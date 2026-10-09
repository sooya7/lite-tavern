// 左栏：角色列表 / 当前角色的聊天记录
import { h, $, clear, icon, iconBtn, toast, confirmDialog, promptDialog, popupMenu, pickFiles, formatTime, downloadText } from './dom.js';
import { state, saveSettings, refreshLists } from '../state.js';
import { api } from '../api.js';
import { selectCharacter, openChat, newChat, reloadCharacters, refresh } from '../controller.js';
import { importFiles } from './importers.js';
import { newCard } from '../core/card.js';
import { cardGreetings } from '../core/card.js';

let tab = 'chars';
let query = '';

const isNarrow = () => matchMedia('(max-width: 760px)').matches;
function closeOnMobile() {
    if (isNarrow()) window.dispatchEvent(new CustomEvent('lt:toggle-left', { detail: false }));
}

export function renderSidebar() {
    const root = $('#left');
    if (!root) return;
    const listScroll = root.querySelector('.side-list')?.scrollTop ?? 0;
    clear(root);
    root.append(
        h('div', { class: 'side-head' },
            h('div', { class: 'brand' }, h('span', { class: 'brand-dot' }, '酒'), '轻酒馆'),
            iconBtn('upload', '导入角色卡 / 预设 / 世界书（也可以直接把文件拖进窗口）', onImport),
            iconBtn('plus', '新建角色', onCreate),
            isNarrow() ? iconBtn('x', '收起', () => closeOnMobile()) : null,
        ),
        h('div', { class: 'tabs', style: { padding: '0 8px' } },
            h('button', { class: `tab ${tab === 'chars' ? 'active' : ''}`, onclick: () => { tab = 'chars'; renderSidebar(); } }, `角色 ${state.characters.length || ''}`),
            h('button', { class: `tab ${tab === 'chats' ? 'active' : ''}`, onclick: () => { tab = 'chats'; renderSidebar(); }, disabled: !state.char }, `聊天记录 ${state.char ? state.chatList.length : ''}`),
        ),
    );
    if (tab === 'chats' && state.char) renderChats(root);
    else renderChars(root);
    const list = root.querySelector('.side-list');
    if (list) list.scrollTop = listScroll;
}

function charSort(a, b) {
    if (!!b.fav - !!a.fav) return !!b.fav - !!a.fav;
    const la = Math.max(a.lastChat ?? 0, a.mtime ?? 0), lb = Math.max(b.lastChat ?? 0, b.mtime ?? 0);
    return lb - la;
}

function renderChars(root) {
    const search = h('input', { class: 'input', placeholder: '搜索名字或标签…', value: query, type: 'search' });
    const list = h('div', { class: 'side-list' });
    const fill = () => {
        clear(list);
        const q = query.trim().toLowerCase();
        const items = state.characters.filter(c => !q || String(c.name).toLowerCase().includes(q) || (c.tags ?? []).some(t => String(t).toLowerCase().includes(q))).sort(charSort);
        if (!items.length) {
            list.append(h('div', { class: 'empty' }, state.characters.length ? '没有匹配的角色' : h('div', {},
                h('div', {}, '还没有角色'),
                h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '10px', flexWrap: 'wrap' } },
                    h('button', { class: 'btn small', onclick: onImport }, icon('upload'), '导入卡'),
                    h('button', { class: 'btn small', onclick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'import' })) }, icon('import'), '从酒馆搬'),
                ))));
            return;
        }
        for (const c of items) list.append(charItem(c));
    };
    search.addEventListener('input', () => { query = search.value; fill(); });
    root.append(h('div', { class: 'side-search' }, search), list);
    fill();
}

function charItem(c) {
    const active = state.char?.file === c.file;
    const chats = active ? state.chatList.length : c.chats;
    const lastChat = active && state.chatList[0] ? state.chatList[0].mtime : c.lastChat;
    const sub = c.error ? `读取失败：${c.error}` : [chats ? `${chats} 个聊天` : '新角色', lastChat ? formatTime(lastChat) : '', (c.tags ?? []).slice(0, 3).join(' · ')].filter(Boolean).join(' · ');
    const el = h('div', {
        class: `char-item ${active ? 'active' : ''}`,
        title: c.name,
        onclick: async () => {
            if (c.error) return;
            if (!active) await selectCharacter(c.file);
            closeOnMobile();
        },
        oncontextmenu: (e) => { e.preventDefault(); charMenu(el, c); },
    },
    h('img', { class: 'avatar', src: api.avatarUrl(c.file, Math.round(c.mtime ?? 0)), alt: '', loading: 'lazy', decoding: 'async' }),
    h('div', { class: 'char-meta' },
        h('div', { class: 'char-name' }, c.fav ? h('span', { style: { color: 'var(--accent)', marginRight: '4px' } }, '★') : null, c.name),
        h('div', { class: 'char-sub' }, sub)),
    iconBtn('more', '更多', (e) => { e.stopPropagation(); charMenu(e.currentTarget, c); }),
    );
    return el;
}

function charMenu(anchor, c) {
    popupMenu(anchor, [
        { label: '编辑角色卡', icon: 'edit', onClick: async () => { if (state.char?.file !== c.file) await selectCharacter(c.file); window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'char' })); } },
        { label: c.fav ? '取消收藏' : '收藏', icon: 'star', onClick: () => toggleFav(c) },
        { label: '导出 PNG 卡', icon: 'download', onClick: () => window.open(api.exportCharacterUrl(c.file, 'png'), '_blank') },
        { label: '导出 JSON', icon: 'download', onClick: () => window.open(api.exportCharacterUrl(c.file, 'json'), '_blank') },
        '-',
        { label: '删除角色', icon: 'trash', danger: true, onClick: () => deleteChar(c) },
    ]);
}

async function toggleFav(c) {
    try {
        const card = state.char?.file === c.file ? state.char.card : await api.getCharacter(c.file);
        card.data.extensions = card.data.extensions ?? {};
        card.data.extensions.fav = !c.fav;
        card.fav = !c.fav;
        await api.saveCharacter(c.file, card);
        await reloadCharacters();
    } catch (e) {
        toast(`操作失败：${e.message}`, 'error');
    }
}

async function deleteChar(c) {
    const ok = await confirmDialog(`删除角色「${c.name}」？\n文件会移到数据目录的 trash 里，可以手动找回。`, { danger: true, okLabel: '删除' });
    if (!ok) return;
    const withChats = c.chats ? await confirmDialog(`它有 ${c.chats} 个聊天记录，要一起删掉吗？\n选“取消”会保留聊天文件。`, { okLabel: '一起删', danger: true }) : false;
    try {
        await api.deleteCharacter(c.file, withChats);
        if (state.char?.file === c.file) {
            state.char = null;
            state.chat = null;
            state.session = null;
            state.chatList = [];
            state.settings.lastChat = null;
            saveSettings();
        }
        await reloadCharacters();
        refresh();
        toast('已删除', 'success');
    } catch (e) {
        toast(`删除失败：${e.message}`, 'error');
    }
}

async function onImport() {
    const files = await pickFiles({ accept: '.png,.json,.jsonl', multiple: true });
    if (files.length) await importFiles(files);
}

async function onCreate() {
    const name = await promptDialog('角色名字：', '', { title: '新建角色' });
    if (!name?.trim()) return;
    try {
        const card = newCard(name.trim());
        const { file } = await api.createCharacter(card);
        await reloadCharacters();
        await selectCharacter(file);
        window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'char' }));
    } catch (e) {
        toast(`创建失败：${e.message}`, 'error');
    }
}

// ---------- 聊天记录 ----------
function renderChats(root) {
    const card = state.char.card.data;
    const greetings = cardGreetings(state.char.card);
    const head = h('div', { class: 'row', style: { padding: '10px 12px 6px' } },
        h('img', { class: 'avatar sm', src: api.avatarUrl(state.char.file), alt: '' }),
        h('div', { class: 'grow', style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.name),
        h('button', {
            class: 'btn small primary',
            onclick: async (e) => {
                if (greetings.filter(Boolean).length > 1) {
                    popupMenu(e.currentTarget, greetings.map((g, i) => ({
                        label: `${i === 0 ? '默认开场白' : `备选开场白 ${i}`}：${String(g).replace(/\s+/g, ' ').slice(0, 24)}…`,
                        onClick: async () => { await newChat({ greetingIndex: i }); closeOnMobile(); },
                    })));
                    return;
                }
                await newChat();
                closeOnMobile();
            },
        }, icon('plus'), '新聊天'),
    );
    const list = h('div', { class: 'side-list' });
    if (!state.chatList.length) list.append(h('div', { class: 'empty' }, '还没有聊天'));
    for (const c of state.chatList) {
        const active = state.chat?.name === c.name;
        const el = h('div', {
            class: `chat-item ${active ? 'active' : ''}`,
            onclick: async () => { if (!active) await openChat(c.name); closeOnMobile(); },
            oncontextmenu: (e) => { e.preventDefault(); chatMenu(el, c); },
        },
        h('div', { class: 'grow' },
            h('div', { class: 't' }, c.name),
            h('div', { class: 'd' }, `${c.count >= 0 ? c.count + ' 条 · ' : ''}${formatTime(c.mtime)}${c.last ? ' · ' + c.last : ''}`)),
        iconBtn('more', '更多', (e) => { e.stopPropagation(); chatMenu(e.currentTarget, c); }),
        );
        list.append(el);
    }
    root.append(head, list);
}

function chatMenu(anchor, c) {
    popupMenu(anchor, [
        { label: '重命名', icon: 'edit', onClick: () => renameChat(c) },
        { label: '导出 JSONL（酒馆可直接导入）', icon: 'download', onClick: () => exportChat(c) },
        '-',
        { label: '删除聊天', icon: 'trash', danger: true, onClick: () => deleteChat(c) },
    ]);
}

async function renameChat(c) {
    const to = await promptDialog('新名字：', c.name, { title: '重命名聊天' });
    if (!to?.trim() || to.trim() === c.name) return;
    try {
        await api.renameChat(state.char.id, c.name, to.trim());
        if (state.chat?.name === c.name) {
            state.chat.name = to.trim();
            state.settings.lastChat = { file: state.char.file, chat: to.trim() };
            if (state.session) state.session.chatId = to.trim();
            saveSettings();
        }
        state.chatList = await api.listChats(state.char.id);
        renderSidebar();
        refresh('topbar');
    } catch (e) {
        toast(`重命名失败：${e.message}`, 'error');
    }
}

async function exportChat(c) {
    try {
        const text = await api.getChat(state.char.id, c.name);
        downloadText(text, `${c.name}.jsonl`, 'application/jsonl');
    } catch (e) {
        toast(`导出失败：${e.message}`, 'error');
    }
}

async function deleteChat(c) {
    if (!await confirmDialog(`删除聊天「${c.name}」？\n会移到数据目录的 trash 里。`, { danger: true, okLabel: '删除' })) return;
    try {
        await api.deleteChat(state.char.id, c.name);
        state.chatList = await api.listChats(state.char.id);
        if (state.chat?.name === c.name) {
            state.chat = null;
            state.session = null;
            if (state.chatList.length) await openChat(state.chatList[0].name);
            else await newChat();
        }
        renderSidebar();
    } catch (e) {
        toast(`删除失败：${e.message}`, 'error');
    }
}

export function setSidebarTab(t) {
    tab = t;
    renderSidebar();
}

export { refreshLists };
