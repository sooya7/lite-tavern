// 数据目录：目录结构贴近酒馆（characters / chats/<卡名>/*.jsonl / presets / worlds / avatars），方便互相拷贝。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readCardJson, writeCardPng, isPng, extractChunks } from '../public/js/core/png.js';
import { normalizeCard, toExportCard } from '../public/js/core/card.js';
import { characterBookToWorld, normalizeWorld } from '../public/js/core/worldinfo.js';
import { HttpError } from './http.mjs';
import { makeThumbnail } from './thumb.mjs';

export const DIRS = ['characters', 'chats', 'presets', 'worlds', 'avatars', 'backups', 'trash', 'extensions', 'files'];

/**
 * 与酒馆（SillyTavern / Luker）共用数据：这几类内容直接读写酒馆用户数据目录里对应的子目录，
 * 两边看到的是同一份文件。设置、密钥、头像、备份、回收站各用各的（结构不一样，没法共用）。
 */
export const SHARED_DIRS = { characters: 'characters', chats: 'chats', worlds: 'worlds', presets: 'OpenAI Settings' };

/** Luker 给每个聊天存的附属文件：<聊天名>.luker-state.<用途>.json，改名、删除时要跟着走 */
const SIDECAR_MARK = '.luker-state.';
const SYNC_SIDECAR = `${SIDECAR_MARK}chat_sync.json`;

export function sanitizeName(name) {
    const s = String(name ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .trim()
        .slice(0, 160);
    if (!s || s === '.' || s === '..') throw new HttpError(400, '名称不合法');
    return s;
}

export class Store {
    /**
     * @param {string} root 自己的数据目录
     * @param {{stData?: string}} [opts] stData：酒馆的用户数据目录，填了就和它共用角色卡、聊天、世界书、预设
     */
    constructor(root, { stData = '' } = {}) {
        this.root = path.resolve(root);
        this.stData = '';
        this.shared = null;
        if (stData) {
            const st = path.resolve(String(stData));
            if (!fs.existsSync(path.join(st, 'characters')) || !fs.existsSync(path.join(st, 'chats'))) {
                throw new Error(`这不像酒馆的用户数据目录（里面应该有 characters、chats 等子目录）：${st}`);
            }
            if (st === this.root || st.startsWith(this.root + path.sep) || this.root.startsWith(st + path.sep)) {
                throw new Error('酒馆数据目录和自己的数据目录不能互相包含（两边的 settings.json 会打架）');
            }
            this.stData = st;
            this.shared = Object.fromEntries(Object.entries(SHARED_DIRS).map(([kind, dir]) => [kind, path.join(st, dir)]));
        }
        for (const d of DIRS) fs.mkdirSync(this.shared?.[d] ?? path.join(this.root, d), { recursive: true });
        this.cardMeta = new Map(); // file → {mtime, meta}
        this.lastBackup = new Map();
        this.thumbJobs = new Map(); // 同一张缩略图并发请求只生成一次
    }

    p(...parts) {
        const base = this.shared?.[parts[0]];
        const root = base ?? this.root;
        const full = base ? path.resolve(base, ...parts.slice(1)) : path.resolve(this.root, ...parts);
        if (full !== root && !full.startsWith(root + path.sep)) throw new HttpError(400, '路径越界');
        return full;
    }

    async writeAtomic(file, data) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tmp, data);
        await fsp.rename(tmp, file);
    }

    async readJsonFile(file, fallback) {
        try {
            return JSON.parse(await fsp.readFile(file, 'utf8'));
        } catch (e) {
            if (e.code === 'ENOENT') return fallback;
            throw e;
        }
    }

    /** 回收站始终在自己的数据目录里：共用模式下删掉的东西酒馆那边就看不到了，但这里还能找回来 */
    async moveToTrash(file) {
        let rel = path.relative(this.root, file);
        for (const [kind, dir] of Object.entries(this.shared ?? {})) {
            if (file.startsWith(dir + path.sep)) rel = path.join(kind, path.relative(dir, file));
        }
        const dest = this.p('trash', `${Date.now()}-${rel.replace(/[\\/]/g, '__')}`);
        try {
            await fsp.rename(file, dest);
        } catch (e) {
            if (e.code !== 'EXDEV') throw e;
            // 两个目录不在同一块盘上，不能直接改名
            await fsp.cp(file, dest, { recursive: true });
            await fsp.rm(file, { recursive: true, force: true });
        }
        return dest;
    }

    // ---------- 设置与密钥 ----------
    async getSettings() {
        return this.readJsonFile(this.p('settings.json'), {});
    }

    async saveSettings(s) {
        await this.writeAtomic(this.p('settings.json'), JSON.stringify(s, null, 2));
    }

    async getSecrets() {
        return this.readJsonFile(this.p('secrets.json'), {});
    }

    async setSecret(id, key) {
        const s = await this.getSecrets();
        if (key) s[id] = key; else delete s[id];
        await this.writeAtomic(this.p('secrets.json'), JSON.stringify(s, null, 2));
    }

    // ---------- 角色卡 ----------
    async listCharacters() {
        const dir = this.p('characters');
        await fsp.mkdir(dir, { recursive: true });
        const files = (await fsp.readdir(dir)).filter(f => /\.(png|json)$/i.test(f));
        const out = [];
        for (const f of files) {
            try {
                const st = await fsp.stat(path.join(dir, f));
                let cached = this.cardMeta.get(f);
                if (!cached || cached.mtime !== st.mtimeMs) {
                    const card = await this.readCard(f);
                    const d = card.data;
                    cached = {
                        mtime: st.mtimeMs,
                        meta: {
                            file: f,
                            id: f.replace(/\.(png|json)$/i, ''),
                            name: d.name,
                            tags: d.tags ?? [],
                            fav: !!d.extensions?.fav,
                            creator: d.creator ?? '',
                            version: d.character_version ?? '',
                            notes: String(d.creator_notes ?? '').slice(0, 200),
                            size: st.size,
                            mtime: st.mtimeMs,
                            hasBook: !!d.character_book?.entries?.length,
                            world: d.extensions?.world ?? '',
                        },
                    };
                    this.cardMeta.set(f, cached);
                }
                const chatDir = this.p('chats', cached.meta.id);
                let chats = 0, lastChat = 0;
                try {
                    const list = (await fsp.readdir(chatDir)).filter(x => x.endsWith('.jsonl'));
                    chats = list.length;
                    for (const c of list) lastChat = Math.max(lastChat, (await fsp.stat(path.join(chatDir, c))).mtimeMs);
                } catch { /* 没有聊天 */ }
                out.push({ ...cached.meta, chats, lastChat });
            } catch (e) {
                out.push({ file: f, id: f.replace(/\.(png|json)$/i, ''), name: f, error: String(e.message ?? e) });
            }
        }
        return out;
    }

    async readCard(file) {
        const full = this.p('characters', sanitizeName(file));
        const buf = await fsp.readFile(full);
        if (/\.png$/i.test(file)) return normalizeCard(JSON.parse(readCardJson(new Uint8Array(buf))));
        return normalizeCard(JSON.parse(buf.toString('utf8')));
    }

    async uniqueCardFile(base) {
        let name = sanitizeName(base);
        let i = 1;
        while (fs.existsSync(this.p('characters', `${name}.png`)) || fs.existsSync(this.p('chats', name))) {
            name = `${sanitizeName(base)}_${++i}`;
        }
        return `${name}.png`;
    }

    /**
     * 导入角色卡（PNG/JSON 原始字节），统一存成 PNG；内嵌世界书另存为世界书并关联。
     * @returns {{file: string, card: object, world?: string}}
     */
    async importCard(bytes, fileName = 'card', { importBook = true, targetFile } = {}) {
        let card, image;
        const u8 = new Uint8Array(bytes);
        if (isPng(u8)) {
            card = normalizeCard(JSON.parse(readCardJson(u8)));
            image = u8;
        } else {
            const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
            card = normalizeCard(JSON.parse(text));
            image = defaultAvatar(card.data.name);
        }
        const file = targetFile ?? await this.uniqueCardFile(card.data.name || path.parse(fileName).name);
        let world;
        const book = card.data.character_book;
        if (importBook && book?.entries?.length) {
            const linked = card.data.extensions?.world;
            world = linked || book.name || `${card.data.name} 世界书`;
            const worldFile = this.p('worlds', `${sanitizeName(world)}.json`);
            if (!fs.existsSync(worldFile)) {
                const w = characterBookToWorld(book);
                delete w.originalData;
                await this.writeAtomic(worldFile, JSON.stringify({ entries: w.entries, name: world }, null, 2));
            }
            card.data.extensions.world = sanitizeName(world);
        }
        await this.writeAtomic(this.p('characters', file), Buffer.from(writeCardPng(image, toExportCard(card))));
        this.cardMeta.delete(file);
        return { file, card, world };
    }

    async saveCard(file, card) {
        const full = this.p('characters', sanitizeName(file));
        let image;
        try {
            const buf = new Uint8Array(await fsp.readFile(full));
            image = isPng(buf) ? buf : defaultAvatar(card.data?.name);
        } catch {
            image = defaultAvatar(card.data?.name);
        }
        const normalized = normalizeCard(card);
        await this.writeAtomic(full, Buffer.from(writeCardPng(image, toExportCard(normalized))));
        this.cardMeta.delete(file);
        return normalized;
    }

    /**
     * 角色头像缩略图路径（_cache/thumbs，按原图 mtime 命名，原图一改自动失效）。
     * 不是 PNG 或解码失败返回 null，调用方退回原图。
     */
    async cardThumbnail(file, short = 160) {
        const src = this.p('characters', sanitizeName(file));
        if (!/\.png$/i.test(file)) return null;
        const st = await fsp.stat(src);
        const base = sanitizeName(file.replace(/\.png$/i, ''));
        const dir = this.p('_cache', 'thumbs');
        const out = path.join(dir, `${base}.${Math.floor(st.mtimeMs).toString(36)}.${short}.png`);
        if (fs.existsSync(out)) return out;
        if (this.thumbJobs.has(out)) return this.thumbJobs.get(out);
        const job = (async () => {
            try {
                const png = makeThumbnail(await fsp.readFile(src), short);
                await fsp.mkdir(dir, { recursive: true });
                const stale = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9a-z]+\\.${short}\\.png$`);
                for (const old of await fsp.readdir(dir)) {
                    if (stale.test(old)) await fsp.unlink(path.join(dir, old)).catch(() => {});
                }
                await this.writeAtomic(out, png);
                return out;
            } catch {
                return null;
            } finally {
                this.thumbJobs.delete(out);
            }
        })();
        this.thumbJobs.set(out, job);
        return job;
    }

    async setCardAvatar(file, imageBytes) {
        const card = await this.readCard(file);
        const u8 = new Uint8Array(imageBytes);
        if (!isPng(u8)) throw new HttpError(400, '头像需要 PNG（浏览器会自动转换）');
        extractChunks(u8);
        await this.writeAtomic(this.p('characters', sanitizeName(file)), Buffer.from(writeCardPng(u8, toExportCard(card))));
        this.cardMeta.delete(file);
    }

    async deleteCard(file, { withChats = false } = {}) {
        const full = this.p('characters', sanitizeName(file));
        await this.moveToTrash(full);
        if (withChats) {
            const dir = this.p('chats', sanitizeName(file).replace(/\.(png|json)$/i, ''));
            if (fs.existsSync(dir)) await this.moveToTrash(dir);
        }
        this.cardMeta.delete(file);
    }

    // ---------- 聊天 ----------
    chatDir(charId) {
        return this.p('chats', sanitizeName(charId));
    }

    async listChats(charId) {
        const dir = this.chatDir(charId);
        let files = [];
        try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.jsonl')); } catch { return []; }
        const out = [];
        for (const f of files) {
            const full = path.join(dir, f);
            const st = await fsp.stat(full);
            const { count, last } = await chatSummary(full, st.size);
            out.push({ name: f.replace(/\.jsonl$/, ''), size: st.size, mtime: st.mtimeMs, count, last });
        }
        return out.sort((a, b) => b.mtime - a.mtime);
    }

    chatFile(charId, name) {
        return path.join(this.chatDir(charId), `${sanitizeName(name)}.jsonl`);
    }

    /** 聊天文件的版本号：任何一方（酒馆、另一个窗口）一写就会变，保存时拿它判断“我手里的还是不是最新的” */
    async chatVersion(charId, name) {
        try {
            const st = await fsp.stat(this.chatFile(charId, name));
            return `${Math.floor(st.mtimeMs)}-${st.size}`;
        } catch {
            return '';
        }
    }

    async readChat(charId, name) {
        return fsp.readFile(this.chatFile(charId, name), 'utf8');
    }

    /**
     * @param {{expect?: string, force?: boolean, backupEveryMs?: number}} [o]
     *   expect：读这个聊天时拿到的版本号。磁盘上的已经不是这个版本就拒绝（409 chat-conflict），force 跳过检查。
     * @returns {Promise<string>} 写完之后的版本号
     */
    async saveChat(charId, name, text, { expect = '', force = false, backupEveryMs = 10 * 60 * 1000 } = {}) {
        const file = this.chatFile(charId, name);
        if (expect && !force) {
            const current = await this.chatVersion(charId, name);
            if (current && current !== expect) throw new HttpError(409, '这个聊天在别处被改过了', 'chat-conflict');
        }
        const key = `${charId}/${name}`;
        const last = this.lastBackup.get(key) ?? 0;
        if ((Date.now() - last > backupEveryMs || (force && expect)) && fs.existsSync(file)) {
            // 强行覆盖别处的修改之前一定留一份，后悔了还能找回来
            this.lastBackup.set(key, Date.now());
            await this.backupFile(file, `chats/${sanitizeName(charId)}`, sanitizeName(name), 8);
        }
        let integrity = '';
        if (this.shared) ({ text, integrity } = stampIntegrity(text));
        await this.writeAtomic(file, text);
        // 先写聊天再写标记：万一酒馆正好卡在中间写了一笔，它下一次保存会对不上标记而被拦下来
        if (integrity) await this.rotateSyncSidecar(file, integrity);
        return this.chatVersion(charId, name);
    }

    /** Luker 把聊天的校验标记另存在旁边的文件里，并且以它为准；这个文件在才更新（原版酒馆只看聊天第一行） */
    async rotateSyncSidecar(chatFile, integrity) {
        const sidecar = chatFile.replace(/\.jsonl$/, '') + SYNC_SIDECAR;
        if (!fs.existsSync(sidecar)) return;
        await this.writeAtomic(sidecar, JSON.stringify({ integrity, updated_at: Date.now() }));
    }

    /** 跟着这个聊天走的附属文件（Luker 的记忆图谱、同步标记等） */
    async chatSidecars(charId, name) {
        const prefix = `${sanitizeName(name)}${SIDECAR_MARK}`;
        try {
            return (await fsp.readdir(this.chatDir(charId))).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
        } catch {
            return [];
        }
    }

    async backupFile(file, sub, base, keep) {
        const dir = this.p('backups', sub);
        await fsp.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await fsp.copyFile(file, path.join(dir, `${base}.${stamp}${path.extname(file)}`));
        const olds = (await fsp.readdir(dir)).filter(f => f.startsWith(base + '.')).sort();
        for (const f of olds.slice(0, Math.max(0, olds.length - keep))) await fsp.unlink(path.join(dir, f)).catch(() => {});
    }

    async renameChat(charId, from, to) {
        const dir = this.chatDir(charId);
        const dest = path.join(dir, `${sanitizeName(to)}.jsonl`);
        if (fs.existsSync(dest)) throw new HttpError(409, '已存在同名聊天');
        const sidecars = await this.chatSidecars(charId, from);
        await fsp.rename(this.chatFile(charId, from), dest);
        for (const f of sidecars) {
            await fsp.rename(path.join(dir, f), path.join(dir, sanitizeName(to) + f.slice(sanitizeName(from).length))).catch(() => {});
        }
    }

    async deleteChat(charId, name) {
        const sidecars = await this.chatSidecars(charId, name);
        await this.moveToTrash(this.chatFile(charId, name));
        for (const f of sidecars) await this.moveToTrash(path.join(this.chatDir(charId), f)).catch(() => {});
    }

    // ---------- 预设 / 世界书（同构的 JSON 目录） ----------
    async listJson(kind) {
        const dir = this.p(kind);
        await fsp.mkdir(dir, { recursive: true });
        const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'));
        const out = [];
        for (const f of files) {
            const st = await fsp.stat(path.join(dir, f));
            out.push({ name: f.replace(/\.json$/, ''), size: st.size, mtime: st.mtimeMs });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    }

    async readJson(kind, name) {
        const data = await this.readJsonFile(this.p(kind, `${sanitizeName(name)}.json`), null);
        if (data === null) throw new HttpError(404, `${kind}/${name} 不存在`);
        return data;
    }

    async saveJson(kind, name, data) {
        const file = this.p(kind, `${sanitizeName(name)}.json`);
        if (kind === 'worlds' && fs.existsSync(file)) {
            const key = `${kind}/${name}`;
            if (Date.now() - (this.lastBackup.get(key) ?? 0) > 10 * 60 * 1000) {
                this.lastBackup.set(key, Date.now());
                await this.backupFile(file, kind, sanitizeName(name), 5);
            }
        }
        const body = kind === 'worlds' ? normalizeWorld(data) : data;
        await this.writeAtomic(file, JSON.stringify(body, null, 2));
    }

    async deleteJson(kind, name) {
        await this.moveToTrash(this.p(kind, `${sanitizeName(name)}.json`));
    }

    async renameJson(kind, from, to) {
        const dest = this.p(kind, `${sanitizeName(to)}.json`);
        if (fs.existsSync(dest)) throw new HttpError(409, '已存在同名文件');
        await fsp.rename(this.p(kind, `${sanitizeName(from)}.json`), dest);
    }
}

/**
 * 给聊天第一行换一个新的 integrity 标记（共用模式下每次保存都换）。
 * 酒馆保存聊天时会核对这个标记：它那边开着旧内容再保存，就会提示而不是悄悄把这边刚写的盖掉。
 * 第一行不是聊天头就原样返回。
 */
export function stampIntegrity(text) {
    const nl = text.indexOf('\n');
    const first = nl < 0 ? text : text.slice(0, nl);
    let header;
    try { header = JSON.parse(first.replace(/^\uFEFF/, '')); } catch { return { text, integrity: '' }; }
    const isHeader = header && typeof header === 'object' && !Array.isArray(header) && header.mes === undefined
        && (header.chat_metadata !== undefined || header.user_name !== undefined);
    if (!isHeader) return { text, integrity: '' };
    const integrity = crypto.randomUUID();
    const meta = header.chat_metadata && typeof header.chat_metadata === 'object' && !Array.isArray(header.chat_metadata) ? header.chat_metadata : {};
    header.chat_metadata = { ...meta, integrity };
    return { text: JSON.stringify(header) + (nl < 0 ? '\n' : text.slice(nl)), integrity };
}

/** 统计聊天条数与最后一条消息预览（只读尾部） */
async function chatSummary(file, size) {
    const fh = await fsp.open(file, 'r');
    try {
        let count = 0;
        let last = '';
        if (size < 4 * 1024 * 1024) {
            const text = await fh.readFile('utf8');
            const lines = text.split('\n').filter(Boolean);
            count = Math.max(0, lines.length - 1);
            try { last = JSON.parse(lines[lines.length - 1])?.mes ?? ''; } catch { /* 忽略 */ }
        } else {
            const len = Math.min(size, 256 * 1024);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            const lines = buf.toString('utf8').split('\n').filter(Boolean);
            try { last = JSON.parse(lines[lines.length - 1])?.mes ?? ''; } catch { /* 忽略 */ }
            count = -1;
        }
        return { count, last: String(last).replace(/\s+/g, ' ').slice(0, 120) };
    } finally {
        await fh.close();
    }
}

/** 生成纯色+首字母风格的默认头像（无首字母绘制，只按名字取色的渐变块） */
export function defaultAvatar(name = '') {
    const W = 256, H = 256;
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const hue = h % 360;
    const rgb = (l) => hslToRgb(hue / 360, 0.45, l);
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0;
        const [r, g, b] = rgb(0.62 - (y / H) * 0.18);
        for (let x = 0; x < W; x++) {
            const o = y * (W * 3 + 1) + 1 + x * 3;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return new Uint8Array(Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]));
}

function hslToRgb(h, s, l) {
    const f = (n) => {
        const k = (n + h * 12) % 12;
        const a = s * Math.min(l, 1 - l);
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}

let TABLE;
function crc32(buf) {
    if (!TABLE) {
        TABLE = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            TABLE[n] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (const b of buf) c = TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
