// SPDX-License-Identifier: GPL-3.0-only
// Clear glass: a clean window pane adds only its reflection. SnowRunner's window glass (the 14 pixel shaders that name
// g_txWindshieldDetail: one output, drawn blended over the cab) writes an alpha that is the dirt alone (the diffuse
// texture's alpha above g_fWindshieldDiffuseCleanAlpha, times the detail map, raised by the mud decals), but a colour
// that does not follow it: the pane's diffuse layer (its albedo lit by the ambient, the sun and the headlights) is
// written in full beside the mirror term. The pass blends the colour as it is (a clean pane shows its reflection, which
// no alpha multiplies), so a pane with alpha 0 still lays its ambient-lit albedo over the cab: an even grey veil that
// makes the interior look white and too bright.
// The cut: the diffuse albedo (the base colour times one minus the metal share, the one register every diffuse term of
// the shader multiplies its light by: ambient, sun, headlights) is multiplied by the pane's alpha right where the shader
// makes it. The colour is then the premultiplied one the blend expects: film colour times alpha plus the mirror term.
// Dirt and mud keep their colour at their alpha; the mirror term, the lamps' highlights and the wet pane are untouched.
// The place is found by data flow, not by text, so it holds on a stock shader and on one the other modules changed:
//   C = the temp the last write of o0.xyzw takes its colour and alpha from (mad o0.xyzw, wet, x, C);
//   the last write of C.xyzw before that is the albedo and alpha with the mud decals in;
//   the first mul after it of the form  D.xyz = C.xyz * s  (s one component of a temp; D.yzw in some) is the diffuse albedo;
//   C.w must not be written again, and D not be C.
// One instruction goes in behind it: mul D.xyz, D, C.wwww. A shader where any step fails is refused with a reason.
// Library: patchGlass(blob) -> { blob, colour, albedo } or { reason }; targets(); isGlass(blob).
// usage: node patch_glass_clear.js [outDir]    what it does to the stock shaders; with outDir writes 0x<CRC>.cso there
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, ins, OP } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const GLASS = Buffer.from('g_txWindshieldDetail');
const SRC_WWWW = 0x100ff6, SRC_XYZW = 0x100e46;   // a temp read as .wwww, and as itself
const T_TEMP = 0, T_OUTPUT = 2;
const MASK = (o) => (o.sel & 0xf);         // a destination's write mask (mode 0)
const isTemp = (o) => o && o.type === T_TEMP && o.dim === 1 && typeof o.idx[0] === 'number';
const swizzle = (o) => o.mode === 1 ? [o.sel & 3, (o.sel >> 2) & 3, (o.sel >> 4) & 3, (o.sel >> 6) & 3] : null;
const isDecl = (op) => (op >= 88 && op <= 106) || (op >= 143 && op <= 183) || op === 53;

const isGlass = (b) => b.includes(GLASS);

function patchGlass(b)
{
    if (!isGlass(b)) return { reason: 'not window glass' };
    const w = walk(b);
    const code = w.insts.filter((x) => !isDecl(x.op)).map((x) => ({ x, o: operands(b, x) }));
    // the last write of the whole of o0
    let last = -1;
    code.forEach((c, i) => { const d = c.o[0]; if (d && d.type === T_OUTPUT && d.idx[0] === 0 && d.mode === 0 && MASK(d) === 0xf) last = i; });
    if (last < 0) return { reason: 'no write of o0.xyzw' };
    const f = code[last];
    if (f.x.op !== OP.mad || f.o.length !== 4 || !isTemp(f.o[3]) || (swizzle(f.o[3]) || []).join('') !== '0123') return { reason: 'o0 is not written as mad o0, wet, x, colour' };
    const C = f.o[3].idx[0];
    // the last write of C.xyzw before it; C.w must stay as it is from there on
    let made = -1;
    for (let i = 0; i < last; i++) { const d = code[i].o[0]; if (isTemp(d) && d.idx[0] === C && d.mode === 0 && MASK(d) === 0xf) made = i; }
    if (made < 0) return { reason: 'the colour register is never written whole' };
    for (let i = made + 1; i < last; i++) { const d = code[i].o[0]; if (isTemp(d) && d.idx[0] === C && d.mode === 0 && (MASK(d) & 8)) return { reason: 'the alpha is written again after the mud decals' }; }
    // the diffuse albedo: the first  D.xyz = C.xyz * (one component of a temp)
    for (let i = made + 1; i < last; i++)
    {
        const { x, o } = code[i];
        if (x.op !== OP.mul || o.length !== 3) continue;
        const d = o[0];
        // three components written (xyz, or yzw where the compiler packed a scalar into x), reading the colour's x, y, z
        if (!isTemp(d) || d.mode !== 0 || d.idx[0] === C) continue;
        const comps = [0, 1, 2, 3].filter((k) => MASK(d) & (1 << k));
        if (comps.length !== 3) continue;
        const col = o.slice(1).find((s) => isTemp(s) && s.idx[0] === C && swizzle(s) && comps.map((k) => swizzle(s)[k]).join('') === '012');
        const one = o.slice(1).find((s) => s !== col && isTemp(s) && swizzle(s) && new Set(swizzle(s)).size === 1);
        if (!col || !one) continue;
        const D = d.idx[0];
        const words = ins(OP.mul, [(0x100002 | (MASK(d) << 4)) >>> 0, D, SRC_XYZW, D, SRC_WWWW, C]);   // D.mask = D * C.w
        const at = x.off + x.len * 4;      // behind the albedo's own instruction
        return { blob: insertWords(b, [{ at, words }], { stat: { instructions: 1, floatInstructions: 1 } }), colour: C, albedo: D };
    }
    return { reason: 'no diffuse albedo made from the colour register' };
}

// the window glass shaders of the stock dump
function targets()
{
    const idx = JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
    return idx.filter((r) => /^ps/.test(r.profile) && (r.res || []).some((x) => x.name === 'g_txWindshieldDetail')).map((r) => r.hash);
}

module.exports = { patchGlass, targets, isGlass };

if (require.main === module)
{
    const outDir = process.argv[2];
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    const report = { targets: 0, patched: 0, skipped: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchGlass(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')));
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; console.log(hash + ' refused: ' + r.reason); continue; }
        report.patched++;
        console.log(hash + ' colour r' + r.colour + ' albedo r' + r.albedo);
        if (outDir) fs.writeFileSync(path.join(outDir, '0x' + hash + '.cso'), r.blob);
    }
    console.log(JSON.stringify(report));
}
