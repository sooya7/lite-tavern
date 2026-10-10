// 酒馆新版宏系统（public/scripts/macros/macro-system.js）的兼容模块：插件注册的宏接到轻酒馆的宏引擎上
import { macroEngine } from '../../js/core/macros.js';

function adapt(name, def) {
    const handler = typeof def === 'function' ? def : def?.handler;
    if (typeof handler !== 'function') return null;
    return {
        handler: (c) => {
            const args = Array.isArray(c?.args) ? c.args : [];
            const out = handler({ name, args, unnamedArgs: args, raw: c?.raw ?? '', env: c?.env ?? {} }, ...args);
            return out === undefined || out === null ? '' : String(out);
        },
    };
}

export const macros = {
    register(name, def) {
        const d = adapt(String(name), def);
        if (!d) return false;
        macroEngine.register(String(name), d);
        return true;
    },
    unregister(name) { macroEngine.unregister(String(name)); },
    has(name) { return macroEngine.has(String(name)); },
};
export const MacroRegistry = macros;
export default macros;
