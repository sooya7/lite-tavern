// 酒馆助手接口用的数据形状 ↔ 轻酒馆内部（与酒馆文件一致）的数据形状。
// 脚本通过 getWorldbook / getPreset / getTavernRegexes 拿到的是酒馆助手自己定义的结构，这里负责来回转换。
// 纯逻辑，不碰 DOM。
import { newWorldInfoEntry, WI_POSITION, WI_LOGIC, ROLE_NAMES } from './worldinfo.js';
import { PROMPT_ORDER_GLOBAL, getPromptOrder, MARKERS, NAMES_BEHAVIOR } from './preset.js';
import { newRegexScript, REGEX_PLACEMENT } from './regex.js';
import { clone, isPlainObject, uuid } from './util.js';

// ---------- 世界书 ----------

const POSITION_NAMES = {
    [WI_POSITION.before]: 'before_character_definition',
    [WI_POSITION.after]: 'after_character_definition',
    [WI_POSITION.ANTop]: 'before_author_note',
    [WI_POSITION.ANBottom]: 'after_author_note',
    [WI_POSITION.atDepth]: 'at_depth',
    [WI_POSITION.EMTop]: 'before_example_messages',
    [WI_POSITION.EMBottom]: 'after_example_messages',
    [WI_POSITION.outlet]: 'outlet',
};
const POSITION_IDS = Object.fromEntries(Object.entries(POSITION_NAMES).map(([k, v]) => [v, Number(k)]));
const LOGIC_NAMES = { [WI_LOGIC.AND_ANY]: 'and_any', [WI_LOGIC.NOT_ALL]: 'not_all', [WI_LOGIC.NOT_ANY]: 'not_any', [WI_LOGIC.AND_ALL]: 'and_all' };
const LOGIC_IDS = Object.fromEntries(Object.entries(LOGIC_NAMES).map(([k, v]) => [v, Number(k)]));

const keyToString = (k) => (k instanceof RegExp || Object.prototype.toString.call(k) === '[object RegExp]' ? String(k) : String(k ?? ''));
const numOrNull = (v) => (v === null || v === undefined || v === '' || v === false || Number(v) === 0 || Number.isNaN(Number(v)) ? null : Number(v));

export function toWorldbookEntry(e) {
    return {
        uid: Number(e.uid),
        name: String(e.comment ?? ''),
        enabled: !e.disable,
        strategy: {
            type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
            keys: [...(e.key ?? [])],
            keys_secondary: { logic: LOGIC_NAMES[Number(e.selectiveLogic ?? 0)] ?? 'and_any', keys: [...(e.keysecondary ?? [])] },
            scan_depth: e.scanDepth === null || e.scanDepth === undefined || e.scanDepth === '' ? 'same_as_global' : Number(e.scanDepth),
        },
        position: {
            type: POSITION_NAMES[Number(e.position ?? WI_POSITION.after)] ?? 'after_character_definition',
            role: ROLE_NAMES[Number(e.role ?? 0)] ?? 'system',
            depth: Number(e.depth ?? 4),
            order: Number(e.order ?? 100),
        },
        content: String(e.content ?? ''),
        probability: e.useProbability === false ? 100 : Number(e.probability ?? 100),
        recursion: {
            prevent_incoming: !!e.excludeRecursion,
            prevent_outgoing: !!e.preventRecursion,
            delay_until: e.delayUntilRecursion === true ? 1 : numOrNull(e.delayUntilRecursion),
        },
        effect: { sticky: numOrNull(e.sticky), cooldown: numOrNull(e.cooldown), delay: numOrNull(e.delay) },
        extra: isPlainObject(e.extra) ? clone(e.extra) : {},
    };
}

/** 脚本给的条目（可以只有部分字段）盖到已有条目上；没有已有条目就从默认值起 */
export function fromWorldbookEntry(w, base, uid) {
    const e = base ? { ...base } : newWorldInfoEntry(uid);
    if (!w || typeof w !== 'object') return e;
    if (w.name !== undefined) { e.comment = String(w.name); e.addMemo = true; }
    if (w.enabled !== undefined) e.disable = !w.enabled;
    const st = w.strategy;
    if (st) {
        if (st.type !== undefined) {
            e.constant = st.type === 'constant';
            e.vectorized = st.type === 'vectorized';
            e.selective = true;
        }
        if (Array.isArray(st.keys)) e.key = st.keys.map(keyToString);
        if (st.keys_secondary) {
            if (st.keys_secondary.logic !== undefined) e.selectiveLogic = LOGIC_IDS[st.keys_secondary.logic] ?? WI_LOGIC.AND_ANY;
            if (Array.isArray(st.keys_secondary.keys)) e.keysecondary = st.keys_secondary.keys.map(keyToString);
        }
        if (st.scan_depth !== undefined) e.scanDepth = st.scan_depth === 'same_as_global' || st.scan_depth === null ? null : Number(st.scan_depth);
    }
    const pos = w.position;
    if (pos) {
        if (pos.type !== undefined) e.position = POSITION_IDS[pos.type] ?? WI_POSITION.after;
        if (pos.role !== undefined) e.role = Math.max(0, ROLE_NAMES.indexOf(pos.role));
        if (pos.depth !== undefined) e.depth = Number(pos.depth);
        if (pos.order !== undefined) e.order = Number(pos.order);
    }
    if (w.content !== undefined) e.content = String(w.content ?? '');
    if (w.probability !== undefined) { e.probability = Number(w.probability); e.useProbability = true; }
    const rec = w.recursion;
    if (rec) {
        if (rec.prevent_incoming !== undefined) e.excludeRecursion = !!rec.prevent_incoming;
        if (rec.prevent_outgoing !== undefined) e.preventRecursion = !!rec.prevent_outgoing;
        if (rec.delay_until !== undefined) e.delayUntilRecursion = rec.delay_until === null ? false : Number(rec.delay_until);
    }
    const eff = w.effect;
    if (eff) {
        if (eff.sticky !== undefined) e.sticky = numOrNull(eff.sticky);
        if (eff.cooldown !== undefined) e.cooldown = numOrNull(eff.cooldown);
        if (eff.delay !== undefined) e.delay = numOrNull(eff.delay);
    }
    if (w.extra !== undefined) e.extra = isPlainObject(w.extra) ? clone(w.extra) : {};
    return e;
}

/** 世界书文件 → 条目数组（按界面显示顺序） */
export function toWorldbook(world) {
    return Object.values(world?.entries ?? {})
        .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid) || a.uid - b.uid)
        .map(toWorldbookEntry);
}

/**
 * 条目数组 → 世界书文件的 entries。uid 相同的沿用原条目里酒馆助手不认识的字段；没给 uid 或 uid 撞了的分配新的。
 * @returns {{entries: object, list: object[]}} list 与输入一一对应（内部格式）
 */
export function fromWorldbook(list, world) {
    const old = world?.entries ?? {};
    const entries = {};
    const out = [];
    let next = Math.max(-1, ...Object.keys(old).map(Number).filter(Number.isFinite), ...list.map(w => Number(w?.uid)).filter(Number.isFinite)) + 1;
    list.forEach((w, index) => {
        let uid = Number(w?.uid);
        if (!Number.isFinite(uid) || uid < 0 || entries[uid]) uid = next++;
        const e = fromWorldbookEntry(w, old[uid], uid);
        e.uid = uid;
        e.displayIndex = index;
        entries[uid] = e;
        out.push(e);
    });
    return { entries, list: out };
}

// ---------- 预设 ----------

const NAME_PREFIX = { [NAMES_BEHAVIOR.NONE]: 'none', [NAMES_BEHAVIOR.DEFAULT]: 'default', [NAMES_BEHAVIOR.COMPLETION]: 'completion', [NAMES_BEHAVIOR.CONTENT]: 'content' };
const NAME_PREFIX_IDS = Object.fromEntries(Object.entries(NAME_PREFIX).map(([k, v]) => [v, Number(k)]));
const SYSTEM_IDS = ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'];
const PROMPT_KNOWN = ['identifier', 'name', 'enabled', 'injection_position', 'injection_depth', 'injection_order', 'role', 'content', 'system_prompt', 'marker', 'forbid_overrides'];

const SETTINGS_MAP = [
    ['max_context', 'openai_max_context'], ['max_completion_tokens', 'openai_max_tokens'], ['reply_count', 'n'], ['should_stream', 'stream_openai'],
    ['temperature', 'temperature'], ['frequency_penalty', 'frequency_penalty'], ['presence_penalty', 'presence_penalty'], ['top_p', 'top_p'],
    ['repetition_penalty', 'repetition_penalty'], ['min_p', 'min_p'], ['top_k', 'top_k'], ['top_a', 'top_a'], ['seed', 'seed'],
    ['squash_system_messages', 'squash_system_messages'], ['reasoning_effort', 'reasoning_effort'], ['request_thoughts', 'show_thoughts'],
    ['request_images', 'request_images'], ['enable_function_calling', 'function_calling'], ['enable_web_search', 'enable_web_search'],
    ['allow_sending_videos', 'video_inlining'], ['wrap_user_messages_in_quotes', 'wrap_in_quotes'],
];

function toPresetPrompt(pr, enabled) {
    const placeholder = MARKERS.includes(pr.identifier) || pr.marker === true;
    const out = {
        id: pr.identifier,
        name: String(pr.name ?? ''),
        enabled: !!enabled,
        position: Number(pr.injection_position) === 1
            ? { type: 'in_chat', depth: Number(pr.injection_depth ?? 4), order: Number(pr.injection_order ?? 100) }
            : { type: 'relative' },
        role: pr.role ?? 'system',
    };
    if (!placeholder) out.content = String(pr.content ?? '');
    const extra = {};
    for (const [k, v] of Object.entries(pr)) if (!PROMPT_KNOWN.includes(k)) extra[k] = clone(v);
    if (Object.keys(extra).length) out.extra = extra;
    return out;
}

export function toHelperPreset(p) {
    const settings = {};
    for (const [th, st] of SETTINGS_MAP) settings[th] = p[st];
    settings.allow_sending_images = p.image_inlining === false ? 'disabled' : (p.inline_image_quality ?? 'auto');
    settings.character_name_prefix = NAME_PREFIX[Number(p.names_behavior ?? 0)] ?? 'default';
    const order = getPromptOrder(p) ?? [];
    const byId = new Map((p.prompts ?? []).map(pr => [pr.identifier, pr]));
    const used = new Set();
    const prompts = [];
    for (const o of order) {
        const pr = byId.get(o.identifier);
        if (!pr || used.has(o.identifier)) continue;
        used.add(o.identifier);
        prompts.push(toPresetPrompt(pr, o.enabled !== false));
    }
    const prompts_unused = (p.prompts ?? []).filter(pr => !used.has(pr.identifier)).map(pr => toPresetPrompt(pr, false));
    return { settings, prompts, prompts_unused, extensions: clone(p.extensions ?? {}) };
}

function fromPresetPrompt(tp, old) {
    const id = String(tp.id ?? uuid());
    const placeholder = MARKERS.includes(id);
    const pr = { ...(old ?? {}), ...(isPlainObject(tp.extra) ? clone(tp.extra) : {}) };
    pr.identifier = id;
    pr.name = String(tp.name ?? old?.name ?? '');
    pr.role = tp.role ?? old?.role ?? 'system';
    if (placeholder) { pr.marker = true; pr.system_prompt = true; delete pr.content; }
    else {
        pr.content = String(tp.content ?? old?.content ?? '');
        pr.marker = false;
        pr.system_prompt = SYSTEM_IDS.includes(id);
    }
    if (tp.position?.type === 'in_chat') {
        pr.injection_position = 1;
        pr.injection_depth = Number(tp.position.depth ?? 4);
        pr.injection_order = Number(tp.position.order ?? 100);
    } else if (tp.position || !old) {
        pr.injection_position = 0;
        pr.injection_depth = Number(old?.injection_depth ?? 4);
        pr.injection_order = Number(old?.injection_order ?? 100);
    }
    return pr;
}

/** 酒馆助手的预设结构盖回酒馆格式的预设（base 里它不管的字段原样保留） */
export function fromHelperPreset(th, base) {
    const p = clone(base ?? {});
    const s = th?.settings ?? {};
    for (const [k, st] of SETTINGS_MAP) if (s[k] !== undefined) p[st] = s[k];
    if (s.allow_sending_images !== undefined) {
        p.image_inlining = s.allow_sending_images !== 'disabled';
        if (s.allow_sending_images !== 'disabled') p.inline_image_quality = s.allow_sending_images;
    }
    if (s.character_name_prefix !== undefined) p.names_behavior = NAME_PREFIX_IDS[s.character_name_prefix] ?? NAMES_BEHAVIOR.DEFAULT;
    if (Array.isArray(th?.prompts)) {
        const old = new Map((p.prompts ?? []).map(pr => [pr.identifier, pr]));
        const prompts = [];
        const order = [];
        const seen = new Set();
        for (const tp of th.prompts) {
            const pr = fromPresetPrompt(tp, old.get(String(tp.id)));
            if (seen.has(pr.identifier)) continue;
            seen.add(pr.identifier);
            prompts.push(pr);
            order.push({ identifier: pr.identifier, enabled: tp.enabled !== false });
        }
        for (const tp of th.prompts_unused ?? []) {
            const pr = fromPresetPrompt(tp, old.get(String(tp.id)));
            if (seen.has(pr.identifier)) continue;
            seen.add(pr.identifier);
            prompts.push(pr);
        }
        p.prompts = prompts;
        const rest = (p.prompt_order ?? []).filter(o => Number(o.character_id) !== PROMPT_ORDER_GLOBAL);
        p.prompt_order = [...rest, { character_id: PROMPT_ORDER_GLOBAL, order }];
    }
    if (th?.extensions !== undefined) p.extensions = clone(th.extensions ?? {});
    return p;
}

// ---------- 正则 ----------

export function toTavernRegex(r) {
    const pl = (r.placement ?? []).map(Number);
    return {
        id: String(r.id ?? ''),
        script_name: String(r.scriptName ?? ''),
        enabled: !r.disabled,
        find_regex: String(r.findRegex ?? ''),
        replace_string: String(r.replaceString ?? ''),
        trim_strings: [...(r.trimStrings ?? [])],
        source: {
            user_input: pl.includes(REGEX_PLACEMENT.USER_INPUT),
            ai_output: pl.includes(REGEX_PLACEMENT.AI_OUTPUT),
            slash_command: pl.includes(REGEX_PLACEMENT.SLASH_COMMAND),
            world_info: pl.includes(REGEX_PLACEMENT.WORLD_INFO),
            reasoning: pl.includes(REGEX_PLACEMENT.REASONING),
        },
        destination: { display: !!r.markdownOnly, prompt: !!r.promptOnly },
        run_on_edit: r.runOnEdit !== false,
        min_depth: r.minDepth === '' || r.minDepth === undefined ? null : r.minDepth,
        max_depth: r.maxDepth === '' || r.maxDepth === undefined ? null : r.maxDepth,
    };
}

export function fromTavernRegex(t, old) {
    const placement = [];
    const src = t.source ?? {};
    if (src.user_input) placement.push(REGEX_PLACEMENT.USER_INPUT);
    if (src.ai_output) placement.push(REGEX_PLACEMENT.AI_OUTPUT);
    if (src.slash_command) placement.push(REGEX_PLACEMENT.SLASH_COMMAND);
    if (src.world_info) placement.push(REGEX_PLACEMENT.WORLD_INFO);
    if (src.reasoning) placement.push(REGEX_PLACEMENT.REASONING);
    return newRegexScript({
        ...(old ?? {}),
        id: String(t.id || old?.id || uuid()),
        scriptName: String(t.script_name ?? old?.scriptName ?? ''),
        disabled: t.enabled === false,
        findRegex: String(t.find_regex ?? ''),
        replaceString: String(t.replace_string ?? ''),
        trimStrings: [...(t.trim_strings ?? [])],
        placement: t.source ? placement : (old?.placement ?? [REGEX_PLACEMENT.AI_OUTPUT]),
        markdownOnly: !!t.destination?.display,
        promptOnly: !!t.destination?.prompt,
        runOnEdit: t.run_on_edit !== false,
        minDepth: t.min_depth ?? null,
        maxDepth: t.max_depth ?? null,
    });
}
