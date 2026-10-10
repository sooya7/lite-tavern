// 全局状态、事件总线、保存
import { api } from './api.js';
import { DEFAULT_POWER } from './core/session.js';
import { DEFAULT_WI_SETTINGS, normalizeWorld } from './core/worldinfo.js';
import { normalizePreset, DEFAULT_PRESET } from './core/preset.js';
import { debounce, clone, uuid } from './core/util.js';
import { serializeChat } from './core/chat.js';
import { toast } from './ui/dom.js';

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
};

class EventBus {
    constructor() { this.map = new Map(); }
    on(type, fn) {
        if (!this.map.has(type)) this.map.set(type, new Set());
        this.map.get(type).add(fn);
        return () => this.off(type, fn);
    }
    once(type, fn) {
        const off = this.on(type, (...a) => { off(); return fn(...a); });
        return off;
    }
    off(type, fn) { this.map.get(type)?.delete(fn); }
    async emit(type, ...args) {
        for (const fn of [...(this.map.get(type) ?? [])]) {
            try { await fn(...args); } catch (e) { console.error(`[event ${type}]`, e); }
        }
    }
}

export const eventSource = new EventBus();

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

const _saveChat = debounce(async () => {
    const c = state.chat;
    if (!c || !state.char) return;
    try {
        await api.saveChat(state.char.id, c.name, serializeChat(c.header, c.messages));
    } catch (e) {
        toast(`聊天保存失败：${e.message}`, 'error');
    }
}, 400);

export function saveChat({ now = false } = {}) {
    _saveChat();
    if (now) return _saveChat.flush();
}

export const savePreset = debounce(async () => {
    if (!state.preset) return;
    try {
        await api.save('presets', state.preset.name, state.preset.data);
    } catch (e) {
        toast(`预设保存失败：${e.message}`, 'error');
    }
}, 600);

export const saveCharacter = debounce(async () => {
    if (!state.char) return;
    try {
        await api.saveCharacter(state.char.file, state.char.card);
        await eventSource.emit(event_types.CHARACTER_EDITED, state.char);
    } catch (e) {
        toast(`角色卡保存失败：${e.message}`, 'error');
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
                toast(`世界书保存失败：${e.message}`, 'error');
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
