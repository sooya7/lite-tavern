// 右侧面板宿主：标签页 + 各面板渲染
import { h, $, clear, icon, iconBtn } from '../dom.js';
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
    { id: 'connection', label: '连接', icon: 'plug', title: 'API 连接', mod: connection },
    { id: 'preset', label: '预设', icon: 'sliders', title: '对话补全预设', mod: preset },
    { id: 'char', label: '角色', icon: 'idCard', title: '角色卡', mod: char },
    { id: 'world', label: '世界书', icon: 'book', title: '世界书', mod: world },
    { id: 'regex', label: '正则', icon: 'regex', title: '正则脚本', mod: regex },
    { id: 'persona', label: '用户', icon: 'user', title: '用户设定', mod: persona },
    { id: 'note', label: '本聊天', icon: 'note', title: '本聊天', mod: note },
    { id: 'vars', label: '变量', icon: 'variable', title: '变量', mod: vars },
    { id: 'inspector', label: '提示词', icon: 'terminal', title: '提示词预览', mod: inspector },
    { id: 'settings', label: '设置', icon: 'settings', title: '设置', mod: settings },
    { id: 'import', label: '导入', icon: 'import', title: '从酒馆导入', mod: importer },
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
    const rail = h('nav', { class: 'panel-rail', role: 'tablist', 'aria-label': '设置面板' },
        TABS.map(t => h('button', {
            class: `tab ${t.id === tab.id ? 'active' : ''}`,
            role: 'tab',
            type: 'button',
            title: t.title,
            'aria-selected': String(t.id === tab.id),
            onclick: () => {
                state.settings.ui.rightTab = t.id;
                saveSettings();
                renderPanels();
            },
        }, icon(t.icon), h('span', {}, t.label))),
    );
    const body = h('div', { class: 'panel-body' });
    const head = h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title' }, tab.title),
        iconBtn('x', '收起', () => window.dispatchEvent(new CustomEvent('lt:toggle-right', { detail: false }))));
    root.append(rail, h('div', { class: 'panel-main' }, head, body));
    try {
        tab.mod.render(body);
    } catch (e) {
        console.error(e);
        body.append(h('div', { class: 'empty' }, `面板出错：${e.message}`));
    }
    body.scrollTop = scrollMemo[tab.id] ?? 0;
    rail.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 只在当前就是这个面板时重绘 */
export function rerenderIfActive(id) {
    if (state.settings.ui.rightTab === id && !document.querySelector('#right .panel-body :focus')) renderPanels();
}
