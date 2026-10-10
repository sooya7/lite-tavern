// 酒馆助手的音频：背景音乐（bgm）和音效（ambient）两路播放器，播放列表和设置存在 settings.audio 里。
// 对应酒馆助手的 playAudio / pauseAudio / getAudioList / replaceAudioList / appendAudioList /
// getAudioSettings / setAudioSettings / getCurrentAudio，以及 /audioplay 等斜杠命令。
// 手机浏览器不允许没有点击就出声：被拦下来时记住，等用户下一次点屏幕再接着放。
import { state, saveSettings } from '../state.js';
import { toast } from './dom.js';

const TYPES = ['bgm', 'ambient'];
const MODES = ['repeat_one', 'repeat_all', 'shuffle', 'play_one_and_stop'];
const players = {};
let pendingResume = null;

function cfg(type) {
    if (!TYPES.includes(type)) throw new Error(`音频类型只能是 bgm 或 ambient，收到「${type}」`);
    const all = (state.settings.audio ??= {});
    const c = (all[type] ??= {});
    if (!Array.isArray(c.list)) c.list = [];
    if (typeof c.enabled !== 'boolean') c.enabled = true;
    if (!MODES.includes(c.mode)) c.mode = type === 'bgm' ? 'repeat_all' : 'repeat_one';
    if (typeof c.muted !== 'boolean') c.muted = false;
    if (!Number.isFinite(c.volume)) c.volume = type === 'bgm' ? 50 : 60;
    return c;
}

function titleOf(url) {
    try {
        const p = new URL(url, location.href).pathname;
        return decodeURIComponent(p.split('/').pop() || url).replace(/\.[^.]+$/, '') || url;
    } catch { return String(url); }
}

function normalize(list) {
    return (Array.isArray(list) ? list : []).filter(a => a && a.url).map(a => ({ title: String(a.title || titleOf(a.url)), url: String(a.url) }));
}

function player(type) {
    if (players[type]) return players[type];
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('ended', () => onEnded(type));
    players[type] = el;
    applySettings(type);
    return el;
}

function applySettings(type) {
    const c = cfg(type);
    const el = players[type];
    if (!el) return;
    el.volume = Math.min(1, Math.max(0, c.volume / 100));
    el.muted = c.muted;
    el.loop = c.mode === 'repeat_one';
    if (!c.enabled && !el.paused) el.pause();
}

function start(type, url) {
    const el = player(type);
    if (el.src !== new URL(url, location.href).href) el.src = url;
    applySettings(type);
    if (!cfg(type).enabled) return;
    el.play().catch((e) => {
        if (e?.name !== 'NotAllowedError') { console.warn('[音频] 播放失败', url, e); return; }
        // 浏览器要求先有一次点击：记下来，下一次点屏幕时接着放
        if (!pendingResume) toast('卡里的音乐被浏览器拦住了，点一下屏幕就会开始播放', 'info', 4000);
        pendingResume = () => { el.play().catch(() => {}); };
    });
}

function onEnded(type) {
    const c = cfg(type);
    const el = players[type];
    if (!el || !c.list.length || c.mode === 'repeat_one' || c.mode === 'play_one_and_stop') return;
    const i = c.list.findIndex(a => new URL(a.url, location.href).href === el.src);
    let next;
    if (c.mode === 'shuffle') next = c.list.length > 1 ? (i + 1 + Math.floor(Math.random() * (c.list.length - 1))) % c.list.length : 0;
    else next = (i + 1) % c.list.length;
    start(type, c.list[next].url);
}

document.addEventListener('pointerdown', () => {
    if (!pendingResume) return;
    const fn = pendingResume;
    pendingResume = null;
    fn();
}, true);

export function playAudio(type, audio) {
    const [a] = normalize([audio]);
    if (!a) throw new Error('playAudio 需要 {url}');
    const c = cfg(type);
    if (!c.list.some(x => x.url === a.url)) { c.list.push(a); saveSettings(); }
    start(type, a.url);
}

export function pauseAudio(type) {
    cfg(type);
    players[type]?.pause();
}

export const getAudioList = (type) => cfg(type).list.map(a => ({ ...a }));

export function replaceAudioList(type, list) {
    cfg(type).list = normalize(list);
    saveSettings();
}

export function appendAudioList(type, list) {
    const c = cfg(type);
    for (const a of normalize(list)) if (!c.list.some(x => x.url === a.url || x.title === a.title)) c.list.push(a);
    saveSettings();
}

export function getAudioSettings(type) {
    const c = cfg(type);
    return { enabled: c.enabled, mode: c.mode, muted: c.muted, volume: c.volume };
}

export function setAudioSettings(type, s = {}) {
    const c = cfg(type);
    if (typeof s.enabled === 'boolean') c.enabled = s.enabled;
    if (MODES.includes(s.mode)) c.mode = s.mode;
    if (typeof s.muted === 'boolean') c.muted = s.muted;
    if (Number.isFinite(Number(s.volume)) && s.volume !== null && s.volume !== '') c.volume = Math.min(100, Math.max(0, Number(s.volume)));
    applySettings(type);
    saveSettings();
}

export function getCurrentAudio(type) {
    const c = cfg(type);
    const el = players[type];
    if (!el || !el.src) return { src: '', title: '', playing: false, progress: 0 };
    const hit = c.list.find(a => new URL(a.url, location.href).href === el.src);
    return {
        src: el.src,
        title: hit?.title ?? '',
        playing: !el.paused && !el.ended,
        progress: el.duration ? Math.round((el.currentTime / el.duration) * 100) : 0,
    };
}

/** 换角色 / 关聊天时停掉所有声音 */
export function stopAllAudio() {
    for (const el of Object.values(players)) { try { el.pause(); } catch { /* 忽略 */ } }
    pendingResume = null;
}

/**
 * 斜杠命令：/audioenable /audioplay /audiopause /audioimport /audioselect /audiomode
 * @returns {string|undefined} 识别了就返回管道值，不认识返回 undefined
 */
export function audioSlash(name, args, text) {
    const type = args.type === 'ambient' ? 'ambient' : 'bgm';
    switch (name) {
        case 'audioenable': setAudioSettings(type, { enabled: String(args.state ?? 'true') !== 'false' }); return '';
        case 'audioplay': {
            if (String(args.play ?? 'true') === 'false') { pauseAudio(type); return ''; }
            const cur = getCurrentAudio(type);
            const first = cfg(type).list[0];
            if (cur.src) start(type, cur.src); else if (first) start(type, first.url);
            return '';
        }
        case 'audiopause': pauseAudio(type); return '';
        case 'audioimport': {
            const urls = String(args.url ?? text).split(',').map(s => s.trim()).filter(Boolean);
            appendAudioList(type, urls.map(url => ({ url })));
            if (String(args.play ?? 'false') === 'true' && urls[0]) start(type, urls[0]);
            return '';
        }
        case 'audioselect': {
            const url = String(args.url ?? text).trim();
            if (url) playAudio(type, { url });
            return '';
        }
        case 'audiomode': setAudioSettings(type, { mode: args.mode ?? text.trim() }); return '';
        default: return undefined;
    }
}
