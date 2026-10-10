// 酒馆助手脚本库的数据结构：角色卡 / 预设里夹带的脚本（data.extensions.tavern_helper.scripts）。
// 纯逻辑，不碰 DOM：规范化、展开文件夹、判断哪些该运行、运行前对源码做的少量替换。
import { uuid, hashString } from './util.js';

/** MagVarUpdate（MVU）变量框架的打包文件。轻酒馆的 MVU 是内置实现，这些文件不再真的加载 */
const MVU_BUNDLE_URL = /https?:\/\/[^\s'"`]*?(?:MagVarUpdate|MVU-offline)[^\s'"`]*?\.js/gi;

export function normalizeScript(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    // 旧版酒馆助手：{type: 'script', value: {id, name, content, info, buttons}}
    const v = s.value && typeof s.value === 'object' && s.content === undefined ? s.value : s;
    const btn = v.button && typeof v.button === 'object' ? v.button : {};
    const buttons = Array.isArray(btn.buttons) ? btn.buttons : (Array.isArray(v.buttons) ? v.buttons : []);
    return {
        type: 'script',
        enabled: v.enabled === true,
        name: String(v.name ?? ''),
        id: String(v.id ?? uuid()),
        content: String(v.content ?? ''),
        info: String(v.info ?? ''),
        button: {
            enabled: btn.enabled !== false,
            buttons: buttons.filter(b => b && typeof b === 'object').map(b => ({ name: String(b.name ?? ''), visible: b.visible !== false })),
        },
        data: v.data && typeof v.data === 'object' && !Array.isArray(v.data) ? v.data : {},
        export_with: v.export_with ?? { data: true, button: true },
    };
}

/**
 * 取出某个“容器”（角色卡的 data.extensions 或预设的 extensions）里的脚本树数组。
 * 返回的是原数组本身（改它就是改卡 / 预设），没有则返回空数组。
 */
export function scriptTreesOf(extensions) {
    const th = extensions?.tavern_helper;
    if (th && Array.isArray(th.scripts)) return th.scripts;
    if (Array.isArray(th)) {
        // 更早的形式：[['scripts', [...]], ['variables', {...}]]
        const pair = th.find(x => Array.isArray(x) && x[0] === 'scripts' && Array.isArray(x[1]));
        if (pair) return pair[1];
        if (th.every(x => x && typeof x === 'object' && !Array.isArray(x))) return th;
    }
    if (Array.isArray(extensions?.TavernHelper_scripts)) return extensions.TavernHelper_scripts;
    return [];
}

/** 脚本变量 / 角色卡变量 / 预设变量所在的对象（没有就建） */
export function helperVariablesOf(extensions, create = false) {
    if (!extensions || typeof extensions !== 'object') return {};
    let th = extensions.tavern_helper;
    if (!th || typeof th !== 'object' || Array.isArray(th)) {
        if (!create) return {};
        th = extensions.tavern_helper = { scripts: scriptTreesOf(extensions), variables: {} };
    }
    if (!th.variables || typeof th.variables !== 'object' || Array.isArray(th.variables)) {
        if (!create) return {};
        th.variables = {};
    }
    return th.variables;
}

const isFolder = (t) => t?.type === 'folder';
const folderChildren = (t) => (Array.isArray(t?.scripts) ? t.scripts : Array.isArray(t?.value) ? t.value : Array.isArray(t?.value?.scripts) ? t.value.scripts : []);

/**
 * 展开文件夹。每项 {script（规范化副本）, raw（卡里的原对象，用来写回开关 / 按钮 / 变量）, folder, on}。
 * on = 脚本自己开着，并且它所在的文件夹也开着。
 */
export function flattenScriptTrees(trees) {
    const out = [];
    for (const t of Array.isArray(trees) ? trees : []) {
        if (!t || typeof t !== 'object') continue;
        if (isFolder(t)) {
            const folderOn = (t.enabled ?? t.value?.enabled) !== false;
            for (const c of folderChildren(t)) {
                if (!c || typeof c !== 'object' || isFolder(c)) continue;
                const script = normalizeScript(c);
                out.push({ script, raw: c, folder: String(t.name ?? t.value?.name ?? ''), on: script.enabled && folderOn });
            }
        } else {
            const script = normalizeScript(t);
            out.push({ script, raw: t, folder: '', on: script.enabled });
        }
    }
    return out;
}

/** 卡 / 预设里所有脚本（规范化后的平铺列表），给只读用途 */
export const scriptsOf = (extensions) => flattenScriptTrees(scriptTreesOf(extensions)).map(x => x.script);

/** 这个脚本是不是在加载 MVU 变量框架 */
export function loadsMvuBundle(content) {
    MVU_BUNDLE_URL.lastIndex = 0;
    return MVU_BUNDLE_URL.test(String(content ?? ''));
}

const HELPER_API = /\b(eventOn|eventOnce|eventMakeFirst|eventMakeLast|eventEmit|getVariables|replaceVariables|registerMvuSchema|SillyTavern|TavernHelper|getChatMessages|toastr|Mvu)\b|\$\(/;

/**
 * 这个脚本是不是只用来加载 MVU（短，去掉注释后没用到任何酒馆助手接口）。
 * 这种脚本不用起，变量更新由内置实现完成；带超时 / 多镜像回退的加载器也算。
 */
export function isMvuLoaderOnly(content) {
    const src = String(content ?? '');
    if (src.length > 2000 || !loadsMvuBundle(src)) return false;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    return !HELPER_API.test(code);
}

/**
 * 运行前对源码做的替换：MVU 打包文件换成本地的空模块（变量更新由内置实现完成，再加载一份会重复执行）。
 * @param {string} content
 * @param {string} stubUrl 空模块的绝对地址
 */
export function rewriteScriptSource(content, stubUrl) {
    MVU_BUNDLE_URL.lastIndex = 0;
    return String(content ?? '').replace(MVU_BUNDLE_URL, stubUrl);
}

/** 脚本按钮对应的事件名（getButtonEvent） */
export function buttonEventName(scriptId, buttonName) {
    return `lt_script_button_${scriptId}_${hashString(String(buttonName)).toString(36)}`;
}

export const DEFAULT_SCRIPT_SETTINGS = {
    enabled: true, // 总开关
    characters: {}, // 角色卡 id → false 表示这张卡的脚本不运行（默认运行）
    presets: {}, // 预设名 → false 表示这个预设的脚本不运行
};

export function scriptSettings(settings) {
    const s = settings?.scripts;
    return {
        enabled: s?.enabled !== false,
        characters: s?.characters && typeof s.characters === 'object' ? s.characters : {},
        presets: s?.presets && typeof s.presets === 'object' ? s.presets : {},
    };
}

/**
 * 现在应该在运行的脚本。
 * @returns {Array<{key: string, source: 'character'|'preset', owner: string, script: object, raw: object, mvuLoader: boolean}>}
 */
export function activeScripts({ card, cardId, preset, presetName, settings }) {
    const cfg = scriptSettings(settings);
    if (!cfg.enabled) return [];
    const out = [];
    const add = (source, owner, extensions) => {
        for (const item of flattenScriptTrees(scriptTreesOf(extensions))) {
            if (!item.on || !item.script.content.trim()) continue;
            out.push({
                // 内容变了要重启，所以把内容哈希也算进 key
                key: `${source}:${owner}:${item.script.id}:${hashString(item.script.content).toString(36)}`,
                source, owner, script: item.script, raw: item.raw,
                mvuLoader: isMvuLoaderOnly(item.script.content),
            });
        }
    };
    if (preset && presetName && cfg.presets[presetName] !== false) add('preset', presetName, preset.extensions);
    if (card && cardId && cfg.characters[cardId] !== false) add('character', cardId, card.data?.extensions);
    return out;
}
