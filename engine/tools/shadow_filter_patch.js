// Sun shadow filters for SnowRunner's material shaders. Two stock filters exist, one per shadow quality path:
//
// Checker path (1149 shaders, the lower shadow settings; not drawn at the top setting, see the runtime dump):
//   sample_c_lz OUT, COORD, t81, s15, Z                      centre
//   4 x sample_c_lz at +-icb[checker] and its perpendicular   blended in at 0.8
//   ieq Q, l(2), CB[..][47].x ; if_nz Q ; 4 more taps with the other icb row, blended at 0.444 ; endif
//   where checker = (pixel.x + pixel.y) & 1 picks one of the two icb rows.
// High quality path (1269 shaders: trucks, objects, terrain; all 54 shadowed shaders of the runtime dump):
//   cascade choice, blocker search, penumbra estimate, then
//   movc S, CHK, l(0.565685,1.131371,2.2,1.4), l(2.2,1.4,0.565685,1.131371)    anchor
//   mul K, KERNEL, S ; 16 x (offset * scale, mad_sat with ATLAS scale + UV, sample_c_lz at t81/s15 with Z)
//   ... mul OUT, OUT, l(0.5)                                                      end: average of 16 fixed Poisson taps
//
// Variants:
//   nochecker      checker path, both icb rows equal (diagnosis)
//   pcf9           checker path, block replaced by replacements/shadow_filter/pcf9.hlsl (Castano 5x5)
//   hq_grid        high quality path, filter replaced by hq_grid.hlsl: tent over a texel-spaced grid (2 to 8 taps
//                  per axis), same spread as the stock taps
//   hq_grid_crisp  the same with half the spread
//   hq_blocker     high quality path, the blocker search replaced by hq_blocker.hlsl (16 GatherRed on a 4x4 grid),
//                  stock filter kept
//   hq_crisp_blocker  both: the blocker search, then hq_grid_crisp
//   hq_revec       high quality path, filter replaced by hq_revec.hlsl: the straight shadow edge rebuilt inside the texels
//                  (revectorization), hq_grid_crisp's tent for wide penumbrae and texture-like texels
//   hq_revec_blocker  the blocker search, then hq_revec (the fidelity bundle's default)
//   hq_revec_seam, hq_revec_blocker_seam  the same plus the cascade seam dither (hq_seam.hlsl) at the cascade choice's
//                  compare: pixels in the last 7 % of a cascade's range take the next one by chance, TAA averages them
// A replacement is compiled HLSL: its instructions are copied with their temps moved behind the shader's own, its
// inputs v0, v1 mapped to fresh temps that movs fill from the stock block's operands, its output o0 to another fresh
// temp that one mov copies into OUT. A shader is left stock when anything after the block reads a register the old
// block wrote (except OUT), or when the block sits inside a loop.
// usage: node shadow_filter_patch.js <variant> [outDir]   writes 0x<original CRC>.shader per patched shader + report.json
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const OPC = { sample_c_lz: 71, ieq: 32, if: 31, else: 18, endif: 21, loop: 48, endloop: 22, switch: 76, endswitch: 23, mov: 54, movc: 55, mul: 56, mad: 50, dcl_temps: 104, customdata: 53, ret: 62, lt: 49, dp3: 16 };
const NO_DEST = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 18, 19, 20, 21, 22, 23, 31, 44, 48, 62, 63, 76]);
const TWO_DEST = new Set([38, 77, 78, 81]); // imul, sincos, udiv, umul
const ICB = [0.5657, 2.5456, 0, 0, 2.2, 1.4, 0, 0];
const HQ_SCALE = [0.565685, 1.131371, 2.2, 1.4];

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return (~c) >>> 0; };
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');
const icbBytes = (() => { const r = Buffer.alloc(32); ICB.forEach((v, i) => r.writeFloatLE(v, i * 4)); return r; })();
const asFloat = (u) => { const t = Buffer.alloc(4); t.writeUInt32LE(u >>> 0); return t.readFloatLE(0); };

const isShadowTap = (b, ins) => { if (ins.op !== OPC.sample_c_lz) return false; const o = operands(b, ins); return o[2].type === 7 && o[2].idx[0] === 81 && o[3].type === 6 && o[3].idx[0] === 15; };
const comps = (o) => (o.mode === 0 ? o.sel & 15 : o.mode === 1 ? [0, 1, 2, 3].reduce((m, k) => m | (1 << ((o.sel >> (2 * k)) & 3)), 0) : o.mode === 2 ? 1 << (o.sel & 3) : 15);
function destsAndSources(b, ins) {
  const ops = operands(b, ins);
  const nd = NO_DEST.has(ins.op) ? 0 : TWO_DEST.has(ins.op) ? 2 : 1;
  return { dests: ops.slice(0, nd), srcs: ops.slice(nd) };
}

// Checker path block: [start, end] instruction indices, plus the operands the splice needs
function findChecker(b) {
  const w = walk(b);
  const taps = w.insts.map((x, i) => (isShadowTap(b, x) ? i : -1)).filter((i) => i >= 0);
  if (taps.length !== 9) return { reason: 'taps ' + taps.length };
  const start = taps[0];
  let q = -1;
  for (let i = start; i < w.insts.length && i < taps[8]; i++) {
    const x = w.insts[i]; if (x.op !== OPC.ieq) continue;
    const o = operands(b, x);
    if (o[1].type === 4 && o[1].imm[0] === 2 && o[2].type === 8 && o[2].idx[1] === 47) { q = i; break; }
  }
  if (q < 0 || taps.filter((t) => t < q).length !== 5 || w.insts[q + 1].op !== OPC.if) return { reason: 'shape' };
  let depth = 0, end = -1;
  for (let i = q + 1; i < w.insts.length; i++) { const op = w.insts[i].op; if (op === OPC.if) depth++; else if (op === OPC.endif && --depth === 0) { end = i; break; } }
  if (end < taps[8]) return { reason: 'shape' };
  const o = operands(b, w.insts[start]);
  return { w, start, end, out: o[0], inputs: [[{ mask: 3, op: o[1] }, { mask: 4, op: o[4] }]] };
}

// High quality path block: anchor movc to the final mul by 0.5, plus the operands the splice needs
function findHQ(b) {
  const w = walk(b);
  const anchors = [];
  w.insts.forEach((x, i) => {
    if (x.op !== OPC.movc) return;
    const o = operands(b, x);
    if (o.length === 4 && o[2].type === 4 && o[2].imm.length === 4 && o[2].imm.every((v, k) => Math.abs(asFloat(v) - HQ_SCALE[k]) < 1e-4)) anchors.push(i);
  });
  if (anchors.length !== 1) return { reason: 'anchors ' + anchors.length };
  const a = anchors[0];
  const S = operands(b, w.insts[a])[0].idx[0];
  const m = w.insts[a + 1], mo = m.op === OPC.mul ? operands(b, m) : null;
  if (!mo || mo[2].type !== 0 || mo[2].idx[0] !== S || mo[1].type !== 0) return { reason: 'shape: kernel' };
  let firstMad = -1, taps = [], end = -1;
  for (let i = a + 2; i < w.insts.length && i < a + 90; i++) {
    const x = w.insts[i];
    if (x.op === OPC.mad && firstMad < 0) firstMad = i;
    if (x.op === OPC.sample_c_lz) { if (!isShadowTap(b, x)) return { reason: 'shape: tap' }; taps.push(i); }
    if (x.op === OPC.mul && taps.length === 16) { const o = operands(b, x); if (o[2] && o[2].type === 4 && Math.abs(asFloat(o[2].imm[0]) - 0.5) < 1e-6) { end = i; break; } }
  }
  if (end < 0 || taps.length !== 16 || firstMad < 0) return { reason: 'shape: taps ' + taps.length };
  const fm = operands(b, w.insts[firstMad]);
  if (!w.insts[firstMad].sat) return { reason: 'shape: mad_sat' };
  const atlasOp = fm[1].type === 8 ? fm[1] : fm[2]; // mad is commutative in its first two sources
  if (atlasOp.type !== 8 || fm[3].type !== 0) return { reason: 'shape: atlas/uv' };
  const zs = taps.map((t) => operands(b, w.insts[t])[4]);
  if (zs.some((z) => z.type !== 0 || z.idx[0] !== zs[0].idx[0] || z.sel !== zs[0].sel || z.mode !== zs[0].mode)) return { reason: 'shape: depth' };
  const out = operands(b, w.insts[end])[0];
  // v0.xy = uv (the mad's addend, its .xy lanes), v0.z = depth, v1.xy = kernel, v1.zw = atlas scale (.zw lanes)
  return { w, start: a, end, out, inputs: [[{ mask: 3, op: fm[3] }, { mask: 4, op: zs[0] }], [{ mask: 3, op: mo[1] }, { mask: 12, op: atlasOp }]] };
}

// true when nothing after the block reads what the block wrote (OUT excepted), and the block is not inside a loop
function safeToReplace(b, blk) {
  const { w, start, end, out } = blk;
  let loops = 0;
  for (let i = 0; i < start; i++) { const op = w.insts[i].op; if (op === OPC.loop) loops++; else if (op === OPC.endloop) loops--; }
  if (loops) return 'inside a loop';
  // stale: register -> components that still hold a value only the old block wrote, on some path from the block
  let stale = new Map();
  for (let i = start; i <= end; i++) for (const d of destsAndSources(b, w.insts[i]).dests) if (d.type === 0) stale.set(d.idx[0], (stale.get(d.idx[0]) || 0) | (d.sel & 15));
  stale.set(out.idx[0], (stale.get(out.idx[0]) || 0) & ~(out.sel & 15));
  const union = (a, c) => { const u = new Map(a); for (const [r, m] of c) u.set(r, (u.get(r) || 0) | m); return u; };
  const frames = []; // if: { entry, thenEnd }, loop: { entry, loop: true }
  for (let i = end + 1; i < w.insts.length; i++) {
    const ins = w.insts[i];
    if (ins.op === OPC.switch) return 'switch after the block';
    if (ins.op === OPC.else && !frames.length) { // the other branch of an if around the block: never runs after it
      let d = 0; for (i++; i < w.insts.length; i++) { const op = w.insts[i].op; if (op === OPC.if) d++; else if (op === OPC.endif) { if (d === 0) break; d--; } }
      continue;
    }
    const { dests, srcs } = destsAndSources(b, ins);
    for (const s of srcs) {
      if (s.type === 0 && (stale.get(s.idx[0]) || 0) & comps(s)) return 'r' + s.idx[0] + ' read after the block';
      for (const ix of s.idx) if (ix && ix.rel && ix.rel.type === 0 && (stale.get(ix.rel.idx[0]) || 0) & comps(ix.rel)) return 'relative index reads r' + ix.rel.idx[0];
    }
    if (ins.op === OPC.if) frames.push({ entry: new Map(stale) });
    else if (ins.op === OPC.loop) frames.push({ entry: new Map(stale), loop: true });
    else if (ins.op === OPC.else) { const f = frames[frames.length - 1]; f.thenEnd = stale; stale = new Map(f.entry); }
    else if (ins.op === OPC.endif || ins.op === OPC.endloop) {
      const f = frames.pop();
      if (f) stale = union(stale, f.thenEnd || f.entry); // without else, the path that skipped the branch keeps the entry state
    } else for (const d of dests) if (d.type === 0 && stale.has(d.idx[0])) stale.set(d.idx[0], stale.get(d.idx[0]) & ~(d.sel & 15));
  }
  return null;
}

// Helper instructions (between the declarations and ret) as token arrays with temps, inputs vN and o0 renamed. The
// declarations end with dcl_temps, or with the last dcl_* (opcodes 88-106) in a helper the compiler left without temps.
// The helper must end in its only ret: code after an early return (a ret inside a branch) cannot be spliced inline.
function helperBody(helper, base, nInputs) {
  const w = walk(helper);
  const dcl = w.insts.find((x) => x.op === OPC.dcl_temps);
  const own = dcl ? helper.readUInt32LE(dcl.off + 4) : 0;
  const first = dcl ? w.insts.indexOf(dcl) + 1 : w.insts.findIndex((x) => x.op < 88 || x.op > 106);
  const rets = w.insts.map((x, i) => (x.op === OPC.ret ? i : -1)).filter((i) => i >= 0);
  if (rets.length !== 1 || rets[0] !== w.insts.length - 1) throw new Error('helper returns early (' + rets.length + ' ret): give it one exit');
  const IN = (k) => base + own + k, RES = base + own + nInputs;
  const body = [];
  for (const ins of w.insts.slice(first)) {
    if (ins.op === OPC.ret) break;
    const tok = Buffer.from(helper.subarray(ins.off, ins.off + ins.len * 4));
    for (const o of operands(helper, ins)) {
      if (o.type !== 0 && o.type !== 1 && o.type !== 2) continue;
      if (o.dim !== 1 || o.rep[0] !== 0) throw new Error('unexpected helper operand');
      if (o.type === 1 && o.idx[0] >= nInputs) throw new Error('helper reads v' + o.idx[0]);
      const at = o.off - ins.off, idxAt = at + o.size - 4;
      const t = tok.readUInt32LE(at);
      tok.writeUInt32LE((t & ~(0xff << 12)) >>> 0, at); // every renamed operand becomes a temp
      tok.writeUInt32LE(o.type === 0 ? base + o.idx[0] : o.type === 1 ? IN(o.idx[0]) : RES, idxAt);
    }
    body.push(tok);
  }
  return { body, IN, RES, temps: own + nInputs + 1 };
}

function replaceRange(b, from, to, insert, extraTemps, deltaInstructions) {
  const ch = chunks(b); const shex = ch.SHEX || ch.SHDR;
  const out = Buffer.concat([b.subarray(0, from), insert, b.subarray(to)]);
  const added = insert.length - (to - from);
  out.writeUInt32LE(out.length, 24);
  out.writeUInt32LE(shex.size + added, shex.off + 4);
  out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + added / 4, shex.data + 4);
  const dcl = walk(b).insts.find((x) => x.op === OPC.dcl_temps);
  out.writeUInt32LE(b.readUInt32LE(dcl.off + 4) + extraTemps, dcl.off + 4); // dcl_temps sits in front of the block
  const n = b.readUInt32LE(28);
  for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + added, 32 + i * 4); }
  if (ch.STAT) {
    const s = ch.STAT.data + (ch.STAT.off > shex.off ? added : 0);
    out.writeUInt32LE((out.readUInt32LE(s) + deltaInstructions) >>> 0, s);
    out.writeUInt32LE(out.readUInt32LE(s + 4) + extraTemps, s + 4);
  }
  dxbcChecksum(out.subarray(20)).copy(out, 4);
  return out;
}

const words = (...w) => { const buf = Buffer.alloc(w.length * 4); w.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4)); return buf; };
const operandTokens = (b, o) => b.subarray(o.off, o.off + o.size);
const movInst = (dest, src) => Buffer.concat([words((OPC.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSrcX = (reg) => words(0x00100006, reg); // rN.xxxx
const tempSrcXYZW = (reg) => words(0x00100E46, reg); // rN.xyzw

// Replaces blk [start, end] with: movs filling the helper's inputs, the helper, a mov of its result into OUT (its .x
// lane, or all four with blk.outAll: the seam dither returns the lt's four-lane mask)
function splice(b, blk, helper) {
  const unsafe = safeToReplace(b, blk);
  if (unsafe) return { reason: unsafe };
  const base = b.readUInt32LE(blk.w.insts.find((x) => x.op === OPC.dcl_temps).off + 4);
  const h = helperBody(helper, base, blk.inputs.length);
  const movs = [];
  blk.inputs.forEach((lanes, k) => lanes.forEach(({ mask, op }) => movs.push(movInst(tempDest(h.IN(k), mask), operandTokens(b, op)))));
  const insert = Buffer.concat([...movs, ...h.body, movInst(operandTokens(b, blk.out), blk.outAll ? tempSrcXYZW(h.RES) : tempSrcX(h.RES))]);
  const from = blk.w.insts[blk.start].off, last = blk.w.insts[blk.end], to = last.off + last.len * 4;
  return { blob: replaceRange(b, from, to, insert, h.temps, movs.length + h.body.length + 1 - (blk.end - blk.start + 1)) };
}

// High quality path, blocker search: from "mul S, K.zwzw, CB[66].zzzz" (search radius = kernel x maximum penumbra)
// to the first div after the 16 point taps (the ratio (receiver - average) / average). The branch around it, the
// per-cascade penumbra factor and the clamp after it stay stock.
const OP_SAMPLE_L = 72, OP_DIV = 14, OP_ADD = 0;
function findBlocker(b)
{
    const w = walk(b);
    let start = -1;
    for (let i = 0; i < w.insts.length && start < 0; i++)
    {
        const x = w.insts[i];
        if (x.op !== OPC.mul) continue;
        const o = operands(b, x);
        if (!(o[2] && o[2].type === 8 && o[2].idx[1] === 66 && o[2].mode === 1 && o[2].sel === 0xaa && o[1].type === 0)) continue;
        for (let j = i + 1; j < Math.min(i + 6, w.insts.length); j++)
            if (w.insts[j].op === OP_SAMPLE_L && operands(b, w.insts[j])[2].idx[0] === 81) { start = i; break; }
    }
    if (start < 0) return { reason: 'blocker: no search radius' };
    let taps = 0, end = -1, firstMad = -1, depthOp = null;
    for (let i = start + 1; i < w.insts.length && i < start + 110; i++)
    {
        const x = w.insts[i];
        if (x.op === OP_SAMPLE_L) { const o = operands(b, x); if (o[2].type !== 7 || o[2].idx[0] !== 81) return { reason: 'blocker: foreign tap' }; taps++; }
        if (x.op === OPC.mad && firstMad < 0) firstMad = i;
        if (x.op === OP_ADD && !depthOp) { const o = operands(b, x); if (o[2] && o[2].type === 4 && o[2].imm.length === 1 && Math.abs(asFloat(o[2].imm[0]) + 0.001) < 1e-7) depthOp = o[1]; }
        if (x.op === OP_DIV && taps === 16) { end = i; break; }
    }
    if (end < 0 || taps !== 16 || firstMad < 0 || !depthOp) return { reason: 'blocker: shape (taps ' + taps + ')' };
    const so = operands(b, w.insts[start]);
    const fm = operands(b, w.insts[firstMad]);
    const atlasOp = fm[1].type === 8 ? fm[1] : fm[2];
    if (atlasOp.type !== 8 || fm[3].type !== 0 || depthOp.type !== 0) return { reason: 'blocker: operands' };
    const out = operands(b, w.insts[end])[0];
    // v0.xy = uv, v0.z = receiver depth, v0.w = maximum penumbra; v1.xy = kernel (.zw lanes of K), v1.zw = atlas scale
    return { w, start, end, out, inputs: [[{ mask: 3, op: fm[3] }, { mask: 4, op: depthOp }, { mask: 8, op: so[2] }], [{ mask: 3, op: so[1] }, { mask: 12, op: atlasOp }]] };
}

// Cascade choice (the seam dither, hq_seam.hlsl): "dp3 D, PE, cb1[1]" (the view depth: the pixel's offset from the eye
// with the view direction), right before "lt M, cb2[87], D" (the split distances below it). The block is the lt, with
// v0.x = the depth, v1.xyz = the offset (the dp3's operand, not yet overwritten), v2 = the splits, and the mask back into
// M whole. Where the dp3 writes over its own input (dp3 r9.x, r9.xzwx, ...; 50 of the 1269) the block takes the dp3 too
// and blk.own asks for the helper build that computes the depth itself (hq_seam_own.cso)
function findSeam(b) {
  const w = walk(b);
  const L = w.insts.findIndex((x) => { if (x.op !== OPC.lt) return false; const o = operands(b, x); return o[1] && o[1].type === 8 && o[1].idx[0] === 2 && o[1].idx[1] === 87; });
  if (L < 1) return { reason: 'seam: no split compare' };
  const lo = operands(b, w.insts[L]), dp = w.insts[L - 1];
  if (dp.op !== OPC.dp3) return { reason: 'seam: shape' };
  const po = operands(b, dp);
  const pe = po[1].type === 0 ? po[1] : po[2], vd = po[1].type === 0 ? po[2] : po[1];
  if (pe.type !== 0 || vd.type !== 8 || vd.idx[0] !== 1 || vd.idx[1] !== 1) return { reason: 'seam: shape (dp3)' };
  if (lo[2].type !== 0 || po[0].type !== 0 || lo[2].idx[0] !== po[0].idx[0]) return { reason: 'seam: shape (depth)' };
  const own = po[0].idx[0] === pe.idx[0] && ((po[0].sel & 15) & comps(pe)) !== 0;
  return { w, start: own ? L - 1 : L, end: L, own, out: lo[0], outAll: true, inputs: [[{ mask: 1, op: own ? pe : lo[2] }], [{ mask: 7, op: pe }], [{ mask: 15, op: lo[1] }]] };
}

function nochecker(b) {
  const blk = findChecker(b);
  if (!blk.w) return { reason: blk.reason };
  const at = b.indexOf(icbBytes);
  if (at < 0 || b.indexOf(icbBytes, at + 1) >= 0) return { reason: 'icb' };
  const out = Buffer.from(b);
  out.copy(out, at + 16, at, at + 16);
  dxbcChecksum(out.subarray(20)).copy(out, 4);
  return { blob: out };
}

const VARIANTS = {
  nochecker: { family: 'checker', run: (b) => nochecker(b) },
  pcf9: { family: 'checker', helper: 'pcf9.cso', find: findChecker },
  hq_grid: { family: 'hq', helper: 'hq_grid.cso', find: findHQ },
  hq_grid_crisp: { family: 'hq', helper: 'hq_grid_crisp.cso', find: findHQ },
  // blocker search first (it sits before the filter in the shader), then the crisp filter on the result
  hq_crisp_blocker: { family: 'hq', steps: [{ helper: 'hq_blocker.cso', find: findBlocker }, { helper: 'hq_grid_crisp.cso', find: findHQ }] },
  // the blocker search alone, the stock 16 tap filter kept (to test the two changes one at a time)
  hq_blocker: { family: 'hq', helper: 'hq_blocker.cso', find: findBlocker },
  // the revectorized filter, alone and after the blocker search (the default)
  hq_revec: { family: 'hq', helper: 'hq_revec.cso', find: findHQ },
  hq_revec_blocker: { family: 'hq', steps: [{ helper: 'hq_blocker.cso', find: findBlocker }, { helper: 'hq_revec.cso', find: findHQ }] },
  // the same with the cascade seam dither (hq_seam.hlsl) at the cascade choice
  hq_revec_seam: { family: 'hq', steps: [{ helper: 'hq_revec.cso', find: findHQ }, { helper: 'hq_seam.cso', helperOwn: 'hq_seam_own.cso', find: findSeam }] },
  hq_revec_blocker_seam: { family: 'hq', steps: [{ helper: 'hq_blocker.cso', find: findBlocker }, { helper: 'hq_revec.cso', find: findHQ }, { helper: 'hq_seam.cso', helperOwn: 'hq_seam_own.cso', find: findSeam }] },
};

function patchOne(b, variant) {
  const v = VARIANTS[variant];
  if (v.run) return v.run(b);
  const steps = v.steps || [{ helper: v.helper, find: v.find }];
  let cur = b;
  for (const s of steps) {
    const blk = s.find(cur);
    if (!blk.w) return { reason: blk.reason };
    const r = splice(cur, blk, fs.readFileSync(path.join(W, 'replacements', 'shadow_filter', blk.own && s.helperOwn ? s.helperOwn : s.helper)));
    if (!r.blob) return r;
    cur = r.blob;
  }
  return { blob: cur };
}

if (require.main === module) {
  const variant = process.argv[2];
  if (!VARIANTS[variant]) { console.log('usage: node shadow_filter_patch.js ' + Object.keys(VARIANTS).join('|') + ' [outDir]'); process.exit(1); }
  const outDir = process.argv[3] || path.join(W, 'replacements', 'shadow_filter', variant);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
  const report = { variant, family: VARIANTS[variant].family, candidates: 0, patched: 0, skipped: {} };
  for (const f of fs.readdirSync(DUMP)) {
    if (!f.endsWith('.cso')) continue;
    const b = fs.readFileSync(path.join(DUMP, f));
    if (b.indexOf('g_txShadowmap') < 0) continue;
    if (VARIANTS[variant].family === 'checker' && b.indexOf(icbBytes) < 0) continue;
    if (VARIANTS[variant].family === 'hq' && findHQ(b).reason === 'anchors 0') continue;
    report.candidates++;
    const r = patchOne(b, variant);
    if (!r.blob) { const k = r.reason.replace(/r\d+/, 'rN'); report.skipped[k] = (report.skipped[k] || 0) + 1; continue; }
    fs.writeFileSync(path.join(outDir, '0x' + hex8(crc32(b)) + '.shader'), r.blob);
    report.patched++;
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
module.exports = { findChecker, findHQ, findBlocker, findSeam, patchOne, splice, helperBody, replaceRange, safeToReplace };
