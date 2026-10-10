// 从酒馆 / TauriTavern 的用户数据目录导入（只读源目录，复制到本项目数据目录）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readCardJson } from '../public/js/core/png.js';
import { normalizeRegexScript } from '../public/js/core/regex.js';
import { HttpError } from './http.mjs';
import { sanitizeName } from './store.mjs';

export function detectStDirs() {
    const home = os.homedir();
    const cands = [
        process.env.ST_DATA,
        'D:/SillyTavern/SillyTavern/data/default-user',
        'C:/SillyTavern/data/default-user',
        'D:/SillyTavern/data/default-user',
        path.join(home, 'SillyTavern/data/default-user'),
        path.join(process.env.APPDATA ?? '', 'com.tauritavern.client/data/default-user'),
        path.join(process.env.LOCALAPPDATA ?? '', 'com.tauritavern.client/data/default-user'),
        path.join(home, 'AppData/Roaming/com.tauritavern.client/data/default-user'),
    ].filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const c of cands) {
        const p = path.resolve(c);
        if (seen.has(p)) continue;
        seen.add(p);
        if (fs.existsSync(path.join(p, 'characters')) || fs.existsSync(path.join(p, 'settings.json'))) out.push(p);
    }
    return out;
}

function assertStDir(dir) {
    const p = path.resolve(String(dir ?? ''));
    if (!fs.existsSync(p)) throw new HttpError(400, `目录不存在：${p}`);
    if (!fs.existsSync(path.join(p, 'characters')) && !fs.existsSync(path.join(p, 'OpenAI Settings'))) {
        throw new HttpError(400, '这不像酒馆的用户数据目录（应包含 characters、OpenAI Settings 等子目录，一般是 data/default-user）');
    }
    return p;
}

/** 复制后把修改时间改回源文件的，列表里的“最近使用”排序才不会全变成导入那一刻 */
async function keepMtime(src, dest) {
    try {
        const st = await fsp.stat(src);
        await fsp.utimes(dest, st.atime, st.mtime);
    } catch { /* 时间戳只影响排序 */ }
}

// ---------- 酒馆里配置的 API 连接 ----------

/**
 * 酒馆的对话补全来源 → 这边的连接类型。base 是官方地址（custom 的地址在连接配置里），
 * secret 是 secrets.json 里放 Key 的那一项，model 是 oai_settings 里记模型名的那一项。
 * 没列在这里的来源（文本补全、Vertex、Azure 等）请求格式对不上，导入时会说明跳过。
 */
const ST_SOURCES = {
    custom: { provider: 'openai', base: '', secret: 'api_key_custom', model: 'custom_model' },
    openai: { provider: 'openai', base: 'https://api.openai.com/v1', secret: 'api_key_openai', model: 'openai_model', proxy: true },
    claude: { provider: 'claude', base: 'https://api.anthropic.com', secret: 'api_key_claude', model: 'claude_model', proxy: true },
    makersuite: { provider: 'gemini', base: 'https://generativelanguage.googleapis.com', secret: 'api_key_makersuite', model: 'google_model' },
    deepseek: { provider: 'openai', base: 'https://api.deepseek.com/v1', secret: 'api_key_deepseek', model: 'deepseek_model' },
    openrouter: { provider: 'openai', base: 'https://openrouter.ai/api/v1', secret: 'api_key_openrouter', model: 'openrouter_model' },
    mistralai: { provider: 'openai', base: 'https://api.mistral.ai/v1', secret: 'api_key_mistralai', model: 'mistralai_model' },
    groq: { provider: 'openai', base: 'https://api.groq.com/openai/v1', secret: 'api_key_groq', model: 'groq_model' },
    xai: { provider: 'openai', base: 'https://api.x.ai/v1', secret: 'api_key_xai', model: 'xai_model' },
    moonshot: { provider: 'openai', base: 'https://api.moonshot.ai/v1', secret: 'api_key_moonshot', model: 'moonshot_model' },
    siliconflow: { provider: 'openai', base: 'https://api.siliconflow.com/v1', secret: 'api_key_siliconflow', model: 'siliconflow_model' },
};

const trimUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '');

const POST_PROCESSING = { merge: 'merge', merge_tools: 'merge', semi: 'semi', semi_tools: 'semi', strict: 'strict', strict_tools: 'strict', single: 'single' };

/**
 * secrets.json 里一项可能是字符串（老版本），也可能是 [{id, value, label, active}]（能存多个 Key 的新版本）。
 * 连接配置指定了用哪个 Key（secretId）就只认那一个，找不到宁可留空：
 * 同一类来源下可能存着好几家中转的 Key，拿错了就等于把这家的 Key 发给了另一家。
 * anyOk：这类来源只有一个官方地址，随便哪个 Key 都是发给同一家，才允许退而求其次。
 */
function pickSecret(entry, secretId, anyOk) {
    if (typeof entry === 'string') return secretId || !anyOk ? '' : entry;
    if (!Array.isArray(entry)) return '';
    const hit = secretId ? entry.find(x => x?.id === secretId) : anyOk ? (entry.find(x => x?.active && x.value) ?? entry.find(x => x?.value)) : null;
    return String(hit?.value ?? '');
}

/**
 * 读出酒馆里配好的连接：优先用“连接配置”（Connection Profiles）里存的每一条；一条都没有就取当前正在用的那个。
 * @param {object} st 酒馆的 settings.json
 * @param {object} secrets 酒馆的 secrets.json
 * @returns {{list: object[], skipped: string[]}} list 每项 {stProfile, name, provider, baseUrl, model, postProcessing, key}
 */
export function readStConnections(st, secrets = {}) {
    const oai = st?.oai_settings ?? {};
    const proxies = Array.isArray(st?.proxies) ? st.proxies : [];
    const list = [];
    const skipped = [];
    const build = ({ id, name, api, url, model, secretId, proxyName, post }) => {
        const src = ST_SOURCES[api];
        if (!src) { skipped.push(`连接 ${name}（来源 ${api || '未知'} 这边还不支持）`); return; }
        let baseUrl = src.base;
        if (api === 'custom') baseUrl = String(url ?? '').trim();
        // 自定义地址：没指定 Key 时，只有地址正是酒馆当前在用的那个，才能用当前生效的 Key
        const sameAsCurrent = api !== 'custom' || trimUrl(baseUrl) === trimUrl(oai.custom_url);
        let key = pickSecret(secrets[src.secret], secretId, sameAsCurrent);
        const proxy = src.proxy ? proxies.find(p => p?.name === proxyName && p.url) : null;
        if (proxy) {
            // 反向代理：地址和密码都用代理的。Claude 这边会自己补 /v1，代理地址末尾的 /v1 要去掉
            baseUrl = String(proxy.url).trim();
            if (src.provider === 'claude') baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
            if (proxy.password) key = String(proxy.password);
        }
        baseUrl = baseUrl.replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseUrl)) { skipped.push(`连接 ${name}（没有填接口地址）`); return; }
        list.push({ stProfile: id, name, provider: src.provider, baseUrl, model: String(model ?? ''), postProcessing: POST_PROCESSING[post] ?? '', key });
    };
    const profiles = st?.extension_settings?.connectionManager?.profiles;
    for (const p of Array.isArray(profiles) ? profiles : []) {
        if (!p || typeof p !== 'object') continue;
        const name = String(p.name || '未命名连接');
        if (p.mode && p.mode !== 'cc') { skipped.push(`连接 ${name}（文本补全接口这边不支持）`); continue; }
        build({
            id: String(p.id ?? name), name, api: p.api,
            url: p['api-url'], model: p.model, secretId: p['secret-id'], proxyName: p.proxy,
            post: p['prompt-post-processing'] ?? oai.custom_prompt_post_processing,
        });
    }
    if (!list.length && !skipped.length && st?.main_api === 'openai' && oai.chat_completion_source) {
        const api = oai.chat_completion_source;
        build({
            id: `current:${api}`, name: '酒馆当前连接', api,
            url: oai.custom_url, model: oai[ST_SOURCES[api]?.model], secretId: '', proxyName: st?.selected_proxy?.name,
            post: oai.custom_prompt_post_processing,
        });
    }
    return { list, skipped };
}

const listFiles = async (dir, re) => {
    try { return (await fsp.readdir(dir)).filter(f => re.test(f)); } catch { return []; }
};

export async function scanStDir(dir, store) {
    const root = assertStDir(dir);
    const characters = [];
    for (const f of await listFiles(path.join(root, 'characters'), /\.(png|json)$/i)) {
        const id = f.replace(/\.(png|json)$/i, '');
        let name = id;
        try {
            const buf = await fsp.readFile(path.join(root, 'characters', f));
            const raw = /\.png$/i.test(f) ? readCardJson(new Uint8Array(buf)) : buf.toString('utf8');
            const j = JSON.parse(raw);
            name = j.data?.name ?? j.name ?? id;
        } catch { /* 读不出就用文件名 */ }
        const chats = (await listFiles(path.join(root, 'chats', id), /\.jsonl$/)).length;
        characters.push({ file: f, id, name, chats });
    }
    const presets = (await listFiles(path.join(root, 'OpenAI Settings'), /\.json$/)).map(f => f.replace(/\.json$/, ''));
    const worlds = (await listFiles(path.join(root, 'worlds'), /\.json$/)).map(f => f.replace(/\.json$/, ''));
    let settings = null;
    try { settings = JSON.parse(await fsp.readFile(path.join(root, 'settings.json'), 'utf8')); } catch { /* 没有设置 */ }
    const pu = settings?.power_user ?? {};
    return {
        dir: root,
        // 这个目录就是正在共用的那个：角色卡、聊天、世界书、预设本来就是同一份，只剩设置类的东西可导
        shared: !!store?.stData && root === store.stData,
        connectionCount: settings ? readStConnections(settings).list.length : 0,
        characters,
        presets,
        worlds,
        regexCount: settings?.extension_settings?.regex?.length ?? 0,
        personaCount: Object.keys(pu.personas ?? {}).length,
        globalWorlds: settings?.world_info_settings?.world_info?.globalSelect ?? [],
        hasSettings: !!settings,
    };
}

/**
 * @param {import('./store.mjs').Store} store
 * @param {{dir: string, characters?: string[], withChats?: boolean, presets?: string[], worlds?: string[], regex?: boolean, personas?: boolean, worldSettings?: boolean, overwrite?: boolean}} sel
 */
export async function importFromSt(store, sel) {
    const root = assertStDir(sel.dir);
    const report = { characters: [], chats: 0, presets: [], worlds: [], regex: 0, personas: 0, connections: [], skipped: [], errors: [] };
    const settings = await store.getSettings();
    if (store.stData && root === store.stData) {
        // 源目录就是共用的那个目录，文件已经是同一份，不能自己往自己身上拷
        sel = { ...sel, characters: [], presets: [], worlds: [] };
    }

    for (const name of sel.worlds ?? []) {
        try {
            const src = path.join(root, 'worlds', `${name}.json`);
            const dest = store.p('worlds', `${sanitizeName(name)}.json`);
            if (fs.existsSync(dest) && !sel.overwrite) { report.skipped.push(`世界书 ${name}（已存在）`); continue; }
            await fsp.copyFile(src, dest);
            await keepMtime(src, dest);
            report.worlds.push(name);
        } catch (e) { report.errors.push(`世界书 ${name}: ${e.message}`); }
    }

    for (const name of sel.presets ?? []) {
        try {
            const src = path.join(root, 'OpenAI Settings', `${name}.json`);
            const dest = store.p('presets', `${sanitizeName(name)}.json`);
            if (fs.existsSync(dest) && !sel.overwrite) { report.skipped.push(`预设 ${name}（已存在）`); continue; }
            const j = JSON.parse(await fsp.readFile(src, 'utf8'));
            // 去掉酒馆里与连接相关、可能带密码的字段
            delete j.proxy_password;
            delete j.reverse_proxy;
            await store.writeAtomic(dest, JSON.stringify(j, null, 2));
            await keepMtime(src, dest);
            report.presets.push(name);
        } catch (e) { report.errors.push(`预设 ${name}: ${e.message}`); }
    }

    for (const file of sel.characters ?? []) {
        try {
            const id = file.replace(/\.(png|json)$/i, '');
            const destFile = `${sanitizeName(id)}.png`;
            if (fs.existsSync(store.p('characters', destFile)) && !sel.overwrite) { report.skipped.push(`角色 ${id}（已存在）`); continue; }
            const bytes = await fsp.readFile(path.join(root, 'characters', file));
            // 酒馆里卡已关联世界书文件时不重复生成
            const { card } = await store.importCard(bytes, file, { importBook: true, targetFile: destFile });
            await keepMtime(path.join(root, 'characters', file), store.p('characters', destFile));
            report.characters.push(card.data.name);
            if (sel.withChats) {
                const srcDir = path.join(root, 'chats', id);
                const destDir = store.p('chats', sanitizeName(id));
                for (const c of await listFiles(srcDir, /\.jsonl$/)) {
                    await fsp.mkdir(destDir, { recursive: true });
                    const d = path.join(destDir, c);
                    if (fs.existsSync(d) && !sel.overwrite) continue;
                    await fsp.copyFile(path.join(srcDir, c), d);
                    await keepMtime(path.join(srcDir, c), d);
                    report.chats++;
                }
            }
        } catch (e) { report.errors.push(`角色 ${file}: ${e.message}`); }
    }

    let st = null;
    try { st = JSON.parse(await fsp.readFile(path.join(root, 'settings.json'), 'utf8')); } catch { /* 无 */ }
    if (st && sel.regex) {
        const list = (st.extension_settings?.regex ?? []).map(normalizeRegexScript);
        const existing = settings.regex ?? [];
        const ids = new Set(existing.map(r => r.id));
        for (const r of list) if (!ids.has(r.id)) { existing.push(r); report.regex++; }
        settings.regex = existing;
    }
    if (st && sel.personas) {
        const pu = st.power_user ?? {};
        const descs = pu.persona_descriptions ?? {};
        settings.personas = settings.personas ?? [];
        for (const [avatar, name] of Object.entries(pu.personas ?? {})) {
            if (settings.personas.some(p => p.stAvatar === avatar)) continue;
            const d = descs[avatar] ?? {};
            const id = `p_${Date.now().toString(36)}_${settings.personas.length}`;
            const persona = {
                id,
                name,
                description: d.description ?? '',
                position: d.position ?? 0,
                depth: d.depth ?? 2,
                role: d.role ?? 0,
                lorebook: d.lorebook ?? '',
                stAvatar: avatar,
                avatar: '',
            };
            try {
                const src = path.join(root, 'User Avatars', avatar);
                if (fs.existsSync(src)) {
                    const ext = path.extname(avatar) || '.png';
                    await fsp.copyFile(src, store.p('avatars', `${id}${ext}`));
                    persona.avatar = `${id}${ext}`;
                }
            } catch { /* 头像可选 */ }
            settings.personas.push(persona);
            report.personas++;
        }
        if (!settings.activePersona && settings.personas.length) {
            const def = settings.personas.find(p => p.stAvatar === st.user_avatar) ?? settings.personas[0];
            settings.activePersona = def.id;
        }
    }
    if (st && sel.worldSettings) {
        const wi = { ...(st.world_info_settings ?? {}) };
        const global = wi.world_info?.globalSelect ?? [];
        delete wi.world_info;
        settings.worldInfo = { ...(settings.worldInfo ?? {}), ...wi, globalSelect: global.filter(n => fs.existsSync(store.p('worlds', `${sanitizeName(n)}.json`))) };
        if (st.extension_settings?.variables?.global) {
            settings.variables = settings.variables ?? {};
            settings.variables.global = { ...st.extension_settings.variables.global, ...(settings.variables.global ?? {}) };
        }
    }
    if (st && sel.connections) {
        let secrets = {};
        try { secrets = JSON.parse(await fsp.readFile(path.join(root, 'secrets.json'), 'utf8')); } catch { /* 没有密钥文件就只导地址和模型 */ }
        const { list, skipped } = readStConnections(st, secrets);
        report.skipped.push(...skipped);
        settings.connections = settings.connections ?? [];
        for (const c of list) {
            const { key, ...conn } = c;
            // 认得出来的（上次导过的，或者手动建的同地址同模型的那条）不重复建
            let cur = settings.connections.find(x => x.stProfile === c.stProfile)
                ?? settings.connections.find(x => !x.stProfile && x.provider === c.provider && String(x.baseUrl ?? '').replace(/\/+$/, '') === c.baseUrl && x.model === c.model);
            if (cur && !sel.overwrite) {
                cur.stProfile = c.stProfile;
                report.skipped.push(`连接 ${c.name}（已存在）`);
                continue;
            }
            if (cur) Object.assign(cur, conn);
            else {
                cur = {
                    id: `c_${crypto.randomUUID().slice(0, 8)}`,
                    prefillAsAssistant: false, sendExtraSamplers: false, thinkingBudget: 0, includeThoughts: true, extraBody: '', extraHeaders: '',
                    ...conn,
                };
                settings.connections.push(cur);
            }
            // Key 只在服务端两个文件之间搬，不经过浏览器
            if (key) await store.setSecret(cur.id, key);
            report.connections.push(key ? c.name : `${c.name}（酒馆里没存 Key）`);
        }
        if (!settings.connections.some(x => x.id === settings.activeConnection) && settings.connections.length) settings.activeConnection = settings.connections[0].id;
    }
    await store.saveSettings(settings);
    return report;
}
