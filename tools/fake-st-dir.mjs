#!/usr/bin/env node
// 造一个最小的假酒馆用户数据目录，给“与酒馆共用数据”的端到端测试用。
// 里面有一个连接配置（指向假模型）和它的 Key，没有角色卡——角色卡由测试通过界面导入，好验证它落在了这个目录里。
// 用法：node tools/fake-st-dir.mjs <目录> [假模型地址，默认 http://127.0.0.1:8799]
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '');
const mock = process.argv[3] ?? 'http://127.0.0.1:8799';
if (!process.argv[2]) { console.error('用法：node tools/fake-st-dir.mjs <目录>'); process.exit(1); }
for (const d of ['characters', 'chats', 'worlds', 'OpenAI Settings', 'User Avatars']) fs.mkdirSync(path.join(dir, d), { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    main_api: 'openai',
    oai_settings: { chat_completion_source: 'custom', custom_url: `${mock}/v1`, custom_model: 'mock-gpt', custom_prompt_post_processing: '' },
    extension_settings: { connectionManager: { selectedProfile: 'p-mock', profiles: [
        { id: 'p-mock', name: '酒馆里的中转', mode: 'cc', api: 'custom', 'api-url': `${mock}/v1`, model: 'mock-gpt', 'secret-id': 'k-mock' },
    ] } },
}, null, 2));
fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ api_key_custom: [{ id: 'k-other', value: 'sk-not-this-one', active: true }, { id: 'k-mock', value: 'sk-from-tavern', active: false }] }));
console.log(dir);
