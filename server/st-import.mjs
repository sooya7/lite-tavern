// 从酒馆 / TauriTavern 的用户数据目录导入（只读源目录，复制到本项目数据目录）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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

const listFiles = async (dir, re) => {
    try { return (await fsp.readdir(dir)).filter(f => re.test(f)); } catch { return []; }
};

export async function scanStDir(dir) {
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
    const report = { characters: [], chats: 0, presets: [], worlds: [], regex: 0, personas: 0, skipped: [], errors: [] };
    const settings = await store.getSettings();

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
    await store.saveSettings(settings);
    return report;
}
