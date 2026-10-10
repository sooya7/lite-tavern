#!/usr/bin/env node
// 共用酒馆数据目录之前的体检（只读，不改任何文件）：
// 把酒馆目录里的每张角色卡、每本世界书、每个预设、每个聊天，按这边“读进来 → 存回去”的流程在内存里走一遍，
// 看存回去的内容有没有比原来少东西、改了值。酒馆（包括 Luker 这类分支）自己加的字段也算，丢了就报出来。
// 用法：node tools/st-roundtrip-check.mjs <酒馆的用户数据目录>
import fs from 'node:fs';
import path from 'node:path';
import { readCardJson, writeCardPng, extractChunks } from '../public/js/core/png.js';
import { normalizeCard, toExportCard } from '../public/js/core/card.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';
import { normalizePreset } from '../public/js/core/preset.js';
import { parseChatJsonl, serializeChat } from '../public/js/core/chat.js';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(path.join(root, 'characters'))) {
    console.error('用法：node tools/st-roundtrip-check.mjs <酒馆的用户数据目录>');
    process.exit(1);
}

/** before 里有的东西 after 里是不是都还在、值一样。返回对不上的路径（最多 max 条） */
function lost(before, after, allow = () => false, at = '', out = [], max = 6) {
    if (out.length >= max || allow(at)) return out;
    if (before === null || typeof before !== 'object') {
        if (before !== after && !(Number.isNaN(before) && Number.isNaN(after))) out.push(`${at || '(根)'}：${JSON.stringify(before)?.slice(0, 40)} → ${JSON.stringify(after)?.slice(0, 40)}`);
        return out;
    }
    if (after === null || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) { out.push(`${at || '(根)'}：结构变了`); return out; }
    // 数组后面多出几项（比如补上缺的默认提示词条目）不算丢，少了才算
    if (Array.isArray(before) && before.length > after.length) { out.push(`${at}：数组长度 ${before.length} → ${after.length}`); return out; }
    for (const k of Object.keys(before)) {
        if (!(k in after)) { if (before[k] !== undefined && !allow(`${at}.${k}`)) out.push(`${at}.${k}：没了`); continue; }
        lost(before[k], after[k], allow, `${at}.${k}`, out, max);
    }
    return out;
}

const files = (dir, re) => { try { return fs.readdirSync(dir).filter(f => re.test(f)).map(f => path.join(dir, f)); } catch { return []; } };
const report = [];
const count = { 角色卡: 0, 世界书: 0, 预设: 0, 聊天: 0 };
const note = (kind, file, items) => { if (items.length) report.push(`${kind} ${path.relative(root, file)}\n    ${items.join('\n    ')}`); };

// 角色卡：读 → 规范化 → 导出结构 → 写回 PNG → 再读
for (const f of files(path.join(root, 'characters'), /\.png$/i)) {
    count.角色卡++;
    try {
        const bytes = new Uint8Array(fs.readFileSync(f));
        const raw = JSON.parse(readCardJson(bytes));
        const out = toExportCard(normalizeCard(raw));
        const again = JSON.parse(readCardJson(writeCardPng(bytes, out)));
        // 这几处是有意统一的：规范版本号（PNG 里 chara 写 V2、ccv3 写 V3，和酒馆一样）、顶层的 V1 镜像字段跟着 data 走、正则补齐默认字段
        const allow = (p) => /^\.(spec|spec_version|name|description|personality|scenario|first_mes|mes_example|creatorcomment|tags|talkativeness|fav)$/.test(p) || /^\.data\.extensions\.regex_scripts\.\d+\./.test(p);
        const items = lost(raw, again, allow);
        // 正则：原有字段的值不能变（补默认值可以）
        const rs = raw.data?.extensions?.regex_scripts;
        if (Array.isArray(rs)) items.push(...lost(rs, again.data.extensions.regex_scripts, (p) => false, '.data.extensions.regex_scripts').map(x => `正则 ${x}`));
        // 图片本身：除了卡数据那两块，别的数据块原样
        const img = (b) => extractChunks(b).filter(c => c.name !== 'tEXt').map(c => `${c.name}:${c.data.length}`).join(',');
        if (img(bytes) !== img(writeCardPng(bytes, out))) items.push('图片数据块变了');
        note('角色卡', f, items);
    } catch (e) {
        note('角色卡', f, [`读不了：${e.message}`]);
    }
}

for (const f of files(path.join(root, 'worlds'), /\.json$/)) {
    count.世界书++;
    try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        // entries 是数组时这边统一成按 uid 的对象（酒馆自己存的都是对象）
        const before = Array.isArray(raw.entries) ? { ...raw, entries: Object.fromEntries(raw.entries.map((e, i) => [e?.uid ?? i, e])) } : raw;
        note('世界书', f, lost(before, JSON.parse(JSON.stringify(normalizeWorld(raw)))));
    } catch (e) {
        note('世界书', f, [`读不了：${e.message}`]);
    }
}

for (const f of files(path.join(root, 'OpenAI Settings'), /\.json$/)) {
    count.预设++;
    try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        note('预设', f, lost(raw, JSON.parse(JSON.stringify(normalizePreset(JSON.parse(JSON.stringify(raw)))))));
    } catch (e) {
        note('预设', f, [`读不了：${e.message}`]);
    }
}

for (const dir of files(path.join(root, 'chats'), /./)) {
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of files(dir, /\.jsonl$/)) {
        count.聊天++;
        try {
            const text = fs.readFileSync(f, 'utf8');
            const lines = text.split(/\r?\n/).filter(l => l.trim());
            const { header, messages } = parseChatJsonl(text);
            const items = [];
            const back = serializeChat(header, messages).split('\n').filter(Boolean);
            if (back.length !== lines.length) items.push(`行数 ${lines.length} → ${back.length}（有读不出来的行，存回去会丢）`);
            else for (let i = 0; i < lines.length && items.length < 4; i++) {
                const d = lost(JSON.parse(lines[i].replace(/^﻿/, '')), JSON.parse(back[i]));
                if (d.length) items.push(`第 ${i + 1} 行 ${d[0]}`);
            }
            note('聊天', f, items);
        } catch (e) {
            note('聊天', f, [`读不了：${e.message}`]);
        }
    }
}

console.log(`检查了：${Object.entries(count).map(([k, v]) => `${k} ${v}`).join('、')}`);
if (!report.length) console.log('存回去不会丢东西，也不会改掉原有的值。');
else {
    console.log(`有 ${report.length} 个文件存回去会和原来不一样：`);
    for (const r of report) console.log('  ' + r);
    process.exitCode = 2;
}
