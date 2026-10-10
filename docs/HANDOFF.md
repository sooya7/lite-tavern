# 轻酒馆 交接文档

更新：2026-10-10

## 1. 项目是什么

一个兼容酒馆（SillyTavern 1.18）数据格式的轻量 AI 角色扮演前端。目标是“轻、快、手机好用”，同时让用户现有的角色卡、对话补全预设、世界书、正则，以及最常用的插件能力（提示词模板 EJS、MVU 变量、酒馆助手式前端卡、角色卡 / 预设自带的酒馆助手脚本）原样可用。

路线选择：没有 fork 酒馆，而是独立实现。原因是酒馆前端自身就有约 200 个模块、5.8 MB JS，扩展直接依赖它的内部模块和 DOM，砍不轻；而独立实现时，数据格式与酒馆双向兼容，不支持的功能可以回酒馆打开同一份数据。代价是任意第三方扩展跑不了，只能把常用能力原生实现。酒馆助手脚本是个例外：它本来就是跑在 iframe 里、通过一套公开接口和酒馆打交道的，所以这里实现了那套接口，脚本本身原样运行（第 3.5 节）。

## 2. 目录结构

```
server.mjs              入口：参数解析、路由、静态文件、登录
server/
  http.mjs              Router、读写 body、静态文件（带 ETag）
  store.mjs             数据目录读写：角色卡 PNG、聊天 JSONL、预设/世界书 JSON、设置、密钥、备份、回收站
  proxy.mjs             LLM 代理：浏览器只发 {path, body}，服务端补地址和密钥后转发，流式原样回传
  st-import.mjs         从酒馆数据目录检测/扫描/导入（只读源目录，保留原文件修改时间）
  thumb.mjs             头像缩略图：纯 zlib 解码 PNG → 按块平均缩小 → 重新编码（缓存在 data/_cache/thumbs）
public/
  index.html, css/app.css
  frontend-runtime.js   前端卡 iframe 内运行时（酒馆助手 / MVU 常用接口）
  script-stubs/mvu.js   空模块：脚本里 import 的 MVU 打包文件会被换成它（变量更新由内置实现完成）
  css/st-compat.css     脚本往页面上加界面时用到的酒馆主题变量和通用类名（有脚本运行时才加载）
  vendor/               js-yaml, lodash, showdown, DOMPurify, jQuery（含许可证）
  js/core/              纯逻辑，不碰 DOM，Node 里可直接测
    util.js png.js macros.js regex.js worldinfo.js ejs.js tokens.js
    preset.js prompt.js card.js providers.js chat.js vars.js mvu.js template.js session.js
    scripts.js          脚本库的数据结构：规范化、展开文件夹、哪些该运行、MVU 加载脚本的识别
    thformat.js         酒馆助手接口用的世界书 / 预设 / 正则结构 ↔ 酒馆文件格式
  js/                   应用层
    api.js state.js controller.js generate.js app.js
    chatops.js          给前端卡和脚本共用的楼层读写、斜杠命令子集
  js/ui/                界面
    dom.js render.js frontend.js chat.js sidebar.js library.js avatars.js importers.js form.js
    scripts.js          脚本宿主：起停脚本 iframe、收拾脚本留在页面上的东西、脚本按钮、脚本的设置界面
    script-api.js       酒馆助手接口的实现（脚本 iframe 里的全局函数、window.TavernHelper / SillyTavern / Mvu）
    panels/ index nav search connection preset char world regex scripts persona note vars inspector settings import
test/core.test.mjs      核心单元测试（21 项）
tools/
  e2e.py                Playwright 端到端测试
  mock-llm.mjs          假模型服务（OpenAI / Claude / Gemini，可模拟 429、错误正文、空回复、慢速）
  fixtures/test-card.json  端到端用测试卡（MVU + 世界书 + 正则 + 前端卡 + EJS）
  fixtures/script-card.json, script-preset.json  端到端用：自带世界书、正则、酒馆助手脚本的卡和预设
  check-imports.mjs     前端模块导入导出静态检查
  smoke-real.mjs        用真实酒馆数据组提示词做冒烟（参数：数据目录、卡、预设、聊天）
  st-compat-scan.mjs, st-ejs-scan.mjs  扫描酒馆数据里用到了哪些特性
docs/HANDOFF.md         本文档
```

## 2.5 界面结构（2026-10-10 改成 Claude app 风格）

- 配色：浅色暖白 `#faf9f5` / 侧栏 `#f5f4ed`，深色 `#262624` / `#1f1e1d`，强调色陶土橙 `#c96442`。全部是 `app.css` 顶部的变量，深色在 `:root[data-theme="dark"]`。主题 `auto | light | dark`，默认跟随系统；`index.html` 里有一段内联脚本按 localStorage 先上色，防止刷新闪白
- 左栏（`ui/sidebar.js`）：品牌 → 新聊天 / 角色库 → 最近角色（收藏优先，最多 6 个）→ 当前角色的聊天记录（默认聊天名显示成日期）→ 底部用户设定。左栏只放“去哪儿”，不放导入和设置入口
- 首页（`ui/library.js`，`state.view === 'home'` 或没选角色时显示）：问候语、继续上次的聊天、角色库卡片网格（搜索 / 排序）；一张卡都没有时显示上手步骤。首页隐藏输入框
- 消息（`ui/chat.js` 的 `buildMessage`）：用户消息是右侧气泡；角色消息通栏、头部小头像 + 名字。全站（界面 + 正文）统一用 `--font-read` 衬线字体栈，只有代码用等宽。操作按钮（复制 / 编辑 / 重新生成 / 更多）和 swipe 在消息下方一行
- 顶栏：`菜单`（左栏开关，电脑上左栏展开时不显示）、标题（点开是这个聊天的重命名 / 导出 / 删除）、`设置`（右栏开关）。两个按钮都带文字，手机上没有悬停提示
- 输入框：大圆角框，下方工具条：`+`（只有继续写 / 重新生成 / 代我写）、当前预设（点开直接切换）、当前连接（点开直接切换）、发送 / 停止。手机上预设和连接都显示。输入框上方是脚本按钮条（`#script-buttons`）：正在运行的脚本登记的按钮，没有就不显示，一行放不下横向滑
- 右栏 = 设置面板（`ui/panels/index.js`）：左侧 4 个分组，顶上是“搜设置和功能”和当前分组的分区，下面是分区内容。结构定义在 `ui/panels/nav.js`：
  - 模型：连接、预设
  - 角色：角色卡、世界书、正则、脚本
  - 本聊天：作者注释、变量、提示词预览
  - 通用：用户设定、外观与行为、导入
  - 分区 id：`connection` `preset` `char` `world` `regex` `scripts` `note` `vars` `inspector` `persona` `settings` `import`，是 `settings.ui.rightTab` 的取值和 `lt:open-panel` 事件的参数；每个分组记得上次停在哪个分区。`scripts` 是 2026-10-10 加的第 12 个分区（单测里每组分区数的上限相应放到 4）
- 搜功能（`ui/panels/search.js`）：一份手写的功能清单（名字 + 别名 + 所在分区 + 定位文字），选中后切到分区、展开折叠块、滚到那一项并闪一下；`Ctrl/⌘+K` 直接进搜索框。面板上的标签文字改了要同步清单，单测会检查清单里的定位文字都在对应面板源码里，端到端会把清单逐项点一遍
- 入口约定（2026-10-10 整理，起因是用户反馈“找功能很复杂”）：**每个功能只留一个入口**，加新功能时先想它属于哪个分组，不要再往 `+`、标题菜单、左栏里塞快捷方式
  - 新聊天、角色库 → 左栏；导入角色卡、新建角色 → 角色库页；其余导入 → 设置 › 通用 › 导入（文件也可以直接拖进窗口）
  - 深浅色 → 设置 › 通用 › 外观与行为（顶栏的月亮按钮已去掉；主题改动立即落盘）
  - 重新生成 → 最后一条回复下面的按钮；继续写 / 代我写 → 输入框的 `+`；消息的 `⋮` 里只剩隐藏、分支、删除等对这条消息的操作
  - 脚本的开关 → 设置 › 角色 › 脚本（角色卡和预设面板里只有一行“N 个脚本，在「脚本」面板里管理”）
- 头像：列表、消息、顶栏都用 `api.thumbUrl()` 的缩略图（`?thumb=1&v=<mtime>`，带版本号时浏览器长期缓存）；导出卡和角色编辑仍是原图

## 3. 关键数据流

**发送一条消息**（`generate.js` → `generate()`）：
1. 先占住 `state.generating`（防连点），`flushPending()` 把待保存的设置写盘（代理从 `settings.json` 读连接配置，不写盘会用旧地址）
2. `addUserMessage` → 永久正则 → 宏替换 → 入聊天
3. `ChatSession.preparePrompt()`：楼层正则（带深度）→ 世界书（EJS 预处理 → 激活）→ `buildChatCompletion` 按预设顺序组装 → EJS 对每条消息求值
4. `buildRequest` 按接口类型拼请求体 → `/api/llm/:conn` 代理 → SSE 解析，流式写入 `m.mes` 并重绘
   - 组提示词前发 `GENERATION_AFTER_COMMANDS` / `GENERATION_STARTED`，把脚本 `injectPrompts` 注入的内容并进扩展提示词；拼请求体前发 `CHAT_COMPLETION_SETTINGS_READY`，监听者可以原地改 `messages` 和采样参数（预设脚本靠它合并消息、加前缀）
5. 失败按设置重试（429/5xx/网络错误/错误当正文/空回复）；中途停止保留已生成部分；失败回滚占位（重新生成会恢复被删的旧回复）
6. 收尾：拆 `<think>` 思维链 → 永久正则 → 同步 swipe → MVU 基于上一层变量应用本条更新（有脚本监听 MVU 事件时边更新边发事件，见 3.5）→ 卡里有正则用到 `<StatusPlaceHolderImpl/>` 时把它补到正文末尾 → 保存 → 广播事件给前端卡

**显示一条消息**（`ui/chat.js` → `fillMessage`）：`session.displayText()`（仅显示正则 + EJS 渲染）→ `formatMessage()`（引号高亮、showdown、DOMPurify、`<style>` 作用域化）→ 代码块里的完整 HTML 文档挂成沙箱 iframe（`ui/frontend.js`）。

**前端卡**：iframe 是 `sandbox` 无同源。读接口（`getAllVariables`、`getChatMessages`、`Mvu.getMvuData` 等）用宿主注入的快照同步返回；写接口（`createChatMessages`、`setChatMessages`、`triggerSlash`、`replaceVariables`、`generate` / `generateRaw`）走 postMessage RPC，由 `chatops.js` / `generate.js` 里的函数执行。斜杠命令只支持一个子集（见 `chatops.js` 的 `triggerSlash`）。前端卡 `eventEmit` 的事件会同时发给脚本，脚本 `eventEmit` 的自定义事件也会转给前端卡。

## 3.5 酒馆助手脚本（2026-10-10）

角色卡的 `data.extensions.tavern_helper.scripts` 和预设的 `extensions.tavern_helper.scripts`（都可以带文件夹）。以前只用来判断是不是 MVU 卡，现在会运行。

**哪些脚本在跑**（`core/scripts.js` 的 `activeScripts`）：总开关开着 → 当前预设的脚本（这个预设没被单独关掉）+ 当前角色卡的脚本（这张卡没被单独关掉，并且已经打开了聊天）→ 脚本自己的 `enabled`、所在文件夹的 `enabled` 都为真。三层开关分别存在 `settings.scripts.enabled`、`settings.scripts.presets[预设名]` / `settings.scripts.characters[卡 id]`（存的是 `false`，没存就是开）、卡 / 预设文件里脚本自己的 `enabled`。导入的卡和预设默认都开，所以“导入后自动运行”不需要任何额外步骤。

**怎么跑**（`ui/scripts.js`）：每个脚本一个隐藏的同源 iframe（`#lt-script-frames` 里，`srcdoc` + 一个 blob 地址的 `<script type="module">`）。iframe 里第一段脚本调 `parent.__ltScriptBoot(window)`，宿主在脚本代码执行前把接口装进它的 `window`。脚本列表变了（换角色、换预设、开关、脚本内容变了）就对齐一次：不该跑的停掉，该跑的起来；内容和 id 都没变的不重启，所以同一张卡里换聊天脚本不会重启（脚本自己监听 `CHAT_CHANGED`，和酒馆助手一致）。

**为什么是同源而不是沙箱**：脚本要直接操作页面（悬浮窗、小手机、改楼层显示），`$` 指向页面、`window.parent.document` 要能用，这在无同源沙箱里做不到。代价是脚本能读写全部数据、能用配置好的模型连接（拿不到 API Key 原文，密钥只在服务端）——和它在酒馆里的权限一样。所以有三层开关，面板上写明了这一点。前端卡仍然是无同源沙箱，没变。

**停掉时的清理**：移除 iframe（浏览器会在里面触发 `pagehide`，脚本自己的清理代码这时运行）→ 摘掉它的事件监听 → 收走它的按钮、共享到全局的接口、注入的提示词。另外，没自己写 `pagehide` 的脚本（和酒馆助手同一个判断：源码里不含 `pagehide`）由宿主盯着：它拿到的 `$` 会给用 HTML 字符串新建的元素打 `data-lt-script` 标记，`window.parent` 是个替身（`createElement` 出来的元素打标记、写到页面 `window` 上的全局变量记下来），停掉时带标记的元素删掉、全局变量恢复。

**接口**（`ui/script-api.js`，名字、参数、返回值的形状对着酒馆助手 4.11 的公开类型声明；实现是自己写的）：
- 事件：`eventOn / eventOnce / eventMakeFirst / eventMakeLast / eventEmit / eventRemoveListener / eventClearAll …`，接在页面的 `eventSource` 上。监听者超过 30 秒不返回就不再等它
- 变量：`getVariables / replaceVariables / updateVariablesWith / insertOrAssignVariables / insertVariables / deleteVariable / getAllVariables`，类型 `chat` `message` `global` `character`（卡里的 `tavern_helper.variables`）`preset` `script`（脚本自己的 `data`）`extension`
- 楼层：`getChatMessages / setChatMessages / createChatMessages / deleteChatMessages / rotateChatMessages`、`retrieveDisplayedMessage / formatAsDisplayedMessage / refreshOneMessage`
- 世界书（`getWorldbook / replaceWorldbook / updateWorldbookWith / createWorldbookEntries / …` 和各种绑定）、预设（`getPreset / replacePreset / updatePresetWith / setPreset / loadPreset …`）、正则（`getTavernRegexes / replaceTavernRegexes / formatAsTavernRegexedString …`）：结构转换在 `core/thformat.js`，酒馆助手不认识的字段写回时原样保留
- 生成：`generate`（用当前预设，`user_input` 作为最后一条用户消息）、`generateRaw`（按 `ordered_prompts` 拼），支持 `injects` `overrides` `max_chat_history` `should_stream` `generation_id` `custom_api`；实现是 `generate.js` 的 `scriptGenerate`，不占主生成的状态，不写入聊天。`custom_api.apiurl` 由浏览器直接请求（本地服务不替脚本转发任意地址）
- `injectPrompts / uninjectPrompts`、`initializeGlobal / waitGlobalInitialized`、脚本按钮（`appendInexistentScriptButtons / getButtonEvent / replaceScriptButtons …`）、`triggerSlash`、`errorCatched`、`builtin`、`SillyTavern`（每次读都是最新的上下文，带 `getContext()`）、`toastr`（接到自己的提示条）、`YAML`（用自带的 js-yaml 接出 `parse / stringify`）、`_`、`$`
- 页面上也挂了一份不带脚本身份的：`window.TavernHelper`、`window.SillyTavern`、`window.Mvu`、`window.toastr`、`window.YAML`（脚本里常见 `window.parent.TavernHelper.xxx` 的写法；EJS 模板也用 `SillyTavern.getContext()`）

**MVU 和脚本**：
- MVU 打包文件不真的加载。只做这一件事的脚本（`isMvuLoaderOnly`）不起；别的脚本里 import 它的地址会被换成 `/script-stubs/mvu.js`。`Mvu` 全局对象是内置实现给的（`getMvuData / replaceMvuData / parseMessage / events …`），`waitGlobalInitialized('Mvu')` 立即完成
- 有脚本监听 MVU 事件时，更新走 `core/mvu.js` 的 `processMessageWithEvents`：`mag_variable_update_started` → 解析命令 → `mag_command_parsed`（命令是 MVU 的 `CommandInfo` 格式，参数是原文字符串，监听者可以改、可以加）→ `mag_command_parsed_for_zod` / `_ended_for_zod` → 执行剩下的命令 → `mag_variable_update_ended`（监听者原地改变量）→ `_for_zod` → `mag_before_message_update`。顺序和参数与 MagVarUpdate 一致，所以卡里的变量结构脚本（`registerMvuSchema`，它自己从 jsdelivr 取 StageDog 的 `mvu_zod.js`）不用改就能工作：它在 `_for_zod` 事件里按结构校验并执行命令，不合结构的丢弃。没人监听时走原来不发事件的 `processMessage`，行为和以前完全一样；单测保证两条路结果一致
- 新聊天初始化变量后会发 `mag_variable_initialized`（每个开场白一次），变量结构脚本靠它补默认值；脚本比聊天晚就绪时在它注册监听的那一刻补发
- `<StatusPlaceHolderImpl/>`：真正的 MVU 脚本会给每条 AI 回复补这个占位符，卡里的正则再把它换成状态栏。现在内置实现也补（`ChatSession.usesStatusPlaceholder()`：卡 / 预设 / 全局正则里有替换它的，或开场白里本来就带着，才补），以前新回复不显示状态栏就是因为缺这个

**脚本用到的第三方库**：`$` 是页面的 jQuery（`vendor/jquery.min.js`，有脚本要跑时才加载）；`z`（zod 4.4.3）和 Vue 3 从 jsdelivr 取（依次试 testingcf / cdn / fastly / gcore 四个镜像），源码里出现 `z.` / `Vue` 才取；图标字体 Font Awesome 同理。酒馆助手自己也是从 jsdelivr 取 Vue 的，脚本本身 import 的东西也都在 jsdelivr，所以这不增加新的依赖点。这台开发机访问不了 npm，所以没有把 zod / Vue 收进 `vendor/`；以后想离线可用可以收进来，改 `ui/scripts.js` 的 `needZod / needVue`。

**脚本的设置界面**：有的脚本把自己的设置界面放进酒馆的 `#extensions_settings` / `#extensions_settings2` / `#extensionsMenu`。页面上常驻这三个容器（平时在隐藏的 `#lt-script-holder` 里），打开 设置 › 角色 › 脚本 时搬进面板的“脚本自己的设置界面”折叠块，面板重绘前搬回去（`parkScriptSettings`）。`css/st-compat.css` 提供酒馆的主题变量（`--SmartThemeBodyColor` 等，指到轻酒馆自己的配色上）和 `menu_button`、`inline-drawer` 等常用类名。注意别在里面定义和轻酒馆重名的变量（`--active` 踩过一次）。

**页面上给脚本留的钩子**：`#chat`、`.mes[mesid][swipeid]`、`.mes_text`、`.mes_block`、`.name_text`、`.last_mes`、`.swipe_left` / `.swipe_right`、`#send_textarea`、`#send_but`，以及几个看不见的同名元素 `#mes_stop`、`#option_regenerate`、`#option_continue`（点了走原有功能）。脚本按这些找元素；改聊天区结构时留着它们。

**`#tavern_helper` 脚本列表**：隐藏的 `#lt-script-holder` 里有一个 `#tavern_helper`，下面每个脚本一个 `div[data-script-id]`（角色卡脚本在前、预设脚本在后，开没开都列）。这是照着酒馆助手设置面板的结构放的：用官方模板写的脚本启动时到这里找自己，判断“同名脚本装了好几份时该哪一份生效”，找不到列表就加载了但什么也不做——不报错，所以很隐蔽。

**交给脚本的提示词消息**：`CHAT_COMPLETION_PROMPT_READY` / `GENERATE_AFTER_DATA` / `CHAT_COMPLETION_SETTINGS_READY` 里的消息只有 `role` / `content` / `name`（`generate.js` 的 `plainMessages`），不带内部的来源标记；监听者没改就沿用原来那份，改了就用它的（`adoptMessages`）。`GENERATE_AFTER_DATA` 必须在拼请求体之前发：新版酒馆上合并消息的脚本只听它。

## 3.6 与酒馆 / Luker 共用数据（2026-10-10）

- 启动参数 `--st-data <酒馆用户数据目录>`（或环境变量 `LT_ST_DATA`）：`characters` / `chats` / `worlds` 对应同名目录，预设对应 `OpenAI Settings`，直接读写酒馆那一份。设置、密钥、头像、备份、回收站、缓存仍在自己的 `--data` 里。`/api/ping` 的 `shared` 字段显示共用目录
- 版本检查：聊天、角色卡、预设、世界书读时记版本（文件 mtime 毫秒 + 大小，响应头 `X-Version`），保存带 `X-Expect`，对不上返回 409（聊天 `chat-conflict`，其余 `conflict`），前端弹窗「载入最新的 / 用这边的覆盖」，覆盖前留备份。新建、导入覆盖不带版本号不查；聊天文件已存在却没带版本号一律拒绝。同一文件的保存在前端排队（`api.js` 的 `versions` / `saving`）
- 校验标记：共用模式下每次写聊天都换 `chat_metadata.integrity`，并更新 Luker 的 `<聊天名>.luker-state.chat_sync.json`（已存在才更新）；先写聊天后写标记（`stampIntegrity`、`rotateSyncSidecar`）。改名 / 删除聊天时带上 `<聊天名>.luker-state.*.json`
- 旧页面挡住：除 `/api/login`、`/api/llm/*` 外，非 GET 请求必须带 `X-LT-Client: 2`（`server.mjs` 的 `CLIENT_PROTOCOL`、`api.js` 的 `PROTOCOL`），否则 409 `stale-client`。**用 curl 调接口要带这个头**。共用模式必须和这条检查一起上
- 导入 API 连接：`/api/st/import` 的 `connections` 选项读酒馆 `settings.json` 的 `extension_settings.connectionManager.profiles` 和 `secrets.json`，Key 只在服务端搬；有 `secret-id` 只认那一个 Key，找不到宁可留空；已有连接靠 `stProfile` 或“同地址同模型”认出，`overwrite: true` 才按酒馆更新
- 工具：`tools/st-roundtrip-check.mjs <目录>` 只读体检（存回去是否丢字段）；`tools/fake-st-dir.mjs` 造假酒馆目录给端到端用
- 共用的边界：连接和密钥、全局正则、用户设定、全局变量、全局启用的世界书不共用。角色卡 / 世界书 / 预设在 Luker 那边没有冲突检查，规矩是**一边改完，另一边先刷新再改**

### 关于 Luker 必须知道的事（读它的源码得出的，容器里 `src/endpoints/chats.js`）

- Luker 是 `funnycups/Luker` v2.8.0，SillyTavern 的分支，Docker 容器 `luker`，数据在 `/opt/luker/data/admin`。
- **聊天不是整存整取**：客户端发补丁（`/patch`、`/append`），服务端打到磁盘文件上。所以别的程序改了聊天文件而它不知道，会出乱子。保护机制是 integrity 标记：
  - 标记存在聊天旁边的 `<聊天名>.luker-state.chat_sync.json`（`{integrity, updated_at}`），**以它为准**；这个文件不存在才看聊天第一行的 `chat_metadata.integrity`，并据此建出这个文件。
  - Luker 每次写聊天都会换标记。客户端带着旧标记来保存会收到冲突，然后走它自己的恢复流程。
  - 我们的做法（已实现）就是每次写聊天都把两处标记一起换掉。**这条路径只读过代码，没在真的 Luker 界面里演练过**，上线后找一个无关紧要的聊天试一下：Luker 开着它 → 轻酒馆里发一句 → 回 Luker 再发一句，应该看到 Luker 提示冲突或自动重载，而不是把轻酒馆那句吞掉。
- 聊天旁边还有别的附属文件（`memory_graph__meta`、`luker_orchestrator_anchors__schema`、`luker_search_tools_anchors__meta`），是 Luker 扩展的数据。轻酒馆改名 / 删除聊天时会带上它们，但**在轻酒馆里删改楼层，这些数据不会跟着更新**。
- Luker 的“最近聊天”列表是进程内存里的索引，轻酒馆新建的聊天要等 Luker 重启才会出现在那个列表里（角色自己的聊天列表是读磁盘的，不受影响）。
- 角色卡缓存按文件 mtime 失效，头像缩略图在原图更新时会重新生成，这两样不用管。
- 预设：Luker 把**当前预设的值存在自己的 `settings.json` 里**，预设文件只在点保存时才写。所以轻酒馆改了预设文件，Luker 要重新选一次这个预设才生效。
- 角色卡 / 世界书 / 预设在 Luker 那边没有冲突检查：它拿着旧内容保存会直接盖掉轻酒馆的修改。轻酒馆这边能发现并提示，Luker 那边不能。给用户的规矩是：**一边改完，另一边先刷新页面再改**。
- Luker 的 `secrets.json`：`api_key_custom` 是 36 个 `{id, value, label, active}`，其中约一半 `value` 是空的；另有 2 个 `api_key_deepseek`。只有 9 个 Key 挂在连接配置上，其余的没有对应地址，没法迁成连接——告诉用户。**任何时候都不要把 Key 的值打印出来。**

## 4. 数据与兼容约定

- 数据目录结构与酒馆对应：`characters/*.png`、`chats/<角色>/*.jsonl`、`presets/*.json`、`worlds/*.json`、`avatars/`；另有 `settings.json`、`secrets.json`、`backups/`、`trash/`
- 聊天 JSONL：第一行元数据，之后每行一条消息；未知字段原样保留。`mes` 永远是当前显示版本，`swipes[swipe_id]` 只在切换/生成结束时同步（与酒馆一致，别改成反过来，之前因此出过流式不显示的 bug）
- MVU：每层 `variables[swipe_id] = {stat_data, display_data, delta_data}`；`[initvar]` 条目即使禁用也读取
- 删除一律移到 `trash/`，聊天和世界书保存时定期备份到 `backups/`
- 密钥只在 `secrets.json`，`/api/secrets` 只返回掩码；从酒馆导入预设时会去掉 `proxy_password` / `reverse_proxy`

## 5. 当前状态（已验证的部分）

- `npm test`：21 项核心单元测试全过（宏、正则、世界书、EJS、MVU、变量、提示词组装、接口格式、PNG/JSONL 往返、前端卡识别、缩略图、设置面板结构与搜索清单；脚本库的规范化与起停判断、MVU 事件流程与不发事件的路径结果一致、状态栏占位符、酒馆助手数据格式来回转换、导入角色卡时世界书和脚本的去向）
- 2026-10-10 共用模式：单测 24/24、端到端 31/31（含共用导入、聊天冲突三种选法、预设冲突、旧页面拦截）；Luker 真实数据只读体检通过（角色卡 25、世界书 33、预设 6、聊天 22 存回去不丢字段）。**Luker 界面里的冲突提示没在真界面演练过**
- 跑端到端：沙箱 / 有 HTTP 代理的环境要设 `NO_PROXY=127.0.0.1,localhost`（否则 `mock()` 的 urllib 走代理 404）；下载不了 Playwright 的 Chromium 时设 `LT_CHROMIUM=/usr/bin/chromium` 用系统浏览器
- 端到端（无头 Chromium + 假模型）26/26 通过，含“中途停止”、设置面板 4 组 12 区逐个打开、搜索清单逐项定位、各菜单的条目、手机上顶栏文字和预设切换；脚本 5 项：导入带脚本的卡后世界书 / 正则 / 脚本自动就位并运行、MVU 事件和变量结构、脚本按钮与脚本变量、脚本自己调模型、面板开关与停掉后的清理、换角色 / 换预设跟着起停、预设脚本改请求和注入提示词、脚本的设置界面、刷新后恢复。注意每次跑前要重启 `mock-llm.mjs`：429 / 错误正文用例是“每个进程只触发一次”，复用旧进程会误报“没有重试”
- 端到端不需要外网：zod 和 `mvu_zod.js` 用 `tools/e2e.py` 里的替身顶上，jsdelivr 的其余请求直接掐掉。真库的行为要在能联网的地方另外验证（见下面 2026-10-10 的脚本实测）
- 2026-10-10 用 117 服务器上 Luker 的真实数据实测（导入 25 角色 / 22 聊天 / 6 预设 / 33 世界书 / 10 正则，0 错误）：
  - 角色库 25 张卡缩略图共约 1.7 MB（原图合计约 82 MB，最大一张 15.9 MB → 61 KB），每张首次生成 50–250 ms
  - “咩咩预设 - ver 0.9.0”组提示词约 2.9 万 tokens、激活 17 条世界书，无 EJS / 宏残留
  - 真实接口（用户自己的中转，`gcli-gemini-3.8-flash`）：测试连接通；小提示词 4.5 秒出首字；真实预设 + 真实卡 2.8 秒出首字、56 秒生成 3338 字，全程流式，无报错
  - 手机 390px 无横向溢出
- 2026-10-10 外网部署收尾验证（`https://117.72.216.74:8446/`）：
  - HTTPS 直连返回 200，证书校验通过，`/api/ping` 返回 `auth: false`（按用户要求不设访问密码）
  - 外网 Chromium 调用真实中转 1 次：7 个流式数据块，首块约 2.9 秒，约 6.4 秒结束；正文在生成过程中多次增长，SSE 未被 nginx 压缩或攒到结束才返回
  - 界面、输入框、按钮、用户消息和角色正文的计算字体一致；浅色 / 深色切换正常；390px 聊天页和 25 张卡的角色库没有横向溢出；页面脚本错误为 0
  - 本次浏览器验证使用内存中的临时聊天，拦截测试产生的保存请求，没有写入服务器聊天和设置
  - 服务端 60 个运行文件与本地 SHA-256 全部一致；`lite-tavern.service` 正常运行且已启用开机自启；nginx 配置检查通过，证书续期 timer 已启用且运行中
- 2026-10-10 脚本实测（117 上另起的测试实例，用线上数据的副本 + 假模型；真的 zod、真的 `mvu_zod.js`、真的角色卡和预设脚本）：
  - 尘世命轨：ZOD / 成就系统 / 小手机都在运行，成就面板和小手机能打开；用它真实的变量结构跑一轮更新——合法的 `_.set` 和 JSONPatch 生效，把数字字段设成文字的那条被结构拒掉，结果里没有 `display_data` / `delta_data`（和真 MVU + zod 一致）
  - 三体（终端手机能打开）、大乾风华录、我真没想重生啊（带镜像回退的 MVU 加载脚本被认出、不单独运行）、木屋求生、人妻牛、重生2008、绮梦：脚本全部在运行、无报错
  - 高级文本格式：脚本把楼层里的 `§` 控制符渲染成了样式（它直接改 `.mes_text`，页面钩子对得上）
  - 真实女友的小手机报语法错误：卡里的脚本源码本身坏了（一个字符串中间断了行），在酒馆里也一样跑不了
  - 预设“梦鲸思客V4-0818”的 5 个脚本都在运行，“消息处理”把 24 条消息合并成 3 条后发出（system / user / assistant），设置界面出现在脚本面板里
  - 以上是“在运行、不报错、点开能出界面”这个层面；每个脚本里面的每项功能没有逐一点过。这台服务器只有 2 核 2G，无头浏览器开着重卡片会把负载顶到 20 以上（踩过一次），实测要一张卡一张卡来、用新聊天、关图片
- 2026-10-10 入口整理（右栏 11 个标签并成 4 组、去重复入口、搜功能）：在 320 / 360 / 390 / 430px 四个宽度下用超长角色名、预设名、模型名检查过顶栏和输入框工具条，没有重叠和溢出；1024px（右栏变抽屉）和 1440px 看过截图
- 这轮真实数据顺带修掉的老问题：Windows 换行（`\r\n`）的卡前端界面识别不出来；单行 ```` ```地点·时间``` ```` 被当成代码块开头、吞掉整段正文塞进 iframe；导入后所有文件时间变成导入时刻（“最近使用”排序失效）；左栏当前聊天条数不更新；提示词预览里预设自定义条目显示成 UUID

## 6. 没覆盖 / 已知限制

- 真实 API 只测过一家 OpenAI 兼容中转（Gemini 模型）；Claude / Gemini 原生格式仍只用假模型测过
- 界面的编辑类面板（预设提示词编辑、世界书条目编辑、正则编辑器、角色编辑、用户设定、导入面板的界面流程）只做过静态检查，没有端到端覆盖
- 不支持：群聊、文本补全（Text Completion）接口、任意第三方酒馆扩展（Persona Weaver、故事神谕、小白X 的任务等，包括卡里 `extensions` 下它们各自存的数据）
- 酒馆助手脚本的边界：
  - 只有角色卡和预设自带的脚本，没有“全局脚本库”（`getScriptTrees({type: 'global'})` 返回空）
  - 页面结构只对齐了 3.5 节列的那几个选择器。脚本去找酒馆页面上别的东西（`#top-bar`、`#completion_prompt_manager`、扩展菜单里的具体按钮、酒馆的弹窗 DOM）会找不到；一般表现为那部分功能没反应，不影响别的
  - 没实现：音频接口、旧版 lorebook 接口（`getLorebookEntries` 一族）、扩展管理、`importRaw*`、`getModelList`、`generate` 的 `tools` / `json_schema` / 图片输入。`registerMacroLike` 只登记不生效
  - 酒馆的事件只发其中一部分（消息增删改、生成开始 / 结束 / 停止、聊天切换、预设切换、渲染完成、`CHAT_COMPLETION_PROMPT_READY`、`CHAT_COMPLETION_SETTINGS_READY`、`GENERATION_AFTER_COMMANDS`、`GENERATE_AFTER_DATA`、`WORLD_INFO_ACTIVATED`、流式 token）；监听别的事件不报错，只是不会触发
  - `generate` 的 `overrides` 只支持角色描述 / 性格 / 场景 / 用户设定 / 示例对话 / `chat_history.prompts`，世界书的两个覆盖只在 `generateRaw` 里生效
  - 斜杠命令仍是子集
- 提示词模板（EJS）实现了常用 API，冷门函数可能缺
- token 数是估算（没有真实分词器）
- 前端卡 iframe 是无同源沙箱（origin 为 null），卡里直接 fetch 第三方图床（如某张卡用的 r2.dev）会被对方的 CORS 拦掉
- 缩略图不支持隔行扫描 PNG 和非 PNG 头像，遇到时自动退回原图
- 只在无头浏览器里看过手机布局（320–430px），没在真机上试
- 搜功能的清单是手写的，只覆盖设置面板里的项和少数几个动作（新聊天、角色库、新建角色），不搜角色、聊天内容

## 7. 建议的下一步

1. 给编辑类面板补端到端用例（预设条目编辑、世界书条目、正则编辑器、角色编辑、用户设定、导入面板）
2. 真机（手机浏览器）看一遍新布局，尤其是输入法弹起时输入框位置、脚本的悬浮窗在手机上的位置
3. 按需补：群聊、文本补全、斜杠命令更多子集
4. 脚本：哪个脚本表现不对就看 设置 › 角色 › 脚本 里它那一行的报错，再对着它的源码补接口或页面钩子；zod / Vue 想离线可用就收进 `vendor/`

## 8. 开发注意

- 无构建：浏览器直接加载 ES 模块，改完刷新即可；改了模块间的导入导出后跑 `node tools/check-imports.mjs`
- `core/` 保持不依赖 DOM，方便在 Node 里测；新逻辑优先放这里并补单测
- 保存是防抖的（`state.js`）：`saveX()` 排队，`flushPending()` 立即写所有待保存项；切换角色/预设/聊天、发请求前都要先 flush，否则防抖回调会读到新状态写错文件
- 在 Windows 的 Git Bash 里用 heredoc/python 改代码时反斜杠会被吞（`\\n` 变成真换行、`'\\'` 变成 `'\'`），含反斜杠的代码用编辑器或 `String.fromCharCode(92)` 之类写法
- 运行数据默认在 `./data`，已在 `.gitignore`，不要提交

## 9. 117 服务器上的常驻服务（2026-10-10）

- 代码 `/opt/lite-tavern/app`，数据 `/opt/lite-tavern/data`（属主 ubuntu）
- **2026-10-10 12:43 起共用模式**：`--st-data /opt/luker/data/admin`，角色卡 / 聊天 / 世界书 / 预设直接用 Luker 那份。服务单元的 `ReadWritePaths` 加了这四个目录（`ProtectSystem=strict` 下不加就是只读，保存会失败）；Luker 的 `settings.json` / `secrets.json` 不在可写范围内。`/opt/lite-tavern/data` 里原来的 characters / chats / worlds / presets 不再使用，留作快照没删
- 上线前备份（`/opt/lite-tavern/`）：`app.bak-20261010-before-share.tgz`、`luker-data.bak-20261010-before-share.tgz`（Luker 四个目录，79 MB）、`lite-tavern.service.bak-20261010`、`settings.bak-20261010-before-api.json`
- 已从 Luker 迁入 9 条连接（sooya、gg、gemini-3.7-flash、new、奶龙、yyz、幻想乡、cat、缥缈）；原「Luker 中转」c_luker01 被认成 cat、后处理 strict。上线时 `/models` 检查：缥缈 522（上游问题），其余 200。Luker 里另有二十来个没挂连接配置的 Key 没迁
- 外网入口：**https://117.72.216.74:8446/**，按用户明确要求不加访问密码。拿到地址的人可以读取 / 修改数据并使用配置好的模型连接
- Node 仍只监听 `127.0.0.1:8730`，nginx 在 8446 提供 HTTPS 反向代理；`/api/llm/` 关闭响应缓冲、请求缓冲和 gzip，超时 3600 秒，保证长回复流式返回
- 常驻 systemd 单元 `lite-tavern.service`，已开机自启；用户 ubuntu，`Restart=on-failure`、MemoryMax=320M、`ProtectSystem=strict`，仅允许写 `/opt/lite-tavern/data`。旧临时单元 `lite-tavern-test` 已停用
- 现行部署配置已保存到仓库：[`deploy/lite-tavern.service`](deploy/lite-tavern.service) 对应 `/etc/systemd/system/lite-tavern.service`；[`deploy/lite-tavern.nginx.conf`](deploy/lite-tavern.nginx.conf) 对应 `/etc/nginx/sites-available/lite-tavern`，由 `/etc/nginx/sites-enabled/lite-tavern` 链接启用
- 与 Luker 共用 `/opt/luker/acme/config/live/luker-ip/` 的受信任 IP 证书；`luker-ip-cert-renew.timer` 每 8 小时检查续期并重载 nginx
- 连接的 Key 都在 `data/secrets.json`（0600），不在仓库和文档里
- 查看状态：`ssh kaze1 'systemctl status lite-tavern --no-pager'`；查看日志：`ssh kaze1 'journalctl -u lite-tavern -n 100 --no-pager'`
- 更新代码：本地 `tar --exclude=.git --exclude=data -czf - . | ssh kaze1 'tar -xzf - -C /opt/lite-tavern/app'`，再 `ssh kaze1 'systemctl restart lite-tavern'`。更改 nginx 配置后先 `nginx -t`，再重载 nginx
- 也可以让服务器直接从 GitHub 取（仓库是公开的，服务器上没有推送凭据，只能拉）：`git clone --depth 1 -b <分支> https://github.com/sooya7/lite-tavern /tmp/lt-src`，再把 `public server server.mjs package.json README.md docs test tools` 同步到 `/opt/lite-tavern/app` 并重启。2026-10-10 的入口整理就是这样部署的
- 注意仓库和服务器的先后：2026-10-10 上午的 Claude 风格改版只部署到了服务器，当时没有推到 GitHub；入口整理时先把服务器上的 60 个文件原样取回提交（分支 `claude/simplify-navigation` 的第一个提交），再在上面改。本地工作副本如果还停在改版那一步，先拉这个分支再继续，否则下次从本地打包部署会把入口整理覆盖掉
- 本次收尾验证报告和截图：本机 `/tmp/lt-real/public-final-result.json`、`42-public-final-desktop.png`、`43-public-final-dark.png`、`44-public-final-mobile-chat.png`、`45-public-final-mobile-home.png`（临时验证产物，不随仓库提交）
