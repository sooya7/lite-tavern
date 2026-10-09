// 连接面板：API 地址、密钥（只写）、模型、各家格式的选项
import { h, clear, icon, toast, confirmDialog, popupMenu } from '../dom.js';
import { state, saveSettings, newConnection, activeConnection, flushPending } from '../../state.js';
import { api } from '../../api.js';
import { PROVIDERS, modelsPath, parseModelList, buildRequest, parseFullResponse } from '../../core/providers.js';
import { samplerParams } from '../../core/preset.js';
import { field, textInput, textArea, numberInput, checkbox, select, section, collapsible } from '../form.js';
import { renderPanels } from './index.js';

const QUICK = [
    { label: 'OpenAI 兼容 / 中转', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
    { label: 'DeepSeek 官方', provider: 'openai', baseUrl: 'https://api.deepseek.com', name: 'DeepSeek' },
    { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', name: 'OpenRouter' },
    { label: 'Claude 官方', provider: 'claude', baseUrl: 'https://api.anthropic.com', name: 'Claude' },
    { label: 'Gemini（AI Studio）', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', name: 'Gemini' },
    { label: '本地（Ollama / LM Studio 等）', provider: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', name: '本地模型' },
];

const modelCache = {};

export function render(body) {
    const s = state.settings;
    if (!s.connections.length) {
        body.append(section('还没有 API 连接',
            h('div', { class: 'muted small', style: { margin: '4px 0 10px' } }, '选一个类型开始。密钥只保存在本机服务端，不会发给浏览器。'),
            h('div', { class: 'quick-grid' }, QUICK.map(q => h('button', { class: 'btn', onclick: () => addConnection(q) }, q.label))),
        ));
        return;
    }
    const conn = activeConnection();
    if (s.activeConnection !== conn.id) { s.activeConnection = conn.id; saveSettings(); }

    const picker = h('select', { class: 'select grow' }, s.connections.map(c => h('option', { value: c.id, selected: c.id === conn.id }, `${c.name}${c.model ? ' · ' + c.model : ''}`)));
    picker.addEventListener('change', () => { s.activeConnection = picker.value; saveSettings(); renderPanels(); });
    body.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
        picker,
        h('button', { class: 'btn small', title: '新建连接', onclick: (e) => popupMenu(e.currentTarget, QUICK.map(q => ({ label: q.label, onClick: () => addConnection(q) }))) }, icon('plus')),
        h('button', { class: 'btn small', title: '复制这个连接', onclick: () => addConnection({ ...conn, id: undefined, name: `${conn.name} 副本` }) }, icon('copy')),
        h('button', { class: 'btn small danger', title: '删除这个连接', onclick: () => removeConnection(conn) }, icon('trash')),
    ));

    const save = () => saveSettings();
    const keyMask = state.secrets?.[conn.id];
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: keyMask ? `已保存：${keyMask}（留空不改）` : '粘贴 API Key', autocomplete: 'new-password' });
    const keyRow = h('div', { class: 'row' }, keyInput,
        h('button', { class: 'btn small primary', onclick: async () => {
            const v = keyInput.value.trim();
            if (!v) { toast('先填密钥', 'warning'); return; }
            await api.setSecret(conn.id, v);
            state.secrets = await api.getSecrets();
            keyInput.value = '';
            toast('密钥已保存在服务端', 'success');
            renderPanels();
        } }, '保存'),
        keyMask ? h('button', { class: 'btn small', title: '清除已保存的密钥', onclick: async () => {
            if (!await confirmDialog('清除这个连接保存的密钥？')) return;
            await api.setSecret(conn.id, '');
            state.secrets = await api.getSecrets();
            renderPanels();
        } }, '清除') : null,
    );

    const listId = `models-${conn.id}`;
    const datalist = h('datalist', { id: listId }, (modelCache[conn.id] ?? []).map(m => h('option', { value: m })));
    const modelInput = textInput(conn, 'model', { placeholder: conn.provider === 'gemini' ? '如 gemini-2.5-pro' : conn.provider === 'claude' ? '如 claude-sonnet-4-5' : '模型名', onChange: save, list: listId });
    const fetchBtn = h('button', { class: 'btn small', onclick: () => fetchModels(conn, datalist, fetchBtn) }, icon('refresh'), '获取');
    const modelSelectWrap = h('div');
    if (modelCache[conn.id]?.length) modelSelectWrap.append(modelPicker(conn, modelInput));

    const testOut = h('div', { class: 'small', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } });

    const provOpts = Object.entries(PROVIDERS).map(([value, p]) => ({ value, label: p.label }));
    const main = section(null,
        field('名称', textInput(conn, 'name', { onChange: save })),
        field('接口类型', select(conn, 'provider', provOpts, {
            onChange: (v) => {
                const defaults = Object.values(PROVIDERS).map(p => p.defaultBase);
                if (!conn.baseUrl || defaults.includes(conn.baseUrl)) conn.baseUrl = PROVIDERS[v].defaultBase;
                save();
                renderPanels();
            },
        })),
        field('接口地址', textInput(conn, 'baseUrl', { placeholder: PROVIDERS[conn.provider]?.defaultBase, onChange: save }),
            conn.provider === 'openai' ? '填到 /v1 为止（程序会拼上 /chat/completions）。中转站一般给的就是这种地址。' : conn.provider === 'claude' ? '官方填 https://api.anthropic.com；Claude 格式的中转填它给的根地址（不含 /v1）。' : '官方填 https://generativelanguage.googleapis.com；反代填根地址（不含 /v1beta）。'),
        field('API Key', keyRow, '只存在本机数据目录的 secrets.json 里，浏览器拿不到明文。'),
        field('模型', h('div', {}, h('div', { class: 'row' }, modelInput, fetchBtn), datalist, modelSelectWrap)),
        field('流式输出', select(conn, 'stream', [{ value: '', label: '跟随预设' }, { value: 'true', label: '开' }, { value: 'false', label: '关' }], {
            onChange: (v) => { conn.stream = v === '' ? undefined : v === 'true'; save(); },
        })),
        h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { class: 'btn', onclick: () => testConnection(conn, testOut) }, icon('send'), '测试连接'),
            h('span', { class: 'muted small' }, '会发一条很短的请求（消耗极少额度）'),
        ),
        testOut,
    );
    body.append(main);

    const adv = [];
    if (conn.provider === 'openai') {
        adv.push(field('提示词后处理', select(conn, 'postProcessing', [
            { value: '', label: '不处理（原样发送）' },
            { value: 'merge', label: '合并连续同角色消息' },
            { value: 'semi', label: '半严格（中间的 system 转 user）' },
            { value: 'strict', label: '严格（再补占位 user）' },
            { value: 'single', label: '全部合成一条 user 消息' },
        ], { onChange: save }), '有些模型（如部分国产/本地模型、某些中转）不接受多条 system 或连续同角色消息时用。'));
        adv.push(checkbox(conn, 'prefillAsAssistant', '预设里的“预填充”作为结尾 assistant 消息发送', { onChange: save, hint: 'DeepSeek、部分中转支持续写结尾的 assistant 消息' }));
        adv.push(checkbox(conn, 'sendExtraSamplers', '额外发送 top_k / min_p / top_a / repetition_penalty', { onChange: save }));
    }
    if (conn.provider === 'claude' || conn.provider === 'gemini') {
        adv.push(field('思考预算（tokens，0 = 不开）', numberInput(conn, 'thinkingBudget', { min: 0, step: 1024, onChange: save })));
    }
    if (conn.provider === 'gemini') adv.push(checkbox(conn, 'includeThoughts', '返回思考过程', { onChange: save }));
    adv.push(field('额外请求体（JSON，会合并进请求）', textArea(conn, 'extraBody', { code: true, rows: 3, placeholder: '{"reasoning": {"effort": "high"}}', onChange: save })));
    adv.push(field('额外请求头（每行 Key: Value 或 JSON）', textArea(conn, 'extraHeaders', { code: true, rows: 2, placeholder: 'HTTP-Referer: https://example.com', onChange: save })));
    body.append(collapsible('高级选项', adv));
}

function modelPicker(conn, modelInput) {
    const list = modelCache[conn.id] ?? [];
    const sel = h('select', { class: 'select', style: { marginTop: '6px' } },
        h('option', { value: '' }, `从 ${list.length} 个模型里选…`),
        list.map(m => h('option', { value: m, selected: m === conn.model }, m)));
    sel.addEventListener('change', () => {
        if (!sel.value) return;
        conn.model = sel.value;
        modelInput.value = sel.value;
        saveSettings();
    });
    return sel;
}

async function fetchModels(conn, datalist, btn) {
    btn.disabled = true;
    try {
        await flushPending();
        const res = await api.llm(conn.id, { path: modelsPath(conn.provider), method: 'GET' });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
        const list = parseModelList(conn.provider, JSON.parse(text));
        if (!list.length) throw new Error('接口没返回模型');
        modelCache[conn.id] = list;
        toast(`拿到 ${list.length} 个模型`, 'success');
        renderPanels();
    } catch (e) {
        toast(`获取模型失败：${e.message}`, 'error');
    } finally {
        btn.disabled = false;
    }
}

async function testConnection(conn, out) {
    clear(out);
    out.append(h('span', { class: 'muted' }, '请求中…'));
    const t0 = performance.now();
    try {
        await flushPending();
        const params = { ...samplerParams(state.preset?.data ?? {}), max_tokens: 32, stream: false };
        const req = buildRequest({ ...conn, stream: false }, { messages: [{ role: 'user', content: 'Reply with one word: ok' }], params, names: {} });
        if (conn.provider === 'claude' && req.body.thinking) { delete req.body.thinking; req.body.temperature = 1; }
        if (conn.provider === 'gemini') delete req.body.generationConfig?.thinkingConfig;
        const res = await api.llm(conn.id, { path: req.path, method: 'POST', body: req.body, stream: false });
        const text = await res.text();
        const ms = Math.round(performance.now() - t0);
        clear(out);
        if (!res.ok) {
            let msg = text;
            try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? text; } catch { /* 原样 */ }
            out.append(h('span', { style: { color: 'var(--danger)' } }, `失败（HTTP ${res.status}，${ms}ms）：${String(msg).slice(0, 400)}`));
            return;
        }
        let reply = '';
        try { reply = parseFullResponse(conn.provider, JSON.parse(text)).text; } catch { reply = text.slice(0, 200); }
        out.append(h('span', { style: { color: 'var(--ok)' } }, `连通（${ms}ms）：${reply.trim().slice(0, 200) || '（空回复，但接口通了）'}`));
    } catch (e) {
        clear(out);
        out.append(h('span', { style: { color: 'var(--danger)' } }, `失败：${e.message}`));
    }
}

function addConnection(q) {
    const s = state.settings;
    const { label, ...rest } = q;
    const c = newConnection({ ...rest, name: q.name ?? label });
    c.id = newConnection().id;
    s.connections.push(c);
    s.activeConnection = c.id;
    saveSettings();
    renderPanels();
}

async function removeConnection(conn) {
    if (!await confirmDialog(`删除连接「${conn.name}」？它保存的密钥也会一起清除。`, { danger: true, okLabel: '删除' })) return;
    const s = state.settings;
    s.connections = s.connections.filter(c => c.id !== conn.id);
    if (s.activeConnection === conn.id) s.activeConnection = s.connections[0]?.id ?? '';
    await api.setSecret(conn.id, '').catch(() => {});
    state.secrets = await api.getSecrets().catch(() => ({}));
    saveSettings();
    renderPanels();
}
