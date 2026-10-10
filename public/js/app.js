// 启动：读设置 → 绑界面 → 恢复上次的聊天；前端卡的写接口、斜杠命令子集也在这里接上
import { state, withDefaults, refreshLists, ensurePreset, eventSource, event_types, saveSettings, saveChat, activePersona } from './state.js';
import { api } from './api.js';
import { bindUI, selectCharacter, openChat, newChat, getSession, refresh, addUserMessage, addNarratorMessage, toggleHidden } from './controller.js';
import { bindGenerateUI, generate, generateQuiet, stopGeneration } from './generate.js';
import { renderChat, appendMessage, renderMessage, updateStreaming, removeMessage, setGenerating, setStatus, setComposerText, renderComposer, renderTopbar, initScrollTracking } from './ui/chat.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderPanels, rerenderIfActive } from './ui/panels/index.js';
import { applyAppearance } from './ui/panels/settings.js';
import { setFrontendHandlers, refreshSnapshots, broadcastEvent } from './ui/frontend.js';
import { importFiles } from './ui/importers.js';
import { h, toast, modal } from './ui/dom.js';
import { createUserMessage, messageText } from './core/chat.js';
import { getPath, setPath, humanizedDate } from './core/util.js';

const app = document.getElementById('app');
const scrim = document.getElementById('scrim');
const narrowLeft = () => matchMedia('(max-width: 760px)').matches;
const narrowRight = () => matchMedia('(max-width: 1100px)').matches;

// ---------- 抽屉 ----------
function setDrawer(side, open) {
    const cls = side === 'left' ? 'left-closed' : 'right-closed';
    app.classList.toggle(cls, !open);
    const overlay = side === 'left' ? narrowLeft() : narrowRight();
    if (!overlay) {
        state.settings.ui[side === 'left' ? 'leftOpen' : 'rightOpen'] = open;
        saveSettings();
    }
    updateScrim();
    if (side === 'right' && open) renderPanels();
    renderTopbar();
}

function updateScrim() {
    const leftOverlayOpen = narrowLeft() && !app.classList.contains('left-closed');
    const rightOverlayOpen = narrowRight() && !app.classList.contains('right-closed');
    scrim.hidden = !(leftOverlayOpen || rightOverlayOpen);
}

function initDrawers() {
    const ui = state.settings.ui;
    app.classList.toggle('left-closed', narrowLeft() ? true : ui.leftOpen === false);
    app.classList.toggle('right-closed', narrowRight() ? true : ui.rightOpen === false);
    updateScrim();
    scrim.addEventListener('click', () => {
        if (narrowLeft()) app.classList.add('left-closed');
        if (narrowRight()) app.classList.add('right-closed');
        updateScrim();
        renderTopbar();
    });
    window.addEventListener('lt:toggle-left', (e) => setDrawer('left', typeof e.detail === 'boolean' ? e.detail : app.classList.contains('left-closed')));
    window.addEventListener('lt:toggle-right', (e) => setDrawer('right', typeof e.detail === 'boolean' ? e.detail : app.classList.contains('right-closed')));
    window.addEventListener('lt:open-panel', (e) => {
        state.settings.ui.rightTab = e.detail;
        saveSettings();
        if (narrowLeft()) app.classList.add('left-closed');
        setDrawer('right', true);
    });
    let lastNarrow = [narrowLeft(), narrowRight()];
    window.addEventListener('resize', () => {
        const now = [narrowLeft(), narrowRight()];
        if (now[0] !== lastNarrow[0] || now[1] !== lastNarrow[1]) {
            lastNarrow = now;
            app.classList.toggle('left-closed', now[0] ? true : state.settings.ui.leftOpen === false);
            app.classList.toggle('right-closed', now[1] ? true : state.settings.ui.rightOpen === false);
            updateScrim();
            renderSidebar();
            renderPanels();
            renderTopbar();
        }
    });
}

// ---------- 拖放导入 ----------
function initDrop() {
    let depth = 0;
    const hint = h('div', { class: 'drop-hint', hidden: true }, '松开导入：角色卡 / 预设 / 世界书 / 正则 / 聊天记录');
    document.body.append(hint);
    window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { depth++; hint.hidden = false; } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
    window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
        depth = 0;
        hint.hidden = true;
        const files = [...(e.dataTransfer?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        await importFiles(files);
    });
}

// ---------- 前端卡 / 斜杠命令 ----------
function roleToFields(role) {
    return { is_user: role === 'user', is_system: role === 'system' };
}

async function createChatMessages(msgs, opt = {}) {
    if (!state.chat) throw new Error('没有打开的聊天');
    const session = getSession();
    const chat = state.chat.messages;
    let at = opt.insert_at === undefined || opt.insert_at === 'end' ? chat.length : Number(opt.insert_at);
    if (at < 0) at = chat.length + at + 1;
    const created = (Array.isArray(msgs) ? msgs : [msgs]).map(m => {
        const role = m.role ?? 'assistant';
        const name = m.name ?? (role === 'user' ? session.names.user : role === 'system' ? 'System' : session.names.char);
        const msg = { name, ...roleToFields(role), send_date: humanizedDate(), mes: String(m.message ?? ''), extra: {} };
        if (role === 'assistant') { msg.swipes = [msg.mes]; msg.swipe_id = 0; msg.swipe_info = [{ send_date: msg.send_date, extra: {} }]; }
        if (m.is_hidden) msg.is_system = true;
        if (m.data) msg.variables = [m.data];
        return msg;
    });
    chat.splice(at, 0, ...created);
    session.vars.invalidate();
    saveChat();
    if (opt.refresh !== 'none') renderChat();
    await eventSource.emit(event_types.MESSAGE_UPDATED, at);
    refreshSnapshots();
    return null;
}

async function setChatMessages(list, opt = {}) {
    const chat = state.chat?.messages;
    if (!chat) throw new Error('没有打开的聊天');
    const touched = [];
    for (const m of (Array.isArray(list) ? list : [list])) {
        const id = Number(m.message_id);
        const msg = chat[id];
        if (!msg) continue;
        if (m.message !== undefined) {
            msg.mes = String(m.message);
            if (Array.isArray(msg.swipes)) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
        }
        if (m.name !== undefined) msg.name = m.name;
        if (m.role !== undefined) Object.assign(msg, roleToFields(m.role));
        if (m.is_hidden !== undefined) msg.is_system = !!m.is_hidden;
        if (m.data !== undefined) {
            if (!Array.isArray(msg.variables)) msg.variables = [];
            msg.variables[msg.swipe_id ?? 0] = m.data;
        }
        touched.push(id);
    }
    getSession()?.vars.invalidate();
    saveChat();
    if (opt.refresh === 'all') renderChat();
    else if (opt.refresh !== 'none') for (const id of touched) renderMessage(id);
    for (const id of touched) await eventSource.emit(event_types.MESSAGE_UPDATED, id);
    refreshSnapshots();
    return null;
}

async function deleteChatMessages(ids) {
    const chat = state.chat?.messages;
    if (!chat) throw new Error('没有打开的聊天');
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))].filter(i => i >= 0 && i < chat.length).sort((a, b) => b - a);
    for (const i of list) chat.splice(i, 1);
    getSession()?.vars.invalidate();
    saveChat();
    renderChat();
    await eventSource.emit(event_types.MESSAGE_DELETED, list[list.length - 1] ?? 0);
    refreshSnapshots();
    return null;
}

/** 按未转义的 | 拆管道 */
function splitPipes(cmd) {
    const out = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (c === String.fromCharCode(92) && cmd[i + 1] === '|') { cur += '|'; i++; continue; }
        if (quote) { if (c === quote) quote = ''; cur += c; continue; }
        if (c === '|' && /\s*\/\w/.test(cmd.slice(i + 1))) { out.push(cur); cur = ''; continue; }
        cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean);
}

/** 解析 /cmd key=value key="v v" 剩余文本 */
function parseCommand(seg) {
    const m = seg.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return null;
    const name = m[1].toLowerCase();
    let rest = m[2];
    const args = {};
    for (;;) {
        const a = rest.match(/^([A-Za-z_][\w-]*)=("([^"]*)"|'([^']*)'|(\S*))\s*/);
        if (!a) break;
        args[a[1]] = a[3] ?? a[4] ?? a[5] ?? '';
        rest = rest.slice(a[0].length);
    }
    return { name, args, text: rest.trim() };
}

function rangeOf(text) {
    const chat = state.chat.messages;
    const m = String(text).trim().match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
    if (!m) return [];
    let a = Number(m[1]), b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 0) a += chat.length;
    if (b < 0) b += chat.length;
    const out = [];
    for (let i = Math.max(0, Math.min(a, b)); i <= Math.min(chat.length - 1, Math.max(a, b)); i++) out.push(i);
    return out;
}

async function triggerSlash(command) {
    if (!state.chat) throw new Error('没有打开的聊天');
    let pipe = '';
    for (const seg of splitPipes(String(command))) {
        const c = parseCommand(seg);
        if (!c) continue;
        const session = getSession();
        const text = (c.text || pipe).replace(/\{\{pipe\}\}/g, pipe);
        switch (c.name) {
            case 'send': await addUserMessage(text); pipe = ''; break;
            case 'sendas': {
                const msg = { name: c.args.name || session.names.char, is_user: false, is_system: false, send_date: humanizedDate(), mes: session.substitute(text), extra: {} };
                msg.swipes = [msg.mes]; msg.swipe_id = 0; msg.swipe_info = [{ send_date: msg.send_date, extra: {} }];
                state.chat.messages.push(msg);
                appendMessage(state.chat.messages.length - 1);
                saveChat();
                pipe = '';
                break;
            }
            case 'sys': case 'narrate': await addNarratorMessage(session.substitute(text)); pipe = ''; break;
            case 'comment': {
                state.chat.messages.push({ name: '注释', is_user: false, is_system: true, send_date: humanizedDate(), mes: text, extra: { type: 'comment' } });
                appendMessage(state.chat.messages.length - 1);
                saveChat();
                pipe = '';
                break;
            }
            case 'trigger': {
                const p = generate('normal');
                if (c.args.await === 'true') await p;
                pipe = '';
                break;
            }
            case 'continue': await generate('continue'); break;
            case 'regenerate': case 'regen': await generate('regenerate'); break;
            case 'swipe': await generate('swipe'); break;
            case 'gen': case 'genraw': pipe = (await generateQuiet({ user_input: text })) ?? ''; break;
            case 'echo': toast(text, c.args.severity ?? 'info'); pipe = text; break;
            case 'setvar': case 'setglobalvar': {
                const key = c.args.key ?? c.args.name;
                const scope = c.name === 'setglobalvar' ? session.vars.global() : session.vars.local();
                setPath(scope, key, text);
                if (c.name === 'setglobalvar') saveSettings(); else saveChat();
                session.vars.invalidate();
                pipe = text;
                break;
            }
            case 'getvar': case 'getglobalvar': {
                const key = c.args.key ?? c.args.name ?? text;
                const v = getPath(c.name === 'getglobalvar' ? session.vars.global() : session.vars.local(), key);
                pipe = v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                break;
            }
            case 'addvar': case 'incvar': case 'decvar': {
                const key = c.args.key ?? c.args.name ?? text;
                const scope = session.vars.local();
                const cur = Number(getPath(scope, key) ?? 0);
                const delta = c.name === 'incvar' ? 1 : c.name === 'decvar' ? -1 : Number(text) || 0;
                setPath(scope, key, cur + delta);
                saveChat();
                session.vars.invalidate();
                pipe = String(cur + delta);
                break;
            }
            case 'hide': case 'unhide': {
                for (const i of rangeOf(text)) {
                    const m = state.chat.messages[i];
                    if (!!m.is_system !== (c.name === 'hide')) toggleHidden(i);
                }
                pipe = '';
                break;
            }
            case 'cut': case 'del': {
                const ids = c.name === 'del' ? rangeOf(`-${Number(text) || 1}--1`) : rangeOf(text);
                await deleteChatMessages(ids);
                pipe = '';
                break;
            }
            case 'messages': {
                pipe = rangeOf(text || `0-${state.chat.messages.length - 1}`).map(i => `${state.chat.messages[i].name}: ${messageText(state.chat.messages[i])}`).join('\n\n');
                break;
            }
            case 'newchat': await newChat(); break;
            default:
                toast(`前端调用了暂不支持的命令 /${c.name}`, 'warning');
                console.warn('[斜杠命令] 不支持', seg);
        }
    }
    refreshSnapshots();
    return pipe;
}

async function onVariablesChanged(type) {
    if (type === 'global') saveSettings(); else saveChat();
    await eventSource.emit(event_types.VARIABLES_UPDATED, type);
    refreshSnapshots();
    rerenderIfActive('vars');
}

// ---------- 给 EJS 模板 / 插件用的 SillyTavern.getContext() 精简版 ----------
function installContextShim() {
    const ctx = () => {
        const s = getSession();
        return {
            chat: state.chat?.messages ?? [],
            chatId: state.chat?.name ?? '',
            chatMetadata: state.chat?.header?.chat_metadata ?? {},
            characterId: state.char?.id,
            characters: state.char ? [{ ...state.char.card.data, data: state.char.card.data, avatar: state.char.file }] : [],
            name1: s?.names.user ?? activePersona().name,
            name2: s?.names.char ?? '',
            eventSource,
            eventTypes: event_types,
            event_types,
            substituteParams: (t) => s?.substitute(t) ?? t,
            saveChat: () => saveChat({ now: true }),
            generateQuietPrompt: (p) => generateQuiet({ user_input: typeof p === 'object' ? p.quietPrompt : p }),
            executeSlashCommands: (cmd) => triggerSlash(cmd).then(pipe => ({ pipe })),
            extensionSettings: state.settings.extensions,
            variables: {
                local: { get: (k) => getPath(s?.vars.local() ?? {}, k), set: (k, v) => { setPath(s.vars.local(), k, v); saveChat(); } },
                global: { get: (k) => getPath(s?.vars.global() ?? {}, k), set: (k, v) => { setPath(s.vars.global(), k, v); saveSettings(); } },
            },
        };
    };
    window.SillyTavern = { getContext: ctx };
}

// ---------- 登录 ----------
function loginDialog() {
    return new Promise((resolve) => {
        const input = h('input', { class: 'input', type: 'password', placeholder: '启动时设置的密码', autocomplete: 'current-password' });
        const err = h('div', { class: 'hint', style: { color: 'var(--danger)' } });
        const submit = async () => {
            try {
                await api.login(input.value);
                m.close(true);
                resolve(true);
            } catch (e) {
                err.textContent = e.message;
            }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        const m = modal({ title: '需要密码', body: h('div', {}, input, err), actions: [{ label: '进入', primary: true, onClick: async () => { await submit(); return false; } }] });
    });
}

// ---------- 启动 ----------
async function boot() {
    let ping;
    try {
        ping = await api.ping();
    } catch (e) {
        document.getElementById('chat').append(h('div', { class: 'empty' }, `连不上本地服务：${e.message}`));
        return;
    }
    state.server = ping;
    let raw;
    for (;;) {
        try { raw = await api.getSettings(); break; } catch (e) {
            if (e.message === '需要登录') { await loginDialog(); continue; }
            throw e;
        }
    }
    state.settings = withDefaults(raw);
    applyAppearance();
    window.addEventListener('lt:need-login', () => loginDialog().then(() => location.reload()));

    bindUI({ sidebar: renderSidebar, chat: renderChat, topbar: renderTopbar, panels: renderPanels, appendMessage, renderMessage, renderChat });
    bindGenerateUI({
        openPanel: (tab) => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: tab })),
        renderChat, appendMessage, renderMessage, updateStreaming, removeMessage, setGenerating, setStatus, setComposerText,
    });
    setFrontendHandlers({ createChatMessages, setChatMessages, deleteChatMessages, triggerSlash, generateQuiet, onVariablesChanged });
    installContextShim();

    initDrawers();
    initDrop();
    renderComposer();
    initScrollTracking();

    try { state.secrets = await api.getSecrets(); } catch { state.secrets = {}; }
    await refreshLists();
    await ensurePreset();
    if (!state.settings.personas.length) {
        state.settings.personas.push({ id: 'p_default', name: 'User', description: '', position: 0, depth: 2, role: 0, lorebook: '', avatar: '' });
        state.settings.activePersona = 'p_default';
        saveSettings();
    }

    renderSidebar();
    renderTopbar();
    renderPanels();
    renderChat();

    const last = state.settings.lastChat;
    if (last && state.characters.some(c => c.file === last.file)) {
        try {
            await selectCharacter(last.file, { openLatest: false });
            if (state.chatList.some(c => c.name === last.chat)) await openChat(last.chat);
            else if (state.chatList.length) await openChat(state.chatList[0].name);
            else await newChat();
        } catch (e) {
            console.error(e);
            toast(`恢复上次的聊天失败：${e.message}`, 'error');
        }
    }
    refresh();

    // 界面跟随事件更新
    for (const ev of [event_types.MESSAGE_SENT, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_DELETED, event_types.CHAT_CHANGED]) {
        eventSource.on(ev, () => renderTopbar());
    }
    // 左栏当前聊天的条数和最后一句跟着变
    for (const ev of [event_types.MESSAGE_RECEIVED, event_types.MESSAGE_DELETED]) eventSource.on(ev, () => renderSidebar());
    eventSource.on(event_types.MESSAGE_RECEIVED, () => rerenderIfActive('vars'));
    eventSource.on(event_types.MESSAGE_SWIPED, () => rerenderIfActive('vars'));
    eventSource.on(event_types.MESSAGE_EDITED, () => { rerenderIfActive('vars'); refreshSnapshots(); });
    eventSource.on(event_types.MESSAGE_DELETED, () => { rerenderIfActive('vars'); refreshSnapshots(); });
    eventSource.on(event_types.CHAT_CHANGED, () => broadcastEvent('chat_id_changed', state.chat?.name));

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.generating && !document.querySelector('.modal-backdrop')) stopGeneration();
    });
    window.addEventListener('beforeunload', (e) => {
        if (state.generating) { e.preventDefault(); e.returnValue = ''; }
    });
    // 切走页面时把没保存的写掉
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') import('./state.js').then(m => m.flushPending()); });

    await eventSource.emit(event_types.APP_READY);
}

boot().catch((e) => {
    console.error(e);
    toast(`启动失败：${e.message}`, 'error');
});

export { createUserMessage };
