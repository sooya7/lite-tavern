// 对话补全提示词组装：复刻酒馆 openai.js 的 Prompt Manager 语义
// （prompt_order、标记位、相对/绝对注入、深度注入排序、预算裁剪、示例对话、续写/扮演/静默、合并系统消息）。
import { getPromptOrder, INJECTION_POSITION, NAMES_BEHAVIOR } from './preset.js';
import { formatWorldInfoValue, ROLE_NAMES } from './worldinfo.js';
import { estimateMessageTokens } from './tokens.js';

export const EXT_PROMPT_TYPE = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const PERSONA_POSITION = { IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4, NONE: 9 };

const roleToNum = (r) => typeof r === 'number' ? r : Math.max(0, ROLE_NAMES.indexOf(String(r ?? 'system')));
const roleToName = (r) => typeof r === 'number' ? (ROLE_NAMES[r] ?? 'system') : (ROLE_NAMES.includes(r) ? r : 'system');

/** 把 mes_example 拆成 <START> 块 */
export function parseMesExamples(str) {
    if (!str || str === '<START>') return [];
    if (!str.startsWith('<START>')) str = '<START>\n' + str.trim();
    return str.split(/<START>/gi).slice(1).map(b => `<START>\n${b.trim()}\n`).filter(b => b.replace(/<START>/i, '').trim());
}

/** 单个示例块 → system 消息（name=example_user/example_assistant），与酒馆 parseExampleIntoIndividual 一致 */
export function parseExampleIntoIndividual(block, userName, charName) {
    const result = [];
    const lines = block.split('\n');
    let cur = [];
    let inUser = false, inBot = false;
    const add = (name, sysName) => {
        const text = cur.join('\n').replace(name + ':', '').trim();
        result.push({ role: 'system', content: text, name: sysName });
        cur = [];
    };
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(userName + ':')) {
            inUser = true;
            if (inBot) add(charName, 'example_assistant');
            inBot = false;
        } else if (line.startsWith(charName + ':')) {
            inBot = true;
            if (inUser) add(userName, 'example_user');
            inUser = false;
        }
        cur.push(line);
    }
    if (inUser) add(userName, 'example_user');
    else if (inBot) add(charName, 'example_assistant');
    return result;
}

/**
 * 组装对话补全消息。
 * @param {object} ctx
 * @param {object} ctx.preset 规范化后的预设
 * @param {string} [ctx.type] normal|continue|impersonate|swipe|regenerate|quiet
 * @param {{user: string, char: string}} ctx.names
 * @param {object} ctx.fields 已做过宏替换的卡字段 {description, personality, scenario, persona, mesExamples, system, jailbreak, depthPrompt:{prompt,depth,role}}
 * @param {{position: number, depth: number, role: number}} [ctx.personaSettings]
 * @param {object[]} ctx.history 时间正序，已过滤隐藏、已做提示词正则：{role, content, name, isUser, narrator, forceAvatar}
 * @param {object} [ctx.worldInfo] checkWorldInfo 结果
 * @param {{text: string, position: number, depth: number, role: number}|null} [ctx.authorsNote] 本轮应插入的作者注释
 * @param {object} [ctx.extensionPrompts] key → {value, position, depth, role}
 * @param {string} [ctx.quietPrompt]
 * @param {string} [ctx.continueText] 续写时被续写消息的原文
 * @param {(text: string, extra?: object) => string} ctx.substitute 宏替换
 * @param {(msg: object) => number} [ctx.countTokens]
 * @param {object} [ctx.options] {preferCharacterPrompt, preferCharacterJailbreak, pinExamples, maxContext, maxTokens}
 */
export function buildChatCompletion(ctx) {
    const preset = ctx.preset;
    const type = ctx.type ?? 'normal';
    const sub = (t, extra) => (t ? ctx.substitute(t, extra) : '');
    const count = ctx.countTokens ?? estimateMessageTokens;
    const opt = { preferCharacterPrompt: true, preferCharacterJailbreak: true, pinExamples: false, ...(ctx.options ?? {}) };
    const fields = ctx.fields ?? {};
    const names = ctx.names ?? { user: 'User', char: 'Assistant' };
    const wi = ctx.worldInfo ?? {};
    const personaSet = ctx.personaSettings ?? { position: PERSONA_POSITION.IN_PROMPT, depth: 2, role: 0 };

    // ---------- 扩展提示词表（作者注释 / 角色深度提示 / 用户设定@深度 / 世界书@深度 / 插件） ----------
    const ext = {};
    for (const [k, v] of Object.entries(ctx.extensionPrompts ?? {})) if (v?.value) ext[k] = { ...v };

    if (ctx.authorsNote) {
        let an = ctx.authorsNote.text ?? '';
        an = `${(wi.anTop ?? []).join('\n')}\n${an}\n${(wi.anBottom ?? []).join('\n')}`.replace(/(^\n)|(\n$)/g, '');
        if (fields.persona && personaSet.position === PERSONA_POSITION.TOP_AN) an = `${fields.persona}\n${an}`;
        if (fields.persona && personaSet.position === PERSONA_POSITION.BOTTOM_AN) an = `${an}\n${fields.persona}`;
        if (an.trim()) {
            ext['2_floating_prompt'] = {
                value: an,
                position: Number(ctx.authorsNote.position ?? EXT_PROMPT_TYPE.IN_CHAT),
                depth: Number(ctx.authorsNote.depth ?? 4),
                role: roleToNum(ctx.authorsNote.role ?? 0),
            };
        }
    }
    const dp = fields.depthPrompt;
    if (dp?.prompt) ext.DEPTH_PROMPT = { value: dp.prompt, position: EXT_PROMPT_TYPE.IN_CHAT, depth: Number(dp.depth ?? 4), role: roleToNum(dp.role ?? 'system') };
    if (fields.persona && personaSet.position === PERSONA_POSITION.AT_DEPTH) {
        ext.PERSONA_DESCRIPTION = { value: fields.persona, position: EXT_PROMPT_TYPE.IN_CHAT, depth: Number(personaSet.depth ?? 2), role: roleToNum(personaSet.role ?? 0) };
    }
    for (const d of wi.depthEntries ?? []) {
        ext[`customDepthWI_${d.depth}_${d.role}`] = { value: d.entries.join('\n'), position: EXT_PROMPT_TYPE.IN_CHAT, depth: Number(d.depth), role: roleToNum(d.role) };
    }

    // ---------- 示例对话 ----------
    let exampleBlocks = parseMesExamples(fields.mesExamples ?? '');
    for (const em of wi.emEntries ?? []) {
        const cleaned = parseMesExamples(sub(em.content));
        if (em.position === 'before') exampleBlocks.unshift(...cleaned);
        else exampleBlocks.push(...cleaned);
    }
    const messageExamples = exampleBlocks.map(b => parseExampleIntoIndividual(b, names.user, names.char)).filter(x => x.length);

    // ---------- 提示词集合（按 prompt_order，宏按顺序求值） ----------
    const order = getPromptOrder(preset);
    const collection = [];
    for (const entry of order) {
        const def = preset.prompts.find(p => p.identifier === entry.identifier);
        if (!def) continue;
        if (!entry.enabled) {
            if (entry.identifier === 'main') collection.push({ ...def, content: '', disabled: true });
            continue;
        }
        if (Array.isArray(def.injection_trigger) && def.injection_trigger.length && !def.injection_trigger.includes(type)) continue;
        collection.push({ ...def, content: def.marker ? '' : sub(def.content ?? '') });
    }
    const idx = (id) => collection.findIndex(p => p.identifier === id);
    const get = (id) => collection[idx(id)];

    // 标记位与系统内容
    const systemPrompts = [
        { identifier: 'worldInfoBefore', role: 'system', content: formatWorldInfoValue(preset.wi_format, wi.worldInfoBefore ?? '') },
        { identifier: 'worldInfoAfter', role: 'system', content: formatWorldInfoValue(preset.wi_format, wi.worldInfoAfter ?? '') },
        { identifier: 'charDescription', role: 'system', content: fields.description ?? '' },
        { identifier: 'charPersonality', role: 'system', content: fields.personality && preset.personality_format ? sub(preset.personality_format) : (fields.personality ?? '') },
        { identifier: 'scenario', role: 'system', content: fields.scenario && preset.scenario_format ? sub(preset.scenario_format) : (fields.scenario ?? '') },
    ];
    if (fields.persona && [PERSONA_POSITION.IN_PROMPT, PERSONA_POSITION.AFTER_CHAR].includes(personaSet.position)) {
        systemPrompts.push({ identifier: 'personaDescription', role: 'system', content: fields.persona });
    }
    for (const sp of systemPrompts) {
        const i = idx(sp.identifier);
        if (i < 0) {
            // 旧预设顺序里缺这个标记位：只有预设根本没有这条提示词定义时才补（被用户删掉/关闭的不补）
            const known = preset.prompts.some(p => p.identifier === sp.identifier) && order.some(o => o.identifier === sp.identifier);
            if (!known && sp.content) {
                const anchor = idx(sp.identifier === 'worldInfoBefore' ? 'main' : 'charDescription') >= 0
                    ? idx(sp.identifier === 'worldInfoBefore' ? 'main' : 'charDescription')
                    : idx('main');
                collection.splice(anchor + 1, 0, { identifier: sp.identifier, role: 'system', content: sp.content, marker: true, system_prompt: true });
            }
            continue;
        }
        const cp = collection[i];
        collection[i] = { ...cp, content: sp.content, role: cp.role ?? sp.role };
    }

    // 角色卡覆盖主提示词 / 历史后指令（{{original}} = 预设原内容）
    const main = get('main');
    if (opt.preferCharacterPrompt && fields.system && main && !main.forbid_overrides && !main.disabled) {
        main.content = sub(fields.system, { original: main.content });
    }
    const jb = get('jailbreak');
    if (opt.preferCharacterJailbreak && fields.jailbreak && jb && !jb.forbid_overrides) {
        jb.content = sub(fields.jailbreak, { original: jb.content });
    }

    // 主提示词相对插入（作者注释在提示词内、插件 IN_PROMPT/BEFORE_PROMPT）
    const mainBefore = [], mainAfter = [];
    for (const key of Object.keys(ext).sort()) {
        const e = ext[key];
        if (e.position === EXT_PROMPT_TYPE.IN_PROMPT) mainAfter.push({ role: roleToName(e.role), content: sub(e.value), source: key });
        else if (e.position === EXT_PROMPT_TYPE.BEFORE_PROMPT) mainBefore.push({ role: roleToName(e.role), content: sub(e.value), source: key });
    }

    // ---------- 预算 ----------
    const maxContext = Number(opt.maxContext ?? preset.openai_max_context ?? 32000);
    const maxTokens = Number(opt.maxTokens ?? preset.openai_max_tokens ?? 1000);
    const budget = maxContext > maxTokens ? maxContext - maxTokens : maxContext;
    let used = 3;

    // 控制提示词（总在最后）
    const control = [];
    if (type === 'impersonate' && preset.impersonation_prompt) control.push({ role: 'system', content: sub(preset.impersonation_prompt), source: 'impersonate' });
    if (ctx.quietPrompt) control.push({ role: 'system', content: sub(ctx.quietPrompt), source: 'quietPrompt' });
    used += control.reduce((a, m) => a + count(m), 0);

    // 固定段落（相对位置）
    const slots = collection.map(() => []);
    const absolute = [];
    collection.forEach((p, i) => {
        if (p.identifier === 'chatHistory' || p.identifier === 'dialogueExamples') return;
        if (Number(p.injection_position) === INJECTION_POSITION.ABSOLUTE) {
            absolute.push(p);
            return;
        }
        const msgs = [];
        if (p.identifier === 'main') msgs.push(...mainBefore);
        if (p.content) msgs.push({ role: roleToName(p.role), content: p.content, source: p.identifier });
        if (p.identifier === 'main') msgs.push(...mainAfter);
        slots[i] = msgs.filter(m => m.content);
        used += slots[i].reduce((a, m) => a + count(m), 0);
    });
    // 没有 main 时，主提示词相对插入放最前
    if (idx('main') < 0 && (mainBefore.length || mainAfter.length)) {
        slots.unshift([...mainBefore, ...mainAfter].filter(m => m.content));
        collection.unshift({ identifier: '__main_ext' });
    }

    // ---------- 聊天记录 ----------
    const historyIdx = idx('chatHistory');
    const exampleIdx = idx('dialogueExamples');
    const debug = { budget, droppedHistory: 0, includedHistory: 0, examples: 0 };

    const newestFirst = [];
    for (const h of ctx.history ?? []) {
        let content = String(h.content ?? '').replace(/\r/g, '');
        let name;
        const nb = Number(preset.names_behavior ?? 0);
        if (nb === NAMES_BEHAVIOR.CONTENT && !h.narrator) content = `${h.name}: ${content}`;
        else if (nb === NAMES_BEHAVIOR.DEFAULT && h.forceAvatar && h.name !== names.user && !h.narrator) content = `${h.name}: ${content}`;
        else if (nb === NAMES_BEHAVIOR.COMPLETION && h.name) name = h.name;
        const role = h.narrator ? 'system' : (h.isUser ? 'user' : 'assistant');
        if (role === 'user' && preset.wrap_in_quotes) content = `"${content}"`;
        newestFirst.unshift({ role, content, name, source: 'chatHistory' });
    }

    // 深度注入（populationInjectionPrompts）
    const depths = new Set([
        ...absolute.map(p => Number(p.injection_depth ?? 4)),
        ...Object.values(ext).filter(e => e.position === EXT_PROMPT_TYPE.IN_CHAT).map(e => Number(e.depth)),
    ]);
    let inserted = 0;
    for (const d of [...depths].sort((a, b) => a - b)) {
        const depthPrompts = absolute.filter(p => Number(p.injection_depth ?? 4) === d && p.content);
        const groups = { 100: [] };
        for (const p of depthPrompts) (groups[Number(p.injection_order ?? 100)] ??= []).push(p);
        const roleMessages = [];
        for (const ord of Object.keys(groups).map(Number).sort((a, b) => a - b)) {
            for (const role of ['system', 'user', 'assistant']) {
                const rolePrompts = groups[ord].filter(p => roleToName(p.role) === role).map(p => p.content).join('\n');
                let extText = '';
                if (ord === 100) {
                    extText = Object.keys(ext).sort().map(k => ext[k])
                        .filter(e => e.position === EXT_PROMPT_TYPE.IN_CHAT && e.value && Number(e.depth) === d && roleToName(e.role) === role)
                        .map(e => e.value.trim()).join('\n');
                    if (extText) extText = sub(extText);
                }
                const joint = [rolePrompts, extText].filter(Boolean).map(x => x.trim()).join('\n');
                if (joint) roleMessages.push({ role, content: joint, injected: true, source: `depth${d}` });
            }
        }
        if (roleMessages.length) {
            newestFirst.splice(d + inserted, 0, ...roleMessages);
            inserted += roleMessages.length;
        }
    }

    const historyMsgs = [];
    const tail = [];
    if (historyIdx >= 0) {
        const newChat = preset.new_chat_prompt ? { role: 'system', content: sub(preset.new_chat_prompt), source: 'newMainChat' } : null;
        if (newChat) used += count(newChat);
        let continueNudge = null;
        if (type === 'continue' && ctx.continueText && !preset.continue_prefill && preset.continue_nudge_prompt) {
            continueNudge = { role: 'system', content: sub(preset.continue_nudge_prompt, { lastChatMessage: String(ctx.continueText).trim() }), source: 'continueNudge' };
            used += count(continueNudge);
        }
        const last = newestFirst.find(m => !m.injected);
        if (type === 'normal' && last?.role === 'assistant' && preset.send_if_empty) {
            const m = { role: 'user', content: sub(preset.send_if_empty), source: 'emptyUserMessageReplacement' };
            if (used + count(m) <= budget) { historyMsgs.push(m); used += count(m); }
        }
        const firstNonInjected = newestFirst.find(m => !m.injected);
        for (const m of newestFirst) {
            const msg = { ...m, content: sub(m.content) };
            if (!msg.content && !msg.injected) continue;
            const t = count(msg);
            if (used + t > budget) {
                debug.droppedHistory = newestFirst.length - newestFirst.indexOf(m);
                break;
            }
            used += t;
            if (type === 'continue' && preset.continue_prefill && m === firstNonInjected) {
                const pre = preset.assistant_prefill ? sub(preset.assistant_prefill) + '\n\n' : '';
                tail.push({ role: msg.role, content: pre + msg.content, source: 'continuePrefill' });
                continue;
            }
            historyMsgs.unshift(msg);
            if (!m.injected) debug.includedHistory++;
        }
        if (newChat) historyMsgs.unshift(newChat);
        if (continueNudge) historyMsgs.push(continueNudge);
        slots[historyIdx] = historyMsgs;
    }

    // ---------- 示例对话（预算允许才加） ----------
    if (exampleIdx >= 0 && messageExamples.length) {
        const exMsgs = [];
        const header = preset.new_example_chat_prompt ? { role: 'system', content: sub(preset.new_example_chat_prompt), source: 'newChat' } : null;
        for (const dialogue of messageExamples) {
            const msgs = dialogue.map(m => ({ ...m, source: 'dialogueExamples' }));
            const cost = (header ? count(header) : 0) + msgs.reduce((a, m) => a + count(m), 0);
            if (used + cost > budget) break;
            used += cost;
            if (header) exMsgs.push({ ...header });
            exMsgs.push(...msgs);
            debug.examples++;
        }
        slots[exampleIdx] = exMsgs;
    }

    let messages = slots.flat().filter(m => m && (m.content || m.injected));
    messages.push(...tail, ...control);

    // 示例消息的 name：转成内容前缀，避免部分接口不认 name 字段
    messages = messages.map(m => {
        if (m.name === 'example_user') return { role: 'system', content: `${names.user}: ${m.content}`, source: m.source, example: 'user' };
        if (m.name === 'example_assistant') return { role: 'system', content: `${names.char}: ${m.content}`, source: m.source, example: 'assistant' };
        return m;
    });

    if (preset.squash_system_messages) messages = squashSystemMessages(messages);

    let prefill = '';
    if (type === 'impersonate') prefill = sub(preset.assistant_impersonation ?? '');
    else if (type !== 'continue' || !preset.continue_prefill) prefill = sub(preset.assistant_prefill ?? '');

    debug.tokens = used;
    return { messages: messages.map(({ injected, ...m }) => m), prefill, debug };
}

export function squashSystemMessages(messages) {
    const exclude = new Set(['newMainChat', 'newChat', 'groupNudge']);
    const out = [];
    let last = null;
    const should = (m) => m.role === 'system' && !m.name && !m.example && !exclude.has(m.source);
    for (const m of messages) {
        if (m.role === 'system' && !m.content) continue;
        if (should(m) && last && should(last)) {
            last.content += '\n' + m.content;
            continue;
        }
        const c = { ...m };
        out.push(c);
        last = c;
    }
    return out;
}
