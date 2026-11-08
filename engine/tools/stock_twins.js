// The stock twins table for SnowRunner Shadows' switches (hid.dll: F8 for every effect, and the NEXT GEN menu's Graphics
// tab with one switch per shader module): for every shader a built shader.pak changed, the CRC32 of its changed code,
// which modules changed it, and the original code, so the DLL can make the original next to each changed shader when
// the game creates it and draw with either one live.
// File SnowRunnerShadows.stock (next to hid.dll in Sources\Bin), little endian:
//   version 2 (since 1.1.3):
//   'SRTW', u32 version 2, u32 count, u32 entriesAt
//   u32 moduleCount (up to 62), then per module u8 length and the id (the catalog id: tonemap, water...), u8 length and
//     the title (the card's name, as the Graphics tab shows it); both printable ASCII
//   zero bytes up to entriesAt (a multiple of 8)
//   count x { u32 key = CRC32 of the changed blob, u32 offset, u32 size, u32 0, u64 mask }, sorted by key, keys unique;
//     mask bit i (0 to 61) = module i of the table changed the shader (every module whose changes the blob carries),
//     bit 62 = the AO pass (the game's SSAO behind GTAO), bit 63 unused in the file (the DLL's "every shader" bit)
//   the original blobs
//   version 1 (up to 1.1.2; the DLL still reads it): 'SRTW', u32 1, u32 count, u32 0, then count x { u32 key, u32 group
//   (1 the AO pass, 2 anything else), u32 offset, u32 size }, sorted by key, and the original blobs
// Main cache: blob i against blob i of the original; side cache (tonemap, bloom): the same stream and index.
// Library: buildTwins(origPak, builtPak[, who]) -> { file, version, count, ao, bytes, shared, modules, unattributed, multi }.
//   who = { modules: [{ id, title }], main: Map (main cache blob index -> Set of ids), side: Map (CRC32 hex of a side
//   cache original -> Set of ids) }, as fidelity_bundle.js's build() records which module wrote each slot, gives
//   version 2; without it version 1. modules lists each module with the count of its shaders; unattributed counts the
//   changed shaders no module claimed (they get no module bit: F8 alone switches them); multi those two or more
//   modules changed. The AO pass's two slots must differ in the built pak (fidelity_bundle.js makes its second copy
//   distinct), else the table would not know which original is which and would leave both out (shared counts the
//   changed shaders left out for that reason).
// inspect(table) -> { version, count, ao, modules: [{ id, title, shaders }], unattributed, multi, bytes } (the tests).
// usage: node stock_twins.js <built shader.pak> <out file>    version 1: a command line carries no attribution
//        node stock_twins.js inspect <table>                  the summary as JSON
const fs = require('fs');
const pak = require('./pak_shader_patch.js');
const side = require('./sdc_side.js');

const AO = new Set(['EA2414F8', 'A3716E2B']); // the AO pass (SSAO) in the original main cache
const MAX_MODULES = 62, AO_BIT = 1n << 62n, MODULE_BITS = AO_BIT - 1n;

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
function ascii(s, what)
{
    if (typeof s !== 'string' || !s.length || s.length > 255 || /[^\x20-\x7e]/.test(s)) throw new Error('a module ' + what + ' must be 1 to 255 printable ASCII characters: ' + JSON.stringify(s));
    return s;
}
const bits = (mask) => { let n = 0; for (let m = mask; m; m >>= 1n) if (m & 1n) n++; return n; };

function buildTwins(orig, built, who)
{
    const ids = who ? who.modules.map((m) => ascii(m.id, 'id')) : null;
    if (ids)
    {
        if (ids.length > MAX_MODULES) throw new Error(ids.length + ' modules: the table holds up to ' + MAX_MODULES);
        if (new Set(ids).size !== ids.length) throw new Error('a module id repeats in the table');
        for (const m of who.modules) ascii(m.title, 'title');
    }
    // the bits of the modules that changed a shader; a module that changed one without being in the table is a fault
    // of the caller's list, not something to hide
    const bitOf = (set) =>
    {
        let m = 0n;
        for (const id of set || [])
        {
            const i = ids.indexOf(id);
            if (i < 0) throw new Error('module ' + id + ' changed a shader but is not in the table');
            m |= 1n << BigInt(i);
        }
        return m;
    };
    const all = [];
    const o = mainBlobs(orig), b = mainBlobs(built);
    if (o.length !== b.length) throw new Error('main caches differ in length: ' + o.length + ' vs ' + b.length);
    for (let i = 0; i < o.length; i++)
    {
        if (o[i].equals(b[i])) continue;
        all.push({ key: pak.crc32(b[i]) >>> 0, ao: AO.has(pak.hex8(pak.crc32(o[i]))), mask: ids ? bitOf(who.main && who.main.get(i)) : 0n, stock: o[i] });
    }
    const so = sideList(orig), sb = sideList(built);
    for (const x of sb)
    {
        const y = so.find((s) => s.stream === x.stream && s.index === x.index);
        if (!y) throw new Error('side cache entry ' + x.stream + '/' + x.index + ' has no original');
        if (!y.blob.equals(x.blob)) all.push({ key: pak.crc32(x.blob) >>> 0, ao: false, mask: ids ? bitOf(who.side && who.side.get(pak.hex8(pak.crc32(y.blob)))) : 0n, stock: y.blob });
    }
    all.sort((p, q) => p.key - q.key);
    // Changed shaders that share a key (a CRC32 can repeat among thousands): with one original between them a single
    // entry serves them all, carrying every one's modules; with different originals the DLL could not tell which is
    // whose, so none of them gets a twin and the switches leave those shaders as they are. shared counts the shaders
    // left out.
    const pairs = [];
    let shared = 0;
    for (let i = 0; i < all.length;)
    {
        let j = i + 1;
        while (j < all.length && all[j].key === all[i].key) j++;
        if (all.slice(i + 1, j).every((p) => p.stock.equals(all[i].stock)))
        {
            const e = all[i];
            for (const p of all.slice(i + 1, j)) { e.mask |= p.mask; e.ao = e.ao || p.ao; }
            pairs.push(e);
        }
        else shared += j - i;
        i = j;
    }
    const version = ids ? 2 : 1, entrySize = ids ? 24 : 16;
    let header;
    if (ids)
    {
        const parts = [Buffer.alloc(4)];
        parts[0].writeUInt32LE(ids.length, 0);
        for (const m of who.modules) parts.push(Buffer.from([m.id.length]), Buffer.from(m.id, 'latin1'), Buffer.from([m.title.length]), Buffer.from(m.title, 'latin1'));
        const table = Buffer.concat(parts);
        const entriesAt = Math.ceil((16 + table.length) / 8) * 8;
        header = Buffer.alloc(entriesAt);
        header.write('SRTW', 0, 'latin1');
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(pairs.length, 8);
        header.writeUInt32LE(entriesAt, 12);
        table.copy(header, 16);
    }
    else
    {
        header = Buffer.alloc(16);
        header.write('SRTW', 0, 'latin1');
        header.writeUInt32LE(1, 4);
        header.writeUInt32LE(pairs.length, 8);
    }
    const entries = Buffer.alloc(pairs.length * entrySize);
    let at = header.length + entries.length;
    pairs.forEach((p, i) =>
    {
        const e = i * entrySize;
        entries.writeUInt32LE(p.key, e);
        if (ids)
        {
            entries.writeUInt32LE(at, e + 4);
            entries.writeUInt32LE(p.stock.length, e + 8);
            entries.writeBigUInt64LE(p.mask | (p.ao ? AO_BIT : 0n), e + 16);
        }
        else
        {
            entries.writeUInt32LE(p.ao ? 1 : 2, e + 4);
            entries.writeUInt32LE(at, e + 8);
            entries.writeUInt32LE(p.stock.length, e + 12);
        }
        at += p.stock.length;
    });
    const file = Buffer.concat([header, entries, ...pairs.map((p) => p.stock)]);
    const modules = ids ? who.modules.map((m, i) => ({ id: m.id, title: m.title, shaders: pairs.filter((p) => p.mask & (1n << BigInt(i))).length })) : [];
    return { file, version, count: pairs.length, ao: pairs.filter((p) => p.ao).length, bytes: file.length, shared, modules,
        unattributed: ids ? pairs.filter((p) => !p.mask && !p.ao).length : 0, multi: ids ? pairs.filter((p) => bits(p.mask) >= 2).length : 0 };
}

// a table read back: its version, counts and modules, with the checks the DLL makes (sorted keys, entries inside the file)
function inspect(buf)
{
    if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'SRTW') throw new Error('not a stock twins table');
    const version = buf.readUInt32LE(4), count = buf.readUInt32LE(8);
    const r = { version, count, ao: 0, modules: [], unattributed: 0, multi: 0, bytes: buf.length };
    if (version === 1)
    {
        if (16 + count * 16 > buf.length) throw new Error('the entries overrun the file');
        for (let i = 0; i < count; i++) if (buf.readUInt32LE(16 + i * 16 + 4) === 1) r.ao++;
        return r;
    }
    if (version !== 2) throw new Error('unknown table version ' + version);
    const entriesAt = buf.readUInt32LE(12), n = buf.readUInt32LE(16);
    let at = 20;
    for (let i = 0; i < n; i++)
    {
        const idLen = buf[at], id = buf.toString('latin1', at + 1, at + 1 + idLen);
        at += 1 + idLen;
        const titleLen = buf[at], title = buf.toString('latin1', at + 1, at + 1 + titleLen);
        at += 1 + titleLen;
        r.modules.push({ id, title, shaders: 0 });
    }
    if (n > MAX_MODULES || at > entriesAt || entriesAt % 8 || entriesAt + count * 24 > buf.length) throw new Error('the module table or the entries overrun the file');
    let prev = -1;
    for (let i = 0; i < count; i++)
    {
        const e = entriesAt + i * 24, key = buf.readUInt32LE(e), off = buf.readUInt32LE(e + 4), size = buf.readUInt32LE(e + 8), mask = buf.readBigUInt64LE(e + 16);
        if (key <= prev) throw new Error('entries not sorted by key at ' + i);
        prev = key;
        if (off + size > buf.length) throw new Error('entry ' + i + ' points past the file');
        if (mask & AO_BIT) r.ao++;
        const mods = mask & MODULE_BITS;
        if (!mods && !(mask & AO_BIT)) r.unattributed++;
        if (bits(mods) >= 2) r.multi++;
        r.modules.forEach((m, k) => { if (mods & (1n << BigInt(k))) m.shaders++; });
    }
    return r;
}

module.exports = { buildTwins, inspect, MAX_MODULES };

if (require.main === module)
{
    const [a, b] = process.argv.slice(2);
    if (a === 'inspect' && b) console.log(JSON.stringify(inspect(fs.readFileSync(b))));
    else if (a && b)
    {
        const r = buildTwins(fs.readFileSync(pak.ORIG), fs.readFileSync(a));
        fs.writeFileSync(b, r.file);
        console.log(r.count + ' stock twins (' + r.ao + ' of the AO pass), ' + r.bytes + ' bytes, version 1 (a command line carries no module table): ' + b);
    }
    else { console.log('usage: node stock_twins.js <built shader.pak> <out file> | inspect <table>'); process.exit(2); }
}
