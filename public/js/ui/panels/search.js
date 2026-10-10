// 设置面板里的“搜功能”：一份手写的功能清单，按名字或别名找，选中后跳到对应分区并定位到那一项。
// 清单是手写的而不是扫 DOM：各分区是懒渲染的，而且手写才能放别名（“字体大小”找到“正文字号”）。

/**
 * @typedef {object} Feature
 * @property {string} t 显示的名字
 * @property {string} [tab] 所在分区（panels/index.js 里 TABS 的 id）
 * @property {string|string[]} [find] 分区里用来定位的文字（标签、卡片标题、折叠标题、按钮文字或按钮的 title）；
 *   给数组时依次尝试：有的项只在某种接口类型下才显示，找不到就退到它所在的折叠块
 * @property {string} [k] 别名 / 英文名，空格分隔
 * @property {string} [action] 不在面板里的动作：newChat | home | newChar
 */

/** @type {Feature[]} */
export const FEATURES = [
    // ---- 模型 › 连接
    { t: 'API 地址', tab: 'connection', find: '接口地址', k: 'url baseurl 中转 接口 反代' },
    { t: 'API Key', tab: 'connection', find: 'API Key', k: '密钥 秘钥 key token' },
    { t: '模型', tab: 'connection', find: '模型', k: 'model 换模型 模型名' },
    { t: '测试连接', tab: 'connection', find: '测试连接', k: '连通 test' },
    { t: '新建连接', tab: 'connection', find: '新建连接', k: '添加 接口 claude gemini openai' },
    { t: '思考预算 / 返回思考过程', tab: 'connection', find: ['思考预算', '高级选项'], k: 'thinking budget 思维链 claude gemini' },
    { t: '提示词后处理', tab: 'connection', find: ['提示词后处理', '高级选项'], k: 'strict 合并 system openai 中转' },
    { t: '额外请求体 / 请求头', tab: 'connection', find: '额外请求体', k: 'extra body headers json' },

    // ---- 模型 › 预设
    { t: '切换预设', tab: 'preset', k: '换预设 对话补全预设 preset' },
    { t: '导入预设', tab: 'preset', find: '导入预设 JSON', k: 'preset json 破限' },
    { t: '导出预设', tab: 'preset', find: '导出当前预设', k: 'preset json 备份' },
    { t: '提示词条目（开关 / 排序 / 编辑）', tab: 'preset', find: '提示词（拖动排序', k: '预设条目 破甲 破限 文风 prompt 开关' },
    { t: '温度', tab: 'preset', find: '温度 temperature', k: 'temperature 采样参数' },
    { t: 'Top P / Top K', tab: 'preset', find: 'Top P', k: '采样参数 top_p top_k' },
    { t: '上下文上限', tab: 'preset', find: '上下文上限', k: 'context tokens 上下文长度 记忆' },
    { t: '回复上限', tab: 'preset', find: '回复上限', k: 'max tokens 回复长度 最大回复 字数' },
    { t: '流式输出', tab: 'preset', find: '流式输出', k: 'stream 打字机' },
    { t: '推理强度', tab: 'preset', find: '推理强度', k: 'reasoning effort 思考 思维链' },
    { t: '频率惩罚 / 存在惩罚', tab: 'preset', find: '频率惩罚', k: 'frequency presence penalty 重复' },
    { t: '重复惩罚 / Min P / Top A', tab: 'preset', find: '更多采样', k: 'repetition penalty min_p top_a' },
    { t: '预填充', tab: 'preset', find: '预填充（assistant 开头）', k: 'prefill 开头' },
    { t: '继续 / 代写的提示词', tab: 'preset', find: '代写提示词', k: 'continue impersonate nudge' },

    // ---- 角色 › 角色卡
    { t: '角色名字 / 头像', tab: 'char', find: '名字', k: 'name avatar 换头像 改名' },
    { t: '角色描述', tab: 'char', find: '描述（description）', k: '人设 设定 description' },
    { t: '开场白', tab: 'char', find: '开场白（first_mes）', k: 'first message greeting 第一句' },
    { t: '性格 / 场景 / 示例对话', tab: 'char', find: '性格 / 场景 / 示例对话', k: 'personality scenario example' },
    { t: '角色专属提示词', tab: 'char', find: '角色专属提示词', k: 'system prompt 主提示词覆盖 历史后指令' },
    { t: '角色绑定的世界书', tab: 'char', find: '绑定的世界书', k: 'lorebook world 角色书' },
    { t: '标签 / 作者信息', tab: 'char', find: '标签与作者信息', k: 'tags creator 版本 备注' },
    { t: '导出角色卡', tab: 'char', find: '导出 PNG', k: 'png json 备份 分享' },

    // ---- 角色 › 世界书
    { t: '全局世界书', tab: 'world', find: '全局世界书', k: 'lorebook world info 启用' },
    { t: '世界书扫描深度 / 预算', tab: 'world', find: '扫描与预算设置', k: 'scan depth budget 递归' },
    { t: '编辑世界书条目', tab: 'world', find: '编辑世界书', k: 'lorebook entry 关键词 条目' },
    { t: '新建世界书', tab: 'world', find: '新建世界书', k: 'lorebook 创建' },
    { t: '导入世界书', tab: 'world', find: '导入世界书 JSON', k: 'lorebook json' },

    // ---- 角色 › 正则
    { t: '正则脚本（全局 / 角色 / 预设）', tab: 'regex', k: 'regex 替换 美化 仅显示' },

    // ---- 角色 › 脚本
    { t: '酒馆助手脚本（角色卡 / 预设自带）', tab: 'scripts', find: '运行角色卡和预设自带的脚本', k: 'tavern helper js-slash-runner 小手机 悬浮窗 状态栏 变量结构 zod 脚本库' },
    { t: '重新加载脚本', tab: 'scripts', find: ['全部重新加载', '酒馆助手脚本'], k: 'reload 重启 脚本没反应' },

    // ---- 本聊天
    { t: '作者注释', tab: 'note', find: '作者注释（只对这个聊天生效）', k: "author's note 本聊天 备注 注入" },
    { t: '聊天绑定的世界书', tab: 'note', find: '绑定世界书（只对这个聊天生效）', k: 'lorebook chat 本聊天' },
    { t: '场景覆盖', tab: 'note', find: '场景覆盖', k: 'scenario 本聊天' },
    { t: 'MVU 变量（当前状态）', tab: 'vars', find: 'MVU 变量', k: 'stat_data 状态栏 好感度 变量' },
    { t: '聊天变量', tab: 'vars', find: '聊天变量', k: 'getvar setvar local' },
    { t: '全局变量', tab: 'vars', find: '全局变量', k: 'getglobalvar global' },
    { t: '预览下一次发送的提示词', tab: 'inspector', find: '预览下一次发送', k: 'prompt 检查 调试 tokens 看提示词' },
    { t: '上一次实际发送的提示词', tab: 'inspector', find: '上一次实际发送', k: 'prompt 请求体 调试' },

    // ---- 通用 › 用户设定
    { t: '切换 / 新建身份', tab: 'persona', find: '当前身份', k: 'persona user 用户设定 我是谁' },
    { t: '用户名字 / 设定描述', tab: 'persona', find: '设定描述', k: 'persona user 我的名字 人设' },
    { t: '用户头像', tab: 'persona', find: '换头像', k: 'persona avatar 我的头像' },

    // ---- 通用 › 外观与行为
    { t: '主题（深色 / 浅色）', tab: 'settings', find: '主题', k: 'dark light 夜间 暗色 黑色 白色 跟随系统' },
    { t: '正文字号', tab: 'settings', find: '正文字号', k: '字体大小 font size 字大' },
    { t: '聊天区宽度', tab: 'settings', find: '聊天区宽度', k: 'width 宽屏' },
    { t: '显示思维链', tab: 'settings', find: '显示思维链', k: 'reasoning think 思考过程' },
    { t: '显示楼层号', tab: 'settings', find: '显示楼层号', k: 'message id 楼层' },
    { t: '渲染前端界面（状态栏 / 面板）', tab: 'settings', find: '渲染代码块里的前端界面', k: '前端卡 iframe 酒馆助手 html 美化' },
    { t: 'Enter 发送', tab: 'settings', find: '电脑上按 Enter 发送', k: '回车 换行 快捷键' },
    { t: 'MVU 变量框架', tab: 'settings', find: 'MVU 变量框架', k: 'mvu 兼容' },
    { t: 'EJS 模板', tab: 'settings', find: '执行 EJS 模板', k: 'prompt template 提示词模板 兼容' },
    { t: '<think> 自动拆成思维链', tab: 'settings', find: '自动把 <think>', k: 'think reasoning 兼容' },
    { t: '角色卡 / 预设自带的正则', tab: 'settings', find: '启用角色卡自带的正则', k: 'regex 局部正则 兼容' },
    { t: '自动重试', tab: 'settings', find: '自动重试', k: '429 重试 retry 空回 报错' },
    { t: '数据目录 / 版本 / 访问密码', tab: 'settings', find: '关于', k: 'about data password 版本号' },

    // ---- 通用 › 导入
    { t: '导入文件（角色卡 / 预设 / 世界书 / 正则 / 聊天）', tab: 'import', find: '导入文件', k: 'png json jsonl 导入角色卡 上传' },
    { t: '从酒馆搬数据', tab: 'import', find: '从酒馆数据目录导入', k: 'sillytavern 迁移 搬家 批量 酒馆导入' },
    { t: '导入酒馆里的 API 连接', tab: 'import', find: '从酒馆数据目录导入', k: 'luker sillytavern 连接配置 key 密钥 迁移 接口' },
    { t: '与酒馆共用数据', tab: 'import', find: '与酒馆共用数据', k: 'luker sillytavern 共享 同一份 数据目录 同步' },

    // ---- 面板外的动作
    { t: '新聊天', action: 'newChat', k: '开新聊天 new chat 重开' },
    { t: '角色库', action: 'home', k: '全部角色 首页 选角色 换角色' },
    { t: '新建角色', action: 'newChar', k: '创建角色 写卡' },
];

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * @param {string} query
 * @param {(f: Feature) => string} pathOf 这项功能所在位置的文字（“模型 › 预设”），也参与匹配
 * @returns {Feature[]} 最多 limit 条，名字命中的排前面
 */
export function searchFeatures(query, pathOf = () => '', limit = 8) {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = [];
    for (const f of FEATURES) {
        const title = norm(f.t);
        const hay = `${title} ${norm(f.k)} ${norm(pathOf(f))}`;
        if (!words.every(w => hay.includes(w))) continue;
        let score = 0;
        for (const w of words) score += title.startsWith(w) ? 3 : title.includes(w) ? 2 : 1;
        scored.push({ f, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.f);
}

const CANDIDATES = '.label, .card-title, .section-head, summary, .check, .btn, button[title]';

/** 在渲染好的分区里找到那一项：完全相同 > 开头相同 > 包含；按钮也看 title */
export function locateFeature(body, find) {
    if (!find) return null;
    if (Array.isArray(find)) {
        for (const one of find) { const el = locateFeature(body, one); if (el) return el; }
        return null;
    }
    let best = null, bestRank = 9;
    for (const el of body.querySelectorAll(CANDIDATES)) {
        for (const text of [el.textContent.trim(), el.getAttribute('title') ?? '']) {
            const rank = text === find ? 0 : text.startsWith(find) ? 1 : text.includes(find) ? 2 : 9;
            if (rank < bestRank) { best = el; bestRank = rank; }
        }
        if (bestRank === 0) break;
    }
    return best;
}

/** 展开它所在的折叠块，滚到中间并闪一下 */
export function revealFeature(el) {
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
    const target = el.matches('summary') ? el.parentElement : (el.closest('.field, .check, .card') ?? el);
    target.scrollIntoView({ block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth; // 连续两次定位到同一项时让动画重新开始
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1800);
}
