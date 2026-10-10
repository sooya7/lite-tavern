// 应用动作：选角色、开/建聊天、构建会话、消息增删改。UI 模块都通过这里改状态。
import { api } from './api.js';
import { state, eventSource, event_types, saveChat, saveSettings, ensurePreset, loadWorld, activePersona, refreshLists, flushPending } from './state.js';
import { ChatSession } from './core/session.js';
import { parseChatJsonl, newChatHeader, createGreetingMessage, createUserMessage, newChatName, messageText, syncSwipe } from './core/chat.js';
import { cardGreetings } from './core/card.js';
import { clone } from './core/util.js';
import { toast } from './ui/dom.js';

let ui = {};
/** UI 层注册的刷新函数：renderSidebar / renderChat / renderTopbar / renderPanels / renderMessage */
export function bindUI(fns) {
    ui = { ...ui, ...fns };
}
export const refresh = (what = ['sidebar', 'chat', 'topbar', 'panels']) => {
    for (const w of [].concat(what)) ui[w]?.();
};

/** 当前聊天的会话对象（设置/预设/卡变了就重建，很便宜） */
export function getSession() {
    if (!state.char || !state.chat || !state.preset) return null;
    const s = state.session;
    const persona = activePersona();
    const conn = state.settings.connections.find(c => c.id === state.settings.activeConnection);
    if (s && s.chat === state.chat.messages && s.card === state.char.card && s.preset === state.preset.data && s.meta === state.chat.header.chat_metadata) {
        s.persona = persona;
        s.settings = state.settings;
        s.power = { ...s.power, ...state.settings.power };
        s.worlds = state.worlds;
        s.model = conn?.model ?? '';
        return s;
    }
    state.session = new ChatSession({
        card: state.char.card,
        cardFile: state.char.id,
        persona,
        preset: state.preset.data,
        chat: state.chat.messages,
        meta: state.chat.header.chat_metadata,
        chatId: state.chat.name,
        settings: state.settings,
        worlds: state.worlds,
        model: conn?.model ?? '',
    });
    state.session.templateGlobals = { _: window._, toastr: toastrShim, SillyTavern: { getContext: () => window.SillyTavern?.getContext?.() } };
    return state.session;
}

const toastrShim = {
    info: (m) => toast(m, 'info'), success: (m) => toast(m, 'success'), warning: (m) => toast(m, 'warning'), error: (m) => toast(m, 'error'),
};

/** 把当前会话会用到的世界书都加载进来 */
export async function loadRelevantWorlds() {
    const names = new Set(state.settings.worldInfo?.globalSelect ?? []);
    const linked = state.char?.card?.data?.extensions?.world;
    if (linked) names.add(linked);
    for (const n of state.settings.worldInfo?.charLore?.[state.char?.id] ?? []) names.add(n);
    const chatWorld = state.chat?.header?.chat_metadata?.world_info;
    if (chatWorld) names.add(chatWorld);
    const pl = activePersona()?.lorebook;
    if (pl) names.add(pl);
    await Promise.all([...names].map(n => loadWorld(n)));
}

export async function selectCharacter(file, { openLatest = true } = {}) {
    if (state.generating) { toast('正在生成，先停止再切换', 'warning'); return; }
    await flushPending();
    const card = await api.getCharacter(file);
    const id = file.replace(/\.(png|json)$/i, '');
    state.char = { file, id, card };
    state.view = 'chat';
    state.chat = null;
    state.session = null;
    state.chatList = await api.listChats(id);
    await loadRelevantWorlds();
    await eventSource.emit(event_types.CHARACTER_SELECTED, state.char);
    if (openLatest && state.chatList.length) await openChat(state.chatList[0].name);
    else if (openLatest) await newChat();
    refresh();
}

export async function openChat(name) {
    if (!state.char) return;
    if (state.generating) { toast('正在生成，先停止再切换', 'warning'); return; }
    await flushPending();
    const text = await api.getChat(state.char.id, name);
    const { header, messages } = parseChatJsonl(text);
    state.chat = { name, header, messages };
    state.session = null;
    state.view = 'chat';
    state.settings.lastChat = { file: state.char.file, chat: name };
    saveSettings();
    await loadRelevantWorlds();
    const s = getSession();
    if (s?.ensureMvuInit()) saveChat();
    await eventSource.emit(event_types.CHAT_CHANGED, name);
    refresh(['chat', 'topbar', 'sidebar', 'panels']);
}

export async function newChat({ greetingIndex = 0 } = {}) {
    if (!state.char) return;
    await flushPending();
    const persona = activePersona();
    const card = state.char.card;
    const name = newChatName(card.data.name);
    const header = newChatHeader(persona.name, card.data.name);
    const messages = [];
    const greetings = cardGreetings(card);
    if (greetings.some(g => g)) {
        const g = createGreetingMessage(card.data.name, greetings);
        if (greetingIndex) { g.swipe_id = greetingIndex; g.mes = g.swipes[greetingIndex]; }
        messages.push(g);
    }
    state.chat = { name, header, messages };
    state.session = null;
    const s = getSession();
    // 开场白里的宏在创建时替换（与酒馆一致）
    for (const m of messages) {
        m.swipes = m.swipes.map(t => s.substitute(t));
        m.mes = m.swipes[m.swipe_id ?? 0];
    }
    s.ensureMvuInit();
    await api.saveChat(state.char.id, name, (await import('./core/chat.js')).serializeChat(header, messages));
    state.chatList = await api.listChats(state.char.id);
    state.view = 'chat';
    state.settings.lastChat = { file: state.char.file, chat: name };
    saveSettings();
    await eventSource.emit(event_types.CHAT_CHANGED, name);
    refresh(['chat', 'topbar', 'sidebar', 'panels']);
}

/** 从某条消息分叉出新聊天 */
export async function branchChat(index) {
    if (!state.chat) return;
    await flushPending();
    const name = `${state.chat.name} 分支 ${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}`;
    const header = clone(state.chat.header);
    header.chat_metadata = { ...header.chat_metadata, main_chat: state.chat.name };
    const messages = clone(state.chat.messages.slice(0, index + 1));
    const { serializeChat } = await import('./core/chat.js');
    await api.saveChat(state.char.id, name, serializeChat(header, messages));
    state.chatList = await api.listChats(state.char.id);
    await openChat(name);
    toast('已从这里开出分支聊天', 'success');
}

export async function addUserMessage(text, { substitute = true } = {}) {
    const s = getSession();
    const persona = activePersona();
    let mes = s.processIncoming(text, true);
    if (substitute) mes = s.substitute(mes);
    const msg = createUserMessage(persona.name, mes);
    if (persona.avatar) msg.force_avatar = api.personaAvatarUrl(persona.avatar);
    state.chat.messages.push(msg);
    s.vars.invalidate();
    ui.appendMessage?.(state.chat.messages.length - 1);
    await eventSource.emit(event_types.MESSAGE_SENT, state.chat.messages.length - 1);
    saveChat();
    return msg;
}

export async function addNarratorMessage(text) {
    state.chat.messages.push({ name: '旁白', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: text, extra: { type: 'narrator' } });
    ui.appendMessage?.(state.chat.messages.length - 1);
    saveChat();
}

export async function editMessage(index, text) {
    const m = state.chat.messages[index];
    if (!m) return;
    const s = getSession();
    m.mes = s.processEdited(text, m.is_user);
    if (Array.isArray(m.swipes)) syncSwipe(m);
    if (!m.is_user && s.mvuEnabled()) s.applyMvu(index);
    s.vars.invalidate();
    await eventSource.emit(event_types.MESSAGE_EDITED, index);
    ui.renderMessage?.(index);
    saveChat();
}

export async function deleteMessages(from, to = from) {
    state.chat.messages.splice(from, to - from + 1);
    getSession()?.vars.invalidate();
    await eventSource.emit(event_types.MESSAGE_DELETED, from);
    ui.renderChat?.();
    saveChat();
}

export function toggleHidden(index) {
    const m = state.chat.messages[index];
    m.is_system = !m.is_system;
    getSession()?.vars.invalidate();
    ui.renderMessage?.(index);
    saveChat();
}

export async function reloadCharacters() {
    await refreshLists();
    refresh('sidebar');
}

export async function setPreset(name) {
    await flushPending();
    state.settings.activePreset = name;
    state.preset = null;
    await ensurePreset();
    state.session = null;
    saveSettings();
    await eventSource.emit(event_types.PRESET_CHANGED, name);
    refresh(['panels', 'topbar']);
}

export { messageText };
