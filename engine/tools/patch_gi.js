// Bounce light (with the sky tint) spliced into SnowRunner's material shaders: replacements\gi\gi_ambient.hlsl, compiled
// to gi_ambient.cso (sky tint 0.6, for the bundle with the ambient module) and gi_only.cso (-D STRENGTH=0, the authored
// ambient colours) next to it, goes in front of the shader's first instruction the way tools\patch_ambient.js puts the
// sky tint there (its temps behind the shader's own, its sampler remapped to the one the shader uses for t86, its
// outputs o0/o1/o2 into three fresh temps, every read of cb2[50], cb2[51], cb2[52] repointed at those temps), and its
// one input is the pixel's world position: the input register the shader subtracts from the eye position (cb1[0]).
// The shader also gets what the helper reads and it lacked: cb1 up to register 13 (last frame's view-projection) and
// t121/t122 (last frame's linear depth and bounce light, which SnowRunner Shadows binds when it sees them declared).
// A shader is left as it is unless it samples the cubemap, reads the ambient colours and its world position is found
// as three components of one input in order. The terrain decals (isDecal: they name g_txDecal and read this frame's
// depth, t80) take the decal build of the helper (gi_ambient_decal.cso, gi_only_decal.cso): their input is a point of
// the box they draw, and the helper finds the lit ground behind it in that depth. A helper never gets a texture the
// shader does not declare, apart from t121/t122.
// Library: patchGI(blob[, helper]) -> { blob, reads } or { reason }; isDecal(blob); targets() -> the pixel shaders in
// dump\ that name g_ambientLight.
// usage: node patch_gi.js    what it would do to the stock shaders
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');
const { words } = require('./patch_water_mix.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'gi', 'gi_ambient.cso');
const OP = { add: 0, ret: 62, sample: 69, sample_l: 72, sample_d: 73, sample_b: 74, dcl_resource: 88, dcl_constantbuffer: 89, dcl_input_ps: 98, dcl_temps: 104 };
const READS = [121, 122];   // last frame's linear depth, last frame's bounce light

const isDecl = (op) => (op >= 88 && op <= 106) || (op >= 143 && op <= 183) || op === 53;
const isAmbient = (o) => o.type === 8 && o.dim === 2 && o.rep[0] === 0 && o.rep[1] === 0 && o.idx[0] === 2 && o.idx[1] >= 50 && o.idx[1] <= 52;
// dcl_resource_texture2d (float,float,float,float) tN
const dclTexture2D = (slot) => words(OP.dcl_resource | (3 << 11) | (4 << 24), 0x00107000, slot, 0x00005555);

// the sampler register the shader uses with t86, or -1
function cubeSampler(b, w)
{
    for (const x of w.insts)
    {
        if (![OP.sample, OP.sample_l, OP.sample_b, OP.sample_d].includes(x.op)) continue;
        const o = operands(b, x);
        if (o[2] && o[2].type === 7 && o[2].idx[0] === 86 && o[3] && o[3].type === 6) return o[3].idx[0];
    }
    return -1;
}

// the input register holding the world position: add r, cb1[0], -vN (either order), vN's x, y, z feeding the
// destination's components in order; -1 when there is none or it is not laid out that way
function worldInput(b, w)
{
    const eye = (o) => o.type === 8 && o.dim === 2 && o.idx[0] === 1 && o.idx[1] === 0;
    for (const x of w.insts)
    {
        if (x.op !== OP.add) continue;
        const o = operands(b, x);
        if (o.length !== 3 || o[0].type !== 0 || o[0].mode !== 0) continue;
        const v = eye(o[1]) && o[2].type === 1 ? o[2] : eye(o[2]) && o[1].type === 1 ? o[1] : null;
        if (!v || v.dim !== 1 || v.rep[0] !== 0 || v.mode !== 1) continue;
        const lanes = [0, 1, 2, 3].filter((k) => o[0].sel & (1 << k));
        const picks = lanes.map((k) => (v.sel >> (k * 2)) & 3);
        if (picks.join() === '0,1,2') return v.idx[0];
    }
    return -1;
}

// the declarations the helper needs: cb1 to register 13, t121 and t122 (before dcl_temps, where fxc puts texture
// declarations), the world position input declared with x, y and z; null when cb1, cb2 or t86 are missing
function declare(b, world)
{
    const out = Buffer.from(b);
    const w = walk(out);
    const L = w.insts.map((x) => ({ x, o: operands(out, x) }));
    let cb1 = false, cb2 = false;
    for (const e of L)
    {
        if (e.x.op !== OP.dcl_constantbuffer || e.o[0].type !== 8) continue;
        const slot = e.o[0].idx[0], at = e.o[0].off + e.o[0].size - 4;
        if (slot === 1) { cb1 = true; if (out.readUInt32LE(at) < 14) out.writeUInt32LE(14, at); }
        if (slot === 2) cb2 = out.readUInt32LE(at) >= 53;
    }
    if (!cb1 || !cb2) return null;
    const textures = new Set(L.filter((e) => e.x.op === OP.dcl_resource).map((e) => e.o[0].idx[0]));
    if (!textures.has(86)) return null;
    const input = L.find((e) => e.x.op === OP.dcl_input_ps && e.o[0].type === 1 && e.o[0].idx[0] === world);
    if (!input || (input.o[0].sel & 7) !== 7) return null;
    const add = READS.filter((t) => !textures.has(t)).map(dclTexture2D);
    if (!add.length) { dxbcChecksum(out.subarray(20)).copy(out, 4); return out; }
    const at = w.insts.find((x) => x.op === OP.dcl_temps).off;
    const ch = chunks(out), shex = ch.SHEX || ch.SHDR, insert = Buffer.concat(add);
    const res = Buffer.concat([out.subarray(0, at), insert, out.subarray(at)]);
    res.writeUInt32LE(res.length, 24);
    res.writeUInt32LE(shex.size + insert.length, shex.off + 4);
    res.writeUInt32LE(out.readUInt32LE(shex.data + 4) + insert.length / 4, shex.data + 4);
    for (let i = 0, n = out.readUInt32LE(28); i < n; i++) { const o = out.readUInt32LE(32 + i * 4); if (o > shex.off) res.writeUInt32LE(o + insert.length, 32 + i * 4); }
    dxbcChecksum(res.subarray(20)).copy(res, 4);
    return res;
}

// the helper's body (after dcl_temps, up to its one ret) with its temps moved to base.., outputs oK -> res + K, its
// sampler -> s, its input v0 -> the world position register
function helperWords(helper, base, sampler, world)
{
    const w = walk(helper);
    // a helper that needs no temps (the bounce light and the tint both off) has no dcl_temps: its body starts after
    // the last declaration
    const dcl = w.insts.find((x) => x.op === OP.dcl_temps);
    const own = dcl ? helper.readUInt32LE(dcl.off + 4) : 0;
    const res = base + own;
    const body = dcl ? w.insts.slice(w.insts.indexOf(dcl) + 1) : w.insts.filter((x) => !isDecl(x.op));
    const rets = body.filter((x) => x.op === OP.ret);
    if (rets.length !== 1 || body[body.length - 1] !== rets[0]) throw new Error('helper returns early');
    const parts = [];
    for (const ins of body.slice(0, -1))
    {
        const tok = Buffer.from(helper.subarray(ins.off, ins.off + ins.len * 4));
        for (const o of operands(helper, ins))
        {
            const at = o.off - ins.off, idxAt = at + o.size - 4;
            if (o.type === 0) tok.writeUInt32LE(base + o.idx[0], idxAt);
            else if (o.type === 2) { tok.writeUInt32LE((tok.readUInt32LE(at) & ~(0xff << 12)) >>> 0, at); tok.writeUInt32LE(res + o.idx[0], idxAt); }
            else if (o.type === 6) tok.writeUInt32LE(sampler, idxAt);
            else if (o.type === 1) { if (o.idx[0] !== 0) throw new Error('helper reads an input other than v0'); tok.writeUInt32LE(world, idxAt); }
        }
        parts.push(tok);
    }
    return { words: Buffer.concat(parts), count: parts.length, temps: own + 3, res };
}

// the operand tokens of cbN[i] rewritten as rT (component selection, modifiers and extended tokens kept)
function asTemp(b, o, reg)
{
    const tok = b.readUInt32LE(o.off);
    const ext = o.size / 4 - 3; // token, extended tokens, two immediate indices
    const out = Buffer.alloc((ext + 2) * 4);
    out.writeUInt32LE(((tok & 0x80000fff) | (1 << 20)) >>> 0, 0); // type temp, one immediate index
    for (let i = 0; i < ext; i++) out.writeUInt32LE(b.readUInt32LE(o.off + 4 + i * 4), 4 + i * 4);
    out.writeUInt32LE(reg, (ext + 1) * 4);
    return out;
}

// the texture slots a shader declares
const declaredTextures = (b, w) => new Set(w.insts.filter((x) => x.op === OP.dcl_resource).map((x) => operands(b, x)[0].idx[0]));

// a terrain decal (it names g_txDecal and reads this frame's depth at t80): it takes the decal build of the helper; the
// meshes' decals (stickers on trucks and the like) name g_txDecal too, but draw on their own surface
const isDecal = (b) => b.indexOf('g_txDecal') >= 0 && declaredTextures(b, walk(b)).has(80);

function patchGI(b0, helper = fs.readFileSync(HELPER))
{
    const w0 = walk(b0);
    const sampler = cubeSampler(b0, w0);
    if (sampler < 0) return { reason: 'no t86 sample' };
    const own = declaredTextures(b0, w0);
    const missing = [...declaredTextures(helper, walk(helper))].filter((t) => !own.has(t) && !READS.includes(t));
    if (missing.length) return { reason: 'the helper reads t' + missing.join(', t') + ', which the shader does not declare' };
    let reads = 0;
    for (const x of w0.insts) if (!isDecl(x.op)) for (const o of operands(b0, x)) if (isAmbient(o)) reads++;
    if (!reads) return { reason: 'no ambient read' };
    const world = worldInput(b0, w0);
    if (world < 0) return { reason: 'no world position' };
    const b = declare(b0, world);
    if (!b) return { reason: 'cb1, cb2, t86 or the world position input not declared as expected' };
    const w = walk(b);
    const first = w.insts.findIndex((x) => !isDecl(x.op));
    const dcl = w.insts.find((x) => x.op === OP.dcl_temps);
    if (!dcl || first < 0) return { reason: 'shape' };
    const base = b.readUInt32LE(dcl.off + 4);
    const h = helperWords(helper, base, sampler, world);
    const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
    const parts = [b.subarray(0, w.insts[first].off), h.words];
    for (const x of w.insts.slice(first))
    {
        const ops = operands(b, x);
        if (!ops.some(isAmbient)) { parts.push(b.subarray(x.off, x.off + x.len * 4)); continue; }
        // rebuild: opcode token(s), then every operand, the ambient reads as temps
        let p = x.off + 4;
        let t = b.readUInt32LE(x.off);
        while (t >>> 31) { t = b.readUInt32LE(p); p += 4; }
        const head = Buffer.from(b.subarray(x.off, p));
        const body = ops.map((o) => (isAmbient(o) ? asTemp(b, o, h.res + (o.idx[1] - 50)) : b.subarray(o.off, o.off + o.size)));
        const inst = Buffer.concat([head, ...body]);
        inst.writeUInt32LE(((head.readUInt32LE(0) & ~(0x7f << 24)) | ((inst.length / 4) << 24)) >>> 0, 0);
        parts.push(inst);
    }
    const end = shex.data + b.readUInt32LE(shex.data + 4) * 4;
    parts.push(b.subarray(end));
    const out = Buffer.concat(parts);
    const added = out.length - b.length;
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(shex.size + added, shex.off + 4);
    out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + added / 4, shex.data + 4);
    out.writeUInt32LE(base + h.temps, dcl.off + 4);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + added, 32 + i * 4); }
    if (ch.STAT)
    {
        const s = ch.STAT.data + (ch.STAT.off > shex.off ? added : 0);
        out.writeUInt32LE(out.readUInt32LE(s) + h.count, s);
        out.writeUInt32LE(out.readUInt32LE(s + 4) + h.temps, s + 4);
    }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, reads };
}

// pixel shaders in dump\ that name the ambient colours (the ones patch_ambient.js looks at), by CRC hex
function targets()
{
    const out = [];
    for (const f of fs.readdirSync(DUMP))
    {
        if (!f.endsWith('.cso')) continue;
        const b = fs.readFileSync(path.join(DUMP, f));
        const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
        if (!shex || (b.readUInt32LE(shex.data) >>> 16) !== 0 || b.indexOf('g_ambientLight') < 0) continue;
        out.push(f.slice(2, 10));
    }
    return out;
}

module.exports = { patchGI, isDecal, targets };

if (require.main === module)
{
    const helper = fs.readFileSync(HELPER), decal = fs.readFileSync(path.join(W, 'replacements', 'gi', 'gi_ambient_decal.cso'));
    const tally = { patched: 0, decals: 0, reads: 0, skipped: {} };
    for (const hash of targets())
    {
        const b = fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso'));
        const r = patchGI(b, isDecal(b) ? decal : helper);
        if (r.blob) { tally.patched++; tally.reads += r.reads; if (isDecal(b)) tally.decals++; }
        else tally.skipped[r.reason] = (tally.skipped[r.reason] || 0) + 1;
    }
    console.log(JSON.stringify(tally));
}
