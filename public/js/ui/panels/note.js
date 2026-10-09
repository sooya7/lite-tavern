// 本聊天：作者注释、聊天绑定世界书、场景覆盖
import { h } from '../dom.js';
import { state, saveChat } from '../../state.js';
import { loadRelevantWorlds } from '../../controller.js';
import { estimateTokens } from '../../core/tokens.js';
import { field, textArea, numberInput, select, section } from '../form.js';

export function render(body) {
    if (!state.chat) { body.append(h('div', { class: 'empty' }, '先打开一个聊天')); return; }
    const meta = state.chat.header.chat_metadata ?? (state.chat.header.chat_metadata = {});
    if (meta.note_interval === undefined) meta.note_interval = 1;
    if (meta.note_position === undefined) meta.note_position = 1;
    if (meta.note_depth === undefined) meta.note_depth = 4;
    if (meta.note_role === undefined) meta.note_role = 0;
    const save = () => saveChat();
    const tokenEl = h('span', { class: 'muted small' }, `约 ${estimateTokens(meta.note_prompt ?? '')} tokens`);
    const depthRow = h('div', { class: 'grid2' },
        field('深度', numberInput(meta, 'note_depth', { min: 0, onChange: save })),
        field('角色', select(meta, 'note_role', [{ value: 0, label: 'system' }, { value: 1, label: 'user' }, { value: 2, label: 'assistant' }], { number: true, onChange: save })),
    );
    depthRow.hidden = Number(meta.note_position) !== 1;
    const noteTa = textArea(meta, 'note_prompt', { rows: 6, onChange: save, placeholder: '比如：[接下来的剧情节奏放慢，多写环境描写]' });
    noteTa.addEventListener('input', () => { tokenEl.textContent = `约 ${estimateTokens(meta.note_prompt ?? '')} tokens`; });

    body.append(section('作者注释（只对这个聊天生效）',
        field(h('span', {}, '内容 ', tokenEl), noteTa),
        h('div', { class: 'grid2' },
            field('位置', select(meta, 'note_position', [
                { value: 0, label: '主提示词之后' },
                { value: 1, label: '聊天记录中（指定深度）' },
                { value: 2, label: '主提示词之前' },
            ], { number: true, onChange: (v) => { depthRow.hidden = v !== 1; save(); } })),
            field('频率（每 N 条用户消息，0 关闭）', numberInput(meta, 'note_interval', { min: 0, onChange: save })),
        ),
        depthRow,
    ));

    body.append(section('聊天设置',
        field('绑定世界书（只对这个聊天生效）', select(meta, 'world_info', [{ value: '', label: '（不绑定）' }, ...state.worldList.map(w => ({ value: w.name, label: w.name }))], {
            onChange: async (v) => { if (!v) delete meta.world_info; save(); await loadRelevantWorlds(); },
        })),
        field('场景覆盖（非空时替换角色卡的场景）', textArea(meta, 'scenario', { rows: 3, onChange: save })),
        h('div', { class: 'kv', style: { marginTop: '10px' } },
            h('span', { class: 'k' }, '聊天'), h('span', {}, state.chat.name),
            h('span', { class: 'k' }, '消息'), h('span', {}, `${state.chat.messages.length} 条`),
            meta.main_chat ? h('span', { class: 'k' }, '分支自') : null, meta.main_chat ? h('span', {}, meta.main_chat) : null,
        ),
    ));
}
