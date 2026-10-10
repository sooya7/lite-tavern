// 一条 AI 回复从“占位”到“写好”的每一步：在哪写（占位楼层 / swipe / 续写）、拆思维链、永久正则、
// 写回楼层字段、变量更新。前端（generate.js）和服务器代生成（server/gen-persist.mjs）共用这一份，
// 页面在不在线，存进聊天文件的楼层和变量都一样。
import { createAssistantMessage, addSwipe, syncSwipe, messageText } from './chat.js';
import { splitThinking } from './providers.js';
import { humanizedDate } from './util.js';
import { estimateTokens } from './tokens.js';
import { extractUpdateBlocks } from './mvu.js';
import { autoCleanup } from './mvu-cleanup.js';

/** 正文开头的 <think>…</think> 拆成思维链；接口本身也返回了思考内容时两段合并 */
export function separateReasoning(text, reasoning, think = true) {
    if (!think) return { body: text, rsn: reasoning };
    const sp = splitThinking(text);
    if (!sp.reasoning && !sp.open) return { body: text, rsn: reasoning };
    return { body: sp.text, rsn: reasoning ? [reasoning, sp.reasoning].join('\n\n') : sp.reasoning };
}

/**
 * 准备写入位置（和生成开始时页面上做的一样）：normal 在末尾加一条空的角色消息，swipe 给最后一条加一个空 swipe，continue 不动。
 * jobId：服务器代生成的任务号，记在占位上（生成途中聊天被保存过的话，服务器靠它认出这个占位）
 * @returns {number} 写入的楼层号
 */
export function placeReply(chat, { type, index, provider, model, started, jobId, charName }) {
    const extra = { api: provider, model, ...(jobId ? { lt_job: jobId } : {}) };
    const at = typeof started === 'string' ? started : new Date(started).toISOString();
    if (type === 'normal') {
        const m = createAssistantMessage(charName, '', extra);
        m.gen_started = at;
        chat.push(m);
        return chat.length - 1;
    }
    if (type === 'swipe') {
        addSwipe(chat[index], '', extra);
        chat[index].gen_started = at;
        return index;
    }
    return index;
}

/**
 * 回复收齐之后写回楼层：永久正则 → 正文 / 时间 / extra → 同步 swipe。思维链已经拆好（separateReasoning）。
 * @param {{type: string, baseText?: string, text: string, reasoning?: string, provider?: string, model?: string, started: Date|string, finished: Date, tzOffset?: number}} o
 *   tzOffset：页面所在时区（Date#getTimezoneOffset 的值）。服务器代写时用它，发送时间按用户那边的钟点写，和页面自己写的一样
 */
export function finalizeReply(session, index, { type, baseText = '', text, reasoning = '', provider, model, started, finished, tzOffset }) {
    const m = session.chat[index];
    const t0 = new Date(started);
    const processed = session.processIncoming(text, false);
    m.mes = type === 'continue' ? baseText + processed : processed;
    m.send_date = humanizedDate(inZone(finished, tzOffset));
    m.gen_finished = finished.toISOString();
    const extra = {
        ...(m.extra ?? {}),
        api: provider,
        model,
        reasoning: reasoning || undefined,
        reasoning_duration: reasoning ? finished - t0 : undefined,
        token_count: estimateTokens(m.mes),
    };
    delete extra.lt_job;
    m.extra = extra;
    if (Array.isArray(m.swipes)) {
        syncSwipe(m);
        m.swipe_info[m.swipe_id] = { ...m.swipe_info[m.swipe_id], gen_started: t0.toISOString(), gen_finished: finished.toISOString() };
    }
    return m;
}

/** 换成另一个时区的“本地时间”：返回的 Date 用本进程的 getHours 等读出来就是那个时区的钟点 */
function inZone(d, tzOffset) {
    if (typeof tzOffset !== 'number' || !Number.isFinite(tzOffset)) return d;
    return new Date(d.getTime() + (d.getTimezoneOffset() - tzOffset) * 60000);
}

/** 这条回复要不要另发请求更新变量：额外模型解析开着、不是中途停下的、正文没自己写更新块、开着自动请求 */
export function wantsSeparateVars(session, index, partial = false) {
    const m = session.chat[index];
    return !!m && session.mvuSeparateActive() && !partial && !extractUpdateBlocks(m.mes).length && session.mvuSettings().mvuAuto !== false;
}

/**
 * MVU：基于上一层变量应用本条更新（emit 不为空时边更新边发事件），再按设置自动清理较老楼层的变量。
 * @returns {Promise<{result: object|null, cleaned: number}>}
 */
export async function applyReplyVars(session, index, emit = null) {
    if (!session.mvuEnabled()) return { result: null, cleaned: 0 };
    const eff = session.mvuSettings();
    const result = await session.applyMvuAsync(index, emit);
    let cleaned = 0;
    // 自动清理较老楼层的变量（每 5 楼做一次，保留最近几楼和快照楼层）
    if (eff.mvuCleanup) cleaned = autoCleanup(session.chat, index, { keep: Number(eff.mvuKeepRecent) || 20, interval: Number(eff.mvuSnapshotInterval) || 50 });
    return { result, cleaned };
}

// ---------- 会话材料（页面的 getSession / loadRelevantWorlds 和服务器用同一套规则） ----------

/** 当前用户设定 */
export function personaOf(settings) {
    const list = settings?.personas ?? [];
    return list.find(x => x.id === settings.activePersona) ?? list[0] ?? { id: '', name: 'User', description: '' };
}

/** 当前连接 */
export function activeConnectionOf(settings) {
    const list = settings?.connections ?? [];
    return list.find(c => c.id === settings.activeConnection) ?? list[0] ?? null;
}

/** 这个聊天会用到的世界书：全局、角色绑定的、角色额外的、聊天的、用户设定的 */
export function relevantWorldNames(settings, card, charId, meta, persona) {
    const names = new Set(settings?.worldInfo?.globalSelect ?? []);
    const linked = card?.data?.extensions?.world;
    if (linked) names.add(linked);
    for (const n of settings?.worldInfo?.charLore?.[charId] ?? []) names.add(n);
    if (meta?.world_info) names.add(meta.world_info);
    if (persona?.lorebook) names.add(persona.lorebook);
    return [...names].filter(Boolean);
}

// ---------- 服务器代生成：找回写入位置 ----------

/** 认一条楼层用的指纹：谁说的 + 发送时间（生成开始时记下“前一条”的指纹，落盘时核对聊天还是不是那个样子） */
export const messageFingerprint = (m) => (m ? `${m.is_user ? 1 : 0}|${m.name ?? ''}|${m.send_date ?? ''}` : '');

const swipeCount = (m) => (Array.isArray(m?.swipes) && m.swipes.length ? m.swipes.length : 1);

/**
 * 在（可能已经被改过的）聊天里找到这次回复该写的位置。
 * target：{type: normal|swipe|continue, index, swipeId?, baseText?, anchor, replace?}
 *   anchor 是生成开始时 index - 1 那条的指纹；replace 是“重新生成”时被替换的旧回复的指纹（它还在文件里）
 * @returns {{kind: 'append'|'replace'|'placeholder'|'swipe'|'swipe-placeholder'|'continue'|'orphan', index: number, swipeId?: number}}
 *   orphan = 对不上了（聊天在别处被改过），调用方把回复作为新的一条加到末尾，宁可多一条也不丢
 */
export function locateReply(messages, target, jobId) {
    const t = target ?? {};
    // 生成途中聊天被保存过：占位（带任务号）已经在文件里了
    if (jobId) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.extra?.lt_job === jobId && t.type !== 'swipe' && t.type !== 'continue') return { kind: 'placeholder', index: i };
            const k = (m?.swipe_info ?? []).findIndex(x => x?.extra?.lt_job === jobId);
            if (k >= 0 && t.type === 'swipe') return { kind: 'swipe-placeholder', index: i, swipeId: k };
        }
    }
    const index = Number(t.index);
    const anchorOk = index === 0 ? !t.anchor : messageFingerprint(messages[index - 1]) === (t.anchor ?? '');
    if (Number.isInteger(index) && index >= 0 && anchorOk) {
        if (t.type === 'normal') {
            if (messages.length === index) return { kind: 'append', index };
            if (t.replace && messages.length === index + 1 && messageFingerprint(messages[index]) === t.replace) return { kind: 'replace', index };
        } else if (t.type === 'swipe') {
            const m = messages[index];
            if (m && !m.is_user && messages.length === index + 1 && swipeCount(m) === Number(t.swipeId)) return { kind: 'swipe', index, swipeId: Number(t.swipeId) };
        } else if (t.type === 'continue') {
            const m = messages[index];
            if (m && !m.is_user && messages.length === index + 1 && messageText(m) === (t.baseText ?? '')) return { kind: 'continue', index };
        }
    }
    return { kind: 'orphan', index: messages.length };
}

const serverMarkOf = (x) => x?.extra?.lt_server_persisted;
/** 这条楼层（任一 swipe）是不是这个任务由服务器写的 */
export const writtenByJob = (m, jobId) => serverMarkOf(m)?.job === jobId || (m?.swipe_info ?? []).some(s => serverMarkOf(s)?.job === jobId);

// 版本号是 “修改时间毫秒-字节数”（server/store.mjs 的 fileVersion）：取前半段比先后
const versionTime = (v) => Number(String(v ?? '').split('-')[0]) || 0;

/**
 * 服务器替页面写过的任务里，哪些是手里这份聊天还没看到、需要重新载入的。
 * 找不到任务写的那一楼不等于“没看到”：那一楼可能后来被重新生成、删掉、或者被“用这边的覆盖”盖掉了，
 * 这时再载入多少次也找不到。所以两条都要管：
 *   - 手里这份的版本不比服务器写完时的旧（之后读的 / 之后存成功过）→ 已经看到过，不用载入；
 *   - 已经为它载入过一次的（seen）→ 不再载入。少了这条，页面会每秒重新载入一次聊天，停不下来。
 * @param {object[]} messages 手里的楼层
 * @param {string} version 手里这份聊天的版本号
 * @param {object[]} jobs /api/gen/active 返回的任务
 * @param {Set<string>} [seen] 已经为它载入过的任务号
 */
export function persistedToLoad(messages, version, jobs, seen = new Set()) {
    const mine = versionTime(version);
    return (jobs ?? []).filter((j) => {
        if (j?.status !== 'persisted' || seen.has(j.id)) return false;
        if ((messages ?? []).some(m => writtenByJob(m, j.id))) return false;
        const theirs = versionTime(j.persisted?.version);
        return !(mine && theirs && mine >= theirs);
    });
}

/**
 * 按 locateReply 的结果把占位放好（和页面上生成开始时一样），返回写入的楼层号和实际的生成类型。
 * @returns {{index: number, type: string, baseText: string}}
 */
export function placeLocated(messages, loc, target, { provider, model, started, charName }) {
    const base = { provider, model, started, charName };
    switch (loc.kind) {
        case 'placeholder':
            messages.splice(loc.index, 1);
            if (loc.index !== messages.length) {
                // 占位后面又有了别的楼层（不该发生）：在原位置放一条新的
                const tmp = [];
                const i = placeReply(tmp, { type: 'normal', ...base });
                messages.splice(loc.index, 0, tmp[i]);
                return { index: loc.index, type: 'normal', baseText: '' };
            }
            return { index: placeReply(messages, { type: 'normal', ...base }), type: 'normal', baseText: '' };
        case 'replace':
            messages.splice(loc.index, 1);
            return { index: placeReply(messages, { type: 'normal', ...base }), type: 'normal', baseText: '' };
        case 'swipe-placeholder': {
            const m = messages[loc.index];
            m.swipes.splice(loc.swipeId, 1);
            m.swipe_info.splice(loc.swipeId, 1);
            if (Array.isArray(m.variables)) m.variables.splice(loc.swipeId, 1);
            m.swipe_id = Math.max(0, Math.min(m.swipe_id ?? 0, m.swipes.length - 1));
            m.mes = m.swipes[m.swipe_id];
            return { index: placeReply(messages, { type: 'swipe', index: loc.index, ...base }), type: 'swipe', baseText: '' };
        }
        case 'swipe':
            return { index: placeReply(messages, { type: 'swipe', index: loc.index, ...base }), type: 'swipe', baseText: '' };
        case 'continue':
            return { index: loc.index, type: 'continue', baseText: target.baseText ?? '' };
        default:
            return { index: placeReply(messages, { type: 'normal', ...base }), type: 'normal', baseText: '' };
    }
}
