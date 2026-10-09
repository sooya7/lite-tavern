// 用本机酒馆的真实数据（只读）跑一遍提示词组装，检查兼容性。
// 用法: node tools/smoke-real.mjs <ST data/default-user> [卡文件名] [预设名] [聊天文件相对路径]
import fs from 'node:fs';
import path from 'node:path';
import { readCardJson } from '../public/js/core/png.js';
import { normalizeCard } from '../public/js/core/card.js';
import { normalizePreset } from '../public/js/core/preset.js';
import { normalizeWorld } from '../public/js/core/worldinfo.js';
import { parseChatJsonl } from '../public/js/core/chat.js';
import { ChatSession } from '../public/js/core/session.js';
import { estimateMessagesTokens } from '../public/js/core/tokens.js';

const root = process.argv[2] ?? 'D:/SillyTavern/SillyTavern/data/default-user';
const cardFile = process.argv[3] ?? '生活系游戏.png';
const presetName = process.argv[4] ?? '命定之诗Kemini5-3.8';
const chatArg = process.argv[5];

const card = normalizeCard(JSON.parse(readCardJson(new Uint8Array(fs.readFileSync(path.join(root, 'characters', cardFile))))));
const preset = normalizePreset(JSON.parse(fs.readFileSync(path.join(root, 'OpenAI Settings', presetName + '.json'), 'utf8')));
const worlds = {};
for (const f of fs.readdirSync(path.join(root, 'worlds')).filter(f => f.endsWith('.json'))) {
    worlds[f.replace(/\.json$/, '')] = normalizeWorld(JSON.parse(fs.readFileSync(path.join(root, 'worlds', f), 'utf8')));
}
const charDir = path.join(root, 'chats', cardFile.replace(/\.png$/, ''));
let chatFile = chatArg ? path.join(root, 'chats', chatArg) : null;
if (!chatFile && fs.existsSync(charDir)) {
    const files = fs.readdirSync(charDir).filter(f => f.endsWith('.jsonl')).map(f => ({ f, t: fs.statSync(path.join(charDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (files[0]) chatFile = path.join(charDir, files[0].f);
}
const { header, messages } = chatFile ? parseChatJsonl(fs.readFileSync(chatFile, 'utf8')) : { header: { chat_metadata: {} }, messages: [] };
const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));

const session = new ChatSession({
    card,
    cardFile: cardFile.replace(/\.png$/, ''),
    persona: { name: header.user_name || 'User', description: '' },
    preset,
    chat: messages,
    meta: header.chat_metadata,
    chatId: chatFile ? path.basename(chatFile) : 'new',
    settings: {
        power: { ejs: true, mvu: 'auto' },
        worldInfo: { ...settings.world_info_settings, globalSelect: [] },
        regex: settings.extension_settings?.regex ?? [],
        variables: { global: {} },
    },
    worlds,
    model: 'test-model',
});

console.log(`card=${card.data.name} preset=${presetName} chat=${chatFile ? path.basename(chatFile) : '(none)'} msgs=${messages.length}`);
console.log('mvu enabled:', session.mvuEnabled(), '| linked world:', card.data.extensions.world, '| loaded:', !!worlds[card.data.extensions.world]);
const t0 = performance.now();
const res = await session.preparePrompt({ type: 'normal', dryRun: true });
const ms = Math.round(performance.now() - t0);
console.log(`built ${res.messages.length} messages in ${ms}ms, ≈${estimateMessagesTokens(res.messages)} tokens, prefill=${JSON.stringify(res.prefill).slice(0, 60)}`);
console.log('debug:', JSON.stringify({ ...res.debug, activated: res.debug.activated.length }));
console.log('activated WI:', res.debug.activated.map(a => a.comment).join(' | ').slice(0, 600));
const errs = res.messages.filter(m => m.ejsError);
if (errs.length) console.log('EJS errors:', errs.map(m => `${m.source}: ${m.ejsError}`).join('\n'));
const leftovers = res.messages.filter(m => /<%|\{\{(?!\s*\/)[^}]{0,40}\}\}/.test(m.content));
if (leftovers.length) {
    console.log('messages still containing <% or {{macro}}:');
    for (const m of leftovers.slice(0, 8)) {
        const hit = m.content.match(/<%[\s\S]{0,60}|\{\{[^}]{0,40}\}\}/)[0];
        console.log(`  [${m.source}] ${hit.replace(/\n/g, '\\n')}`);
    }
}
for (const m of res.messages) {
    console.log(`- ${m.role.padEnd(9)} ${String(m.source).slice(0, 22).padEnd(22)} ${String(m.content.length).padStart(6)}ch  ${m.content.slice(0, 70).replace(/\n/g, '⏎')}`);
}
