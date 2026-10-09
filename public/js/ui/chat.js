// 聊天区：消息列表、消息操作、输入框、顶栏
import { h, $, clear, icon, iconBtn, toast, confirmDialog, popupMenu, formatTime, modal } from './dom.js';
import { state, eventSource, event_types, saveChat, saveSettings, activePersona } from '../state.js';
import { api } from '../api.js';
import { getSession, editMessage, deleteMessages, toggleHidden, branchChat, newChat, refresh } from '../controller.js';
import { generate, stopGeneration } from '../generate.js';
import { formatMessage, mountFormatted, renderReasoning } from './render.js';
import { mountFrontend, refreshSnapshots } from './frontend.js';
import { messageText, setSwipe, deleteSwipe, ensureSwipes } from '../core/chat.js';
import { parseSendDate } from '../core/util.js';

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
    const url = avatarFor(m);
    if (url) return h('img', { class: 'avatar', src: url, alt: '', loading: 'lazy' });
    const letter = (m.name || '?').slice(0, 1);
    return h('div', { class: 'avatar', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: 'var(--muted)' } }, letter);
}

export function renderChat() {
    const el = chatEl();
    if (!el) return;
    clear(el);
    if (!state.char) {
        el.append(welcome());
        return;
    }
    if (!state.chat) {
        el.append(h('div', { class: 'empty' }, '没有打开的聊天'));
        return;
    }
    const msgs = state.chat.messages;
    renderFrom = Math.max(0, msgs.length - RENDER_WINDOW);
    if (renderFrom > 0) {
        el.append(h('div', { style: { textAlign: 'center', padding: '8px' } },
            h('button', { class: 'btn small', onclick: () => { renderFrom = Math.max(0, renderFrom - RENDER_WINDOW); rerenderFrom(); } }, `加载更早的 ${Math.min(RENDER_WINDOW, renderFrom)} 条`)));
    }
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    if (!msgs.length) el.append(h('div', { class: 'empty' }, '这张卡没有开场白，直接说点什么吧'));
    scrollToBottom(true);
}

function rerenderFrom() {
    const el = chatEl();
    const prevH = scrollEl().scrollHeight;
    const keep = scrollEl().scrollTop;
    clear(el);
    const msgs = state.chat.messages;
    if (renderFrom > 0) {
        el.append(h('div', { style: { textAlign: 'center', padding: '8px' } },
            h('button', { class: 'btn small', onclick: () => { renderFrom = Math.max(0, renderFrom - RENDER_WINDOW); rerenderFrom(); } }, `加载更早的消息`)));
    }
    for (let i = renderFrom; i < msgs.length; i++) el.append(buildMessage(i));
    scrollEl().scrollTop = keep + (scrollEl().scrollHeight - prevH);
}

function welcome() {
    return h('div', { class: 'welcome' },
        h('div', { class: 'welcome-logo' }, '酒'),
        h('h1', {}, '轻酒馆'),
        h('p', {}, '兼容酒馆的角色卡、预设、世界书、正则、EJS 模板与 MVU 变量的轻量前端'),
        h('div', { class: 'steps' },
            h('div', { class: 'step' }, h('b', {}, '1'), h('div', {}, '在右侧「连接」里填 API 地址和 Key（OpenAI 兼容 / Claude / Gemini）')),
            h('div', { class: 'step' }, h('b', {}, '2'), h('div', {}, '左侧导入角色卡（PNG/JSON），或在「导入」里一键从酒馆搬数据')),
            h('div', { class: 'step' }, h('b', {}, '3'), h('div', {}, '「预设」里导入你常用的对话补全预设，开聊')),
        ),
        h('div', { class: 'actions' },
            h('button', { class: 'btn primary', onclick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'import' })) }, icon('import'), '从酒馆导入'),
            h('button', { class: 'btn', onclick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'connection' })) }, icon('plug'), '配置连接'),
        ),
    );
}

function buildMessage(i, { streaming = false } = {}) {
    const m = state.chat.messages[i];
    const isLast = i === state.chat.messages.length - 1;
    const el = h('div', {
        class: `mes ${m.is_user ? 'user' : 'char'} ${m.is_system ? 'hidden-msg' : ''} ${streaming ? 'streaming' : ''}`,
        mesid: String(i),
        is_user: String(!!m.is_user),
        is_system: String(!!m.is_system),
        ch_name: m.name ?? '',
    });
    const time = parseSendDate(m.send_date);
    const tools = h('div', { class: 'mes_tools' },
        iconBtn('edit', '编辑', () => startEdit(i)),
        iconBtn('copy', '复制', () => copyMessage(i)),
        iconBtn('more', '更多', (e) => messageMenu(e.currentTarget, i)),
    );
    const textEl = h('div', { class: 'mes_text' });
    const block = h('div', { class: 'mes_block' },
        h('div', { class: 'mes_head' },
            h('span', { class: 'mes_name' }, m.name ?? ''),
            m.is_system ? h('span', { class: 'tag' }, '已隐藏') : null,
            h('span', { class: 'mes_time' }, time ? formatTime(time) : ''),
            state.settings.ui.showMesId ? h('span', { class: 'mes_id' }, `#${i}`) : null,
            tools,
        ),
        h('div', { class: 'reasoning-slot' }),
        textEl,
    );
    const swipeCount = Array.isArray(m.swipes) && m.swipes.length ? m.swipes.length : 1;
    if (!m.is_user && !m.extra?.type && (isLast || swipeCount > 1)) {
        block.append(h('div', { class: 'swipes' },
            iconBtn('left', '上一个', () => swipe(i, -1)),
            h('span', {}, `${Math.min(m.swipe_id ?? 0, swipeCount - 1) + 1}/${swipeCount}`),
            iconBtn('right', isLast ? '下一个 / 重新生成' : '下一个', () => swipe(i, 1)),
        ));
    }
    el.append(avatarEl(m), block);
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
    clear(slot);
    if (state.settings.ui.showReasoning && m.extra?.reasoning) {
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
    textarea = h('textarea', { id: 'send_textarea', rows: 1, placeholder: matchMedia('(pointer: coarse)').matches || !state.settings.ui.enterToSend ? '说点什么…' : '说点什么…（Enter 发送，Shift+Enter 换行）' });
    const sendBtn = h('button', { class: 'icon-btn send-btn primary', id: 'send_but', title: '发送', onclick: onSend }, icon('send'));
    const moreBtn = iconBtn('more', '更多操作', (e) => composerMenu(e.currentTarget));
    root.append(status, h('div', { class: 'composer-inner' }, moreBtn, textarea, sendBtn));
    const fit = () => { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`; };
    textarea.addEventListener('input', fit);
    textarea.addEventListener('keydown', (e) => {
        const mobile = matchMedia('(pointer: coarse)').matches;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && state.settings.ui.enterToSend && !mobile) {
            e.preventDefault();
            onSend();
        }
    });
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
    btn.replaceChildren(icon(on ? 'stop' : 'send'));
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
    bar.append(iconBtn('menu', '角色列表', () => window.dispatchEvent(new CustomEvent('lt:toggle-left'))));
    if (state.char) {
        const card = state.char.card.data;
        bar.append(h('div', { class: 'title' },
            h('img', { class: 'avatar sm', src: api.avatarUrl(state.char.file, state.char.v), alt: '' }),
            h('div', { style: { minWidth: 0 } },
                h('div', { class: 'n' }, card.name),
                h('div', { class: 's' }, `${state.preset?.name ?? ''}${state.chat ? ' · ' + state.chat.messages.length + ' 条' : ''}`))));
    } else {
        bar.append(h('div', { class: 'title' }, h('div', { class: 'n' }, '轻酒馆')));
    }
    bar.append(
        iconBtn(state.settings.theme === 'light' ? 'moon' : 'sun', '切换深浅色', () => {
            state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = state.settings.theme;
            saveSettings();
            renderTopbar();
        }),
        iconBtn('sidebar', '设置面板', () => window.dispatchEvent(new CustomEvent('lt:toggle-right')), app.classList.contains('right-closed') ? '' : 'active'),
    );
}

export { refresh };
