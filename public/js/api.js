// 本地服务接口封装
async function request(method, url, body, { raw = false, headers = {} } = {}) {
    const opts = { method, headers: { ...headers } };
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
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const err = new Error(data?.error?.message ?? `请求失败 ${res.status}`);
        err.status = res.status;
        err.code = data?.error?.code ?? '';
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
    getCharacter: (file) => request('GET', `/api/characters/${enc(file)}`),
    saveCharacter: (file, card) => request('PUT', `/api/characters/${enc(file)}`, card),
    createCharacter: (card) => request('POST', '/api/characters/create', card),
    deleteCharacter: (file, withChats) => request('DELETE', `/api/characters/${enc(file)}?chats=${withChats ? 1 : 0}`),
    importCharacter: (file) => request('POST', '/api/characters/import', file, { headers: { 'X-File-Name': enc(file.name) } }),
    setCharacterAvatar: (file, blob) => request('PUT', `/api/characters/${enc(file)}/avatar`, blob),
    avatarUrl: (file, v = '') => `/api/characters/${enc(file)}/avatar${v ? `?v=${v}` : ''}`,
    /** 列表用的小图（服务端缩放，去掉卡片元数据）；v 用原图 mtime，变了才会重新下载 */
    thumbUrl: (file, v = '') => `/api/characters/${enc(file)}/avatar?thumb=1${v ? `&v=${v}` : ''}`,
    exportCharacterUrl: (file, format) => `/api/characters/${enc(file)}/export?format=${format}`,

    listChats: (charId) => request('GET', `/api/chats/${enc(charId)}`),
    /** @returns {Promise<{text: string, version: string}>} version 是这份内容的版本号，保存时带回去 */
    getChat: async (charId, name) => {
        const res = await request('GET', `/api/chats/${enc(charId)}/${enc(name)}`, undefined, { raw: true });
        if (!res.ok) throw new Error(`读不到聊天（${res.status}）`);
        return { text: await res.text(), version: res.headers.get('X-Chat-Version') ?? '' };
    },
    /**
     * expect：读这个聊天时拿到的版本号。磁盘上的已经被别处改过就会失败（err.code === 'chat-conflict'），force 强行覆盖。
     * @returns {Promise<{ok: boolean, version: string}>}
     */
    saveChat: (charId, name, text, { expect = '', force = false } = {}) => request('PUT', `/api/chats/${enc(charId)}/${enc(name)}`, text, {
        headers: { 'Content-Type': 'application/jsonl', ...(expect ? { 'X-Chat-Expect': expect } : {}), ...(force ? { 'X-Chat-Force': '1' } : {}) },
    }),
    renameChat: (charId, name, to) => request('POST', `/api/chats/${enc(charId)}/${enc(name)}/rename`, { to }),
    deleteChat: (charId, name) => request('DELETE', `/api/chats/${enc(charId)}/${enc(name)}`),

    list: (kind) => request('GET', `/api/${kind}`),
    get: (kind, name) => request('GET', `/api/${kind}/${enc(name)}`),
    save: (kind, name, data) => request('PUT', `/api/${kind}/${enc(name)}`, data),
    remove: (kind, name) => request('DELETE', `/api/${kind}/${enc(name)}`),
    rename: (kind, name, to) => request('POST', `/api/${kind}/${enc(name)}/rename`, { to }),

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
