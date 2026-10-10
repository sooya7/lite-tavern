import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMvuUpdateRule, toUpdateBlock, buildMvuUpdateMessages, stripUpdateBlocks } from '../public/js/core/mvu-extra.js';
import { processMessage } from '../public/js/core/mvu.js';
import { ChatSession } from '../public/js/core/session.js';
import { normalizeCard } from '../public/js/core/card.js';
import { normalizePreset } from '../public/js/core/preset.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';

test('变量单独更新：规则识别、结果转成更新块', () => {
    assert.equal(isMvuUpdateRule('请在末尾输出 <UpdateVariable> 块'), true);
    assert.equal(isMvuUpdateRule("_.set('a', 1)"), true);
    assert.equal(isMvuUpdateRule('普通设定', '[mvu_update] 规则'), true);
    assert.equal(isMvuUpdateRule('普通设定', '人物'), false);

    const b = toUpdateBlock('{"analysis":"受伤","patch":[{"op":"delta","path":"/hp","value":-3},{"bad":1}]}');
    assert.match(b, /<Analysis>受伤<\/Analysis>/);
    assert.deepEqual(processMessage({ stat_data: { hp: 10 } }, `正文\n${b}`).variables.stat_data, { hp: 7 });
    assert.deepEqual(processMessage({ stat_data: { hp: 10 } }, toUpdateBlock('[{"op":"replace","path":"/hp","value":1}]')).variables.stat_data, { hp: 1 });
    const txt = toUpdateBlock("好的\n<UpdateVariable>\n_.set('hp', 10, 2);\n</UpdateVariable>");
    assert.deepEqual(processMessage({ stat_data: { hp: 10 } }, txt).variables.stat_data, { hp: 2 });
    assert.equal(toUpdateBlock('没有更新'), '');
    assert.equal(stripUpdateBlocks('a<UpdateVariable>x</UpdateVariable>b<StatusPlaceHolderImpl/>'), 'ab');

    const msgs = buildMvuUpdateMessages({ rules: ['hp 范围 0-10'], statData: { hp: 5 }, history: [{ name: '我', text: '打你' }], reply: { name: '角色', text: '被打了' } });
    assert.equal(msgs.length, 2);
    assert.match(msgs[0].content, /hp 范围 0-10/);
    assert.match(msgs[1].content, /hp: 5/);
    assert.match(msgs[1].content, /被打了/);
});

test('变量单独更新：规则条目只进更新请求，不进正文', async () => {
    const world = normalizeWorld({ entries: {
        0: { uid: 0, comment: '[initvar]', content: 'hp: 10', disable: true },
        1: { uid: 1, comment: '变量规则', content: '每次回复末尾输出 <UpdateVariable> 更新 hp', constant: true },
        2: { uid: 2, comment: '设定', content: '这里是世界设定', constant: true },
    } });
    const card = normalizeCard({ spec: 'chara_card_v2', data: { name: '角色', first_mes: '开场', extensions: { world: 'w' } } });
    const make = (power) => new ChatSession({ card, cardFile: '角色', persona: { name: '我' }, preset: normalizePreset({}), chat: [{ name: '角色', is_user: false, mes: '开场' }, { name: '我', is_user: true, mes: '打你' }], meta: {}, settings: { power }, worlds: { w: world } });

    const inline = make({ mvu: 'auto' });
    const all = (await inline.preparePrompt({ type: 'normal', dryRun: true })).messages.map(m => m.content).join('\n');
    assert.match(all, /UpdateVariable/);

    const sep = make({ mvu: 'auto', mvuSeparate: true });
    assert.equal(sep.mvuSeparateActive(), true);
    const main = (await sep.preparePrompt({ type: 'normal', dryRun: true })).messages.map(m => m.content).join('\n');
    assert.doesNotMatch(main, /UpdateVariable/);
    assert.match(main, /世界设定/);

    sep.chat.push({ name: '角色', is_user: false, mes: '被打了<StatusPlaceHolderImpl/>' });
    const parts = sep.mvuUpdateParts(2);
    assert.deepEqual(parts.statData, { hp: 10 });
    assert.equal(parts.rules.length, 1);
    assert.equal(parts.reply.text, '被打了');
    assert.deepEqual(parts.history.map(h => h.text), ['开场', '打你']);
});
