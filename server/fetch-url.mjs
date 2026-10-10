// 从链接下载角色卡文件。目前只认 Discord 附件的直链（用户的卡都从 Discord 来）。
//
// 这个服务可能不设密码就放在公网上，“让服务器去下载一个链接”不设限的话，别人可以拿它探测服务器内部或者当跳板，
// 所以：只下白名单域名、只走 https、不跟跳转、限大小限时间，下回来的东西不是角色卡就丢弃、不交给页面。
import { spawn } from 'node:child_process';
import { HttpError } from './http.mjs';
import { readCardJson, isPng } from '../public/js/core/png.js';

export const MAX_CARD_BYTES = 40 * 1024 * 1024;
const DISCORD_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const HOW = '在 Discord 里长按（电脑上右键）那个卡片文件，选“复制链接”，再粘贴到这里';

/**
 * 把粘贴进来的内容整理成能下到原文件的地址；不认的抛 400，并说明该贴什么。
 * @returns {{url: string, name: string}}
 */
export function normalizeCardUrl(input) {
    const m = String(input ?? '').match(/https?:\/\/[^\s<>"'，。）)]+/i); // 粘贴的内容里可能夹着别的字，取第一个链接
    if (!m) throw new HttpError(400, `没有看到链接。${HOW}`);
    let u;
    try { u = new URL(m[0]); } catch { throw new HttpError(400, `这个链接不完整。${HOW}`); }
    const host = u.hostname.toLowerCase();
    if (/(^|\.)(discord|discordapp)\.com$/.test(host) && u.pathname.startsWith('/channels/')) {
        throw new HttpError(400, '这是消息的链接，不是文件的链接。长按那个卡片文件本身（不是整条消息），选“复制链接”');
    }
    if (!DISCORD_HOSTS.has(host)) throw new HttpError(400, '目前只支持 Discord 附件的链接（cdn.discordapp.com 开头的那种）');
    if (!/^\/(attachments|ephemeral-attachments)\/[^/]+\/[^/]+\/[^/]+$/.test(u.pathname)) throw new HttpError(400, `这不是 Discord 附件的链接。${HOW}`);
    // 一律换成原文件的地址：media 域名和 format / width / height 这些参数给的是转码、缩小过的预览图，卡的数据已经没了
    const out = new URL(`https://cdn.discordapp.com${u.pathname}`);
    for (const k of ['ex', 'is', 'hm']) {
        const v = u.searchParams.get(k);
        if (v && /^[0-9a-f]+$/i.test(v)) out.searchParams.set(k, v);
    }
    let name = 'card';
    try { name = decodeURIComponent(u.pathname.split('/').pop()) || 'card'; } catch { /* 保持默认 */ }
    return { url: out.href, name };
}

function httpFail(status) {
    if (status === 403 || status === 404) return new HttpError(502, '这个链接打不开了。Discord 的附件链接大约一天就失效，回 Discord 重新复制一个新的');
    return new HttpError(502, `Discord 那边返回了 ${status}，没下下来`);
}

/** 经代理下载（这台机器直连不了 Discord 时用）：交给 curl，它自带 socks 代理、限大小、限时间 */
function curlDownload(url, { proxy, maxBytes, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const args = ['-sS', '--fail', '--proto', '=https', '--max-redirs', '0', '--max-filesize', String(maxBytes),
            '--max-time', String(Math.ceil(timeoutMs / 1000)), '--connect-timeout', '15', '-x', proxy, '-o', '-', '--', url];
        let child;
        try { child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(new HttpError(500, `没法启动下载：${e.message}`)); return; }
        const chunks = [];
        let size = 0, err = '', over = false;
        child.stdout.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { over = true; child.kill('SIGKILL'); return; }
            chunks.push(c);
        });
        child.stderr.on('data', (c) => { err = (err + c).slice(-500); });
        child.on('error', (e) => reject(new HttpError(500, e.code === 'ENOENT' ? '服务器上没有 curl，没法经代理下载' : `没法启动下载：${e.message}`)));
        child.on('close', (code) => {
            if (over || code === 63) return reject(new HttpError(413, `文件太大了（超过 ${Math.round(maxBytes / 1048576)} MB），不像是角色卡`));
            if (code === 0) return resolve(Buffer.concat(chunks));
            const st = Number(err.match(/error: (\d{3})/)?.[1]);
            if (code === 22 && st) return reject(httpFail(st));
            if (code === 28) return reject(new HttpError(504, '下载超时了，过一会儿再试'));
            reject(new HttpError(502, `连不上 Discord（经代理 ${proxy.replace(/\/\/.*@/, '//')}）：${err.trim().replace(/^curl: /, '') || `curl 退出码 ${code}`}`));
        });
    });
}

/** 直连下载（服务器能直接访问 Discord 时） */
async function directDownload(url, { maxBytes, timeoutMs }) {
    let res;
    try {
        res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        if (e.name === 'TimeoutError') throw new HttpError(504, '下载超时了。服务器可能直连不了 Discord（启动参数 --fetch-proxy 可以指定代理）');
        throw new HttpError(502, `连不上 Discord：${e?.cause?.code || e.message}。服务器可能直连不了（启动参数 --fetch-proxy 可以指定代理）`);
    }
    if (!res.ok) throw httpFail(res.status);
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
        size += c.length;
        if (size > maxBytes) throw new HttpError(413, `文件太大了（超过 ${Math.round(maxBytes / 1048576)} MB），不像是角色卡`);
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

/** 下回来的是不是角色卡；是的话取出名字 */
export function inspectCardBytes(bytes) {
    const u8 = new Uint8Array(bytes);
    const png = isPng(u8);
    let raw;
    try {
        raw = JSON.parse(png ? readCardJson(u8) : Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
        throw new HttpError(422, png
            ? '下回来的图片里没有卡的数据。这多半是一张普通图片，或者是被 Discord 压缩过的预览图；要复制的是卡片文件本身的链接'
            : '下回来的不是角色卡（既不是带卡数据的 PNG，也不是卡的 JSON）');
    }
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw.data && typeof raw.data === 'object' ? raw.data : raw) : null;
    if (!d || typeof d.name !== 'string' || !d.name.trim() || !('first_mes' in d || 'description' in d || raw.spec)) {
        throw new HttpError(422, '下回来的文件不是角色卡');
    }
    return { png, cardName: d.name };
}

/**
 * 按链接把卡文件下回来。
 * @param {string} input 用户粘贴的内容
 * @param {{proxy?: string, maxBytes?: number, timeoutMs?: number, download?: Function}} [o] download 留给测试替换
 * @returns {Promise<{bytes: Buffer, name: string, png: boolean, cardName: string}>}
 */
export async function fetchCardFromUrl(input, { proxy = '', maxBytes = MAX_CARD_BYTES, timeoutMs = 90000, download } = {}) {
    const { url, name } = normalizeCardUrl(input);
    const get = download ?? (proxy ? curlDownload : directDownload);
    const bytes = await get(url, { proxy, maxBytes, timeoutMs });
    if (!bytes?.length) throw new HttpError(502, '下回来的文件是空的');
    if (bytes.length > maxBytes) throw new HttpError(413, `文件太大了（超过 ${Math.round(maxBytes / 1048576)} MB），不像是角色卡`);
    const info = inspectCardBytes(bytes);
    const ext = info.png ? '.png' : '.json';
    return { bytes, name: /\.(png|json)$/i.test(name) ? name : `${name}${ext}`, ...info };
}
