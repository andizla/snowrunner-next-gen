// SM4/SM5 shader bytecode (SHEX/SHDR) walker and operand decoder. Library + CLI.
//   node dxbc_shex.js align <file.cso> <file.asm>   check the walker against fxc disassembly, print the opcode table seen
const fs = require('fs');
function chunks(b) { const n = b.readUInt32LE(28); const out = {}; for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); out[b.toString('ascii', o, o + 4)] = { off: o, data: o + 8, size: b.readUInt32LE(o + 4) }; } return out; }
function walk(b) { // returns { start, versionTok, lengthTokOff, insts: [{ off, op, len, sat, ext }] } with offsets in bytes into b
  const ch = chunks(b); const c = ch.SHEX || ch.SHDR; const start = c.data; const total = b.readUInt32LE(start + 4); const end = start + total * 4; const insts = []; let p = start + 8;
  while (p < end) { const t = b.readUInt32LE(p); const op = t & 0x7ff; let len;
    if (op === 53) len = b.readUInt32LE(p + 4); else len = (t >>> 24) & 0x7f; // 53 = customdata: length in the next dword
    if (len === 0) throw new Error('zero length at ' + p);
    insts.push({ off: p, op, len, sat: (t >>> 13) & 1, ext: t >>> 31 }); p += len * 4; }
  if (p !== end) throw new Error('walk overran: ' + p + ' vs ' + end);
  return { chunk: c, start, end, insts }; }
function operands(b, inst) { // decode operands of one instruction: [{ type, ncomp, mode, sel, idx: [..], imm: [..], ext, off, size }]
  let p = inst.off; let t = b.readUInt32LE(p); p += 4; while (t >>> 31) { t = b.readUInt32LE(p); p += 4; } const end = inst.off + inst.len * 4; const ops = [];
  const read = () => { const o0 = p; const tok = b.readUInt32LE(p); p += 4; const o = { off: o0, ncomp: tok & 3, mode: (tok >>> 2) & 3, sel: (tok >>> 4) & 0xff, type: (tok >>> 12) & 0xff, dim: (tok >>> 20) & 3, rep: [(tok >>> 22) & 7, (tok >>> 25) & 7, (tok >>> 28) & 7], ext: 0, idx: [], imm: [] };
    let e = tok >>> 31; while (e) { const x = b.readUInt32LE(p); p += 4; o.ext = x; e = x >>> 31; }
    if (o.type === 4) { const n = o.ncomp === 2 ? 4 : 1; for (let i = 0; i < n; i++) { o.imm.push(b.readUInt32LE(p)); p += 4; } }
    else if (o.type === 5) { const n = o.ncomp === 2 ? 8 : 2; p += n * 4; }
    for (let i = 0; i < o.dim; i++) { const r = o.rep[i]; if (r === 0) { o.idx.push(b.readUInt32LE(p)); p += 4; } else if (r === 1) { o.idx.push(b.readUInt32LE(p)); p += 8; } else if (r === 2) { o.idx.push({ rel: read() }); } else if (r === 3) { const base = b.readUInt32LE(p); p += 4; o.idx.push({ base, rel: read() }); } }
    o.size = p - o0; return o; };
  while (p < end) ops.push(read()); return ops; }
module.exports = { chunks, walk, operands };
if (require.main === module && process.argv[2] === 'align') {
  const b = fs.readFileSync(process.argv[3]); const w = walk(b); const lines = []; let inIcb = false;
  for (const l of fs.readFileSync(process.argv[4], 'latin1').split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('//')) continue; if (inIcb) { if (s.includes('}')) inIcb = false; continue; } if (s.startsWith('dcl_immediateConstantBuffer')) { inIcb = !s.includes('}'); lines.push('dcl_immediateConstantBuffer'); continue; } if (/^[a-z]s_\d_\d$/.test(s)) continue; lines.push(s.split(/[\s(]/)[0].replace(/_sat$/, '').replace(/_indexable$/, '')); }
  console.log('instructions walked: ' + w.insts.length + ', disassembly lines: ' + lines.length);
  const map = new Map(); let bad = 0; for (let i = 0; i < Math.min(lines.length, w.insts.length); i++) { const k = w.insts[i].op; if (!map.has(k)) map.set(k, lines[i]); else if (map.get(k) !== lines[i]) { if (bad++ < 5) console.log('  mismatch at ' + i + ': op ' + k + ' was ' + map.get(k) + ' now ' + lines[i]); } }
  console.log('inconsistent opcode/mnemonic pairs: ' + bad); console.log([...map.entries()].sort((a, c) => a[0] - c[0]).map(([k, v]) => k + '=' + v).join(' '));
}
