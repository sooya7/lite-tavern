// 一次聊天的完整上下文：宏环境、变量、正则、世界书、EJS、MVU、提示词组装。
// 不依赖 DOM，Node 里可直接用真实的预设/卡/世界书跑测试。
import { macroEngine } from './macros.js';
import { VariableManager } from './vars.js';
import { getRegexedString, REGEX_PLACEMENT, collectRegexScripts } from './regex.js';
import { getSortedEntries, checkWorldInfo, characterBookToWorld, normalizeWorld, DEFAULT_WI_SETTINGS, parseDecorators } from './worldinfo.js';
import { buildChatCompletion, PERSONA_POSITION, EXT_PROMPT_TYPE } from './prompt.js';
import { createTemplateRuntime, preprocessWorldEntries, classifySpecialEntries } from './template.js';
import { messageText, isNarrator } from './chat.js';
import { estimateMessageTokens, estimateTokens } from './tokens.js';
import { collectInitVars, dumpYaml, detectMvu, processMessage, processMessageWithEvents, latestMvuVars, extractUpdateBlocks, withStatusPlaceholder, STATUS_PLACEHOLDER, MVU_EVENTS } from './mvu.js';
import { cardDepthPrompt, cardRegexScripts, cardTavernHelperScripts, cardLinkedWorld, cardGreetings } from './card.js';
import { presetTavernHelperScripts } from './preset.js';
import { syncSwipe } from './chat.js';
import { getPath, clone } from './util.js';
import { hasEjs } from './ejs.js';

export const DEFAULT_POWER = {
    preferCharacterPrompt: true,
    preferCharacterJailbreak: true,
    pinExamples: false,
    ejs: true,
    ejsRender: true,
    mvu: 'auto', // auto | on | off
    thinkAutoParse: true,
    regexAllowCharacter: true,
    regexAllowPreset: true,
};

export class ChatSession {
    /**
     * @param {object} o
     * @param {object|null} o.card 规范化后的卡（V2 结构）
     * @param {string} [o.cardFile] 卡文件名（不含扩展名），用于 characterFilter 与聊天目录
     * @param {{name: string, description: string, position?: number, depth?: number, role?: number, lorebook?: string}} o.persona
     * @param {object} o.preset 规范化预设
     * @param {object[]} o.chat 消息数组（会被原地修改）
     * @param {object} o.meta chat_metadata（会被原地修改）
     * @param {string} [o.chatId]
     * @param {object} o.settings 应用设置 {power, worldInfo, regex, variables:{global}}
     * @param {Record<string, object>} o.worlds 已加载的世界书 name → json
     * @param {string} [o.model]
     */
    constructor(o) {
        Object.assign(this, o);
        this.settings = o.settings ?? {};
        this.power = { ...DEFAULT_POWER, ...(this.settings.power ?? {}) };
        this.worlds = o.worlds ?? {};
        this.vars = new VariableManager({ chat: this.chat, meta: this.meta, global: this.settings.variables?.global ?? (this.settings.variables = { global: {} }).global });
        this.templateState = { defines: {}, injects: {}, forced: new Set() };
        this.extensionPrompts = {};
        this.lastPrompt = null;
    }

    get names() {
        return { user: this.persona?.name || 'User', char: this.card?.data?.name || 'Assistant' };
    }

    // ---------- 正则 ----------
    regexScripts() {
        return collectRegexScripts({
            global: this.settings.regex ?? [],
            character: cardRegexScripts(this.card),
            preset: this.preset?.extensions?.regex_scripts ?? [],
            allowCharacter: this.power.regexAllowCharacter,
            allowPreset: this.power.regexAllowPreset,
        });
    }

    // ---------- 宏 ----------
    rawFields() {
        const d = this.card?.data ?? {};
        const dp = cardDepthPrompt(this.card);
        return {
            description: d.description ?? '',
            personality: d.personality ?? '',
            scenario: this.meta?.scenario || d.scenario || '',
            persona: this.persona?.description ?? '',
            mesExamples: d.mes_example ?? '',
            system: d.system_prompt ?? '',
            jailbreak: d.post_history_instructions ?? '',
            depthPrompt: dp ? { ...dp } : null,
            creatorNotes: d.creator_notes ?? '',
            firstMessage: d.first_mes ?? '',
            version: d.character_version ?? '',
        };
    }

    macroEnv(fields, extra = {}) {
        const names = this.names;
        const self = this;
        return {
            user: names.user,
            char: names.char,
            group: names.char,
            description: fields.description,
            personality: fields.personality,
            scenario: fields.scenario,
            persona: fields.persona,
            mesExamples: fields.mesExamples,
            mesExamplesRaw: fields.mesExamplesRaw ?? fields.mesExamples,
            charPrompt: fields.system,
            charInstruction: fields.jailbreak,
            charDepthPrompt: fields.depthPrompt?.prompt ?? '',
            creatorNotes: fields.creatorNotes,
            firstMessage: fields.firstMessage,
            charVersion: fields.version,
            model: this.model ?? '',
            isMobile: 'false',
            chat: this.chat,
            chatId: this.chatId ?? '',
            maxPrompt: this.preset?.openai_max_context,
            maxContext: this.preset?.openai_max_context,
            maxResponse: this.preset?.openai_max_tokens,
            lastGenerationType: this.lastGenerationType ?? 'normal',
            outlets: this.outlets ?? {},
            input: this.input ?? '',
            vars: { local: this.vars.macroScope('local'), global: this.vars.macroScope('global') },
            extra: {
                // 酒馆助手 / MVU 的宏
                get_message_variable: (args) => getPath(self.vars.cache(), args[0]),
                get_chat_variable: (args) => getPath(self.vars.local(), args[0]),
                get_global_variable: (args) => getPath(self.vars.global(), args[0]),
                format_message_variable: (args) => fmt(getPath(self.vars.cache(), args[0])),
                format_chat_variable: (args) => fmt(getPath(self.vars.local(), args[0])),
                format_global_variable: (args) => fmt(getPath(self.vars.global(), args[0])),
                ...(this.extraMacros ?? {}),
                ...extra,
            },
            original: extra.original,
        };
    }

    /** 替换后的卡字段（先用原始字段做环境，再替换一次） */
    fields() {
        const raw = this.rawFields();
        const rawEnv = this.macroEnv(raw, { original: () => '{{original}}' });
        const s = (t) => macroEngine.evaluate(t, rawEnv);
        const out = {
            ...raw,
            description: s(raw.description),
            personality: s(raw.personality),
            scenario: s(raw.scenario),
            persona: s(raw.persona),
            mesExamplesRaw: raw.mesExamples,
            mesExamples: s(raw.mesExamples),
            system: s(raw.system),
            jailbreak: s(raw.jailbreak),
            creatorNotes: s(raw.creatorNotes),
        };
        if (raw.depthPrompt?.prompt) out.depthPrompt = { ...raw.depthPrompt, prompt: s(raw.depthPrompt.prompt) };
        return out;
    }

    substitute(text, extra = {}, fields) {
        if (!text || typeof text !== 'string' || (!text.includes('{{') && !/<(USER|BOT|CHAR|GROUP|CHARIFNOTGROUP)>/i.test(text))) return text ?? '';
        const env = this.macroEnv(fields ?? this._fieldsCache ?? this.fields(), extra);
        if (extra.original !== undefined) env.original = extra.original;
        return macroEngine.evaluate(text, env, extra.postProcess ? { postProcess: extra.postProcess } : undefined);
    }

    // ---------- 世界书 ----------
    worldBooks() {
        const wi = this.settings.worldInfo ?? {};
        const book = (name) => (this.worlds[name] ? { world: name, entries: this.worlds[name].entries } : null);
        const global = (wi.globalSelect ?? []).map(book).filter(Boolean);
        const character = [];
        const linked = cardLinkedWorld(this.card);
        if (linked && this.worlds[linked]) character.push(book(linked));
        else if (this.card?.data?.character_book?.entries?.length) {
            const w = characterBookToWorld(this.card.data.character_book);
            character.push({ world: linked || this.card.data.character_book.name || `${this.names.char} 内嵌世界书`, entries: w.entries });
        }
        for (const extraName of wi.charLore?.[this.cardFile] ?? []) {
            const b = book(extraName);
            if (b) character.push(b);
        }
        const chat = this.meta?.world_info ? [book(this.meta.world_info)].filter(Boolean) : [];
        const persona = this.persona?.lorebook ? [book(this.persona.lorebook)].filter(Boolean) : [];
        return { global, character, chat, persona };
    }

    allWorldEntries() {
        const b = this.worldBooks();
        const out = [];
        for (const list of [b.chat, b.persona, b.global, b.character]) {
            for (const w of list) for (const e of Object.values(w.entries ?? {})) out.push({ ...e, world: w.world });
        }
        return out;
    }

    // ---------- MVU ----------
    mvuEnabled() {
        if (this.power.mvu === 'on') return true;
        if (this.power.mvu === 'off') return false;
        return detectMvu({
            scripts: [...cardTavernHelperScripts(this.card), ...presetTavernHelperScripts(this.preset)],
            entries: this.allWorldEntries(),
        });
    }

    /**
     * 这张卡靠不靠 MVU 的状态栏占位符显示状态栏：卡 / 预设 / 全局正则里有替换它的，或开场白里本来就带着。
     * 真正的 MVU 脚本会给每条 AI 回复补上占位符；这里只在确实有人用它时才补，免得往别的卡的正文里塞东西。
     */
    usesStatusPlaceholder() {
        if (this.regexScripts().some(r => !r.disabled && String(r.findRegex ?? '').includes('StatusPlaceHolderImpl'))) return true;
        return cardGreetings(this.card).some(g => String(g).includes(STATUS_PLACEHOLDER));
    }

    /** 没有任何楼层带 stat_data 时，用 [initvar] 初始化开场白楼层（每个 swipe 各一份） */
    ensureMvuInit() {
        if (!this.mvuEnabled() || !this.chat.length) return false;
        if (latestMvuVars(this.chat)) return false;
        const init = collectInitVars(this.allWorldEntries());
        const first = this.chat[0];
        const hasSwipes = Array.isArray(first.swipes) && first.swipes.length > 0;
        const swipes = hasSwipes ? first.swipes : [first.mes];
        first.variables = Array.isArray(first.variables) ? first.variables : [];
        const placeholder = !first.is_user && Object.keys(init).length > 0 && this.usesStatusPlaceholder();
        swipes.forEach((text, i) => {
            const base = { ...(first.variables[i] ?? {}), stat_data: clone(init) };
            first.variables[i] = extractUpdateBlocks(text).length ? processMessage(base, text).variables : base;
            if (placeholder && typeof text === 'string' && !text.includes(STATUS_PLACEHOLDER)) {
                const next = withStatusPlaceholder(text);
                if (hasSwipes) first.swipes[i] = next;
                if (!hasSwipes || i === (first.swipe_id ?? 0)) first.mes = next;
            }
        });
        // 刚初始化、还没通知过监听 mag_variable_initialized 的脚本（变量结构脚本靠它补默认值）
        this.mvuInitPending = true;
        this.vars.invalidate();
        return true;
    }

    /**
     * 把开场白楼层每个 swipe 的变量交给监听者过一遍（它们会原地改 stat_data）。
     * @param {(variables: object, swipeId: number) => Promise<void>} notify
     */
    async notifyMvuInit(notify) {
        const first = this.chat[0];
        if (!first || !Array.isArray(first.variables)) return false;
        for (let i = 0; i < first.variables.length; i++) {
            const v = first.variables[i];
            if (v && typeof v === 'object' && v.stat_data) await notify(v, i);
        }
        this.vars.invalidate();
        return true;
    }

    /** AI 回复完成后：从上一层变量 + 本条更新命令得到本层变量 */
    applyMvu(index) {
        if (!this.mvuEnabled()) return null;
        const msg = this.chat[index];
        if (!msg || msg.is_user) return null;
        const prev = latestMvuVars(this.chat, index - 1);
        const prevVars = prev ? prev.vars : { stat_data: collectInitVars(this.allWorldEntries()) };
        const res = processMessage(prevVars, messageText(msg));
        this.storeMvuResult(msg, res.variables, messageText(msg));
        return res;
    }

    /**
     * 同 applyMvu，但更新过程中发 MVU 事件（有脚本在监听时用）。emit 为空就退回同步路径。
     * @param {number} index
     * @param {((name: string, ...args: any[]) => Promise<void>)|null} emit
     */
    async applyMvuAsync(index, emit) {
        if (!emit) return this.applyMvu(index);
        if (!this.mvuEnabled()) return null;
        const msg = this.chat[index];
        if (!msg || msg.is_user) return null;
        const prev = latestMvuVars(this.chat, index - 1);
        const prevVars = prev ? prev.vars : { stat_data: collectInitVars(this.allWorldEntries()) };
        const text = messageText(msg);
        const res = await processMessageWithEvents(prevVars, text, emit);
        const ctx = { variables: res.variables, message_content: text };
        await emit(MVU_EVENTS.BEFORE_MESSAGE_UPDATE, ctx);
        // 监听者改过正文就用它的；没改过就用现在的正文（等监听者的时候别处可能已经改了）
        const content = typeof ctx.message_content === 'string' && ctx.message_content !== text ? ctx.message_content : messageText(msg);
        this.storeMvuResult(msg, ctx.variables ?? res.variables, content);
        return res;
    }

    storeMvuResult(msg, variables, content) {
        if (!Array.isArray(msg.variables)) msg.variables = [];
        const sid = msg.swipe_id ?? 0;
        const merged = { ...(msg.variables[sid] ?? {}), ...variables };
        // 变量结构脚本会去掉 display_data / delta_data，这里别把旧的留下来
        for (const k of ['display_data', 'delta_data']) if (!(k in variables)) delete merged[k];
        msg.variables[sid] = merged;
        const text = this.usesStatusPlaceholder() ? withStatusPlaceholder(content) : content;
        if (text !== msg.mes) {
            msg.mes = text;
            if (Array.isArray(msg.swipes)) syncSwipe(msg);
        }
        this.vars.invalidate();
    }

    // ---------- EJS ----------
    templateRuntime() {
        const self = this;
        return createTemplateRuntime({
            vars: this.vars,
            chat: this.chat,
            names: this.names,
            chatId: this.chatId,
            characterId: this.cardFile,
            getWorldEntries: () => self.allWorldEntries(),
            getCharacter: () => self.card?.data ?? null,
            getPreset: () => self.preset,
            substitute: (t) => self.substitute(t),
            forcedEntries: this.templateState.forced,
            defines: this.templateState.defines,
            injects: this.templateState.injects,
            execute: this.executeCommand,
            globals: this.templateGlobals ?? {},
        });
    }

    // ---------- 提示词 ----------
    /**
     * @param {{type?: string, quietPrompt?: string, dryRun?: boolean, excludeLast?: boolean,
     *   maxHistory?: number, chatOverride?: object[], historyOverride?: Array<{role: string, content: string}>, appendHistory?: Array<{role: string, content: string}>,
     *   fieldOverrides?: object}} opt 后四个是给脚本的 generate() 用的：只取最近几条聊天记录、整段替换聊天记录、
     *   在聊天记录末尾加几条（这次的用户输入）、覆盖角色描述等字段
     */
    async preparePrompt({ type = 'normal', quietPrompt = '', dryRun = false, excludeLast = false, maxHistory, historyOverride, appendHistory, fieldOverrides, chatOverride } = {}) {
        this.lastGenerationType = type;
        if (!dryRun) this.ensureMvuInit();
        const wiSettings = { ...DEFAULT_WI_SETTINGS, ...(this.settings.worldInfo ?? {}) };
        const scripts = this.regexScripts();
        const isContinue = type === 'continue';
        const runtime = this.power.ejs ? this.templateRuntime() : null;
        const ejsCtx = { runType: 'generate', isDryRun: dryRun, generateType: type };

        // 变量快照：预览/试算时不落盘
        let snapshot = null;
        if (dryRun) snapshot = { meta: clone(this.meta?.variables ?? {}), global: clone(this.vars.global()), msgs: this.chat.map(m => clone(m.variables)) };

        try {
            this._fieldsCache = { ...this.fields(), ...(fieldOverrides ?? {}) };
            const fields = this._fieldsCache;
            const sub = (t, extra) => this.substitute(t, extra, fields);

            // chatOverride：插件的生成拦截器改过的聊天记录（只影响这次请求，不改真正的聊天）
            let core = (Array.isArray(chatOverride) ? chatOverride : this.chat).map((m, index) => ({ m, index })).filter(x => !x.m.is_system);
            if (excludeLast && core.length) core.pop();
            core = core.map((x, i) => ({
                ...x,
                text: getRegexedString(messageText(x.m), x.m.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, {
                    scripts, isPrompt: true, depth: core.length - i - (isContinue ? 2 : 1), substitute: sub,
                }),
            }));

            // 作者注释是否到期（按用户消息数与间隔）
            const meta = this.meta ?? {};
            const interval = Number(meta.note_interval ?? 1);
            const userCount = this.chat.filter(m => m.is_user).length;
            let anDue = false;
            if (userCount > 0 && interval > 0) {
                const till = userCount >= interval ? userCount % interval : interval - userCount;
                anDue = till === 0;
            }
            const authorsNote = anDue ? { text: sub(meta.note_prompt ?? ''), position: Number(meta.note_position ?? 1), depth: Number(meta.note_depth ?? 4), role: Number(meta.note_role ?? 0) } : null;

            // 世界书
            const books = this.worldBooks();
            let entries = getSortedEntries({ ...books, strategy: wiSettings.world_info_character_strategy });
            let special = [];
            if (runtime) {
                const pre = await preprocessWorldEntries(entries, runtime, ejsCtx);
                entries = pre.entries;
                special = pre.special;
            }
            const injects = [];
            if (authorsNote?.text && this.settings.authorsNoteScan) injects.push(authorsNote.text);
            const worldInfo = await checkWorldInfo({
                messages: core.map(x => (wiSettings.world_info_include_names ? `${x.m.name}: ${x.text}` : x.text)).reverse(),
                entries,
                settings: wiSettings,
                maxContext: Number(this.preset.openai_max_context ?? 32000),
                globalScanData: {
                    personaDescription: fields.persona,
                    characterDescription: fields.description,
                    characterPersonality: fields.personality,
                    characterDepthPrompt: fields.depthPrompt?.prompt ?? '',
                    scenario: fields.scenario,
                    creatorNotes: fields.creatorNotes,
                },
                injects,
                substitute: (t) => sub(t),
                regexContent: (content, entry, depth) => getRegexedString(content, REGEX_PLACEMENT.WORLD_INFO, { scripts, isPrompt: true, depth: depth ?? undefined, substitute: sub }),
                countTokens: estimateTokens,
                characterName: this.cardFile,
                characterTags: this.card?.data?.tags ?? [],
                generationType: type,
                chatLength: this.chat.length,
                timedStore: dryRun ? clone(meta.timedWorldInfo ?? {}) : (meta.timedWorldInfo ??= {}),
                dryRun,
                forced: this.templateState.forced,
            });
            this.outlets = worldInfo.outlets;
            if (!dryRun) this.templateState.forced.clear();

            const asHistory = (h) => ({
                role: h.role === 'user' ? 'user' : 'assistant',
                content: String(h.content ?? ''),
                name: h.role === 'user' ? this.names.user : this.names.char,
                isUser: h.role === 'user',
                narrator: h.role === 'system',
                forceAvatar: false,
            });
            let history = Array.isArray(historyOverride) ? historyOverride.map(asHistory) : core.map(x => ({
                role: x.m.is_user ? 'user' : 'assistant',
                content: x.text,
                name: x.m.name,
                isUser: !!x.m.is_user,
                narrator: isNarrator(x.m),
                forceAvatar: !!x.m.force_avatar,
            }));
            if (Number.isFinite(maxHistory)) history = maxHistory > 0 ? history.slice(-maxHistory) : [];
            if (Array.isArray(appendHistory)) history.push(...appendHistory.map(asHistory));
            const continueMsg = isContinue ? core[core.length - 1] : null;

            const built = buildChatCompletion({
                preset: this.preset,
                type,
                names: this.names,
                fields,
                personaSettings: {
                    position: Number(this.persona?.position ?? PERSONA_POSITION.IN_PROMPT),
                    depth: Number(this.persona?.depth ?? 2),
                    role: Number(this.persona?.role ?? 0),
                },
                history,
                worldInfo,
                authorsNote,
                extensionPrompts: this.extensionPrompts,
                quietPrompt,
                continueText: continueMsg?.text ?? '',
                substitute: sub,
                countTokens: estimateMessageTokens,
                options: {
                    preferCharacterPrompt: this.power.preferCharacterPrompt,
                    preferCharacterJailbreak: this.power.preferCharacterJailbreak,
                    pinExamples: this.power.pinExamples,
                },
            });

            // EJS：特殊条目注入 + 每条消息求值
            let messages = built.messages;
            if (runtime) {
                const sp = classifySpecialEntries(special);
                const evalEntries = async (list) => {
                    const out = [];
                    for (const e of list) {
                        const txt = sub(await runtime.evaluate(e.content, ejsCtx));
                        if (txt.trim()) out.push({ role: 'system', content: txt, source: `wi:${e.comment || e.uid}` });
                    }
                    return out;
                };
                const before = await evalEntries(sp.before);
                const after = await evalEntries(sp.after);
                messages = [...before, ...messages, ...after];
                const evaluated = [];
                for (const m of messages) {
                    if (!hasEjs(m.content)) { evaluated.push(m); continue; }
                    try {
                        let c = await runtime.evaluate(m.content, ejsCtx);
                        if (c.includes('{{')) c = sub(c);
                        evaluated.push({ ...m, content: c });
                    } catch (err) {
                        evaluated.push({ ...m, ejsError: String(err?.message ?? err) });
                        console.warn('[EJS] 提示词求值失败', m.source, err);
                    }
                }
                messages = evaluated.filter(m => m.content && m.content.trim());
            }

            const result = {
                messages,
                prefill: built.prefill,
                debug: { ...built.debug, activated: worldInfo.activated.map(e => ({ world: e.world, uid: e.uid, comment: e.comment, position: e.position })), wiOverflow: worldInfo.overflow },
                worldInfo,
                fields,
                history,
            };
            if (!dryRun) this.lastPrompt = result;
            return result;
        } finally {
            this._fieldsCache = null;
            if (snapshot) {
                if (this.meta) this.meta.variables = snapshot.meta;
                const g = this.vars.global();
                for (const k of Object.keys(g)) delete g[k];
                Object.assign(g, snapshot.global);
                this.chat.forEach((m, i) => { if (snapshot.msgs[i] === undefined) delete m.variables; else m.variables = snapshot.msgs[i]; });
                this.vars.invalidate();
            }
        }
    }

    // ---------- 消息处理 ----------
    /** 新收到的 AI 文本 → 永久正则（非仅显示/非仅提示词） */
    processIncoming(text, isUser = false) {
        return getRegexedString(text, isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, {
            scripts: this.regexScripts(), substitute: (t, o) => this.substitute(t, o ?? {}),
        });
    }

    processEdited(text, isUser = false) {
        return getRegexedString(text, isUser ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, {
            scripts: this.regexScripts(), isEdit: true, substitute: (t, o) => this.substitute(t, o ?? {}),
        });
    }

    /** 显示前处理：仅显示的正则（带深度）+ EJS 渲染。返回待 markdown 的文本 */
    async displayText(index, { reasoning = false } = {}) {
        const m = this.chat[index];
        if (!m) return '';
        let text = reasoning ? (m.extra?.reasoning ?? '') : messageText(m);
        if (index === 0 && !m.is_user && !reasoning) text = this.substitute(text);
        if (!m.is_system || reasoning) {
            const usable = this.chat.map((x, i) => ({ x, i })).filter(o => !o.x.is_system);
            const pos = usable.findIndex(o => o.i === index);
            const depth = pos >= 0 ? usable.length - pos - 1 : undefined;
            const placement = reasoning ? REGEX_PLACEMENT.REASONING : (m.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT);
            text = getRegexedString(text, placement, { scripts: this.regexScripts(), isMarkdown: true, depth, substitute: (t, o) => this.substitute(t, o ?? {}) });
        }
        if (this.power.ejs && this.power.ejsRender && hasEjs(text)) {
            try {
                text = await this.templateRuntime().evaluate(text, { runType: 'render', messageId: index, cacheUpto: index });
            } catch (err) {
                console.warn('[EJS] 渲染失败', index, err);
            }
        }
        return text;
    }
}

function fmt(v) {
    if (v === undefined) return '';
    if (v && typeof v === 'object') return dumpYaml(v).trimEnd();
    return String(v);
}

export { parseDecorators, normalizeWorld, EXT_PROMPT_TYPE };
