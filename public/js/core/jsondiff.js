// 按字段算两份 JSON 的差异，前端存聊天时只上传改过的字段（参照 Luker 的 JSON Patch 做法，格式更紧凑）。
// 一条操作：{p: 路径数组, v: 新值} 赋值；{p, d: 1} 删除键；{p, len: n} 把数组截短到 n。
// 前后端共用：前端 diffJson 生成，服务端 applyJsonOps 应用。

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function same(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
        return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !same(a[k], b[k])) return false;
    return true;
}

/** @returns {object[]} 把 a 变成 b 的操作（a、b 都是 JSON.parse 出来的值） */
export function diffJson(a, b, path = [], ops = []) {
    if (same(a, b)) return ops;
    if (isObj(a) && isObj(b)) {
        for (const k of Object.keys(b)) {
            if (!Object.prototype.hasOwnProperty.call(a, k)) ops.push({ p: [...path, k], v: b[k] });
            else diffJson(a[k], b[k], [...path, k], ops);
        }
        for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, k)) ops.push({ p: [...path, k], d: 1 });
        return ops;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (b.length < a.length) ops.push({ p: path, len: b.length });
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) diffJson(a[i], b[i], [...path, i], ops);
        for (let i = n; i < b.length; i++) ops.push({ p: [...path, i], v: b[i] });
        return ops;
    }
    ops.push({ p: path, v: b });
    return ops;
}

/** 把 diffJson 的操作应用到 doc 上，返回新的值（doc 会被就地改）。路径走不通就抛错 */
export function applyJsonOps(doc, ops) {
    let root = doc;
    for (const op of ops) {
        const p = Array.isArray(op?.p) ? op.p : null;
        if (!p || p.some(k => k === '__proto__' || k === 'constructor' || k === 'prototype')) throw new Error('bad op');
        if (!p.length) {
            if (op.len !== undefined) { if (!Array.isArray(root)) throw new Error('bad op'); root.length = op.len; }
            else if ('v' in op) root = op.v;
            else throw new Error('bad op');
            continue;
        }
        let cur = root;
        for (let i = 0; i < p.length - 1; i++) {
            cur = cur?.[p[i]];
            if (cur === null || typeof cur !== 'object') throw new Error('bad path');
        }
        const k = p[p.length - 1];
        if (cur === null || typeof cur !== 'object' || k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error('bad path');
        if (op.d) delete cur[k];
        else if (op.len !== undefined) {
            if (!Array.isArray(cur[k]) || !Number.isInteger(op.len) || op.len < 0) throw new Error('bad op');
            cur[k].length = op.len;
        } else if ('v' in op) cur[k] = op.v;
        else throw new Error('bad op');
    }
    return root;
}
