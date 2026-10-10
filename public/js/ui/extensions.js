// 酒馆第三方插件（public/scripts/extensions/third-party 那种）在轻酒馆里的加载器。
// 插件按酒馆的路径 import '../../../../script.js'、'../../../extensions.js' 等模块，轻酒馆在 public/ 下放了同名的兼容模块
// （public/script.js、public/scripts/*.js、public/st-context.js），它们从这里拿实现。
// 插件文件本身由服务端从插件目录提供：/scripts/extensions/third-party/<目录名>/...
import { state, eventSource, saveSettings, saveChat, loadWorld, saveWorld, refreshLists } from '../state.js';
import { PROTOCOL } from '../api.js';
import { tavern_events, buildContext } from './script-api.js';
import { toast } from './dom.js';
import { getSession } from '../controller.js';

const EXT_BASE = '/scripts/extensions/third-party/';
/** @type {Array<{name: string, display_name: string, version: string, generate_interceptor: string, loaded: boolean, error?: string}>} */
export const extensionList = [];
let listLoaded = false;

/** 插件开关：settings.thirdParty[目录名] = true 才加载 */
export function isExtensionEnabled(name) {
    return state.settings.thirdParty?.[name] === true;
}

export function setExtensionEnabled(name, on) {
    state.settings.thirdParty = { ...(state.settings.thirdParty ?? {}), [name]: !!on };
    saveSettings({ now: true });
}

export async function fetchExtensionList() {
    const r = await fetch('/api/extensions', { headers: { 'X-LT-Client': PROTOCOL } });
    if (!r.ok) throw new Error(`读取插件列表失败（${r.status}）`);
    const list = await r.json();
    const old = new Map(extensionList.map(e => [e.name, e]));
    extensionList.splice(0, extensionList.length, ...list.map(m => ({ ...m, loaded: old.get(m.name)?.loaded ?? false, error: old.get(m.name)?.error })));
    listLoaded = true;
    return extensionList;
}

// ---------- 酒馆的全局变量 / 函数 ----------

function defineGetter(name, get, set) {
    try {
        Object.defineProperty(window, name, { configurable: true, get, ...(set ? { set } : {}) });
    } catch { /* 已经被别的东西定义成不可改：不管 */ }
}

/** 兼容模块（public/script.js 等）和插件直接用到的东西都挂在这一个对象上 */
export const stHost = {
    eventSource: null,
    event_types: tavern_events,
    get extension_settings() {
        state.settings.extensions ??= {};
        return state.settings.extensions;
    },
    getContext: () => window.SillyTavern?.getContext?.() ?? buildContext(),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-LT-Client': PROTOCOL, 'X-CSRF-Token': 'lite-tavern' }),
    saveSettings: () => saveSettings({ now: true }),
    saveSettingsDebounced: () => saveSettings(),
    saveChat: () => saveChat({ now: true }),
    saveChatConditional: () => saveChat({ now: true }),
    saveChatDebounced: () => saveChat(),
    saveMetadata: () => saveChat({ now: true }),
    saveMetadataDebounced: () => saveChat(),
    get chat() { return state.chat?.messages ?? []; },
    get chat_metadata() { return state.chat?.header?.chat_metadata ?? {}; },
    get world_names() { return state.worldList.map(w => w.name ?? w); },
    get selected_world_info() { return [...(state.settings.worldInfo?.globalSelect ?? [])]; },
    /** 酒馆 world-info.js 的 loadWorldInfo：返回 {entries: {uid: 条目}}（酒馆格式） */
    async loadWorldInfo(name) {
        if (!name) return null;
        const w = await loadWorld(String(name), { force: true });
        return w ? JSON.parse(JSON.stringify(w)) : null;
    },
    async saveWorldInfo(name, data) {
        if (!name || !data) return;
        state.worlds[name] = data;
        saveWorld(name);
        if (!state.worldList.some(w => (w.name ?? w) === name)) await refreshLists().catch(() => {});
    },
};

/** 酒馆的 eventSource 还有 removeListener / emitAndWait 等写法，包一层 */
function wrapEventSource() {
    return {
        on: (t, fn) => eventSource.on(t, fn),
        once: (t, fn) => eventSource.once(t, fn),
        makeFirst: (t, fn) => eventSource.makeFirst(t, fn),
        makeLast: (t, fn) => eventSource.makeLast(t, fn),
        off: (t, fn) => eventSource.off(t, fn),
        removeListener: (t, fn) => eventSource.off(t, fn),
        emit: (t, ...a) => eventSource.emit(t, ...a),
        emitAndWait: (t, ...a) => eventSource.emit(t, ...a),
        listenerCount: (t) => eventSource.count(t),
    };
}

let installed = false;
export function installStGlobals() {
    if (installed) return;
    installed = true;
    stHost.eventSource = wrapEventSource();
    window.eventSource ??= stHost.eventSource;
    window.event_types ??= tavern_events;
    window.getRequestHeaders = stHost.getRequestHeaders;
    window.saveSettingsDebounced ??= stHost.saveSettingsDebounced;
    window.saveChat ??= stHost.saveChat;
    window.saveChatConditional ??= stHost.saveChatConditional;
    window.saveMetadataDebounced ??= stHost.saveMetadataDebounced;
    defineGetter('chat', () => stHost.chat);
    defineGetter('chat_metadata', () => stHost.chat_metadata);
    defineGetter('this_chid', () => (state.char ? 0 : undefined));
    defineGetter('characters', () => buildContext().characters);
    defineGetter('name1', () => getSession()?.names.user ?? '');
    defineGetter('name2', () => getSession()?.names.char ?? state.char?.card?.data?.name ?? '');
    defineGetter('world_names', () => stHost.world_names);
    defineGetter('is_send_press', () => !!state.generating);
    defineGetter('isGenerating', () => !!state.generating);
    window.SillyTavernLite = stHost;
}

// ---------- 生成拦截器（manifest.generate_interceptor） ----------

/**
 * 发请求前依次调用已加载插件的生成拦截器，和酒馆一样把“要发给 AI 的聊天记录”（隐藏楼已去掉）交给它们改。
 * 拦截器可以替换、插入、删除元素；返回改过的数组，没人改就返回 null。
 */
export async function runGenerateInterceptors(messages, type) {
    const fns = extensionList.filter(e => e.loaded && e.generate_interceptor && typeof globalThis[e.generate_interceptor] === 'function');
    if (!fns.length) return null;
    const coreChat = messages.filter(m => !m.is_system);
    const before = coreChat.slice();
    let aborted = false;
    const abort = () => { aborted = true; };
    const contextSize = Number(state.preset?.data?.openai_max_context ?? 0);
    for (const e of fns) {
        try {
            await globalThis[e.generate_interceptor](coreChat, contextSize, abort, type);
        } catch (err) {
            console.error(`[插件 ${e.name}] 生成拦截器出错`, err);
        }
        if (aborted) break;
    }
    if (aborted) return { aborted: true, chat: coreChat };
    const changed = coreChat.length !== before.length || coreChat.some((m, i) => m !== before[i]);
    return changed ? { aborted: false, chat: coreChat } : null;
}

// ---------- 加载 ----------

function loadCss(url) {
    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.dataset.ltExtension = '1';
        link.onload = () => resolve(true);
        link.onerror = () => resolve(false);
        document.head.append(link);
    });
}

/** 启动时调用：加载所有开着的插件。不挡启动（插件可能有几兆脚本） */
export async function loadEnabledExtensions() {
    installStGlobals();
    try {
        if (!listLoaded) await fetchExtensionList();
    } catch (e) {
        console.warn(e);
        return;
    }
    const todo = extensionList.filter(e => isExtensionEnabled(e.name) && !e.loaded && e.js);
    // 酒馆页面自带 Font Awesome 6，插件的图标都靠它；轻酒馆只在有插件要加载时才引入（本地一份，不走外网）
    if (todo.length && !document.querySelector('link[data-lt-fontawesome]')) {
        await Promise.all(['fontawesome', 'solid', 'regular', 'brands'].map(n => loadCss(`/vendor/fontawesome/css/${n}.min.css`).then(() => {
            document.querySelector(`link[href="/vendor/fontawesome/css/${n}.min.css"]`)?.setAttribute('data-lt-fontawesome', '1');
        })));
    }
    for (const e of todo) {
        const base = `${EXT_BASE}${encodeURIComponent(e.name)}/`;
        try {
            if (e.css) await loadCss(base + e.css);
            await import(base + e.js);
            e.loaded = true;
            e.error = undefined;
            console.info(`[轻酒馆] 插件已加载：${e.display_name} ${e.version}`);
        } catch (err) {
            e.error = err?.message || String(err);
            console.error(`[轻酒馆] 插件加载失败：${e.name}`, err);
            toast(`插件「${e.display_name}」加载失败：${e.error}`, 'error');
        }
    }
    if (todo.length) {
        await eventSource.emit(tavern_events.EXTENSIONS_FIRST_LOAD);
    }
}
