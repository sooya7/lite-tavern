import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacroEngine, objectScope } from '../public/js/core/macros.js';
import { runRegexScript, getRegexedString, REGEX_PLACEMENT } from '../public/js/core/regex.js';
import { checkWorldInfo, getSortedEntries, newWorldInfoEntry, parseDecorators, WI_POSITION, WI_LOGIC } from '../public/js/core/worldinfo.js';
import { render } from '../public/js/core/ejs.js';
import { applyCommands, parseCommands, extractUpdateBlocks, processMessage, collectInitVars } from '../public/js/core/mvu.js';
import { buildChatCompletion, parseMesExamples, parseExampleIntoIndividual } from '../public/js/core/prompt.js';
import { normalizePreset, newCustomPrompt } from '../public/js/core/preset.js';
import { postProcessMessages, buildRequest, splitThinking, parseStreamEvent } from '../public/js/core/providers.js';
import { writeCardPng, readCardJson, BLANK_PNG } from '../public/js/core/png.js';
import { parseChatJsonl, serializeChat, addSwipe, setSwipe } from '../public/js/core/chat.js';
import { VariableManager } from '../public/js/core/vars.js';
import { extractFrontends } from '../public/js/ui/render.js';
import { decodeScaled, encodePng, makeThumbnail } from '../server/thumb.mjs';

const engine = new MacroEngine();
const env = (over = {}) => {
    const local = {}, global = {};
    return { user: 'Ann', char: 'Bob', vars: { local: objectScope(local), global: objectScope(global) }, chat: [], ...over, _local: local };
};

test('宏：基础、嵌套、未知保留、变量', () => {
    const e = env();
    assert.equal(engine.evaluate('Hi {{user}}, I am {{char}}.', e), 'Hi Ann, I am Bob.');
    assert.equal(engine.evaluate('<USER> & <BOT>', e), 'Ann & Bob');
    assert.equal(engine.evaluate('{{unknownMacro::x}} {{user}}', e), '{{unknownMacro::x}} Ann');
    assert.equal(engine.evaluate('{{setvar::a::1}}{{getvar::a}}', e), '1');
    assert.equal(engine.evaluate('{{addvar::a::2}}{{getvar::a}}', e), '3');
    assert.equal(engine.evaluate('{{incvar::a}}', e), '4');
    assert.equal(engine.evaluate('{{addvar::s::x}}{{addvar::s::y}}{{getvar::s}}', e), 'xy');
    assert.equal(engine.evaluate('{{setvar::n::{{user}}}}{{getvar::n}}', e), 'Ann');
    assert.equal(engine.evaluate('a{{// comment {{user}} }}b', e), 'ab');
    assert.equal(engine.evaluate('x\n\n{{trim}}\n\ny', e), 'xy');
    assert.equal(engine.evaluate('{{reverse:abc}}', e), 'cba');
    assert.match(engine.evaluate('{{roll:d6}}', e), /^[1-6]$/);
    assert.ok(['a', 'b'].includes(engine.evaluate('{{random:a,b}}', e)));
    assert.ok(['a', 'b'].includes(engine.evaluate('{{random::a::b}}', e)));
    const p1 = engine.evaluate('{{pick::x::y::z}}', { ...e, chatId: 'c1' });
    assert.equal(engine.evaluate('{{pick::x::y::z}}', { ...e, chatId: 'c1' }), p1);
});

test('宏：if/else 作用域与变量简写', () => {
    const e = env();
    assert.equal(engine.evaluate('{{if {{user}}}}yes{{else}}no{{/if}}', e), 'yes');
    assert.equal(engine.evaluate('{{if .flag}}on{{else}}off{{/if}}', e), 'off');
    engine.evaluate('{{.flag = 1}}', e);
    assert.equal(engine.evaluate('{{if .flag}}on{{else}}off{{/if}}', e), 'on');
    assert.equal(engine.evaluate('{{.flag++}}', e), '2');
    assert.equal(engine.evaluate('{{.missing ?? dflt}}', e), 'dflt');
    assert.equal(engine.evaluate('{{if !.missing}}not set{{/if}}', e), 'not set');
    assert.equal(engine.evaluate('{{//}}multi\nline{{///}}ok', e), 'ok');
    assert.equal(engine.evaluate('\\{\\{user\\}\\}', e), '{{user}}');
});

test('宏：original 只替换一次、extra 动态宏', () => {
    const e = env({ original: 'ORIG', extra: { lastChatMessage: 'LAST' } });
    assert.equal(engine.evaluate('{{original}}/{{original}}', e), 'ORIG/');
    assert.equal(engine.evaluate('[{{lastChatMessage}}]', e), '[LAST]');
});

test('正则：捕获组、{{match}}、trimStrings、深度与仅显示', () => {
    const s = { findRegex: '/(\\w+)@(\\w+)/g', replaceString: '$2 at $1 [{{match}}]', placement: [2], trimStrings: [] };
    assert.equal(runRegexScript(s, 'a@b c@d'), 'b at a [a@b] d at c [c@d]');
    const t = { findRegex: '/<x>(.*?)<\\/x>/', replaceString: '[$1]', trimStrings: ['!'], placement: [2] };
    assert.equal(runRegexScript(t, '<x>hi!</x>'), '[hi]');
    const named = { findRegex: '/(?<k>\\d+)/', replaceString: 'n=$<k>,bad=$9', placement: [2] };
    assert.equal(runRegexScript(named, 'v12'), 'vn=12,bad=');
    const md = { findRegex: '/secret/g', replaceString: '***', placement: [2], markdownOnly: true, maxDepth: 1 };
    assert.equal(getRegexedString('a secret', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [md], isMarkdown: true, depth: 0 }), 'a ***');
    assert.equal(getRegexedString('a secret', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [md], isMarkdown: true, depth: 2 }), 'a secret');
    assert.equal(getRegexedString('a secret', REGEX_PLACEMENT.AI_OUTPUT, { scripts: [md] }), 'a secret');
    const sub = { findRegex: '/{{user}}/g', replaceString: 'X', placement: [2], substituteRegex: 1 };
    assert.equal(getRegexedString('Ann!', 2, { scripts: [sub], substitute: (t) => engine.evaluate(t, env()) }), 'X!');
});

function book(entries) {
    const obj = {};
    entries.forEach((e, i) => { obj[i] = newWorldInfoEntry(i, e); });
    return { world: 'w', entries: obj };
}

test('世界书：关键词、正则键、次要逻辑、常驻、递归、位置与顺序', async () => {
    const entries = getSortedEntries({ global: [book([
        { key: ['apple'], content: 'A-trigger mention', order: 10, position: WI_POSITION.before },
        { key: ['/ban+ana/i'], content: 'B', order: 20, position: WI_POSITION.before },
        { key: ['cat'], keysecondary: ['dog'], selective: true, selectiveLogic: WI_LOGIC.AND_ANY, content: 'C' },
        { key: ['cat'], keysecondary: ['dog'], selective: true, selectiveLogic: WI_LOGIC.NOT_ANY, content: 'D' },
        { constant: true, content: 'E', position: WI_POSITION.atDepth, depth: 2, role: 1 },
        { key: ['A-trigger'], content: 'F (from recursion)' },
        { key: ['apple'], content: 'G', disable: true },
    ])] });
    const res = await checkWorldInfo({ messages: ['I like apple and BANNNANA', 'cat'], entries, settings: { world_info_recursive: true, world_info_depth: 2 }, maxContext: 100000, random: () => 0 });
    assert.equal(res.worldInfoBefore, 'A-trigger mention\nB');
    assert.ok(res.worldInfoAfter.includes('D'));
    assert.ok(!res.worldInfoAfter.includes('C'));
    assert.ok(res.worldInfoAfter.includes('F (from recursion)'));
    assert.deepEqual(res.depthEntries, [{ depth: 2, role: 1, entries: ['E'] }]);
});

test('世界书：分组与装饰器', async () => {
    const entries = getSortedEntries({ global: [book([
        { key: ['x'], content: 'g1', group: 'grp', groupOverride: false, groupWeight: 100 },
        { key: ['x'], content: 'g2', group: 'grp', groupOverride: true },
        { content: '@@activate\nforced', key: [] },
        { constant: true, content: '@@dont_activate\nnever' },
    ])] });
    const res = await checkWorldInfo({ messages: ['x'], entries, settings: {}, maxContext: 100000, random: () => 0 });
    assert.ok(res.worldInfoAfter.includes('g2'));
    assert.ok(!res.worldInfoAfter.includes('g1'));
    assert.ok(res.worldInfoAfter.includes('forced'));
    assert.ok(!res.worldInfoAfter.includes('never'));
    assert.deepEqual(parseDecorators('@@if a > 1\n@@private\nbody').decorators.map(d => d.name), ['@@if', '@@private']);
});

test('EJS：输出、转义、空白控制、await', async () => {
    assert.equal(await render('<%= "<b>" %>|<%- "<b>" %>', {}), '&lt;b&gt;|<b>');
    assert.equal(await render('a\n<% if (x) { -%>\nyes\n<% } -%>\nb', { x: true }), 'a\nyes\nb');
    assert.equal(await render('a\n  <%_ if (x) { _%>\nyes\n  <%_ } _%>\nb', { x: true }), 'a\nyes\nb');
    assert.equal(await render('<% print("p", 1) %>|<%# no %>|<%% lit %%>', {}), 'p1||<% lit %>');
    assert.equal(await render('<%- await f() %>', { f: async () => 'ok' }), 'ok');
});

test('MVU：JSONPatch 与旧 _.set 语法', () => {
    const text = `正文
<UpdateVariable>
<Analysis>x</Analysis>
<JSONPatch>
[
  { "op": "replace", "path": "/player/level", "value": 2 },
  { "op": "delta", "path": "/player/exp", "value": -5 },
  { "op": "insert", "path": "/items/-", "value": "刀" },
  { "op": "remove", "path": "/tmp" },
  { "op": "move", "from": "/a", "to": "/b" }
]
</JSONPatch>
</UpdateVariable>`;
    const res = processMessage({ stat_data: { player: { level: 1, exp: 10 }, items: [], tmp: 1, a: 'v' } }, text);
    assert.deepEqual(res.variables.stat_data, { player: { level: 2, exp: 5 }, items: ['刀'], b: 'v' });
    const legacy = parseCommands(`_.set('角色.好感度', 10, 15);//变好了\n_.add('角色.金钱', -3);\n_.set("角色.状态", "开心");`);
    const out = applyCommands({ 角色: { 好感度: [10, '描述'], 金钱: 5, 状态: '' } }, legacy);
    assert.deepEqual(out.data, { 角色: { 好感度: [15, '描述'], 金钱: 2, 状态: '开心' } });
    assert.equal(extractUpdateBlocks('<UpdateVariable>abc').length, 1);
    assert.deepEqual(collectInitVars([{ comment: '[initvar]初始', content: 'a:\n  b: 1\nlist:\n  - x' }]), { a: { b: 1 }, list: ['x'] });
});

test('变量：消息层 setvar 与合并视图', () => {
    const chat = [{ mes: 'a', swipe_id: 0 }, { mes: 'b', swipe_id: 0 }];
    const vm = new VariableManager({ chat, meta: {}, global: { g: 1 } });
    vm.setvar('x.y', 5, 'local');
    vm.setvar('m', 'msg');
    assert.equal(vm.getvar('x.y'), 5);
    assert.equal(vm.getvar('m'), 'msg');
    assert.equal(vm.getvar('g'), 1);
    assert.equal(vm.setvar('m', 'again', 'nx'), undefined);
    assert.equal(vm.incvar('cnt', 2, { defaults: 1 }), 3);
    assert.deepEqual(chat[1].variables[0], { m: 'msg', cnt: 3 });
});

test('提示词：顺序、深度注入、示例、预算裁剪、角色覆盖', () => {
    const preset = normalizePreset({
        openai_max_context: 220,
        openai_max_tokens: 100,
        new_chat_prompt: '[Start]',
        prompts: [
            { identifier: 'main', name: 'Main', role: 'system', content: 'MAIN for {{char}}', system_prompt: true },
            newCustomPrompt({ identifier: 'inj', content: 'AT DEPTH 1', injection_position: 1, injection_depth: 1 }),
        ],
        prompt_order: [{ character_id: 100001, order: [
            { identifier: 'main', enabled: true }, { identifier: 'charDescription', enabled: true }, { identifier: 'dialogueExamples', enabled: true },
            { identifier: 'chatHistory', enabled: true }, { identifier: 'inj', enabled: true }, { identifier: 'jailbreak', enabled: true },
        ] }],
    });
    const sub = (t, extra = {}) => engine.evaluate(t, { ...env(), ...extra, original: extra.original });
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message number ${i}`, isUser: i % 2 === 0, name: i % 2 ? 'Bob' : 'Ann' }));
    const res = buildChatCompletion({
        preset, names: { user: 'Ann', char: 'Bob' },
        fields: { description: 'DESC', system: 'CARD MAIN + {{original}}', mesExamples: '<START>\nAnn: hi\nBob: yo' },
        history, substitute: sub,
    });
    const contents = res.messages.map(m => m.content);
    assert.equal(contents[0], 'CARD MAIN + MAIN for Bob');
    assert.equal(contents[1], 'DESC');
    assert.equal(contents.at(-1), 'message number 29');
    assert.equal(contents.at(-2), 'AT DEPTH 1');
    assert.ok(contents.includes('[Start]'));
    assert.ok(res.debug.droppedHistory > 0, '预算应裁掉旧消息');
    assert.ok(!contents.includes('message number 0'));
    assert.deepEqual(parseExampleIntoIndividual(parseMesExamples('Ann: hi\nBob: yo')[0], 'Ann', 'Bob').map(m => m.name), ['example_user', 'example_assistant']);
});

test('接口：strict 后处理、Claude 预填充、思维链拆分、流事件', () => {
    const msgs = [{ role: 'system', content: 's1' }, { role: 'system', content: 's2' }, { role: 'assistant', content: 'a' }, { role: 'system', content: 'mid' }];
    assert.deepEqual(postProcessMessages(msgs, 'strict'), [
        { role: 'system', content: 's1\n\ns2' }, { role: 'user', content: "Let's get started." }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'mid' },
    ]);
    const r = buildRequest({ provider: 'claude', model: 'claude-x' }, { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }], prefill: 'Sure ', params: { temperature: 1, top_p: 1, top_k: 0, max_tokens: 10, stream: true } });
    assert.equal(r.body.system[0].text, 'sys');
    assert.equal(r.body.messages.at(-1).role, 'assistant');
    assert.equal(r.body.messages.at(-1).content[0].text, 'Sure');
    assert.deepEqual(splitThinking('<think>\nplan\n</think>\nanswer'), { text: 'answer', reasoning: 'plan', open: false });
    assert.equal(splitThinking('<think>half').open, true);
    assert.deepEqual(parseStreamEvent('openai', { data: '{"choices":[{"delta":{"content":"x","reasoning_content":"r"}}]}' }), { text: 'x', reasoning: 'r', finishReason: undefined });
    assert.deepEqual(parseStreamEvent('claude', { data: '{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"t"}}' }), { reasoning: 't' });
});

test('角色卡 PNG 读写往返、聊天 JSONL 往返与 swipe', () => {
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '测试角色', description: '中文描述' } };
    const png = writeCardPng(BLANK_PNG, card);
    assert.equal(JSON.parse(readCardJson(png)).data.name, '测试角色');
    assert.equal(JSON.parse(readCardJson(png)).spec, 'chara_card_v3');
    const text = serializeChat({ user_name: 'A', character_name: 'B', chat_metadata: { x: 1 } }, [{ name: 'B', mes: 'hi', custom_field: 42 }]);
    const parsed = parseChatJsonl(text);
    assert.equal(parsed.messages[0].custom_field, 42);
    const m = parsed.messages[0];
    addSwipe(m, 'second');
    assert.equal(m.swipes.length, 2);
    setSwipe(m, 0);
    assert.equal(m.mes, 'hi');
});

test('前端卡识别：单行 ``` 代码不算围栏；Windows 换行归一后能识别', () => {
    const doc = '```html\n<!DOCTYPE html>\n<html><body>状态栏</body></html>\n```';
    // 单行 ```…``` 后面再出现前端卡：只抽出真正的那一块，正文不被吞
    const r1 = extractFrontends(`<time>\n\`\`\`公寓·20:30\`\`\`\n</time>\n正文第一段\n\n${doc}`);
    assert.equal(r1.frontends.length, 1);
    assert.ok(r1.text.includes('正文第一段'));
    assert.ok(r1.frontends[0].startsWith('<!DOCTYPE html>'));
    // formatMessage 会先把 \r\n 归一；这里直接验证归一后的文本
    const crlf = `<Gui>\r\n${doc.replace(/\n/g, '\r\n')}\r\n</Gui>`;
    assert.equal(extractFrontends(crlf).frontends.length, 0, '不归一时识别不出（说明归一是必要的）');
    assert.equal(extractFrontends(crlf.replace(/\r\n?/g, '\n')).frontends.length, 1);
});

test('缩略图：PNG 解码、按块平均缩小、重新编码', () => {
    const w = 40, h = 20, rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        rgba.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], o);
    }
    const png = encodePng({ width: w, height: h, rgba, alpha: false });
    const small = decodeScaled(png, 10);
    assert.equal(small.width, 20);
    assert.equal(small.height, 10);
    assert.equal(small.alpha, false);
    assert.deepEqual([...small.rgba.slice(0, 4)], [255, 0, 0, 255]);
    const last = (small.width * small.height - 1) * 4;
    assert.deepEqual([...small.rgba.slice(last, last + 4)], [0, 0, 255, 255]);
    // 带卡片元数据的 PNG：缩略图不再包含 tEXt 块
    const card = writeCardPng(png, { spec: 'chara_card_v2', data: { name: 'x', description: 'y'.repeat(5000) } });
    const thumb = makeThumbnail(Buffer.from(card), 10);
    assert.ok(thumb.length < card.length);
    assert.ok(!Buffer.from(thumb).includes(Buffer.from('tEXt')));
});
