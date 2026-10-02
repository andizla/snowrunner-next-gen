// The small shader caches in shader.pak (common_pc_sm50_<pass>.sdc: base, dof, edge_aa, ffp, fill, hdr, ...).
// Layout, decoded from common_pc_sm50_hdr.sdc:
//   u32 streamCount, u32 totalRecords, u32 totalCompressed, u32 flag (1)
//   per stream: u32 compressedSize, u32 recordCount, recordCount x { u32 key, u32 entrySize, u32 zero }
//   then the streams, one zlib stream each, back to back
// A stream inflates to its entries concatenated in record order (records sorted by key; no offsets are stored), so an
// entry may change size: only its record, the stream's compressed size and the total change. Shader entries are
// DXBC containers; the 4-byte entries between them are small integers (indices, left as they are).
// usage: node sdc_side.js selftest            parse and rebuild every small cache of the backup pak without changes
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return (~c) >>> 0; };
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');

function parseSide(buf)
{
    const count = buf.readUInt32LE(0), totalRecords = buf.readUInt32LE(4), totalCompressed = buf.readUInt32LE(8), flag = buf.readUInt32LE(12);
    let p = 16;
    const streams = [];
    let records = 0;
    for (let s = 0; s < count; s++)
    {
        const compressed = buf.readUInt32LE(p), n = buf.readUInt32LE(p + 4);
        const recs = [];
        for (let i = 0; i < n; i++) { const o = p + 8 + i * 12; recs.push({ key: buf.readUInt32LE(o), size: buf.readUInt32LE(o + 4), zero: buf.readUInt32LE(o + 8) }); }
        streams.push({ compressed, recs });
        records += n;
        p += 8 + n * 12;
    }
    if (records !== totalRecords) throw new Error('record count mismatch: ' + records + ' vs ' + totalRecords);
    let z = p, compressedSum = 0;
    for (const s of streams)
    {
        const data = zlib.inflateSync(buf.subarray(z, z + s.compressed));
        const expect = s.recs.reduce((a, r) => a + r.size, 0);
        if (data.length !== expect) throw new Error('stream inflates to ' + data.length + ', records say ' + expect);
        let o = 0;
        s.entries = s.recs.map((r) => { const e = data.subarray(o, o + r.size); o += r.size; return e; });
        s.raw = buf.subarray(z, z + s.compressed);
        z += s.compressed;
        compressedSum += s.compressed;
    }
    if (compressedSum !== totalCompressed || z !== buf.length) throw new Error('stream sizes do not add up to the file');
    return { flag, streams };
}

// replacements: Map of CRC (hex8) of an original DXBC entry -> new DXBC. Streams without a replacement keep their
// original compressed bytes, so a rebuild without replacements is byte identical.
function rebuildSide(side, replacements)
{
    const head = [], bodies = [];
    let totalRecords = 0, totalCompressed = 0;
    const replaced = [];
    for (const s of side.streams)
    {
        let changed = false;
        const entries = s.entries.map((e) =>
        {
            if (e.length < 32 || e.toString('latin1', 0, 4) !== 'DXBC') return e;
            const h = hex8(crc32(e));
            const r = replacements.get(h);
            if (!r) return e;
            changed = true;
            replaced.push(h);
            return r;
        });
        const body = changed ? zlib.deflateSync(Buffer.concat(entries), { level: 1 }) : s.raw;
        const sec = Buffer.alloc(8 + s.recs.length * 12);
        sec.writeUInt32LE(body.length, 0);
        sec.writeUInt32LE(s.recs.length, 4);
        s.recs.forEach((r, i) => { sec.writeUInt32LE(r.key, 8 + i * 12); sec.writeUInt32LE(entries[i].length, 12 + i * 12); sec.writeUInt32LE(r.zero, 16 + i * 12); });
        head.push(sec);
        bodies.push(body);
        totalRecords += s.recs.length;
        totalCompressed += body.length;
    }
    const top = Buffer.alloc(16);
    top.writeUInt32LE(side.streams.length, 0);
    top.writeUInt32LE(totalRecords, 4);
    top.writeUInt32LE(totalCompressed, 8);
    top.writeUInt32LE(side.flag, 12);
    return { out: Buffer.concat([top, ...head, ...bodies]), replaced };
}

// every DXBC entry of a parsed side cache: [{ crc, stream, index, blob }]
function sideBlobs(side)
{
    const out = [];
    side.streams.forEach((s, si) => s.entries.forEach((e, i) => { if (e.length >= 32 && e.toString('latin1', 0, 4) === 'DXBC') out.push({ crc: hex8(crc32(e)), stream: si, index: i, blob: e }); }));
    return out;
}

module.exports = { parseSide, rebuildSide, sideBlobs, crc32, hex8 };

if (require.main === module && process.argv[2] === 'selftest')
{
    const pak = fs.readFileSync(path.join(__dirname, '..', 'pak_backup', 'shader.pak.orig'));
    let e = pak.length - 22; while (pak.readUInt32LE(e) !== 0x06054b50) e--;
    const n = pak.readUInt16LE(e + 10); let p = pak.readUInt32LE(e + 16);
    for (let i = 0; i < n; i++)
    {
        const nl = pak.readUInt16LE(p + 28), xl = pak.readUInt16LE(p + 30), cl = pak.readUInt16LE(p + 32);
        const lho = pak.readUInt32LE(p + 42), cs = pak.readUInt32LE(p + 20);
        const name = pak.toString('latin1', p + 46, p + 46 + nl);
        const d = lho + 30 + pak.readUInt16LE(lho + 26) + pak.readUInt16LE(lho + 28);
        p += 46 + nl + xl + cl;
        if (!/common_pc_sm50_.*\.sdc$/.test(name)) continue;
        const buf = pak.subarray(d, d + cs);
        const side = parseSide(buf);
        const same = rebuildSide(side, new Map()).out.equals(buf);
        // a rebuild that recompresses every stream must still parse back to the same entries
        const all = new Map(sideBlobs(side).map((b) => [b.crc, b.blob]));
        const re = parseSide(rebuildSide(side, all).out);
        const entriesSame = re.streams.every((s, si) => s.entries.every((x, k) => x.equals(side.streams[si].entries[k])));
        console.log(name.split('\\').pop().padEnd(32), side.streams.length + ' streams', sideBlobs(side).length + ' shaders', 'no-op rebuild identical: ' + same, 'recompressed rebuild reads back: ' + entriesSame);
    }
}
