// 头像缩略图：纯 zlib 解码 PNG → 按块平均缩小 → 重新编码 PNG（顺带去掉卡片里嵌的元数据）。
// 角色卡 PNG 常有几 MB 到十几 MB（大半是 chara 文本块），列表里直接加载原图又慢又占内存。
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RAW = 160 * 1024 * 1024; // 解压后的扫描线超过这个大小就不处理，交给原图

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function readChunks(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG');
    let pos = 8, ihdr = null, plte = null, trns = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
        else if (type === 'PLTE') plte = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (!ihdr) throw new Error('缺少 IHDR');
    return { ihdr, plte, trns, idat };
}

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(ft, line, cur, prev, bpp) {
    const n = line.length;
    switch (ft) {
        case 0: cur.set(line); break;
        case 1: for (let i = 0; i < n; i++) cur[i] = line[i] + (i >= bpp ? cur[i - bpp] : 0); break;
        case 2: for (let i = 0; i < n; i++) cur[i] = line[i] + prev[i]; break;
        case 3: for (let i = 0; i < n; i++) cur[i] = line[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1); break;
        case 4: for (let i = 0; i < n; i++) cur[i] = line[i] + paeth(i >= bpp ? cur[i - bpp] : 0, prev[i], i >= bpp ? prev[i - bpp] : 0); break;
        default: throw new Error(`未知的过滤类型 ${ft}`);
    }
}

/** 把一行解码后的像素展开成 RGBA8 */
function rowToRgba(cur, w, { depth, color }, plte, trns, out) {
    const maxv = (1 << depth) - 1;
    const sample = (idx) => {
        if (depth === 8) return cur[idx];
        if (depth === 16) return cur[idx * 2];
        const bitPos = idx * depth;
        const v = (cur[bitPos >> 3] >> (8 - depth - (bitPos & 7))) & maxv;
        return color === 3 ? v : Math.round(v * 255 / maxv);
    };
    const trnsGray = color === 0 && trns?.length >= 2 ? trns.readUInt16BE(0) : -1;
    for (let x = 0, o = 0; x < w; x++, o += 4) {
        if (color === 6) {
            out[o] = sample(x * 4); out[o + 1] = sample(x * 4 + 1); out[o + 2] = sample(x * 4 + 2); out[o + 3] = sample(x * 4 + 3);
        } else if (color === 2) {
            out[o] = sample(x * 3); out[o + 1] = sample(x * 3 + 1); out[o + 2] = sample(x * 3 + 2); out[o + 3] = 255;
        } else if (color === 3) {
            const i = sample(x);
            out[o] = plte?.[i * 3] ?? 0; out[o + 1] = plte?.[i * 3 + 1] ?? 0; out[o + 2] = plte?.[i * 3 + 2] ?? 0;
            out[o + 3] = trns && i < trns.length ? trns[i] : 255;
        } else if (color === 4) {
            const g = sample(x * 2);
            out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = sample(x * 2 + 1);
        } else {
            const g = sample(x);
            out[o] = out[o + 1] = out[o + 2] = g;
            out[o + 3] = trnsGray >= 0 && g === Math.round(trnsGray * 255 / maxv) ? 0 : 255;
        }
    }
}

/**
 * 解码并缩小：短边缩到 short 像素（原图更小就不放大），逐行累加，不展开整张原图。
 * @returns {{width: number, height: number, rgba: Uint8Array, alpha: boolean}}
 */
export function decodeScaled(buf, short = 160) {
    const { ihdr, plte, trns, idat } = readChunks(buf);
    const { width: w, height: h, depth, color, interlace } = ihdr;
    if (interlace) throw new Error('不支持隔行扫描 PNG');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
    if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`不支持的格式 color=${color} depth=${depth}`);
    if (!w || !h) throw new Error('尺寸为 0');
    const bitsPP = channels * depth;
    const bpp = Math.max(1, bitsPP >> 3);
    const stride = Math.ceil(w * bitsPP / 8);
    if ((stride + 1) * h > MAX_RAW) throw new Error('图片太大');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < (stride + 1) * h) throw new Error('图像数据不完整');

    const scale = Math.min(1, short / Math.min(w, h));
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const colOf = new Uint32Array(w);
    for (let x = 0; x < w; x++) colOf[x] = Math.min(tw - 1, Math.floor(x * tw / w));
    const colCount = new Uint32Array(tw);
    for (let x = 0; x < w; x++) colCount[colOf[x]]++;

    const out = new Uint8Array(tw * th * 4);
    const acc = new Float64Array(tw * 4); // 预乘 alpha 累加，透明边缘不发黑
    const accA = new Float64Array(tw);
    let accRows = 0, curTy = 0, alpha = false;
    const flush = () => {
        for (let tx = 0; tx < tw; tx++) {
            const n = colCount[tx] * accRows;
            const a = accA[tx] / n;
            const o = (curTy * tw + tx) * 4;
            if (a > 0) {
                out[o] = Math.round(acc[tx * 4] / accA[tx]);
                out[o + 1] = Math.round(acc[tx * 4 + 1] / accA[tx]);
                out[o + 2] = Math.round(acc[tx * 4 + 2] / accA[tx]);
            }
            out[o + 3] = Math.round(a);
            if (out[o + 3] < 255) alpha = true;
        }
        acc.fill(0); accA.fill(0); accRows = 0;
    };

    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    const rgba = new Uint8Array(w * 4);
    for (let y = 0; y < h; y++) {
        const off = y * (stride + 1);
        unfilter(raw[off], raw.subarray(off + 1, off + 1 + stride), cur, prev, bpp);
        const ty = Math.min(th - 1, Math.floor(y * th / h));
        if (ty !== curTy) { flush(); curTy = ty; }
        rowToRgba(cur, w, ihdr, plte, trns, rgba);
        for (let x = 0; x < w; x++) {
            const tx = colOf[x], a = rgba[x * 4 + 3];
            acc[tx * 4] += rgba[x * 4] * a;
            acc[tx * 4 + 1] += rgba[x * 4 + 1] * a;
            acc[tx * 4 + 2] += rgba[x * 4 + 2] * a;
            accA[tx] += a;
        }
        accRows++;
        [prev, cur] = [cur, prev];
    }
    flush();
    return { width: tw, height: th, rgba: out, alpha };
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** RGBA8 → PNG（不透明时存 RGB；每行挑绝对值和最小的过滤方式） */
export function encodePng({ width: w, height: h, rgba, alpha }) {
    const ch = alpha ? 4 : 3;
    const stride = w * ch;
    const lines = Buffer.alloc((stride + 1) * h);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
    const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) cur[x * ch + c] = rgba[(y * w + x) * 4 + c];
        let best = 0, bestSum = Infinity;
        for (let ft = 0; ft < 5; ft++) {
            const o = cand[ft];
            let sum = 0;
            for (let i = 0; i < stride; i++) {
                const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
                const p = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
                const v = (cur[i] - p) & 255;
                o[i] = v;
                sum += v < 128 ? v : 256 - v;
            }
            if (sum < bestSum) { bestSum = sum; best = ft; }
        }
        lines[y * (stride + 1)] = best;
        lines.set(cand[best], y * (stride + 1) + 1);
        [prev, cur] = [cur, prev];
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = alpha ? 6 : 2;
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(lines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function makeThumbnail(buf, short = 160) {
    return encodePng(decodeScaled(buf, short));
}
