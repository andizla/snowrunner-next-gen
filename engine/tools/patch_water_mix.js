// Two splices into SnowRunner's water shaders (the 20 river and mud shaders of patch_water_ssr.js, g_txBBOpaque at t4,
// and for blend also the lake and sea "domain" shaders, g_txBBOpaque at t5), each replacing one instruction with a
// compiled helper:
//   blend   replacements\water\blend.cso at the final combine "out = reflection * F + colour": the water's own colour
//           gives way to the reflection as Fresnel rises (colour * (1 - F) + reflection * F), the sun highlight's share
//           of the colour kept. The stock sum only looks right with bright sky in the reflection; with the screen-space
//           reflections of darker banks the water turns milky.
//   absorb  replacements\water\absorb.cso at the lerp "colour = body + (behind - body) * T": the see-through fade T
//           per channel, T ^ w, the channels the water's own colour is dark in fading faster (teal or brown depths
//           instead of grey). Rivers only: the lake and sea shaders already tint what they refract by depth
//           (g_colorRefraction).
// Found by structure, the same in every variant: the Fresnel term (mad F, x, 0.98, 0.02), the one `sample` of
// g_txBBOpaque (the refracted scene), the lerp after it (mad with a broadcast T, an operand computed from that sample
// and the body colour), and the combine (mad of the reflection, F and the lerp's result). "Computed from the sample" is
// followed per component, and a register overwritten from elsewhere stops counting (the lake shaders reuse r2). The
// lake shaders that reflect a planar reflection image take the blend too; their reflection stays their own. The sun
// highlight is
// the third operand of the mad that made the body colour (mad body, albedo, light, highlight), when there is one and
// its register still holds it at the combine. Operands are re-swizzled for the helper's .xyz order, so colours kept in
// packed components (r1.xzw in the small variants) arrive in order.
// Apply after patch_water_ssr.js and blend before absorb: absorb replaces the lerp that blend reads its inputs around.
// Library: patchBlend(blob[, helper[, opaque slot]]), patchAbsorb(blob[, helper[, opaque slot]]) -> { blob, note } or
// { reason }; the opaque slot is 4 for rivers (default), 5 for lakes and seas.
// usage: node patch_water_mix.js [outDir]    blend, absorb and both on the stock shaders (default replacements\water\mix)
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange } = require('./shadow_filter_patch.js');
const { insertWords, dxbcChecksum, ins } = require('./dxbc_patch.js');
const { targets } = require('./patch_water_ssr.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const BLEND = path.join(W, 'replacements', 'water', 'blend.cso'), ABSORB = path.join(W, 'replacements', 'water', 'absorb.cso');
const GLOW = path.join(W, 'replacements', 'water', 'blend_glow.cso');
const OP = { add: 0, dp3: 16, mad: 50, mov: 54, sample: 69, dcl_resource: 88, dcl_constantbuffer: 89, dcl_sampler: 90, dcl_temps: 104 };
const F098 = 0x3f7ae148, F002 = 0x3ca3d70a; // 0.98f and 0.02f, Schlick with F0 = 0.02

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((OP.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const swz = (c) => c[0] | (c[1] << 2) | (c[2] << 4) | (c[3] << 6);
const tempSrc = (reg, c) => words(0x00100006 | (swz(c) << 4), reg);
const zero4 = words(0x00004002, 0, 0, 0, 0); // l(0, 0, 0, 0)
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);
const maskOf = (o) => (o.mode === 0 ? o.sel & 15 : 0);
const bitsOf = (m) => [0, 1, 2, 3].filter((k) => m & (1 << k));
const saturated = (b, x) => (b.readUInt32LE(x.off) >>> 13) & 1;

// the source components an operand reads for the written components of a destination mask, in order
function comps(o, mask)
{
    const pos = bitsOf(mask);
    if (o.mode === 1) return pos.map((k) => (o.sel >> (2 * k)) & 3);
    if (o.mode === 2) return pos.map(() => o.sel & 3);
    throw new Error('unexpected operand selection');
}
// the operand with a swizzle that reads the given components as .x, .y, .z (and .w)
function reswizzle(b, o, c)
{
    const four = c.slice(0, 4);
    while (four.length < 4) four.push(four[four.length - 1]);
    const tok = Buffer.from(tokens(b, o));
    tok.writeUInt32LE(((tok.readUInt32LE(0) & ~0xfff) | 2 | (1 << 2) | (swz(four) << 4)) >>> 0, 0);
    return tok;
}
// the result register read into the written components of a destination mask, in order
const resultInto = (reg, mask) => { const c = [0, 0, 0, 0]; bitsOf(mask).forEach((k, j) => { c[k] = j; }); return tempSrc(reg, c); };
const writesReg = (e, reg) => e.o[0] && e.o[0].type === 0 && e.o[0].idx[0] === reg && maskOf(e.o[0]);
// ALU instructions whose source component k feeds destination component k; any other instruction (dot products,
// samples) is taken to read every component its sources select
const PER_COMPONENT = new Set([0, 1, 11, 12, 14, 24, 25, 26, 27, 28, 29, 30, 35, 36, 37, 39, 41, 42, 43, 47, 49, 50, 51, 52, 54, 55, 56, 57, 59, 60,
    64, 65, 66, 67, 68, 75, 79, 80, 83, 84, 85, 86, 87]);
const readComps = (e, o, m) => (o.mode === 0 ? [0, 1, 2, 3] : PER_COMPONENT.has(e.x.op) ? comps(o, m) : [0, 1, 2, 3].map((k) => (o.mode === 1 ? (o.sel >> (2 * k)) & 3 : o.sel & 3)));

// the Fresnel term, the refraction sample, the lerp, the body colour's highlight and the combine, as far as found
function find(b, opaqueSlot = 4)
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    const imm = (o, v) => o && o.type === 4 && o.imm.includes(v);
    const fres = L.filter((e) => e.x.op === OP.mad && e.o.length === 4 && e.o[0].type === 0 && imm(e.o[2], F098) && imm(e.o[3], F002));
    const refr = L.filter((e) => e.x.op === OP.sample && e.o[2] && e.o[2].type === 7 && e.o[2].idx[0] === opaqueSlot);
    if (fres.length !== 1) return { w, L, reason: 'Fresnel terms: ' + fres.length };
    if (refr.length !== 1) return { w, L, reason: 'refraction samples: ' + refr.length };
    const F = { reg: fres[0].o[0].idx[0], comp: bitsOf(maskOf(fres[0].o[0]))[0] };
    // the lerp: the first mad after the sample with a broadcast factor, an operand computed from the sample, and one not;
    // which components of which registers hold something computed from the sample, followed instruction by instruction
    const derived = new Map([[refr[0].o[0].idx[0], maskOf(refr[0].o[0])]]);
    const fromSample = (e, o, m) => o.type === 0 && readComps(e, o, m).some((c) => (derived.get(o.idx[0]) || 0) & (1 << c));
    let lerp = null;
    for (const e of L.slice(refr[0].i + 1))
    {
        const d = e.o[0], m = d && d.type === 0 ? maskOf(d) : 0;
        if (!m) continue;
        const src = e.o.slice(1);
        if (e.x.op === OP.mad && bitsOf(m).length === 3 && src.every((o) => o.type === 0) &&
            new Set(comps(src[0], m)).size === 1 && fromSample(e, src[1], m) && !fromSample(e, src[2], m))
        {
            lerp = e;
            break;
        }
        const was = derived.get(d.idx[0]) || 0;
        derived.set(d.idx[0], src.some((o) => fromSample(e, o, m)) ? was | m : was & ~m);
    }
    if (!lerp) return { w, L, F, reason: 'no lerp after the refraction sample' };
    const lerpMask = maskOf(lerp.o[0]);
    // the combine: the first mad after the lerp reading the Fresnel term (broadcast, followed from its mad through
    // per-component instructions: some variants move it with a min into another component) and the lerp's result in
    // the order it was written
    const fres0 = fres[0].i, fAt = new Map([[F.reg, 1 << F.comp]]);
    const fromF = (e, o, m) => o.type === 0 && readComps(e, o, m).some((c) => (fAt.get(o.idx[0]) || 0) & (1 << c));
    const step = (e) => // the Fresnel term's registers after instruction e
    {
        const d = e.o[0], m = d && d.type === 0 ? maskOf(d) : 0;
        if (!m) return;
        const was = fAt.get(d.idx[0]) || 0;
        fAt.set(d.idx[0], PER_COMPONENT.has(e.x.op) && e.o.slice(1).some((o) => fromF(e, o, m)) ? was | m : was & ~m);
    };
    for (const e of L.slice(fres0 + 1, lerp.i + 1)) step(e);
    let combine = null;
    for (const e of L.slice(lerp.i + 1))
    {
        if (e.i > fres0 && e.x.op === OP.mad && e.o.length === 4 && e.o.slice(1).every((o) => o.type === 0) && bitsOf(maskOf(e.o[0])).length === 3)
        {
            const m = maskOf(e.o[0]);
            const isF = (o) => new Set(comps(o, m)).size === 1 && comps(o, m).every((c) => (fAt.get(o.idx[0]) || 0) & (1 << c));
            const isL = (o) => o.idx[0] === lerp.o[0].idx[0] && comps(o, m).join() === bitsOf(lerpMask).join();
            const k = [1, 2].find((j) => isF(e.o[j]));
            if (k && isL(e.o[3])) { combine = { e, R: e.o[k === 1 ? 2 : 1], Fop: e.o[k], Lop: e.o[3] }; break; }
        }
        if (e.i > fres0) step(e);
        if (writesReg(e, lerp.o[0].idx[0]) & lerpMask) break; // the lerp's result replaced before any combine
    }
    // the highlight: the third operand of the mad that last wrote the body colour, if its register lives to the combine
    let highlight = null;
    const bodyReg = lerp.o[3].idx[0], bodyComps = comps(lerp.o[3], lerpMask);
    const def = L.slice(0, lerp.i).reverse().find((e) => writesReg(e, bodyReg) && bodyComps.some((c) => maskOf(e.o[0]) & (1 << c)));
    if (def && def.x.op === OP.mad && def.o[3].type === 0 && bodyComps.every((c) => maskOf(def.o[0]) & (1 << c)) && combine)
    {
        const h = def.o[3], hComps = bodyComps.map((c) => (h.mode === 1 ? (h.sel >> (2 * c)) & 3 : h.sel & 3));
        const tReg = lerp.o[1].idx[0];
        const between = (from, to, reg) => L.slice(from + 1, to).some((e) => writesReg(e, reg));
        if (h.mode !== 0 && !between(def.i, combine.e.i, h.idx[0]) && !between(lerp.i, combine.e.i, tReg))
            highlight = { op: h, comps: hComps };
    }
    return { w, L, F, refr: refr[0], lerp, lerpMask, combine, highlight };
}

// replaces one instruction: the helper's inputs read first, its body, its result written where the instruction wrote
function splice(b, w, at, helper, nIn, inputs, dst)
{
    if (saturated(b, at.x)) return { reason: 'the replaced instruction saturates' };
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, nIn);
    const insert = Buffer.concat([...inputs.map(([mask, src], k) => movInst(tempDest(h.IN(k), mask), src)), ...h.body, movInst(tokens(b, dst), resultInto(h.RES, maskOf(dst)))]);
    return { blob: replaceRange(b, at.x.off, at.x.off + at.x.len * 4, insert, h.temps, h.body.length + inputs.length) };
}

function patchBlend(b, helper = fs.readFileSync(BLEND), opaqueSlot = 4)
{
    const f = find(b, opaqueSlot);
    if (f.reason) return { reason: f.reason };
    if (!f.combine) return { reason: 'no combine of reflection and colour' };
    const c = f.combine, m = maskOf(c.e.o[0]);
    const r = splice(b, f.w, c.e, helper, 5, [
        [7, reswizzle(b, c.Lop, comps(c.Lop, m))],                      // colour
        [7, reswizzle(b, c.R, comps(c.R, m))],                          // reflection
        [1, reswizzle(b, c.Fop, comps(c.Fop, m))],                      // F
        [1, reswizzle(b, f.lerp.o[1], comps(f.lerp.o[1], f.lerpMask))], // T
        [15, f.highlight ? reswizzle(b, f.highlight.op, f.highlight.comps) : zero4],
    ], c.e.o[0]);
    if (r.blob) r.note = f.highlight ? 'highlight kept' : 'no highlight';
    return r;
}

function patchAbsorb(b, helper = fs.readFileSync(ABSORB), opaqueSlot = 4)
{
    const f = find(b, opaqueSlot);
    if (!f.lerp) return { reason: f.reason };
    const cb2 = f.L.find((e) => e.x.op === OP.dcl_constantbuffer && e.o[0].type === 8 && e.o[0].idx[0] === 2);
    if (!cb2 || cb2.o[0].idx[1] < 51) return { reason: 'cb2 declared with fewer than 51 registers' };
    const e = f.lerp, m = f.lerpMask;
    return splice(b, f.w, e, helper, 3, [
        [1, reswizzle(b, e.o[1], comps(e.o[1], m))], // T
        [7, reswizzle(b, e.o[2], comps(e.o[2], m))], // behind - body
        [7, reswizzle(b, e.o[3], comps(e.o[3], m))], // body
    ], e.o[0]);
}

// the dot product the Fresnel term is built from: followed back from the Fresnel mad's first operand through
// per-component steps ((1 - c)^5 takes an add and a few muls) to the dp3 that wrote it; null if anything else feeds it
function dotBehindFresnel(L, fres)
{
    const key = (r, c) => r * 4 + c;
    const want = new Set([key(fres.o[1].idx[0], comps(fres.o[1], maskOf(fres.o[0]))[0])]);
    for (let i = fres.i - 1; i >= 0 && want.size; i--)
    {
        const e = L[i], d = e.o[0];
        if (!d || d.type !== 0) continue;
        const hit = bitsOf(maskOf(d)).filter((c) => want.has(key(d.idx[0], c)));
        if (!hit.length) continue;
        if (e.x.op === OP.dp3) return e;
        if (!PER_COMPONENT.has(e.x.op)) return null;
        for (const c of hit) want.delete(key(d.idx[0], c));
        for (const o of e.o.slice(1))
            if (o.type === 0) for (const c of hit) want.add(key(o.idx[0], o.mode === 1 ? (o.sel >> (2 * c)) & 3 : o.mode === 2 ? o.sel & 3 : c));
    }
    return null;
}

// Sun glow through wave crests: replacements\water\blend_glow.cso at the combine, in place of blend.cso (it does the
// blend too), with two more inputs: the water pixel's world position (the input the shader subtracts from the eye,
// cb1[0]) and the wave normal. The shader builds the reflection direction out of the normal right after the Fresnel dot
// product (mad R, N, -2 N.I, I) and overwrites it there, so a copy goes into a fresh temp right after that dp3. Only
// shaders that sample the sun shadow map themselves (t81 with the comparison sampler s15) take it: the helper looks the
// sun up there as they do. cb2 is widened to 88 registers with dynamic indexing (the cascade matrices, picked per pixel).
function patchGlow(b, helper = fs.readFileSync(GLOW), opaqueSlot = 4)
{
    const f0 = find(b, opaqueSlot);
    if (f0.reason) return { reason: f0.reason };
    if (!f0.combine) return { reason: 'no combine of reflection and colour' };
    const L0 = f0.L;
    const declared = (op, reg) => L0.some((e) => e.x.op === op && e.o[0] && e.o[0].idx[0] === reg);
    if (!declared(OP.dcl_resource, 81) || !declared(OP.dcl_sampler, 15)) return { reason: 'no sun shadow map (t81 with s15)' };
    // the world position: the input the shader subtracts from the eye
    let world = -1;
    for (const e of L0)
    {
        if (e.x.op !== OP.add || e.o.length !== 3) continue;
        const eye = (p) => p.type === 8 && p.idx[0] === 1 && p.idx[1] === 0;
        if (eye(e.o[1]) && e.o[2].type === 1) { world = e.o[2].idx[0]; break; }
        if (eye(e.o[2]) && e.o[1].type === 1) { world = e.o[1].idx[0]; break; }
    }
    if (world < 0) return { reason: 'no world position' };
    // the normal: of the dp3 behind the Fresnel term, the operand the reflection built next scales by the doubled dot
    const fres = L0.filter((e) => e.x.op === OP.mad && e.o.length === 4 && e.o[0].type === 0 && e.o[2].type === 4 && e.o[2].imm.includes(F098) && e.o[3].type === 4 && e.o[3].imm.includes(F002));
    if (fres.length !== 1) return { reason: 'Fresnel terms: ' + fres.length };
    const dot = dotBehindFresnel(L0, fres[0]);
    if (!dot) return { reason: 'no dot product behind the Fresnel term' };
    const A = dot.o[1], B = dot.o[2];
    if (A.type !== 0 || B.type !== 0 || A.idx[0] === B.idx[0]) return { reason: 'the Fresnel dot product is not of two temps' };
    let N = null;
    for (const e of L0.slice(dot.i + 1, dot.i + 7))
    {
        if (e.x.op !== OP.mad || e.o.length !== 4 || e.o[3].type !== 0) continue;
        for (const [n, i] of [[A, B], [B, A]])
            if (e.o[3].idx[0] === i.idx[0] && [e.o[1], e.o[2]].some((o) => o.type === 0 && o.idx[0] === n.idx[0])) N = n;
        if (N) break;
    }
    if (!N) return { reason: 'no reflection built from the Fresnel dot product' };
    // a copy of the normal right after the dp3, into a fresh temp S
    const S = b.readUInt32LE(f0.w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const dw = (buf) => Array.from({ length: buf.length / 4 }, (_, k) => buf.readUInt32LE(k * 4));
    const save = ins(OP.mov, [(0x00100002 | (7 << 4)) >>> 0, S, ...dw(tokens(b, N))]);
    const b1 = insertWords(b, [{ at: dot.x.off + dot.x.len * 4, words: save }], { temps: 1, stat: { instructions: 1, movInstructions: 1 } });
    // cb2 to 88 registers with dynamic indexing
    let cb2 = false;
    for (const x of walk(b1).insts.filter((y) => y.op === OP.dcl_constantbuffer))
    {
        const o = operands(b1, x)[0];
        if (o.idx[0] !== 2) continue;
        const at = o.off + o.size - 4;
        if (b1.readUInt32LE(at) < 88) b1.writeUInt32LE(88, at);
        b1.writeUInt32LE((b1.readUInt32LE(x.off) | (1 << 11)) >>> 0, x.off);
        cb2 = true;
    }
    if (!cb2) return { reason: 'cb2 not declared' };
    dxbcChecksum(b1.subarray(20)).copy(b1, 4);
    // the helper at the combine: the blend's five inputs, the world position, the normal's copy
    const f = find(b1, opaqueSlot);
    if (f.reason || !f.combine) return { reason: 'the combine is lost after the copy: ' + (f.reason || 'none') };
    const c = f.combine, m = maskOf(c.e.o[0]);
    const r = splice(b1, f.w, c.e, helper, 7, [
        [7, reswizzle(b1, c.Lop, comps(c.Lop, m))],                      // colour
        [7, reswizzle(b1, c.R, comps(c.R, m))],                          // reflection
        [1, reswizzle(b1, c.Fop, comps(c.Fop, m))],                      // F
        [1, reswizzle(b1, f.lerp.o[1], comps(f.lerp.o[1], f.lerpMask))], // T
        [15, f.highlight ? reswizzle(b1, f.highlight.op, f.highlight.comps) : zero4],
        [7, words(0x00101246, world)],                                   // vN.xyzx: the world position
        [7, words(0x00100246, S)],                                       // rS.xyzx: the normal
    ], c.e.o[0]);
    if (r.blob) r.note = (f.highlight ? 'highlight kept' : 'no highlight') + ', glow';
    return r;
}

module.exports = { patchBlend, patchAbsorb, patchGlow, find, splice, comps, reswizzle, maskOf, bitsOf, tokens, words };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'water', 'mix');
    const blend = fs.readFileSync(BLEND), absorb = fs.readFileSync(ABSORB);
    const report = {};
    for (const set of ['blend', 'absorb', 'both'])
    {
        const dir = path.join(outDir, set);
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(dir, f));
        const rep = (report[set] = { targets: 0, patched: 0, notes: {}, skipped: {} });
        for (const hash of targets())
        {
            rep.targets++;
            let r = { blob: fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')) };
            if (set !== 'absorb') { r = patchBlend(r.blob, blend); if (r.note) rep.notes[r.note] = (rep.notes[r.note] || 0) + 1; }
            if (r.blob && set !== 'blend') r = patchAbsorb(r.blob, absorb);
            if (!r.blob) { rep.skipped[r.reason] = (rep.skipped[r.reason] || 0) + 1; continue; }
            fs.writeFileSync(path.join(dir, '0x' + hash + '.shader'), r.blob);
            rep.patched++;
        }
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
