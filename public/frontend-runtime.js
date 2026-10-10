// 前端卡 iframe 内运行时：提供酒馆助手（TavernHelper）/ MVU 的常用接口。
// iframe 是沙箱（无同源），读接口用宿主注入的快照，写接口通过 postMessage 交给宿主执行。
(function () {
    'use strict';
    const INIT = window.__LT_INIT || {};
    let snap = INIT.snapshot || {};
    const frameId = INIT.frameId;
    const realParent = window.parent;
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();

    function post(msg) {
        realParent.postMessage({ __lt: true, frameId, ...msg }, '*');
    }

    // 沙箱里 localStorage 不可用：换成宿主代存的一份（同步读，写入转给宿主）
    function makeStorage(initial, persist) {
        const m = new Map(Object.entries(initial || {}));
        const send = (op, key, value) => { if (persist) post({ type: 'storage', op, key, value }); };
        const api = {
            getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
            setItem: (k, v) => { m.set(String(k), String(v)); send('set', String(k), String(v)); },
            removeItem: (k) => { m.delete(String(k)); send('remove', String(k)); },
            clear: () => { m.clear(); send('clear'); },
            key: (i) => [...m.keys()][i] ?? null,
            get length() { return m.size; },
        };
        return new Proxy(api, {
            get: (t, p) => (p in t ? t[p] : (typeof p === 'string' && m.has(p) ? m.get(p) : undefined)),
            set: (t, p, v) => { api.setItem(p, v); return true; },
            deleteProperty: (t, p) => { api.removeItem(p); return true; },
        });
    }
    for (const [name, persist] of [['localStorage', true], ['sessionStorage', false]]) {
        let ok = false;
        try { ok = !!window[name]; } catch (e) { ok = false; }
        if (!ok) {
            try { Object.defineProperty(window, name, { value: makeStorage(persist ? INIT.store : {}, persist), configurable: true }); } catch (e) { /* 改不了就算了 */ }
        }
    }
    let chatInput = String(INIT.input || '');

    function rpc(method, ...args) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            post({ type: 'rpc', id, method, args: JSON.parse(JSON.stringify(args)) });
        });
    }

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || !d.__lt || e.source !== realParent) return;
        if (d.type === 'rpc-result') {
            const p = pending.get(d.id);
            if (!p) return;
            pending.delete(d.id);
            if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
        } else if (d.type === 'input') {
            chatInput = String(d.value ?? '');
        } else if (d.type === 'snapshot') {
            snap = d.snapshot;
        } else if (d.type === 'event') {
            if (d.snapshot) snap = d.snapshot;
            emitLocal(d.name, ...(d.args || []));
        }
    });

    function emitLocal(name, ...args) {
        for (const fn of [...(listeners.get(name) || [])]) {
            try { fn(...args); } catch (err) { console.error('[前端卡] 事件处理出错', name, err); }
        }
    }

    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const getPath = (obj, path, dflt) => {
        if (window._ && window._.get) return window._.get(obj, path, dflt);
        const parts = String(path).replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
        let cur = obj;
        for (const p of parts) { if (cur == null) return dflt; cur = cur[p]; }
        return cur === undefined ? dflt : cur;
    };

    function resolveMessageId(id) {
        if (id === undefined || id === null || id === 'latest' || id === -1) return snap.lastMessageId;
        if (typeof id === 'number' && id < 0) return snap.lastMessageId + 1 + id;
        return Number(id);
    }

    function messageVars(id) {
        const mid = resolveMessageId(id);
        return (snap.messageVars || {})[mid] || {};
    }

    // ---------- 变量 ----------
    function getVariables(opt) {
        const o = opt || {};
        switch (o.type || 'chat') {
            case 'global': return clone(snap.globalVars || {});
            case 'message': return clone(messageVars(o.message_id ?? snap.messageId));
            case 'character': return clone(snap.characterVars || {});
            case 'script': return {};
            default: return clone(snap.chatVars || {});
        }
    }
    function getAllVariables() {
        return clone(snap.allVars || {});
    }
    async function replaceVariables(vars, opt) {
        const o = opt || {};
        await rpc('replaceVariables', vars, { ...o, message_id: o.type === 'message' ? resolveMessageId(o.message_id ?? snap.messageId) : undefined });
    }
    async function insertOrAssignVariables(vars, opt) {
        const cur = getVariables(opt);
        const merged = window._ ? window._.merge(cur, vars) : Object.assign(cur, vars);
        await replaceVariables(merged, opt);
        return merged;
    }
    async function updateVariablesWith(fn, opt) {
        const cur = getVariables(opt);
        const next = (await fn(cur)) || cur;
        await replaceVariables(next, opt);
        return next;
    }
    async function deleteVariable(path, opt) {
        const cur = getVariables(opt);
        if (window._ && window._.unset) window._.unset(cur, path); else delete cur[path];
        await replaceVariables(cur, opt);
        return { variables: cur, delete_occurred: true };
    }

    // ---------- 聊天 ----------
    function parseRange(range) {
        const last = snap.lastMessageId;
        if (range === undefined || range === null) return [0, last];
        if (typeof range === 'number') { const r = range < 0 ? last + 1 + range : range; return [r, r]; }
        const s = String(range).replace(/\{\{lastMessageId\}\}/g, String(last));
        const m = s.match(/^(-?\d+)(?:-(-?\d+))?$/);
        if (!m) return [0, last];
        let a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : a;
        if (a < 0) a = last + 1 + a;
        if (b < 0) b = last + 1 + b;
        return [Math.min(a, b), Math.max(a, b)];
    }
    function getChatMessages(range, opt) {
        const o = opt || {};
        const [a, b] = parseRange(range);
        return (snap.chat || []).filter(m => m.message_id >= a && m.message_id <= b)
            .filter(m => !o.role || o.role === 'all' || m.role === o.role)
            .filter(m => o.hide_state === 'hidden' ? m.is_hidden : o.hide_state === 'unhidden' ? !m.is_hidden : true)
            .map(m => clone(m));
    }
    const createChatMessages = (msgs, opt) => rpc('createChatMessages', msgs, opt || {});
    const setChatMessages = (msgs, opt) => rpc('setChatMessages', msgs, opt || {});
    const deleteChatMessages = (ids, opt) => rpc('deleteChatMessages', ids, opt || {});
    const triggerSlash = (cmd) => rpc('triggerSlash', String(cmd));
    const generate = (cfg) => rpc('generate', cfg || {});
    const generateRaw = (cfg) => rpc('generateRaw', cfg || {});

    // ---------- 事件 ----------
    function eventOn(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return { stop: () => eventRemoveListener(name, fn) };
    }
    function eventOnce(name, fn) {
        const wrap = (...a) => { eventRemoveListener(name, wrap); fn(...a); };
        return eventOn(name, wrap);
    }
    function eventRemoveListener(name, fn) { listeners.get(name)?.delete(fn); }
    function eventClearEvent(name) { listeners.delete(name); }
    function eventEmit(name, ...args) {
        emitLocal(name, ...args);
        post({ type: 'emit', name, args: clone(args) });
    }

    const tavern_events = {
        APP_READY: 'app_ready', MESSAGE_RECEIVED: 'message_received', MESSAGE_SENT: 'message_sent', MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_UPDATED: 'message_updated', CHAT_CHANGED: 'chat_id_changed',
        GENERATION_STARTED: 'generation_started', GENERATION_STOPPED: 'generation_stopped', GENERATION_ENDED: 'generation_ended',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', USER_MESSAGE_RENDERED: 'user_message_rendered', STREAM_TOKEN_RECEIVED: 'stream_token_received',
        WORLDINFO_UPDATED: 'worldinfo_updated', SETTINGS_UPDATED: 'settings_updated',
    };
    const iframe_events = {
        MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
        GENERATION_STARTED: 'js_generation_started', STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
        STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally', GENERATION_ENDED: 'js_generation_ended',
    };

    // ---------- MVU ----------
    const Mvu = {
        events: {
            VARIABLE_INITIALIZED: 'mag_variable_initialized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
            VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended', COMMAND_PARSED: 'mag_command_parsed',
            SINGLE_VARIABLE_UPDATED: 'mag_variable_updated', BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
        },
        getMvuData(opt) {
            const o = opt || {};
            if (o.type === 'chat') return clone(snap.chatVars || {});
            const v = messageVars(o.message_id ?? snap.messageId);
            return clone({ initialized_lorebooks: v.initialized_lorebooks || {}, stat_data: v.stat_data || {}, display_data: v.display_data || {}, delta_data: v.delta_data || {} });
        },
        async replaceMvuData(data, opt) {
            const o = opt || {};
            const mid = resolveMessageId(o.message_id ?? snap.messageId);
            const cur = messageVars(mid);
            await rpc('replaceVariables', { ...cur, ...data }, { type: 'message', message_id: mid });
        },
        getMvuVariable(data, path, opt) {
            const v = getPath(data && data.stat_data ? data.stat_data : data, path, (opt || {}).default_value);
            return Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' ? v[0] : v;
        },
        async setMvuVariable(data, path, value) {
            const target = data && data.stat_data ? data.stat_data : data;
            if (window._ && window._.set) window._.set(target, path, value);
            return true;
        },
        parseMessage: async () => undefined,
        getRecordFromMvuData: (data) => data,
    };

    // ---------- 杂项 ----------
    const toast = (type) => (msg, title) => { post({ type: 'rpc', id: 0, method: 'toast', args: [type, String(title ? `${title}：${msg}` : msg)] }); };
    window.toastr = { info: toast('info'), success: toast('success'), warning: toast('warning'), error: toast('error'), clear() {}, remove() {} };

    function errorCatched(fn) {
        return function (...args) {
            try {
                const r = fn.apply(this, args);
                if (r && typeof r.catch === 'function') return r.catch(err => { console.error(err); window.toastr.error(String(err && err.message || err)); });
                return r;
            } catch (err) {
                console.error(err);
                window.toastr.error(String(err && err.message || err));
            }
        };
    }

    function waitGlobalInitialized(name) {
        return new Promise((resolve) => {
            const check = () => { if (window[name]) resolve(window[name]); else setTimeout(check, 50); };
            check();
        });
    }

    function substitudeMacros(text) {
        return String(text ?? '').replace(/\{\{user\}\}/gi, snap.userName || 'User').replace(/\{\{char\}\}/gi, snap.charName || '');
    }

    const getCurrentMessageId = () => snap.messageId;
    const getLastMessageId = () => snap.lastMessageId;
    const getCharData = () => clone(snap.charData || null);
    const getCharAvatarPath = () => snap.charAvatar || '';
    const getUserAvatarPath = () => snap.userAvatar || '';
    const getIframeName = () => `message-iframe-${snap.messageId}-${frameId}`;
    const getScriptId = () => `lt-frame-${frameId}`;

    const SillyTavern = {
        getContext: () => ({
            name1: snap.userName, name2: snap.charName, chat: clone(snap.chat || []), chatId: snap.chatId,
            characterId: snap.characterId, eventSource: { on: eventOn, once: eventOnce, emit: eventEmit, removeListener: eventRemoveListener },
            eventTypes: tavern_events, event_types: tavern_events,
        }),
        chat: snap.chat,
    };

    const api = {
        getVariables, getAllVariables, replaceVariables, insertOrAssignVariables, insertVariables: insertOrAssignVariables, updateVariablesWith, deleteVariable,
        getChatInput: () => chatInput,
        setChatInput: (text) => { chatInput = String(text ?? ''); return rpc('setChatInput', chatInput); },
        getChatMessages, createChatMessages, setChatMessages, deleteChatMessages, triggerSlash, triggerSlashWithResult: triggerSlash, generate, generateRaw,
        eventOn, eventOnce, eventMakeLast: eventOn, eventMakeFirst: eventOn, eventEmit, eventRemoveListener, eventClearEvent, tavern_events, iframe_events,
        Mvu, errorCatched, waitGlobalInitialized, substitudeMacros, getCurrentMessageId, getLastMessageId, getMessageId: getCurrentMessageId,
        getCharData, getCharAvatarPath, getUserAvatarPath, getIframeName, getScriptId, SillyTavern,
        getTavernHelperVersion: () => '4.0.0', getFrontendVersion: () => '4.0.0',
    };
    // 其余的酒馆助手接口转给宿主页面去做（返回 Promise）。只放参数能跨窗口复制的；要传函数的（xxxWith、registerMacroLike）不在其列
    const PROXIED = ('getModelList getProxyPresetNames playAudio pauseAudio getAudioList replaceAudioList appendAudioList getAudioSettings setAudioSettings getCurrentAudio '
        + 'getWorldbookNames getGlobalWorldbookNames rebindGlobalWorldbooks getCharWorldbookNames rebindCharWorldbooks getChatWorldbookName rebindChatWorldbook '
        + 'getOrCreateChatWorldbook createWorldbook createOrReplaceWorldbook deleteWorldbook getWorldbook replaceWorldbook createWorldbookEntries '
        + 'getLorebookSettings setLorebookSettings getLorebooks deleteLorebook createLorebook getCharLorebooks getCurrentCharPrimaryLorebook setCurrentCharLorebooks '
        + 'getChatLorebook setChatLorebook getOrCreateChatLorebook getLorebookEntries replaceLorebookEntries setLorebookEntries createLorebookEntries deleteLorebookEntries '
        + 'getPersonaNames getPersonaIds getCurrentPersonaName getCurrentPersonaId getPersonaAvatarPath getPersona createPersona createOrReplacePersona deletePersona replacePersona '
        + 'getCharacterNames getCharacterIds getCurrentCharacterName getCurrentCharacterId getCharacter replaceCharacter createCharacter createOrReplaceCharacter deleteCharacter '
        + 'getPresetNames getLoadedPresetName loadPreset getPreset replacePreset setPreset createPreset createOrReplacePreset deletePreset renamePreset '
        + 'getTavernRegexes replaceTavernRegexes isCharacterTavernRegexesEnabled formatAsTavernRegexedString '
        + 'importRawCharacter importRawChat importRawPreset importRawWorldbook importRawTavernRegex '
        + 'isInstalledExtension getExtensionType getExtensionInstallationInfo installExtension uninstallExtension reinstallExtension updateExtension '
        + 'injectPrompts uninjectPrompts getChatHistoryBrief stopGenerationById stopAllGeneration formatAsDisplayedMessage').split(' ');
    function rpcRaw(method, ...args) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            try { post({ type: 'rpc', id, method, args }); } catch (e) { pending.delete(id); reject(e); }
        });
    }
    const RESPONSE_RETURNING = new Set(['importRawCharacter', 'importRawChat', 'importRawWorldbook', 'installExtension', 'uninstallExtension', 'reinstallExtension', 'updateExtension']);
    for (const name of PROXIED) {
        if (api[name]) continue;
        api[name] = async (...args) => {
            const r = await rpcRaw('helper', name, args);
            // 返回 Response 的接口：宿主那边拆成了 {ok, status, body}，这里还原
            if (RESPONSE_RETURNING.has(name) && r && typeof r === 'object' && 'status' in r && 'body' in r) return new Response(r.body, { status: r.status });
            return r;
        };
    }
    if (!api.getWorldbook) api.getWorldbook = (...a) => rpcRaw('helper', 'getWorldbook', a);
    Object.assign(window, api);
    window.TavernHelper = api;

    // 很多卡直接摸 window.parent.document 里的 #send_textarea（酒馆里是同源的）。
    // 这里沙箱跨源摸不到，给一个替身：只认聊天输入框，读写转给宿主
    const noop = () => {};
    const fakeInput = {
        id: 'send_textarea', tagName: 'TEXTAREA', nodeName: 'TEXTAREA', style: {}, classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
        get value() { return chatInput; },
        set value(v) { chatInput = String(v ?? ''); rpc('setChatInput', chatInput).catch(noop); },
        get textContent() { return chatInput; },
        dispatchEvent: () => true, focus: noop, blur: noop, click: noop, select: noop, setSelectionRange: noop,
        addEventListener: noop, removeEventListener: noop, getAttribute: (k) => (k === 'id' ? 'send_textarea' : null), setAttribute: noop,
        scrollIntoView: noop, closest: () => null, matches: (sel) => /send_textarea|textarea/i.test(String(sel)),
    };
    const isInputSel = (sel) => /send_textarea|^\s*textarea\b/i.test(String(sel));
    const fakeDoc = {
        querySelector: (sel) => (isInputSel(sel) ? fakeInput : null),
        querySelectorAll: (sel) => (isInputSel(sel) ? [fakeInput] : []),
        getElementById: (id) => (id === 'send_textarea' ? fakeInput : null),
        getElementsByTagName: (t) => (/^textarea$/i.test(t) ? [fakeInput] : []),
        addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
        createElement: (t) => document.createElement(t),
        get body() { return null; }, get head() { return null; }, get documentElement() { return null; },
    };
    let sameOrigin = false;
    try { sameOrigin = !!realParent.document; } catch (e) { sameOrigin = false; }
    if (!sameOrigin && realParent !== window) {
        const fakeParent = new Proxy({}, {
            get(t, p) {
                if (p === 'document') return fakeDoc;
                if (p === 'postMessage') return (...a) => realParent.postMessage(...a);
                if (p === 'localStorage') return window.localStorage;
                if (p === 'sessionStorage') return window.sessionStorage;
                if (p === 'indexedDB') { try { return window.indexedDB; } catch (e) { return undefined; } }
                if (p === 'parent' || p === 'top') return fakeParent;
                if (p === 'window' || p === 'self') return fakeParent;
                try { return realParent[p]; } catch (e) { return undefined; }
            },
            set() { return true; },
            has(t, p) { return p === 'document' || p === 'postMessage'; },
        });
        try { Object.defineProperty(window, 'parent', { value: fakeParent, configurable: true, writable: true }); } catch (e) { /* 浏览器不让换就算了 */ }
    }

    // ---------- 自动高度 ----------
    let lastH = 0;
    // 量内容实际占的高度：documentElement.scrollHeight 不会小于 iframe 当前高度，用它会只增不减
    function contentHeight() {
        const b = document.body;
        if (!b) return 0;
        let bottom = 0;
        for (const el of b.children) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.position === 'fixed') continue;
            const r = el.getBoundingClientRect();
            bottom = Math.max(bottom, r.bottom + (parseFloat(cs.marginBottom) || 0));
        }
        const bs = getComputedStyle(b);
        bottom += (parseFloat(bs.paddingBottom) || 0) + (parseFloat(bs.borderBottomWidth) || 0) + (parseFloat(bs.marginBottom) || 0) + (window.scrollY || 0);
        // 内容本身比视口高（滚动了）时，以 scrollHeight 为准
        const overflow = b.scrollHeight > window.innerHeight + 1 ? b.scrollHeight : 0;
        return Math.ceil(Math.max(bottom, overflow));
    }
    function report() {
        const hgt = contentHeight();
        if (hgt > 0 && Math.abs(hgt - lastH) > 1) {
            lastH = hgt;
            post({ type: 'height', height: hgt });
        }
    }
    let raf = 0;
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; report(); }); };
    window.addEventListener('load', () => {
        report();
        emitLocal(iframe_events.MESSAGE_IFRAME_RENDER_ENDED, getIframeName());
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(schedule);
            ro.observe(document.documentElement);
            if (document.body) ro.observe(document.body);
        }
        if (document.body) new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        let n = 0;
        const t = setInterval(() => { report(); if (++n > 20) clearInterval(t); }, 250);
    });
    document.addEventListener('DOMContentLoaded', report);
    window.addEventListener('error', (e) => { post({ type: 'error', message: String(e.message || e.error) }); });
})();
