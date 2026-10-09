// 导入：从酒馆 / TauriTavern 数据目录批量搬（只读源目录），或导入单个文件
import { h, clear, icon, toast, pickFiles } from '../dom.js';
import { state, withDefaults, refreshLists, flushPending, ensurePreset } from '../../state.js';
import { api } from '../../api.js';
import { refresh, loadRelevantWorlds } from '../../controller.js';
import { importFiles } from '../importers.js';
import { section } from '../form.js';

let detected = null;
let scan = null;
let dirInput = '';
const sel = { characters: new Set(), presets: new Set(), worlds: new Set(), withChats: true, regex: true, personas: true, worldSettings: true, overwrite: false };

export function render(body) {
    body.append(section('导入文件',
        h('div', { class: 'muted small', style: { marginBottom: '8px' } }, '支持：角色卡 PNG/JSON（V1/V2/V3）、对话补全预设 JSON、世界书 JSON、正则 JSON、聊天记录 JSONL（导入到当前角色）。也可以直接把文件拖进窗口。'),
        h('button', { class: 'btn', onclick: async () => { const f = await pickFiles({ accept: '.png,.json,.jsonl', multiple: true }); if (f.length) await importFiles(f); } }, icon('upload'), '选择文件'),
    ));

    const box = h('div');
    body.append(section('从酒馆数据目录导入', box));
    renderStImport(box);
}

async function renderStImport(box) {
    clear(box);
    box.append(h('div', { class: 'muted small', style: { marginBottom: '8px' } }, '选酒馆的用户数据目录（一般是 SillyTavern/data/default-user）。只会读取并复制，不会改动原目录。'));
    if (!detected) {
        box.append(h('div', { class: 'muted small' }, '正在查找…'));
        try { detected = await api.stDetect(); } catch { detected = []; }
        return renderStImport(box);
    }
    if (detected.length) {
        box.append(h('div', { class: 'label' }, '找到这些目录：'),
            ...detected.map(d => h('button', { class: `btn small ${dirInput === d ? 'primary' : ''}`, style: { display: 'flex', width: '100%', justifyContent: 'flex-start', marginBottom: '4px', whiteSpace: 'normal', textAlign: 'left' }, onclick: () => { dirInput = d; doScan(box); } }, d)));
    }
    const input = h('input', { class: 'input', placeholder: 'D:\\SillyTavern\\data\\default-user', value: dirInput });
    input.addEventListener('input', () => { dirInput = input.value.trim(); });
    box.append(h('div', { class: 'label' }, '或手动填路径：'), h('div', { class: 'row' }, input, h('button', { class: 'btn small', onclick: () => doScan(box) }, '读取')));
    if (scan) box.append(scanView(box));
}

async function doScan(box) {
    if (!dirInput) { toast('先选或填一个目录', 'warning'); return; }
    try {
        scan = await api.stScan(dirInput);
        sel.characters = new Set(scan.characters.map(c => c.file));
        sel.presets = new Set(scan.presets);
        sel.worlds = new Set(scan.worlds);
        sel.regex = scan.regexCount > 0;
        sel.personas = scan.personaCount > 0;
        sel.worldSettings = scan.hasSettings;
    } catch (e) {
        scan = null;
        toast(e.message, 'error');
    }
    renderStImport(box);
}

function checkList(title, items, set, label) {
    const all = h('input', { type: 'checkbox', checked: items.length && items.every(i => set.has(i.key)) });
    const boxes = items.map(i => {
        const cb = h('input', { type: 'checkbox', checked: set.has(i.key) });
        cb.addEventListener('change', () => { if (cb.checked) set.add(i.key); else set.delete(i.key); all.checked = items.every(x => set.has(x.key)); });
        return { cb, el: h('label', { class: 'check' }, cb, label(i)) };
    });
    all.addEventListener('change', () => {
        for (const [n, b] of boxes.entries()) { b.cb.checked = all.checked; if (all.checked) set.add(items[n].key); else set.delete(items[n].key); }
    });
    return h('details', { class: 'fold', open: items.length <= 8 },
        h('summary', {}, icon('chevronDown', 'fold-ic'), h('span', { class: 'grow' }, `${title}（${items.length}）`),
            h('label', { class: 'check', onclick: (e) => e.stopPropagation() }, all, '全选')),
        h('div', { class: 'fold-body check-list scroll-box' }, boxes.map(b => b.el)));
}

function scanView(box) {
    const wrap = h('div', { style: { marginTop: '12px' } });
    wrap.append(
        checkList('角色卡', scan.characters.map(c => ({ key: c.file, ...c })), sel.characters, (c) => `${c.name}${c.chats ? `（${c.chats} 个聊天）` : ''}`),
        checkList('预设', scan.presets.map(p => ({ key: p, name: p })), sel.presets, (p) => p.name),
        checkList('世界书', scan.worlds.map(w => ({ key: w, name: w })), sel.worlds, (w) => `${w.name}${scan.globalWorlds.includes(w.name) ? '（全局启用中）' : ''}`),
    );
    const opt = (key, label, disabled) => {
        const cb = h('input', { type: 'checkbox', checked: !!sel[key], disabled });
        cb.addEventListener('change', () => { sel[key] = cb.checked; });
        return h('label', { class: 'check' }, cb, label);
    };
    wrap.append(h('div', { style: { margin: '8px 0' } },
        opt('withChats', '连同聊天记录一起导入'),
        opt('regex', `全局正则（${scan.regexCount} 条）`, !scan.regexCount),
        opt('personas', `用户设定 / 头像（${scan.personaCount} 个）`, !scan.personaCount),
        opt('worldSettings', '世界书扫描设置、全局启用的世界书、全局变量', !scan.hasSettings),
        opt('overwrite', '覆盖这边已有的同名文件'),
    ));
    const report = h('div', { class: 'small' });
    const btn = h('button', { class: 'btn primary', onclick: async () => {
        btn.disabled = true;
        clear(report);
        report.append(h('span', { class: 'muted' }, '导入中…大的角色卡和聊天会慢一点'));
        try {
            await flushPending();
            const r = await api.stImport({
                dir: scan.dir,
                characters: [...sel.characters],
                withChats: sel.withChats,
                presets: [...sel.presets],
                worlds: [...sel.worlds],
                regex: sel.regex,
                personas: sel.personas,
                worldSettings: sel.worldSettings,
                overwrite: sel.overwrite,
            });
            // 服务端已把正则/用户设定/世界书设置合并进 settings.json，这里重新读回来
            state.settings = withDefaults(await api.getSettings());
            await refreshLists();
            await ensurePreset();
            state.session = null;
            state.worlds = {};
            await loadRelevantWorlds();
            clear(report);
            report.append(
                h('div', { style: { color: 'var(--ok)' } }, `完成：角色 ${r.characters.length}、聊天 ${r.chats}、预设 ${r.presets.length}、世界书 ${r.worlds.length}、正则 ${r.regex}、用户设定 ${r.personas}`),
                r.skipped.length ? h('div', { class: 'muted' }, `跳过（已存在）：${r.skipped.join('、')}`) : null,
                r.errors.length ? h('div', { style: { color: 'var(--danger)' } }, `出错：${r.errors.join('；')}`) : null,
            );
            refresh(['sidebar', 'topbar', 'chat']);
            toast('导入完成', 'success');
        } catch (e) {
            clear(report);
            report.append(h('div', { style: { color: 'var(--danger)' } }, `导入失败：${e.message}`));
        } finally {
            btn.disabled = false;
        }
    } }, icon('import'), '开始导入');
    wrap.append(btn, report);
    return wrap;
}
