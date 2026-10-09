// 变量面板：MVU 状态（最新楼层）、聊天变量、全局变量；可编辑、可重算
import { h, clear, icon, toast, confirmDialog, modal } from '../dom.js';
import { state, saveChat, saveSettings, eventSource, event_types } from '../../state.js';
import { getSession, refresh } from '../../controller.js';
import { dumpYaml, latestMvuVars, MVU_KEYS } from '../../core/mvu.js';
import { section, collapsible, jsonEditor } from '../form.js';
import { refreshSnapshots, broadcastEvent } from '../frontend.js';
import { renderPanels } from './index.js';

export function render(body) {
    const session = getSession();
    if (!session) { body.append(h('div', { class: 'empty' }, '先打开一个聊天')); return; }
    const chat = state.chat.messages;
    const mvuOn = session.mvuEnabled();
    const mode = state.settings.power.mvu ?? 'auto';
    const latest = latestMvuVars(chat);

    // ---------- MVU ----------
    const mvuHead = h('div', { class: 'row', style: { marginBottom: '6px' } },
        h('span', { class: `tag ${mvuOn ? 'ok' : ''}` }, mvuOn ? 'MVU 已启用' : 'MVU 未启用'),
        h('span', { class: 'muted small grow' }, mode === 'auto' ? '（自动检测：卡/预设引用了 MagVarUpdate 或世界书有 [initvar] 条目）' : mode === 'on' ? '（设置里强制开启）' : '（设置里关闭）'),
    );
    const mvuBody = [mvuHead];
    if (mvuOn) {
        if (latest) {
            const v = latest.vars;
            const deltaKeys = Object.keys(v.delta_data ?? {});
            mvuBody.push(
                h('div', { class: 'muted small', style: { marginBottom: '4px' } }, `来自第 #${latest.index} 层${deltaKeys.length ? `，本层改了 ${deltaKeys.length} 处` : ''}`),
                h('pre', { class: 'var-tree' }, dumpYaml(v.stat_data ?? {}).trimEnd() || '（空）'),
                deltaKeys.length ? collapsible('本层变化', [h('pre', { class: 'var-tree' }, deltaKeys.map(k => {
                    const [a, b] = v.delta_data[k];
                    return `${k}: ${fmt(a)} → ${fmt(b)}`;
                }).join('\n'))], { open: true }) : null,
                h('div', { class: 'row wrap', style: { marginTop: '8px' } },
                    h('button', { class: 'btn small', onclick: () => editStatData(latest.index) }, icon('edit'), '编辑这层的变量'),
                    h('button', { class: 'btn small', onclick: recomputeAll }, icon('refresh'), '从头重算所有楼层'),
                ),
            );
        } else {
            mvuBody.push(h('div', { class: 'muted small' }, '还没有变量数据。'),
                h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => { if (session.ensureMvuInit()) { saveChat(); renderPanels(); toast('已用 [initvar] 初始化', 'success'); } else toast('没有可初始化的楼层', 'warning'); } }, '用初始变量初始化'));
        }
    }
    body.append(section('MVU 变量', ...mvuBody));

    // ---------- 聊天 / 全局变量 ----------
    const meta = state.chat.header.chat_metadata;
    body.append(collapsible('聊天变量（{{getvar}} / setvar）', [
        jsonEditor(meta.variables ?? {}, async (v) => {
            meta.variables = v;
            session.vars.invalidate();
            saveChat();
            await afterVarsChanged();
            toast('已保存', 'success');
        }),
    ], { sub: `${Object.keys(meta.variables ?? {}).length} 个` }));
    body.append(collapsible('全局变量（{{getglobalvar}}）', [
        jsonEditor(state.settings.variables.global ?? {}, async (v) => {
            const g = state.settings.variables.global;
            for (const k of Object.keys(g)) delete g[k];
            Object.assign(g, v);
            session.vars.invalidate();
            saveSettings();
            await afterVarsChanged();
            toast('已保存', 'success');
        }),
    ], { sub: `${Object.keys(state.settings.variables.global ?? {}).length} 个` }));

    const last = chat.length - 1;
    const lastVars = last >= 0 && Array.isArray(chat[last].variables) ? chat[last].variables[chat[last].swipe_id ?? 0] : null;
    const otherKeys = lastVars ? Object.keys(lastVars).filter(k => !MVU_KEYS.includes(k)) : [];
    if (otherKeys.length) {
        body.append(collapsible(`最新楼层的其他变量（#${last}）`, [h('pre', { class: 'var-tree' }, JSON.stringify(Object.fromEntries(otherKeys.map(k => [k, lastVars[k]])), null, 2))]));
    }
}

function fmt(v) {
    if (v === undefined) return '（无）';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

async function afterVarsChanged() {
    await eventSource.emit(event_types.VARIABLES_UPDATED);
    refreshSnapshots();
    broadcastEvent('mag_variable_update_ended');
    refresh('chat');
}

function editStatData(index) {
    const m = state.chat.messages[index];
    const sw = m.swipe_id ?? 0;
    const cur = m.variables?.[sw]?.stat_data ?? {};
    const box = h('div');
    const ed = jsonEditor(cur, async (v) => {
        m.variables[sw] = { ...(m.variables[sw] ?? {}), stat_data: v, display_data: v, delta_data: {} };
        getSession()?.vars.invalidate();
        saveChat();
        await afterVarsChanged();
        dlg.close();
        renderPanels();
        toast('已保存', 'success');
    }, { rows: 22 });
    box.append(h('div', { class: 'hint', style: { marginBottom: '6px' } }, `改的是第 #${index} 层（当前回复版本）的 stat_data。后面的楼层不会自动跟着变，必要时用“从头重算”。`), ed);
    const dlg = modal({ title: '编辑变量', wide: true, body: box });
}

async function recomputeAll() {
    const ok = await confirmDialog('按 [initvar] 初始值和每条 AI 回复里的更新命令，从第一层开始重算所有楼层（只算当前显示的回复版本）。\n手动改过的变量会被覆盖。继续？', { okLabel: '重算' });
    if (!ok) return;
    const session = getSession();
    const chat = state.chat.messages;
    for (const m of chat) {
        if (!Array.isArray(m.variables)) continue;
        for (const v of m.variables) if (v && typeof v === 'object') for (const k of MVU_KEYS) delete v[k];
    }
    session.vars.invalidate();
    session.ensureMvuInit();
    let errors = 0;
    for (let i = 1; i < chat.length; i++) {
        if (chat[i].is_user) continue;
        const r = session.applyMvu(i);
        errors += r?.errors?.length ?? 0;
    }
    saveChat();
    await afterVarsChanged();
    renderPanels();
    toast(`重算完成${errors ? `，有 ${errors} 处命令没执行成功` : ''}`, errors ? 'warning' : 'success');
}

export { clear };
