// 扫描一个 SillyTavern 用户数据目录，统计预设/角色卡/世界书实际用到的特性。
// 只读，不改任何文件。用法: node tools/st-compat-scan.mjs <ST data/default-user 目录>
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) {
    console.error('usage: node tools/st-compat-scan.mjs <data/default-user>');
    process.exit(1);
}

const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n = 40) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}×${v}`).join('  ');

function macroNames(text, map) {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(/\{\{\s*([^{}:\s]+)/g)) bump(map, m[1].toLowerCase().replace(/^\/\/.*/, '//'));
}

function featureFlags(text, map) {
    if (typeof text !== 'string') return;
    if (/<%[\s\S]*?%>/.test(text)) bump(map, 'ejs <% %>');
    if (/@@\w+/.test(text)) bump(map, '@@decorator');
    if (/<script[\s>]/i.test(text)) bump(map, '<script>');
    if (/<style[\s>]/i.test(text)) bump(map, '<style>');
    if (/```html/i.test(text)) bump(map, '```html');
    if (/<html|<body|<!DOCTYPE/i.test(text)) bump(map, 'full-html-doc');
    if (/getvar|setvar/i.test(text)) bump(map, 'vars');
    if (/stat_data|_.set\(|mvu|MagVar/i.test(text)) bump(map, 'mvu-ish');
}

function readPngChunks(buf) {
    const out = {};
    let off = 8;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'tEXt') {
            const zero = data.indexOf(0);
            out[data.toString('latin1', 0, zero)] = data.toString('latin1', zero + 1);
        }
        off += 12 + len;
        if (type === 'IEND') break;
    }
    return out;
}

// ---------- presets ----------
const presetDir = path.join(root, 'OpenAI Settings');
console.log('=== Chat Completion presets ===');
const presetKeys = new Map(), promptMacros = new Map(), promptFeatures = new Map(), extKeys = new Map();
const regexPlacement = new Map(), regexFlags = new Map(), injPos = new Map(), orderIds = new Map();
for (const f of fs.readdirSync(presetDir).filter(f => f.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(presetDir, f), 'utf8'));
    Object.keys(j).forEach(k => bump(presetKeys, k));
    const prompts = j.prompts || [];
    let enabled = 0;
    const order = (j.prompt_order || []);
    order.forEach(o => bump(orderIds, String(o.character_id)));
    const main = order.find(o => o.character_id === 100001) || order[0];
    if (main) enabled = main.order.filter(x => x.enabled).length;
    prompts.forEach(p => {
        bump(injPos, `pos${p.injection_position ?? '-'}/${p.role ?? '-'}`);
        if (p.injection_trigger?.length) bump(injPos, 'has_trigger');
        macroNames(p.content, promptMacros);
        featureFlags(p.content, promptFeatures);
    });
    const ext = j.extensions || {};
    Object.keys(ext).forEach(k => bump(extKeys, k));
    const rx = ext.regex_scripts || [];
    rx.forEach(r => {
        (r.placement || []).forEach(p => bump(regexPlacement, p));
        if (r.markdownOnly) bump(regexFlags, 'markdownOnly');
        if (r.promptOnly) bump(regexFlags, 'promptOnly');
        if (r.runOnEdit) bump(regexFlags, 'runOnEdit');
        if (r.substituteRegex) bump(regexFlags, `substituteRegex=${r.substituteRegex}`);
        if (r.minDepth != null && r.minDepth !== '') bump(regexFlags, 'minDepth');
        if (r.maxDepth != null && r.maxDepth !== '') bump(regexFlags, 'maxDepth');
        if (r.disabled) bump(regexFlags, 'disabled');
        featureFlags(r.replaceString, promptFeatures);
    });
    const th = ext.tavern_helper || ext.TavernHelper_scripts;
    console.log(`- ${f}: prompts=${prompts.length} enabled=${enabled} regex=${rx.length} ext=[${Object.keys(ext).join(',')}] th=${th ? JSON.stringify(th).length + 'B' : '-'}`);
}
console.log('preset keys:', top(presetKeys, 200));
console.log('prompt_order ids:', top(orderIds));
console.log('injection pos/role:', top(injPos));
console.log('macros in prompts:', top(promptMacros, 80));
console.log('features:', top(promptFeatures));
console.log('preset ext keys:', top(extKeys));
console.log('regex placement:', top(regexPlacement), '| flags:', top(regexFlags));

// ---------- characters ----------
console.log('\n=== Characters ===');
const cardMacros = new Map(), cardFeatures = new Map();
for (const f of fs.readdirSync(path.join(root, 'characters'))) {
    const p = path.join(root, 'characters', f);
    if (!f.endsWith('.png')) continue;
    const chunks = readPngChunks(fs.readFileSync(p));
    const raw = chunks.ccv3 || chunks.chara;
    const card = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const d = card.data || card;
    const ext = d.extensions || {};
    const book = d.character_book;
    for (const k of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions']) {
        macroNames(d[k], cardMacros);
        featureFlags(d[k], cardFeatures);
    }
    (d.alternate_greetings || []).forEach(g => { macroNames(g, cardMacros); featureFlags(g, cardFeatures); });
    (book?.entries || []).forEach(e => { macroNames(e.content, cardMacros); featureFlags(e.content, cardFeatures); });
    const rx = ext.regex_scripts || [];
    rx.forEach(r => featureFlags(r.replaceString, cardFeatures));
    console.log(`- ${f}: spec=${card.spec || 'v1'} ${card.spec_version || ''} chunks=[${Object.keys(chunks)}] alt=${(d.alternate_greetings || []).length} book=${book?.entries?.length ?? 0} regex=${rx.length} ext=[${Object.keys(ext).join(',')}] desc=${(d.description || '').length}ch first=${(d.first_mes || '').length}ch`);
    if (ext.tavern_helper) console.log('   tavern_helper:', JSON.stringify(ext.tavern_helper).slice(0, 300));
    if (ext.depth_prompt) console.log('   depth_prompt:', JSON.stringify(ext.depth_prompt).slice(0, 120));
}
console.log('macros in cards:', top(cardMacros, 60));
console.log('card features:', top(cardFeatures));

// ---------- worlds ----------
console.log('\n=== World info ===');
const wiKeys = new Map(), wiPos = new Map(), wiMacros = new Map(), wiFeatures = new Map(), wiFlags = new Map();
for (const f of fs.readdirSync(path.join(root, 'worlds')).filter(f => f.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'worlds', f), 'utf8'));
    const entries = Object.values(j.entries || {});
    entries.forEach(e => {
        Object.keys(e).forEach(k => bump(wiKeys, k));
        bump(wiPos, `pos${e.position}${e.position === 4 ? '/d' + e.depth + '/r' + e.role : ''}`);
        if (e.constant) bump(wiFlags, 'constant');
        if (e.selective && e.keysecondary?.length) bump(wiFlags, `selective/logic${e.selectiveLogic}`);
        if (e.disable) bump(wiFlags, 'disabled');
        if (e.useProbability && e.probability < 100) bump(wiFlags, 'probability<100');
        if (e.group) bump(wiFlags, 'group');
        if (e.sticky) bump(wiFlags, 'sticky');
        if (e.cooldown) bump(wiFlags, 'cooldown');
        if (e.delay) bump(wiFlags, 'delay');
        if (e.excludeRecursion) bump(wiFlags, 'excludeRecursion');
        if (e.preventRecursion) bump(wiFlags, 'preventRecursion');
        if (e.delayUntilRecursion) bump(wiFlags, 'delayUntilRecursion');
        if (e.scanDepth != null) bump(wiFlags, 'scanDepth');
        if (e.key?.some(k => /^\/.+\/[a-z]*$/.test(k))) bump(wiFlags, 'regexKey');
        if (e.outletName) bump(wiFlags, 'outlet');
        if (e.triggers?.length) bump(wiFlags, 'triggers');
        if (e.characterFilter?.names?.length || e.characterFilter?.tags?.length) bump(wiFlags, 'characterFilter');
        macroNames(e.content, wiMacros);
        featureFlags(e.content, wiFeatures);
    });
    console.log(`- ${f}: entries=${entries.length}`);
}
console.log('wi entry keys:', top(wiKeys, 80));
console.log('wi positions:', top(wiPos));
console.log('wi flags:', top(wiFlags));
console.log('macros in wi:', top(wiMacros, 60));
console.log('wi features:', top(wiFeatures));

// ---------- settings.json ----------
console.log('\n=== settings.json (no secrets printed) ===');
const s = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
const es = s.extension_settings || {};
console.log('top keys:', Object.keys(s).join(','));
console.log('extension_settings keys:', Object.keys(es).join(','));
console.log('global regex:', (es.regex || []).length, 'preset_allowed_regex:', JSON.stringify(es.preset_allowed_regex || {}).length, 'character_allowed_regex:', (es.character_allowed_regex || []).length);
const pu = s.power_user || {};
console.log('persona_description_position:', pu.persona_description_position, 'personas:', Object.keys(pu.personas || {}).length);
const wi = s.world_info_settings || {};
console.log('world_info_settings:', JSON.stringify({ ...wi, world_info: undefined }).slice(0, 600));
console.log('main_api:', s.main_api, 'chat_completion_source:', s.oai_settings?.chat_completion_source, 'preset:', s.oai_settings?.preset_settings_openai);
