// 酒馆助手接口里补齐的那一批：音频、旧版世界书（lorebook）接口、用户设定（persona）、新建 / 删除角色卡、
// 一键导入（importRaw*）、扩展管理、模型列表。名字和形状照着酒馆助手 4.x 的类型声明，
// 旧版世界书条目的字段换算照着酒馆助手自己的实现（src/function/lorebook_entry.ts）。
import { state, saveSettings, saveWorld, loadWorld, refreshLists, eventSource } from '../state.js';
import { api } from '../api.js';
import { reloadCharacters, refresh } from '../controller.js';
import { listModelsOf } from '../generate.js';
import { normalizeWorld, DEFAULT_WI_SETTINGS } from '../core/worldinfo.js';
import { newCard } from '../core/card.js';
import { normalizeRegexScript } from '../core/regex.js';
import { parseChatJsonl } from '../core/chat.js';
import { uuid } from '../core/util.js';
import { rerenderIfActive } from './panels/index.js';
import { fetchExtensionList, extensionList } from './extensions.js';
import { classifyJson } from './importers.js';
import * as audio from './audio.js';

const lodash = () => window._;
const deep = (v) => (v === undefined ? undefined : lodash().cloneDeep(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- 旧版世界书条目 ----------

const POS_NAME = { 0: 'before_character_definition', 1: 'after_character_definition', 5: 'before_example_messages', 6: 'after_example_messages', 2: 'before_author_note', 3: 'after_author_note' };
const POS_NUM = {
    before_character_definition: 0, after_character_definition: 1, before_example_messages: 5, after_example_messages: 6,
    before_author_note: 2, after_author_note: 3, at_depth_as_system: 4, at_depth_as_user: 4, at_depth_as_assistant: 4,
};
const LOGIC_NAME = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };
const LOGIC_NUM = { and_any: 0, not_all: 1, not_any: 2, and_all: 3 };
const ROLE_NUM = { at_depth_as_system: 0, at_depth_as_user: 1, at_depth_as_assistant: 2 };

const DEFAULT_RAW_ENTRY = {
    key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
    order: 100, position: 0, disable: false, excludeRecursion: false, preventRecursion: false, matchPersonaDescription: false,
    matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false,
    matchCreatorNotes: false, delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false,
    groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0,
    sticky: null, cooldown: null, delay: null,
};

export function toLorebookEntry(e) {
    const keys = Array.isArray(e.key) ? e.key : [];
    const filters = Array.isArray(e.keysecondary) ? e.keysecondary : [];
    return {
        uid: Number(e.uid),
        display_index: Number(e.displayIndex ?? e.uid),
        comment: String(e.comment ?? ''),
        enabled: !e.disable,
        type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
        position: POS_NAME[e.position] ?? (e.role === 1 ? 'at_depth_as_user' : e.role === 2 ? 'at_depth_as_assistant' : 'at_depth_as_system'),
        depth: Number(e.position) === 4 ? Number(e.depth ?? 4) : null,
        order: Number(e.order ?? 100),
        probability: Number(e.probability ?? 100),
        key: keys, keys,
        logic: LOGIC_NAME[e.selectiveLogic] ?? 'and_any',
        filter: filters, filters,
        scan_depth: e.scanDepth ?? 'same_as_global',
        case_sensitive: e.caseSensitive ?? 'same_as_global',
        match_whole_words: e.matchWholeWords ?? 'same_as_global',
        use_group_scoring: e.useGroupScoring ?? 'same_as_global',
        automation_id: e.automationId || null,
        exclude_recursion: !!e.excludeRecursion,
        prevent_recursion: !!e.preventRecursion,
        delay_until_recursion: e.delayUntilRecursion ?? false,
        content: String(e.content ?? ''),
        group: String(e.group ?? ''),
        group_prioritized: !!e.groupOverride,
        group_weight: Number(e.groupWeight ?? 100),
        sticky: e.sticky || null,
        cooldown: e.cooldown || null,
        delay: e.delay || null,
    };
}

/** 旧版条目（可以只有部分字段）→ 酒馆原始条目；没给的字段用默认值，base 给了就在它的基础上改 */
export function fromLorebookEntry(entry, base = null) {
    const out = { ...DEFAULT_RAW_ENTRY, ...(base ? deep(base) : {}) };
    const set = {
        uid: v => { out.uid = Number(v); },
        display_index: v => { out.displayIndex = Number(v); },
        comment: v => { out.comment = String(v ?? ''); },
        enabled: v => { out.disable = !v; },
        type: v => { out.constant = v === 'constant'; out.vectorized = v === 'vectorized'; },
        position: v => {
            if (POS_NUM[v] === undefined) return;
            out.position = POS_NUM[v];
            if (ROLE_NUM[v] !== undefined) out.role = ROLE_NUM[v];
        },
        depth: v => { out.depth = v === null ? 4 : Number(v); },
        order: v => { out.order = Number(v); },
        probability: v => { out.probability = Number(v); },
        keys: v => { out.key = [...(v ?? [])].map(String); },
        key: v => { out.key = [...(v ?? [])].map(String); },
        logic: v => { if (LOGIC_NUM[v] !== undefined) out.selectiveLogic = LOGIC_NUM[v]; },
        filters: v => { out.keysecondary = [...(v ?? [])].map(String); },
        filter: v => { out.keysecondary = [...(v ?? [])].map(String); },
        scan_depth: v => { out.scanDepth = v === 'same_as_global' ? null : Number(v); },
        case_sensitive: v => { out.caseSensitive = v === 'same_as_global' ? null : !!v; },
        match_whole_words: v => { out.matchWholeWords = v === 'same_as_global' ? null : !!v; },
        use_group_scoring: v => { out.useGroupScoring = v === 'same_as_global' ? null : !!v; },
        automation_id: v => { out.automationId = v === null ? '' : String(v); },
        exclude_recursion: v => { out.excludeRecursion = !!v; },
        prevent_recursion: v => { out.preventRecursion = !!v; },
        delay_until_recursion: v => { out.delayUntilRecursion = v; },
        content: v => { out.content = String(v ?? ''); },
        group: v => { out.group = String(v ?? ''); },
        group_prioritized: v => { out.groupOverride = !!v; },
        group_weight: v => { out.groupWeight = Number(v); },
        sticky: v => { out.sticky = v === null ? 0 : Number(v); },
        cooldown: v => { out.cooldown = v === null ? 0 : Number(v); },
        delay: v => { out.delay = v === null ? 0 : Number(v); },
    };
    for (const [k, v] of Object.entries(entry ?? {})) if (v !== undefined) set[k]?.(v);
    return out;
}

const MAX_UID = 1_000_000;

async function worldOrThrow(name) {
    const w = await loadWorld(String(name));
    if (!w) throw new Error(`未能找到世界书 '${name}'`);
    return w;
}

function writeEntries(name, rawList) {
    const w = state.worlds[name] ?? (state.worlds[name] = normalizeWorld({ entries: {} }));
    const entries = {};
    for (const e of rawList) entries[e.uid] = e;
    w.entries = normalizeWorld({ entries }).entries;
    saveWorld(name);
    rerenderIfActive('world');
}

function matchFilter(entry, filter) {
    return Object.entries(filter).every(([field, expected]) => {
        const v = entry[field];
        if (Array.isArray(v)) return (Array.isArray(expected) ? expected : [expected]).every(x => v.includes(x));
        if (typeof v === 'string') return v.includes(String(expected));
        return v === expected;
    });
}

// ---------- 用户设定 ----------

function personaOf(id) {
    const s = state.settings;
    if (id === undefined || id === null || id === 'current') return s.personas.find(p => p.id === s.activePersona) ?? s.personas[0] ?? null;
    return s.personas.find(p => p.id === String(id) || p.name === String(id)) ?? null;
}

function toPersona(p) {
    return {
        avatar_id: p.id,
        avatar: p.avatar || `${p.id}.png`,
        name: p.name,
        title: p.title ?? '',
        description: p.description ?? '',
        position: Number(p.position ?? 0),
        depth: Number(p.depth ?? 2),
        role: Number(p.role ?? 0),
        lorebook: p.lorebook ?? '',
        connections: deep(p.connections ?? []),
        is_default: state.settings.defaultPersona === p.id,
    };
}

async function applyPersona(p, data, { replace = false } = {}) {
    const d = deep(data) ?? {};
    if (replace) { p.title = ''; p.description = ''; p.position = 0; p.depth = 2; p.role = 0; p.lorebook = ''; p.connections = []; }
    for (const k of ['name', 'title', 'description', 'lorebook']) if (d[k] !== undefined) p[k] = String(d[k] ?? '');
    for (const k of ['position', 'depth', 'role']) if (d[k] !== undefined) p[k] = Number(d[k]);
    if (Array.isArray(d.connections)) p.connections = d.connections;
    if (d.is_default === true) state.settings.defaultPersona = p.id;
    if (typeof Blob !== 'undefined' && d.avatar instanceof Blob) {
        const file = `${p.id}.png`;
        await api.savePersonaAvatar(file, d.avatar);
        p.avatar = file;
    }
}

function afterPersona(render) {
    saveSettings();
    state.session = null;
    if (render !== 'none') { refresh(['panels', 'topbar']); rerenderIfActive('persona'); }
}

// ---------- 主体 ----------

/**
 * @param {object} helper createScriptApi 里已经建好的接口（复用新版世界书 / 角色卡的实现）
 */
export function createMoreApi(helper) {
    // ----- 生成 -----
    const getModelList = (custom) => listModelsOf(custom ?? {});
    const getProxyPresetNames = () => state.settings.connections.map(c => c.name);

    // ----- 音频 -----
    const audioApi = {
        playAudio: audio.playAudio, pauseAudio: audio.pauseAudio, getAudioList: audio.getAudioList, replaceAudioList: audio.replaceAudioList,
        appendAudioList: audio.appendAudioList, getAudioSettings: audio.getAudioSettings, setAudioSettings: audio.setAudioSettings,
        getCurrentAudio: audio.getCurrentAudio,
    };

    // ----- 旧版世界书 -----
    const getLorebookSettings = () => {
        const w = { ...DEFAULT_WI_SETTINGS, ...state.settings.worldInfo };
        return {
            selected_global_lorebooks: [...(w.globalSelect ?? [])],
            scan_depth: w.world_info_depth,
            context_percentage: w.world_info_budget,
            budget_cap: w.world_info_budget_cap,
            min_activations: w.world_info_min_activations,
            max_depth: w.world_info_min_activations_depth_max,
            max_recursion_steps: w.world_info_max_recursion_steps,
            insertion_strategy: { 0: 'evenly', 1: 'character_first', 2: 'global_first' }[w.world_info_character_strategy] ?? 'character_first',
            include_names: !!w.world_info_include_names,
            recursive: !!w.world_info_recursive,
            case_sensitive: !!w.world_info_case_sensitive,
            match_whole_words: !!w.world_info_match_whole_words,
            use_group_scoring: !!w.world_info_use_group_scoring,
            overflow_alert: !!w.world_info_overflow_alert,
        };
    };
    const setLorebookSettings = (s = {}) => {
        const w = state.settings.worldInfo;
        const map = {
            scan_depth: 'world_info_depth', context_percentage: 'world_info_budget', budget_cap: 'world_info_budget_cap',
            min_activations: 'world_info_min_activations', max_depth: 'world_info_min_activations_depth_max',
            max_recursion_steps: 'world_info_max_recursion_steps', include_names: 'world_info_include_names', recursive: 'world_info_recursive',
            case_sensitive: 'world_info_case_sensitive', match_whole_words: 'world_info_match_whole_words',
            use_group_scoring: 'world_info_use_group_scoring', overflow_alert: 'world_info_overflow_alert',
        };
        for (const [k, f] of Object.entries(map)) if (s[k] !== undefined) w[f] = typeof DEFAULT_WI_SETTINGS[f] === 'boolean' ? !!s[k] : Number(s[k]);
        if (s.insertion_strategy !== undefined) w.world_info_character_strategy = { evenly: 0, character_first: 1, global_first: 2 }[s.insertion_strategy] ?? w.world_info_character_strategy;
        if (Array.isArray(s.selected_global_lorebooks)) {
            helper.rebindGlobalWorldbooks(s.selected_global_lorebooks);
        } else saveSettings();
        state.session = null;
        eventSource.emit('worldinfo_settings_updated');
        rerenderIfActive('world');
    };
    const getLorebooks = () => helper.getWorldbookNames();
    const deleteLorebook = (name) => helper.deleteWorldbook(name);
    const createLorebook = (name) => helper.createWorldbook(name, []);
    const getCharLorebooks = ({ name, type = 'all' } = {}) => {
        const r = helper.getCharWorldbookNames(name ?? 'current');
        if (type === 'primary') return { primary: r.primary, additional: [] };
        if (type === 'additional') return { primary: null, additional: r.additional };
        return r;
    };
    const getCurrentCharPrimaryLorebook = () => helper.getCharWorldbookNames('current').primary;
    const setCurrentCharLorebooks = async (books = {}) => {
        const cur = helper.getCharWorldbookNames('current');
        await helper.rebindCharWorldbooks('current', { primary: books.primary !== undefined ? books.primary : cur.primary, additional: books.additional ?? cur.additional });
    };
    const getChatLorebook = () => helper.getChatWorldbookName('current');
    const setChatLorebook = (name) => helper.rebindChatWorldbook('current', name ?? null);
    const getOrCreateChatLorebook = (name) => helper.getOrCreateChatWorldbook('current', name);

    const getLorebookEntries = async (name, { filter = 'none' } = {}) => {
        const w = await worldOrThrow(name);
        let list = Object.values(w.entries).map(toLorebookEntry);
        if (filter !== 'none' && isObj(filter)) list = list.filter(e => matchFilter(e, filter));
        return deep(list);
    };
    const replaceLorebookEntries = async (name, entries) => {
        await worldOrThrow(name);
        const used = new Set();
        const freeUid = (want) => {
            let i = Number.isInteger(want) ? want : Math.floor(Math.random() * MAX_UID);
            let step = 1;
            while (used.has(i)) { i = (i + step * step) % MAX_UID; step++; }
            used.add(i);
            return i;
        };
        let maxIndex = Math.max(-1, ...(entries ?? []).map(e => (Number.isFinite(e?.display_index) ? e.display_index : -1)));
        const raw = (entries ?? []).map((e) => {
            const uid = freeUid(Number.isInteger(e?.uid) ? e.uid : undefined);
            return fromLorebookEntry({ ...e, uid, display_index: Number.isFinite(e?.display_index) ? e.display_index : ++maxIndex });
        });
        writeEntries(String(name), raw);
    };
    const updateLorebookEntriesWith = async (name, updater) => {
        await replaceLorebookEntries(name, await updater(await getLorebookEntries(name)));
        return getLorebookEntries(name);
    };
    const setLorebookEntries = (name, entries) => updateLorebookEntriesWith(name, (data) => {
        for (const e of entries ?? []) {
            const hit = data.find(x => x.uid === e.uid);
            if (hit) lodash().merge(hit, deep(e));
            if (hit && Array.isArray(e.keys)) { hit.keys = [...e.keys]; hit.key = [...e.keys]; }
            if (hit && Array.isArray(e.filters)) { hit.filters = [...e.filters]; hit.filter = [...e.filters]; }
        }
        return data;
    });
    const createLorebookEntries = async (name, entries) => {
        const newUids = [];
        const updated = await updateLorebookEntriesWith(name, (data) => {
            const used = new Set(data.map(e => e.uid));
            const fresh = (entries ?? []).map((e) => {
                let i = 0;
                while (used.has(i)) i++;
                used.add(i);
                newUids.push(i);
                return { ...deep(e), uid: i };
            });
            return [...data, ...fresh];
        });
        return { entries: updated, new_uids: newUids };
    };
    const deleteLorebookEntries = async (name, uids) => {
        let deleted = false;
        const ids = new Set((uids ?? []).map(Number));
        const updated = await updateLorebookEntriesWith(name, (data) => {
            const keep = data.filter(e => !ids.has(e.uid));
            deleted = keep.length !== data.length;
            return keep;
        });
        return { entries: updated, delete_occurred: deleted };
    };

    // ----- 用户设定 -----
    const getPersonaNames = () => state.settings.personas.map(p => p.name);
    const getPersonaIds = () => state.settings.personas.map(p => p.id);
    const getCurrentPersonaName = () => personaOf('current')?.name ?? null;
    const getCurrentPersonaId = () => personaOf('current')?.id ?? null;
    const getPersonaAvatarPath = (id = 'current') => { const p = personaOf(id); return p?.avatar ? api.personaAvatarUrl(p.avatar) : null; };
    const getPersona = (id) => {
        const p = personaOf(id);
        if (!p) throw new Error(`用户设定「${id}」不存在`);
        return toPersona(p);
    };
    const createPersona = async (name, data = {}, options = {}) => {
        if (name === 'current') throw new Error('不能用 current 作为名字');
        if (state.settings.personas.some(p => p.name === String(name))) return false;
        const p = { id: `p_${uuid().slice(0, 8)}`, name: String(name), description: '', position: 0, depth: 2, role: 0, lorebook: '', avatar: '' };
        state.settings.personas.push(p);
        await applyPersona(p, { ...(data ?? {}), name: String(name) });
        afterPersona(options.render);
        return true;
    };
    const createOrReplacePersona = async (name, data = {}, options = {}) => {
        const p = state.settings.personas.find(x => x.name === String(name));
        if (!p) return createPersona(name, data, options);
        await applyPersona(p, { ...(data ?? {}), name: String(name) }, { replace: true });
        afterPersona(options.render);
        return false;
    };
    const deletePersona = async (id) => {
        const p = personaOf(id);
        if (!p) return false;
        const s = state.settings;
        s.personas = s.personas.filter(x => x !== p);
        if (s.activePersona === p.id) s.activePersona = s.personas[0]?.id ?? '';
        afterPersona();
        return true;
    };
    const replacePersona = async (id, data, options = {}) => {
        const p = personaOf(id);
        if (!p) throw new Error(`用户设定「${id}」不存在`);
        await applyPersona(p, data, { replace: true });
        afterPersona(options.render);
    };
    const updatePersonaWith = async (id, updater, options = {}) => {
        const next = await updater(getPersona(id));
        await replacePersona(id, next, options);
        return getPersona(id);
    };

    // ----- 角色卡：新建 / 删除 -----
    const fillCard = async (file, character) => {
        const ref = file;
        await helper.replaceCharacter(ref, character ?? {});
        if (typeof Blob !== 'undefined' && character?.avatar instanceof Blob) await api.setCharacterAvatar(ref, character.avatar);
    };
    const createCharacter = async (name, character = {}) => {
        if (name === 'current') throw new Error('不能用 current 作为名字');
        const n = String(name).replace(/\.png$/i, '');
        if (state.characters.some(c => c.name === n || c.file === String(name))) return false;
        const { file } = await api.createCharacter(newCard(n));
        await reloadCharacters();
        await fillCard(file, character);
        await reloadCharacters();
        return true;
    };
    const createOrReplaceCharacter = async (name, character = {}) => {
        const exists = name === 'current' ? !!state.char : state.characters.some(c => c.name === String(name) || c.file === String(name));
        if (!exists) return createCharacter(name, character);
        await helper.replaceCharacter(name, character ?? {});
        return false;
    };
    const deleteCharacter = async (name, { delete_chats = false } = {}) => {
        const meta = name === 'current' && state.char ? state.characters.find(c => c.file === state.char.file)
            : state.characters.find(c => c.name === String(name) || c.file === String(name) || c.id === String(name));
        if (!meta) return false;
        await api.deleteCharacter(meta.file, !!delete_chats);
        if (state.char?.file === meta.file) {
            state.char = null; state.chat = null; state.session = null; state.chatList = [];
            state.settings.lastChat = null;
            saveSettings();
        }
        await reloadCharacters();
        refresh();
        await eventSource.emit('characterDeleted', { id: meta.file, character: { name: meta.name, avatar: meta.file } });
        return true;
    };

    // ----- 一键导入 -----
    const textOf = async (content) => (typeof Blob !== 'undefined' && content instanceof Blob ? content.text() : String(content ?? ''));
    const okResponse = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const errResponse = (e) => new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const baseName = (f) => String(f ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

    const importRawCharacter = async (filename, content) => {
        try {
            const blob = typeof Blob !== 'undefined' && content instanceof Blob ? content : new Blob([String(content ?? '')], { type: 'application/json' });
            const file = new File([blob], String(filename || 'character.png'), { type: blob.type || (/\.png$/i.test(filename) ? 'image/png' : 'application/json') });
            const r = await api.importCharacter(file);
            await reloadCharacters();
            return okResponse({ file_name: r.file, ...r });
        } catch (e) { return errResponse(e); }
    };
    const importRawChat = async (filename, content) => {
        try {
            if (!state.char) throw new Error('没有打开角色卡，不知道导入到谁名下');
            const text = await textOf(content);
            parseChatJsonl(text);
            let name = baseName(filename) || `导入 ${Date.now()}`;
            if (state.chatList.some(c => c.name === name)) name = `${name} 导入${Date.now().toString(36).slice(-4)}`;
            await api.saveChat(state.char.id, name, text);
            state.chatList = await api.listChats(state.char.id);
            refresh('sidebar');
            return okResponse({ res: true, file_name: name });
        } catch (e) { return errResponse(e); }
    };
    const importRawPreset = async (filename, content) => {
        try {
            const j = JSON.parse(await textOf(content));
            if (classifyJson(j) !== 'preset') throw new Error('不是预设文件');
            await api.save('presets', baseName(filename) || '导入的预设', j);
            await refreshLists();
            rerenderIfActive('preset');
            return true;
        } catch (e) { console.warn('[importRawPreset]', e); return false; }
    };
    const importRawWorldbook = async (filename, content) => {
        try {
            const j = JSON.parse(await textOf(content));
            if (!j || typeof j !== 'object' || !j.entries) throw new Error('不是世界书文件');
            const name = baseName(filename) || '导入的世界书';
            await api.save('worlds', name, j);
            await refreshLists();
            await loadWorld(name, { force: true });
            rerenderIfActive('world');
            return okResponse({ name });
        } catch (e) { return errResponse(e); }
    };
    const importRawTavernRegex = (filename, content) => {
        try {
            const j = JSON.parse(String(content ?? ''));
            const list = (Array.isArray(j) ? j : [j]).filter(x => x && typeof x === 'object' && 'findRegex' in x).map(normalizeRegexScript);
            if (!list.length) return false;
            const ids = new Set(state.settings.regex.map(r => r.id));
            for (const r of list) { if (ids.has(r.id)) r.id = uuid(); state.settings.regex.push(r); }
            saveSettings();
            state.session = null;
            refresh(['panels', 'chat']);
            return true;
        } catch (e) { console.warn('[importRawTavernRegex]', e); return false; }
    };

    // ----- 扩展管理（第三方插件目录里的插件） -----
    const extName = (id) => String(id ?? '').replace(/^third-party\//, '');
    const extRequest = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const isInstalledExtension = (id) => {
        const n = extName(id);
        if (n === 'JS-Slash-Runner' || n === 'tavern_helper') return true;
        return extensionList.some(e => e.name === n);
    };
    const getExtensionType = (id) => {
        const n = extName(id);
        if (n === 'JS-Slash-Runner') return 'local';
        return extensionList.some(e => e.name === n) ? 'local' : null;
    };
    const getExtensionInstallationInfo = async (id) => {
        const r = await extRequest('/api/extensions/version', { extensionName: extName(id) });
        if (!r.ok) return null;
        const j = await r.json();
        return { current_branch_name: j.currentBranchName ?? '', current_commit_hash: j.currentCommitHash ?? '', is_up_to_date: !!j.isUpToDate, remote_url: j.remoteUrl ?? '' };
    };
    const afterExt = async (r) => { try { await fetchExtensionList(); } catch { /* 列表刷新失败不影响结果 */ } rerenderIfActive('general'); return r; };
    const installExtension = async (url, type = 'local') => afterExt(await extRequest('/api/extensions/install', { url: String(url), global: type === 'global' }));
    const uninstallExtension = async (id) => afterExt(await extRequest('/api/extensions/delete', { extensionName: extName(id) }));
    const updateExtension = async (id) => afterExt(await extRequest('/api/extensions/update', { extensionName: extName(id) }));
    const reinstallExtension = async (id) => {
        const info = await getExtensionInstallationInfo(id);
        if (!info?.remote_url) return new Response(JSON.stringify({ error: '找不到这个插件的来源地址' }), { status: 404 });
        const del = await uninstallExtension(id);
        if (!del.ok) return del;
        return installExtension(info.remote_url, 'local');
    };


    return {
        getModelList, getProxyPresetNames,
        ...audioApi,
        getLorebookSettings, setLorebookSettings, getLorebooks, deleteLorebook, createLorebook, getCharLorebooks, getCurrentCharPrimaryLorebook,
        setCurrentCharLorebooks, getChatLorebook, setChatLorebook, getOrCreateChatLorebook,
        getLorebookEntries, replaceLorebookEntries, updateLorebookEntriesWith, setLorebookEntries, createLorebookEntries, deleteLorebookEntries,
        getPersonaNames, getPersonaIds, getCurrentPersonaName, getCurrentPersonaId, getPersonaAvatarPath, getPersona, createPersona,
        createOrReplacePersona, deletePersona, replacePersona, updatePersonaWith,
        createCharacter, createOrReplaceCharacter, deleteCharacter,
        importRawCharacter, importRawChat, importRawPreset, importRawWorldbook, importRawTavernRegex,
        isInstalledExtension, getExtensionType, getExtensionInstallationInfo, installExtension, uninstallExtension, reinstallExtension, updateExtension,
    };
}
