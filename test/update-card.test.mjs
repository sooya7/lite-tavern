// 用新版卡文件原地更新角色卡：内容和自带世界书直接覆盖，聊天记录保留，不留备份
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { readCardJson, isPng } from '../public/js/core/png.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'test-card.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const bytesOf = (card) => Buffer.from(JSON.stringify(card), 'utf8');

let dir, store;
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-upd-'));
    store = new Store(dir);
});
after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const allFiles = (sub) => {
    const out = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : out.push(path.join(d, f.name)); };
    if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub));
    return out;
};

test('更新角色卡：内容、自带世界书直接覆盖；聊天、收藏、文件名不变；不留备份', async () => {
    const { file, world } = await store.importCard(bytesOf(FIXTURE), 'test-card.json');
    assert.ok(world, '测试卡应该带世界书');
    const id = file.replace(/\.png$/, '');
    // 用户这边：收藏了这张卡，聊过天，还手改过世界书
    const card0 = await store.readCard(file);
    card0.data.extensions.fav = true;
    await store.saveCard(file, card0);
    await store.saveChat(id, '聊天一', '{"user_name":"User","character_name":"x"}\n{"name":"x","is_user":false,"mes":"旧聊天内容"}\n');
    const worldFile = path.join(dir, 'worlds', `${world}.json`);
    fs.writeFileSync(worldFile, JSON.stringify({ entries: { 0: { uid: 0, key: ['手改'], content: '用户手改过的条目' } }, name: world }));
    const avatarBefore = fs.readFileSync(path.join(dir, 'characters', file));
    const backupsBefore = allFiles('backups').length;

    // 新版：改了名字、版本、开场白、世界书条目，去掉了正则
    const v2 = clone(FIXTURE);
    v2.data.name = FIXTURE.data.name + ' 改';
    v2.data.character_version = '2.0';
    v2.data.first_mes = '新版开场白';
    v2.data.character_book.entries[0].content = '新版世界书条目';
    v2.data.extensions.regex_scripts = [];
    const r = await store.updateCard(file, bytesOf(v2));

    assert.equal(r.file, file, '文件名不变');
    assert.equal(r.oldName, FIXTURE.data.name);
    assert.equal(r.world, world, '接着用原来关联的那本世界书');
    assert.equal(r.worldReplaced, true);
    assert.equal(r.avatarChanged, false, '新文件是 JSON，头像保留');
    const card = await store.readCard(file);
    assert.equal(card.data.name, v2.data.name);
    assert.equal(card.data.character_version, '2.0');
    assert.equal(card.data.first_mes, '新版开场白');
    assert.equal((card.data.extensions.regex_scripts ?? []).length, 0, '新版没有的东西不保留');
    assert.equal(card.data.extensions.fav, true, '收藏是用户自己的标记，保留');
    assert.equal(card.data.extensions.world, world);
    const w = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
    const contents = Object.values(w.entries).map(e => e.content);
    assert.ok(contents.includes('新版世界书条目') && !contents.includes('用户手改过的条目'), '世界书直接覆盖');
    assert.match(await store.readChat(id, '聊天一'), /旧聊天内容/, '聊天记录保留');
    assert.equal((await store.listChats(id)).length, 1);
    assert.equal(allFiles('backups').length, backupsBefore, '不留备份');
    assert.equal(allFiles('characters').length, 1, '不多出一张卡');
    // 头像（PNG 的图像数据）没变：只换了里面的卡数据
    const after1 = fs.readFileSync(path.join(dir, 'characters', file));
    assert.ok(isPng(new Uint8Array(after1)));
    assert.equal((await store.listCharacters()).find(c => c.file === file).name, v2.data.name, '角色列表读到新名字');

    // 新文件是 PNG：头像也换
    const other = await store.importCard(bytesOf({ ...clone(v2), data: { ...clone(v2).data, name: '另一张', character_version: '3.0' } }), 'other.json', { importBook: false });
    const otherPng = fs.readFileSync(path.join(dir, 'characters', other.file));
    const r3 = await store.updateCard(file, otherPng);
    assert.equal(r3.avatarChanged, true);
    assert.equal((await store.readCard(file)).data.character_version, '3.0');
    assert.equal(JSON.parse(readCardJson(new Uint8Array(fs.readFileSync(path.join(dir, 'characters', file))))).data.name, '另一张');
    assert.match(await store.readChat(id, '聊天一'), /旧聊天内容/);
    void avatarBefore;
});

test('更新角色卡：选错文件（不是角色卡）时拒绝，原来的卡不动', async () => {
    const { file } = await store.importCard(bytesOf(FIXTURE), 'keep.json', { importBook: false });
    const before = fs.readFileSync(path.join(dir, 'characters', file));
    for (const bad of [Buffer.from('不是 JSON'), bytesOf({ prompts: [], temperature: 1 }), bytesOf({ entries: { 0: { content: 'x' } } }), bytesOf([1, 2, 3])]) {
        await assert.rejects(() => store.updateCard(file, bad), (e) => e.status === 400);
    }
    assert.deepEqual(fs.readFileSync(path.join(dir, 'characters', file)), before);
    await assert.rejects(() => store.updateCard('没有这张卡.png', bytesOf(FIXTURE)), (e) => e.status === 404);
});
