// 预设面板：切换/导入/导出、采样参数、提示词管理器（拖拽排序、开关、编辑）、格式与杂项
import { h, clear, icon, iconBtn, toast, confirmDialog, promptDialog, modal, pickFiles, downloadText, makeSortable } from '../dom.js';
import { state, savePreset, refreshLists, flushPending } from '../../state.js';
import { api } from '../../api.js';
import { setPreset, refresh } from '../../controller.js';
import { getPromptOrder, newCustomPrompt, BUILTIN_PROMPT_NAMES, MARKERS, PROMPT_ORDER_GLOBAL, presetTavernHelperScripts, normalizePreset } from '../../core/preset.js';
import { estimateTokens } from '../../core/tokens.js';
import { clone } from '../../core/util.js';
import { field, textInput, textArea, numberInput, checkbox, select, rangeRow, section, collapsible, toggle } from '../form.js';
import { renderPanels } from './index.js';
import { importPresetJson } from '../importers.js';

const TRIGGERS = [
    ['normal', '普通'], ['continue', '继续'], ['impersonate', '代写'], ['swipe', '重刷'], ['regenerate', '重新生成'], ['quiet', '静默'],
];

const save = () => savePreset();

export function render(body) {
    if (!state.preset) { body.append(h('div', { class: 'empty' }, '预设还没加载')); return; }
    const p = state.preset.data;

    // ---------- 选择与文件操作 ----------
    const picker = h('select', { class: 'select grow' }, state.presetList.map(x => h('option', { value: x.name, selected: x.name === state.preset.name }, x.name)));
    picker.addEventListener('change', () => setPreset(picker.value));
    body.append(h('div', { class: 'row', style: { marginBottom: '10px' } },
        picker,
        iconBtn('upload', '导入预设 JSON', onImport),
        iconBtn('download', '导出当前预设', () => downloadText(JSON.stringify(p, null, 4), `${state.preset.name}.json`)),
        iconBtn('copy', '另存为', onSaveAs),
        iconBtn('edit', '重命名', onRename),
        iconBtn('trash', '删除预设', onDelete),
    ));

    // ---------- 采样参数 ----------
    body.append(collapsible('采样参数', [
        field('温度 temperature', rangeRow(p, 'temperature', { min: 0, max: 2, step: 0.01, onChange: save })),
        field('Top P', rangeRow(p, 'top_p', { min: 0, max: 1, step: 0.01, onChange: save })),
        field('Top K（0 = 不用）', rangeRow(p, 'top_k', { min: 0, max: 200, step: 1, onChange: save })),
        field('频率惩罚 frequency_penalty', rangeRow(p, 'frequency_penalty', { min: -2, max: 2, step: 0.01, onChange: save })),
        field('存在惩罚 presence_penalty', rangeRow(p, 'presence_penalty', { min: -2, max: 2, step: 0.01, onChange: save })),
        h('div', { class: 'grid2' },
            field('上下文上限（tokens）', numberInput(p, 'openai_max_context', { min: 512, step: 1024, onChange: save })),
            field('回复上限（tokens）', numberInput(p, 'openai_max_tokens', { min: 16, step: 100, onChange: save })),
        ),
        h('div', { class: 'grid2' },
            field('推理强度', select(p, 'reasoning_effort', [
                { value: 'auto', label: '不指定' }, { value: 'minimal', label: '最低' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' },
            ], { onChange: save })),
            field('种子（-1 随机）', numberInput(p, 'seed', { step: 1, onChange: save })),
        ),
        checkbox(p, 'stream_openai', '流式输出', { onChange: save }),
        collapsible('更多采样（多数接口不认，需在连接里打开“额外发送”）', [
            field('Min P', rangeRow(p, 'min_p', { min: 0, max: 1, step: 0.001, onChange: save })),
            field('Top A', rangeRow(p, 'top_a', { min: 0, max: 1, step: 0.001, onChange: save })),
            field('重复惩罚 repetition_penalty', rangeRow(p, 'repetition_penalty', { min: 1, max: 2, step: 0.01, onChange: save })),
        ]),
    ], { open: false, sub: `温度 ${p.temperature} · 上下文 ${p.openai_max_context} · 回复 ${p.openai_max_tokens}` }));

    // ---------- 提示词管理器 ----------
    body.append(promptManager(p));

    // ---------- 格式与杂项 ----------
    body.append(collapsible('格式与杂项', [
        field('角色名处理（names_behavior）', select(p, 'names_behavior', [
            { value: -1, label: '不加名字' }, { value: 0, label: '默认（仅群聊/代写时）' }, { value: 1, label: '放进消息的 name 字段' }, { value: 2, label: '写进消息正文 “名字: ”' },
        ], { number: true, onChange: save })),
        checkbox(p, 'squash_system_messages', '合并相邻的 system 消息', { onChange: save }),
        checkbox(p, 'continue_prefill', '“继续”时把上一条作为预填充（而不是追加提示）', { onChange: save }),
        field('继续时的连接符', select(p, 'continue_postfix', [
            { value: '', label: '无' }, { value: ' ', label: '空格' }, { value: '\n', label: '换行' }, { value: '\n\n', label: '空一行' },
        ], { onChange: save })),
        field('预填充（assistant 开头）', textArea(p, 'assistant_prefill', { rows: 2, onChange: save }), 'Claude/Gemini 原生支持；OpenAI 兼容接口要在连接里勾选“预填充作为 assistant 消息”'),
        field('代写时的预填充', textArea(p, 'assistant_impersonation', { rows: 2, onChange: save })),
        field('代写提示词', textArea(p, 'impersonation_prompt', { rows: 3, onChange: save })),
        field('继续提示词', textArea(p, 'continue_nudge_prompt', { rows: 2, onChange: save })),
        field('新聊天开头', textInput(p, 'new_chat_prompt', { onChange: save })),
        field('示例对话开头', textInput(p, 'new_example_chat_prompt', { onChange: save })),
        field('用户消息为空时发送', textInput(p, 'send_if_empty', { onChange: save })),
        field('世界书格式', textInput(p, 'wi_format', { onChange: save }), '{0} 代表世界书内容'),
        field('场景格式', textInput(p, 'scenario_format', { onChange: save })),
        field('性格格式', textInput(p, 'personality_format', { onChange: save })),
    ]));

    const th = presetTavernHelperScripts(p);
    const rx = p.extensions?.regex_scripts ?? [];
    if (th.length || rx.length) {
        body.append(section('预设自带的扩展内容',
            rx.length ? h('div', { class: 'small' }, `正则脚本 ${rx.length} 条（在「正则」面板里管理）`) : null,
            th.length ? h('div', { class: 'small' }, `酒馆助手脚本 ${th.length} 个（在「脚本」面板里管理）：${th.map(x => x.name).filter(Boolean).slice(0, 6).join('、')}${th.length > 6 ? '…' : ''}`) : null,
        ));
    }
}

// ---------- 提示词管理器 ----------
function promptManager(p) {
    const order = getPromptOrder(p);
    // 保证 100001 存在（normalize 已处理），直接改它
    const list = h('div', { class: 'prompt-list' });
    const byId = new Map(p.prompts.map(x => [x.identifier, x]));
    let total = 0;

    const fill = () => {
        clear(list);
        total = 0;
        order.forEach((o) => {
            const pr = byId.get(o.identifier);
            if (!pr) return;
            const isMarker = !!pr.marker;
            const abs = Number(pr.injection_position) === 1;
            const tokens = !isMarker ? estimateTokens(pr.content ?? '') : 0;
            if (o.enabled && !isMarker) total += tokens;
            const name = pr.name || BUILTIN_PROMPT_NAMES[pr.identifier] || pr.identifier;
            const item = h('div', { class: `list-item ${o.enabled ? '' : 'disabled'}`, dataset: { id: pr.identifier } },
                h('span', { class: 'drag-handle', title: '拖动排序' }, icon('grip')),
                h('span', { class: 'li-name', title: name, onclick: () => editPrompt(p, pr, fill) },
                    isMarker ? h('span', { class: 'tag', style: { marginRight: '6px' } }, '占位') : null,
                    name,
                    BUILTIN_PROMPT_NAMES[pr.identifier] && pr.name !== BUILTIN_PROMPT_NAMES[pr.identifier] ? h('span', { class: 'li-sub' }, ` ${BUILTIN_PROMPT_NAMES[pr.identifier]}`) : null),
                abs ? h('span', { class: 'tag accent', title: '插入到聊天记录里的固定深度' }, `@${pr.injection_depth ?? 4}`) : null,
                !isMarker && pr.role && pr.role !== 'system' ? h('span', { class: 'tag' }, pr.role === 'user' ? '用户' : 'AI') : null,
                !isMarker ? h('span', { class: 'li-sub', style: { minWidth: '34px', textAlign: 'right' } }, tokens ? `${tokens}` : '空') : null,
                toggle(!!o.enabled, (v) => { o.enabled = v; save(); fill(); }, '启用/停用'),
            );
            list.append(item);
        });
        totalEl.textContent = `已启用的自定义内容约 ${total} tokens`;
    };
    const totalEl = h('span', { class: 'muted small' });
    makeSortable(list, '.list-item', (from, to) => {
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        save();
        fill();
    });

    const missing = p.prompts.filter(x => !order.some(o => o.identifier === x.identifier));
    const addExisting = missing.length ? (() => {
        const sel = h('select', { class: 'select' }, h('option', { value: '' }, `加回已有条目（${missing.length}）…`), missing.map(x => h('option', { value: x.identifier }, x.name || x.identifier)));
        sel.addEventListener('change', () => {
            if (!sel.value) return;
            order.push({ identifier: sel.value, enabled: true });
            save();
            renderPanels();
        });
        return sel;
    })() : null;

    fill();
    return collapsible('提示词（拖动排序，点名字编辑）', [
        h('div', { class: 'row', style: { marginBottom: '8px' } },
            totalEl,
            h('div', { class: 'grow' }),
            h('button', {
                class: 'btn small',
                onclick: () => {
                    const pr = newCustomPrompt();
                    p.prompts.push(pr);
                    const histIdx = order.findIndex(o => o.identifier === 'chatHistory');
                    order.splice(histIdx >= 0 ? histIdx : order.length, 0, { identifier: pr.identifier, enabled: true });
                    save();
                    editPrompt(p, pr, () => renderPanels());
                },
            }, icon('plus'), '新条目'),
        ),
        list,
        addExisting,
    ], { open: true, sub: `${order.filter(o => o.enabled).length}/${order.length} 启用` });
}

function editPrompt(p, pr, onDone) {
    const isMarker = !!pr.marker;
    const isBuiltin = !!BUILTIN_PROMPT_NAMES[pr.identifier];
    const draft = clone(pr);
    const content = isMarker ? null : textArea(draft, 'content', { rows: 14, code: true, maxRows: 30 });
    const tokenEl = h('span', { class: 'muted small' }, isMarker ? '' : `约 ${estimateTokens(draft.content ?? '')} tokens`);
    content?.addEventListener('input', () => { tokenEl.textContent = `约 ${estimateTokens(draft.content ?? '')} tokens`; });
    const depthWrap = h('div', { class: 'grid2' },
        field('深度（0 = 最后一条之后）', numberInput(draft, 'injection_depth', { min: 0, step: 1 })),
        field('同深度排序（越小越前）', numberInput(draft, 'injection_order', { step: 1 })),
    );
    const posSel = select(draft, 'injection_position', [{ value: 0, label: '按列表位置' }, { value: 1, label: '插入聊天记录（指定深度）' }], {
        number: true, onChange: (v) => { depthWrap.hidden = v !== 1; },
    });
    depthWrap.hidden = Number(draft.injection_position ?? 0) !== 1;
    const triggers = h('div', { class: 'row wrap' }, TRIGGERS.map(([k, label]) => {
        const cb = h('input', { type: 'checkbox', checked: (draft.injection_trigger ?? []).includes(k) });
        cb.addEventListener('change', () => {
            const set = new Set(draft.injection_trigger ?? []);
            if (cb.checked) set.add(k); else set.delete(k);
            draft.injection_trigger = [...set];
        });
        return h('label', { class: 'check' }, cb, label);
    }));

    const bodyEl = h('div', {},
        isMarker ? h('div', { class: 'hint', style: { marginBottom: '8px' } }, '这是占位条目：内容来自角色卡 / 世界书 / 聊天记录本身，这里只能调整位置和开关。') : null,
        field('名称', textInput(draft, 'name')),
        !isMarker ? h('div', { class: 'grid2' },
            field('角色', select(draft, 'role', [{ value: 'system', label: '系统 system' }, { value: 'user', label: '用户 user' }, { value: 'assistant', label: 'AI assistant' }])),
            field('位置', posSel),
        ) : null,
        !isMarker ? depthWrap : null,
        !isMarker ? field('只在这些生成类型时发送（都不勾 = 总是）', triggers) : null,
        !isMarker ? field(h('span', {}, '内容 ', tokenEl), content, '支持 {{char}} {{user}} {{getvar::x}} 等宏，以及 <% %> EJS 模板') : null,
        (pr.identifier === 'main' || pr.identifier === 'jailbreak') ? checkbox(draft, 'forbid_overrides', '不允许角色卡覆盖这一条') : null,
        h('div', { class: 'muted small', style: { marginTop: '8px' } }, `标识：${pr.identifier}`),
    );
    modal({
        title: `编辑：${pr.name || BUILTIN_PROMPT_NAMES[pr.identifier] || pr.identifier}`,
        wide: true,
        body: bodyEl,
        actions: [
            !isBuiltin ? { label: '删除', danger: true, onClick: async () => {
                if (!await confirmDialog('删除这个提示词条目？')) return false;
                p.prompts = p.prompts.filter(x => x.identifier !== pr.identifier);
                for (const o of p.prompt_order) o.order = (o.order ?? []).filter(x => x.identifier !== pr.identifier);
                save();
                renderPanels();
                return true;
            } } : null,
            { label: '取消', value: false },
            { label: '保存', primary: true, onClick: () => {
                Object.assign(pr, draft);
                if (Number(pr.injection_position) !== 1) pr.injection_position = 0;
                save();
                onDone?.();
                return true;
            } },
        ].filter(Boolean),
    });
}

// ---------- 文件操作 ----------
async function onImport() {
    const [f] = await pickFiles({ accept: '.json' });
    if (!f) return;
    try {
        const j = JSON.parse(await f.text());
        await importPresetJson(j, f.name.replace(/\.json$/i, ''));
    } catch (e) {
        toast(`导入失败：${e.message}`, 'error');
    }
}

async function onSaveAs() {
    const name = await promptDialog('新预设名字：', `${state.preset.name} 副本`, { title: '另存为' });
    if (!name?.trim()) return;
    if (state.presetList.some(x => x.name === name.trim())) { toast('已经有同名预设了', 'warning'); return; }
    await flushPending();
    await api.save('presets', name.trim(), state.preset.data);
    await refreshLists();
    await setPreset(name.trim());
    toast('已另存并切换', 'success');
}

async function onRename() {
    const old = state.preset.name;
    const name = await promptDialog('新名字：', old, { title: '重命名预设' });
    if (!name?.trim() || name.trim() === old) return;
    try {
        await flushPending();
        await api.rename('presets', old, name.trim());
        await refreshLists();
        state.preset.name = name.trim();
        state.settings.activePreset = name.trim();
        await setPreset(name.trim());
    } catch (e) {
        toast(`重命名失败：${e.message}`, 'error');
    }
}

async function onDelete() {
    if (state.presetList.length <= 1) { toast('至少要留一个预设', 'warning'); return; }
    const name = state.preset.name;
    if (!await confirmDialog(`删除预设「${name}」？（会移到 trash）`, { danger: true, okLabel: '删除' })) return;
    await flushPending();
    await api.remove('presets', name);
    await refreshLists();
    await setPreset(state.presetList[0].name);
    refresh(['panels', 'topbar']);
}

export { normalizePreset, PROMPT_ORDER_GLOBAL, MARKERS };
