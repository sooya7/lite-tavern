// 头像：角色用服务端缩略图，没有图片时用首字母占位
import { h } from './dom.js';
import { state } from '../state.js';
import { api } from '../api.js';

/** 角色卡头像版本号：头像刚换过用 state.char.v，否则用列表里的文件 mtime */
export function charVersion(file) {
    if (state.char?.file === file && state.char.v) return state.char.v;
    const c = state.characters.find(x => x.file === file);
    return c?.mtime ? Math.round(c.mtime) : '';
}

export function charThumbUrl(file) {
    return api.thumbUrl(file, charVersion(file));
}

export function letterAvatar(name, cls = 'avatar') {
    return h('span', { class: `${cls} avatar-letter`, 'aria-hidden': 'true' }, String(name || '?').trim().slice(0, 1).toUpperCase() || '?');
}

export function charAvatar(file, cls = 'avatar', { name } = {}) {
    if (!file) return letterAvatar(name, cls);
    const img = h('img', { class: cls, src: charThumbUrl(file), alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(letterAvatar(name, cls)), { once: true });
    return img;
}

export function personaAvatar(p, cls = 'avatar') {
    if (p?.avatar) return h('img', { class: cls, src: api.personaAvatarUrl(p.avatar), alt: '', loading: 'lazy' });
    return letterAvatar(p?.name || 'U', `${cls} warm`);
}
