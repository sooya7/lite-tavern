// 生成流程：组提示词 → 发请求（流式/非流式，自动重试）→ 写回消息 → 正则/MVU/事件
import { api } from './api.js';
import { state, eventSource, event_types, saveChat, activeConnection, flushPending, mvuEmitter } from './state.js';
import { getSession, addUserMessage, refresh } from './controller.js';
import { buildRequest, readSSE, parseStreamEvent, parseFullResponse, splitThinking } from './core/providers.js';
import { samplerParams } from './core/preset.js';
import { createAssistantMessage, addSwipe, syncSwipe, messageText } from './core/chat.js';
import { humanizedDate, sleep, uuid } from './core/util.js';
import { estimateTokens } from './core/tokens.js';
import { toast } from './ui/dom.js';
import { broadcastEvent } from './ui/frontend.js';
import { runGenerateInterceptors } from './ui/extensions.js';

let ui = {};
export function bindGenerateUI(fns) { ui = { ...ui, ...fns }; }

class GenError extends Error {
    constructor(message, { retryable = false, status } = {}) {
        super(message);
        this.retryable = retryable;
        this.status = status;
    }
}

function errorPatterns() {
    return String(state.settings.retry?.errorPatterns ?? '').split('\n').map(s => s.trim()).filter(Boolean).map(s => {
        try { return new RegExp(s, 'i'); } catch { return null; }
    }).filter(Boolean);
}

/**
 * 发一次请求，onDelta 收增量。返回 {text, reasoning}
 */
async function requestOnce(conn, req, signal, onDelta, sender) {
    const payload = { path: req.path, method: req.method, body: req.body, stream: req.stream };
    const res = sender ? await sender(payload, signal) : await api.llm(conn.id, payload, signal);
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const t = await res.text();
            try { const j = JSON.parse(t); msg = j.error?.message ?? j.message ?? j.detail ?? t; } catch { msg = t || msg; }
        } catch { /* 忽略 */ }
        throw new GenError(`接口报错（${res.status}）：${String(msg).slice(0, 500)}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
    }
    let text = '', reasoning = '';
    if (req.stream && (ctype.includes('event-stream') || ctype.includes('text/plain') || !ctype.includes('json'))) {
        for await (const ev of readSSE(res.body)) {
            const d = parseStreamEvent(conn.provider, ev);
            if (!d) continue;
            if (d.error) throw new GenError(`接口报错：${d.error}`, { retryable: /429|rate|overload|timeout|5\d\d/i.test(d.error) });
            if (d.text) text += d.text;
            if (d.reasoning) reasoning += d.reasoning;
            if (d.text || d.reasoning) onDelta(text, reasoning);
            if (d.done) break;
        }
    } else {
        const j = await res.json().catch(() => { throw new GenError('接口返回的不是 JSON'); });
        const r = parseFullResponse(conn.provider, j);
        text = r.text;
        reasoning = r.reasoning;
        onDelta(text, reasoning);
    }
    return { text, reasoning };
}

/**
 * @param {'normal'|'regenerate'|'swipe'|'continue'|'impersonate'|'quiet'} type
 * @param {{input?: string, quietPrompt?: string, silent?: boolean}} opt
 */
export async function generate(type = 'normal', opt = {}) {
    if (state.generating) return null;
    if (!state.char || !state.chat) { toast('先选一个角色', 'warning'); return null; }
    const conn = activeConnection();
    if (!conn) {
        toast('还没有配置 API 连接，先在「连接」里添加一个', 'warning');
        ui.openPanel?.('connection');
        return null;
    }
    if (!conn.model && conn.provider !== 'openai') {
        toast('连接里还没选模型', 'warning');
        ui.openPanel?.('connection');
        return null;
    }
    const chat = state.chat.messages;
    if (type === 'swipe') {
        const last = chat[chat.length - 1];
        if (!last || last.is_user) { toast('最后一条不是角色消息，没法重刷', 'warning'); return null; }
    }
    // 先占住生成状态，防止连点触发两次
    state.generating = true;
    const ac = new AbortController();
    state.abort = ac;
    ui.setGenerating?.(true);

    let targetIndex = -1;
    let excludeLast = false;
    let baseText = '';
    let removedForRegen = null;
    const started = new Date();
    let session;
    try {
        // 连接配置由服务端从 settings.json 读取，发请求前先把待保存的设置写掉
        await flushPending();
        session = getSession();
        if (type === 'normal' && opt.input?.trim()) await addUserMessage(opt.input);
    } catch (e) {
        toast(`发送失败：${e.message}`, 'error');
        finish();
        return null;
    }

    if (type === 'regenerate') {
        const last = chat[chat.length - 1];
        if (last && !last.is_user && !last.is_system) {
            removedForRegen = chat.pop();
            ui.renderChat?.();
        }
        type = 'normal';
    }
    if (type === 'swipe') excludeLast = true;
    if (type === 'continue') {
        const last = chat[chat.length - 1];
        if (!last || last.is_user) type = 'normal';
        else baseText = messageText(last);
    }

    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, { quiet_prompt: opt.quietPrompt }, false);
    await eventSource.emit(event_types.GENERATION_STARTED, type, { quiet_prompt: opt.quietPrompt }, false);
    broadcastEvent('js_generation_started');

    let prompt;
    try {
        // 脚本用 injectPrompts 注入的提示词（在上面两个事件里注入的也算）
        await ui.beforePrompt?.(session, type);
        // 酒馆插件的生成拦截器（manifest.generate_interceptor）：拿到这次要发的聊天记录副本，可以临时改
        let chatOverride;
        const intercepted = await runGenerateInterceptors(session.chat, type === 'swipe' ? 'swipe' : (removedForRegen ? 'regenerate' : type));
        if (intercepted?.aborted) throw new Error('插件中止了这次生成');
        if (intercepted) chatOverride = intercepted.chat;
        prompt = await session.preparePrompt({ type, quietPrompt: opt.quietPrompt, excludeLast, chatOverride });
        if (prompt.worldInfo?.activated?.length) await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, prompt.worldInfo.activated);
        const evData = { chat: plainMessages(prompt.messages), dryRun: false, type };
        await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, evData);
        prompt.messages = adoptMessages(prompt.messages, evData.chat);
    } catch (e) {
        console.error(e);
        toast(`组装提示词出错：${e.message}`, 'error');
        if (removedForRegen) { chat.push(removedForRegen); ui.renderChat?.(); }
        finish();
        return null;
    }

    const preset = state.preset.data;
    const params = samplerParams(preset);
    // 发送前给脚本改请求的两次机会，顺序和酒馆一样：先 GENERATE_AFTER_DATA（{prompt: 消息数组}），再
    // CHAT_COMPLETION_SETTINGS_READY（消息 + 采样参数）。合并相邻消息、加前缀之类的预设脚本靠它们；
    // 新版酒馆（> 1.13.4）上这类脚本只听前一个，所以两个都要在拼请求体之前发，改动才算数
    const afterData = { prompt: plainMessages(prompt.messages) };
    await eventSource.emit(event_types.GENERATE_AFTER_DATA, afterData, false);
    prompt.messages = adoptMessages(prompt.messages, afterData.prompt);
    const genData = await settingsReady(conn, params, prompt.messages, session.names);
    prompt.messages = genData.messages;
    const req = buildRequest(conn, { messages: prompt.messages, prefill: prompt.prefill, params, names: session.names });

    // 准备写入位置
    if (type === 'normal') {
        const m = createAssistantMessage(session.names.char, '', { api: conn.provider, model: conn.model });
        m.gen_started = started.toISOString();
        chat.push(m);
        targetIndex = chat.length - 1;
        ui.appendMessage?.(targetIndex, { streaming: true });
    } else if (type === 'swipe') {
        targetIndex = chat.length - 1;
        addSwipe(chat[targetIndex], '', { api: conn.provider, model: conn.model });
        chat[targetIndex].gen_started = started.toISOString();
        ui.renderMessage?.(targetIndex, { streaming: true });
    } else if (type === 'continue') {
        targetIndex = chat.length - 1;
        ui.renderMessage?.(targetIndex, { streaming: true });
    }

    const think = session.power.thinkAutoParse !== false;
    // 正文开头的 <think>…</think> 拆成思维链；接口本身也返回了思考内容时两段合并
    const separate = (text, reasoning) => {
        if (!think) return { body: text, rsn: reasoning };
        const sp = splitThinking(text);
        if (!sp.reasoning && !sp.open) return { body: text, rsn: reasoning };
        return { body: sp.text, rsn: reasoning ? [reasoning, sp.reasoning].join('\n\n') : sp.reasoning };
    };
    let lastPaint = 0;
    const paint = (text, reasoning, force = false) => {
        const now = performance.now();
        if (!force && now - lastPaint < 60) return;
        lastPaint = now;
        const { body, rsn } = separate(text, reasoning);
        if (type === 'impersonate' || type === 'quiet') {
            ui.setStatus?.(`生成中… ${estimateTokens(body)} tokens`);
            if (type === 'impersonate') ui.setComposerText?.(body);
            return;
        }
        const m = chat[targetIndex];
        if (!m) return;
        m.mes = type === 'continue' ? baseText + body : body;
        m.extra = { ...(m.extra ?? {}), reasoning: rsn || undefined };
        ui.updateStreaming?.(targetIndex);
        ui.setStatus?.(`生成中… ${estimateTokens(body)} tokens`);
        broadcastEvent('js_stream_token_received_fully', m.mes);
        if (eventSource.count(event_types.STREAM_TOKEN_RECEIVED)) eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, m.mes);
    };

    const retry = state.settings.retry ?? {};
    const maxRetries = retry.enabled ? Number(retry.maxRetries ?? 2) : 0;
    const patterns = errorPatterns();
    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (ac.signal.aborted) break;
        if (attempt > 0) {
            ui.setStatus?.(`第 ${attempt} 次重试…`);
            await sleep(Number(retry.delayMs ?? 2000) * attempt);
            if (ac.signal.aborted) break;
        }
        try {
            const r = await requestOnce(conn, req, ac.signal, paint);
            if (patterns.some(p => p.test(r.text.slice(0, 400))) && r.text.length < 2000) {
                throw new GenError(`接口把错误当正文返回了：${r.text.slice(0, 200)}`, { retryable: true });
            }
            if (!r.text.trim() && !r.reasoning.trim()) throw new GenError('接口返回了空回复', { retryable: !!retry.onEmpty });
            result = r;
            break;
        } catch (e) {
            if (ac.signal.aborted || e.name === 'AbortError') { lastErr = null; break; }
            lastErr = e;
            console.warn('[生成] 失败', e);
            if (!(e instanceof GenError) || !e.retryable) break;
        }
    }

    const aborted = ac.signal.aborted;
    // 中途停止：保留已经生成的部分
    if (!result && aborted && targetIndex >= 0) {
        const m = chat[targetIndex];
        const partial = type === 'continue' ? messageText(m).slice(baseText.length) : messageText(m);
        if (partial.trim()) result = { text: partial, reasoning: m.extra?.reasoning ?? '', partial: true };
    }

    if (!result) {
        if (lastErr) toast(lastErr.message, 'error');
        // 回滚占位
        if (type === 'normal' && targetIndex >= 0) {
            chat.splice(targetIndex, 1);
            ui.removeMessage?.(targetIndex);
            if (removedForRegen) {
                chat.push(removedForRegen);
                ui.appendMessage?.(chat.length - 1);
            }
        } else if (type === 'swipe' && targetIndex >= 0) {
            const m = chat[targetIndex];
            m.swipes.pop();
            m.swipe_info.pop();
            m.swipe_id = m.swipes.length - 1;
            m.mes = m.swipes[m.swipe_id];
            m.extra = { ...(m.swipe_info[m.swipe_id]?.extra ?? {}) };
            ui.renderMessage?.(targetIndex);
        } else if (type === 'continue' && targetIndex >= 0) {
            chat[targetIndex].mes = baseText;
            ui.renderMessage?.(targetIndex);
        }
        finish();
        await eventSource.emit(aborted ? event_types.GENERATION_STOPPED : event_types.GENERATION_ENDED, -1);
        return null;
    }

    // 拆思维链 + 永久正则
    const sep = result.partial ? { body: result.text, rsn: result.reasoning } : separate(result.text, result.reasoning);
    const text = sep.body;
    const reasoning = sep.rsn;
    const finished = new Date();

    if (type === 'impersonate') {
        ui.setComposerText?.(text.trim());
        finish();
        await eventSource.emit(event_types.GENERATION_ENDED, -1);
        return text;
    }
    if (type === 'quiet') {
        finish();
        await eventSource.emit(event_types.GENERATION_ENDED, -1);
        return text;
    }

    const m = chat[targetIndex];
    const processed = session.processIncoming(text, false);
    m.mes = type === 'continue' ? baseText + processed : processed;
    m.send_date = humanizedDate(finished);
    m.gen_finished = finished.toISOString();
    m.extra = {
        ...(m.extra ?? {}),
        api: conn.provider,
        model: conn.model,
        reasoning: reasoning || undefined,
        reasoning_duration: reasoning ? finished - started : undefined,
        token_count: estimateTokens(m.mes),
    };
    if (Array.isArray(m.swipes)) {
        syncSwipe(m);
        m.swipe_info[m.swipe_id] = { ...m.swipe_info[m.swipe_id], gen_started: started.toISOString(), gen_finished: finished.toISOString() };
    }

    // MVU：基于上一层变量应用本条更新（有脚本监听 MVU 事件时边更新边发事件）
    if (session.mvuEnabled()) {
        broadcastEvent('mag_variable_update_started');
        const r = await session.applyMvuAsync(targetIndex, mvuEmitter());
        if (r?.errors?.length) toast(`变量更新有 ${r.errors.length} 处没执行：${String(r.errors[0]).split('\n')[0]}`, 'warning');
    }
    session.vars.invalidate();
    ui.renderMessage?.(targetIndex);
    saveChat();
    finish();
    await eventSource.emit(event_types.MESSAGE_RECEIVED, targetIndex, type);
    broadcastEvent('message_received', targetIndex);
    broadcastEvent('js_generation_ended', m.mes);
    broadcastEvent('mag_variable_update_ended');
    await eventSource.emit(event_types.GENERATION_ENDED, targetIndex);
    if (result.partial) toast('已停止，保留了已生成的部分', 'info');
    return m.mes;

    function finish() {
        state.generating = false;
        state.abort = null;
        ui.setGenerating?.(false);
        ui.setStatus?.('');
        ui.afterGeneration?.();
        if (targetIndex >= 0 && chat[targetIndex]) ui.renderMessage?.(targetIndex);
    }
}

export function stopGeneration() {
    state.abort?.abort();
    // 脚本发起的、没要求“静默”的生成也一起停
    for (const g of scriptGens.values()) if (!g.silent) g.ac.abort();
}

/**
 * 交给事件监听者的消息：和酒馆一样只有 role / content / name。轻酒馆自己给每条消息记的来源（source 等）不带出去——
 * 合并相邻消息的脚本会比较两条消息除正文外是否相同，带着来源标记它就认为都不同、什么也不合并。
 */
const plainMessages = (messages) => messages.map(m => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) }));

/** 监听者没动过就沿用原来那份（保留来源标记，提示词预览里还看得到每条是哪来的）；动过就用它改好的 */
function adoptMessages(original, edited) {
    if (!Array.isArray(edited)) return original;
    const same = edited.length === original.length && edited.every((m, i) => m && m.role === original[i].role && m.content === original[i].content && (m.name || '') === (original[i].name || ''));
    return same ? original : edited.filter(m => m && typeof m === 'object');
}

/** 发 CHAT_COMPLETION_SETTINGS_READY：监听者可以原地改 messages 和采样参数 */
async function settingsReady(conn, params, messages, names) {
    const data = {
        messages: plainMessages(messages),
        model: conn.model,
        temperature: params.temperature,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        stream: params.stream,
        stop: [],
        chat_completion_source: conn.provider === 'claude' ? 'claude' : conn.provider === 'gemini' ? 'makersuite' : 'openai',
        user_name: names?.user ?? '',
        char_name: names?.char ?? '',
        group_names: [],
    };
    if (!eventSource.count(event_types.CHAT_COMPLETION_SETTINGS_READY)) return { ...data, messages };
    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data);
    data.messages = adoptMessages(messages, data.messages);
    for (const k of ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'max_tokens']) {
        if (typeof data[k] === 'number' && !Number.isNaN(data[k])) params[k] = data[k];
    }
    return data;
}

// ---------- 脚本 / 前端卡发起的生成（酒馆助手的 generate / generateRaw） ----------
// 不占用主生成的状态，可以和正文生成同时进行；不写入聊天，只把文本还给调用方。

const scriptGens = new Map(); // generation_id → {ac, silent}

export const RAW_PROMPT_ORDER = ['world_info_before', 'persona_description', 'char_description', 'char_personality', 'scenario',
    'world_info_after', 'dialogue_examples', 'chat_history', 'user_input'];

const OVERRIDE_FIELDS = { char_description: 'description', char_personality: 'personality', scenario: 'scenario', persona_description: 'persona', dialogue_examples: 'mesExamples' };

function customConnection(api, base) {
    return {
        ...(base ?? {}), id: '', provider: 'openai', postProcessing: base?.postProcessing ?? '', extraBody: '', extraHeaders: '',
        model: api.model ?? base?.model ?? '', baseUrl: String(api.apiurl).replace(/\/+$/, ''),
    };
}

/** 自定义接口：浏览器直接请求（不经过本地代理，本地服务不替脚本转发任意地址） */
async function requestCustom(api, req, signal) {
    const base = String(api.apiurl).replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}${req.path}`;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}) },
        body: JSON.stringify(req.body),
        signal,
    });
}

/**
 * @param {object} config 酒馆助手的 GenerateConfig / GenerateRawConfig
 * @param {{raw?: boolean}} mode raw = generateRaw（不用预设，按 ordered_prompts 拼）
 * @returns {Promise<string|{content: string, reasoning?: string}>}
 */
export async function scriptGenerate(config = {}, { raw = false } = {}) {
    const cfg = config ?? {};
    const id = String(cfg.generation_id ?? uuid());
    const base = activeConnection();
    const custom = cfg.custom_api?.apiurl ? cfg.custom_api : null;
    if (!base && !custom) throw new Error('还没有配置 API 连接');
    const conn = custom ? customConnection(custom, base) : { ...base, ...(cfg.custom_api?.model ? { model: cfg.custom_api.model } : {}) };
    const session = getSession();
    const sub = (t) => (session ? session.substitute(String(t ?? '')) : String(t ?? ''));
    const userInput = cfg.user_input === undefined || cfg.user_input === null ? '' : String(cfg.user_input);
    const ov = cfg.overrides ?? {};

    await eventSource.emit('js_generation_requested', id, raw ? 'generateRaw' : 'generate', cfg);

    let messages = [];
    let prefill = '';
    if (session) {
        await flushPending();
        const fieldOverrides = {};
        for (const [k, f] of Object.entries(OVERRIDE_FIELDS)) if (typeof ov[k] === 'string') fieldOverrides[f] = ov[k];
        const injects = (cfg.injects ?? []).filter(x => x && x.content && x.position !== 'none');
        const saved = { ...session.extensionPrompts };
        injects.forEach((x, i) => { session.extensionPrompts[`th_gen_${id}_${i}`] = { value: String(x.content), position: 1, depth: Number(x.depth ?? 0), role: x.role ?? 'system' }; });
        let prepared;
        try {
            await ui.beforePrompt?.(session, 'quiet');
            prepared = await session.preparePrompt({
                type: 'quiet',
                // 酒馆的“静默提示词”：作为最后一条 system 指令，而不是一条用户消息
                quietPrompt: cfg.quiet_prompt ? String(cfg.quiet_prompt) : '',
                dryRun: true,
                maxHistory: typeof cfg.max_chat_history === 'number' ? cfg.max_chat_history : undefined,
                historyOverride: Array.isArray(ov.chat_history?.prompts) ? ov.chat_history.prompts.map(p => ({ role: p.role, content: sub(p.content) })) : undefined,
                appendHistory: !raw && userInput ? [{ role: 'user', content: sub(userInput) }] : undefined,
                fieldOverrides,
            });
        } finally {
            session.extensionPrompts = saved;
        }
        if (raw) {
            const wi = prepared.worldInfo ?? {};
            const f = prepared.fields ?? {};
            const builtin = {
                world_info_before: () => [{ role: 'system', content: typeof ov.world_info_before === 'string' ? ov.world_info_before : wi.worldInfoBefore }],
                world_info_after: () => [{ role: 'system', content: typeof ov.world_info_after === 'string' ? ov.world_info_after : wi.worldInfoAfter }],
                persona_description: () => [{ role: 'system', content: f.persona }],
                char_description: () => [{ role: 'system', content: f.description }],
                char_personality: () => [{ role: 'system', content: f.personality }],
                scenario: () => [{ role: 'system', content: f.scenario }],
                dialogue_examples: () => [{ role: 'system', content: f.mesExamples }],
                chat_history: () => (prepared.history ?? []).map(h => ({ role: h.narrator ? 'system' : h.role, content: h.content })),
                user_input: () => [{ role: 'user', content: sub(userInput) }],
            };
            for (const p of cfg.ordered_prompts ?? RAW_PROMPT_ORDER) {
                if (typeof p === 'string') messages.push(...(builtin[p]?.() ?? []));
                else if (p && typeof p === 'object' && p.content !== undefined) messages.push({ role: p.role ?? 'system', content: sub(p.content) });
            }
            // 没排进 ordered_prompts 的额外注入放在最后一条之前
            for (const x of injects) messages.splice(Math.max(0, messages.length - Number(x.depth ?? 0)), 0, { role: x.role ?? 'system', content: sub(x.content) });
        } else {
            messages = prepared.messages;
            prefill = prepared.prefill;
        }
    } else {
        for (const p of cfg.ordered_prompts ?? ['user_input']) {
            if (p === 'user_input') messages.push({ role: 'user', content: userInput });
            else if (p && typeof p === 'object' && p.content !== undefined) messages.push({ role: p.role ?? 'system', content: String(p.content) });
        }
    }
    messages = messages.filter(m => m && typeof m.content === 'string' && m.content.trim());
    if (!messages.length) throw new Error('没有可以发送的提示词');

    const params = samplerParams(state.preset?.data ?? {});
    for (const k of ['max_tokens', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k']) {
        const v = cfg.custom_api?.[k];
        if (typeof v === 'number') params[k] = v;
    }
    const stream = !!cfg.should_stream;
    // 脚本发起的请求同样经过 CHAT_COMPLETION_SETTINGS_READY（酒馆里所有对话补全请求都会）
    messages = (await settingsReady(conn, params, messages, session?.names)).messages;
    const req = buildRequest({ ...conn, stream }, { messages, prefill, params, names: session?.names ?? { user: 'User', char: 'Assistant' } });

    const ac = new AbortController();
    scriptGens.set(id, { ac, silent: !!cfg.should_silence });
    if (!cfg.should_silence) ui.setStatus?.('脚本正在请求生成…');
    await eventSource.emit('js_generation_started', id);
    let last = '';
    const onDelta = (text) => {
        if (!stream || text === last) return;
        const inc = text.startsWith(last) ? text.slice(last.length) : text;
        last = text;
        eventSource.emit('js_stream_token_received_fully', text, id);
        eventSource.emit('js_stream_token_received_incrementally', inc, id);
        broadcastEvent('js_stream_token_received_fully', text, id);
        broadcastEvent('js_stream_token_received_incrementally', inc, id);
    };
    try {
        const send = () => (custom
            ? requestOnce(conn, req, ac.signal, onDelta, (payload, signal) => requestCustom(custom, payload, signal))
            : requestOnce(conn, req, ac.signal, onDelta));
        const retry = state.settings.retry ?? {};
        const max = retry.enabled && !custom ? Number(retry.maxRetries ?? 2) : 0;
        let r, err;
        for (let attempt = 0; attempt <= max; attempt++) {
            if (attempt > 0) await sleep(Number(retry.delayMs ?? 2000) * attempt);
            if (ac.signal.aborted) break;
            try { r = await send(); break; } catch (e) {
                err = e;
                if (ac.signal.aborted || e.name === 'AbortError' || !(e instanceof GenError) || !e.retryable) break;
            }
        }
        if (!r) {
            if (ac.signal.aborted) throw new Error('生成已停止');
            throw err ?? new Error('生成失败');
        }
        const sp = splitThinking(r.text);
        const content = sp.reasoning || sp.open ? sp.text : r.text;
        const reasoning = [r.reasoning, sp.reasoning].filter(Boolean).join('\n\n');
        await eventSource.emit('js_generation_ended', content, id);
        broadcastEvent('js_generation_ended', content, id);
        return cfg.should_return_reasoning ? { content, reasoning: reasoning || undefined } : content;
    } finally {
        scriptGens.delete(id);
        if (!cfg.should_silence && !state.generating) ui.setStatus?.('');
    }
}

export function stopScriptGeneration(id) {
    const g = scriptGens.get(String(id));
    if (!g) return false;
    g.ac.abort();
    return true;
}

export function stopAllScriptGeneration() {
    const any = scriptGens.size > 0;
    for (const g of scriptGens.values()) g.ac.abort();
    return any;
}

/** 静默生成（前端卡 / 斜杠命令 / EJS 用），不写入聊天 */
export async function generateQuiet(cfg = {}) {
    const r = await scriptGenerate({ quiet_prompt: cfg.user_input ?? cfg.prompt ?? cfg.quietPrompt ?? '', should_silence: cfg.should_silence ?? false });
    return typeof r === 'string' ? r : r?.content ?? '';
}

/** 预览：只组提示词不发送 */
export async function previewPrompt(type = 'normal') {
    const session = getSession();
    if (!session) return null;
    const res = await session.preparePrompt({ type, dryRun: true });
    const conn = activeConnection();
    const req = conn ? buildRequest(conn, { messages: res.messages, prefill: res.prefill, params: samplerParams(state.preset.data), names: session.names }) : null;
    return { ...res, request: req };
}

export { refresh };
