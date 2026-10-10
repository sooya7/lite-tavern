// 从链接下载角色卡：只认 Discord 附件直链，换成原文件地址；下回来不是角色卡就丢弃
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCardUrl, fetchCardFromUrl, inspectCardBytes } from '../server/fetch-url.mjs';
import { Store } from '../server/store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CARD = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'test-card.json'));
const is400 = (re) => (e) => e.status === 400 && (!re || re.test(e.message));

test('链接整理：只认 Discord 附件，一律换成原文件地址', () => {
    const a = normalizeCardUrl('https://cdn.discordapp.com/attachments/111/222/%E5%B0%98%E4%B8%96.png?ex=6708a1b2&is=67074f32&hm=abcdef0123&');
    assert.equal(a.url, 'https://cdn.discordapp.com/attachments/111/222/%E5%B0%98%E4%B8%96.png?ex=6708a1b2&is=67074f32&hm=abcdef0123');
    assert.equal(a.name, '尘世.png');
    // 预览图的链接（media 域名 + 转码参数）会丢卡数据：换回原文件
    const b = normalizeCardUrl('看这个 https://media.discordapp.net/attachments/1/2/card.png?ex=aa&is=bb&hm=cc&format=webp&quality=lossless&width=400&height=600 谢谢');
    assert.equal(b.url, 'https://cdn.discordapp.com/attachments/1/2/card.png?ex=aa&is=bb&hm=cc');
    assert.equal(normalizeCardUrl('http://cdn.discordapp.com/attachments/1/2/c.json').url, 'https://cdn.discordapp.com/attachments/1/2/c.json', '一律走 https');
    // 不认的：说明该贴什么
    assert.throws(() => normalizeCardUrl(''), is400(/复制链接/));
    assert.throws(() => normalizeCardUrl('https://discord.com/channels/1/2/3'), is400(/消息的链接/));
    assert.throws(() => normalizeCardUrl('https://example.com/attachments/1/2/c.png'), is400(/只支持 Discord/));
    assert.throws(() => normalizeCardUrl('https://cdn.discordapp.com/avatars/1/2.png'), is400(/不是 Discord 附件/));
    // 想借它访问服务器内部的：一律拒绝
    for (const bad of ['http://127.0.0.1:9091/proxies', 'https://169.254.169.254/latest/meta-data', 'https://cdn.discordapp.com.evil.com/attachments/1/2/c.png', 'https://cdn.discordapp.com@127.0.0.1/attachments/1/2/c.png', 'file:///etc/passwd']) {
        assert.throws(() => normalizeCardUrl(bad), (e) => e.status === 400, bad);
    }
});

test('按链接下载：是角色卡才交出去；过大、不是卡、空文件都拒绝', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-url-'));
    try {
        const store = new Store(dir);
        const { file } = await store.importCard(CARD, 'c.json', { importBook: false });
        const png = fs.readFileSync(path.join(dir, 'characters', file));
        const link = 'https://cdn.discordapp.com/attachments/1/2/x?ex=aa&is=bb&hm=cc';
        let asked = '';
        const r = await fetchCardFromUrl(link, { download: async (u, o) => { asked = u; assert.equal(o.maxBytes, 40 * 1024 * 1024); return png; } });
        assert.equal(asked, link);
        assert.equal(r.png, true);
        assert.equal(r.cardName, JSON.parse(CARD).data.name);
        assert.equal(r.name, 'x.png', '链接里没有扩展名时按内容补上');
        assert.deepEqual(r.bytes, png);
        const j = await fetchCardFromUrl('https://cdn.discordapp.com/attachments/1/2/card.json', { download: async () => CARD });
        assert.equal(j.png, false);
        assert.equal(j.name, 'card.json');
        // 拿下回来的 PNG 去更新，和选本地文件一样能用
        const up = await store.updateCard(file, r.bytes);
        assert.equal(up.card.data.name, r.cardName);

        const plainPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        await assert.rejects(() => fetchCardFromUrl(link, { download: async () => plainPng }), (e) => e.status === 422 && /没有卡的数据/.test(e.message));
        await assert.rejects(() => fetchCardFromUrl(link, { download: async () => Buffer.from('<html>not found</html>') }), (e) => e.status === 422);
        await assert.rejects(() => fetchCardFromUrl(link, { download: async () => Buffer.from(JSON.stringify({ prompts: [], temperature: 1 })) }), (e) => e.status === 422);
        await assert.rejects(() => fetchCardFromUrl(link, { download: async () => Buffer.alloc(0) }), (e) => e.status === 502);
        await assert.rejects(() => fetchCardFromUrl(link, { maxBytes: 100, download: async () => png }), (e) => e.status === 413);
        await assert.rejects(() => fetchCardFromUrl('https://example.com/a.png', { download: async () => { throw new Error('不该去下载'); } }), (e) => e.status === 400);
        assert.throws(() => inspectCardBytes(Buffer.from('[1,2]')), (e) => e.status === 422);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
