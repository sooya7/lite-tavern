// 静态检查：前端模块之间 import 的名字是否真的被导出（无构建项目里防手滑）
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'public/js');
const files = [];
(function walk(d) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
    }
})(root);

function exportsOf(src) {
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const p = part.trim();
            if (!p) continue;
            const as = p.split(/\s+as\s+/);
            names.add((as[1] ?? as[0]).trim());
        }
    }
    if (/export\s+default\b/.test(src)) names.add('default');
    return names;
}

let bad = 0;
for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
        if (!m[2].startsWith('.')) continue;
        const target = path.resolve(path.dirname(f), m[2]);
        if (!fs.existsSync(target)) { console.log(`缺文件 ${path.relative(root, f)} -> ${m[2]}`); bad++; continue; }
        const ex = exportsOf(fs.readFileSync(target, 'utf8'));
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name && !ex.has(name)) { console.log(`缺导出 ${name}  (${path.relative(root, f)} 从 ${m[2]} 导入)`); bad++; }
        }
    }
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s*'([^']+)'/g)) {
        if (!m[2].startsWith('.')) continue;
        const target = path.resolve(path.dirname(f), m[2]);
        if (!fs.existsSync(target)) { console.log(`缺文件 ${path.relative(root, f)} -> ${m[2]}`); bad++; continue; }
        if (!exportsOf(fs.readFileSync(target, 'utf8')).has('default')) { console.log(`缺默认导出 ${m[2]} (${path.relative(root, f)})`); bad++; }
    }
}
console.log(bad ? `共 ${bad} 处问题` : '导入导出全部对得上');
process.exit(bad ? 1 : 0);
