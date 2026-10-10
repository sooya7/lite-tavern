// 生成流程：组提示词 → 发请求（服务器代生成；旧服务端时浏览器直连，自动重试）→ 写回消息 → 正则/MVU/事件
import { api } from './api.js';
import { state, eventSource, event_types, saveChat, saveChatForJob, discardPendingChatSave, activeConnection, flushPending, mvuEmitter } from './state.js';
import { getSession, addUserMessage, refresh, openChat } from './controller.js';
import { buildRequest, splitThinking, modelsPath, parseModelList } from './core/providers.js';
import { samplerParams, normalizePreset } from './core/preset.js';
import { messageText } from './core/chat.js';
import { sleep, uuid, clone } from './core/util.js';
import { createPacer } from './core/pace.js';
import { estimateTokens } from './core/tokens.js';
import { toast } from './ui/dom.js';
import { GenError, readLlmResponse, generateWithRetry } from './core/llm.js';
import { separateReasoning, placeReply, placeLocated, locateReply, finalizeReply, wantsSeparateVars, applyReplyVars, messageFingerprint, persistedToLoad } from './core/reply.js';
import * as mvuReq from './core/mvu-request.js';
import { latestMvuVars, MVU_EVENTS } from './core/mvu.js';
import { broadcastEvent, broadcastQuiet, broadcastStreamText } from './ui/frontend.js';
import { runGenerateInterceptors } from './ui/extensions.js';
import { startJob, streamJob, cancelJob, claimJob, ackJob, activeJobs, kickStreams } from './genjob.js';

let ui = {};
export function bindGenerateUI(fns) { ui = { ...ui, ...fns }; }

/**
 * 发一次请求，onDelta 收增量。返回 {text, reasoning}
 */
async function requestOnce(conn, req, signal, onDelta, sender) {
    const payload = { path: req.path, method: req.method, body: req.body, stream: req.stream };
    const res = sender ? await sender(payload, signal) : await api.llm(conn.id, payload, signal);
    return readLlmResponse(conn.provider, req, res, onDelta);
}

/** 服务器能代生成吗（旧服务端没有这个接口时浏览器自己请求） */
const jobsUsable = () => !!state.server?.genJobs;
const swipeCountOf = (m) => (Array.isArray(m?.swipes) && m.swipes.length ? m.swipes.length : 1);

/**
 * @param {'normal'|'regenerate'|'swipe'|'continue'|'impersonate'|'quiet'} type
 * @param {{input?: string, quietPrompt?: string, silent?: boolean}} opt
 */
export async function generate(type = 'normal', opt = {}) {
    if (state.generating) return null;
    if (!state.char || !state.chat) { toast('先选一个角色', 'warning'); return null; }
    const conn = activeConnection();
    if (!conn) {
        toast('还没有配置 API 连接，先在「连接」里添加一个', 'warning');
        ui.openPanel?.('connection');
        return null;
    }
    if (!conn.model && conn.provider !== 'openai') {
        toast('连接里还没选模型', 'warning');
        ui.openPanel?.('connection');
        return null;
    }
    const chat = state.chat.messages;
    if (type === 'swipe') {
        const last = chat[chat.length - 1];
        if (!last || last.is_user) { toast('最后一条不是角色消息，没法重刷', 'warning'); return null; }
    }
    // 先占住生成状态，防止连点触发两次
    state.generating = true;
    const ac = new AbortController();
    state.abort = ac;
    ui.setGenerating?.(true);

    const ctx = { chat, chatRef: state.chat, conn, type, targetIndex: -1, baseText: '', removedForRegen: null, started: new Date(), ac, jobId: '', target: null };
    let excludeLast = false;
    let session;
    try {
        // 连接配置由服务端从 settings.json 读取，发请求前先把待保存的设置写掉
        await flushPending();
        session = getSession();
        ctx.session = session;
        if (type === 'normal' && opt.input?.trim()) await addUserMessage(opt.input);
    } catch (e) {
        toast(`发送失败：${e.message}`, 'error');
        endGeneration(ctx);
        return null;
    }

    if (type === 'regenerate') {
        const last = chat[chat.length - 1];
        if (last && !last.is_user && !last.is_system) {
            ctx.removedForRegen = chat.pop();
            ui.renderChat?.();
        }
        type = 'normal';
    }
    if (type === 'swipe') excludeLast = true;
    if (type === 'continue') {
        const last = chat[chat.length - 1];
        if (!last || last.is_user) type = 'normal';
        else ctx.baseText = messageText(last);
    }
    ctx.type = type;

    await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, { quiet_prompt: opt.quietPrompt }, false);
    await eventSource.emit(event_types.GENERATION_STARTED, type, { quiet_prompt: opt.quietPrompt }, false);
    broadcastEvent('js_generation_started');

    let prompt;
    try {
        // 脚本用 injectPrompts 注入的提示词（在上面两个事件里注入的也算）
        await ui.beforePrompt?.(session, type);
        // 酒馆插件的生成拦截器（manifest.generate_interceptor）：拿到这次要发的聊天记录副本，可以临时改
        let chatOverride;
        const intercepted = await runGenerateInterceptors(session.chat, type === 'swipe' ? 'swipe' : (ctx.removedForRegen ? 'regenerate' : type));
        if (intercepted?.aborted) throw new Error('插件中止了这次生成');
        if (intercepted) chatOverride = intercepted.chat;
        await eventSource.emit('generate_before_combine_prompts', { type });
        prompt = await session.preparePrompt({ type, quietPrompt: opt.quietPrompt, excludeLast, chatOverride });
        await eventSource.emit('worldinfo_scan_done', { activated: prompt.worldInfo?.activated ?? [] });
        if (prompt.worldInfo?.activated?.length) await eventSource.emit(event_types.WORLD_INFO_ACTIVATED, prompt.worldInfo.activated);
        await eventSource.emit('generate_after_combine_prompts', { prompt: prompt.messages.map(m => m.content).join('\n'), dryRun: false });
        const evData = { chat: plainMessages(prompt.messages), dryRun: false, type };
        await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, evData);
        prompt.messages = adoptMessages(prompt.messages, evData.chat);
        ui.transformPrompt?.(prompt.messages);
    } catch (e) {
        console.error(e);
        toast(`组装提示词出错：${e.message}`, 'error');
        if (ctx.removedForRegen) { chat.push(ctx.removedForRegen); ui.renderChat?.(); }
        endGeneration(ctx);
        return null;
    }

    const preset = state.preset.data;
    const params = samplerParams(preset);
    // 发送前给脚本改请求的两次机会，顺序和酒馆一样：先 GENERATE_AFTER_DATA（{prompt: 消息数组}），再
    // CHAT_COMPLETION_SETTINGS_READY（消息 + 采样参数）。合并相邻消息、加前缀之类的预设脚本靠它们；
    // 新版酒馆（> 1.13.4）上这类脚本只听前一个，所以两个都要在拼请求体之前发，改动才算数
    const afterData = { prompt: plainMessages(prompt.messages) };
    await eventSource.emit(event_types.GENERATE_AFTER_DATA, afterData, false);
    prompt.messages = adoptMessages(prompt.messages, afterData.prompt);
    const genData = await settingsReady(conn, params, prompt.messages, session.names);
    prompt.messages = genData.messages;
    const req = buildRequest(conn, { messages: prompt.messages, prefill: prompt.prefill, params, names: session.names });

    // 准备写入位置。写聊天的三种生成交给服务器去请求：页面切到后台、锁屏、关掉都不影响，回来接着看
    const writes = type === 'normal' || type === 'swipe' || type === 'continue';
    const useJob = writes && jobsUsable();
    if (useJob) {
        ctx.jobId = `g_${uuid()}`;
        // 刚加的用户消息先落盘：服务器替页面写回复时，聊天文件里得有它（占位不存，服务器自己放）
        await flushPending();
    }
    if (writes) {
        const index = type === 'normal' ? chat.length : chat.length - 1;
        // 记下位置和“前一条”的指纹：服务器替页面写的时候核对聊天还是不是这个样子
        ctx.target = {
            type,
            index,
            ...(type === 'swipe' ? { swipeId: swipeCountOf(chat[index]) } : {}),
            ...(type === 'continue' ? { baseText: ctx.baseText } : {}),
            anchor: messageFingerprint(chat[index - 1]),
            ...(ctx.removedForRegen ? { replace: messageFingerprint(ctx.removedForRegen) } : {}),
        };
        ctx.targetIndex = placeReply(chat, { type, index, provider: conn.provider, model: conn.model, started: ctx.started, jobId: ctx.jobId, charName: session.names.char });
        if (type === 'normal') ui.appendMessage?.(ctx.targetIndex, { streaming: true });
        else ui.renderMessage?.(ctx.targetIndex, { streaming: true });
    }
    ctx.think = session.power.thinkAutoParse !== false;
    ctx.paint = makePainter(ctx);

    let outcome = null;
    if (useJob) {
        // 页面在等服务器：有生成在进行时不再挡“离开页面”
        outcome = await runJob(ctx, { path: req.path, method: req.method, body: req.body, stream: req.stream });
    }
    if (!outcome || outcome.fallback) {
        ctx.jobId = '';
        outcome = await runLocal(ctx, req);
    }
    return completeReply(ctx, outcome);
}

// 流式重绘的节奏（core/pace.js）。每次重绘都要把整条回复重新排一遍版（Markdown → 清洗 → 换掉整块内容），回复越长越贵；
// 以前固定 60 毫秒一次，七八千字的回复能把手机的主线程占满一分多钟，手机就是这么烫起来的。
// 现在最快每秒 5 次；重绘一次花了 t 毫秒就至少歇 PAINT_REST × t。字还是实时出，只是一小段一小段地出。
const PAINT_MIN_MS = 200;
const PAINT_MAX_MS = 1000;
const PAINT_REST = 6;

/** 正在用的那个（页面回到前台时补画一次） */
let livePainter = null;

/**
 * 流式写进占位楼层。收到的文字每次都记进消息里（点停止时保留的就是它，一个字不少），
 * 画到屏幕上、通知脚本和卡片界面则按上面的节奏来；页面在后台时不画，回到前台补上。
 */
function makePainter(ctx) {
    let body = '';
    const pacer = createPacer(() => {
        if (ctx.type === 'impersonate' || ctx.type === 'quiet') {
            ui.setStatus?.(`生成中… ${estimateTokens(body)} tokens`);
            if (ctx.type === 'impersonate') ui.setComposerText?.(body);
            return;
        }
        const m = ctx.chat[ctx.targetIndex];
        if (!m) return;
        ui.updateStreaming?.(ctx.targetIndex);
        ui.setStatus?.(`生成中… ${estimateTokens(body)} tokens`);
        // 卡片界面：每个界面这次生成只拿一次完整快照，之后只告诉它这一楼现在的文字
        broadcastStreamText('js_stream_token_received_fully', ctx.targetIndex, m.mes, ctx);
        if (eventSource.count(event_types.STREAM_TOKEN_RECEIVED)) eventSource.emit(event_types.STREAM_TOKEN_RECEIVED, m.mes);
    }, { minMs: PAINT_MIN_MS, maxMs: PAINT_MAX_MS, rest: PAINT_REST, hidden: () => typeof document !== 'undefined' && document.hidden });
    const paint = (text, reasoning, force = false) => {
        const sep = separateReasoning(text, reasoning, ctx.think);
        body = sep.body;
        if (ctx.type !== 'impersonate' && ctx.type !== 'quiet') {
            const m = ctx.chat[ctx.targetIndex];
            if (!m) return;
            m.mes = ctx.type === 'continue' ? ctx.baseText + body : body;
            m.extra = { ...(m.extra ?? {}), reasoning: sep.rsn || undefined };
        }
        pacer.request(force);
    };
    /** 还有没画上去的就现在画（页面回到前台时） */
    paint.flush = () => pacer.flush();
    /** 生成结束 / 重试从头来：到点要画的那一下作废 */
    paint.cancel = () => pacer.cancel();
    livePainter = paint;
    return paint;
}

/** 浏览器直接请求（旧服务端、代我写、静默生成） */
async function runLocal(ctx, req) {
    const r = await generateWithRetry(() => requestOnce(ctx.conn, req, ctx.ac.signal, ctx.paint), {
        retry: state.settings.retry ?? {},
        signal: ctx.ac.signal,
        onRetry: (n) => { ctx.paint.cancel(); ui.setStatus?.(`第 ${n} 次重试…`); },
        log: (e) => console.warn('[生成] 失败', e),
    });
    return { result: r.result, error: r.error, aborted: ctx.ac.signal.aborted };
}

/** 开服务器任务并跟着它的流 */
async function runJob(ctx, request) {
    try {
        await startJob({
            id: ctx.jobId,
            conn: ctx.conn.id,
            request,
            chat: { char: state.char.id, file: state.char.file, name: state.chat.name },
            target: ctx.target,
            preset: state.preset?.name ?? '',
            started: ctx.started.toISOString(),
            provider: ctx.conn.provider,
            model: ctx.conn.model,
            tzOffset: new Date().getTimezoneOffset(),
        });
    } catch (e) {
        // 旧服务端没有这个接口：浏览器自己请求
        if (e.status === 404 || e.status === 405) return { fallback: true };
        return { result: null, error: e, aborted: false };
    }
    return followJob(ctx);
}

/**
 * 收服务器任务的流，直到有结果。页面切后台 / 断网后回来会按 seq 续上（genjob.js 的 streamJob）。
 * @returns {Promise<{result?: object|null, error?: Error|null, aborted?: boolean, lost?: boolean, persisted?: object}>}
 */
async function followJob(ctx) {
    const { ac, jobId } = ctx;
    let text = '', reasoning = '';
    let doneEv = null;
    const onEvent = (ev) => {
        if (ev.type === 'delta') {
            text += ev.t ?? '';
            reasoning += ev.r ?? '';
            ctx.paint(text, reasoning);
        } else if (ev.type === 'reset') {
            // 服务器在重试：这次从头再来
            text = '';
            reasoning = '';
            ctx.paint.cancel();
        } else if (ev.type === 'status') {
            ui.setStatus?.(ev.text);
        } else if (ev.type === 'persisting') {
            ui.setStatus?.('页面刚才不在，服务器正在把回复写进聊天…');
        }
    };
    // 收齐了：先认领（告诉服务器页面在，自己来收尾）。服务器已经接手了就等它写完
    const onDone = async (ev) => {
        doneEv = ev;
        const c = await claimJob(jobId);
        return c.status !== 'persisting' && c.status !== 'persisted';
    };
    let r = await streamJob(jobId, { signal: ac.signal, onEvent, onDone });
    if (r.kind === 'aborted') {
        // 用户点了停止：让服务器断开上游。正好碰上服务器在替页面写，就等它写完用它的
        const c = await cancelJob(jobId);
        if (c.status !== 'persisting' && c.status !== 'persisted') return { result: null, error: null, aborted: true };
        r = await streamJob(jobId, { after: r.lastSeq, onEvent, onDone: async () => false });
    }
    switch (r.kind) {
        case 'done':
            return { result: { text: r.ev.text ?? text, reasoning: r.ev.reasoning ?? reasoning }, error: null, aborted: false };
        case 'error':
            return { result: null, error: new GenError(r.ev.message ?? '生成失败', { status: r.ev.status }), aborted: false };
        case 'cancelled':
            // 别的窗口点了停止：当作停止，保留已经生成的部分
            return { result: null, error: null, aborted: true };
        case 'persisted':
            return { persisted: r.ev };
        case 'persist_failed':
            // 服务器没写成（保存出错）：页面自己来
            if (doneEv) return { result: { text: doneEv.text ?? text, reasoning: doneEv.reasoning ?? reasoning }, error: null, aborted: false };
            return { result: null, error: new Error(`服务器保存回复失败：${r.ev.message ?? ''}`), aborted: false };
        case 'lost':
        default:
            return { result: null, error: new Error('服务器上找不到这次生成了（服务器可能重启过），没收完的部分已保留'), aborted: false, lost: true };
    }
}

/** 收尾时给服务器打招呼：“我还在处理”（额外模型解析可能要十几秒）。服务器已经接手就叫停本地的处理 */
function claimHeartbeat(jobId, onTaken) {
    const timer = setInterval(async () => {
        const c = await claimJob(jobId);
        if (c.status === 'persisting' || c.status === 'persisted') onTaken();
    }, 5000);
    return () => clearInterval(timer);
}

/** 流式那一段结束了：还没到点的那一下重绘作废（不然它会在正式排好版之后又把这一楼画回流式的样子） */
function stopPainting(ctx) {
    ctx.paint?.cancel();
    if (livePainter === ctx.paint) livePainter = null;
}

/** 生成结束：放开生成状态、刷新界面 */
function endGeneration(ctx) {
    stopPainting(ctx);
    state.generating = false;
    state.abort = null;
    ui.setGenerating?.(false);
    ui.setStatus?.('');
    ui.afterGeneration?.();
    if (ctx.targetIndex >= 0 && ctx.chat[ctx.targetIndex]) ui.renderMessage?.(ctx.targetIndex);
}

/**
 * 拿到结果之后：停止保留部分 / 失败回滚 / 拆思维链、正则、变量、保存、发事件。
 * 页面自己请求、服务器代生成、刷新后接回来的任务都走这里，所以三种情况下存进去的东西一样。
 */
async function completeReply(ctx, outcome) {
    const { session, conn, type, chat, removedForRegen, started, ac, jobId } = ctx;
    const targetIndex = ctx.targetIndex;
    const baseText = ctx.baseText;
    stopPainting(ctx);
    if (outcome.persisted) return adoptServerReply(ctx);
    let result = outcome.result ?? null;
    const lastErr = outcome.error ?? null;
    const aborted = !!outcome.aborted || ac.signal.aborted;
    // 中途停止（或服务器任务丢了）：保留已经生成的部分
    if (!result && (aborted || outcome.lost) && targetIndex >= 0) {
        const m = chat[targetIndex];
        const partial = type === 'continue' ? messageText(m).slice(baseText.length) : messageText(m);
        if (partial.trim()) result = { text: partial, reasoning: m.extra?.reasoning ?? '', partial: true };
    }

    if (!result) {
        if (lastErr) toast(lastErr.message, 'error');
        // 回滚占位
        if (type === 'normal' && targetIndex >= 0) {
            chat.splice(targetIndex, 1);
            ui.removeMessage?.(targetIndex);
            if (removedForRegen) {
                chat.push(removedForRegen);
                ui.appendMessage?.(chat.length - 1);
            }
        } else if (type === 'swipe' && targetIndex >= 0) {
            const m = chat[targetIndex];
            m.swipes.pop();
            m.swipe_info.pop();
            m.swipe_id = m.swipes.length - 1;
            m.mes = m.swipes[m.swipe_id];
            m.extra = { ...(m.swipe_info[m.swipe_id]?.extra ?? {}) };
            ui.renderMessage?.(targetIndex);
        } else if (type === 'continue' && targetIndex >= 0) {
            chat[targetIndex].mes = baseText;
            ui.renderMessage?.(targetIndex);
        }
        if (jobId) ackJob(jobId);
        endGeneration(ctx);
        await eventSource.emit(aborted ? event_types.GENERATION_STOPPED : event_types.GENERATION_ENDED, -1);
        // 这个聊天在别的窗口里正在生成：接过来显示它
        if (lastErr?.code === 'gen-busy') resumeActiveJobs();
        return null;
    }
    if (outcome.lost) toast(lastErr?.message ?? '服务器上找不到这次生成了', 'warning');

    // 拆思维链 + 永久正则
    const sep = result.partial ? { body: result.text, rsn: result.reasoning } : separateReasoning(result.text, result.reasoning, ctx.think);
    const text = sep.body;
    const reasoning = sep.rsn;
    const finished = new Date();

    if (type === 'impersonate') {
        ui.setComposerText?.(text.trim());
        await eventSource.emit('impersonate_ready', text.trim());
        endGeneration(ctx);
        await eventSource.emit(event_types.GENERATION_ENDED, -1);
        return text;
    }
    if (type === 'quiet') {
        endGeneration(ctx);
        await eventSource.emit(event_types.GENERATION_ENDED, -1);
        return text;
    }

    const m = finalizeReply(session, targetIndex, { type, baseText, text, reasoning, provider: conn.provider, model: conn.model, started, finished });

    // 收尾期间一直告诉服务器“页面在处理”；页面被挂起太久、服务器已经接手的话，本地的额外模型解析停掉
    const post = new AbortController();
    const onStop = () => post.abort();
    ac.signal.addEventListener('abort', onStop, { once: true });
    let taken = false;
    const stopBeat = jobId && !result.partial ? claimHeartbeat(jobId, () => { taken = true; post.abort(); }) : () => {};

    // 变量单独更新：正文没自己写更新块时，另发一次请求只要变量更新（关了“自动请求”就等用户手动点“重试额外模型解析”）
    const eff = session.mvuSettings();
    if (wantsSeparateVars(session, targetIndex, result.partial)) {
        ui.renderMessage?.(targetIndex);
        ui.setStatus?.('正在更新变量…');
        try {
            await updateVarsSeparately(session, targetIndex, post.signal);
        } catch (e) {
            if (!post.signal.aborted) toast(`变量更新失败：${String(e?.message ?? e).split('\n')[0]}`, 'warning');
        }
    }

    // MVU：基于上一层变量应用本条更新（有脚本监听 MVU 事件时边更新边发事件）
    if (session.mvuEnabled() && !taken) {
        broadcastEvent('mag_variable_update_started');
        const { result: r, cleaned } = await applyReplyVars(session, targetIndex, mvuEmitter());
        if (r?.errors?.length && eff.mvuNotifyError) toast(`变量更新有 ${r.errors.length} 处没执行：${String(r.errors[0]).split('\n')[0]}`, 'warning');
        if (cleaned) console.info(`[MVU] 已清理 ${cleaned} 层的旧变量`);
    }
    stopBeat();
    ac.signal.removeEventListener('abort', onStop);
    session.vars.invalidate();
    ui.renderMessage?.(targetIndex);
    if (jobId) {
        // 带着任务号保存：服务器据此知道页面已经写好了，不会再替页面写一遍（保存和确认是同一个请求，不会两边都写）
        const saved = taken ? 'gen-persisted' : await saveChatForJob(jobId);
        if (saved === 'gen-persisted') return adoptServerReply(ctx);
    } else {
        saveChat();
    }
    endGeneration(ctx);
    if (reasoning) await eventSource.emit('stream_reasoning_done', reasoning, finished - started, targetIndex, 'done');
    await eventSource.emit(event_types.MESSAGE_RECEIVED, targetIndex, type);
    broadcastEvent('message_received', targetIndex);
    broadcastEvent('js_generation_ended', m.mes);
    broadcastEvent('mag_variable_update_ended');
    await eventSource.emit(event_types.GENERATION_ENDED, targetIndex);
    if (result.partial && !outcome.lost) toast('已停止，保留了已生成的部分', 'info');
    return m.mes;
}

/**
 * 页面不在的时候服务器已经把回复（和变量）写进聊天了：丢掉本地的占位，载入服务器那份。
 * 脚本该收的事件由 replayServerReplies 补发（载入聊天后自动进行）。
 */
async function adoptServerReply(ctx) {
    discardPendingChatSave();
    ctx.targetIndex = -1;
    endGeneration(ctx);
    if (state.chat === ctx.chatRef || state.chat?.messages === ctx.chat) {
        try {
            await openChat(state.chat.name, { stay: true });
        } catch (e) {
            toast(`载入服务器保存的回复失败：${e.message}`, 'error');
        }
    }
    await eventSource.emit(event_types.GENERATION_ENDED, -1);
    return null;
}

// ---------- 刷新 / 重开聊天后接回服务器上的任务 ----------

let resuming = false;
/** 已经为它重新载入过聊天的任务（服务器替页面写的）。每个任务只载入一次，见 core/reply.js 的 persistedToLoad */
const reloadedFor = new Set();
/**
 * 打开聊天 / 回到前台 / 网络恢复时调用：这个聊天在服务器上还有没完成的任务，就接着显示它的流；
 * 服务器刚替页面写好的，本地还是旧的就重新载入。
 */
export async function resumeActiveJobs() {
    if (resuming || !jobsUsable() || !state.char || !state.chat || state.generating) return;
    resuming = true;
    try {
        const chatRef = state.chat;
        const jobs = await activeJobs(state.char.id, chatRef.name);
        if (state.chat !== chatRef || state.generating) return;
        const missed = persistedToLoad(chatRef.messages, chatRef.version, jobs, reloadedFor);
        if (missed.length) {
            for (const j of missed) reloadedFor.add(j.id);
            discardPendingChatSave();
            await openChat(chatRef.name, { stay: true });
            return;
        }
        const live = jobs.find(j => ['running', 'awaiting_ack', 'persisting', 'persist_failed'].includes(j.status));
        if (live) await attachJob(live);
    } finally {
        resuming = false;
    }
}

/** 接回一个任务：按服务器记的位置放好占位，从头收它的流，收齐后照常收尾 */
async function attachJob(j) {
    const session = getSession();
    if (!session) return;
    const chat = state.chat.messages;
    const conn = { ...(state.settings.connections.find(c => c.id === j.conn) ?? {}), id: j.conn, provider: j.provider, model: j.model };
    const ac = new AbortController();
    const ctx = { chat, chatRef: state.chat, conn, type: j.target?.type ?? 'normal', targetIndex: -1, baseText: '', removedForRegen: null, started: new Date(j.started), ac, jobId: j.id, target: j.target, session };
    state.generating = true;
    state.abort = ac;
    ui.setGenerating?.(true);
    // 服务器正在替页面写（或位置对不上）：不在本地显示流，等它写完载入
    const loc = j.status === 'persisting' ? { kind: 'orphan' } : locateReply(chat, j.target, j.id);
    if (loc.kind === 'orphan') {
        ui.setStatus?.('服务器正在完成这次回复…');
        const r = await streamJob(j.id, { signal: ac.signal, onDone: async () => false });
        if (r.kind === 'persisted') return adoptServerReply(ctx);
        endGeneration(ctx);
        if (r.kind === 'error') toast(r.ev?.message ?? '生成失败', 'error');
        return null;
    }
    if (loc.kind === 'replace') ctx.removedForRegen = chat[loc.index];
    const placed = placeLocated(chat, loc, j.target, { provider: j.provider, model: j.model, started: j.started, charName: session.names.char });
    // 本地是刚从服务器读的，占位放好之后带上任务号（和生成开始时一样）
    const pm = chat[placed.index];
    if (placed.type === 'normal') pm.extra = { ...(pm.extra ?? {}), lt_job: j.id };
    ctx.type = placed.type;
    ctx.targetIndex = placed.index;
    ctx.baseText = placed.baseText;
    ctx.think = session.power.thinkAutoParse !== false;
    ctx.paint = makePainter(ctx);
    ui.renderChat?.();
    ui.setStatus?.('接着显示服务器上的生成…');
    const outcome = await followJob(ctx);
    return completeReply(ctx, outcome);
}

/**
 * 服务器替页面写的楼层，脚本那时没在跑：现在补发它们该收到的事件（MESSAGE_RECEIVED，MVU 的“变量更新完了”）。
 * 变量服务器已经算好，不再走一遍 MVU 的解析；监听者原地改了变量就照常保存。补发过的把标记里的 pending 去掉。
 */
export async function replayServerReplies() {
    const chatRef = state.chat;
    if (!chatRef || state.generating) return;
    const marks = [];
    chatRef.messages.forEach((m, i) => {
        const all = [m.extra, ...(m.swipe_info ?? []).map(s => s?.extra)].map(e => e?.lt_server_persisted).filter(x => x?.pending);
        if (all.length) marks.push({ i, m, mark: all[0], all });
    });
    if (!marks.length) return;
    const session = getSession();
    for (const { i, m, mark, all } of marks) {
        if (state.chat !== chatRef) return;
        for (const x of all) x.pending = false;
        if (mark.mvu && session?.mvuEnabled()) {
            const vars = m.variables?.[m.swipe_id ?? 0];
            if (vars) {
                const before = clone(latestMvuVars(chatRef.messages, i - 1)?.vars ?? {});
                await eventSource.emit(MVU_EVENTS.VARIABLE_UPDATE_ENDED, vars, before);
                await eventSource.emit(`${MVU_EVENTS.VARIABLE_UPDATE_ENDED}_for_zod`, vars, before);
            }
        }
        if (mark.reasoning && m.extra?.reasoning) await eventSource.emit('stream_reasoning_done', m.extra.reasoning, 0, i, 'done');
        await eventSource.emit(event_types.MESSAGE_RECEIVED, i, mark.type ?? 'normal');
        broadcastEvent('message_received', i);
        broadcastEvent('js_generation_ended', m.mes);
        if (mark.mvu) broadcastEvent('mag_variable_update_ended');
        ui.renderMessage?.(i);
    }
    session?.vars.invalidate();
    saveChat();
}

// 打开聊天后：等脚本对齐好（它们要收补发的事件），补发服务器代写楼层的事件，再看有没有没完成的任务
// （不在监听里等：openChat 会等所有监听者跑完，接回的任务要一直跑到生成结束）
eventSource.on(event_types.CHAT_CHANGED, () => { afterChatOpened().catch(e => console.error('[代生成] 打开聊天后的检查失败', e)); });
async function afterChatOpened() {
    await sleep(50);
    await ui.scriptsSettled?.();
    await replayServerReplies();
    await resumeActiveJobs();
}

// 页面回到前台、网络恢复：断掉的流马上重连；没在生成时看看服务器上有没有这个聊天的任务
if (typeof document !== 'undefined') {
    const wake = () => { kickStreams(); resumeActiveJobs(); };
    // 在后台时流式不往屏幕上画，回来先把攒下的画上
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { livePainter?.flush(); wake(); } });
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
}

// ---------- 变量单独更新（额外模型解析） ----------

const regexToast = { text: '', at: 0 };

/** 额外模型解析用到的页面环境：当前预设、按名字读预设、发请求、提示 */
function mvuEnv() {
    return {
        preset: state.preset?.data ?? {},
        presetName: state.preset?.name ?? '',
        loadPreset: async (name) => {
            if (!state.presetList.some(p => p.name === name)) throw new Error(`找不到预设「${name}」`);
            return normalizePreset(await api.get('presets', name));
        },
        send: (conn, req, signal) => requestOnce(conn, req, signal, () => {}),
        get conn() { return mvuReq.mvuConnectionOf(state.settings, activeConnection()); },
        onFilter: (f) => {
            state.mvuLastFilter = f;
            const errs = (f.regexErrors ?? []).join('\n');
            if (errs && (errs !== regexToast.text || Date.now() - regexToast.at > 10000)) { toast(errs, 'warning'); regexToast.text = errs; regexToast.at = Date.now(); }
        },
        notice: (text) => toast(text, 'info'),
    };
}

/** 拼额外模型解析的请求（见 core/mvu-request.js） */
export const buildMvuRequest = (session, index, o = {}) => mvuReq.buildMvuRequest(session, index, o, mvuEnv());

/** 按“请求策略”请求模型，拿到一个 <UpdateVariable> 块（不写回正文） */
export const requestVarUpdate = (session, index, o = {}) => mvuReq.requestVarUpdate(session, index, o, mvuEnv());

export const writeUpdateBlock = mvuReq.writeUpdateBlock;

/** 另发请求更新变量，结果写回这条消息末尾（不应用变量） */
export const updateVarsSeparately = (session, index, signal) => mvuReq.updateVarsSeparately(session, index, signal, mvuEnv());

/** “重试额外模型解析”：对某一楼（默认最后一条 AI 回复）重新请求并重新应用 */
export async function redoVarsForMessage(index) {
    const session = getSession();
    if (!session || state.generating) return false;
    const ac = new AbortController();
    state.abort = ac;
    state.generating = true;
    ui.setGenerating?.(true);
    ui.setStatus?.('正在更新变量…');
    try {
        // 先去掉这一楼原有的更新块，请求时只看剧情
        const m = session.chat[index];
        const stripped = String(messageText(m)).replace(/\s*<UpdateVariable>[\s\S]*?(<\/UpdateVariable>|$)/gi, '');
        if (stripped !== messageText(m)) { m.mes = stripped; if (Array.isArray(m.swipes)) syncSwipe(m); }
        await updateVarsSeparately(session, index, ac.signal);
        broadcastEvent('mag_variable_update_started');
        const r = await session.applyMvuAsync(index, mvuEmitter());
        if (r?.errors?.length && session.mvuSettings().mvuNotifyError) toast(`变量更新有 ${r.errors.length} 处没执行：${String(r.errors[0]).split('\n')[0]}`, 'warning');
        session.vars.invalidate();
        ui.renderMessage?.(index);
        saveChat();
        broadcastEvent('mag_variable_update_ended');
        return true;
    } catch (e) {
        if (!ac.signal.aborted) toast(`变量更新失败：${String(e?.message ?? e).split('\n')[0]}`, 'warning');
        return false;
    } finally {
        state.generating = false;
        state.abort = null;
        ui.setGenerating?.(false);
        ui.setStatus?.('');
    }
}

export function stopGeneration() {
    state.abort?.abort();
    // 脚本发起的、没要求“静默”的生成也一起停
    for (const g of scriptGens.values()) if (!g.silent) g.ac.abort();
}

/**
 * 交给事件监听者的消息：和酒馆一样只有 role / content / name。轻酒馆自己给每条消息记的来源（source 等）不带出去——
 * 合并相邻消息的脚本会比较两条消息除正文外是否相同，带着来源标记它就认为都不同、什么也不合并。
 */
const plainMessages = (messages) => messages.map(m => ({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) }));

/** 监听者没动过就沿用原来那份（保留来源标记，提示词预览里还看得到每条是哪来的）；动过就用它改好的 */
function adoptMessages(original, edited) {
    if (!Array.isArray(edited)) return original;
    const same = edited.length === original.length && edited.every((m, i) => m && m.role === original[i].role && m.content === original[i].content && (m.name || '') === (original[i].name || ''));
    return same ? original : edited.filter(m => m && typeof m === 'object');
}

/** 发 CHAT_COMPLETION_SETTINGS_READY：监听者可以原地改 messages 和采样参数 */
async function settingsReady(conn, params, messages, names) {
    const data = {
        messages: plainMessages(messages),
        model: conn.model,
        temperature: params.temperature,
        frequency_penalty: params.frequency_penalty,
        presence_penalty: params.presence_penalty,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        stream: params.stream,
        stop: [],
        chat_completion_source: conn.provider === 'claude' ? 'claude' : conn.provider === 'gemini' ? 'makersuite' : 'openai',
        user_name: names?.user ?? '',
        char_name: names?.char ?? '',
        group_names: [],
    };
    if (!eventSource.count(event_types.CHAT_COMPLETION_SETTINGS_READY)) return { ...data, messages };
    await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data);
    data.messages = adoptMessages(messages, data.messages);
    for (const k of ['temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'max_tokens']) {
        if (typeof data[k] === 'number' && !Number.isNaN(data[k])) params[k] = data[k];
    }
    return data;
}

// ---------- 脚本 / 前端卡发起的生成（酒馆助手的 generate / generateRaw） ----------
// 不占用主生成的状态，可以和正文生成同时进行；不写入聊天，只把文本还给调用方。

const scriptGens = new Map(); // generation_id → {ac, silent}

export const RAW_PROMPT_ORDER = ['world_info_before', 'persona_description', 'char_description', 'char_personality', 'scenario',
    'world_info_after', 'dialogue_examples', 'chat_history', 'user_input'];

const OVERRIDE_FIELDS = { char_description: 'description', char_personality: 'personality', scenario: 'scenario', persona_description: 'persona', dialogue_examples: 'mesExamples' };

function customConnection(api, base) {
    return {
        ...(base ?? {}), id: '', provider: 'openai', postProcessing: base?.postProcessing ?? '', extraBody: '', extraHeaders: '',
        model: api.model ?? base?.model ?? '', baseUrl: String(api.apiurl).replace(/\/+$/, ''),
    };
}

/** 自定义接口：浏览器直接请求（不经过本地代理，本地服务不替脚本转发任意地址） */
async function requestCustom(api, req, signal) {
    const base = String(api.apiurl).replace(/\/+$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}${req.path}`;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}) },
        body: JSON.stringify(req.body),
        signal,
    });
}

/**
 * @param {object} config 酒馆助手的 GenerateConfig / GenerateRawConfig
 * @param {{raw?: boolean}} mode raw = generateRaw（不用预设，按 ordered_prompts 拼）
 * @returns {Promise<string|{content: string, reasoning?: string}>}
 */
export async function scriptGenerate(config = {}, { raw = false } = {}) {
    const cfg = config ?? {};
    const id = String(cfg.generation_id ?? uuid());
    // custom_api.proxy_preset：按名字用“连接”里的某一个（酒馆的代理预设在轻酒馆里就是连接）
    const presetName = String(cfg.custom_api?.proxy_preset ?? '').trim();
    const named = presetName ? state.settings.connections.find(c => c.name === presetName) : null;
    const base = named ?? activeConnection();
    const custom = !named && cfg.custom_api?.apiurl ? cfg.custom_api : null;
    if (!base && !custom) throw new Error('还没有配置 API 连接');
    const conn = custom ? customConnection(custom, base) : { ...base, ...(cfg.custom_api?.model ? { model: cfg.custom_api.model } : {}) };
    const session = getSession();
    const sub = (t) => (session ? session.substitute(String(t ?? '')) : String(t ?? ''));
    const userInput = cfg.user_input === undefined || cfg.user_input === null ? '' : String(cfg.user_input);
    const ov = cfg.overrides ?? {};

    await eventSource.emit('js_generation_requested', id, raw ? 'generateRaw' : 'generate', cfg);

    let messages = [];
    let prefill = '';
    if (session) {
        await flushPending();
        const fieldOverrides = {};
        for (const [k, f] of Object.entries(OVERRIDE_FIELDS)) if (typeof ov[k] === 'string') fieldOverrides[f] = ov[k];
        const injects = (cfg.injects ?? []).filter(x => x && x.content && x.position !== 'none');
        const saved = { ...session.extensionPrompts };
        injects.forEach((x, i) => { session.extensionPrompts[`th_gen_${id}_${i}`] = { value: String(x.content), position: 1, depth: Number(x.depth ?? 0), role: x.role ?? 'system' }; });
        let prepared;
        try {
            await ui.beforePrompt?.(session, 'quiet');
            prepared = await session.preparePrompt({
                type: 'quiet',
                // 酒馆的“静默提示词”：作为最后一条 system 指令，而不是一条用户消息
                quietPrompt: cfg.quiet_prompt ? String(cfg.quiet_prompt) : '',
                dryRun: true,
                maxHistory: typeof cfg.max_chat_history === 'number' ? cfg.max_chat_history : undefined,
                historyOverride: Array.isArray(ov.chat_history?.prompts) ? ov.chat_history.prompts.map(p => ({ role: p.role, content: sub(p.content) })) : undefined,
                appendHistory: !raw && userInput ? [{ role: 'user', content: sub(userInput) }] : undefined,
                fieldOverrides,
            });
        } finally {
            session.extensionPrompts = saved;
        }
        if (raw) {
            const wi = prepared.worldInfo ?? {};
            const f = prepared.fields ?? {};
            const builtin = {
                world_info_before: () => [{ role: 'system', content: typeof ov.world_info_before === 'string' ? ov.world_info_before : wi.worldInfoBefore }],
                world_info_after: () => [{ role: 'system', content: typeof ov.world_info_after === 'string' ? ov.world_info_after : wi.worldInfoAfter }],
                persona_description: () => [{ role: 'system', content: f.persona }],
                char_description: () => [{ role: 'system', content: f.description }],
                char_personality: () => [{ role: 'system', content: f.personality }],
                scenario: () => [{ role: 'system', content: f.scenario }],
                dialogue_examples: () => [{ role: 'system', content: f.mesExamples }],
                chat_history: () => (prepared.history ?? []).map(h => ({ role: h.narrator ? 'system' : h.role, content: h.content })),
                user_input: () => [{ role: 'user', content: sub(userInput) }],
            };
            for (const p of cfg.ordered_prompts ?? RAW_PROMPT_ORDER) {
                if (typeof p === 'string') messages.push(...(builtin[p]?.() ?? []));
                else if (p && typeof p === 'object' && p.content !== undefined) messages.push({ role: p.role ?? 'system', content: sub(p.content) });
            }
            // 没排进 ordered_prompts 的额外注入放在最后一条之前
            for (const x of injects) messages.splice(Math.max(0, messages.length - Number(x.depth ?? 0)), 0, { role: x.role ?? 'system', content: sub(x.content) });
        } else {
            messages = prepared.messages;
            prefill = prepared.prefill;
        }
    } else {
        for (const p of cfg.ordered_prompts ?? ['user_input']) {
            if (p === 'user_input') messages.push({ role: 'user', content: userInput });
            else if (p && typeof p === 'object' && p.content !== undefined) messages.push({ role: p.role ?? 'system', content: String(p.content) });
        }
    }
    messages = messages.filter(m => m && typeof m.content === 'string' && m.content.trim());
    if (!messages.length) throw new Error('没有可以发送的提示词');
    ui.transformPrompt?.(messages);

    const params = samplerParams(state.preset?.data ?? {});
    for (const k of ['max_tokens', 'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k']) {
        const v = cfg.custom_api?.[k];
        if (typeof v === 'number') params[k] = v;
    }
    const stream = !!cfg.should_stream;
    // 脚本发起的请求同样经过 CHAT_COMPLETION_SETTINGS_READY（酒馆里所有对话补全请求都会）
    messages = (await settingsReady(conn, params, messages, session?.names)).messages;
    const images = await collectImages(cfg, conn.provider);
    const tools = Array.isArray(cfg.tools) && cfg.tools.length ? cfg.tools : null;
    const jsonSchema = !tools && cfg.json_schema && typeof cfg.json_schema === 'object' ? cfg.json_schema : null;
    const req = buildRequest({ ...conn, stream }, { messages, prefill, params, names: session?.names ?? { user: 'User', char: 'Assistant' }, images, tools, toolChoice: cfg.tool_choice ?? null, jsonSchema });

    const ac = new AbortController();
    scriptGens.set(id, { ac, silent: !!cfg.should_silence });
    if (!cfg.should_silence) ui.setStatus?.('脚本正在请求生成…');
    await eventSource.emit('js_generation_started', id);
    let last = '';
    const onDelta = (text) => {
        if (!stream || text === last) return;
        const inc = text.startsWith(last) ? text.slice(last.length) : text;
        last = text;
        eventSource.emit('js_stream_token_received_fully', text, id);
        eventSource.emit('js_stream_token_received_incrementally', inc, id);
        // 脚本自己发起的生成不写聊天，卡片界面手里的聊天快照没变：只发事件，不再每个字都附一整份聊天
        broadcastQuiet('js_stream_token_received_fully', text, id);
        broadcastQuiet('js_stream_token_received_incrementally', inc, id);
    };
    try {
        const send = () => (custom
            ? requestOnce(conn, req, ac.signal, onDelta, (payload, signal) => requestCustom(custom, payload, signal))
            : requestOnce(conn, req, ac.signal, onDelta));
        const retry = state.settings.retry ?? {};
        const max = retry.enabled && !custom ? Number(retry.maxRetries ?? 2) : 0;
        let r, err;
        for (let attempt = 0; attempt <= max; attempt++) {
            if (attempt > 0) await sleep(Number(retry.delayMs ?? 2000) * attempt);
            if (ac.signal.aborted) break;
            try { r = await send(); break; } catch (e) {
                err = e;
                if (ac.signal.aborted || e.name === 'AbortError' || !(e instanceof GenError) || !e.retryable) break;
            }
        }
        if (!r) {
            if (ac.signal.aborted) throw new Error('生成已停止');
            throw err ?? new Error('生成失败');
        }
        const sp = splitThinking(r.text);
        let content = sp.reasoning || sp.open ? sp.text : r.text;
        const reasoning = [r.reasoning, sp.reasoning].filter(Boolean).join('\n\n');
        let toolCalls = r.toolCalls ?? [];
        // Claude 的结构化输出是借一个强制工具做的：结果就是那个工具的参数
        if (jsonSchema && toolCalls.length && !String(content).trim()) { content = toolCalls[0].function.arguments; toolCalls = []; }
        if (!tools) toolCalls = [];
        await eventSource.emit('js_generation_ended', content, id);
        broadcastEvent('js_generation_ended', content, id);
        if (!cfg.should_return_reasoning && !toolCalls.length) return content;
        return { content, ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    } finally {
        scriptGens.delete(id);
        if (!cfg.should_silence && !state.generating) ui.setStatus?.('');
    }
}

/** 图片输入：File / Blob / 链接 / data URL / 裸 base64 都转成模型能用的地址（Gemini 只收内嵌数据，链接会先下载） */
async function collectImages(cfg, provider) {
    const raw = [];
    const take = (v) => { if (Array.isArray(v)) raw.push(...v); else if (v) raw.push(v); };
    take(cfg.image);
    for (const p of [...(cfg.ordered_prompts ?? []), ...(cfg.overrides?.chat_history?.prompts ?? [])]) if (p && typeof p === 'object') take(p.image);
    const toDataUrl = (blob) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
    });
    const out = [];
    for (const v of raw) {
        try {
            if (typeof Blob !== 'undefined' && v instanceof Blob) { out.push(await toDataUrl(v)); continue; }
            const str = String(v).trim();
            if (!str) continue;
            if (/^data:/i.test(str)) { out.push(str); continue; }
            if (/^(https?:)?\/\//i.test(str) || str.startsWith('/')) {
                if (provider === 'gemini' || str.startsWith('/')) {
                    try { const r = await fetch(str); if (r.ok) { out.push(await toDataUrl(await r.blob())); continue; } } catch { /* 跨域下载不了就直接给链接 */ }
                }
                out.push(new URL(str, location.href).href);
                continue;
            }
            out.push(`data:image/png;base64,${str}`);
        } catch (e) {
            console.warn('[生成] 图片读取失败', e);
        }
    }
    return out;
}

/** 酒馆助手的 getModelList：给一个接口地址和 key，列出它的模型（经本地服务转发，避开跨域） */
export async function listModelsOf(custom = {}) {
    const presetName = String(custom.proxy_preset ?? '').trim();
    const named = presetName ? state.settings.connections.find(c => c.name === presetName) : null;
    if (named || !custom.apiurl) {
        const conn = named ?? activeConnection();
        if (!conn) throw new Error('还没有配置 API 连接');
        const res = await api.llm(conn.id, { path: modelsPath(conn.provider), method: 'GET' });
        const text = await res.text();
        if (!res.ok) throw new Error(`获取模型列表失败（${res.status}）：${text.slice(0, 200)}`);
        return parseModelList(conn.provider, JSON.parse(text));
    }
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_completion_source: 'custom', reverse_proxy: String(custom.apiurl), proxy_password: String(custom.key ?? '') }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`获取模型列表失败（${res.status}）：${text.slice(0, 200)}`);
    return parseModelList('openai', JSON.parse(text));
}

export function stopScriptGeneration(id) {
    const g = scriptGens.get(String(id));
    if (!g) return false;
    g.ac.abort();
    return true;
}

export function stopAllScriptGeneration() {
    const any = scriptGens.size > 0;
    for (const g of scriptGens.values()) g.ac.abort();
    return any;
}

/** 静默生成（前端卡 / 斜杠命令 / EJS 用），不写入聊天 */
export async function generateQuiet(cfg = {}) {
    const r = await scriptGenerate({ quiet_prompt: cfg.user_input ?? cfg.prompt ?? cfg.quietPrompt ?? '', should_silence: cfg.should_silence ?? false });
    return typeof r === 'string' ? r : r?.content ?? '';
}

/** 预览：只组提示词不发送 */
export async function previewPrompt(type = 'normal') {
    const session = getSession();
    if (!session) return null;
    const res = await session.preparePrompt({ type, dryRun: true });
    const conn = activeConnection();
    const req = conn ? buildRequest(conn, { messages: res.messages, prefill: res.prefill, params: samplerParams(state.preset.data), names: session.names }) : null;
    return { ...res, request: req };
}

export { refresh };
