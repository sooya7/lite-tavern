// LLM 请求代理：浏览器只发 {path, body}，服务端补上地址与密钥后转发，流式原样回传。
import { HttpError, sendJson } from './http.mjs';

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

/**
 * @param {import('./store.mjs').Store} store
 */
export async function proxyRequest(store, req, res, connId, payload) {
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
    const ac = new AbortController();
    // 只看响应是否提前关闭：Node 16+ 的 req 'close' 在请求体读完时就会触发，不能拿来判断断开
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let upstream;
    try {
        upstream = await fetch(url, {
            method: payload.method || 'POST',
            headers,
            body: payload.method === 'GET' ? undefined : JSON.stringify(payload.body ?? {}),
            signal: ac.signal,
        });
    } catch (e) {
        if (ac.signal.aborted) return;
        const cause = e?.cause?.code || e?.cause?.message || e.message;
        sendJson(res, 502, { error: { message: `连不上接口：${cause}（地址 ${conn.baseUrl}）` } });
        return;
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
