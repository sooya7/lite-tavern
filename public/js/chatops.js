// 给前端卡和酒馆助手脚本用的聊天操作：读写楼层、斜杠命令子集。数据形状与酒馆助手的 ChatMessage 一致。
import { state, eventSource, event_types, saveSettings, saveChat, activeConnection, activePersona, loadWorld, saveWorld } from './state.js';
import { getSession, newChat, addUserMessage, addNarratorMessage, toggleHidden, selectCharacter, setPreset, refresh } from './controller.js';
import { generate, generateQuiet, stopGeneration } from './generate.js';
import { renderChat, appendMessage, renderMessage } from './ui/chat.js';
import { refreshSnapshots } from './ui/frontend.js';
import { rerenderIfActive } from './ui/panels/index.js';
import { toast, h, modal, promptDialog, confirmDialog } from './ui/dom.js';
import { audioSlash } from './ui/audio.js';
import { estimateTokens } from './core/tokens.js';
import { newWorldInfoEntry } from './core/worldinfo.js';
import { messageText, ensureSwipes, setSwipe, addSwipe, deleteSwipe } from './core/chat.js';
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
            case 'setinput': {
                const el = document.getElementById('send_textarea');
                if (el) { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); }
                pipe = text;
                break;
            }
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
            default: {
                const r = await moreSlash(c, text, pipe, session);
                if (r === STOP) return pipe;
                if (r === undefined) {
                    toast(`前端调用了暂不支持的命令 /${c.name}`, 'warning');
                    console.warn('[斜杠命令] 不支持', seg);
                } else pipe = r;
            }
        }
    }
    refreshSnapshots();
    return pipe;
}

const STOP = Symbol('stop');
const num = (v) => { const n = Number(String(v ?? '').trim()); return Number.isFinite(n) ? n : 0; };
const toText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** 数学命令的参数：先看 key=value 里的变量名，再看空格分开的数字或变量名 */
function mathArgs(text, session) {
    return String(text ?? '').trim().split(/\s+/).filter(Boolean).map((t) => {
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        const v = getPath(session.vars.local(), t) ?? getPath(session.vars.global(), t);
        return num(v ?? t);
    });
}

async function worldEntry(file, uid) {
    const w = await loadWorld(String(file ?? ''));
    if (!w) throw new Error(`世界书「${file}」不存在`);
    return { w, e: uid === undefined ? null : w.entries[Number(uid)] ?? null };
}

/** 斜杠命令里不常用但脚本会用到的那一批。认识就返回新的管道值，STOP 表示到此为止，undefined 表示不认识 */
async function moreSlash(c, text, pipe, session) {
    const a = c.args;
    const audio = audioSlash(c.name, a, text);
    if (audio !== undefined) return audio;
    switch (c.name) {
        // ----- 生成 -----
        case 'impersonate': case 'imper': await generate('impersonate'); return '';
        case 'stop': return String(!!stopGeneration());
        case 'abort': if (a.quiet !== 'true' && text) toast(text, 'warning'); return STOP;
        case 'return': return STOP;
        // ----- 变量 -----
        case 'flushvar': case 'flushglobalvar': {
            const key = a.key ?? a.name ?? text;
            const scope = c.name === 'flushglobalvar' ? session.vars.global() : session.vars.local();
            if (key) delete scope[key];
            if (c.name === 'flushglobalvar') saveSettings(); else saveChat();
            session.vars.invalidate();
            return '';
        }
        case 'listvar': return JSON.stringify({ local: session.vars.local(), global: session.vars.global() });
        // ----- 文本 / 数学 -----
        case 'len': { try { const v = JSON.parse(text); return String(Array.isArray(v) ? v.length : typeof v === 'object' && v ? Object.keys(v).length : String(text).length); } catch { return String(String(text).length); } }
        case 'upper': return String(text).toUpperCase();
        case 'lower': return String(text).toLowerCase();
        case 'trim': return String(text).trim();
        case 'tokens': return String(estimateTokens(String(text)));
        case 'add': return String(mathArgs(text, session).reduce((x, y) => x + y, 0));
        case 'mul': return String(mathArgs(text, session).reduce((x, y) => x * y, 1));
        case 'sub': { const [x = 0, ...r] = mathArgs(text, session); return String(r.reduce((p, y) => p - y, x)); }
        case 'div': { const [x = 0, y = 1] = mathArgs(text, session); return String(y === 0 ? 0 : x / y); }
        case 'mod': { const [x = 0, y = 1] = mathArgs(text, session); return String(y === 0 ? 0 : x % y); }
        case 'pow': { const [x = 0, y = 1] = mathArgs(text, session); return String(x ** y); }
        case 'max': return String(Math.max(...mathArgs(text, session)));
        case 'min': return String(Math.min(...mathArgs(text, session)));
        case 'abs': return String(Math.abs(mathArgs(text, session)[0] ?? 0));
        case 'round': return String(Math.round(mathArgs(text, session)[0] ?? 0));
        case 'floor': return String(Math.floor(mathArgs(text, session)[0] ?? 0));
        case 'ceil': return String(Math.ceil(mathArgs(text, session)[0] ?? 0));
        case 'rand': {
            const from = a.from !== undefined ? num(a.from) : 0;
            const to = a.to !== undefined ? num(a.to) : (text ? num(text) : 1);
            const v = from + Math.random() * (to - from);
            return String(a.round === 'round' || a.round === 'floor' || a.round === 'ceil' ? Math[a.round](v) : v);
        }
        // ----- 对话框 -----
        case 'input': { const v = await promptDialog(text, a.default ?? '', { title: '输入' }); return v ?? ''; }
        case 'popup': case 'alert': await modal({ title: a.header ?? '', body: h('div', { style: { whiteSpace: 'pre-wrap' } }, text), actions: [{ label: a.okButton ?? '确定', value: true, primary: true }] }).done; return '';
        case 'confirm': return String(await confirmDialog(text, { title: a.header ?? '确认' }));
        case 'buttons': {
            let labels = [];
            try { labels = JSON.parse(a.labels ?? '[]'); } catch { labels = String(a.labels ?? '').split(',').map(x => x.trim()).filter(Boolean); }
            const v = await modal({ title: a.header ?? '', body: h('div', { style: { whiteSpace: 'pre-wrap' } }, text), actions: labels.map(l => ({ label: String(l), value: String(l) })) }).done;
            return v ?? '';
        }
        case 'delay': case 'wait': case 'sleep': await new Promise(r => setTimeout(r, Math.min(num(text || a.ms), 60000))); return pipe;
        // ----- 注入提示词 -----
        case 'inject': {
            const id = a.id ?? `slash_${Date.now()}`;
            const pos = { before: 2, after: 0, chat: 1, none: -1 }[a.position ?? 'after'] ?? 0;
            if (!text) { delete session.extensionPrompts[id]; return ''; }
            session.extensionPrompts[id] = { value: text, position: pos, depth: num(a.depth ?? 4), role: a.role ?? 'system', scan: a.scan === 'true' };
            return '';
        }
        case 'listinjects': return JSON.stringify(session.extensionPrompts);
        case 'flushinject': case 'flushinjects': {
            if (text) delete session.extensionPrompts[text]; else for (const k of Object.keys(session.extensionPrompts)) delete session.extensionPrompts[k];
            return '';
        }
        // ----- 连接、预设、角色、身份、聊天 -----
        case 'model': {
            const conn = activeConnection();
            if (!text) return conn?.model ?? '';
            if (conn) { conn.model = text.trim(); saveSettings(); refresh(['panels', 'topbar']); }
            return conn?.model ?? '';
        }
        case 'preset': {
            if (!text) return state.preset?.name ?? '';
            const hit = state.presetList.find(p => p.name === text.trim()) ?? state.presetList.find(p => p.name.toLowerCase().includes(text.trim().toLowerCase()));
            if (hit) await setPreset(hit.name);
            return state.preset?.name ?? '';
        }
        case 'go': case 'char': {
            const want = text.trim().toLowerCase();
            const hit = state.characters.find(x => x.name.toLowerCase() === want) ?? state.characters.find(x => x.name.toLowerCase().includes(want));
            if (!hit) { toast(`找不到角色「${text}」`, 'warning'); return ''; }
            await selectCharacter(hit.file);
            return hit.name;
        }
        case 'persona': {
            const want = text.trim();
            if (!want) return activePersona().name;
            const p = state.settings.personas.find(x => x.name === want) ?? state.settings.personas.find(x => x.name.includes(want));
            if (p) { state.settings.activePersona = p.id; state.session = null; saveSettings(); refresh(['panels', 'topbar', 'chat']); }
            return activePersona().name;
        }
        case 'getchatname': return state.chat?.name ?? '';
        case 'closechat': state.view = 'home'; refresh(['chat', 'topbar', 'sidebar']); return '';
        case 'bg': {
            const url = String(text || a.url || '').trim();
            const box = document.getElementById('chat');
            if (box && /^(https?:|data:|\/)/i.test(url)) { box.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`; box.style.backgroundSize = 'cover'; box.style.backgroundPosition = 'center'; }
            else if (box && (url === '' || url === 'none')) box.style.backgroundImage = '';
            return '';
        }
        // ----- 回复版本 -----
        case 'addswipe': {
            const i = state.chat.messages.length - 1;
            const m = state.chat.messages[i];
            if (!m || m.is_user) return '';
            ensureSwipes(m);
            addSwipe(m, session.substitute(text));
            if (a.switch === 'true') setSwipe(m, m.swipes.length - 1);
            renderMessage(i);
            saveChat();
            return '';
        }
        case 'delswipe': {
            const i = state.chat.messages.length - 1;
            const m = state.chat.messages[i];
            if (!m || !Array.isArray(m.swipes) || m.swipes.length < 2) return '';
            if (text) setSwipe(m, Math.max(0, Math.min(m.swipes.length - 1, num(text) - 1)));
            deleteSwipe(m);
            renderMessage(i);
            saveChat();
            return '';
        }
        // ----- 世界书条目 -----
        case 'getentryfield': {
            const { e } = await worldEntry(a.file, text);
            const field = a.field ?? 'content';
            const v = e?.[field === 'key' ? 'key' : field === 'secondary' ? 'keysecondary' : field];
            return Array.isArray(v) ? v.join(', ') : toText(v);
        }
        case 'setentryfield': {
            const { w, e } = await worldEntry(a.file, a.uid);
            if (!e) return '';
            const field = a.field ?? 'content';
            const k = field === 'key' ? 'key' : field === 'secondary' ? 'keysecondary' : field;
            e[k] = Array.isArray(e[k]) ? String(text).split(',').map(x => x.trim()).filter(Boolean) : typeof e[k] === 'number' ? num(text) : typeof e[k] === 'boolean' ? text === 'true' : text;
            void w;
            saveWorld(String(a.file));
            state.session = null;
            return '';
        }
        case 'findentry': {
            const { w } = await worldEntry(a.file);
            const field = a.field ?? 'key';
            const k = field === 'key' ? 'key' : field === 'secondary' ? 'keysecondary' : field;
            const q = String(text).toLowerCase();
            const hit = Object.values(w.entries).find(e => (Array.isArray(e[k]) ? e[k].join(',') : String(e[k] ?? '')).toLowerCase().includes(q));
            return hit ? String(hit.uid) : '';
        }
        case 'createentry': {
            const { w } = await worldEntry(a.file);
            const uid = Math.max(-1, ...Object.keys(w.entries).map(Number)) + 1;
            w.entries[uid] = newWorldInfoEntry(uid, { key: String(a.key ?? '').split(',').map(x => x.trim()).filter(Boolean), content: text });
            saveWorld(String(a.file));
            state.session = null;
            return String(uid);
        }
        default: return undefined;
    }
}

/** 变量被前端卡 / 脚本改了之后：落盘、通知、刷新 */
export async function onVariablesChanged(type) {
    if (type === 'global') saveSettings(); else saveChat();
    await eventSource.emit(event_types.VARIABLES_UPDATED, type);
    refreshSnapshots();
    rerenderIfActive('vars');
}
