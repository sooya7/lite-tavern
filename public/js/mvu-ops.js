// MVU 的应用层操作：修复按钮、增量校正、角色卡覆盖的保存、通知、删楼层后恢复变量、聊天变量的清理。
// 语义照 MagVarUpdate 的 button.ts / incremental_repair.ts / character_override / cleanup（MIT），代码自己写。
import { state, saveChat, saveWorld, saveCharacter, eventSource, event_types, mvuEmitter } from './state.js';
import { getSession, refresh } from './controller.js';
import { latestMvuVars, collectInitVars } from './core/mvu.js';
import { setOverride, serializeOverride, isOverrideEntry, OVERRIDE_ENTRY_NAME, buildRepairTask, buildRepairTail, collectStateChanges, planRepair } from './core/mvu-extra.js';
import { markSnapshot, replayRange, clearOldFloors, restoreVariables, mergeInitVars, mirrorToChatVars, removeMirroredChatVars, CLEAN_KEYS } from './core/mvu-cleanup.js';
import { newWorldInfoEntry } from './core/worldinfo.js';
import { syncSwipe } from './core/chat.js';
import { clone, debounce } from './core/util.js';
import { h, toast, modal, promptDialog } from './ui/dom.js';
import { redoVarsForMessage, requestVarUpdate } from './generate.js';
import { refreshSnapshots, broadcastEvent } from './ui/frontend.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sid = (m) => m?.swipe_id ?? 0;
const omit = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !keys.includes(k)));

async function afterChange(index) {
    const session = getSession();
    session?.vars.invalidate();
    saveChat();
    await eventSource.emit(event_types.VARIABLES_UPDATED);
    refreshSnapshots();
    broadcastEvent('mag_variable_update_ended');
    if (index !== undefined) await eventSource.emit(event_types.MESSAGE_UPDATED, index);
    refresh(['chat', 'panels']);
}

function lastAiIndex(chat) {
    let i = chat.length - 1;
    while (i >= 0 && (chat[i].is_user || chat[i].is_system)) i--;
    return i;
}

async function askFloor(message, def) {
    const r = await promptDialog(message, String(def), { title: '选择楼层' });
    if (r === null || r === undefined || String(r).trim() === '') return null;
    const n = parseInt(r, 10);
    if (Number.isNaN(n)) { toast(`请输入有效的楼层号，你输入的是“${r}”`, 'error'); return null; }
    return n;
}

// ---------- 修复按钮 ----------

/** 重新处理变量：把最后一楼的变量去掉，按上一楼的变量 + 这一楼的更新命令重新算 */
export async function reprocessLast() {
    const session = getSession();
    if (!session) return;
    const chat = session.chat;
    const last = chat.length - 1;
    if (last < 1) { toast('还没有可以处理的楼层', 'info'); return; }
    const m = chat[last];
    if (m.is_user) { toast('最后一楼是你发的消息，没有变量要处理', 'info'); return; }
    if (Array.isArray(m.variables) && m.variables[sid(m)]) m.variables[sid(m)] = omit(m.variables[sid(m)], [...CLEAN_KEYS]);
    session.vars.invalidate();
    const r = await session.applyMvuAsync(last, mvuEmitter());
    if (r?.errors?.length && session.mvuSettings().mvuNotifyError) toast(`变量更新有 ${r.errors.length} 处没执行：${String(r.errors[0]).split('\n')[0]}`, 'warning');
    await afterChange(last);
    toast('已重新处理最后一楼的变量', 'success');
}

/** 重新读取初始变量：用 [initvar] 的最新内容补上新字段、更新描述，写到最后一楼 */
export async function reloadInitVars() {
    const session = getSession();
    if (!session) return;
    const init = collectInitVars(session.allWorldEntries());
    if (!Object.keys(init).length) { toast('没有找到 [initvar] 初始变量', 'error'); return; }
    const chat = session.chat;
    const last = chat.length - 1;
    const latest = latestMvuVars(chat);
    if (last < 0 || !latest) { toast('没有找到带变量的楼层', 'error'); return; }
    const merged = mergeInitVars(init, latest.vars.stat_data);
    const m = chat[last];
    if (!Array.isArray(m.variables)) m.variables = [];
    m.variables[sid(m)] = { ...(m.variables[sid(m)] ?? {}), ...clone(latest.vars), stat_data: merged, display_data: clone(merged), delta_data: clone(latest.vars.delta_data ?? {}) };
    if (session.mvuSettings().mvuChatVars) mirrorToChatVars(session.meta, m.variables[sid(m)]);
    await afterChange(last);
    toast('已按初始变量补上新字段并更新描述', 'success');
}

/** 快照楼层：标记后清理时不会去掉这一层的变量，重演也可以从这层开始 */
export async function snapshotFloor() {
    const session = getSession();
    if (!session) return;
    const id = await askFloor('设成快照的楼层，清理时会保留它的变量，之后重演可以从这一层开始。填楼层号（例如 10）：', 10);
    if (id === null) return;
    if (!session.chat[id]) { toast(`没有第 ${id} 层`, 'error'); return; }
    if (!markSnapshot(session.chat, id)) { toast(`第 ${id} 层没有变量，没法设成快照`, 'warning'); return; }
    saveChat();
    toast(`已把第 ${id} 层设成快照楼层`, 'success');
}

/** 重演楼层：从某一层的变量开始，把后面的回复依次重算到指定楼层 */
export async function replayFloor() {
    const session = getSession();
    if (!session) return;
    const chat = session.chat;
    let end = await askFloor('变量出了问题的楼层（-1 表示最新一层）：', -1);
    if (end === null) return;
    if (end === -1) end = chat.length - 1;
    if (!chat[end]) { toast(`没有第 ${end} 层`, 'error'); return; }
    const found = latestMvuVars(chat, end - 1);
    if (!found) { toast('前面找不到带变量的楼层，没法重演', 'error'); return; }
    const start = await askFloor(`从哪一层开始重演？离得最近的、带变量的楼层是第 ${found.index} 层。`, found.index);
    if (start === null) return;
    const base = chat[start];
    const baseVars = Array.isArray(base?.variables) ? base.variables[sid(base)] : null;
    if (!baseVars?.stat_data) { toast(`第 ${start} 层没有变量，请换一层`, 'error'); return; }
    if (start >= end) { toast('开始的楼层要在出问题的楼层之前', 'error'); return; }
    const r = replayRange(chat, start, end, baseVars);
    const m = chat[end];
    if (!Array.isArray(m.variables)) m.variables = [];
    m.variables[sid(m)] = { ...omit(m.variables[sid(m)], CLEAN_KEYS), ...r.variables };
    await afterChange(end);
    toast(`已重演到第 ${end} 层，共重算 ${r.count} 楼${r.errors.length ? `，有 ${r.errors.length} 处命令没执行` : ''}`, r.errors.length ? 'warning' : 'success');
}

/** 重试额外模型解析：对某一楼（默认最后一条回复）重新请求模型更新变量 */
export async function retryExtra() {
    const session = getSession();
    if (!session) return;
    if (!session.mvuSeparateActive()) { toast('现在没有启用“额外模型解析”，不需要这样做', 'info'); return; }
    const chat = session.chat;
    const def = lastAiIndex(chat);
    if (def < 1) { toast('还没有可以解析的回复', 'info'); return; }
    const id = await askFloor('重新解析哪一楼？默认是最后一条回复。改中间的楼层时，后面的楼层不会自动跟着变。', def);
    if (id === null) return;
    const m = chat[id];
    if (!m || m.is_user || m.is_system || id < 1) { toast(`第 ${id} 层不是 AI 回复`, 'error'); return; }
    if (await redoVarsForMessage(id)) {
        await afterChange(id);
        toast('解析完成', 'success');
    }
}

/** 清除旧楼层变量：保留最后几楼，其余楼层每隔“快照保留间隔”留一层 */
export async function clearOldVars() {
    const session = getSession();
    if (!session) return;
    const interval = Number(session.mvuSettings().mvuSnapshotInterval) || 50;
    const depth = await askFloor(`清除旧楼层的变量，聊天文件会变小。要保留变量的最近楼层数（例如 10 = 保留最后 10 层；更早的楼层每 ${interval} 层留一层快照）。之后想回到没保留变量的楼层，需要用“重演楼层”：`, 10);
    if (depth === null) return;
    const n = clearOldFloors(session.chat, Math.max(0, depth), interval);
    session.vars.invalidate();
    saveChat();
    toast(`已清理 ${n} 层的旧变量，保留了最后 ${depth} 层`, 'success');
}

// ---------- 增量校正 ----------

let repairing = false;

/**
 * 增量校正额外模型解析（最后一楼）：可选写一个方向 → 以现在的变量为准请求校正 → 预览变化 → 确认后并进正文并重算这一楼。
 * 等待期间聊天、楼层、回复版本或变量变了，结果作废。应用后提示里有“撤销”。
 */
export async function incrementalRepair() {
    if (repairing) { toast('已经有一次增量校正在进行', 'info'); return; }
    const session = getSession();
    if (!session) return;
    if (!session.mvuSeparateActive()) { toast('现在没有启用“额外模型解析”，不需要这样做', 'info'); return; }
    const chat = session.chat;
    const idx = chat.length - 1;
    const m = chat[idx];
    const s = sid(m);
    const cur = Array.isArray(m?.variables) ? m.variables[s] : null;
    const prev = latestMvuVars(chat, idx - 1);
    if (idx < 1 || !m || m.is_user || !cur?.stat_data || !prev) { toast('最新一楼或上一楼没有可用的变量，没法增量校正', 'warning'); return; }
    const anchor = { chatObj: state.chat, len: chat.length, mes: m.mes, stat: JSON.stringify(cur.stat_data) };
    const still = () => state.chat === anchor.chatObj && state.chat?.messages === chat && chat.length === anchor.len && chat[idx] === m
        && sid(m) === s && m.mes === anchor.mes && JSON.stringify(m.variables?.[s]?.stat_data) === anchor.stat;
    const changed = '等待期间聊天、楼层、回复版本或变量变了，这次结果作废';

    const direction = await promptDialog('可选：写下这次要重点核对什么；留空就让模型自己检查遗漏和明显的错误。\n例如：核对生命值归零后的后果，或补上这一轮明确拿到的物品。', '', { title: '增量校正', multiline: true });
    if (direction === null) return;
    if (!still()) { toast(changed, 'warning'); return; }
    const changes = collectStateChanges(prev.vars.stat_data, cur.stat_data);
    repairing = true;
    let block;
    try {
        block = await requestVarUpdate(session, idx, {
            task: (schema) => buildRepairTask(changes, { schema }),
            userInput: buildRepairTail(direction),
            statData: cur.stat_data,
            statLabel: '现在的变量（本楼原有的更新已经执行完）',
            keepBlocks: true,
            validate: (b) => {
                if (!still()) throw new Error(changed);
                const p = planRepair(prev.vars, cur, anchor.mes, b);
                if (p.errors.length) throw new Error(p.errors.join('\n'));
                if (same(p.variables.stat_data, cur.stat_data)) throw new Error('校正没有带来实际变化');
            },
        });
    } catch (e) {
        toast(`增量校正没成功，变量没改：${String(e?.message ?? e).split('\n')[0]}`, 'error');
        return;
    } finally {
        repairing = false;
    }
    if (!still()) { toast(changed, 'warning'); return; }
    const plan = planRepair(prev.vars, cur, anchor.mes, block);
    if (plan.errors.length) { toast(`整楼重算失败，没有提交：${plan.errors[0]}`, 'error'); return; }
    if (same(plan.variables.stat_data, cur.stat_data)) { toast('校正没有带来实际变化，正文和变量都没改', 'info'); return; }

    const fmt = (v) => (v === undefined ? '（无）' : JSON.stringify(v));
    const body = h('div', { class: 'repair-preview' },
        h('div', { class: 'muted small' }, `模型提出 ${plan.commands.length} 项修正。确认后把它并进本楼的更新块，并从上一楼的变量重算本楼，正文和变量一起保存。`),
        h('div', { class: 'label', style: { marginTop: '10px' } }, '变量会这样变'),
        h('ul', { class: 'repair-diff' }, plan.changes.map(c => h('li', {}, h('code', {}, c.path), ' ', fmt(c.before), ' → ', h('b', {}, fmt(c.after))))),
        h('details', { style: { marginTop: '8px' } }, h('summary', {}, '查看原始补丁'), h('pre', { class: 'var-tree' }, block)),
    );
    const ok = await modal({ title: '增量校正预览', wide: true, body, actions: [{ label: '取消', value: false }, { label: '应用修正', value: true, primary: true }] }).done;
    if (!ok) return;
    if (!still()) { toast(changed, 'warning'); return; }

    const before = { mes: m.mes, swipes: Array.isArray(m.swipes) ? [...m.swipes] : undefined, vars: clone(cur), meta: clone(session.meta?.variables ?? {}) };
    m.mes = plan.content;
    if (Array.isArray(m.swipes)) syncSwipe(m);
    m.variables[s] = { ...omit(cur, CLEAN_KEYS), ...plan.variables };
    const mirror = session.mvuSettings().mvuChatVars;
    if (mirror) mirrorToChatVars(session.meta, m.variables[s]);
    await afterChange(idx);
    const applied = { mes: m.mes, stat: JSON.stringify(m.variables[s].stat_data) };
    toast('增量校正已应用并写回正文', 'success', 12000, {
        action: {
            label: '撤销',
            onClick: async () => {
                if (state.chat !== anchor.chatObj || chat[idx] !== m || sid(m) !== s || m.mes !== applied.mes || JSON.stringify(m.variables?.[s]?.stat_data) !== applied.stat) {
                    toast('校正之后变量或回复又变了，为了不覆盖新进度，不能直接撤销', 'warning');
                    return;
                }
                m.mes = before.mes;
                if (before.swipes) m.swipes = before.swipes;
                m.variables[s] = before.vars;
                if (mirror && session.meta) session.meta.variables = before.meta;
                await afterChange(idx);
                toast('已撤销这次增量校正', 'info');
            },
        },
    });
}

// ---------- 角色卡覆盖 ----------

/**
 * 改一项角色卡覆盖并存回角色主世界书的 [config_override] 条目（关闭状态，内容是 JSON，和原版 MVU 同一个位置）。
 * 绑定的世界书文件 → 存世界书；卡里内嵌的世界书 → 存角色卡。
 */
export function writeOverride(path, value) {
    const session = getSession();
    if (!session) throw new Error('先打开一个聊天');
    const pw = session.primaryWorld();
    if (!pw || pw.kind === 'missing') throw new Error('这张卡没有角色世界书，没法保存角色卡配置');
    const ov = session.mvuOverride();
    const draft = setOverride(ov.error ? {} : ov.draft, path, value);
    const content = serializeOverride(draft);
    if (pw.kind === 'linked') {
        const world = state.worlds[pw.world];
        const entries = world.entries ?? (world.entries = {});
        const hit = Object.values(entries).find(isOverrideEntry);
        if (hit) hit.content = content;
        else {
            const uid = Math.max(-1, ...Object.values(entries).map(e => Number(e.uid) || 0)) + 1;
            entries[uid] = newWorldInfoEntry(uid, { comment: OVERRIDE_ENTRY_NAME, content, disable: true, key: [], addMemo: true });
        }
        saveWorld(pw.world);
    } else {
        const book = state.char.card.data.character_book;
        const hit = (book.entries ?? []).find(e => isOverrideEntry(e));
        if (hit) hit.content = content;
        else {
            const id = Math.max(-1, ...book.entries.map(e => Number(e.id) || 0)) + 1;
            book.entries.push({ id, keys: [], secondary_keys: [], comment: OVERRIDE_ENTRY_NAME, name: OVERRIDE_ENTRY_NAME, content, enabled: false, constant: false, selective: false, insertion_order: 100, position: 'after_char', extensions: {} });
        }
        saveCharacter();
    }
    session.vars.invalidate();
    return draft;
}

// ---------- 事件：通知、聊天变量、删楼层后恢复 ----------

let loadedShown = false;
const initShown = new Set();

function onChatOpened() {
    const session = getSession();
    if (!session || !session.mvuEnabled()) return;
    const eff = session.mvuSettings();
    if (!loadedShown && eff.mvuNotifyLoaded) { loadedShown = true; toast('MVU 变量框架已加载（轻酒馆内置）', 'info'); }
    const key = `${state.char?.id}/${state.chat?.name}`;
    if (session.mvuInitPending && session.chat.length === 1 && !initShown.has(key)) {
        initShown.add(key);
        if (eff.mvuNotifyInit) toast('变量已按初始值初始化', 'success');
    }
    // 没开“变量更新到聊天变量”时，聊天变量里不留 MVU 的那几项（原版打开聊天时也这么做）
    if (!eff.mvuChatVars && removeMirroredChatVars(session.meta)) { session.vars.invalidate(); saveChat(); }
    else if (eff.mvuChatVars) {
        const latest = latestMvuVars(session.chat);
        if (latest && !same(session.meta?.variables?.stat_data, latest.vars.stat_data)) { mirrorToChatVars(session.meta, latest.vars); session.vars.invalidate(); saveChat(); }
    }
}

const restoreLater = debounce(() => {
    const session = getSession();
    if (!session || !session.mvuEnabled()) return;
    const eff = session.mvuSettings();
    const r = restoreVariables(session.chat, { keep: Number(eff.mvuKeepRecent) || 20, restoreRecent: Number(eff.mvuRestoreRecent) || 10 });
    if (r.status === 'unavailable') toast(`在 0～${r.floor} 层找不到有效的变量，没法恢复楼层变量`, 'warning');
    if (r.status === 'restored' && r.restored) { session.vars.invalidate(); saveChat(); refresh('panels'); }
}, 2000);

export function initMvuOps() {
    eventSource.on(event_types.CHAT_CHANGED, onChatOpened);
    eventSource.on(event_types.MESSAGE_DELETED, () => restoreLater());
}

