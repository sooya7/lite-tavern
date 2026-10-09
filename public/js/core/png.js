// PNG 文本块读写（角色卡 chara / ccv3），浏览器与 Node 共用，只用 Uint8Array。
import { utf8ToBase64, base64ToUtf8 } from './util.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let CRC_TABLE = null;
function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
    }
    return CRC_TABLE;
}

function crc32(bytes) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

const latin1Decode = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
};
const latin1Encode = (str) => {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
    return out;
};

export function isPng(bytes) {
    return bytes && bytes.length > 8 && SIGNATURE.every((v, i) => bytes[i] === v);
}

export function extractChunks(bytes) {
    if (!isPng(bytes)) throw new Error('不是 PNG 文件');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let off = 8;
    while (off + 8 <= bytes.length) {
        const len = view.getUint32(off);
        const name = latin1Decode(bytes.subarray(off + 4, off + 8));
        const data = bytes.subarray(off + 8, off + 8 + len);
        chunks.push({ name, data });
        off += 12 + len;
        if (name === 'IEND') break;
    }
    return chunks;
}

export function encodeChunks(chunks) {
    let total = 8;
    for (const c of chunks) total += 12 + c.data.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(SIGNATURE, 0);
    let off = 8;
    for (const c of chunks) {
        view.setUint32(off, c.data.length);
        const nameBytes = latin1Encode(c.name);
        out.set(nameBytes, off + 4);
        out.set(c.data, off + 8);
        const crcInput = new Uint8Array(4 + c.data.length);
        crcInput.set(nameBytes, 0);
        crcInput.set(c.data, 4);
        view.setUint32(off + 8 + c.data.length, crc32(crcInput));
        off += 12 + c.data.length;
    }
    return out;
}

/** 读取所有 tEXt / 未压缩 iTXt 文本块 → [{keyword, text}] */
export function readTextChunks(bytes) {
    const result = [];
    for (const c of extractChunks(bytes)) {
        if (c.name === 'tEXt') {
            const z = c.data.indexOf(0);
            result.push({ keyword: latin1Decode(c.data.subarray(0, z)), text: latin1Decode(c.data.subarray(z + 1)) });
        } else if (c.name === 'iTXt') {
            const z = c.data.indexOf(0);
            const keyword = latin1Decode(c.data.subarray(0, z));
            const compressed = c.data[z + 1];
            if (compressed) continue;
            let p = z + 3;
            const langEnd = c.data.indexOf(0, p); p = langEnd + 1;
            const transEnd = c.data.indexOf(0, p); p = transEnd + 1;
            result.push({ keyword, text: new TextDecoder().decode(c.data.subarray(p)) });
        }
    }
    return result;
}

/** 从 PNG 里取角色卡 JSON 字符串，优先 ccv3（与酒馆一致） */
export function readCardJson(bytes) {
    const texts = readTextChunks(bytes);
    const v3 = texts.find(t => t.keyword.toLowerCase() === 'ccv3');
    if (v3) return base64ToUtf8(v3.text);
    const v2 = texts.find(t => t.keyword.toLowerCase() === 'chara');
    if (v2) return base64ToUtf8(v2.text);
    throw new Error('PNG 里没有角色卡数据（缺少 chara/ccv3 文本块）');
}

function textChunk(keyword, text) {
    const k = latin1Encode(keyword);
    const t = latin1Encode(text);
    const data = new Uint8Array(k.length + 1 + t.length);
    data.set(k, 0);
    data[k.length] = 0;
    data.set(t, k.length + 1);
    return { name: 'tEXt', data };
}

/**
 * 把卡数据写进 PNG：移除旧的 chara/ccv3，写入 chara(V2) 与 ccv3(V3)，与酒馆写法一致。
 * @param {Uint8Array} bytes 原图
 * @param {object} cardV2 V2 结构的卡（spec 会在 ccv3 里改成 v3）
 */
export function writeCardPng(bytes, cardV2) {
    const chunks = extractChunks(bytes).filter(c => {
        if (c.name !== 'tEXt') return true;
        const z = c.data.indexOf(0);
        const kw = latin1Decode(c.data.subarray(0, z)).toLowerCase();
        return kw !== 'chara' && kw !== 'ccv3';
    });
    const iend = chunks.findIndex(c => c.name === 'IEND');
    const v2 = JSON.stringify(cardV2);
    const v3 = JSON.stringify({ ...cardV2, spec: 'chara_card_v3', spec_version: '3.0' });
    chunks.splice(iend, 0, textChunk('chara', utf8ToBase64(v2)), textChunk('ccv3', utf8ToBase64(v3)));
    return encodeChunks(chunks);
}

// 1x1 透明 PNG，用于没有头像的角色卡导出
export const BLANK_PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
