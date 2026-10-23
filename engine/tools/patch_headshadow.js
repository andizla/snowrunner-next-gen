// Headlight shadows spliced into SnowRunner's lit shaders (replacements\headlight\headshadow.hlsl, compiled to
// headshadow.cso next to it). The lit pixel shaders take the truck's headlight in one of two ways, both inside the branch
// where the pixel is within the lamp's reach and cone: most objects sample its light pattern once (sample_d ... t54,
// g_txHeadLightMap, s2), and the terrain (about 2300 shaders) works out an intensity alone and multiplies the lamp's
// colour (g_cHeadLightColor[0], cb2[16]) by it. The helper runs right after the pattern's sample, whose colour it then
// scales, or right before that colour multiply, whose intensity it scales; fed the pixel's world position (what the
// shader subtracts g_vHeadLightPos[0], cb2[24], from: an input, or a temp that still holds it there), it returns the
// share of the lamp's light that gets past what stands in the way. Everything else the shader does with the light stays.
// The shader also gets what the helper reads and it lacked: t121 (the previous frame's linear depth, which SnowRunner
// Shadows binds when it sees it declared; declared in front of dcl_temps, where fxc puts textures) and cb1 up to register
// 13 (the previous frame's view-projection, c10..c13: the declaration is widened in place).
// A shader is left as it is unless: one such sample writing a temp, or none and a colour multiply by one temp component;
// the world position a plain input declared with x, y and z (an input read beyond its declaration crashes NVIDIA's
// compiler, see patch_puddle.js) or a plain temp no instruction writes before the helper runs, and no loop in between;
// cb2 declared to register 24 or more.
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
const CB1_REGS = 14;   // the helper reads cb1 up to c13 (the previous frame's view-projection)
const OP = { add: 0, mul: 56, sample_d: 73, dcl_resource: 88, dcl_constantbuffer: 89, dcl_temps: 104 };
const PATTERN_SLOT = 54, PATTERN_SAMPLER = 2, DEPTH_SLOT = 121;

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((54 | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const mulInst = (dest, a, c) => Buffer.concat([words((OP.mul | ((1 + (dest.length + a.length + c.length) / 4) << 24)) >>> 0), dest, a, c]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);   // rN.xyzw
const tempSrcX = (reg) => words(0x00100006, reg);  // rN.xxxx
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

const isCb2 = (p, reg) => p && p.type === 8 && p.idx[0] === 2 && p.idx[1] === reg;
// a plain operand: one token and one immediate index, no modifier (its bytes can be copied as a source elsewhere)
const plain = (p) => p && !p.ext && p.dim === 1 && p.rep[0] === 0 && p.size === 8;
// the component a source operand replicates (rN.wwww or rN.w), or -1
function replicated(p)
{
    if (p.mode === 2) return p.sel & 3;
    if (p.mode === 1) { const c = p.sel & 3; return ((p.sel >> 2) & 3) === c && ((p.sel >> 4) & 3) === c && ((p.sel >> 6) & 3) === c ? c : -1; }
    return -1;
}
// whether an instruction writes any of the x, y, z of temp n (destinations are the operands in mask mode)
const writesXyz = (e, n) => e.o.some((p) => p.type === 0 && p.mode === 0 && p.idx[0] === n && (p.sel & 7) !== 0);

function patchHeadShadow(b, helper = fs.readFileSync(HELPER))
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let world = null, worldAt = -1, cb1 = null, cb2 = 0;
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
            if (isCb2(o[2], 24)) world = o[1]; else if (isCb2(o[1], 24)) world = o[2];
            if (world) worldAt = e.i;
        }
    }
    if (!world) return { reason: 'no world position' };
    if (!plain(world) || (world.type !== 0 && world.type !== 1)) return { reason: 'the world position is not a plain temp or input' };
    if (!cb1) return { reason: 'no cb1' };
    if (cb2 < 25) return { reason: 'cb2 declared with ' + cb2 + ' registers' };
    if (world.type === 1)
    {
        const dcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0].type === 1 && e.o[0].idx[0] === world.idx[0]);
        if (!dcl || (dcl.o[0].sel & 7) !== 7) return { reason: 'the world position input is not declared with x, y and z' };
    }
    // where the helper goes: right after the light pattern's sample (scaling the sample), or, in the shaders that light
    // the headlight without a pattern (the terrain's), right before the lamp's colour is multiplied by its intensity
    // (mul rC, rI.c, cb2[16]: scaling the intensity, so the colour and the light's direction both take the shadow)
    let at, mode;
    if (patterns.length === 1)
    {
        const { o } = patterns[0];
        if (patterns[0].i < worldAt) return { reason: 'the pattern is sampled before the world position is measured' };
        if (o[3].idx[0] !== PATTERN_SAMPLER) return { reason: 'the light pattern sampler is s' + o[3].idx[0] };
        if (o[0].type !== 0) return { reason: 'the sample does not write a temp' };
        at = patterns[0]; mode = 'pattern';
    }
    else if (patterns.length === 0)
    {
        at = L.find((e) => e.i > worldAt && e.x.op === OP.mul && e.o.length === 3 && !e.x.sat && (isCb2(e.o[1], 16) || isCb2(e.o[2], 16)));
        if (!at) return { reason: 'no light pattern and no colour of headlight 0' };
        const s = isCb2(at.o[1], 16) ? at.o[2] : at.o[1];
        if (s.type !== 0 || !plain(s) || replicated(s) < 0) return { reason: 'the intensity of headlight 0 is not one temp component' };
        mode = 'intensity';
    }
    else return { reason: 'light pattern samples: ' + patterns.length };
    // a temp position must still hold the pixel where the helper reads it, and neither may be inside a loop
    for (const e of L.slice(worldAt + 1, at.i))
    {
        if (e.x.op === 48 || e.x.op === 22) return { reason: 'a loop between the world position and the light' };
        if (world.type === 0 && writesXyz(e, world.idx[0])) return { reason: 'the world position temp is overwritten before the light' };
    }
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 1);
    const x = at.x, orig = b.subarray(x.off, x.off + x.len * 4);
    const feed = movInst(tempDest(h.IN(0), 7), tokens(b, world));   // the world position, as the shader measures it
    let spliced, note;
    if (mode === 'pattern')
    {
        // the sample as it was, then the helper, then the sample's colour times the helper's share (its own components)
        const o = at.o;
        spliced = Buffer.concat([orig, feed, ...h.body, mulInst(tokens(b, o[0]), tempSrc(o[0].idx[0]), tempSrcX(h.RES))]);
        note = 'pattern r' + o[0].idx[0];
    }
    else
    {
        // the helper, the intensity times its share, then the colour multiply as it was
        const s = isCb2(at.o[1], 16) ? at.o[2] : at.o[1], c = replicated(s), r = s.idx[0];
        const rep = words(0x00100006 | ((c | (c << 2) | (c << 4) | (c << 6)) << 4), r);   // rN.cccc
        spliced = Buffer.concat([feed, ...h.body, mulInst(tempDest(r, 1 << c), rep, tempSrcX(h.RES)), orig]);
        note = 'intensity r' + r + '.' + 'xyzw'[c];
    }
    let out = replaceRange(b, x.off, x.off + x.len * 4, spliced, h.temps, h.body.length + 2);
    // cb1 widened to CB1_REGS registers in place (its size is the operand's last index token; before the code, so the offset holds)
    if (cb1.o[0].idx[1] < CB1_REGS) out.writeUInt32LE(CB1_REGS, cb1.o[0].off + cb1.o[0].size - 4);
    // t121 declared in front of dcl_temps (the spliced code lies after it, so this offset holds too)
    if (!textures.has(DEPTH_SLOT)) out = insertAt(out, w.insts.find((y) => y.op === OP.dcl_temps).off, dclTexture2D(DEPTH_SLOT));
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: note + ' at ' + at.i + ', world ' + (world.type ? 'v' : 'r') + world.idx[0] + ', cb1 ' + cb1.o[0].idx[1] + (cb1.o[0].idx[1] < CB1_REGS ? ' -> ' + CB1_REGS : '') + (textures.has(DEPTH_SLOT) ? '' : ', t121 added') };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const binds = (r, name) => (r.res || []).some((x) => x.name === name);
// the lit pixel shaders that take headlight 0: those that bind its pattern, and those whose code holds the index pair of
// g_vHeadLightPos[0] (cb2[24]); patchHeadShadow decides on each
let cached = null;
function targets()
{
    if (cached) return cached;
    const pair = Buffer.from([2, 0, 0, 0, 24, 0, 0, 0]);
    cached = index().filter((r) => /^ps/.test(r.profile) && (binds(r, 'g_txHeadLightMap') || fs.readFileSync(path.join(DUMP, '0x' + r.hash + '.cso')).includes(pair)))
        .map((r) => r.hash.toUpperCase());
    return cached;
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
