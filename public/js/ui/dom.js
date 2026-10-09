// DOM 小工具：h()、图标、提示、弹窗、菜单、文件选择。

export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
    while (el.firstChild) el.firstChild.remove();
    return el;
}

// Lucide 风格线性图标（MIT 风格的简单路径，自绘）
const ICONS = {
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/>',
    branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    regex: '<path d="M17 3v10M12.67 5.5l8.66 5M12.67 10.5l8.66-5"/><path d="M4 17h5v5H4z"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
    variable: '<path d="M8 21s-4-3-4-9 4-9 4-9M16 3s4 3 4 9-4 9-4 9M9 9l6 6M15 9l-6 6"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    continue: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    mask: '<path d="M2 8c0-2 2-3 5-3h10c3 0 5 1 5 3 0 6-4 10-10 10S2 14 2 8z"/><path d="M8 11h.01M16 11h.01"/>',
    wand: '<path d="m15 4 5 5L9 20H4v-5z"/><path d="M13 6l5 5"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
    brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
};

export function icon(name, cls = '') {
    const span = document.createElement('span');
    span.className = `ic ${cls}`;
    span.style.display = 'inline-flex';
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
    return span;
}

export function iconBtn(name, title, onClick, cls = '') {
    return h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, type: 'button', onclick: onClick }, icon(name));
}

// ---------- 提示 ----------
export function toast(message, type = 'info', ms = 3200) {
    const root = document.getElementById('toasts');
    const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' }, h('div', { class: 'grow' }, message));
    el.addEventListener('click', () => el.remove());
    root.append(el);
    setTimeout(() => el.remove(), type === 'error' ? Math.max(ms, 6000) : ms);
}

// ---------- 弹窗 ----------
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
    const root = document.getElementById('modal-root');
    let resolveFn;
    const done = new Promise(r => { resolveFn = r; });
    const close = (value) => {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        onClose?.(value);
        resolveFn(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const foot = h('div', { class: 'modal-foot' }, actions.map(a => h('button', {
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
        type: 'button',
        onclick: async () => {
            if (a.onClick) {
                const r = await a.onClick();
                if (r === false) return;
                close(r === undefined ? a.value : r);
            } else close(a.value);
        },
    }, a.label)));
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-head' }, h('div', { class: 'grow' }, title ?? ''), iconBtn('x', '关闭', () => close(undefined))),
        h('div', { class: 'modal-body' }, body),
        actions.length ? foot : null,
    );
    const backdrop = h('div', { class: 'modal-backdrop' }, box);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) backdrop.dataset.down = '1'; });
    backdrop.addEventListener('mouseup', (e) => { if (e.target === backdrop && backdrop.dataset.down) close(undefined); delete backdrop.dataset.down; });
    document.addEventListener('keydown', onKey);
    root.append(backdrop);
    const firstInput = box.querySelector('input, textarea, select');
    setTimeout(() => firstInput?.focus(), 30);
    return { close, done, el: box };
}

export function confirmDialog(message, { title = '确认', okLabel = '确定', danger = false } = {}) {
    return modal({
        title,
        body: h('div', { style: { whiteSpace: 'pre-wrap' } }, message),
        actions: [{ label: '取消', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
    }).done.then(v => !!v);
}

export function promptDialog(message, defaultValue = '', { title = '输入', multiline = false, placeholder = '' } = {}) {
    const input = multiline
        ? h('textarea', { class: 'textarea', value: defaultValue, placeholder, rows: 8 })
        : h('input', { class: 'input', value: defaultValue, placeholder });
    const m = modal({
        title,
        body: h('div', {}, message ? h('div', { class: 'muted small', style: { marginBottom: '8px' } }, message) : null, input),
        actions: [{ label: '取消', value: null }, { label: '确定', primary: true, onClick: () => input.value }],
    });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.close(input.value); } });
    return m.done.then(v => (v === undefined ? null : v));
}

// ---------- 菜单 ----------
let openMenu = null;
export function popupMenu(anchor, items) {
    openMenu?.remove();
    const menu = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map(it => it === '-' ? h('div', { class: 'sep' }) : h('button', {
        type: 'button',
        role: 'menuitem',
        class: it.danger ? 'danger' : '',
        style: it.danger ? { color: 'var(--danger)' } : undefined,
        onclick: () => { menu.remove(); openMenu = null; it.onClick?.(); },
    }, it.icon ? icon(it.icon) : null, it.label)));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    openMenu = menu;
    setTimeout(() => {
        const off = (e) => {
            if (!menu.contains(e.target)) { menu.remove(); openMenu = null; document.removeEventListener('pointerdown', off, true); }
        };
        document.addEventListener('pointerdown', off, true);
    });
    return menu;
}

// ---------- 文件 ----------
export function pickFiles({ accept = '', multiple = false } = {}) {
    return new Promise((resolve) => {
        const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
        input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text, name, type = 'application/json') {
    downloadBlob(new Blob([text], { type }), name);
}

export function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 简单的拖拽排序（指针事件，手机可用） */
export function makeSortable(container, itemSelector, onMove) {
    let dragEl = null, placeholderIdx = -1, startY = 0;
    container.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('.drag-handle');
        if (!handle || !container.contains(handle)) return;
        dragEl = handle.closest(itemSelector);
        if (!dragEl) return;
        e.preventDefault();
        startY = e.clientY;
        dragEl.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
            const items = [...container.querySelectorAll(itemSelector)];
            items.forEach(i => i.classList.remove('drop-before', 'drop-after'));
            const over = items.find(i => { const r = i.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY <= r.bottom; });
            if (!over || over === dragEl) { placeholderIdx = -1; return; }
            const r = over.getBoundingClientRect();
            const after = ev.clientY > r.top + r.height / 2;
            over.classList.add(after ? 'drop-after' : 'drop-before');
            placeholderIdx = items.indexOf(over) + (after ? 1 : 0);
            const scroller = container.closest('.panel-body, .modal-body');
            if (scroller) {
                const sr = scroller.getBoundingClientRect();
                if (ev.clientY < sr.top + 40) scroller.scrollTop -= 12;
                if (ev.clientY > sr.bottom - 40) scroller.scrollTop += 12;
            }
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            const items = [...container.querySelectorAll(itemSelector)];
            items.forEach(i => i.classList.remove('drop-before', 'drop-after'));
            dragEl.classList.remove('dragging');
            const from = items.indexOf(dragEl);
            if (placeholderIdx >= 0 && Math.abs(startY) >= 0) {
                let to = placeholderIdx > from ? placeholderIdx - 1 : placeholderIdx;
                if (to !== from) onMove(from, to);
            }
            dragEl = null;
            placeholderIdx = -1;
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}
