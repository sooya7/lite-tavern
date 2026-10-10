// 启动：读设置 → 绑界面 → 恢复上次的聊天；前端卡的写接口、斜杠命令子集也在这里接上
import { state, withDefaults, refreshLists, ensurePreset, eventSource, event_types, saveSettings } from './state.js';
import { api } from './api.js';
import { bindUI, selectCharacter, openChat, newChat, getSession, refresh } from './controller.js';
import { bindGenerateUI, generateQuiet, scriptGenerate, stopGeneration } from './generate.js';
import { createChatMessages, setChatMessages, deleteChatMessages, triggerSlash, onVariablesChanged } from './chatops.js';
import { initScripts, syncScripts, renderScriptButtons } from './ui/scripts.js';
import { renderChat, appendMessage, renderMessage, updateStreaming, removeMessage, setGenerating, setStatus, setComposerText, renderComposer, renderTopbar, initScrollTracking } from './ui/chat.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderPanels, rerenderIfActive, focusPanelSearch } from './ui/panels/index.js';
import { applyAppearance } from './ui/panels/settings.js';
import { setFrontendHandlers, refreshSnapshots, broadcastEvent } from './ui/frontend.js';
import { importFiles } from './ui/importers.js';
import { h, toast, modal } from './ui/dom.js';
import { createUserMessage } from './core/chat.js';

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
    setFrontendHandlers({ createChatMessages, setChatMessages, deleteChatMessages, triggerSlash, generateQuiet, scriptGenerate, onVariablesChanged });
    // 酒馆助手脚本：装页面级接口（window.TavernHelper / SillyTavern / Mvu），之后跟着角色、预设的切换起停脚本
    initScripts({ bindGenerate: bindGenerateUI });

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
        // Ctrl/⌘+K：打开设置并把光标放进“搜设置和功能”
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !document.querySelector('.modal-backdrop')) {
            e.preventDefault();
            if (app.classList.contains('right-closed')) setDrawer('right', true);
            focusPanelSearch();
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (state.generating) { e.preventDefault(); e.returnValue = ''; }
    });
    // 切走页面时把没保存的写掉
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') import('./state.js').then(m => m.flushPending()); });

    await eventSource.emit(event_types.APP_READY);
    renderScriptButtons();
    await syncScripts();
}

boot().catch((e) => {
    console.error(e);
    toast(`启动失败：${e.message}`, 'error');
});

export { createUserMessage };
