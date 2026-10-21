// Headlight shadows spliced into SnowRunner's lit shaders (replacements\headlight\headshadow.hlsl, compiled to
// headshadow.cso next to it). Every lit pixel shader that takes the truck's headlight samples its light pattern once:
// sample_d ... t54 (g_txHeadLightMap), s2, at the pixel's place in the lamp's projection, inside the branch where the
// pixel is within the lamp's reach and cone. Right after that sample the helper runs, fed the pixel's world position
// (the input the shader subtracts g_vHeadLightPos[0], cb2[24], from), and the sample's colour is multiplied by what the
// helper returns: the share of the lamp's light that gets past what stands in the way. Everything the shader does with
// the pattern afterwards (distance falloff, colour, the surface's response) stays.
// The shader also gets what the helper reads and it lacked: t121 (this frame's linear depth, which SnowRunner Shadows
// binds when it sees it declared; declared in front of dcl_temps, where fxc puts textures) and cb1 up to register 5
// (the view-projection: the declaration is widened in place).
// A shader is left as it is unless: exactly one such sample, writing a temp; the world position an input declared with
// x, y and z (an input read beyond its declaration crashes NVIDIA's compiler, see patch_puddle.js), so its value at the
// sample is the one the shader measured from the lamp; cb2 declared to register 24 or more.
// Works on a stock shader or on one the other modules patched already (they touch other instructions).
// Library: patchHeadShadow(blob[, helper]) -> { blob, note } or { reason }; targets() -> the hashes in dump\.
// usage: node patch_headshadow.js [outDir]    the set built on the stock shaders (default replacements\headlight\set)
'use strict';
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange } = require('./shadow_filter_patch.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'headlight', 'headshadow.cso');
const OP = { add: 0, mul: 56, sample_d: 73, dcl_resource: 88, dcl_constantbuffer: 89, dcl_temps: 104 };
const PATTERN_SLOT = 54, PATTERN_SAMPLER = 2, DEPTH_SLOT = 121;

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((54 | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const mulInst = (dest, a, c) => Buffer.concat([words((OP.mul | ((1 + (dest.length + a.length + c.length) / 4) << 24)) >>> 0), dest, a, c]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);   // rN.xyzw
const tempSrcX = (reg) => words(0x00100006, reg);  // rN.xxxx
const inputSrc = (reg) => words(0x00101246, reg);  // vN.xyzx
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

function patchHeadShadow(b, helper = fs.readFileSync(HELPER))
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let world = null, cb1 = null, cb2 = 0;
    const patterns = [], textures = new Set();
    for (const e of L)
    {
        const { x, o } = e;
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8) { if (o[0].idx[0] === 1) cb1 = e; if (o[0].idx[0] === 2) cb2 = o[0].idx[1]; }
        if (x.op === OP.dcl_resource && o[0]) textures.add(o[0].idx[0]);
        if (x.op === OP.sample_d && o[2] && o[2].type === 7 && o[2].idx[0] === PATTERN_SLOT) patterns.push(e);
        // the pixel minus g_vHeadLightPos[0]: add rX, <p>, -cb2[24]
        if (x.op === OP.add && o.length === 3 && !world)
        {
            const lamp = (p) => p.type === 8 && p.idx[0] === 2 && p.idx[1] === 24;
            if (lamp(o[2])) world = o[1]; else if (lamp(o[1])) world = o[2];
        }
    }
    if (patterns.length !== 1) return { reason: 'light pattern samples: ' + patterns.length };
    if (!world) return { reason: 'no world position' };
    if (world.type !== 1) return { reason: 'the world position is a temp, not an input' };
    if (!cb1) return { reason: 'no cb1' };
    if (cb2 < 25) return { reason: 'cb2 declared with ' + cb2 + ' registers' };
    const dcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0].type === 1 && e.o[0].idx[0] === world.idx[0]);
    if (!dcl || (dcl.o[0].sel & 7) !== 7) return { reason: 'the world position input is not declared with x, y and z' };
    const { i, o } = patterns[0];
    if (o[3].idx[0] !== PATTERN_SAMPLER) return { reason: 'the light pattern sampler is s' + o[3].idx[0] };
    if (o[0].type !== 0) return { reason: 'the sample does not write a temp' };
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 1);
    const x = w.insts[i];
    const sample = b.subarray(x.off, x.off + x.len * 4);
    // the sample as it was, then the helper, then the sample's colour times the helper's share (its own components)
    const atSample = Buffer.concat([
        sample,
        movInst(tempDest(h.IN(0), 7), inputSrc(world.idx[0])),   // the world position
        ...h.body,
        mulInst(tokens(b, o[0]), tempSrc(o[0].idx[0]), tempSrcX(h.RES)),
    ]);
    let out = replaceRange(b, x.off, x.off + x.len * 4, atSample, h.temps, h.body.length + 2);
    // cb1 widened to 6 registers in place (its size is the operand's last index token; before the code, so the offset holds)
    if (cb1.o[0].idx[1] < 6) out.writeUInt32LE(6, cb1.o[0].off + cb1.o[0].size - 4);
    // t121 declared in front of dcl_temps (the spliced code lies after it, so this offset holds too)
    if (!textures.has(DEPTH_SLOT)) out = insertAt(out, w.insts.find((y) => y.op === OP.dcl_temps).off, dclTexture2D(DEPTH_SLOT));
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: 'sample r' + o[0].idx[0] + ' at ' + i + ', world v' + world.idx[0] + ', cb1 ' + cb1.o[0].idx[1] + (cb1.o[0].idx[1] < 6 ? ' -> 6' : '') + (textures.has(DEPTH_SLOT) ? '' : ', t121 added') };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const binds = (r, name) => (r.res || []).some((x) => x.name === name);
// the lit pixel shaders that project the headlight's pattern
function targets()
{
    return index().filter((r) => /^ps/.test(r.profile) && binds(r, 'g_txHeadLightMap')).map((r) => r.hash.toUpperCase());
}

module.exports = { patchHeadShadow, targets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'headlight', 'set');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, skipped: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchHeadShadow(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
