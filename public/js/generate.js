// 生成流程：组提示词 → 发请求（流式/非流式，自动重试）→ 写回消息 → 正则/MVU/事件
import { api } from './api.js';
import { state, eventSource, event_types, saveChat, activeConnection, flushPending } from './state.js';
import { getSession, addUserMessage, refresh } from './controller.js';
import { buildRequest, readSSE, parseStreamEvent, parseFullResponse, splitThinking } from './core/providers.js';
import { samplerParams } from './core/preset.js';
import { createAssistantMessage, addSwipe, syncSwipe, messageText } from './core/chat.js';
import { humanizedDate, sleep } from './core/util.js';
import { estimateTokens } from './core/tokens.js';
import { toast } from './ui/dom.js';
import { broadcastEvent } from './ui/frontend.js';

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
async function requestOnce(conn, req, signal, onDelta) {
    const res = await api.llm(conn.id, { path: req.path, method: req.method, body: req.body, stream: req.stream }, signal);
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

    await eventSource.emit(event_types.GENERATION_STARTED, type);
    broadcastEvent('js_generation_started');

    let prompt;
    try {
        prompt = await session.preparePrompt({ type, quietPrompt: opt.quietPrompt, excludeLast });
        const evData = { chat: prompt.messages, dryRun: false, type };
        await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, evData);
        prompt.messages = evData.chat;
    } catch (e) {
        console.error(e);
        toast(`组装提示词出错：${e.message}`, 'error');
        if (removedForRegen) { chat.push(removedForRegen); ui.renderChat?.(); }
        finish();
        return null;
    }

    const preset = state.preset.data;
    const params = samplerParams(preset);
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

    // MVU：基于上一层变量应用本条更新
    if (session.mvuEnabled()) {
        broadcastEvent('mag_variable_update_started');
        const r = session.applyMvu(targetIndex);
        if (r?.errors?.length) toast(`变量更新有 ${r.errors.length} 处没执行：${r.errors[0]}`, 'warning');
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
        if (targetIndex >= 0 && chat[targetIndex]) ui.renderMessage?.(targetIndex);
    }
}

export function stopGeneration() {
    state.abort?.abort();
}

/** 静默生成（前端卡 / 插件用），不写入聊天 */
export async function generateQuiet(cfg = {}) {
    const prompt = cfg.user_input ?? cfg.prompt ?? cfg.quietPrompt ?? '';
    return generate('quiet', { quietPrompt: prompt });
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
