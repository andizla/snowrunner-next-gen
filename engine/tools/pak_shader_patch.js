// Replaces shaders inside SnowRunner's shader.pak, so a look works without any loader.
//   shader.pak is a plain zip (every entry stored, no extra fields, padded with zeros to a 4096 byte multiple behind
//   the end record). The entry [project]\prebuild\shaders_cache_mr\shadercachedx11.sdc is a 12 byte header (date stamp,
//   compressed size, inflated size) plus one zlib stream. Inflated: include list, program count, blob count, then
//   blobCount x (u32 size, DXBC blob), then a program table that refers to blobs by index. A blob may change size.
// usage: node pak_shader_patch.js selftest [pak]           no-op rewrites must reproduce the input byte for byte
//        node pak_shader_patch.js status
//        node pak_shader_patch.js install <blob.cso|variant> replaces 0xEA2414F8 and 0xA3716E2B (the two SSAO passes)
//        node pak_shader_patch.js restore                   puts shader.pak.orig back
// install keeps pak_backup/shader.pak.orig in the project folder (made once, never overwritten) and notes its work in
// shader.pak.look.json next to it. When the
// pak changed outside this tool (game update, Steam verify) and still holds the original shaders, it becomes the new
// backup and the old one is kept under a dated name.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const project = path.resolve(__dirname, '..');
// SR_SHADER_PAK points the tool at another copy of shader.pak (dry runs)
const PAK = process.env.SR_SHADER_PAK || path.join('C:/', 'Program Files (x86)', 'Steam', 'steamapps', 'common', 'Snowrunner', 'preload', 'paks', 'client', 'shader.pak');
const ENTRY_TAIL = 'shadercachedx11.sdc';
const TARGETS = ['EA2414F8', 'A3716E2B'];

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return (~c) >>> 0; }
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- zip (stored entries only, which is all the game uses here)
function parseZip(b) {
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no zip end record');
  const count = b.readUInt16LE(e + 10), cdSize = b.readUInt32LE(e + 12), cdOff = b.readUInt32LE(e + 16), commentLen = b.readUInt16LE(e + 20);
  const tail = b.subarray(e + 22 + commentLen);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory record ' + i);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), cmtLen = b.readUInt16LE(p + 32);
    const ent = { cd: p, cdLen: 46 + nameLen + extraLen + cmtLen, flags: b.readUInt16LE(p + 8), method: b.readUInt16LE(p + 10), crc: b.readUInt32LE(p + 16), csize: b.readUInt32LE(p + 20), usize: b.readUInt32LE(p + 24), lho: b.readUInt32LE(p + 42), name: b.toString('latin1', p + 46, p + 46 + nameLen) };
    if (b.readUInt32LE(ent.lho) !== 0x04034b50) throw new Error('bad local header for ' + ent.name);
    ent.dataOff = ent.lho + 30 + b.readUInt16LE(ent.lho + 26) + b.readUInt16LE(ent.lho + 28);
    entries.push(ent);
    p += ent.cdLen;
  }
  return { entries, cdOff, cdSize, eocd: e, commentLen, tail };
}

// Rewrites one stored entry. Everything else is copied as it is; offsets, sizes and checksums are repaired.
function rewriteZip(b, entryName, data) {
  const z = parseZip(b);
  const order = [...z.entries].sort((x, y) => x.lho - y.lho);
  const target = z.entries.find((x) => x.name === entryName);
  if (!target) throw new Error('entry not found: ' + entryName);
  if (target.method !== 0 || target.flags !== 0) throw new Error('entry is not a plain stored entry');
  if (z.tail.some((v) => v !== 0)) throw new Error('unexpected bytes behind the zip end record');
  const crc = crc32(data);
  const parts = [];
  let pos = 0;
  const newLho = new Map();
  for (let i = 0; i < order.length; i++) {
    const ent = order[i];
    const end = i + 1 < order.length ? order[i + 1].lho : z.cdOff;
    newLho.set(ent, pos);
    if (ent === target) {
      const head = Buffer.from(b.subarray(ent.lho, ent.dataOff));
      head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
      if (end !== ent.dataOff + ent.csize) throw new Error('unexpected bytes behind the entry data');
      parts.push(head, data);
      pos += head.length + data.length;
    } else {
      parts.push(b.subarray(ent.lho, end));
      pos += end - ent.lho;
    }
  }
  const cdStart = pos;
  for (const ent of z.entries) {
    const rec = Buffer.from(b.subarray(ent.cd, ent.cd + ent.cdLen));
    rec.writeUInt32LE(newLho.get(ent), 42);
    if (ent === target) { rec.writeUInt32LE(crc, 16); rec.writeUInt32LE(data.length, 20); rec.writeUInt32LE(data.length, 24); }
    parts.push(rec);
    pos += rec.length;
  }
  const eocd = Buffer.from(b.subarray(z.eocd, z.eocd + 22 + z.commentLen));
  eocd.writeUInt32LE(pos - cdStart, 12); eocd.writeUInt32LE(cdStart, 16);
  parts.push(eocd);
  pos += eocd.length;
  // the game's paks end on a 4096 byte boundary, zero filled, when the original does
  if (b.length % 4096 === 0 && pos % 4096) parts.push(Buffer.alloc(4096 - (pos % 4096)));
  else if (b.length % 4096 !== 0) parts.push(Buffer.from(z.tail));
  return Buffer.concat(parts);
}
const readEntry = (b, ent) => b.subarray(ent.dataOff, ent.dataOff + ent.csize);

// ---- shadercachedx11.sdc
function parseCache(inflated) {
  let p = 4;
  const includes = inflated.readUInt32LE(0);
  for (let i = 0; i < includes; i++) p += 2 + inflated.readUInt16LE(p) + 4;
  const programs = inflated.readUInt32LE(p), count = inflated.readUInt32LE(p + 4);
  p += 8;
  const blobsStart = p;
  const blobs = [];
  for (let i = 0; i < count; i++) {
    const size = inflated.readUInt32LE(p);
    if (inflated.toString('latin1', p + 4, p + 8) !== 'DXBC' || inflated.readUInt32LE(p + 4 + 24) !== size) throw new Error('blob ' + i + ' is not a size framed DXBC container');
    blobs.push({ off: p + 4, size });
    p += 4 + size;
  }
  return { programs, count, blobsStart, blobs, tableOff: p };
}
function rebuildCache(inflated, parsed, replacements) {
  const parts = [inflated.subarray(0, parsed.blobsStart)];
  parsed.blobs.forEach((bl, i) => {
    const data = replacements.get(i) || inflated.subarray(bl.off, bl.off + bl.size);
    const size = Buffer.alloc(4); size.writeUInt32LE(data.length, 0);
    parts.push(size, data);
  });
  parts.push(inflated.subarray(parsed.tableOff));
  return Buffer.concat(parts);
}
function readSdc(sdc) {
  if (sdc.readUInt32LE(4) !== sdc.length - 12) throw new Error('cache header: compressed size does not match');
  const inflated = zlib.inflateSync(sdc.subarray(12));
  if (inflated.length !== sdc.readUInt32LE(8)) throw new Error('cache header: inflated size does not match');
  return { stamp: sdc.readUInt32LE(0), inflated };
}
function writeSdc(stamp, inflated) {
  const packed = zlib.deflateSync(inflated, { level: 1 });   // the shipped stream starts 78 01 too
  const head = Buffer.alloc(12);
  head.writeUInt32LE(stamp, 0); head.writeUInt32LE(packed.length, 4); head.writeUInt32LE(inflated.length, 8);
  return Buffer.concat([head, packed]);
}
function findTargets(inflated, parsed) {
  const found = new Map();
  parsed.blobs.forEach((bl, i) => { const h = hex8(crc32(inflated.subarray(bl.off, bl.off + bl.size))); if (TARGETS.includes(h)) found.set(h, i); });
  return found;
}

function patchPak(pak, blob) {
  const z = parseZip(pak);
  const ent = z.entries.find((x) => x.name.endsWith(ENTRY_TAIL));
  if (!ent) throw new Error('shader.pak has no ' + ENTRY_TAIL);
  const { stamp, inflated } = readSdc(readEntry(pak, ent));
  const parsed = parseCache(inflated);
  const found = findTargets(inflated, parsed);
  if (found.size !== TARGETS.length) throw new Error('original SSAO shaders not found in this pak (found ' + [...found.keys()].join(', ') + ')');
  const rebuilt = rebuildCache(inflated, parsed, new Map([...found.values()].map((i) => [i, blob])));
  // read back what was built before it goes anywhere
  const check = parseCache(rebuilt);
  if (check.count !== parsed.count || !rebuilt.subarray(check.tableOff).equals(inflated.subarray(parsed.tableOff))) throw new Error('rebuilt cache failed its read back');
  for (const i of found.values()) if (!rebuilt.subarray(check.blobs[i].off, check.blobs[i].off + check.blobs[i].size).equals(blob)) throw new Error('rebuilt cache does not hold the new blob');
  const sdc = writeSdc(stamp, rebuilt);
  if (!readSdc(sdc).inflated.equals(rebuilt)) throw new Error('packed cache failed its read back');
  const out = rewriteZip(pak, ent.name, sdc);
  const z2 = parseZip(out);
  for (const e of z.entries) {
    const e2 = z2.entries.find((x) => x.name === e.name);
    const same = readEntry(pak, e).equals(readEntry(out, e2));
    if (e === ent ? !readEntry(out, e2).equals(sdc) : !same) throw new Error('entry check failed: ' + e.name);
    if (crc32(readEntry(out, e2)) !== e2.crc) throw new Error('crc check failed: ' + e.name);
  }
  return { out, slots: [...found.entries()], blobs: parsed.count, sdcSize: sdc.length };
}

// A set of replacements named 0x<CRC of the original blob>.shader: every blob with that CRC is replaced
function patchPakSet(pak, dir) {
  const set = new Map(fs.readdirSync(dir).filter((f) => /^0x[0-9A-F]{8}\.shader$/.test(f)).map((f) => [f.slice(2, 10), fs.readFileSync(path.join(dir, f))]));
  const z = parseZip(pak);
  const ent = z.entries.find((x) => x.name.endsWith(ENTRY_TAIL));
  const { stamp, inflated } = readSdc(readEntry(pak, ent));
  const parsed = parseCache(inflated);
  const repl = new Map();
  const seen = new Set();
  parsed.blobs.forEach((bl, i) => { const h = hex8(crc32(inflated.subarray(bl.off, bl.off + bl.size))); if (set.has(h)) { repl.set(i, set.get(h)); seen.add(h); } });
  const rebuilt = rebuildCache(inflated, parsed, repl);
  const check = parseCache(rebuilt);
  if (check.count !== parsed.count || !rebuilt.subarray(check.tableOff).equals(inflated.subarray(parsed.tableOff))) throw new Error('rebuilt cache failed its read back');
  parsed.blobs.forEach((bl, i) => {
    const got = rebuilt.subarray(check.blobs[i].off, check.blobs[i].off + check.blobs[i].size);
    if (!got.equals(repl.get(i) || inflated.subarray(bl.off, bl.off + bl.size))) throw new Error('rebuilt cache differs at blob ' + i);
  });
  const sdc = writeSdc(stamp, rebuilt);
  if (!readSdc(sdc).inflated.equals(rebuilt)) throw new Error('packed cache failed its read back');
  const out = rewriteZip(pak, ent.name, sdc);
  const z2 = parseZip(out);
  for (const e of z.entries) {
    const e2 = z2.entries.find((x) => x.name === e.name);
    if (e === ent ? !readEntry(out, e2).equals(sdc) : !readEntry(pak, e).equals(readEntry(out, e2))) throw new Error('entry check failed: ' + e.name);
    if (crc32(readEntry(out, e2)) !== e2.crc) throw new Error('crc check failed: ' + e.name);
  }
  return { out, files: set.size, found: seen.size, slots: repl.size, blobs: parsed.count };
}

function resolveBlob(arg) {
  const candidates = [arg, path.join(project, 'replacements', 'ssao_builds', arg, '0xEA2414F8.shader')];
  const f = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!f) throw new Error('no such blob or variant: ' + arg);
  const blob = fs.readFileSync(f);
  if (blob.toString('latin1', 0, 4) !== 'DXBC' || blob.readUInt32LE(24) !== blob.length) throw new Error('not a DXBC container: ' + f);
  return { blob, file: f };
}

// Backup and note live outside the game folder, so the game never meets a second pak-like file next to its paks;
// SR_STATE_DIR puts them in a folder of its own (the installer, SnowRunner Next Gen, keeps one per game)
const STATE_DIR = process.env.SR_STATE_DIR || (process.env.SR_SHADER_PAK ? path.dirname(PAK) : path.join(project, 'pak_backup'));
fs.mkdirSync(STATE_DIR, { recursive: true });
const NOTE = path.join(STATE_DIR, 'shader.pak.look.json');
const ORIG = path.join(STATE_DIR, 'shader.pak.orig');
// local time, as YYYY-MM-DD hh:mm
const localStamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const readNote = () => (fs.existsSync(NOTE) ? JSON.parse(fs.readFileSync(NOTE, 'utf8')) : {});

module.exports = { PAK, ORIG, NOTE, ENTRY_TAIL, parseZip, rewriteZip, readEntry, parseCache, rebuildCache, readSdc, writeSdc, crc32, hex8, sha256, localStamp };
if (require.main === module) {
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'selftest') {
  const pak = fs.readFileSync(arg || PAK);
  const z = parseZip(pak);
  const ent = z.entries.find((x) => x.name.endsWith(ENTRY_TAIL));
  const sdc = Buffer.from(readEntry(pak, ent));
  console.log('zip no-op rewrite identical: ' + rewriteZip(pak, ent.name, sdc).equals(pak));
  const { inflated } = readSdc(sdc);
  const parsed = parseCache(inflated);
  console.log('cache: ' + parsed.programs + ' programs, ' + parsed.count + ' blobs, table at ' + parsed.tableOff + ' of ' + inflated.length);
  console.log('cache no-op rebuild identical: ' + rebuildCache(inflated, parsed, new Map()).equals(inflated));
  console.log('targets: ' + [...findTargets(inflated, parsed).entries()].map(([h, i]) => '0x' + h + ' = blob ' + i).join(', '));
} else if (cmd === 'status') {
  const cur = sha256(fs.readFileSync(PAK));
  const note = readNote();
  const orig = fs.existsSync(ORIG) ? sha256(fs.readFileSync(ORIG)) : null;
  if (orig && cur === orig) console.log('shader.pak is the original (backup present)');
  else if (note.patchedSha256 === cur) console.log('shader.pak holds "' + note.variant + '" since ' + note.date + ' (backup ' + (orig ? 'present' : 'MISSING') + ')');
  else console.log(orig ? 'shader.pak differs from the backup and from the last install: changed outside this tool (game update?)' : 'shader.pak is untouched by this tool (no backup yet)');
} else if (cmd === 'install') {
  const { blob, file } = resolveBlob(arg);
  const curBuf = fs.readFileSync(PAK);
  const cur = sha256(curBuf);
  const note = readNote();
  if (!fs.existsSync(ORIG)) {
    fs.copyFileSync(PAK, ORIG);
    if (sha256(fs.readFileSync(ORIG)) !== cur) throw new Error('backup copy does not match');
    console.log('backup written: ' + ORIG);
  } else if (cur !== sha256(fs.readFileSync(ORIG)) && cur !== note.patchedSha256) {
    patchPak(curBuf, blob);   // throws unless the changed pak still holds the original shaders
    const kept = ORIG + '.' + new Date().toISOString().slice(0, 10);
    fs.renameSync(ORIG, kept);
    fs.copyFileSync(PAK, ORIG);
    console.log('shader.pak changed outside this tool: it is the new backup, the old backup is kept as ' + kept);
  }
  const r = patchPak(fs.readFileSync(ORIG), blob);
  const tmp = PAK + '.tmp';
  fs.writeFileSync(tmp, r.out);
  fs.renameSync(tmp, PAK);
  fs.writeFileSync(NOTE, JSON.stringify({ variant: arg, blobFile: file, blobCrc32: hex8(crc32(blob)), patchedSha256: sha256(r.out), date: localStamp() }, null, 2));
  console.log('installed ' + arg + ' (blob 0x' + hex8(crc32(blob)) + ', ' + blob.length + ' bytes) into blobs ' + r.slots.map(([h, i]) => i + ' (was 0x' + h + ')').join(' and ') + ' of ' + r.blobs + '; shader.pak ' + r.out.length + ' bytes');
} else if (cmd === 'install-set') {
  // always built from the backup, so sets never stack; the backup is made from the current pak if it is missing
  const dir = fs.existsSync(arg) ? arg : path.join(project, 'replacements', arg);
  if (!fs.existsSync(dir)) throw new Error('no such folder: ' + arg);
  if (!fs.existsSync(ORIG)) { fs.copyFileSync(PAK, ORIG); console.log('backup written: ' + ORIG); }
  const r = patchPakSet(fs.readFileSync(ORIG), dir);
  if (!r.found) throw new Error('none of the ' + r.files + ' replacements matches a shader in the backup pak');
  const tmp = PAK + '.tmp';
  fs.writeFileSync(tmp, r.out);
  fs.renameSync(tmp, PAK);
  fs.writeFileSync(NOTE, JSON.stringify({ variant: arg, set: dir, patchedSha256: sha256(r.out), date: localStamp() }, null, 2));
  console.log('installed ' + arg + ': ' + r.found + ' of ' + r.files + ' replacements matched, ' + r.slots + ' of ' + r.blobs + ' blobs replaced; shader.pak ' + r.out.length + ' bytes');
} else if (cmd === 'restore') {
  if (!fs.existsSync(ORIG)) throw new Error('no backup to restore');
  fs.copyFileSync(ORIG, PAK);
  if (fs.existsSync(NOTE)) fs.writeFileSync(NOTE, JSON.stringify({ variant: null, date: localStamp() }, null, 2));
  console.log('shader.pak restored from the backup');
} else console.log('usage: selftest [pak] | status | install <blob.cso|variant> | install-set <folder|replacements subfolder> | restore');

}
