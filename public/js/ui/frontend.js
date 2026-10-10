// 前端卡宿主：创建沙箱 iframe、注入运行时与数据快照、处理 iframe 发来的请求。
import { h, toast } from './dom.js';
import { state, eventSource } from '../state.js';
import { messageText } from '../core/chat.js';
import { setPath } from '../core/util.js';

// 前端卡运行时的版本号：改了 frontend-runtime.js 就改这里，iframe 才会用新的（平时走长期缓存，不用每个 iframe 都请求一次）
const RT_V = '20261010h30';
const frames = new Map(); // frameId → {iframe, messageId}
let nextId = 1;
let handlers = {};

/** 由 app 注入真正干活的函数：createChatMessages / triggerSlash / generate / onVariablesChanged / rerender */
export function setFrontendHandlers(h2) {
    handlers = h2;
}

// 和酒馆助手的口径一致：旁白 / 注释算 system；被隐藏的楼层角色不变，隐藏与否看 is_hidden
function roleOf(m) {
    if (m.is_user) return 'user';
    return m.extra?.type === 'narrator' || m.extra?.type === 'comment' ? 'system' : 'assistant';
}

export function buildSnapshot(messageId) {
    const chat = state.chat?.messages ?? [];
    const session = state.session;
    const messageVars = {};
    chat.forEach((m, i) => {
        const v = Array.isArray(m.variables) ? m.variables[m.swipe_id ?? 0] : null;
        if (v) messageVars[i] = v;
    });
    const mid = messageId ?? chat.length - 1;
    return {
        messageId: mid,
        lastMessageId: chat.length - 1,
        chatId: state.chat?.name ?? '',
        characterId: state.char?.id ?? '',
        userName: session?.names.user ?? 'User',
        charName: session?.names.char ?? '',
        charAvatar: state.char ? `/api/characters/${encodeURIComponent(state.char.file)}/avatar` : '',
        charData: state.char?.card?.data ? { name: state.char.card.data.name, description: state.char.card.data.description, tags: state.char.card.data.tags } : null,
        chat: chat.map((m, i) => ({
            message_id: i,
            name: m.name,
            role: roleOf(m),
            is_hidden: !!m.is_system,
            message: messageText(m),
            data: messageVars[i] ?? {},
            swipe_id: m.swipe_id ?? 0,
            // 全部版本只给首楼和这个界面所在的楼（开场选择这类卡要看首楼有哪些开场）；每一楼都带的话长聊天的快照会非常大
            ...((i === 0 || i === mid) && Array.isArray(m.swipes) && m.swipes.length > 1
                ? { swipes: m.swipes.map((t, k) => (k === (m.swipe_id ?? 0) ? messageText(m) : String(t ?? ''))) } : {}),
            extra: m.extra ?? {},
        })),
        messageVars,
        chatVars: state.chat?.header?.chat_metadata?.variables ?? {},
        globalVars: state.settings.variables?.global ?? {},
        allVars: session ? session.vars.cache(mid) : {},
    };
}

const BS = String.fromCharCode(92), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

function safeJson(obj) {
    return JSON.stringify(obj).split('<').join(BS + 'u003c').split(LS).join(BS + 'u2028').split(PS).join(BS + 'u2029');
}

// 沙箱 iframe 没有自己的 localStorage：用宿主的 localStorage（加前缀）给卡片模拟一份，折叠状态、皮肤等才能记住
const FS_PREFIX = 'lt.fs.';
function storeSnapshot() {
    const out = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(FS_PREFIX)) out[k.slice(FS_PREFIX.length)] = localStorage.getItem(k);
        }
    } catch { /* 隐私模式 */ }
    return out;
}
function storeWrite(op, key, value) {
    try {
        if (op === 'set') localStorage.setItem(FS_PREFIX + key, String(value));
        else if (op === 'remove') localStorage.removeItem(FS_PREFIX + key);
        else if (op === 'clear') for (const k of Object.keys(storeSnapshot())) localStorage.removeItem(FS_PREFIX + k);
    } catch { /* 存不下就算了 */ }
}

const composer = () => document.getElementById('send_textarea');
/** 把文字放进输入框（前端卡的剧情选项、/setinput 用） */
export function setComposerInput(text) {
    const el = composer();
    if (!el) return;
    el.value = String(text ?? '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
}
// 输入框内容同步给各前端卡，getChatInput() 才能同步读到
document.addEventListener('input', (e) => {
    if (e.target?.id !== 'send_textarea') return;
    gc();
    for (const [, f] of frames) f.iframe.contentWindow?.postMessage({ __lt: true, type: 'input', value: e.target.value }, '*');
}, true);

function buildDoc(html, frameId, messageId) {
    const init = { frameId, snapshot: buildSnapshot(messageId), store: storeSnapshot(), input: composer()?.value ?? '' };
    const vh = Math.max(window.innerHeight, 400) / 100;
    const head = `<meta charset="utf-8"><base target="_blank">`
        + `<style>:root{--lt-vh:${vh}px;color-scheme:normal}html,body{margin:0;background:transparent}</style>`
        + `<script>window.__LT_INIT=${safeJson(init)};</script>`
        + `<script src="${location.origin}/vendor/jquery.min.js"></script>`
        + `<script src="${location.origin}/vendor/lodash.min.js"></script>`
        + `<script src="${location.origin}/frontend-runtime.js?v=${RT_V}"></script>`;
    // vh 在 iframe 里会随 iframe 高度变化导致无限撑高，换成父窗口的视口高度
    let doc = String(html).replace(/(\d+(?:\.\d+)?)vh\b/g, 'calc(var(--lt-vh) * $1)');
    if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (m) => m + head);
    else if (/<html[^>]*>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
    else doc = `<!doctype html><html><head>${head}</head><body>${doc}</body></html>`;
    return doc;
}

/** 在 wrap 里挂一个前端 iframe */
export function mountFrontend(html, wrap, messageId) {
    const frameId = nextId++;
    const iframe = h('iframe', {
        class: 'frontend-frame',
        sandbox: 'allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox',
        loading: 'lazy',
        title: '前端卡内容',
        style: { height: '60px' },
    });
    iframe.srcdoc = buildDoc(html, frameId, messageId);
    frames.set(frameId, { iframe, messageId });
    wrap.append(iframe);
    return iframe;
}

/** 清理已从 DOM 移除的 iframe */
function gc() {
    for (const [id, f] of frames) if (!f.iframe.isConnected) frames.delete(id);
}

export function broadcastEvent(name, ...args) {
    gc();
    for (const [, f] of frames) {
        f.iframe.contentWindow?.postMessage({ __lt: true, type: 'event', name, args, snapshot: buildSnapshot(f.messageId) }, '*');
    }
}

export function refreshSnapshots() {
    gc();
    for (const [, f] of frames) {
        f.iframe.contentWindow?.postMessage({ __lt: true, type: 'snapshot', snapshot: buildSnapshot(f.messageId) }, '*');
    }
}

function frameBySource(src) {
    for (const [id, f] of frames) if (f.iframe.contentWindow === src) return { id, ...f };
    return null;
}

async function runRpc(frame, method, args) {
    switch (method) {
        case 'toast': {
            const [type, msg] = args;
            toast(msg, type);
            return null;
        }
        case 'replaceVariables': {
            const [vars, opt = {}] = args;
            const type = opt.type ?? 'chat';
            if (type === 'global') {
                state.settings.variables.global = vars;
            } else if (type === 'message') {
                const msg = state.chat?.messages?.[opt.message_id ?? frame.messageId];
                if (!msg) throw new Error('找不到楼层');
                if (!Array.isArray(msg.variables)) msg.variables = [];
                msg.variables[msg.swipe_id ?? 0] = vars;
            } else {
                const meta = state.chat?.header?.chat_metadata;
                if (meta) meta.variables = vars;
            }
            state.session?.vars.invalidate();
            await handlers.onVariablesChanged?.(type);
            return null;
        }
        case 'createChatMessages': return handlers.createChatMessages?.(...args);
        case 'setChatMessages': return handlers.setChatMessages?.(...args);
        case 'deleteChatMessages': return handlers.deleteChatMessages?.(...args);
        case 'triggerSlash': return handlers.triggerSlash?.(...args) ?? '';
        case 'setChatInput': setComposerInput(args[0]); return null;
        case 'parentEvent': {
            // 卡片界面在“父页面的 document”上发的自定义事件：在这边真的发一次，卡片自带的脚本（跑在同源的 iframe 里）能收到。
            // 只放行带命名空间的事件名（hc1:opening-confirm 这种），不让沙箱里的内容伪造点击、按键，也不让它发轻酒馆自己的 lt: 事件
            const [type, detail] = args;
            if (typeof type !== 'string' || !/^[a-z][\w]*[:.\-][\w:.\-]+$/i.test(type) || /^lt[:.\-]/i.test(type)) throw new Error(`不支持在页面上发这个事件：${type}`);
            const d = detail && typeof detail === 'object' ? detail : { value: detail };
            document.dispatchEvent(new CustomEvent(type, { detail: d }));
            if (!('result' in d)) return { handled: false };
            try {
                const result = await d.result;
                return { handled: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
            } catch (e) {
                return { handled: true, error: String(e?.message ?? e) };
            }
        }
        case 'generate': return handlers.scriptGenerate?.(args[0] ?? {}, { raw: false }) ?? '';
        case 'generateRaw': return handlers.scriptGenerate?.(args[0] ?? {}, { raw: true }) ?? '';
        case 'helper': {
            // 其余酒馆助手接口：转给页面上的完整实现（参数和返回值要能跨窗口复制，传函数的接口不走这里）
            const [name, list] = args;
            const fn = window.TavernHelper?.[name];
            if (typeof fn !== 'function') throw new Error(`前端卡调用了暂不支持的接口：${name}`);
            const r = await fn(...(Array.isArray(list) ? list : []));
            if (typeof Response !== 'undefined' && r instanceof Response) return { ok: r.ok, status: r.status, body: await r.text() };
            return r === undefined ? null : JSON.parse(JSON.stringify(r));
        }
        default: throw new Error(`前端卡调用了暂不支持的接口：${method}`);
    }
}

window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d) return;
    if (!d.__lt) {
        // 有些卡直接 postMessage({type:'sendChat', text}) 给父页面：按酒馆的样子放进输入框
        if (d.type === 'sendChat' && typeof d.text === 'string' && frameBySource(e.source)) setComposerInput(d.text);
        return;
    }
    const frame = frameBySource(e.source);
    if (!frame) return;
    if (d.type === 'height') {
        const hgt = Math.min(Math.max(Number(d.height) || 0, 20), 6000);
        frame.iframe.style.height = `${hgt}px`;
        return;
    }
    if (d.type === 'storage') {
        storeWrite(d.op, d.key, d.value);
        return;
    }
    if (d.type === 'error') {
        console.warn('[前端卡] 脚本报错：', d.message);
        return;
    }
    if (d.type === 'emit') {
        // 其他前端界面和脚本都要能收到
        broadcastEvent(d.name, ...(d.args ?? []));
        eventSource.emit(String(d.name), ...(d.args ?? []));
        return;
    }
    if (d.type === 'rpc') {
        let result = null, error = null;
        try {
            result = await runRpc(frame, d.method, d.args ?? []);
        } catch (err) {
            error = String(err?.message ?? err);
            console.warn('[前端卡]', d.method, err);
        }
        if (d.id) e.source.postMessage({ __lt: true, type: 'rpc-result', id: d.id, result: result ?? null, error }, '*');
    }
});

export { setPath };
