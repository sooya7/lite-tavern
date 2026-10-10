// 全局状态、事件总线、保存
import { api } from './api.js';
import { DEFAULT_POWER } from './core/session.js';
import { DEFAULT_WI_SETTINGS, normalizeWorld } from './core/worldinfo.js';
import { normalizePreset, DEFAULT_PRESET } from './core/preset.js';
import { debounce, clone, uuid } from './core/util.js';
import { serializeChat } from './core/chat.js';
import { toast } from './ui/dom.js';
import { MVU_EVENTS } from './core/mvu.js';

export const event_types = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_SELECTED: 'character_selected',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    SETTINGS_UPDATED: 'settings_updated',
    PRESET_CHANGED: 'preset_changed',
    WORLDINFO_UPDATED: 'worldinfo_updated',
    CHARACTER_EDITED: 'character_edited',
    VARIABLES_UPDATED: 'variables_updated',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    // 下面这些是给酒馆助手脚本听的，名字与酒馆一致
    CHAT_CREATED: 'chat_created',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATE_AFTER_DATA: 'generate_after_data',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
};

class EventBus {
    constructor() { this.map = new Map(); }
    list(type) {
        if (!this.map.has(type)) this.map.set(type, []);
        return this.map.get(type);
    }
    on(type, fn) {
        const l = this.list(type);
        if (!l.includes(fn)) l.push(fn);
        return () => this.off(type, fn);
    }
    /** 排到最前 / 最后执行（酒馆助手脚本的 eventMakeFirst / eventMakeLast） */
    makeFirst(type, fn) {
        this.off(type, fn);
        this.list(type).unshift(fn);
        return () => this.off(type, fn);
    }
    makeLast(type, fn) {
        this.off(type, fn);
        this.list(type).push(fn);
        return () => this.off(type, fn);
    }
    once(type, fn) {
        const off = this.on(type, (...a) => { off(); return fn(...a); });
        return off;
    }
    off(type, fn) {
        const l = this.map.get(type);
        const i = l ? l.indexOf(fn) : -1;
        if (i >= 0) l.splice(i, 1);
    }
    count(type) { return this.map.get(type)?.length ?? 0; }
    async emit(type, ...args) {
        for (const fn of [...(this.map.get(type) ?? [])]) {
            try { await fn(...args); } catch (e) { console.error(`[event ${type}]`, e); }
        }
    }
}

export const eventSource = new EventBus();
// 酒馆的叫法
eventSource.removeListener = eventSource.off;

const MVU_LISTENED = [...Object.values(MVU_EVENTS), `${MVU_EVENTS.COMMAND_PARSED}_for_zod`, `${MVU_EVENTS.COMMAND_PARSED}_ended_for_zod`, `${MVU_EVENTS.VARIABLE_UPDATE_ENDED}_for_zod`];
/** 有脚本在监听 MVU 事件时返回发事件的函数，没有就返回 null（变量更新走不发事件的老路，行为和以前完全一样） */
export function mvuEmitter() {
    if (!MVU_LISTENED.some(n => eventSource.count(n) > 0)) return null;
    return (name, ...args) => eventSource.emit(name, ...args);
}

export const DEFAULT_SETTINGS = {
    version: 1,
    theme: 'auto', // auto 跟随系统
    ui: { leftOpen: true, rightOpen: true, rightTab: 'connection', fontSize: 16, chatWidth: 780, enterToSend: true, showReasoning: true, showMesId: false, renderFrontend: true },
    connections: [],
    activeConnection: '',
    activePreset: '',
    personas: [],
    activePersona: '',
    power: { ...DEFAULT_POWER },
    worldInfo: { ...DEFAULT_WI_SETTINGS, globalSelect: [], charLore: {} },
    regex: [],
    variables: { global: {} },
    retry: { enabled: true, maxRetries: 2, delayMs: 2000, onEmpty: true, errorPatterns: 'failed with status (429|5\\d\\d)\nrate limit exceeded' },
    authorsNoteScan: false,
    lastChat: null,
    extensions: {},
    // 角色卡 / 预设自带的酒馆助手脚本：总开关，以及按卡、按预设关掉的名单（见 core/scripts.js）
    scripts: { enabled: true, characters: {}, presets: {} },
};

export const state = {
    settings: clone(DEFAULT_SETTINGS),
    characters: [],
    char: null, // {file, id, card}
    chatList: [],
    chat: null, // {name, header, messages}
    preset: null, // {name, data}
    presetList: [],
    worldList: [],
    worlds: {}, // name → normalized world
    session: null,
    view: 'chat', // chat | home（首页：问候 + 角色库）
    generating: false,
    abort: null,
    secrets: {},
};

export function withDefaults(s) {
    const out = { ...clone(DEFAULT_SETTINGS), ...(s ?? {}) };
    out.ui = { ...DEFAULT_SETTINGS.ui, ...(s?.ui ?? {}) };
    out.power = { ...DEFAULT_SETTINGS.power, ...(s?.power ?? {}) };
    out.worldInfo = { ...DEFAULT_SETTINGS.worldInfo, ...(s?.worldInfo ?? {}) };
    out.retry = { ...DEFAULT_SETTINGS.retry, ...(s?.retry ?? {}) };
    out.variables = { global: {}, ...(s?.variables ?? {}) };
    if (!out.variables.global) out.variables.global = {};
    out.scripts = { enabled: s?.scripts?.enabled !== false, characters: { ...(s?.scripts?.characters ?? {}) }, presets: { ...(s?.scripts?.presets ?? {}) } };
    return out;
}

const _saveSettings = debounce(async () => {
    try {
        await api.saveSettings(state.settings);
    } catch (e) {
        toast(`设置保存失败：${e.message}`, 'error');
    }
}, 500);

export function saveSettings({ now = false } = {}) {
    _saveSettings();
    if (now) return _saveSettings.flush();
}

let chatWrites = Promise.resolve();
let chatConflictHandler = null;
/** 聊天在别处（酒馆、另一个窗口）被改过、这边存不进去时找谁问用户。界面层来注册，这里不碰界面 */
export function onChatConflict(fn) {
    chatConflictHandler = fn;
}

/**
 * 把一个聊天写到磁盘。写入排成一队，一次只发一个：每次都要带上一次写完拿到的版本号，
 * 服务端靠它判断磁盘上的内容是不是已经被别处改过。
 * chat.conflict 为真时不再自动写（等用户选“载入最新的”还是“覆盖”），force 强行覆盖。
 */
export function writeChat(charId, chat, { force = false } = {}) {
    const run = async () => {
        if (chat.conflict && !force) return;
        try {
            const r = await api.saveChat(charId, chat.name, serializeChat(chat.header, chat.messages), { expect: chat.version ?? '', force });
            chat.version = r?.version ?? '';
            chat.conflict = false;
        } catch (e) {
            if (e.code === 'chat-conflict') {
                chat.conflict = true;
                if (chatConflictHandler) chatConflictHandler(chat, charId);
                else toast('这个聊天在别处被改过了，这里的修改没有保存', 'error');
            } else {
                toast(`聊天保存失败：${e.message}`, 'error');
            }
        }
    };
    chatWrites = chatWrites.then(run, run);
    return chatWrites;
}

const _saveChat = debounce(() => {
    const c = state.chat;
    if (!c || !state.char) return undefined;
    return writeChat(state.char.id, c);
}, 400);

export function saveChat({ now = false } = {}) {
    _saveChat();
    if (now) return _saveChat.flush();
}

let fileConflictHandler = null;
/**
 * 角色卡 / 预设 / 世界书在别处被改过、这边存不进去时找谁问用户（界面层注册）。
 * 传过去的是 {key, label, reload(), overwrite()}：reload 把磁盘上最新的载进来，overwrite 用这边的盖掉。
 */
export function onFileConflict(fn) {
    fileConflictHandler = fn;
}

function saveFailed(e, what, conflict) {
    if (e.code === 'conflict' && fileConflictHandler) fileConflictHandler(conflict);
    else if (e.code !== 'stale-client') toast(`${what}保存失败：${e.message}`, 'error'); // 旧页面另有一个整页的提示
}

export const savePreset = debounce(async () => {
    const p = state.preset;
    if (!p) return;
    try {
        await api.save('presets', p.name, p.data);
    } catch (e) {
        saveFailed(e, '预设', {
            key: `presets/${p.name}`,
            label: `预设「${p.name}」`,
            reload: async () => {
                const data = normalizePreset(await api.get('presets', p.name));
                if (state.preset === p) { state.preset = { name: p.name, data }; state.session = null; }
            },
            overwrite: () => api.save('presets', p.name, p.data, { force: true }),
        });
    }
}, 600);

export const saveCharacter = debounce(async () => {
    const c = state.char;
    if (!c) return;
    try {
        await api.saveCharacter(c.file, c.card);
        await eventSource.emit(event_types.CHARACTER_EDITED, c);
    } catch (e) {
        saveFailed(e, '角色卡', {
            key: `characters/${c.file}`,
            label: `角色卡「${c.card?.data?.name ?? c.id}」`,
            reload: async () => {
                c.card = await api.getCharacter(c.file);
                if (state.char === c) { state.session = null; await eventSource.emit(event_types.CHARACTER_EDITED, c); }
            },
            overwrite: async () => {
                await api.saveCharacter(c.file, c.card, { force: true });
                await eventSource.emit(event_types.CHARACTER_EDITED, c);
            },
        });
    }
}, 700);

const worldSavers = new Map();
export function saveWorld(name) {
    if (!worldSavers.has(name)) {
        worldSavers.set(name, debounce(async () => {
            try {
                await api.save('worlds', name, state.worlds[name]);
                await eventSource.emit(event_types.WORLDINFO_UPDATED, name);
            } catch (e) {
                saveFailed(e, '世界书', {
                    key: `worlds/${name}`,
                    label: `世界书「${name}」`,
                    reload: async () => {
                        await loadWorld(name, { force: true });
                        state.session = null;
                        await eventSource.emit(event_types.WORLDINFO_UPDATED, name);
                    },
                    overwrite: async () => {
                        await api.save('worlds', name, state.worlds[name], { force: true });
                        await eventSource.emit(event_types.WORLDINFO_UPDATED, name);
                    },
                });
            }
        }, 600));
    }
    worldSavers.get(name)();
}

/** 把所有还没落盘的修改立刻写掉（切换角色/预设/聊天前、发请求前调用） */
export async function flushPending() {
    await Promise.all([
        _saveSettings.flush(),
        _saveChat.flush(),
        savePreset.flush(),
        saveCharacter.flush(),
        ...[...worldSavers.values()].map(f => f.flush()),
    ]);
}

export async function loadWorld(name, { force = false } = {}) {
    if (!name) return null;
    if (state.worlds[name] && !force) return state.worlds[name];
    try {
        state.worlds[name] = normalizeWorld(await api.get('worlds', name));
    } catch {
        return null;
    }
    return state.worlds[name];
}

export async function refreshLists() {
    const [chars, presets, worlds] = await Promise.all([api.listCharacters(), api.list('presets'), api.list('worlds')]);
    state.characters = chars;
    state.presetList = presets;
    state.worldList = worlds;
}

export async function ensurePreset() {
    const s = state.settings;
    let name = s.activePreset;
    if (!state.presetList.length) {
        await api.save('presets', '默认', clone(DEFAULT_PRESET));
        state.presetList = await api.list('presets');
        name = '默认';
    }
    if (!state.presetList.some(p => p.name === name)) name = state.presetList[0].name;
    if (state.preset?.name === name) return state.preset;
    state.preset = { name, data: normalizePreset(await api.get('presets', name)) };
    s.activePreset = name;
    return state.preset;
}

export function activeConnection() {
    const s = state.settings;
    return s.connections.find(c => c.id === s.activeConnection) ?? s.connections[0] ?? null;
}

export function activePersona() {
    const s = state.settings;
    const p = s.personas.find(x => x.id === s.activePersona) ?? s.personas[0];
    return p ?? { id: '', name: 'User', description: '' };
}

export function newConnection(partial = {}) {
    return {
        id: `c_${uuid().slice(0, 8)}`,
        name: '新连接',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        postProcessing: '',
        prefillAsAssistant: false,
        sendExtraSamplers: false,
        thinkingBudget: 0,
        includeThoughts: true,
        extraBody: '',
        extraHeaders: '',
        ...partial,
    };
}
