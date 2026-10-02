// Screen-space reflections spliced into SnowRunner's object material shaders (replacements\reflections\object_ssr.hlsl,
// compiled to object_ssr.cso next to it): the PBR pixel shaders of vehicles and props that reflect the environment
// cubemap once per pixel at the mip level sqrt(roughness) * 8 + 0.5 (sample_l ... t86 with s8, the level from
// "mad x, y, l(8), l(0.5)"). The helper takes that sample's place, fed the direction as sampled, the mip level and the
// pixel's world position (the input the shader subtracts from the eye position cb1[0]); its colour goes where the sample
// wrote, in the cubemap's units, so the stock multiplies after it (g_fReflCubeGGXScale, reflectivity, Fresnel) stay.
// The shader also gets what the helper reads and it lacked: t120 and t121 (the previous frame's scene colour and linear
// depth, which SnowRunner Shadows binds when it sees them declared; declared before dcl_temps, where fxc puts textures)
// and cb1 up to register 13 (the previous frame's view-projection: the declaration is widened in place).
// A shader is left as it is unless: exactly one such sample; the world position found and its input declared with x, y
// and z (an input read beyond its declaration crashes NVIDIA's compiler, see patch_puddle.js); s2 and s8 declared; cb2
// (the sample may write its colour to .xyz or to packed components such as .yzw: the result is swizzled to match);
// declared to register 57 (g_fReflCubeGGXScale); nothing after the sample reads a register only the sample wrote.
// Works on a stock shader or on one the other modules patched already (they touch other instructions).
// Library: patchObject(blob[, helper]) -> { blob, note } or { reason }; targets() -> the hashes in dump\.
// usage: node patch_object_ssr.js [outDir]    the set built on the stock shaders (default replacements\reflections\set)
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange, safeToReplace } = require('./shadow_filter_patch.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'reflections', 'object_ssr.cso');
const OP = { add: 0, mad: 50, mov: 54, sample_l: 72, dcl_resource: 88, dcl_constantbuffer: 89, dcl_sampler: 90, dcl_temps: 104 };
// the DLL-fed textures a helper reads (t120 and above), declared in the target when it lacks them: t120/t121 for the
// marching helper, t121/t123/t124 for the reflection-pass helper (replacements\sssr\object_sssr.cso)
function feedTextures(helper)
{
    const slots = [];
    for (const x of walk(helper).insts) if (x.op === OP.dcl_resource) { const o = operands(helper, x); if (o[0] && o[0].idx[0] >= 120) slots.push(o[0].idx[0]); }
    return slots.length ? slots.sort((a, b) => a - b) : [120, 121];
}

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const f32 = (u) => { const b = Buffer.alloc(4); b.writeUInt32LE(u >>> 0); return b.readFloatLE(0); };
const movInst = (dest, src) => Buffer.concat([words((OP.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);  // rN.xyzw
// rN swizzled so that its x, y, z land on the components of a destination mask, in order: a sample that writes .yzw
// (its colour in packed components) takes the helper's result as .xxyz, one that writes .xyz as .xyzw
function resultSrc(reg, mask)
{
    const comps = [0, 1, 2, 3].filter((c) => mask & (1 << c));
    const swz = [0, 0, 0, 0];
    comps.forEach((c, k) => { swz[c] = k; });
    return words(0x00100006 | ((swz[0] | (swz[1] << 2) | (swz[2] << 4) | (swz[3] << 6)) << 4), reg);
}
const inputSrc = (reg) => words(0x00101246, reg); // vN.xyzx
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);
// dcl_resource_texture2d (float,float,float,float) tN: opcode 88, dimension texture2d in bits 11..15, 4 tokens
const dclTexture2D = (slot) => words(OP.dcl_resource | (3 << 11) | (4 << 24), 0x00107000, slot, 0x00005555);

// bytes inserted at a byte offset inside the shader code; the container's sizes, chunk offsets and checksum follow
// (dcl_temps is not touched: this is for declarations in front of it)
function insertAt(b, at, bytes)
{
    const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
    const out = Buffer.concat([b.subarray(0, at), bytes, b.subarray(at)]);
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(shex.size + bytes.length, shex.off + 4);
    out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + bytes.length / 4, shex.data + 4);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + bytes.length, 32 + i * 4); }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return out;
}

function patchObject(b, helper = fs.readFileSync(HELPER))
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let world = -1, cb1 = null, cb2 = 0;
    const madTemps = new Set(), cubes = [], samplers = new Set(), textures = new Set();
    for (const e of L)
    {
        const { x, o } = e;
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8) { if (o[0].idx[0] === 1) cb1 = e; if (o[0].idx[0] === 2) cb2 = o[0].idx[1]; }
        if (x.op === OP.dcl_sampler && o[0]) samplers.add(o[0].idx[0]);
        if (x.op === OP.dcl_resource && o[0]) textures.add(o[0].idx[0]);
        if (x.op === OP.mad && o.length === 4 && o[0].type === 0 && o[2].type === 4 && o[3].type === 4 && Math.abs(f32(o[2].imm[0]) - 8) < 1e-6 && Math.abs(f32(o[3].imm[0]) - 0.5) < 1e-6) madTemps.add(o[0].idx[0]);
        if (x.op === OP.sample_l && o[2] && o[2].type === 7 && o[2].idx[0] === 86 && o[3] && o[3].type === 6 && o[4] && o[4].type === 0 && madTemps.has(o[4].idx[0])) cubes.push(e);
        if (x.op === OP.add && o.length === 3 && world < 0)
        {
            const eye = (p) => p.type === 8 && p.idx[0] === 1 && p.idx[1] === 0;
            if (eye(o[1]) && o[2].type === 1) world = o[2].idx[0];
            else if (eye(o[2]) && o[1].type === 1) world = o[1].idx[0];
        }
    }
    if (cubes.length !== 1) return { reason: 'roughness-mip cubemap samples: ' + cubes.length };
    if (world < 0) return { reason: 'no world position' };
    if (!cb1) return { reason: 'no cb1' };
    if (cb2 < 58) return { reason: 'cb2 declared with ' + cb2 + ' registers' };
    if (!samplers.has(2) || !samplers.has(8)) return { reason: 'samplers s2 or s8 not declared' };
    const dcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0].type === 1 && e.o[0].idx[0] === world);
    if (!dcl || (dcl.o[0].sel & 7) !== 7) return { reason: 'the world position input is not declared with x, y and z' };
    const { i, o } = cubes[0];
    if (cubes[0].o[3].idx[0] !== 8) return { reason: 'the cubemap sampler is s' + cubes[0].o[3].idx[0] };
    if (o[0].type !== 0 || o[1].type !== 0) return { reason: 'the sample does not read and write temps' };
    const unsafe = safeToReplace(b, { w, start: i, end: i, out: o[0] });
    if (unsafe) return { reason: unsafe };
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 3);
    const atSample = Buffer.concat([
        movInst(tempDest(h.IN(0), 7), tokens(b, o[1])),   // the direction, as the sample took it
        movInst(tempDest(h.IN(1), 1), tokens(b, o[4])),   // the mip level
        movInst(tempDest(h.IN(2), 7), inputSrc(world)),   // the world position
        ...h.body,
        movInst(tokens(b, o[0]), resultSrc(h.RES, o[0].sel & 15)),
    ]);
    const x = w.insts[i];
    let out = replaceRange(b, x.off, x.off + x.len * 4, atSample, h.temps, h.body.length + 4);
    // cb1 widened to 14 registers in place (its size is the operand's last index token; before the code, so the offset holds)
    if (cb1.o[0].idx[1] < 14) out.writeUInt32LE(14, cb1.o[0].off + cb1.o[0].size - 4);
    // the feed textures declared in front of dcl_temps (the spliced code lies after it, so this offset holds too)
    const FEED = feedTextures(helper);
    const add = FEED.filter((t) => !textures.has(t)).map(dclTexture2D);
    if (add.length) out = insertAt(out, w.insts.find((x) => x.op === OP.dcl_temps).off, Buffer.concat(add));
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: 'sample r' + o[0].idx[0] + ' at ' + i + ', world v' + world + ', cb1 ' + cb1.o[0].idx[1] + ' -> 14, added t' + FEED.filter((t) => !textures.has(t)).join(', t') };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const binds = (r, name) => (r.res || []).some((x) => x.name === name);
// the object materials: PBR pixel shaders with the cubemap, not water, not the wet-ground terrain, not decals
function targets()
{
    return index().filter((r) => /^ps/.test(r.profile) && ['g_txReflCubeGGX', 'g_txPbrParams', 'g_txBrdfLutGGX'].every((t) => binds(r, t)) &&
        !['g_txWaterMap', 'g_txDomain', 'g_txDecal', 'g_txFoam'].some((t) => binds(r, t))).map((r) => r.hash);
}

module.exports = { patchObject, targets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'reflections', 'set');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, skipped: {}, notes: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchObject(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.notes[hash] = r.note;
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targets: report.targets, patched: report.patched, skipped: report.skipped }));
}
