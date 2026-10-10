// 给前端卡和酒馆助手脚本用的聊天操作：读写楼层、斜杠命令子集。数据形状与酒馆助手的 ChatMessage 一致。
import { state, eventSource, event_types, saveSettings, saveChat } from './state.js';
import { getSession, newChat, addUserMessage, addNarratorMessage, toggleHidden } from './controller.js';
import { generate, generateQuiet } from './generate.js';
import { renderChat, appendMessage, renderMessage } from './ui/chat.js';
import { refreshSnapshots } from './ui/frontend.js';
import { rerenderIfActive } from './ui/panels/index.js';
import { toast } from './ui/dom.js';
import { messageText, ensureSwipes, setSwipe } from './core/chat.js';
import { getPath, setPath, humanizedDate, clone } from './core/util.js';

/** 酒馆助手的口径：旁白 / 注释算 system，隐藏与否另看 is_hidden */
export function roleOf(m) {
    if (m.is_user) return 'user';
    return m.extra?.type === 'narrator' || m.extra?.type === 'comment' ? 'system' : 'assistant';
}

const roleToFields = (role) => ({ is_user: role === 'user', is_system: false });

const swipeVars = (m, sid = m.swipe_id ?? 0) => (Array.isArray(m.variables) ? m.variables[sid] : null) ?? {};

export function toChatMessage(m, i) {
    return {
        message_id: i,
        name: m.name,
        role: roleOf(m),
        is_hidden: !!m.is_system,
        message: messageText(m),
        data: clone(swipeVars(m)),
        extra: clone(m.extra ?? {}),
    };
}

function toChatMessageSwiped(m, i) {
    const swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes.slice() : [messageText(m)];
    const sid = Math.min(m.swipe_id ?? 0, swipes.length - 1);
    swipes[sid] = messageText(m);
    return {
        message_id: i,
        name: m.name,
        role: roleOf(m),
        is_hidden: !!m.is_system,
        swipe_id: sid,
        swipes,
        swipes_data: swipes.map((_, k) => clone(swipeVars(m, k))),
        swipes_info: swipes.map((_, k) => clone(m.swipe_info?.[k] ?? {})),
    };
}

/** 楼层号 / 范围（'3'、'0-5'、-1、'0-{{lastMessageId}}'）→ [起, 止]；超出范围返回 null */
export function parseRange(range, last) {
    if (range === undefined || range === null || range === '') return last >= 0 ? [0, last] : null;
    const norm = (n) => (n < 0 ? last + 1 + n : n);
    let a, b;
    if (typeof range === 'number') a = b = norm(range);
    else {
        const s = String(range).replace(/\{\{lastMessageId\}\}/gi, String(last)).trim();
        const m = s.match(/^(-?\d+)(?:\s*-\s*(-?\d+))?$/);
        if (!m) return null;
        a = norm(Number(m[1]));
        b = m[2] !== undefined ? norm(Number(m[2])) : a;
    }
    const lo = Math.max(0, Math.min(a, b)), hi = Math.min(last, Math.max(a, b));
    return lo > hi ? null : [lo, hi];
}

export function getChatMessages(range, opt = {}) {
    const chat = state.chat?.messages ?? [];
    const r = parseRange(range, chat.length - 1);
    if (!r) return [];
    const out = [];
    for (let i = r[0]; i <= r[1]; i++) {
        const m = chat[i];
        if (opt.role && opt.role !== 'all' && roleOf(m) !== opt.role) continue;
        if (opt.hide_state === 'hidden' && !m.is_system) continue;
        if (opt.hide_state === 'unhidden' && m.is_system) continue;
        out.push(opt.include_swipes ? toChatMessageSwiped(m, i) : toChatMessage(m, i));
    }
    return out;
}

function afterChange(touched, refresh) {
    getSession()?.vars.invalidate();
    saveChat();
    if (refresh === 'all') renderChat();
    else if (refresh !== 'none') for (const id of touched) renderMessage(id);
    refreshSnapshots();
    rerenderIfActive('vars');
}

export async function createChatMessages(msgs, opt = {}) {
    if (!state.chat) throw new Error('没有打开的聊天');
    const session = getSession();
    const chat = state.chat.messages;
    const where = opt.insert_before ?? opt.insert_at;
    let at = where === undefined || where === 'end' ? chat.length : Number(where);
    if (at < 0) at = chat.length + at;
    at = Math.max(0, Math.min(chat.length, at));
    const created = (Array.isArray(msgs) ? msgs : [msgs]).map(m => {
        const role = m.role ?? 'assistant';
        const name = m.name ?? (role === 'user' ? session.names.user : role === 'system' ? 'System' : session.names.char);
        const msg = { name, ...roleToFields(role), send_date: humanizedDate(), mes: String(m.message ?? ''), extra: { ...(role === 'system' ? { type: 'narrator' } : {}), ...(m.extra ?? {}) } };
        if (role === 'assistant') { msg.swipes = [msg.mes]; msg.swipe_id = 0; msg.swipe_info = [{ send_date: msg.send_date, extra: {} }]; }
        if (m.is_hidden) msg.is_system = true;
        if (m.data) msg.variables = [clone(m.data)];
        return msg;
    });
    chat.splice(at, 0, ...created);
    const appended = at === chat.length - created.length;
    getSession()?.vars.invalidate();
    saveChat();
    if (opt.refresh !== 'none') {
        if (appended && opt.refresh !== 'all') for (let i = at; i < chat.length; i++) appendMessage(i);
        else renderChat();
    }
    for (let i = at; i < at + created.length; i++) await eventSource.emit(event_types.MESSAGE_UPDATED, i);
    refreshSnapshots();
    return null;
}

export async function setChatMessages(list, opt = {}) {
    const chat = state.chat?.messages;
    if (!chat) throw new Error('没有打开的聊天');
    const touched = [];
    for (const m of (Array.isArray(list) ? list : [list])) {
        let id = Number(m?.message_id);
        if (id < 0) id += chat.length;
        const msg = chat[id];
        if (!msg) continue;
        if (Array.isArray(m.swipes)) {
            msg.swipes = m.swipes.map(String);
            msg.swipe_info = (msg.swipe_info ?? []).slice(0, msg.swipes.length);
            ensureSwipes(msg);
            msg.mes = msg.swipes[msg.swipe_id];
        }
        if (Array.isArray(m.swipes_data)) msg.variables = clone(m.swipes_data);
        if (Array.isArray(m.swipes_info)) msg.swipe_info = clone(m.swipes_info);
        if (m.swipe_id !== undefined && Number(m.swipe_id) !== (msg.swipe_id ?? 0)) setSwipe(msg, Number(m.swipe_id));
        if (m.message !== undefined) {
            msg.mes = String(m.message);
            if (Array.isArray(msg.swipes)) msg.swipes[msg.swipe_id ?? 0] = msg.mes;
        }
        if (m.name !== undefined) msg.name = m.name;
        if (m.role !== undefined && m.role !== roleOf(msg)) {
            msg.is_user = m.role === 'user';
            if (m.role === 'system') msg.extra = { ...(msg.extra ?? {}), type: 'narrator' };
            else if (msg.extra?.type === 'narrator') delete msg.extra.type;
        }
        if (m.is_hidden !== undefined) msg.is_system = !!m.is_hidden;
        if (m.data !== undefined) {
            if (!Array.isArray(msg.variables)) msg.variables = [];
            msg.variables[msg.swipe_id ?? 0] = clone(m.data);
        }
        if (m.extra !== undefined) msg.extra = clone(m.extra);
        touched.push(id);
    }
    afterChange(touched, opt.refresh ?? 'affected');
    for (const id of touched) await eventSource.emit(event_types.MESSAGE_UPDATED, id);
    return null;
}

export async function deleteChatMessages(ids, opt = {}) {
    const chat = state.chat?.messages;
    if (!chat) throw new Error('没有打开的聊天');
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).map(i => (i < 0 ? i + chat.length : i)))]
        .filter(i => i >= 0 && i < chat.length).sort((a, b) => b - a);
    if (!list.length) return null;
    for (const i of list) chat.splice(i, 1);
    getSession()?.vars.invalidate();
    saveChat();
    if (opt.refresh !== 'none') renderChat();
    await eventSource.emit(event_types.MESSAGE_DELETED, list[list.length - 1] ?? 0);
    refreshSnapshots();
    return null;
}

/** [begin, middle) [middle, end) → [middle, end) [begin, middle) */
export async function rotateChatMessages(begin, middle, end, opt = {}) {
    const chat = state.chat?.messages;
    if (!chat) throw new Error('没有打开的聊天');
    const b = Math.max(0, Number(begin)), e = Math.min(chat.length, Number(end)), mid = Number(middle);
    if (!(b <= mid && mid <= e)) throw new Error('楼层范围不对');
    const part = chat.slice(b, e);
    chat.splice(b, e - b, ...part.slice(mid - b), ...part.slice(0, mid - b));
    getSession()?.vars.invalidate();
    saveChat();
    if (opt.refresh !== 'none') renderChat();
    refreshSnapshots();
    return null;
}

// ---------- 斜杠命令子集 ----------

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
    const r = parseRange(String(text).trim(), state.chat.messages.length - 1);
    if (!r) return [];
    const out = [];
    for (let i = r[0]; i <= r[1]; i++) out.push(i);
    return out;
}

export async function triggerSlash(command) {
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
            case 'pass': pipe = session.substitute(text); break;
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

/** 变量被前端卡 / 脚本改了之后：落盘、通知、刷新 */
export async function onVariablesChanged(type) {
    if (type === 'global') saveSettings(); else saveChat();
    await eventSource.emit(event_types.VARIABLES_UPDATED, type);
    refreshSnapshots();
    rerenderIfActive('vars');
}
