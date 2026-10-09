// 极简 EJS 编译器（自写，语义对齐 ejs 3.x）：<% %> <%= %> <%- %> <%# %> <%% %%> <%_ _%> -%>
// 编译为 async 函数，模板里可以 await；变量通过 with(locals) 访问。

const TOKEN_RE = /(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)/;

export function escapeXML(s) {
    return String(s ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' })[c]);
}

const stripSemi = (s) => s.replace(/;(\s*$)/, '$1');

function splitTemplate(str) {
    const out = [];
    let rest = str;
    let m;
    while ((m = TOKEN_RE.exec(rest))) {
        if (m.index) out.push(rest.slice(0, m.index));
        out.push(m[0]);
        rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push(rest);
    return out;
}

/** 把模板编译成 JS 源码 */
export function compileSource(template) {
    const text = String(template).replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>');
    const parts = splitTemplate(text);
    let src = '';
    let mode = null; // eval | escaped | raw | comment | literal
    let truncate = false;
    const addOutput = (line) => {
        if (truncate) {
            line = line.replace(/^(?:\r\n|\r|\n)/, '');
            truncate = false;
        }
        if (!line) return;
        src += `;__append(${JSON.stringify(line)})\n`;
    };
    for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        if (line.startsWith('<%') && !line.startsWith('<%%')) {
            const closing = parts[i + 2];
            if (!(closing === '%>' || closing === '-%>' || closing === '_%>')) {
                throw new Error(`EJS: 找不到 "${line}" 的结束标记`);
            }
        }
        switch (line) {
            case '<%': case '<%_': mode = 'eval'; break;
            case '<%=': mode = 'escaped'; break;
            case '<%-': mode = 'raw'; break;
            case '<%#': mode = 'comment'; break;
            case '<%%': mode = 'literal'; src += `;__append("<%")\n`; break;
            case '%%>': mode = 'literal'; src += `;__append("%>")\n`; break;
            case '%>': case '-%>': case '_%>':
                if (mode === 'literal') addOutput(line);
                mode = null;
                truncate = line.startsWith('-') || line.startsWith('_');
                break;
            default:
                if (mode) {
                    let code = line;
                    if ((mode === 'eval' || mode === 'escaped' || mode === 'raw') && code.lastIndexOf('//') > code.lastIndexOf('\n')) code += '\n';
                    if (mode === 'eval') src += `;${code}\n`;
                    else if (mode === 'escaped') src += `;__append(__escape(${stripSemi(code)}))\n`;
                    else if (mode === 'raw') src += `;__append(${stripSemi(code)})\n`;
                    else if (mode === 'literal') addOutput(code);
                } else {
                    addOutput(line);
                }
        }
    }
    return src;
}

const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor;
const cache = new Map();

/**
 * 编译模板为 async (locals) => string
 * locals 里的函数可以通过 print() 往输出追加（运行时注入）。
 */
export function compile(template, { cacheKey } = {}) {
    const key = cacheKey ?? template;
    if (cache.has(key)) return cache.get(key);
    const body = `let __output = '';
const __append = (s) => { if (s !== undefined && s !== null) __output += s; };
const print = (...a) => { __output += a.map(x => typeof x === 'string' ? x : (x === undefined || x === null ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)))).join(''); };
with (__locals) {
${compileSource(template)}
}
return __output;`;
    const fn = new AsyncFunction('__locals', '__escape', body);
    const wrapped = (locals = {}) => fn(locals, escapeXML);
    if (cache.size > 500) cache.clear();
    cache.set(key, wrapped);
    return wrapped;
}

export async function render(template, locals = {}, opts = {}) {
    if (typeof template !== 'string' || !template.includes('<%')) return template;
    return compile(template, opts)(locals);
}

export const hasEjs = (s) => typeof s === 'string' && s.includes('<%');
