// 左栏：新聊天 / 角色库入口、最近角色、当前角色的聊天记录、底部用户设定。
// 这里只放“去哪儿”：导入和新建角色在角色库页，其余设置都在右侧设置面板（每个功能只留一个入口）。
import { h, $, clear, icon, iconBtn, toast, confirmDialog, promptDialog, popupMenu, pickFiles, formatTime, downloadText, brandMark } from './dom.js';
import { state, saveSettings, refreshLists, activePersona, eventSource, flushPending } from '../state.js';
import { api } from '../api.js';
import { selectCharacter, openChat, newChat, reloadCharacters, refresh } from '../controller.js';
import { importFiles, classifyJson } from './importers.js';
import { newCard, normalizeCard } from '../core/card.js';
import { isPng, readCardJson } from '../core/png.js';
import { cardGreetings } from '../core/card.js';
import { charAvatar, personaAvatar } from './avatars.js';
import { setHomeTab } from './library.js';

const RECENT_CHARS = 6;

const isNarrow = () => matchMedia('(max-width: 760px)').matches;
export function closeOnMobile() {
    if (isNarrow()) window.dispatchEvent(new CustomEvent('lt:toggle-left', { detail: false }));
}
const openPanel = (id) => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: id }));

/** 回到首页（问候 + 角色库） */
/** @param {'recent'|'library'} [tab] 首页的哪个标签，默认“最近聊天” */
export function goHome(tab = 'recent') {
    setHomeTab(tab);
    state.view = 'home';
    refresh(['chat', 'topbar', 'sidebar']);
    closeOnMobile();
}

/** 酒馆默认的聊天名是“角色名 - 2026-10-09@22h37m12s”，列表里显示成日期 */
export function chatTitle(name, charName = state.char?.card?.data?.name) {
    let n = String(name ?? '');
    if (charName && n.startsWith(`${charName} - `)) n = n.slice(charName.length + 3);
    const m = n.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m(?:\s*\d{1,2}s)?(?:\s*\d+ms)?$/);
    if (!m) return n || String(name ?? '');
    const p = (x) => String(x).padStart(2, '0');
    const sameYear = Number(m[1]) === new Date().getFullYear();
    return `${sameYear ? '' : `${m[1]}年`}${Number(m[2])}月${Number(m[3])}日 ${p(m[4])}:${p(m[5])}`;
}

/** 消息预览：去掉标签、代码块和多余空白 */
export function plainSnippet(text, max = 80) {
    return String(text ?? '')
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

export async function startNewChat(anchor) {
    if (!state.char) { goHome('library'); return; }
    const greetings = cardGreetings(state.char.card);
    if (greetings.filter(Boolean).length > 1 && anchor) {
        popupMenu(anchor, greetings.map((g, i) => ({
            label: `${i === 0 ? '默认开场白' : `备选开场白 ${i}`}：${plainSnippet(g, 24)}…`,
            onClick: async () => { await newChat({ greetingIndex: i }); closeOnMobile(); },
        })));
        return;
    }
    await newChat();
    closeOnMobile();
}

export function renderSidebar() {
    const root = $('#left');
    if (!root) return;
    const listScroll = root.querySelector('.side-list')?.scrollTop ?? 0;
    clear(root);
    const home = state.view === 'home' || !state.char;
    const charName = state.char?.card?.data?.name ?? '';
    const list = h('div', { class: 'side-list' });
    root.append(
        h('div', { class: 'side-head' },
            h('div', { class: 'brand' }, brandMark(), '轻酒馆'),
            iconBtn(isNarrow() ? 'x' : 'panelLeft', '收起侧栏', () => window.dispatchEvent(new CustomEvent('lt:toggle-left', { detail: false }))),
        ),
        h('div', { class: 'side-nav' },
            h('button', {
                class: 'nav-item new-chat',
                title: state.char ? `和「${charName}」开始新聊天` : '先选一个角色',
                onclick: (e) => startNewChat(e.currentTarget),
            }, h('span', { class: 'nc-ic' }, icon('plus')), '新聊天'),
            h('button', { class: `nav-item ${home ? 'active' : ''}`, onclick: () => goHome('recent') }, icon('home'), '首页'),
        ),
        list,
        sideFoot(),
    );
    renderRecentChars(list);
    if (state.char) renderChats(list);
    list.scrollTop = listScroll;
}

function sideFoot() {
    const p = activePersona();
    return h('div', { class: 'side-foot' },
        h('button', { class: 'persona-row', title: '用户设定（你在故事里的身份）', onclick: () => { openPanel('persona'); } },
            personaAvatar(p),
            h('div', { class: 'grow' },
                h('div', { class: 'p-name' }, p.name || 'User'),
                h('div', { class: 'p-sub' }, `用户设定${state.settings.personas.length > 1 ? ` · 共 ${state.settings.personas.length} 个` : ''}`)),
            icon('right', 'p-go')));
}

function charSort(a, b) {
    if (!!b.fav - !!a.fav) return !!b.fav - !!a.fav;
    const la = Math.max(a.lastChat ?? 0, a.mtime ?? 0), lb = Math.max(b.lastChat ?? 0, b.mtime ?? 0);
    return lb - la;
}

function renderRecentChars(list) {
    const all = [...state.characters].sort(charSort);
    let items = all.slice(0, RECENT_CHARS);
    const cur = state.char && all.find(c => c.file === state.char.file);
    if (cur && !items.includes(cur)) items = [cur, ...items.slice(0, RECENT_CHARS - 1)];
    list.append(h('div', { class: 'section-title' },
        h('span', { class: 'grow' }, '最近角色'),
        h('button', { class: 'section-link', onclick: () => goHome('library') }, `全部 ${all.length}`)));
    if (!items.length) {
        list.append(h('div', { class: 'empty small', style: { padding: '12px' } }, '还没有角色，去角色库导入或新建一个'));
        return;
    }
    for (const c of items) list.append(charItem(c));
}

function charItem(c) {
    const active = state.char?.file === c.file && state.view !== 'home';
    const el = h('div', {
        class: `char-item ${active ? 'active' : ''}`,
        title: c.error ? `读取失败：${c.error}` : c.name,
        onclick: async () => {
            if (c.error) return;
            if (state.char?.file !== c.file) await selectCharacter(c.file);
            else if (state.view === 'home') { state.view = 'chat'; refresh(['chat', 'topbar', 'sidebar']); }
            closeOnMobile();
        },
        oncontextmenu: (e) => { e.preventDefault(); charMenu(el, c); },
    },
    charAvatar(c.error ? '' : c.file, 'avatar', { name: c.name }),
    h('div', { class: 'char-meta' },
        h('div', { class: 'char-name' }, c.fav ? h('span', { class: 'fav-star' }, '★') : null, c.name)),
    iconBtn('more', '更多', (e) => { e.stopPropagation(); charMenu(e.currentTarget, c); }),
    );
    return el;
}

export function charMenu(anchor, c) {
    popupMenu(anchor, [
        { label: '编辑角色卡', icon: 'edit', onClick: async () => { if (state.char?.file !== c.file) await selectCharacter(c.file); openPanel('char'); } },
        { label: c.fav ? '取消收藏' : '收藏', icon: 'star', onClick: () => toggleFav(c) },
        { label: '用新版卡文件更新…', icon: 'upload', onClick: () => updateChar(c) },
        { label: '从链接更新…', icon: 'link', onClick: () => updateCharFromUrl(c) },
        { label: '导出 PNG 卡', icon: 'download', onClick: () => window.open(api.exportCharacterUrl(c.file, 'png'), '_blank') },
        { label: '导出 JSON', icon: 'download', onClick: () => window.open(api.exportCharacterUrl(c.file, 'json'), '_blank') },
        '-',
        { label: '删除角色', icon: 'trash', danger: true, onClick: () => deleteChar(c) },
    ]);
}

/** 读一下选中的文件是不是角色卡，取出名字、版本、有没有自带世界书（给确认框用） */
async function peekCardFile(f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const png = isPng(bytes);
    const raw = JSON.parse(png ? readCardJson(bytes) : new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
    if (classifyJson(raw) !== 'card') throw new Error('不是角色卡');
    const d = normalizeCard(raw).data;
    if (!d.name) throw new Error('卡里没有名字');
    return { png, name: d.name, version: d.character_version ?? '', hasBook: !!d.character_book?.entries?.length };
}

/**
 * 用新版的卡文件更新这张卡：卡的内容和自带世界书直接覆盖，聊天记录保留，不留备份（2026-10-10 用户定的）。
 * 覆盖了找不回来，所以先读出新文件里的卡名给用户确认一眼，免得选错文件。
 */
async function updateChar(c) {
    if (updateBlocked(c)) return;
    const [f] = await pickFiles({ accept: '.png,.json' });
    if (f) await applyCardUpdate(c, f);
}

/**
 * 从链接更新：粘贴 Discord 里卡片文件的链接，服务器把文件下回来，后面和选本地文件一样。
 * Discord 的附件链接大约一天就失效，所以不记链接，每次粘新的。
 */
async function updateCharFromUrl(c) {
    if (updateBlocked(c)) return;
    const f = await downloadCardFromLink(`从链接更新「${c.name}」`);
    if (!f) return;
    await applyCardUpdate(c, f);
}

const updateBlocked = (c) => {
    if (state.char?.file === c.file && state.generating) { toast('正在生成，等这条回复结束再更新', 'warning'); return true; }
    return false;
};

async function applyCardUpdate(c, f) {
    const current = state.char?.file === c.file;
    let info;
    try {
        info = await peekCardFile(f);
    } catch (e) {
        toast(`${f.name} 不是角色卡，没有更新`, 'error');
        return;
    }
    const ver = (v) => (v ? `（版本 ${v}）` : '');
    const ok = await confirmDialog(
        `用「${info.name}」${ver(info.version)}覆盖现在的「${c.name}」${ver(c.version)}？\n\n`
        + `设定、开场白、自带的正则和脚本${info.png ? '、头像' : ''}都换成新版的${info.hasBook ? '，卡自带的世界书也直接覆盖' : ''}。聊天记录保留。\n`
        + '不留备份，覆盖后找不回旧版。',
        { danger: true, okLabel: '覆盖' });
    if (!ok) return;
    try {
        await flushPending(); // 这张卡要是还有没存的编辑，先落盘，免得更新之后又被旧内容盖回去
        const r = await api.updateCharacter(c.file, f);
        const extra = [
            r.world ? `世界书「${r.world}」${r.worldReplaced ? '已覆盖' : '已添加并绑定'}` : '',
            r.scripts ? `${r.scripts} 个脚本` : '',
            r.regex ? `${r.regex} 条正则` : '',
        ].filter(Boolean);
        toast(`已更新为「${r.name}」${ver(r.version)}${extra.length ? `：${extra.join('，')}` : ''}`, 'success', 5000);
        await reloadCharacters();
        if (current) await selectCharacter(c.file, { stay: state.view !== 'chat' });
    } catch (e) {
        toast(`更新失败：${e.message}`, 'error');
    }
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
        eventSource.emit('characterDeleted', { id: c.file, character: { name: c.name, avatar: c.file } });
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

/** “导入”按钮：点开选从文件还是从链接（入口还是这一个，不另外加按钮） */
export function onImport(e) {
    const anchor = e?.currentTarget;
    if (!anchor) { importFromFiles(); return; }
    popupMenu(anchor, [
        { label: '从文件导入', icon: 'upload', onClick: importFromFiles },
        { label: '从 Discord 链接导入', icon: 'link', onClick: importFromUrl },
    ]);
}

async function importFromFiles() {
    const files = await pickFiles({ accept: '.png,.json,.jsonl', multiple: true });
    if (files.length) await importFiles(files);
}

/** 粘贴 Discord 里卡片文件的链接，服务器下回来后和选本地文件一样导入成一张新卡 */
async function importFromUrl() {
    const f = await downloadCardFromLink('从链接导入角色卡');
    if (f) await importFiles([f]);
}

/** 问链接、让服务器下载，返回 File；取消或失败返回 null（失败已经提示过） */
async function downloadCardFromLink(title) {
    const url = await promptDialog('粘贴卡片文件的链接：\n在 Discord 里长按（电脑上右键）那个卡片文件，选“复制链接”。', '', { title, placeholder: 'https://cdn.discordapp.com/attachments/…' });
    if (!url?.trim()) return null;
    const tip = toast('正在下载…', 'info', 60000);
    try {
        return await api.fetchCardUrl(url.trim());
    } catch (e) {
        toast(`没下下来：${e.message}`, 'error', 8000);
        return null;
    } finally {
        tip?.remove?.();
    }
}

export async function onCreate() {
    const name = await promptDialog('角色名字：', '', { title: '新建角色' });
    if (!name?.trim()) return;
    try {
        const card = newCard(name.trim());
        const { file } = await api.createCharacter(card);
        await reloadCharacters();
        await selectCharacter(file);
        openPanel('char');
    } catch (e) {
        toast(`创建失败：${e.message}`, 'error');
    }
}

// ---------- 聊天记录 ----------
function renderChats(list) {
    const name = state.char.card.data.name;
    list.append(h('div', { class: 'section-title' },
        h('span', { class: 'grow' }, `${name} 的聊天`),
        h('span', {}, state.chatList.length || '')));
    if (!state.chatList.length) list.append(h('div', { class: 'empty small', style: { padding: '10px' } }, '还没有聊天'));
    for (const c of state.chatList) {
        const active = state.chat?.name === c.name && state.view !== 'home';
        // 当前打开的聊天用内存里的消息，列表接口的条数和预览是打开那一刻的
        const open = state.chat?.name === c.name ? state.chat.messages : null;
        const count = open ? open.length : c.count;
        const snippet = plainSnippet(open ? open[open.length - 1]?.mes : c.last, 60);
        const el = h('div', {
            class: `chat-item ${active ? 'active' : ''}`,
            title: c.name,
            onclick: async () => {
                if (state.chat?.name !== c.name) await openChat(c.name);
                else if (state.view === 'home') { state.view = 'chat'; refresh(['chat', 'topbar', 'sidebar']); }
                closeOnMobile();
            },
            oncontextmenu: (e) => { e.preventDefault(); chatMenu(el, c); },
        },
        h('div', { class: 'grow' },
            h('div', { class: 't' }, chatTitle(c.name, name)),
            h('div', { class: 'd' }, [count >= 0 ? `${count} 条` : '', formatTime(open ? Date.now() : c.mtime), snippet].filter(Boolean).join(' · '))),
        iconBtn('more', '更多', (e) => { e.stopPropagation(); chatMenu(e.currentTarget, c); }),
        );
        list.append(el);
    }
}

export function chatMenu(anchor, c) {
    popupMenu(anchor, [
        { label: '重命名', icon: 'edit', onClick: () => renameChat(c) },
        { label: '导出 JSONL（酒馆可直接导入）', icon: 'download', onClick: () => exportChat(c) },
        '-',
        { label: '删除聊天', icon: 'trash', danger: true, onClick: () => deleteChat(c) },
    ]);
}

export async function renameChat(c) {
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

export async function exportChat(c) {
    try {
        const { text } = await api.getChat(state.char.id, c.name);
        downloadText(text, `${c.name}.jsonl`, 'application/jsonl');
    } catch (e) {
        toast(`导出失败：${e.message}`, 'error');
    }
}

export async function deleteChat(c) {
    if (!await confirmDialog(`删除聊天「${c.name}」？\n会移到数据目录的 trash 里。`, { danger: true, okLabel: '删除' })) return;
    try {
        await api.deleteChat(state.char.id, c.name);
        eventSource.emit('chat_deleted', c.name);
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

/** 旧接口：以前左栏有“角色 / 聊天记录”两个标签，现在合在一起了 */
export function setSidebarTab(t) {
    if (t === 'chars') goHome('library');
    else renderSidebar();
}

export { refreshLists };
