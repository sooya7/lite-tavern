// 发一次模型请求、读回复、按设置重试。前端（generate.js）和服务器代生成（server/gen-jobs.mjs）共用：
// 两边对“什么算失败、哪些失败该重试、错误当正文怎么认”的判断必须一样，否则断开前后表现会不同。
import { readSSE, parseStreamEvent, parseFullResponse } from './providers.js';
import { sleep } from './util.js';

/** 生成失败；retryable = 按设置可以重试（429 / 5xx / 网络抖动 / 错误当正文 / 空回复） */
export class GenError extends Error {
    constructor(message, { retryable = false, status } = {}) {
        super(message);
        this.retryable = retryable;
        this.status = status;
    }
}

/** 重试设置的默认值（和设置面板一致；state.js 的 DEFAULT_SETTINGS 也用这一份） */
export const DEFAULT_RETRY = { enabled: true, maxRetries: 2, delayMs: 2000, onEmpty: true, errorPatterns: 'failed with status (429|5\\d\\d)\nrate limit exceeded' };

/** “错误当正文”的识别规则：设置里每行一个正则，写坏的跳过 */
export function errorPatterns(retry) {
    return String(retry?.errorPatterns ?? '').split('\n').map(s => s.trim()).filter(Boolean).map(s => {
        try { return new RegExp(s, 'i'); } catch { return null; }
    }).filter(Boolean);
}

/**
 * 读一次请求的结果。res 是 fetch 的 Response（浏览器、Node 都行），onDelta(text, reasoning) 收累计到目前的全文。
 * @returns {Promise<{text: string, reasoning: string, toolCalls: any[]}>}
 */
export async function readLlmResponse(provider, req, res, onDelta = () => {}) {
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const t = await res.text();
            try { const j = JSON.parse(t); msg = j.error?.message ?? j.message ?? j.detail ?? t; } catch { msg = t || msg; }
        } catch { /* 忽略 */ }
        throw new GenError(`接口报错（${res.status}）：${String(msg).slice(0, 500)}`, { retryable: res.status === 429 || res.status >= 500, status: res.status });
    }
    let text = '', reasoning = '', toolCalls = [];
    if (req.stream && (ctype.includes('event-stream') || ctype.includes('text/plain') || !ctype.includes('json'))) {
        for await (const ev of readSSE(res.body)) {
            const d = parseStreamEvent(provider, ev);
            if (!d) continue;
            if (d.error) throw new GenError(`接口报错：${d.error}`, { retryable: /429|rate|overload|timeout|5\d\d/i.test(d.error) });
            if (d.text) text += d.text;
            if (d.reasoning) reasoning += d.reasoning;
            if (d.text || d.reasoning) onDelta(text, reasoning);
            if (d.done) break;
        }
    } else {
        const j = await res.json().catch(() => { throw new GenError('接口返回的不是 JSON'); });
        const r = parseFullResponse(provider, j);
        text = r.text;
        reasoning = r.reasoning;
        toolCalls = r.toolCalls ?? [];
        onDelta(text, reasoning);
    }
    return { text, reasoning, toolCalls };
}

/**
 * 正文生成的重试循环（主回复用；脚本自己的 generate 另有简单的循环）。
 * @param {(attempt: number) => Promise<{text: string, reasoning: string, toolCalls?: any[]}>} once 发一次请求
 * @param {{retry?: object, signal?: AbortSignal, onRetry?: (attempt: number) => void, wait?: (ms: number) => Promise<void>, log?: (e: Error) => void}} o
 * @returns {Promise<{result: object|null, error: Error|null, aborted: boolean}>}
 */
export async function generateWithRetry(once, { retry = {}, signal, onRetry, wait = sleep, log } = {}) {
    const maxRetries = retry.enabled ? Number(retry.maxRetries ?? 2) : 0;
    const patterns = errorPatterns(retry);
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) break;
        if (attempt > 0) {
            onRetry?.(attempt);
            await wait(Number(retry.delayMs ?? 2000) * attempt);
            if (signal?.aborted) break;
        }
        try {
            const r = await once(attempt);
            if (patterns.some(p => p.test(r.text.slice(0, 400))) && r.text.length < 2000) {
                throw new GenError(`接口把错误当正文返回了：${r.text.slice(0, 200)}`, { retryable: true });
            }
            if (!r.text.trim() && !r.reasoning.trim()) throw new GenError('接口返回了空回复', { retryable: !!retry.onEmpty });
            return { result: r, error: null, aborted: false };
        } catch (e) {
            if (signal?.aborted || e.name === 'AbortError') return { result: null, error: null, aborted: true };
            lastErr = e;
            log?.(e);
            if (!(e instanceof GenError) || !e.retryable) break;
        }
    }
    return { result: null, error: lastErr, aborted: !!signal?.aborted };
}
