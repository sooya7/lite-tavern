// 酒馆助手（TavernHelper）接口在轻酒馆里的实现：脚本 iframe 里的 getVariables / eventOn / getWorldbook / generate …
// 每个脚本拿到一份绑定了自己身份的接口（createScriptApi），整个页面另有一份不带脚本身份的（window.TavernHelper）。
// 接口的名字、参数和返回值的形状照着酒馆助手 4.x 的公开类型声明来；实现是这里自己写的，读写的是轻酒馆的状态。
import { state, eventSource, event_types, saveSettings, saveChat, saveCharacter, savePreset, saveWorld, loadWorld, refreshLists, activePersona, activeConnection, mvuEmitter } from '../state.js';
import { api } from '../api.js';
import { getSession, refresh, setPreset as switchPreset, loadRelevantWorlds } from '../controller.js';
import { generate as mainGenerate, stopGeneration, scriptGenerate, stopScriptGeneration, stopAllScriptGeneration, RAW_PROMPT_ORDER } from '../generate.js';
import * as ops from '../chatops.js';
import { toast, modal, h } from './dom.js';
import { formatMessage } from './render.js';
import { renderMessage, renderChat, updateComposerChips } from './chat.js';
import { broadcastEvent, refreshSnapshots } from './frontend.js';
import { rerenderIfActive } from './panels/index.js';
import { helperVariablesOf, scriptTreesOf, flattenScriptTrees, buttonEventName } from '../core/scripts.js';
import { MVU_EVENTS, processMessageWithEvents, processMessage, dumpYaml, parseYamlOrJson } from '../core/mvu.js';
import { toWorldbook, toWorldbookEntry, fromWorldbook, toHelperPreset, fromHelperPreset, toTavernRegex, fromTavernRegex } from '../core/thformat.js';
import { normalizePreset, DEFAULT_PRESET } from '../core/preset.js';
import { getRegexedString, REGEX_PLACEMENT } from '../core/regex.js';
import { normalizeWorld } from '../core/worldinfo.js';
import { estimateTokens } from '../core/tokens.js';
import { uuid, debounce, parseRegexFromString, humanizedDateTime } from '../core/util.js';

export const HELPER_VERSION = '4.11.3';
export const TAVERN_VERSION = '1.18.0';
/** 监听者最多等这么久，超时就不等了（它自己接着跑），免得一个卡死的脚本把生成流程挂住 */
const LISTENER_TIMEOUT = 30000;

// 酒馆的事件名。轻酒馆实际会发的只是其中一部分（见 docs/HANDOFF.md 的脚本一节），其余的监听了也不会触发。
export const tavern_events = {
    APP_READY: 'app_ready', EXTRAS_CONNECTED: 'extras_connected', MESSAGE_SWIPED: 'message_swiped', MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received', MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated',
    MESSAGE_FILE_EMBEDDED: 'message_file_embedded', MESSAGE_REASONING_EDITED: 'message_reasoning_edited', MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted', MORE_MESSAGES_LOADED: 'more_messages_loaded', IMPERSONATE_READY: 'impersonate_ready',
    CHAT_CHANGED: 'chat_id_changed', GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS', GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended', SD_PROMPT_PROCESSING: 'sd_prompt_processing',
    EXTENSIONS_FIRST_LOAD: 'extensions_first_load', EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded', SETTINGS_LOADED: 'settings_loaded',
    SETTINGS_UPDATED: 'settings_updated', MOVABLE_PANELS_RESET: 'movable_panels_reset', SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
    SETTINGS_LOADED_AFTER: 'settings_loaded_after', CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
    CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed', OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after', OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready', OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated', WORLDINFO_UPDATED: 'worldinfo_updated', CHARACTER_EDITOR_OPENED: 'character_editor_opened',
    CHARACTER_EDITED: 'character_edited', CHARACTER_PAGE_LOADED: 'character_page_loaded', USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', FORCE_SET_BACKGROUND: 'force_set_background', CHAT_DELETED: 'chat_deleted',
    CHAT_CREATED: 'chat_created', GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts', GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    GENERATE_AFTER_DATA: 'generate_after_data', WORLD_INFO_ACTIVATED: 'world_info_activated', TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready', CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected', CHARACTER_DELETED: 'characterDeleted', CHARACTER_DUPLICATED: 'character_duplicated',
    CHARACTER_RENAMED: 'character_renamed', CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat', SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
    STREAM_TOKEN_RECEIVED: 'stream_token_received', STREAM_REASONING_DONE: 'stream_reasoning_done', FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
    WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate', OPEN_CHARACTER_LIBRARY: 'open_character_library', ONLINE_STATUS_CHANGED: 'online_status_changed',
    IMAGE_SWIPED: 'image_swiped', CONNECTION_PROFILE_LOADED: 'connection_profile_loaded', CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted', CONNECTION_PROFILE_UPDATED: 'connection_profile_updated', TOOL_CALLS_PERFORMED: 'tool_calls_performed',
    TOOL_CALLS_RENDERED: 'tool_calls_rendered', CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown', SECRET_WRITTEN: 'secret_written',
    SECRET_DELETED: 'secret_deleted', SECRET_ROTATED: 'secret_rotated', SECRET_EDITED: 'secret_edited', PRESET_CHANGED: 'preset_changed',
    PRESET_DELETED: 'preset_deleted', PRESET_RENAMED: 'preset_renamed', PRESET_RENAMED_BEFORE: 'preset_renamed_before', MAIN_API_CHANGED: 'main_api_changed',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded', WORLDINFO_SCAN_DONE: 'worldinfo_scan_done', MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
};

export const iframe_events = {
    MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
    GENERATION_REQUESTED: 'js_generation_requested', GENERATION_STARTED: 'js_generation_started',
    STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully', STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
    GENERATION_ENDED: 'js_generation_ended',
};

/** 这些事件宿主自己已经会转发给消息里的前端界面，脚本再发一遍就重复了 */
const HOST_BROADCAST = new Set(['js_generation_started', 'js_stream_token_received_fully', 'js_stream_token_received_incrementally', 'js_generation_ended',
    'message_received', 'chat_id_changed', 'mag_variable_update_started', 'mag_variable_update_ended']);

const lodash = () => window._;
/** 脚本给的对象可能是别的窗口里的、也可能是 Vue 的响应式代理，用 lodash 深拷贝（structuredClone 遇到代理会抛错） */
const deep = (v) => (v === undefined ? undefined : lodash().cloneDeep(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- 页面级的共享状态 ----------

const globals = new Map(); // initializeGlobal 的名字 → 值
const globalWaiters = new Map(); // 名字 → [resolve]
const injections = new Map(); // id → {prompt, once, chat}
const macroLikes = []; // {regex, replace}
const windows = new Set(); // 正在运行的脚本窗口（initializeGlobal 要把值放进每个窗口）

/** 脚本宿主（ui/scripts.js）提供的能力：按钮表、重新加载脚本等。页面级接口没有脚本身份，也要能查按钮表 */
let scriptHost = null;
export function setScriptHost(host) { scriptHost = host; }

export function registerScriptWindow(win) { windows.add(win); }
export function unregisterScriptWindow(win) { windows.delete(win); }

/** 脚本共享到全局的接口里，哪些是某个脚本放的（脚本停了要收回） */
export function dropGlobalsOf(owner) {
    for (const [name, g] of [...globals]) {
        if (g.owner !== owner) continue;
        globals.delete(name);
        try { if (window[name] === g.value) delete window[name]; } catch { /* 删不掉就留着 */ }
    }
}

function setGlobal(name, value, owner) {
    globals.set(name, { value, owner });
    try { window[name] = value; } catch { /* 有的名字不让写 */ }
    for (const w of windows) { try { defineGlobal(w, name, value); } catch { /* 窗口已经没了 */ } }
    for (const r of globalWaiters.get(name) ?? []) r(value);
    globalWaiters.delete(name);
}

function defineGlobal(win, name, value) {
    Object.defineProperty(win, name, { value, writable: true, configurable: true, enumerable: true });
}

function toastText(msg, title) {
    const clean = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    const m = clean(msg), t = clean(title);
    return t && m ? `${t}：${m}` : (m || t);
}

/** toastr 的替身：接到轻酒馆自己的提示条上 */
export const toastr = {
    options: {},
    info: (m, t) => toast(toastText(m, t), 'info'),
    success: (m, t) => toast(toastText(m, t), 'success'),
    warning: (m, t) => toast(toastText(m, t), 'warning'),
    error: (m, t) => toast(toastText(m, t), 'error'),
    clear() { document.getElementById('toasts')?.replaceChildren(); },
    remove() { document.getElementById('toasts')?.replaceChildren(); },
};

/** YAML 全局对象的替身：酒馆助手给的是 yaml 库，这里用自带的 js-yaml 接出最常用的两个函数 */
export const YAML = {
    parse: (text) => parseYamlOrJson(text),
    stringify: (value) => dumpYaml(value),
};

// ---------- 变量 ----------

function resolveMessageIndex(id) {
    const chat = state.chat?.messages ?? [];
    let i = id === undefined || id === null || id === 'latest' ? chat.length - 1 : Number(id);
    if (i < 0) i += chat.length;
    if (!Number.isInteger(i) || i < 0 || i >= chat.length) throw new Error(`楼层号 ${id} 超出范围（当前共 ${chat.length} 楼）`);
    return i;
}

/** 当前卡 / 预设里某个 id 的脚本原对象（每次现找：预设被整体替换后旧引用就失效了） */
export function findScriptRaw(scriptId, source) {
    const pools = [];
    if (source !== 'preset' && state.char) pools.push(['character', state.char.card.data.extensions]);
    if (source !== 'character' && state.preset) pools.push(['preset', state.preset.data.extensions]);
    for (const [src, ext] of pools) {
        const hit = flattenScriptTrees(scriptTreesOf(ext)).find(x => x.script.id === String(scriptId));
        if (hit) return { raw: hit.raw.value && hit.raw.content === undefined ? hit.raw.value : hit.raw, source: src };
    }
    return null;
}

function persistSource(source) {
    if (source === 'preset') savePreset(); else saveCharacter();
}

const notifyVars = debounce((type) => {
    eventSource.emit(event_types.VARIABLES_UPDATED, type);
    refreshSnapshots();
    rerenderIfActive('vars');
}, 120);

function variableStore(option, rt) {
    const o = typeof option === 'string' ? { type: option } : (option ?? {});
    const type = o.type ?? 'chat';
    const session = getSession();
    switch (type) {
        case 'global': return {
            get: () => state.settings.variables.global ?? {},
            set: (v) => { state.settings.variables.global = v; session?.vars && (session.vars.state.global = v); saveSettings(); },
            type,
        };
        case 'character': {
            if (!state.char) throw new Error('没有打开角色卡');
            const ext = state.char.card.data.extensions ?? (state.char.card.data.extensions = {});
            return {
                get: () => helperVariablesOf(ext),
                set: (v) => { helperVariablesOf(ext, true); ext.tavern_helper.variables = v; saveCharacter(); },
                type,
            };
        }
        case 'preset': {
            if (!state.preset) throw new Error('没有加载预设');
            const ext = state.preset.data.extensions ?? (state.preset.data.extensions = {});
            return {
                get: () => helperVariablesOf(ext),
                set: (v) => { helperVariablesOf(ext, true); ext.tavern_helper.variables = v; savePreset(); },
                type,
            };
        }
        case 'message': {
            const index = resolveMessageIndex(o.message_id);
            const msg = state.chat.messages[index];
            const sid = msg.swipe_id ?? 0;
            return {
                get: () => (Array.isArray(msg.variables) ? msg.variables[sid] : null) ?? {},
                set: (v) => { if (!Array.isArray(msg.variables)) msg.variables = []; msg.variables[sid] = v; saveChat(); },
                type,
            };
        }
        case 'script': {
            const id = o.script_id ?? rt?.id;
            if (!id) throw new Error('不在脚本里调用时要用 script_id 指明是哪个脚本');
            const found = findScriptRaw(id, o.script_id ? undefined : rt?.source);
            if (!found) throw new Error(`找不到脚本 ${id}`);
            return {
                get: () => (isObj(found.raw.data) ? found.raw.data : {}),
                set: (v) => { found.raw.data = v; persistSource(found.source); },
                type,
            };
        }
        case 'extension': {
            const key = String(o.extension_id ?? '');
            return {
                get: () => state.settings.extensions?.[key] ?? {},
                set: (v) => { (state.settings.extensions ??= {})[key] = v; saveSettings(); },
                type,
            };
        }
        default: {
            if (!state.chat) return { get: () => ({}), set: () => { throw new Error('没有打开的聊天'); }, type: 'chat' };
            const meta = state.chat.header.chat_metadata ?? (state.chat.header.chat_metadata = {});
            return {
                get: () => (isObj(meta.variables) ? meta.variables : {}),
                set: (v) => { meta.variables = v; saveChat(); },
                type: 'chat',
            };
        }
    }
}

function writeVariables(store, value) {
    if (!isObj(value)) throw new Error('变量表必须是对象');
    store.set(deep(value));
    getSession()?.vars.invalidate();
    notifyVars(store.type);
}

// ---------- 世界书 ----------

async function requireWorld(name) {
    const w = await loadWorld(String(name));
    if (!w) throw new Error(`世界书「${name}」不存在`);
    return w;
}

function storeWorld(name, list) {
    const w = state.worlds[name] ?? (state.worlds[name] = normalizeWorld({ entries: {} }));
    const { entries, list: internal } = fromWorldbook(deep(list ?? []), w);
    w.entries = entries;
    saveWorld(name);
    rerenderIfActive('world');
    return internal.map(toWorldbookEntry);
}

function characterByName(nameOrId) {
    if (nameOrId === undefined || nameOrId === null || nameOrId === 'current') return state.char ? { file: state.char.file, id: state.char.id, current: true } : null;
    const s = String(nameOrId);
    if (state.char && (state.char.file === s || state.char.id === s || state.char.card.data.name === s)) return { file: state.char.file, id: state.char.id, current: true };
    const c = state.characters.find(x => x.file === s || x.id === s || x.name === s);
    return c ? { file: c.file, id: c.id, current: false } : null;
}

async function cardOf(ref) {
    return ref.current ? state.char.card : api.getCharacter(ref.file);
}

// ---------- 预设 ----------

function presetRef(name) {
    const n = name === undefined || name === null || name === 'in_use' ? state.preset?.name : String(name);
    return { name: n, loaded: !!state.preset && n === state.preset.name };
}

function readPresetSync(name) {
    const ref = presetRef(name);
    if (ref.loaded) return state.preset.data;
    if (!state.presetList.some(p => p.name === ref.name)) throw new Error(`预设「${ref.name}」不存在`);
    // getPreset 是同步接口，没加载的预设只能同步去取
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/presets/${encodeURIComponent(ref.name)}`, false);
    xhr.send();
    if (xhr.status !== 200) throw new Error(`读取预设「${ref.name}」失败`);
    return normalizePreset(JSON.parse(xhr.responseText));
}

async function writePreset(name, helperPreset) {
    const ref = presetRef(name);
    if (ref.loaded) {
        state.preset.data = normalizePreset(fromHelperPreset(deep(helperPreset), state.preset.data));
        state.session = null;
        savePreset();
        rerenderIfActive('preset');
        rerenderIfActive('scripts');
        updateComposerChips();
        return;
    }
    const base = state.presetList.some(p => p.name === ref.name) ? readPresetSync(ref.name) : DEFAULT_PRESET;
    await api.save('presets', ref.name, normalizePreset(fromHelperPreset(deep(helperPreset), base)));
    await refreshLists();
    rerenderIfActive('preset');
    updateComposerChips();
}

// ---------- 正则 ----------

function regexStore(option) {
    const o = option ?? {};
    const type = o.type ?? (o.scope === 'character' ? 'character' : o.scope === 'global' ? 'global' : 'global');
    if (type === 'character') {
        if (!state.char) return { get: () => [], set: () => { throw new Error('没有打开角色卡'); } };
        const ext = state.char.card.data.extensions ?? (state.char.card.data.extensions = {});
        return { get: () => ext.regex_scripts ?? [], set: (v) => { ext.regex_scripts = v; saveCharacter(); } };
    }
    if (type === 'preset') {
        if (!state.preset) return { get: () => [], set: () => { throw new Error('没有加载预设'); } };
        const ext = state.preset.data.extensions ?? (state.preset.data.extensions = {});
        return { get: () => ext.regex_scripts ?? [], set: (v) => { ext.regex_scripts = v; savePreset(); } };
    }
    return { get: () => state.settings.regex ?? [], set: (v) => { state.settings.regex = v; saveSettings(); } };
}

const SOURCE_PLACEMENT = { user_input: REGEX_PLACEMENT.USER_INPUT, ai_output: REGEX_PLACEMENT.AI_OUTPUT, slash_command: REGEX_PLACEMENT.SLASH_COMMAND,
    world_info: REGEX_PLACEMENT.WORLD_INFO, reasoning: REGEX_PLACEMENT.REASONING };

// ---------- 注入的提示词 ----------

/** 生成前调用：把 injectPrompts 注入的内容放进会话的扩展提示词里 */
export async function applyInjections(session) {
    if (!session) return;
    for (const k of Object.keys(session.extensionPrompts)) if (k.startsWith('th_inject_')) delete session.extensionPrompts[k];
    for (const [id, inj] of injections) {
        if (inj.chat !== (state.chat?.name ?? '')) continue;
        const p = inj.prompt;
        if (p.position === 'none' || !p.content) continue;
        if (typeof p.filter === 'function') {
            try { if (!(await p.filter())) continue; } catch (e) { console.warn('[脚本] 注入提示词的 filter 出错', e); continue; }
        }
        session.extensionPrompts[`th_inject_${id}`] = { value: String(p.content), position: 1, depth: Number(p.depth ?? 0), role: p.role ?? 'system' };
    }
}

/** 一次生成结束后调用：只管一次的注入用完就撤掉 */
export function expireInjections() {
    for (const [id, inj] of [...injections]) if (inj.once) injections.delete(id);
}

export function dropInjectionsOf(owner) {
    for (const [id, inj] of [...injections]) if (inj.owner === owner) injections.delete(id);
    for (let i = macroLikes.length - 1; i >= 0; i--) if (macroLikes[i].owner === owner) macroLikes.splice(i, 1);
}

// ---------- SillyTavern.getContext() ----------

const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002 };

function popupBody(content) {
    if (content && typeof content === 'object') {
        if (content.jquery) return content.get(0);
        if (content.nodeType) return content;
    }
    return h('div', { class: 'script-popup', html: String(content ?? '') });
}

async function callGenericPopup(content, type = POPUP_TYPE.TEXT, inputValue = '', options = {}) {
    const input = type === POPUP_TYPE.INPUT ? h(Number(options.rows) > 1 ? 'textarea' : 'input', { class: Number(options.rows) > 1 ? 'textarea' : 'input', value: inputValue ?? '', rows: options.rows }) : null;
    const actions = [];
    if (type === POPUP_TYPE.CONFIRM || type === POPUP_TYPE.INPUT) actions.push({ label: options.cancelButton || '取消', value: POPUP_RESULT.NEGATIVE });
    if (type !== POPUP_TYPE.DISPLAY) actions.push({ label: options.okButton || '确定', primary: true, value: POPUP_RESULT.AFFIRMATIVE });
    const m = modal({ title: '', body: h('div', {}, popupBody(content), input), actions, wide: !!(options.wide || options.large) });
    const result = await m.done;
    if (result === undefined) return type === POPUP_TYPE.INPUT ? null : POPUP_RESULT.CANCELLED;
    if (type === POPUP_TYPE.INPUT) return result === POPUP_RESULT.AFFIRMATIVE ? input.value : null;
    return result;
}

/** 整个页面共用的上下文（脚本各自拿到的那份另外包了一层，用来记账事件监听） */
export function buildContext() {
    const s = getSession();
    const chat = state.chat?.messages ?? [];
    const cardData = state.char?.card?.data;
    const conn = state.settings.connections.length ? activeConnection() : null;
    const characters = state.char ? [{ ...cardData, data: cardData, avatar: state.char.file, name: cardData.name, chat: state.chat?.name ?? '' }] : [];
    const ctx = {
        chat,
        chatId: state.chat?.name ?? '',
        chatMetadata: state.chat?.header?.chat_metadata ?? {},
        chat_metadata: state.chat?.header?.chat_metadata ?? {},
        characterId: state.char ? 0 : undefined,
        this_chid: state.char ? 0 : undefined,
        characters,
        groups: [],
        groupId: null,
        name1: s?.names.user ?? activePersona().name,
        name2: s?.names.char ?? cardData?.name ?? '',
        mainApi: 'openai',
        onlineStatus: conn ? (conn.model || 'Connected') : 'no_connection',
        maxContext: Number(state.preset?.data?.openai_max_context ?? 0),
        eventSource,
        eventTypes: tavern_events,
        event_types: tavern_events,
        extensionSettings: state.settings.extensions,
        extension_settings: state.settings.extensions,
        powerUserSettings: { ...state.settings.power },
        chatCompletionSettings: state.preset?.data ?? {},
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup,
        callPopup: (content, type) => callGenericPopup(content, type === 'confirm' ? POPUP_TYPE.CONFIRM : type === 'input' ? POPUP_TYPE.INPUT : POPUP_TYPE.TEXT),
        getCurrentChatId: () => state.chat?.name ?? '',
        getChatCompletionModel: () => conn?.model ?? '',
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        substituteParams: (t) => s?.substitute(String(t ?? '')) ?? String(t ?? ''),
        substituteParamsExtended: (t) => s?.substitute(String(t ?? '')) ?? String(t ?? ''),
        saveChat: () => saveChat({ now: true }),
        saveChatDebounced: () => saveChat(),
        saveChatConditional: () => saveChat({ now: true }),
        saveMetadata: () => saveChat({ now: true }),
        saveMetadataDebounced: () => saveChat(),
        saveSettingsDebounced: () => saveSettings(),
        saveSettings: () => saveSettings({ now: true }),
        reloadCurrentChat: async () => { renderChat(); },
        generate: (type, opt) => mainGenerate(type === 'quiet' ? 'quiet' : (type ?? 'normal'), { quietPrompt: opt?.quiet_prompt }),
        Generate: (type, opt) => mainGenerate(type === 'quiet' ? 'quiet' : (type ?? 'normal'), { quietPrompt: opt?.quiet_prompt }),
        generateQuietPrompt: (p) => scriptGenerate({ quiet_prompt: typeof p === 'object' ? p?.quietPrompt : p, should_silence: true }),
        generateRaw: (p) => scriptGenerate({ ordered_prompts: [{ role: 'user', content: typeof p === 'object' ? (p?.prompt ?? '') : String(p ?? '') }], should_silence: true }, { raw: true }),
        stopGeneration: () => { stopGeneration(); return true; },
        executeSlashCommands: (cmd) => ops.triggerSlash(cmd).then(pipe => ({ pipe })),
        executeSlashCommandsWithOptions: (cmd) => ops.triggerSlash(cmd).then(pipe => ({ pipe })),
        updateMessageBlock: (id) => renderMessage(Number(id)),
        addOneMessage: (mes) => { const i = chat.indexOf(mes); renderMessage(i >= 0 ? i : chat.length - 1); },
        messageFormatting: (text, name, isSystem, isUser) => formatMessage(String(text ?? ''), { charName: s?.names.char, isUser: !!isUser, isSystem: !!isSystem }).html,
        getTokenCountAsync: async (text) => estimateTokens(String(text ?? '')),
        getTokenCount: (text) => estimateTokens(String(text ?? '')),
        getThumbnailUrl: (type, file) => (type === 'avatar' ? api.thumbUrl(file) : api.personaAvatarUrl(file)),
        uuidv4: uuid,
        humanizedDateTime,
        isMobile: () => matchMedia('(max-width: 760px)').matches,
        t: (strings, ...values) => (Array.isArray(strings) ? strings.reduce((a, c, i) => a + c + (values[i] ?? ''), '') : String(strings)),
        variables: {
            local: { get: (k) => lodash().get(s?.vars.local() ?? {}, k), set: (k, v) => { lodash().set(s.vars.local(), k, v); s.vars.invalidate(); saveChat(); } },
            global: { get: (k) => lodash().get(s?.vars.global() ?? {}, k), set: (k, v) => { lodash().set(s.vars.global(), k, v); s.vars.invalidate(); saveSettings(); } },
        },
        writeExtensionField: async (_characterId, key, value) => {
            if (!state.char) return;
            (state.char.card.data.extensions ??= {})[key] = deep(value);
            saveCharacter();
        },
    };
    return ctx;
}

// ---------- 每个脚本自己的那份接口 ----------

/**
 * @param {object|null} rt 脚本运行时（见 ui/scripts.js）。为空 = 页面级的接口，不带脚本身份
 */
export function createScriptApi(rt) {
    const _ = lodash();
    const owner = rt ?? { id: '', listeners: new Map() };
    const fail = (e, where) => { if (rt) rt.fail(e, where); else console.error('[酒馆助手接口]', where, e); };

    // ----- 事件 -----
    const wrap = (type, fn) => async (...args) => {
        try {
            const r = fn(...args);
            if (r && typeof r.then === 'function') {
                let timer;
                const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), LISTENER_TIMEOUT); });
                const out = await Promise.race([r.then(() => 'done'), late]);
                clearTimeout(timer);
                if (out === 'timeout') console.warn(`[脚本${rt ? ` ${rt.name}` : ''}] 事件 ${type} 的处理超过 ${LISTENER_TIMEOUT / 1000} 秒，不再等它`);
            }
        } catch (e) {
            fail(e, `处理事件 ${type}`);
        }
    };
    const register = (type, fn, how) => {
        if (typeof fn !== 'function') throw new Error('事件监听器必须是函数');
        type = String(type);
        let m = owner.listeners.get(type);
        if (!m) owner.listeners.set(type, (m = new Map()));
        let w = m.get(fn);
        if (!w) m.set(fn, (w = wrap(type, fn)));
        if (how === 'first') eventSource.makeFirst(type, w); else if (how === 'last') eventSource.makeLast(type, w); else eventSource.on(type, w);
        rt?.host.onListenerAdded?.(type, w);
        return { stop: () => eventRemoveListener(type, fn) };
    };
    const eventOn = (type, fn) => register(type, fn);
    const eventMakeFirst = (type, fn) => register(type, fn, 'first');
    const eventMakeLast = (type, fn) => register(type, fn, 'last');
    const eventOnce = (type, fn) => {
        const once = (...args) => { eventRemoveListener(type, once); return fn(...args); };
        return register(type, once);
    };
    function eventRemoveListener(type, fn) {
        const m = owner.listeners.get(String(type));
        const w = m?.get(fn);
        if (!w) return;
        eventSource.off(String(type), w);
        m.delete(fn);
    }
    const eventClearEvent = (type) => {
        const m = owner.listeners.get(String(type));
        for (const w of m?.values() ?? []) eventSource.off(String(type), w);
        owner.listeners.delete(String(type));
    };
    const eventClearListener = (fn) => { for (const type of [...owner.listeners.keys()]) eventRemoveListener(type, fn); };
    const eventClearAll = () => { for (const type of [...owner.listeners.keys()]) eventClearEvent(type); };
    const forward = (type, args) => {
        if (HOST_BROADCAST.has(type)) return;
        try { broadcastEvent(type, ...JSON.parse(JSON.stringify(args))); } catch { /* 带函数之类传不过去的参数就不转发给消息里的前端界面 */ }
    };
    const eventEmit = async (type, ...args) => { forward(String(type), args); await eventSource.emit(String(type), ...args); };
    const eventEmitAndWait = (type, ...args) => { forward(String(type), args); eventSource.emit(String(type), ...args); };

    // ----- 变量 -----
    const getVariables = (option) => deep(variableStore(option, rt).get());
    const replaceVariables = (variables, option) => writeVariables(variableStore(option, rt), variables);
    const updateVariablesWith = (updater, option) => {
        const store = variableStore(option, rt);
        const result = updater(deep(store.get()));
        const done = (v) => { const next = isObj(v) ? v : store.get(); writeVariables(store, next); return deep(next); };
        return result && typeof result.then === 'function' ? result.then(done) : done(result);
    };
    const insertOrAssignVariables = (variables, option) => updateVariablesWith(old => _.mergeWith(old, deep(variables), (a, b) => (Array.isArray(b) ? b : undefined)), option);
    const insertVariables = (variables, option) => updateVariablesWith(old => _.defaultsDeep(old, deep(variables)), option);
    const deleteVariable = (path, option) => {
        let deleted = false;
        const variables = updateVariablesWith(old => { deleted = _.unset(old, path); return old; }, option);
        return { variables, delete_occurred: deleted };
    };
    const getAllVariables = () => {
        const session = getSession();
        const out = {};
        Object.assign(out, state.settings.variables.global ?? {});
        if (state.char) Object.assign(out, helperVariablesOf(state.char.card.data.extensions));
        if (rt) { try { Object.assign(out, variableStore({ type: 'script' }, rt).get()); } catch { /* 脚本已不在卡里 */ } }
        if (session) Object.assign(out, session.vars.local());
        for (const m of state.chat?.messages ?? []) {
            const v = Array.isArray(m.variables) ? m.variables[m.swipe_id ?? 0] : null;
            if (v) Object.assign(out, v);
        }
        return deep(out);
    };
    const registerVariableSchema = () => {};

    // ----- 楼层 -----
    const getChatMessages = (range, option) => ops.getChatMessages(range, option ?? {});
    const setChatMessages = (list, option) => ops.setChatMessages(deep(list), option ?? {});
    const setChatMessage = (field, messageId, option) => ops.setChatMessages([{ ...(deep(field) ?? {}), message_id: messageId }], option ?? {});
    const createChatMessages = (list, option) => ops.createChatMessages(deep(list), option ?? {});
    const deleteChatMessages = (ids, option) => ops.deleteChatMessages(ids, option ?? {});
    const rotateChatMessages = (begin, middle, end, option) => ops.rotateChatMessages(begin, middle, end, option ?? {});
    const getLastMessageId = () => (state.chat?.messages.length ?? 0) - 1;
    const substitudeMacros = (text) => getSession()?.substitute(String(text ?? '')) ?? String(text ?? '');

    const retrieveDisplayedMessage = (id) => window.jQuery(`#chat .mes[mesid="${Number(id)}"] .mes_text`);
    const formatAsDisplayedMessage = (text, option = {}) => {
        const session = getSession();
        const chat = state.chat?.messages ?? [];
        let id = option.message_id;
        if (id === undefined || id === 'last') id = chat.length - 1;
        else if (id === 'last_user') id = chat.findLastIndex(m => m.is_user);
        else if (id === 'last_char') id = chat.findLastIndex(m => !m.is_user && !m.is_system);
        const m = chat[Number(id)];
        if (!m) throw new Error(`楼层号 ${option.message_id} 超出范围`);
        let out = substitudeMacros(text);
        if (session) out = getRegexedString(out, m.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, { scripts: session.regexScripts(), isMarkdown: true, substitute: (t, o) => session.substitute(t, o ?? {}) });
        return formatMessage(out, { charName: session?.names.char, isUser: !!m.is_user }).html;
    };
    const refreshOneMessage = async (id) => { renderMessage(Number(id)); };

    // ----- 生成 -----
    const generate = (config) => scriptGenerate(deep(config ?? {}), { raw: false });
    const generateRaw = (config) => scriptGenerate(deep(config ?? {}), { raw: true });
    const getModelList = async () => { throw new Error('轻酒馆没有实现 getModelList'); };

    // ----- 全局共享 -----
    const initializeGlobal = (name, value) => setGlobal(String(name), value, rt ?? null);
    const waitGlobalInitialized = (name) => {
        name = String(name);
        const take = (value) => { if (rt?.win) { try { defineGlobal(rt.win, name, value); } catch { /* 窗口没了 */ } } return value; };
        if (globals.has(name)) return Promise.resolve(take(globals.get(name).value));
        return new Promise((resolve) => {
            if (!globalWaiters.has(name)) globalWaiters.set(name, []);
            globalWaiters.get(name).push((v) => resolve(take(v)));
        });
    };

    // ----- 注入 -----
    const injectPrompts = (prompts, options = {}) => {
        const ids = [];
        for (const p of prompts ?? []) {
            const id = String(p?.id ?? uuid());
            ids.push(id);
            injections.set(id, { prompt: { ...p, id }, once: !!options.once, chat: state.chat?.name ?? '', owner: rt ?? null });
        }
        return { uninject: () => uninjectPrompts(ids) };
    };
    const uninjectPrompts = (ids) => { for (const id of ids ?? []) injections.delete(String(id)); };

    // ----- 助手宏（登记下来，轻酒馆目前不在显示 / 提示词里应用它们） -----
    const registerMacroLike = (regex, replace) => {
        macroLikes.push({ regex, replace, owner: rt ?? null });
        return { unregister: () => unregisterMacroLike(regex) };
    };
    const unregisterMacroLike = (regex) => {
        const i = macroLikes.findIndex(m => String(m.regex) === String(regex));
        if (i >= 0) macroLikes.splice(i, 1);
    };

    // ----- 角色卡 -----
    const getCurrentCharacterName = () => state.char?.card.data.name ?? null;
    const getCurrentCharacterId = () => state.char?.file ?? null;
    const getCharacterNames = () => state.characters.map(c => c.name);
    const getCharacterIds = () => state.characters.map(c => c.file);
    const getCharData = (name) => {
        const ref = characterByName(name ?? 'current');
        if (!ref) return null;
        if (!ref.current) { const meta = state.characters.find(c => c.file === ref.file); return meta ? { name: meta.name, avatar: meta.file, tags: meta.tags } : null; }
        const d = state.char.card.data;
        return deep({ ...d, data: d, avatar: state.char.file, chat: state.chat?.name ?? '' });
    };
    const getCharAvatarPath = (name) => { const ref = characterByName(name ?? 'current'); return ref ? api.avatarUrl(ref.file) : null; };
    const getChatHistoryBrief = async () => state.chatList.map(c => ({ file_name: `${c.name}.jsonl`, mes: c.last, last_mes: c.mtime }));
    const getChatHistoryDetail = async () => null;
    const toCharacter = (card, file) => {
        const d = card.data;
        return {
            avatar: file,
            version: d.character_version ?? '',
            creator: d.creator ?? '',
            creator_notes: d.creator_notes ?? '',
            worldbook: d.extensions?.world || null,
            description: d.description ?? '',
            first_messages: [d.first_mes ?? '', ...(d.alternate_greetings ?? [])],
            extensions: deep({ ...(d.extensions ?? {}), regex_scripts: (d.extensions?.regex_scripts ?? []).map(toTavernRegex), tavern_helper: { scripts: scriptTreesOf(d.extensions), variables: helperVariablesOf(d.extensions) } }),
        };
    };
    const getCharacter = async (name) => {
        const ref = characterByName(name);
        if (!ref) throw new Error(`角色卡「${name}」不存在`);
        return toCharacter(await cardOf(ref), ref.file);
    };
    const replaceCharacter = async (name, character) => {
        const ref = characterByName(name);
        if (!ref) throw new Error(`角色卡「${name}」不存在`);
        const card = await cardOf(ref);
        const d = card.data;
        const c = deep(character) ?? {};
        if (c.version !== undefined) d.character_version = String(c.version);
        if (c.creator !== undefined) d.creator = String(c.creator);
        if (c.creator_notes !== undefined) d.creator_notes = String(c.creator_notes);
        if (c.description !== undefined) d.description = String(c.description);
        if (Array.isArray(c.first_messages)) { d.first_mes = String(c.first_messages[0] ?? ''); d.alternate_greetings = c.first_messages.slice(1).map(String); }
        if (c.worldbook !== undefined) (d.extensions ??= {}).world = c.worldbook ?? '';
        if (isObj(c.extensions)) {
            const { regex_scripts, tavern_helper, ...rest } = c.extensions;
            Object.assign((d.extensions ??= {}), rest);
            if (Array.isArray(regex_scripts)) d.extensions.regex_scripts = regex_scripts.map(r => fromTavernRegex(r));
            if (isObj(tavern_helper)) d.extensions.tavern_helper = tavern_helper;
        }
        if (ref.current) { saveCharacter(); state.session = null; rerenderIfActive('char'); }
        else await api.saveCharacter(ref.file, card);
    };
    const updateCharacterWith = async (name, updater) => {
        const next = await updater(await getCharacter(name));
        await replaceCharacter(name, next);
        return getCharacter(name);
    };

    // ----- 世界书 -----
    const getWorldbookNames = () => state.worldList.map(w => w.name);
    const getGlobalWorldbookNames = () => [...(state.settings.worldInfo.globalSelect ?? [])];
    const rebindGlobalWorldbooks = async (names) => {
        state.settings.worldInfo.globalSelect = [...new Set((names ?? []).map(String))];
        saveSettings();
        await loadRelevantWorlds();
        rerenderIfActive('world');
    };
    const getCharWorldbookNames = (name) => {
        const ref = characterByName(name ?? 'current');
        if (!ref) return { primary: null, additional: [] };
        const meta = ref.current ? { world: state.char.card.data.extensions?.world } : state.characters.find(c => c.file === ref.file);
        return { primary: meta?.world || null, additional: [...(state.settings.worldInfo.charLore?.[ref.id] ?? [])] };
    };
    const rebindCharWorldbooks = async (name, books) => {
        const ref = characterByName(name ?? 'current');
        if (!ref) throw new Error(`角色卡「${name}」不存在`);
        const card = await cardOf(ref);
        (card.data.extensions ??= {}).world = books?.primary ?? '';
        state.settings.worldInfo.charLore = { ...(state.settings.worldInfo.charLore ?? {}), [ref.id]: [...new Set(books?.additional ?? [])] };
        saveSettings();
        if (ref.current) { saveCharacter(); await loadRelevantWorlds(); rerenderIfActive('char'); }
        else await api.saveCharacter(ref.file, card);
    };
    const getChatWorldbookName = () => state.chat?.header?.chat_metadata?.world_info || null;
    const rebindChatWorldbook = async (_chat, name) => {
        if (!state.chat) throw new Error('没有打开的聊天');
        const meta = state.chat.header.chat_metadata ?? (state.chat.header.chat_metadata = {});
        if (name) meta.world_info = String(name); else delete meta.world_info;
        saveChat();
        await loadRelevantWorlds();
        rerenderIfActive('note');
    };
    const createOrReplaceWorldbook = async (name, list = []) => {
        name = String(name);
        const existed = state.worldList.some(w => w.name === name);
        state.worlds[name] = normalizeWorld({ entries: {}, ...(existed ? (state.worlds[name] ?? {}) : {}) });
        const { entries } = fromWorldbook(deep(list ?? []), existed ? state.worlds[name] : null);
        state.worlds[name].entries = entries;
        await api.save('worlds', name, state.worlds[name]);
        if (!existed) await refreshLists();
        rerenderIfActive('world');
        return !existed;
    };
    const createWorldbook = async (name, list) => {
        if (state.worldList.some(w => w.name === String(name))) return false;
        return createOrReplaceWorldbook(name, list);
    };
    const getOrCreateChatWorldbook = async (_chat, name) => {
        const cur = getChatWorldbookName();
        if (cur) return cur;
        const n = String(name || `Chat Book ${state.chat?.name ?? humanizedDateTime()}`).replace(/[\\/:*?"<>|]/g, '_');
        await createWorldbook(n, []);
        await rebindChatWorldbook('current', n);
        return n;
    };
    const deleteWorldbook = async (name) => {
        name = String(name);
        if (!state.worldList.some(w => w.name === name)) return false;
        await api.remove('worlds', name);
        delete state.worlds[name];
        await refreshLists();
        rerenderIfActive('world');
        return true;
    };
    const getWorldbook = async (name) => deep(toWorldbook(await requireWorld(name)));
    const replaceWorldbook = async (name, list) => { await requireWorld(name); storeWorld(String(name), list); };
    const updateWorldbookWith = async (name, updater) => {
        const cur = deep(toWorldbook(await requireWorld(name)));
        const next = await updater(cur);
        return deep(storeWorld(String(name), Array.isArray(next) ? next : cur));
    };
    const createWorldbookEntries = async (name, entries) => {
        const world = await requireWorld(name);
        const cur = toWorldbook(world);
        let uid = Math.max(-1, ...cur.map(e => e.uid)) + 1;
        const fresh = (entries ?? []).map(e => ({ ...deep(e), uid: uid++ }));
        const stored = storeWorld(String(name), [...cur, ...fresh]);
        return { worldbook: deep(stored), new_entries: deep(stored.slice(cur.length)) };
    };
    const deleteWorldbookEntries = async (name, predicate) => {
        const cur = deep(toWorldbook(await requireWorld(name)));
        const gone = cur.filter(e => predicate(e));
        const stored = storeWorld(String(name), cur.filter(e => !gone.includes(e)));
        return { worldbook: deep(stored), deleted_entries: gone };
    };

    // ----- 预设 -----
    const getPresetNames = () => ['in_use', ...state.presetList.map(p => p.name)];
    const getLoadedPresetName = () => state.preset?.name ?? '';
    const loadPreset = (name) => {
        if (!state.presetList.some(p => p.name === String(name))) return false;
        switchPreset(String(name)).catch(e => fail(e, 'loadPreset'));
        return true;
    };
    const getPreset = (name) => deep(toHelperPreset(readPresetSync(name)));
    const replacePreset = (name, preset) => writePreset(name, preset);
    const updatePresetWith = async (name, updater) => {
        const next = await updater(getPreset(name));
        await writePreset(name, next);
        return getPreset(name);
    };
    const setPreset = async (name, partial) => {
        const merged = _.mergeWith(getPreset(name), deep(partial), (a, b) => (Array.isArray(b) ? b : undefined));
        await writePreset(name, merged);
        return getPreset(name);
    };
    const createOrReplacePreset = async (name, preset) => {
        const n = name === 'in_use' ? state.preset.name : String(name);
        const existed = state.presetList.some(p => p.name === n);
        await writePreset(n, preset ?? toHelperPreset(DEFAULT_PRESET));
        return !existed;
    };
    const createPreset = async (name, preset) => {
        if (state.presetList.some(p => p.name === String(name))) return false;
        return createOrReplacePreset(name, preset);
    };
    const deletePreset = async (name) => {
        const n = String(name);
        if (!state.presetList.some(p => p.name === n) || n === state.preset?.name) return false;
        await api.remove('presets', n);
        await refreshLists();
        rerenderIfActive('preset');
        return true;
    };
    const renamePreset = async (name, to) => {
        const n = String(name);
        if (!state.presetList.some(p => p.name === n) || n === state.preset?.name) return false;
        await api.rename('presets', n, String(to));
        await refreshLists();
        rerenderIfActive('preset');
        return true;
    };
    const SYSTEM_PROMPT_IDS = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
    const PLACEHOLDER_IDS = ['worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter', 'dialogueExamples', 'chatHistory'];
    const isPresetSystemPrompt = (p) => SYSTEM_PROMPT_IDS.includes(p?.id);
    const isPresetPlaceholderPrompt = (p) => PLACEHOLDER_IDS.includes(p?.id);
    const isPresetNormalPrompt = (p) => !isPresetSystemPrompt(p) && !isPresetPlaceholderPrompt(p);

    // ----- 正则 -----
    const getTavernRegexes = (option) => {
        const o = option ?? {};
        let list = [];
        if (o.type) list = regexStore(o).get().map(toTavernRegex);
        else {
            // 旧接口：{scope: 'all'|'global'|'character', enable_state: 'all'|'enabled'|'disabled'}
            const scope = o.scope ?? 'all';
            if (scope !== 'character') list.push(...regexStore({ type: 'global' }).get().map(r => ({ ...toTavernRegex(r), scope: 'global' })));
            if (scope !== 'global') list.push(...regexStore({ type: 'character' }).get().map(r => ({ ...toTavernRegex(r), scope: 'character' })));
            if (o.enable_state === 'enabled') list = list.filter(r => r.enabled);
            if (o.enable_state === 'disabled') list = list.filter(r => !r.enabled);
        }
        return deep(list);
    };
    const replaceTavernRegexes = async (regexes, option) => {
        const o = option ?? {};
        const put = (type, list) => {
            const store = regexStore({ type });
            const old = new Map(store.get().map(r => [String(r.id), r]));
            store.set(list.map(r => fromTavernRegex(r, old.get(String(r.id)))));
        };
        const list = deep(regexes ?? []);
        if (o.type) put(o.type, list);
        else {
            if ((o.scope ?? 'all') !== 'character') put('global', list.filter(r => r.scope !== 'character'));
            if ((o.scope ?? 'all') !== 'global') put('character', list.filter(r => r.scope === 'character'));
        }
        state.session = null;
        renderChat();
        rerenderIfActive('regex');
    };
    const updateTavernRegexesWith = async (updater, option) => {
        const next = await updater(getTavernRegexes(option));
        await replaceTavernRegexes(next, option);
        return getTavernRegexes(option);
    };
    const isCharacterTavernRegexesEnabled = () => state.settings.power.regexAllowCharacter !== false;
    const formatAsTavernRegexedString = (text, source, destination, option = {}) => {
        const session = getSession();
        if (!session) return String(text ?? '');
        return getRegexedString(String(text ?? ''), SOURCE_PLACEMENT[source] ?? REGEX_PLACEMENT.AI_OUTPUT, {
            scripts: session.regexScripts(), isMarkdown: destination === 'display', isPrompt: destination === 'prompt',
            depth: option.depth, substitute: (t, o) => session.substitute(t, o ?? {}),
        });
    };

    // ----- 脚本自己 -----
    const needScript = () => { if (!rt) throw new Error('这个接口只能在脚本里用'); return rt; };
    const myRaw = () => {
        const found = findScriptRaw(needScript().id, rt.source);
        if (!found) throw new Error('这个脚本已经不在角色卡 / 预设里了');
        return found;
    };
    const myButtons = () => {
        const { raw } = myRaw();
        if (!isObj(raw.button)) raw.button = { enabled: true, buttons: Array.isArray(raw.buttons) ? raw.buttons : [] };
        if (!Array.isArray(raw.button.buttons)) raw.button.buttons = [];
        return raw.button;
    };
    const saveMine = () => { persistSource(rt.source); rt.host.onButtonsChanged?.(); };
    const cleanButtons = (list) => (Array.isArray(list) ? list : []).filter(b => b && b.name !== undefined).map(b => ({ name: String(b.name), visible: b.visible !== false }));
    const getScriptId = () => needScript().id;
    const getScriptName = () => needScript().name;
    const getScriptInfo = () => String(myRaw().raw.info ?? '');
    const replaceScriptInfo = (info) => { myRaw().raw.info = String(info ?? ''); persistSource(rt.source); rerenderIfActive('scripts'); };
    const getScriptButtons = () => deep(myButtons().buttons);
    const replaceScriptButtons = (buttons) => { myButtons().buttons = cleanButtons(deep(buttons)); saveMine(); };
    const updateScriptButtonsWith = (updater) => {
        const r = updater(getScriptButtons());
        const done = (v) => { replaceScriptButtons(v); return getScriptButtons(); };
        return r && typeof r.then === 'function' ? r.then(done) : done(r);
    };
    const appendInexistentScriptButtons = (buttons) => {
        const cur = myButtons().buttons;
        const add = cleanButtons(deep(buttons)).filter(b => !cur.some(c => c.name === b.name));
        if (!add.length) return;
        cur.push(...add);
        saveMine();
    };
    const getButtonEvent = (name) => buttonEventName(needScript().id, name);
    const eventOnButton = (name, fn) => { eventOn(getButtonEvent(name), fn); };
    const getAllEnabledScriptButtons = () => scriptHost?.buttonMap?.() ?? {};
    const treesOf = (option) => {
        const type = option?.type ?? 'character';
        if (type === 'character') { if (!state.char) throw new Error('没有打开角色卡'); return { ext: (state.char.card.data.extensions ??= {}), source: 'character' }; }
        if (type === 'preset') { if (!state.preset) throw new Error('没有加载预设'); return { ext: (state.preset.data.extensions ??= {}), source: 'preset' }; }
        return { ext: { tavern_helper: { scripts: [] } }, source: 'global' };
    };
    const getScriptTrees = (option) => deep(scriptTreesOf(treesOf(option).ext));
    const replaceScriptTrees = (trees, option) => {
        const { ext, source } = treesOf(option);
        if (source === 'global') throw new Error('轻酒馆没有全局脚本库，脚本只能放在角色卡或预设里');
        helperVariablesOf(ext, true);
        ext.tavern_helper.scripts = deep(trees ?? []);
        persistSource(source);
        scriptHost?.onLibraryChanged?.();
    };
    const updateScriptTreesWith = (updater, option) => {
        const r = updater(getScriptTrees(option));
        const done = (v) => { replaceScriptTrees(v, option); return getScriptTrees(option); };
        return r && typeof r.then === 'function' ? r.then(done) : done(r);
    };

    // ----- 杂项 -----
    const errorCatched = (fn) => function (...args) {
        const report = (e) => { fail(e, '脚本'); toastr.error(String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 3).join('\n'), rt ? `脚本「${rt.name}」出错` : '脚本出错'); };
        try {
            const r = fn.apply(this, args);
            return r && typeof r.catch === 'function' ? r.catch(report) : r;
        } catch (e) {
            report(e);
            return undefined;
        }
    };
    const getIframeName = () => (rt ? rt.frameName : '');
    const getMessageId = (iframeName) => {
        const m = String(iframeName).match(/^(?:TH-message--|message-iframe-)(\d+)/);
        if (!m) throw new Error(`「${iframeName}」不是消息里前端界面的名字`);
        return Number(m[1]);
    };
    const getCurrentMessageId = () => { throw new Error('getCurrentMessageId 只能在消息里的前端界面中使用，脚本里请用 getLastMessageId()'); };
    const reloadIframe = () => { rt?.host.reload?.(rt); };
    const triggerSlash = (cmd) => ops.triggerSlash(String(cmd));

    const builtin = {
        addOneMessage: (mes) => { const chat = state.chat?.messages ?? []; const i = chat.indexOf(mes); renderMessage(i >= 0 ? i : chat.length - 1); },
        copyText: (text) => navigator.clipboard?.writeText(String(text ?? '')),
        duringGenerating: () => !!state.generating,
        getImageTokenCost: async () => 0,
        getVideoTokenCost: async () => 0,
        parseRegexFromString,
        promptManager: {
            get messages() { return [{ identifier: 'chat', collection: (getSession()?.lastPrompt?.messages ?? []).map(m => ({ identifier: m.source ?? '', role: m.role, content: m.content, tokens: estimateTokens(m.content) })) }]; },
            getPromptCollection: () => ({ collection: deep(state.preset?.data?.prompts ?? []) }),
        },
        reloadAndRenderChatWithoutEvents: async () => { renderChat(); },
        reloadChatWithoutEvents: async () => { renderChat(); },
        reloadEditor: () => rerenderIfActive('world'),
        reloadEditorDebounced: () => rerenderIfActive('world'),
        renderMarkdown: (text) => formatMessage(String(text ?? ''), {}).html,
        renderPromptManager: () => rerenderIfActive('preset'),
        renderPromptManagerDebounced: () => rerenderIfActive('preset'),
        saveSettings: async () => { await saveSettings({ now: true }); },
        uuidv4: uuid,
    };

    // ----- MVU -----
    const Mvu = {
        events: { ...MVU_EVENTS },
        getMvuData: (option) => getVariables(option ?? { type: 'message', message_id: 'latest' }),
        replaceMvuData: async (data, option) => replaceVariables(data, option ?? { type: 'message', message_id: 'latest' }),
        getCurrentMvuData: () => getVariables({ type: 'message', message_id: 'latest' }),
        replaceCurrentMvuData: async (data) => replaceVariables(data, { type: 'message', message_id: 'latest' }),
        parseMessage: async (message, oldData) => {
            const emit = mvuEmitter();
            const res = emit ? await processMessageWithEvents(deep(oldData), String(message ?? ''), emit) : processMessage(deep(oldData), String(message ?? ''));
            return res.changed ? deep(res.variables) : undefined;
        },
        reloadInitVar: async () => false,
        setMvuVariable: async (data, path, value) => { if (!isObj(data.stat_data)) data.stat_data = {}; _.set(data.stat_data, path, value); return true; },
        getMvuVariable: (data, path, option = {}) => {
            const tree = option.category === 'display' ? data?.display_data : option.category === 'delta' ? data?.delta_data : data?.stat_data;
            const v = _.get(tree, path, option.default_value);
            return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && !Array.isArray(v[0]) ? v[0] : v;
        },
        getRecordFromMvuData: (data, category = 'stat') => (category === 'display' ? data?.display_data : category === 'delta' ? data?.delta_data : data?.stat_data) ?? {},
        isDuringExtraAnalysis: () => false,
    };

    const helper = {
        // 事件
        eventOn, eventOnButton, eventMakeLast, eventMakeFirst, eventOnce, eventEmit, eventEmitAndWait, eventRemoveListener, eventClearEvent, eventClearListener, eventClearAll,
        tavern_events, iframe_events,
        // 变量
        getVariables, replaceVariables, updateVariablesWith, insertOrAssignVariables, insertVariables, deleteVariable, getAllVariables, registerVariableSchema,
        // 楼层
        getChatMessages, setChatMessages, setChatMessage, createChatMessages, deleteChatMessages, rotateChatMessages, getLastMessageId, substitudeMacros,
        retrieveDisplayedMessage, formatAsDisplayedMessage, refreshOneMessage,
        // 生成
        generate, generateRaw, getModelList, stopGenerationById: stopScriptGeneration, stopAllGeneration: stopAllScriptGeneration,
        builtin_prompt_default_order: [...RAW_PROMPT_ORDER], placeholder_prompt_default_order: [...RAW_PROMPT_ORDER],
        // 全局、注入、宏
        initializeGlobal, waitGlobalInitialized, injectPrompts, uninjectPrompts, registerMacroLike, unregisterMacroLike,
        // 角色卡
        getCurrentCharacterName, getCurrentCharacterId, getCharacterNames, getCharacterIds, getCharData, getCharAvatarPath, getChatHistoryBrief, getChatHistoryDetail,
        getCharacter, replaceCharacter, updateCharacterWith,
        // 世界书
        getWorldbookNames, getGlobalWorldbookNames, rebindGlobalWorldbooks, getCharWorldbookNames, rebindCharWorldbooks, getChatWorldbookName, rebindChatWorldbook,
        getOrCreateChatWorldbook, createWorldbook, createOrReplaceWorldbook, deleteWorldbook, getWorldbook, replaceWorldbook, updateWorldbookWith,
        createWorldbookEntries, deleteWorldbookEntries,
        // 预设
        getPresetNames, getLoadedPresetName, loadPreset, getPreset, replacePreset, updatePresetWith, setPreset, createPreset, createOrReplacePreset, deletePreset, renamePreset,
        isPresetNormalPrompt, isPresetSystemPrompt, isPresetPlaceholderPrompt, default_preset: toHelperPreset(DEFAULT_PRESET),
        // 正则
        getTavernRegexes, replaceTavernRegexes, updateTavernRegexesWith, isCharacterTavernRegexesEnabled, formatAsTavernRegexedString,
        // 脚本
        getScriptId, getScriptName, getScriptInfo, replaceScriptInfo, getScriptButtons, replaceScriptButtons, updateScriptButtonsWith, appendInexistentScriptButtons,
        getButtonEvent, getAllEnabledScriptButtons, getScriptTrees, replaceScriptTrees, updateScriptTreesWith,
        // 杂项
        errorCatched, getIframeName, getMessageId, getCurrentMessageId, reloadIframe, triggerSlash, triggerSlashWithResult: triggerSlash, builtin,
        getTavernHelperVersion: () => HELPER_VERSION, getFrontendVersion: () => HELPER_VERSION, getTavernVersion: () => TAVERN_VERSION,
        getTavernHelperExtensionId: () => 'JS-Slash-Runner', isAdmin: () => true,
    };

    /** 这个脚本看到的 SillyTavern：页面共用的上下文，事件监听换成记在这个脚本名下的 */
    const context = () => {
        const base = buildContext();
        base.eventSource = {
            on: (type, fn) => { eventOn(type, fn); },
            once: (type, fn) => { eventOnce(type, fn); },
            makeFirst: (type, fn) => { eventMakeFirst(type, fn); },
            makeLast: (type, fn) => { eventMakeLast(type, fn); },
            removeListener: eventRemoveListener,
            off: eventRemoveListener,
            emit: eventEmit,
            emitAndWait: eventEmitAndWait,
        };
        return base;
    };
    const SillyTavern = () => { const c = context(); return { ...c, getContext: context, libs: { lodash: _, DOMPurify: window.DOMPurify, showdown: window.showdown } }; };

    return { helper, Mvu, SillyTavern, eventClearAll };
}

/** 页面级的接口：挂到 window 上，供 window.parent.TavernHelper / window.parent.SillyTavern 这种写法使用 */
export function installHostGlobals() {
    const page = createScriptApi(null);
    window.TavernHelper = page.helper;
    window.toastr = toastr;
    window.YAML = YAML;
    window.SillyTavern = { getContext: () => page.SillyTavern(), libs: { lodash: lodash(), DOMPurify: window.DOMPurify, showdown: window.showdown } };
    // MVU 是内置实现，随时可用；脚本和前端界面用 waitGlobalInitialized('Mvu') 等它
    globals.set('Mvu', { value: page.Mvu, owner: 'host' });
    window.Mvu = page.Mvu;
    return page;
}
