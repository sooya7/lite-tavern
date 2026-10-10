#!/usr/bin/env node
// 轻酒馆本地服务：静态页面 + 数据存储 + LLM 代理 + 酒馆导入。零依赖，Node 18+。
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { Router, HttpError, sendJson, sendText, readBody, readJson, serveFile, safeJoin, notModified } from './server/http.mjs';
import { Store, sanitizeName, defaultAvatar } from './server/store.mjs';
import { proxyRequest } from './server/proxy.mjs';
import { GenJobs } from './server/gen-jobs.mjs';
import { detectStDirs, scanStDir, importFromSt } from './server/st-import.mjs';
import { registerStCompat, registerVectorApi, VectorStore, serveExtensionFile, csrfToken, EXT_URL_PREFIX } from './server/st-compat.mjs';
import { flattenScriptTrees, scriptTreesOf } from './public/js/core/scripts.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 前后端约定的版本。保存的规矩变了就加一：还开着旧页面的浏览器再来保存会被挡住并提示刷新，
// 免得旧页面按老规矩（比如不带版本号）把别处刚写的内容盖掉。
const CLIENT_PROTOCOL = '2';
/** 保存请求里前端带回来的“我读到的是哪一版 / 用户选了覆盖” */
const writeCheck = (req) => ({ expect: String(req.headers['x-expect'] ?? ''), force: req.headers['x-force'] === '1' });
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
    // 酒馆（SillyTavern / Luker）的用户数据目录：填了就和它共用角色卡、聊天、世界书、预设
    stData: String(args['st-data'] ?? process.env.LT_ST_DATA ?? ''),
    open: !!args.open,
    // 酒馆第三方插件目录（每个子目录一个插件，和酒馆的 public/scripts/extensions/third-party 一样）；可以直接指向酒馆那份
    extDir: '',
    // 服务器代生成：生成完成后等页面确认多久（毫秒），过了就由服务器自己写进聊天
    genGraceMs: Math.max(1000, Number(args['gen-grace'] ?? process.env.LT_GEN_GRACE_MS ?? 15000) || 15000),
};
config.extDir = path.resolve(String(args['extensions-dir'] ?? process.env.LT_EXTENSIONS ?? path.join(config.data, 'extensions')));

const isLocalHost = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
if (!isLocalHost && !config.password) {
    console.error('监听非本机地址时必须设置访问密码：--password 你的密码（否则局域网里任何人都能用你的 API Key）');
    process.exit(1);
}

let store;
try {
    store = new Store(config.data, { stData: config.stData });
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
const router = new Router();
const genJobs = new GenJobs(store, { graceMs: config.genGraceMs });
const sessionToken = config.password ? crypto.createHash('sha256').update(`${config.password}|${config.data}`).digest('hex') : '';

function isAuthed(req) {
    if (!config.password) return true;
    const cookie = req.headers.cookie ?? '';
    if (cookie.split(/;\s*/).some(c => c === `lt_auth=${sessionToken}`)) return true;
    const auth = req.headers.authorization ?? '';
    return auth === `Bearer ${config.password}`;
}

// ---------- 状态 ----------
router.get('/api/ping', async () => ({ ok: true, version: '0.1.0', protocol: CLIENT_PROTOCOL, data: config.data, shared: store.stData, auth: !!config.password, genJobs: true, genGraceMs: config.genGraceMs }));

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
router.get('/api/characters/:file', async (req, res, { file }) => {
    const v = await store.versionOf('characters', file);
    res.setHeader('X-Version', v);
    if (notModified(req, res, v)) return undefined;
    return store.readCard(file);
});
router.get('/api/characters/:file/avatar', async (req, res, { file }) => {
    const url = new URL(req.url, 'http://x');
    // ?thumb=1 给列表用的小图；带了 ?v=（原图 mtime）就允许浏览器长期缓存，省掉每张头像一次 304 往返
    const versioned = url.searchParams.has('v');
    if (url.searchParams.get('thumb') === '1') {
        const thumb = await store.cardThumbnail(file).catch(() => null);
        if (thumb) {
            serveFile(req, res, thumb, { cache: versioned ? 'private, max-age=31536000, immutable' : 'no-cache' });
            return undefined;
        }
    }
    serveFile(req, res, store.p('characters', sanitizeName(file)), { cache: 'no-cache' });
    return undefined;
});
router.put('/api/characters/:file', async (req, res, { file }) => {
    const card = await store.saveCard(file, await readJson(req), writeCheck(req));
    res.setHeader('X-Version', await store.versionOf('characters', file));
    return card;
});
router.put('/api/characters/:file/avatar', async (req, res, { file }) => {
    await store.setCardAvatar(file, await readBody(req));
    res.setHeader('X-Version', await store.versionOf('characters', file));
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
    // 卡里自带了什么，导入完告诉界面一声（世界书已另存并绑定；脚本、正则留在卡里，打开这张卡就生效）
    const scripts = flattenScriptTrees(scriptTreesOf(card.data.extensions));
    return { file, name: card.data.name, world, scripts: scripts.length, scriptsOn: scripts.filter(x => x.on).length, regex: card.data.extensions?.regex_scripts?.length ?? 0 };
});
// 用新版卡文件原地更新一张卡（聊天记录保留，卡的内容和自带世界书直接覆盖，不留备份）
router.post('/api/characters/:file/update', async (req, res, { file }) => {
    const bytes = await readBody(req);
    const r = await store.updateCard(file, bytes);
    const scripts = flattenScriptTrees(scriptTreesOf(r.card.data.extensions));
    return {
        file: r.file, name: r.card.data.name, oldName: r.oldName, version: r.card.data.character_version ?? '',
        world: r.world, worldReplaced: r.worldReplaced, avatarChanged: r.avatarChanged,
        scripts: scripts.length, scriptsOn: scripts.filter(x => x.on).length, regex: r.card.data.extensions?.regex_scripts?.length ?? 0,
    };
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
router.get('/api/recent-chats', async (req) => store.recentChats(Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 30)));
router.get('/api/chats/:char', async (req, res, { char }) => store.listChats(char));
router.get('/api/chats/:char/:name', async (req, res, { char, name }) => {
    // 先取版本号再读内容：中间要是被别处改了，前端拿到的版本号偏旧，下次保存会被拦下来（宁可多问一次）
    const version = await store.chatVersion(char, name);
    res.setHeader('X-Version', version);
    if (notModified(req, res, version)) return undefined;
    const text = await store.readChat(char, name);
    sendText(res, 200, text, 'application/jsonl; charset=utf-8');
    return undefined;
});
/**
 * 写聊天都在这个聊天的写入锁里做（服务器代写回复也用这把锁）。带 X-LT-Gen-Job 的保存同时是对那次代生成的确认：
 * 服务器已经替页面写过了就拒绝（409 gen-persisted），写成功了服务器就不会再写。
 */
async function chatWrite(req, char, name, fn) {
    const jobId = String(req.headers['x-lt-gen-job'] ?? '');
    return store.withChatLock(char, name, async () => {
        const job = jobId ? genJobs.beforeClientSave(jobId) : null;
        let ok = false;
        try {
            const out = await fn();
            ok = true;
            return out;
        } finally {
            genJobs.afterClientSave(job, ok);
        }
    });
}
router.put('/api/chats/:char/:name', async (req, res, { char, name }) => {
    const text = (await readBody(req)).toString('utf8');
    const first = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : undefined);
    try { JSON.parse(first); } catch { throw new HttpError(400, '聊天格式不对'); }
    const version = await chatWrite(req, char, name, () => store.saveChat(char, name, text, writeCheck(req)));
    return { ok: true, version };
});
router.patch('/api/chats/:char/:name', async (req, res, { char, name }) => {
    const patch = await readJson(req);
    const version = await chatWrite(req, char, name, () => store.patchChat(char, name, patch, { expect: String(req.headers['x-expect'] ?? '') }));
    return { ok: true, version };
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
    router.get(`/api/${kind}/:name`, async (req, res, { name }) => {
        const v = await store.versionOf(kind, name);
        res.setHeader('X-Version', v);
        if (notModified(req, res, v)) return undefined;
        return store.readJson(kind, name);
    });
    router.put(`/api/${kind}/:name`, async (req, res, { name }) => {
        await store.saveJson(kind, name, await readJson(req), writeCheck(req));
        res.setHeader('X-Version', await store.versionOf(kind, name));
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

// ---------- 服务器代生成（见 server/gen-jobs.mjs） ----------
router.post('/api/gen', async (req) => genJobs.create(await readJson(req)));
router.get('/api/gen/active', async (req) => {
    const url = new URL(req.url, 'http://x');
    return genJobs.active(url.searchParams.get('char') ?? '', url.searchParams.get('chat') ?? '');
});
router.get('/api/gen/:id', async (req, res, { id }) => genJobs.summary(genJobs.mustGet(id)));
router.get('/api/gen/:id/events', async (req, res, { id }) => {
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? 0) || 0;
    genJobs.subscribe(id, after, req, res);
    return undefined;
});
router.post('/api/gen/:id/abort', async (req, res, { id }) => genJobs.cancel(id));
router.post('/api/gen/:id/claim', async (req, res, { id }) => genJobs.claim(id));
router.post('/api/gen/:id/ack', async (req, res, { id }) => genJobs.ack(id));

// ---------- 酒馆插件兼容接口 ----------
registerStCompat(router, store, { extDir: config.extDir });
// 向量存在轻酒馆自己的数据目录里（不和酒馆共用：酒馆那边的插件把向量放在浏览器里）
registerVectorApi(router, new VectorStore(path.join(config.data, 'vectors')));

// ---------- 酒馆导入 ----------
router.get('/api/st/detect', async () => [...new Set([store.stData, ...detectStDirs()].filter(Boolean))]);
router.post('/api/st/scan', async (req) => scanStDir((await readJson(req)).dir, store));
router.post('/api/st/import', async (req) => importFromSt(store, await readJson(req)));

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
        if (pathname.startsWith('/api/')) {
            if (pathname !== '/api/login' && pathname !== '/api/ping' && !isAuthed(req)) throw new HttpError(401, '需要登录');
            // 酒馆插件调的兼容接口不带轻酒馆的版本头，放行（世界书写入走插件自己的整本覆盖，和酒馆行为一致）
            const readOnlyCompat = pathname.startsWith('/api/backends/') || pathname.startsWith('/api/vector/') || pathname === '/api/settings/get' || pathname.startsWith('/api/worldinfo/') || pathname.startsWith('/api/extensions/');
            const writes = req.method !== 'GET' && req.method !== 'HEAD' && pathname !== '/api/login' && !pathname.startsWith('/api/llm/') && !readOnlyCompat;
            if (writes && req.headers['x-lt-client'] !== CLIENT_PROTOCOL) {
                throw new HttpError(409, '页面是旧版本，请刷新页面后再操作（这次没有保存）', 'stale-client');
            }
            const m = router.match(req.method, pathname);
            if (!m) throw new HttpError(404, `没有这个接口：${req.method} ${pathname}`);
            const result = await m.handler(req, res, m.params);
            if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
            return;
        }
        if (pathname === '/csrf-token') {
            if (!isAuthed(req)) throw new HttpError(401, '需要登录');
            return csrfToken(res);
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        if (pathname.startsWith(EXT_URL_PREFIX)) {
            if (!isAuthed(req)) throw new HttpError(401, '需要登录');
            return serveExtensionFile(req, res, config.extDir, pathname);
        }
        const rel = pathname === '/' ? '/index.html' : pathname;
        const file = safeJoin(PUBLIC, rel);
        if (!file) throw new HttpError(400, 'Bad path');
        // 首页每次都取新的；带 ?v= 的（入口脚本、前端卡运行时）随版本号长期缓存；其余靠 ETag 协商
        const versioned = new URL(req.url, 'http://x').searchParams.has('v');
        serveFile(req, res, file, { cache: rel === '/index.html' ? 'no-store' : versioned ? 'public, max-age=31536000, immutable' : rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache' });
    } catch (e) {
        const status = e.status ?? 500;
        if (status >= 500) console.error(e);
        if (!res.headersSent) sendJson(res, status, { error: { message: e.message ?? String(e), ...(e instanceof HttpError && e.code ? { code: e.code } : {}) } });
        else res.end();
    }
});

server.listen(config.port, config.host, () => {
    const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
    console.log(`轻酒馆已启动：${url}`);
    console.log(`数据目录：${config.data}`);
    if (store.stData) console.log(`角色卡、聊天、世界书、预设与酒馆共用：${store.stData}`);
    if (!isLocalHost) console.log('已开启访问密码（局域网/手机访问时输入）');
    if (config.open) {
        const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd);
    }
});
