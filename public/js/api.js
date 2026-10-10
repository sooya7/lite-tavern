// 本地服务接口封装
/** 和 server.mjs 的 CLIENT_PROTOCOL 对应：服务端升级后，还开着的旧页面再保存会被挡住并提示刷新 */
export const PROTOCOL = '2';

// 角色卡 / 预设 / 世界书的版本号：读的时候记下来，保存时自动带回去。
// 磁盘上的已经不是这一版（酒馆那边或另一个窗口改过）就会保存失败：err.code === 'conflict'。
const versions = new Map();
const saving = new Map(); // 同一个文件的保存排队：下一次要用上一次写完拿到的新版本号

async function request(method, url, body, o = {}) {
    if (o.track && method === 'PUT') {
        const prev = saving.get(o.track) ?? Promise.resolve();
        const next = prev.then(() => send(method, url, body, o), () => send(method, url, body, o));
        saving.set(o.track, next.catch(() => {}));
        return next;
    }
    return send(method, url, body, o);
}

async function send(method, url, body, { raw = false, headers = {}, track = '', force = false } = {}) {
    const opts = { method, headers: { 'X-LT-Client': PROTOCOL, ...headers } };
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
    getCharacter: (file) => request('GET', `/api/characters/${enc(file)}`, undefined, { track: `characters/${file}` }),
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

    listChats: (charId) => request('GET', `/api/chats/${enc(charId)}`),
    /** @returns {Promise<{text: string, version: string}>} version 是这份内容的版本号，保存时带回去 */
    getChat: async (charId, name) => {
        const res = await request('GET', `/api/chats/${enc(charId)}/${enc(name)}`, undefined, { raw: true });
        if (!res.ok) throw new Error(`读不到聊天（${res.status}）`);
        return { text: await res.text(), version: res.headers.get('X-Version') ?? '' };
    },
    /**
     * expect：读这个聊天时拿到的版本号。磁盘上的已经被别处改过就会失败（err.code === 'chat-conflict'），force 强行覆盖。
     * @returns {Promise<{ok: boolean, version: string}>}
     */
    saveChat: (charId, name, text, { expect = '', force = false } = {}) => request('PUT', `/api/chats/${enc(charId)}/${enc(name)}`, text, {
        headers: { 'Content-Type': 'application/jsonl', ...(expect ? { 'X-Expect': expect } : {}), ...(force ? { 'X-Force': '1' } : {}) },
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
