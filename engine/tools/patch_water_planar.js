// Screen-space reflections spliced into SnowRunner's planar-reflection water shaders (replacements\water\ssr_planar.hlsl,
// compiled to ssr_planar.cso next to it): the 88 lake, sea and puddle shaders that sample the engine's planar reflection
// image (g_txReflections, t4 with s2) once and reflect no cubemap. Every body of water seen in play, road puddles
// included, is one of these; the 20 river and 88 cube-only lake shaders that patch_water_ssr.js covers were not drawn
// in those scenes (other settings may use them).
// The splice replaces the planar sample with the helper, fed the sample's texture coordinate, the pixel's world position
// (the input the shader subtracts from the eye position cb1[0]) and the wave normal's x and z: the register the shader
// projects with the view matrix rows cb1[6].xz and cb1[8].xz (two dp2) for the distortion of that coordinate, copied into
// one of the helper's temps right after that pair, because the shader overwrites it before the sample. The helper's
// result goes where the sample wrote (rgb reflection, a the planar alpha).
// A shader is left as it is unless: exactly one `sample` of t4, with s2 only; g_txZ (t80) with s0 only; g_txBBOpaque (t5)
// with s2 only; the world position found; cb1 declared with 6 registers or more; the dp2 pair found before the sample;
// nothing after the sample reads a register only the sample wrote. Works on a stock shader or on one the other modules
// patched already (they touch other instructions).
// Library: patchPlanar(blob[, helper]) -> { blob, note } or { reason }; planarTargets() -> the hashes in dump\.
// usage: node patch_water_planar.js [outDir]    the set built on the stock shaders (default replacements\water\ssr_planar_set)
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange, safeToReplace } = require('./shadow_filter_patch.js');
const { insertAt, dclTexture2D } = require('./patch_puddle.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'water', 'ssr_planar.cso');
const OP = { add: 0, dp2: 15, mov: 54, sample: 69, sample_c: 70, sample_c_lz: 71, sample_l: 72, sample_d: 73, sample_b: 74, dcl_resource: 88, dcl_constantbuffer: 89, dcl_temps: 104 };
const SAMPLES = [OP.sample, OP.sample_c, OP.sample_c_lz, OP.sample_l, OP.sample_d, OP.sample_b];

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((OP.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);  // rN.xyzw
const inputSrc = (reg) => words(0x00101246, reg); // vN.xyzx (never a component the input does not declare, see patch_puddle.js)
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);

// the textures the helper reads that the shader does not declare (the reflection pass's depth pyramid, t125:
// SnowRunner Shadows binds it where it sees it declared), declared before dcl_temps as fxc puts them; the shader as
// it is when there are none
function declareMissing(b, helper)
{
    const slots = (blob) => walk(blob).insts.filter((x) => x.op === OP.dcl_resource).map((x) => operands(blob, x)[0].idx[0]);
    const own = new Set(slots(b)), need = slots(helper).filter((t) => !own.has(t));
    // constant buffers the helper reads that the shader lacks (b13: SnowRunner Shadows' copy of the fog composite's
    // constants): the helper's own declaration, before the shader's first one
    const cbs = (blob) => walk(blob).insts.filter((x) => x.op === OP.dcl_constantbuffer).map((x) => ({ x, slot: operands(blob, x)[0].idx[0] }));
    const ownCb = new Set(cbs(b).map((c) => c.slot)), needCb = cbs(helper).filter((c) => !ownCb.has(c.slot));
    let out = b;
    if (needCb.length)
    {
        const first = walk(out).insts.find((x) => x.op === OP.dcl_constantbuffer) || walk(out).insts.find((x) => x.op === OP.dcl_temps);
        out = insertAt(out, first.off, Buffer.concat(needCb.map((c) => helper.subarray(c.x.off, c.x.off + c.x.len * 4))));
    }
    if (!need.length) return out;
    return insertAt(out, walk(out).insts.find((x) => x.op === OP.dcl_temps).off, Buffer.concat(need.map(dclTexture2D)));
}

function patchPlanar(b0, helper = fs.readFileSync(HELPER))
{
    const b = declareMissing(b0, helper);
    const w = walk(b);
    let cb1 = 0, world = -1;
    const planar = [], samplerOf = {}, dp2s = [];
    const isCb1 = (p, reg) => p && p.type === 8 && p.idx[0] === 1 && p.idx[1] === reg;
    w.insts.forEach((x, i) =>
    {
        const o = operands(b, x);
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8 && o[0].idx[0] === 1) cb1 = o[0].idx[1];
        if (SAMPLES.includes(x.op) && o[2] && o[2].type === 7 && o[3] && o[3].type === 6)
        {
            (samplerOf[o[2].idx[0]] = samplerOf[o[2].idx[0]] || new Set()).add(o[3].idx[0]);
            if (x.op === OP.sample && o[2].idx[0] === 4) planar.push({ i, o });
        }
        if (x.op === OP.add && o.length === 3 && world < 0)
        {
            const eye = (p) => p.type === 8 && p.idx[0] === 1 && p.idx[1] === 0;
            if (eye(o[1]) && o[2].type === 1) world = o[2].idx[0];
            else if (eye(o[2]) && o[1].type === 1) world = o[1].idx[0];
        }
        if (x.op === OP.dp2 && o.length === 3 && o[1].type === 0 && (isCb1(o[2], 6) || isCb1(o[2], 8))) dp2s.push({ i, o, row: o[2].idx[1] });
    });
    if (planar.length !== 1) return { reason: 'planar reflection samples: ' + planar.length };
    if (world < 0) return { reason: 'no world position' };
    if (cb1 < 6) return { reason: 'cb1 declared with ' + cb1 + ' registers' };
    const only = (t, s) => samplerOf[t] && samplerOf[t].size === 1 && samplerOf[t].has(s);
    if (!only(80, 0) || !only(4, 2) || !only(5, 2)) return { reason: 'texture or sampler slots differ' };
    const { i, o } = planar[0];
    if (o[0].type !== 0) return { reason: 'the sample writes something other than a temp' };
    if (o[1].type !== 0) return { reason: 'the sample coordinate is not a temp' };
    // the last pair of dp2 before the sample that project one temp's two components with rows 6 and 8: the normal's x, z
    let pair = null;
    for (let k = dp2s.length - 1; k >= 1 && !pair; k--)
    {
        const a = dp2s[k - 1], c = dp2s[k];
        if (c.i >= i || a.o[1].idx[0] !== c.o[1].idx[0] || a.o[1].sel !== c.o[1].sel || a.o[1].mode !== c.o[1].mode || a.row === c.row || c.i - a.i > 4) continue;
        pair = { a, c };
    }
    if (!pair) return { reason: 'no view-projected normal before the planar sample' };
    const unsafe = safeToReplace(b, { w, start: i, end: i, out: o[0] });
    if (unsafe) return { reason: unsafe };
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 3);
    // at the sample: the coordinate and the world position in, the helper, its result where the sample wrote
    const atSample = Buffer.concat([
        movInst(tempDest(h.IN(0), 3), tokens(b, o[1])),
        movInst(tempDest(h.IN(1), 7), inputSrc(world)),
        ...h.body,
        movInst(tokens(b, o[0]), tempSrc(h.RES)),
    ]);
    const x = w.insts[i];
    let out = replaceRange(b, x.off, x.off + x.len * 4, atSample, h.temps, h.body.length + 3);
    // right after the dp2 pair (earlier in the code, so its offsets still hold): the normal's x and z into the helper's
    // third input, with the swizzle the dp2 read them with
    const last = w.insts[pair.c.i], end = last.off + last.len * 4;
    out = replaceRange(out, end, end, movInst(tempDest(h.IN(2), 3), tokens(b, pair.c.o[1])), 0, 1);
    return { blob: out, note: 'planar sample r' + o[0].idx[0] + ' at ' + i + ', world v' + world + ', normal r' + pair.c.o[1].idx[0] + ' from ' + pair.c.i };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const binds = (r, name, slot) => (r.res || []).some((x) => x.name === name && (slot === undefined || x.bind === slot));
// the lake, sea and puddle shaders with the planar reflection: the water domain map, g_txReflections at t4, the opaque scene at t5
function planarTargets()
{
    return index().filter((r) => /^ps/.test(r.profile) && binds(r, 'g_txDomain') && binds(r, 'g_txReflections', 4) && binds(r, 'g_txBBOpaque', 5)).map((r) => r.hash);
}

module.exports = { patchPlanar, planarTargets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'water', 'ssr_planar_set');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, skipped: {}, notes: {} };
    for (const hash of planarTargets())
    {
        report.targets++;
        const r = patchPlanar(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.notes[hash] = r.note;
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targets: report.targets, patched: report.patched, skipped: report.skipped }));
}
