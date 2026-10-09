#!/usr/bin/env node
// 轻酒馆本地服务：静态页面 + 数据存储 + LLM 代理 + 酒馆导入。零依赖，Node 18+。
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Router, HttpError, sendJson, sendText, readBody, readJson, serveFile, safeJoin } from './server/http.mjs';
import { Store, sanitizeName, defaultAvatar } from './server/store.mjs';
import { proxyRequest } from './server/proxy.mjs';
import { detectStDirs, scanStDir, importFromSt } from './server/st-import.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) out[k] = v;
        else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
        else out[k] = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const config = {
    port: Number(args.port ?? process.env.LT_PORT ?? 8730),
    host: String(args.host ?? process.env.LT_HOST ?? '127.0.0.1'),
    data: path.resolve(String(args.data ?? process.env.LT_DATA ?? path.join(ROOT, 'data'))),
    password: args.password ?? process.env.LT_PASSWORD ?? '',
    open: !!args.open,
};

const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!isLocalHost && !config.password) {
    console.error('监听非本机地址时必须设置访问密码：--password 你的密码（否则局域网里任何人都能用你的 API Key）');
    process.exit(1);
}

const store = new Store(config.data);
const router = new Router();
const sessionToken = config.password ? crypto.createHash('sha256').update(`${config.password}|${config.data}`).digest('hex') : '';

function isAuthed(req) {
    if (!config.password) return true;
    const cookie = req.headers.cookie ?? '';
    if (cookie.split(/;\s*/).some(c => c === `lt_auth=${sessionToken}`)) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${config.password}`;
}

// ---------- 状态 ----------
router.get('/api/ping', async () => ({ ok: true, version: '0.1.0', data: config.data, auth: !!config.password }));

router.post('/api/login', async (req, res) => {
    const { password } = await readJson(req);
    if (!config.password || password !== config.password) throw new HttpError(401, '密码不对');
    res.setHeader('Set-Cookie', `lt_auth=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    return { ok: true };
});

router.get('/api/settings', async () => store.getSettings());
router.put('/api/settings', async (req) => {
    const s = await readJson(req);
    await store.saveSettings(s);
    return { ok: true };
});

// ---------- 密钥（只写不读） ----------
router.get('/api/secrets', async () => {
    const s = await store.getSecrets();
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v ? `${String(v).slice(0, 3)}…${String(v).slice(-4)}` : '']));
});
router.put('/api/secrets/:id', async (req, res, { id }) => {
    const { key } = await readJson(req);
    await store.setSecret(id, String(key ?? '').trim());
    return { ok: true };
});

// ---------- 角色卡 ----------
router.get('/api/characters', async () => store.listCharacters());
router.get('/api/characters/:file', async (req, res, { file }) => store.readCard(file));
router.get('/api/characters/:file/avatar', async (req, res, { file }) => {
    serveFile(req, res, store.p('characters', sanitizeName(file)), { cache: 'no-cache' });
    return undefined;
});
router.put('/api/characters/:file', async (req, res, { file }) => store.saveCard(file, await readJson(req)));
router.put('/api/characters/:file/avatar', async (req, res, { file }) => {
    await store.setCardAvatar(file, await readBody(req));
    return { ok: true };
});
router.delete('/api/characters/:file', async (req, res, { file }) => {
    const url = new URL(req.url, 'http://x');
    await store.deleteCard(file, { withChats: url.searchParams.get('chats') === '1' });
    return { ok: true };
});
router.post('/api/characters/import', async (req) => {
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'card'));
    const bytes = await readBody(req);
    const { file, card, world } = await store.importCard(bytes, name);
    return { file, name: card.data.name, world };
});
router.post('/api/characters/create', async (req) => {
    const card = await readJson(req);
    const file = await store.uniqueCardFile(card?.data?.name || '新角色');
    await store.writeAtomic(store.p('characters', file), Buffer.from(defaultAvatar(card?.data?.name)));
    await store.saveCard(file, card);
    return { file };
});
router.get('/api/characters/:file/export', async (req, res, { file }) => {
    const url = new URL(req.url, 'http://x');
    const card = await store.readCard(file);
    const fmt = url.searchParams.get('format') ?? 'png';
    const base = encodeURIComponent(file.replace(/\.(png|json)$/i, ''));
    if (fmt === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${base}.json` });
        res.end(JSON.stringify(card, null, 2));
    } else {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename*=UTF-8''${base}.png` });
        fs.createReadStream(store.p('characters', sanitizeName(file))).pipe(res);
    }
    return undefined;
});

// ---------- 聊天 ----------
router.get('/api/chats/:char', async (req, res, { char }) => store.listChats(char));
router.get('/api/chats/:char/:name', async (req, res, { char, name }) => {
    sendText(res, 200, await store.readChat(char, name), 'application/jsonl; charset=utf-8');
    return undefined;
});
router.put('/api/chats/:char/:name', async (req, res, { char, name }) => {
    const text = (await readBody(req)).toString('utf8');
    const first = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : undefined);
    try { JSON.parse(first); } catch { throw new HttpError(400, '聊天格式不对'); }
    await store.saveChat(char, name, text);
    return { ok: true };
});
router.post('/api/chats/:char/:name/rename', async (req, res, { char, name }) => {
    const { to } = await readJson(req);
    await store.renameChat(char, name, to);
    return { ok: true };
});
router.delete('/api/chats/:char/:name', async (req, res, { char, name }) => {
    await store.deleteChat(char, name);
    return { ok: true };
});

// ---------- 预设 / 世界书 ----------
for (const kind of ['presets', 'worlds']) {
    router.get(`/api/${kind}`, async () => store.listJson(kind));
    router.get(`/api/${kind}/:name`, async (req, res, { name }) => store.readJson(kind, name));
    router.put(`/api/${kind}/:name`, async (req, res, { name }) => {
        await store.saveJson(kind, name, await readJson(req));
        return { ok: true };
    });
    router.delete(`/api/${kind}/:name`, async (req, res, { name }) => {
        await store.deleteJson(kind, name);
        return { ok: true };
    });
    router.post(`/api/${kind}/:name/rename`, async (req, res, { name }) => {
        const { to } = await readJson(req);
        await store.renameJson(kind, name, to);
        return { ok: true };
    });
}

// ---------- 用户头像 ----------
router.get('/api/avatars/:file', async (req, res, { file }) => {
    serveFile(req, res, store.p('avatars', sanitizeName(file)), { cache: 'no-cache' });
    return undefined;
});
router.put('/api/avatars/:file', async (req, res, { file }) => {
    await store.writeAtomic(store.p('avatars', sanitizeName(file)), await readBody(req));
    return { ok: true };
});

// ---------- LLM 代理 ----------
router.post('/api/llm/:conn', async (req, res, { conn }) => {
    const payload = await readJson(req);
    await proxyRequest(store, req, res, conn, payload);
    return undefined;
});

// ---------- 酒馆导入 ----------
router.get('/api/st/detect', async () => detectStDirs());
router.post('/api/st/scan', async (req) => scanStDir((await readJson(req)).dir));
router.post('/api/st/import', async (req) => importFromSt(store, await readJson(req)));

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
        if (pathname.startsWith('/api/')) {
            if (pathname !== '/api/login' && pathname !== '/api/ping' && !isAuthed(req)) throw new HttpError(401, '需要登录');
            const m = router.match(req.method, pathname);
            if (!m) throw new HttpError(404, `没有这个接口：${req.method} ${pathname}`);
            const result = await m.handler(req, res, m.params);
            if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        const rel = pathname === '/' ? '/index.html' : pathname;
        const file = safeJoin(PUBLIC, rel);
        if (!file) throw new HttpError(400, 'Bad path');
        serveFile(req, res, file, { cache: rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
    } catch (e) {
        const status = e.status ?? 500;
        if (status >= 500) console.error(e);
        if (!res.headersSent) sendJson(res, status, { error: { message: e.message ?? String(e) } });
        else res.end();
    }
});

server.listen(config.port, config.host, () => {
    const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
    console.log(`轻酒馆已启动：${url}`);
    console.log(`数据目录：${config.data}`);
    if (!isLocalHost) console.log('已开启访问密码（局域网/手机访问时输入）');
    if (config.open) {
        const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd);
    }
});
