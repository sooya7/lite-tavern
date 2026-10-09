// 正则面板：全局 / 角色卡局部 / 预设 三组脚本，编辑器带实时测试
import { h, clear, icon, iconBtn, toast, confirmDialog, modal, pickFiles, downloadText, makeSortable } from '../dom.js';
import { state, saveSettings, saveCharacter, savePreset } from '../../state.js';
import { refresh, getSession } from '../../controller.js';
import { newRegexScript, normalizeRegexScript, runRegexScript, REGEX_PLACEMENT } from '../../core/regex.js';
import { regexFromString, clone, debounce } from '../../core/util.js';
import { field, textInput, textArea, numberInput, checkbox, select, section, collapsible, toggle } from '../form.js';
import { renderPanels } from './index.js';
import { importRegexJson } from '../importers.js';

const PLACEMENTS = [
    [REGEX_PLACEMENT.USER_INPUT, '用户输入'],
    [REGEX_PLACEMENT.AI_OUTPUT, 'AI 输出'],
    [REGEX_PLACEMENT.SLASH_COMMAND, '斜杠命令'],
    [REGEX_PLACEMENT.WORLD_INFO, '世界书'],
    [REGEX_PLACEMENT.REASONING, '思维链'],
];

const rerenderChat = debounce(() => refresh('chat'), 400);

function groups() {
    const out = [{
        id: 'global',
        title: '全局正则',
        hint: '对所有角色生效',
        list: state.settings.regex,
        save: () => saveSettings(),
    }];
    if (state.char) {
        const ext = state.char.card.data.extensions ?? (state.char.card.data.extensions = {});
        out.push({
            id: 'character',
            title: `角色局部正则 · ${state.char.card.data.name}`,
            hint: '存在角色卡里，跟着卡走',
            list: ext.regex_scripts ?? (ext.regex_scripts = []),
            save: () => saveCharacter(),
            disabledNote: state.settings.power.regexAllowCharacter === false ? '（设置里已关闭角色正则）' : '',
        });
    }
    if (state.preset) {
        const ext = state.preset.data.extensions ?? (state.preset.data.extensions = {});
        out.push({
            id: 'preset',
            title: `预设正则 · ${state.preset.name}`,
            hint: '存在预设里，跟着预设走',
            list: ext.regex_scripts ?? (ext.regex_scripts = []),
            save: () => savePreset(),
            disabledNote: state.settings.power.regexAllowPreset === false ? '（设置里已关闭预设正则）' : '',
        });
    }
    return out;
}

export function render(body) {
    body.append(h('div', { class: 'hint', style: { marginBottom: '10px' } }, '执行顺序：全局 → 角色 → 预设，组内从上到下。“仅显示”只改屏幕上的样子，“仅提示词”只改发给 AI 的内容，两个都不勾会直接改写消息本身。'));
    for (const g of groups()) body.append(groupBlock(g));
}

function groupBlock(g) {
    const list = h('div');
    const fill = () => {
        clear(list);
        if (!g.list.length) list.append(h('div', { class: 'muted small', style: { padding: '6px 2px' } }, '没有脚本'));
        g.list.forEach((s, i) => {
            const flags = [];
            if (s.markdownOnly) flags.push('仅显示');
            if (s.promptOnly) flags.push('仅提示词');
            if (!s.markdownOnly && !s.promptOnly) flags.push('改写原文');
            const places = (s.placement ?? []).map(p => PLACEMENTS.find(x => x[0] === Number(p))?.[1]).filter(Boolean).join('/');
            list.append(h('div', { class: `list-item ${s.disabled ? 'disabled' : ''}` },
                h('span', { class: 'drag-handle', title: '拖动排序' }, icon('grip')),
                h('div', { class: 'grow', style: { minWidth: 0, cursor: 'pointer' }, onclick: () => editScript(g, s, i, fill) },
                    h('div', { class: 'li-name' }, s.scriptName || '（未命名）'),
                    h('div', { class: 'li-sub' }, `${places || '无作用位置'} · ${flags.join(' ')}${s.minDepth !== null && s.minDepth !== '' && s.minDepth !== undefined ? ` · 深度≥${s.minDepth}` : ''}${s.maxDepth !== null && s.maxDepth !== '' && s.maxDepth !== undefined ? ` · 深度≤${s.maxDepth}` : ''}`)),
                toggle(!s.disabled, (v) => { s.disabled = !v; g.save(); fill(); rerenderChat(); }, '启用/停用'),
            ));
        });
    };
    makeSortable(list, '.list-item', (from, to) => {
        const [m] = g.list.splice(from, 1);
        g.list.splice(to, 0, m);
        g.save();
        fill();
        rerenderChat();
    });
    fill();
    return collapsible(g.title, [
        h('div', { class: 'row', style: { marginBottom: '6px' } },
            h('span', { class: 'muted small grow' }, `${g.hint}${g.disabledNote ?? ''}`),
            iconBtn('plus', '新建', () => {
                const s = newRegexScript();
                g.list.push(s);
                g.save();
                fill();
                editScript(g, s, g.list.length - 1, fill);
            }),
            iconBtn('upload', '导入（酒馆导出的正则 JSON）', async () => {
                const files = await pickFiles({ accept: '.json', multiple: true });
                for (const f of files) {
                    try {
                        const j = JSON.parse(await f.text());
                        if (g.id === 'global') { importRegexJson(j); continue; }
                        for (const x of (Array.isArray(j) ? j : [j])) g.list.push(normalizeRegexScript(x));
                        g.save();
                        toast('已导入', 'success');
                    } catch (e) {
                        toast(`导入 ${f.name} 失败：${e.message}`, 'error');
                    }
                }
                renderPanels();
                rerenderChat();
            }),
            g.list.length ? iconBtn('download', '导出这一组', () => downloadText(JSON.stringify(g.list, null, 4), `regex-${g.id}.json`)) : null,
        ),
        list,
    ], { open: g.id === 'global' || g.list.length > 0, sub: `${g.list.filter(s => !s.disabled).length}/${g.list.length}` });
}

function editScript(g, s, index, refill) {
    const d = clone(s);
    const trimObj = { v: (d.trimStrings ?? []).join('\n') };
    const testIn = h('textarea', { class: 'textarea code', rows: 4, placeholder: '在这里贴一段文字测试效果' });
    const testOut = h('pre', { class: 'regex-test-out' });
    const reState = h('div', { class: 'hint' });
    const runTest = () => {
        const re = regexFromString(d.findRegex ?? '');
        reState.textContent = !d.findRegex ? '' : re ? `✓ 正则有效：${re}` : '✗ 正则写法有误';
        reState.style.color = !d.findRegex || re ? 'var(--muted)' : 'var(--danger)';
        if (!testIn.value) { testOut.textContent = ''; return; }
        const session = getSession();
        try {
            testOut.textContent = runRegexScript({ ...d, disabled: false }, testIn.value, { substitute: session ? (t, o) => session.substitute(t, o ?? {}) : undefined });
        } catch (e) {
            testOut.textContent = `出错：${e.message}`;
        }
    };
    testIn.addEventListener('input', runTest);
    const placements = h('div', { class: 'row wrap' }, PLACEMENTS.map(([v, label]) => {
        const cb = h('input', { type: 'checkbox', checked: (d.placement ?? []).map(Number).includes(v) });
        cb.addEventListener('change', () => {
            const set = new Set((d.placement ?? []).map(Number));
            if (cb.checked) set.add(v); else set.delete(v);
            d.placement = [...set].sort();
        });
        return h('label', { class: 'check' }, cb, label);
    }));
    const nullableDepth = (key) => {
        const el = h('input', { class: 'input', type: 'number', min: -1, placeholder: '不限', value: d[key] ?? '' });
        el.addEventListener('input', () => { d[key] = el.value === '' ? null : Number(el.value); });
        return el;
    };
    const bodyEl = h('div', {},
        field('名字', textInput(d, 'scriptName')),
        field('查找（/正则/标志，或普通文本）', textInput(d, 'findRegex', { placeholder: '/<status>([\\s\\S]*?)<\\/status>/g', onChange: runTest }), null),
        reState,
        field('替换为', textArea(d, 'replaceString', { rows: 5, code: true, onChange: runTest }), '用 $1、$<名字> 引用分组，{{match}} 代表整个匹配；支持宏'),
        field('从捕获内容里剔除（每行一个）', textArea(trimObj, 'v', { rows: 2, code: true, onChange: (v) => { d.trimStrings = v.split('\n').filter(Boolean); runTest(); } })),
        field('作用于', placements),
        h('div', { class: 'row wrap', style: { gap: '14px' } },
            checkbox(d, 'markdownOnly', '仅显示'),
            checkbox(d, 'promptOnly', '仅提示词'),
            checkbox(d, 'runOnEdit', '编辑消息时也执行'),
            checkbox(d, 'disabled', '停用'),
        ),
        h('div', { class: 'grid3' },
            field('最小深度', nullableDepth('minDepth')),
            field('最大深度', nullableDepth('maxDepth')),
            field('查找里的宏', select(d, 'substituteRegex', [{ value: 0, label: '不替换' }, { value: 1, label: '原样替换' }, { value: 2, label: '转义后替换' }], { number: true, onChange: runTest })),
        ),
        h('div', { class: 'hint' }, '深度 0 是最后一条消息，1 是倒数第二条，以此类推。'),
        collapsible('测试', [testIn, h('div', { class: 'label' }, '结果'), testOut], { open: false }),
    );
    runTest();
    modal({
        title: `编辑正则：${s.scriptName || ''}`,
        wide: true,
        body: bodyEl,
        actions: [
            { label: '删除', danger: true, onClick: async () => {
                if (!await confirmDialog(`删除正则「${s.scriptName}」？`)) return false;
                const i = g.list.indexOf(s);
                if (i >= 0) g.list.splice(i, 1);
                g.save();
                refill();
                rerenderChat();
                return true;
            } },
            { label: '取消', value: false },
            { label: '保存', primary: true, onClick: () => {
                Object.assign(s, d);
                g.save();
                refill();
                rerenderChat();
                return true;
            } },
        ],
    });
}

export { section, numberInput };
