// MVU 面板对齐原版的部分：黑白名单正则、世界书筛选、请求组装、请求策略、自动清理 / 恢复、增量校正、角色卡覆盖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compileEntryRegex, filterUpdateBooks, filterPlotBooks, unsupportedWorlds, buildBuiltinMessages, buildTask, presetTaskInjects,
    runWithStrategy, applyAdvancedParams, collectStateChanges, appendRepairBlock, planRepair, buildRepairTask,
    readOverride, applyOverride, setOverride, serializeOverride, hasOverride, MVU_DEFAULTS,
} from '../public/js/core/mvu-extra.js';
import { cleanupMessageVariables, autoCleanup, clearOldFloors, restoreVariables, markSnapshot, replayRange, mergeInitVars, mirrorToChatVars, removeMirroredChatVars } from '../public/js/core/mvu-cleanup.js';
import { processMessage } from '../public/js/core/mvu.js';
import { ChatSession } from '../public/js/core/session.js';
import { normalizeCard } from '../public/js/core/card.js';
import { normalizePreset } from '../public/js/core/preset.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';

const book = (world, list) => ({ world, entries: Object.fromEntries(list.map((e, i) => [i, { uid: i, content: '', ...e }])) });
const comments = (b) => Object.values(b.entries).map(e => e.comment);

test('黑白名单正则：/源码/标志、直接写、出错', () => {
    assert.equal(compileEntryRegex('').regex, undefined);
    assert.equal(compileEntryRegex('  ').error, undefined);
    const a = compileEntryRegex('角色|地点').regex;
    assert.ok(a.test('人物：角色A') && a.test('地点表') && !a.test('物品'));
    const b = compileEntryRegex('/ABC|x/i').regex;
    assert.equal(b.flags, 'i');
    assert.ok(b.test('abc'));
    const c = compileEntryRegex('/a\\/b/').regex;
    assert.ok(c.test('a/b'));
    assert.match(compileEntryRegex('/abc').error, /斜杠/);
    assert.ok(compileEntryRegex('(').error);
    assert.ok(compileEntryRegex('/a/zz').error, '无效标志');
});

test('世界书筛选：标签、没适配的世界书、黑白名单（原版额外分析阶段）', () => {
    const books = {
        character: [book('角色书', [{ comment: '[mvu_plot]剧情' }, { comment: '[mvu_update]规则' }, { comment: '[mvu_plot][mvu_update]两边' }, { comment: '人物设定' }, { comment: '临时笔记' }])],
        global: [book('适配的全局书', [{ comment: '[mvu_update]全局规则' }, { comment: '地点' }]), book('普通全局书', [{ comment: '杂项' }])],
        chat: [], persona: [book('用户书', [{ comment: '我' }])],
    };
    assert.deepEqual(unsupportedWorlds(books), ['普通全局书', '用户书']);
    const f = filterUpdateBooks(books, { blacklist: '临时' });
    assert.equal(f.supported, true);
    assert.deepEqual(comments(f.books.character[0]), ['[mvu_update]规则', '[mvu_plot][mvu_update]两边', '人物设定']);
    assert.deepEqual(f.books.global.map(b => b.world), ['适配的全局书'], '没适配的全局书整本不给变量更新');
    assert.deepEqual(f.books.persona, []);
    assert.deepEqual(f.unsupported, ['普通全局书', '用户书']);
    assert.deepEqual(f.filtered, [{ lore: 'characterLore', world: '角色书', comment: '临时笔记', reason: '黑名单', sources: ['用户全局配置'] }]);

    // 白名单：用户和角色卡任一命中就保留；[mvu_update] 不受影响
    const w = filterUpdateBooks(books, { whitelist: '人物', charWhitelist: '/地点/' });
    assert.deepEqual(comments(w.books.character[0]), ['[mvu_update]规则', '[mvu_plot][mvu_update]两边', '人物设定']);
    assert.deepEqual(comments(w.books.global[0]), ['[mvu_update]全局规则', '地点']);
    const reasons = w.filtered.map(x => [x.comment, x.reason, x.sources.join('+')]);
    assert.deepEqual(reasons, [['临时笔记', '白名单', '用户全局配置+角色卡配置']]);
    // 黑名单：角色卡的也算
    assert.deepEqual(filterUpdateBooks(books, { charBlacklist: '人物' }).filtered[0].sources, ['角色卡配置']);
    // 无效正则只提示，不挡别的
    const bad = filterUpdateBooks(books, { whitelist: '(', blacklist: '临时' });
    assert.equal(bad.regexErrors.length, 1);
    assert.equal(bad.filtered.length, 1);

    // 角色书没适配：不统计没适配的书，全局书照样给
    const plain = { character: [book('角色书', [{ comment: '人物' }])], global: [book('g', [{ comment: '杂项' }])], chat: [], persona: [] };
    assert.deepEqual(unsupportedWorlds(plain), []);
    assert.equal(filterUpdateBooks(plain).books.global.length, 1);

    // 正文阶段：去掉只给变量更新的条目，[mvu_plot] 和两边都带的留着
    assert.deepEqual(comments(filterPlotBooks(books).character[0]), ['[mvu_plot]剧情', '[mvu_plot][mvu_update]两边', '人物设定', '临时笔记']);
});

test('请求组装：内置顺序、开头 / 结尾提示词、不带破限内容', () => {
    const msgs = buildBuiltinMessages({
        head: '开头的话', tail: '结尾的话', persona: '我是用户', description: '角色描述', worldBefore: '世界书前', worldAfter: '世界书后',
        history: [{ role: 'user', content: '打你' }, { role: 'assistant', content: '被打了' }], statData: { hp: 5 }, task: buildTask(),
    });
    const c = msgs.map(m => m.content);
    const at = (s) => c.findIndex(x => x.includes(s));
    assert.equal(c[0], '开头的话');
    assert.ok(at('<additional_information>') < at('我是用户') && at('我是用户') < at('角色描述') && at('角色描述') < at('世界书前') && at('世界书后') < at('</additional_information>'));
    assert.ok(at('</additional_information>') < at('<past_observe>') && at('<past_observe>') < at('打你') && at('被打了') < at('</past_observe>'));
    assert.ok(at('</past_observe>') < at('hp: 5') && at('hp: 5') < at('<variable_update_task>') && at('<variable_update_task>') < at('结尾的话'));
    assert.equal(msgs[msgs.length - 1].role, 'user');
    assert.equal(msgs.find(m => m.content === '打你').role, 'user');
    // 没填开头 / 结尾时不出现空消息
    const plain = buildBuiltinMessages({ history: [], task: buildTask() });
    assert.equal(plain[0].content, '<additional_information>');
    assert.ok(plain.every(m => m.content.trim()));
    // 任务说明是中性措辞
    for (const t of [buildTask(), buildTask({ schema: true }), buildRepairTask([])]) {
        assert.doesNotMatch(t, /jailbreak|破限|生死|紧急|ignore|safety|安全限制/i);
    }
    assert.match(buildTask({ schema: true }), /"patch"/);
    assert.deepEqual(presetTaskInjects('T').map(x => [x.depth, x.content]), [[0, 'T'], [2, '<past_observe>'], [1, '</past_observe>']]);
    // 高级参数：空的不动
    assert.deepEqual(applyAdvancedParams({ temperature: 0.3, top_p: 1, max_tokens: 2048 }, { mvuTemperature: '', mvuTopP: '0.8', mvuMaxTokens: 500 }), { temperature: 0.3, top_p: 0.8, max_tokens: 500 });
});

test('请求组装：preparePrompt 的变量更新阶段按规则筛世界书，正文阶段去掉 [mvu_update]', async () => {
    const world = normalizeWorld({ entries: {
        0: { uid: 0, comment: '[initvar]', content: 'hp: 10', disable: true },
        1: { uid: 1, comment: '[mvu_update]变量规则', content: '更新规则内容', constant: true },
        2: { uid: 2, comment: '[mvu_plot]文风', content: '文风内容', constant: true },
        3: { uid: 3, comment: '设定', content: '世界设定内容', constant: true },
        4: { uid: 4, comment: '临时', content: '临时内容', constant: true },
    } });
    const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '角色', description: '描述', first_mes: '开场', extensions: { world: 'w' } } });
    const s = new ChatSession({ card, cardFile: '角色', persona: { name: '我' }, preset: normalizePreset({}), chat: [{ name: '角色', is_user: false, mes: '开场' }, { name: '我', is_user: true, mes: '打你' }, { name: '角色', is_user: false, mes: '被打了' }], meta: {}, settings: { power: { mvu: 'on', mvuSeparate: true } }, worlds: { w: world } });
    const all = (r) => r.messages.map(m => m.content).join('\n');
    const main = all(await s.preparePrompt({ type: 'normal', dryRun: true }));
    assert.doesNotMatch(main, /更新规则内容/);
    assert.match(main, /文风内容/);
    const upd = await s.preparePrompt({ type: 'quiet', dryRun: true, mvuPhase: 'update', mvuFilter: { blacklist: '临时' }, chatOverride: s.chat.slice(0, 3), maxHistory: 2 });
    const wi = `${upd.worldInfo.worldInfoBefore}\n${upd.worldInfo.worldInfoAfter}`;
    assert.match(wi, /更新规则内容/);
    assert.match(wi, /世界设定内容/);
    assert.doesNotMatch(wi, /文风内容/);
    assert.doesNotMatch(wi, /临时内容/);
    assert.deepEqual(upd.history.map(h => h.content), ['打你', '被打了']);
    assert.equal(s.lastMvuFilter.filtered[0].comment, '临时');
});

test('请求策略：依次重试、同时请求、先一次再同时、手动停止', async () => {
    const seq = [];
    let n = 0;
    const flaky = async () => { n++; if (n < 3) throw new Error(`第 ${n} 次失败`); return 'ok'; };
    assert.equal(await runWithStrategy(flaky, { mode: 'seq', count: 3, notice: t => seq.push(t) }), 'ok');
    assert.deepEqual(seq, ['正在请求模型更新变量…', '正在重试（1 / 2）…', '正在重试（2 / 2）…']);
    n = 0;
    await assert.rejects(runWithStrategy(flaky, { mode: 'seq', count: 2 }), /第 2 次失败/);

    // 同时请求：谁先成功用谁，其余的被中止
    const aborted = [];
    let k = 0;
    const racer = (signal) => new Promise((resolve, reject) => {
        const id = k++;
        signal.addEventListener('abort', () => aborted.push(id));
        if (id === 1) setTimeout(() => resolve(`r${id}`), 5);
        else setTimeout(() => reject(new Error('x')), id === 0 ? 1 : 50);
    });
    assert.equal(await runWithStrategy(racer, { mode: 'parallel', count: 3 }), 'r1');
    assert.ok(aborted.includes(2), '其余的请求要被中止');

    // 先一次，失败再同时 count-1 次
    let calls = 0;
    const notes = [];
    const firstFails = async () => { calls++; if (calls === 1) throw new Error('first'); return 'later'; };
    assert.equal(await runWithStrategy(firstFails, { mode: 'once-then-parallel', count: 3, notice: t => notes.push(t) }), 'later');
    assert.equal(calls, 3, '第一次 + 同时两次');
    assert.match(notes[1], /同时请求 2 次/);

    // 手动停止后不再重试
    const ac = new AbortController();
    let tries = 0;
    const stopper = async () => { tries++; ac.abort(); throw new Error('stopped'); };
    await assert.rejects(runWithStrategy(stopper, { mode: 'seq', count: 5, signal: ac.signal }), /已停止/);
    assert.equal(tries, 1);
});

const ai = (mes, stat) => ({ name: '角色', is_user: false, mes, swipe_id: 0, swipes: [mes], variables: stat === undefined ? undefined : [{ stat_data: stat, display_data: stat, delta_data: {}, other: 1 }] });
const user = (mes) => ({ name: '我', is_user: true, mes });

test('自动清理：快照间隔、保留最近几楼、删楼层后恢复', () => {
    const chat = [ai('开场', { hp: 0 })];
    for (let i = 1; i <= 30; i++) chat.push(ai(`<UpdateVariable>_.set('hp', ${i});</UpdateVariable>`, { hp: i }));
    // 清理 [1, 12]，间隔 5：5、10 楼标成快照，其余去掉 MVU 字段（别的变量留着）
    assert.equal(cleanupMessageVariables(chat, 1, 12, 5), 10);
    assert.equal(chat[3].variables[0].stat_data, undefined);
    assert.equal(chat[3].variables[0].other, 1);
    assert.equal(chat[5].variables[0].snapshot, true);
    assert.deepEqual(chat[10].variables[0].stat_data, { hp: 10 });
    assert.deepEqual(chat[13].variables[0].stat_data, { hp: 13 });
    // 已经是快照的不动；再清一遍不重复计数
    assert.equal(cleanupMessageVariables(chat, 1, 12, 5), 0);

    // 自动清理只在楼层数是 5 的倍数时做
    const c2 = [ai('开场', { hp: 0 })];
    for (let i = 1; i <= 29; i++) c2.push(ai('x', { hp: i }));
    assert.equal(c2.length, 30);
    assert.ok(autoCleanup(c2, 29, { keep: 5, interval: 50 }) > 0);
    assert.equal(c2[24].variables[0].stat_data, undefined, '保留最近 5 楼之外的被清掉');
    assert.deepEqual(c2[25].variables[0].stat_data, { hp: 25 });
    c2.push(ai('x', { hp: 30 }));
    assert.equal(autoCleanup(c2, 30, { keep: 5, interval: 50 }), 0, '31 楼不是 5 的倍数');

    // 恢复：最近几楼缺变量 → 从保留范围之前最近的快照重算补回
    const c3 = [ai('开场', { hp: 0 }), user('a')];
    for (let i = 1; i <= 12; i++) c3.push(ai(`<UpdateVariable>_.set('hp', ${i});</UpdateVariable>`, { hp: i }), user('b'));
    c3.pop();
    for (let i = 2; i < c3.length; i++) if (!c3[i].is_user && c3[i].variables) delete c3[i].variables[0].stat_data;
    c3[2].variables[0].stat_data = { hp: 1 }; // 第 2 楼留作起点
    const r = restoreVariables(c3, { keep: 10, restoreRecent: 4 });
    assert.equal(r.status, 'restored');
    const last = c3[c3.length - 1];
    assert.deepEqual(last.variables[0].stat_data, { hp: 12 });
    assert.equal(last.variables[0].other, 1, '别的变量留着');
    assert.equal(restoreVariables(c3, { keep: 10, restoreRecent: 4 }).status, 'not-needed');
    // 找不到起点
    const c4 = [ai('开场'), user('a'), ai('x')];
    assert.equal(restoreVariables(c4, { keep: 1, restoreRecent: 1 }).status, 'unavailable');

    // 清除旧楼层变量：保留最后 depth 楼，其余每 interval 楼留一层
    const c5 = [ai('开场', { hp: 0 })];
    for (let i = 1; i <= 10; i++) c5.push(ai('x', { hp: i }));
    clearOldFloors(c5, 3, 4);
    assert.equal(c5[1].variables[0].stat_data, undefined);
    assert.equal(c5[4].variables[0].snapshot, true);
    assert.deepEqual(c5[8].variables[0].stat_data, { hp: 8 }, '最后 3 楼（8-10）保留');
    assert.deepEqual(c5[0].variables[0].stat_data, { hp: 0 }, '开场白不动');
    assert.equal(markSnapshot(c5, 2), true);
    assert.equal(c5[2].variables[0].snapshot, true);

    // 重演
    const rp = replayRange(chat, 10, 14, chat[10].variables[0]);
    assert.deepEqual(rp.variables.stat_data, { hp: 14 });
    assert.equal(rp.count, 4);
});

test('重新读取初始变量、聊天变量同步', () => {
    const init = { hp: [10, '生命值，0-10'], 新字段: 1, 人物: { 名字: '甲', description: '新描述' } };
    const latest = { hp: [3, '旧描述'], 人物: { 名字: '乙', description: '旧' }, 自己加的: true };
    const m = mergeInitVars(init, latest);
    assert.deepEqual(m, { hp: [3, '生命值，0-10'], 新字段: 1, 人物: { 名字: '乙', description: '新描述' }, 自己加的: true });

    const meta = { variables: { 自己的: 1 } };
    mirrorToChatVars(meta, { stat_data: { hp: 1 }, display_data: { hp: 1 } });
    assert.deepEqual(meta.variables, { 自己的: 1, stat_data: { hp: 1 }, display_data: { hp: 1 } });
    assert.equal(removeMirroredChatVars(meta), true);
    assert.deepEqual(meta.variables, { 自己的: 1 });
    assert.equal(removeMirroredChatVars(meta), false);
});

test('增量校正：变化清单、并进正文、整楼重算', () => {
    assert.deepEqual(collectStateChanges({ a: 1, b: { c: [1] }, d: 1 }, { a: 2, b: { c: [1, 2] }, e: 1 }).map(x => x.path), ['/a', '/b/c', '/d', '/e']);
    const prev = { stat_data: { hp: 10, 地点: '门口', 物品: [] } };
    const original = '正文<UpdateVariable>\n<JSONPatch>[{"op":"delta","path":"/hp","value":-3}]</JSONPatch>\n</UpdateVariable>\n\n<StatusPlaceHolderImpl/>';
    const cur = processMessage(prev, original).variables;
    assert.equal(cur.stat_data.hp, 7);
    const block = '<UpdateVariable><JSONPatch>[{"op":"replace","path":"/地点","value":"书库"},{"op":"replace","path":"/物品","value":["钥匙"]}]</JSONPatch></UpdateVariable>';
    const plan = planRepair(prev, cur, original, block);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.variables.stat_data, { hp: 7, 地点: '书库', 物品: ['钥匙'] }, '原有的 -3 只算一次，校正叠上去');
    assert.ok(plan.content.trimEnd().endsWith('<StatusPlaceHolderImpl/>'), '状态栏占位符保持在最后');
    assert.ok(plan.content.indexOf('-3') < plan.content.indexOf('书库'), '校正放在原有更新之后');
    assert.deepEqual(plan.changes.map(c => c.path), ['/地点', '/物品']);
    assert.equal(plan.commands.length, 2);
    // 原有更新块没闭合：先补上结尾
    const open = appendRepairBlock('正文<UpdateVariable>_.set(\'hp\', 1);', block);
    assert.deepEqual(processMessage({ stat_data: { hp: 9, 地点: 'x', 物品: [] } }, open).variables.stat_data, { hp: 1, 地点: '书库', 物品: ['钥匙'] });
    // 没有更新块：加在末尾
    assert.match(appendRepairBlock('只有正文', '[{"op":"replace","path":"/hp","value":1}]'), /只有正文\n\n<UpdateVariable>/);
    assert.equal(appendRepairBlock('x', '  '), 'x');
});

test('角色卡覆盖：读、改、存、和用户设置合并', () => {
    const entry = { comment: '[config_override]', disable: true, content: JSON.stringify({ 更新方式: '额外模型解析', 额外模型解析配置: { 启用自动请求: false, 世界书条目白名单正则: '人物', 别的扩展: 1 }, schema: {} }) };
    const r = readOverride([{ comment: '[config_override]', disable: false, content: '{}' }, entry]);
    assert.equal(r.entry, entry, '开着的同名条目不算');
    assert.equal(r.draft.额外模型解析配置.别的扩展, 1, '未知字段保留');
    const eff = applyOverride({ ...MVU_DEFAULTS, mvuSeparate: false, mvuAuto: true, mvuWhitelist: '地点' }, r.draft);
    assert.equal(eff.mvuSeparate, true);
    assert.equal(eff.mvuAuto, false);
    assert.equal(eff.mvuWhitelist, '地点', '用户自己的白名单不被替换');
    assert.equal(eff.charWhitelist, '人物', '角色卡的白名单叠加');
    assert.equal(hasOverride(r.draft, '兼容性.更新到聊天变量'), false);
    let d = setOverride(r.draft, '兼容性.更新到聊天变量', true);
    d = setOverride(d, '额外模型解析配置.世界书条目白名单正则', '  ');
    d = setOverride(d, '更新方式', undefined);
    assert.deepEqual(d, { 额外模型解析配置: { 启用自动请求: false, 别的扩展: 1 }, 兼容性: { 更新到聊天变量: true } });
    const text = serializeOverride(d);
    const doc = JSON.parse(text);
    assert.equal(Object.keys(doc).at(-1), 'schema', 'schema 放最后');
    assert.deepEqual(readOverride([{ ...entry, content: text }]).draft, d);
    assert.match(readOverride([{ ...entry, content: '{坏的' }]).error, /JSON|Unexpected|Expected/);
    assert.equal(hasOverride({ 额外模型解析配置: { 世界书条目白名单正则: '(' } }, '额外模型解析配置.世界书条目白名单正则'), false, '无效正则不算覆盖中');

    // 会话：从角色主世界书读覆盖
    const world = normalizeWorld({ entries: { 0: { uid: 0, ...entry } } });
    const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '角色', first_mes: '开场', extensions: { world: 'w' } } });
    const s = new ChatSession({ card, cardFile: '角色', persona: { name: '我' }, preset: normalizePreset({}), chat: [], meta: {}, settings: { power: { mvu: 'on' } }, worlds: { w: world } });
    assert.equal(s.mvuSettings().mvuSeparate, true);
    assert.equal(s.mvuSeparateActive(), true);
    // 内嵌世界书
    const card2 = normalizeCard({ spec: 'chara_card_v2', data: { name: '角色', first_mes: '开场', character_book: { entries: [{ id: 0, keys: [], comment: '[config_override]', enabled: false, content: '{"兼容性":{"更新到聊天变量":true}}' }] } } });
    const s2 = new ChatSession({ card: card2, cardFile: '角色', persona: { name: '我' }, preset: normalizePreset({}), chat: [], meta: {}, settings: { power: {} }, worlds: {} });
    assert.equal(s2.primaryWorld().kind, 'embedded');
    assert.equal(s2.mvuSettings().mvuChatVars, true);
});
