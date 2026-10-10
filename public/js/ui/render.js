// 消息渲染：对齐酒馆 messageFormatting（引号高亮、showdown、DOMPurify、<style> 作用域），
// 另外把含完整 HTML 文档的代码块渲染成沙箱 iframe（酒馆助手式前端卡）。
import { h, icon } from './dom.js';

let converter = null;
function getConverter() {
    if (converter) return converter;
    const sd = window.showdown;
    converter = new sd.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
        ghCodeBlocks: true,
    });
    return converter;
}

let purifyReady = false;
function setupPurify() {
    if (purifyReady) return;
    purifyReady = true;
    const DP = window.DOMPurify;
    DP.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A' && node.getAttribute('href')) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
        }
    });
}

const FRONTEND_RE = /<html[\s>]|<body[\s>]|<!doctype html/i;

/** 把 ``` 代码块里的完整 HTML 文档抽出来，换成占位 */
export function extractFrontends(text) {
    const frontends = [];
    // 与 showdown 一致：围栏后的语言标记里不能有反引号，否则“```地点·时间```”这种单行代码会被当成代码块开头
    const out = text.replace(/(^|\n)([ \t]*)(```|~~~)[^\n`]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g, (m, lead, indent, fence, body) => {
        if (!FRONTEND_RE.test(body)) return m;
        frontends.push(body);
        return `${lead}<div data-lt-frontend="${frontends.length - 1}"></div>`;
    });
    return { text: out, frontends };
}

/** 抽出 <style>，作用域化后再塞回 */
function extractStyles(text) {
    const styles = [];
    const out = text.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
        styles.push(css);
        return `<div data-lt-style="${styles.length - 1}"></div>`;
    });
    return { text: out, styles };
}

export function scopeCss(css, scope = '.mes_text') {
    let sheet;
    try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(css.replace(/@import[^;]+;/g, ''));
    } catch {
        return '';
    }
    const rewrite = (rules) => [...rules].map((rule) => {
        if (rule instanceof CSSStyleRule) {
            const sel = rule.selectorText.split(',').map((s) => {
                s = s.trim();
                if (/^(html|body|:root)$/i.test(s)) return scope;
                s = s.replace(/^(html|body|:root)\s+/i, '');
                return s.startsWith(scope) ? s : `${scope} ${s}`;
            }).join(', ');
            const nested = rule.cssRules?.length ? rewrite(rule.cssRules) : '';
            return `${sel} { ${rule.style.cssText} }${nested ? '\n' + nested : ''}`;
        }
        if (rule instanceof CSSMediaRule) return `@media ${rule.conditionText} {\n${rewrite(rule.cssRules)}\n}`;
        if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText} {\n${rewrite(rule.cssRules)}\n}`;
        if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) return '';
        return rule.cssText;
    }).join('\n');
    return rewrite(sheet.cssRules);
}

const QUOTE_PH = String.fromCharCode(0xfffe);

function highlightQuotes(mes) {
    // 与酒馆一致：保护 <style>/代码，标签里的引号先换成占位，再给各种引号包 <q>
    mes = mes.replace(/<([^>]+)>/g, (_, c) => '<' + c.replace(/"/g, QUOTE_PH) + '>');
    mes = mes.replace(/<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim, (match, p1, p2, p3, p4, p5, p6) => {
        if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
        if (p2) return `<q>“${p2.slice(1, -1)}”</q>`;
        if (p3) return `<q>«${p3.slice(1, -1)}»</q>`;
        if (p4) return `<q>「${p4.slice(1, -1)}」</q>`;
        if (p5) return `<q>『${p5.slice(1, -1)}』</q>`;
        if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`;
        return match;
    });
    return mes.replaceAll(QUOTE_PH, '"');
}

/**
 * 文本 → { html, frontends: string[], styles: string[] }
 * @param {string} text 已经过“仅显示”正则与 EJS 的文本
 */
export function formatMessage(text, { charName, isUser = false, isSystem = false } = {}) {
    if (!text) return { html: '', frontends: [], styles: [] };
    setupPurify();
    // 很多卡是 Windows 换行，不归一的话代码块的闭合 ``` 后面跟着 \r，前端卡识别不出来
    let mes = String(text).replace(/\r\n?/g, '\n');
    const fe = extractFrontends(mes);
    mes = fe.text;
    const st = extractStyles(mes);
    mes = st.text;
    if (!isSystem) {
        mes = highlightQuotes(mes);
        mes = getConverter().makeHtml(mes);
        mes = mes.replace(/<code(.*)>[\s\S]*?<\/code>/g, (m) => m.replace(/&amp;/g, '&'));
        mes = mes.trim();
    }
    if (charName && !isUser) mes = mes.replace(new RegExp(`(^|\n)${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'g'), '$1');
    const html = window.DOMPurify.sanitize(mes, {
        ADD_ATTR: ['data-lt-frontend', 'data-lt-style', 'target'],
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form'],
        FORBID_ATTR: ['srcdoc'],
    });
    return { html, frontends: fe.frontends, styles: st.styles };
}

/**
 * 把 formatMessage 的结果挂到容器里（样式作用域化、前端 iframe 挂载）
 * @param {HTMLElement} el .mes_text
 * @param {object} res formatMessage 结果
 * @param {(html: string, wrap: HTMLElement) => HTMLElement} mountFrontend
 */
export function mountFormatted(el, res, mountFrontend) {
    el.innerHTML = res.html;
    el.querySelectorAll('[data-lt-style]').forEach((ph) => {
        const css = res.styles[Number(ph.dataset.ltStyle)] ?? '';
        const scoped = scopeCss(css);
        if (scoped) ph.replaceWith(h('style', {}, scoped));
        else ph.remove();
    });
    el.querySelectorAll('[data-lt-frontend]').forEach((ph) => {
        const html = res.frontends[Number(ph.dataset.ltFrontend)] ?? '';
        if (!mountFrontend) {
            ph.replaceWith(h('pre', {}, h('code', {}, html)));
            return;
        }
        const wrap = h('div', { class: 'frontend-wrap' });
        ph.replaceWith(wrap);
        mountFrontend(html, wrap);
    });
}

export function renderReasoning(text, { open = false, streaming = false, duration } = {}) {
    if (!text) return null;
    const secs = duration ? `${(duration / 1000).toFixed(1)} 秒` : '';
    return h('details', { class: 'reasoning', open },
        h('summary', {}, icon(streaming ? 'clock' : 'brain'), streaming ? '思考中…' : `思考过程${secs ? ' · ' + secs : ''}`, icon('chevronDown', 'chev')),
        h('div', { class: 'reasoning-body' }, text));
}
