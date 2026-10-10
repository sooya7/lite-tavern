// 设置面板的结构：4 个分组，每组 2–4 个分区。按“这项设置影响谁”来分。
// 纯数据，不碰 DOM（单测会检查搜索清单和这里对得上）。分区 id 同时是 settings.ui.rightTab 的取值和 lt:open-panel 的参数。

export const GROUPS = [
    { id: 'model', label: '模型', icon: 'cpu', hint: '用哪个接口、哪套预设', tabs: ['connection', 'preset'] },
    { id: 'char', label: '角色', icon: 'idCard', hint: '角色卡、世界书、正则、脚本', tabs: ['char', 'world', 'regex', 'scripts'] },
    { id: 'chat', label: '本聊天', icon: 'message', hint: '只影响当前这个聊天', tabs: ['note', 'vars', 'inspector'] },
    { id: 'general', label: '通用', icon: 'settings', hint: '你的身份、界面、导入', tabs: ['persona', 'settings', 'import'] },
];

export const TAB_LABELS = {
    connection: '连接',
    preset: '预设',
    char: '角色卡',
    world: '世界书',
    regex: '正则',
    scripts: '脚本',
    note: '作者注释',
    vars: '变量',
    inspector: '提示词预览',
    persona: '用户设定',
    settings: '外观与行为',
    import: '导入',
};

export const groupOf = (tabId) => GROUPS.find(g => g.tabs.includes(tabId)) ?? GROUPS[0];

/** “模型 › 预设” */
export const pathOf = (tabId) => `${groupOf(tabId).label} › ${TAB_LABELS[tabId] ?? tabId}`;
