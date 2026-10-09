// 通用工具：浏览器与 Node 共用，不依赖 DOM。

export function uuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

export const clone = (v) => (v === undefined ? undefined : structuredClone(v));

export function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** lodash 风格路径: a.b[0].c / a.b.0.c */
export function toPath(path) {
    if (Array.isArray(path)) return path;
    if (path === null || path === undefined || path === '') return [];
    const out = [];
    String(path).replace(/[^.[\]]+|\[(?:(-?\d+)|(["'])(.*?)\2)\]/g, (m, num, q, str) => {
        out.push(num !== undefined ? num : (q ? str : m));
        return m;
    });
    return out;
}

export function getPath(obj, path, defaults) {
    const parts = toPath(path);
    let cur = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined) return defaults;
        cur = cur[p];
    }
    return cur === undefined ? defaults : cur;
}

export function hasPath(obj, path) {
    const parts = toPath(path);
    let cur = obj;
    for (const p of parts) {
        if (cur === null || typeof cur !== 'object' || !(p in cur)) return false;
        cur = cur[p];
    }
    return true;
}

export function setPath(obj, path, value) {
    const parts = toPath(path);
    if (!parts.length) return value;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === null || typeof cur[p] !== 'object') {
            cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        }
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
}

export function unsetPath(obj, path) {
    const parts = toPath(path);
    if (!parts.length) return false;
    const parent = parts.length > 1 ? getPath(obj, parts.slice(0, -1)) : obj;
    if (parent === null || typeof parent !== 'object') return false;
    const last = parts[parts.length - 1];
    if (Array.isArray(parent) && /^\d+$/.test(last)) {
        parent.splice(Number(last), 1);
        return true;
    }
    return delete parent[last];
}

/** 深合并（数组整体替换），返回 target */
export function deepMerge(target, ...sources) {
    for (const src of sources) {
        if (!isPlainObject(src)) continue;
        for (const [k, v] of Object.entries(src)) {
            if (isPlainObject(v) && isPlainObject(target[k])) deepMerge(target[k], v);
            else target[k] = clone(v);
        }
    }
    return target;
}

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function escapeRegex(str) {
    return String(str).replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * 正则脚本用的宽松解析（与酒馆 regexFromString 一致）：
 * "/pattern/flags" 或不带斜杠的裸 pattern 都接受；非法返回 null。
 */
export function regexFromString(input) {
    if (typeof input !== 'string' || !input) return null;
    try {
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);
        if (!m) return null;
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJd]+$/.test(m[3])) return new RegExp(input);
        return new RegExp(m[2], m[3]);
    } catch {
        return null;
    }
}

/** 世界书关键词用的严格解析（与酒馆 parseRegexFromString 一致），不是 /x/flags 形式返回 null */
export function parseRegexFromString(input) {
    if (typeof input !== 'string') return null;
    const m = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!m) return null;
    let [, pattern, flags] = m;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

export function debounce(fn, ms = 300) {
    let t = null;
    const wrapped = (...args) => {
        clearTimeout(t);
        t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
    /** 有待执行的调用才立即执行（没有就什么都不做） */
    wrapped.flush = (...args) => {
        if (t === null) return undefined;
        clearTimeout(t);
        t = null;
        return fn(...args);
    };
    Object.defineProperty(wrapped, 'pending', { get: () => t !== null });
    return wrapped;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 简单字符串哈希（用于 pick 宏、WI hash 等稳定随机）
export function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// 可复现的伪随机（mulberry32）
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 酒馆的 send_date 格式："October 9, 2026 3:12pm" */
export function humanizedDate(d = new Date()) {
    let h = d.getHours();
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h}:${mm}${ampm}`;
}

/** 酒馆的聊天文件名时间格式："2026-10-09@15h12m03s" */
export function humanizedDateTime(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}@${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

export function parseSendDate(s) {
    if (!s) return null;
    if (typeof s === 'number') return new Date(s);
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t);
    // "October 9, 2026 3:12pm"
    const m = String(s).match(/^(\w+) (\d+), (\d+) (\d+):(\d+)(am|pm)$/i);
    if (m) {
        let h = Number(m[4]) % 12;
        if (m[6].toLowerCase() === 'pm') h += 12;
        return new Date(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]), h, Number(m[5]));
    }
    return null;
}

/** 安全文件名：去掉路径分隔与保留字符 */
export function sanitizeFileName(name) {
    return String(name ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .trim()
        .slice(0, 180) || 'untitled';
}

// UTF-8 <-> base64，浏览器与 Node 通用
export function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

export function base64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

export function truncate(str, n) {
    str = String(str ?? '');
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
