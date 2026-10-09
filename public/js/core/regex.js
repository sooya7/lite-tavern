// 正则脚本引擎：与酒馆 regex 扩展的数据格式和执行语义一致。
import { regexFromString, uuid } from './util.js';

export const REGEX_PLACEMENT = {
    MD_DISPLAY: 0, // 已废弃
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
};

export const SUBSTITUTE_FIND = { NONE: 0, RAW: 1, ESCAPED: 2 };

export function newRegexScript(partial = {}) {
    return {
        id: uuid(),
        scriptName: '新正则',
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: SUBSTITUTE_FIND.NONE,
        minDepth: null,
        maxDepth: null,
        ...partial,
    };
}

/** 把用于正则的宏值转义（酒馆 sanitizeRegexMacro） */
export function sanitizeRegexMacro(x) {
    return String(x).replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
        switch (s) {
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            case '\v': return '\\v';
            case '\f': return '\\f';
            case '\0': return '\\0';
            default: return '\\' + s;
        }
    });
}

function filterString(str, trimStrings, substitute) {
    let out = str;
    for (const t of trimStrings || []) {
        const sub = substitute ? substitute(t) : t;
        if (sub) out = out.replaceAll(sub, '');
    }
    return out;
}

/**
 * 执行单个正则脚本
 * @param {object} script
 * @param {string} raw
 * @param {{substitute?: (s: string, opts?: object) => string}} ctx substitute = 宏替换函数
 */
export function runRegexScript(script, raw, { substitute } = {}) {
    if (!script || script.disabled || !script.findRegex || !raw) return raw;
    const mode = Number(script.substituteRegex ?? 0) || (script.substituteRegex === true ? 1 : 0);
    let pattern = script.findRegex;
    if (substitute && mode === SUBSTITUTE_FIND.RAW) pattern = substitute(pattern);
    if (substitute && mode === SUBSTITUTE_FIND.ESCAPED) pattern = substitute(pattern, { postProcess: sanitizeRegexMacro });
    const re = regexFromString(pattern);
    if (!re) return raw;
    const replaceTemplate = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
    return raw.replace(re, function (...args) {
        const last = args[args.length - 1];
        const groups = last && typeof last === 'object' ? last : null;
        const groupCount = args.length - 3 - (groups ? 1 : 0);
        const replaced = replaceTemplate.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, name) => {
            let m;
            if (num) m = Number(num) <= groupCount ? args[Number(num)] : undefined;
            else if (name) m = groups?.[name];
            if (!m || typeof m !== 'string') return '';
            return filterString(m, script.trimStrings, substitute);
        });
        return substitute ? substitute(replaced) : replaced;
    });
}

/**
 * 按位置与条件执行一组脚本（酒馆 getRegexedString）
 * @param {string} raw
 * @param {number} placement
 * @param {{scripts: object[], isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number, substitute?: Function}} opts
 */
export function getRegexedString(raw, placement, { scripts = [], isMarkdown = false, isPrompt = false, isEdit = false, depth, substitute } = {}) {
    if (typeof raw !== 'string' || !raw) return raw ?? '';
    let out = raw;
    for (const s of scripts) {
        if (!s || s.disabled) continue;
        const applies = (s.markdownOnly && isMarkdown)
            || (s.promptOnly && isPrompt)
            || (!s.markdownOnly && !s.promptOnly && !isMarkdown && !isPrompt);
        if (!applies) continue;
        if (isEdit && !s.runOnEdit) continue;
        if (typeof depth === 'number') {
            const min = s.minDepth === '' || s.minDepth === null || s.minDepth === undefined ? NaN : Number(s.minDepth);
            const max = s.maxDepth === '' || s.maxDepth === null || s.maxDepth === undefined ? NaN : Number(s.maxDepth);
            if (!Number.isNaN(min) && min >= -1 && depth < min) continue;
            if (!Number.isNaN(max) && max >= 0 && depth > max) continue;
        }
        if (!(s.placement || []).map(Number).includes(placement)) continue;
        out = runRegexScript(s, out, { substitute });
    }
    return out;
}

/** 合并脚本来源：全局 → 角色卡 → 预设（与酒馆 SCRIPT_TYPES 顺序一致） */
export function collectRegexScripts({ global = [], character = [], preset = [], allowCharacter = true, allowPreset = true }) {
    return [
        ...global,
        ...(allowCharacter ? character : []),
        ...(allowPreset ? preset : []),
    ].filter(Boolean);
}

/** 规范化导入的脚本（兼容旧字段） */
export function normalizeRegexScript(s) {
    const out = newRegexScript({ ...s });
    if (!Array.isArray(out.placement)) out.placement = [];
    // 旧版 placement 0（MD_DISPLAY）= AI 输出 + 仅显示
    if (out.placement.includes(0)) {
        out.placement = out.placement.filter(p => p !== 0);
        if (!out.placement.includes(REGEX_PLACEMENT.AI_OUTPUT)) out.placement.push(REGEX_PLACEMENT.AI_OUTPUT);
        out.markdownOnly = true;
    }
    if (!Array.isArray(out.trimStrings)) out.trimStrings = [];
    if (typeof out.substituteRegex === 'boolean') out.substituteRegex = out.substituteRegex ? 1 : 0;
    return out;
}
