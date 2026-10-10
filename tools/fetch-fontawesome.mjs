#!/usr/bin/env node
// 下载 Font Awesome Free 6 的字体文件到 public/vendor/fontawesome/webfonts/（酒馆插件的图标靠它；仓库里只放了 CSS）。
// 零依赖：从 npm 仓库取 tgz，自己解 tar。国内服务器默认走 npmmirror，可用 FA_REGISTRY 换。
// 用法：node tools/fetch-fontawesome.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'public', 'vendor', 'fontawesome', 'webfonts');
const VERSION = process.env.FA_VERSION || '6.7.2';
const REGISTRY = (process.env.FA_REGISTRY || 'https://registry.npmmirror.com').replace(/\/+$/, '');
const url = `${REGISTRY}/@fortawesome/fontawesome-free/-/fontawesome-free-${VERSION}.tgz`;

const r = await fetch(url);
if (!r.ok) {
    console.error(`下载失败：${r.status} ${url}`);
    process.exit(1);
}
const tar = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    const m = /^package\/webfonts\/([^/]+\.woff2)$/.exec(name);
    if (m) {
        fs.writeFileSync(path.join(OUT, m[1]), body);
        n++;
    }
    off += 512 + Math.ceil(size / 512) * 512;
}
console.log(`已写入 ${n} 个字体文件到 ${OUT}`);
