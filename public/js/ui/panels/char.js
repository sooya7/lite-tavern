// 角色卡编辑
import { h, clear, icon, toast, pickFiles, confirmDialog } from '../dom.js';
import { state, saveCharacter, saveSettings } from '../../state.js';
import { api } from '../../api.js';
import { loadRelevantWorlds, refresh, reloadCharacters } from '../../controller.js';
import { cardTavernHelperScripts } from '../../core/card.js';
import { estimateTokens } from '../../core/tokens.js';
import { field, textInput, textArea, numberInput, select, section, collapsible, pickList } from '../form.js';
import { renderPanels } from './index.js';

export function render(body) {
    if (!state.char) { body.append(h('div', { class: 'empty' }, '先在左边选一个角色')); return; }
    const card = state.char.card;
    const d = card.data;
    const ext = d.extensions ?? (d.extensions = {});
    const save = () => { saveCharacter(); updateTokens(); };
    const tokenEl = h('span', { class: 'muted small' });
    const updateTokens = () => {
        const perm = [d.description, d.personality, d.scenario, d.system_prompt, d.post_history_instructions, ext.depth_prompt?.prompt].map(x => estimateTokens(x ?? '')).reduce((a, b) => a + b, 0);
        tokenEl.textContent = `常驻约 ${perm} tokens · 示例对话约 ${estimateTokens(d.mes_example ?? '')}`;
    };
    updateTokens();

    const avatar = h('img', { class: 'avatar lg', src: api.avatarUrl(state.char.file, state.char.v), alt: '' });
    body.append(h('div', { class: 'row', style: { alignItems: 'flex-start', marginBottom: '10px', gap: '12px' } },
        h('div', { class: 'avatar-col' }, avatar,
            h('button', { class: 'btn small', onclick: () => changeAvatar(avatar) }, '换头像')),
        h('div', { class: 'grow' },
            field('名字', textInput(d, 'name', { onChange: () => { save(); refresh('topbar'); } })),
            h('div', { style: { marginTop: '6px' } }, tokenEl),
            h('div', { class: 'muted small' }, `文件：${state.char.file}`),
        ),
    ));

    body.append(
        field('描述（description）', textArea(d, 'description', { rows: 8, onChange: save })),
        field('开场白（first_mes）', textArea(d, 'first_mes', { rows: 6, onChange: save })),
        greetingsEditor(d, save),
        collapsible('性格 / 场景 / 示例对话', [
            field('性格（personality）', textArea(d, 'personality', { rows: 3, onChange: save })),
            field('场景（scenario）', textArea(d, 'scenario', { rows: 3, onChange: save })),
            field('示例对话（mes_example）', textArea(d, 'mes_example', { rows: 6, code: true, onChange: save }), '每段用 <START> 开头'),
        ]),
        collapsible('角色专属提示词', [
            field('主提示词覆盖（system_prompt）', textArea(d, 'system_prompt', { rows: 3, onChange: save }), '非空时替换预设的主提示词（设置里可关）。可用 {{original}} 引用原内容'),
            field('历史后指令覆盖（post_history_instructions）', textArea(d, 'post_history_instructions', { rows: 3, onChange: save })),
            depthPromptEditor(ext, save),
        ]),
        collapsible('世界书', [worldEditor(d, ext, save)], { open: true }),
        collapsible('标签与作者信息', [
            field('标签（逗号分隔）', tagsInput(d, save)),
            h('div', { class: 'grid2' },
                field('作者', textInput(d, 'creator', { onChange: save })),
                field('版本', textInput(d, 'character_version', { onChange: save })),
            ),
            field('作者备注（creator_notes）', textArea(d, 'creator_notes', { rows: 4, onChange: save })),
        ]),
    );

    const th = cardTavernHelperScripts(card);
    const rx = ext.regex_scripts ?? [];
    if (th.length || rx.length) {
        body.append(section('卡里自带的扩展内容',
            rx.length ? h('div', { class: 'small' }, `局部正则 ${rx.length} 条（在「正则」面板里管理）`) : null,
            th.length ? h('div', { class: 'small' }, `酒馆助手脚本 ${th.length} 个（在「脚本」面板里管理）：${th.map(x => x.name).filter(Boolean).slice(0, 6).join('、')}`) : null,
        ));
    }

    body.append(h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn small', onclick: () => window.open(api.exportCharacterUrl(state.char.file, 'png'), '_blank') }, icon('download'), '导出 PNG'),
        h('button', { class: 'btn small', onclick: () => window.open(api.exportCharacterUrl(state.char.file, 'json'), '_blank') }, icon('download'), '导出 JSON'),
    ));
}

function greetingsEditor(d, save) {
    const wrap = h('div');
    const fill = () => {
        clear(wrap);
        d.alternate_greetings.forEach((g, i) => {
            const obj = { v: g };
            const ta = textArea(obj, 'v', { rows: 3, onChange: (v) => { d.alternate_greetings[i] = v; save(); } });
            wrap.append(h('div', { class: 'greeting' },
                h('div', { class: 'row' }, h('span', { class: 'label grow', style: { margin: '6px 0 2px' } }, `备选开场白 ${i + 1}`),
                    h('button', { class: 'btn small ghost', onclick: async () => {
                        if (!await confirmDialog(`删除备选开场白 ${i + 1}？`)) return;
                        d.alternate_greetings.splice(i, 1);
                        save();
                        fill();
                    } }, icon('trash'))),
                ta));
        });
        wrap.append(h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => { d.alternate_greetings.push(''); save(); fill(); } }, icon('plus'), '加一个备选开场白'));
    };
    fill();
    return h('div', { class: 'field' }, wrap, h('div', { class: 'hint' }, '新开聊天时会作为开场白的几个可滑动版本'));
}

function depthPromptEditor(ext, save) {
    const dp = ext.depth_prompt ?? { prompt: '', depth: 4, role: 'system' };
    const commit = () => { ext.depth_prompt = dp; save(); };
    return h('div', {},
        field('角色注释（depth_prompt，插在聊天记录指定深度）', textArea(dp, 'prompt', { rows: 3, onChange: commit })),
        h('div', { class: 'grid2' },
            field('深度', numberInput(dp, 'depth', { min: 0, onChange: commit })),
            field('角色', select(dp, 'role', [{ value: 'system', label: 'system' }, { value: 'user', label: 'user' }, { value: 'assistant', label: 'assistant' }], { onChange: commit })),
        ),
    );
}

function tagsInput(d, save) {
    const el = h('input', { class: 'input', value: (d.tags ?? []).join(', ') });
    el.addEventListener('input', () => {
        d.tags = el.value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        save();
    });
    return el;
}

function worldEditor(d, ext, save) {
    const s = state.settings;
    const linked = ext.world ?? '';
    const names = state.worldList.map(w => w.name);
    const sel = h('select', { class: 'select' },
        h('option', { value: '' }, '（不绑定）'),
        names.map(n => h('option', { value: n, selected: n === linked }, n)),
        linked && !names.includes(linked) ? h('option', { value: linked, selected: true }, `${linked}（文件不存在）`) : null);
    sel.addEventListener('change', async () => {
        ext.world = sel.value;
        save();
        await loadRelevantWorlds();
        refresh('panels');
    });
    const extra = new Set(s.worldInfo.charLore?.[state.char.id] ?? []);
    const extraBox = pickList(names.filter(n => n !== linked), n => extra.has(n), async (n, on) => {
        if (on) extra.add(n); else extra.delete(n);
        s.worldInfo.charLore = { ...(s.worldInfo.charLore ?? {}), [state.char.id]: [...extra] };
        saveSettings();
        await loadRelevantWorlds();
    }, { noneText: '没有额外的', moreTitle: '其他世界书', unit: '本' });
    const embedded = d.character_book?.entries?.length ?? 0;
    return h('div', {},
        field('绑定的世界书', sel, embedded ? `卡里内嵌了 ${embedded} 条世界书条目；导入时已另存为世界书并绑定。` : '绑定后，这个角色的每个聊天都会用它'),
        names.length > 1 ? field('额外世界书（只对这个角色生效）', extraBox) : null,
        h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => window.dispatchEvent(new CustomEvent('lt:open-panel', { detail: 'world' })) }, icon('book'), '去编辑世界书'),
    );
}

async function changeAvatar(img) {
    const [f] = await pickFiles({ accept: 'image/*' });
    if (!f) return;
    try {
        const blob = await toPng(f);
        await api.setCharacterAvatar(state.char.file, blob);
        state.char.v = Date.now();
        img.src = api.avatarUrl(state.char.file, state.char.v);
        await reloadCharacters();
        refresh(['topbar', 'chat']);
        toast('头像已更新', 'success');
    } catch (e) {
        toast(`换头像失败：${e.message}`, 'error');
    }
}

/** 任意图片 → PNG（最长边不超过 1024，防止卡文件过大） */
export async function toPng(file, maxSide = 1024) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('转换失败'))), 'image/png'));
}

export { renderPanels };
