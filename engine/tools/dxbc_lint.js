// Checks for spliced shader code that fxc would never write but D3D lets through. So far one: an input operand whose
// swizzle names a component the input's dcl_input does not declare (v1.xyzw where only v1.xyz exists). D3D ignores the
// lanes an instruction's destination does not write, so WARP and an output comparison see nothing wrong, but NVIDIA's
// D3D11 driver (616.92) maps the undeclared component to a register past a 52-entry table in its background compiler
// and reads whatever lies behind it: the game crashes in nvwgf2umx.dll / nvgpucomp64.dll (the case: a world position
// read as vN.xyzw on the terrain's three-component input). No stock shader has one.
// Library: undeclaredInputReads(blob) -> [{ inst, reg, selected, declared }] (empty = clean).
// usage: node dxbc_lint.js <folder or file> [...]    lists offenders, exit code 1 when there are any
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');

const isDecl = (op) => op === 53 || (op >= 88 && op <= 106) || (op >= 143 && op <= 162) || op === 206 || (op >= 113 && op <= 116);

// the components an operand names: a mask, all four selectors of a swizzle, or one component
function selected(o)
{
    if (o.ncomp !== 2) return o.ncomp === 1 ? 1 : 0;
    if (o.mode === 0) return o.sel & 15;
    if (o.mode === 1) { let m = 0; for (let k = 0; k < 4; k++) m |= 1 << ((o.sel >> (k * 2)) & 3); return m; }
    return 1 << (o.sel & 3);
}

function undeclaredInputReads(b)
{
    const w = walk(b);
    const declared = new Map();
    for (const x of w.insts)
    {
        if (x.op < 95 || x.op > 100) continue; // dcl_input, dcl_input_sgv/siv, dcl_input_ps(_sgv/_siv)
        const o = operands(b, x)[0];
        if (o && o.type === 1 && o.dim === 1) declared.set(o.idx[0], (declared.get(o.idx[0]) || 0) | (o.sel & 15));
    }
    const out = [];
    w.insts.forEach((x, k) =>
    {
        if (isDecl(x.op)) return;
        const visit = (o) =>
        {
            for (const ix of o.idx) if (ix && typeof ix === 'object' && ix.rel) visit(ix.rel);
            if (o.type !== 1 || o.dim !== 1 || typeof o.idx[0] !== 'number') return;
            const m = selected(o), d = declared.get(o.idx[0]) || 0;
            if (m & ~d) out.push({ inst: k, reg: o.idx[0], selected: m, declared: d });
        };
        for (const o of operands(b, x)) visit(o);
    });
    return out;
}

module.exports = { undeclaredInputReads };

if (require.main === module)
{
    const files = [];
    for (const a of process.argv.slice(2))
    {
        if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (/\.(shader|cso)$/.test(f)) files.push(path.join(a, f)); }
        else files.push(a);
    }
    let bad = 0;
    for (const f of files)
    {
        const r = undeclaredInputReads(fs.readFileSync(f));
        if (!r.length) continue;
        bad++;
        if (bad <= 20) console.log(path.basename(f) + ': ' + r.map((x) => 'v' + x.reg + ' names 0x' + x.selected.toString(16) + ', declared 0x' + x.declared.toString(16) + ' (instruction ' + x.inst + ')').join('; '));
    }
    console.log(files.length + ' shaders, ' + bad + ' read input components they do not declare');
    process.exit(bad ? 1 : 0);
}
