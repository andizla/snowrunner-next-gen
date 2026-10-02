// Extract every DXBC/DXIL container from cache files, name by CRC32 of the whole blob, index reflection data.
// usage: node extract.js <outdir> <file...>     (writes 0x<hash>.cso, index.json, index.tsv, sources_<file>.txt)
const fs = require('fs'), path = require('path');
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }; })();
const cstr = (b, o) => { let e = o; while (e < b.length && b[e] !== 0) e++; return b.toString('latin1', o, e); };
const RES = { 0: 'cb', 1: 'tb', 2: 'tex', 3: 'samp', 4: 'uav', 5: 'sbuf', 6: 'rwsbuf', 7: 'babuf', 8: 'rwbabuf' };
const DIM = { 1: 'buf', 2: '1d', 3: '1darr', 4: '2d', 5: '2darr', 6: '2dms', 7: '2dmsarr', 8: '3d', 9: 'cube', 10: 'cubearr', 11: 'bufex' };
const TYPE = { 0: 'ps', 1: 'vs', 2: 'gs', 3: 'hs', 4: 'ds', 5: 'cs', 6: 'lib', 7: 'ms', 8: 'as' };
function rdef(b, d) {
  const cbCount = b.readUInt32LE(d), cbOff = b.readUInt32LE(d + 4), resCount = b.readUInt32LE(d + 8), resOff = b.readUInt32LE(d + 12), creator = b.readUInt32LE(d + 24);
  const rd11 = b.toString('ascii', d + 28, d + 32) === 'RD11', vs = rd11 ? 40 : 24;
  const cbs = []; for (let i = 0; i < cbCount; i++) { const c = d + cbOff + i * 24; const vc = b.readUInt32LE(c + 4), vo = b.readUInt32LE(c + 8); const vars = []; for (let v = 0; v < vc; v++) { const p = d + vo + v * vs; vars.push(cstr(b, d + b.readUInt32LE(p))); } cbs.push({ name: cstr(b, d + b.readUInt32LE(c)), size: b.readUInt32LE(c + 12), vars }); }
  const res = []; for (let i = 0; i < resCount; i++) { const r = d + resOff + i * 32; const ty = b.readUInt32LE(r + 4), dim = b.readUInt32LE(r + 12); res.push({ name: cstr(b, d + b.readUInt32LE(r)), type: RES[ty] || ('t' + ty), dim: (ty === 2 || ty >= 4) ? (DIM[dim] || ('d' + dim)) : '', bind: b.readUInt32LE(r + 20) }); }
  return { creator: cstr(b, d + creator), cbs, res };
}
function sgn(b, d) { const n = b.readUInt32LE(d); const o = []; for (let i = 0; i < n; i++) { const p = d + 8 + i * 24; o.push(cstr(b, d + b.readUInt32LE(p)) + b.readUInt32LE(p + 4)); } return o; }
const strings = (buf, min) => { const o = []; let s = ''; for (const x of buf) { if (x >= 0x20 && x < 0x7f) s += String.fromCharCode(x); else { if (s.length >= min) o.push(s); s = ''; } } if (s.length >= min) o.push(s); return o; };
const outdir = process.argv[2]; fs.mkdirSync(outdir, { recursive: true }); const index = []; const seen = new Map(); let total = 0, dups = 0;
for (const f of process.argv.slice(3)) {
  const b = fs.readFileSync(f); const src = path.basename(f); let i = b.indexOf('DXBC'), lastEnd = 0, first = true;
  while (i >= 0) {
    let adv = 4;
    if (i + 32 <= b.length) {
      const size = b.readUInt32LE(i + 24), nch = b.readUInt32LE(i + 28);
      if (size >= 64 && i + size <= b.length && nch > 0 && nch <= 32) {
        const ch = {}; const order = []; let ok = true;
        for (let c = 0; c < nch; c++) { const off = b.readUInt32LE(i + 32 + c * 4); if (off + 8 > size) { ok = false; break; } const tag = b.toString('ascii', i + off, i + off + 4); ch[tag] = i + off + 8; order.push(tag); }
        if (ok) {
          if (first) { first = false; fs.writeFileSync(path.join(outdir, 'sources_' + src.replace(/\.[^.]+$/, '') + '.txt'), strings(b.subarray(0, i), 6).join('\n')); }
          total++; const blob = b.subarray(i, i + size); const hash = ('00000000' + CRC(blob).toString(16)).slice(-8).toUpperCase();
          const tags = strings(b.subarray(Math.max(lastEnd, i - 512), i), 5);
          if (seen.has(hash)) { dups++; const r = seen.get(hash); r.at.push(src + '@' + i); if (tags.length) r.tags.push(...tags); }
          else {
            const rec = { hash, size, at: [src + '@' + i], tags, chunks: order, dxil: !!ch.DXIL };
            const vt = ch.SHEX || ch.SHDR || ch.DXIL; if (vt) { const ver = b.readUInt32LE(vt); rec.profile = (TYPE[(ver >> 16) & 0xffff] || 't') + '_' + ((ver >> 4) & 0xf) + '_' + (ver & 0xf); }
            if (ch.STAT && !ch.DXIL) rec.instr = b.readUInt32LE(ch.STAT);
            if (ch.RDEF) { const r = rdef(b, ch.RDEF); rec.cbs = r.cbs; rec.res = r.res; rec.creator = r.creator; }
            if (ch.ISGN) rec.in = sgn(b, ch.ISGN); if (ch.OSGN) rec.out = sgn(b, ch.OSGN);
            seen.set(hash, rec); index.push(rec); fs.writeFileSync(path.join(outdir, '0x' + hash + '.cso'), blob);
          }
          adv = size; lastEnd = i + size;
        }
      }
    }
    i = b.indexOf('DXBC', i + adv);
  }
}
fs.writeFileSync(path.join(outdir, 'index.json'), JSON.stringify(index, null, 1));
const tsv = ['hash\tprofile\tsize\tinstr\tin\tout\tcbuffers\tvars\tresources\ttags\tcopies\tchunks'];
for (const r of index) tsv.push(['0x' + r.hash, r.profile, r.size, r.instr, (r.in || []).join(','), (r.out || []).join(','), (r.cbs || []).map(c => c.name + '[' + c.size + ']').join(','), (r.cbs || []).flatMap(c => c.vars).join(','), (r.res || []).map(x => x.type + (x.dim ? '.' + x.dim : '') + ':' + x.name + '@' + x.bind).join(','), [...new Set(r.tags)].join('|'), r.at.length, r.chunks.join('+')].join('\t'));
fs.writeFileSync(path.join(outdir, 'index.tsv'), tsv.join('\n'));
const prof = {}; for (const r of index) prof[r.profile] = (prof[r.profile] || 0) + 1;
console.log('blobs ' + total + ', unique ' + index.length + ', duplicate copies ' + dups + ', dxil ' + index.filter(r => r.dxil).length + ', with reflection ' + index.filter(r => r.cbs).length + ', profiles ' + JSON.stringify(prof));
const freq = sel => { const m = {}; for (const r of index) for (const n of new Set(sel(r))) m[n] = (m[n] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
console.log('top resources: ' + freq(r => (r.res || []).map(x => x.name)).slice(0, 40).map(([n, c]) => n + '=' + c).join(' '));
console.log('top cbuffers: ' + freq(r => (r.cbs || []).map(x => x.name)).slice(0, 30).map(([n, c]) => n + '=' + c).join(' '));
