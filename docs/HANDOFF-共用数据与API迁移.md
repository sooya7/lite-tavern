# 交接：与 Luker 共用数据 + 把 Luker 的 API 迁过来

写于 2026-10-10 12:25（北京时间）。上一个会话额度用完，做到一半停下。接手的人从这里继续，做完后把这份文档的内容并进 `docs/HANDOFF.md` 再删掉本文件。

## 用户要什么

1. 轻酒馆和 Luker **共用一份数据**（用户原话：「能和 luker 共用一个数据文件吗」→ 我给了方案 → 「好」）。
2. **把 Luker 里配的 API（连接和 Key）迁到轻酒馆**（「然后把 api 迁移过去」）。
3. 更早的一件事还悬着：脚本功能的分支要不要合进 main，用户没回答（见最后一节）。

## 现在线上是什么状态（重要：线上还没动）

- 线上 `/opt/lite-tavern/app` 是分支 `claude/tavern-helper-scripts` 的 28bc5d3（脚本功能），**不是**共用模式，服务单元没改。
- Luker 的数据（`/opt/luker/data/admin`）**只读过，没写过一个字节**。
- API 还没迁：轻酒馆里只有一条连接 `c_luker01`「Luker 中转」。
- 服务器 `/tmp/lt-src` 是本分支 bce9dff 的浅克隆（体检时用的），可以删，也可以 `git pull` 后接着用。
- 本次还没给 Luker 数据做备份（上线第一步要做）。

## 代码在哪

- 仓库 `sooya7/lite-tavern`，分支 **`claude/shared-st-data`**（叠在 `claude/tavern-helper-scripts` 上面，main 还在 b5f534d）。
- `bce9dff`：共用目录、聊天冲突检查、导入 API 连接。**单测 24/24、端到端 29/29 都过了。**
- 它后面那个提交（本文档所在的提交）：给角色卡 / 预设 / 世界书也加了版本检查，加了“旧页面保存一律挡住”。**单测 24/24 过了；端到端没跑**（跑之前被打断），也还缺两条端到端用例，见下面“还没做完的”。

### 已经实现的东西

| 功能 | 位置 | 说明 |
|---|---|---|
| 共用目录 | `server/store.mjs`（`SHARED_DIRS`、`Store` 构造函数、`p()`） | 启动参数 `--st-data <酒馆用户数据目录>`（或环境变量 `LT_ST_DATA`）。characters / chats / worlds 对应同名目录，presets 对应 `OpenAI Settings`。设置、密钥、头像、备份、回收站、缓存留在自己的 `--data` 目录 |
| 聊天冲突检查 | `store.saveChat`、`server.mjs` 聊天路由、`public/js/state.js` 的 `writeChat`、`controller.js` 的 `onChatConflict` | 读聊天时响应头 `X-Version`（文件 mtime 毫秒 + 大小）；保存带 `X-Expect`，对不上返回 409 `chat-conflict`；前端弹窗「载入最新的 / 用这边的覆盖」，覆盖前服务端留备份。文件已存在却没带版本号也拒绝 |
| 校验标记 | `stampIntegrity`、`rotateSyncSidecar` | 共用模式下每次保存聊天都换一个 `chat_metadata.integrity`，并更新 Luker 的 `<聊天名>.luker-state.chat_sync.json`（这个文件已存在才更新）。先写聊天、后写标记 |
| 附属文件 | `chatSidecars`、`renameChat`、`deleteChat` | 聊天改名 / 删除时带上 `<聊天名>.luker-state.*.json` |
| 导入 API 连接 | `server/st-import.mjs` 的 `readStConnections`、`importFromSt` 的 `connections` 选项 | 读酒馆 `settings.json` 的 `extension_settings.connectionManager.profiles` 和 `secrets.json`。Key 只在服务端两个文件之间搬。指定了 `secret-id` 就只认那一个 Key，找不到宁可留空（防止把这家的 Key 发给另一家）。已有连接靠 `stProfile` 字段或“同地址同模型”认出来，不重复建；`overwrite: true` 才按酒馆的更新 |
| 导入面板 | `public/js/ui/panels/import.js` | 多了「与酒馆共用数据」一节；扫描的目录就是共用目录时只列设置类的导入项；多了「API 连接和 Key」勾选项 |
| 其余三类的版本检查（未跑端到端） | `store.guardWrite`、`versionOf`；`public/js/api.js` 的 `versions` / `saving`；`state.js` 的 `onFileConflict`；`controller.js` 的弹窗 | 角色卡 / 预设 / 世界书：读时记版本号，保存自动带上，对不上 409 `conflict`，弹窗同上。没带版本号不查（新建、导入覆盖）。同一个文件的保存在前端排队 |
| 旧页面挡住（未跑端到端） | `server.mjs` 的 `CLIENT_PROTOCOL`、`api.js` 的 `PROTOCOL`、`app.js` 的 `lt:stale-client` | 除 `/api/login`、`/api/llm/*` 外，所有非 GET 请求必须带 `X-LT-Client: 2`，否则 409 `stale-client`。**用 curl 调接口时记得带这个头** |
| 工具 | `tools/st-roundtrip-check.mjs`、`tools/fake-st-dir.mjs` | 前者是只读体检；后者造假的酒馆目录给端到端用 |

### 还没做完的

1. **跑端到端**。本机的跑法（脚本在上个会话的临时目录里，已经没了，照这个重建）：
   ```bash
   node tools/fake-st-dir.mjs <假酒馆目录>
   node tools/mock-llm.mjs 8799 &
   node server.mjs --port 8731 --data <空目录A> &
   node server.mjs --port 8732 --data <空目录B> --st-data <假酒馆目录> &
   LT_SHARED_URL=http://127.0.0.1:8732 LT_SHARED_DIR=<假酒馆目录> LT_SHARED_OWN=<空目录B> python3 tools/e2e.py
   ```
   上次 29/29 是在 bce9dff 上。最新提交改了 `api.js` 的请求流程（排队、版本头），要重跑确认没带坏别的。
2. **补两条端到端用例**（代码写好了但没写进文件）：
   - 预设冲突：在共用实例里改温度 → 外部改 `OpenAI Settings/默认.json` → 再改温度 → 弹出「预设「默认」在别处被改过了」→ 选载入最新的 → 输入框显示外部的值。温度输入框的定位方法：搜索框填 `temperature` → 点结果 → `#right .flash input[type=number]`。
   - 旧页面：`page.evaluate` 里不带 `X-LT-Client` 头 `PUT /api/settings`，应得 409 `stale-client`，`GET` 不受影响。
3. **文档**：`docs/HANDOFF.md` 和 `README.md` 还没写共用模式、`--st-data`、版本检查、`CLIENT_PROTOCOL`。
4. **上线**（步骤见下一节）。
5. **知识库**：做完后在 `01-Projects/轻酒馆 lite-tavern.md` 记一笔结果。

## 上线步骤（按顺序，每条命令都要短，见“坑”）

用户当时正在用 Luker（最后一次写入 11:46），所以每一步都要保证不碰坏 Luker。

1. 推最新代码，服务器上 `/tmp/lt-src` 拉到最新；`sudo -u ubuntu node --test test/core.test.mjs`。
2. 体检（只读）：`sudo -u ubuntu nice node tools/st-roundtrip-check.mjs /opt/luker/data/admin`。上次结果：角色卡 25、世界书 33、预设 6、聊天 22，全部“存回去不丢东西”。代码改过后再跑一次。
3. 备份：
   - `tar -czf /opt/lite-tavern/app.bak-<日期>-before-share.tgz -C /opt/lite-tavern app`
   - `tar -czf /opt/lite-tavern/luker-data.bak-<日期>-before-share.tgz -C /opt/luker/data/admin characters chats worlds "OpenAI Settings"`（先 `du -sh` 看大小，磁盘剩 15G）
4. 同步代码：`rsync -a --delete --exclude=.git --chown=ubuntu:ubuntu /tmp/lt-src/ /opt/lite-tavern/app/`。
5. 改服务单元 `/etc/systemd/system/lite-tavern.service`：`ExecStart` 末尾加 `--st-data /opt/luker/data/admin`，然后 `systemctl daemon-reload && systemctl restart lite-tavern`。现在的 ExecStart 是 `/usr/bin/node /opt/lite-tavern/app/server.mjs --port 8730 --host 127.0.0.1 --data /opt/lite-tavern/data`，以 `ubuntu` 身份运行。Luker 容器是 uid 1000（就是 ubuntu），目录权限 750/640 属主 ubuntu，读写没问题。
6. 核对：`curl -s 127.0.0.1:8730/api/ping` 里 `shared` 是 `/opt/luker/data/admin`；`/api/characters` 有 25 个；`/api/presets` 有 6 个；Luker 的 `settings.json`、`secrets.json` 的 mtime 没变。
7. 迁 API（Key 不会出现在输出里）：
   ```bash
   curl -s -X POST 127.0.0.1:8730/api/st/import -H 'Content-Type: application/json' -H 'X-LT-Client: 2' \
     -d '{"dir":"/opt/luker/data/admin","connections":true,"overwrite":true}'
   ```
   预期：9 条连接（sooya、gg、gemini-3.7-flash、new、奶龙、yyz、幻想乡、cat、缥缈），全是 OpenAI 兼容的自定义地址，每条都有 `secret-id`。
   - 用 `overwrite: true` 是有意的：现有的 `c_luker01`「Luker 中转」和 Luker 的 `cat` 同地址同模型，会被认出来并改名为 `cat`、后处理改成 `strict`（Luker 全局的 `custom_prompt_post_processing` 就是 strict）。**这两处变化要告诉用户。**
   - 当前生效的连接不变（还是 `c_luker01`，也就是 cat，和 Luker 里选中的一致）。
8. 验证连接（不花额度）：对每条连接 `POST /api/llm/<连接id>`，请求体 `{"path":"/models","method":"GET"}`，只看状态码，不要打印响应体。个别中转不支持 `/models` 属正常，如实告诉用户哪几条没验证到。
9. 清理 `/tmp/lt-src`，确认 `lite-tavern` 和 Luker 容器都正常、负载正常。

### 上线后旧数据怎么办

- `/opt/lite-tavern/data` 里原来的 `characters / chats / worlds / presets` 四个目录不再使用，**留着别删**（等于一份快照），告诉用户它们在那儿。
- 那里比 Luker 多出来的东西我核对过，都不用搬：
  - 2 个聊天（`default_Assistant/Assistant - 2026-10-10@08h14m04s`、`【Sgw】长期素食导致的/… - 2026-10-10@08h14m19s`）是我早上的冒烟测试（「用一句话介绍你自己」「（测试）…」）。
  - 2 本世界书（`《问道红尘》·世界书`、`明明我才是主人公… (2)`）是导入时从卡里内嵌的世界书另存出来的；Luker 里这两张卡的世界书链接是悬空的。共用后轻酒馆会直接用卡里内嵌的那份（`core/session.js` 168–172 行的回退），效果一样。
  - 其余有差异的文件都是 Luker 那边更新（尘世命轨的聊天 Luker 有 203 条，轻酒馆的旧副本 126 条）。
- `settings.json` 里的 `lastChat` 可能指向那两个测试聊天之一，切换后找不到。**没验证过启动时找不到上次的聊天会怎样**，上线后打开页面看一眼。

## 关于 Luker 必须知道的事（读它的源码得出的，容器里 `src/endpoints/chats.js`）

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

## 坑

- 服务器 2 核 2G、swap 常年快满。别在上面循环跑无头浏览器（上次把负载打到 23）。
- `srv__run_command` 单条命令约 2KB 上限、约 30 秒超时；长脚本用 heredoc 分段写，耗时的放后台再轮询。`pkill -f` 会把自己这条 shell 也杀掉，用 pid 文件或按端口找 pid。
- 开发容器访问不了 npm registry 和这台服务器；GitHub 公开仓库能 clone。
- 用户可能开着更新前的轻酒馆页面。“旧页面挡住”就是为这个加的：旧页面不带版本号保存，会把它手里的旧副本写进 Luker 的目录。**所以共用模式一定要和带 `CLIENT_PROTOCOL` 检查的这版代码一起上，不能只上 bce9dff。**
- 打开聊天本身可能触发写入：MVU 卡的聊天里没有任何楼层带 `stat_data` 时会自动初始化（`session.ensureMvuInit`），卡里的脚本也可能写变量。写入都走带版本检查的保存，不会悄悄盖东西，但 Luker 那边开着同一个聊天时会看到冲突提示。

## 做完后要告诉用户的

- 共用了哪四类、哪些没共用（连接和密钥、全局正则、用户设定、全局变量、全局启用的世界书）。
- 两边同时开同一个聊天会怎样；“一边改完另一边先刷新”的规矩。
- 迁过来的 9 条连接，哪几条验证过能连；`Luker 中转` 改名成了 `cat`、后处理变成 strict。
- Luker 里另有二十来个没挂连接配置的 Key 没迁，要的话让用户说是哪家的地址。
- 旧数据目录留着没删；两个测试聊天没搬。
- Luker 界面里的冲突提示有没有实际演练过，如实说。

## 还悬着的问题（要问用户）

- 脚本功能（`claude/tavern-helper-scripts`）和这次的共用功能（`claude/shared-st-data`）都还没合进 main，线上跑的是分支。用户以前的习惯是让合进 main，但这次没明确说，合之前问一句。
