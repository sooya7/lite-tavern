// 前端卡宿主：创建沙箱 iframe、注入运行时与数据快照、处理 iframe 发来的请求。
import { h, toast } from './dom.js';
import { state, eventSource } from '../state.js';
import { messageText } from '../core/chat.js';
import { setPath } from '../core/util.js';

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

function buildDoc(html, frameId, messageId) {
    const init = { frameId, snapshot: buildSnapshot(messageId) };
    const vh = Math.max(window.innerHeight, 400) / 100;
    const head = `<meta charset="utf-8"><base target="_blank">`
        + `<style>:root{--lt-vh:${vh}px;color-scheme:normal}html,body{margin:0;background:transparent}</style>`
        + `<script>window.__LT_INIT=${safeJson(init)};</script>`
        + `<script src="${location.origin}/vendor/jquery.min.js"></script>`
        + `<script src="${location.origin}/vendor/lodash.min.js"></script>`
        + `<script src="${location.origin}/frontend-runtime.js"></script>`;
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
        case 'generate': return handlers.scriptGenerate?.(args[0] ?? {}, { raw: false }) ?? '';
        case 'generateRaw': return handlers.scriptGenerate?.(args[0] ?? {}, { raw: true }) ?? '';
        default: throw new Error(`前端卡调用了暂不支持的接口：${method}`);
    }
}

window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || !d.__lt) return;
    const frame = frameBySource(e.source);
    if (!frame) return;
    if (d.type === 'height') {
        const hgt = Math.min(Math.max(Number(d.height) || 0, 20), 6000);
        frame.iframe.style.height = `${hgt}px`;
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
