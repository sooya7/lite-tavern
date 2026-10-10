# 轻酒馆 lite-tavern

兼容 SillyTavern（酒馆）数据格式的轻量 AI 角色扮演前端。零依赖 Node 服务 + 无构建原生 JS 前端。

- 角色卡：PNG / JSON，V1 / V2 / V3；导入时内嵌世界书自动拆出并绑定，自带的正则和脚本直接生效
- 对话补全预设：提示词管理器（顺序、开关、深度注入、触发类型）、采样参数、格式项，与酒馆 `OpenAI Settings/*.json` 同格式
- 世界书：关键词 / 正则键、次要逻辑、常驻、递归、概率、分组、预算、8 种位置、粘滞 / 冷却 / 延迟、装饰器
- 正则：全局 / 角色 / 预设三组，仅显示 / 仅提示词 / 深度范围 / 宏替换
- 宏：酒馆 1.18 新宏引擎语法 + 旧语法，变量宏
- 插件生态的原生兼容：提示词模板（EJS `<% %>`）、MVU 变量框架、酒馆助手式前端卡（代码块里的 HTML 界面，沙箱 iframe）
- 角色卡 / 预设自带的酒馆助手脚本：导入后自动运行（小手机、悬浮状态栏、变量结构校验等），在 设置 › 角色 › 脚本 里逐个开关。脚本和在酒馆里一样能读写全部数据、使用配置好的模型连接，只给信得过的卡和预设开着
- 接口：OpenAI 兼容（含中转）、Claude、Gemini；流式、思维链拆分、自动重试（含“中转把报错当正文”）
- 密钥只存在服务端 `data/secrets.json`，浏览器拿不到明文
- 一键从酒馆 / TauriTavern 数据目录导入（只读源目录）

## 运行

需要 Node.js 18+（开发用 24）。

```bash
node server.mjs                 # http://127.0.0.1:8730，数据在 ./data
node server.mjs --port 8730 --host 0.0.0.0 --password 你的密码 --data D:/lt-data --open
```

开放到局域网时务必加 `--password`。

与酒馆 / Luker 共用数据：加 `--st-data <酒馆用户数据目录>`（如 `data/default-user`），角色卡、聊天、世界书、预设直接读写那一份，两边同时改同一个文件时会弹窗让你选。连接和 Key 可在 设置 › 导入 里从酒馆搬过来。细节见交接文档 3.6 节。

## 测试

```bash
npm test                         # 核心引擎单元测试（node --test）
node tools/check-imports.mjs     # 前端模块导入导出静态检查
# 端到端（无头浏览器 + 假模型，不花额度）：
node tools/mock-llm.mjs 8799
node server.mjs --port 8731 --data <空目录>
python tools/e2e.py
# 连共用模式一起测：见 tools/e2e.py 开头的说明（LT_SHARED_URL / LT_SHARED_DIR / LT_SHARED_OWN）
```

详细的结构、现状和后续工作见 [docs/HANDOFF.md](docs/HANDOFF.md)。

## 第三方

`public/vendor/` 下的 js-yaml、lodash、showdown、DOMPurify、jQuery 各自附带许可证文件。
