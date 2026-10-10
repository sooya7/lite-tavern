// 服务器代生成的前端一侧：开任务、收流（断了按 seq 续上）、停止、认领、找回没完成的任务、补发服务器代写楼层的事件。
// 服务端在 server/gen-jobs.mjs。为什么要这样：手机把页面切到后台 / 锁屏 / 关掉之后，浏览器里的请求会被掐断；
// 改成服务器去请求模型，页面只是“看”，看不到了也不影响生成，回来接着看；页面一直没回来，服务器自己把回复和变量写进聊天。
import { PROTOCOL } from './api.js';
import { readSSE } from './core/providers.js';
import { sleep } from './core/util.js';

const enc = encodeURIComponent;
/** 服务端每 10 秒发一次心跳；超过这么久一个字节都没收到，就当连接已经死了（手机切后台回来常见），重连 */
const STALE_MS = 25000;

/** 正在收的流（visibilitychange / online 时踢一下，让它马上重连） */
const live = new Set();

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LT-Client': PROTOCOL },
        body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
        const err = new Error(data?.error?.message ?? `请求失败 ${res.status}`);
        err.status = res.status;
        err.code = data?.error?.code ?? '';
        throw err;
    }
    return data;
}

/**
 * 开一个任务。body：{id, conn, request: {path, method, body, stream}, chat: {char, file, name}, target, preset, started, provider, model, tzOffset}
 * 服务器不支持（旧服务端）时抛 err.status === 404。
 */
export const startJob = (body) => post('/api/gen', body);

/** 用户点停止：服务器断开上游。返回 {status, text, reasoning}（停下时已经生成的部分） */
export const cancelJob = (id) => post(`/api/gen/${enc(id)}/abort`).catch(e => ({ status: e.status === 404 ? 'missing' : 'error', error: e.message }));

/** 收到完成之后：告诉服务器“我在处理，先别替我写”。返回任务当前状态（服务器已经接手时是 persisting / persisted） */
export const claimJob = (id) => post(`/api/gen/${enc(id)}/claim`).catch(e => ({ status: e.status === 404 ? 'missing' : 'error' }));

/** 不用服务器再管了（出错、取消之后的收尾） */
export const ackJob = (id) => post(`/api/gen/${enc(id)}/ack`).catch(() => null);

/** 这个聊天在服务器上的任务（没完成的、等确认的、服务器刚替页面写进去的） */
export async function activeJobs(charId, chatName) {
    try {
        const res = await fetch(`/api/gen/active?char=${enc(charId)}&chat=${enc(chatName)}`, { cache: 'no-store' });
        if (!res.ok) return [];
        return (await res.json()) ?? [];
    } catch {
        return [];
    }
}

/** 页面回到前台 / 网络恢复：正在收的流马上重连（不等心跳超时） */
export function kickStreams() {
    for (const s of live) s.kick();
}

/**
 * 收一个任务的事件，直到它有结果。断线自动重连，带上已经收到的最后一个 seq，服务器只补发后面的，不丢也不重。
 * onEvent(ev) 收每个事件（delta / reset / status / persisting …）。
 * @param {{after?: number, signal?: AbortSignal, onEvent?: (ev: object) => void, onDone?: (ev: object) => Promise<boolean>}} o
 *   onDone 收到完成事件时调用，返回 true = 就此结束（页面接手），false = 接着收（服务器已经在替页面写，等它写完）
 * @returns {Promise<{kind: 'done'|'error'|'cancelled'|'persisted'|'persist_failed'|'lost'|'aborted', ev?: object, lastSeq: number}>}
 */
export function streamJob(id, { after = 0, signal, onEvent, onDone } = {}) {
    let lastSeq = after;
    let inner = null;
    let wake = null;
    const handle = {
        kick() {
            inner?.abort();
            wake?.();
        },
    };
    live.add(handle);
    const run = async () => {
        let failures = 0;
        while (true) {
            if (signal?.aborted) return { kind: 'aborted', lastSeq };
            inner = new AbortController();
            const onAbort = () => inner.abort();
            signal?.addEventListener('abort', onAbort, { once: true });
            let watchdog = null;
            const pet = () => {
                clearTimeout(watchdog);
                watchdog = setTimeout(() => inner.abort(), STALE_MS);
            };
            try {
                pet();
                const res = await fetch(`/api/gen/${enc(id)}/events?after=${lastSeq}`, { signal: inner.signal, cache: 'no-store' });
                if (res.status === 404) return { kind: 'lost', lastSeq };
                if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
                failures = 0;
                // 心跳是注释行，readSSE 不交出来；所以看原始字节来判断连接活着
                const body = res.body.pipeThrough(new TransformStream({ transform(chunk, ctl) { pet(); ctl.enqueue(chunk); } }));
                for await (const raw of readSSE(body)) {
                    let ev;
                    try { ev = JSON.parse(raw.data); } catch { continue; }
                    if (typeof ev.seq !== 'number' || ev.seq <= lastSeq) continue;
                    lastSeq = ev.seq;
                    if (ev.type === 'done') {
                        if (!onDone || await onDone(ev)) return { kind: 'done', ev, lastSeq };
                        continue;
                    }
                    if (ev.type === 'error' || ev.type === 'cancelled' || ev.type === 'persisted' || ev.type === 'persist_failed') return { kind: ev.type, ev, lastSeq };
                    onEvent?.(ev);
                }
            } catch (e) {
                if (signal?.aborted) return { kind: 'aborted', lastSeq };
                if (!inner.signal.aborted) failures++;
            } finally {
                clearTimeout(watchdog);
                signal?.removeEventListener('abort', onAbort);
            }
            if (signal?.aborted) return { kind: 'aborted', lastSeq };
            // 连接断了：等一会儿再连（被 kick 叫醒就马上连）
            const delay = Math.min(5000, 500 * 2 ** Math.min(failures, 4));
            await Promise.race([sleep(failures ? delay : 200), new Promise(r => { wake = r; })]);
            wake = null;
        }
    };
    // 不管怎么结束都把连接断掉：浏览器对同一个站点只开 6 个连接，留着不关的流会把后面的请求（保存、认领）堵住
    return run().finally(() => { live.delete(handle); inner?.abort(); });
}

/** 服务器支持代生成吗（/api/ping 的 genJobs） */
export const jobsSupported = (server) => !!server?.genJobs;

