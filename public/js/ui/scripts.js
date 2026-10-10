// 酒馆助手脚本的宿主：决定哪些脚本该运行，给每个脚本开一个隐藏的同源 iframe，注入接口，
// 脚本停掉时把它留在页面上的东西收走；另外管输入框上方的脚本按钮、脚本自己的设置界面的落脚处。
//
// 和消息里的前端界面（ui/frontend.js，无同源沙箱）不同，脚本要直接操作页面（悬浮窗、小手机、改楼层显示），
// 所以和酒馆助手一样跑在同源 iframe 里：脚本能读写这里的全部数据、用配置好的模型连接。开关见 设置 › 角色 › 脚本。
import { state, eventSource, event_types, saveChat, saveCharacter, savePreset } from '../state.js';
import { getSession } from '../controller.js';
import { activeScripts, flattenScriptTrees, scriptTreesOf, rewriteScriptSource, buttonEventName, loadsMvuBundle } from '../core/scripts.js';
import { MVU_EVENTS } from '../core/mvu.js';
import { createScriptApi, installHostGlobals, registerScriptWindow, unregisterScriptWindow, dropGlobalsOf, dropInjectionsOf,
    applyInjections, expireInjections, toastr, YAML, findScriptRaw, setScriptHost } from './script-api.js';
import { renderMessage } from './chat.js';
import { refreshSnapshots } from './frontend.js';
import { rerenderIfActive } from './panels/index.js';
import { h, clear } from './dom.js';

const TAG = 'data-lt-script';
const CDNS = ['https://testingcf.jsdelivr.net', 'https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net'];
const LIB_TIMEOUT = 8000;

/** key → 运行时 */
const running = new Map();
/** 脚本 id → 最近一次的状态（停掉以后面板上还要能看到它为什么停的） */
const lastStatus = new Map();
let seq = 0;
let page = null;
let frames = null;
let holder = null;
let helperIndex = null;
let queue = Promise.resolve();

const host = {
    onListenerAdded,
    onButtonsChanged: () => { renderScriptButtons(); rerenderIfActive('scripts'); },
    onLibraryChanged: () => { syncScripts(); rerenderIfActive('scripts'); },
    buttonMap,
    reload: (rt) => reloadScript(rt.id),
};

// ---------- 第三方库 ----------

const libs = {}; // name → Promise

function loadScriptTag(src) {
    return new Promise((resolve, reject) => {
        const el = h('script', { src });
        el.onload = () => resolve();
        el.onerror = () => { el.remove(); reject(new Error(`加载失败：${src}`)); };
        document.head.append(el);
    });
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} 超时`)), ms))]);

/** 依次试几个镜像，全失败才算失败 */
async function fromCdn(path, load) {
    let last;
    for (const base of CDNS) {
        try { return await withTimeout(load(base + path), LIB_TIMEOUT, base + path); } catch (e) { last = e; }
    }
    throw last ?? new Error(`加载失败：${path}`);
}

/** 页面里的 jQuery：脚本里的 $ 指向页面而不是脚本自己的 iframe（和酒馆助手一致） */
function needJQuery() {
    return (libs.jquery ??= window.jQuery ? Promise.resolve() : loadScriptTag('/vendor/jquery.min.js'));
}

/** zod（脚本里的全局 z，变量结构脚本要用）。和酒馆助手用的是同一个大版本 */
function needZod() {
    return (libs.zod ??= (window.z ? Promise.resolve(window.z) : fromCdn('/npm/zod@4.4.3/+esm', (url) => import(url)).then((m) => { window.z = m; return m; }))
        .catch((e) => { delete libs.zod; throw e; }));
}

/** Vue 的源码（取回来存成 blob 地址，塞进要用它的脚本 iframe；直接从 CDN 引的话镜像挂了没法回退） */
function needVue() {
    return (libs.vue ??= fromCdn('/npm/vue@3/dist/vue.runtime.global.prod.js', async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} ${res.status}`);
        return URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    }).catch((e) => { delete libs.vue; throw e; }));
}

function needFontAwesome() {
    if (libs.fa) return;
    libs.fa = true;
    const link = h('link', { rel: 'stylesheet', href: `${CDNS[0]}/npm/@fortawesome/fontawesome-free@6/css/all.min.css` });
    let i = 0;
    link.onerror = () => { if (++i < CDNS.length) link.href = `${CDNS[i]}/npm/@fortawesome/fontawesome-free@6/css/all.min.css`; };
    document.head.append(link);
}

function needCompatCss() {
    if (libs.css) return;
    libs.css = true;
    document.head.append(h('link', { rel: 'stylesheet', href: '/css/st-compat.css' }));
    // 酒馆的折叠抽屉（脚本的设置界面常用）：点标题展开 / 收起
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest?.('.inline-drawer-toggle');
        if (!toggle) return;
        const drawer = toggle.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        if (!content) return;
        const open = getComputedStyle(content).display === 'none';
        content.style.display = open ? 'block' : 'none';
        const ic = drawer.querySelector(':scope > .inline-drawer-toggle .inline-drawer-icon');
        ic?.classList.toggle('down', !open);
        ic?.classList.toggle('up', open);
        ic?.classList.toggle('fa-circle-chevron-down', !open);
        ic?.classList.toggle('fa-circle-chevron-up', open);
    });
}

const uses = (content, re) => re.test(content);

// ---------- 追踪脚本往页面上加的东西 ----------

const isHtml = (s) => typeof s === 'string' && /^\s*<[\s\S]*>\s*$/.test(s);
const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;

function tagger(rt) {
    return (el) => {
        try { if (el && el.nodeType === 1 && !el.hasAttribute(TAG)) el.setAttribute(TAG, rt.tag); } catch { /* 不是普通元素 */ }
        return el;
    };
}

/** 给这个脚本一份 jQuery：功能就是页面的 jQuery，只是用 HTML 字符串新建出来的元素会打上这个脚本的标记 */
function scriptJQuery(rt) {
    const base = window.jQuery;
    const tag = tagger(rt);
    const mark = (jq) => { for (let i = 0; i < jq.length; i++) tag(jq[i]); return jq; };
    const $ = function (selector, context) {
        const r = base(selector, context);
        Object.setPrototypeOf(r, $.fn);
        return isHtml(selector) ? mark(r) : r;
    };
    Object.setPrototypeOf($, base);
    $.fn = $.prototype = Object.create(base.fn);
    $.fn.constructor = $;
    for (const method of ['append', 'prepend', 'before', 'after', 'html', 'replaceWith', 'wrap', 'wrapAll', 'wrapInner']) {
        $.fn[method] = function (...args) {
            return base.fn[method].apply(this, args.map(a => (isHtml(a) ? mark(base(a)) : a)));
        };
    }
    return $;
}

/**
 * window.parent 的替身：读到的都是页面本身的东西，只是 createElement 出来的元素会打标记、
 * 写到页面 window 上的全局变量会记下来，脚本停掉时好收走。
 */
function parentProxy(rt, $) {
    const tag = tagger(rt);
    const real = window;
    const doc = new Proxy(document, {
        get(t, p) {
            if (p === 'createElement' || p === 'createElementNS') return (...a) => tag(t[p](...a));
            const v = Reflect.get(t, p, t);
            return typeof v === 'function' ? v.bind(t) : v;
        },
        set(t, p, v) { t[p] = v; return true; },
    });
    const remember = (p) => { if (!rt.writes.has(p)) rt.writes.set(p, { had: p in real, value: real[p] }); };
    const proxy = new Proxy(real, {
        get(t, p) {
            if (p === 'document') return doc;
            if (p === '$' || p === 'jQuery') return $;
            if (p === 'parent' || p === 'window' || p === 'self' || p === 'globalThis' || p === 'frames') return proxy;
            const v = Reflect.get(t, p, t);
            // 浏览器自带的方法（setTimeout、fetch、getComputedStyle…）要绑回真正的 window 才能调用；
            // 构造函数和页面自己的函数（lodash、TavernHelper 的接口）原样给，不然它们身上挂的属性就丢了
            if (typeof v === 'function' && typeof p === 'string' && /^[a-z]/.test(p) && NATIVE.test(Function.prototype.toString.call(v))) return v.bind(t);
            return v;
        },
        set(t, p, v) { remember(p); t[p] = v; return true; },
        deleteProperty(t, p) { remember(p); return delete t[p]; },
    });
    return proxy;
}

function sweep(rt) {
    const sel = `[${TAG}="${rt.tag}"]`;
    for (const el of [...document.querySelectorAll(sel)]) {
        if (el.isConnected && !el.parentElement?.closest(sel)) el.remove();
    }
    for (const [p, w] of rt.writes) {
        try { if (w.had) window[p] = w.value; else delete window[p]; } catch { /* 有的属性删不掉 */ }
    }
    rt.writes.clear();
}

// ---------- 启动 / 停止 ----------

function setStatus(rt, stateName, message) {
    rt.state = stateName;
    if (message) rt.errors.push(message);
    lastStatus.set(rt.id, { state: rt.state, errors: rt.errors.slice(-5), at: Date.now(), source: rt.source });
    rerenderIfActive('scripts');
}

function makeRuntime(item) {
    const s = item.script;
    const rt = {
        key: item.key,
        id: s.id,
        name: s.name || '未命名脚本',
        source: item.source,
        owner: item.owner,
        content: s.content,
        tag: `s${++seq}`,
        frameName: `TH-script--${s.name}--${s.id}`,
        listeners: new Map(),
        writes: new Map(),
        errors: [],
        state: 'loading',
        host,
        win: null,
        iframe: null,
        urls: [],
        // 和酒馆助手一样：脚本自己写了 pagehide 清理的就不替它盯着，免得替身对象和它的写法冲突
        protect: !s.content.includes('pagehide'),
        fail(e, where) {
            const text = `${where ? `${where}：` : ''}${e?.message ?? e}`;
            console.error(`[脚本 ${rt.name}]`, where ?? '', e);
            if (rt.errors[rt.errors.length - 1] !== text) setStatus(rt, rt.state === 'loading' ? 'error' : rt.state, text);
        },
    };
    rt.api = createScriptApi(rt);
    return rt;
}

/** iframe 里第一段脚本会调这里：在脚本代码运行之前把接口装进它的 window */
function boot(win) {
    const rt = [...running.values()].find(r => r.iframe && r.iframe.contentWindow === win);
    if (!rt) return;
    rt.win = win;
    registerScriptWindow(win);
    const { helper, Mvu, SillyTavern } = rt.api;
    const $ = rt.protect ? scriptJQuery(rt) : window.jQuery;
    Object.assign(win, helper, { _: window._, $, jQuery: $, toastr, YAML, showdown: window.showdown, DOMPurify: window.DOMPurify, TavernHelper: helper, EjsTemplate: window.EjsTemplate });
    if (window.z) win.z = window.z;
    Object.defineProperty(win, 'SillyTavern', { get: SillyTavern, configurable: true });
    Object.defineProperty(win, 'Mvu', { value: Mvu, writable: true, configurable: true });
    // Vue / pinia 的编译开关（用它们打包的脚本要求先定义好）
    win.__VUE_OPTIONS_API__ = true;
    win.__VUE_PROD_DEVTOOLS__ = false;
    win.__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
    win.name = rt.frameName;
    // iframe 里那个 <script type="module"> 的 onload / onerror 调的是它
    win.__ltLoaded = (ok) => loaded(win, ok);
    if (rt.protect) {
        try {
            const proxy = parentProxy(rt, $);
            Object.defineProperty(win, 'parent', { get: () => proxy, set() {}, configurable: true });
        } catch (e) { console.warn('[脚本] 没能接管 window.parent', e); }
        const tag = tagger(rt);
        const d = win.document;
        const ce = d.createElement.bind(d), cens = d.createElementNS.bind(d);
        d.createElement = (...a) => tag(ce(...a));
        d.createElementNS = (...a) => tag(cens(...a));
    }
    win.addEventListener('error', (e) => rt.fail(e.error ?? e.message, '运行出错'));
    win.addEventListener('unhandledrejection', (e) => rt.fail(e.reason, '运行出错'));
    win.addEventListener('pagehide', () => rt.api.eventClearAll());
}

function loaded(win, ok) {
    const rt = [...running.values()].find(r => r.win === win);
    if (!rt) return;
    if (!ok) setStatus(rt, 'error', '脚本没能加载（语法错误，或它 import 的网络文件取不到）');
    else if (rt.state === 'loading') setStatus(rt, 'running');
}

async function start(item) {
    const rt = makeRuntime(item);
    running.set(rt.key, rt);
    lastStatus.set(rt.id, { state: 'loading', errors: [], at: Date.now(), source: rt.source });
    const c = rt.content;
    try {
        await needJQuery();
        needCompatCss();
        if (uses(c, /\bfa-(solid|regular|brands)\b|\bfa fa-/)) needFontAwesome();
        if (uses(c, /\bz\.|registerMvuSchema|\bzod\b/)) await needZod().catch(e => rt.fail(e, 'zod 没加载上（变量结构校验不会生效）'));
        let vue = '';
        if (uses(c, /\bVue\b/)) vue = await needVue().catch((e) => { rt.fail(e, 'Vue 没加载上'); return ''; });
        if (!running.has(rt.key)) return; // 等库的时候已经被停掉了

        // 酒馆助手允许把脚本包在 ``` 里
        const body = c.match(/^\s*```[^\n]*\n([\s\S]*)\n```\s*$/)?.[1] ?? c;
        const src = rewriteScriptSource(body, `${location.origin}/script-stubs/mvu.js`);
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        rt.urls.push(url);
        const iframe = h('iframe', { class: 'lt-script-frame', id: rt.frameName, name: rt.frameName, 'aria-hidden': 'true', tabindex: '-1', title: `脚本：${rt.name}` });
        rt.iframe = iframe;
        iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8">'
            + '<script>parent.__ltScriptBoot(window)</' + 'script>'
            + (vue ? `<script src="${vue}"></` + 'script>' : '')
            + '</head><body>'
            + `<script type="module" src="${url}" onload="__ltLoaded(true)" onerror="__ltLoaded(false)"></` + 'script>'
            + '</body></html>';
        frames.append(iframe);
    } catch (e) {
        rt.fail(e, '启动失败');
        setStatus(rt, 'error');
    }
}

function stop(rt) {
    running.delete(rt.key);
    for (const [type, m] of rt.listeners) for (const w of m.values()) eventSource.off(type, w);
    rt.listeners.clear();
    if (rt.win) unregisterScriptWindow(rt.win);
    // 移除 iframe 会在它里面触发 pagehide，脚本自己的清理代码在这时运行
    try { rt.iframe?.remove(); } catch { /* 已经不在了 */ }
    sweep(rt);
    dropGlobalsOf(rt);
    dropInjectionsOf(rt);
    for (const u of rt.urls) URL.revokeObjectURL(u);
    const st = lastStatus.get(rt.id);
    if (st && st.state !== 'error') lastStatus.set(rt.id, { ...st, state: 'stopped' });
}

function wanted() {
    // 角色卡的脚本等聊天打开了再起（和酒馆一样）：选了角色但聊天还没载入时，脚本一启动就去读楼层会直接报错
    const ready = !!(state.char && state.chat);
    return activeScripts({
        card: ready ? state.char.card : null,
        cardId: ready ? state.char.id : '',
        preset: state.preset?.data ?? null,
        presetName: state.preset?.name ?? '',
        settings: state.settings,
    });
}

/** 让“正在运行的脚本”和“应该运行的脚本”对齐。可以随便多调，内部排队 */
export function syncScripts() {
    queue = queue.then(doSync).catch(e => console.error('[脚本] 同步失败', e));
    return queue;
}

/**
 * 酒馆助手设置面板里的脚本列表（#tavern_helper 下每个脚本一个 div[data-script-id]，顺序：角色卡脚本、预设脚本）。
 * 很多用官方模板写的脚本靠它判断“同名脚本装了好几份时该哪一份生效”：页面上找不到这个列表，它们就认为
 * 轮不到自己，加载了但什么也不做。这里放一份看不见的。
 */
function renderHelperIndex() {
    if (!helperIndex) return;
    const ids = [];
    if (state.char && state.chat) ids.push(...flattenScriptTrees(scriptTreesOf(state.char.card.data.extensions)).map(x => x.script.id));
    if (state.preset) ids.push(...flattenScriptTrees(scriptTreesOf(state.preset.data.extensions)).map(x => x.script.id));
    helperIndex.replaceChildren(...ids.map(id => h('div', { dataset: { scriptId: id } })));
}

async function doSync() {
    if (!frames) return;
    renderHelperIndex();
    const want = wanted();
    const keys = new Set(want.map(w => w.key));
    for (const rt of [...running.values()]) if (!keys.has(rt.key)) stop(rt);
    for (const item of want) {
        if (running.has(item.key)) continue;
        if (item.mvuLoader) { lastStatus.set(item.script.id, { state: 'builtin', errors: [], at: Date.now(), source: item.source }); continue; }
        await start(item);
    }
    renderScriptButtons();
    rerenderIfActive('scripts');
}

export async function reloadScript(id) {
    for (const rt of [...running.values()]) if (rt.id === id) stop(rt);
    await syncScripts();
}

export async function reloadAllScripts() {
    for (const rt of [...running.values()]) stop(rt);
    await syncScripts();
}

/** 面板用：脚本 id → {state: loading|running|error|stopped|builtin, errors: string[]} */
export function scriptStatus(id) {
    return lastStatus.get(id) ?? null;
}

export const runningCount = () => running.size;

// ---------- MVU 初始化事件 ----------

async function afterInitNotify() {
    saveChat();
    if (state.chat?.messages.length) renderMessage(0);
    refreshSnapshots();
    rerenderIfActive('vars');
}

/** 脚本晚于聊天打开才注册 mag_variable_initialized：把刚初始化的开场白变量补发给它一次 */
function onListenerAdded(type, wrapped) {
    if (type !== MVU_EVENTS.VARIABLE_INITIALIZED) return;
    const session = getSession();
    if (!session?.mvuInitPending || (state.chat?.messages.length ?? 0) > 1) return;
    session.notifyMvuInit((v, i) => wrapped(v, i)).then(ok => { if (ok) afterInitNotify(); });
}

async function notifyInitToAll() {
    const session = getSession();
    if (!session?.mvuInitPending || (state.chat?.messages.length ?? 0) > 1) return;
    if (!eventSource.count(MVU_EVENTS.VARIABLE_INITIALIZED)) return;
    if (await session.notifyMvuInit((v, i) => eventSource.emit(MVU_EVENTS.VARIABLE_INITIALIZED, v, i))) await afterInitNotify();
}

// ---------- 脚本按钮 ----------

function buttonMap() {
    const out = {};
    for (const rt of running.values()) {
        const raw = findScriptRaw(rt.id, rt.source)?.raw;
        const btn = raw?.button;
        if (!btn || btn.enabled === false) continue;
        const list = (btn.buttons ?? []).filter(b => b && b.visible !== false && b.name);
        if (list.length) out[rt.id] = list.map(b => ({ button_id: buttonEventName(rt.id, b.name), button_name: String(b.name) }));
    }
    return out;
}

/** 输入框上方的一排脚本按钮（脚本用 appendInexistentScriptButtons 等接口登记的） */
export function renderScriptButtons() {
    const composer = document.getElementById('composer');
    if (!composer) return;
    let bar = document.getElementById('script-buttons');
    if (!bar) {
        bar = h('div', { id: 'script-buttons', class: 'script-buttons', role: 'toolbar', 'aria-label': '脚本按钮' });
        composer.prepend(bar);
    }
    clear(bar);
    const map = buttonMap();
    for (const rt of running.values()) {
        for (const b of map[rt.id] ?? []) {
            bar.append(h('button', { class: 'script-btn', type: 'button', title: `脚本「${rt.name}」的按钮`, dataset: { script: rt.id }, onclick: () => eventSource.emit(b.button_id) }, b.button_name));
        }
    }
    bar.hidden = !bar.childElementCount;
}

// ---------- 脚本自己的设置界面 ----------

const HOLDER_IDS = ['extensions_settings', 'extensions_settings2', 'extensionsMenu'];

/** 酒馆里扩展放设置界面的几个容器。脚本往这里面加东西；平时藏着，打开 设置 › 角色 › 脚本 时搬进面板 */
export function scriptSettingsNodes() {
    return HOLDER_IDS.map(id => document.getElementById(id)).filter(Boolean);
}

/** 面板重绘前把容器搬回藏身处，免得跟着面板内容一起从页面上消失 */
export function parkScriptSettings() {
    if (!holder) return;
    for (const el of scriptSettingsNodes()) if (el.parentElement !== holder) holder.append(el);
}

// ---------- 初始化 ----------

export function initScripts({ bindGenerate } = {}) {
    if (frames) return;
    setScriptHost(host);
    page = installHostGlobals();
    window.__ltScriptBoot = boot;
    frames = h('div', { id: 'lt-script-frames', 'aria-hidden': 'true' });
    helperIndex = h('div', { id: 'tavern_helper' });
    holder = h('div', { id: 'lt-script-holder', hidden: true }, HOLDER_IDS.map(id => h('div', { id, class: 'st-ext-area' })), helperIndex);
    document.body.append(frames, holder);
    bindGenerate?.({ beforePrompt: applyInjections, afterGeneration: expireInjections });

    for (const ev of [event_types.CHAT_CHANGED, event_types.CHARACTER_SELECTED, event_types.PRESET_CHANGED, event_types.CHARACTER_EDITED]) {
        eventSource.on(ev, () => { syncScripts().then(notifyInitToAll); });
    }
    return page;
}

/** 面板改了开关之后调用：写回卡 / 预设并重新对齐 */
export function scriptToggled(source) {
    if (source === 'preset') savePreset(); else if (source === 'character') saveCharacter();
    return syncScripts();
}

export { flattenScriptTrees, scriptTreesOf, loadsMvuBundle };
