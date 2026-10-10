// 服务器代写回复：页面在宽限期里没来确认（切到后台、锁屏、关掉了），服务器自己把回复写进聊天文件，并把变量也算好。
// 用的是页面同一套代码（public/js/core）：会话、永久正则、思维链拆分、额外模型解析（含请求策略 / 请求内容 / 高级参数 /
// 角色卡覆盖）、随 AI 输出解析、自动清理、同步到聊天变量，所以写出来的楼层和变量与页面自己收尾时一样。
// 跑不了的是脚本和前端卡（它们只在浏览器里）：楼层上打 lt_server_persisted 标记，页面下次打开时补发事件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatSession } from '../public/js/core/session.js';
import { parseChatJsonl, serializeChat, syncSwipe } from '../public/js/core/chat.js';
import { normalizePreset } from '../public/js/core/preset.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';
import { readLlmResponse, GenError } from '../public/js/core/llm.js';
import { separateReasoning, placeLocated, locateReply, finalizeReply, wantsSeparateVars, applyReplyVars, personaOf, relevantWorldNames } from '../public/js/core/reply.js';
import { updateVarsSeparately, mvuConnectionOf } from '../public/js/core/mvu-request.js';
import { mirrorToChatVars } from '../public/js/core/mvu-cleanup.js';
import { HttpError } from './http.mjs';
import { openUpstream } from './proxy.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 额外模型解析最多等这么久（页面上没有超时，是因为用户可以点停止；服务器上没人点） */
const MVU_TIMEOUT_MS = 5 * 60 * 1000;

let lodash = null;
/** 提示词模板（EJS）里常用 _：和页面一样给一份 lodash（vendor 里是 UMD 文件，包是 ESM，不能直接 require） */
function getLodash() {
    if (!lodash) {
        try {
            const src = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'lodash.min.js'), 'utf8');
            const mod = { exports: {} };
            new Function('module', 'exports', 'define', src)(mod, mod.exports, undefined);
            lodash = mod.exports;
        } catch {
            lodash = {};
        }
    }
    return lodash;
}

/** 服务器上发一次请求（额外模型解析用）：连不上算可以重试的错误，和页面经本地代理请求时一样 */
export function serverSender(store) {
    return async (conn, req, signal) => {
        let res;
        try {
            res = await openUpstream(store, conn.id, { path: req.path, method: req.method, body: req.body, stream: req.stream }, signal);
        } catch (e) {
            if (e instanceof HttpError) throw new GenError(`接口报错（${e.status}）：${e.message}`, { retryable: e.status >= 500, status: e.status });
            throw e;
        }
        return readLlmResponse(conn.provider, req, res, () => {});
    };
}

/**
 * 按页面的规则在服务器上建会话：设置、角色卡、预设、用户设定、相关世界书都从磁盘读（页面发起生成前已经把待保存的都写盘了）。
 * @returns {Promise<{session: ChatSession, header: object, messages: object[], settings: object, preset: object}>}
 */
export async function buildServerSession(store, { char, file, name, preset: presetName, model }, chatText) {
    const settings = await store.getSettings();
    const card = await store.readCard(file);
    const pname = presetName || settings.activePreset;
    let preset;
    try { preset = normalizePreset(await store.readJson('presets', pname)); } catch { preset = normalizePreset({}); }
    const { header, messages } = parseChatJsonl(chatText);
    const persona = personaOf(settings);
    const worlds = {};
    for (const n of relevantWorldNames(settings, card, char, header.chat_metadata, persona)) {
        try { worlds[n] = normalizeWorld(await store.readJson('worlds', n)); } catch { /* 世界书不在了：和页面一样跳过 */ }
    }
    const session = new ChatSession({ card, cardFile: char, persona, preset, chat: messages, meta: header.chat_metadata, chatId: name, settings, worlds, model: model ?? '' });
    session.templateGlobals = { _: getLodash() };
    return { session, header, messages, settings, preset, presetName: pname };
}

/** swipe / 续写的位置对不上了：把算好的这一版单独拿出来，作为新的一条加到末尾 */
function standalone(m) {
    const sid = m.swipe_id ?? 0;
    return {
        ...m,
        swipe_id: 0,
        swipes: [m.mes],
        swipe_info: [m.swipe_info?.[sid] ?? { send_date: m.send_date, extra: m.extra }],
        ...(Array.isArray(m.variables) ? { variables: [m.variables[sid] ?? {}] } : {}),
    };
}

/**
 * 把任务的结果写进聊天。job：gen-jobs.mjs 的任务（text / reasoning 是收齐的原文，没拆思维链）
 * @returns {Promise<{index: number, swipe_id: number, version: string, kind: string, warnings: string[]}>}
 */
export async function persistReply(store, job) {
    const { char, name } = job;
    const version0 = await store.chatVersion(char, name);
    if (!version0) throw new Error('聊天文件不在了');
    const text0 = await store.readChat(char, name);
    const { session, header, messages, settings, preset, presetName } = await buildServerSession(store, job, text0);
    const loc = locateReply(messages, job.target, job.id);
    const placed = placeLocated(messages, loc, job.target, { provider: job.provider, model: job.model, started: job.started, charName: session.names.char });
    const sep = separateReasoning(job.text, job.reasoning, session.power.thinkAutoParse !== false);
    const m = finalizeReply(session, placed.index, {
        type: placed.type, baseText: placed.baseText, text: sep.body, reasoning: sep.rsn,
        provider: job.provider, model: job.model, started: job.started, finished: new Date(job.doneAt ?? Date.now()), tzOffset: job.tzOffset,
    });

    const warnings = [];
    // 额外模型解析：和页面一样的条件、一样的请求（连接按设置里选的，没选就用这次生成的连接）
    if (wantsSeparateVars(session, placed.index, false)) {
        const active = (settings.connections ?? []).find(c => c.id === job.conn) ?? { id: job.conn, provider: job.provider, model: job.model };
        const env = {
            preset,
            presetName,
            loadPreset: async (n) => normalizePreset(await store.readJson('presets', n)),
            send: serverSender(store),
            get conn() { return mvuConnectionOf(settings, active); },
            onFilter: () => {},
            notice: () => {},
        };
        try {
            await updateVarsSeparately(session, placed.index, AbortSignal.timeout(MVU_TIMEOUT_MS), env);
        } catch (e) {
            warnings.push(`变量更新失败：${String(e?.message ?? e).split('\n')[0]}`);
        }
    }
    const mvu = session.mvuEnabled();
    if (mvu) {
        const { result } = await applyReplyVars(session, placed.index, null);
        if (result?.errors?.length) warnings.push(`变量更新有 ${result.errors.length} 处没执行：${String(result.errors[0]).split('\n')[0]}`);
    }
    // 标记：页面下次打开这个聊天时据此补发脚本该收到的事件（pending 补发后变成 false）
    m.extra = {
        ...(m.extra ?? {}),
        lt_server_persisted: {
            job: job.id, type: job.target?.type ?? 'normal', at: new Date().toISOString(), pending: true, mvu,
            ...(m.extra?.reasoning ? { reasoning: true } : {}),
            ...(loc.kind === 'orphan' ? { orphan: true } : {}),
            ...(warnings.length ? { warnings } : {}),
        },
    };
    if (Array.isArray(m.swipes)) syncSwipe(m);
    const mirror = mvu && session.mvuSettings().mvuChatVars;

    return store.withChatLock(char, name, async () => {
        const v = await store.chatVersion(char, name);
        let outHeader = header, outMsgs = messages, index = placed.index;
        if (v !== version0) {
            // 算的这段时间里聊天被写过（页面上别的操作）：读最新的，把算好的这一楼放进去
            const fresh = parseChatJsonl(await store.readChat(char, name));
            const loc2 = locateReply(fresh.messages, job.target, job.id);
            const same = loc2.kind === loc.kind && loc2.index === loc.index;
            if (same && loc.kind === 'append') fresh.messages.push(m);
            else if (same && loc.kind !== 'orphan') fresh.messages[loc.index] = m;
            else fresh.messages.push(loc.kind === 'append' || loc.kind === 'replace' || loc.kind === 'placeholder' || loc.kind === 'orphan' ? m : standalone(m));
            index = fresh.messages.indexOf(m) >= 0 ? fresh.messages.indexOf(m) : fresh.messages.length - 1;
            if (mirror && index === fresh.messages.length - 1) mirrorToChatVars(fresh.header.chat_metadata, fresh.messages[index].variables?.[fresh.messages[index].swipe_id ?? 0] ?? {});
            outHeader = fresh.header;
            outMsgs = fresh.messages;
        }
        const version = await store.saveChat(char, name, serializeChat(outHeader, outMsgs), { expect: v });
        return { index, swipe_id: outMsgs[index]?.swipe_id ?? 0, version, kind: loc.kind, warnings };
    });
}
