// 宏引擎：对齐酒馆 1.18 新宏引擎（左到右求值、嵌套、作用域宏 {{if}}...{{/if}}、变量简写 .var/$var），
// 同时兼容旧语法（{{random:a,b}}、{{roll:d6}}、<USER>、{{time_UTC+8}}、{{trim}} 吃换行）。
import { hashString, seededRandom } from './util.js';

const TRIM_MARKER = '\u0000TRIM\u0000';
const ELSE_MARKER = '\u0000ELSE\u0000';

/** 宏值规范化：对象转 JSON，空值转空串 */
export function normalizeMacroValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
}

function isFalsyCondition(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '' || s === 'false' || s === 'off' || s === '0' || s === 'null' || s === 'undefined' || s === 'no';
}

// ---------- 文本切分 ----------

/** 从 i 处（指向 "{{"）找配对的 "}}"，支持嵌套；返回 "}}" 结束后的下标，找不到返回 -1 */
function findMacroEnd(text, i) {
    let depth = 0;
    for (let p = i; p < text.length - 1; p++) {
        if (text[p] === '\\' && (text[p + 1] === '{' || text[p + 1] === '}')) { p++; continue; }
        if (text[p] === '{' && text[p + 1] === '{') { depth++; p++; continue; }
        if (text[p] === '}' && text[p + 1] === '}') {
            depth--;
            p++;
            if (depth === 0) {
                // 处理 "}}}"：最外层取最后一个 "}}"（如 {{getvar::{{x}}}} 已由嵌套计数处理）
                return p + 1;
            }
        }
    }
    return -1;
}

/** 把文本切成 [{type:'text', value} | {type:'macro', body, start, end}] */
function tokenize(text) {
    const tokens = [];
    let cursor = 0;
    let i = 0;
    while (i < text.length - 1) {
        if (text[i] === '\\' && (text[i + 1] === '{' || text[i + 1] === '}')) { i += 2; continue; }
        if (text[i] === '{' && text[i + 1] === '{') {
            const end = findMacroEnd(text, i);
            if (end < 0) break;
            if (i > cursor) tokens.push({ type: 'text', value: text.slice(cursor, i) });
            tokens.push({ type: 'macro', body: text.slice(i + 2, end - 2), start: i, end });
            cursor = i = end;
            continue;
        }
        i++;
    }
    if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
    return tokens;
}

/** 在顶层按分隔符切参数（不切嵌套宏内部） */
function splitTopLevel(str, sep) {
    const parts = [];
    let depth = 0, last = 0;
    for (let p = 0; p < str.length; p++) {
        if (str[p] === '\\' && p + 1 < str.length) { p++; continue; }
        if (str.startsWith('{{', p)) { depth++; p++; continue; }
        if (str.startsWith('}}', p) && depth > 0) { depth--; p++; continue; }
        if (depth === 0 && str.startsWith(sep, p)) {
            parts.push(str.slice(last, p));
            last = p + sep.length;
            p += sep.length - 1;
        }
    }
    parts.push(str.slice(last));
    return parts;
}

/**
 * 解析宏体：返回 {name, args, rawArgs, kind}
 * kind: 'normal' | 'close' | 'var'
 */
function parseBody(body) {
    const trimmed = body.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        return { kind: 'close', name: trimmed.slice(1).trim().toLowerCase() };
    }
    if (trimmed.startsWith('///')) return { kind: 'close', name: '//' };
    if (trimmed.startsWith('//')) return { kind: 'normal', name: '//', args: [trimmed.slice(2)], sep: 'comment' };
    if (/^[.$][\p{L}\p{N}_-]/u.test(trimmed)) return { kind: 'var', expr: trimmed };

    const m = trimmed.match(/^([\p{L}_][\p{L}\p{N}_-]*)/u);
    if (!m) return { kind: 'invalid' };
    const name = m[1];
    const rest = trimmed.slice(name.length);
    if (rest === '') return { kind: 'normal', name, args: [], sep: 'none' };
    if (rest.startsWith('::')) return { kind: 'normal', name, args: splitTopLevel(rest.slice(2), '::'), sep: '::' };
    if (rest.startsWith(':')) return { kind: 'normal', name, args: [rest.slice(1)], sep: ':' };
    if (/^\s/.test(rest)) return { kind: 'normal', name, args: [rest.trim()], sep: 'space' };
    // 形如 {{time_UTC+8}} 这种名字后直接跟符号，交给预处理；其余视为无效
    return { kind: 'invalid' };
}

// ---------- 时间格式 ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(d, fmt) {
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const h12 = d.getHours() % 12 || 12;
    const map = {
        YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
        MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate(), dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3),
        HH: pad(d.getHours()), H: d.getHours(), hh: pad(h12), h: h12, mm: pad(d.getMinutes()), m: d.getMinutes(), ss: pad(d.getSeconds()), s: d.getSeconds(),
        A: d.getHours() >= 12 ? 'PM' : 'AM', a: d.getHours() >= 12 ? 'pm' : 'am',
    };
    if (fmt === 'LT') fmt = 'h:mm A';
    if (fmt === 'LL') fmt = 'MMMM D, YYYY';
    if (fmt === 'LLL') fmt = 'MMMM D, YYYY h:mm A';
    return fmt.replace(/\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g, (t, lit) => lit !== undefined ? lit : String(map[t]));
}

export function humanizeDuration(ms) {
    const s = Math.abs(ms) / 1000;
    if (s < 45) return 'a few seconds';
    if (s < 90) return 'a minute';
    const min = s / 60;
    if (min < 45) return `${Math.round(min)} minutes`;
    if (min < 90) return 'an hour';
    const h = min / 60;
    if (h < 22) return `${Math.round(h)} hours`;
    if (h < 36) return 'a day';
    const days = h / 24;
    if (days < 26) return `${Math.round(days)} days`;
    if (days < 45) return 'a month';
    if (days < 320) return `${Math.round(days / 30.4)} months`;
    if (days < 548) return 'a year';
    return `${Math.round(days / 365)} years`;
}

function rollDice(formula, rand = Math.random) {
    let f = String(formula ?? '').trim().replace(/\s+/g, '');
    if (/^\d+$/.test(f)) f = `1d${f}`;
    const m = f.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
    if (!m) return '';
    const count = Number(m[1] || 1), sides = Number(m[2]), mod = Number(m[3] || 0);
    if (count > 1000 || sides < 1) return '';
    let total = 0;
    for (let i = 0; i < count; i++) total += 1 + Math.floor(rand() * sides);
    return String(total + mod);
}

function splitLegacyList(arg) {
    // {{random:a,b,c}}，支持 \, 转义
    return arg.replace(/\\,/g, '\u0001').split(',').map(x => x.replace(/\u0001/g, ',').trim());
}

// ---------- 引擎 ----------

export class MacroEngine {
    constructor() {
        /** @type {Map<string, {handler: Function, delayArgs?: boolean, list?: boolean}>} */
        this.macros = new Map();
        registerCoreMacros(this);
    }

    register(name, def, aliases = []) {
        const d = typeof def === 'function' ? { handler: def } : def;
        this.macros.set(name.toLowerCase(), d);
        for (const a of aliases) this.macros.set(a.toLowerCase(), d);
    }

    unregister(name) {
        this.macros.delete(name.toLowerCase());
    }

    has(name) {
        return this.macros.has(String(name).toLowerCase());
    }

    /**
     * @param {string} text
     * @param {object} env 见 buildMacroEnv
     */
    evaluate(text, env = {}, { postProcess } = {}) {
        if (typeof text !== 'string' || !text) return text ?? '';
        let input = text
            .replace(/{{time_(UTC[+-]\d+)}}/gi, (_, off) => `{{time::${off}}}`)
            .replace(/<USER>/gi, '{{user}}')
            .replace(/<BOT>/gi, '{{char}}')
            .replace(/<CHAR>/gi, '{{char}}')
            .replace(/<GROUP>/gi, '{{group}}')
            .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}');
        if (!input.includes('{{')) return /\\[{}]/.test(input) ? input.replace(/\\([{}])/g, '$1') : input;
        const ctx = { env, raw: input, depth: 0, postProcess };
        let out = this.#evalText(input, ctx, 0);
        // {{trim}} 旧语义：吃掉两侧换行
        out = out.replace(new RegExp(`(?:\\r?\\n)*${TRIM_MARKER}(?:\\r?\\n)*`, 'g'), '');
        out = out.replaceAll(ELSE_MARKER, '');
        out = out.replace(/\\([{}])/g, '$1');
        return out;
    }

    #evalText(text, ctx, baseOffset) {
        if (!text.includes('{{')) return text;
        if (ctx.depth > 40) return text;
        ctx.depth++;
        try {
            const tokens = tokenize(text);
            // 作用域配对：{{name ...}} ... {{/name}}
            const parsed = tokens.map(t => t.type === 'macro' ? { ...t, info: parseBody(t.body) } : t);
            const stacks = new Map();
            for (let i = 0; i < parsed.length; i++) {
                const t = parsed[i];
                if (t.type !== 'macro') continue;
                if (t.info.kind === 'normal') {
                    const key = t.info.name.toLowerCase();
                    if (key === 'if' && t.info.args.length !== 1) continue;
                    if (!stacks.has(key)) stacks.set(key, []);
                    stacks.get(key).push(i);
                } else if (t.info.kind === 'close') {
                    const st = stacks.get(t.info.name);
                    if (st?.length) {
                        const openIdx = st.pop();
                        parsed[openIdx].closeIdx = i;
                    }
                }
            }
            let out = '';
            for (let i = 0; i < parsed.length; i++) {
                const t = parsed[i];
                if (t.type === 'text') { out += t.value; continue; }
                if (t.closeIdx !== undefined) {
                    const close = parsed[t.closeIdx];
                    const content = text.slice(t.end, close.start);
                    out += this.#call(t, ctx, baseOffset, content);
                    i = t.closeIdx;
                    continue;
                }
                if (t.info.kind === 'close') { out += text.slice(t.start, t.end); continue; }
                out += this.#call(t, ctx, baseOffset, undefined);
            }
            return out;
        } finally {
            ctx.depth--;
        }
    }

    #call(tok, ctx, baseOffset, scopedContent) {
        const info = tok.info;
        const raw = `{{${tok.body}}}`;
        if (info.kind === 'var') return this.#evalVarShorthand(info.expr, ctx, baseOffset + tok.start);
        if (info.kind !== 'normal') return raw;
        let def = this.macros.get(info.name.toLowerCase());
        if (!def && ctx.env.extra) {
            // 运行时附加的宏（如 {{original}}、{{lastChatMessage}}、插件注册的宏）
            const lower = info.name.toLowerCase();
            const key = Object.keys(ctx.env.extra).find(k => k.toLowerCase() === lower);
            if (key !== undefined) {
                const v = ctx.env.extra[key];
                def = typeof v === 'function' ? { handler: ({ args, env: e }) => v(args, e) } : { handler: () => v };
            }
        }
        if (!def) {
            // 未知宏：保持原样，但仍处理其中嵌套的已知宏
            const inner = this.#evalText(tok.body, ctx, baseOffset + tok.start + 2);
            const restored = `{{${inner}}}`;
            return scopedContent !== undefined ? restored + scopedContent + `{{/${info.name}}}` : restored;
        }
        const evalArg = (s) => this.#evalText(s, ctx, baseOffset + tok.start);
        let args = info.args.slice();
        // 旧语法 {{random:a,b}} / {{random::a,b}} / {{random a,b}}：单个参数时按逗号切
        if (def.list && args.length === 1 && info.sep !== 'comment') args = splitLegacyList(args[0]);
        if (!def.delayArgs) args = args.map(a => evalArg(a));
        if (scopedContent !== undefined) {
            const content = def.delayArgs ? scopedContent : evalArg(trimScoped(scopedContent));
            args.push(def.delayArgs ? scopedContent : content);
        }
        try {
            const result = def.handler({
                args,
                list: args,
                env: ctx.env,
                isScoped: scopedContent !== undefined,
                raw,
                offset: baseOffset + tok.start,
                rawText: ctx.raw,
                resolve: (s) => this.#evalText(s, ctx, baseOffset + tok.start),
                engine: this,
            });
            const value = normalizeMacroValue(result);
            return ctx.postProcess && ctx.depth === 1 ? ctx.postProcess(value) : value;
        } catch (e) {
            console.warn('[macro] 执行失败', info.name, e);
            return raw;
        }
    }

    #evalVarShorthand(expr, ctx, offset) {
        const vars = ctx.env.vars;
        if (!vars) return '';
        const scope = expr[0] === '$' ? vars.global : vars.local;
        const m = expr.slice(1).match(/^([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)\s*(\+\+|--|\+=|-=|\|\|=|\?\?=|\|\||\?\?|==|!=|>=|<=|>|<|=)?\s*([\s\S]*)$/u);
        if (!m) return `{{${expr}}}`;
        const [, name, op, rawValue] = m;
        const value = () => this.#evalText(rawValue, ctx, offset);
        const cur = () => scope.get(name);
        const num = (x) => Number(x);
        switch (op) {
            case undefined: return normalizeMacroValue(cur());
            case '=': scope.set(name, value()); return '';
            case '++': { const n = (num(cur()) || 0) + 1; scope.set(name, n); return String(n); }
            case '--': { const n = (num(cur()) || 0) - 1; scope.set(name, n); return String(n); }
            case '+=': { scope.set(name, addValue(cur(), value())); return ''; }
            case '-=': { const v = num(value()); if (!Number.isNaN(v)) scope.set(name, (num(cur()) || 0) - v); return ''; }
            case '||': return isFalsyCondition(cur()) ? value() : normalizeMacroValue(cur());
            case '??': return scope.has(name) ? normalizeMacroValue(cur()) : value();
            case '||=': if (isFalsyCondition(cur())) scope.set(name, value()); return '';
            case '??=': if (!scope.has(name)) scope.set(name, value()); return '';
            case '==': return String(normalizeMacroValue(cur()) === value());
            case '!=': return String(normalizeMacroValue(cur()) !== value());
            case '>': return String(num(cur()) > num(value()));
            case '>=': return String(num(cur()) >= num(value()));
            case '<': return String(num(cur()) < num(value()));
            case '<=': return String(num(cur()) <= num(value()));
        }
        return '';
    }
}

function trimScoped(s) {
    return s.replace(/^\s*\n/, '').replace(/\n\s*$/, '').trim();
}

/** addvar 语义：数组 push、数字相加、否则字符串拼接（与酒馆 addLocalVariable 一致） */
export function addValue(current, value) {
    let cur = current;
    if (cur && typeof cur === 'object') cur = JSON.stringify(cur);
    cur = cur || 0;
    try {
        const parsed = JSON.parse(cur);
        if (Array.isArray(parsed)) {
            parsed.push(value);
            return JSON.stringify(parsed);
        }
    } catch { /* 不是数组 */ }
    const inc = Number(value);
    if (Number.isNaN(inc) || Number.isNaN(Number(cur))) return String(cur || '') + value;
    const next = Number(cur) + inc;
    return Number.isNaN(next) ? '' : next;
}

function splitElse(content) {
    // 顶层的 {{else}}（不进入嵌套 {{if}}...{{/if}}）
    const tokens = tokenize(content);
    let depth = 0;
    for (const t of tokens) {
        if (t.type !== 'macro') continue;
        const info = parseBody(t.body);
        if (info.kind === 'normal' && info.name.toLowerCase() === 'if' && info.args.length === 1) depth++;
        else if (info.kind === 'close' && info.name === 'if') depth--;
        else if (depth === 0 && info.kind === 'normal' && info.name.toLowerCase() === 'else' && info.args.length === 0) {
            return [content.slice(0, t.start), content.slice(t.end)];
        }
    }
    return [content, undefined];
}

function registerCoreMacros(engine) {
    const env = (ctx) => ctx.env;
    const field = (key) => ({ handler: (c) => {
        const v = env(c)[key];
        return typeof v === 'function' ? v() : v;
    } });

    engine.register('space', ({ args }) => ' '.repeat(Number(args[0] ?? 1) || 1));
    engine.register('newline', ({ args }) => '\n'.repeat(Number(args[0] ?? 1) || 1));
    engine.register('noop', () => '');
    engine.register('trim', ({ args, isScoped }) => isScoped ? (args[args.length - 1] ?? '').trim() : TRIM_MARKER);
    engine.register('else', () => ELSE_MARKER);
    engine.register('if', {
        delayArgs: true,
        handler: ({ args, resolve, env: e }) => {
            let cond = String(args[0] ?? '').trim();
            let content = args[1] ?? '';
            let invert = false;
            if (cond.startsWith('!')) { invert = true; cond = cond.slice(1).trim(); }
            let value;
            if (/^[.$][\p{L}\p{N}_-]/u.test(cond)) {
                const scope = cond[0] === '$' ? e.vars?.global : e.vars?.local;
                value = normalizeMacroValue(scope?.get(cond.slice(1)));
            } else if (/^[\p{L}_][\p{L}\p{N}_-]*$/u.test(cond) && engine.has(cond)) {
                value = resolve(`{{${cond}}}`);
            } else {
                value = resolve(cond);
            }
            let truthy = !isFalsyCondition(value);
            if (invert) truthy = !truthy;
            const [thenPart, elsePart] = splitElse(content);
            const chosen = truthy ? thenPart : (elsePart ?? '');
            return resolve(trimScoped(chosen));
        },
    });
    engine.register('input', field('input'));
    engine.register('maxPrompt', field('maxPrompt'), ['maxPromptTokens']);
    engine.register('maxContext', field('maxContext'), ['maxContextTokens']);
    engine.register('maxResponse', field('maxResponse'), ['maxResponseTokens']);
    engine.register('reverse', ({ args }) => Array.from(String(args[0] ?? '')).reverse().join(''));
    engine.register('//', () => '', ['comment']);
    engine.register('roll', ({ args }) => rollDice(args[0]));
    engine.register('random', { list: true, handler: ({ list }) => list.length ? list[Math.floor(Math.random() * list.length)] : '' });
    engine.register('pick', {
        list: true,
        handler: ({ list, env: e, offset, rawText }) => {
            if (!list.length) return '';
            const seed = hashString(`${e.chatId ?? ''}|${hashString(rawText)}|${offset}`);
            return list[Math.floor(seededRandom(seed)() * list.length)];
        },
    });
    engine.register('banned', () => '');
    engine.register('outlet', ({ args, env: e }) => e.outlets?.[String(args[0] ?? '').trim()] ?? '');

    // 角色与环境
    engine.register('user', field('user'));
    engine.register('char', field('char'));
    engine.register('group', { handler: (c) => env(c).group ?? env(c).char }, ['charIfNotGroup']);
    engine.register('groupNotMuted', { handler: (c) => env(c).group ?? env(c).char });
    engine.register('notChar', field('user'));
    engine.register('charPrompt', field('charPrompt'));
    engine.register('charInstruction', field('charInstruction'), ['charJailbreak']);
    engine.register('charDescription', field('description'), ['description']);
    engine.register('charPersonality', field('personality'), ['personality']);
    engine.register('charScenario', field('scenario'), ['scenario']);
    engine.register('persona', field('persona'));
    engine.register('mesExamplesRaw', field('mesExamplesRaw'));
    engine.register('mesExamples', field('mesExamples'));
    engine.register('charDepthPrompt', field('charDepthPrompt'));
    engine.register('charCreatorNotes', field('creatorNotes'), ['creatorNotes']);
    engine.register('charFirstMessage', field('firstMessage'), ['greeting']);
    engine.register('charVersion', field('charVersion'), ['version', 'char_version']);
    engine.register('model', field('model'));
    engine.register('original', { handler: (c) => {
        const o = env(c).original;
        if (typeof o === 'function') return o();
        // {{original}} 只展开一次（与酒馆一致）
        env(c).original = '';
        return o ?? '';
    } });
    engine.register('isMobile', field('isMobile'));
    engine.register('systemPrompt', field('systemPrompt'));
    engine.register('lastGenerationType', field('lastGenerationType'));
    engine.register('hasExtension', ({ args, env: e }) => String(!!e.hasExtension?.(args[0])));

    // 聊天
    const chat = (c) => env(c).chat ?? [];
    const visible = (c) => chat(c).filter(m => !m.is_system);
    engine.register('lastMessage', (c) => visible(c).at(-1)?.mes ?? '');
    engine.register('lastMessageId', (c) => chat(c).length ? String(chat(c).length - 1) : '');
    engine.register('lastUserMessage', (c) => visible(c).filter(m => m.is_user).at(-1)?.mes ?? '');
    engine.register('lastCharMessage', (c) => visible(c).filter(m => !m.is_user).at(-1)?.mes ?? '');
    engine.register('firstIncludedMessageId', field('firstIncludedMessageId'));
    engine.register('firstDisplayedMessageId', (c) => env(c).firstDisplayedMessageId ?? '0');
    engine.register('lastSwipeId', (c) => {
        const m = chat(c).at(-1);
        return m?.swipes?.length ? String(m.swipes.length) : '';
    });
    engine.register('currentSwipeId', (c) => {
        const m = chat(c).at(-1);
        return m?.swipes?.length ? String((m.swipe_id ?? 0) + 1) : '';
    });

    // 时间
    const now = (c) => env(c).now ? new Date(env(c).now) : new Date();
    engine.register('time', ({ args, env: e }) => {
        const d = e.now ? new Date(e.now) : new Date();
        const off = String(args[0] ?? '').match(/UTC([+-]\d+)/i);
        if (off) {
            const utc = d.getTime() + d.getTimezoneOffset() * 60000;
            return formatDate(new Date(utc + Number(off[1]) * 3600000), 'LT');
        }
        return formatDate(d, 'LT');
    });
    engine.register('date', (c) => formatDate(now(c), 'LL'));
    engine.register('weekday', (c) => formatDate(now(c), 'dddd'));
    engine.register('isotime', (c) => formatDate(now(c), 'HH:mm'));
    engine.register('isodate', (c) => formatDate(now(c), 'YYYY-MM-DD'));
    engine.register('datetimeformat', (c) => formatDate(now(c), String(c.args[0] ?? '').trim() || 'LLL'));
    engine.register('idleDuration', (c) => {
        const lastUser = [...chat(c)].reverse().find(m => m.is_user && !m.is_system);
        const t = lastUser?.send_date ? Date.parse(lastUser.send_date) : NaN;
        return Number.isNaN(t) ? 'just now' : humanizeDuration(now(c).getTime() - t);
    }, ['idle_duration']);
    engine.register('timeDiff', ({ args }) => {
        const a = Date.parse(args[0]), b = Date.parse(args[1]);
        if (Number.isNaN(a) || Number.isNaN(b)) return '';
        return humanizeDuration(a - b);
    });

    // 变量（本地=聊天，全局）
    const scope = (c, g) => (g ? env(c).vars?.global : env(c).vars?.local);
    for (const [prefix, g] of [['', false], ['global', true]]) {
        const n = (s) => (g ? s.replace('var', 'globalvar') : s);
        engine.register(n('setvar'), (c) => { scope(c, g)?.set(String(c.args[0]).trim(), c.args[1] ?? ''); return ''; });
        engine.register(n('addvar'), (c) => {
            const s = scope(c, g), k = String(c.args[0]).trim();
            s?.set(k, addValue(s.get(k), c.args[1] ?? ''));
            return '';
        });
        engine.register(n('incvar'), (c) => {
            const s = scope(c, g), k = String(c.args[0]).trim();
            const v = addValue(s?.get(k), 1);
            s?.set(k, v);
            return v;
        });
        engine.register(n('decvar'), (c) => {
            const s = scope(c, g), k = String(c.args[0]).trim();
            const v = addValue(s?.get(k), -1);
            s?.set(k, v);
            return v;
        });
        engine.register(n('getvar'), (c) => scope(c, g)?.get(String(c.args[0]).trim()));
        engine.register(n('hasvar'), (c) => String(!!scope(c, g)?.has(String(c.args[0]).trim())), [g ? 'globalvarexists' : 'varexists']);
        engine.register(n('deletevar'), (c) => { scope(c, g)?.delete(String(c.args[0]).trim()); return ''; }, [g ? 'flushglobalvar' : 'flushvar']);
        void prefix;
    }
}

/** 默认单例 */
export const macroEngine = new MacroEngine();

/**
 * 简单变量作用域适配器：把普通对象包装成 get/set/has/delete
 * 值是对象时 get 返回原对象，由宏规范化成 JSON。
 */
export function objectScope(obj, onChange) {
    return {
        get: (k) => obj[k],
        set: (k, v) => { obj[k] = v; onChange?.(k, v); },
        has: (k) => Object.prototype.hasOwnProperty.call(obj, k),
        delete: (k) => { delete obj[k]; onChange?.(k, undefined); },
        raw: obj,
    };
}
