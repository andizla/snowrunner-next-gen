// DXBC container surgery: insert instruction words at one or more byte offsets of the SHEX chunk and repair everything
// that depends on the layout (container size, chunk size and offsets, program length, dcl_temps, STAT counters, checksum).
const path = require('path');
const { walk, chunks } = require(path.join(__dirname, 'dxbc_shex.js'));

// DXBC checksum: MD5 rounds with a non-standard final block (verified against shipped shader headers)
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
function transform(st, bl) {
  const M = new Uint32Array(16);
  for (let i = 0; i < 16; i++) M[i] = bl.readUInt32LE(i * 4);
  let a = st[0], b = st[1], c = st[2], d = st[3];
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
    else { f = c ^ (b | ~d); g = (7 * i) % 16; }
    f = (f + a + K[i] + M[g]) >>> 0;
    a = d; d = c; c = b;
    b = (b + (((f << S[i]) | (f >>> (32 - S[i]))) >>> 0)) >>> 0;
  }
  st[0] = (st[0] + a) >>> 0; st[1] = (st[1] + b) >>> 0; st[2] = (st[2] + c) >>> 0; st[3] = (st[3] + d) >>> 0;
}
function dxbcChecksum(data) {
  const st = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const bits = data.length * 8, full = Math.floor(data.length / 64), last = data.length % 64;
  for (let i = 0; i < full; i++) transform(st, data.subarray(i * 64, i * 64 + 64));
  const tail = data.subarray(full * 64);
  if (last >= 56) {
    const b1 = Buffer.alloc(64); tail.copy(b1, 0); b1[last] = 0x80; transform(st, b1);
    const b2 = Buffer.alloc(64); b2.writeUInt32LE(bits >>> 0, 0); b2.writeUInt32LE(((bits >>> 2) | 1) >>> 0, 60); transform(st, b2);
  } else {
    const bl = Buffer.alloc(64); bl.writeUInt32LE(bits >>> 0, 0); tail.copy(bl, 4); bl[4 + last] = 0x80;
    bl.writeUInt32LE(((bits >>> 2) | 1) >>> 0, 60); transform(st, bl);
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(st[i], i * 4);
  return out;
}

// Token helpers (SM5 operand encoding: ncomp bits 1:0, mode 3:2, selection 11:4, type 19:12, index dimension 21:20)
const f32 = (v) => { const t = Buffer.alloc(4); t.writeFloatLE(v); return t.readUInt32LE(0); };
const OP = { add: 0, dp3: 16, mad: 50, max: 52, mov: 54, mul: 56, sample: 69, dcl_resource: 88, dcl_temps: 104 };
const DEST_XYZ = 0x100072, SRC_XYZX = 0x100246, IMM4 = 0x4002;
const ins = (op, body) => [((op | ((body.length + 1) << 24)) >>> 0), ...body];
const imm3 = (v) => [IMM4, f32(v), f32(v), f32(v), 0];

// insertions: [{ at: byte offset of the instruction the words go in front of, words: [...] }]
// stat: { instructions, floatInstructions, movInstructions } added to the STAT counters, temps: extra temp registers
function insertWords(b, insertions, { temps = 0, stat = {} } = {}) {
  const w = walk(b);
  const ch = chunks(b);
  const shex = ch.SHEX || ch.SHDR;
  const sorted = [...insertions].sort((x, y) => x.at - y.at);
  const parts = [];
  let pos = 0, added = 0, words = 0;
  for (const i of sorted) {
    const add = Buffer.alloc(i.words.length * 4);
    i.words.forEach((v, k) => add.writeUInt32LE(v >>> 0, k * 4));
    parts.push(b.subarray(pos, i.at), add);
    pos = i.at; added += add.length; words += i.words.length;
  }
  parts.push(b.subarray(pos));
  const out = Buffer.concat(parts);
  // Everything below sits in front of the first insertion point or is addressed through the repaired offsets
  out.writeUInt32LE(out.length, 24);
  out.writeUInt32LE(shex.size + added, shex.off + 4);
  out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + words, shex.data + 4);
  if (temps) {
    const dcl = w.insts.find((x) => x.op === OP.dcl_temps);
    if (!dcl) throw new Error('no dcl_temps');
    out.writeUInt32LE(b.readUInt32LE(dcl.off + 4) + temps, dcl.off + 4);
  }
  const n = b.readUInt32LE(28);
  for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + added, 32 + i * 4); }
  if (ch.STAT) {
    const s = ch.STAT.data + (ch.STAT.off > shex.off ? added : 0);
    const bump = (index, by) => { if (by) out.writeUInt32LE(out.readUInt32LE(s + index * 4) + by, s + index * 4); };
    bump(0, stat.instructions); bump(1, temps); bump(4, stat.floatInstructions); bump(19, stat.movInstructions);
  }
  dxbcChecksum(out.subarray(20)).copy(out, 4);
  return out;
}

const firstTempFree = (b) => { const dcl = walk(b).insts.find((x) => x.op === OP.dcl_temps); return dcl ? b.readUInt32LE(dcl.off + 4) : -1; };

module.exports = { insertWords, dxbcChecksum, firstTempFree, f32, ins, imm3, OP, DEST_XYZ, SRC_XYZX, IMM4 };
