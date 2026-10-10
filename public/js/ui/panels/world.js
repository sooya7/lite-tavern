// 世界书面板：全局启用、扫描设置、世界书文件管理、条目编辑
import { h, clear, icon, iconBtn, toast, confirmDialog, promptDialog, modal, pickFiles, downloadText } from '../dom.js';
import { state, saveSettings, saveWorld, loadWorld, refreshLists, flushPending } from '../../state.js';
import { api } from '../../api.js';
import { loadRelevantWorlds, refresh } from '../../controller.js';
import { newWorldInfoEntry, WI_POSITION, WI_LOGIC, DEFAULT_WI_SETTINGS, normalizeWorld } from '../../core/worldinfo.js';
import { estimateTokens } from '../../core/tokens.js';
import { clone } from '../../core/util.js';
import { field, textInput, textArea, numberInput, checkbox, select, rangeRow, section, collapsible, toggle, pickList } from '../form.js';
import { renderPanels } from './index.js';
import { importWorldJson } from '../importers.js';

let editing = '';
let pickedFor = null; // 上一次是替哪个角色挑的“正在编辑哪一本”
let query = '';

const POSITIONS = [
    { value: 0, label: '角色定义之前' },
    { value: 1, label: '角色定义之后' },
    { value: 5, label: '示例对话之前' },
    { value: 6, label: '示例对话之后' },
    { value: 2, label: '作者注释之前' },
    { value: 3, label: '作者注释之后' },
    { value: 4, label: '聊天记录中（指定深度）' },
    { value: 7, label: '出口（{{outlet::名字}} 取用）' },
];
const POS_SHORT = { 0: '角色前', 1: '角色后', 2: '注释前', 3: '注释后', 4: '@深度', 5: '例前', 6: '例后', 7: '出口' };
const LOGIC = [
    { value: WI_LOGIC.AND_ANY, label: '含任一个' },
    { value: WI_LOGIC.AND_ALL, label: '全都含' },
    { value: WI_LOGIC.NOT_ANY, label: '一个都不含' },
    { value: WI_LOGIC.NOT_ALL, label: '不全含' },
];
const TRIGGERS = [['normal', '普通'], ['continue', '继续'], ['impersonate', '代写'], ['swipe', '重刷'], ['regenerate', '重新生成'], ['quiet', '静默']];

export function render(body) {
    const s = state.settings;
    const wi = s.worldInfo;
    const names = state.worldList.map(w => w.name);

    // ---------- 全局启用 ----------
    const global = new Set(wi.globalSelect ?? []);
    const linked = state.char?.card?.data?.extensions?.world ?? '';
    const chatWorld = state.chat?.header?.chat_metadata?.world_info ?? '';
    const activeInfo = [];
    if (linked) activeInfo.push(`角色绑定：${linked}`);
    for (const n of wi.charLore?.[state.char?.id] ?? []) activeInfo.push(`角色额外：${n}`);
    if (chatWorld) activeInfo.push(`聊天绑定：${chatWorld}`);
    body.append(section('全局世界书（所有聊天都生效）',
        names.length ? pickList(names, n => global.has(n), async (n, on) => {
            if (on) global.add(n); else global.delete(n);
            wi.globalSelect = [...global];
            saveSettings();
            await loadRelevantWorlds();
        }, { noneText: '现在没有启用全局世界书', moreTitle: '其他世界书', unit: '本' }) : h('div', { class: 'muted small' }, '还没有世界书'),
        activeInfo.length ? h('div', { class: 'hint' }, `当前聊天另外生效：${activeInfo.join('；')}`) : null,
    ));

    // ---------- 扫描设置 ----------
    const save = () => saveSettings();
    body.append(collapsible('扫描与预算设置', [
        h('div', { class: 'grid2' },
            field('扫描深度（条消息）', numberInput(wi, 'world_info_depth', { min: 0, onChange: save })),
            field('预算（上下文 %）', numberInput(wi, 'world_info_budget', { min: 1, max: 100, onChange: save })),
        ),
        h('div', { class: 'grid2' },
            field('预算上限（tokens，0 不限）', numberInput(wi, 'world_info_budget_cap', { min: 0, onChange: save })),
            field('最少激活条数', numberInput(wi, 'world_info_min_activations', { min: 0, onChange: save })),
        ),
        h('div', { class: 'grid2' },
            field('最大递归层数（0 不限）', numberInput(wi, 'world_info_max_recursion_steps', { min: 0, onChange: save })),
            field('角色/全局排序', select(wi, 'world_info_character_strategy', [{ value: 0, label: '平均混排' }, { value: 1, label: '角色优先' }, { value: 2, label: '全局优先' }], { number: true, onChange: save })),
        ),
        checkbox(wi, 'world_info_recursive', '递归扫描（激活的条目内容也参与匹配）', { onChange: save }),
        checkbox(wi, 'world_info_include_names', '匹配时带上发言人名字', { onChange: save }),
        checkbox(wi, 'world_info_case_sensitive', '区分大小写', { onChange: save }),
        checkbox(wi, 'world_info_match_whole_words', '整词匹配（英文）', { onChange: save }),
        checkbox(wi, 'world_info_use_group_scoring', '分组按匹配分数选', { onChange: save }),
        checkbox(wi, 'world_info_overflow_alert', '超出预算时提醒', { onChange: save }),
    ]));

    // ---------- 编辑 ----------
    // 默认打开当前角色绑定的那本。换了角色（包括刚启动时还没进聊天、面板先画了一遍）要重新挑，
    // 不然会一直停在名单里的第一本上；同一个角色下用户自己选了别的就听他的
    const charKey = state.char?.id ?? '';
    const hasLinked = !!linked && names.includes(linked);
    if (!editing || !names.includes(editing) || (pickedFor !== charKey && hasLinked)) editing = hasLinked ? linked : (editing && names.includes(editing) ? editing : (names[0] ?? ''));
    pickedFor = charKey;
    const picker = h('select', { class: 'select grow' }, names.map(n => h('option', { value: n, selected: n === editing }, n)));
    picker.addEventListener('change', () => { editing = picker.value; renderPanels(); });
    body.append(h('div', { class: 'section-head' }, '编辑世界书'));
    // 窄屏上选择框自己占一行，五个按钮排到下一行，不再把选择框挤成一条缝、把“删除”挤出屏幕
    body.append(h('div', { class: 'pick-bar' },
        names.length ? picker : h('div', { class: 'grow muted small' }, '还没有世界书'),
        h('div', { class: 'pick-bar-acts' },
            iconBtn('plus', '新建世界书', onCreate),
            iconBtn('upload', '导入世界书 JSON', onImport),
            editing ? iconBtn('download', '导出', onExport) : null,
            editing ? iconBtn('edit', '重命名', onRename) : null,
            editing ? iconBtn('trash', '删除', onDelete) : null),
    ));
    if (!editing) return;
    const holder = h('div', {}, h('div', { class: 'muted small' }, '加载中…'));
    body.append(holder);
    loadWorld(editing).then((w) => {
        clear(holder);
        if (!w) { holder.append(h('div', { class: 'empty' }, '读取失败')); return; }
        holder.append(entryList(editing, w));
    });
}

function entryList(name, w) {
    const wrap = h('div');
    const search = h('input', { class: 'input', type: 'search', placeholder: '搜索条目…', title: '按标题、关键词、内容搜', value: query });
    const list = h('div', { class: 'entry-list' });
    const fill = () => {
        clear(list);
        const q = query.trim().toLowerCase();
        const entries = Object.values(w.entries).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid) || a.uid - b.uid);
        const shown = entries.filter(e => !q || `${e.comment}\n${e.key.join(',')}\n${e.content}`.toLowerCase().includes(q));
        countEl.textContent = `${entries.filter(e => !e.disable).length}/${entries.length} 条启用`;
        for (const e of shown) list.append(entryRow(name, w, e, fill));
        if (!shown.length) list.append(h('div', { class: 'empty' }, entries.length ? '没有匹配的条目' : '还没有条目'));
    };
    const countEl = h('span', { class: 'muted small' });
    search.addEventListener('input', () => { query = search.value; fill(); });
    wrap.append(
        h('div', { class: 'row', style: { marginBottom: '6px' } }, search,
            h('button', { class: 'btn small', onclick: () => addEntry(name, w, fill) }, icon('plus'), '条目')),
        h('div', { class: 'row', style: { marginBottom: '4px' } }, countEl),
        list,
    );
    fill();
    return wrap;
}

function strategyTag(e) {
    if (e.constant) return h('span', { class: 'tag accent', title: '常驻：总是发送' }, '常驻');
    if (e.vectorized) return h('span', { class: 'tag', title: '向量化（本程序按关键词处理）' }, '向量');
    return h('span', { class: 'tag ok', title: '关键词触发' }, '关键词');
}

function entryRow(name, w, e, refill) {
    const title = e.comment || e.key.join(', ') || `条目 ${e.uid}`;
    const open = () => editEntry(name, w, e, refill);
    // 整行都能点开（开关除外），右边的箭头是给人看的：这一行点了会打开详情
    return h('div', { class: `list-item entry-row ${e.disable ? 'disabled' : ''}`, onclick: open },
        toggle(!e.disable, (v) => { e.disable = !v; saveWorld(name); refill(); }, '启用/停用'),
        h('div', { class: 'entry-main' },
            h('div', { class: 'li-name' }, title),
            h('div', { class: 'entry-meta' },
                strategyTag(e),
                h('span', { class: 'tag', title: '插入位置' }, Number(e.position) === 4 ? `@${e.depth}` : (POS_SHORT[e.position] ?? '?')),
                h('span', { class: 'li-sub', title: '顺序' }, `顺序 ${e.order ?? 100}`)),
            h('div', { class: 'li-sub entry-keys' }, `${estimateTokens(e.content)} tokens`,
                e.constant ? '' : (e.key.length ? ` · 🔑 ${e.key.join(', ')}` : ' · 没有关键词'))),
        h('button', { class: 'icon-btn entry-open', title: '打开这一条', 'aria-label': `打开条目：${title}`, onclick: (ev) => { ev.stopPropagation(); open(); } }, icon('right')),
    );
}

function addEntry(name, w, refill) {
    const uids = Object.keys(w.entries).map(Number);
    const uid = uids.length ? Math.max(...uids) + 1 : 0;
    const e = newWorldInfoEntry(uid, { comment: '新条目' });
    w.entries[uid] = e;
    saveWorld(name);
    refill();
    editEntry(name, w, e, refill);
}

const BACKSLASH = String.fromCharCode(92);

/** 关键词按英文逗号拆分（与酒馆一致），/正则/ 里的逗号不拆 */
export function splitKeys(str) {
    const out = [];
    let cur = '';
    let i = 0;
    while (i < str.length) {
        const c = str[i];
        if (c === '/' && cur.trim() === '') {
            let j = i + 1;
            let closed = false;
            while (j < str.length) {
                if (str[j] === BACKSLASH) { j += 2; continue; }
                if (str[j] === '/') { closed = true; break; }
                j++;
            }
            if (closed) {
                let k = j + 1;
                while (k < str.length && /[gimsuy]/.test(str[k])) k++;
                cur += str.slice(i, k);
                i = k;
                continue;
            }
        }
        if (c === ',') { out.push(cur); cur = ''; i++; continue; }
        cur += c;
        i++;
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
}

function editEntry(name, w, e, refill) {
    const d = clone(e);
    const keysObj = { v: d.key.join(', ') };
    const keys2Obj = { v: d.keysecondary.join(', ') };
    const tokenEl = h('span', { class: 'muted small' }, `约 ${estimateTokens(d.content)} tokens`);
    const content = textArea(d, 'content', { rows: 12, maxRows: 28 });
    content.addEventListener('input', () => { tokenEl.textContent = `约 ${estimateTokens(d.content)} tokens`; });
    const depthRow = h('div', { class: 'grid2' },
        field('深度', numberInput(d, 'depth', { min: 0 })),
        field('角色', select(d, 'role', [{ value: 0, label: 'system' }, { value: 1, label: 'user' }, { value: 2, label: 'assistant' }], { number: true })),
    );
    const outletRow = field('出口名', textInput(d, 'outletName'));
    const syncPos = () => { depthRow.hidden = Number(d.position) !== 4; outletRow.hidden = Number(d.position) !== 7; };
    syncPos();
    const triggers = h('div', { class: 'row wrap' }, TRIGGERS.map(([k, label]) => {
        const cb = h('input', { type: 'checkbox', checked: (d.triggers ?? []).includes(k) });
        cb.addEventListener('change', () => {
            const set = new Set(d.triggers ?? []);
            if (cb.checked) set.add(k); else set.delete(k);
            d.triggers = [...set];
        });
        return h('label', { class: 'check' }, cb, label);
    }));
    const triState = (key, label) => select(d, key, [{ value: '', label: `${label}：跟随全局` }, { value: 'true', label: `${label}：是` }, { value: 'false', label: `${label}：否` }], {
        onChange: (v) => { d[key] = v === '' ? null : v === 'true'; },
    });
    const nullableNum = (key, ph) => {
        const el = h('input', { class: 'input', type: 'number', min: 0, placeholder: ph, value: d[key] ?? '' });
        el.addEventListener('input', () => { d[key] = el.value === '' ? null : Number(el.value); });
        return el;
    };
    const stratObj = { v: d.constant ? 'constant' : 'normal' };

    const bodyEl = h('div', {},
        field('标题 / 备注', textInput(d, 'comment')),
        h('div', { class: 'grid2' },
            field('触发方式', select(stratObj, 'v', [{ value: 'normal', label: '关键词触发' }, { value: 'constant', label: '常驻（总是发送）' }], { onChange: (v) => { d.constant = v === 'constant'; } })),
            field('顺序（越大越靠后/越优先）', numberInput(d, 'order', { step: 1 })),
        ),
        field('关键词（英文逗号分隔，支持 /正则/i）', textInput(keysObj, 'v', { onChange: (v) => { d.key = splitKeys(v); } })),
        h('div', { class: 'grid2' },
            field('次要关键词', textInput(keys2Obj, 'v', { onChange: (v) => { d.keysecondary = splitKeys(v); d.selective = true; } })),
            field('次要关键词逻辑', select(d, 'selectiveLogic', LOGIC, { number: true })),
        ),
        h('div', { class: 'grid2' },
            field('插入位置', select(d, 'position', POSITIONS, { number: true, onChange: syncPos })),
            field('触发概率 %', numberInput(d, 'probability', { min: 0, max: 100 })),
        ),
        depthRow,
        outletRow,
        field(h('span', {}, '内容 ', tokenEl), content),
        collapsible('高级', [
            h('div', { class: 'grid2' },
                field('分组名', textInput(d, 'group', { placeholder: '同组只选一条' })),
                field('组内权重', numberInput(d, 'groupWeight', { min: 0 })),
            ),
            checkbox(d, 'groupOverride', '组内优先（按顺序选而不是随机）'),
            h('div', { class: 'grid3' },
                field('粘滞（条）', nullableNum('sticky', '无')),
                field('冷却（条）', nullableNum('cooldown', '无')),
                field('延迟（条）', nullableNum('delay', '无')),
            ),
            h('div', { class: 'grid2' },
                field('扫描深度覆盖', nullableNum('scanDepth', '跟随全局')),
                field('匹配选项', h('div', {}, triState('caseSensitive', '区分大小写'), triState('matchWholeWords', '整词'))),
            ),
            checkbox(d, 'excludeRecursion', '不被递归激活（只看聊天内容）'),
            checkbox(d, 'preventRecursion', '内容不参与递归'),
            checkbox(d, 'delayUntilRecursion', '只在递归阶段激活'),
            checkbox(d, 'ignoreBudget', '不受预算限制'),
            checkbox(d, 'useProbability', '启用概率'),
            field('只在这些生成类型时生效（都不勾 = 总是）', triggers),
            field('额外匹配来源', h('div', { class: 'check-list' },
                checkbox(d, 'matchPersonaDescription', '用户设定'),
                checkbox(d, 'matchCharacterDescription', '角色描述'),
                checkbox(d, 'matchCharacterPersonality', '角色性格'),
                checkbox(d, 'matchScenario', '场景'),
                checkbox(d, 'matchCharacterDepthPrompt', '角色注释'),
                checkbox(d, 'matchCreatorNotes', '作者备注'),
            )),
        ]),
        h('div', { class: 'muted small', style: { marginTop: '8px' } }, `UID ${e.uid}`),
    );
    modal({
        title: `编辑条目：${e.comment || e.uid}`,
        wide: true,
        body: bodyEl,
        actions: [
            { label: '删除', danger: true, onClick: async () => {
                if (!await confirmDialog('删除这个条目？')) return false;
                delete w.entries[e.uid];
                saveWorld(name);
                refill();
                return true;
            } },
            { label: '复制一份', onClick: () => {
                const uids = Object.keys(w.entries).map(Number);
                const uid = Math.max(...uids) + 1;
                w.entries[uid] = { ...clone(d), uid, displayIndex: uid, comment: `${d.comment} 副本` };
                saveWorld(name);
                refill();
                return true;
            } },
            { label: '取消', value: false },
            { label: '保存', primary: true, onClick: () => {
                Object.assign(e, d);
                saveWorld(name);
                refill();
                return true;
            } },
        ],
    });
}

// ---------- 文件操作 ----------
async function onCreate() {
    const name = await promptDialog('世界书名字：', '', { title: '新建世界书' });
    if (!name?.trim()) return;
    if (state.worldList.some(w => w.name === name.trim())) { toast('已有同名世界书', 'warning'); return; }
    await api.save('worlds', name.trim(), { entries: {} });
    await refreshLists();
    await loadWorld(name.trim(), { force: true });
    editing = name.trim();
    renderPanels();
}

async function onImport() {
    const [f] = await pickFiles({ accept: '.json' });
    if (!f) return;
    try {
        const j = JSON.parse(await f.text());
        const n = await importWorldJson(j, f.name.replace(/\.json$/i, ''));
        if (n) { editing = n; renderPanels(); }
    } catch (e) {
        toast(`导入失败：${e.message}`, 'error');
    }
}

async function onExport() {
    const w = await loadWorld(editing);
    if (w) downloadText(JSON.stringify({ entries: w.entries, ...(w.name ? { name: w.name } : {}) }, null, 4), `${editing}.json`);
}

async function onRename() {
    const old = editing;
    const to = await promptDialog('新名字：', old, { title: '重命名世界书' });
    if (!to?.trim() || to.trim() === old) return;
    try {
        await flushPending();
        await api.rename('worlds', old, to.trim());
        const nn = to.trim();
        state.worlds[nn] = state.worlds[old];
        delete state.worlds[old];
        const wi = state.settings.worldInfo;
        wi.globalSelect = (wi.globalSelect ?? []).map(x => (x === old ? nn : x));
        for (const k of Object.keys(wi.charLore ?? {})) wi.charLore[k] = wi.charLore[k].map(x => (x === old ? nn : x));
        if (state.char?.card?.data?.extensions?.world === old) {
            state.char.card.data.extensions.world = nn;
            await api.saveCharacter(state.char.file, state.char.card);
        }
        saveSettings();
        await refreshLists();
        editing = nn;
        renderPanels();
        toast('已重命名（当前角色与全局选择已同步；其他角色绑定的旧名需要手动改）', 'success');
    } catch (e) {
        toast(`重命名失败：${e.message}`, 'error');
    }
}

async function onDelete() {
    if (!await confirmDialog(`删除世界书「${editing}」？（会移到 trash）`, { danger: true, okLabel: '删除' })) return;
    await flushPending();
    await api.remove('worlds', editing);
    delete state.worlds[editing];
    const wi = state.settings.worldInfo;
    wi.globalSelect = (wi.globalSelect ?? []).filter(x => x !== editing);
    saveSettings();
    await refreshLists();
    editing = '';
    renderPanels();
    refresh('chat');
}

export { DEFAULT_WI_SETTINGS, normalizeWorld, rangeRow, WI_POSITION };
