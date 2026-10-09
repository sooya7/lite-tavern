// 世界书引擎：数据格式与激活语义对齐酒馆 world-info.js（关键词/正则键/选择逻辑/常驻/递归/
// 概率/分组/预算/位置/深度/粘滞/冷却/延迟/装饰器）。
import { parseRegexFromString, escapeRegex, hashString } from './util.js';

export const WI_POSITION = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const WI_STRATEGY = { evenly: 0, character_first: 1, global_first: 2 };
export const ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const ROLE_NAMES = ['system', 'user', 'assistant'];
export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;

export const DEFAULT_WI_SETTINGS = {
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_include_names: true,
    world_info_recursive: false,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_character_strategy: WI_STRATEGY.character_first,
    world_info_budget_cap: 0,
    world_info_use_group_scoring: false,
    world_info_max_recursion_steps: 0,
};

export function newWorldInfoEntry(uid, partial = {}) {
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: WI_LOGIC.AND_ANY,
        addMemo: true,
        order: 100,
        position: WI_POSITION.after,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: DEFAULT_DEPTH,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: DEFAULT_WEIGHT,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: ROLE.SYSTEM,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        characterFilter: { isExclude: false, names: [], tags: [] },
        displayIndex: uid,
        ...partial,
    };
}

/** 规范化世界书 JSON（补全缺省字段，保留未知字段） */
export function normalizeWorld(json) {
    const entries = {};
    const src = json?.entries ?? {};
    const list = Array.isArray(src) ? src : Object.values(src);
    list.forEach((e, i) => {
        const uid = Number.isFinite(Number(e?.uid)) ? Number(e.uid) : i;
        const merged = newWorldInfoEntry(uid, e);
        if (!Array.isArray(merged.key)) merged.key = String(merged.key ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (!Array.isArray(merged.keysecondary)) merged.keysecondary = String(merged.keysecondary ?? '').split(',').map(s => s.trim()).filter(Boolean);
        entries[uid] = merged;
    });
    return { ...json, entries };
}

/** 角色卡内嵌 character_book → 世界书（酒馆 convertCharacterBook） */
export function characterBookToWorld(book) {
    const entries = {};
    (book?.entries ?? []).forEach((entry, index) => {
        const id = entry.id ?? index;
        const x = entry.extensions ?? {};
        entries[id] = newWorldInfoEntry(id, {
            key: entry.keys ?? [],
            keysecondary: entry.secondary_keys ?? [],
            comment: entry.comment ?? entry.name ?? '',
            content: entry.content ?? '',
            constant: !!entry.constant,
            selective: !!entry.selective,
            order: entry.insertion_order ?? 100,
            position: x.position ?? (entry.position === 'before_char' ? WI_POSITION.before : WI_POSITION.after),
            excludeRecursion: x.exclude_recursion ?? false,
            preventRecursion: x.prevent_recursion ?? false,
            delayUntilRecursion: x.delay_until_recursion ?? false,
            disable: entry.enabled === false,
            addMemo: !!entry.comment,
            displayIndex: x.display_index ?? index,
            probability: x.probability ?? 100,
            useProbability: x.useProbability ?? true,
            depth: x.depth ?? DEFAULT_DEPTH,
            selectiveLogic: x.selectiveLogic ?? WI_LOGIC.AND_ANY,
            outletName: x.outlet_name ?? '',
            group: x.group ?? '',
            groupOverride: x.group_override ?? false,
            groupWeight: x.group_weight ?? DEFAULT_WEIGHT,
            scanDepth: x.scan_depth ?? null,
            caseSensitive: x.case_sensitive ?? null,
            matchWholeWords: x.match_whole_words ?? null,
            useGroupScoring: x.use_group_scoring ?? null,
            automationId: x.automation_id ?? '',
            role: x.role ?? ROLE.SYSTEM,
            vectorized: x.vectorized ?? false,
            sticky: x.sticky ?? null,
            cooldown: x.cooldown ?? null,
            delay: x.delay ?? null,
            matchPersonaDescription: x.match_persona_description ?? false,
            matchCharacterDescription: x.match_character_description ?? false,
            matchCharacterPersonality: x.match_character_personality ?? false,
            matchCharacterDepthPrompt: x.match_character_depth_prompt ?? false,
            matchScenario: x.match_scenario ?? false,
            matchCreatorNotes: x.match_creator_notes ?? false,
            triggers: x.triggers ?? [],
            ignoreBudget: x.ignore_budget ?? false,
            extensions: x,
        });
    });
    return { name: book?.name ?? '', entries, originalData: book };
}

/** 世界书 → character_book（导出角色卡时内嵌，酒馆 convertWorldInfoToCharacterBook） */
export function worldToCharacterBook(name, entriesObj) {
    const entries = Object.values(entriesObj ?? {}).map(e => ({
        id: e.uid,
        keys: e.key,
        secondary_keys: e.keysecondary,
        comment: e.comment,
        content: e.content,
        constant: e.constant,
        selective: e.selective,
        insertion_order: e.order,
        enabled: !e.disable,
        position: e.position == 0 ? 'before_char' : 'after_char',
        use_regex: true,
        extensions: {
            ...(e.extensions ?? {}),
            position: e.position,
            exclude_recursion: e.excludeRecursion,
            display_index: e.displayIndex,
            probability: e.probability ?? null,
            useProbability: e.useProbability ?? false,
            depth: e.depth ?? DEFAULT_DEPTH,
            selectiveLogic: e.selectiveLogic ?? 0,
            outlet_name: e.outletName ?? '',
            group: e.group ?? '',
            group_override: e.groupOverride ?? false,
            group_weight: e.groupWeight ?? null,
            prevent_recursion: e.preventRecursion ?? false,
            delay_until_recursion: e.delayUntilRecursion ?? false,
            scan_depth: e.scanDepth ?? null,
            match_whole_words: e.matchWholeWords ?? null,
            use_group_scoring: e.useGroupScoring ?? false,
            case_sensitive: e.caseSensitive ?? null,
            automation_id: e.automationId ?? '',
            role: e.role ?? 0,
            vectorized: e.vectorized ?? false,
            sticky: e.sticky ?? null,
            cooldown: e.cooldown ?? null,
            delay: e.delay ?? null,
            match_persona_description: e.matchPersonaDescription ?? false,
            match_character_description: e.matchCharacterDescription ?? false,
            match_character_personality: e.matchCharacterPersonality ?? false,
            match_character_depth_prompt: e.matchCharacterDepthPrompt ?? false,
            match_scenario: e.matchScenario ?? false,
            match_creator_notes: e.matchCreatorNotes ?? false,
            triggers: e.triggers ?? [],
            ignore_budget: e.ignoreBudget ?? false,
        },
    }));
    return { name, entries };
}

/**
 * 解析条目开头的 @@ 装饰器行（酒馆原生 + ST-Prompt-Template 扩展）
 * @returns {{decorators: {name: string, args: string}[], content: string}}
 */
export function parseDecorators(content) {
    if (typeof content !== 'string' || !content.startsWith('@@')) return { decorators: [], content: content ?? '' };
    const lines = content.split('\n');
    const decorators = [];
    let i = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('@@')) break;
        if (line.startsWith('@@@')) continue; // 转义行，酒馆会把它当未知装饰器跳过
        const m = line.match(/^(@@[\w-]+)\s*(.*)$/);
        if (m) decorators.push({ name: m[1], args: m[2].trim() });
    }
    return { decorators, content: lines.slice(i).join('\n') };
}

export const hasDecorator = (entry, name) => (entry.decorators ?? []).some(d => d.name === name);

const sortByOrderDesc = (a, b) => b.order - a.order;

export function entryKey(entry) {
    return `${entry.world}.${entry.uid}`;
}

/**
 * 汇总各来源条目并按酒馆策略排序。sources 中每项: {world: string, entries: object}
 * @param {{chat?: object[], persona?: object[], global?: object[], character?: object[], strategy?: number}} p
 */
export function getSortedEntries({ chat = [], persona = [], global = [], character = [], strategy = WI_STRATEGY.character_first }) {
    const seen = new Set();
    const collect = (books) => {
        const out = [];
        for (const b of books) {
            if (!b || seen.has(b.world)) continue;
            seen.add(b.world);
            for (const e of Object.values(b.entries ?? {})) out.push({ ...e, world: b.world });
        }
        return out;
    };
    const chatLore = collect(chat);
    const personaLore = collect(persona);
    const globalLore = collect(global);
    const charLore = collect(character);
    let entries;
    switch (Number(strategy)) {
        case WI_STRATEGY.evenly: entries = [...globalLore, ...charLore].sort(sortByOrderDesc); break;
        case WI_STRATEGY.global_first: entries = [...globalLore.sort(sortByOrderDesc), ...charLore.sort(sortByOrderDesc)]; break;
        default: entries = [...charLore.sort(sortByOrderDesc), ...globalLore.sort(sortByOrderDesc)]; break;
    }
    entries = [...chatLore.sort(sortByOrderDesc), ...personaLore.sort(sortByOrderDesc), ...entries];
    return entries.map(e => {
        const { decorators, content } = parseDecorators(e.content || '');
        return { ...structuredClone(e), decorators, content };
    });
}

class ScanBuffer {
    constructor(messages, globalScanData, settings) {
        this.depthBuffer = [];
        for (let d = 0; d < Math.min(messages.length, MAX_SCAN_DEPTH); d++) this.depthBuffer[d] = String(messages[d] ?? '').trim();
        this.recurse = [];
        this.inject = [];
        this.global = globalScanData ?? {};
        this.settings = settings;
        this.skew = 0;
    }

    depth() {
        return this.settings.world_info_depth + this.skew;
    }

    get(entry, scanState) {
        let depth = entry.scanDepth ?? this.depth();
        if (depth <= 0) depth = 0;
        if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;
        const J = '\n\x01';
        let result = '\x01' + this.depthBuffer.slice(0, depth).join(J);
        const g = this.global;
        if (entry.matchPersonaDescription && g.personaDescription) result += J + g.personaDescription;
        if (entry.matchCharacterDescription && g.characterDescription) result += J + g.characterDescription;
        if (entry.matchCharacterPersonality && g.characterPersonality) result += J + g.characterPersonality;
        if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) result += J + g.characterDepthPrompt;
        if (entry.matchScenario && g.scenario) result += J + g.scenario;
        if (entry.matchCreatorNotes && g.creatorNotes) result += J + g.creatorNotes;
        if (this.inject.length) result += J + this.inject.join(J);
        if (this.recurse.length && scanState !== SCAN.MIN_ACTIVATIONS) result += J + this.recurse.join(J);
        return result;
    }

    matchKeys(haystack, needle, entry) {
        const keyRegex = parseRegexFromString(needle);
        if (keyRegex) return keyRegex.test(haystack);
        const cs = entry.caseSensitive ?? this.settings.world_info_case_sensitive;
        const h = cs ? haystack : haystack.toLowerCase();
        const n = cs ? needle : needle.toLowerCase();
        const whole = entry.matchWholeWords ?? this.settings.world_info_match_whole_words;
        if (whole) {
            if (n.split(/\s+/).length > 1) return h.includes(n);
            return new RegExp(`(?:^|\\W)(${escapeRegex(n)})(?:$|\\W)`).test(h);
        }
        return h.includes(n);
    }
}

const SCAN = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 };

/** 粘滞/冷却/延迟（状态存在 chat_metadata.timedWorldInfo） */
class TimedEffects {
    constructor(chatLength, entries, store, dryRun) {
        this.len = chatLength;
        this.entries = entries;
        this.store = store ?? {};
        this.dryRun = dryRun;
        for (const t of ['sticky', 'cooldown']) if (!this.store[t] || typeof this.store[t] !== 'object') this.store[t] = {};
        this.buffer = { sticky: new Set(), cooldown: new Set(), delay: new Set() };
    }

    key(e) {
        return String(hashString(entryKey(e)));
    }

    check() {
        const onEnded = { sticky: (e) => {
            if (!e.cooldown) return;
            this.store.cooldown[this.key(e)] = { hash: this.key(e), start: this.len, end: this.len + Number(e.cooldown), protected: true };
            this.buffer.cooldown.add(this.key(e));
        } };
        for (const type of ['sticky', 'cooldown']) {
            for (const [k, v] of Object.entries(this.store[type])) {
                const entry = this.entries.find(e => this.key(e) === String(v.hash));
                if (this.len <= Number(v.start) && !v.protected) { delete this.store[type][k]; continue; }
                if (!entry) { if (this.len >= Number(v.end)) delete this.store[type][k]; continue; }
                if (!entry[type]) { delete this.store[type][k]; continue; }
                if (this.len >= Number(v.end)) {
                    delete this.store[type][k];
                    onEnded[type]?.(entry);
                    continue;
                }
                this.buffer[type].add(this.key(entry));
            }
        }
        for (const e of this.entries) if (e.delay && this.len < e.delay) this.buffer.delay.add(this.key(e));
    }

    active(type, e) {
        return this.buffer[type].has(this.key(e));
    }

    set(activated) {
        if (this.dryRun) return;
        for (const type of ['sticky', 'cooldown']) {
            for (const e of activated) {
                if (!e[type]) continue;
                const k = this.key(e);
                if (!this.store[type][k]) this.store[type][k] = { hash: k, start: this.len, end: this.len + Number(e[type]), protected: false };
            }
        }
    }
}

/**
 * 执行世界书扫描。
 * @param {object} p
 * @param {string[]} p.messages 最新在前的扫描文本（已按 include_names 拼好名字）
 * @param {object[]} p.entries getSortedEntries 的结果
 * @param {object} p.settings world_info_settings
 * @param {number} p.maxContext
 * @param {object} [p.globalScanData]
 * @param {string[]} [p.injects] 额外参与扫描的文本（如作者注释）
 * @param {(s: string) => string} [p.substitute] 宏替换
 * @param {(content: string, entry: object) => string} [p.regexContent] 世界书正则
 * @param {(s: string) => number} [p.countTokens]
 * @param {string} [p.characterName] 角色卡文件名（不含扩展名），用于 characterFilter
 * @param {string[]} [p.characterTags]
 * @param {string} [p.generationType]
 * @param {number} [p.chatLength] 当前聊天消息数（粘滞/延迟用）
 * @param {object} [p.timedStore] chat_metadata.timedWorldInfo
 * @param {boolean} [p.dryRun]
 * @param {Set<string>} [p.forced] 外部强制激活的 entryKey 集合
 * @param {() => number} [p.random]
 */
export async function checkWorldInfo(p) {
    const settings = { ...DEFAULT_WI_SETTINGS, ...(p.settings ?? {}) };
    const substitute = p.substitute ?? (s => s);
    const countTokens = p.countTokens ?? (s => Math.ceil(String(s).length / 3));
    const random = p.random ?? Math.random;
    const entries = p.entries ?? [];
    const buffer = new ScanBuffer(p.messages ?? [], p.globalScanData, settings);
    for (const inj of p.injects ?? []) if (inj) buffer.inject.push(inj);

    const empty = { worldInfoBefore: '', worldInfoAfter: '', depthEntries: [], anTop: [], anBottom: [], emEntries: [], outlets: {}, activated: [] };
    if (!entries.length) return empty;

    let budget = Math.round(settings.world_info_budget * p.maxContext / 100) || 1;
    if (settings.world_info_budget_cap > 0 && budget > settings.world_info_budget_cap) budget = settings.world_info_budget_cap;

    const timed = new TimedEffects(p.chatLength ?? p.messages?.length ?? 0, entries, p.timedStore, p.dryRun);
    timed.check();

    const delayLevels = [...new Set(entries.filter(e => e.delayUntilRecursion).map(e => e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion)))].sort((a, b) => a - b);
    let currentDelayLevel = delayLevels.shift() ?? 0;

    let scanState = SCAN.INITIAL;
    let overflow = false;
    let count = 0;
    const activated = new Map();
    const failedProbability = new Set();
    let activatedText = '';

    while (scanState) {
        if (settings.world_info_max_recursion_steps && settings.world_info_max_recursion_steps <= count) break;
        count++;
        let nextState = SCAN.NONE;
        const now = new Set();

        for (const entry of entries) {
            if (failedProbability.has(entry) || activated.has(entryKey(entry))) continue;
            if (entry.disable) continue;
            const cf = entry.characterFilter;
            if (cf?.names?.length) {
                const included = cf.names.includes(p.characterName);
                if (cf.isExclude ? included : !included) continue;
            }
            if (cf?.tags?.length && p.characterTags) {
                const inc = p.characterTags.some(t => cf.tags.includes(t));
                if (cf.isExclude ? inc : !inc) continue;
            }
            if (Array.isArray(entry.triggers) && entry.triggers.length && p.generationType && !entry.triggers.includes(p.generationType)) continue;

            const sticky = timed.active('sticky', entry);
            if (timed.active('delay', entry)) continue;
            if (timed.active('cooldown', entry) && !sticky) continue;
            if (scanState !== SCAN.RECURSION && entry.delayUntilRecursion && !sticky) continue;
            if (scanState === SCAN.RECURSION && entry.delayUntilRecursion && Number(entry.delayUntilRecursion) > currentDelayLevel && !sticky) continue;
            if (scanState === SCAN.RECURSION && settings.world_info_recursive && entry.excludeRecursion && !sticky) continue;

            if (hasDecorator(entry, '@@activate')) { now.add(entry); continue; }
            if (hasDecorator(entry, '@@dont_activate')) continue;
            if (entry.constant) { now.add(entry); continue; }
            if (p.forced?.has(entryKey(entry))) { now.add(entry); continue; }
            if (sticky) { now.add(entry); continue; }
            if (!Array.isArray(entry.key) || !entry.key.length) continue;

            const text = buffer.get(entry, scanState);
            const primary = entry.key.find(k => {
                const s = substitute(k);
                return s && buffer.matchKeys(text, s.trim(), entry);
            });
            if (!primary) continue;

            const hasSecondary = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length;
            if (!hasSecondary) { now.add(entry); continue; }

            const logic = Number(entry.selectiveLogic ?? 0);
            let any = false, all = true, ok = false;
            for (const k2 of entry.keysecondary) {
                const s = substitute(k2);
                const hit = !!s && buffer.matchKeys(text, s.trim(), entry);
                if (hit) any = true; else all = false;
                if (logic === WI_LOGIC.AND_ANY && hit) { ok = true; break; }
                if (logic === WI_LOGIC.NOT_ALL && !hit) { ok = true; break; }
            }
            if (!ok && logic === WI_LOGIC.NOT_ANY && !any) ok = true;
            if (!ok && logic === WI_LOGIC.AND_ALL && all) ok = true;
            if (ok) now.add(entry);
        }

        const newEntries = [...now].sort((a, b) => {
            const sa = timed.active('sticky', a) ? 1 : 0, sb = timed.active('sticky', b) ? 1 : 0;
            return sb - sa || entries.indexOf(a) - entries.indexOf(b);
        });
        filterByInclusionGroups(newEntries, activated, buffer, timed, settings, random);

        let newContent = '';
        const baseTokens = countTokens(activatedText);
        for (const entry of newEntries) {
            if (entry.useProbability && random() * 100 > entry.probability && !timed.active('sticky', entry)) {
                failedProbability.add(entry);
                continue;
            }
            entry.content = substitute(entry.content);
            if (!entry.ignoreBudget) {
                if (overflow) continue;
                newContent += `${entry.content}\n`;
                if (baseTokens + countTokens(newContent) >= budget) {
                    overflow = true;
                    continue;
                }
            }
            activated.set(entryKey(entry), entry);
        }

        const successful = newEntries.filter(e => activated.has(entryKey(e)));
        const forRecursion = successful.filter(e => !e.preventRecursion);

        if (settings.world_info_recursive && !overflow && forRecursion.length) nextState = SCAN.RECURSION;
        if (settings.world_info_recursive && !overflow && scanState === SCAN.MIN_ACTIVATIONS && buffer.recurse.length) nextState = SCAN.RECURSION;

        const minNotMet = settings.world_info_min_activations > 0 && activated.size < settings.world_info_min_activations;
        if (!nextState && !overflow && minNotMet) {
            const overMax = (settings.world_info_min_activations_depth_max > 0 && buffer.depth() > settings.world_info_min_activations_depth_max)
                || buffer.depth() > (p.messages?.length ?? 0);
            if (!overMax) {
                nextState = SCAN.MIN_ACTIVATIONS;
                buffer.skew++;
            }
        }
        if (nextState === SCAN.NONE && delayLevels.length) {
            nextState = SCAN.RECURSION;
            currentDelayLevel = delayLevels.shift();
        }
        scanState = nextState;
        if (scanState) {
            const text = forRecursion.map(e => e.content).join('\n');
            if (text) buffer.recurse.push(text);
            activatedText = text + '\n' + activatedText;
        }
    }

    // 组装输出：按 order 降序遍历再 unshift → 最终升序（与酒馆一致）
    const before = [], after = [], anTop = [], anBottom = [], em = [], depth = [], outlets = {};
    for (const entry of [...activated.values()].sort(sortByOrderDesc)) {
        const regexDepth = entry.position === WI_POSITION.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
        const content = p.regexContent ? p.regexContent(entry.content, entry, regexDepth) : entry.content;
        if (!content) continue;
        switch (Number(entry.position)) {
            case WI_POSITION.before: before.unshift(content); break;
            case WI_POSITION.after: after.unshift(content); break;
            case WI_POSITION.EMTop: em.unshift({ position: 'before', content }); break;
            case WI_POSITION.EMBottom: em.unshift({ position: 'after', content }); break;
            case WI_POSITION.ANTop: anTop.unshift(content); break;
            case WI_POSITION.ANBottom: anBottom.unshift(content); break;
            case WI_POSITION.atDepth: {
                const d = entry.depth ?? DEFAULT_DEPTH, r = entry.role ?? ROLE.SYSTEM;
                const ex = depth.find(x => x.depth === d && x.role === r);
                if (ex) ex.entries.unshift(content); else depth.push({ depth: d, role: r, entries: [content] });
                break;
            }
            case WI_POSITION.outlet: {
                const name = entry.outletName;
                if (!name) break;
                (outlets[name] ??= []).unshift(content);
                break;
            }
        }
    }
    timed.set([...activated.values()]);
    const outletText = Object.fromEntries(Object.entries(outlets).map(([k, v]) => [k, v.join('\n')]));
    return {
        worldInfoBefore: before.join('\n'),
        worldInfoAfter: after.join('\n'),
        depthEntries: depth,
        anTop,
        anBottom,
        emEntries: em,
        outlets: outletText,
        activated: [...activated.values()],
        overflow,
    };
}

function filterByInclusionGroups(newEntries, activated, buffer, timed, settings, random) {
    const grouped = {};
    for (const e of newEntries) {
        if (!e.group) continue;
        for (const g of String(e.group).split(/,\s*/).filter(Boolean)) (grouped[g] ??= []).push(e);
    }
    if (!Object.keys(grouped).length) return;
    const remove = (e) => { const i = newEntries.indexOf(e); if (i >= 0) newEntries.splice(i, 1); };
    const removeAllBut = (group, keep) => group.forEach(e => { if (e !== keep) remove(e); });

    for (const [g, group] of Object.entries(grouped)) {
        // 粘滞优先；冷却/延迟中的移出
        const stickies = group.filter(e => timed.active('sticky', e));
        if (stickies.length) {
            group.filter(e => !stickies.includes(e)).forEach(remove);
            grouped[g] = stickies;
        }
    }
    for (const [g, group] of Object.entries(grouped)) {
        const useScoring = group.some(e => e.useGroupScoring ?? settings.world_info_use_group_scoring);
        if (!useScoring || group.length < 2) continue;
        const score = (e) => {
            const text = buffer.get(e, SCAN.INITIAL);
            let s = 0;
            for (const k of e.key ?? []) if (k && buffer.matchKeys(text, k.trim(), e)) s++;
            for (const k of e.keysecondary ?? []) if (k && buffer.matchKeys(text, k.trim(), e)) s++;
            return s;
        };
        const scores = group.map(score);
        const max = Math.max(...scores);
        group.forEach((e, i) => { if (scores[i] < max && (e.useGroupScoring ?? settings.world_info_use_group_scoring)) remove(e); });
        grouped[g] = group.filter((_, i) => scores[i] === max);
    }
    for (const [g, group] of Object.entries(grouped)) {
        const alive = group.filter(e => newEntries.includes(e));
        if ([...activated.values()].some(e => String(e.group).split(/,\s*/).includes(g))) {
            alive.forEach(remove);
            continue;
        }
        if (alive.length <= 1) continue;
        const prios = alive.filter(e => e.groupOverride).sort(sortByOrderDesc);
        if (prios.length) { removeAllBut(alive, prios[0]); continue; }
        const total = alive.reduce((a, e) => a + (e.groupWeight ?? DEFAULT_WEIGHT), 0);
        const roll = random() * total;
        let cur = 0, winner = null;
        for (const e of alive) {
            cur += e.groupWeight ?? DEFAULT_WEIGHT;
            if (roll <= cur) { winner = e; break; }
        }
        if (winner) removeAllBut(alive, winner);
    }
}

/** 示例对话里的 WI（EM 位置）需要的块格式化 */
export function formatWorldInfoValue(format, value) {
    if (!value) return '';
    if (!format || !format.trim()) return value;
    return format.replace(/\{0\}/g, value);
}
