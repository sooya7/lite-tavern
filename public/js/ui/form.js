// 表单小工具：直接绑定到对象字段，改动即写回并回调。
import { h, icon } from './dom.js';

export function field(label, control, hint) {
    return h('div', { class: 'field' },
        label ? h('label', { class: 'label' }, label) : null,
        control,
        hint ? h('div', { class: 'hint' }, hint) : null);
}

export function textInput(obj, key, { placeholder = '', type = 'text', onChange, autocomplete = 'off', list } = {}) {
    const el = h('input', { class: 'input', type, placeholder, value: obj[key] ?? '', autocomplete, spellcheck: 'false', list });
    el.addEventListener('input', () => { obj[key] = el.value; onChange?.(el.value); });
    return el;
}

export function textArea(obj, key, { rows = 4, code = false, placeholder = '', onChange, autoGrow = true, maxRows = 24 } = {}) {
    const el = h('textarea', { class: `textarea ${code ? 'code' : ''}`, rows, placeholder, spellcheck: 'false' });
    el.value = obj[key] ?? '';
    const grow = () => {
        if (!autoGrow) return;
        el.style.height = 'auto';
        const lh = 20;
        el.style.height = `${Math.min(el.scrollHeight + 2, maxRows * lh + 16)}px`;
    };
    el.addEventListener('input', () => { obj[key] = el.value; grow(); onChange?.(el.value); });
    requestAnimationFrame(grow);
    return el;
}

export function numberInput(obj, key, { min, max, step = 1, onChange, placeholder = '' } = {}) {
    const el = h('input', { class: 'input', type: 'number', min, max, step, placeholder, value: obj[key] ?? '' });
    el.addEventListener('input', () => {
        if (el.value === '') return;
        let v = Number(el.value);
        if (Number.isNaN(v)) return;
        obj[key] = v;
        onChange?.(v);
    });
    return el;
}

export function checkbox(obj, key, label, { onChange, invert = false, hint } = {}) {
    const input = h('input', { type: 'checkbox', checked: invert ? !obj[key] : !!obj[key] });
    input.addEventListener('change', () => { obj[key] = invert ? !input.checked : input.checked; onChange?.(obj[key]); });
    return h('label', { class: 'check', title: hint ?? '' }, input, h('span', {}, label));
}

export function toggle(checked, onChange, title = '') {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch', title, onclick: (e) => e.stopPropagation() }, input, h('span'));
}

/**
 * @param {object} obj
 * @param {string} key
 * @param {Array<{value: any, label: string}>|Array<string>} options
 */
export function select(obj, key, options, { onChange, number = false } = {}) {
    const el = h('select', { class: 'select' }, options.map(o => {
        const opt = typeof o === 'object' ? o : { value: o, label: o };
        return h('option', { value: String(opt.value), selected: String(obj[key] ?? '') === String(opt.value) }, opt.label);
    }));
    el.addEventListener('change', () => {
        const v = number ? Number(el.value) : el.value;
        obj[key] = v;
        onChange?.(v);
    });
    return el;
}

export function rangeRow(obj, key, { min = 0, max = 1, step = 0.01, onChange } = {}) {
    const range = h('input', { type: 'range', min, max, step, value: obj[key] ?? min });
    const num = h('input', { class: 'input', type: 'number', min, max, step, value: obj[key] ?? min });
    range.addEventListener('input', () => { num.value = range.value; obj[key] = Number(range.value); onChange?.(obj[key]); });
    num.addEventListener('input', () => {
        if (num.value === '' || Number.isNaN(Number(num.value))) return;
        range.value = num.value;
        obj[key] = Number(num.value);
        onChange?.(obj[key]);
    });
    return h('div', { class: 'range-row' }, range, num);
}

export function section(title, ...children) {
    return h('div', { class: 'card' }, title ? h('div', { class: 'card-title' }, title) : null, ...children);
}

export function collapsible(title, children, { open = false, sub } = {}) {
    return h('details', { class: 'fold', open },
        h('summary', {}, icon('chevronDown', 'fold-ic'), h('span', { class: 'grow' }, title), sub ? h('span', { class: 'muted small' }, sub) : null),
        h('div', { class: 'fold-body' }, children));
}

/**
 * 名字很多的勾选清单：勾上的直接列出来，没勾的收进折叠块，点开才能选。
 * 勾 / 取消后当场挪位置，折叠块开着就保持开着。名字不多（不超过 foldOver 个）时照旧全部列出。
 * @param {string[]} names
 * @param {(name: string) => boolean} isOn
 * @param {(name: string, on: boolean) => any} onToggle 要同步改好 isOn 读的那份数据（存盘之类的可以异步）
 */
export function pickList(names, isOn, onToggle, { noneText = '一个都没勾', moreTitle = '其他', unit = '个', foldOver = 6 } = {}) {
    const wrap = h('div', { class: 'pick-list' });
    let open = false;
    const draw = (focusName) => {
        const boxes = new Map();
        const row = (n) => {
            const cb = h('input', { type: 'checkbox', checked: isOn(n) });
            cb.addEventListener('change', () => { const r = onToggle(n, cb.checked); draw(n); return r; });
            boxes.set(n, cb);
            return h('label', { class: 'check' }, cb, h('span', {}, n));
        };
        const more = wrap.querySelector(':scope > .fold');
        if (more) open = more.open;
        wrap.replaceChildren();
        if (names.length <= foldOver) {
            wrap.append(h('div', { class: 'check-list' }, names.map(row)));
        } else {
            const on = names.filter(isOn), off = names.filter(n => !isOn(n));
            wrap.append(on.length ? h('div', { class: 'check-list' }, on.map(row)) : h('div', { class: 'muted small pick-none' }, noneText));
            if (off.length) wrap.append(collapsible(moreTitle, h('div', { class: 'check-list' }, off.map(row)), { open, sub: `${off.length} ${unit}` }));
        }
        if (focusName) boxes.get(focusName)?.focus({ preventScroll: true });
    };
    draw();
    return wrap;
}

/** JSON 编辑框：失焦或点保存时解析，失败标红 */
export function jsonEditor(value, onSave, { rows = 10, label = '保存' } = {}) {
    const ta = h('textarea', { class: 'textarea code', rows, spellcheck: 'false' });
    ta.value = JSON.stringify(value ?? {}, null, 2);
    const err = h('div', { class: 'hint', style: { color: 'var(--danger)' } });
    const btn = h('button', {
        class: 'btn small primary',
        onclick: async () => {
            try {
                const v = ta.value.trim() ? JSON.parse(ta.value) : {};
                err.textContent = '';
                await onSave(v);
            } catch (e) {
                err.textContent = `JSON 有误：${e.message}`;
            }
        },
    }, label);
    return h('div', {}, ta, err, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '6px' } }, btn));
}
