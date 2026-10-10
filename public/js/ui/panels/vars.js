// 变量面板：MVU 状态（最新楼层）、聊天变量、全局变量；可编辑、可重算
import { h, clear, icon, toast, confirmDialog, modal } from '../dom.js';
import { state, saveChat, saveSettings, eventSource, event_types } from '../../state.js';
import { getSession, refresh } from '../../controller.js';
import { dumpYaml, latestMvuVars, MVU_KEYS } from '../../core/mvu.js';
import { section, collapsible, jsonEditor, field, checkbox, select, textInput, numberInput, textArea } from '../form.js';
import { refreshSnapshots, broadcastEvent } from '../frontend.js';
import { renderPanels, subTabs } from './index.js';
import { redoVarsForMessage, listModelsOf } from '../../generate.js';
import { REQUEST_MODES, compileEntryRegex, hasOverride, getOverride, LORE_LABEL } from '../../core/mvu-extra.js';
import { reprocessLast, reloadInitVars, snapshotFloor, replayFloor, retryExtra, incrementalRepair, clearOldVars, writeOverride } from '../../mvu-ops.js';

// 每栏收起 / 展开的状态，面板重绘时保持（默认收起）
const openFolds = new Set();
function fold(key, title, children, sub) {
    const el = collapsible(title, children, { open: openFolds.has(key), sub });
    el.addEventListener('toggle', () => { if (el.open) openFolds.add(key); else openFolds.delete(key); });
    return el;
}

export function render(body) {
    const session = getSession();
    // 两个小标签：查看变量（折叠的几栏） / MVU 设置（照原版面板的顺序摊开）
    const sub = subTabs.vars === 'mvu' ? 'mvu' : 'view';
    body.append(h('div', { class: 'panel-seg vars-seg' },
        [['view', '查看变量'], ['mvu', 'MVU 设置']].map(([id, label]) => h('button', {
            class: `seg-tab ${id === sub ? 'active' : ''}`, onclick: () => { subTabs.vars = id; renderPanels(); },
        }, label))));
    if (sub === 'mvu') { body.append(...mvuSettingsCards(session)); return; }
    if (!session) { body.append(h('div', { class: 'empty' }, '打开一个聊天后，这里会显示角色状态和变量。')); return; }
    const chat = state.chat.messages;
    const mvuOn = session.mvuEnabled();
    const mode = state.settings.power.mvu ?? 'auto';
    const latest = latestMvuVars(chat);
    let lastAi = chat.length - 1;
    while (lastAi >= 0 && (chat[lastAi].is_user || chat[lastAi].is_system)) lastAi--;

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
                    session.mvuSeparateActive() && lastAi >= 0 ? h('button', { class: 'btn small', onclick: async (ev) => {
                        ev.currentTarget.disabled = true;
                        if (await redoVarsForMessage(lastAi)) toast('已重新更新最后一楼的变量', 'success');
                        renderPanels();
                    } }, icon('refresh'), '让模型重新更新最后一楼') : null,
                ),
            );
        } else {
            mvuBody.push(h('div', { class: 'muted small' }, '还没有变量数据。'),
                h('button', { class: 'btn small', style: { marginTop: '6px' }, onclick: () => { if (session.ensureMvuInit()) { saveChat(); renderPanels(); toast('已用 [initvar] 初始化', 'success'); } else toast('没有可初始化的楼层', 'warning'); } }, '用初始变量初始化'));
        }
    }
    body.append(fold('mvu', '角色状态', mvuBody, !mvuOn ? '未启用' : latest ? `${Object.keys(latest.vars.stat_data ?? {}).length} 项` : '空'));

    // ---------- 聊天 / 全局变量 ----------
    const meta = state.chat.header.chat_metadata;
    body.append(collapsible('本聊天变量', [
        h('div', { class: 'hint' }, '只属于这段对话，卡和脚本用 {{getvar}} / setvar 读写。'),
        jsonEditor(meta.variables ?? {}, async (v) => {
            meta.variables = v;
            session.vars.invalidate();
            saveChat();
            await afterVarsChanged();
            toast('已保存', 'success');
        }),
    ], { sub: `${Object.keys(meta.variables ?? {}).length} 项` }));
    body.append(collapsible('全局变量', [
        h('div', { class: 'hint' }, '所有聊天共用，用 {{getglobalvar}} / setglobalvar 读写。'),
        jsonEditor(state.settings.variables.global ?? {}, async (v) => {
            const g = state.settings.variables.global;
            for (const k of Object.keys(g)) delete g[k];
            Object.assign(g, v);
            session.vars.invalidate();
            saveSettings();
            await afterVarsChanged();
            toast('已保存', 'success');
        }),
    ], { sub: `${Object.keys(state.settings.variables.global ?? {}).length} 项` }));

    const last = chat.length - 1;
    const lastVars = last >= 0 && Array.isArray(chat[last].variables) ? chat[last].variables[chat[last].swipe_id ?? 0] : null;
    const otherKeys = lastVars ? Object.keys(lastVars).filter(k => !MVU_KEYS.includes(k)) : [];
    if (otherKeys.length) {
        body.append(collapsible(`最新楼层的其他变量（#${last}）`, [h('pre', { class: 'var-tree' }, JSON.stringify(Object.fromEntries(otherKeys.map(k => [k, lastVars[k]])), null, 2))]));
    }
}

// ---------- MVU 设置（照原版面板：通知设置 → 变量更新方式 → 修复按钮 → 自动清理变量 → 兼容性 → 角色卡覆盖） ----------

const ALL_CHATS = '对所有聊天生效。';

function badge(text, kind = '') {
    return h('span', { class: `tag accent override-badge ${kind}` }, text);
}

/** 正则输入框：下面实时显示“正则无效” */
function regexInput(obj, key, placeholder, onChange) {
    const err = h('div', { class: 'hint regex-err' });
    const show = () => { const r = compileEntryRegex(obj[key]); err.textContent = r.error ? `正则无效：${r.error}` : ''; };
    const el = textInput(obj, key, { placeholder, onChange: (v) => { show(); onChange?.(v); } });
    show();
    return h('div', {}, el, err);
}

/** 高级参数：可以留空（= 默认） */
function optionalNumber(obj, key, { placeholder = '默认', step = 'any', onChange } = {}) {
    const el = h('input', { class: 'input', type: 'number', step, placeholder, value: obj[key] ?? '' });
    el.addEventListener('input', () => { obj[key] = el.value === '' ? '' : el.value; onChange?.(obj[key]); });
    return el;
}

function foldCard(key, title, ...children) { return fold(key, title, children); }

function mvuSettingsCards(session) {
    const p = state.settings.power;
    const save = () => { saveSettings(); getSession(); };
    const saveAndRender = () => { save(); renderPanels(); };
    const eff = session ? session.mvuSettings() : { ...p };
    const ov = session ? session.mvuOverride() : { draft: {}, error: '', world: null };
    const ovOn = (path) => !ov.error && hasOverride(ov.draft, path);
    const cards = [];

    // ---- 通知设置
    cards.push(foldCard('notify', '通知设置',
        h('div', { class: 'hint' }, ALL_CHATS),
        checkbox(p, 'mvuNotifyLoaded', 'MVU 加载成功时通知', { onChange: save }),
        checkbox(p, 'mvuNotifyInit', '变量初始化成功时通知', { onChange: save }),
        checkbox(p, 'mvuNotifyError', '变量初始化/更新出错时通知', { onChange: save }),
        checkbox(p, 'mvuNotifyExtra', '额外模型解析中通知', { onChange: save }),
    ));

    // ---- 变量更新方式
    const m = { v: p.mvuSeparate ? 'extra' : 'ai' };
    const methodTitle = h('div', { class: 'card-title' }, '变量更新方式',
        ovOn('更新方式') ? badge(`角色卡覆盖：${eff.mvuSeparate ? '额外模型解析' : '随 AI 输出'}`) : null);
    const upd = h('div', { class: 'card' }, methodTitle,
        select(m, 'v', [
            { value: 'ai', label: '随 AI 输出' },
            { value: 'extra', label: '额外模型解析' },
        ], { onChange: (v) => { p.mvuSeparate = v === 'extra'; saveAndRender(); } }),
        h('div', { class: 'hint' }, (p.mvuSeparate ? '正文写完后另请求一次模型更新变量。' : '模型写正文时顺带更新变量。') + ALL_CHATS),
    );
    const extraOn = p.mvuSeparate || eff.mvuSeparate;
    if (extraOn && session && eff.mvuSeparate) {
        const bad = session.mvuUnsupportedWorlds();
        if (bad.length) upd.append(h('div', { class: 'note info mvu-unsupported' }, `世界书 [${bad.join(', ')}] 没适配，只发给写正文的模型。`));
    }
    if (extraOn) {
        // 不常用的几块折起来，点开才显示
        const part = (key, title) => { const b = h('div'); upd.append(fold(key, title, [b])); return b; };
        // 请求内容
        const mode = p.mvuPromptMode || 'builtin';
        const rc = part('rc', '请求内容');
        rc.append(field('请求内容', select(p, 'mvuPromptMode', [
                { value: 'builtin', label: '内置' },
                { value: 'preset', label: '使用当前预设' },
                { value: 'other', label: '使用其他预设' },
            ], { onChange: saveAndRender })));
        if (mode === 'other') {
            const names = state.presetList.map(x => x.name);
            rc.append(field('其他预设', names.length
                ? select(p, 'mvuOtherPreset', [{ value: '', label: '（选一个预设）' }, ...names.map(n => ({ value: n, label: n }))], { onChange: save })
                : h('div', { class: 'muted small' }, '还没有保存的预设')));
        }
        if (mode === 'builtin') {
            rc.append(
                field('开头提示词（可选）', textArea(p, 'mvuHeadPrompt', { rows: 2, onChange: save })),
                field('结尾提示词（可选）', textArea(p, 'mvuTailPrompt', { rows: 2, onChange: save })),
            );
        }
        rc.append(
            field('聊天历史条数', numberInput(p, 'mvuHistory', { min: 0, max: 100, onChange: save, placeholder: '2' })),
            checkbox(p, 'mvuSchema', '要求结构化输出（JSON），接口不支持时自动退回普通文本', { onChange: save }),
            field(h('span', {}, '世界书条目白名单正则 ', ovOn('额外模型解析配置.世界书条目白名单正则') ? badge('角色卡规则叠加') : null),
                regexInput(p, 'mvuWhitelist', '角色|地点 或 /角色|地点/i', save),
                '只保留条目名能匹配的条目，留空不启用。'),
            field(h('span', {}, '世界书条目黑名单正则 ', ovOn('额外模型解析配置.世界书条目黑名单正则') ? badge('角色卡规则叠加') : null),
                regexInput(p, 'mvuBlacklist', '临时|禁用 或 /临时|禁用/i', save),
                '去掉条目名能匹配的条目，留空不启用。'),
            h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: showFiltered }, '上次分析被筛选的条目')),
        );
        // 请求策略
        part('rs', '请求策略').append(
            field('请求方式', select(p, 'mvuRequestMode', REQUEST_MODES, { onChange: save })),
            field('请求次数', numberInput(p, 'mvuRequestCount', { min: 1, max: 10, onChange: save, placeholder: '3' })),
        );
        // 模型来源
        const conn = () => state.settings.connections.find(c => c.id === p.mvuConnection) ?? null;
        const dl = h('datalist', { id: 'mvu-model-list' });
        const getBtn = h('button', { class: 'btn small', onclick: async () => {
            getBtn.disabled = true;
            try {
                const c = conn();
                const list = await listModelsOf(c ? { proxy_preset: c.name } : {});
                clear(dl); dl.append(...list.map(x => h('option', { value: x })));
                toast(`拿到 ${list.length} 个模型`, 'success');
            } catch (e) { toast(e.message, 'error'); }
            finally { getBtn.disabled = false; }
        } }, icon('refresh'), '获取');
        upd.append(h('div', { class: 'section-head card-sub' }, '模型来源'),
            field('模型来源', select(p, 'mvuConnection', [
                { value: '', label: '与当前连接相同' },
                ...state.settings.connections.map(c => ({ value: c.id, label: c.name || c.model || c.id })),
            ], { onChange: save })),
            field('模型名称（留空用连接里的）', h('div', { class: 'row' },
                h('div', { class: 'grow' }, textInput(p, 'mvuModel', { placeholder: '例如 gemini-2.5-flash', onChange: save, list: 'mvu-model-list' })),
                getBtn, dl)),
        );
        upd.append(h('div', { class: 'row wrap' }, checkbox(p, 'mvuAuto', '自动请求', { onChange: save }),
                ovOn('额外模型解析配置.启用自动请求') ? badge(`角色卡覆盖：${eff.mvuAuto ? '开' : '关'}`) : null),
            h('div', { class: 'hint' }, '关掉后要手动点“重试额外模型解析”。'));
        // 高级参数
        part('adv', '高级参数').append(
            h('div', { class: 'hint' }, '留空用默认值。'),
            h('div', { class: 'param-grid' },
                field('最大回复 token', optionalNumber(p, 'mvuMaxTokens', { step: 1, onChange: save })),
                field('温度', optionalNumber(p, 'mvuTemperature', { onChange: save })),
                field('频率惩罚', optionalNumber(p, 'mvuFreqPenalty', { onChange: save })),
                field('存在惩罚', optionalNumber(p, 'mvuPresPenalty', { onChange: save })),
                field('Top P', optionalNumber(p, 'mvuTopP', { onChange: save })),
                field('Top K', optionalNumber(p, 'mvuTopK', { step: 1, onChange: save })),
            ),
        );
    }
    cards.push(upd);

    // ---- 修复按钮
    const run = (fn) => async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        try { await fn(); } catch (e) { toast(String(e?.message ?? e), 'error'); } finally { b.disabled = false; }
    };
    cards.push(section('修复按钮',
        h('div', { class: 'hint' }, session ? '对当前聊天操作。' : '先打开一个聊天。'),
        h('div', { class: 'row wrap mvu-fix-buttons' },
            h('button', { class: 'btn small', disabled: !session, onclick: run(reprocessLast) }, '重新处理变量'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(reloadInitVars) }, '重新读取初始变量'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(snapshotFloor) }, '快照楼层'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(replayFloor) }, '重演楼层'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(retryExtra) }, '重试额外模型解析'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(incrementalRepair) }, '增量校正额外模型解析'),
            h('button', { class: 'btn small', disabled: !session, onclick: run(clearOldVars) }, '清除旧楼层变量'),
        ),
    ));

    // ---- 自动清理变量
    cards.push(foldCard('cleanup', '自动清理变量',
        h('div', { class: 'hint' }, `删掉老楼层的变量，让聊天文件变小。${ALL_CHATS}`),
        checkbox(p, 'mvuCleanup', '启用自动清理变量', { onChange: saveAndRender }),
        ...(p.mvuCleanup ? [
            field('快照保留间隔', numberInput(p, 'mvuSnapshotInterval', { min: 1, onChange: save, placeholder: '50' })),
            field('要保留变量的最近楼层数', numberInput(p, 'mvuKeepRecent', { min: 1, onChange: save, placeholder: '20' })),
            field('触发恢复变量的最近楼层数', numberInput(p, 'mvuRestoreRecent', { min: 1, onChange: save, placeholder: '10' })),
        ] : []),
    ));

    // ---- 兼容性
    cards.push(foldCard('compat', '兼容性',
        h('div', { class: 'row wrap' }, checkbox(p, 'mvuChatVars', '变量更新到聊天变量', { onChange: save }),
            ovOn('兼容性.更新到聊天变量') ? badge(`角色卡覆盖：${eff.mvuChatVars ? '开' : '关'}`) : null),
        h('div', { class: 'hint' }, `老角色卡玩不了时打开。${ALL_CHATS}`),
    ));

    // ---- 角色卡覆盖
    cards.push(overrideCard(session, ov));
    return cards;
}

function overrideCard(session, ov) {
    const INHERIT = '__inherit__';
    const active = !ov.error && ['更新方式', '额外模型解析配置.启用自动请求', '兼容性.更新到聊天变量', '额外模型解析配置.世界书条目白名单正则', '额外模型解析配置.世界书条目黑名单正则'].some(x => hasOverride(ov.draft, x));
    const box = h('div', { class: 'override-body' });
    const wrap = fold('override', '角色卡覆盖', [box], active ? '覆盖中' : '未启用');
    box.append(h('div', { class: 'hint' }, '只对当前角色卡生效，和原版 MVU 存在同一位置。'));
    if (!session) { box.append(h('div', { class: 'muted small' }, '先打开一个聊天。')); return wrap; }
    const pw = session.primaryWorld();
    const editable = !!pw && pw.kind !== 'missing';
    box.append(field('角色世界书', h('div', { class: 'muted' }, pw ? `${pw.world}${pw.kind === 'embedded' ? '（卡里内嵌）' : pw.kind === 'missing' ? '（没找到这本世界书）' : ''}` : '未绑定')));
    if (ov.error) box.append(h('div', { class: 'note warn' }, `[config_override] 条目的内容不是有效的 JSON，先当作没有覆盖：${ov.error}`));
    const draft = ov.error ? {} : ov.draft;
    const set = (path, value) => {
        try { writeOverride(path, value); getSession(); renderPanels(); } catch (e) { toast(e.message, 'error'); }
    };
    const boolSel = (path) => {
        const v = getOverride(draft, path);
        const o = { v: typeof v === 'boolean' ? String(v) : INHERIT };
        const el = select(o, 'v', [{ value: INHERIT, label: '跟随用户配置' }, { value: 'true', label: '开' }, { value: 'false', label: '关' }],
            { onChange: (x) => set(path, x === INHERIT ? undefined : x === 'true') });
        el.disabled = !editable;
        return el;
    };
    const mo = { v: ['随AI输出', '额外模型解析'].includes(getOverride(draft, '更新方式')) ? getOverride(draft, '更新方式') : INHERIT };
    const methodSel = select(mo, 'v', [{ value: INHERIT, label: '跟随用户配置' }, { value: '随AI输出', label: '随 AI 输出' }, { value: '额外模型解析', label: '额外模型解析' }],
        { onChange: (x) => set('更新方式', x === INHERIT ? undefined : x) });
    methodSel.disabled = !editable;
    const rx = (path, placeholder) => {
        const o = { v: getOverride(draft, path) ?? '' };
        const err = h('div', { class: 'hint regex-err' });
        let t = null;
        const el = textInput(o, 'v', { placeholder, onChange: (v) => {
            const r = compileEntryRegex(v);
            err.textContent = r.error ? `角色卡配置正则无效：${r.error}` : '';
            clearTimeout(t);
            // 打字时不每个键都写世界书，停一下再存；存的时候不重绘面板，免得输入框丢焦点
            t = setTimeout(() => { try { writeOverride(path, v); getSession(); } catch (e) { toast(e.message, 'error'); } }, 400);
        } });
        el.disabled = !editable;
        return h('div', {}, el, err);
    };
    box.append(
        field('变量更新方式（角色卡）', methodSel),
        field('自动请求（角色卡）', boolSel('额外模型解析配置.启用自动请求')),
        field('角色卡世界书条目白名单正则', rx('额外模型解析配置.世界书条目白名单正则', '角色|地点 或 /角色|地点/i'), '和上面的白名单叠加。'),
        field('角色卡世界书条目黑名单正则', rx('额外模型解析配置.世界书条目黑名单正则', '临时|禁用 或 /临时|禁用/i'), '和上面的黑名单叠加。'),
        field('变量更新到聊天变量（角色卡）', boolSel('兼容性.更新到聊天变量')),
    );
    return wrap;
}

/** 上次分析被筛选的条目 */
function showFiltered() {
    const r = state.mvuLastFilter;
    const list = r?.filtered ?? [];
    const body = list.length
        ? h('div', { class: 'filtered-table-wrap' }, h('table', { class: 'filtered-table' },
            h('thead', {}, h('tr', {}, ['条目来源', '世界书', '原因', '配置来源', '条目备注'].map(t => h('th', {}, t)))),
            h('tbody', {}, list.map(e => h('tr', {},
                h('td', {}, LORE_LABEL[e.lore] ?? e.lore), h('td', {}, e.world), h('td', {}, e.reason),
                h('td', {}, (e.sources ?? []).join('、') || '—'), h('td', { class: 'break' }, e.comment)))))
        )
        : h('div', { class: 'muted' }, r ? '上次分析没有被黑 / 白名单筛掉的条目。' : '这次打开页面后还没做过额外模型解析。');
    modal({ title: '上次分析被筛选的条目', wide: true, body, actions: [{ label: '关闭', value: true, primary: true }] });
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
