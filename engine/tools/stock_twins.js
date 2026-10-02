// The stock twins table for SnowRunner Shadows' dev switches (hid.dll: F8 every shader.pak effect, F11 the AO pass):
// for every shader a built shader.pak changed, the CRC32 of its changed code, its group and the original code, so the
// DLL can make the original next to each changed shader when the game creates it and draw with either one live.
// File SnowRunnerShadows.stock (next to hid.dll in Sources\Bin), little endian:
//   'SRTW', u32 version 1, u32 count, u32 0
//   count x { u32 key = CRC32 of the changed blob, u32 group (1 the AO pass, 2 anything else), u32 offset, u32 size },
//   sorted by key, keys unique
//   the original blobs
// Main cache: blob i against blob i of the original; side cache (tonemap, bloom): the same stream and index.
// Library: buildTwins(origPak, builtPak) -> { file, count, ao, bytes }. The AO pass's two slots must differ in the built
// pak (fidelity_bundle.js makes its second copy distinct), else the table would not know which original is which.
// usage: node stock_twins.js <built shader.pak> <out file>
const fs = require('fs');
const pak = require('./pak_shader_patch.js');
const side = require('./sdc_side.js');

const AO = new Set(['EA2414F8', 'A3716E2B']); // the AO pass (SSAO) in the original main cache

function mainBlobs(buf)
{
    const z = pak.parseZip(buf), ent = z.entries.find((x) => x.name.endsWith(pak.ENTRY_TAIL));
    const { inflated } = pak.readSdc(pak.readEntry(buf, ent)), parsed = pak.parseCache(inflated);
    return parsed.blobs.map((bl) => inflated.subarray(bl.off, bl.off + bl.size));
}
function sideList(buf)
{
    const z = pak.parseZip(buf), ent = z.entries.find((x) => x.name.endsWith('common_pc_sm50_hdr.sdc'));
    return side.sideBlobs(side.parseSide(pak.readEntry(buf, ent)));
}

function buildTwins(orig, built)
{
    const pairs = [];
    const o = mainBlobs(orig), b = mainBlobs(built);
    if (o.length !== b.length) throw new Error('main caches differ in length: ' + o.length + ' vs ' + b.length);
    for (let i = 0; i < o.length; i++)
    {
        if (o[i].equals(b[i])) continue;
        pairs.push({ key: pak.crc32(b[i]) >>> 0, group: AO.has(pak.hex8(pak.crc32(o[i]))) ? 1 : 2, stock: o[i] });
    }
    const so = sideList(orig), sb = sideList(built);
    for (const x of sb)
    {
        const y = so.find((s) => s.stream === x.stream && s.index === x.index);
        if (!y) throw new Error('side cache entry ' + x.stream + '/' + x.index + ' has no original');
        if (!y.blob.equals(x.blob)) pairs.push({ key: pak.crc32(x.blob) >>> 0, group: 2, stock: y.blob });
    }
    pairs.sort((p, q) => p.key - q.key);
    for (let i = 1; i < pairs.length; i++)
        if (pairs[i].key === pairs[i - 1].key) throw new Error('two changed shaders share the key ' + pak.hex8(pairs[i].key) + ': the DLL could not tell their originals apart');
    const head = Buffer.alloc(16 + pairs.length * 16);
    head.write('SRTW', 0, 'latin1');
    head.writeUInt32LE(1, 4);
    head.writeUInt32LE(pairs.length, 8);
    let at = head.length;
    pairs.forEach((p, i) =>
    {
        const e = 16 + i * 16;
        head.writeUInt32LE(p.key, e);
        head.writeUInt32LE(p.group, e + 4);
        head.writeUInt32LE(at, e + 8);
        head.writeUInt32LE(p.stock.length, e + 12);
        at += p.stock.length;
    });
    const file = Buffer.concat([head, ...pairs.map((p) => p.stock)]);
    return { file, count: pairs.length, ao: pairs.filter((p) => p.group === 1).length, bytes: file.length };
}

module.exports = { buildTwins };

if (require.main === module)
{
    const [builtPath, outPath] = process.argv.slice(2);
    if (!builtPath || !outPath) { console.log('usage: node stock_twins.js <built shader.pak> <out file>'); process.exit(2); }
    const r = buildTwins(fs.readFileSync(pak.ORIG), fs.readFileSync(builtPath));
    fs.writeFileSync(outPath, r.file);
    console.log(r.count + ' stock twins (' + r.ao + ' of the AO pass), ' + r.bytes + ' bytes: ' + outPath);
}
