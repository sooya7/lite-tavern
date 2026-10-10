// MVU（MagVarUpdate）变量框架的原生实现：
// - [initvar] 世界书条目（YAML/JSON）→ 初始 stat_data
// - AI 回复里的 <UpdateVariable>：新格式 <JSONPatch>[...]</JSONPatch>（replace/delta/insert/remove/move/add）
//   与旧格式 _.set/_.add/_.insert/_.assign/_.remove/_.delete
// - 每层消息的 variables[swipe] = { stat_data, display_data, delta_data }
import yaml from '../../vendor/js-yaml.mjs';
import { getPath, setPath, hasPath, unsetPath, clone, isPlainObject, toPath, deepMerge } from './util.js';

export const MVU_KEYS = ['stat_data', 'display_data', 'delta_data'];

/** MVU 对外的事件名（与 MagVarUpdate 一致，脚本和前端卡靠这些名字监听） */
export const MVU_EVENTS = {
    VARIABLE_INITIALIZED: 'mag_variable_initialized',
    VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
    COMMAND_PARSED: 'mag_command_parsed',
    VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
    BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
};

/** MVU 会在每条 AI 回复末尾补上这个占位符，卡里的正则把它换成状态栏 */
export const STATUS_PLACEHOLDER = '<StatusPlaceHolderImpl/>';

export function parseYamlOrJson(text) {
    const s = String(text ?? '').trim();
    if (!s) return undefined;
    try { return JSON.parse(s); } catch { /* 再试 YAML */ }
    return yaml.load(s);
}

export function dumpYaml(obj) {
    try {
        return yaml.dump(obj, { lineWidth: -1, noRefs: true, sortKeys: false });
    } catch {
        return JSON.stringify(obj, null, 2);
    }
}

/** 是否像 MVU 卡：酒馆助手脚本里引了 MagVarUpdate，或世界书里有 [initvar] */
export function detectMvu({ scripts = [], entries = [] } = {}) {
    const byScript = scripts.some(s => /MagVarUpdate|MVU-offline|mvu_bundle/i.test(s?.content ?? ''));
    const byEntry = entries.some(e => isInitVarEntry(e));
    return byScript || byEntry;
}

export function isInitVarEntry(e) {
    const c = String(e?.comment ?? '');
    return /\[initvar]/i.test(c) || /\[InitialVariables]/i.test(c) || /^@@initial_variables/m.test(String(e?.content ?? ''));
}

/** 从世界书条目汇总初始变量（不管条目是否禁用，MVU 也是这么读的） */
export function collectInitVars(entries) {
    const out = {};
    for (const e of entries) {
        if (!isInitVarEntry(e)) continue;
        const content = String(e.content ?? '').replace(/^@@initial_variables[^\n]*\n?/m, '');
        try {
            const data = parseYamlOrJson(content);
            if (isPlainObject(data)) deepMerge(out, data);
        } catch (err) {
            console.warn('[MVU] 初始变量解析失败', e.comment, err);
        }
    }
    return out;
}

/**
 * 开场白里的 <initvar> 块。MVU 的规则：某个开场带了这个块，这个开场就以块里的内容当初始变量，
 * 不再用角色世界书里的 [initvar]（多开场的卡靠它让每个开场有自己的初始状态）。
 * 没有这个块、或者块都解析不了，返回 null。
 * @param {(t: string) => string} [substitute] 宏替换
 */
export function greetingInitVars(text, substitute = (t) => t) {
    let out = null;
    for (const m of String(text ?? '').matchAll(/<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim)) {
        try {
            const data = parseYamlOrJson(substitute(m[2]));
            out ??= {};
            if (isPlainObject(data)) deepMerge(out, data);
        } catch (err) {
            console.warn('[MVU] 开场白里的 <initvar> 解析失败', err);
        }
    }
    return out;
}

/** 提取 <UpdateVariable> 块（最后一个允许没闭合，处理截断） */
export function extractUpdateBlocks(text) {
    const s = String(text ?? '');
    const blocks = [];
    const re = /<UpdateVariable>([\s\S]*?)(?:<\/UpdateVariable>|$)/gi;
    let m;
    while ((m = re.exec(s))) {
        blocks.push(m[1]);
        if (m[0].length === 0) break;
    }
    return blocks;
}

// ---------- 宽松字面量解析（旧格式 _.set('a', 1, "x")） ----------
function parseArgs(src) {
    const args = [];
    let i = 0;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const value = () => {
        ws();
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            let out = '';
            while (i < src.length && src[i] !== q) {
                if (src[i] === '\\' && i + 1 < src.length) {
                    const n = src[i + 1];
                    out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
                    i += 2;
                } else out += src[i++];
            }
            i++;
            return out;
        }
        if (c === '[' || c === '{') {
            const open = c, close = c === '[' ? ']' : '}';
            let depth = 0, start = i, inStr = null;
            for (; i < src.length; i++) {
                const ch = src[i];
                if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
                if (ch === '"' || ch === "'") inStr = ch;
                else if (ch === open) depth++;
                else if (ch === close) { depth--; if (depth === 0) { i++; break; } }
            }
            const raw = src.slice(start, i);
            try { return JSON.parse(raw); } catch { /* 宽松 */ }
            try { return parseYamlOrJson(raw); } catch { return raw; }
        }
        let start = i;
        while (i < src.length && src[i] !== ',' && src[i] !== ')') i++;
        const raw = src.slice(start, i).trim();
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        if (raw === 'null' || raw === 'undefined') return null;
        if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
        return raw;
    };
    while (i < src.length) {
        ws();
        if (src[i] === ')' || i >= src.length) break;
        args.push(value());
        ws();
        if (src[i] === ',') i++;
        else break;
    }
    return args;
}

function findCallEnd(src, start) {
    let depth = 0, inStr = null;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/** 把参数串按顶层逗号切开，保留每个参数的原文（给监听 mag_command_parsed 的脚本看的就是原文） */
function splitArgs(src) {
    const out = [];
    let depth = 0, inStr = null, start = 0;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inStr) { if (ch === '\\') i++; else if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') inStr = ch;
        else if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
    }
    const last = src.slice(start).trim();
    if (last || out.length) out.push(last);
    return out.filter((a, i, arr) => a !== '' || i < arr.length - 1);
}

/** 解析一个 UpdateVariable 块 → 命令列表 */
export function parseCommands(block) {
    const cmds = [];
    const jp = block.match(/<JSONPatch>([\s\S]*?)(?:<\/JSONPatch>|$)/i);
    let patchText = jp ? jp[1] : null;
    if (!patchText && /^\s*\[\s*\{/.test(block.replace(/<Analysis>[\s\S]*?<\/Analysis>/i, ''))) {
        patchText = block.replace(/<Analysis>[\s\S]*?<\/Analysis>/i, '');
    }
    if (patchText) {
        const cleaned = patchText.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
        let ops = null;
        try { ops = JSON.parse(cleaned); } catch {
            try { ops = JSON.parse(cleaned.replace(/,\s*([\]}])/g, '$1')); } catch {
                try { ops = parseYamlOrJson(cleaned); } catch { ops = null; }
            }
        }
        if (Array.isArray(ops)) {
            for (const op of ops) if (op && typeof op === 'object' && op.op) cmds.push({ kind: 'patch', ...op, full: JSON.stringify(op) });
        }
    }
    // 旧格式 _.xxx(...)
    const re = /_\.(set|add|insert|assign|remove|delete|unset)\s*\(/g;
    let m;
    while ((m = re.exec(block))) {
        const open = m.index + m[0].length - 1;
        const end = findCallEnd(block, open);
        if (end < 0) break;
        const inner = block.slice(open + 1, end);
        const args = parseArgs(inner);
        const tail = block.slice(end + 1, block.indexOf('\n', end) === -1 ? block.length : block.indexOf('\n', end));
        const reason = (tail.match(/\/\/\s*(.*)$/) || [])[1]?.trim() ?? '';
        cmds.push({ kind: 'legacy', fn: m[1], args, reason, rawArgs: splitArgs(inner), full: block.slice(m.index, end + 1) });
        re.lastIndex = end + 1;
    }
    return cmds;
}

/** JSON Pointer 或 lodash 路径 → 路径数组 */
export function parsePath(p) {
    if (Array.isArray(p)) return p;
    const s = String(p ?? '');
    if (s.startsWith('/')) return s.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    return toPath(s);
}

// 旧版 MVU 的 [值, 描述] 结构
const isVWD = (v) => Array.isArray(v) && v.length === 2 && typeof v[1] === 'string' && !Array.isArray(v[0]);

function coerceLike(oldVal, newVal) {
    if (typeof oldVal === 'number' && typeof newVal === 'string' && newVal.trim() !== '' && !Number.isNaN(Number(newVal))) return Number(newVal);
    if (typeof oldVal === 'boolean' && (newVal === 'true' || newVal === 'false')) return newVal === 'true';
    return newVal;
}

/**
 * 在 stat_data 上执行命令。返回 {data, delta, errors}
 * delta: { 'a.b': [old, new, reason] }
 */
export function applyCommands(statData, cmds) {
    const data = clone(statData ?? {});
    const delta = {};
    const errors = [];
    const record = (path, oldV, newV, reason = '') => { delta[path.join('.')] = [oldV, newV, reason]; };

    for (const c of cmds) {
        try {
            if (c.kind === 'patch') {
                const op = String(c.op).toLowerCase();
                const path = parsePath(c.path ?? c.to);
                switch (op) {
                    case 'replace':
                    case 'set': {
                        const old = getPath(data, path);
                        const nv = isVWD(old) && !Array.isArray(c.value) ? [coerceLike(old[0], c.value), old[1]] : coerceLike(old, c.value);
                        setPath(data, path, nv);
                        record(path, old, nv);
                        break;
                    }
                    case 'delta': {
                        const old = getPath(data, path);
                        const base = isVWD(old) ? old[0] : old;
                        const nv = (Number(base) || 0) + Number(c.value);
                        if (Number.isNaN(nv)) throw new Error(`delta 不是数字: ${c.path}`);
                        setPath(data, path, isVWD(old) ? [nv, old[1]] : nv);
                        record(path, base, nv);
                        break;
                    }
                    case 'insert':
                    case 'add': {
                        const parentPath = path.slice(0, -1);
                        const last = path[path.length - 1];
                        const parent = parentPath.length ? getPath(data, parentPath) : data;
                        if (Array.isArray(parent)) {
                            if (last === '-' || last === undefined) parent.push(c.value);
                            else parent.splice(Number(last), 0, c.value);
                        } else if (parent && typeof parent === 'object') {
                            parent[last] = c.value;
                        } else {
                            setPath(data, path, c.value);
                        }
                        record(path, undefined, c.value);
                        break;
                    }
                    case 'remove': {
                        const old = getPath(data, path);
                        if (!hasPath(data, path)) break;
                        unsetPath(data, path);
                        record(path, old, undefined);
                        break;
                    }
                    case 'move': {
                        const from = parsePath(c.from);
                        const to = parsePath(c.to ?? c.path);
                        const v = getPath(data, from);
                        unsetPath(data, from);
                        setPath(data, to, v);
                        record(to, undefined, v);
                        break;
                    }
                    case 'copy': {
                        const v = clone(getPath(data, parsePath(c.from)));
                        setPath(data, path, v);
                        record(path, undefined, v);
                        break;
                    }
                    default:
                        break;
                }
            } else if (c.kind === 'legacy') {
                const [p, a1, a2] = c.args;
                const path = parsePath(p);
                switch (c.fn) {
                    case 'set': {
                        const nvRaw = c.args.length >= 3 ? a2 : a1;
                        const old = getPath(data, path);
                        const nv = isVWD(old) && !Array.isArray(nvRaw) ? [coerceLike(old[0], nvRaw), old[1]] : coerceLike(old, nvRaw);
                        setPath(data, path, nv);
                        record(path, isVWD(old) ? old[0] : old, isVWD(nv) ? nv[0] : nv, c.reason);
                        break;
                    }
                    case 'add': {
                        const old = getPath(data, path);
                        const base = isVWD(old) ? old[0] : old;
                        if (Array.isArray(base)) {
                            base.push(a1);
                            record(path, undefined, a1, c.reason);
                        } else {
                            const nv = (Number(base) || 0) + Number(a1);
                            setPath(data, path, isVWD(old) ? [nv, old[1]] : nv);
                            record(path, base, nv, c.reason);
                        }
                        break;
                    }
                    case 'insert':
                    case 'assign': {
                        const target = getPath(data, path);
                        if (c.args.length >= 3) {
                            if (Array.isArray(target)) { if (a1 === '-') target.push(a2); else target.splice(Number(a1), 0, a2); }
                            else if (target && typeof target === 'object') target[a1] = a2;
                            else setPath(data, [...path, a1], a2);
                        } else if (Array.isArray(target)) target.push(a1);
                        else if (isPlainObject(target) && isPlainObject(a1)) Object.assign(target, a1);
                        else setPath(data, path, a1);
                        record(path, undefined, c.args.length >= 3 ? a2 : a1, c.reason);
                        break;
                    }
                    case 'remove':
                    case 'delete':
                    case 'unset': {
                        if (c.args.length >= 2) {
                            const target = getPath(data, path);
                            if (Array.isArray(target)) {
                                const i = typeof a1 === 'number' ? a1 : target.findIndex(x => JSON.stringify(x) === JSON.stringify(a1));
                                if (i >= 0) target.splice(i, 1);
                            } else if (target && typeof target === 'object') delete target[a1];
                        } else {
                            unsetPath(data, path);
                        }
                        record(path, undefined, undefined, c.reason);
                        break;
                    }
                    case 'move': {
                        const to = parsePath(a1);
                        if (!hasPath(data, path)) throw new Error(`移动的源路径不存在: ${path.join('.')}`);
                        const v = getPath(data, path);
                        unsetPath(data, path);
                        setPath(data, to, v);
                        record(to, undefined, v, c.reason);
                        break;
                    }
                }
            }
        } catch (err) {
            errors.push(`${c.op ?? c.fn}: ${err.message}`);
        }
    }
    return { data, delta, errors };
}

/** display_data：变动过的叶子写成 "旧->新" */
export function buildDisplayData(data, delta) {
    const out = clone(data);
    for (const [p, [oldV, newV]] of Object.entries(delta)) {
        if (oldV === undefined || newV === undefined || typeof newV === 'object') continue;
        try { setPath(out, p, `${oldV}->${newV}`); } catch { /* 忽略 */ }
    }
    return out;
}

/**
 * 处理一条 AI 消息：基于上一层 stat_data 应用本条消息的更新命令。
 * @returns {{variables: object, changed: boolean, errors: string[]}}
 */
export function processMessage(prevVars, text) {
    const prev = prevVars?.stat_data ?? {};
    const blocks = extractUpdateBlocks(text);
    const cmds = blocks.flatMap(parseCommands);
    const { data, delta, errors } = applyCommands(prev, cmds);
    const variables = {
        ...clone(prevVars ?? {}),
        stat_data: data,
        display_data: buildDisplayData(data, delta),
        delta_data: delta,
    };
    return { variables, changed: cmds.length > 0, errors, commandCount: cmds.length };
}

/** 找到 <= upto 的最近一层带 stat_data 的变量 */
export function latestMvuVars(chat, upto) {
    for (let i = Math.min(upto ?? chat.length - 1, chat.length - 1); i >= 0; i--) {
        const m = chat[i];
        const v = Array.isArray(m?.variables) ? m.variables[m.swipe_id ?? 0] : null;
        if (v && isPlainObject(v.stat_data)) return { index: i, vars: v };
    }
    return null;
}

// ---------- 带事件的更新流程（有脚本在监听 MVU 事件时走这条路） ----------
// 事件顺序和参数与 MagVarUpdate（MIT，MagicalAstrogy & StageDog）一致，这样卡里的变量结构脚本
// （registerMvuSchema）、给变量设上下限的脚本不用改就能工作。

const trimQuotes = (s) => String(s ?? '').replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1');
const lodashPath = (segments) => segments.map(seg => `["${String(seg).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join('');
const pointerPath = (p) => lodashPath(parsePath(p ?? ''));
const TYPE_ALIAS = { remove: 'delete', unset: 'delete', assign: 'insert' };

function parseLiteral(raw) {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { /* 不是 JSON，按宽松字面量解析 */ }
    const v = parseArgs(raw);
    return v.length ? v[0] : trimQuotes(raw);
}

/** 内部命令 → MVU 的 CommandInfo（参数是原文字符串）。表示不了的（copy）返回 null，留给内置执行 */
export function toCommandInfo(c) {
    if (c.kind === 'legacy') {
        return { type: TYPE_ALIAS[c.fn] ?? c.fn, full_match: c.full ?? '', args: [...(c.rawArgs ?? c.args.map(a => JSON.stringify(a)))], reason: c.reason ?? '' };
    }
    const full = c.full ?? JSON.stringify({ op: c.op, path: c.path, value: c.value });
    const path = pointerPath(c.path ?? c.to);
    switch (String(c.op).toLowerCase()) {
        case 'replace': case 'set': return { type: 'set', full_match: full, args: [path, JSON.stringify(c.value)], reason: 'json_patch' };
        case 'delta': return { type: 'add', full_match: full, args: [path, JSON.stringify(c.value)], reason: 'json_patch' };
        case 'insert': case 'add': {
            const parts = parsePath(c.path ?? c.to);
            const last = String(parts[parts.length - 1] ?? '-');
            return { type: 'insert', full_match: full, args: [lodashPath(parts.slice(0, -1)), /^\d+$/.test(last) ? last : JSON.stringify(last), JSON.stringify(c.value)], reason: 'json_patch' };
        }
        case 'remove': return { type: 'delete', full_match: full, args: [path], reason: 'json_patch' };
        case 'move': return { type: 'move', full_match: full, args: [pointerPath(c.from), path], reason: 'json_patch' };
        default: return null;
    }
}

/** CommandInfo → 内部命令（监听者可能改过、加过） */
export function fromCommandInfo(info) {
    const type = TYPE_ALIAS[info?.type] ?? info?.type;
    const raw = Array.isArray(info?.args) ? info.args : [];
    const path = trimQuotes(raw[0]).replace(/^(?:stat_data|status_current_variables)\./, '');
    const rest = raw.slice(1).map((a, i) => (type === 'move' && i === 0 ? trimQuotes(a).replace(/^(?:stat_data|status_current_variables)\./, '') : parseLiteral(a)));
    return { kind: 'legacy', fn: type, args: [path, ...rest], reason: info?.reason === 'json_patch' ? '' : (info?.reason ?? '') };
}

/** 一段 AI 回复里的全部更新命令（内部格式） */
export function extractCommands(text) {
    return extractUpdateBlocks(text).flatMap(parseCommands);
}

/**
 * 处理一条 AI 消息，过程中发 MVU 事件。监听者可以改命令（mag_command_parsed）、
 * 改更新后的变量（mag_variable_update_ended）。emit 要等监听者跑完再返回。
 * @param {object} prevVars 上一层的变量（不会被改）
 * @param {string} text 消息正文
 * @param {(name: string, ...args: any[]) => Promise<void>} emit
 * @returns {Promise<{variables: object, before: object, changed: boolean, errors: string[], commandCount: number}>}
 */
export async function processMessageWithEvents(prevVars, text, emit) {
    const variables = clone(prevVars ?? {});
    if (!isPlainObject(variables.stat_data)) variables.stat_data = {};
    const before = clone(variables);
    await emit(MVU_EVENTS.VARIABLE_UPDATE_STARTED, variables);

    const internal = extractCommands(text);
    const infos = [];
    const untranslated = [];
    for (const c of internal) {
        const info = toCommandInfo(c);
        if (info) infos.push(info); else untranslated.push(c);
    }
    const errors = [];
    await emit(MVU_EVENTS.COMMAND_PARSED, variables, infos, text);
    // 变量结构脚本（MVU zod）在这一步自己校验并执行命令，执行掉的会从列表里拿走，剩下不合结构的在下一步清空
    await emit(`${MVU_EVENTS.COMMAND_PARSED}_for_zod`, variables, infos, text, (msg) => errors.push(String(msg)));
    await emit(`${MVU_EVENTS.COMMAND_PARSED}_ended_for_zod`, variables, infos, text);

    const cmds = [...infos.map(fromCommandInfo), ...untranslated];
    const res = applyCommands(variables.stat_data, cmds);
    variables.stat_data = res.data;
    variables.display_data = buildDisplayData(res.data, res.delta);
    variables.delta_data = res.delta;
    errors.push(...res.errors);

    await emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, variables, before);
    await emit(`${MVU_EVENTS.VARIABLE_UPDATE_ENDED}_for_zod`, variables, before);
    const changed = internal.length > 0 || JSON.stringify(variables.stat_data) !== JSON.stringify(before.stat_data);
    return { variables, before, changed, errors, commandCount: internal.length };
}

/** 给消息正文补上状态栏占位符，并去掉 AI 抄回来的 <status_current_variable> 块 */
export function withStatusPlaceholder(text) {
    let out = String(text ?? '');
    if (out.includes('<status_current_variable>')) out = out.replace(/<(status_current_variable)>(?:(?!<\1>)[\s\S])*<\/\1?>/gi, '');
    if (!out.includes(STATUS_PLACEHOLDER)) out += `\n\n${STATUS_PLACEHOLDER}`;
    return out;
}
