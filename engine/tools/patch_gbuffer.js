// The reflection pass's G-buffer written from the object material shaders (module sssr): every
// PBR pixel shader that samples the environment cubemap at the roughness mip (the 3229 tools\patch_object_ssr.js
// targets with a world position) gets a write of render-target slot 7: o7 = (shading normal x 0.5 + 0.5, sqrt
// roughness), computed by replacements\sssr\gbuffer.hlsl (compiled to gbuffer.cso next to it) from the direction the
// shader samples the cubemap with (the mirror direction), the pixel's world position and the eye (cb1[0]), plus the
// operand of the mip computation "mad mip, x, l(8), l(0.5)" (x = sqrt roughness). SnowRunner Shadows binds an RGBA8
// target at slot 7 during the lit pass (ini SSR=1) and the pass reads it; without that target the write is discarded
// by D3D, so the shader draws exactly as before (checked by running both on the same inputs and comparing targets 0..6).
// The splice sits right in front of the cubemap sample (where the direction and the mip operand are live) and adds
// "dcl_output o7.xyzw" after the shader's last output declaration and an SV_Target7 element to the output signature
// (OSGN), so the runtime and the driver see a shader that legitimately writes eight targets.
// A shader is left as it is unless: exactly one roughness-mip cubemap sample; the world position input found and
// declared with x, y and z; cb1 declared; no output 7 already. The roughness written is (mip - 0.5) / 8 from the
// sample's own mip (the game computes the mip in place over its operand, see patchGBuffer). Order in the bundle: this
// one before patch_object_ssr's variant, which replaces the sample this one anchors on.
// Library: patchGBuffer(blob[, helper]) -> { blob, note } or { reason }; targets() -> patch_object_ssr's targets.
// usage: node patch_gbuffer.js [outDir]    the set built on the stock shaders (default replacements\sssr\set)
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange } = require('./shadow_filter_patch.js');
const { dxbcChecksum } = require('./dxbc_patch.js');
const objssr = require('./patch_object_ssr.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'sssr', 'gbuffer.cso');
const OP = { add: 0, mad: 50, mov: 54, sample_l: 72, dcl_constantbuffer: 89, dcl_output: 101, dcl_temps: 104 };
const SLOT = 7;

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const f32 = (u) => { const b = Buffer.alloc(4); b.writeUInt32LE(u >>> 0); return b.readFloatLE(0); };
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);
const inst = (op, ...ops) => { const n = ops.reduce((s, o) => s + o.length, 0) / 4; return Buffer.concat([words(op | ((1 + n) << 24)), ...ops]); };
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);                    // rN.xyzw
const immScalar = (v) => { const b = Buffer.alloc(8); b.writeUInt32LE(0x00004001, 0); b.writeFloatLE(v, 4); return b; }; // l(v), one component
const outDest = (reg, mask) => words(0x00102002 | (mask << 4), reg); // oN.mask
const inputSrc = (reg) => words(0x00101246, reg);                   // vN.xyzx
const isCb = (o, slot, reg) => o && o.type === 8 && o.idx[0] === slot && o.idx[1] === reg;

// bytes inserted at a byte offset inside the container: the chunk that holds the offset grows, every chunk that starts
// after it moves, the total size follows (the checksum is redone by the caller)
function insertBytes(b, at, bytes)
{
    const out = Buffer.concat([b.subarray(0, at), bytes, b.subarray(at)]);
    out.writeUInt32LE(out.length, 24);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++)
    {
        const off = b.readUInt32LE(32 + i * 4), size = b.readUInt32LE(off + 4);
        if (off + 8 <= at && at <= off + 8 + size) out.writeUInt32LE(size + bytes.length, off + 4); // grows
        else if (off >= at) out.writeUInt32LE(off + bytes.length, 32 + i * 4);                       // moves
    }
    return out;
}

// the output signature gains SV_Target<slot> xyzw: a copy of element 0 with its index and register changed; every
// element's name offset moves by one element (the strings follow the element array)
function addOutputElement(b, slot)
{
    const ch = chunks(b), sig = ch.OSGN || ch.OSG5;
    if (!sig) return null;
    const stride = ch.OSG5 ? 32 : 24, skip = ch.OSG5 ? 4 : 0, d = sig.data;
    const count = b.readUInt32LE(d), first = d + b.readUInt32LE(d + 4);
    const el = Buffer.from(b.subarray(first, first + stride));
    el.writeUInt32LE(slot, skip + 4);   // semantic index
    el.writeUInt32LE(slot, skip + 16);  // register
    el[skip + 20] = 0x0f;               // mask xyzw
    el[skip + 21] = 0x00;               // never-written components: none
    // in front of the system-value outputs (SV_Coverage, SV_Depth: register 0xffffffff), which fxc keeps last; a
    // target element after them makes the runtime refuse the shader (1596 of the 3229 have such outputs)
    let at = count;
    for (let i = 0; i < count; i++) if (b.readUInt32LE(first + i * stride + skip + 16) === 0xffffffff) { at = i; break; }
    const out = insertBytes(b, first + at * stride, el);
    out.writeUInt32LE(count + 1, d);    // the chunk did not move: it holds the insertion
    for (let i = 0; i <= count; i++) { const e = d + out.readUInt32LE(d + 4) + i * stride + skip; out.writeUInt32LE(out.readUInt32LE(e) + stride, e); }
    return out;
}

function patchGBuffer(b, helper = fs.readFileSync(HELPER))
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let world = -1, cb1 = false, lastDclOut = null;
    const mads = new Map(), cubes = [];
    for (const e of L)
    {
        const { x, o } = e;
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8 && o[0].idx[0] === 1) cb1 = true;
        if (x.op === OP.dcl_output && o[0] && o[0].type === 2) { lastDclOut = e; if (o[0].idx[0] === SLOT) return { reason: 'output 7 in use' }; }
        if (x.op === OP.mad && o.length === 4 && o[0].type === 0 && o[2].type === 4 && o[3].type === 4 && Math.abs(f32(o[2].imm[0]) - 8) < 1e-6 && Math.abs(f32(o[3].imm[0]) - 0.5) < 1e-6) mads.set(o[0].idx[0], e);
        if (x.op === OP.sample_l && o[2] && o[2].type === 7 && o[2].idx[0] === 86 && o[4] && o[4].type === 0 && mads.has(o[4].idx[0])) cubes.push(e);
        if (x.op === OP.add && o.length === 3 && world < 0)
        {
            if (isCb(o[1], 1, 0) && o[2].type === 1) world = o[2].idx[0];
            else if (isCb(o[2], 1, 0) && o[1].type === 1) world = o[1].idx[0];
        }
    }
    if (cubes.length !== 1) return { reason: 'roughness-mip cubemap samples: ' + cubes.length };
    if (world < 0) return { reason: 'no world position' };
    if (!cb1) return { reason: 'no cb1' };
    if (!lastDclOut) return { reason: 'no output declaration' };
    const dcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0].type === 1 && e.o[0].idx[0] === world);
    if (!dcl || (dcl.o[0].sel & 7) !== 7) return { reason: 'the world position input is not declared with x, y and z' };
    const s = cubes[0];
    if (s.o[1].type !== 0) return { reason: 'the sample direction is not a temp' };
    // sqrt roughness from the mip the sample uses: the mad computes it IN PLACE in the game's code ("sqrt r0.w, r1.w;
    // mad r0.w, r0.w, l(8), l(0.5)"), so its operand register holds the mip by the sample, not sqrt roughness (read as
    // such it saturates to 1 = fully rough on nearly every pixel). (mip - 0.5) / 8 is sqrt roughness whether or not
    // the mad overwrote its operand.
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 2);   // v0.xyz = R, v0.w = sqrt roughness (fxc packed the third input there), v1.xyz = P
    const block = Buffer.concat([
        inst(OP.mov, tempDest(h.IN(0), 7), tokens(b, s.o[1])),                               // the direction as sampled
        inst(OP.mad, tempDest(h.IN(0), 8), tokens(b, s.o[4]), immScalar(0.125), immScalar(-0.0625)), // (mip - 0.5) / 8 into .w
        inst(OP.mov, tempDest(h.IN(1), 7), inputSrc(world)),                                  // the world position
        ...h.body,
        inst(OP.mov, outDest(SLOT, 0xf), tempSrc(h.RES)),
    ]);
    let out = replaceRange(b, s.x.off, s.x.off, block, h.temps, block.length / 4);
    // dcl_output o7.xyzw after the last output declaration (in front of the code, so the splice above is done first)
    const after = lastDclOut.x.off + lastDclOut.x.len * 4;
    out = insertBytes(out, after, inst(OP.dcl_output, outDest(SLOT, 0xf)));
    const ch = chunks(out), shex = ch.SHEX || ch.SHDR;
    out.writeUInt32LE(out.readUInt32LE(shex.data + 4) + 3, shex.data + 4);   // the code's token count
    if (ch.STAT) out.writeUInt32LE(out.readUInt32LE(ch.STAT.data) + 1, ch.STAT.data);  // instruction count
    const withSig = addOutputElement(out, SLOT);
    if (!withSig) return { reason: 'no output signature chunk' };
    out = withSig;
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: 'sample at ' + s.i + ', mip r' + s.o[4].idx[0] + ', world v' + world };
}

const targets = () => objssr.targets();
module.exports = { patchGBuffer, targets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'sssr', 'set');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, skipped: {}, notes: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchGBuffer(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.notes[hash] = r.note;
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targets: report.targets, patched: report.patched, skipped: report.skipped }));
}
