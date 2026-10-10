// 额外模型解析（变量单独更新）的请求：组提示词、按请求策略请求、把结果写回楼层。
// 原来在 generate.js 里；挪到 core 是为了让服务器代生成（server/gen-persist.mjs）用同一份代码，
// 页面不在线时服务器算出来的变量和页面自己算的一致。和浏览器有关的东西（读预设、发请求、弹通知）由调用方通过 env 传进来：
//   env.preset        当前预设（规范化后的数据）
//   env.presetName    当前预设的名字
//   env.loadPreset    (name) => Promise<预设数据>，“使用其他预设”时按名字读
//   env.send          (conn, req, signal) => Promise<{text, reasoning, toolCalls}>，发一次请求
//   env.conn          额外模型解析用的连接（mvuConnectionOf 算出来的）
//   env.onFilter      (lastMvuFilter) => void，世界书筛选的结果（面板显示 / 正则写错时提示）
//   env.notice        (text) => void，请求策略里的提示（“正在重试…”）
import { buildRequest, splitThinking } from './providers.js';
import { samplerParams } from './preset.js';
import { syncSwipe, messageText } from './chat.js';
import { toUpdateBlock, MVU_PATCH_SCHEMA, isMvuUpdateRule, stripUpdateBlocks, buildTask, buildBuiltinMessages, presetTaskInjects, previousVarsBlock, applyAdvancedParams, runWithStrategy, DEFAULT_USER_INPUT } from './mvu-extra.js';
import { STATUS_PLACEHOLDER, latestMvuVars, collectInitVars } from './mvu.js';
import { GenError } from './llm.js';

/** 单独更新用的连接：设置里选的那个（可换模型），没选就用当前连接 */
export function mvuConnectionOf(settings, active) {
    const p = settings?.power ?? {};
    const base = (p.mvuConnection && (settings.connections ?? []).find(c => c.id === p.mvuConnection)) || active;
    if (!base) throw new Error('还没有配置 API 连接');
    return { ...base, ...(p.mvuModel ? { model: p.mvuModel } : {}), stream: false };
}

/**
 * 拼额外模型解析的请求：消息、预填充、采样参数。
 * - 内置：开头提示词 → <additional_information>（用户设定、角色描述、世界书）→ <past_observe>（前 N 楼 + 本楼）→ 剧情发生前的变量 → 任务 → 结尾提示词
 * - 使用当前预设 / 其他预设：按那份预设组提示词，任务注入在深度 0，<past_observe> 包住最后两条
 * 世界书都按变量更新的规则筛（[mvu_plot] 不给、没适配的世界书不给、黑白名单）。
 * @param {{task?: string, userInput?: string}} o
 */
export async function buildMvuRequest(session, index, { task, userInput, statData: statOverride, statLabel, keepBlocks = false } = {}, env = {}) {
    const eff = session.mvuSettings();
    const chat = session.chat;
    const upto = chat.slice(0, index + 1);
    const n = Math.max(0, Number(eff.mvuHistory ?? 2) || 0);
    const prev = latestMvuVars(chat, index - 1);
    const statData = statOverride ?? (prev ? prev.vars.stat_data ?? {} : collectInitVars(session.allWorldEntries()));
    const mvuFilter = { whitelist: eff.mvuWhitelist, blacklist: eff.mvuBlacklist, charWhitelist: eff.charWhitelist, charBlacklist: eff.charBlacklist };
    const theTask = task ?? buildTask();
    const input = userInput || DEFAULT_USER_INPUT;
    const mode = eff.mvuPromptMode || 'builtin';
    let presetData = env.preset ?? session.preset ?? {};
    let messages, prefill = '';
    if (mode === 'builtin') {
        const prepared = await session.preparePrompt({ type: 'quiet', dryRun: true, mvuPhase: 'update', mvuFilter, chatOverride: upto, maxHistory: n + 1 });
        // 预设里教模型写更新块的提示词（正文那边已经去掉了）放进资料里
        const rules = (presetData.prompts ?? []).filter(p => p?.content && isMvuUpdateRule(p.content, p.name)).map(p => session.substitute(p.content));
        const wi = prepared.worldInfo ?? {};
        messages = buildBuiltinMessages({
            head: eff.mvuHeadPrompt,
            tail: eff.mvuTailPrompt,
            persona: prepared.fields?.persona ?? '',
            description: prepared.fields?.description ?? '',
            worldBefore: wi.worldInfoBefore ?? '',
            worldAfter: [wi.worldInfoAfter ?? '', ...rules].filter(t => String(t).trim()).join('\n\n'),
            history: (prepared.history ?? []).map(h => ({ role: h.narrator ? 'system' : h.role, content: keepBlocks ? h.content : stripUpdateBlocks(h.content) })),
            statData,
            statLabel,
            task: theTask,
            userInput: input,
        });
    } else {
        let presetOverride;
        if (mode === 'other') {
            const name = eff.mvuOtherPreset;
            if (!name) throw new Error('“请求内容”选了使用其他预设，但还没选是哪个预设');
            presetOverride = env.presetName === name ? presetData : await env.loadPreset?.(name);
            if (!presetOverride) throw new Error(`找不到预设「${name}」`);
        }
        if (presetOverride) presetData = presetOverride;
        const saved = { ...session.extensionPrompts };
        presetTaskInjects(`${previousVarsBlock(statData, statLabel)}\n\n${theTask}`).forEach((x, i) => {
            session.extensionPrompts[`mvu_task_${i}`] = { value: x.content, position: 1, depth: x.depth, role: x.role };
        });
        let prepared;
        try {
            prepared = await session.preparePrompt({ type: 'quiet', dryRun: true, mvuPhase: 'update', mvuFilter, chatOverride: upto, maxHistory: n + 1, appendHistory: [{ role: 'user', content: input }], presetOverride });
        } finally {
            session.extensionPrompts = saved;
        }
        messages = prepared.messages;
        prefill = prepared.prefill ?? '';
    }
    if (session.lastMvuFilter) env.onFilter?.(session.lastMvuFilter);
    let params = samplerParams(presetData);
    if (mode === 'builtin') {
        // 没填高级参数时的默认：温度压到 ≤0.3，回复上限至少 2048
        params.temperature = Math.min(Number(params.temperature ?? 0.3), 0.3);
        params.max_tokens = Math.max(Number(params.max_tokens ?? 0), 2048);
    }
    params = applyAdvancedParams(params, eff);
    params.stream = false;
    return { messages: messages.filter(m => m && typeof m.content === 'string' && m.content.trim()), prefill, params };
}

/**
 * 按“请求策略”请求模型，拿到一个 <UpdateVariable> 块（不写回正文）。
 * @param {{signal?: AbortSignal, task?: (schema: boolean) => string, userInput?: string, validate?: (block: string) => any, quiet?: boolean}} o
 *   validate 抛错 = 这次尝试失败（会按策略重试）
 */
export async function requestVarUpdate(session, index, { signal, task, userInput, validate, quiet = false, statData, statLabel, keepBlocks } = {}, env = {}) {
    const eff = session.mvuSettings();
    const conn = env.conn;
    if (!conn) throw new Error('还没有配置 API 连接');
    const names = session.names ?? { user: 'User', char: 'Assistant' };
    const attempt = async (sig) => {
        const ask = async (schema) => {
            const { messages, prefill, params } = await buildMvuRequest(session, index, { task: task ? task(schema) : buildTask({ schema }), userInput, statData, statLabel, keepBlocks }, env);
            const req = buildRequest(conn, { messages, prefill, params, names, jsonSchema: schema ? MVU_PATCH_SCHEMA : null });
            req.stream = false;
            req.body.stream = false;
            const r = await env.send(conn, req, sig);
            return r.toolCalls?.length && !String(r.text).trim() ? r.toolCalls[0].function.arguments : r.text;
        };
        let raw;
        if (eff.mvuSchema !== false) {
            try { raw = await ask(true); } catch (e) {
                // 中转 / 模型不支持结构化输出：退回普通文本
                if (sig?.aborted || !(e instanceof GenError) || e.retryable) throw e;
            }
        }
        if (raw === undefined || !toUpdateBlock(raw)) raw = await ask(false);
        const block = toUpdateBlock(splitThinking(raw).text || raw);
        if (!block) throw new Error('模型没有给出能识别的变量更新');
        if (validate) await validate(block);
        return block;
    };
    return runWithStrategy(attempt, {
        mode: eff.mvuRequestMode,
        count: eff.mvuRequestCount,
        signal,
        notice: (text) => { if (!quiet && eff.mvuNotifyExtra) env.notice?.(text); },
    });
}

/** 把更新块写回这条消息末尾（状态栏占位符之前），原有的更新块换掉 */
export function writeUpdateBlock(session, index, block) {
    const m = session.chat[index];
    let text = String(messageText(m)).replace(/\s*<UpdateVariable>[\s\S]*?(<\/UpdateVariable>|$)/gi, '');
    const at = text.lastIndexOf(STATUS_PLACEHOLDER);
    text = at >= 0
        ? `${text.slice(0, at).replace(/\s+$/, '')}\n\n${block}\n\n${text.slice(at)}`
        : `${text.replace(/\s+$/, '')}\n\n${block}`;
    m.mes = text;
    if (Array.isArray(m.swipes)) syncSwipe(m);
}

/**
 * 另发请求，让模型只根据这条回复产出变量更新，结果写回这条消息末尾。
 * 不应用变量，调用方接着走 applyMvuAsync。
 */
export async function updateVarsSeparately(session, index, signal, env = {}) {
    const msg = session.chat[index];
    if (!msg || msg.is_user) throw new Error('这一楼不是 AI 回复');
    const block = await requestVarUpdate(session, index, { signal }, env);
    writeUpdateBlock(session, index, block);
    return block;
}
