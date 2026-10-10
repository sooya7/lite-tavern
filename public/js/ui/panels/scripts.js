// 脚本：角色卡 / 预设自带的酒馆助手脚本。总开关、按卡 / 按预设的开关、逐个脚本的开关和运行状态。
import { h, icon } from '../dom.js';
import { state, saveSettings } from '../../state.js';
import { section, collapsible, toggle } from '../form.js';
import { flattenScriptTrees, scriptTreesOf, isMvuLoaderOnly } from '../../core/scripts.js';
import { syncScripts, scriptToggled, scriptStatus, reloadAllScripts, scriptSettingsNodes } from '../scripts.js';

const STATE_TEXT = { loading: '启动中', running: '运行中', error: '出错了', stopped: '已停止' };

function scriptRow(item, source, sourceOn) {
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

    const cards = [
        state.char ? sourceCard(`角色卡「${state.char.card.data.name}」的脚本`, 'character', state.char.card.data.extensions, state.char.id, cfg.characters) : null,
        state.preset ? sourceCard(`预设「${state.preset.name}」的脚本`, 'preset', state.preset.data.extensions, state.preset.name, cfg.presets) : null,
    ].filter(Boolean);
    if (cards.length) body.append(...cards);
    else body.append(h('div', { class: 'empty' }, state.char ? '当前角色卡和预设都没有自带脚本' : '先在左边选一个角色。当前预设没有自带脚本'));

    if (cards.length) {
        body.append(h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { class: 'btn small', type: 'button', onclick: () => reloadAllScripts() }, icon('refresh'), '全部重新加载'),
            h('span', { class: 'hint', style: { margin: 0 } }, '脚本表现不对时先试这个')));
    }

    // 有的脚本会把自己的设置界面放进酒馆的“扩展设置”区域，这里给它们一个落脚处
    const nodes = scriptSettingsNodes().filter(n => n.childElementCount);
    if (nodes.length) body.append(collapsible('脚本自己的设置界面', nodes, { open: true }));
}
