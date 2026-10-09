// 角色卡：V1/V2/V3 规范化、字段访问、导出结构。保留未知字段，导出时能原样带回去。
import { clone, isPlainObject } from './util.js';
import { normalizeRegexScript } from './regex.js';

const V2_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt',
    'post_history_instructions', 'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions'];

/**
 * 任意来源的卡 JSON → V2 结构 {spec, spec_version, data, ...其余顶层字段}
 */
export function normalizeCard(raw) {
    if (!isPlainObject(raw)) throw new Error('角色卡格式不对');
    let card;
    if (isPlainObject(raw.data) && (raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' || raw.data.name !== undefined)) {
        card = clone(raw);
    } else {
        // V1 / 其他老格式
        card = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: raw.name ?? raw.char_name ?? '未命名',
                description: raw.description ?? raw.char_persona ?? '',
                personality: raw.personality ?? '',
                scenario: raw.scenario ?? raw.world_scenario ?? '',
                first_mes: raw.first_mes ?? raw.char_greeting ?? '',
                mes_example: raw.mes_example ?? raw.example_dialogue ?? '',
                creator_notes: raw.creatorcomment ?? raw.creator_notes ?? '',
                system_prompt: '',
                post_history_instructions: '',
                alternate_greetings: [],
                tags: Array.isArray(raw.tags) ? raw.tags : [],
                creator: raw.creator ?? '',
                character_version: '',
                extensions: { talkativeness: raw.talkativeness ?? '0.5', fav: !!raw.fav },
            },
        };
    }
    const d = card.data;
    for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) {
        if (typeof d[k] !== 'string') d[k] = d[k] === undefined || d[k] === null ? '' : String(d[k]);
    }
    if (!Array.isArray(d.alternate_greetings)) d.alternate_greetings = [];
    if (!Array.isArray(d.tags)) d.tags = [];
    if (!isPlainObject(d.extensions)) d.extensions = {};
    if (Array.isArray(d.extensions.regex_scripts)) d.extensions.regex_scripts = d.extensions.regex_scripts.map(normalizeRegexScript);
    if (!d.name) d.name = '未命名';
    if (!card.spec) card.spec = 'chara_card_v2';
    if (!card.spec_version) card.spec_version = card.spec === 'chara_card_v3' ? '3.0' : '2.0';
    return card;
}

/** 导出用：顶层补齐 V1 镜像字段（酒馆也这么写，老工具能读） */
export function toExportCard(card) {
    const c = clone(card);
    const d = c.data;
    c.spec = 'chara_card_v2';
    c.spec_version = '2.0';
    Object.assign(c, {
        name: d.name,
        description: d.description,
        personality: d.personality,
        scenario: d.scenario,
        first_mes: d.first_mes,
        mes_example: d.mes_example,
        creatorcomment: d.creator_notes,
        tags: d.tags,
        talkativeness: d.extensions?.talkativeness ?? '0.5',
        fav: !!d.extensions?.fav,
    });
    if (!c.create_date) c.create_date = new Date().toISOString();
    return c;
}

export function newCard(name = '新角色') {
    return normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name } });
}

export const cardRegexScripts = (card) => card?.data?.extensions?.regex_scripts ?? [];
export const cardDepthPrompt = (card) => card?.data?.extensions?.depth_prompt ?? null;
export const cardLinkedWorld = (card) => card?.data?.extensions?.world ?? '';

export function cardTavernHelperScripts(card) {
    const th = card?.data?.extensions?.tavern_helper;
    if (!th) return [];
    if (Array.isArray(th.scripts)) return th.scripts;
    if (Array.isArray(th)) return th;
    return [];
}

/** 所有开场白（first_mes + alternate_greetings） */
export function cardGreetings(card) {
    const d = card?.data ?? {};
    return [d.first_mes ?? '', ...(d.alternate_greetings ?? [])].filter((g, i) => i === 0 || g);
}

export { V2_FIELDS };
