// 本地假模型服务：OpenAI / Claude / Gemini 三种格式（流式/非流式），用于端到端测试，不花真实额度。
// 用法：node tools/mock-llm.mjs [端口=8799]
// 回复内容按最后一条用户消息里的关键字变化：
//   ERR429      第一次返回 429，重试后正常
//   ERRTEXT     返回 200 但正文是“failed with status 429”（模拟中转把报错当正文）
//   EMPTY       返回空回复（第一次），之后正常
//   SLOW        每个分片间隔 120ms（方便测试中途停止）
//   MVU         回复里带 <UpdateVariable> JSONPatch
//   HTML        回复里带一个完整 HTML 前端代码块
//   THINK       回复以 <think>…</think> 开头
// GET /last 返回最近一次收到的请求（路径 + 请求体），GET /count 返回各关键字已触发次数
import http from 'node:http';

const port = Number(process.argv[2] ?? 8799);
let last = null;
const counters = {};

function lastUserText(body) {
    if (Array.isArray(body?.messages)) {
        const u = [...body.messages].reverse().find(m => m.role === 'user');
        if (!u) return '';
        return typeof u.content === 'string' ? u.content : (u.content ?? []).map(p => p.text ?? '').join('');
    }
    if (Array.isArray(body?.contents)) {
        const u = [...body.contents].reverse().find(c => c.role === 'user');
        return (u?.parts ?? []).map(p => p.text ?? '').join('');
    }
    return '';
}

function makeReply(text) {
    const parts = [];
    let reasoning = '';
    if (/THINK/.test(text)) reasoning = '先想一想：用户想看思维链拆分。';
    parts.push(`收到。你说的是「${text.slice(-40).replace(/\s+/g, ' ')}」。`);
    parts.push('\n\n*她抬起头，看向窗外。*"今天的风有点大。"');
    if (/MVU/.test(text)) {
        parts.push('\n\n<UpdateVariable>\n<Analysis>好感上升</Analysis>\n<JSONPatch>\n[{"op":"delta","path":"/好感度","value":5},{"op":"replace","path":"/地点","value":"图书馆"}]\n</JSONPatch>\n</UpdateVariable>');
    }
    if (/HTML/.test(text)) {
        parts.push('\n\n```html\n<!doctype html><html><head><style>body{font-family:sans-serif;color:#c96}.box{padding:8px;border:1px solid #c96;border-radius:8px}</style></head><body><div class="box" id="b">加载中</div><script>\nconst v = getAllVariables();\ndocument.getElementById("b").textContent = "前端卡：楼层 " + getCurrentMessageId() + "，好感度 " + JSON.stringify(_.get(v, "stat_data.好感度"));\n</script></body></html>\n```');
    }
    if (/SLOW/.test(text)) parts.push('\n\n' + '她慢慢合上书，把它放回书架。'.repeat(20) + '【结束】');
    const body = parts.join('');
    return { text: reasoning ? `<think>${reasoning}</think>\n${body}` : body, reasoning: '' };
}

function chunks(s, n = 6) {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function once(key) {
    counters[key] = (counters[key] ?? 0) + 1;
    return counters[key] === 1;
}

async function readBody(req) {
    const bufs = [];
    for await (const c of req) bufs.push(c);
    const t = Buffer.concat(bufs).toString('utf8');
    try { return t ? JSON.parse(t) : {}; } catch { return { raw: t }; }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/last') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(last)); return; }
    if (req.method === 'GET' && p === '/count') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(counters)); return; }
    if (req.method === 'GET' && /\/models$/.test(p)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (p.startsWith('/v1beta')) res.end(JSON.stringify({ models: [{ name: 'models/gemini-mock' }, { name: 'models/gemini-mock-pro' }] }));
        else res.end(JSON.stringify({ data: [{ id: 'mock-gpt' }, { id: 'mock-claude' }, { id: 'mock-big' }] }));
        return;
    }
    if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
    const body = await readBody(req);
    last = { path: p + url.search, headers: { auth: req.headers.authorization ? 'Bearer ***' : undefined, 'x-api-key': req.headers['x-api-key'] ? '***' : undefined, 'x-goog-api-key': req.headers['x-goog-api-key'] ? '***' : undefined }, body };
    const userText = lastUserText(body);
    const slow = /SLOW/.test(userText);

    if (/ERR429/.test(userText) && once('ERR429')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit (mock)' } }));
        return;
    }
    let reply = makeReply(userText);
    if (/ERRTEXT/.test(userText) && once('ERRTEXT')) reply = { text: 'Request failed with status 429: upstream busy', reasoning: '' };
    if (/EMPTY/.test(userText) && once('EMPTY')) reply = { text: '', reasoning: '' };

    // Claude
    if (p.endsWith('/v1/messages')) {
        if (!body.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', content: [{ type: 'text', text: reply.text }], stop_reason: 'end_turn' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', { type: 'message_start', message: { id: 'msg_mock', role: 'assistant', content: [] } });
        if (body.thinking) {
            send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Claude 的思考过程（mock）' } });
        }
        send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
        for (const c of chunks(reply.text)) {
            if (res.destroyed) return;
            send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: c } });
            await sleep(slow ? 120 : 8);
        }
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
    }
    // Gemini
    if (p.includes(':generateContent') || p.includes(':streamGenerateContent')) {
        const stream = p.includes(':streamGenerateContent');
        if (!stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: reply.text }] }, finishReason: 'STOP' }] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (body.generationConfig?.thinkingConfig?.includeThoughts) {
            res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini 思考（mock）', thought: true }] } }] })}\n\n`);
        }
        for (const c of chunks(reply.text, 10)) {
            if (res.destroyed) return;
            res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: c }] } }] })}\n\n`);
            await sleep(slow ? 120 : 8);
        }
        res.end();
        return;
    }
    // OpenAI 兼容
    if (p.endsWith('/chat/completions')) {
        if (!body.stream) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.text }, finish_reason: 'stop' }] }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const c of chunks(reply.text)) {
            if (res.destroyed) return;
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: c } }] })}\n\n`);
            await sleep(slow ? 120 : 8);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock 不认识的路径 ${p}` } }));
});

server.listen(port, '127.0.0.1', () => console.log(`mock LLM 已启动 http://127.0.0.1:${port}`));
