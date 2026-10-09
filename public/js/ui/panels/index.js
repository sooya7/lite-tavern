// 右侧面板宿主：标签页 + 各面板渲染
import { h, $, clear, iconBtn } from '../dom.js';
import { state, saveSettings } from '../../state.js';
import * as connection from './connection.js';
import * as preset from './preset.js';
import * as char from './char.js';
import * as world from './world.js';
import * as regex from './regex.js';
import * as persona from './persona.js';
import * as note from './note.js';
import * as vars from './vars.js';
import * as inspector from './inspector.js';
import * as settings from './settings.js';
import * as importer from './import.js';

export const TABS = [
    { id: 'connection', label: '连接', mod: connection },
    { id: 'preset', label: '预设', mod: preset },
    { id: 'char', label: '角色', mod: char },
    { id: 'world', label: '世界书', mod: world },
    { id: 'regex', label: '正则', mod: regex },
    { id: 'persona', label: '用户', mod: persona },
    { id: 'note', label: '本聊天', mod: note },
    { id: 'vars', label: '变量', mod: vars },
    { id: 'inspector', label: '提示词', mod: inspector },
    { id: 'settings', label: '设置', mod: settings },
    { id: 'import', label: '导入', mod: importer },
];

const scrollMemo = {};

export function renderPanels() {
    const root = $('#right');
    if (!root) return;
    const current = state.settings.ui.rightTab;
    const tab = TABS.find(t => t.id === current) ?? TABS[0];
    const oldBody = root.querySelector('.panel-body');
    if (oldBody && root.dataset.tab) scrollMemo[root.dataset.tab] = oldBody.scrollTop;
    clear(root);
    root.dataset.tab = tab.id;
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
        TABS.map(t => h('button', {
            class: `tab ${t.id === tab.id ? 'active' : ''}`,
            role: 'tab',
            onclick: () => {
                state.settings.ui.rightTab = t.id;
                saveSettings();
                renderPanels();
            },
        }, t.label)),
        h('div', { class: 'grow' }),
        matchMedia('(max-width: 1100px)').matches ? iconBtn('x', '收起', () => window.dispatchEvent(new CustomEvent('lt:toggle-right', { detail: false }))) : null,
    );
    const body = h('div', { class: 'panel-body' });
    root.append(tabs, body);
    try {
        tab.mod.render(body);
    } catch (e) {
        console.error(e);
        body.append(h('div', { class: 'empty' }, `面板出错：${e.message}`));
    }
    body.scrollTop = scrollMemo[tab.id] ?? 0;
    tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 只在当前就是这个面板时重绘 */
export function rerenderIfActive(id) {
    if (state.settings.ui.rightTab === id && !document.querySelector('#right .panel-body :focus')) renderPanels();
}
