# 轻酒馆 交接文档

更新：2026-10-10（页面版本 20261010h22；本轮加了服务器代生成，见 3.8 节）

## 1. 项目是什么

一个兼容酒馆（SillyTavern 1.18）数据格式的轻量 AI 角色扮演前端。目标是“轻、快、手机好用”，同时让用户现有的角色卡、对话补全预设、世界书、正则，以及最常用的插件能力（提示词模板 EJS、MVU 变量、酒馆助手式前端卡、角色卡 / 预设自带的酒馆助手脚本）原样可用。

路线选择：没有 fork 酒馆，而是独立实现。原因是酒馆前端自身就有约 200 个模块、5.8 MB JS，扩展直接依赖它的内部模块和 DOM，砍不轻；而独立实现时，数据格式与酒馆双向兼容，不支持的功能可以回酒馆打开同一份数据。代价是任意第三方扩展跑不了，只能把常用能力原生实现。酒馆助手脚本是个例外：它本来就是跑在 iframe 里、通过一套公开接口和酒馆打交道的，所以这里实现了那套接口，脚本本身原样运行（第 3.5 节）。

## 2. 目录结构

```
server.mjs              入口：参数解析、路由、静态文件、登录
server/
  http.mjs              Router、读写 body、静态文件（带 ETag）
  store.mjs             数据目录读写：角色卡 PNG、聊天 JSONL、预设/世界书 JSON、设置、密钥、备份、回收站
  proxy.mjs             LLM 代理：浏览器只发 {path, body}，服务端补地址和密钥后转发，流式原样回传（openUpstream 也给代生成用）
  gen-jobs.mjs          服务器代生成的任务表：起任务请求上游、带 seq 的事件缓存与 SSE 续传、取消 / 认领 / 确认、宽限期到点代写（3.8 节）
  gen-persist.mjs       服务器代写回复：用 public/js/core 同一套代码建会话、收尾、算变量，写进聊天文件
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
    mvu-extra.js        额外模型解析：设置默认值、世界书筛选、请求组装、请求策略、增量校正、角色卡覆盖（纯函数）
    mvu-cleanup.js      楼层变量的自动清理 / 恢复 / 快照 / 重演 / 聊天变量同步（纯函数）
    scripts.js          脚本库的数据结构：规范化、展开文件夹、哪些该运行、MVU 加载脚本的识别
    thformat.js         酒馆助手接口用的世界书 / 预设 / 正则结构 ↔ 酒馆文件格式
    llm.js              读模型回复、按设置重试（GenError / readLlmResponse / generateWithRetry），页面和服务器代生成共用
    reply.js            一条回复的收尾：放占位、拆思维链、永久正则、写回楼层、变量更新；代生成时找回写入位置（locateReply）
    mvu-request.js      额外模型解析的请求（原来在 generate.js，挪过来给服务器代写用），浏览器相关的东西经 env 传入
  js/                   应用层
    api.js state.js controller.js generate.js app.js
    mvu-ops.js          MVU 修复按钮、增量校正、角色卡覆盖的保存、通知、删楼层后恢复变量（见 3.5 节“MVU 面板”）
    chatops.js          给前端卡和脚本共用的楼层读写、斜杠命令子集
    genjob.js           服务器代生成的前端一侧：开任务、收流（断线按 seq 续上）、停止、认领、找回任务
  js/ui/                界面
    dom.js render.js frontend.js chat.js sidebar.js library.js avatars.js importers.js form.js
    scripts.js          脚本宿主：起停脚本 iframe、收拾脚本留在页面上的东西、脚本按钮、脚本的设置界面
    script-api.js       酒馆助手接口的实现（脚本 iframe 里的全局函数、window.TavernHelper / SillyTavern / Mvu）
    panels/ index nav search connection preset char world regex scripts persona note vars inspector settings import
test/core.test.mjs      核心单元测试（21 项）
test/mvu-extra.test.mjs, test/mvu-panel.test.mjs  MVU 额外模型解析、面板对齐原版的部分
test/gen-jobs.test.mjs  服务器代生成：断开不中断、seq 续传、取消、确认 / 不重复写、同一聊天的保护、代写的回复和变量与页面算的一致
tools/
  e2e.py                Playwright 端到端测试
  mock-llm.mjs          假模型服务（OpenAI / Claude / Gemini，可模拟 429、错误正文、空回复、慢速；流式没发完被断开时计数 ABORTED）
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
- 卡片 / 预设自己排过版的内容不加装饰（2026-10-10 晚，起因是用户对比 Luker 截图觉得“左边更顺眼”）：消息里带 `style` 或 `class` 的 `<details>` 原样显示，只有光秃秃的 `<details>` 才给灰底圆角；前端卡 iframe 不加圆角。以后给 `.mes_text` 里的元素加默认样式时，先想清楚会不会盖到卡片自带的排版上
- 输入区（2026-10-10 晚用户定的，之前试过“空着时收成一行”，用户要求保持展开）：上半区是输入框 + 发送键（`.composer-row`），下半区是 ＋、预设、连接（`.composer-bar`），所有宽度都一样。滚动按钮只在往回翻的时候出现（往下读、生成时跟着滚到底都不显示，不挡正文），窄屏靠右，离底部的距离跟着输入区实际高度走（`--composer-h`，`initScrollTracking` 里用 ResizeObserver 设）
- 正文排版（2026-10-10 晚，用户对比 Luker 截图后定的）：**全站无衬线**（`--font`，中文字体排最前；上午那次“全站统一衬线”已作废，`--font-read` 现在等于 `--font`）；正文行距 1.62、段间距 1.4em（差不多空一整行）；角色正文颜色 `--read`（比纯黑柔），对话 `<q>` 用 `--quote`（柔和的蓝）。窄屏（≤760px）聊天页是“纸面”布局：`.chat-scroll` 用深一点的 `--backdrop`，正文放在 `--paper` 色的 `.chat` 上，两侧各露 7px 底色、文字离屏幕边 26px——起因是用户说“从左到右都铺满了，看着很累”。首页（`.center.home`）不套这层
- 头像：列表、消息、顶栏都用 `api.thumbUrl()` 的缩略图（`?thumb=1&v=<mtime>`，带版本号时浏览器长期缓存）；导出卡和角色编辑仍是原图

## 3. 关键数据流

**发送一条消息**（`generate.js` → `generate()`）：
1. 先占住 `state.generating`（防连点），`flushPending()` 把待保存的设置写盘（代理从 `settings.json` 读连接配置，不写盘会用旧地址）
2. `addUserMessage` → 永久正则 → 宏替换 → 入聊天
3. `ChatSession.preparePrompt()`：楼层正则（带深度）→ 世界书（EJS 预处理 → 激活）→ `buildChatCompletion` 按预设顺序组装 → EJS 对每条消息求值
4. `buildRequest` 按接口类型拼请求体 → 普通生成 / 重刷 / 继续写交给服务器代生成（`/api/gen`，3.8 节），页面订阅它的 SSE，流式写入 `m.mes` 并重绘；代我写、静默生成、旧服务端仍是浏览器经 `/api/llm/:conn` 代理直接请求
   - 组提示词前发 `GENERATION_AFTER_COMMANDS` / `GENERATION_STARTED`，把脚本 `injectPrompts` 注入的内容并进扩展提示词；拼请求体前发 `CHAT_COMPLETION_SETTINGS_READY`，监听者可以原地改 `messages` 和采样参数（预设脚本靠它合并消息、加前缀）
5. 失败按设置重试（429/5xx/网络错误/错误当正文/空回复；代生成时由服务器重试，判断规则在 `core/llm.js`，两边一样）；中途停止保留已生成部分；失败回滚占位（重新生成会恢复被删的旧回复）
6. 收尾（`generate.js` 的 `completeReply`，步骤本身在 `core/reply.js`）：拆 `<think>` 思维链 → 永久正则 → 同步 swipe → 额外模型解析（开着时）→ MVU 基于上一层变量应用本条更新（有脚本监听 MVU 事件时边更新边发事件，见 3.5）→ 卡里有正则用到 `<StatusPlaceHolderImpl/>` 时把它补到正文末尾 → 自动清理 → 保存（代生成时带任务号保存 = 确认）→ 广播事件给前端卡

**显示一条消息**（`ui/chat.js` → `fillMessage`）：`session.displayText()`（仅显示正则 + EJS 渲染）→ `formatMessage()`（引号高亮、showdown、DOMPurify、`<style>` 作用域化）→ 代码块里的完整 HTML 文档挂成沙箱 iframe（`ui/frontend.js`）。

**前端卡**：iframe 是 `sandbox` 无同源。读接口（`getAllVariables`、`getChatMessages`、`Mvu.getMvuData` 等）用宿主注入的快照同步返回；写接口（`createChatMessages`、`setChatMessages`、`triggerSlash`、`replaceVariables`、`generate` / `generateRaw`）走 postMessage RPC，由 `chatops.js` / `generate.js` 里的函数执行。斜杠命令只支持一个子集（见 `chatops.js` 的 `triggerSlash`）。前端卡 `eventEmit` 的事件会同时发给脚本，脚本 `eventEmit` 的自定义事件也会转给前端卡。

### 聊天和角色卡的流量（2026-10-10）

- 保存聊天只传改动：`PATCH /api/chats/:char/:name`，体为 `{baseCount, count, set: {行号: 整行}, edit: {行号: 字段级操作}}`，带 `X-Expect` 版本号。前端拿上次读 / 写时的各行（`chat.base`）对比，新楼层整行、改过的楼层按字段（`core/jsondiff.js`，参照 Luker 的 JSON Patch 做法）。服务端行数对不上回 409 `patch-base`，前端自动退回整份 `PUT`
- 下载走本机缓存：聊天和角色卡存在浏览器 IndexedDB（`lt-cache`，最多 12 个），请求带 `If-None-Match`，没变就 304 用本机那份；保存后同步更新缓存
- Luker 对比：它上传也是按字段打补丁（还带 `test` 守卫），但打开聊天每次整份下载，没有缓存

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
- **变量单独更新 / MVU 面板**（2026-10-10 第二轮：对齐 MagVarUpdate 原版面板）。设置在 设置 › 本聊天 › 变量，全部存在 `settings.power` 里、对所有聊天生效（默认值见 `core/mvu-extra.js` 的 `MVU_DEFAULTS`）。照原版顺序直接摊开成卡片：通知设置 → 变量更新方式 → 修复按钮 → 自动清理变量 → 兼容性 → 角色卡覆盖；只有看变量内容的三栏（角色状态 / 本聊天变量 / 全局变量）默认折叠。没打开聊天时设置卡片也显示（修复按钮和角色卡覆盖不可用）
  - 变量更新方式：随 AI 输出 / 额外模型解析（`mvuSeparate`）。选额外模型解析（或角色卡覆盖成它）时才出现四个小标题：
    - 请求内容 `mvuPromptMode`：`builtin` 内置 / `preset` 使用当前预设 / `other` 使用其他预设（`mvuOtherPreset`）。内置的顺序照原版“内置破限”但**不带任何破限头尾**：开头提示词 `mvuHeadPrompt` → `<additional_information>` 用户设定、角色描述、世界书前 / 后（再加上预设里教写更新块的提示词，正文那边删掉了）`</additional_information>` → `<past_observe>` 前 `mvuHistory` 楼 + 本楼 `</past_observe>` → 剧情发生前的变量（`<previous_variables>`）→ 任务说明（`buildTask`，自己写的中性措辞，标签 `<variable_update_task>`）→ 结尾提示词 `mvuTailPrompt` → 一句用户消息。开头 / 结尾默认空。用预设时（`buildMvuRequest` 里 `preparePrompt({mvuPhase: 'update', presetOverride})`）任务在深度 0、`<past_observe>` / `</past_observe>` 在深度 2 / 1（`presetTaskInjects`），采样参数用那份预设的。原版“使用其他预设”是把预设拆成 ordered_prompts + 注入；这里直接用那份预设整套组提示词，效果相同
    - 世界书筛选（`filterUpdateBooks`，原版 filterEntries 额外分析阶段）：只带 `[mvu_plot]` 的不给变量更新；不带标签的两边都给；`[mvu_update]` 只给变量更新（正文那边 `filterPlotBooks` 去掉，另外仍按内容识别去掉 `isMvuUpdateRule` 的条目）。角色主世界书有标签时，全局 / 聊天 / 用户世界书里没标签的整本不给变量更新，面板上提示“未适配”（`unsupportedWorlds`）。白名单 / 黑名单正则 `mvuWhitelist` / `mvuBlacklist`（`/源码/标志` 或直接写 `a|b`，`compileEntryRegex`），和角色卡的叠加：白名单任一命中保留，黑名单任一命中去掉，`[mvu_update]` 条目不受影响；无效正则提示后忽略。上次被筛掉的条目存在 `state.mvuLastFilter`，“上次分析被筛选的条目”按钮弹表格。**和原版不同**：原版角色卡没适配时整个不做额外模型解析，这里照做（黑白名单也生效）
    - 请求策略：`mvuRequestMode` seq 依次请求失败后重试 / parallel 同时请求多次 / once-then-parallel 先一次再同时，`mvuRequestCount`（`runWithStrategy`；解析不出更新也算失败；手动停止不再重试；同时请求时其余的中止）。`mvuAuto` 自动请求：关了 AI 回复后不请求（楼层照常从上一楼抄变量），需要时点“重试额外模型解析”
    - 模型来源 `mvuConnection` / `mvuModel`（获取模型列表）、结构化输出 `mvuSchema`（接口 4xx 退回文本）
    - 高级参数 `mvuMaxTokens mvuTemperature mvuFreqPenalty mvuPresPenalty mvuTopP mvuTopK`，留空 = 默认（内置时温度 ≤0.3、回复上限 ≥2048，其余跟预设）；填了的经 `applyAdvancedParams` 进 `buildRequest`，三家接口各自换算
  - 请求流程：`generate.js` 的 `buildMvuRequest`（拼消息）→ `requestVarUpdate`（按策略请求，可传 `validate`、自定义任务）→ `writeUpdateBlock`（写回正文末尾、状态栏占位符之前）→ `applyMvuAsync`。正文自己写了更新块时不请求；被中途停止的回复不更新
  - 修复按钮（`mvu-ops.js`）：重新处理变量（最后一楼按上一楼重算）、重新读取初始变量（`mergeInitVars`：[initvar] 补新字段、更新描述，写到最后一楼）、快照楼层、重演楼层（`replayRange`）、重试额外模型解析（任选一楼，默认最后一条回复）、增量校正额外模型解析、清除旧楼层变量（`clearOldFloors`）。原版把其中 4 个当“老旧功能”藏起来，这里都显示
  - 增量校正（最后一楼）：可选方向 → 以现在的变量为准请求（任务 `buildRepairTask`，标签 `<variable_repair_task>`，历史里保留原更新块）→ 每次尝试在副本上试算，出错或没变化算失败 → 预览变化（`planRepair`：校正块作为新的 `<UpdateVariable>` 放在原更新块后面，再从上一楼整楼重算）→ 确认后写正文和变量 → 提示条带“撤销”（`toast` 第 4 个参数 `{action}`）。等待期间聊天 / 楼层 / 回复版本 / 正文 / 变量变了就作废；撤销前也检查没被再改过
  - 通知（`mvuNotify*`）：加载成功（打开第一个 MVU 聊天时一次）、初始化成功（新聊天）、更新出错（默认关，和原版一样；“变量更新有 N 处没执行”现在受它控制）、额外模型解析中（请求 / 重试进度）。请求失败的提示不受开关影响
  - 自动清理（`core/mvu-cleanup.js`，原版 function/cleanup）：`mvuCleanup` 默认开，收到回复后在聊天楼层数是 5 的倍数时清理 `mvuKeepRecent` 楼以前的变量，楼层号是 `mvuSnapshotInterval` 倍数的留作快照（`snapshot: true`）；去掉的只有 `initialized_lorebooks stat_data display_data delta_data schema`，脚本自己存的变量不动。删楼层后 2 秒（`initMvuOps` 里的监听）检查最近 `mvuRestoreRecent` 楼，缺变量就从保留范围之前最近的快照重算补回（`restoreVariables`，只算 AI 回复楼层）
  - 兼容性 `mvuChatVars`：最新楼层的变量同时抄到 `chat_metadata.variables`（`mirrorToChatVars`）；关着时打开聊天会把聊天变量里这几项去掉（原版 checkAndRemoveChatVariables）
  - 角色卡覆盖：和原版同一个位置——角色主世界书（绑定的世界书文件，没绑定就是卡里内嵌的 character_book）里一个**关闭的** `[config_override]` 条目，内容是 JSON（`更新方式`、`额外模型解析配置.启用自动请求 / 世界书条目白名单正则 / 世界书条目黑名单正则`、`兼容性.更新到聊天变量`，schema 放最后，未知字段原样保留）。读：`ChatSession.mvuOverride()`，合并后的设置 `mvuSettings()`（`applyOverride`），所有生效判断都用它；写：`mvu-ops.js` 的 `writeOverride`（存世界书或角色卡）。被覆盖的设置旁边有“角色卡覆盖：值”的标记，黑白名单显示“角色卡规则叠加”。原版的 sendas 一项轻酒馆没有对应功能，读写时原样保留
  - 搜功能清单里每项都加了条目；额外模型解析专属的项给了退路（找不到就定位到“变量更新方式”）
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

## 3.7 酒馆第三方插件（2026-10-10，首个目标：柚月の记忆 yuzuki-Memory）

- 服务端：`--extensions-dir`（默认 `data/extensions`）下每个带 `manifest.json` 的子目录是一个插件，按酒馆的 URL `/scripts/extensions/third-party/<目录>/...` 提供（需登录）。117 上直接指向 Luker 的 `/opt/luker/extensions`（只读），两边插件版本一致。
- 兼容接口在 `server/st-compat.mjs`：`/api/extensions`（列表）、`/api/backends/chat-completions/generate|status`（带 `reverse_proxy` 就转发到那个 OpenAI 兼容地址，`proxy_password` 当 Bearer；不带就借轻酒馆当前连接；Gemini 原生 `makersuite` 暂不支持，返回 400，柚月会自动降级到 OpenAI 协议）、`/api/settings/get`（最小的酒馆设置，不含密钥）、`/api/worldinfo/get|edit`、`/api/vector/list|insert|delete|purge|query-multi`（向量存在轻酒馆自己的 `data/vectors/`，JSON 文件 + 余弦相似度）、`/csrf-token`。这些路径不要求 `X-LT-Client` 版本头。
- 前端：`public/js/ui/extensions.js` 是加载器（设置 › 通用 › 酒馆插件 的开关存在 `settings.thirdParty[目录名]`，刷新后生效）；启动后后台 `import()` 插件入口，先引入本地的 Font Awesome 6（`public/vendor/fontawesome`；CSS 在仓库里，字体用 `node tools/fetch-fontawesome.mjs` 下载，默认走 npmmirror）。`public/script.js`、`public/scripts/extensions.js`、`public/scripts/world-info.js`、`public/scripts/macros/macro-system.js`、`public/st-context.js` 是酒馆同名模块的兼容实现，插件按相对路径 import 会落到这里。宏系统注册接到 `core/macros.js` 的 `macroEngine`。
- `manifest.generate_interceptor`：`generate.js` 在组装提示词前调用（`runGenerateInterceptors`），拿到去掉隐藏楼的聊天副本，改动通过 `preparePrompt({chatOverride})` 只影响这次请求。
- 插件放进 `#extensionsMenu`（酒馆的魔棒菜单）的入口，轻酒馆列在输入框 + 菜单里，点击时同时发 Enter 键和 click 给原元素。
- `SillyTavern.getContext()` 补了 `loadWorldInfo/saveWorldInfo/setExtensionPrompt/extensionPrompts/isGenerating`，`chatMetadata` 会在聊天头里建好 `chat_metadata` 再给出去（插件写入能随聊天保存，共用模式下和 Luker 看到同一份柚月记忆）。
- 已验证（本地无头浏览器）：柚月 1.0.8 的 30 个模块全部加载无报错、记忆窗口打开、插件自己的 API（流式/非流式）与借主连接都通、正常发消息不受影响。没测：真实长聊天上的自动总结/填表全过程、向量化全流程、手机触屏布局。

## 3.8 服务器代生成（2026-10-10，页面版本 h22）

起因：iPhone 上的 PWA 切到后台 / 锁屏 / 关掉页面，浏览器里的请求会被掐掉，回复生成一半就没了。思路照 Luker（`src/endpoints/backends/luker-generation.js`、`src/ws-delivery.js`、`src/endpoints/generation-control.js`）：**生成由服务器请求上游，页面只是看**。

**流程**
1. `generate()` 组好请求体后（脚本的 `GENERATE_AFTER_DATA` / `CHAT_COMPLETION_SETTINGS_READY` 都已经改过），先把刚加的用户消息落盘，再 `POST /api/gen`：`{id, conn, request: {path, method, body, stream}, chat: {char, file, name}, target, preset, started, provider, model, tzOffset}`。`target` = `{type: normal|swipe|continue, index, swipeId?, baseText?, anchor, replace?}`：`anchor` 是写入位置前一条的指纹（谁说的 + 发送时间，`core/reply.js` 的 `messageFingerprint`），`replace` 是“重新生成”时被替换的旧回复的指纹（它还在文件里）。本地占位的 `extra.lt_job` 记着任务号（生成途中聊天被保存过的话，服务器靠它认出占位）
2. 服务器（`server/gen-jobs.mjs`）起任务去请求上游，按设置重试。**客户端断开不 abort**，只有 `POST /api/gen/:id/abort` 才断开上游。事件带递增 `seq` 存在内存：`delta`（增量 `t` / `r`，攒 40ms 一批）、`reset`（重试，从头再来）、`status`、`done`（全文）、`error`、`cancelled`、`persisting`、`persisted`、`persist_failed`。任务保留 2 小时
3. 页面 `GET /api/gen/:id/events?after=<已收到的最后一个 seq>`（SSE，每 10 秒一个心跳注释）。断了自动重连只补发后面的，不丢不重；25 秒没收到任何字节就当连接死了重连；`visibilitychange` 回到前台、`online`、`pageshow` 时立即重连（`genjob.js` 的 `kickStreams`）。流结束时一定断开连接（浏览器同站只有 6 个连接，留着不关会把保存请求堵住——踩过）；服务器在任务到头时也主动断开订阅
4. 收到 `done`：页面先 `POST /claim`（宽限期从现在重新算），收尾期间每 5 秒再认领一次（额外模型解析可能要十几秒），然后照常走前端收尾，**带 `X-LT-Gen-Job` 头保存聊天 = 确认**（`state.js` 的 `saveChatForJob`）。确认和保存是同一个请求，在聊天的写入锁里（`store.withChatLock`）先核对任务状态再写，所以不会出现页面和服务器都写
5. 宽限期（默认 15 秒，`--gen-grace <毫秒>` 或 `LT_GEN_GRACE_MS`；`/api/ping` 的 `genGraceMs`）内没确认：服务器 `persistReply`（`server/gen-persist.mjs`）自己写进聊天文件，用的是 `public/js/core` 同一套代码：`buildServerSession` 按页面规则读设置、角色卡、预设、用户设定、相关世界书（`core/reply.js` 的 `relevantWorldNames` / `personaOf`，页面的 `loadRelevantWorlds` / `activePersona` 也改用它们）→ `locateReply` 找位置 → `placeLocated` 放占位 → 拆思维链（`separateReasoning`）→ `finalizeReply`（永久正则、正文、时间按页面时区、extra、swipe）→ 额外模型解析（`core/mvu-request.js`，同样的开关 / 请求内容模式 / 请求策略 / 高级参数 / 连接选择，角色卡 `[config_override]` 覆盖经 `session.mvuSettings()` 生效）→ `applyReplyVars`（随 AI 输出解析、写进这一楼这个 swipe 的 `variables`、状态栏占位符、同步到聊天变量、自动清理）。写之前在写入锁里核对版本：算的过程中聊天被写过就读最新的，把算好的这一楼放进去
6. 服务器写的楼层打标记 `extra.lt_server_persisted = {job, type, at, pending: true, mvu, reasoning?, orphan?, warnings?}`（swipe 的话也在那个 swipe 的 `swipe_info[].extra` 里）。页面下次打开这个聊天（`CHAT_CHANGED` 后等脚本对齐好）由 `replayServerReplies` 补发：MVU 开着时发 `mag_variable_update_ended`（参数是这一楼存好的变量和上一楼的变量，监听者原地改了照常保存）和 `_for_zod`，然后 `stream_reasoning_done`（有思维链时）、`MESSAGE_RECEIVED`，前端卡收到 `message_received` / `js_generation_ended` / `mag_variable_update_ended`。**不重新解析变量**。补发后 `pending` 改成 false，标记留着
7. 找回：打开聊天、回到前台、网络恢复时 `GET /api/gen/active?char=&chat=`（`resumeActiveJobs`）。有生成中 / 等确认 / 服务器写失败的任务：按 `target` 在本地聊天里放好占位，从 seq 0 收流，收齐后照常由页面收尾（刷新页面也能接回来）；服务器正在写：等它写完载入；服务器刚写完而本地是旧的：重新载入。页面带任务号保存时服务器已经写过（或别的窗口已经确认过）返回 409 `gen-persisted`，页面丢掉本地占位、载入服务器那份
8. 停止：页面断开 SSE 并 `POST /abort`，保留本地已显示的部分（行为和以前一样）；已经收齐的任务被停止时也不再由服务器写。被别的窗口停掉的任务当作停止

**写入位置**（`locateReply`）：先找带任务号的占位；否则核对 `anchor`，normal 要求文件正好 `index` 条（或 `index + 1` 条且最后一条是 `replace`）、swipe 要求那一楼的 swipe 数等于 `swipeId`、continue 要求那一楼的正文还是 `baseText`。对不上（别处删改过楼层）就把回复作为新的一条加到末尾并标 `orphan`，宁可多一条也不丢

**保护**：同一个聊天已有 running / awaiting_ack / persisting 的任务时再开新的回 409 `gen-busy`（页面提示后接过去显示那个任务）；任务号重复回 409。服务器重启丢掉内存里的任务：页面的流 / 认领收到 404，提示“服务器上找不到这次生成了”，已经显示的部分按停止处理保留，没有内容就回滚占位

**部署时**：nginx 不用改——`/api/gen/` 走 `location /`，那里已经 `proxy_buffering off`、读超时 600 秒（心跳 10 秒一次），`text/event-stream` 不在 gzip 列表里；服务端也带了 `X-Accel-Buffering: no`。宽限期要改就在 systemd 单元的启动参数加 `--gen-grace`。任务在内存里，`systemctl restart` 会丢掉进行中的任务（页面会提示并保留已显示的部分）

**和 Luker 的差别**
- 推送用 SSE 不用 WebSocket：只有服务器往页面推，SSE 自带重连语义，nginx 的 `/api/` 已按流式配置；seq 续传、心跳和 Luker 的 ws-delivery 一样
- 确认 = 带任务号的那次保存（同一个请求、同一把写入锁），Luker 是保存后另外确认 / 按聊天找任务确认
- 收尾期间页面会续期（认领心跳），宽限期从“最后一次认领”算；Luker 是从完成时算的固定 15 秒
- Luker 代写只写正文；这里连永久正则、思维链拆分、MVU 变量（含额外模型解析）一起在服务器算好，并标记让页面补发脚本事件
- 找回接口：Luker `GET /api/generation/active?avatar_url&file_name`，这里 `GET /api/gen/active?char&chat`；显式取消 `POST /api/gen/:id/abort`（Luker `/api/generation/:id/abort`）

**服务器上跑不了的**（只在浏览器里才有的东西，服务器代写时缺）
- 酒馆助手脚本和前端卡本身：事件只能事后补发。监听 MVU 过程事件的脚本（`mag_command_parsed`、`_for_zod` 的命令校验，即变量结构 / zod 脚本）在服务器代写时不参与：**不合结构的命令不会被拒**，`display_data` / `delta_data` 会先留着，补发 `mag_variable_update_ended_for_zod` 时由结构脚本去掉
- 脚本在 `mag_before_message_update` 里改正文、在 `MESSAGE_RECEIVED` 里改楼层：补发时才发生（变量不重算）
- 额外模型解析的请求里：脚本 `injectPrompts` 注入的提示词、`registerMacroLike` 的助手宏、`CHAT_COMPLETION_SETTINGS_READY` 对变量更新请求的修改，服务器上都没有（正文请求是页面组好的，不受影响）
- 提示词模板（EJS）里 `SillyTavern.getContext()`、`toastr` 在服务器上没有（给了 lodash 的 `_`）；用到它们的世界书条目在额外模型解析的请求里会求值失败、按原文处理
- 代我写、静默生成、脚本自己的 `generate` / `generateRaw` 不写聊天，仍由浏览器直接请求（切后台会断）
- 同一个聊天在两个窗口都开着时，两个窗口都会接着显示并各自收尾（额外模型解析会请求两次），先保存的算数，后保存的载入它

## 4. 数据与兼容约定

- 数据目录结构与酒馆对应：`characters/*.png`、`chats/<角色>/*.jsonl`、`presets/*.json`、`worlds/*.json`、`avatars/`；另有 `settings.json`、`secrets.json`、`backups/`、`trash/`
- 聊天 JSONL：第一行元数据，之后每行一条消息；未知字段原样保留。`mes` 永远是当前显示版本，`swipes[swipe_id]` 只在切换/生成结束时同步（与酒馆一致，别改成反过来，之前因此出过流式不显示的 bug）
- MVU：每层 `variables[swipe_id] = {stat_data, display_data, delta_data}`；`[initvar]` 条目即使禁用也读取
- 删除一律移到 `trash/`，聊天和世界书保存时定期备份到 `backups/`
- 密钥只在 `secrets.json`，`/api/secrets` 只返回掩码；从酒馆导入预设时会去掉 `proxy_password` / `reverse_proxy`

## 5. 当前状态（已验证的部分）

- 2026-10-10 服务器代生成（h22）：单测 45/45（新增 `test/gen-jobs.test.mjs` 7 项）；端到端 42/42（新增 6 项：页面在线时由页面收尾、断网后按 seq 续传不丢不重字、生成中关掉页面后服务器写完回复和随 AI 输出的变量并在重开后补发事件、页面在线 / 停止时服务器不再写、额外模型解析的变量由服务器算好、刷新页面后接回生成中的任务；“中途停止”还检查了上游确实被断开）。端到端里关页面的两项要等宽限期，各约 28 秒。**只在本地测过，没有部署到 117**；真机 iPhone 后台 / 锁屏没试过

- `npm test`：38 项（含 `test/mvu-extra.test.mjs` 变量单独更新、`test/mvu-panel.test.mjs` 黑白名单正则 / 世界书筛选 / 请求组装 / 请求策略 / 自动清理与恢复 / 增量校正合并 / 角色卡覆盖）。原 21 项核心单元测试全过（宏、正则、世界书、EJS、MVU、变量、提示词组装、接口格式、PNG/JSONL 往返、前端卡识别、缩略图、设置面板结构与搜索清单；脚本库的规范化与起停判断、MVU 事件流程与不发事件的路径结果一致、状态栏占位符、酒馆助手数据格式来回转换、导入角色卡时世界书和脚本的去向）
- 2026-10-10 共用模式：单测 24/24、端到端 31/31（含共用导入、聊天冲突三种选法、预设冲突、旧页面拦截）；Luker 真实数据只读体检通过（角色卡 25、世界书 33、预设 6、聊天 22 存回去不丢字段）。**Luker 界面里的冲突提示没在真界面演练过**
- 跑端到端：沙箱 / 有 HTTP 代理的环境要设 `NO_PROXY=127.0.0.1,localhost`（否则 `mock()` 的 urllib 走代理 404）；下载不了 Playwright 的 Chromium 时设 `LT_CHROMIUM=/usr/bin/chromium` 用系统浏览器
- 端到端（无头 Chromium + 假模型）连共用实例 36/36 通过（2026-10-10 第二轮新增 4 项：请求策略失败后重试与通知开关、关掉自动请求后手动重试、增量校正的预览 / 应用 / 撤销、角色卡覆盖存进世界书；“变量单独更新”那项还检查了设置卡片的顺序和内置请求内容的顺序，并截 `/tmp/lt-shots/vars-mvu-ai.png`、`vars-mvu-extra.png`。假模型按请求里的 `variable_update_task` / `variable_repair_task` 认出变量更新请求，关键字 NOSCHEMA / BADONCE 见 `tools/mock-llm.mjs`）。沙箱里新版 playwright 浏览器下不下来时用 `pip install playwright==1.47.0` 再 `playwright install chromium`。共用实例的 `LT_SHARED_OWN` 必须就是它的 `--data` 目录，否则备份用例会误报。原来 26/26，含“中途停止”、设置面板 4 组 12 区逐个打开、搜索清单逐项定位、各菜单的条目、手机上顶栏文字和预设切换；脚本 5 项：导入带脚本的卡后世界书 / 正则 / 脚本自动就位并运行、MVU 事件和变量结构、脚本按钮与脚本变量、脚本自己调模型、面板开关与停掉后的清理、换角色 / 换预设跟着起停、预设脚本改请求和注入提示词、脚本的设置界面、刷新后恢复。注意每次跑前要重启 `mock-llm.mjs`：429 / 错误正文用例是“每个进程只触发一次”，复用旧进程会误报“没有重试”
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
- 酒馆助手脚本的边界（2026-10-10 补齐后）：
  - 已有：全局脚本库（存在 `settings.scripts.global`，设置 › 角色 › 脚本 里导入 / 开关 / 删除；导入的默认关着）、音频（`ui/audio.js`，播放列表和设置存在 `settings.audio`，手机被拦时下次点屏幕再放）、助手宏 `registerMacroLike`（提示词发出前和楼层显示时替换）、`getModelList` / `getProxyPresetNames`（代理预设 = 连接）、`generate` 的 `image` / `tools` / `tool_choice` / `json_schema` / `custom_api.proxy_preset`（三家接口各自换算，见 `core/providers.js` 的 `add*Extras`；用到工具或结构化输出时不走流式）、旧版世界书 `getLorebook*` 一族（字段换算照酒馆助手源码）、用户设定 `getPersona*` 一族、`createCharacter / createOrReplaceCharacter / deleteCharacter`、`importRaw*`、扩展管理（服务端 `/api/extensions/install|update|delete|version` 用 git，插件目录只读时报 403）。这一批在 `ui/script-api-more.js`
  - 前端卡 iframe 里的接口是子集，其余能跨窗口复制参数的接口经 `rpc('helper', 名字, 参数)` 转给页面上的完整实现（返回 Promise）；要传函数的（`xxxWith`、`registerMacroLike`）在前端卡里没有
  - 事件：在原来那些之外补发 `settings_updated`、`chatcompletion_model_changed`、`chatcompletion_source_changed`、`connection_profile_loaded`、`online_status_changed`、`oai_preset_changed_before/after`、`preset_renamed(_before)`、`preset_deleted`、`chat_deleted`、`characterDeleted`、`impersonate_ready`、`message_swipe_deleted`、`character_first_message_selected`、`generate_before/after_combine_prompts`、`worldinfo_scan_done`、`stream_reasoning_done`、`character_page_loaded`、`worldinfo_settings_updated`；脚本发 `worldinfo_force_activate` 会让下一次生成强制激活那些条目。仍不发的：图片 / 生图 / 工具调用渲染 / 密钥 / 群聊 / 设置载入（脚本启动前就过了，和酒馆一样）这类轻酒馆没有对应功能的
  - 斜杠命令补了：音频 6 个、`impersonate stop abort return flushvar flushglobalvar listvar len upper lower trim tokens add sub mul div mod pow max min abs round floor ceil rand input popup confirm buttons delay inject listinjects flushinject model preset go/char persona getchatname closechat bg addswipe delswipe getentryfield setentryfield findentry createentry`。没有：带 `{: :}` 闭包的流程控制（`if`、`while`、`times`、`run`）、快速回复
  - 页面结构只对齐了 3.5 节列的那几个选择器。脚本去找酒馆页面上别的东西（`#top-bar`、`#completion_prompt_manager`、酒馆的弹窗 DOM）会找不到；一般表现为那部分功能没反应，不影响别的
  - `generate` 的 `overrides` 只支持角色描述 / 性格 / 场景 / 用户设定 / 示例对话 / `chat_history.prompts`，世界书的两个覆盖只在 `generateRaw` 里生效
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
- **仓库副本和推送（2026-10-10 傍晚起）**：服务器上有一份正式检出 `/opt/lite-tavern/repo`（root，`main` 跟踪 `origin/main`），推送凭据是用户给的 GitHub 令牌，存在 `/root/.config/lite-tavern/git-credentials`（0600），只经这份检出的本地 `credential.helper` 使用，令牌值不要打印。部署完把运行目录同步进去再提交推送：`rsync -a --no-owner --no-group --exclude='*.bak*' --exclude=node_modules --exclude=public/vendor/fontawesome/webfonts --exclude=.git /opt/lite-tavern/app/ /opt/lite-tavern/repo/`。`app` 目录本身不是 git 仓库。服务器全局 git 配置给 github.com 设了 `socks5://127.0.0.1:8082` 代理，这份检出用本地配置绕开了它（直连）；直连和代理都时通时不通，`git fetch` / `push` 失败就多试几次
- **数据异地备份（2026-10-10 傍晚起）**：`lite-tavern-gdrive-backup.timer` 每天 04:40 左右跑 `/usr/local/sbin/lite-tavern-gdrive-backup.sh`（仓库里的 [`deploy/lite-tavern-gdrive-backup.sh`](deploy/lite-tavern-gdrive-backup.sh) 和同名 `.service` / `.timer`），打一个 `lite-tavern-backup-<UTC 时间>.tar.gz` 传到 Google Drive 的 `SOOYA/lite-tavern-backups/`（rclone 远端 `gdrive`，和 `sooya-gdrive-backup` 同一个账号），传完核对再清理，云端留 30 份、本地 `/opt/lite-tavern/backups-cloud/`（0700）留 3 份
  - 归档里两棵树：`lite-tavern-data/` = `/opt/lite-tavern/data`（设置、`secrets.json`、头像、冲突备份、向量等；不含 `_cache`，共用模式下也不含切换前留下的 `characters` / `chats` / `worlds` / `presets` 旧副本）；`st-data/` = `/opt/luker/data/admin`（角色卡、聊天、世界书、预设、`settings.json`、`secrets.json`、用户设定、快速回复、主题等；不含酒馆自己的滚动备份 `backups`、插件代码 `extensions`、`thumbnails`）。**里面有两边的 Key 和全部聊天**，用户明确同意带上
  - 恢复：从云盘下回来，`tar -xzf <归档> -C <临时目录>`，停掉对应服务后把要的目录拷回原位（注意属主：轻酒馆那份是 ubuntu）。首份归档 108 MB，解开后和线上逐目录比对过一致
  - 这台机器直连不了 Google，走本机 sing-box 出口代理（8082）。上传传不完的主因（2026-10-10 晚用 `rclone -vv` 查到的）：rclone 远端 `gdrive` 用的是 rclone 自带的公共 client_id，Google 对它按分钟限流（`403 Quota exceeded ... project_number:202264815644`）。默认的分块上传里，限流正好卡在最后一块的提交上，重试 10 次不过就整份从头再传，108 MB 的归档传了三遍多都没成。脚本因此加了 `--drive-upload-cutoff 1G`（一次请求传完，限流只发生在开头，重试几次放行后一口气传完；手动验证 6 分半传完，云端大小和本地一致）。`sooya-gdrive-backup` 近几天一半失败多半也是这个原因，它的脚本没动。彻底的办法是给这个远端配自己的 Google API client_id，需要用户自己去 Google Cloud 建，没做
  - 出口代理（2026-10-10 晚按用户要求改过）：原来 129 个节点里 101 个 trojan 节点已失效（连上只回 nginx 欢迎页），`auto` 组的明文 HTTP 测速把它们当成可用，分组每一两分钟被带到失效节点上。现在 `/etc/sooya-github-proxy/config.json` 的分组里只留 28 个能用的 vless 节点，删掉 100 个失效节点的定义（`vertex-residential-kr-lguplus-02` 也不通，只从分组里拿掉、定义保留）；原配置备份在同目录 `config.json.bak-keep28-20261010-1935`。rclone 每一步仍整体重试 40 次、间隔 20 秒。
- 也可以让服务器直接从 GitHub 取（仓库是公开的）：`git clone --depth 1 -b <分支> https://github.com/sooya7/lite-tavern /tmp/lt-src`，再把 `public server server.mjs package.json README.md docs test tools` 同步到 `/opt/lite-tavern/app` 并重启。2026-10-10 的入口整理就是这样部署的
- 注意仓库和服务器的先后：2026-10-10 上午的 Claude 风格改版只部署到了服务器，当时没有推到 GitHub；入口整理时先把服务器上的 60 个文件原样取回提交（分支 `claude/simplify-navigation` 的第一个提交），再在上面改。本地工作副本如果还停在改版那一步，先拉这个分支再继续，否则下次从本地打包部署会把入口整理覆盖掉
- 本次收尾验证报告和截图：本机 `/tmp/lt-real/public-final-result.json`、`42-public-final-desktop.png`、`43-public-final-dark.png`、`44-public-final-mobile-chat.png`、`45-public-final-mobile-home.png`（临时验证产物，不随仓库提交）
