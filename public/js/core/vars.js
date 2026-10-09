// 变量体系：全局（设置里）、本地（chat_metadata.variables）、消息楼层（message.variables[swipe_id]，酒馆助手/EJS/MVU 共用）。
import { getPath, setPath, hasPath, unsetPath, clone, isPlainObject, deepMerge } from './util.js';

export const SCOPES = ['global', 'local', 'message', 'cache', 'initial'];
const FLAGS = ['nx', 'xx', 'n', 'nxs', 'xxs'];
const RESULTS = ['old', 'new', 'fullcache'];

/** 把 ST-Prompt-Template 的简写选项（字符串/布尔）展开成对象 */
export function normalizeVarOptions(options) {
    if (options === undefined || options === null) return {};
    if (typeof options === 'boolean') return { dryRun: options };
    if (typeof options === 'string') {
        if (SCOPES.includes(options)) return { scope: options };
        if (FLAGS.includes(options)) return { flags: options };
        if (RESULTS.includes(options)) return { results: options };
        return {};
    }
    return options;
}

export class VariableManager {
    /**
     * @param {{chat: object[], meta: object, global: object, initial?: object}} state
     */
    constructor(state) {
        this.state = state;
        this._cache = null;
        this.listeners = new Set();
    }

    get chat() { return this.state.chat ?? []; }

    invalidate() {
        this._cache = null;
        for (const fn of this.listeners) fn();
    }

    local() {
        const m = this.state.meta ?? (this.state.meta = {});
        if (!isPlainObject(m.variables)) m.variables = {};
        return m.variables;
    }

    global() {
        if (!isPlainObject(this.state.global)) this.state.global = {};
        return this.state.global;
    }

    initial() {
        return this.state.initial ?? {};
    }

    /** 消息楼层变量（当前或指定 swipe）；create=true 时自动创建 */
    message(id, swipe, create = false) {
        const msg = this.chat[id];
        if (!msg) return create ? {} : undefined;
        const sid = swipe ?? msg.swipe_id ?? 0;
        if (!Array.isArray(msg.variables)) {
            if (!create) return undefined;
            msg.variables = [];
        }
        if (!isPlainObject(msg.variables[sid])) {
            if (!create) return undefined;
            msg.variables[sid] = {};
        }
        return msg.variables[sid];
    }

    /** 解析消息过滤器 {id, role, swipe_id} → 楼层号 */
    resolveMessageId(filter, fallback) {
        const n = this.chat.length;
        if (filter && typeof filter === 'object') {
            if (Number.isInteger(filter.id)) return filter.id < 0 ? n + filter.id : filter.id;
            const role = filter.role ?? 'assistant';
            for (let i = n - 1; i >= 0; i--) {
                const m = this.chat[i];
                const r = m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant');
                if (role === 'any' || role === r) return i;
            }
            return -1;
        }
        if (Number.isInteger(filter)) return filter < 0 ? n + filter : filter;
        return fallback ?? n - 1;
    }

    /** 合并视图：全局 → 本地 → 各楼层（按顺序顶层覆盖） */
    cache(uptoId) {
        const upto = uptoId ?? this.chat.length - 1;
        if (this._cache && this._cache.upto === upto) return this._cache.value;
        const out = Object.assign({}, this.global(), this.local());
        for (let i = 0; i <= upto && i < this.chat.length; i++) {
            const v = this.message(i);
            if (v) Object.assign(out, v);
        }
        this._cache = { upto, value: out };
        return out;
    }

    tree(scope, msgId) {
        switch (scope) {
            case 'global': return this.global();
            case 'local': return this.local();
            case 'initial': return this.initial();
            case 'message': return this.message(msgId, undefined, true);
            default: return this.cache(msgId);
        }
    }

    // ---- ST-Prompt-Template 风格 API ----

    getvar(key, options = {}, ctx = {}) {
        const o = normalizeVarOptions(options);
        const scope = o.scope ?? 'cache';
        const msgId = this.resolveMessageId(o.withMsg, ctx.messageId);
        const tree = scope === 'message' ? this.message(msgId) ?? {} : this.tree(scope, scope === 'cache' ? ctx.cacheUpto : msgId);
        let value = key === null || key === undefined ? tree : getPath(tree, key);
        if (o.index !== undefined && o.index !== null) {
            let v = value;
            if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* 保持字符串 */ } }
            value = v?.[o.index];
        }
        if (value === undefined) return o.defaults;
        return o.clone ? clone(value) : value;
    }

    setvar(key, value, options = {}, ctx = {}) {
        const o = normalizeVarOptions(options);
        if (ctx.dryRun && !o.dryRun) return undefined;
        const scope = o.scope ?? 'message';
        const msgId = this.resolveMessageId(o.withMsg, ctx.messageId);
        const tree = this.tree(scope === 'cache' ? 'message' : scope, msgId);
        const flags = o.flags ?? 'n';
        const exists = key === null || key === undefined ? true : hasPath(tree, key);
        if ((flags === 'nx' || flags === 'nxs') && exists) return undefined;
        if ((flags === 'xx' || flags === 'xxs') && !exists) return undefined;
        const old = key === null || key === undefined ? clone(tree) : clone(getPath(tree, key));
        let next = value;
        if (o.index !== undefined && o.index !== null) {
            let arr = getPath(tree, key);
            if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = undefined; } }
            if (!arr || typeof arr !== 'object') arr = /^\d+$/.test(String(o.index)) ? [] : {};
            arr[o.index] = value;
            next = arr;
        }
        if (o.merge && isPlainObject(old) && isPlainObject(next)) next = deepMerge(clone(old), next);
        if (key === null || key === undefined) {
            for (const k of Object.keys(tree)) delete tree[k];
            Object.assign(tree, next);
        } else {
            setPath(tree, key, next);
        }
        this.invalidate();
        if (o.results === 'old') return old;
        if (o.results === 'fullcache') return this.cache();
        return next;
    }

    incvar(key, value = 1, options = {}, ctx = {}) {
        const o = normalizeVarOptions(options);
        const cur = this.getvar(key, { scope: o.inscope ?? 'cache', withMsg: o.withMsg, defaults: o.defaults ?? 0 }, ctx);
        let next = (Number(cur) || 0) + Number(value);
        if (o.min !== undefined && o.min !== null) next = Math.max(o.min, next);
        if (o.max !== undefined && o.max !== null) next = Math.min(o.max, next);
        return this.setvar(key, next, { scope: o.outscope ?? 'message', flags: o.flags, results: o.results, withMsg: o.withMsg, dryRun: o.dryRun }, ctx);
    }

    decvar(key, value = 1, options = {}, ctx = {}) {
        return this.incvar(key, -Number(value), options, ctx);
    }

    delvar(key, index, options = {}, ctx = {}) {
        const o = normalizeVarOptions(options);
        if (ctx.dryRun && !o.dryRun) return undefined;
        const scope = o.scope ?? 'message';
        const tree = this.tree(scope === 'cache' ? 'message' : scope, this.resolveMessageId(o.withMsg, ctx.messageId));
        if (index !== undefined && index !== null) {
            const target = getPath(tree, key);
            if (Array.isArray(target)) {
                const i = typeof index === 'number' ? index : target.indexOf(index);
                if (i >= 0) target.splice(i, 1);
            } else if (isPlainObject(target)) {
                delete target[index];
            }
        } else {
            unsetPath(tree, key);
        }
        this.invalidate();
        return true;
    }

    insvar(key, value, index, options = {}, ctx = {}) {
        const o = normalizeVarOptions(options);
        if (ctx.dryRun && !o.dryRun) return undefined;
        const scope = o.scope ?? 'message';
        const tree = this.tree(scope === 'cache' ? 'message' : scope, this.resolveMessageId(o.withMsg, ctx.messageId));
        let target = getPath(tree, key);
        if (target === undefined) {
            // 读合并视图里的值作为起点，避免消息层没有时丢数据
            target = clone(this.getvar(key, { scope: 'cache' }, ctx)) ?? [];
            setPath(tree, key, target);
        }
        if (Array.isArray(target)) {
            if (index === undefined || index === null) target.push(value);
            else target.splice(Number(index), 0, value);
        } else if (isPlainObject(target)) {
            if (index !== undefined && index !== null) target[index] = value;
            else if (isPlainObject(value)) Object.assign(target, value);
        }
        this.invalidate();
        return target;
    }

    // ---- 酒馆宏用的简单作用域（{{getvar}} / {{setvar}}） ----
    macroScope(kind) {
        const tree = () => (kind === 'global' ? this.global() : this.local());
        return {
            get: (k) => tree()[k],
            set: (k, v) => { tree()[k] = v; this.invalidate(); },
            has: (k) => Object.prototype.hasOwnProperty.call(tree(), k),
            delete: (k) => { delete tree()[k]; this.invalidate(); },
        };
    }
}
