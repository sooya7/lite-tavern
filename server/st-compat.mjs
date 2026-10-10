// 酒馆（SillyTavern）插件要用到的几个后端接口的兼容实现，让第三方插件（如柚月の记忆）不改代码就能在轻酒馆里跑。
// 只做插件实际会调的那几个：生成（OpenAI 兼容转发）、模型列表、世界书读写、设置读取、CSRF 令牌、插件目录列表。
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, sendJson, readJson, serveFile, safeJoin } from './http.mjs';

function parseHeaderText(text) {
    if (!text) return {};
    if (typeof text === 'object') return text;
    try { const o = JSON.parse(text); if (o && typeof o === 'object') return o; } catch { /* 也支持 "Key: Value" 每行一个 */ }
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}

const PASS_FIELDS = ['model', 'messages', 'temperature', 'max_tokens', 'stream', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'n', 'tools', 'tool_choice', 'response_format', 'reasoning_effort', 'logit_bias'];

/** 酒馆的生成请求体 → OpenAI 兼容的 /chat/completions 请求体 */
export function toOpenAiBody(body) {
    const out = {};
    for (const k of PASS_FIELDS) if (body[k] !== undefined && body[k] !== null && body[k] !== '') out[k] = body[k];
    if (out.max_tokens !== undefined) {
        const n = Number(out.max_tokens);
        if (Number.isFinite(n) && n > 0) out.max_tokens = Math.floor(n); else delete out.max_tokens;
    }
    for (const k of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) {
        if (out[k] === undefined) continue;
        const n = Number(out[k]);
        if (Number.isFinite(n)) out[k] = n; else delete out[k];
    }
    out.stream = body.stream === true;
    return out;
}

/** 请求要发到哪里：带了 reverse_proxy 就用它（插件自己的 API 配置），否则用轻酒馆当前的连接 */
async function resolveTarget(store, body) {
    const proxy = String(body.reverse_proxy || body.custom_url || '').trim().replace(/\/+$/, '');
    if (proxy) {
        if (!/^https?:\/\//i.test(proxy)) throw new HttpError(400, '接口地址需要以 http:// 或 https:// 开头');
        const base = proxy.replace(/\/chat\/completions$/i, '');
        const headers = { ...parseHeaderText(body.custom_include_headers) };
        if (body.proxy_password) headers.Authorization = `Bearer ${body.proxy_password}`;
        return { base, headers, label: base };
    }
    const settings = await store.getSettings();
    const conns = settings.connections ?? [];
    const conn = conns.find(c => c.id === settings.activeConnection) ?? conns[0];
    if (!conn) throw new HttpError(400, '轻酒馆里还没有连接配置');
    if (conn.provider === 'claude' || conn.provider === 'gemini') throw new HttpError(400, `插件借用主连接时只支持 OpenAI 兼容接口（当前连接是 ${conn.provider}），请在插件里单独填 API`);
    const key = (await store.getSecrets())[conn.id];
    const headers = { ...parseHeaderText(conn.extraHeaders) };
    if (key) headers.Authorization = `Bearer ${key}`;
    return { base: String(conn.baseUrl || '').replace(/\/+$/, ''), headers, label: conn.name || conn.baseUrl, model: conn.model };
}

async function pipeUpstream(res, upstream, ac) {
    const type = upstream.headers.get('content-type') ?? 'application/json';
    res.writeHead(upstream.status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
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

/** 列出插件目录：每个带 manifest.json 的子目录算一个插件 */
export function listExtensions(dir) {
    if (!dir || !fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name, 'manifest.json');
        try {
            const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            const m = JSON.parse(raw);
            out.push({
                name,
                display_name: String(m.display_name || name),
                version: String(m.version || ''),
                author: String(m.author || ''),
                description: String(m.description || ''),
                js: typeof m.js === 'string' ? m.js : '',
                css: typeof m.css === 'string' ? m.css : '',
                generate_interceptor: typeof m.generate_interceptor === 'string' ? m.generate_interceptor : '',
                loading_order: Number(m.loading_order ?? 100),
            });
        } catch { /* 没有清单或清单坏了：不算插件 */ }
    }
    return out.sort((a, b) => a.loading_order - b.loading_order || a.name.localeCompare(b.name));
}

export const EXT_URL_PREFIX = '/scripts/extensions/third-party/';

/** 插件的静态文件 */
export function serveExtensionFile(req, res, dir, pathname) {
    if (!dir) throw new HttpError(404, '没有配置插件目录');
    const rel = pathname.slice(EXT_URL_PREFIX.length);
    const file = safeJoin(dir, '/' + rel);
    if (!file) throw new HttpError(400, 'Bad path');
    serveFile(req, res, file, { cache: 'no-cache' });
}

/**
 * @param {import('./http.mjs').Router} router
 * @param {import('./store.mjs').Store} store
 * @param {{extDir: string}} opts
 */
export function registerStCompat(router, store, { extDir }) {
    router.get('/api/extensions', async () => listExtensions(extDir));

    router.post('/api/backends/chat-completions/generate', async (req, res) => {
        const body = await readJson(req);
        if (body.chat_completion_source === 'makersuite' && !/\/openai\/?$/i.test(String(body.reverse_proxy || ''))) {
            throw new HttpError(400, '轻酒馆暂不支持 Gemini 原生接口，请在插件 API 设置里改用 OpenAI 兼容地址（例如以 /v1 结尾的地址）');
        }
        const target = await resolveTarget(store, body);
        const payload = toOpenAiBody(body);
        if (!payload.model && target.model) payload.model = target.model;
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        let upstream;
        try {
            upstream = await fetch(`${target.base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...target.headers },
                body: JSON.stringify(payload),
                signal: ac.signal,
            });
        } catch (e) {
            if (ac.signal.aborted) return undefined;
            const cause = e?.cause?.code || e?.cause?.message || e.message;
            sendJson(res, 502, { error: { message: `连不上接口：${cause}（地址 ${target.label}）` } });
            return undefined;
        }
        await pipeUpstream(res, upstream, ac);
        return undefined;
    });

    router.post('/api/backends/chat-completions/status', async (req, res) => {
        const body = await readJson(req);
        const target = await resolveTarget(store, body);
        let r;
        try {
            r = await fetch(`${target.base}/models`, { headers: target.headers });
        } catch (e) {
            throw new HttpError(502, `连不上接口：${e?.cause?.code || e.message}`);
        }
        const text = await r.text();
        if (!r.ok) throw new HttpError(r.status, text.slice(0, 500) || r.statusText);
        try { return JSON.parse(text); } catch { return { data: [] }; }
    });

    // 酒馆的 /api/settings/get 返回 {settings: "整份设置的 JSON 字符串"}。插件只拿它找“当前用的是什么模型/接口”，
    // 这里按轻酒馆当前连接给一份最小的（不含密钥：借主连接发请求时服务端会自己补）
    router.post('/api/settings/get', async () => {
        const settings = await store.getSettings();
        const conns = settings.connections ?? [];
        const conn = conns.find(c => c.id === settings.activeConnection) ?? conns[0];
        const oai = {
            chat_completion_source: 'custom',
            custom_url: '',
            custom_model: conn?.model ?? '',
            openai_model: conn?.model ?? '',
            reverse_proxy: '',
        };
        return { settings: JSON.stringify({ main_api: 'openai', oai_settings: oai, extension_settings: settings.extensions ?? {} }), world_names: (await store.listJson('worlds')).map(w => w.name ?? w) };
    });

    router.post('/api/worldinfo/get', async (req) => {
        const { name } = await readJson(req);
        if (!name) throw new HttpError(400, '缺少世界书名字');
        try {
            return await store.readJson('worlds', String(name));
        } catch (e) {
            if (e.status === 404 || e.code === 'ENOENT') return {};
            throw e;
        }
    });

    router.post('/api/worldinfo/edit', async (req) => {
        const { name, data } = await readJson(req);
        if (!name || !data || typeof data !== 'object') throw new HttpError(400, '缺少世界书名字或内容');
        await store.saveJson('worlds', String(name), data, { force: true });
        return { ok: true };
    });
}

/** 酒馆插件的 /csrf-token：轻酒馆不用 CSRF 令牌，给个固定值让插件放心 */
export function csrfToken(res) {
    sendJson(res, 200, { token: 'lite-tavern' });
}

// ---------- 向量存储（酒馆 /api/vector/*，插件自己算好向量再交给后端存和检索） ----------
// 每个“集合 / 来源 / 模型”一个 JSON 文件：{version, items: [{hash, text, index, vector, norm}]}。
// 规模是一本记忆书几百到几千条，整文件读写足够；同一文件的写操作排队，避免并发写坏。

const safeSeg = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || '_';
const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;

export class VectorStore {
    constructor(root) {
        this.root = root;
        this.queues = new Map();
    }

    file(collectionId, source, model) {
        return path.join(this.root, safeSeg(source || 'transformers'), safeSeg(collectionId), `${safeSeg(model || 'default')}.json`);
    }

    read(file) {
        try {
            const d = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(d?.items) ? d : { version: 1, items: [] };
        } catch {
            return { version: 1, items: [] };
        }
    }

    async update(file, fn) {
        const prev = this.queues.get(file) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(async () => {
            const d = this.read(file);
            fn(d);
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fs.promises.writeFile(tmp, JSON.stringify(d));
            await fs.promises.rename(tmp, file);
        });
        this.queues.set(file, next);
        return next;
    }

    list({ collectionId, source, model }) {
        return this.read(this.file(collectionId, source, model)).items.map(x => x.hash);
    }

    async insert({ collectionId, source, model, items, embeddings }) {
        const add = [];
        for (const it of items ?? []) {
            const vec = embeddings?.[it.text];
            if (!Array.isArray(vec) || !vec.length) throw new HttpError(400, `缺少这段文字的向量：${String(it.text).slice(0, 30)}`);
            add.push({ hash: Number(it.hash), text: String(it.text), index: Number(it.index ?? 0), vector: vec.map(Number), norm: norm(vec) });
        }
        await this.update(this.file(collectionId, source, model), (d) => {
            const byHash = new Map(d.items.map(x => [x.hash, x]));
            for (const x of add) byHash.set(x.hash, x);
            d.items = [...byHash.values()];
        });
    }

    async delete({ collectionId, source, model, hashes }) {
        const drop = new Set((hashes ?? []).map(Number));
        await this.update(this.file(collectionId, source, model), (d) => { d.items = d.items.filter(x => !drop.has(x.hash)); });
    }

    async purge({ collectionId }) {
        if (!fs.existsSync(this.root)) return;
        for (const src of fs.readdirSync(this.root)) {
            const dir = path.join(this.root, src, safeSeg(collectionId));
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    }

    queryMulti({ collectionIds, source, model, searchText, topK = 10, threshold = 0, embeddings }) {
        const q = embeddings?.[searchText];
        if (!Array.isArray(q) || !q.length) throw new HttpError(400, '缺少检索文字的向量');
        const qn = norm(q);
        const hits = [];
        for (const id of collectionIds ?? []) {
            for (const x of this.read(this.file(id, source, model)).items) {
                if (x.vector.length !== q.length) continue;
                let dot = 0;
                for (let i = 0; i < q.length; i++) dot += q[i] * x.vector[i];
                const score = dot / (qn * (x.norm || norm(x.vector)));
                if (score >= Number(threshold || 0)) hits.push({ id, score, x });
            }
        }
        hits.sort((a, b) => b.score - a.score);
        const out = {};
        for (const id of collectionIds ?? []) out[id] = { hashes: [], metadata: [] };
        for (const h of hits.slice(0, Math.max(1, Number(topK) || 10))) {
            out[h.id].hashes.push(h.x.hash);
            out[h.id].metadata.push({ hash: h.x.hash, text: h.x.text, index: h.x.index, score: h.score });
        }
        return out;
    }
}

export function registerVectorApi(router, vectors) {
    router.post('/api/vector/list', async (req) => vectors.list(await readJson(req)));
    router.post('/api/vector/insert', async (req) => { await vectors.insert(await readJson(req)); return { ok: true }; });
    router.post('/api/vector/delete', async (req) => { await vectors.delete(await readJson(req)); return { ok: true }; });
    router.post('/api/vector/purge', async (req) => { await vectors.purge(await readJson(req)); return { ok: true }; });
    router.post('/api/vector/query-multi', async (req) => vectors.queryMulti(await readJson(req)));
}
