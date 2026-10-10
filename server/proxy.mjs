// LLM 请求代理：浏览器只发 {path, body}，服务端补上地址与密钥后转发，流式原样回传。
import { HttpError, sendJson } from './http.mjs';
import { DEFAULT_RETRY } from '../public/js/core/llm.js';

function authHeaders(conn, key) {
    const h = {};
    if (!key) return h;
    switch (conn.provider) {
        case 'claude':
            h['x-api-key'] = key;
            break;
        case 'gemini':
            h['x-goog-api-key'] = key;
            break;
        default:
            h.Authorization = `Bearer ${key}`;
    }
    return h;
}

function buildUrl(conn, p) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.includes('://') || p.startsWith('//')) throw new HttpError(400, '请求路径不合法');
    const base = String(conn.baseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new HttpError(400, '接口地址需要以 http:// 或 https:// 开头');
    return base + p;
}

function parseHeaders(text) {
    if (!text) return {};
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch { /* 也支持 "Key: Value" 每行一个 */ }
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}

/** 流式请求等上游“开口”最多等多久（毫秒）；非流式的回复是一次给完的，等多久取决于它写多长，不套这条 */
export function firstByteTimeoutMs(settings, payload) {
    if (!(payload?.stream ?? payload?.body?.stream)) return 0;
    const sec = Number(settings?.retry?.firstByteSec ?? DEFAULT_RETRY.firstByteSec);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 0;
}

/**
 * 按连接配置向上游发请求，返回 fetch 的 Response。浏览器转发（proxyRequest）和服务器代生成（gen-jobs.mjs）共用。
 *
 * 流式请求会等上游“开口”——收到响应头和第一块数据——再返回；超过设置的秒数（retry.firstByteSec，默认 30）
 * 还没有任何数据就断开这一次，抛 504（可重试）。开口之后这条限制就不管了，后面写多久都不会因为它被掐断。
 * 起因：2026-10-10 一次请求发出去后中转 5 分钟没有任何回应，Node 的 fetch 默认等满 5 分钟才报错。
 * @param {import('./store.mjs').Store} store
 * @param {{path: string, method?: string, body?: object, stream?: boolean}} payload
 */
export async function openUpstream(store, connId, payload, signal) {
    const settings = await store.getSettings();
    const conn = (settings.connections ?? []).find(c => c.id === connId);
    if (!conn) throw new HttpError(404, '找不到这个连接配置');
    const secrets = await store.getSecrets();
    const key = secrets[connId];
    const url = buildUrl(conn, payload.path);
    const headers = {
        'Content-Type': 'application/json',
        ...(conn.provider === 'claude' ? { 'anthropic-version': '2023-06-01' } : {}),
        ...parseHeaders(conn.extraHeaders),
        ...authHeaders(conn, key),
    };
    const waitMs = firstByteTimeoutMs(settings, payload);
    // 等开口的计时用自己的中止信号；外面（停止按钮、页面断开）中止时跟着中止，返回之后也一直有效
    const ac = new AbortController();
    if (signal?.aborted) ac.abort(signal.reason);
    else signal?.addEventListener('abort', () => ac.abort(signal.reason), { once: true });
    let timedOut = false;
    const timer = waitMs ? setTimeout(() => { timedOut = true; ac.abort(); }, waitMs) : null;
    try {
        const res = await fetch(url, {
            method: payload.method || 'POST',
            headers,
            body: payload.method === 'GET' ? undefined : JSON.stringify(payload.body ?? {}),
            signal: ac.signal,
        });
        if (!timer || !res.body) return res;
        // 读到第一块数据才算开口（有的中转先回响应头，然后一直不出字）
        const reader = res.body.getReader();
        const first = await reader.read();
        const body = new ReadableStream({
            start(ctl) { if (first.done) ctl.close(); else ctl.enqueue(first.value); },
            async pull(ctl) {
                try {
                    const r = await reader.read();
                    if (r.done) ctl.close(); else ctl.enqueue(r.value);
                } catch (e) { ctl.error(e); }
            },
            cancel(reason) { return reader.cancel(reason); },
        });
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
        if (timedOut && !signal?.aborted) throw new HttpError(504, `接口 ${Math.round(waitMs / 1000)} 秒没有任何回应（地址 ${conn.baseUrl}）`, 'first-byte-timeout');
        if (signal?.aborted || ac.signal.aborted) throw e;
        const cause = e?.cause?.code || e?.cause?.message || e.message;
        throw new HttpError(502, `连不上接口：${cause}（地址 ${conn.baseUrl}）`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {import('./store.mjs').Store} store
 */
export async function proxyRequest(store, req, res, connId, payload) {
    const ac = new AbortController();
    // 只看响应是否提前关闭：Node 16+ 的 req 'close' 在请求体读完时就会触发，不能拿来判断断开
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let upstream;
    try {
        upstream = await openUpstream(store, connId, payload, ac.signal);
    } catch (e) {
        if (ac.signal.aborted) return;
        if (e instanceof HttpError && (e.status === 502 || e.status === 504)) { sendJson(res, e.status, { error: { message: e.message } }); return; }
        throw e;
    }
    const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
    res.writeHead(upstream.status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Upstream-Status': String(upstream.status),
    });
    if (!upstream.body) return res.end();
    try {
        for await (const chunk of upstream.body) {
            if (!res.write(chunk)) await new Promise(r => res.once('drain', r));
        }
    } catch (e) {
        if (!ac.signal.aborted) res.write(`\n\ndata: ${JSON.stringify({ error: { message: `流中断：${e.message}` } })}\n\n`);
    } finally {
        res.end();
    }
}
