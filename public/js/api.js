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
    if (!res.ok) throw new Error(data?.error?.message ?? `请求失败 ${res.status}`);
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
    exportCharacterUrl: (file, format) => `/api/characters/${enc(file)}/export?format=${format}`,

    listChats: (charId) => request('GET', `/api/chats/${enc(charId)}`),
    getChat: async (charId, name) => (await request('GET', `/api/chats/${enc(charId)}/${enc(name)}`, undefined, { raw: true })).text(),
    saveChat: (charId, name, text) => request('PUT', `/api/chats/${enc(charId)}/${enc(name)}`, text, { headers: { 'Content-Type': 'application/jsonl' } }),
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
