// 提示词检查器：预览下一次要发送的内容（不发送），或看上一次实际发出的内容
import { h, clear, icon, toast, modal } from '../dom.js';
import { state } from '../../state.js';
import { getSession } from '../../controller.js';
import { previewPrompt } from '../../generate.js';
import { estimateMessageTokens, estimateTokens } from '../../core/tokens.js';

let lastView = null; // {kind, data}

const ROLE_LABEL = { system: '系统', user: '用户', assistant: 'AI' };
const SOURCE_LABEL = {
    main: '主提示词', nsfw: '辅助提示词', jailbreak: '历史后指令', enhanceDefinitions: '增强定义', chatHistory: '聊天记录',
    dialogueExamples: '示例对话', worldInfoBefore: '世界书（前）', worldInfoAfter: '世界书（后）', charDescription: '角色描述',
    charPersonality: '角色性格', scenario: '场景', personaDescription: '用户设定', newMainChat: '新聊天标记', newChat: '示例标记',
    authorsNote: '作者注释', continueNudge: '继续提示', impersonate: '代写提示', quietPrompt: '静默提示', emptyUserMessageReplacement: '空消息替换',
};

export function render(body) {
    const session = getSession();
    if (!session) { body.append(h('div', { class: 'empty' }, '先打开一个聊天')); return; }
    const out = h('div');
    body.append(h('div', { class: 'row wrap', style: { marginBottom: '10px' } },
        h('button', { class: 'btn small primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
                const r = await previewPrompt('normal');
                lastView = { kind: '预览（下一次普通发送，未发送）', data: r };
                show(out);
            } catch (err) {
                console.error(err);
                toast(`预览失败：${err.message}`, 'error');
            } finally { e.currentTarget.disabled = false; }
        } }, icon('eye'), '预览下一次发送'),
        h('button', { class: 'btn small', disabled: !session.lastPrompt, onclick: () => { lastView = { kind: '上一次实际发送', data: session.lastPrompt }; show(out); } }, '上一次实际发送'),
    ), out);
    if (lastView) show(out);
    else out.append(h('div', { class: 'hint' }, '预览会完整走一遍世界书、宏、EJS 和正则，但不会改动变量，也不会请求接口。'));
}

function show(out) {
    clear(out);
    const { kind, data } = lastView;
    if (!data) return;
    const msgs = data.messages ?? [];
    const total = msgs.reduce((a, m) => a + estimateMessageTokens(m), 0);
    const ctx = Number(state.preset?.data?.openai_max_context ?? 0);
    out.append(h('div', { class: 'card' },
        h('div', { class: 'card-title' }, kind),
        h('div', { class: 'kv', style: { marginTop: '6px' } },
            h('span', { class: 'k' }, '消息条数'), h('span', {}, String(msgs.length)),
            h('span', { class: 'k' }, '估算 tokens'), h('span', {}, `${total}${ctx ? ` / 上限 ${ctx}` : ''}`),
            data.prefill ? h('span', { class: 'k' }, '预填充') : null, data.prefill ? h('span', {}, `${estimateTokens(data.prefill)} tokens`) : null,
            h('span', { class: 'k' }, '激活世界书'), h('span', {}, `${data.debug?.activated?.length ?? 0} 条${data.debug?.wiOverflow ? '（超预算，有条目被挤掉）' : ''}`),
        ),
        h('div', { class: 'row wrap', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', onclick: () => copy(JSON.stringify(msgs.map(m => ({ role: m.role, content: m.content })), null, 2)) }, icon('copy'), '复制消息 JSON'),
            data.request ? h('button', { class: 'btn small', onclick: () => modal({ title: '请求体', wide: true, body: h('pre', { class: 'var-tree', style: { maxHeight: '70vh' } }, JSON.stringify(data.request.body, null, 2)) }) }, '查看请求体') : null,
        ),
    ));
    const act = data.debug?.activated ?? [];
    if (act.length) {
        out.append(h('details', { class: 'prompt-msg' },
            h('summary', {}, h('b', {}, '激活的世界书条目'), h('span', { class: 'muted' }, `${act.length} 条`)),
            h('pre', {}, act.map(e => `[${e.world}] ${e.comment || e.uid}`).join('\n'))));
    }
    // 预设里的自定义条目来源是 UUID，换成条目名字
    const promptName = new Map((state.preset?.data?.prompts ?? []).filter(p => p.name).map(p => [p.identifier, p.name]));
    msgs.forEach((m, i) => {
        const src = String(m.source ?? '');
        const srcLabel = SOURCE_LABEL[src] ?? promptName.get(src) ?? (src.startsWith('wi:') ? `世界书 ${src.slice(3)}` : src.startsWith('chat') || src === 'history' ? '聊天记录' : src);
        out.append(h('details', { class: 'prompt-msg', open: i === msgs.length - 1 },
            h('summary', {},
                h('span', { class: `tag ${m.role === 'system' ? '' : m.role === 'user' ? 'ok' : 'accent'}` }, ROLE_LABEL[m.role] ?? m.role),
                h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, srcLabel || String(m.content).slice(0, 40)),
                m.ejsError ? h('span', { class: 'tag danger', title: m.ejsError }, 'EJS 出错') : null,
                h('span', { class: 'muted' }, `${estimateMessageTokens(m)}`)),
            h('pre', {}, m.content)));
    });
    if (data.prefill) out.append(h('details', { class: 'prompt-msg', open: true }, h('summary', {}, h('span', { class: 'tag accent' }, '预填充')), h('pre', {}, data.prefill)));
}

function copy(text) {
    navigator.clipboard?.writeText(text).then(() => toast('已复制', 'success'), () => toast('复制失败', 'error'));
}
