// 极简路由与 HTTP 工具（零依赖）
import fs from 'node:fs';
import path from 'node:path';

export class Router {
    constructor() {
        this.routes = [];
    }

    add(method, pattern, handler) {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/\/:(\w+)(\*)?/g, (_, k, star) => {
            keys.push(k);
            return star ? '/(.+)' : '/([^/]+)';
        }) + '/?$');
        this.routes.push({ method, re, keys, handler });
    }

    get(p, h) { this.add('GET', p, h); }
    post(p, h) { this.add('POST', p, h); }
    put(p, h) { this.add('PUT', p, h); }
    delete(p, h) { this.add('DELETE', p, h); }

    match(method, pathname) {
        for (const r of this.routes) {
            if (r.method !== method) continue;
            const m = pathname.match(r.re);
            if (!m) continue;
            const params = {};
            r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
            return { handler: r.handler, params };
        }
        return null;
    }
}

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function sendJson(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(text);
}

export async function readBody(req, limit = 200 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) throw new HttpError(413, '请求体太大');
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

export async function readJson(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        throw new HttpError(400, 'JSON 格式错误');
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

export function mimeOf(file) {
    return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** 把 rel 解析到 root 下，越界返回 null */
export function safeJoin(root, rel) {
    const full = path.resolve(root, '.' + path.sep + rel);
    const r = path.resolve(root);
    if (full !== r && !full.startsWith(r + path.sep)) return null;
    return full;
}

export function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
            sendText(res, 404, 'Not found');
            return;
        }
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag });
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeOf(file), 'Content-Length': st.size, ETag: etag, 'Cache-Control': cache });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
}
