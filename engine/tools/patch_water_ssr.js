// Screen-space reflections spliced into SnowRunner's water shaders (replacements\water\ssr.hlsl, compiled to ssr.cso
// next to it, and to ssr_t5.cso for the lake and sea shaders). The stock river and mud shaders, and the lake and sea
// ("domain") shaders without a planar reflection, reflect only the sky cubemap. This replaces their one cubemap
// reflection sample (sample ... t86, s8) with the helper, fed the sample's direction and the pixel's world position (the
// input the shader subtracts from the eye position cb1[0]); the helper's colour goes where the sample wrote.
// A shader is left as it is unless: exactly one such sample, the world position found, g_txZ read at t80 with s0 only,
// g_txBBOpaque (t4 in rivers, t5 in lakes and seas) with s2 only, the cubemap at t86 with s8 only, cb1 declared with 6
// registers or more, and the sample outside any loop with nothing after it reading a register only the sample wrote.
// Lakes that reflect a planar reflection image sample the cubemap only with sample_l and are left alone here. Works on a
// stock shader or on one the other modules already patched (sky ambient, shadow filter), since it only looks for that
// one sample.
// Library: patchWater(blob[, helper[, opaque slot]]) -> { blob } or { reason }; targets() -> the river shaders' hashes
// in dump\, domainTargets() -> the lake and sea shaders' hashes (g_txBBOpaque at t5).
// usage: node patch_water_ssr.js [outDir]    the set built on the stock shaders (default replacements\water\ssr_river)
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange, safeToReplace } = require('./shadow_filter_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'water', 'ssr.cso');
const OP = { add: 0, mov: 54, sample: 69, sample_l: 72, sample_d: 73, sample_b: 74, dcl_constantbuffer: 89, dcl_temps: 104 };

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((OP.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);  // rN.xyzw
// vN.xyzx: the copy writes x, y and z only, and a swizzle naming a component the input does not declare (vN.xyzw on
// a three-component input) crashes NVIDIA's driver (see patch_puddle.js)
const inputSrc = (reg) => words(0x00101246, reg);
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);

function patchWater(b, helper = fs.readFileSync(HELPER), opaqueSlot = 4)
{
    const w = walk(b);
    let cb1 = 0, world = -1;
    const cube = [], samplerOf = {};
    w.insts.forEach((x, i) =>
    {
        const o = operands(b, x);
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8 && o[0].idx[0] === 1) cb1 = o[0].idx[1];
        if ([OP.sample, OP.sample_l, OP.sample_d, OP.sample_b].includes(x.op) && o[2] && o[2].type === 7 && o[3] && o[3].type === 6)
        {
            (samplerOf[o[2].idx[0]] = samplerOf[o[2].idx[0]] || new Set()).add(o[3].idx[0]);
            if (x.op === OP.sample && o[2].idx[0] === 86) cube.push({ i, o });
        }
        if (x.op === OP.add && o.length === 3 && world < 0)
        {
            const eye = (p) => p.type === 8 && p.idx[0] === 1 && p.idx[1] === 0;
            if (eye(o[1]) && o[2].type === 1) world = o[2].idx[0];
            else if (eye(o[2]) && o[1].type === 1) world = o[1].idx[0];
        }
    });
    if (cube.length !== 1) return { reason: 'cubemap reflection samples: ' + cube.length };
    if (world < 0) return { reason: 'no world position' };
    if (cb1 < 6) return { reason: 'cb1 declared with ' + cb1 + ' registers' };
    const only = (t, s) => samplerOf[t] && samplerOf[t].size === 1 && samplerOf[t].has(s);
    if (!only(80, 0) || !only(opaqueSlot, 2) || !only(86, 8)) return { reason: 'texture or sampler slots differ' };
    const { i, o } = cube[0];
    if (o[0].type !== 0) return { reason: 'the sample writes something other than a temp' };
    const unsafe = safeToReplace(b, { w, start: i, end: i, out: o[0] });
    if (unsafe) return { reason: unsafe };
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 2);
    const insert = Buffer.concat([
        movInst(tempDest(h.IN(0), 7), tokens(b, o[1])), // the direction, as the sample took it
        movInst(tempDest(h.IN(1), 7), inputSrc(world)), // the world position
        ...h.body,
        movInst(tokens(b, o[0]), tempSrc(h.RES)),        // the colour, where the sample wrote it
    ]);
    const x = w.insts[i];
    return { blob: replaceRange(b, x.off, x.off + x.len * 4, insert, h.temps, h.body.length + 2) };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const binds = (r, name, slot) => (r.res || []).some((x) => x.name === name && (slot === undefined || x.bind === slot));
// the river and mud water shaders: pixel shaders that bind foam and the opaque scene
function targets()
{
    return index().filter((r) => /^ps/.test(r.profile) && binds(r, 'g_txFoam') && binds(r, 'g_txBBOpaque')).map((r) => r.hash);
}
// the lake and sea shaders: pixel shaders that bind the water domain map and the opaque scene at t5
function domainTargets()
{
    return index().filter((r) => /^ps/.test(r.profile) && binds(r, 'g_txDomain') && binds(r, 'g_txBBOpaque', 5)).map((r) => r.hash);
}

module.exports = { patchWater, targets, domainTargets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'water', 'ssr_river');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, skipped: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchWater(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
