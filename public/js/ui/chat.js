// 聊天区：消息列表、消息操作、输入框、顶栏；没选角色或点了“角色库”时显示首页
import { h, $, clear, icon, iconBtn, toast, confirmDialog, popupMenu, formatTime, modal } from './dom.js';
import { state, eventSource, event_types, saveChat, saveSettings, activePersona, activeConnection } from '../state.js';
import { api } from '../api.js';
import { getSession, editMessage, deleteMessages, toggleHidden, branchChat, newChat, refresh } from '../controller.js';
import { generate, stopGeneration } from '../generate.js';
import { formatMessage, mountFormatted, renderReasoning } from './render.js';
import { mountFrontend, refreshSnapshots } from './frontend.js';
import { messageText, setSwipe, deleteSwipe, ensureSwipes } from '../core/chat.js';
import { parseSendDate } from '../core/util.js';
import { renderHome } from './library.js';
import { charAvatar, letterAvatar } from './avatars.js';
import { chatTitle, startNewChat, goHome, renameChat, exportChat, deleteChat } from './sidebar.js';
import { resolvedTheme, applyAppearance } from './panels/settings.js';

const RENDER_WINDOW = 80;
let renderFrom = 0;
let stickToBottom = true;

const chatEl = () => $('#chat');
const scrollEl = () => $('#chat-scroll');

const DIRECT_URL = /^(\/api\/|data:|https?:|blob:)/;

function avatarFor(m) {
    const fa = typeof m.force_avatar === 'string' ? m.force_avatar : '';
    if (m.is_user) {
        if (fa) {
            if (DIRECT_URL.test(fa)) return fa;
            // 酒馆的写法：User Avatars/xxx.png 或 /thumbnail?type=persona&file=xxx.png
            const fileParam = fa.match(/[?&]file=([^&]+)/);
            let base = fileParam ? fileParam[1] : fa.split('/').pop().split('?')[0];
            try { base = decodeURIComponent(base); } catch { /* 原样 */ }
            const p = state.settings.personas.find(x => x.stAvatar === base);
            if (p?.avatar) return api.personaAvatarUrl(p.avatar);
        }
        const p = activePersona();
        return p.avatar ? api.personaAvatarUrl(p.avatar) : null;
    }
    if (fa && DIRECT_URL.test(fa)) return fa;
    return state.char ? api.avatarUrl(state.char.file, state.char.v) : null;
}

function avatarEl(m) {
    const fa = typeof m.force_avatar === 'string' ? m.force_avatar : '';
    if (!m.is_user && !(fa && DIRECT_URL.test(fa)) && state.char) return charAvatar(state.char.file, 'avatar', { name: m.name });
    const url = avatarFor(m);
    if (url) return h('img', { class: 'avatar', src: url, alt: '', loading: 'lazy' });
    return letterAvatar(m.name, 'avatar');
}

export function renderChat() {
    const el = chatEl();
    if (!el) return;
    clear(el);
    const home = state.view === 'home' || !state.char;
    $('#center')?.classList.toggle('home', home);
    if (home) {
        renderHome(el);
        if (scrollEl()) scrollEl().scrollTop = 0;
        return;
    }
    if (!state.chat) {
        el.append(h('div', { class: 'empty' }, '没有打开的聊天'));
        return;
    }
    const msgs = state.chat.messages;
    renderFrom = Math.max(0, msgs.length - RENDER_WINDOW);
    if (renderFrom > 0) el.append(loadEarlierBtn(`加载更早的 ${Math.min(RENDER_WINDOW, renderFrom)} 条`));
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    if (!msgs.length) el.append(h('div', { class: 'empty' }, '这张卡没有开场白，直接说点什么吧'));
    scrollToBottom(true);
}

function loadEarlierBtn(label) {
    return h('div', { class: 'load-earlier' },
        h('button', { class: 'btn small', onclick: () => { renderFrom = Math.max(0, renderFrom - RENDER_WINDOW); rerenderFrom(); } }, label));
}

function rerenderFrom() {
    const el = chatEl();
    const prevH = scrollEl().scrollHeight;
    const keep = scrollEl().scrollTop;
    clear(el);
    const msgs = state.chat.messages;
    if (renderFrom > 0) el.append(loadEarlierBtn('加载更早的消息'));
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    scrollEl().scrollTop = keep + (scrollEl().scrollHeight - prevH);
}

function buildMessage(i, { streaming = false } = {}) {
    const m = state.chat.messages[i];
    const isLast = i === state.chat.messages.length - 1;
    const user = !!m.is_user;
    const el = h('div', {
        class: `mes ${user ? 'user' : 'char'} ${m.is_system ? 'hidden-msg' : ''} ${streaming ? 'streaming' : ''} ${isLast ? 'last' : ''}`,
        mesid: String(i),
        is_user: String(user),
        is_system: String(!!m.is_system),
        ch_name: m.name ?? '',
    });
    const time = parseSendDate(m.send_date);
    const timeText = time ? formatTime(time) : '';
    const tools = h('div', { class: 'mes_tools' },
        iconBtn('copy', '复制', () => copyMessage(i)),
        iconBtn('edit', '编辑', () => startEdit(i)),
        !user && isLast && !m.extra?.type ? iconBtn('refresh', '重新生成', () => generate('regenerate')) : null,
        iconBtn('more', '更多', (e) => messageMenu(e.currentTarget, i)),
    );
    const textEl = h('div', { class: 'mes_text' });
    const hiddenTag = m.is_system ? h('span', { class: 'tag' }, '已隐藏') : null;
    const idTag = state.settings.ui.showMesId ? h('span', { class: 'mes_id' }, `#${i}`) : null;
    const foot = h('div', { class: 'mes_foot' });
    if (user) {
        foot.append(...[h('span', { class: 'mes_meta' }, [m.name, timeText].filter(Boolean).join(' · ')), idTag, hiddenTag, tools].filter(Boolean));
        el.append(h('div', { class: 'mes_block' }, h('div', { class: 'mes_bubble' }, textEl), foot));
    } else {
        const swipeCount = Array.isArray(m.swipes) && m.swipes.length ? m.swipes.length : 1;
        if (!m.extra?.type && (isLast || swipeCount > 1)) {
            foot.append(h('div', { class: 'swipes' },
                iconBtn('left', '上一个', () => swipe(i, -1)),
                h('span', {}, `${Math.min(m.swipe_id ?? 0, swipeCount - 1) + 1}/${swipeCount}`),
                iconBtn('right', isLast ? '下一个 / 重新生成' : '下一个', () => swipe(i, 1)),
            ));
        }
        foot.append(tools);
        el.append(
            h('div', { class: 'mes_head' },
                avatarEl(m),
                h('span', { class: 'mes_name' }, m.name ?? ''),
                h('span', { class: 'mes_time' }, timeText),
                idTag, hiddenTag),
            h('div', { class: 'mes_block' }, h('div', { class: 'reasoning-slot' }), textEl, foot),
        );
    }
    fillMessage(el, i, { streaming });
    return el;
}

/** 填充消息正文（异步：显示正则 + EJS 渲染） */
async function fillMessage(el, i, { streaming = false } = {}) {
    const m = state.chat.messages[i];
    const session = getSession();
    const textEl = el.querySelector('.mes_text');
    const slot = el.querySelector('.reasoning-slot');
    if (!session) {
        textEl.textContent = messageText(m);
        return;
    }
    const token = (el._renderToken = (el._renderToken ?? 0) + 1);
    let text;
    if (streaming) {
        text = messageText(m);
    } else {
        text = await session.displayText(i);
    }
    if (el._renderToken !== token) return;
    const res = formatMessage(text, { charName: session.names.char, isUser: m.is_user });
    const allowFrontend = state.settings.ui.renderFrontend !== false && !streaming;
    mountFormatted(textEl, res, allowFrontend ? (html, wrap) => mountFrontend(html, wrap, i) : null);
    if (slot) clear(slot);
    if (slot && state.settings.ui.showReasoning && m.extra?.reasoning) {
        let rsn = m.extra.reasoning;
        if (!streaming) rsn = await session.displayText(i, { reasoning: true });
        if (el._renderToken !== token) return;
        const r = renderReasoning(rsn, { open: streaming && !m.mes, streaming: streaming && !m.mes, duration: m.extra.reasoning_duration });
        if (r) slot.append(r);
    }
    if (!streaming) {
        await eventSource.emit(m.is_user ? event_types.USER_MESSAGE_RENDERED : event_types.CHARACTER_MESSAGE_RENDERED, i);
    }
    if (stickToBottom) scrollToBottom();
}

export function renderMessage(i, opt = {}) {
    const el = chatEl()?.querySelector(`.mes[mesid="${i}"]`);
    if (!el) {
        if (i >= renderFrom) renderChat();
        return;
    }
    el.replaceWith(buildMessage(i, opt));
    // 上一条消息的 swipe 箭头显示与“是否最后一条”有关
    if (i > 0) {
        const prev = chatEl().querySelector(`.mes[mesid="${i - 1}"]`);
        if (prev && !state.chat.messages[i - 1]?.is_user) prev.replaceWith(buildMessage(i - 1));
    }
}

export function appendMessage(i, opt = {}) {
    const el = chatEl();
    el.querySelector('.empty')?.remove();
    // 之前的最后一条（可能带重刷箭头）要刷新
    const prevIdx = i - 1;
    const prev = el.querySelector(`.mes[mesid="${prevIdx}"]`);
    if (prev) prev.replaceWith(buildMessage(prevIdx));
    el.append(buildMessage(i, opt));
    scrollToBottom(true);
}

export function removeMessage(i) {
    chatEl()?.querySelector(`.mes[mesid="${i}"]`)?.remove();
    const prev = chatEl()?.querySelector(`.mes[mesid="${i - 1}"]`);
    if (prev) prev.replaceWith(buildMessage(i - 1));
}

export function updateStreaming(i) {
    const el = chatEl()?.querySelector(`.mes[mesid="${i}"]`);
    if (!el) return appendMessage(i, { streaming: true });
    el.classList.add('streaming');
    fillMessage(el, i, { streaming: true });
}

function scrollToBottom(force = false) {
    const s = scrollEl();
    if (!s) return;
    if (force || stickToBottom) s.scrollTop = s.scrollHeight;
}

export function initScrollTracking() {
    const s = scrollEl();
    const btn = h('button', { class: 'scroll-bottom', title: '到底部', hidden: true, onclick: () => { stickToBottom = true; scrollToBottom(true); } }, icon('chevronDown'));
    $('#center').append(btn);
    s.addEventListener('scroll', () => {
        const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
        stickToBottom = atBottom;
        btn.hidden = atBottom;
    }, { passive: true });
}

async function swipe(i, dir) {
    const m = state.chat.messages[i];
    if (state.generating) return;
    ensureSwipes(m);
    const isLast = i === state.chat.messages.length - 1;
    const next = (m.swipe_id ?? 0) + dir;
    if (next < 0) return;
    if (next >= m.swipes.length) {
        if (!isLast) return;
        await generate('swipe');
        await eventSource.emit(event_types.MESSAGE_SWIPED, i);
        return;
    }
    setSwipe(m, next);
    getSession()?.vars.invalidate();
    renderMessage(i);
    refreshSnapshots();
    await eventSource.emit(event_types.MESSAGE_SWIPED, i);
    saveChat();
}

function copyMessage(i) {
    navigator.clipboard?.writeText(messageText(state.chat.messages[i])).then(() => toast('已复制', 'success'), () => toast('复制失败', 'error'));
}

function startEdit(i) {
    const el = chatEl().querySelector(`.mes[mesid="${i}"]`);
    if (!el || el.classList.contains('editing')) return;
    const m = state.chat.messages[i];
    el.classList.add('editing');
    const textEl = el.querySelector('.mes_text');
    const ta = h('textarea', { class: 'textarea', value: messageText(m) });
    const box = h('div', { class: 'mes-edit' }, ta, h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => renderMessage(i) }, '取消'),
        h('button', { class: 'btn small primary', onclick: () => editMessage(i, ta.value) }, '保存'),
    ));
    textEl.replaceWith(box);
    const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 4, window.innerHeight * 0.7)}px`; };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') renderMessage(i);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) editMessage(i, ta.value);
    });
    setTimeout(() => { fit(); ta.focus(); }, 0);
}

function messageMenu(anchor, i) {
    const m = state.chat.messages[i];
    const isLast = i === state.chat.messages.length - 1;
    popupMenu(anchor, [
        isLast && !m.is_user ? { label: '重新生成', icon: 'refresh', onClick: () => generate('regenerate') } : null,
        isLast && !m.is_user ? { label: '继续写', icon: 'continue', onClick: () => generate('continue') } : null,
        { label: m.is_system ? '取消隐藏（重新发给 AI）' : '隐藏（不发给 AI）', icon: m.is_system ? 'eye' : 'eyeOff', onClick: () => toggleHidden(i) },
        { label: '从这里分支', icon: 'branch', onClick: () => branchChat(i) },
        Array.isArray(m.swipes) && m.swipes.length > 1 ? { label: '删除当前这个回复版本', icon: 'x', onClick: () => { deleteSwipe(m); getSession()?.vars.invalidate(); renderMessage(i); saveChat(); } } : null,
        m.extra?.reasoning ? { label: '查看思维链原文', icon: 'brain', onClick: () => modal({ title: '思维链', body: h('pre', { style: { whiteSpace: 'pre-wrap' } }, m.extra.reasoning), wide: true }) } : null,
        Array.isArray(m.variables) && m.variables[m.swipe_id ?? 0] ? { label: '查看本层变量', icon: 'variable', onClick: () => modal({ title: `#${i} 楼层变量`, wide: true, body: h('div', { class: 'var-tree' }, JSON.stringify(m.variables[m.swipe_id ?? 0], null, 2)) }) } : null,
        '-',
        { label: '删除这条', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('删除这条消息？', { danger: true, okLabel: '删除' })) deleteMessages(i); } },
        !isLast ? { label: '删除这条及之后所有', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog(`删除第 ${i} 条及之后共 ${state.chat.messages.length - i} 条？`, { danger: true, okLabel: '删除' })) deleteMessages(i, state.chat.messages.length - 1); } } : null,
    ]);
}

// ---------- 输入区 ----------
let textarea;
export function renderComposer() {
    const root = $('#composer');
    clear(root);
    const status = h('div', { class: 'gen-status', id: 'gen-status' });
    const coarse = matchMedia('(pointer: coarse)').matches;
    textarea = h('textarea', { id: 'send_textarea', rows: 1, placeholder: coarse || !state.settings.ui.enterToSend ? '说点什么…' : '说点什么…（Enter 发送，Shift+Enter 换行）' });
    const sendBtn = h('button', { class: 'icon-btn send-btn primary', id: 'send_but', type: 'button', title: '发送', 'aria-label': '发送', onclick: onSend }, icon('arrowUp'));
    const moreBtn = iconBtn('plus', '更多操作', (e) => composerMenu(e.currentTarget), 'tool');
    const bar = h('div', { class: 'composer-bar' },
        moreBtn,
        h('button', { class: 'chip preset', type: 'button', id: 'composer-preset', title: '对话补全预设', onclick: () => openPanel('preset') }),
        h('div', { class: 'grow' }),
        h('button', { class: 'chip model', type: 'button', id: 'composer-model', title: '切换 API 连接', onclick: (e) => connectionMenu(e.currentTarget) }),
        sendBtn);
    const box = h('div', { class: 'composer-box' }, textarea, bar);
    box.addEventListener('mousedown', (e) => { if (e.target === box) { e.preventDefault(); textarea.focus(); } });
    root.append(status, box);
    const fit = () => { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`; };
    textarea.addEventListener('input', fit);
    textarea.addEventListener('keydown', (e) => {
        const mobile = matchMedia('(pointer: coarse)').matches;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && state.settings.ui.enterToSend && !mobile) {
            e.preventDefault();
            onSend();
        }
    });
    updateComposerChips();
    if (!chipsHooked) {
        // 连接 / 预设面板里的改动（改模型名、切连接、换预设）都会冒泡到 #right，统一刷新标签
        chipsHooked = true;
        let raf = 0;
        const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateComposerChips); };
        for (const ev of ['input', 'change', 'click']) $('#right')?.addEventListener(ev, later);
    }
}
let chipsHooked = false;

const openPanel = (id) => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: id }));

/** 输入框工具条上的“预设 / 模型”小标签 */
export function updateComposerChips() {
    const presetChip = $('#composer-preset');
    if (presetChip) presetChip.replaceChildren(icon('sliders'), h('span', { class: 'chip-t' }, state.preset?.name ?? '预设'));
    const modelChip = $('#composer-model');
    if (modelChip) {
        const conn = state.settings.connections.length ? activeConnection() : null;
        modelChip.replaceChildren(h('span', { class: 'chip-t' }, conn ? (conn.model || conn.name) : '配置连接'), icon('chevronDown'));
    }
}

function connectionMenu(anchor) {
    const s = state.settings;
    if (!s.connections.length) { openPanel('connection'); return; }
    const cur = activeConnection();
    popupMenu(anchor, [
        ...s.connections.map(c => ({
            label: `${c.name}${c.model ? ` · ${c.model}` : ''}`,
            icon: 'plug',
            current: c.id === cur.id,
            onClick: () => {
                s.activeConnection = c.id;
                saveSettings();
                updateComposerChips();
                refresh('panels');
            },
        })),
        '-',
        { label: '管理连接…', icon: 'settings', onClick: () => openPanel('connection') },
    ]);
}

function onSend() {
    if (state.generating) { stopGeneration(); return; }
    const text = textarea.value;
    textarea.value = '';
    textarea.style.height = 'auto';
    generate('normal', { input: text });
}

function composerMenu(anchor) {
    popupMenu(anchor, [
        { label: '继续写最后一条', icon: 'continue', onClick: () => generate('continue') },
        { label: '重新生成最后一条', icon: 'refresh', onClick: () => generate('regenerate') },
        { label: '代我写一条（扮演用户）', icon: 'mask', onClick: () => generate('impersonate') },
        '-',
        { label: '作者注释', icon: 'note', onClick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'note' })) },
        { label: '查看将要发送的提示词', icon: 'terminal', onClick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'inspector' })) },
        { label: '新建聊天', icon: 'plus', onClick: () => newChat() },
    ]);
}

export function setGenerating(on) {
    const btn = $('#send_but');
    if (!btn) return;
    btn.classList.toggle('stop', on);
    btn.classList.toggle('primary', !on);
    btn.title = on ? '停止' : '发送';
    btn.replaceChildren(icon(on ? 'stop' : 'arrowUp'));
    if (!on) chatEl()?.querySelectorAll('.mes.streaming').forEach(e => e.classList.remove('streaming'));
}

export function setStatus(text) {
    const s = $('#gen-status');
    if (!s) return;
    clear(s);
    if (text) s.append(h('span', { class: 'spinner' }), h('span', {}, text));
}

export function setComposerText(text) {
    if (!textarea) return;
    textarea.value = text;
    textarea.dispatchEvent(new Event('input'));
}

export function getComposerText() {
    return textarea?.value ?? '';
}

// ---------- 顶栏 ----------
export function renderTopbar() {
    const bar = $('#topbar');
    clear(bar);
    const app = $('#app');
    bar.append(iconBtn('panelLeft', '角色列表', () => window.dispatchEvent(new CustomEvent('lt:toggle-left')), 'toggle-left'));
    if (state.char && state.view !== 'home') {
        const card = state.char.card.data;
        const sub = state.chat ? chatTitle(state.chat.name, card.name) : '';
        bar.append(h('button', { class: 'title-btn', title: '聊天操作', onclick: (e) => titleMenu(e.currentTarget) },
            charAvatar(state.char.file, 'avatar', { name: card.name }),
            h('span', { class: 'n' }, card.name),
            sub ? h('span', { class: 's' }, `/ ${sub}`) : null,
            icon('chevronDown')));
    } else {
        bar.append(h('div', { class: 'title-plain' }, state.characters.length ? '角色库' : '轻酒馆'));
    }
    bar.append(
        h('div', { class: 'spacer' }),
        iconBtn(resolvedTheme() === 'light' ? 'moon' : 'sun', '切换深浅色', () => {
            state.settings.theme = resolvedTheme() === 'light' ? 'dark' : 'light';
            applyAppearance();
            saveSettings({ now: true });
            renderTopbar();
        }),
        iconBtn('panelRight', '设置面板', () => window.dispatchEvent(new CustomEvent('lt:toggle-right')), app.classList.contains('right-closed') ? '' : 'active'),
    );
    updateComposerChips();
}

function titleMenu(anchor) {
    const c = state.chat && state.chatList.find(x => x.name === state.chat.name);
    popupMenu(anchor, [
        { label: '新聊天', icon: 'plus', onClick: () => startNewChat(anchor) },
        c ? { label: '重命名这个聊天', icon: 'edit', onClick: () => renameChat(c) } : null,
        c ? { label: '导出 JSONL（酒馆可直接导入）', icon: 'download', onClick: () => exportChat(c) } : null,
        '-',
        { label: '编辑角色卡', icon: 'idCard', onClick: () => openPanel('char') },
        { label: '本聊天的设置（作者注释等）', icon: 'note', onClick: () => openPanel('note') },
        { label: '回到角色库', icon: 'users', onClick: () => goHome() },
        c ? '-' : null,
        c ? { label: '删除这个聊天', icon: 'trash', danger: true, onClick: () => deleteChat(c) } : null,
    ]);
}

export { refresh };
