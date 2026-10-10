// 首页：最近聊天（和酒馆首页一样，所有角色的聊天按时间排，点一下就进去）和角色库两个标签；一张卡都没有时显示上手步骤
import { h, clear, icon, iconBtn, formatTime, toast, BRAND_SVG } from './dom.js';
import { state, activePersona } from '../state.js';
import { selectCharacter, openChat, refresh } from '../controller.js';
import { api } from '../api.js';
import { charAvatar } from './avatars.js';
import { charMenu, onImport, onCreate, plainSnippet, chatTitle } from './sidebar.js';

let query = '';
let sort = 'recent';
/** 首页显示哪个标签：recent 最近聊天 | library 角色库 */
let homeTab = 'recent';
export function setHomeTab(tab) { homeTab = tab === 'library' ? 'library' : 'recent'; }
/** 最近聊天的上一次结果：先画旧的，后台拉新的再换 */
let recentCache = null;

const openPanel = (id) => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: id }));

function greetingWord() {
    const hr = new Date().getHours();
    if (hr < 5) return '夜深了';
    if (hr < 11) return '早上好';
    if (hr < 13) return '中午好';
    if (hr < 18) return '下午好';
    return '晚上好';
}

const SORTS = {
    recent: (a, b) => (!!b.fav - !!a.fav) || (Math.max(b.lastChat ?? 0, b.mtime ?? 0) - Math.max(a.lastChat ?? 0, a.mtime ?? 0)),
    name: (a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'),
    chats: (a, b) => (b.chats ?? 0) - (a.chats ?? 0) || SORTS.recent(a, b),
};

export function renderHome(el) {
    const wrap = h('div', { class: 'home-wrap' });
    const hasChars = state.characters.length > 0;
    if (!hasChars) {
        const persona = activePersona();
        wrap.append(h('div', { class: 'greeting' },
            h('span', { class: 'greeting-mark', html: BRAND_SVG }),
            h('h1', {}, `${greetingWord()}，${persona.name || 'User'}`),
            h('p', {}, '兼容酒馆的角色卡、预设、世界书、正则、EJS 模板与 MVU 变量的轻量前端')));
        wrap.append(onboarding());
        el.append(wrap);
        return;
    }
    const tab = (id, label) => h('button', {
        class: `home-tab ${homeTab === id ? 'active' : ''}`,
        onclick: () => { if (homeTab !== id) { homeTab = id; refresh(['chat']); } },
    }, label);
    wrap.classList.add(`home-${homeTab}`);
    wrap.append(h('div', { class: 'home-tabs' }, tab('recent', '最近聊天'), tab('library', '角色库'),
        homeTab === 'library' ? h('div', { class: 'home-tab-actions' },
            h('button', { class: 'btn', title: '导入角色卡', onclick: onImport }, icon('upload'), h('span', { class: 'bt-label' }, '导入')),
            h('button', { class: 'btn primary', title: '新建角色', onclick: onCreate }, icon('plus'), h('span', { class: 'bt-label' }, '新建'))) : null));
    wrap.append(homeTab === 'library' ? library() : recentChats());
    el.append(wrap);
}

function recentChats() {
    const box = h('div', { class: 'recent-list' });
    const draw = (list) => {
        clear(box);
        if (!list) { box.append(h('div', { class: 'empty' }, '正在读取…')); return; }
        if (!list.length) { box.append(h('div', { class: 'empty' }, '还没有聊天。去「角色库」选一个角色开始吧')); return; }
        for (const c of list) box.append(recentItem(c));
    };
    draw(recentCache);
    api.recentChats(50).then((list) => {
        recentCache = list;
        draw(list);
    }, (e) => { if (!recentCache) { clear(box); box.append(h('div', { class: 'empty' }, `读取最近聊天失败：${e.message}`)); } });
    return box;
}

function recentItem(c) {
    const current = state.char?.file === c.file && state.chat?.name === c.chat;
    const meta = [chatTitle(c.chat, c.charName), c.count > 0 ? `${c.count} 楼` : ''].filter(Boolean).join(' · ');
    return h('button', {
        class: `recent-item ${current ? 'active' : ''}`,
        title: `${c.charName} · ${c.chat}`,
        onclick: () => openRecent(c),
    },
    charAvatar(c.file, 'avatar', { name: c.charName }),
    h('div', { class: 'ri-body' },
        h('div', { class: 'ri-top' },
            h('span', { class: 'ri-name' }, c.charName),
            h('span', { class: 'ri-time' }, formatTime(c.mtime))),
        h('div', { class: 'ri-last' }, c.last ? plainSnippet(c.last, 120) : '（空）'),
        h('div', { class: 'ri-meta' }, meta)));
}

async function openRecent(c) {
    try {
        if (state.char?.file === c.file && state.chat?.name === c.chat) {
            state.view = 'chat';
            refresh(['chat', 'topbar', 'sidebar']);
            return;
        }
        if (state.char?.file !== c.file) await selectCharacter(c.file, { openLatest: false });
        if (state.char?.file !== c.file) return; // 正在生成之类的原因没切过去
        await openChat(c.chat);
    } catch (e) {
        toast(`打开聊天失败：${e.message}`, 'error');
    }
}

function library() {
    const box = h('div');
    const grid = h('div', { class: 'lib-grid' });
    const count = h('span', { class: 'muted' });
    const search = h('input', { class: 'input', type: 'search', placeholder: '搜索名字、标签或作者…', value: query });
    const sortSel = h('select', { class: 'select', title: '排序' },
        h('option', { value: 'recent', selected: sort === 'recent' }, '最近使用'),
        h('option', { value: 'name', selected: sort === 'name' }, '按名字'),
        h('option', { value: 'chats', selected: sort === 'chats' }, '聊天最多'));
    const fill = () => {
        clear(grid);
        const q = query.trim().toLowerCase();
        const match = (c) => !q || [c.name, c.creator, ...(c.tags ?? [])].some(t => String(t ?? '').toLowerCase().includes(q));
        const items = state.characters.filter(match).sort(SORTS[sort] ?? SORTS.recent);
        count.textContent = q ? `${items.length} / ${state.characters.length}` : `${state.characters.length}`;
        if (!items.length) {
            grid.append(h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, '没有匹配的角色'));
            return;
        }
        for (const c of items) grid.append(charCard(c));
    };
    search.addEventListener('input', () => { query = search.value; fill(); });
    sortSel.addEventListener('change', () => { sort = sortSel.value; fill(); });
    box.append(
        h('div', { class: 'lib-head' },
            h('h2', {}, '角色库', count),
            h('button', { class: 'btn', onclick: onImport }, icon('upload'), '导入'),
            h('button', { class: 'btn primary', onclick: onCreate }, icon('plus'), '新建角色')),
        h('div', { class: 'lib-tools' },
            h('div', { class: 'search-box' }, icon('search'), search),
            sortSel),
        grid,
    );
    fill();
    return box;
}

function charCard(c) {
    const active = state.char?.file === c.file;
    const notes = plainSnippet(c.notes, 140);
    const when = Math.max(c.lastChat ?? 0, 0) || c.mtime;
    const meta = [c.chats ? `${c.chats} 个聊天` : '还没聊过', when ? formatTime(when) : '', ...(c.tags ?? []).slice(0, 2)].filter(Boolean).join(' · ');
    const el = h('div', {
        class: `char-card ${active ? 'active' : ''} ${c.error ? 'error' : ''}`,
        role: 'button',
        tabindex: '0',
        title: c.error ? `读取失败：${c.error}` : c.name,
        onclick: () => open(c),
        onkeydown: (e) => { if (e.key === 'Enter') open(c); },
        oncontextmenu: (e) => { e.preventDefault(); if (!c.error) charMenu(el, c); },
    },
    charAvatar(c.error ? '' : c.file, 'avatar', { name: c.name }),
    h('div', { class: 'cc-body' },
        h('div', { class: 'cc-name' }, c.fav ? h('span', { class: 'fav-star' }, '★') : null, c.name),
        h('div', { class: 'cc-notes' }, c.error ? `读取失败：${c.error}` : notes || (c.creator ? `作者：${c.creator}` : '没有简介')),
        h('div', { class: 'cc-meta' }, meta)),
    c.error ? null : iconBtn('more', '更多', (e) => { e.stopPropagation(); charMenu(e.currentTarget, c); }),
    );
    return el;
}

async function open(c) {
    if (c.error) return;
    if (state.char?.file === c.file) {
        state.view = 'chat';
        refresh(['chat', 'topbar', 'sidebar']);
        return;
    }
    await selectCharacter(c.file);
}

function onboarding() {
    return h('div', {},
        h('div', { class: 'steps' },
            h('div', { class: 'step' }, h('b', {}, '1'), h('div', {}, '在「设置 › 模型 › 连接」里填 API 地址和 Key（OpenAI 兼容 / Claude / Gemini）')),
            h('div', { class: 'step' }, h('b', {}, '2'), h('div', {}, '导入角色卡（PNG / JSON，可以直接拖进窗口），或在「设置 › 通用 › 导入」里一键从酒馆搬数据')),
            h('div', { class: 'step' }, h('b', {}, '3'), h('div', {}, '在「设置 › 模型 › 预设」里导入你常用的对话补全预设，开聊')),
        ),
        h('div', { class: 'home-actions' },
            h('button', { class: 'btn primary', onclick: () => openPanel('import') }, icon('import'), '从酒馆导入'),
            h('button', { class: 'btn', onclick: onImport }, icon('upload'), '导入角色卡'),
            h('button', { class: 'btn', onclick: () => openPanel('connection') }, icon('plug'), '配置连接'),
        ));
}
