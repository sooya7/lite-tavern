// 接口适配：OpenAI 兼容 / Claude / Gemini 的请求体构造与流式解析。
// 浏览器只拼请求体，真正发请求由本地服务代理（key 不进浏览器）。

export const PROVIDERS = {
    openai: { label: 'OpenAI 兼容（中转/DeepSeek/OpenRouter 等）', defaultBase: 'https://api.openai.com/v1' },
    claude: { label: 'Claude（Anthropic 官方格式）', defaultBase: 'https://api.anthropic.com' },
    gemini: { label: 'Gemini（Google AI Studio）', defaultBase: 'https://generativelanguage.googleapis.com' },
};

export const PROMPT_PLACEHOLDER = "Let's get started.";

/**
 * 酒馆的提示词后处理（merge / semi / strict / single）
 * @param {object[]} messages
 * @param {string} mode
 * @param {{user: string, char: string}} names
 */
export function postProcessMessages(messages, mode, names = {}) {
    if (!mode) return messages;
    const strict = mode === 'semi' || mode === 'strict' || mode === 'single';
    const placeholders = mode === 'strict';
    const single = mode === 'single';
    let msgs = messages.map(m => {
        let content = m.content ?? '';
        let role = m.role;
        if (m.name && role !== 'system' && !content.startsWith(`${m.name}: `)) content = `${m.name}: ${content}`;
        if (single) {
            if (role === 'assistant' && names.char && !content.startsWith(`${names.char}: `)) content = `${names.char}: ${content}`;
            if (role === 'user' && names.user && !content.startsWith(`${names.user}: `)) content = `${names.user}: ${content}`;
            role = 'user';
        }
        return { role, content };
    });
    const merge = (list) => {
        const out = [];
        for (const m of list) {
            const last = out[out.length - 1];
            if (last && last.role === m.role && m.content) last.content += '\n\n' + m.content;
            else out.push({ ...m });
        }
        if (!out.length) out.push({ role: 'user', content: PROMPT_PLACEHOLDER });
        return out;
    };
    msgs = merge(msgs);
    if (strict) {
        for (let i = 1; i < msgs.length; i++) if (msgs[i].role === 'system') msgs[i].role = 'user';
        if (placeholders && msgs.length) {
            if (msgs[0].role === 'system' && (msgs.length === 1 || msgs[1].role !== 'user')) msgs.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER });
            else if (msgs[0].role !== 'system' && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
        }
        msgs = merge(msgs);
    }
    return msgs;
}

function stripMeta(messages) {
    return messages.map(m => {
        const out = { role: m.role, content: m.content };
        if (m.name) out.name = m.name;
        return out;
    });
}

/**
 * 构造请求
 * @param {object} conn 连接配置 {provider, model, postProcessing, prefillAsAssistant, extraBody, sendExtraSamplers, thinkingBudget, includeThoughts}
 * @param {{messages: object[], prefill?: string, params: object, names?: object}} req
 * @returns {{path: string, method: string, body: object, stream: boolean}}
 */
export function buildRequest(conn, { messages, prefill = '', params, names }) {
    const stream = conn.stream === undefined ? params.stream : !!conn.stream;
    let extra = {};
    if (conn.extraBody) {
        try { extra = typeof conn.extraBody === 'string' ? JSON.parse(conn.extraBody) : conn.extraBody; } catch { extra = {}; }
    }
    switch (conn.provider) {
        case 'claude': return { ...buildClaude(conn, messages, prefill, params, names, stream, extra), method: 'POST', stream };
        case 'gemini': return { ...buildGemini(conn, messages, prefill, params, stream, extra), method: 'POST', stream };
        default: return { ...buildOpenAI(conn, messages, prefill, params, names, stream, extra), method: 'POST', stream };
    }
}

function buildOpenAI(conn, messages, prefill, params, names, stream, extra) {
    let msgs = postProcessMessages(stripMeta(messages), conn.postProcessing, names);
    if (prefill && conn.prefillAsAssistant) msgs.push({ role: 'assistant', content: prefill });
    const body = {
        model: conn.model,
        messages: msgs,
        temperature: params.temperature,
        top_p: params.top_p,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        max_tokens: params.max_tokens,
        stream,
    };
    if (params.seed >= 0) body.seed = params.seed;
    if (conn.sendExtraSamplers) {
        if (params.top_k > 0) body.top_k = params.top_k;
        if (params.min_p > 0) body.min_p = params.min_p;
        if (params.top_a > 0) body.top_a = params.top_a;
        if (params.repetition_penalty !== 1) body.repetition_penalty = params.repetition_penalty;
    }
    if (params.reasoning_effort && !['auto', ''].includes(params.reasoning_effort)) body.reasoning_effort = params.reasoning_effort;
    if (stream && conn.streamUsage) body.stream_options = { include_usage: true };
    return { path: '/chat/completions', body: { ...body, ...extra } };
}

function toClaudeContent(text) {
    return [{ type: 'text', text }];
}

function buildClaude(conn, messages, prefill, params, names, stream, extra) {
    const msgs = stripMeta(messages);
    const system = [];
    let i = 0;
    while (i < msgs.length && msgs[i].role === 'system') { if (msgs[i].content) system.push(msgs[i].content); i++; }
    const rest = msgs.slice(i).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const merged = [];
    for (const m of rest) {
        if (!m.content) continue;
        const last = merged[merged.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + m.content;
        else merged.push({ ...m });
    }
    if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '[Start a new chat]' });
    const pre = String(prefill ?? '').trimEnd();
    if (pre) {
        const last = merged[merged.length - 1];
        if (last.role === 'assistant') last.content += '\n\n' + pre;
        else merged.push({ role: 'assistant', content: pre });
    }
    // Claude 不接受以空白结尾的 assistant 预填充
    const last = merged[merged.length - 1];
    if (last.role === 'assistant') last.content = last.content.trimEnd();
    const body = {
        model: conn.model,
        max_tokens: params.max_tokens,
        messages: merged.map(m => ({ role: m.role, content: toClaudeContent(m.content) })),
        stream,
        temperature: Math.min(Math.max(params.temperature, 0), 1),
    };
    if (system.length) body.system = [{ type: 'text', text: system.join('\n\n') }];
    if (params.top_p < 1) body.top_p = params.top_p;
    if (params.top_k > 0) body.top_k = params.top_k;
    if (conn.thinkingBudget > 0) {
        body.thinking = { type: 'enabled', budget_tokens: Number(conn.thinkingBudget) };
        delete body.top_p; delete body.top_k; body.temperature = 1;
        if (body.max_tokens <= conn.thinkingBudget) body.max_tokens = Number(conn.thinkingBudget) + body.max_tokens;
    }
    return { path: '/v1/messages', body: { ...body, ...extra } };
}

function buildGemini(conn, messages, prefill, params, stream, extra) {
    const msgs = stripMeta(messages);
    const system = [];
    let i = 0;
    while (i < msgs.length && msgs[i].role === 'system') { if (msgs[i].content) system.push(msgs[i].content); i++; }
    const contents = [];
    for (const m of msgs.slice(i)) {
        if (!m.content) continue;
        const role = m.role === 'assistant' ? 'model' : 'user';
        const last = contents[contents.length - 1];
        if (last && last.role === role) last.parts[0].text += '\n\n' + m.content;
        else contents.push({ role, parts: [{ text: m.content }] });
    }
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: PROMPT_PLACEHOLDER }] });
    if (prefill) {
        const last = contents[contents.length - 1];
        if (last.role === 'model') last.parts[0].text += '\n\n' + prefill;
        else contents.push({ role: 'model', parts: [{ text: prefill }] });
    }
    const generationConfig = {
        temperature: params.temperature,
        topP: params.top_p,
        maxOutputTokens: params.max_tokens,
        candidateCount: 1,
    };
    if (params.top_k > 0) generationConfig.topK = params.top_k;
    if (params.seed >= 0) generationConfig.seed = params.seed;
    if (conn.includeThoughts !== false) generationConfig.thinkingConfig = { includeThoughts: true };
    if (conn.thinkingBudget > 0) generationConfig.thinkingConfig = { ...(generationConfig.thinkingConfig ?? {}), thinkingBudget: Number(conn.thinkingBudget) };
    const categories = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY'];
    const body = {
        contents,
        generationConfig,
        safetySettings: categories.map(category => ({ category, threshold: 'OFF' })),
    };
    if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
    const model = encodeURIComponent(conn.model || 'gemini-2.5-pro');
    const path = stream ? `/v1beta/models/${model}:streamGenerateContent?alt=sse` : `/v1beta/models/${model}:generateContent`;
    return { path, body: { ...body, ...extra } };
}

export function modelsPath(provider) {
    if (provider === 'claude') return '/v1/models';
    if (provider === 'gemini') return '/v1beta/models';
    return '/models';
}

export function parseModelList(provider, json) {
    if (provider === 'gemini') return (json?.models ?? []).map(m => String(m.name).replace(/^models\//, '')).filter(Boolean);
    const list = json?.data ?? json?.models ?? (Array.isArray(json) ? json : []);
    return list.map(m => (typeof m === 'string' ? m : m.id ?? m.name)).filter(Boolean).sort();
}

// ---------- 流式解析 ----------

/** 逐行解析 SSE，回调 {event, data} */
export async function* readSSE(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let event = null;
    let data = [];
    const flush = function* () {
        if (data.length) yield { event, data: data.join('\n') };
        event = null;
        data = [];
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.search(/\r?\n/)) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + (buf[nl] === '\r' ? 2 : 1));
                if (line === '') { yield* flush(); continue; }
                if (line.startsWith(':')) continue;
                const idx = line.indexOf(':');
                const field = idx < 0 ? line : line.slice(0, idx);
                const val = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '');
                if (field === 'event') event = val;
                else if (field === 'data') data.push(val);
            }
        }
        buf += decoder.decode();
        if (buf.trim()) {
            for (const line of buf.split(/\r?\n/)) if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        yield* flush();
    } finally {
        reader.releaseLock?.();
    }
}

/**
 * 把一个 SSE 事件解析成增量：{text?, reasoning?, done?, error?, finishReason?, usage?}
 */
export function parseStreamEvent(provider, ev) {
    if (!ev?.data) return null;
    if (ev.data === '[DONE]') return { done: true };
    let j;
    try { j = JSON.parse(ev.data); } catch { return null; }
    if (j.error) return { error: j.error.message ?? JSON.stringify(j.error) };
    if (provider === 'claude') {
        if (j.type === 'content_block_delta') {
            if (j.delta?.type === 'text_delta') return { text: j.delta.text };
            if (j.delta?.type === 'thinking_delta') return { reasoning: j.delta.thinking };
        }
        if (j.type === 'message_delta') return { finishReason: j.delta?.stop_reason, usage: j.usage };
        if (j.type === 'message_stop') return { done: true };
        if (j.type === 'error') return { error: j.error?.message ?? 'Claude error' };
        return null;
    }
    if (provider === 'gemini') {
        const cand = j.candidates?.[0];
        if (!cand) {
            if (j.promptFeedback?.blockReason) return { error: `Gemini 拒绝了请求：${j.promptFeedback.blockReason}` };
            return null;
        }
        let text = '', reasoning = '';
        for (const p of cand.content?.parts ?? []) {
            if (p.thought) reasoning += p.text ?? '';
            else text += p.text ?? '';
        }
        return { text, reasoning, finishReason: cand.finishReason };
    }
    const choice = j.choices?.[0];
    if (!choice) return j.usage ? { usage: j.usage } : null;
    const d = choice.delta ?? choice.message ?? {};
    return {
        text: d.content ?? choice.text ?? '',
        reasoning: d.reasoning_content ?? d.reasoning ?? '',
        finishReason: choice.finish_reason,
    };
}

/** 非流式响应 → {text, reasoning} */
export function parseFullResponse(provider, j) {
    if (j?.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    if (provider === 'claude') {
        let text = '', reasoning = '';
        for (const b of j.content ?? []) {
            if (b.type === 'text') text += b.text;
            if (b.type === 'thinking') reasoning += b.thinking;
        }
        return { text, reasoning };
    }
    if (provider === 'gemini') {
        const cand = j.candidates?.[0];
        if (!cand) throw new Error(j.promptFeedback?.blockReason ? `Gemini 拒绝了请求：${j.promptFeedback.blockReason}` : 'Gemini 没有返回内容');
        let text = '', reasoning = '';
        for (const p of cand.content?.parts ?? []) {
            if (p.thought) reasoning += p.text ?? ''; else text += p.text ?? '';
        }
        return { text, reasoning };
    }
    const m = j.choices?.[0]?.message ?? {};
    return { text: m.content ?? j.choices?.[0]?.text ?? '', reasoning: m.reasoning_content ?? m.reasoning ?? '' };
}

/**
 * 推理内容自动解析：回复开头的 <think>...</think> 拆到 reasoning。
 * 流式时可反复调用（传累计文本）。
 */
export function splitThinking(text, prefix = '<think>', suffix = '</think>') {
    const s = String(text ?? '');
    const lead = s.match(/^\s*/)[0].length;
    if (!prefix || !s.startsWith(prefix, lead)) return { text: s, reasoning: '', open: false };
    const start = lead + prefix.length;
    const end = s.indexOf(suffix, start);
    if (end < 0) return { text: '', reasoning: s.slice(start).replace(/^\n/, ''), open: true };
    return { text: s.slice(end + suffix.length).replace(/^\s*\n/, ''), reasoning: s.slice(start, end).replace(/^\n/, '').replace(/\n$/, ''), open: false };
}
