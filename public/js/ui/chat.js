// 聊天区：消息列表、消息操作、输入框、顶栏；没选角色或点了“角色库”时显示首页
import { h, $, clear, icon, iconBtn, toast, confirmDialog, popupMenu, formatTime, modal } from './dom.js';
import { state, eventSource, event_types, saveChat, saveSettings, activePersona, activeConnection } from '../state.js';
import { api } from '../api.js';
import { getSession, editMessage, deleteMessages, toggleHidden, branchChat, setPreset, refresh } from '../controller.js';
import { generate, stopGeneration } from '../generate.js';
import { formatMessage, mountFormatted, renderReasoning } from './render.js';
import { mountFrontend, refreshSnapshots } from './frontend.js';
import { messageText, setSwipe, deleteSwipe, ensureSwipes } from '../core/chat.js';
import { parseSendDate } from '../core/util.js';
import { renderHome } from './library.js';
import { charAvatar, letterAvatar } from './avatars.js';
import { applyMacroLikes } from './script-api.js';
import { chatTitle, renameChat, exportChat, deleteChat } from './sidebar.js';

// 聊天页一次显示多少楼（设置 › 通用 › 外观，和酒馆的“加载消息数”一个意思）；0 = 全部
const renderWindow = () => {
    const n = Number(state.settings.ui.chatWindow ?? 80);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
};
// “加载更早的”每次补多少：窗口很小（比如只看最近 1～2 楼）时也别一次只补一两楼
const loadStep = () => Math.max(20, Math.min(renderWindow(), 200));
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
        eventSource.emit('character_page_loaded');
        return;
    }
    if (!state.chat) {
        el.append(h('div', { class: 'empty' }, '没有打开的聊天'));
        return;
    }
    const msgs = state.chat.messages;
    renderFrom = Math.max(0, msgs.length - renderWindow());
    if (renderFrom > 0) el.append(loadEarlierBtn(`加载更早的 ${Math.min(loadStep(), renderFrom)} 条（前面还有 ${renderFrom} 条）`));
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    if (!msgs.length) el.append(h('div', { class: 'empty' }, '这张卡没有开场白，直接说点什么吧'));
    scrollToBottom(true);
}

function loadEarlierBtn(label) {
    return h('div', { class: 'load-earlier' },
        h('button', { class: 'btn small', onclick: () => { renderFrom = Math.max(0, renderFrom - loadStep()); rerenderFrom(); eventSource.emit(event_types.MORE_MESSAGES_LOADED); } }, label));
}

function rerenderFrom() {
    const el = chatEl();
    const prevH = scrollEl().scrollHeight;
    const keep = scrollEl().scrollTop;
    clear(el);
    const msgs = state.chat.messages;
    if (renderFrom > 0) el.append(loadEarlierBtn(`加载更早的 ${Math.min(loadStep(), renderFrom)} 条（前面还有 ${renderFrom} 条）`));
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    scrollEl().scrollTop = keep + (scrollEl().scrollHeight - prevH);
}

function buildMessage(i, { streaming = false } = {}) {
    const m = state.chat.messages[i];
    const isLast = i === state.chat.messages.length - 1;
    const user = !!m.is_user;
    const el = h('div', {
        // last_mes / swipe_left / swipe_right 是酒馆页面上的类名，角色卡脚本会按它们找元素
        class: `mes ${user ? 'user' : 'char'} ${m.is_system ? 'hidden-msg' : ''} ${streaming ? 'streaming' : ''} ${isLast ? 'last last_mes' : ''}`,
        mesid: String(i),
        swipeid: String(m.swipe_id ?? 0),
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
                iconBtn('left', '上一个', () => swipe(i, -1), 'swipe_left'),
                h('span', { class: 'swipes-counter' }, `${Math.min(m.swipe_id ?? 0, swipeCount - 1) + 1}/${swipeCount}`),
                iconBtn('right', isLast ? '下一个 / 重新生成' : '下一个', () => swipe(i, 1), 'swipe_right'),
            ));
        }
        foot.append(tools);
        el.append(
            h('div', { class: 'mes_head' },
                avatarEl(m),
                h('span', { class: 'mes_name name_text' }, m.name ?? ''),
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
        // 脚本登记的助手宏（registerMacroLike）在显示时替换
        text = applyMacroLikes(text, { message_id: i, role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant' });
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

/** 正在读的那一楼：顶部已经滚出视口、但还占着视口上沿的消息 */
function readingMessage(s) {
    const top = s.getBoundingClientRect().top;
    for (const el of s.querySelectorAll('.mes')) {
        const r = el.getBoundingClientRect();
        if (r.bottom <= top + 40) continue;
        return r.top < top - 60 ? { el, offset: r.top - top } : null;
    }
    return null;
}

export function initScrollTracking() {
    const s = scrollEl();
    const down = h('button', { class: 'scroll-btn scroll-bottom', title: '到底部', hidden: true, onclick: () => { stickToBottom = true; scrollToBottom(true); } }, icon('chevronDown'));
    const up = h('button', { class: 'scroll-btn scroll-mes-top', title: '回到这楼开头', hidden: true, onclick: () => {
        const cur = readingMessage(s);
        if (!cur) return;
        stickToBottom = false;
        s.scrollTo({ top: s.scrollTop + cur.offset - 8, behavior: 'smooth' });
    } }, icon('arrowUp'));
    $('#center').append(h('div', { class: 'scroll-btns' }, up, down));
    // 输入区有多高按钮就垫多高（上面多出脚本按钮、状态行，或者输入框收成一行时都跟着变）
    const composer = $('#composer');
    if (composer && typeof ResizeObserver === 'function') {
        const setH = () => $('#center').style.setProperty('--composer-h', `${composer.offsetHeight}px`);
        new ResizeObserver(setH).observe(composer);
        setH();
    }
    let raf = 0;
    let lastTop = s.scrollTop, goingUp = false;
    const update = () => {
        raf = 0;
        const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
        stickToBottom = atBottom;
        // 只在往回翻的时候露出来：往下读、或者生成时跟着滚到底，按钮都收起，不挡正文
        if (s.scrollTop < lastTop - 4) goingUp = true;
        else if (s.scrollTop > lastTop + 4) goingUp = false;
        lastTop = s.scrollTop;
        down.hidden = atBottom || !goingUp;
        up.hidden = !goingUp || !readingMessage(s);
    };
    s.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); }, { passive: true });
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
    // 开场白（第一楼、角色说的）换了版本：酒馆另外发一个“选了哪个开场白”
    if (i === 0 && !m.is_user) await eventSource.emit('character_first_message_selected', { input: m.mes, output: m.mes, character: state.char?.card?.data?.name ?? '' });
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
    // 重新生成在消息下面那排按钮里，继续写在输入框的 + 里，这里不再重复
    popupMenu(anchor, [
        { label: m.is_system ? '取消隐藏（重新发给 AI）' : '隐藏（不发给 AI）', icon: m.is_system ? 'eye' : 'eyeOff', onClick: () => toggleHidden(i) },
        { label: '从这里分支', icon: 'branch', onClick: () => branchChat(i) },
        Array.isArray(m.swipes) && m.swipes.length > 1 ? { label: '删除当前这个回复版本', icon: 'x', onClick: () => { const sid = m.swipe_id ?? 0; deleteSwipe(m); getSession()?.vars.invalidate(); renderMessage(i); saveChat(); eventSource.emit('message_swipe_deleted', { messageId: i, swipeId: sid, newSwipeId: m.swipe_id ?? 0 }); } } : null,
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
    const moreBtn = iconBtn('plus', '让 AI 继续写 / 重新生成 / 代我写', (e) => composerMenu(e.currentTarget), 'tool');
    const bar = h('div', { class: 'composer-bar' },
        moreBtn,
        h('button', { class: 'chip preset', type: 'button', id: 'composer-preset', title: '切换预设', onclick: (e) => presetMenu(e.currentTarget) }),
        h('div', { class: 'grow' }),
        h('button', { class: 'chip model', type: 'button', id: 'composer-model', title: '切换连接', onclick: (e) => connectionMenu(e.currentTarget) }));
    // 上半区：输入框 + 发送键（2026-10-10 用户要求发送键放在上面）
    const row = h('div', { class: 'composer-row' }, textarea, sendBtn);
    // 酒馆页面上的几个按钮 id，角色卡脚本会用 $('#mes_stop').click() 这类写法触发停止 / 重新生成 / 继续。
    // 这里放几个看不见的同名元素接住，功能还是走上面那一套（界面上不多出入口）
    const compat = h('div', { hidden: true, 'aria-hidden': 'true' },
        h('div', { id: 'mes_stop', onclick: () => stopGeneration() }),
        h('div', { id: 'option_regenerate', onclick: () => generate('regenerate') }),
        h('div', { id: 'option_continue', onclick: () => generate('continue') }));
    const box = h('div', { class: 'composer-box' }, row, bar, compat);
    box.addEventListener('mousedown', (e) => { if (e.target === box || e.target === row) { e.preventDefault(); textarea.focus(); } });
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
    if (presetChip) presetChip.replaceChildren(icon('sliders'), h('span', { class: 'chip-t' }, state.preset?.name ?? '预设'), icon('chevronDown'));
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

function presetMenu(anchor) {
    const cur = state.preset?.name;
    popupMenu(anchor, [
        ...state.presetList.map(p => ({
            label: p.name,
            icon: 'sliders',
            current: p.name === cur,
            onClick: () => { if (p.name !== cur) setPreset(p.name); },
        })),
        '-',
        { label: '编辑预设…', icon: 'settings', onClick: () => openPanel('preset') },
    ]);
}

function onSend() {
    if (state.generating) { stopGeneration(); return; }
    const text = textarea.value;
    textarea.value = '';
    textarea.style.height = 'auto';
    generate('normal', { input: text });
}

/** 输入框的 +：只放“让 AI 生成”的几种方式，其余功能各回各家（新聊天在左栏，作者注释 / 提示词预览在设置 › 本聊天） */
function composerMenu(anchor) {
    popupMenu(anchor, [
        { label: '继续写最后一条', icon: 'continue', onClick: () => generate('continue') },
        { label: '重新生成最后一条', icon: 'refresh', onClick: () => generate('regenerate') },
        { label: '代我写一条（扮演用户）', icon: 'mask', onClick: () => generate('impersonate') },
        ...extensionMenuItems(),
    ]);
}

/** 酒馆插件放进“魔棒菜单”（#extensionsMenu）里的入口：轻酒馆把它们列在 + 菜单里，点了转给原来的元素 */
function extensionMenuItems() {
    const host = document.getElementById('extensionsMenu');
    const items = [...(host?.children ?? [])]
        .map(el => ({ el, label: (el.textContent || el.title || '').replace(/\s+/g, ' ').trim() }))
        .filter(x => x.label)
        .map(({ el, label }) => ({ label, icon: 'plug', onClick: () => {
            // 有的插件听点击，有的（如柚月）只听按下 / 回车：两样都发，没人听的那样不起作用
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            (el.querySelector('.list-group-item, [role=button], button') ?? el).click();
        } }));
    return items.length ? ['-', ...items] : [];
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
    // 手机上没有悬停提示，按钮都带文字
    bar.append(h('button', { class: 'tb-btn toggle-left', type: 'button', title: '菜单', 'aria-label': '菜单：角色和聊天记录', onclick: () => window.dispatchEvent(new CustomEvent('lt:toggle-left')) },
        icon('menu'), h('span', { class: 'lbl' }, '菜单')));
    if (state.char && state.view !== 'home') {
        const card = state.char.card.data;
        const sub = state.chat ? chatTitle(state.chat.name, card.name) : '';
        bar.append(h('button', { class: 'title-btn', title: '这个聊天：重命名 / 导出 / 删除', onclick: (e) => titleMenu(e.currentTarget) },
            charAvatar(state.char.file, 'avatar', { name: card.name }),
            h('span', { class: 'n' }, card.name),
            sub ? h('span', { class: 's' }, `/ ${sub}`) : null,
            icon('chevronDown')));
    } else {
        bar.append(h('div', { class: 'title-plain' }, state.characters.length ? '首页' : '轻酒馆'));
    }
    bar.append(
        h('div', { class: 'spacer' }),
        h('button', { class: `tb-btn toggle-right ${app.classList.contains('right-closed') ? '' : 'active'}`, type: 'button', title: '设置', 'aria-label': '设置：模型、角色、本聊天、通用', onclick: () => window.dispatchEvent(new CustomEvent('lt:toggle-right')) },
            icon('sliders'), h('span', { class: 'lbl' }, '设置')),
    );
    updateComposerChips();
}

function titleMenu(anchor) {
    const c = state.chat && state.chatList.find(x => x.name === state.chat.name);
    // 只放对“这个聊天”本身的操作，和左栏聊天记录的 ⋮ 一致；新聊天 / 角色库在左栏，角色卡和作者注释在设置里
    if (!c) return;
    popupMenu(anchor, [
        { label: '重命名', icon: 'edit', onClick: () => renameChat(c) },
        { label: '导出 JSONL（酒馆可直接导入）', icon: 'download', onClick: () => exportChat(c) },
        '-',
        { label: '删除聊天', icon: 'trash', danger: true, onClick: () => deleteChat(c) },
    ]);
}

export { refresh };
