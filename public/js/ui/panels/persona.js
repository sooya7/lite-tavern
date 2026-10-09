// 用户设定（persona）：多个身份，头像、描述、插入位置、绑定世界书
import { h, clear, icon, iconBtn, toast, confirmDialog, pickFiles } from '../dom.js';
import { state, saveSettings, activePersona } from '../../state.js';
import { api } from '../../api.js';
import { loadRelevantWorlds, refresh } from '../../controller.js';
import { uuid } from '../../core/util.js';
import { estimateTokens } from '../../core/tokens.js';
import { field, textInput, textArea, numberInput, select, section } from '../form.js';
import { renderPanels } from './index.js';
import { toPng } from './char.js';

const POSITIONS = [
    { value: 0, label: '跟随预设（用户设定占位）' },
    { value: 2, label: '作者注释之前' },
    { value: 3, label: '作者注释之后' },
    { value: 4, label: '聊天记录中（指定深度）' },
    { value: 9, label: '不发送' },
];

function newPersona(name = 'User') {
    return { id: `p_${uuid().slice(0, 8)}`, name, description: '', position: 0, depth: 2, role: 0, lorebook: '', avatar: '' };
}

export function render(body) {
    const s = state.settings;
    if (!s.personas.length) {
        s.personas.push(newPersona('User'));
        s.activePersona = s.personas[0].id;
        saveSettings();
    }
    const cur = activePersona();
    if (s.activePersona !== cur.id) { s.activePersona = cur.id; saveSettings(); }

    const list = h('div', { class: 'persona-grid' }, s.personas.map(p => h('button', {
        class: `persona-chip ${p.id === cur.id ? 'active' : ''}`,
        title: p.name,
        onclick: async () => {
            s.activePersona = p.id;
            saveSettings();
            await loadRelevantWorlds();
            renderPanels();
            refresh(['chat', 'topbar']);
        },
    },
    p.avatar ? h('img', { class: 'avatar sm', src: api.personaAvatarUrl(p.avatar), alt: '' }) : h('span', { class: 'avatar sm avatar-letter' }, (p.name || '?').slice(0, 1)),
    h('span', { class: 'persona-name' }, p.name || '（无名）'))));
    body.append(section('当前身份',
        list,
        h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', onclick: () => { const p = newPersona('新身份'); s.personas.push(p); s.activePersona = p.id; saveSettings(); renderPanels(); } }, icon('plus'), '新身份'),
            s.personas.length > 1 ? h('button', { class: 'btn small danger', onclick: async () => {
                if (!await confirmDialog(`删除身份「${cur.name}」？`, { danger: true, okLabel: '删除' })) return;
                s.personas = s.personas.filter(p => p.id !== cur.id);
                s.activePersona = s.personas[0].id;
                saveSettings();
                renderPanels();
            } }, icon('trash'), '删除') : null,
        ),
        h('div', { class: 'hint' }, '新消息用当前身份的名字和头像；聊天里的 {{user}} 也跟着变。'),
    ));

    const save = () => saveSettings();
    const tokenEl = h('span', { class: 'muted small' }, `约 ${estimateTokens(cur.description ?? '')} tokens`);
    const depthRow = h('div', { class: 'grid2' },
        field('深度', numberInput(cur, 'depth', { min: 0, onChange: save })),
        field('角色', select(cur, 'role', [{ value: 0, label: 'system' }, { value: 1, label: 'user' }, { value: 2, label: 'assistant' }], { number: true, onChange: save })),
    );
    depthRow.hidden = Number(cur.position) !== 4;
    const avatarImg = cur.avatar ? h('img', { class: 'avatar lg', src: api.personaAvatarUrl(cur.avatar) + `?v=${Date.now()}`, alt: '' }) : h('div', { class: 'avatar lg avatar-letter', style: { fontSize: '36px' } }, (cur.name || '?').slice(0, 1));
    body.append(
        h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '12px', marginBottom: '6px' } },
            h('div', {}, avatarImg, h('button', { class: 'btn small', style: { marginTop: '6px', width: '96px' }, onclick: () => changeAvatar(cur) }, '换头像')),
            h('div', { class: 'grow' }, field('名字', textInput(cur, 'name', { onChange: () => { save(); refresh('topbar'); } })))),
        field(h('span', {}, '设定描述 ', tokenEl), (() => {
            const ta = textArea(cur, 'description', { rows: 8, onChange: save });
            ta.addEventListener('input', () => { tokenEl.textContent = `约 ${estimateTokens(cur.description ?? '')} tokens`; });
            return ta;
        })()),
        field('插入位置', select(cur, 'position', POSITIONS, { number: true, onChange: (v) => { depthRow.hidden = v !== 4; save(); } })),
        depthRow,
        field('绑定世界书（用这个身份时生效）', select(cur, 'lorebook', [{ value: '', label: '（不绑定）' }, ...state.worldList.map(w => ({ value: w.name, label: w.name }))], {
            onChange: async () => { save(); await loadRelevantWorlds(); },
        })),
    );
}

async function changeAvatar(p) {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (!f) return;
    try {
        const blob = await toPng(f, 512);
        const file = `${p.id}.png`;
        await api.savePersonaAvatar(file, blob);
        p.avatar = file;
        saveSettings();
        renderPanels();
        refresh('chat');
        toast('头像已更新', 'success');
    } catch (e) {
        toast(`换头像失败：${e.message}`, 'error');
    }
}

export { clear, iconBtn };
