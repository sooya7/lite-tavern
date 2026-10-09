// 聊天记录：与酒馆 JSONL 完全兼容（第一行是元数据，之后每行一条消息），未知字段原样保留。
import { humanizedDate, humanizedDateTime, clone } from './util.js';

export function newChatHeader(userName, charName) {
    return {
        user_name: userName,
        character_name: charName,
        create_date: humanizedDateTime(),
        chat_metadata: {},
    };
}

export function parseChatJsonl(text) {
    const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { header: newChatHeader('User', ''), messages: [] };
    const first = JSON.parse(lines[0]);
    let header, rest;
    if (first && (first.chat_metadata !== undefined || first.user_name !== undefined) && first.mes === undefined) {
        header = first;
        rest = lines.slice(1);
    } else {
        header = newChatHeader('User', first?.name ?? '');
        rest = lines;
    }
    if (!header.chat_metadata || typeof header.chat_metadata !== 'object') header.chat_metadata = {};
    const messages = [];
    for (const l of rest) {
        try { messages.push(JSON.parse(l)); } catch { /* 跳过坏行 */ }
    }
    return { header, messages };
}

export function serializeChat(header, messages) {
    return [JSON.stringify(header), ...messages.map(m => JSON.stringify(m))].join('\n') + '\n';
}

// 与酒馆一致：mes 永远是当前显示的版本（swipes[swipe_id] 只在切换/生成结束时同步）
export const messageText = (m) => (m ? (typeof m.mes === 'string' ? m.mes : (Array.isArray(m.swipes) ? m.swipes[m.swipe_id ?? 0] : '')) ?? '' : '');

export function createUserMessage(name, text, extra = {}) {
    return {
        name,
        is_user: true,
        is_system: false,
        send_date: humanizedDate(),
        mes: text,
        extra: { ...extra },
    };
}

export function createAssistantMessage(name, text = '', extra = {}) {
    const now = humanizedDate();
    return {
        name,
        is_user: false,
        is_system: false,
        send_date: now,
        mes: text,
        extra: { ...extra },
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ send_date: now, extra: { ...extra } }],
    };
}

/** 开场白消息（多开场白做成 swipes） */
export function createGreetingMessage(name, greetings) {
    const list = greetings.length ? greetings : [''];
    const now = humanizedDate();
    return {
        name,
        is_user: false,
        is_system: false,
        send_date: now,
        mes: list[0],
        extra: {},
        swipe_id: 0,
        swipes: list.slice(),
        swipe_info: list.map(() => ({ send_date: now, extra: {} })),
    };
}

export function ensureSwipes(m) {
    if (!Array.isArray(m.swipes) || !m.swipes.length) {
        m.swipes = [m.mes ?? ''];
        m.swipe_id = 0;
    }
    if (!Array.isArray(m.swipe_info)) m.swipe_info = [];
    while (m.swipe_info.length < m.swipes.length) m.swipe_info.push({ send_date: m.send_date, extra: clone(m.extra ?? {}) });
    if (m.swipe_id === undefined || m.swipe_id >= m.swipes.length) m.swipe_id = 0;
    return m;
}

/** 当前 swipe 的文本/extra 写回 swipes/swipe_info */
export function syncSwipe(m) {
    if (!Array.isArray(m.swipes)) return m;
    ensureSwipes(m);
    m.swipes[m.swipe_id] = m.mes;
    m.swipe_info[m.swipe_id] = { ...(m.swipe_info[m.swipe_id] ?? {}), send_date: m.send_date, extra: clone(m.extra ?? {}) };
    return m;
}

export function setSwipe(m, idx) {
    ensureSwipes(m);
    syncSwipe(m);
    m.swipe_id = Math.max(0, Math.min(idx, m.swipes.length - 1));
    m.mes = m.swipes[m.swipe_id];
    const info = m.swipe_info[m.swipe_id] ?? {};
    if (info.send_date) m.send_date = info.send_date;
    m.extra = clone(info.extra ?? {});
    return m;
}

export function addSwipe(m, text = '', extra = {}) {
    ensureSwipes(m);
    syncSwipe(m);
    m.swipes.push(text);
    const now = humanizedDate();
    m.swipe_info.push({ send_date: now, extra: { ...extra } });
    m.swipe_id = m.swipes.length - 1;
    m.mes = text;
    m.send_date = now;
    m.extra = { ...extra };
    return m;
}

export function deleteSwipe(m, idx = m.swipe_id) {
    ensureSwipes(m);
    if (m.swipes.length <= 1) return false;
    m.swipes.splice(idx, 1);
    m.swipe_info.splice(idx, 1);
    if (Array.isArray(m.variables)) m.variables.splice(idx, 1);
    m.swipe_id = Math.min(m.swipe_id, m.swipes.length - 1);
    m.mes = m.swipes[m.swipe_id];
    m.extra = clone(m.swipe_info[m.swipe_id]?.extra ?? {});
    return true;
}

export const isNarrator = (m) => m?.extra?.type === 'narrator';

/** 聊天文件名（不含 .jsonl） */
export function newChatName(charName) {
    return `${charName} - ${humanizedDateTime()}`;
}
