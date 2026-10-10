// 设置：外观、输入、兼容开关、自动重试、关于
import { h } from '../dom.js';
import { state, saveSettings } from '../../state.js';
import { refresh } from '../../controller.js';
import { extensionList, fetchExtensionList, isExtensionEnabled, setExtensionEnabled } from '../extensions.js';
import { field, numberInput, checkbox, select, textArea, section, collapsible, rangeRow } from '../form.js';

let followSystem = null;

/** 实际生效的深浅色（auto 时看系统） */
export function resolvedTheme() {
    const t = state.settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyAppearance() {
    const ui = state.settings.ui;
    const root = document.documentElement;
    const theme = resolvedTheme();
    root.dataset.theme = theme;
    root.style.setProperty('--mes-font', `${Number(ui.fontSize) || 16}px`);
    root.style.setProperty('--chat-width', `${Number(ui.chatWidth) || 780}px`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#faf9f5' : '#262624';
    try { localStorage.setItem('lt-theme', state.settings.theme || 'auto'); } catch { /* 无痕模式 */ }
    if (!followSystem) {
        followSystem = matchMedia('(prefers-color-scheme: dark)');
        followSystem.addEventListener('change', () => { if (!['light', 'dark'].includes(state.settings.theme)) { applyAppearance(); refresh('topbar'); } });
    }
}

export function render(body) {
    const s = state.settings;
    const ui = s.ui;
    const p = s.power;
    const r = s.retry;
    const save = () => saveSettings();
    const look = () => { applyAppearance(); save(); };
    const rerender = () => { save(); refresh('chat'); };

    body.append(section('外观',
        // 主题立刻落盘（不等防抖）：换完马上刷新或关页面也要保住
        field('主题', select(s, 'theme', [{ value: 'auto', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }], { onChange: () => { applyAppearance(); saveSettings({ now: true }); } })),
        field('正文字号', rangeRow(ui, 'fontSize', { min: 12, max: 24, step: 0.5, onChange: look })),
        field('聊天区宽度（px）', rangeRow(ui, 'chatWidth', { min: 560, max: 1600, step: 20, onChange: look })),
        checkbox(ui, 'showReasoning', '显示思维链（可折叠）', { onChange: rerender }),
        checkbox(ui, 'showMesId', '显示楼层号', { onChange: rerender }),
        field('聊天页只显示最近几楼', numberInput(ui, 'chatWindow', { min: 0, max: 9999, onChange: rerender, placeholder: '80' }), '只影响显示，不影响发给 AI 的内容；更早的点顶部按钮再加载。0 = 全部显示'),
        checkbox(ui, 'renderFrontend', '渲染代码块里的前端界面（酒馆助手式状态栏/面板）', { onChange: rerender }),
        checkbox(ui, 'enterToSend', '电脑上按 Enter 发送（Shift+Enter 换行）', { onChange: save }),
    ));

    body.append(section('兼容性',
        field('MVU 变量框架', select(p, 'mvu', [
            { value: 'auto', label: '自动（检测到 MVU 卡/预设时启用）' },
            { value: 'on', label: '总是启用' },
            { value: 'off', label: '关闭' },
        ], { onChange: rerender })),
        checkbox(p, 'ejs', '执行 EJS 模板（ST-Prompt-Template 语法 <% %>）', { onChange: rerender }),
        checkbox(p, 'ejsRender', '消息显示时也执行 EJS', { onChange: rerender }),
        checkbox(p, 'thinkAutoParse', '自动把 <think>…</think> 拆成思维链', { onChange: save }),
        checkbox(p, 'regexAllowCharacter', '启用角色卡自带的正则', { onChange: rerender }),
        checkbox(p, 'regexAllowPreset', '启用预设自带的正则', { onChange: rerender }),
        checkbox(p, 'preferCharacterPrompt', '角色卡的主提示词覆盖预设', { onChange: save }),
        checkbox(p, 'preferCharacterJailbreak', '角色卡的历史后指令覆盖预设', { onChange: save }),
        checkbox(p, 'pinExamples', '示例对话不因超长被裁掉', { onChange: save }),
        checkbox(s, 'authorsNoteScan', '作者注释内容也参与世界书匹配', { onChange: save }),
    ));

    body.append(section('自动重试',
        checkbox(r, 'enabled', '失败时自动重试（429 / 5xx / 网络错误）', { onChange: save }),
        h('div', { class: 'grid2' },
            field('最多重试次数', numberInput(r, 'maxRetries', { min: 0, max: 10, onChange: save })),
            field('间隔（毫秒，逐次递增）', numberInput(r, 'delayMs', { min: 0, step: 500, onChange: save })),
        ),
        checkbox(r, 'onEmpty', '回复为空时也重试', { onChange: save }),
        field('把这些“正文”当成错误（每行一个正则）', textArea(r, 'errorPatterns', { rows: 3, code: true, onChange: save }), '有的中转会把上游报错当成正常回复返回，命中这里的短回复会被当作失败重试'),
    ));

    body.append(extensionsSection());

    body.append(collapsible('关于', [
        h('div', { class: 'kv' },
            h('span', { class: 'k' }, '数据目录'), h('span', { style: { wordBreak: 'break-all' } }, state.server?.data ?? ''),
            h('span', { class: 'k' }, '版本'), h('span', {}, state.server?.version ?? ''),
            h('span', { class: 'k' }, '访问密码'), h('span', {}, state.server?.auth ? '已开启' : '未开启（仅本机访问时没问题；开放到局域网请用 --password 启动）'),
        ),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, '数据格式与酒馆一致：characters/ 下是 PNG 角色卡，chats/ 下是 JSONL 聊天，presets/ 和 worlds/ 是 JSON，可以直接拷回酒馆使用。'),
    ]));
}

/** 酒馆第三方插件（如柚月の记忆）：开关，改完刷新页面生效 */
function extensionsSection() {
    const list = h('div', {});
    const draw = () => {
        list.replaceChildren();
        if (!extensionList.length) {
            list.append(h('div', { class: 'hint' }, '插件目录里没有插件。把酒馆插件（带 manifest.json 的文件夹）放进服务端的插件目录（启动参数 --extensions-dir）后刷新。'));
            return;
        }
        for (const e of extensionList) {
            const box = { on: isExtensionEnabled(e.name) };
            const status = e.error ? `加载失败：${e.error}` : e.loaded ? '已加载' : box.on ? '刷新页面后加载' : '';
            list.append(checkbox(box, 'on', `${e.display_name}${e.version ? ` ${e.version}` : ''}`, {
                onChange: (v) => { setExtensionEnabled(e.name, v); draw(); },
            }));
            if (status || e.description) list.append(h('div', { class: 'hint', style: { margin: '-4px 0 8px 26px' } }, [e.description, status].filter(Boolean).join(' · ')));
        }
        list.append(h('div', { class: 'hint' }, '开关改完要刷新页面才生效。插件的设置界面由插件自己提供（通常是页面上的悬浮按钮或菜单）。'));
    };
    if (extensionList.length) draw();
    else fetchExtensionList().then(draw, (e) => { list.replaceChildren(h('div', { class: 'hint' }, e.message)); });
    return section('酒馆插件', list);
}
