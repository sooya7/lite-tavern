// 服务器代生成的任务表。思路照 Luker（src/endpoints/backends/luker-generation.js）：
// - 页面发起生成时带上任务号和要写到哪（聊天、楼层 / swipe、生成类型），由服务器去请求模型；页面断开不影响，只有显式取消才断开上游
// - 每个事件（增量、重试、完成、出错…）带递增的 seq 存在内存里；页面凭任务号 + 已收到的 seq 重新订阅，服务器只补发后面的
// - 完成后进入 awaiting_ack：页面在线就由页面照常收尾（正则、变量、脚本事件），保存聊天时带上任务号 = 确认；
//   宽限期（默认 15 秒，页面收尾期间会续期）内没确认，服务器自己写进聊天（gen-persist.mjs），连变量一起算好
// - 任务保留 2 小时；服务器重启就没了（页面会收到 404，按“任务丢了”处理）
// 和 Luker 的差别：推送用 SSE 而不是 WebSocket（只有服务器往页面推，SSE 够用，nginx 已按流式配置）；确认和保存是同一个请求。
import { HttpError } from './http.mjs';
import { openUpstream } from './proxy.mjs';
import { readLlmResponse, generateWithRetry, GenError, DEFAULT_RETRY } from '../public/js/core/llm.js';
import { persistReply } from './gen-persist.mjs';

export const JOB_TTL_MS = 2 * 60 * 60 * 1000;
/** 还没完的状态：同一个聊天有这些状态的任务时不再接新的 */
const BUSY = new Set(['running', 'awaiting_ack', 'persisting']);
/** 页面打开聊天时要知道的：没完成的、等确认的、服务器正在写 / 没写成的（页面可以接手） */
const ACTIVE = new Set(['running', 'awaiting_ack', 'persisting', 'persist_failed']);
const TYPES = new Set(['normal', 'swipe', 'continue']);
/** 到头的状态：之后不会再有事件 */
const FINAL = new Set(['failed', 'cancelled', 'persisted', 'acked']);

const chatKeyOf = (char, name) => `${char}\u0000${name}`;

export class GenJobs {
    /**
     * @param {import('./store.mjs').Store} store
     * @param {{graceMs?: number, ttlMs?: number, heartbeatMs?: number, coalesceMs?: number, persist?: Function}} [o]
     */
    constructor(store, { graceMs = 15000, ttlMs = JOB_TTL_MS, heartbeatMs = 10000, coalesceMs = 40, persist = persistReply } = {}) {
        this.store = store;
        this.graceMs = graceMs;
        this.ttlMs = ttlMs;
        this.heartbeatMs = heartbeatMs;
        this.coalesceMs = coalesceMs;
        this.persistFn = persist;
        /** @type {Map<string, object>} */
        this.jobs = new Map();
        this.pruneTimer = setInterval(() => this.prune(), 10 * 60 * 1000);
        this.pruneTimer.unref?.();
    }

    get(id) {
        return this.jobs.get(String(id ?? '')) ?? null;
    }

    mustGet(id) {
        const job = this.get(id);
        if (!job) throw new HttpError(404, '没有这个生成任务（可能已经过期，或者服务器重启过）', 'gen-missing');
        return job;
    }

    /** 给页面看的任务摘要 */
    summary(job) {
        return {
            id: job.id, status: job.status, chat: { char: job.char, name: job.name }, target: job.target,
            provider: job.provider, model: job.model, conn: job.conn, started: job.started, lastSeq: job.seq,
            ...(job.error ? { error: job.error } : {}), ...(job.persisted ? { persisted: job.persisted } : {}),
        };
    }

    /** 页面发起生成 */
    create(body) {
        const b = body ?? {};
        const id = String(b.id ?? '');
        if (!/^[\w-]{6,80}$/.test(id)) throw new HttpError(400, '任务号不对');
        if (this.jobs.has(id)) throw new HttpError(409, '这个任务号已经用过了', 'gen-exists');
        const req = b.request ?? {};
        if (typeof req.path !== 'string' || !req.body || typeof req.body !== 'object') throw new HttpError(400, '缺少请求内容');
        const chat = b.chat ?? {};
        if (!chat.char || !chat.name || !chat.file) throw new HttpError(400, '缺少目标聊天');
        const target = b.target ?? {};
        if (!TYPES.has(target.type) || !Number.isInteger(target.index) || target.index < 0) throw new HttpError(400, '写入位置不对');
        if (!b.conn) throw new HttpError(400, '缺少连接');
        const chatKey = chatKeyOf(chat.char, chat.name);
        for (const j of this.jobs.values()) {
            if (j.chatKey === chatKey && BUSY.has(j.status)) throw new HttpError(409, '这个聊天还有一次生成没结束（可能在别的窗口），等它结束再发', 'gen-busy');
        }
        const now = Date.now();
        const job = {
            id, chatKey, char: String(chat.char), name: String(chat.name), file: String(chat.file),
            target: { ...target }, preset: String(b.preset ?? ''), conn: String(b.conn),
            provider: String(b.provider ?? 'openai'), model: String(b.model ?? ''),
            started: String(b.started ?? new Date(now).toISOString()),
            tzOffset: Number.isFinite(Number(b.tzOffset)) ? Number(b.tzOffset) : undefined,
            request: { path: req.path, method: req.method || 'POST', body: req.body, stream: !!req.stream },
            status: 'running', seq: 0, events: [], subs: new Set(),
            text: '', reasoning: '', error: '', createdAt: now, updatedAt: now,
            ac: new AbortController(), deadline: 0, timer: null, clientSaving: false, persisted: null,
        };
        this.jobs.set(id, job);
        this.run(job).catch((e) => {
            console.error('[代生成] 任务异常', e);
            if (job.status === 'running') this.fail(job, e);
        });
        return this.summary(job);
    }

    /** 记一个事件并推给所有订阅者 */
    emit(job, data) {
        const ev = { seq: ++job.seq, ...data };
        job.events.push(ev);
        job.updatedAt = Date.now();
        for (const s of job.subs) s.send(ev);
        if (FINAL.has(job.status)) this.endSubs(job);
        return ev;
    }

    /** 任务到头了（不会再有新事件）：断开所有订阅，别占着连接 */
    endSubs(job) {
        for (const s of [...job.subs]) s.end();
        job.subs.clear();
    }

    fail(job, e) {
        job.status = 'failed';
        job.error = String(e?.message ?? e ?? '生成失败');
        this.emit(job, { type: 'error', message: job.error, ...(e?.status ? { status: e.status } : {}) });
    }

    /** 请求上游（按设置重试），把增量攒一小会儿再发（几十毫秒一批，事件不至于太碎） */
    async run(job) {
        const settings = await this.store.getSettings();
        const retry = { ...DEFAULT_RETRY, ...(settings.retry ?? {}) };
        let sentT = 0, sentR = 0, cur = { text: '', reasoning: '' }, flushTimer = null;
        const flush = () => {
            clearTimeout(flushTimer);
            flushTimer = null;
            const t = cur.text.length > sentT ? cur.text.slice(sentT) : '';
            const r = cur.reasoning.length > sentR ? cur.reasoning.slice(sentR) : '';
            if (!t && !r) return;
            sentT = cur.text.length;
            sentR = cur.reasoning.length;
            this.emit(job, { type: 'delta', ...(t ? { t } : {}), ...(r ? { r } : {}) });
        };
        const onDelta = (text, reasoning) => {
            cur = { text, reasoning };
            job.text = text;
            job.reasoning = reasoning;
            if (!flushTimer) flushTimer = setTimeout(flush, this.coalesceMs);
        };
        const signal = job.ac.signal;
        const out = await generateWithRetry(async () => {
            let res;
            try {
                res = await openUpstream(this.store, job.conn, job.request, signal);
            } catch (e) {
                // 连不上：和页面经代理请求时一样算 502，可以重试
                if (e instanceof HttpError) throw new GenError(e.status === 502 ? e.message : `接口报错（${e.status}）：${e.message}`, { retryable: e.status >= 500, status: e.status });
                throw e;
            }
            return readLlmResponse(job.provider, job.request, res, onDelta);
        }, {
            retry,
            signal,
            onRetry: (n) => {
                flush();
                cur = { text: '', reasoning: '' };
                sentT = sentR = 0;
                this.emit(job, { type: 'reset', attempt: n });
                this.emit(job, { type: 'status', text: `第 ${n} 次重试…` });
            },
            log: (e) => console.warn(`[代生成] ${job.id} 失败：${e.message}`),
        });
        flush();
        job.doneAt = Date.now();
        if (signal.aborted || job.status === 'cancelled') {
            job.status = 'cancelled';
            this.emit(job, { type: 'cancelled', text: cur.text, reasoning: cur.reasoning });
            return;
        }
        if (!out.result) {
            this.fail(job, out.error ?? new Error('生成失败'));
            return;
        }
        job.text = out.result.text;
        job.reasoning = out.result.reasoning ?? '';
        job.status = 'awaiting_ack';
        job.deadline = Date.now() + this.graceMs;
        this.emit(job, { type: 'done', text: job.text, reasoning: job.reasoning });
        this.schedule(job);
    }

    /** 宽限期到点检查：页面认领过就顺延，页面正在保存就再等一下 */
    schedule(job) {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => this.check(job), Math.max(0, job.deadline - Date.now()) + 5);
        job.timer.unref?.();
    }

    check(job) {
        if (job.status !== 'awaiting_ack') return;
        if (job.clientSaving) job.deadline = Math.max(job.deadline, Date.now() + 2000);
        if (Date.now() < job.deadline) { this.schedule(job); return; }
        this.persist(job);
    }

    /** 页面没来：服务器自己写进聊天 */
    async persist(job) {
        job.status = 'persisting';
        this.emit(job, { type: 'persisting' });
        try {
            const r = await this.persistFn(this.store, job);
            job.persisted = r;
            job.status = 'persisted';
            this.emit(job, { type: 'persisted', ...r });
        } catch (e) {
            console.error(`[代生成] ${job.id} 写入聊天失败`, e);
            job.status = 'persist_failed';
            job.error = String(e?.message ?? e);
            this.emit(job, { type: 'persist_failed', message: job.error });
        }
    }

    /** 用户点了停止。返回停下时的状态和已经生成的部分 */
    cancel(id) {
        const job = this.mustGet(id);
        if (job.status === 'running') {
            job.status = 'cancelled';
            job.ac.abort();
        } else if (job.status === 'awaiting_ack' || job.status === 'persist_failed') {
            // 已经收齐了但页面说停：页面自己收尾（保留它已经显示的部分），服务器不再替它写
            clearTimeout(job.timer);
            job.status = 'cancelled';
            this.emit(job, { type: 'cancelled', text: job.text, reasoning: job.reasoning });
        }
        return { status: job.status, text: job.text, reasoning: job.reasoning };
    }

    /** 页面收到完成、正在收尾：宽限期从现在起重新算。服务器写失败过的任务也可以由页面认领回去 */
    claim(id) {
        const job = this.mustGet(id);
        if (job.status === 'persist_failed') job.status = 'awaiting_ack';
        if (job.status === 'awaiting_ack') {
            job.deadline = Math.max(job.deadline, Date.now() + this.graceMs);
            this.schedule(job);
        }
        return { status: job.status };
    }

    /** 页面说这个任务不用管了（出错 / 停止后的收尾） */
    ack(id) {
        const job = this.mustGet(id);
        if (job.status === 'awaiting_ack' || job.status === 'persist_failed') {
            clearTimeout(job.timer);
            job.status = 'acked';
        }
        job.seen = true;
        if (FINAL.has(job.status)) this.endSubs(job);
        return { status: job.status };
    }

    /**
     * 页面带着任务号保存聊天（在聊天的写入锁里调用）。服务器已经在写 / 写过了就拒绝，页面改为载入服务器那份。
     * 返回任务（或 null：任务不在了，照常保存），保存完调 afterClientSave。
     */
    beforeClientSave(id) {
        const job = this.get(id);
        if (!job) return null;
        if (job.status === 'persisting' || job.status === 'persisted') {
            throw new HttpError(409, '页面不在的时候服务器已经把这次回复写进聊天了', 'gen-persisted');
        }
        // 两个窗口开着同一个聊天、都接着显示了这次生成：先保存的算数，后来的改为载入它存的那份
        if (job.status === 'acked') throw new HttpError(409, '这次回复已经在别的窗口保存过了', 'gen-persisted');
        job.clientSaving = true;
        return job;
    }

    afterClientSave(job, ok) {
        if (!job) return;
        job.clientSaving = false;
        if (ok && (job.status === 'awaiting_ack' || job.status === 'persist_failed')) {
            clearTimeout(job.timer);
            job.status = 'acked';
            job.updatedAt = Date.now();
            this.endSubs(job);
        }
    }

    /** 某个聊天在服务器上的任务（页面打开聊天、回到前台时问） */
    active(char, name) {
        const key = chatKeyOf(char, name);
        const out = [];
        for (const j of this.jobs.values()) {
            if (j.chatKey !== key) continue;
            if (ACTIVE.has(j.status) || j.status === 'persisted') out.push(this.summary(j));
        }
        return out.sort((a, b) => b.lastSeq - a.lastSeq);
    }

    /**
     * SSE 订阅：先补发 seq 大于 after 的事件，再推新的；定时发心跳注释（页面靠它判断连接活着）。
     * 任务已经到头（不会再有新事件）时补发完就结束。
     */
    subscribe(id, after, req, res) {
        const job = this.mustGet(id);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            Connection: 'keep-alive',
        });
        const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        res.write(': ok\n\n');
        for (const ev of job.events) if (ev.seq > after) send(ev);
        if (FINAL.has(job.status)) { res.end(); return; }
        const beat = setInterval(() => res.write(': ping\n\n'), this.heartbeatMs);
        const sub = { send, end: () => { clearInterval(beat); job.subs.delete(sub); res.end(); } };
        job.subs.add(sub);
        const done = () => { clearInterval(beat); job.subs.delete(sub); };
        res.on('close', done);
        res.on('error', done);
    }

    /** 过期的任务清掉；跑了 2 小时还没完的断开上游 */
    prune(now = Date.now()) {
        for (const [id, j] of this.jobs) {
            if (now - j.updatedAt < this.ttlMs && now - j.createdAt < this.ttlMs * 2) continue;
            if (j.status === 'running') j.ac.abort();
            if (j.status === 'persisting') continue;
            clearTimeout(j.timer);
            this.jobs.delete(id);
        }
    }

    close() {
        clearInterval(this.pruneTimer);
        for (const j of this.jobs.values()) { clearTimeout(j.timer); if (j.status === 'running') j.ac.abort(); }
    }
}
