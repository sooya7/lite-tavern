// 服务器代生成：任务表（断开不中断、seq 续传、取消、确认、同一聊天的保护）和服务器代写（回复 + 变量和页面算的一致）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { GenJobs } from '../server/gen-jobs.mjs';
import { buildServerSession } from '../server/gen-persist.mjs';
import { parseChatJsonl, serializeChat, createGreetingMessage, createUserMessage, newChatHeader, messageText } from '../public/js/core/chat.js';
import { cardGreetings } from '../public/js/core/card.js';
import { locateReply, placeLocated, placeReply, finalizeReply, separateReasoning, wantsSeparateVars, applyReplyVars, messageFingerprint } from '../public/js/core/reply.js';
import { updateVarsSeparately, mvuConnectionOf } from '../public/js/core/mvu-request.js';
import { readLlmResponse } from '../public/js/core/llm.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 假模型：OpenAI 兼容，流式一段一段慢慢发；变量更新请求回一个更新块 ----------
let upstream, upstreamUrl;
const hits = { main: 0, mvu: 0, aborted: 0 };
const REPLY = '<think>想一想</think>她点点头。"好的。"\n\n<UpdateVariable>\n<JSONPatch>\n[{"op":"delta","path":"/好感度","value":5}]\n</JSONPatch>\n</UpdateVariable>';
const PLAIN = '她慢慢合上书，把它放回书架。窗外下起了雨。【结束】';

function startUpstream() {
    return new Promise((resolve) => {
        upstream = http.createServer(async (req, res) => {
            const bufs = [];
            for await (const c of req) bufs.push(c);
            const body = JSON.parse(Buffer.concat(bufs).toString('utf8') || '{}');
            const whole = JSON.stringify(body);
            if (whole.includes('variable_update_task')) {
                hits.mvu++;
                const patch = [{ op: 'delta', path: '/好感度', value: 3 }, { op: 'replace', path: '/地点', value: '书库' }];
                const text = body.response_format ? JSON.stringify({ analysis: '单独更新', patch }) : `<UpdateVariable>\n<JSONPatch>\n${JSON.stringify(patch)}\n</JSONPatch>\n</UpdateVariable>`;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
                return;
            }
            hits.main++;
            const last = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
            if (/BAD400/.test(last)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'bad request (mock)' } }));
                return;
            }
            const reply = /PLAIN/.test(last) ? PLAIN : REPLY;
            const delay = /SLOW/.test(last) ? 40 : 2;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.on('close', () => { if (!res.writableEnded) hits.aborted++; });
            for (let i = 0; i < reply.length; i += 4) {
                if (res.destroyed) return;
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(i, i + 4) } }] })}\n\n`);
                await sleep(delay);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
        upstream.listen(0, '127.0.0.1', () => { upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`; resolve(); });
    });
}

// ---------- 数据目录：测试卡（MVU + 内嵌世界书 + 正则）、一个预设、一个聊天 ----------
let dir, store;
const CHAR = 'test';
const CONN = { id: 'c_mock', name: 'mock', provider: 'openai', baseUrl: '', model: 'mock-gpt', postProcessing: '', extraBody: '', extraHeaders: '' };

async function setupData() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gen-'));
    store = new Store(dir);
    fs.copyFileSync(path.join(ROOT, 'tools', 'fixtures', 'test-card.json'), path.join(dir, 'characters', `${CHAR}.json`));
    fs.writeFileSync(path.join(dir, 'presets', '默认.json'), JSON.stringify({ temperature: 0.8, openai_max_tokens: 300 }));
    await store.saveSettings({
        connections: [{ ...CONN, baseUrl: upstreamUrl }], activeConnection: CONN.id, activePreset: '默认',
        personas: [{ id: 'p', name: 'User', description: '' }], activePersona: 'p',
        power: { mvu: 'on' }, retry: { enabled: false },
    });
}

/** 新建一个聊天：开场白（变量初始化好）+ 一句用户消息。返回聊天名 */
let chatSeq = 0;
async function newChat(userText) {
    const name = `chat-${++chatSeq}`;
    const card = await store.readCard(`${CHAR}.json`);
    const header = newChatHeader('User', card.data.name);
    const messages = [createGreetingMessage(card.data.name, cardGreetings(card))];
    const { session } = await buildServerSession(store, { char: CHAR, file: `${CHAR}.json`, name, preset: '默认' }, serializeChat(header, messages));
    session.chat[0].mes = session.substitute(session.chat[0].mes);
    session.chat[0].swipes = session.chat[0].swipes.map(t => session.substitute(t));
    session.ensureMvuInit();
    session.chat.push(createUserMessage('User', userText));
    await store.saveChat(CHAR, name, serializeChat(header, session.chat));
    return name;
}

async function readChat(name) {
    return parseChatJsonl(await store.readChat(CHAR, name));
}

function jobBody(name, messages, userText, extra = {}) {
    const index = messages.length;
    return {
        id: `g_test_${Math.random().toString(36).slice(2, 10)}`,
        conn: CONN.id,
        request: { path: '/chat/completions', method: 'POST', stream: true, body: { model: 'mock-gpt', stream: true, messages: [{ role: 'user', content: userText }] } },
        chat: { char: CHAR, file: `${CHAR}.json`, name },
        target: { type: 'normal', index, anchor: messageFingerprint(messages[index - 1]) },
        preset: '默认',
        started: new Date().toISOString(),
        provider: 'openai',
        model: 'mock-gpt',
        tzOffset: new Date().getTimezoneOffset(),
        ...extra,
    };
}

/** 假的 SSE 响应：收集 data 事件 */
function fakeRes() {
    const r = {
        events: [], ended: false, handlers: {},
        writeHead() {},
        write(chunk) {
            for (const line of String(chunk).split('\n')) if (line.startsWith('data: ')) r.events.push(JSON.parse(line.slice(6)));
            return true;
        },
        end() { r.ended = true; r.handlers.close?.(); },
        on(ev, fn) { r.handlers[ev] = fn; },
        close() { r.handlers.close?.(); },
    };
    return r;
}

async function waitFor(fn, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = await fn();
        if (v) return v;
        await sleep(20);
    }
    throw new Error('等不到');
}

let jobs;
before(async () => {
    await startUpstream();
    await setupData();
    jobs = new GenJobs(store, { graceMs: 300, coalesceMs: 5, heartbeatMs: 1000 });
});
after(() => {
    jobs?.close();
    upstream?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** 页面那边收尾的同一串步骤（generate.js 的 completeReply），用来和服务器代写的结果比对 */
async function clientEquivalent(name, job) {
    const text = await store.readChat(CHAR, name);
    const { session, settings, preset } = await buildServerSession(store, job, text);
    const loc = locateReply(session.chat, job.target, job.id);
    const placed = placeLocated(session.chat, loc, job.target, { provider: job.provider, model: job.model, started: job.started, charName: session.names.char });
    const sep = separateReasoning(job.text, job.reasoning, true);
    finalizeReply(session, placed.index, { type: placed.type, text: sep.body, reasoning: sep.rsn, provider: job.provider, model: job.model, started: job.started, finished: new Date(job.doneAt), tzOffset: job.tzOffset });
    if (wantsSeparateVars(session, placed.index)) {
        await updateVarsSeparately(session, placed.index, undefined, {
            preset, presetName: '默认', conn: mvuConnectionOf(settings, settings.connections[0]),
            send: async (conn, req, signal) => readLlmResponse(conn.provider, req, await fetch(`${upstreamUrl}${req.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal })),
        });
    }
    await applyReplyVars(session, placed.index, null);
    return session.chat[placed.index];
}

test('代生成：页面断开后服务器照样生成完，宽限期内没人确认就写进聊天（随 AI 输出的变量）', async () => {
    const name = await newChat('你好');
    const { messages } = await readChat(name);
    const body = jobBody(name, messages, '你好');
    jobs.create(body);
    // 订阅一下就断开（页面切到后台）
    const r1 = fakeRes();
    jobs.subscribe(body.id, 0, {}, r1);
    await sleep(10);
    r1.close();
    const job = jobs.get(body.id);
    await waitFor(() => job.status === 'persisted');
    assert.equal(hits.aborted, 0, '页面断开不该断开上游');
    const after = await readChat(name);
    assert.equal(after.messages.length, messages.length + 1);
    const m = after.messages.at(-1);
    assert.match(m.mes, /她点点头/);
    assert.equal(m.extra.reasoning, '想一想', '思维链拆出来了');
    assert.equal(m.extra.lt_job, undefined, '占位的任务号去掉了');
    assert.equal(m.extra.lt_server_persisted.pending, true, '打了“服务器代写”标记');
    assert.equal(m.extra.lt_server_persisted.mvu, true);
    assert.equal(m.variables[0].stat_data.好感度, 15, '随 AI 输出的变量更新在服务器上算好了');
    // 和页面自己收尾算出来的一样（同一份聊天、同一个结果）
    const tmp = await newChat('你好');
    const job2 = { ...job, name: tmp, target: { ...job.target, anchor: messageFingerprint((await readChat(tmp)).messages.at(-1)) } };
    const expect = await clientEquivalent(tmp, job2);
    assert.equal(m.mes, expect.mes);
    assert.deepEqual(m.variables, expect.variables);
    assert.equal(m.send_date, expect.send_date);
});

test('代生成：额外模型解析的变量也在服务器上算（和页面一致）', async () => {
    const settings = await store.getSettings();
    await store.saveSettings({ ...settings, power: { ...settings.power, mvuSeparate: true } });
    try {
        const name = await newChat('PLAIN 讲个故事');
        const { messages } = await readChat(name);
        const body = jobBody(name, messages, 'PLAIN 讲个故事');
        const before = hits.mvu;
        jobs.create(body);
        const job = jobs.get(body.id);
        await waitFor(() => job.status === 'persisted');
        assert.ok(hits.mvu > before, '服务器发了变量更新请求');
        const m = (await readChat(name)).messages.at(-1);
        assert.match(m.mes, /<UpdateVariable>/, '更新块写回正文');
        assert.equal(m.variables[0].stat_data.好感度, 13);
        assert.equal(m.variables[0].stat_data.地点, '书库');
        const tmp = await newChat('PLAIN 讲个故事');
        const expect = await clientEquivalent(tmp, { ...job, name: tmp, target: { ...job.target, anchor: messageFingerprint((await readChat(tmp)).messages.at(-1)) } });
        assert.deepEqual(m.variables[0].stat_data, expect.variables[0].stat_data);
        assert.equal(m.mes, expect.mes);
    } finally {
        await store.saveSettings(settings);
    }
});

test('代生成：断开重连按 seq 续传，不丢也不重', async () => {
    const name = await newChat('SLOW 慢慢说');
    const { messages } = await readChat(name);
    const body = jobBody(name, messages, 'SLOW 慢慢说');
    jobs.create(body);
    const r1 = fakeRes();
    jobs.subscribe(body.id, 0, {}, r1);
    await sleep(250);
    r1.close();
    const got = r1.events.filter(e => e.type === 'delta');
    assert.ok(got.length > 0, '断开前收到了一部分');
    const lastSeq = r1.events.at(-1).seq;
    await sleep(150);
    const r2 = fakeRes();
    jobs.subscribe(body.id, lastSeq, {}, r2);
    await waitFor(() => r2.events.some(e => e.type === 'done'));
    assert.ok(r2.events.every(e => e.seq > lastSeq), '只补发后面的');
    const text = [...r1.events, ...r2.events].filter(e => e.type === 'delta').map(e => e.t ?? '').join('');
    const done = r2.events.find(e => e.type === 'done');
    assert.equal(text, done.text, '拼起来正好是全文');
    jobs.ack(body.id);
});

test('代生成：停止取消上游，服务器不再写；同一聊天不能同时开两个', async () => {
    const name = await newChat('SLOW 停止');
    const { messages } = await readChat(name);
    const body = jobBody(name, messages, 'SLOW 停止');
    jobs.create(body);
    assert.throws(() => jobs.create({ ...body, id: `${body.id}x` }), (e) => e.code === 'gen-busy');
    await sleep(120);
    const abortedBefore = hits.aborted;
    const r = jobs.cancel(body.id);
    assert.equal(r.status, 'cancelled');
    assert.ok(r.text.length > 0, '返回已经生成的部分');
    await waitFor(() => hits.aborted > abortedBefore);
    await sleep(500);
    assert.equal(jobs.get(body.id).status, 'cancelled');
    assert.equal((await readChat(name)).messages.length, messages.length, '取消后服务器不写');
    // 取消之后可以再开
    jobs.create({ ...body, id: `${body.id}y`, request: { ...body.request, body: { ...body.request.body, messages: [{ role: 'user', content: 'PLAIN' }] } } });
    await waitFor(() => jobs.get(`${body.id}y`).status === 'persisted');
});

test('代生成：页面带任务号保存 = 确认，服务器不会再写；服务器写过后页面的保存被拒', async () => {
    const name = await newChat('PLAIN 在线');
    const { messages } = await readChat(name);
    const body = jobBody(name, messages, 'PLAIN 在线');
    jobs.create(body);
    const job = jobs.get(body.id);
    await waitFor(() => job.status === 'awaiting_ack');
    // 页面收尾中：认领顺延宽限期
    jobs.claim(body.id);
    await sleep(200);
    jobs.claim(body.id);
    await sleep(200);
    assert.equal(job.status, 'awaiting_ack', '认领后宽限期顺延');
    // 页面保存（和 server.mjs 的 chatWrite 一样：锁里核对任务 → 写 → 确认）
    await store.withChatLock(CHAR, name, async () => {
        const j = jobs.beforeClientSave(body.id);
        const c = await readChat(name);
        c.messages.push({ name: '小林', is_user: false, mes: '页面写的', send_date: 'x' });
        await store.saveChat(CHAR, name, serializeChat(c.header, c.messages), { expect: await store.chatVersion(CHAR, name) });
        jobs.afterClientSave(j, true);
    });
    assert.equal(job.status, 'acked');
    // 另一个窗口也接着显示了这次生成，它再带任务号保存：被拒，改为载入
    assert.throws(() => jobs.beforeClientSave(body.id), (e) => e.code === 'gen-persisted');
    await sleep(600);
    const after = await readChat(name);
    assert.equal(after.messages.length, messages.length + 1, '没有重复写');
    assert.equal(after.messages.at(-1).mes, '页面写的');

    // 另一个任务：页面没来，服务器写了；页面回来再保存被拒（gen-persisted）
    const name2 = await newChat('PLAIN 离线');
    const m2 = (await readChat(name2)).messages;
    const b2 = jobBody(name2, m2, 'PLAIN 离线');
    jobs.create(b2);
    await waitFor(() => jobs.get(b2.id).status === 'persisted');
    assert.throws(() => jobs.beforeClientSave(b2.id), (e) => e.code === 'gen-persisted');
    assert.deepEqual(jobs.active(CHAR, name2).map(j => j.status), ['persisted']);
});

test('代生成：上游报错时任务失败、不写聊天；找不到任务时 404', async () => {
    const name = await newChat('BAD400');
    const { messages } = await readChat(name);
    const body = jobBody(name, messages, 'BAD400');
    jobs.create(body);
    const job = jobs.get(body.id);
    await waitFor(() => job.status === 'failed');
    assert.match(job.error, /400/);
    const r = fakeRes();
    jobs.subscribe(body.id, 0, {}, r);
    assert.equal(r.events.at(-1).type, 'error');
    assert.ok(r.ended, '到头的任务补发完就结束');
    await sleep(400);
    assert.equal((await readChat(name)).messages.length, messages.length);
    assert.throws(() => jobs.claim('g_nope_123'), (e) => e.status === 404);
});

test('代生成：写入位置的认法（追加 / 重新生成 / swipe / 续写 / 占位 / 对不上）', () => {
    const u = { name: 'U', is_user: true, send_date: 'a', mes: '你好' };
    const a = { name: 'C', is_user: false, send_date: 'b', mes: '旧回复', swipes: ['旧回复'], swipe_id: 0, swipe_info: [{}] };
    const fpU = messageFingerprint(u);
    assert.equal(locateReply([u], { type: 'normal', index: 1, anchor: fpU }).kind, 'append');
    assert.equal(locateReply([u, a], { type: 'normal', index: 1, anchor: fpU, replace: messageFingerprint(a) }).kind, 'replace');
    assert.equal(locateReply([u, a], { type: 'normal', index: 1, anchor: fpU }).kind, 'orphan');
    assert.equal(locateReply([u, a], { type: 'swipe', index: 1, swipeId: 1, anchor: fpU }).kind, 'swipe');
    assert.equal(locateReply([u, a], { type: 'swipe', index: 1, swipeId: 2, anchor: fpU }).kind, 'orphan');
    assert.equal(locateReply([u, a], { type: 'continue', index: 1, baseText: '旧回复', anchor: fpU }).kind, 'continue');
    assert.equal(locateReply([u, { ...a, mes: '改过' }], { type: 'continue', index: 1, baseText: '旧回复', anchor: fpU }).kind, 'orphan');
    // 生成途中保存过：占位带着任务号
    const chat = [u];
    placeReply(chat, { type: 'normal', provider: 'openai', model: 'm', started: new Date(), jobId: 'g_1', charName: 'C' });
    assert.deepEqual(locateReply(chat, { type: 'normal', index: 1, anchor: 'x' }, 'g_1'), { kind: 'placeholder', index: 1 });
    const placed = placeLocated(chat, { kind: 'placeholder', index: 1 }, {}, { provider: 'openai', model: 'm', started: new Date().toISOString(), charName: 'C' });
    assert.equal(placed.index, 1);
    assert.equal(chat.length, 2);
    const sw = [u, structuredClone(a)];
    placeReply(sw, { type: 'swipe', index: 1, provider: 'openai', model: 'm', started: new Date(), jobId: 'g_2', charName: 'C' });
    assert.equal(locateReply(sw, { type: 'swipe', index: 1, swipeId: 1, anchor: fpU }, 'g_2').kind, 'swipe-placeholder');
    assert.equal(messageText(sw[1]), '');
});
