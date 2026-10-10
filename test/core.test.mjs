import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacroEngine, objectScope } from '../public/js/core/macros.js';
import { runRegexScript, getRegexedString, REGEX_PLACEMENT } from '../public/js/core/regex.js';
import { checkWorldInfo, getSortedEntries, newWorldInfoEntry, parseDecorators, WI_POSITION, WI_LOGIC } from '../public/js/core/worldinfo.js';
import { render } from '../public/js/core/ejs.js';
import { applyCommands, parseCommands, extractUpdateBlocks, processMessage, collectInitVars, processMessageWithEvents, toCommandInfo, fromCommandInfo, extractCommands, withStatusPlaceholder, detectMvu, MVU_EVENTS } from '../public/js/core/mvu.js';
import { buildChatCompletion, parseMesExamples, parseExampleIntoIndividual } from '../public/js/core/prompt.js';
import { normalizePreset, newCustomPrompt } from '../public/js/core/preset.js';
import { postProcessMessages, buildRequest, splitThinking, parseStreamEvent } from '../public/js/core/providers.js';
import { writeCardPng, readCardJson, BLANK_PNG } from '../public/js/core/png.js';
import { parseChatJsonl, serializeChat, addSwipe, setSwipe } from '../public/js/core/chat.js';
import { VariableManager } from '../public/js/core/vars.js';
import { extractFrontends } from '../public/js/ui/render.js';
import { decodeScaled, encodePng, makeThumbnail } from '../server/thumb.mjs';
import fs from 'node:fs';
import { GROUPS, TAB_LABELS, groupOf, pathOf } from '../public/js/ui/panels/nav.js';
import { FEATURES, searchFeatures } from '../public/js/ui/panels/search.js';
import { normalizeScript, scriptTreesOf, flattenScriptTrees, activeScripts, isMvuLoaderOnly, rewriteScriptSource, buttonEventName, helperVariablesOf } from '../public/js/core/scripts.js';
import { toWorldbook, fromWorldbook, toHelperPreset, fromHelperPreset, toTavernRegex, fromTavernRegex } from '../public/js/core/thformat.js';
import { ChatSession } from '../public/js/core/session.js';
import { normalizeCard } from '../public/js/core/card.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';
import { Store } from '../server/store.mjs';
import os from 'node:os';
import path from 'node:path';

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

test('设置面板：4 个分组盖住 12 个分区，搜索清单和面板上的字对得上', () => {
    const tabs = GROUPS.flatMap(g => g.tabs);
    assert.equal(GROUPS.length, 4);
    assert.equal(tabs.length, 12);
    assert.equal(new Set(tabs).size, 12, '一个分区只属于一个分组');
    assert.deepEqual([...tabs].sort(), Object.keys(TAB_LABELS).sort());
    for (const g of GROUPS) assert.ok(g.tabs.length >= 2 && g.tabs.length <= 4, `${g.label} 的分区数`);
    assert.equal(groupOf('scripts').id, 'char');
    assert.equal(groupOf('vars').id, 'chat');
    assert.equal(pathOf('preset'), '模型 › 预设');

    const src = (id) => fs.readFileSync(new URL(`../public/js/ui/panels/${id}.js`, import.meta.url), 'utf8');
    for (const f of FEATURES) {
        if (f.action) continue;
        assert.ok(tabs.includes(f.tab), `${f.t} 指向不存在的分区 ${f.tab}`);
        // 定位文字必须真的出现在那个分区的源码里：面板上的字改了，这里会提醒同步清单
        for (const one of [].concat(f.find ?? [])) assert.ok(src(f.tab).includes(one), `${f.t}：${f.tab}.js 里找不到「${one}」`);
    }
    assert.equal(new Set(FEATURES.map(f => f.t)).size, FEATURES.length, '功能名不重复');

    const path = (f) => (f.tab ? pathOf(f.tab) : '');
    assert.equal(searchFeatures('字体大小', path)[0].t, '正文字号');
    assert.equal(searchFeatures('Temperature', path)[0].t, '温度');
    assert.equal(searchFeatures('深色', path)[0].tab, 'settings');
    assert.equal(searchFeatures('开场白', path)[0].tab, 'char');
    assert.equal(searchFeatures('新聊天', path)[0].action, 'newChat');
    assert.ok(searchFeatures('世界书', path).length >= 4, '“世界书”应该同时找到全局、角色、聊天几处');
    assert.ok(searchFeatures('本聊天', path).every(f => groupOf(f.tab).id === 'chat'), '分组名也能搜');
    assert.ok(searchFeatures('预设 导入', path).some(f => f.t === '导入预设'), '多个词都要命中');
    assert.deepEqual(searchFeatures('   ', path), []);
    assert.deepEqual(searchFeatures('这个功能不存在', path), []);
    assert.ok(searchFeatures('a', path).length <= 8);
});

// ---------- 酒馆助手脚本 ----------

const MVU_URL = 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';
const script = (over = {}) => ({ type: 'script', enabled: true, name: '脚本', id: 'id-1', content: 'console.log(1)', info: '', button: { enabled: true, buttons: [] }, data: {}, ...over });

test('脚本库：规范化、文件夹展开、旧格式、哪些该运行', () => {
    const n = normalizeScript({ name: 1, content: 2, button: { buttons: [{ name: '开', visible: true }, { name: '关', visible: false }, null] } });
    assert.equal(n.name, '1');
    assert.equal(n.content, '2');
    assert.equal(n.enabled, false, '没写 enabled 的脚本默认不运行');
    assert.deepEqual(n.button.buttons, [{ name: '开', visible: true }, { name: '关', visible: false }]);
    assert.ok(n.id.length > 8);

    const ext = { tavern_helper: { scripts: [
        script({ id: 'a' }),
        { type: 'folder', enabled: false, name: '关着的文件夹', scripts: [script({ id: 'b' })] },
        { type: 'folder', enabled: true, name: '开着的文件夹', scripts: [script({ id: 'c' }), script({ id: 'd', enabled: false })] },
    ], variables: { x: 1 } } };
    const flat = flattenScriptTrees(scriptTreesOf(ext));
    assert.deepEqual(flat.map(x => [x.script.id, x.on, x.folder]), [['a', true, ''], ['b', false, '关着的文件夹'], ['c', true, '开着的文件夹'], ['d', false, '开着的文件夹']]);
    assert.equal(flat[0].raw, ext.tavern_helper.scripts[0], 'raw 是卡里的原对象，开关写回它');
    assert.deepEqual(helperVariablesOf(ext), { x: 1 });
    assert.deepEqual(helperVariablesOf({}), {});
    const made = {};
    helperVariablesOf(made, true).k = 1;
    assert.deepEqual(made.tavern_helper.variables, { k: 1 });

    // 更早的两种存法
    assert.equal(scriptTreesOf({ tavern_helper: [['scripts', [script()]], ['variables', {}]] }).length, 1);
    const legacy = flattenScriptTrees(scriptTreesOf({ TavernHelper_scripts: [{ type: 'script', value: { id: 'old', name: '旧', content: 'x', enabled: true, buttons: [{ name: 'b', visible: true }] } }] }));
    assert.equal(legacy[0].script.id, 'old');
    assert.equal(legacy[0].script.button.buttons[0].name, 'b');
    assert.deepEqual(scriptTreesOf(undefined), []);
    assert.deepEqual(scriptTreesOf({ tavern_helper: { scripts: 'x' } }), []);

    const card = { data: { extensions: ext } };
    const preset = { extensions: { tavern_helper: { scripts: [script({ id: 'p1' }), script({ id: 'p2', content: `import '${MVU_URL}'` }), script({ id: 'p3', content: '   ' })] } } };
    const all = activeScripts({ card, cardId: '卡', preset, presetName: '预设', settings: {} });
    assert.deepEqual(all.map(x => `${x.source}:${x.script.id}`), ['preset:p1', 'preset:p2', 'character:a', 'character:c'], '预设脚本在前，空脚本和关掉的不算');
    assert.equal(all[1].mvuLoader, true);
    assert.equal(all[0].mvuLoader, false);
    assert.deepEqual(activeScripts({ card, cardId: '卡', preset, presetName: '预设', settings: { scripts: { enabled: false } } }), []);
    assert.deepEqual(activeScripts({ card, cardId: '卡', preset, presetName: '预设', settings: { scripts: { characters: { 卡: false } } } }).map(x => x.script.id), ['p1', 'p2']);
    assert.deepEqual(activeScripts({ card, cardId: '卡', preset, presetName: '预设', settings: { scripts: { presets: { 预设: false } } } }).map(x => x.script.id), ['a', 'c']);
    assert.deepEqual(activeScripts({ card: null, cardId: '', preset: null, presetName: '', settings: {} }), []);
    // 内容变了 key 跟着变（要重启），内容没变 key 不变（不重启）
    const k1 = activeScripts({ card, cardId: '卡', settings: {} })[0].key;
    assert.equal(activeScripts({ card, cardId: '卡', settings: {} })[0].key, k1);
    ext.tavern_helper.scripts[0].content = 'console.log(2)';
    assert.notEqual(activeScripts({ card, cardId: '卡', settings: {} })[0].key, k1);
});

test('脚本库：MVU 加载脚本的识别与替换、按钮事件名', () => {
    assert.equal(isMvuLoaderOnly(`import '${MVU_URL}';`), true);
    assert.equal(isMvuLoaderOnly(`import'${MVU_URL}'`), true);
    assert.equal(isMvuLoaderOnly("import 'https://testingcf.jsdelivr.net/gh/NLKASHEI/MVU-offline@v1.0.1/mvu_bundle_full.js'"), true);
    // 带超时和镜像回退的加载器，注释里提到了别的接口名也不影响
    assert.equal(isMvuLoaderOnly(`// registerMvuSchema 在别的脚本里\nconst T = 15000;\nconst importMvu = (url) => Promise.race([import(url), new Promise((_, r) => setTimeout(() => r(new Error('超时')), T))]);\ntry { await importMvu('${MVU_URL}'); } catch (e) { console.error(e); }`), true);
    assert.equal(isMvuLoaderOnly(`import '${MVU_URL}';\neventOn('x', () => {});`), false, '还做了别的事的脚本要运行');
    assert.equal(isMvuLoaderOnly("import { registerMvuSchema } from 'https://x/mvu_zod.js'; $(() => registerMvuSchema(S))"), false);
    assert.equal(isMvuLoaderOnly('console.log(1)'), false);

    const out = rewriteScriptSource(`import '${MVU_URL}';\nawait import("https://gcore.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js");\nimport { klona } from 'https://testingcf.jsdelivr.net/npm/klona@2.0.6/+esm';`, 'http://h/stub.js');
    assert.equal(out.match(/http:\/\/h\/stub\.js/g).length, 2);
    assert.ok(out.includes('klona@2.0.6'), '别的 import 不动');
    assert.ok(!out.includes('MagVarUpdate'));

    assert.equal(buttonEventName('s1', '开始'), buttonEventName('s1', '开始'));
    assert.notEqual(buttonEventName('s1', '开始'), buttonEventName('s1', '结束'));
    assert.notEqual(buttonEventName('s1', '开始'), buttonEventName('s2', '开始'));
    assert.ok(detectMvu({ scripts: [{ name: 'x', content: "import 'https://a/gh/NLKASHEI/MVU-offline@v1/mvu_bundle_full.js'" }] }));
});

test('MVU 事件流程：与不发事件的路径结果一致，监听者能改命令和结果', async () => {
    const text = `正文<UpdateVariable>_.set('a.b', 1, 5); // 原因
_.add("hp", -3);
_.insert('bag', "刀, 剑");
_.remove('gone');
<JSONPatch>[{"op":"replace","path":"/a/c","value":"x"},{"op":"delta","path":"/hp","value":2},{"op":"insert","path":"/bag/-","value":"盾"},{"op":"insert","path":"/obj/k","value":{"n":1}},{"op":"move","from":"/m1","path":"/m2"}]</JSONPatch></UpdateVariable>`;
    const prev = { stat_data: { a: { b: 1, c: 'y' }, hp: 10, bag: ['矛'], gone: 1, obj: {}, m1: { k: 1 }, 好感: [3, '0 到 10'] } };
    const sync = processMessage(prev, text);
    const seen = [];
    const res = await processMessageWithEvents(prev, text, async (name) => { seen.push(name); });
    assert.deepEqual(res.variables.stat_data, sync.variables.stat_data);
    assert.deepEqual(res.variables.stat_data, { a: { b: 5, c: 'x' }, hp: 9, bag: ['矛', '盾', '刀, 剑'], obj: { k: { n: 1 } }, m2: { k: 1 }, 好感: [3, '0 到 10'] });
    assert.deepEqual(seen, ['mag_variable_update_started', 'mag_command_parsed', 'mag_command_parsed_for_zod', 'mag_command_parsed_ended_for_zod', 'mag_variable_update_ended', 'mag_variable_update_ended_for_zod']);
    assert.equal(res.changed, true);
    assert.equal(res.commandCount, 9);
    assert.deepEqual(prev.stat_data.a, { b: 1, c: 'y' }, '上一层的变量不能被改');
    assert.equal(MVU_EVENTS.VARIABLE_UPDATE_ENDED, 'mag_variable_update_ended');

    // 命令交给监听者时是 MVU 的格式：参数是原文
    const infos = extractCommands(text).map(toCommandInfo);
    assert.deepEqual(infos.find(c => c.full_match.startsWith('_.set')), { type: 'set', full_match: "_.set('a.b', 1, 5)", args: ["'a.b'", '1', '5'], reason: '原因' });
    assert.deepEqual(infos.find(c => c.type === 'move').args, ['["m1"]', '["m2"]']);
    assert.equal(infos.find(c => c.full_match.startsWith('_.remove')).type, 'delete', '别名归一');
    assert.deepEqual(fromCommandInfo({ type: 'set', args: ['stat_data.角色.络络.好感度', '"30"'], reason: 'r' }), { kind: 'legacy', fn: 'set', args: ['角色.络络.好感度', '30'], reason: 'r' });

    // 监听者改路径、加命令、给结果设上限
    const r2 = await processMessageWithEvents({ stat_data: { 络络: { 好感度: 5 }, 次数: 0 } }, "<UpdateVariable>_.set('络-络.好感度', 99);</UpdateVariable>", async (name, variables, arg) => {
        if (name === 'mag_command_parsed') {
            arg.forEach(c => { c.args[0] = c.args[0].replace(/-/g, ''); });
            arg.push({ type: 'add', full_match: '', args: ['次数', '1'], reason: '脚本' });
        }
        if (name === 'mag_variable_update_ended') {
            assert.equal(arg.stat_data.络络.好感度, 5, '第二个参数是更新前的变量');
            variables.stat_data.络络.好感度 = Math.min(variables.stat_data.络络.好感度, 10);
        }
    });
    assert.deepEqual(r2.variables.stat_data, { 络络: { 好感度: 10 }, 次数: 1 });

    // 变量结构脚本的做法：自己执行并拿走命令，剩下的清空；结束时去掉 display_data / delta_data
    const r3 = await processMessageWithEvents({ stat_data: { n: 1 } }, "<UpdateVariable>_.set('n', 2);_.set('不在结构里', 1);</UpdateVariable>", async (name, variables, arg) => {
        if (name === 'mag_command_parsed_for_zod') { variables.stat_data = { ...variables.stat_data, n: 2 }; arg.splice(0, 1); }
        if (name === 'mag_command_parsed_ended_for_zod') arg.length = 0;
        if (name === 'mag_variable_update_ended_for_zod') { delete variables.display_data; delete variables.delta_data; }
    });
    assert.deepEqual(r3.variables, { stat_data: { n: 2 } });

    assert.equal(withStatusPlaceholder('你好'), '你好\n\n<StatusPlaceHolderImpl/>');
    assert.equal(withStatusPlaceholder('你好\n<StatusPlaceHolderImpl/>'), '你好\n<StatusPlaceHolderImpl/>');
    assert.equal(withStatusPlaceholder('a<status_current_variable>{"x":1}</status_current_variable>b <StatusPlaceHolderImpl/>'), 'ab <StatusPlaceHolderImpl/>');
});

test('会话：MVU 状态栏占位符只在卡用到它时才补，事件路径写回楼层', async () => {
    const world = normalizeWorld({ entries: { 0: { uid: 0, comment: '[initvar]', content: 'hp: 10', disable: true } } });
    const make = (regex) => {
        const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '角色', first_mes: '开场', extensions: { world: 'w', regex_scripts: regex } } });
        const chat = [{ name: '角色', is_user: false, mes: '开场', swipes: ['开场', '另一个开场'], swipe_id: 0 }];
        return new ChatSession({ card, cardFile: '角色', persona: { name: '我' }, preset: normalizePreset({}), chat, meta: {}, settings: {}, worlds: { w: world } });
    };
    const withBar = make([{ id: 'r', scriptName: '状态栏', findRegex: '<StatusPlaceHolderImpl/>', replaceString: 'x', placement: [2] }]);
    assert.equal(withBar.usesStatusPlaceholder(), true);
    assert.equal(withBar.ensureMvuInit(), true);
    assert.deepEqual(withBar.chat[0].swipes, ['开场\n\n<StatusPlaceHolderImpl/>', '另一个开场\n\n<StatusPlaceHolderImpl/>']);
    assert.equal(withBar.chat[0].mes, '开场\n\n<StatusPlaceHolderImpl/>');
    assert.deepEqual(withBar.chat[0].variables[1].stat_data, { hp: 10 });
    assert.equal(withBar.mvuInitPending, true);

    // 初始化事件：监听者原地改每个开场白的变量
    const swipes = [];
    await withBar.notifyMvuInit(async (v, i) => { swipes.push(i); v.stat_data = { ...v.stat_data, 默认值: true }; });
    assert.deepEqual(swipes, [0, 1]);
    assert.deepEqual(withBar.chat[0].variables[0].stat_data, { hp: 10, 默认值: true });

    withBar.chat.push({ name: '角色', is_user: false, mes: "回复<UpdateVariable>_.add('hp', -4);</UpdateVariable>", swipes: ["回复<UpdateVariable>_.add('hp', -4);</UpdateVariable>"], swipe_id: 0 });
    const names = [];
    await withBar.applyMvuAsync(1, async (name, a) => {
        names.push(name);
        if (name === 'mag_before_message_update') a.message_content += '（脚本加的）';
    });
    assert.equal(withBar.chat[1].variables[0].stat_data.hp, 6);
    assert.ok(withBar.chat[1].mes.endsWith('（脚本加的）\n\n<StatusPlaceHolderImpl/>'));
    assert.equal(withBar.chat[1].swipes[0], withBar.chat[1].mes, 'swipes 跟着同步');
    assert.equal(names.at(-1), 'mag_before_message_update');

    // 没用到占位符的卡：变量照常更新，正文不动
    const plain = make([]);
    assert.equal(plain.usesStatusPlaceholder(), false);
    plain.ensureMvuInit();
    assert.equal(plain.chat[0].mes, '开场');
    plain.chat.push({ name: '角色', is_user: false, mes: "回复<UpdateVariable>_.add('hp', 1);</UpdateVariable>" });
    plain.applyMvu(1);
    assert.equal(plain.chat[1].mes, "回复<UpdateVariable>_.add('hp', 1);</UpdateVariable>");
    assert.equal(plain.chat[1].variables[0].stat_data.hp, 11);
    assert.equal(await plain.applyMvuAsync(1, null).then(r => r.variables.stat_data.hp), 11, '没有监听者时走老路');
});

test('酒馆助手数据格式：世界书、预设、正则来回转换不丢东西', () => {
    const world = normalizeWorld({ entries: {
        3: { uid: 3, comment: '蓝灯', content: '内容', constant: true, key: ['a', '/b/i'], keysecondary: ['c'], selectiveLogic: 3, position: 4, role: 2, depth: 2, order: 50, probability: 80, excludeRecursion: true, sticky: 2, displayIndex: 1, automationId: '保留我' },
        7: { uid: 7, comment: '绿灯', content: '', disable: true, scanDepth: 5, position: 0, displayIndex: 0, delayUntilRecursion: 2 },
    } });
    const book = toWorldbook(world);
    assert.deepEqual(book.map(e => e.uid), [7, 3], '按界面顺序');
    assert.deepEqual(book[1], {
        uid: 3, name: '蓝灯', enabled: true,
        strategy: { type: 'constant', keys: ['a', '/b/i'], keys_secondary: { logic: 'and_all', keys: ['c'] }, scan_depth: 'same_as_global' },
        position: { type: 'at_depth', role: 'assistant', depth: 2, order: 50 },
        content: '内容', probability: 80,
        recursion: { prevent_incoming: true, prevent_outgoing: false, delay_until: null },
        effect: { sticky: 2, cooldown: null, delay: null },
        extra: {},
    });
    assert.equal(book[0].enabled, false);
    assert.equal(book[0].strategy.scan_depth, 5);
    assert.equal(book[0].position.type, 'before_character_definition');
    assert.equal(book[0].recursion.delay_until, 2);

    // 脚本改一条、加一条（不带 uid）、删一条
    book[1].content = '改过';
    book[1].strategy.type = 'selective';
    const { entries, list } = fromWorldbook([book[1], { name: '新条目', content: '新', strategy: { keys: [/正则/g] }, position: { type: 'outlet' } }], world);
    assert.deepEqual(Object.keys(entries).map(Number).sort((a, b) => a - b), [3, 8]);
    assert.equal(entries[3].content, '改过');
    assert.equal(entries[3].constant, false);
    assert.equal(entries[3].automationId, '保留我', '酒馆助手不认识的字段原样留着');
    assert.equal(entries[3].displayIndex, 0);
    assert.equal(entries[8].comment, '新条目');
    assert.deepEqual(entries[8].key, ['/正则/g']);
    assert.equal(entries[8].position, 7);
    assert.equal(list.length, 2);
    assert.deepEqual(toWorldbook({ entries }).map(e => e.name), ['蓝灯', '新条目']);

    const preset = normalizePreset({
        temperature: 0.7, openai_max_context: 1000, openai_max_tokens: 200, stream_openai: false, names_behavior: 2, 自定义字段: '保留',
        prompts: [{ identifier: 'main', name: '主', role: 'system', content: '主提示词', system_prompt: true }, { identifier: 'u1', name: '深度', role: 'user', content: '注入', injection_position: 1, injection_depth: 2, injection_order: 7, injection_trigger: ['normal'] }, { identifier: 'spare', name: '没排上', content: '闲置' }],
        prompt_order: [{ character_id: 100001, order: [{ identifier: 'u1', enabled: false }, { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
        extensions: { tavern_helper: { scripts: [script()], variables: { v: 1 } } },
    });
    const th = toHelperPreset(preset);
    assert.equal(th.settings.max_context, 1000);
    assert.equal(th.settings.max_completion_tokens, 200);
    assert.equal(th.settings.should_stream, false);
    assert.equal(th.settings.character_name_prefix, 'content');
    assert.deepEqual(th.prompts.map(p => [p.id, p.enabled]), [['u1', false], ['main', true], ['chatHistory', true]]);
    assert.deepEqual(th.prompts[0].position, { type: 'in_chat', depth: 2, order: 7 });
    assert.deepEqual(th.prompts[0].extra, { injection_trigger: ['normal'] });
    assert.equal('content' in th.prompts[2], false, '占位提示词没有 content');
    assert.ok(th.prompts_unused.some(p => p.id === 'spare'));
    assert.equal(th.extensions.tavern_helper.scripts.length, 1);

    // 脚本开一个条目、改内容、调顺序
    th.prompts[0].enabled = true;
    th.prompts[1].content = '改过的主提示词';
    th.prompts.reverse();
    th.settings.temperature = 1.2;
    const back = fromHelperPreset(th, preset);
    assert.equal(back.temperature, 1.2);
    assert.equal(back.自定义字段, '保留');
    assert.equal(back.names_behavior, 2);
    const order = back.prompt_order.find(o => o.character_id === 100001).order;
    assert.deepEqual(order, [{ identifier: 'chatHistory', enabled: true }, { identifier: 'main', enabled: true }, { identifier: 'u1', enabled: true }]);
    const u1 = back.prompts.find(p => p.identifier === 'u1');
    assert.deepEqual([u1.injection_position, u1.injection_depth, u1.injection_order, u1.injection_trigger], [1, 2, 7, ['normal']]);
    assert.equal(back.prompts.find(p => p.identifier === 'main').content, '改过的主提示词');
    assert.equal(back.prompts.find(p => p.identifier === 'main').system_prompt, true);
    assert.equal(back.prompts.find(p => p.identifier === 'chatHistory').marker, true);
    assert.ok(back.prompts.some(p => p.identifier === 'spare'), '没排进顺序的条目还在');
    assert.deepEqual(toHelperPreset(normalizePreset(back)).prompts.map(p => p.id), ['chatHistory', 'main', 'u1']);

    const rx = { id: 'r1', scriptName: '美化', findRegex: '/a/g', replaceString: 'b', trimStrings: ['t'], placement: [2, 6], disabled: true, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 2, minDepth: 1, maxDepth: null };
    const tr = toTavernRegex(rx);
    assert.deepEqual(tr, { id: 'r1', script_name: '美化', enabled: false, find_regex: '/a/g', replace_string: 'b', trim_strings: ['t'],
        source: { user_input: false, ai_output: true, slash_command: false, world_info: false, reasoning: true }, destination: { display: true, prompt: false }, run_on_edit: false, min_depth: 1, max_depth: null });
    const rb = fromTavernRegex({ ...tr, enabled: true }, rx);
    assert.equal(rb.disabled, false);
    assert.deepEqual(rb.placement, [2, 6]);
    assert.equal(rb.substituteRegex, 2, '酒馆助手不管的字段沿用原来的');
    assert.equal(rb.markdownOnly, true);
});

test('导入角色卡：内嵌世界书另存并绑定，脚本原样留在卡里', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-store-'));
    try {
        const store = new Store(dir);
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
            name: '带脚本的卡', first_mes: '你好',
            character_book: { name: '卡里的世界书', entries: [{ keys: ['钥匙'], content: '门后有宝箱', enabled: true, insertion_order: 10, comment: '宝箱' }] },
            extensions: { tavern_helper: { scripts: [script({ id: 's1', name: '状态栏' }), { type: 'folder', enabled: true, name: '夹', scripts: [script({ id: 's2', enabled: false })] }], variables: { 角色变量: 1 } } },
        } };
        const r = await store.importCard(Buffer.from(JSON.stringify(card)), '带脚本的卡.json');
        assert.equal(r.world, '卡里的世界书');
        const saved = await store.readCard(r.file);
        assert.equal(saved.data.extensions.world, '卡里的世界书');
        const world = await store.readJson('worlds', '卡里的世界书');
        assert.equal(Object.values(world.entries)[0].content, '门后有宝箱');
        const flat = flattenScriptTrees(scriptTreesOf(saved.data.extensions));
        assert.deepEqual(flat.map(x => [x.script.id, x.on]), [['s1', true], ['s2', false]]);
        assert.deepEqual(saved.data.extensions.tavern_helper.variables, { 角色变量: 1 });
        assert.deepEqual(activeScripts({ card: saved, cardId: r.file.replace(/\.png$/, ''), settings: {} }).map(x => x.script.name), ['状态栏']);
        // 同名世界书已经在了就不覆盖（用户可能改过），照样绑定
        await store.saveJson('worlds', '卡里的世界书', { entries: { 0: { uid: 0, content: '我改过了' } } });
        const again = await store.importCard(Buffer.from(JSON.stringify(card)), '带脚本的卡.json');
        assert.notEqual(again.file, r.file);
        assert.equal(Object.values((await store.readJson('worlds', '卡里的世界书')).entries)[0].content, '我改过了');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
