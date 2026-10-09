// EJS 模板环境：兼容 ST-Prompt-Template 的常用 API（getvar/setvar/print/getwi/getchar/getpreset/
// activewi/getChatMessages/matchChatMessages/injectPrompt/define/evalTemplate/parseJSON/jsonPatch…）。
import { render, hasEjs } from './ejs.js';
import { parseDecorators } from './worldinfo.js';
import { applyCommands, dumpYaml } from './mvu.js';
import { clone, regexFromString } from './util.js';

/**
 * 模板运行上下文（每次生成/渲染新建一个）
 * @param {object} host 宿主能力
 * @param {import('./vars.js').VariableManager} host.vars
 * @param {object[]} host.chat
 * @param {() => object[]} host.getWorldEntries 当前可用的所有世界书条目（带 world 字段）
 * @param {(name?: string) => object|null} host.getCharacter 角色卡 data
 * @param {() => object|null} host.getPreset
 * @param {(text: string) => string} host.substitute 酒馆宏
 * @param {object} host.names {user, char}
 * @param {Set<string>} [host.forcedEntries] activewi 的去处
 * @param {object} [host.defines] define() 的持久对象
 * @param {object} [host.injects] injectPrompt 的存储
 * @param {(cmd: string) => any} [host.execute]
 * @param {object} [host.globals] 额外注入的全局（_, SillyTavern, toastr…）
 */
export function createTemplateRuntime(host) {
    const defines = host.defines ?? {};
    const injects = host.injects ?? {};
    const forced = host.forcedEntries ?? new Set();
    let runID = 0;

    const msgText = (m) => (m?.swipes && m.swipe_id !== undefined ? (m.swipes[m.swipe_id] ?? m.mes) : m?.mes) ?? '';
    const roleOf = (m) => (m.is_user ? 'user' : m.is_system ? 'system' : 'assistant');

    function findEntry(book, title) {
        const entries = host.getWorldEntries();
        const pool = book ? entries.filter(e => e.world === book) : entries;
        return pool.find(e => String(e.uid) === String(title) || e.comment === title)
            ?? pool.find(e => typeof title === 'string' && e.comment?.includes(title));
    }

    /**
     * 渲染一段模板。
     * @param {string} content
     * @param {object} ctx {runType, messageId, swipeId, isDryRun, generateType, data, cacheUpto}
     */
    async function evaluate(content, ctx = {}) {
        if (!hasEjs(content)) return content;
        const locals = buildLocals(ctx);
        return render(content, locals);
    }

    function buildLocals(ctx = {}) {
        const vars = host.vars;
        const vctx = { messageId: ctx.messageId, dryRun: ctx.isDryRun, cacheUpto: ctx.cacheUpto };
        const chat = host.chat;
        const names = host.names ?? {};
        const lastOf = (pred) => { for (let i = chat.length - 1; i >= 0; i--) if (pred(chat[i])) return msgText(chat[i]); return ''; };

        const api = {
            // 变量
            getvar: (k, o) => vars.getvar(k, o, vctx),
            setvar: (k, v, o) => vars.setvar(k, v, o, vctx),
            incvar: (k, v = 1, o) => vars.incvar(k, v, o, vctx),
            decvar: (k, v = 1, o) => vars.decvar(k, v, o, vctx),
            delvar: (k, i, o) => vars.delvar(k, i, o, vctx),
            insvar: (k, v, i, o) => vars.insvar(k, v, i, o, vctx),
            patchVariables: (k, change, o = {}) => {
                const cur = clone(vars.getvar(k, { ...o, scope: o.scope ?? 'cache' }, vctx)) ?? {};
                const ops = Array.isArray(change) ? change : [change];
                const { data } = applyCommands({ v: cur }, ops.map(op => ({ kind: 'patch', ...op, path: `/v${op.path ?? ''}`, from: op.from ? `/v${op.from}` : undefined })));
                return vars.setvar(k, data.v, o, vctx);
            },
            setVariableSchema: () => undefined,
            // 世界书
            getwi: async (a, b, c) => {
                let book = null, title = a, data = b;
                if (typeof b === 'string' || typeof b === 'number') { book = a; title = b; data = c; }
                const e = findEntry(book, title);
                if (!e) return '';
                const { content } = parseDecorators(e.content ?? '');
                const evaluated = await evaluate(content, { ...ctx, data: { ...(ctx.data ?? {}), ...(data ?? {}) } });
                return host.substitute ? host.substitute(evaluated) : evaluated;
            },
            activewi: async (a, b, force) => {
                let book = null, title = a;
                if (typeof b === 'string' || typeof b === 'number') { book = a; title = b; } else force = b;
                const e = findEntry(book, title);
                if (e) forced.add(`${e.world}.${e.uid}`);
                return !!e;
            },
            getchar: async (name, template, data) => {
                const c = host.getCharacter(name);
                if (!c) return '';
                if (template) return evaluate(template, { ...ctx, data: { ...c, ...(data ?? {}) } });
                return [c.description, c.personality, c.scenario].filter(Boolean).join('\n');
            },
            getpreset: async (name, data) => {
                const p = host.getPreset();
                const pr = p?.prompts?.find(x => x.name === name || x.identifier === name);
                if (!pr) return '';
                const out = await evaluate(pr.content ?? '', { ...ctx, data });
                return host.substitute ? host.substitute(out) : out;
            },
            getqr: async () => '',
            getCharData: async (name) => clone(host.getCharacter(name)),
            getWorldInfoData: async (name) => clone(host.getWorldEntries().filter(e => e.world === name)),
            getEnabledWorldInfoEntries: async () => clone(host.getWorldEntries().filter(e => !e.disable)),
            define: (name, value, merge = false) => {
                if (merge && defines[name] && typeof defines[name] === 'object') Object.assign(defines[name], value);
                else defines[name] = value;
            },
            execute: async (cmd) => (host.execute ? host.execute(cmd) : ''),
            evalTemplate: async (content, data = {}) => evaluate(content, { ...ctx, data: { ...(ctx.data ?? {}), ...data } }),
            // 聊天
            getChatMessage: (idx, role) => {
                const list = role ? chat.filter(m => role === 'any' || roleOf(m) === role) : chat;
                const i = idx < 0 ? list.length + idx : idx;
                return msgText(list[i]);
            },
            getChatMessages: (a, b, c) => {
                let start, end, role;
                if (typeof b === 'string') { start = -a; end = undefined; role = b; }
                else if (b === undefined) { start = -a; end = undefined; }
                else { start = a; end = b; role = c; }
                let list = chat.map((m, i) => ({ m, i }));
                if (role && role !== 'any') list = list.filter(x => roleOf(x.m) === role);
                return list.slice(start, end).map(x => msgText(x.m));
            },
            matchChatMessages: (pattern, opt = {}) => {
                const re = pattern instanceof RegExp ? pattern : (typeof pattern === 'string' && pattern.startsWith('/') ? regexFromString(pattern) : null);
                const start = opt.start ?? -(opt.depth ?? chat.length);
                const list = chat.slice(start, opt.end).filter(m => !opt.role || opt.role === 'any' || roleOf(m) === opt.role);
                return list.some(m => (re ? re.test(msgText(m)) : msgText(m).includes(String(pattern))));
            },
            // 注入
            injectPrompt: (key, prompt, order = 100) => {
                (injects[key] ??= []).push({ prompt: String(prompt), order });
            },
            getPromptsInjected: (key) => (injects[key] ?? []).slice().sort((a, b) => a.order - b.order).map(x => x.prompt).join('\n'),
            hasPromptsInjected: (key) => !!injects[key]?.length,
            // 工具
            parseJSON: (text) => {
                if (typeof text !== 'string') return text;
                try { return JSON.parse(text); } catch { /* 宽松 */ }
                try { return JSON.parse(text.replace(/,\s*([\]}])/g, '$1').replace(/'/g, '"')); } catch { return undefined; }
            },
            jsonPatch: (dest, change) => applyCommands({ v: dest }, (Array.isArray(change) ? change : [change]).map(op => ({ kind: 'patch', ...op, path: `/v${op.path ?? ''}` }))).data.v,
            activateRegex: () => undefined,
            toYaml: (o) => dumpYaml(o),
        };
        // 别名
        Object.assign(api, {
            setLocalVar: (k, v, o = {}) => api.setvar(k, v, { ...asObj(o), scope: 'local' }),
            setGlobalVar: (k, v, o = {}) => api.setvar(k, v, { ...asObj(o), scope: 'global' }),
            setMessageVar: (k, v, o = {}) => api.setvar(k, v, { ...asObj(o), scope: 'message' }),
            getLocalVar: (k, o = {}) => api.getvar(k, { ...asObj(o), scope: 'local' }),
            getGlobalVar: (k, o = {}) => api.getvar(k, { ...asObj(o), scope: 'global' }),
            getMessageVar: (k, o = {}) => api.getvar(k, { ...asObj(o), scope: 'message' }),
            incLocalVar: (k, v = 1, o = {}) => api.incvar(k, v, { ...asObj(o), outscope: 'local' }),
            incGlobalVar: (k, v = 1, o = {}) => api.incvar(k, v, { ...asObj(o), outscope: 'global' }),
            incMessageVar: (k, v = 1, o = {}) => api.incvar(k, v, { ...asObj(o), outscope: 'message' }),
            decLocalVar: (k, v = 1, o = {}) => api.decvar(k, v, { ...asObj(o), outscope: 'local' }),
            decGlobalVar: (k, v = 1, o = {}) => api.decvar(k, v, { ...asObj(o), outscope: 'global' }),
            decMessageVar: (k, v = 1, o = {}) => api.decvar(k, v, { ...asObj(o), outscope: 'message' }),
            delLocalVar: (k, i, o = {}) => api.delvar(k, i, { ...asObj(o), scope: 'local' }),
            delGlobalVar: (k, i, o = {}) => api.delvar(k, i, { ...asObj(o), scope: 'global' }),
            delMessageVar: (k, i, o = {}) => api.delvar(k, i, { ...asObj(o), scope: 'message' }),
            insertLocalVar: (k, v, i, o = {}) => api.insvar(k, v, i, { ...asObj(o), scope: 'local' }),
            insertGlobalVar: (k, v, i, o = {}) => api.insvar(k, v, i, { ...asObj(o), scope: 'global' }),
            insertMessageVar: (k, v, i, o = {}) => api.insvar(k, v, i, { ...asObj(o), scope: 'message' }),
            getWorldInfo: api.getwi,
            activateWorldInfo: api.activewi,
            getChara: api.getchar,
            getPresetPrompt: api.getpreset,
            getQuickReply: api.getqr,
        });

        const msg = ctx.messageId !== undefined ? chat[ctx.messageId] : undefined;
        const locals = {
            ...(host.globals ?? {}),
            ...defines,
            ...api,
            variables: vars.cache(ctx.cacheUpto),
            user: names.user, char: names.char, userName: names.user, charName: names.char, assistantName: names.char,
            chatId: host.chatId ?? '', characterId: host.characterId ?? '',
            lastUserMessage: lastOf(m => m.is_user && !m.is_system),
            lastCharMessage: lastOf(m => !m.is_user && !m.is_system),
            lastMessage: lastOf(m => !m.is_system),
            lastMessageId: chat.length - 1,
            runType: ctx.runType ?? 'generate',
            runID: runID++,
            message_id: ctx.messageId,
            swipe_id: msg?.swipe_id,
            is_last: ctx.messageId !== undefined ? ctx.messageId === chat.length - 1 : undefined,
            is_user: msg?.is_user,
            is_system: msg?.is_system,
            name: msg?.name,
            isDryRun: !!ctx.isDryRun,
            generateType: ctx.generateType,
            ...(ctx.data ?? {}),
        };
        return locals;
    }

    return { evaluate, buildLocals, forced, injects, defines };
}

function asObj(o) {
    if (o === undefined || o === null) return {};
    if (typeof o === 'object') return o;
    if (['nx', 'xx', 'n', 'nxs', 'xxs'].includes(o)) return { flags: o };
    if (['old', 'new', 'fullcache'].includes(o)) return { results: o };
    if (typeof o === 'boolean') return { dryRun: o };
    return {};
}

/**
 * 世界书装饰器预处理（ST-Prompt-Template 语义）：
 *  - [GENERATE:*] / [RENDER:*] / @@generate_* / @@render_* / @@initial_variables 等特殊条目移出常规扫描
 *  - @@if 条件为假 → 移除
 *  - @@preprocessing → 先渲染内容
 *  - @@private → 包成独立作用域
 * @returns {Promise<{entries: object[], special: object[]}>}
 */
export async function preprocessWorldEntries(entries, runtime, ctx) {
    const out = [];
    const special = [];
    for (const e of entries) {
        if (e.disable) { out.push(e); continue; }
        const names = (e.decorators ?? []).map(d => d.name);
        const comment = String(e.comment ?? '');
        const isSpecial = /\[(GENERATE|RENDER)[:\]]/i.test(comment) || /\[InitialVariables]/i.test(comment)
            || names.some(n => /^@@(generate_before|generate_after|render_before|render_after|initial_variables|only_preload|message_formatting)$/.test(n));
        if (isSpecial) { special.push(e); continue; }
        const cond = (e.decorators ?? []).find(d => d.name === '@@if');
        if (cond) {
            let ok = true;
            try {
                ok = (await runtime.evaluate(`<%- !!(${cond.args}) %>`, ctx)) === 'true';
            } catch (err) {
                console.warn('[EJS] @@if 求值失败', comment, err);
            }
            if (!ok) continue;
        }
        if (names.includes('@@preprocessing') || comment.includes('[Preprocessing]')) {
            try {
                const content = await runtime.evaluate(e.content, ctx);
                out.push({ ...e, content });
            } catch (err) {
                console.warn('[EJS] 预处理失败', comment, err);
                out.push(e);
            }
            continue;
        }
        if (names.includes('@@private') && hasEjs(e.content)) {
            out.push({ ...e, content: `<% await (async () => { %>${e.content}<% })(); %>` });
            continue;
        }
        out.push(e);
    }
    return { entries: out, special };
}

/** [GENERATE:BEFORE]/[GENERATE:AFTER]/@@generate_before/@@generate_after 条目 → 前置/后置注入 */
export function classifySpecialEntries(special) {
    const before = [], after = [], renderBefore = [], renderAfter = [];
    for (const e of special) {
        const names = (e.decorators ?? []).map(d => d.name);
        const c = String(e.comment ?? '');
        if (names.includes('@@generate_before') || /\[GENERATE:BEFORE]/i.test(c)) before.push(e);
        else if (names.includes('@@generate_after') || /\[GENERATE:AFTER]/i.test(c)) after.push(e);
        else if (names.includes('@@render_before') || /\[RENDER:BEFORE]/i.test(c)) renderBefore.push(e);
        else if (names.includes('@@render_after') || /\[RENDER:AFTER]/i.test(c)) renderAfter.push(e);
    }
    return { before, after, renderBefore, renderAfter };
}
