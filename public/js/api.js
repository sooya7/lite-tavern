// 本地服务接口封装
/** 和 server.mjs 的 CLIENT_PROTOCOL 对应：服务端升级后，还开着的旧页面再保存会被挡住并提示刷新 */
export const PROTOCOL = '2';

// 角色卡 / 预设 / 世界书的版本号：读的时候记下来，保存时自动带回去。
// 磁盘上的已经不是这一版（酒馆那边或另一个窗口改过）就会保存失败：err.code === 'conflict'。
const versions = new Map();
const saving = new Map(); // 同一个文件的保存排队：下一次要用上一次写完拿到的新版本号

// ---------- 本机缓存（IndexedDB）：大文件没变就不重新下载 ----------
const IDB_NAME = 'lt-cache', IDB_STORE = 'files', IDB_KEEP = 12;
let idbP = null;
function idb() {
    if (!idbP) {
        idbP = new Promise((resolve) => {
            try {
                const r = indexedDB.open(IDB_NAME, 1);
                r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => resolve(null);
            } catch { resolve(null); }
        });
    }
    return idbP;
}
async function idbDo(mode, fn) {
    const db = await idb();
    if (!db) return undefined;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(IDB_STORE, mode);
            const req = fn(tx.objectStore(IDB_STORE));
            tx.oncomplete = () => resolve(req?.result);
            tx.onerror = tx.onabort = () => resolve(undefined);
        } catch { resolve(undefined); }
    });
}
const cacheGet = (key) => idbDo('readonly', st => st.get(key));
async function cachePut(key, version, text) {
    if (!version) return;
    await idbDo('readwrite', st => st.put({ version, text, at: Date.now() }, key));
    // 只留最近用过的几个，别把手机存储占满
    const all = await idbDo('readonly', st => st.getAllKeys());
    if (Array.isArray(all) && all.length > IDB_KEEP) {
        const rows = await Promise.all(all.map(async k => [k, (await cacheGet(k))?.at ?? 0]));
        rows.sort((a, b) => a[1] - b[1]);
        await idbDo('readwrite', st => { for (const [k] of rows.slice(0, rows.length - IDB_KEEP)) st.delete(k); return null; });
    }
}
/** 带着本机那一版的版本号去问，没变就是 304，直接用本机的 */
async function cachedText(url, key) {
    const hit = await cacheGet(key).catch(() => undefined);
    const res = await send('GET', url, undefined, { raw: true, fetchCache: 'no-store', headers: hit?.version ? { 'If-None-Match': `"${hit.version}"` } : {} });
    if (res.status === 304 && hit) {
        idbDo('readwrite', st => st.put({ ...hit, at: Date.now() }, key));
        return { text: hit.text, version: hit.version };
    }
    if (!res.ok) {
        let msg = `${res.status}`;
        try { const d = await res.json(); msg = d?.error?.message || d?.error || msg; } catch { /* 不是 JSON */ }
        throw new Error(msg);
    }
    const text = await res.text();
    const version = res.headers.get('X-Version') ?? '';
    cachePut(key, version, text);
    return { text, version };
}

const chatPrefetch = new Map();
async function fetchChat(charId, name) {
    try {
        return await cachedText(`/api/chats/${enc(charId)}/${enc(name)}`, `chat:${charId}/${name}`);
    } catch (e) {
        throw new Error(`读不到聊天（${e.message}）`);
    }
}

async function request(method, url, body, o = {}) {
    if (o.track && method === 'PUT') {
        const prev = saving.get(o.track) ?? Promise.resolve();
        const next = prev.then(() => send(method, url, body, o), () => send(method, url, body, o));
        saving.set(o.track, next.catch(() => {}));
        return next;
    }
    return send(method, url, body, o);
}

async function send(method, url, body, { raw = false, headers = {}, track = '', force = false, fetchCache = '' } = {}) {
    const opts = { method, headers: { 'X-LT-Client': PROTOCOL, ...headers } };
    if (fetchCache) opts.cache = fetchCache;
    if (track && method === 'PUT' && versions.get(track)) {
        opts.headers['X-Expect'] = versions.get(track);
        if (force) opts.headers['X-Force'] = '1';
    }
    if (body !== undefined) {
        if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array || typeof body === 'string') {
            opts.body = body;
        } else {
            opts.body = JSON.stringify(body);
            opts.headers['Content-Type'] = 'application/json';
        }
    }
    const res = await fetch(url, opts);
    if (res.status === 401 && !url.endsWith('/api/login')) {
        window.dispatchEvent(new CustomEvent('lt:need-login'));
        throw new Error('需要登录');
    }
    if (raw) return res;
    if (track && res.ok && res.headers.get('X-Version')) versions.set(track, res.headers.get('X-Version'));
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const err = new Error(data?.error?.message ?? `请求失败 ${res.status}`);
        err.status = res.status;
        err.code = data?.error?.code ?? '';
        if (err.code === 'stale-client') window.dispatchEvent(new CustomEvent('lt:stale-client'));
        throw err;
    }
    return data;
}

const enc = encodeURIComponent;

export const api = {
    ping: () => request('GET', '/api/ping'),
    login: (password) => request('POST', '/api/login', { password }),
    getSettings: () => request('GET', '/api/settings'),
    saveSettings: (s) => request('PUT', '/api/settings', s),
    getSecrets: () => request('GET', '/api/secrets'),
    setSecret: (id, key) => request('PUT', `/api/secrets/${enc(id)}`, { key }),

    listCharacters: () => request('GET', '/api/characters'),
    getCharacter: async (file) => {
        const { text, version } = await cachedText(`/api/characters/${enc(file)}`, `char:${file}`);
        if (version) versions.set(`characters/${file}`, version);
        return JSON.parse(text);
    },
    /** force：用户明确选了“用这边的覆盖”（别处的修改会被盖掉，服务端先留备份） */
    saveCharacter: (file, card, { force = false } = {}) => request('PUT', `/api/characters/${enc(file)}`, card, { track: `characters/${file}`, force }),
    createCharacter: (card) => request('POST', '/api/characters/create', card),
    deleteCharacter: (file, withChats) => { versions.delete(`characters/${file}`); return request('DELETE', `/api/characters/${enc(file)}?chats=${withChats ? 1 : 0}`); },
    importCharacter: (file) => request('POST', '/api/characters/import', file, { headers: { 'X-File-Name': enc(file.name) } }),
    setCharacterAvatar: async (file, blob) => {
        // 换头像会重写整张卡的文件，版本号跟着变；这不算“别处改的”，直接记新的
        const res = await request('PUT', `/api/characters/${enc(file)}/avatar`, blob, { raw: true });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `请求失败 ${res.status}`);
        if (res.headers.get('X-Version')) versions.set(`characters/${file}`, res.headers.get('X-Version'));
        return res.json();
    },
    avatarUrl: (file, v = '') => `/api/characters/${enc(file)}/avatar${v ? `?v=${v}` : ''}`,
    /** 列表用的小图（服务端缩放，去掉卡片元数据）；v 用原图 mtime，变了才会重新下载 */
    thumbUrl: (file, v = '') => `/api/characters/${enc(file)}/avatar?thumb=1${v ? `&v=${v}` : ''}`,
    exportCharacterUrl: (file, format) => `/api/characters/${enc(file)}/export?format=${format}`,

    recentChats: (limit = 30) => request('GET', `/api/recent-chats?limit=${limit}`),
    listChats: (charId) => request('GET', `/api/chats/${enc(charId)}`),
    /** @returns {Promise<{text: string, version: string}>} version 是这份内容的版本号，保存时带回去 */
    getChat: async (charId, name) => {
        const key = `${charId}/${name}`;
        const early = chatPrefetch.get(key);
        chatPrefetch.delete(key);
        if (early) { try { return await early; } catch { /* 预取失败就正常再取一次 */ } }
        return fetchChat(charId, name);
    },
    /** 点进聊天时先把聊天记录发出去下载，和读角色卡并行；随后的 getChat 直接用这次的结果（10 秒内有效） */
    prefetchChat: (charId, name) => {
        const key = `${charId}/${name}`;
        if (chatPrefetch.has(key)) return;
        const p = fetchChat(charId, name);
        p.catch(() => {});
        chatPrefetch.set(key, p);
        setTimeout(() => { if (chatPrefetch.get(key) === p) chatPrefetch.delete(key); }, 10000);
    },
    /**
     * expect：读这个聊天时拿到的版本号。磁盘上的已经被别处改过就会失败（err.code === 'chat-conflict'），force 强行覆盖。
     * @returns {Promise<{ok: boolean, version: string}>}
     */
    /** 只上传改过的行（见服务端 patchChat）；底稿对不上时抛 err.code === 'patch-base'，调用方改用 saveChat 整份上传 */
    patchChat: (charId, name, patch, { expect = '', job = '' } = {}) => request('PATCH', `/api/chats/${enc(charId)}/${enc(name)}`, patch, {
        headers: { ...(expect ? { 'X-Expect': expect } : {}), ...(job ? { 'X-LT-Gen-Job': job } : {}) },
    }),
    /** 存完把这一版记到本机缓存，下次打开不用再下载 */
    cacheChat: (charId, name, version, text) => cachePut(`chat:${charId}/${name}`, version, text),
    /** job：服务器代生成的任务号，带上它就是告诉服务器这次回复页面写好了（见 state.js 的 writeChat） */
    saveChat: (charId, name, text, { expect = '', force = false, job = '' } = {}) => request('PUT', `/api/chats/${enc(charId)}/${enc(name)}`, text, {
        headers: { 'Content-Type': 'application/jsonl', ...(expect ? { 'X-Expect': expect } : {}), ...(force ? { 'X-Force': '1' } : {}), ...(job ? { 'X-LT-Gen-Job': job } : {}) },
    }),
    renameChat: (charId, name, to) => request('POST', `/api/chats/${enc(charId)}/${enc(name)}/rename`, { to }),
    deleteChat: (charId, name) => request('DELETE', `/api/chats/${enc(charId)}/${enc(name)}`),

    list: (kind) => request('GET', `/api/${kind}`),
    get: (kind, name) => request('GET', `/api/${kind}/${enc(name)}`, undefined, { track: `${kind}/${name}` }),
    save: (kind, name, data, { force = false } = {}) => request('PUT', `/api/${kind}/${enc(name)}`, data, { track: `${kind}/${name}`, force }),
    remove: (kind, name) => { versions.delete(`${kind}/${name}`); return request('DELETE', `/api/${kind}/${enc(name)}`); },
    rename: async (kind, name, to) => {
        const r = await request('POST', `/api/${kind}/${enc(name)}/rename`, { to });
        // 改名不动内容，版本号跟着新名字走
        if (versions.has(`${kind}/${name}`)) { versions.set(`${kind}/${to}`, versions.get(`${kind}/${name}`)); versions.delete(`${kind}/${name}`); }
        return r;
    },

    personaAvatarUrl: (file) => `/api/avatars/${enc(file)}`,
    savePersonaAvatar: (file, blob) => request('PUT', `/api/avatars/${enc(file)}`, blob),

    llm: (connId, payload, signal) => fetch(`/api/llm/${enc(connId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
    }),

    stDetect: () => request('GET', '/api/st/detect'),
    stScan: (dir) => request('POST', '/api/st/scan', { dir }),
    stImport: (sel) => request('POST', '/api/st/import', sel),
};
