// MVU 楼层变量的清理与恢复（照 MagVarUpdate 的 function/cleanup 和修复按钮的语义，代码自己写）。
// 纯函数，直接改传进来的聊天数组，不碰 DOM。
import { processMessage, latestMvuVars } from './mvu.js';
import { clone, isPlainObject } from './util.js';

/** 清理时从楼层变量里去掉的字段（其它脚本存的变量不动） */
export const CLEAN_KEYS = ['initialized_lorebooks', 'stat_data', 'display_data', 'delta_data', 'schema'];

const swipeCount = (m) => (Array.isArray(m?.swipes) && m.swipes.length ? m.swipes.length : 1);
const hasVars = (m) => {
    const v = Array.isArray(m?.variables) ? m.variables[m.swipe_id ?? 0] : null;
    return !!v && isPlainObject(v.stat_data);
};
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/**
 * 清理 [start, end] 楼层里楼层号不是 interval 倍数的变量；倍数楼层标成快照（snapshot: true）保留。
 * 已经是快照的楼层不动。返回清理掉的楼层数。
 */
export function cleanupMessageVariables(chat, start, end, interval) {
    const step = Math.max(1, Math.floor(Number(interval) || 1));
    let counter = 0;
    for (let id = Math.max(0, start); id <= Math.min(end, chat.length - 1); id++) {
        const m = chat[id];
        if (!m || !Array.isArray(m.variables)) continue;
        let counted = false;
        m.variables = Array.from({ length: swipeCount(m) }, (_, i) => {
            const v = m.variables[i];
            if (!isPlainObject(v)) return {};
            if (v.snapshot === true) return v;
            if (id % step === 0) { v.snapshot = true; return v; }
            if (!counted && CLEAN_KEYS.some(k => k in v)) { counted = true; counter++; }
            return omit(v, CLEAN_KEYS);
        });
    }
    return counter;
}

/**
 * 收到新回复后的自动清理（原版：聊天楼层数是 5 的倍数时才做；保留最近 keep 楼）。
 * @returns {number} 清理掉的楼层数
 */
export function autoCleanup(chat, messageId, { keep = 20, interval = 50 } = {}) {
    if (chat.length % 5 !== 0) return 0;
    const old = messageId - keep;
    if (old <= 0) return 0;
    return cleanupMessageVariables(chat, Math.max(1, old - 2 - keep * 2), old, interval);
}

/** 修复按钮“清除旧楼层变量”：保留最后 depth 楼，其余楼层每 interval 楼留一层快照 */
export function clearOldFloors(chat, depth, interval) {
    const step = Math.max(1, Math.floor(Number(interval) || 1));
    const endIdx = chat.length - depth - 1; // slice(1, -depth-1)
    let counter = 0;
    for (let id = 1; id < endIdx; id++) {
        const m = chat[id];
        if (!m || !Array.isArray(m.variables)) continue;
        const index = id - 1;
        let counted = false;
        m.variables = Array.from({ length: swipeCount(m) }, (_, i) => {
            const v = m.variables[i];
            if (!isPlainObject(v)) return {};
            if (v.snapshot === true) return v;
            if ((index + 1) % step === 0) { v.snapshot = true; return v; }
            if (!counted && CLEAN_KEYS.some(k => k in v)) { counted = true; counter++; }
            return omit(v, CLEAN_KEYS);
        });
    }
    return counter;
}

/** 修复按钮“快照楼层”：这一层的每个回复版本都标成快照，清理时不会被去掉 */
export function markSnapshot(chat, id) {
    const m = chat[id];
    if (!m) return false;
    let any = false;
    for (let i = 0; i < swipeCount(m); i++) {
        const v = m.variables?.[i];
        if (isPlainObject(v)) { v.snapshot = true; any = true; }
    }
    return any;
}

/** 从 base 楼层的变量开始，把 (base, end] 的 AI 回复依次重算一遍；只读，不写回。返回 {variables, count, errors} */
export function replayRange(chat, base, end, startVars) {
    let vars = clone(startVars);
    let count = 0;
    const errors = [];
    for (let i = base + 1; i <= end; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const r = processMessage(vars, String(m.mes ?? ''));
        vars = r.variables;
        errors.push(...r.errors);
        count++;
    }
    return { variables: vars, count, errors };
}

/**
 * 删楼层后恢复变量（原版 restoreVariables）：最近 restoreRecent 楼里有楼层缺变量时，
 * 从 keep 楼之前最近的一层有变量的楼开始重算，把最近 keep 楼里缺变量的楼层补上。
 * @returns {{status: 'not-needed'|'unavailable'|'restored', restored?: number, floor?: number}}
 */
export function restoreVariables(chat, { keep = 20, restoreRecent = 10 } = {}) {
    const last = chat.length - 1;
    const recentStart = Math.max(1, last - restoreRecent);
    let lastMissing = -1;
    for (let i = last; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user || m?.is_system) continue;
        if (!hasVars(m)) { lastMissing = i; break; }
    }
    if (recentStart > lastMissing) return { status: 'not-needed' };
    const keepStart = Math.max(1, last - keep);
    const snap = latestMvuVars(chat, keepStart);
    if (!snap) return { status: 'unavailable', floor: keepStart };
    let vars = clone(snap.vars);
    let restored = 0;
    for (let i = snap.index + 1; i <= lastMissing; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const valid = hasVars(m);
        vars = processMessage(vars, String(m.mes ?? '')).variables;
        if (i >= keepStart && !valid) {
            if (!Array.isArray(m.variables)) m.variables = [];
            const sid = m.swipe_id ?? 0;
            const keepOther = isPlainObject(m.variables[sid]) ? omit(m.variables[sid], CLEAN_KEYS) : {};
            m.variables[sid] = { ...keepOther, ...clone(vars) };
            restored++;
        }
    }
    return { status: 'restored', restored };
}

/**
 * 修复按钮“重新读取初始变量”：以 [initvar] 的最新内容为底，合并最新楼层的变量（楼层里的值优先），
 * 再把描述字段（[值, "描述"] 的第二项、对象的 description）换成初始变量里的新描述。
 */
export function mergeInitVars(init, latest) {
    const merged = deepMergeNew(clone(init ?? {}), latest ?? {});
    updateDescriptions(init ?? {}, latest ?? {}, merged);
    return merged;
}

function deepMergeNew(target, src) {
    for (const [k, v] of Object.entries(src ?? {})) {
        if (isPlainObject(v) && isPlainObject(target[k])) deepMergeNew(target[k], v);
        else target[k] = clone(v);
    }
    return target;
}

function updateDescriptions(init, msg, target) {
    if (!isPlainObject(init) || !target) return;
    for (const [key, value] of Object.entries(init)) {
        const mv = msg?.[key];
        if (Array.isArray(value)) {
            if (value.length === 2 && typeof value[1] === 'string') {
                if (Array.isArray(mv) && mv.length === 2 && Array.isArray(target[key])) {
                    target[key][1] = value[1];
                    if (isPlainObject(value[0]) && isPlainObject(mv[0])) {
                        if (typeof value[0].description === 'string' && 'description' in mv[0] && isPlainObject(target[key][0])) target[key][0].description = value[0].description;
                        updateDescriptions(value[0], mv[0], target[key][0]);
                    }
                }
            } else if (Array.isArray(mv) && Array.isArray(target[key])) {
                value.forEach((item, i) => {
                    if (i >= mv.length || !isPlainObject(item) || !isPlainObject(target[key][i])) return;
                    if (typeof item.description === 'string' && isPlainObject(mv[i]) && 'description' in mv[i]) target[key][i].description = item.description;
                    updateDescriptions(item, mv[i], target[key][i]);
                });
            }
        } else if (isPlainObject(value)) {
            if (typeof value.description === 'string' && isPlainObject(mv) && 'description' in mv && isPlainObject(target[key])) target[key].description = value.description;
            if (isPlainObject(mv) && isPlainObject(target[key])) updateDescriptions(value, mv, target[key]);
        }
    }
}

/** 兼容性“变量更新到聊天变量”：把楼层变量里 MVU 的几项抄到 chat_metadata.variables */
export function mirrorToChatVars(meta, variables) {
    if (!meta || !isPlainObject(variables)) return;
    if (!isPlainObject(meta.variables)) meta.variables = {};
    for (const k of CLEAN_KEYS) {
        if (k in variables) meta.variables[k] = clone(variables[k]);
        else delete meta.variables[k];
    }
}

/** 没开“变量更新到聊天变量”时，打开聊天会把聊天变量里的这几项去掉（原版 checkAndRemoveChatVariables）。返回是否改了 */
export function removeMirroredChatVars(meta) {
    if (!isPlainObject(meta?.variables)) return false;
    let changed = false;
    for (const k of CLEAN_KEYS) if (k in meta.variables) { delete meta.variables[k]; changed = true; }
    return changed;
}
