// MVU 变量“单独更新”：正文生成时不让模型写 <UpdateVariable>，写完后再单独请求一次只产出变量更新。
// 这里只放纯函数（判断哪些提示词是变量规则、拼更新请求、解析结果），请求本身在 generate.js。
import { dumpYaml, extractUpdateBlocks, extractCommands, STATUS_PLACEHOLDER, processMessage } from './mvu.js';
import { clone, isPlainObject } from './util.js';

/** 变量更新规则：条目名带 [mvu_update]（与 MVU 的额外模型解析约定一致），或内容在教模型怎么写更新块 */
export function isMvuUpdateRule(content, comment = '') {
    if (/\[mvu_update]/i.test(String(comment ?? ''))) return true;
    const c = String(content ?? '');
    return /<\/?UpdateVariable>|<\/?JSONPatch>|_\.(set|add|insert|assign|remove)\s*\(/.test(c);
}

/** 只给正文用、不给变量更新请求看的条目 */
export function isMvuPlotOnly(comment = '') {
    return /\[mvu_plot]/i.test(String(comment ?? ''));
}

/** 去掉正文里已有的更新块，给更新请求当剧情看 */
export function stripUpdateBlocks(text) {
    return String(text ?? '').replace(/<UpdateVariable>[\s\S]*?(<\/UpdateVariable>|$)/gi, '').replace(/<StatusPlaceHolderImpl\/>/g, '').trim();
}

/** 结构化输出用的结构：先简短分析，再给 JSONPatch 列表 */
export const MVU_PATCH_SCHEMA = {
    name: 'mvu_update',
    description: '根据最新剧情更新变量',
    strict: false,
    value: {
        type: 'object',
        properties: {
            analysis: { type: 'string', description: '简短说明哪些变量要变、为什么' },
            patch: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: ['replace', 'delta', 'insert', 'remove', 'move'] },
                        path: { type: 'string', description: 'JSON Pointer，如 /角色/好感度' },
                        value: { description: '新值；delta 时为增量数字' },
                        from: { type: 'string', description: 'move 时的来源路径' },
                    },
                    required: ['op', 'path'],
                },
            },
        },
        required: ['patch'],
    },
};

const INSTRUCTION = `你是变量更新器。根据“最新回复”里发生的事，更新“当前变量”。只改剧情里确实变了的变量，不要编造没发生的事，不要续写剧情。

输出格式：
<UpdateVariable>
<Analysis>一两句说明改了什么、为什么</Analysis>
<JSONPatch>
[
  { "op": "replace", "path": "/路径/到/变量", "value": 新值 },
  { "op": "delta", "path": "/数值变量", "value": 增量 },
  { "op": "insert", "path": "/对象/新键 或 /数组/-", "value": 值 },
  { "op": "remove", "path": "/要删的路径" }
]
</JSONPatch>
</UpdateVariable>

path 用 JSON Pointer（/ 分隔，键名原样写中文）。没有需要改的就输出空数组 []。除了这个块不要输出任何别的内容。`;

/**
 * 拼更新请求的消息
 * @param {{rules: string[], statData: object, history: {name: string, text: string}[], reply: {name: string, text: string}, schema?: boolean}} o
 */
export function buildMvuUpdateMessages({ rules = [], statData = {}, history = [], reply, schema = false }) {
    const sys = [INSTRUCTION];
    if (schema) sys.push('如果接口要求 JSON 输出，就按 {"analysis": "...", "patch": [...]} 输出，patch 的写法同上。');
    const rulesText = rules.map(s => String(s ?? '').trim()).filter(Boolean).join('\n\n');
    if (rulesText) sys.push(`以下是这张卡的变量规则（里面要求的输出格式以上面为准，规则里的取值范围、更新条件照常遵守）：\n${rulesText}`);
    const ctx = history.filter(h => h.text).map(h => `【${h.name}】\n${h.text}`).join('\n\n');
    const user = [
        `当前变量：\n\`\`\`yaml\n${dumpYaml(statData ?? {}).trim() || '{}'}\n\`\`\``,
        ctx ? `前文（只作参考）：\n${ctx}` : '',
        `最新回复（据此更新）：\n【${reply?.name ?? ''}】\n${reply?.text ?? ''}`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys.join('\n\n') },
        { role: 'user', content: user },
    ];
}

/** 结构化结果 / 模型文本 → 一个 <UpdateVariable> 块（解析不出来返回 ''） */
export function toUpdateBlock(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '';
    let obj = null;
    const bare = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    if (/^[[{]/.test(bare)) { try { obj = JSON.parse(bare); } catch { obj = null; } }
    if (obj) {
        const patch = Array.isArray(obj) ? obj : Array.isArray(obj.patch) ? obj.patch : Array.isArray(obj.json_patch) ? obj.json_patch : null;
        if (!patch) return '';
        const ops = patch.filter(p => p && typeof p === 'object' && p.op && typeof p.path === 'string');
        const analysis = !Array.isArray(obj) && obj.analysis ? `<Analysis>${String(obj.analysis).trim()}</Analysis>\n` : '';
        return `<UpdateVariable>\n${analysis}<JSONPatch>\n${JSON.stringify(ops, null, 2)}\n</JSONPatch>\n</UpdateVariable>`;
    }
    const blocks = extractUpdateBlocks(s);
    if (!blocks.length) return '';
    return blocks.map(b => `<UpdateVariable>${b.replace(/\s+$/, '')}\n</UpdateVariable>`).join('\n');
}

// =====================================================================
// 下面是和 MagVarUpdate（MIT，MagicalAstrogy & StageDog）面板对齐的部分：
// 设置默认值、角色卡覆盖、世界书条目筛选、请求组装、请求策略、增量校正。语义照着原版，代码是自己写的。
// =====================================================================

/** 变量相关设置的默认值（都存在 settings.power 里，对所有聊天生效） */
export const MVU_DEFAULTS = {
    // 通知
    mvuNotifyLoaded: true, // MVU 加载成功时通知
    mvuNotifyInit: true, // 变量初始化成功时通知
    mvuNotifyError: false, // 变量初始化/更新出错时通知
    mvuNotifyExtra: true, // 额外模型解析中通知
    // 请求内容
    mvuPromptMode: 'builtin', // builtin | preset | other
    mvuOtherPreset: '',
    mvuHeadPrompt: '', // 开头提示词（内置模式，默认空）
    mvuTailPrompt: '', // 结尾提示词（内置模式，默认空）
    mvuWhitelist: '',
    mvuBlacklist: '',
    // 请求策略
    mvuRequestMode: 'seq', // seq | parallel | once-then-parallel
    mvuRequestCount: 3,
    mvuAuto: true,
    // 高级参数（空 = 默认）
    mvuMaxTokens: '',
    mvuTemperature: '',
    mvuFreqPenalty: '',
    mvuPresPenalty: '',
    mvuTopP: '',
    mvuTopK: '',
    // 自动清理
    mvuCleanup: true,
    mvuSnapshotInterval: 50,
    mvuKeepRecent: 20,
    mvuRestoreRecent: 10,
    // 兼容性
    mvuChatVars: false,
};

export const UPDATE_TAG = /\[mvu_update\]/i;
export const PLOT_TAG = /\[mvu_plot\]/i;

// ---------- 条目标题的黑 / 白名单正则 ----------

/** 支持 /源码/标志 和直接写的源码（a|b）。空 = 不启用。返回 {regex} / {error} / {} */
export function compileEntryRegex(value) {
    const t = String(value ?? '').trim();
    if (!t) return {};
    try {
        if (t.startsWith('/')) {
            let end = -1;
            for (let i = t.length - 1; i > 0; i--) {
                if (t[i] !== '/') continue;
                let bs = 0;
                for (let j = i - 1; j >= 0 && t[j] === '\\'; j--) bs++;
                if (bs % 2 === 0) { end = i; break; }
            }
            if (end <= 0) throw new Error('/…/ 写法缺少结尾的斜杠');
            return { regex: new RegExp(t.slice(1, end), t.slice(end + 1)) };
        }
        return { regex: new RegExp(t) };
    } catch (e) {
        return { error: e?.message ?? String(e) };
    }
}

function testRegex(re, s) {
    re.lastIndex = 0;
    return re.test(s);
}

const tagged = (e) => UPDATE_TAG.test(String(e?.comment ?? '')) || PLOT_TAG.test(String(e?.comment ?? ''));
const plotOnly = (e) => PLOT_TAG.test(String(e?.comment ?? '')) && !UPDATE_TAG.test(String(e?.comment ?? ''));
const updateOnly = (e) => UPDATE_TAG.test(String(e?.comment ?? '')) && !PLOT_TAG.test(String(e?.comment ?? ''));
const entriesOf = (b) => Object.values(b?.entries ?? {});

/** 角色主世界书里有没有 [mvu_plot] / [mvu_update] 条目（原版的“角色卡支持额外模型解析”） */
export function characterSupportsExtra(books) {
    return entriesOf(books?.character?.[0]).some(tagged);
}

/**
 * 额外模型解析开着时，全局 / 聊天 / 用户世界书里没有任何 [mvu_plot] / [mvu_update] 条目的那几本。
 * 原版只在角色主世界书适配了的时候才统计（没适配时整个角色卡都按“随 AI 输出”处理）。
 */
export function unsupportedWorlds(books) {
    if (!characterSupportsExtra(books)) return [];
    const ok = new Set();
    for (const g of ['character', 'global', 'chat', 'persona']) for (const b of books?.[g] ?? []) if (entriesOf(b).some(tagged)) ok.add(b.world);
    const out = new Set();
    for (const g of ['global', 'chat', 'persona']) for (const b of books?.[g] ?? []) if (!ok.has(b.world)) out.add(b.world);
    return [...out].sort();
}

const LORE_OF = { character: 'characterLore', global: 'globalLore', chat: 'chatLore', persona: 'personaLore' };
export const LORE_LABEL = { characterLore: '角色世界书', globalLore: '全局世界书', chatLore: '聊天世界书', personaLore: '用户世界书' };

/**
 * 变量更新请求用的世界书（原版 filterEntries 的额外分析阶段）：
 * - 只带 [mvu_plot] 的条目不给变量更新；不带标签的两边都给；带 [mvu_update] 的只给变量更新（正文那边在 session 里去掉）
 * - 角色主世界书适配了时：全局 / 聊天 / 用户世界书里没适配的整本不给变量更新
 * - 标题黑白名单：白名单任一来源命中就保留，黑名单任一来源命中就去掉；带 [mvu_update] 的条目不受影响
 * 和原版不同的一点：原版在角色卡没适配时根本不做额外模型解析；这里照样做，黑白名单也照样生效。
 * @returns {{books: object, filtered: object[], unsupported: string[], regexErrors: string[], supported: boolean}}
 */
export function filterUpdateBooks(books, { whitelist = '', blacklist = '', charWhitelist = '', charBlacklist = '' } = {}) {
    const supported = characterSupportsExtra(books);
    const unsupported = supported ? unsupportedWorlds(books) : [];
    const drop = new Set(unsupported);
    const regexErrors = [];
    const compile = (value, source, label) => {
        const r = compileEntryRegex(value);
        if (r.error) regexErrors.push(`${source}的${label}无效，这次没用它：${r.error}`);
        return r.regex ? { regex: r.regex, source } : null;
    };
    const white = [compile(whitelist, '用户全局配置', '白名单正则'), compile(charWhitelist, '角色卡配置', '白名单正则')].filter(Boolean);
    const black = [compile(blacklist, '用户全局配置', '黑名单正则'), compile(charBlacklist, '角色卡配置', '黑名单正则')].filter(Boolean);
    const filtered = [];
    const out = {};
    for (const g of ['character', 'global', 'chat', 'persona']) {
        out[g] = [];
        for (const b of books?.[g] ?? []) {
            if (!b) continue;
            if (g !== 'character' && drop.has(b.world)) continue;
            const entries = {};
            for (const [k, e] of Object.entries(b.entries ?? {})) {
                if (plotOnly(e)) continue;
                const comment = String(e?.comment ?? '');
                if (!UPDATE_TAG.test(comment)) {
                    let reason = null;
                    if (white.length && !white.some(w => testRegex(w.regex, comment))) reason = { reason: '白名单', sources: white.map(w => w.source) };
                    else {
                        const hit = black.filter(x => testRegex(x.regex, comment));
                        if (hit.length) reason = { reason: '黑名单', sources: hit.map(x => x.source) };
                    }
                    if (reason) {
                        if (!e?.disable) filtered.push({ lore: LORE_OF[g], world: b.world, comment, ...reason });
                        continue;
                    }
                }
                entries[k] = e;
            }
            out[g].push({ ...b, entries });
        }
    }
    return { books: out, filtered, unsupported, regexErrors, supported };
}

/** 正文请求用的世界书：去掉只给变量更新的 [mvu_update] 条目（原版正文阶段的规则） */
export function filterPlotBooks(books) {
    const out = {};
    for (const g of ['character', 'global', 'chat', 'persona']) {
        out[g] = (books?.[g] ?? []).filter(Boolean).map(b => ({ ...b, entries: Object.fromEntries(Object.entries(b.entries ?? {}).filter(([, e]) => !updateOnly(e))) }));
    }
    return out;
}

// ---------- 角色卡覆盖（原版 CharacterOverride：角色主世界书里一个关闭的 [config_override] 条目，内容是 JSON） ----------

export const OVERRIDE_ENTRY_NAME = '[config_override]';
export const isOverrideEntry = (e) => !!e && (e.disable === true || e.enabled === false) && String(e.comment ?? e.name ?? '').trim().toLowerCase() === OVERRIDE_ENTRY_NAME;

/** 角色卡能覆盖的几项：路径 → 对应的 power 设置 */
export const OVERRIDE_PATHS = {
    '更新方式': 'mvuSeparate',
    '额外模型解析配置.启用自动请求': 'mvuAuto',
    '额外模型解析配置.世界书条目白名单正则': 'charWhitelist',
    '额外模型解析配置.世界书条目黑名单正则': 'charBlacklist',
    '兼容性.更新到聊天变量': 'mvuChatVars',
};

/** 从条目列表里读覆盖配置。返回 {draft, entry, error} */
export function readOverride(entries) {
    const list = (Array.isArray(entries) ? entries : Object.values(entries ?? {})).filter(isOverrideEntry);
    const entry = list[0] ?? null;
    if (!entry) return { draft: {}, entry: null, error: '' };
    try {
        const doc = JSON.parse(String(entry.content ?? ''));
        if (!isPlainObject(doc)) throw new Error('内容不是 JSON 对象');
        const { schema: _schema, ...draft } = doc;
        return { draft: normalizeOverride(draft), entry, error: '' };
    } catch (e) {
        return { draft: {}, entry, error: e?.message ?? String(e) };
    }
}

function getAt(o, path) { return path.split('.').reduce((a, k) => (isPlainObject(a) ? a[k] : undefined), o); }
export const hasOverride = (draft, path) => {
    const v = getAt(draft, path);
    if (path.endsWith('正则')) return typeof v === 'string' && !!compileEntryRegex(v).regex;
    return v !== undefined;
};
export const getOverride = (draft, path) => getAt(draft, path);

/** 去掉类型不对的已知字段和空正则；未知字段原样保留 */
export function normalizeOverride(draft) {
    const d = clone(isPlainObject(draft) ? draft : {});
    if (d['更新方式'] !== undefined && !['随AI输出', '额外模型解析'].includes(d['更新方式'])) delete d['更新方式'];
    const ex = d['额外模型解析配置'];
    if (ex !== undefined && !isPlainObject(ex)) delete d['额外模型解析配置'];
    if (isPlainObject(ex)) {
        if (ex['启用自动请求'] !== undefined && typeof ex['启用自动请求'] !== 'boolean') delete ex['启用自动请求'];
        for (const k of ['世界书条目白名单正则', '世界书条目黑名单正则']) if (ex[k] !== undefined && (typeof ex[k] !== 'string' || !ex[k].trim())) delete ex[k];
        if (!Object.keys(ex).length) delete d['额外模型解析配置'];
    }
    const cp = d['兼容性'];
    if (cp !== undefined && !isPlainObject(cp)) delete d['兼容性'];
    if (isPlainObject(cp)) {
        if (cp['更新到聊天变量'] !== undefined && typeof cp['更新到聊天变量'] !== 'boolean') delete cp['更新到聊天变量'];
        if (!Object.keys(cp).length) delete d['兼容性'];
    }
    return d;
}

/** 改一项覆盖（value 为 undefined 或空正则 = 跟随用户配置），返回新的 draft */
export function setOverride(draft, path, value) {
    const d = clone(isPlainObject(draft) ? draft : {});
    const [root, child] = path.split('.');
    const del = value === undefined || (path.endsWith('正则') && !String(value ?? '').trim());
    if (!child) {
        if (del) delete d[root]; else d[root] = value;
    } else {
        if (!isPlainObject(d[root])) d[root] = {};
        if (del) delete d[root][child]; else d[root][child] = value;
        if (!Object.keys(d[root]).length) delete d[root];
    }
    return normalizeOverride(d);
}

const OVERRIDE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
        '更新方式': { type: 'string', enum: ['随AI输出', '额外模型解析'] },
        '额外模型解析配置': {
            type: 'object',
            properties: { '启用自动请求': { type: 'boolean' }, '世界书条目白名单正则': { type: 'string' }, '世界书条目黑名单正则': { type: 'string' } },
            additionalProperties: true,
        },
        '兼容性': {
            type: 'object',
            properties: { '更新到聊天变量': { type: 'boolean' }, 'sendas不视为user消息': { type: 'boolean' } },
            additionalProperties: true,
        },
    },
    additionalProperties: true,
    title: 'CharacterSettingsOverride',
};

/** 写进条目的内容：配置在前，schema 放最后（和原版一样，方便在酒馆里编辑） */
export function serializeOverride(draft) {
    const { schema: _s, ...config } = normalizeOverride(draft);
    return JSON.stringify({ ...config, schema: OVERRIDE_SCHEMA }, null, 4);
}

/** 用户设置 + 角色卡覆盖 = 实际生效的设置。黑白名单是叠加（charWhitelist / charBlacklist），不是替换 */
export function applyOverride(power, draft) {
    const eff = { ...MVU_DEFAULTS, ...(power ?? {}), charWhitelist: '', charBlacklist: '' };
    const d = isPlainObject(draft) ? draft : {};
    if (d['更新方式'] !== undefined) eff.mvuSeparate = d['更新方式'] === '额外模型解析';
    const ex = d['额外模型解析配置'] ?? {};
    if (typeof ex['启用自动请求'] === 'boolean') eff.mvuAuto = ex['启用自动请求'];
    if (typeof ex['世界书条目白名单正则'] === 'string') eff.charWhitelist = ex['世界书条目白名单正则'];
    if (typeof ex['世界书条目黑名单正则'] === 'string') eff.charBlacklist = ex['世界书条目黑名单正则'];
    const cp = d['兼容性'] ?? {};
    if (typeof cp['更新到聊天变量'] === 'boolean') eff.mvuChatVars = cp['更新到聊天变量'];
    return eff;
}

// ---------- 额外模型解析的请求内容 ----------

/** 任务说明：自己写的中性措辞（不带任何“破限”内容） */
export function buildTask({ schema = false } = {}) {
    const fmtText = schema
        ? `输出要求：只输出一个 JSON 对象 {"analysis": "一两句说明", "patch": [...]}，patch 是下面这种 JSONPatch 操作的列表，不要输出 <UpdateVariable> 标签、markdown 或别的文字。`
        : `输出要求：只输出一个 <UpdateVariable> 块。变量规则里约定了更新块的写法就照规则写；没有约定时用下面的写法：
<UpdateVariable>
<Analysis>一两句说明改了什么、为什么</Analysis>
<JSONPatch>
[
  { "op": "replace", "path": "/路径/到/变量", "value": 新值 },
  { "op": "delta", "path": "/数值变量", "value": 增量 },
  { "op": "insert", "path": "/对象/新键 或 /数组/-", "value": 值 },
  { "op": "remove", "path": "/要删的路径" }
]
</JSONPatch>
</UpdateVariable>
除了这个块不要输出任何别的内容。`;
    return `<variable_update_task>
现在先停下角色扮演，不要续写剧情。请以旁白的视角阅读 <past_observe> 里的剧情，对照“剧情发生前的变量”和上面资料里的变量规则，分析最新这段剧情让哪些变量发生了变化，然后给出变量更新。
- 只改剧情里确实变了的变量，没发生的事不要编造。
- 遵守变量规则里写明的取值范围和更新条件。
- path 用 JSON Pointer（用 / 分隔，键名照原样写）。没有需要改的就给空数组 []。
${fmtText}
</variable_update_task>`;
}

export const DEFAULT_USER_INPUT = '请完成上面的变量更新任务。';

/** 剧情发生前的变量 */
export function previousVarsBlock(statData, label = '剧情发生前的变量') {
    return `<previous_variables>\n${label}：\n\`\`\`yaml\n${dumpYaml(statData ?? {}).trim() || '{}'}\n\`\`\`\n</previous_variables>`;
}

/**
 * 内置请求内容（原版“使用内置破限”的顺序，去掉了破限头尾）：
 * [开头提示词] → <additional_information> 用户设定 / 角色描述 / 世界书 </additional_information>
 * → <past_observe> 聊天记录 </past_observe> → 剧情发生前的变量 → 任务 → [结尾提示词] → 一句用户消息
 */
export function buildBuiltinMessages({ head = '', tail = '', persona = '', description = '', worldBefore = '', worldAfter = '', history = [], statData = {}, statLabel, task, userInput = DEFAULT_USER_INPUT }) {
    const sys = (content) => ({ role: 'system', content });
    const out = [];
    if (String(head).trim()) out.push(sys(String(head)));
    out.push(sys('<additional_information>'));
    for (const t of [persona, description, worldBefore, worldAfter]) if (String(t ?? '').trim()) out.push(sys(String(t)));
    out.push(sys('</additional_information>'));
    out.push(sys('<past_observe>'));
    for (const h of history) if (String(h?.content ?? '').trim()) out.push({ role: h.role === 'user' ? 'user' : h.role === 'system' ? 'system' : 'assistant', content: String(h.content) });
    out.push(sys('</past_observe>'));
    out.push(sys(previousVarsBlock(statData, statLabel)));
    out.push(sys(task ?? buildTask()));
    if (String(tail).trim()) out.push(sys(String(tail)));
    out.push({ role: 'user', content: userInput || DEFAULT_USER_INPUT });
    return out;
}

/** “使用当前预设 / 其他预设”时注入聊天里的几条（原版：任务在深度 0，<past_observe> 包住最后两条） */
export function presetTaskInjects(task) {
    return [
        { content: task, depth: 0, role: 'system' },
        { content: '<past_observe>', depth: 2, role: 'system' },
        { content: '</past_observe>', depth: 1, role: 'system' },
    ];
}

/** 高级参数：留空的不动（沿用基础值），填了的覆盖 */
export function applyAdvancedParams(params, power = {}) {
    const p = { ...params };
    const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    const map = { mvuMaxTokens: 'max_tokens', mvuTemperature: 'temperature', mvuFreqPenalty: 'frequency_penalty', mvuPresPenalty: 'presence_penalty', mvuTopP: 'top_p', mvuTopK: 'top_k' };
    for (const [k, to] of Object.entries(map)) { const v = num(power[k]); if (v !== null) p[to] = v; }
    return p;
}

// ---------- 请求策略 ----------

export const REQUEST_MODES = [
    { value: 'seq', label: '依次请求，失败后重试' },
    { value: 'parallel', label: '同时请求多次' },
    { value: 'once-then-parallel', label: '先请求一次，失败后再同时请求多次' },
];

/**
 * 按请求方式跑 attempt(signal)：它返回结果或抛错（解析不出更新也算失败）。
 * 手动停止（signal 中止）后不再重试。同时请求时谁先成功用谁，其余的中止。
 * @param {(signal: AbortSignal) => Promise<any>} attempt
 * @param {{mode?: string, count?: number, notice?: (text: string) => void, signal?: AbortSignal}} o
 */
export async function runWithStrategy(attempt, { mode = 'seq', count = 3, notice = () => {}, signal } = {}) {
    const n = Math.max(1, Math.min(10, Math.floor(Number(count) || 1)));
    const aborted = () => !!signal?.aborted;
    const abortError = () => Object.assign(new Error('已停止'), { name: 'AbortError' });
    const parallel = async (k) => {
        const acs = Array.from({ length: k }, () => new AbortController());
        const onAbort = () => acs.forEach(a => a.abort());
        signal?.addEventListener('abort', onAbort);
        try {
            return await Promise.any(acs.map(a => attempt(a.signal)));
        } catch (e) {
            if (aborted()) throw abortError();
            const errs = e?.errors ?? [e];
            throw errs[errs.length - 1];
        } finally {
            signal?.removeEventListener('abort', onAbort);
            acs.forEach(a => a.abort());
        }
    };
    if (mode === 'parallel') {
        notice(`同时请求 ${n} 次，取最先成功的那次…`);
        return parallel(n);
    }
    if (mode === 'once-then-parallel') {
        const k = Math.max(2, n);
        notice('先请求一次…');
        try { return await attempt(signal); } catch (e) { if (aborted()) throw abortError(); }
        notice(`第一次失败了，再同时请求 ${k - 1} 次…`);
        return parallel(k - 1);
    }
    let last;
    for (let i = 0; i < n; i++) {
        if (aborted()) throw abortError();
        notice(i === 0 ? '正在请求模型更新变量…' : `正在重试（${i} / ${n - 1}）…`);
        try { return await attempt(signal); } catch (e) {
            last = e;
            if (aborted()) throw abortError();
        }
    }
    throw last ?? new Error('请求失败');
}

// ---------- 增量校正 ----------

const encSeg = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 前后两份变量的差别：对象按叶子比，数组整体比（原版 collectIncrementalStateChanges） */
export function collectStateChanges(before, after, limit = 120) {
    const out = [];
    const visit = (a, b, path) => {
        if (out.length >= limit || same(a, b)) return;
        if (isPlainObject(a) && isPlainObject(b)) {
            for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
                visit(a[k], b[k], `${path}/${encSeg(k)}`);
                if (out.length >= limit) break;
            }
            return;
        }
        out.push({ path: path || '/', before: a, after: b });
    };
    visit(before, after, '');
    return out;
}

const short = (v, n = 300) => {
    const s = v === undefined ? '（无）' : JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function formatChanges(changes, budget = 12000) {
    if (!changes.length) return '（本楼还没有变量变化）';
    let s = '', count = 0;
    for (const c of changes) {
        const line = `${c.path}: ${short(c.before)} -> ${short(c.after)}\n`;
        if (s.length + line.length > budget) break;
        s += line; count++;
    }
    if (count < changes.length) s += `（另有 ${changes.length - count} 项没列出）\n`;
    return s.trimEnd();
}

/** 增量校正的任务说明（以当前已更新好的状态为准，只补漏和改错） */
export function buildRepairTask(changes, { schema = false } = {}) {
    return `<variable_repair_task>
这次是“增量校正”，不是重新更新一遍。
- 现在的变量已经是这段剧情结束、原有更新执行完之后的结果，不是剧情发生前的状态。
- <past_observe> 里有最新剧情和原有的更新；下面列出了本楼已经发生的变量变化。
- 只补上遗漏的变化，或者改正和剧情、变量规则明显冲突的错误；已经正确的不要再输出。
- 修改一律以现在的变量为基准，优先用 replace 写出正确的最终值，不要重算整份变量。
- 只有规则允许新增字段时才用 insert；确定是错误字段时才用 remove；拿不准就不动。
- ${schema ? '只输出 JSON 对象 {"analysis": "...", "patch": [...]}。' : '只输出一个 <UpdateVariable><JSONPatch>[...]</JSONPatch></UpdateVariable>，不要附带剧情或解释。'}
- 没有需要校正的就给空数组 []。
本楼已经发生的变化：
${formatChanges(changes)}
</variable_repair_task>`;
}

export function buildRepairTail(direction = '') {
    const d = String(direction ?? '').trim().slice(0, 500);
    return `请按增量校正任务检查变量。${d ? `优先核对这一点：${d}` : '没有指定方向：自己检查遗漏和明显的错误。'}只输出需要的校正操作。`;
}

/**
 * 把校正块并进正文：作为一个新的 <UpdateVariable> 块放在最后一个更新块后面（没有就放在末尾），
 * 状态栏占位符保持在最后。没闭合的更新块先补上结尾。
 */
export function appendRepairBlock(message, repair) {
    let content = String(repair ?? '').trim();
    const wrap = content.match(/^<UpdateVariable>([\s\S]*?)<\/UpdateVariable>$/i);
    if (wrap && !/<UpdateVariable>/i.test(wrap[1])) content = wrap[1].trim();
    if (!content) return message;
    let text = String(message ?? '');
    let tailPh = '';
    const at = text.lastIndexOf(STATUS_PLACEHOLDER);
    if (at >= 0 && !text.slice(at + STATUS_PLACEHOLDER.length).trim()) { tailPh = text.slice(at); text = text.slice(0, at); }
    const opens = (text.match(/<UpdateVariable>/gi) ?? []).length;
    const closes = (text.match(/<\/UpdateVariable>/gi) ?? []).length;
    if (opens > closes) text = `${text.replace(/\s+$/, '')}\n</UpdateVariable>`;
    const block = `<UpdateVariable>\n${content}\n</UpdateVariable>`;
    const lastClose = text.search(/<\/UpdateVariable>(?![\s\S]*<\/UpdateVariable>)/i);
    if (lastClose >= 0 && !extractCommands(`<UpdateVariable>${text.slice(lastClose + 17)}</UpdateVariable>`).length) {
        const end = lastClose + '</UpdateVariable>'.length;
        text = `${text.slice(0, end)}\n${block}${text.slice(end)}`;
    } else {
        text = `${text.replace(/\s+$/, '')}\n\n${block}`;
    }
    return tailPh ? `${text.replace(/\s+$/, '')}\n\n${tailPh}` : text;
}

/**
 * 增量校正的结果：校正块并进正文后，从上一楼变量把整楼重算一遍（不在已更新的状态上再叠一次）。
 * @returns {{content: string, variables: object, errors: string[], changes: object[], commands: object[]}}
 */
export function planRepair(prevVars, curVars, message, block) {
    const content = appendRepairBlock(message, block);
    const r = processMessage(prevVars, content);
    return {
        content,
        variables: r.variables,
        errors: r.errors,
        changes: collectStateChanges(curVars?.stat_data, r.variables.stat_data),
        commands: extractCommands(block),
    };
}
