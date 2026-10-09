// 统计 EJS 模板 (ST-Prompt-Template) 与酒馆助手脚本的实际用法。只读。
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n = 60) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}×${v}`).join('  ');

const ejsCalls = new Map(), decorators = new Map(), thScripts = [], thApi = new Map();
const samples = [];

function scanText(text, where) {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/<%([\s\S]*?)%>/g)) {
        const code = m[1];
        for (const c of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) bump(ejsCalls, c[1]);
        if (samples.length < 12 && code.length > 20) samples.push(`[${where}] <%${code.slice(0, 160).replace(/\s+/g, ' ')}%>`);
    }
    for (const m of text.matchAll(/^@@(\w+)/gm)) bump(decorators, m[1]);
}

function scanScript(code) {
    for (const c of code.matchAll(/\b([a-z][A-Za-z]+)\s*\(/g)) bump(thApi, c[1]);
}

function collectTH(th, owner) {
    const scripts = th?.scripts || (Array.isArray(th) ? th : []);
    for (const s of scripts) {
        const content = s.content || '';
        const imports = [...content.matchAll(/import\(['"`]([^'"`]+)/g)].map(m => m[1]);
        thScripts.push(`${owner} :: ${s.name} (${s.type || 'script'}, ${content.length}B${s.enabled === false ? ', off' : ''})${imports.length ? ' imports=' + imports.join(',') : ''}`);
        scanScript(content);
        (s.button?.buttons || s.buttons || []).forEach(b => thScripts.push(`    button: ${b.name}`));
    }
}

for (const f of fs.readdirSync(path.join(root, 'OpenAI Settings'))) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'OpenAI Settings', f), 'utf8'));
    (j.prompts || []).forEach(p => scanText(p.content, `preset:${f}`));
    (j.extensions?.regex_scripts || []).forEach(r => scanText(r.replaceString, `preset-regex:${f}`));
    collectTH(j.extensions?.tavern_helper, f);
}
for (const f of fs.readdirSync(path.join(root, 'worlds'))) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'worlds', f), 'utf8'));
    Object.values(j.entries || {}).forEach(e => scanText(e.content, `wi:${f}`));
}
function readPngText(buf) {
    const out = {};
    let off = 8;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'tEXt') {
            const data = buf.subarray(off + 8, off + 8 + len);
            const z = data.indexOf(0);
            out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1);
        }
        off += 12 + len;
        if (type === 'IEND') break;
    }
    return out;
}
for (const f of fs.readdirSync(path.join(root, 'characters')).filter(f => f.endsWith('.png'))) {
    const t = readPngText(fs.readFileSync(path.join(root, 'characters', f)));
    const card = JSON.parse(Buffer.from(t.ccv3 || t.chara, 'base64').toString('utf8'));
    const d = card.data || card;
    ['description', 'first_mes', 'mes_example', 'scenario', 'system_prompt', 'post_history_instructions'].forEach(k => scanText(d[k], `card:${f}:${k}`));
    (d.character_book?.entries || []).forEach(e => scanText(e.content, `card-book:${f}`));
    (d.extensions?.regex_scripts || []).forEach(r => scanText(r.replaceString, `card-regex:${f}`));
    collectTH(d.extensions?.tavern_helper, f);
}

console.log('EJS calls:', top(ejsCalls));
console.log('decorators:', top(decorators));
console.log('\nEJS samples:\n' + samples.join('\n'));
console.log('\nTavernHelper scripts:\n' + thScripts.join('\n'));
console.log('\nTH api calls (top):', top(thApi, 80));
