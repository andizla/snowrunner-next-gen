// Screen-space reflections spliced into SnowRunner's wet-ground shaders (the terrain and the models that get wet, the
// pixel shaders that read g_txWaterMap): replacements\puddles\puddle_ssr.hlsl, compiled to puddle_ssr.cso next to it,
// takes the place of the shader's one reflection sample, the cubemap read with the mip level sqrt(roughness) * 8 + 0.5
// (sample_l ... t86 whose mip level comes from mad x, y, l(8), l(0.5)). Right after that sample every such shader turns
// it into light with four multiplies: by g_fReflCubeGGXScale (cb2[57].y), by the material's reflectivity (cb5[..].w),
// by the sky visibility (one component of a temp) and by the ambient colour (a temp); the helper gets the last two,
// the direction, the mip level and the pixel's world position (the input the shader subtracts from the eye position).
// The shader also gets what the helper reads and it lacked: t120 and t121 (the previous frame's scene colour and linear
// depth, which SnowRunner Shadows binds when it sees t120 declared) and cb1 up to register 13 (the previous frame's
// view-projection). A shader is left as it is unless the sample, its four multiplies and the world position are found.
// Works on a stock shader or on one the other modules already patched.
// The water decals (the terrain decals that name g_txWaterNormals, drawn over the ground with the same reflection
// sample and multiplies) take the decal build of the helper (puddle_ssr_decal.cso: their input is a point of the box
// they draw, the helper finds the ground behind it in this frame's depth, t80, which they declare; PSSR_CALM turns the
// reflected ray towards a still mirror's). The road puddles are neither terrain nor decal: the planar water shaders
// draw them (patch_water_planar.js).
// Library: patchPuddle(blob[, helper]) -> { blob } or { reason }; targets() -> the wet-ground pixel shaders in dump\;
// decalTargets() -> the water decals in dump\ (give isDecal ones, patch_gi.js, HELPER_DECAL).
// usage: node patch_puddle.js    what it would do to the stock shaders
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');
const { splice, comps, reswizzle, maskOf, bitsOf, tokens, words } = require('./patch_water_mix.js');
const { targets } = require('./patch_glare.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'puddles', 'puddle_ssr.cso');
const HELPER_DECAL = path.join(W, 'replacements', 'puddles', 'puddle_ssr_decal.cso');

// the water decals: the pixel shaders in dump\ that name g_txWaterNormals
function decalTargets()
{
    const idx = JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
    return idx.filter((r) => /^ps/.test(r.profile) && (r.res || []).some((x) => x.name === 'g_txWaterNormals')).map((r) => r.hash);
}
const OP = { add: 0, mad: 50, mul: 56, sample_l: 72, dcl_resource: 88, dcl_constantbuffer: 89, dcl_sampler: 90, dcl_temps: 104 };
const F8 = 0x41000000, F05 = 0x3f000000; // 8.0f, 0.5f
const FEED = [120, 121];                 // previous scene colour, previous linear depth

// dcl_resource_texture2d (float,float,float,float) tN
const dclTexture2D = (slot) => words(OP.dcl_resource | (3 << 11) | (4 << 24), 0x00107000, slot, 0x00005555);

// declarations inserted at a byte offset inside the shader code, the container's sizes, offsets and checksum repaired
function insertAt(b, at, insert)
{
    const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
    const out = Buffer.concat([b.subarray(0, at), insert, b.subarray(at)]);
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(shex.size + insert.length, shex.off + 4);
    out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + insert.length / 4, shex.data + 4);
    for (let i = 0, n = b.readUInt32LE(28); i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + insert.length, 32 + i * 4); }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return out;
}

// the declarations the helper needs: cb1 to register 13, cb2 to register 57, t120 and t121 (before dcl_temps, where
// fxc puts texture declarations); null when a sampler or the cubemap the helper uses is not declared
function declare(b)
{
    const out = Buffer.from(b);
    const w = walk(out);
    const L = w.insts.map((x) => ({ x, o: operands(out, x) }));
    const need = { 1: 14, 2: 58 };
    for (const e of L)
    {
        if (e.x.op !== OP.dcl_constantbuffer || e.o[0].type !== 8) continue;
        const slot = e.o[0].idx[0], at = e.o[0].off + e.o[0].size - 4;
        if (need[slot] && out.readUInt32LE(at) < need[slot]) out.writeUInt32LE(need[slot], at);
        delete need[slot];
    }
    if (Object.keys(need).length) return null;
    const samplers = new Set(L.filter((e) => e.x.op === OP.dcl_sampler).map((e) => e.o[0].idx[0]));
    const textures = new Set(L.filter((e) => e.x.op === OP.dcl_resource).map((e) => e.o[0].idx[0]));
    if (!samplers.has(2) || !samplers.has(8) || !textures.has(86)) return null;
    const add = FEED.filter((t) => !textures.has(t)).map(dclTexture2D);
    if (!add.length) { dxbcChecksum(out.subarray(20)).copy(out, 4); return out; }
    return insertAt(out, w.insts.find((x) => x.op === OP.dcl_temps).off, Buffer.concat(add));
}

function patchPuddle(b, helper = fs.readFileSync(HELPER))
{
    const d = declare(b);
    if (!d) return { reason: 'constant buffers, samplers or the cubemap not declared as expected' };
    const w = walk(d);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(d, x) }));
    // the reflection sample: sample_l of the cubemap whose mip level was made by mad x, y, 8, 0.5
    const lastWrite = (i, reg) => L.slice(0, i).reverse().find((e) => e.o[0] && e.o[0].type === 0 && e.o[0].idx[0] === reg && maskOf(e.o[0]));
    const imm = (o, v) => o && o.type === 4 && o.imm.includes(v);
    const samples = L.filter((e) => e.x.op === OP.sample_l && e.o[2] && e.o[2].type === 7 && e.o[2].idx[0] === 86 && e.o[4] && e.o[4].type === 0 && e.o[0].type === 0 &&
        (() => { const m = lastWrite(e.i, e.o[4].idx[0]); return m && m.x.op === OP.mad && imm(m.o[2], F8) && imm(m.o[3], F05); })());
    if (samples.length !== 1) return { reason: 'reflection samples: ' + samples.length };
    // a helper never reads a texture the shader does not declare, apart from the feed (the decal build reads this
    // frame's depth, t80, which only the decals declare)
    const own = new Set(L.filter((e) => e.x.op === OP.dcl_resource).map((e) => e.o[0].idx[0]));
    const hw = walk(helper), missing = hw.insts.filter((x) => x.op === OP.dcl_resource).map((x) => operands(helper, x)[0].idx[0]).filter((t) => !own.has(t));
    if (missing.length) return { reason: 'the helper reads t' + missing.join(', t') + ', which the shader does not declare' };
    const s = samples[0], dst = s.o[0], dm = maskOf(dst), reg = dst.idx[0];
    // its four multiplies: scale, reflectivity, visibility, ambient; each reads the value where the one before put it
    // (the last one sometimes writes into the ambient colour's register instead of the sample's)
    let cur = { reg, mask: dm };
    const factor = (e) =>
    {
        const m = e.o[0] && e.o[0].type === 0 ? maskOf(e.o[0]) : 0;
        if (e.x.op !== OP.mul || bitsOf(m).length !== bitsOf(dm).length) return null;
        const isValue = (o) => o.type === 0 && o.idx[0] === cur.reg && comps(o, m).join() === bitsOf(cur.mask).join();
        const other = isValue(e.o[1]) ? e.o[2] : isValue(e.o[2]) ? e.o[1] : null;
        if (other) cur = { reg: e.o[0].idx[0], mask: m };
        return other && { o: other, m };
    };
    const f = [];
    for (const e of L.slice(s.i + 1, s.i + 5)) { const x = factor(e); if (!x) break; f.push(x); }
    if (f.length !== 4) return { reason: 'the multiplies after the sample differ' };
    if (!(f[0].o.type === 8 && f[0].o.idx[0] === 2 && f[0].o.idx[1] === 57) || f[1].o.type !== 8) return { reason: 'scale or reflectivity not where expected' };
    const vis = f[2].o, amb = f[3].o, visComps = comps(vis, f[2].m), ambComps = comps(amb, f[3].m);
    if (vis.type !== 0 || amb.type !== 0 || new Set(visComps).size !== 1) return { reason: 'visibility or ambient not a temp' };
    if (amb.idx[0] === reg && ambComps.some((c) => dm & (1 << c))) return { reason: 'ambient shares the sample register' };
    // the world position: add r, cb1[0], -vN
    const eye = (o) => o.type === 8 && o.idx[0] === 1 && o.idx[1] === 0;
    const pos = L.find((e) => e.x.op === OP.add && e.o.length === 3 && ((eye(e.o[1]) && e.o[2].type === 1) || (eye(e.o[2]) && e.o[1].type === 1)));
    if (!pos) return { reason: 'no world position' };
    const world = eye(pos.o[1]) ? pos.o[2].idx[0] : pos.o[1].idx[0];
    // the input must be declared with x, y and z; it is read as vN.xyzx, never .xyzw: the terrain declares its world
    // position with three components, and a swizzle that names the missing w makes NVIDIA's driver (616.92) map it to
    // a register past a 52-entry table in its background compiler (the game crashes) although D3D ignores the lane
    // the destination does not write
    const dcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0].type === 1 && e.o[0].idx[0] === world);
    if (!dcl || (dcl.o[0].sel & 7) !== 7) return { reason: 'the world position input is not declared with x, y and z' };
    return splice(d, w, s, helper, 5, [
        [7, tokens(d, s.o[1])],                        // the direction, as the sample took it
        [1, reswizzle(d, s.o[4], [s.o[4].sel & 3])],   // the mip level
        [7, words(0x00101246, world)],                 // the world position, vN.xyzx
        [1, reswizzle(d, vis, visComps)],              // the sky visibility
        [7, reswizzle(d, amb, ambComps)],              // the ambient colour
    ], dst);
}

module.exports = { patchPuddle, targets, decalTargets, HELPER, HELPER_DECAL, insertAt, dclTexture2D }; // (the last two: patch_water_planar.js too)

if (require.main === module)
{
    const { isDecal } = require('./patch_gi.js');
    const run = (list, pick) =>
    {
        const report = { targets: 0, patched: 0, skipped: {} };
        for (const hash of list)
        {
            report.targets++;
            const b = fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper = pick(b);
            const r = helper ? patchPuddle(b, helper) : { reason: 'not a decal' };
            if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
            report.patched++;
        }
        return report;
    };
    const helper = fs.readFileSync(HELPER), decal = fs.readFileSync(HELPER_DECAL);
    console.log('wet ground: ' + JSON.stringify(run(targets(), () => helper)));
    console.log('water decals: ' + JSON.stringify(run(decalTargets(), (b) => isDecal(b) ? decal : null)));
}
