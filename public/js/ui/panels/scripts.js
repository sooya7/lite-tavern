// 脚本：角色卡 / 预设自带的酒馆助手脚本。总开关、按卡 / 按预设的开关、逐个脚本的开关和运行状态。
import { h, icon, toast, confirmDialog, pickFiles } from '../dom.js';
import { state, saveSettings } from '../../state.js';
import { section, collapsible, toggle } from '../form.js';
import { flattenScriptTrees, scriptTreesOf, isMvuLoaderOnly, normalizeScript } from '../../core/scripts.js';
import { globalScriptLib } from '../script-api.js';
import { syncScripts, scriptToggled, scriptStatus, reloadAllScripts, scriptSettingsNodes } from '../scripts.js';

const STATE_TEXT = { loading: '启动中', running: '运行中', error: '出错了', stopped: '已停止' };

function scriptRow(item, source, sourceOn, onDelete) {
    const s = item.script;
    const st = scriptStatus(s.id);
    const builtin = isMvuLoaderOnly(s.content);
    const active = sourceOn && item.on;
    let dot = '', text = '未启用';
    if (active && builtin) text = '只是加载 MVU 变量框架：轻酒馆已内置，不用单独运行';
    else if (active && st) { dot = st.state; text = STATE_TEXT[st.state] ?? st.state; }
    else if (active) { dot = 'loading'; text = '等待启动'; }
    if (active && st?.state === 'running' && st.errors.length) text = '运行中（有报错）';
    const visible = (s.button.buttons ?? []).filter(b => b.visible).length;
    const meta = [text, item.folder ? `文件夹「${item.folder}」` : '', s.button.enabled && visible ? `输入框上方有 ${visible} 个按钮` : ''].filter(Boolean).join(' · ');
    const sw = toggle(s.enabled, (on) => {
        // 写回卡 / 预设里的原对象（旧版格式的脚本内容在 value 里）
        const raw = item.raw.value && item.raw.content === undefined ? item.raw.value : item.raw;
        raw.enabled = on;
        scriptToggled(source);
    }, `开关脚本「${s.name}」`);
    return h('div', { class: 'script-row', dataset: { script: s.id } },
        h('span', { class: `script-dot ${dot}` }),
        h('div', { class: 'script-main' },
            h('div', { class: 'script-name' }, s.name || '未命名脚本'),
            h('div', { class: 'script-meta' }, meta),
            active && st?.errors.length ? h('div', { class: 'script-err' }, st.errors.slice(-2).join('\n')) : null,
            s.info.trim() ? h('details', {}, h('summary', { class: 'script-meta' }, '作者说明'), h('div', { class: 'script-info' }, s.info.trim())) : null,
        ),
        onDelete ? h('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': `删除脚本「${s.name}」`, onclick: onDelete }, icon('trash')) : null,
        sw);
}

function sourceCard(title, source, extensions, key, map) {
    const items = flattenScriptTrees(scriptTreesOf(extensions));
    if (!items.length) return null;
    const on = map[key] !== false;
    const head = h('div', { class: 'card-title' },
        h('span', { class: 'grow' }, `${title}（${items.length} 个）`),
        toggle(on, (v) => {
            if (v) delete map[key]; else map[key] = false;
            saveSettings();
            syncScripts();
        }, source === 'character' ? '这张卡的脚本整体开关' : '这个预设的脚本整体开关'));
    return h('div', { class: 'card' }, head, items.map(item => scriptRow(item, source, on && state.settings.scripts.enabled !== false)));
}

/** 酒馆助手导出的脚本文件：单个脚本、文件夹，或它们的数组；也接受 {scripts: [...]} */
function scriptsFromJson(j) {
    const list = Array.isArray(j) ? j : Array.isArray(j?.scripts) ? j.scripts : Array.isArray(j?.tavern_helper?.scripts) ? j.tavern_helper.scripts : [j];
    const out = [];
    for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        if (x.type === 'folder' && Array.isArray(x.scripts)) out.push({ ...x, scripts: x.scripts.map(normalizeScript) });
        else if (x.content !== undefined || x.value?.content !== undefined) out.push(normalizeScript(x));
    }
    return out;
}

async function importGlobalScripts() {
    const files = await pickFiles({ accept: '.json,application/json', multiple: true });
    if (!files?.length) return;
    const lib = globalScriptLib();
    const trees = lib.tavern_helper.scripts ??= [];
    const have = new Set(flattenScriptTrees(trees).map(x => x.script.id));
    let n = 0;
    for (const f of files) {
        let j;
        try { j = JSON.parse((await f.text()).replace(/^\uFEFF/, '')); } catch { toast(`${f.name} 不是合法的 JSON`, 'error'); continue; }
        const got = scriptsFromJson(j);
        if (!got.length) { toast(`${f.name} 里没有找到脚本`, 'warning'); continue; }
        for (const sc of got) {
            for (const it of sc.type === 'folder' ? sc.scripts : [sc]) {
                if (have.has(it.id)) it.id = crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
                have.add(it.id);
                it.enabled = false;
                n++;
            }
            trees.push(sc);
        }
    }
    if (!n) return;
    saveSettings();
    await syncScripts();
    toast(`已导入 ${n} 个全局脚本。导入的脚本默认关着，确认可信后再打开`, 'success', 5000);
}

function globalCard(cfg) {
    const lib = globalScriptLib();
    const trees = lib.tavern_helper.scripts ??= [];
    const items = flattenScriptTrees(trees);
    const on = cfg.globalEnabled !== false;
    const head = h('div', { class: 'card-title' },
        h('span', { class: 'grow' }, `全局脚本（${items.length} 个，所有角色和预设下都运行）`),
        toggle(on, (v) => { cfg.globalEnabled = v; saveSettings(); syncScripts(); }, '全局脚本整体开关'));
    const remove = (item) => async () => {
        if (!await confirmDialog(`删除全局脚本「${item.script.name || '未命名脚本'}」？`, { okLabel: '删除', danger: true })) return;
        const drop = (list) => {
            for (let i = list.length - 1; i >= 0; i--) {
                const x = list[i];
                if (x === item.raw || x?.value === item.raw || x?.id === item.script.id) list.splice(i, 1);
                else if (x?.type === 'folder' && Array.isArray(x.scripts)) drop(x.scripts);
            }
        };
        drop(trees);
        saveSettings();
        await syncScripts();
    };
    return h('div', { class: 'card' }, head,
        items.length ? items.map(item => scriptRow(item, 'global', on && cfg.enabled !== false, remove(item))) : h('div', { class: 'hint', style: { margin: '4px 0' } }, '还没有全局脚本。酒馆助手里导出的脚本文件（.json）可以导进来'),
        h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', type: 'button', onclick: () => importGlobalScripts().catch(e => toast(`导入失败：${e.message}`, 'error')) }, icon('upload'), '导入脚本')));
}

export function render(body) {
    const cfg = state.settings.scripts;
    const master = h('input', { type: 'checkbox', checked: cfg.enabled !== false });
    master.addEventListener('change', () => {
        cfg.enabled = master.checked;
        saveSettings();
        syncScripts();
    });
    body.append(section('酒馆助手脚本',
        h('label', { class: 'check' }, master, h('span', {}, '运行角色卡和预设自带的脚本')),
        h('div', { class: 'hint' }, '脚本是卡和预设的作者写的程序（小手机、悬浮状态栏、变量结构校验这些）。它和在酒馆里一样，能读写这里的全部数据、使用你配置的模型连接，所以只给信得过的卡和预设开着。导入带脚本的角色卡或预设后，脚本会自动出现在下面并运行。'),
    ));

    body.append(globalCard(cfg));

    const cards = [
        state.char ? sourceCard(`角色卡「${state.char.card.data.name}」的脚本`, 'character', state.char.card.data.extensions, state.char.id, cfg.characters) : null,
        state.preset ? sourceCard(`预设「${state.preset.name}」的脚本`, 'preset', state.preset.data.extensions, state.preset.name, cfg.presets) : null,
    ].filter(Boolean);
    if (cards.length) body.append(...cards);
    else body.append(h('div', { class: 'empty' }, state.char ? '当前角色卡和预设都没有自带脚本' : '先在左边选一个角色。当前预设没有自带脚本'));

    if (cards.length || flattenScriptTrees(globalScriptLib().tavern_helper.scripts ?? []).length) {
        body.append(h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn small', type: 'button', onclick: () => reloadAllScripts() }, icon('refresh'), '全部重新加载'),
            h('span', { class: 'hint', style: { margin: 0 } }, '脚本表现不对时先试这个')));
    }

    // 有的脚本会把自己的设置界面放进酒馆的“扩展设置”区域，这里给它们一个落脚处
    const nodes = scriptSettingsNodes().filter(n => n.childElementCount);
    if (nodes.length) body.append(collapsible('脚本自己的设置界面', nodes, { open: true }));
}
