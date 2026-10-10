// 统一的文件导入：角色卡 PNG/JSON、预设、世界书、正则、聊天记录。拖进窗口或点导入按钮都走这里。
import { api } from '../api.js';
import { state, saveSettings, refreshLists, loadWorld } from '../state.js';
import { normalizeRegexScript } from '../core/regex.js';
import { parseChatJsonl } from '../core/chat.js';
import { scriptsOf } from '../core/scripts.js';
import { toast, confirmDialog, promptDialog } from './dom.js';
import { selectCharacter, reloadCharacters, setPreset, openChat, refresh } from '../controller.js';

const BOM_RE = new RegExp('^' + String.fromCharCode(0xfeff));

/** 导入角色卡后的提示：卡里自带的世界书、脚本、正则都已经跟着加进来了 */
export function cardImportedText(r) {
    const extra = [
        r.world ? `世界书「${r.world}」已添加并绑定` : '',
        r.scripts ? (r.scriptsOn === r.scripts ? `${r.scripts} 个脚本已启用` : `${r.scripts} 个脚本（${r.scriptsOn} 个启用，其余按卡里的设置关着）`) : '',
        r.regex ? `${r.regex} 条正则` : '',
    ].filter(Boolean);
    return `已导入角色「${r.name}」${extra.length ? `：${extra.join('，')}` : ''}`;
}
const baseName = (name) => name.replace(/\.[^.]+$/, '');

/** 判断一个 JSON 是什么 */
export function classifyJson(j) {
    if (!j || typeof j !== 'object') return 'unknown';
    if (Array.isArray(j)) return j.length && j.every(x => x && typeof x === 'object' && 'findRegex' in x) ? 'regex' : 'unknown';
    if (j.spec === 'chara_card_v2' || j.spec === 'chara_card_v3') return 'card';
    if ('findRegex' in j && 'replaceString' in j) return 'regex';
    if (Array.isArray(j.prompts) || Array.isArray(j.prompt_order) || ('openai_max_context' in j && 'temperature' in j)) return 'preset';
    if (j.entries && typeof j.entries === 'object' && !('first_mes' in j)) return 'world';
    if (typeof j.name === 'string' && ('first_mes' in j || 'description' in j || 'char_name' in j)) return 'card';
    if (j.data && typeof j.data === 'object' && typeof j.data.name === 'string') return 'card';
    return 'unknown';
}

async function uniqueName(kind, name) {
    const list = kind === 'presets' ? state.presetList : state.worldList;
    if (!list.some(x => x.name === name)) return name;
    const overwrite = await confirmDialog(`已经有叫「${name}」的${kind === 'presets' ? '预设' : '世界书'}了，要覆盖吗？\n选“取消”会换个名字导入。`, { okLabel: '覆盖' });
    if (overwrite) return name;
    let i = 2;
    while (list.some(x => x.name === `${name} (${i})`)) i++;
    const n = await promptDialog('换个名字：', `${name} (${i})`, { title: '导入' });
    return n?.trim() || null;
}

export async function importPresetJson(j, name) {
    const n = await uniqueName('presets', name);
    if (!n) return null;
    await api.save('presets', n, j);
    await refreshLists();
    await setPreset(n);
    const scripts = scriptsOf(j.extensions);
    const on = scripts.filter(x => x.enabled).length;
    const extra = [
        scripts.length ? (on === scripts.length ? `${on} 个脚本已启用` : `${scripts.length} 个脚本（${on} 个启用）`) : '',
        j.extensions?.regex_scripts?.length ? `${j.extensions.regex_scripts.length} 条正则` : '',
    ].filter(Boolean);
    toast(`已导入预设「${n}」并切换过去${extra.length ? `：自带 ${extra.join('，')}` : ''}`, 'success', extra.length ? 5000 : undefined);
    return n;
}

export async function importWorldJson(j, name) {
    const n = await uniqueName('worlds', name);
    if (!n) return null;
    await api.save('worlds', n, j);
    await refreshLists();
    await loadWorld(n, { force: true });
    toast(`已导入世界书「${n}」。要全局生效的话在「世界书」里勾选`, 'success');
    refresh('panels');
    return n;
}

export function importRegexJson(j) {
    const list = (Array.isArray(j) ? j : [j]).map(normalizeRegexScript);
    const ids = new Set(state.settings.regex.map(r => r.id));
    let added = 0;
    for (const r of list) {
        if (ids.has(r.id)) r.id = crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`;
        state.settings.regex.push(r);
        added++;
    }
    saveSettings();
    if (state.session) state.session = null;
    toast(`已导入 ${added} 条全局正则`, 'success');
    refresh(['panels', 'chat']);
}

export async function importChatText(text, fileName) {
    if (!state.char) { toast('先选中要导入到哪个角色', 'warning'); return; }
    let parsed;
    try { parsed = parseChatJsonl(text); } catch (e) { toast(`聊天记录格式不对：${e.message}`, 'error'); return; }
    let name = baseName(fileName);
    if (state.chatList.some(c => c.name === name)) name = `${name} 导入${Date.now().toString(36).slice(-4)}`;
    await api.saveChat(state.char.id, name, text);
    state.chatList = await api.listChats(state.char.id);
    toast(`已导入聊天（${parsed.messages.length} 条）`, 'success');
    await openChat(name);
}

/**
 * @param {File[]} files
 */
export async function importFiles(files) {
    let lastCard = null;
    let cards = 0;
    for (const f of files) {
        try {
            if (/\.png$/i.test(f.name)) {
                const r = await api.importCharacter(f);
                cards++;
                lastCard = r.file;
                toast(cardImportedText(r), 'success', 5000);
                continue;
            }
            if (/\.jsonl$/i.test(f.name)) {
                await importChatText(await f.text(), f.name);
                continue;
            }
            if (/\.json$/i.test(f.name)) {
                const text = (await f.text()).replace(BOM_RE, '');
                let j;
                try { j = JSON.parse(text); } catch { toast(`${f.name} 不是合法的 JSON`, 'error'); continue; }
                const kind = classifyJson(j);
                if (kind === 'card') {
                    const r = await api.importCharacter(f);
                    cards++;
                    lastCard = r.file;
                    toast(cardImportedText(r), 'success', 5000);
                } else if (kind === 'preset') await importPresetJson(j, baseName(f.name));
                else if (kind === 'world') await importWorldJson(j, j.name && typeof j.name === 'string' ? j.name : baseName(f.name));
                else if (kind === 'regex') importRegexJson(j);
                else toast(`认不出 ${f.name} 是什么（支持角色卡、对话补全预设、世界书、正则）`, 'warning');
                continue;
            }
            toast(`不支持的文件：${f.name}`, 'warning');
        } catch (e) {
            toast(`导入 ${f.name} 失败：${e.message}`, 'error');
        }
    }
    if (cards) {
        await reloadCharacters();
        await refreshLists();
        if (cards === 1 && lastCard) await selectCharacter(lastCard);
    }
}
