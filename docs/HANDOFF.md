# 轻酒馆 交接文档

更新：2026-10-10

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
  st-import.mjs         从酒馆数据目录检测/扫描/导入（只读源目录，保留原文件修改时间）
  thumb.mjs             头像缩略图：纯 zlib 解码 PNG → 按块平均缩小 → 重新编码（缓存在 data/_cache/thumbs）
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
    dom.js render.js frontend.js chat.js sidebar.js library.js avatars.js importers.js form.js
    panels/ index connection preset char world regex persona note vars inspector settings import
test/core.test.mjs      核心单元测试（14 项）
tools/
  e2e.py                Playwright 端到端测试
  mock-llm.mjs          假模型服务（OpenAI / Claude / Gemini，可模拟 429、错误正文、空回复、慢速）
  fixtures/test-card.json  端到端用测试卡（MVU + 世界书 + 正则 + 前端卡 + EJS）
  check-imports.mjs     前端模块导入导出静态检查
  smoke-real.mjs        用真实酒馆数据组提示词做冒烟（参数：数据目录、卡、预设、聊天）
  st-compat-scan.mjs, st-ejs-scan.mjs  扫描酒馆数据里用到了哪些特性
docs/HANDOFF.md         本文档
```

## 2.5 界面结构（2026-10-10 改成 Claude app 风格）

- 配色：浅色暖白 `#faf9f5` / 侧栏 `#f5f4ed`，深色 `#262624` / `#1f1e1d`，强调色陶土橙 `#c96442`。全部是 `app.css` 顶部的变量，深色在 `:root[data-theme="dark"]`。主题 `auto | light | dark`，默认跟随系统；`index.html` 里有一段内联脚本按 localStorage 先上色，防止刷新闪白
- 左栏（`ui/sidebar.js`）：品牌 → 新聊天 / 角色库 / 从酒馆导入 → 最近角色（收藏优先，最多 6 个）→ 当前角色的聊天记录（默认聊天名显示成日期）→ 底部用户设定
- 首页（`ui/library.js`，`state.view === 'home'` 或没选角色时显示）：问候语、继续上次的聊天、角色库卡片网格（搜索 / 排序）；一张卡都没有时显示上手步骤。首页隐藏输入框
- 消息（`ui/chat.js` 的 `buildMessage`）：用户消息是右侧气泡；角色消息通栏、头部小头像 + 名字。全站（界面 + 正文）统一用 `--font-read` 衬线字体栈，只有代码用等宽。操作按钮（复制 / 编辑 / 重新生成 / 更多）和 swipe 在消息下方一行
- 输入框：大圆角框，下方工具条：`+`（更多操作）、当前预设、当前连接（点开切换）、发送 / 停止
- 右栏（`ui/panels/index.js`）：左侧竖向图标导航 + 标题栏 + 内容，11 个面板一次全显示
- 头像：列表、消息、顶栏都用 `api.thumbUrl()` 的缩略图（`?thumb=1&v=<mtime>`，带版本号时浏览器长期缓存）；导出卡和角色编辑仍是原图

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

- `npm test`：14 项核心单元测试全过（宏、正则、世界书、EJS、MVU、变量、提示词组装、接口格式、PNG/JSONL 往返、前端卡识别、缩略图）
- 端到端（无头 Chromium + 假模型）17/17 通过，含“中途停止”。注意每次跑前要重启 `mock-llm.mjs`：429 / 错误正文用例是“每个进程只触发一次”，复用旧进程会误报“没有重试”
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
- 这轮真实数据顺带修掉的老问题：Windows 换行（`\r\n`）的卡前端界面识别不出来；单行 ```` ```地点·时间``` ```` 被当成代码块开头、吞掉整段正文塞进 iframe；导入后所有文件时间变成导入时刻（“最近使用”排序失效）；左栏当前聊天条数不更新；提示词预览里预设自定义条目显示成 UUID

## 6. 没覆盖 / 已知限制

- 真实 API 只测过一家 OpenAI 兼容中转（Gemini 模型）；Claude / Gemini 原生格式仍只用假模型测过
- 界面的编辑类面板（预设提示词编辑、世界书条目编辑、正则编辑器、角色编辑、用户设定、导入面板的界面流程）只做过静态检查，没有端到端覆盖
- 不支持：群聊、文本补全（Text Completion）接口、酒馆助手脚本库（操作酒馆页面的脚本）、任意第三方酒馆扩展、Persona Weaver、故事神谕
- 提示词模板（EJS）实现了常用 API，冷门函数可能缺
- token 数是估算（没有真实分词器）
- 前端卡 iframe 是无同源沙箱（origin 为 null），卡里直接 fetch 第三方图床（如某张卡用的 r2.dev）会被对方的 CORS 拦掉
- 缩略图不支持隔行扫描 PNG 和非 PNG 头像，遇到时自动退回原图
- 只在无头浏览器 390px 宽度看过手机布局，没在真机上试

## 7. 建议的下一步

1. 给编辑类面板补端到端用例（预设条目编辑、世界书条目、正则编辑器、角色编辑、用户设定、导入面板）
2. 真机（手机浏览器）看一遍新布局，尤其是输入法弹起时输入框位置
3. 按需补：群聊、文本补全、斜杠命令更多子集

## 8. 开发注意

- 无构建：浏览器直接加载 ES 模块，改完刷新即可；改了模块间的导入导出后跑 `node tools/check-imports.mjs`
- `core/` 保持不依赖 DOM，方便在 Node 里测；新逻辑优先放这里并补单测
- 保存是防抖的（`state.js`）：`saveX()` 排队，`flushPending()` 立即写所有待保存项；切换角色/预设/聊天、发请求前都要先 flush，否则防抖回调会读到新状态写错文件
- 在 Windows 的 Git Bash 里用 heredoc/python 改代码时反斜杠会被吞（`\\n` 变成真换行、`'\\'` 变成 `'\'`），含反斜杠的代码用编辑器或 `String.fromCharCode(92)` 之类写法
- 运行数据默认在 `./data`，已在 `.gitignore`，不要提交

## 9. 117 服务器上的常驻服务（2026-10-10）

- 代码 `/opt/lite-tavern/app`，数据 `/opt/lite-tavern/data`（属主 ubuntu），从 `/opt/luker/data/admin` 只读导入
- 外网入口：**https://117.72.216.74:8446/**，按用户明确要求不加访问密码。拿到地址的人可以读取 / 修改数据并使用配置好的模型连接
- Node 仍只监听 `127.0.0.1:8730`，nginx 在 8446 提供 HTTPS 反向代理；`/api/llm/` 关闭响应缓冲、请求缓冲和 gzip，超时 3600 秒，保证长回复流式返回
- 常驻 systemd 单元 `lite-tavern.service`，已开机自启；用户 ubuntu，`Restart=on-failure`、MemoryMax=320M、`ProtectSystem=strict`，仅允许写 `/opt/lite-tavern/data`。旧临时单元 `lite-tavern-test` 已停用
- 现行部署配置已保存到仓库：[`deploy/lite-tavern.service`](deploy/lite-tavern.service) 对应 `/etc/systemd/system/lite-tavern.service`；[`deploy/lite-tavern.nginx.conf`](deploy/lite-tavern.nginx.conf) 对应 `/etc/nginx/sites-available/lite-tavern`，由 `/etc/nginx/sites-enabled/lite-tavern` 链接启用
- 与 Luker 共用 `/opt/luker/acme/config/live/luker-ip/` 的受信任 IP 证书；`luker-ip-cert-renew.timer` 每 8 小时检查续期并重载 nginx
- 连接“Luker 中转”的 Key 从 Luker 的 secrets.json 复制到 `data/secrets.json`（0600），不在仓库和文档里
- 查看状态：`ssh kaze1 'systemctl status lite-tavern --no-pager'`；查看日志：`ssh kaze1 'journalctl -u lite-tavern -n 100 --no-pager'`
- 更新代码：本地 `tar --exclude=.git --exclude=data -czf - . | ssh kaze1 'tar -xzf - -C /opt/lite-tavern/app'`，再 `ssh kaze1 'systemctl restart lite-tavern'`。更改 nginx 配置后先 `nginx -t`，再重载 nginx
- 本次收尾验证报告和截图：本机 `/tmp/lt-real/public-final-result.json`、`42-public-final-desktop.png`、`43-public-final-dark.png`、`44-public-final-mobile-chat.png`、`45-public-final-mobile-home.png`（临时验证产物，不随仓库提交）
