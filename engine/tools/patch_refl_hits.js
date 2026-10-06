// The lakes' reflection image: the hit rule of the engine's own screen-space pass (SpinTires/WaterCompute, techniques
// "Reflections" 0x44F6CB1D and "ReflectionsWithTAA" 0x8E21C0FB, main cache). That pass fills g_txReflections, the image
// the 88 lake, sea and puddle shaders read at t4, at half the frame's size: for every water texel it walks up the
// screen one texel a step and looks for the first thing standing out of the water, then takes the scene's colour twice
// as far up (a mirror about that waterline). With T = the height over the water plane of what the screen shows i
// texels up, less (i - 2) x tol (tol 0.002 to 0.008 m, more the steeper the view), a step is a hit when
//     0 <= T < 1 m
//     and T > minH and T - T(previous step) > minRise
// minH = 0.02 + 0.02 s, minRise = 0.01 + 0.04 s metres, s = saturate((opaque depth at the texel - 10) / 10). The second
// line keeps gently rising ground out of the mirror, but minRise is metres PER TEXEL of the target: something upright
// 20 m away rises 3.0 cm a texel at 540 rows (a 1920 x 1080 frame, field of view 43.7 degrees) and 1.5 cm at 1080 rows
// (3840 x 2160), so the higher the resolution, the less passes. At 3840 x 2160 a hull, a tyre or a pier standing in
// the water is found only beyond about 75 m, and the image shows sky where a truck should be.
// Modes:
//   slope[:c]  minH stays; minRise becomes c x (the height a texel covers at the sampled depth, less tol), c = 0.5
//              unless given, so there is no resolution in it. An upright wall rises exactly that height a texel, and
//              ground that climbs at the angle b under a line of sight falling at the angle a rises
//              tan b / (tan a + tan b) of it: with c = 0.5 a step counts when the ground there is steeper than the line
//              of sight, which is the condition for a level mirror to show that ground at all. One instruction is
//              inserted into the loop
//   off        the second line never rejects: the rule is 0 <= T < 1 m, as in Expeditions: A MudRunner Game, which has
//              the same pass without the second line. The two "and"s that merge its results into the hit condition are
//              fed the first test's result instead; nothing is inserted, and the second line's instructions run with
//              nothing reading them. Gentle beaches and the far rims of puddles mirror themselves into the water
// A blob is patched only when it is the shader this was written for: its CRC32 (the dump names the files by it) must be
// the name, and the hit test is then found by its instructions, not by offsets. slope relies on that identity: it
// rewrites minRise's register every step, which is free there in these two shaders. The result is checked with
// dxbc_lint.js (no undeclared input component read).
// Library: patchReflHits(hash, blob, mode) -> Buffer (throws on anything unexpected); TARGETS; parseMode(text).
// usage: node patch_refl_hits.js [mode=slope] [outDir]     writes 0x44F6CB1D.shader and 0x8E21C0FB.shader
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, dxbcChecksum, f32, ins } = require('./dxbc_patch.js');
const { undeclaredInputReads } = require('./dxbc_lint.js');
const { crc32, hex8 } = require('./sdc_side.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const TARGETS = ['44F6CB1D', '8E21C0FB'];
const OP = { add: 0, and: 1, if: 31, lt: 49, mad: 50, mul: 56, ult: 79 };
const destOne = (reg, c) => [(0x00100002 | ((1 << c) << 4)) >>> 0, reg];
const srcOne = (reg, c) => [(0x0010000a | (c << 4)) >>> 0, reg];
const imm1 = (v) => [0x4001, f32(v)];
// one component of a temp register as an operand names it: [register, component], or null for anything else
function comp(o)
{
    if (!o || o.type !== 0 || o.dim !== 1 || o.rep[0] !== 0 || o.size !== 8) return null;
    if (o.mode === 2) return [o.idx[0], o.sel & 3];
    const c = o.mode === 0 ? [1, 2, 4, 8].indexOf(o.sel & 15) : -1;
    return c < 0 ? null : [o.idx[0], c];
}
const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

function parseMode(text)
{
    const m = /^(off|slope)(?::([0-9.]+))?$/.exec(text || 'slope');
    if (!m) throw new Error('unknown mode "' + text + '": slope[:c] or off');
    const v = m[2] === undefined ? null : parseFloat(m[2]);
    if (m[1] === 'off') { if (v !== null) throw new Error('mode off takes no value'); return { kind: 'off', name: 'off' }; }
    const c = v === null ? 0.5 : v;
    if (!(c > 0 && c < 1)) throw new Error('slope: c must lie between 0 and 1');
    return { kind: 'slope', c, name: 'slope' + (v === null ? '' : '_' + c) };
}

// The hit test, as the march's loop holds it once:
//   mad Q, k, z, -tol          the height a texel covers at the sampled depth, less tol
//   mad A, ...                 mad T, Q, i, A
//   add R, -T(previous), T     ult X, T, l(1.0)        unsigned: also 0 <= T
//   lt H, minH, T              and X, X, H
//   lt R, minRise, R           and R, R, X             if_nz R
function hitTest(blob)
{
    const w = walk(blob), order = [OP.mad, OP.mad, OP.mad, OP.add, OP.ult, OP.lt, OP.and, OP.lt, OP.and, OP.if];
    const found = [];
    for (let at = 0; at + order.length <= w.insts.length; at++)
    {
        if (!order.every((op, k) => w.insts[at + k].op === op)) continue;
        const [qtol, , tmad, rise, ult, ltH, andH, ltR, andR, ifnz] = order.map((op, k) => operands(blob, w.insts[at + k]));
        const Q = comp(qtol[0]), T = comp(ult[1]), X = comp(ult[0]), H = comp(ltH[0]), R = comp(ltR[0]), minRise = comp(ltR[1]);
        if (!(ult[2].type === 4 && ult[2].imm.length === 1 && ult[2].imm[0] === f32(1))) continue;
        if (!(same(comp(tmad[0]), T) && same(comp(tmad[1]), Q) && same(comp(rise[0]), R) && same(comp(rise[2]), T) && same(comp(ltH[2]), T) &&
            same(comp(andH[0]), X) && same(comp(andH[1]), X) && same(comp(andH[2]), H) && same(comp(ltR[2]), R) &&
            same(comp(andR[0]), R) && same(comp(andR[1]), R) && same(comp(andR[2]), X) && same(comp(ifnz[0]), R) && minRise)) continue;
        found.push({ Q, minRise, afterQ: w.insts[at + 1].off, andH, andR });
    }
    if (found.length !== 1) throw new Error('the march\'s hit test was found ' + found.length + ' times');
    return found[0];
}

function patchReflHits(hash, blob, mode)
{
    if (!TARGETS.includes(hash)) throw new Error('0x' + hash + ' is not one of the reflection pass shaders (' + TARGETS.map((h) => '0x' + h).join(', ') + ')');
    if (hex8(crc32(blob)) !== hash) throw new Error('0x' + hash + ': not the shader this patch was made for (CRC32 ' + hex8(crc32(blob)) + '): another game version, left as it is');
    const t = hitTest(blob);
    let out;
    if (mode.kind === 'off')
    {
        out = Buffer.from(blob);
        blob.copy(out, t.andH[2].off, t.andH[1].off, t.andH[1].off + 8);   // and X, X, X
        blob.copy(out, t.andR[1].off, t.andR[2].off, t.andR[2].off + 8);   // and R, X, X
        dxbcChecksum(out.subarray(20)).copy(out, 4);
    }
    else if (mode.kind === 'slope')
    {
        const mul = ins(OP.mul, [...destOne(t.minRise[0], t.minRise[1]), ...srcOne(t.Q[0], t.Q[1]), ...imm1(mode.c)]);
        out = insertWords(blob, [{ at: t.afterQ, words: mul }], { stat: { instructions: 1, floatInstructions: 1 } });
    }
    else throw new Error('mode');

    // the result: still walks, one instruction more at most, nothing the lint objects to
    if (walk(out).insts.length !== walk(blob).insts.length + (mode.kind === 'off' ? 0 : 1)) throw new Error('0x' + hash + ': the patched code does not read back');
    if (undeclaredInputReads(out).length) throw new Error('0x' + hash + ': the patched code reads an input component it does not declare');
    return out;
}

module.exports = { patchReflHits, parseMode, TARGETS };

if (require.main === module)
{
    const mode = parseMode(process.argv[2]);
    const outDir = process.argv[3] || path.join(W, 'replacements', 'refl_hits', mode.name);
    const done = [];
    for (const hash of TARGETS)
    {
        const file = path.join(DUMP, '0x' + hash + '.cso');
        if (!fs.existsSync(file)) throw new Error('0x' + hash + ' is not among the game\'s shaders in ' + DUMP + ': another game version, nothing written');
        const blob = fs.readFileSync(file);
        done.push([hash, blob.length, patchReflHits(hash, blob, mode)]);
    }
    fs.mkdirSync(outDir, { recursive: true });
    for (const [hash, , out] of done) fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), out);
    console.log('lake reflection hit rule (' + mode.name + (mode.kind === 'slope' ? ', c ' + mode.c : '') + '): ' +
        done.map(([hash, size, out]) => '0x' + hash + ' ' + size + ' -> ' + out.length + ' bytes').join(', ') + ', in ' + outDir);
}
