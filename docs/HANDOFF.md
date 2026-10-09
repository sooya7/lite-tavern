# 轻酒馆 交接文档

更新：2026-10-09

## 1. 项目是什么

一个兼容酒馆（SillyTavern 1.18）数据格式的轻量 AI 角色扮演前端。目标是“轻、快、手机好用”，同时让用户现有的角色卡、对话补全预设、世界书、正则，以及最常用的插件能力（提示词模板 EJS、MVU 变量、酒馆助手式前端卡）原样可用。

路线选择：没有 fork 酒馆，而是独立实现。原因是酒馆前端自身就有约 200 个模块、5.8 MB JS，扩展直接依赖它的内部模块和 DOM，砍不轻；而独立实现时，数据格式与酒馆双向兼容，不支持的功能可以回酒馆打开同一份数据。代价是任意第三方扩展跑不了，只能把常用能力原生实现。

## 2. 目录结构

```
server.mjs              入口：参数解析、路由、静态文件、登录
server/
  http.mjs              Router、读写 body、静态文件（带 ETag）
  store.mjs             数据目录读写：角色卡 PNG、聊天 JSONL、预设/世界书 JSON、设置、密钥、备份、回收站
  proxy.mjs             LLM 代理：浏览器只发 {path, body}，服务端补地址和密钥后转发，流式原样回传
  st-import.mjs         从酒馆数据目录检测/扫描/导入（只读源目录）
public/
  index.html, css/app.css
  frontend-runtime.js   前端卡 iframe 内运行时（酒馆助手 / MVU 常用接口）
  vendor/               js-yaml, lodash, showdown, DOMPurify, jQuery（含许可证）
  js/core/              纯逻辑，不碰 DOM，Node 里可直接测
    util.js png.js macros.js regex.js worldinfo.js ejs.js tokens.js
    preset.js prompt.js card.js providers.js chat.js vars.js mvu.js template.js session.js
  js/                   应用层
    api.js state.js controller.js generate.js app.js
  js/ui/                界面
    dom.js render.js frontend.js chat.js sidebar.js importers.js form.js
    panels/ index connection preset char world regex persona note vars inspector settings import
test/core.test.mjs      核心单元测试（12 项）
tools/
  e2e.py                Playwright 端到端测试
  mock-llm.mjs          假模型服务（OpenAI / Claude / Gemini，可模拟 429、错误正文、空回复、慢速）
  fixtures/test-card.json  端到端用测试卡（MVU + 世界书 + 正则 + 前端卡 + EJS）
  check-imports.mjs     前端模块导入导出静态检查
  smoke-real.mjs        用真实酒馆数据组提示词做冒烟（参数：数据目录、卡、预设、聊天）
  st-compat-scan.mjs, st-ejs-scan.mjs  扫描酒馆数据里用到了哪些特性
docs/HANDOFF.md         本文档
```

## 3. 关键数据流

**发送一条消息**（`generate.js` → `generate()`）：
1. 先占住 `state.generating`（防连点），`flushPending()` 把待保存的设置写盘（代理从 `settings.json` 读连接配置，不写盘会用旧地址）
2. `addUserMessage` → 永久正则 → 宏替换 → 入聊天
3. `ChatSession.preparePrompt()`：楼层正则（带深度）→ 世界书（EJS 预处理 → 激活）→ `buildChatCompletion` 按预设顺序组装 → EJS 对每条消息求值
4. `buildRequest` 按接口类型拼请求体 → `/api/llm/:conn` 代理 → SSE 解析，流式写入 `m.mes` 并重绘
5. 失败按设置重试（429/5xx/网络错误/错误当正文/空回复）；中途停止保留已生成部分；失败回滚占位（重新生成会恢复被删的旧回复）
6. 收尾：拆 `<think>` 思维链 → 永久正则 → 同步 swipe → MVU 基于上一层变量应用本条更新 → 保存 → 广播事件给前端卡

**显示一条消息**（`ui/chat.js` → `fillMessage`）：`session.displayText()`（仅显示正则 + EJS 渲染）→ `formatMessage()`（引号高亮、showdown、DOMPurify、`<style>` 作用域化）→ 代码块里的完整 HTML 文档挂成沙箱 iframe（`ui/frontend.js`）。

**前端卡**：iframe 是 `sandbox` 无同源。读接口（`getAllVariables`、`getChatMessages`、`Mvu.getMvuData` 等）用宿主注入的快照同步返回；写接口（`createChatMessages`、`setChatMessages`、`triggerSlash`、`replaceVariables`、`generate`）走 postMessage RPC，由 `app.js` 里的处理函数执行。斜杠命令只支持一个子集（见 `app.js` 的 `triggerSlash`）。

## 4. 数据与兼容约定

- 数据目录结构与酒馆对应：`characters/*.png`、`chats/<角色>/*.jsonl`、`presets/*.json`、`worlds/*.json`、`avatars/`；另有 `settings.json`、`secrets.json`、`backups/`、`trash/`
- 聊天 JSONL：第一行元数据，之后每行一条消息；未知字段原样保留。`mes` 永远是当前显示版本，`swipes[swipe_id]` 只在切换/生成结束时同步（与酒馆一致，别改成反过来，之前因此出过流式不显示的 bug）
- MVU：每层 `variables[swipe_id] = {stat_data, display_data, delta_data}`；`[initvar]` 条目即使禁用也读取
- 删除一律移到 `trash/`，聊天和世界书保存时定期备份到 `backups/`
- 密钥只在 `secrets.json`，`/api/secrets` 只返回掩码；从酒馆导入预设时会去掉 `proxy_password` / `reverse_proxy`

## 5. 当前状态（已验证的部分）

- `npm test`：12 项核心单元测试全过（宏、正则、世界书、EJS、MVU、变量、提示词组装、接口格式、PNG/JSONL 往返）
- 真实数据冒烟：用户酒馆里的 5 组预设 + 角色卡组提示词，无 EJS 报错、无残留宏（唯一残留是某张卡私有的酒馆助手宏，属预期）
- 酒馆数据导入：通过接口实测导入成功（角色+聊天、预设、世界书、正则、用户设定）
- 端到端（无头 Chromium + 假模型），最后一次完整运行 16/17 通过：配置连接/存密钥/拉模型/测试连接、密钥不回传、导入测试卡、流式+思维链+MVU+前端卡+世界书/EJS 进提示词、变量面板、重刷、429 重试、错误正文重试、空回复重试、编辑/隐藏/删除、提示词预览、Claude/Gemini 收发、刷新恢复、浅色主题、手机 390px 布局
  - 未通过的一项是“中途停止”：原因是假模型回复太短，点停止前已经生成完。之后已把假模型的慢速回复加长、断言改为检查结尾标记，**但按要求没有再跑**，下次接手先跑一遍 `python tools/e2e.py` 确认
  - 同一次运行里已确认流式过程中正文实时显示、停止后消息条数正确

## 6. 没覆盖 / 已知限制

- 从未用真实 API 跑过（全部是假模型），第一次真实使用要留意各家中转的流式格式差异
- 界面的编辑类面板（预设提示词编辑、世界书条目编辑、正则编辑器、角色编辑、用户设定、导入面板的界面流程）只做过静态检查，没有端到端覆盖
- 不支持：群聊、文本补全（Text Completion）接口、酒馆助手脚本库（操作酒馆页面的脚本）、任意第三方酒馆扩展、Persona Weaver、故事神谕
- 提示词模板（EJS）实现了常用 API，冷门函数可能缺
- token 数是估算（没有真实分词器）
- 角色列表直接加载原图头像，超大 PNG（实测有 8.5 MB 的）多了会占内存，后续应在服务端生成缩略图
- 只在无头浏览器 390px 宽度看过手机布局，没在真机上试

## 7. 建议的下一步

1. 跑一遍端到端，确认“中途停止”通过
2. 用一个真实接口（用户自己的中转）小额实测一次流式和重试
3. 给编辑类面板补端到端用例
4. 服务端头像缩略图（纯 zlib 解码缩放 PNG，或前端 canvas 生成后缓存）
5. 按需补：群聊、文本补全、斜杠命令更多子集

## 8. 开发注意

- 无构建：浏览器直接加载 ES 模块，改完刷新即可；改了模块间的导入导出后跑 `node tools/check-imports.mjs`
- `core/` 保持不依赖 DOM，方便在 Node 里测；新逻辑优先放这里并补单测
- 保存是防抖的（`state.js`）：`saveX()` 排队，`flushPending()` 立即写所有待保存项；切换角色/预设/聊天、发请求前都要先 flush，否则防抖回调会读到新状态写错文件
- 在 Windows 的 Git Bash 里用 heredoc/python 改代码时反斜杠会被吞（`\\n` 变成真换行、`'\\'` 变成 `'\'`），含反斜杠的代码用编辑器或 `String.fromCharCode(92)` 之类写法
- 运行数据默认在 `./data`，已在 `.gitignore`，不要提交
