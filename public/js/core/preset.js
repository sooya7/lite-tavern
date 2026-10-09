// 对话补全（Chat Completion）预设：默认值、规范化、提示词顺序工具。格式与酒馆 "OpenAI Settings/*.json" 一致。
import { clone, uuid } from './util.js';
import { normalizeRegexScript } from './regex.js';

export const PROMPT_ORDER_GLOBAL = 100001;
export const PROMPT_ORDER_DEFAULT = 100000;

export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 };

export const NAMES_BEHAVIOR = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 };

export const MARKERS = ['chatHistory', 'dialogueExamples', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription'];

export const BUILTIN_PROMPT_NAMES = {
    main: '主提示词',
    nsfw: '辅助提示词',
    jailbreak: '历史后指令',
    enhanceDefinitions: '增强定义',
    chatHistory: '聊天记录',
    dialogueExamples: '示例对话',
    worldInfoBefore: '世界书（角色前）',
    worldInfoAfter: '世界书（角色后）',
    charDescription: '角色描述',
    charPersonality: '角色性格',
    scenario: '场景',
    personaDescription: '用户设定',
};

export const DEFAULT_PROMPTS = [
    { name: 'Main Prompt', system_prompt: true, role: 'system', content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.", identifier: 'main' },
    { name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    { name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '', identifier: 'jailbreak' },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'enhanceDefinitions', role: 'system', name: 'Enhance Definitions', content: "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.", system_prompt: true, marker: false },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

export const DEFAULT_ORDER = [
    ['main', true], ['worldInfoBefore', true], ['personaDescription', true], ['charDescription', true], ['charPersonality', true],
    ['scenario', true], ['enhanceDefinitions', false], ['nsfw', true], ['worldInfoAfter', true], ['dialogueExamples', true],
    ['chatHistory', true], ['jailbreak', true],
].map(([identifier, enabled]) => ({ identifier, enabled }));

export const DEFAULT_PRESET = {
    temperature: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 1,
    top_k: 0,
    top_a: 0,
    min_p: 0,
    repetition_penalty: 1,
    openai_max_context: 32000,
    openai_max_tokens: 1000,
    max_context_unlocked: true,
    wrap_in_quotes: false,
    names_behavior: NAMES_BEHAVIOR.DEFAULT,
    send_if_empty: '',
    impersonation_prompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    new_chat_prompt: '[Start a new Chat]',
    new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
    new_example_chat_prompt: '[Example Chat]',
    continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    group_nudge_prompt: '[Write the next reply only as {{char}}.]',
    stream_openai: true,
    assistant_prefill: '',
    assistant_impersonation: '',
    squash_system_messages: false,
    continue_prefill: false,
    continue_postfix: ' ',
    seed: -1,
    n: 1,
    show_thoughts: true,
    reasoning_effort: 'auto',
    custom_prompt_post_processing: '',
    prompts: DEFAULT_PROMPTS,
    prompt_order: [{ character_id: PROMPT_ORDER_GLOBAL, order: DEFAULT_ORDER }],
    extensions: {},
};

/** 规范化导入的预设：补默认值、补齐内置提示词、保证 100001 的顺序存在 */
export function normalizePreset(raw) {
    const p = { ...clone(DEFAULT_PRESET), ...clone(raw ?? {}) };
    if (!Array.isArray(p.prompts)) p.prompts = clone(DEFAULT_PROMPTS);
    for (const def of DEFAULT_PROMPTS) {
        if (!p.prompts.some(x => x.identifier === def.identifier)) p.prompts.push(clone(def));
    }
    for (const pr of p.prompts) {
        if (!pr.identifier) pr.identifier = uuid();
        if (pr.marker === undefined) pr.marker = MARKERS.includes(pr.identifier);
    }
    if (!Array.isArray(p.prompt_order)) p.prompt_order = [];
    if (!getPromptOrder(p, false)) {
        const fallback = p.prompt_order.find(o => o.character_id === PROMPT_ORDER_DEFAULT) ?? p.prompt_order[0];
        p.prompt_order.push({ character_id: PROMPT_ORDER_GLOBAL, order: clone(fallback?.order ?? DEFAULT_ORDER) });
    }
    if (!p.extensions || typeof p.extensions !== 'object') p.extensions = {};
    if (Array.isArray(p.extensions.regex_scripts)) p.extensions.regex_scripts = p.extensions.regex_scripts.map(normalizeRegexScript);
    return p;
}

/** 当前生效的顺序（全局策略 100001，退化到 100000 或第一个） */
export function getPromptOrder(preset, fallback = true) {
    const list = preset?.prompt_order ?? [];
    const g = list.find(o => Number(o.character_id) === PROMPT_ORDER_GLOBAL);
    if (g || !fallback) return g?.order ?? null;
    return (list.find(o => Number(o.character_id) === PROMPT_ORDER_DEFAULT) ?? list[0])?.order ?? DEFAULT_ORDER;
}

export function getPromptById(preset, id) {
    return preset?.prompts?.find(p => p.identifier === id) ?? null;
}

export function newCustomPrompt(partial = {}) {
    return {
        identifier: uuid(),
        name: '新提示词',
        role: 'system',
        content: '',
        system_prompt: false,
        marker: false,
        injection_position: INJECTION_POSITION.RELATIVE,
        injection_depth: 4,
        injection_order: 100,
        forbid_overrides: false,
        ...partial,
    };
}

/** 采样参数（发送请求时用） */
export function samplerParams(preset) {
    return {
        temperature: Number(preset.temperature ?? 1),
        top_p: Number(preset.top_p ?? 1),
        top_k: Number(preset.top_k ?? 0),
        frequency_penalty: Number(preset.frequency_penalty ?? 0),
        presence_penalty: Number(preset.presence_penalty ?? 0),
        repetition_penalty: Number(preset.repetition_penalty ?? 1),
        min_p: Number(preset.min_p ?? 0),
        top_a: Number(preset.top_a ?? 0),
        max_tokens: Number(preset.openai_max_tokens ?? 1000),
        seed: Number(preset.seed ?? -1),
        stream: preset.stream_openai !== false,
        reasoning_effort: preset.reasoning_effort ?? 'auto',
        show_thoughts: preset.show_thoughts !== false,
    };
}

/** 预设里可能夹带的酒馆助手脚本（用于检测 MVU 等） */
export function presetTavernHelperScripts(preset) {
    const th = preset?.extensions?.tavern_helper;
    if (!th) return [];
    if (Array.isArray(th.scripts)) return th.scripts;
    if (Array.isArray(th)) return th;
    return [];
}
