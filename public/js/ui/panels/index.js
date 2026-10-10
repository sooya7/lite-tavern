// 右侧设置面板：左边 4 个分组，顶上是搜索框和当前分组的分区，下面是分区内容
import { h, $, clear, icon, iconBtn } from '../dom.js';
import { state, saveSettings } from '../../state.js';
import { GROUPS, TAB_LABELS, groupOf, pathOf } from './nav.js';
import { searchFeatures, locateFeature, revealFeature } from './search.js';
import { startNewChat, goHome, onCreate } from '../sidebar.js';
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

const MODS = { connection, preset, char, world, regex, persona, note, vars, inspector, settings, import: importer };

export const TABS = Object.keys(MODS).map(id => ({ id, label: TAB_LABELS[id], mod: MODS[id] }));

const scrollMemo = {};
/** 每个分组上次停在哪个分区，点分组时回到那里 */
const lastInGroup = {};
let shell = null;

const ACTIONS = {
    newChat: () => startNewChat(),
    home: () => goHome(),
    newChar: () => onCreate(),
};

function currentTab() {
    const id = state.settings.ui.rightTab;
    return TABS.find(t => t.id === id) ?? TABS[0];
}

function selectTab(id) {
    state.settings.ui.rightTab = id;
    saveSettings();
    renderPanels();
}

function buildShell(root) {
    clear(root);
    const rail = h('nav', { class: 'panel-rail', role: 'tablist', 'aria-label': '设置分组' });
    const input = h('input', { class: 'input', type: 'search', placeholder: '搜设置和功能…', 'aria-label': '搜设置和功能', autocomplete: 'off', spellcheck: 'false' });
    const results = h('div', { class: 'panel-results', role: 'listbox', hidden: true });
    const seg = h('div', { class: 'panel-seg', role: 'tablist', 'aria-label': '分区' });
    const body = h('div', { class: 'panel-body' });
    const head = h('div', { class: 'panel-head' },
        h('div', { class: 'search-box panel-search' }, icon('search'), input),
        iconBtn('x', '收起', () => window.dispatchEvent(new CustomEvent('lt:toggle-right', { detail: false }))));
    root.append(rail, h('div', { class: 'panel-main' }, head, results, seg, body));
    shell = { root, rail, input, results, seg, body, active: -1, hits: [] };
    bindSearch();
    return shell;
}

function bindSearch() {
    const { input, results } = shell;
    const close = () => { results.hidden = true; shell.hits = []; shell.active = -1; };
    const paint = () => {
        clear(results);
        shell.hits = searchFeatures(input.value, f => (f.tab ? pathOf(f.tab) : ''));
        shell.active = shell.hits.length ? 0 : -1;
        if (!input.value.trim()) { close(); return; }
        results.hidden = false;
        if (!shell.hits.length) {
            results.append(h('div', { class: 'panel-results-empty' }, '没找到。换个说法试试，比如“字号”“温度”“开场白”'));
            return;
        }
        shell.hits.forEach((f, i) => results.append(h('button', {
            class: `panel-result ${i === 0 ? 'active' : ''}`,
            type: 'button',
            role: 'option',
            // 用 mousedown：点结果时输入框先失焦，等 click 就来不及了
            onmousedown: (e) => { e.preventDefault(); go(f); },
        }, h('span', { class: 'r-t' }, f.t), h('span', { class: 'r-p' }, f.tab ? pathOf(f.tab) : '直接执行'))));
    };
    const move = (d) => {
        if (!shell.hits.length) return;
        shell.active = (shell.active + d + shell.hits.length) % shell.hits.length;
        [...results.children].forEach((el, i) => el.classList.toggle('active', i === shell.active));
        results.children[shell.active]?.scrollIntoView({ block: 'nearest' });
    };
    const go = (f) => {
        input.value = '';
        close();
        input.blur();
        openFeature(f);
    };
    input.addEventListener('input', paint);
    input.addEventListener('focus', () => { if (input.value.trim()) paint(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
        else if (e.key === 'Enter' && shell.hits[shell.active]) { e.preventDefault(); go(shell.hits[shell.active]); }
        else if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; close(); }
    });
}

/** 跳到某项功能：切到它的分区，展开折叠块、滚过去并闪一下；面板外的动作直接执行 */
export function openFeature(f) {
    if (f.action) {
        // 面板是盖在聊天上的抽屉时先收起来，不然看不到动作的结果
        if (matchMedia('(max-width: 1100px)').matches) window.dispatchEvent(new CustomEvent('lt:toggle-right', { detail: false }));
        ACTIONS[f.action]?.();
        return;
    }
    scrollMemo[f.tab] = 0;
    selectTab(f.tab);
    if (!f.find) return;
    const tryReveal = (left) => {
        const el = shell && locateFeature(shell.body, f.find);
        if (el) revealFeature(el);
        else if (left > 0) setTimeout(() => tryReveal(left - 1), 150); // 个别分区（导入）是异步填的
    };
    tryReveal(4);
}

/** 打开面板后把光标放进搜索框（Ctrl/⌘+K） */
export function focusPanelSearch() {
    shell?.input.focus();
    shell?.input.select();
}

export function renderPanels() {
    const root = $('#right');
    if (!root) return;
    if (!shell || shell.root !== root || !root.contains(shell.body)) buildShell(root);
    const { rail, seg, body } = shell;
    const tab = currentTab();
    const group = groupOf(tab.id);
    if (root.dataset.tab) scrollMemo[root.dataset.tab] = body.scrollTop;
    root.dataset.tab = tab.id;
    root.dataset.group = group.id;
    lastInGroup[group.id] = tab.id;

    clear(rail);
    rail.append(...GROUPS.map(g => h('button', {
        class: `tab ${g.id === group.id ? 'active' : ''}`,
        role: 'tab',
        type: 'button',
        title: `${g.label}：${g.hint}`,
        'aria-selected': String(g.id === group.id),
        dataset: { group: g.id },
        onclick: () => selectTab(lastInGroup[g.id] ?? g.tabs[0]),
    }, icon(g.icon), h('span', {}, g.label))));

    clear(seg);
    seg.append(...group.tabs.map(id => h('button', {
        class: `seg-tab ${id === tab.id ? 'active' : ''}`,
        role: 'tab',
        type: 'button',
        'aria-selected': String(id === tab.id),
        dataset: { tab: id },
        onclick: () => selectTab(id),
    }, TAB_LABELS[id])));

    clear(body);
    try {
        tab.mod.render(body);
    } catch (e) {
        console.error(e);
        body.append(h('div', { class: 'empty' }, `面板出错：${e.message}`));
    }
    body.scrollTop = scrollMemo[tab.id] ?? 0;
}

/** 只在当前就是这个分区时重绘 */
export function rerenderIfActive(id) {
    if (state.settings.ui.rightTab === id && !document.querySelector('#right .panel-body :focus')) renderPanels();
}
