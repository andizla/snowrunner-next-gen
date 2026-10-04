// Pushes the near LOD switches of SnowRunner's meshes further out. Many meshes swap to a simpler model 10-15 m from
// the camera, and with GTAO and the sharper shadows that swap shows as a flip in shading at a fixed distance (rock
// outcrops most of all).
// Two sets:
//   nature  rocks, trees and bushes (by name; stumps, twigs, crops, ruins, stone walls, rockets and signs left out)
//   all     every mesh with LOD distances (models and plants; nothing else in shared.pak has them), and the grass: the
//           grass meshes carry no LOD switches, the game fades grass by distance per grass type instead (initial.pak,
//           [media]\...\classes\grass\*.xml, <GrassBrand FadeDistances="7, 17, 30">: density steps, then the end of the
//           grass; most grass is gone at 30 m), so with this set those distances are multiplied by GRASS_FACTOR (3
//           by default; an installer may offer others). initial.pak is built from
//           pak_backup\initial.pak.orig, read back and checked, the same way; the nature set and restore put the
//           original initial.pak back, but only over this tool's own build (another tool's change is left alone).
//
// The meshes live in preload\paks\client\shared.pak as "[meshes]\models_<name>", "[meshes]\plants_<name>" and so on:
// a plain zip (stored or deflate, no zip64, entries back to back, zero padding to a 4096 byte multiple behind the end
// record). Each mesh is a u32 XML size, the XML header (<CombineXMesh Type="Model|Plant"> with <MeshLod
// Distances="10, 25, 45" .../>, pretty printed), then binary data. A mesh whose first switch is nearer than 40 m gets
// its switches raised to at least 40, 70, 110, 160 m (a value already further stays). The XML keeps its byte length
// (the whitespace between tags gives or takes the difference), so the size prefix and the binary data stay byte for
// byte. HidingDistance, MeshShadow and every other value stay.
//
// shared.pak is always built from pak_backup\shared.pak.orig, a copy of the untouched file made on the first install.
// Unchanged entries are copied raw; in changed ones only the deflate blocks holding the XML header are encoded anew
// (see redeflate), stored ones stay stored. The result is read back and checked before it replaces shared.pak. A Steam
// verify or a game update puts the stock file back; after an update, `backup` takes the new file as the original.
// usage: node lod_patch.js list [nature|all] [names] | status | install [nature|all] | restore | backup
//        node lod_patch.js build <file> [nature|all]     a patched copy anywhere, for tests
//        node lod_patch.js grass-status | grass-build <file> [factor]   the grass half (GRASS_FACTOR sets the factor)
//        node lod_patch.js grass-install [factor] | grass-restore   the grass alone (with LOD_GRASS=leave, install and
//        restore then leave it to these; SR_STATE_DIR moves pak_backup's files elsewhere)
//        node lod_patch.js fill-status | fill-install [factor] | fill-restore   the fill light (daytime_fill.js: the day
//        states' ambient times the factor, 0.7 unless FILL_FACTOR says otherwise). Grass and fill light are two parts of
//        one initial.pak built from its original: installing or removing one keeps the other.
//        node lod_patch.js stars-status | stars-install [factor] | stars-restore   brighter stars (sky_stars.js: the star
//        layer times the factor at night, dusk and dawn, 3 unless STARS_FACTOR says otherwise): a third part of the same
//        build. The photo night skies (Scandinavia, Kola, Quebec) carry their stars in the picture's alpha when
//        boot.pak holds those builds; their sky alpha then follows in every build, with or without the stars part
//        node lod_patch.js weather-status | weather-install [parts] | weather-restore   the weather (daytime_weather.js:
//        cloud shadows on every map, showers, drizzle at dusk and night, the horizon clouds, rain and snow drawn farther;
//        fireflies, pollen; the parts as one comma list, WEATHER_PARTS or all seven by default): a fourth part of the
//        same build
//        node lod_patch.js initial-status | initial-restore | initial-build <file> [grass=<f>] [fill=<f>] [stars=<f>] [weather=<parts>]   the parts:
//        what is in initial.pak (JSON), the original back, a built copy anywhere (tests)
//        node lod_patch.js initial-refresh   the parts that are in, built again (new rules, or boot.pak's photo skies changed)
//        node lod_patch.js initial-adopt   another mod's (or a game update's) initial.pak becomes the original, with
//        whatever of this tool's last build is still in it taken out of that original (see initialAdopt)
//        (install, restore, backup and the grass, fill and initial commands with the game closed)
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

// SR_SHARED_PAK points the tool at another copy of shared.pak (dry runs)
const PAK = process.env.SR_SHARED_PAK || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/shared.pak';
const W = path.resolve(__dirname, '..');
// backups and notes: pak_backup in the project, or SR_STATE_DIR (the installer, SnowRunner Next Gen, keeps one per game)
const STATE = process.env.SR_STATE_DIR || path.join(W, 'pak_backup');
if (process.env.SR_STATE_DIR) fs.mkdirSync(STATE, { recursive: true });
const ORIG = path.join(STATE, 'shared.pak.orig');
const NOTE = path.join(STATE, 'shared.pak.lod.json');
const FLOORS = [40, 70, 110, 160]; // metres: switch n of a changed mesh is at least FLOORS[n]
// the grass half of the all set: SR_INITIAL_PAK points it at another copy of initial.pak (dry runs). LOD_GRASS=leave:
// install and restore leave the grass alone, for callers that handle it with grass-install / grass-restore
const INITIAL = process.env.SR_INITIAL_PAK || path.join(path.dirname(PAK), 'initial.pak');
const INITIAL_ORIG = path.join(STATE, 'initial.pak.orig');
const GRASS_NOTE = path.join(STATE, 'initial.pak.grass.json');
const GRASS_WITH_SETS = process.env.LOD_GRASS !== 'leave';
const GRASS_FACTOR = Number(process.env.GRASS_FACTOR || 3);
const GRASS_ENTRY = /classes[\\/]grass[\\/][^\\/]+\.xml$/i;
// the other part of initial.pak: the fill light (daytime_fill.js)
const { isFillState, fillEdit, FILL_FACTOR: FILL_DEFAULT } = require('./daytime_fill.js');
const FILL_FACTOR = Number(process.env.FILL_FACTOR || FILL_DEFAULT);
// and brighter stars (sky_stars.js)
const { isSkyEntry, starsEdit, photoSkies, STARS_FACTOR: STARS_DEFAULT } = require('./sky_stars.js');
const STARS_FACTOR = Number(process.env.STARS_FACTOR || STARS_DEFAULT);
// and the weather (daytime_weather.js)
const { isWeatherEntry, weatherEdit, weatherContext, weatherSpec, weatherCanonical, weatherAdds, DAYTIME_ENTRY: WEATHER_DAYTIME, WEATHER_DEFAULT } = require('./daytime_weather.js');
const WEATHER_PARTS = weatherCanonical(process.env.WEATHER_PARTS || WEATHER_DEFAULT);
// boot.pak holds the photo night skies; builds of them with the stars in their alpha need a sky alpha to match
// (sky_stars.js). SR_BOOT_PAK points at another copy (dry runs)
const BOOT = process.env.SR_BOOT_PAK || path.join(path.dirname(PAK), 'boot.pak');
// A plain zip's offsets are 32 bit. The stock file is 233 KB under 2 GiB and the all set takes it past that. The game
// reads 32 bit entry offsets past 2 GiB in its (zip64) texture paks, and it loads this build too.
const LIMIT = 0xffffffff;
const SETS = { nature: 'rocks, trees, bushes', all: 'all meshes' };

// the nature set, by name without the models_/plants_ prefix
const TREES = /^(ash_tree|aspen|birch|burnt_pine|burnt_spruce|burnt_small_tree|burnt_us_tsuga|chestnut|conifer|elm|larch|mangrove|maple|oak|palm_(banana|cocos|sabal)|pine|poplar|saman|silver_fir|spruce|sugar_maple|us_tsuga|willow|smoldering_pine|small_tree|cactus_saguaro)/;
const BUSHES = /^(bush|chunk_bush|dry_bush|burnt_dry_bush|prickly_pear)/;
const PLANT_ROCKS = /^(rock|small_rock|small_forest_rock|burnt_small_rock)/;
const NOT_PLANTS = /stump|_leaf|root|twig/;
// models: rocks only, not the stone walls, towers and ruins, nor rockets, signs and banners that only carry the word
const MODEL_ROCKS = /^(burnt_)?(rock(?!et)|cliff|boulder|pebble)/;
const baseName = (name) => name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1); // the pak writes "[meshes]\..."
// the nature group of a mesh name: { group: 'rocks' | 'trees' | 'bushes', type: the mesh type the name implies } or null
function natureGroup(name)
{
    const base = baseName(name);
    if (base.startsWith('plants_'))
    {
        const s = base.slice(7);
        const group = NOT_PLANTS.test(s) ? null : TREES.test(s) ? 'trees' : BUSHES.test(s) ? 'bushes' : PLANT_ROCKS.test(s) ? 'rocks' : null;
        return group && { group, type: 'plant' };
    }
    if (base.startsWith('models_'))
    {
        const s = base.slice(7);
        return MODEL_ROCKS.test(s) ? { group: 'rocks', type: 'model' } : null;
    }
    return null;
}
// whether a set takes an entry: { group, type } (type null = any; the grass meshes themselves have no LOD switches, so
// only the plants named after grass change, fireflies grass, miscanthus and swamp grass) or null
function classify(name, set = 'nature')
{
    if (set === 'nature') return natureGroup(name);
    if (!name.startsWith('[meshes]')) return null;
    return natureGroup(name) || { group: null, type: null };
}

// "10, 25, 45" -> "40, 70, 110"; null when the list stays (first switch far enough already, or not a plain rising list)
function raise(list)
{
    const parts = list.split(',').map((s) => s.trim());
    if (parts.length > FLOORS.length || parts.some((s) => !/^\d+(\.\d+)?$/.test(s))) return null;
    const d = parts.map(Number);
    if (d[0] >= FLOORS[0] || d.some((x, i) => i > 0 && !(x > d[i - 1]))) return null;
    return parts.map((s, i) => (d[i] >= FLOORS[i] ? s : String(FLOORS[i]))).join(', ');
}

function meshType(data)
{
    const n = data.length >= 8 ? data.readUInt32LE(0) : 0;
    if (n < 16 || n > data.length - 4) return '';
    const m = /<CombineXMesh\b[^>]*?\bType="([^"]*)"/i.exec(data.toString('latin1', 4, 4 + Math.min(n, 4096)));
    return m ? m[1].toLowerCase() : '';
}

// the mesh with its switches raised and its XML at the old byte length, or null (nothing to raise, or no whitespace
// between tags to balance with); notes collects "old -> new". Works on the header alone as well.
function patchMesh(data, notes = [])
{
    const n = data.length >= 8 ? data.readUInt32LE(0) : 0;
    if (n < 16 || n > data.length - 4) return null;
    const xml = data.toString('latin1', 4, 4 + n);
    let delta = 0;
    let out = xml.replace(/(<MeshLod\b[^>]*?\bDistances\s*=\s*")([^"]*)(")/gi, (all, open, list, close) =>
    {
        const raised = raise(list);
        if (raised === null) return all;
        delta += raised.length - list.length;
        notes.push(list + ' -> ' + raised);
        return open + raised + close;
    });
    if (out === xml) return null;
    if (delta < 0) out = out.replace(/>([ \t\r\n]+)</, (all, ws) => '>' + ws + ' '.repeat(-delta) + '<');
    else if (delta > 0)
    {
        let left = delta;
        out = out.replace(/>([ \t\r\n]+)</g, (all, ws) => { const k = Math.min(left, ws.length); left -= k; return '>' + ws.slice(k) + '<'; });
    }
    if (out.length !== xml.length) return null;
    return Buffer.concat([data.subarray(0, 4), Buffer.from(out, 'latin1'), data.subarray(4 + n)]);
}
const hasLods = (data) => /<MeshLod\b[^>]*?\bDistances\s*=/i.test(data.toString('latin1', 4, 4 + Math.min(data.readUInt32LE(0), data.length - 4)));

// ---- zip, read and written in pieces (the file is 2 GB)
function readZip(fd)
{
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 22 + 65535 + 4096));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const e = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (e < 0) throw new Error('no zip end record');
    if (e >= 20 && tail.readUInt32LE(e - 20) === 0x07064b50) throw new Error('zip64: not handled');
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16), commentLen = tail.readUInt16LE(e + 20);
    if (tail.subarray(e + 22 + commentLen).some((v) => v !== 0)) throw new Error('unexpected bytes behind the zip end record');
    if (cdOff + cdSize !== size - tail.length + e) throw new Error('bytes between the central directory and the end record');
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    for (let p = 0; p < cd.length;)
    {
        if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory record at ' + p);
        const n = cd.readUInt16LE(p + 28), x = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32);
        entries.push({ rec: p, flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
            csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), lho: cd.readUInt32LE(p + 42), name: cd.toString('latin1', p + 46, p + 46 + n) });
        p += 46 + n + x + c;
    }
    if (entries.length !== tail.readUInt16LE(e + 10)) throw new Error('entry count differs from the end record');
    return { size, cd, cdOff, eocd: Buffer.from(tail.subarray(e, e + 22 + commentLen)), entries };
}

// an entry's local header (name and extra included) and where its data starts
function localHeader(fd, ent)
{
    const fixed = Buffer.alloc(30);
    fs.readSync(fd, fixed, 0, 30, ent.lho);
    if (fixed.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header: ' + ent.name);
    const head = Buffer.alloc(30 + fixed.readUInt16LE(26) + fixed.readUInt16LE(28));
    fs.readSync(fd, head, 0, head.length, ent.lho);
    return head;
}
function readRaw(fd, ent, head)
{
    const raw = Buffer.alloc(ent.csize);
    fs.readSync(fd, raw, 0, raw.length, ent.lho + head.length);
    return raw;
}
// an entry's local header, compressed data and data, checked against the CRC
function readEntry(fd, ent)
{
    const head = localHeader(fd, ent), raw = readRaw(fd, ent, head);
    const data = ent.flags !== 0 ? null : ent.method === 8 ? zlib.inflateRawSync(raw) : ent.method === 0 ? raw : null;
    if (!data || data.length !== ent.usize || zlib.crc32(data) !== ent.crc) throw new Error('entry does not read back: ' + ent.name);
    return { head, raw, data };
}
// the start of an entry's data, enough for the XML header (inflates the first 64 KB of compressed data as far as it goes)
function readStart(fd, ent)
{
    if (ent.flags !== 0 || (ent.method !== 0 && ent.method !== 8)) return Buffer.alloc(0);
    const head = localHeader(fd, ent);
    const part = Buffer.alloc(Math.min(ent.csize, 65536));
    fs.readSync(fd, part, 0, part.length, ent.lho + head.length);
    return ent.method === 8 ? zlib.inflateRawSync(part, { finishFlush: zlib.constants.Z_SYNC_FLUSH }) : part;
}

// ---- deflate, re-encoded only as far as it has to be. The game's encoder packs tighter than zlib: whole meshes at
// zlib -9 come out 4% larger (5 MB over the nature set alone). So only the blocks up to the end of the XML header are
// encoded anew (zlib -9, ending on a sync flush) and the original later blocks follow as they are, shifted to the byte
// boundary (about 110 KB over the nature set). Every result is inflated and compared.
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function huffman(lengths)
{
    const count = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(lengths.length);
    for (const l of lengths) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 15; i++) offs[i + 1] = offs[i] + count[i];
    lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s; });
    return { count, symbols };
}
// the end of the first block whose output reaches `need` bytes: { bitEnd, outEnd, final }
function blockEnd(buf, need)
{
    let pos = 0, out = 0;
    const bit = () => { const v = (buf[pos >> 3] >> (pos & 7)) & 1; pos++; return v; };
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v; };
    const decode = (h) =>
    {
        let code = 0, first = 0, index = 0;
        for (let len = 1; len < 16; len++)
        {
            code |= bit();
            const c = h.count[len];
            if (code - c < first) return h.symbols[index + (code - first)];
            index += c; first = (first + c) << 1; code <<= 1;
        }
        throw new Error('bad deflate code');
    };
    for (;;)
    {
        const final = bit(), type = bits(2);
        if (type === 0)
        {
            pos = (pos + 7) & ~7;
            const len = buf[pos >> 3] | (buf[(pos >> 3) + 1] << 8);
            pos += 32 + len * 8; out += len;
        }
        else
        {
            let lit, dist;
            if (type === 1) { lit = huffman(new Array(288).fill(8).fill(9, 144, 256).fill(7, 256, 280)); dist = huffman(new Array(30).fill(5)); }
            else if (type === 2)
            {
                const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
                const cl = new Array(19).fill(0);
                for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
                const ch = huffman(cl), lens = [];
                while (lens.length < hlit + hdist)
                {
                    const s = decode(ch);
                    if (s < 16) lens.push(s);
                    else if (s === 16) { const prev = lens[lens.length - 1], r = 3 + bits(2); for (let i = 0; i < r; i++) lens.push(prev); }
                    else { const r = s === 17 ? 3 + bits(3) : 11 + bits(7); for (let i = 0; i < r; i++) lens.push(0); }
                }
                lit = huffman(lens.slice(0, hlit)); dist = huffman(lens.slice(hlit));
            }
            else throw new Error('bad deflate block type');
            for (let s; (s = decode(lit)) !== 256;)
            {
                if (s < 256) { out++; continue; }
                out += LBASE[s - 257] + bits(LEXT[s - 257]);
                bits(DEXT[decode(dist)]);
            }
        }
        if (out >= need || final) return { bitEnd: pos, outEnd: out, final };
    }
}
// the stream's bits from bitPos on, moved to start at bit 0
function bitsFrom(buf, bitPos)
{
    const b = bitPos >> 3, s = bitPos & 7;
    if (!s) return buf.subarray(b);
    const out = Buffer.alloc(buf.length - b);
    for (let i = 0; i < out.length; i++) out[i] = ((buf[b + i] >> s) | ((buf[b + i + 1] || 0) << (8 - s))) & 255;
    return out;
}
// the patched data deflated. Where the original blocks after the one holding the XML header's end can be kept (the
// result inflates to exactly `next`): { prefix, tailBit, length, how: 'spliced' }, the kept part to be taken from the
// source when writing. Else the whole entry at zlib -9: { comp, length, how: 'one block' | 'splice failed' }.
function redeflate(raw, next, xmlEnd)
{
    const cut = blockEnd(raw, xmlEnd);
    if (!cut.final)
    {
        const prefix = zlib.deflateRawSync(next.subarray(0, cut.outEnd), { level: 9, memLevel: 9, finishFlush: zlib.constants.Z_SYNC_FLUSH });
        const tail = bitsFrom(raw, cut.bitEnd);
        let same = false;
        try { same = zlib.inflateRawSync(Buffer.concat([prefix, tail])).equals(next); } catch { same = false; }
        if (same) return { prefix, tailBit: cut.bitEnd, length: prefix.length + tail.length, how: 'spliced' };
    }
    const comp = zlib.deflateRawSync(next, { level: 9, memLevel: 9 });
    return { comp, length: comp.length, how: cut.final ? 'one block' : 'splice failed' };
}

// every entry the set changes, with what its new data is made of, counts per group, and the size of the result
function plan(file, set = 'nature')
{
    if (!SETS[set]) throw new Error('unknown set ' + set + ' (nature or all)');
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd);
        const jobs = new Map(), changed = {}, kept = {}, noRoom = [], how = {};
        let grow = 0;
        for (const ent of z.entries)
        {
            const c = classify(ent.name, set);
            if (!c) continue;
            const start = readStart(fd, ent), type = meshType(start);
            if (!type || type === 'grass' || (c.type && type !== c.type)) continue;
            const group = c.group || 'other ' + type + 's';
            const peek = [];
            if (!patchMesh(start, peek))
            {
                if (peek.length) noRoom.push(ent.name); else if (hasLods(start)) kept[group] = (kept[group] || 0) + 1;
                continue;
            }
            const { head, raw, data } = readEntry(fd, ent);
            const notes = [];
            const next = patchMesh(data, notes);
            if (!next) throw new Error('the header and the whole entry disagree: ' + ent.name);
            const n = data.readUInt32LE(0);
            const job = { head, crc: zlib.crc32(next), usize: next.length, type, group, notes };
            if (ent.method === 8)
            {
                const r = redeflate(raw, next, 4 + n);
                Object.assign(job, r.how === 'spliced' ? { prefix: r.prefix, tailBit: r.tailBit } : { comp: r.comp });
                job.length = r.length;
                how[r.how] = (how[r.how] || 0) + 1;
            }
            else
            {
                job.storedHead = Buffer.from(next.subarray(0, 4 + n)); // the rest is the source's own bytes
                job.length = next.length;
                how.stored = (how.stored || 0) + 1;
            }
            jobs.set(ent, job);
            changed[group] = (changed[group] || 0) + 1;
            grow += job.length - ent.csize;
        }
        const end = z.cdOff + grow + z.cd.length + z.eocd.length;
        const size = z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end;
        return { z, set, jobs, changed, kept, noRoom, grow, how, size };
    }
    finally { fs.closeSync(fd); }
}

// writes the patched pak: raw copies of unchanged entries, the planned data for changed ones, the central directory
// with new offsets and sizes, the end record, and zero padding to a 4096 byte multiple when the original has it.
// p.adds (optional): new entries [{ name, data, comp, method, crc }], written after the last entry with a local header
// and a central directory record of their own (version, time and date as the first record has them)
function writePak(src, dst, p)
{
    if (p.size > LIMIT) throw new Error('the result would be ' + p.size + ' bytes, past what a plain zip can address');
    const fin = fs.openSync(src, 'r'), fout = fs.openSync(dst, 'w');
    try
    {
        const order = p.z.entries.slice().sort((a, b) => a.lho - b.lho);
        const newLho = new Map(), buf = Buffer.alloc(8 << 20);
        let pos = 0;
        const put = (b) => { fs.writeSync(fout, b, 0, b.length, pos); pos += b.length; };
        const copy = (from, to) => { for (let q = from; q < to;) { const k = Math.min(buf.length, to - q); fs.readSync(fin, buf, 0, k, q); put(buf.subarray(0, k)); q += k; } };
        copy(0, order[0].lho);
        order.forEach((ent, i) =>
        {
            const end = i + 1 < order.length ? order[i + 1].lho : p.z.cdOff;
            newLho.set(ent, pos);
            const job = p.jobs.get(ent);
            if (!job) { copy(ent.lho, end); return; }
            // bytes behind the entry that no record points at (a mod that appended its own copies leaves the old ones in
            // place) are copied through as they are, after the new data
            const behind = ent.lho + job.head.length + ent.csize;
            if (end < behind) throw new Error('entry runs into the next: ' + ent.name);
            const head = Buffer.from(job.head);
            head.writeUInt32LE(job.crc, 14); head.writeUInt32LE(job.length, 18); head.writeUInt32LE(job.usize, 22);
            if (job.method !== undefined) head.writeUInt16LE(job.method, 8);   // a job may store what was deflated
            put(head);
            const from = pos;
            if (job.comp) put(job.comp);
            else
            {
                const raw = readRaw(fin, ent, job.head);
                if (job.prefix) { put(job.prefix); put(bitsFrom(raw, job.tailBit)); }
                else { put(job.storedHead); put(raw.subarray(job.storedHead.length)); }
            }
            if (pos - from !== job.length) throw new Error('wrote ' + (pos - from) + ' bytes for ' + ent.name + ', planned ' + job.length);
            copy(behind, end);
        });
        // the new entries: local header, name, data
        const made = p.z.cd.readUInt16LE(4), time = p.z.cd.readUInt16LE(12), date = p.z.cd.readUInt16LE(14), recs = [];
        for (const a of p.adds || [])
        {
            const name = Buffer.from(a.name, 'latin1'), head = Buffer.alloc(30), rec = Buffer.alloc(46);
            head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(a.method, 8); head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12);
            head.writeUInt32LE(a.crc, 14); head.writeUInt32LE(a.comp.length, 18); head.writeUInt32LE(a.data.length, 22); head.writeUInt16LE(name.length, 26);
            rec.writeUInt32LE(0x02014b50, 0); rec.writeUInt16LE(made, 4); rec.writeUInt16LE(20, 6); rec.writeUInt16LE(a.method, 10); rec.writeUInt16LE(time, 12); rec.writeUInt16LE(date, 14);
            rec.writeUInt32LE(a.crc, 16); rec.writeUInt32LE(a.comp.length, 20); rec.writeUInt32LE(a.data.length, 24); rec.writeUInt16LE(name.length, 28); rec.writeUInt32LE(pos, 42);
            recs.push(rec, name);
            put(head); put(name); put(a.comp);
        }
        const cd = Buffer.from(p.z.cd), cdOff = pos;
        for (const ent of p.z.entries)
        {
            cd.writeUInt32LE(newLho.get(ent), ent.rec + 42);
            const job = p.jobs.get(ent);
            if (job) { cd.writeUInt32LE(job.crc, ent.rec + 16); cd.writeUInt32LE(job.length, ent.rec + 20); cd.writeUInt32LE(job.usize, ent.rec + 24); }
            if (job && job.method !== undefined) cd.writeUInt16LE(job.method, ent.rec + 10);
        }
        put(cd);
        for (const r of recs) put(r);
        const eocd = Buffer.from(p.z.eocd), added = (p.adds || []).length;
        if (added)
        {
            eocd.writeUInt16LE(eocd.readUInt16LE(8) + added, 8); eocd.writeUInt16LE(eocd.readUInt16LE(10) + added, 10);
            eocd.writeUInt32LE(pos - cdOff, 12);
        }
        eocd.writeUInt32LE(cdOff, 16);
        put(eocd);
        if (p.z.size % 4096 === 0 && pos % 4096) put(Buffer.alloc(4096 - (pos % 4096)));
        if (pos !== p.size) throw new Error('wrote ' + pos + ' bytes, planned ' + p.size);
    }
    finally { fs.closeSync(fin); fs.closeSync(fout); }
}

// reads a written pak back: the same entries in the same order; every changed entry passes its CRC, keeps its size and
// mesh type and has nothing left to raise; the others keep their records, and every 50th is read and CRC checked
function verify(file, p)
{
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd);
        if (z.entries.length !== p.z.entries.length) throw new Error('entry count changed');
        let sampled = 0;
        z.entries.forEach((ent, i) =>
        {
            const was = p.z.entries[i];
            if (ent.name !== was.name) throw new Error('entry order changed at ' + i);
            const job = p.jobs.get(was);
            if (job)
            {
                const { data } = readEntry(fd, ent);
                if (ent.crc !== job.crc || ent.usize !== was.usize || meshType(data) !== job.type || patchMesh(data) !== null) throw new Error('changed entry reads back wrong: ' + ent.name);
                return;
            }
            if (ent.crc !== was.crc || ent.csize !== was.csize || ent.usize !== was.usize || ent.method !== was.method) throw new Error('entry record changed: ' + ent.name);
            if (i % 50 === 0) { readEntry(fd, ent); sampled++; }
        });
        return sampled;
    }
    finally { fs.closeSync(fd); }
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function cdHash(file)
{
    const fd = fs.openSync(file, 'r');
    try { return sha256(readZip(fd).cd); } finally { fs.closeSync(fd); }
}
function fileHash(file)
{
    const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(16 << 20);
    try { for (let k; (k = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, k)); } finally { fs.closeSync(fd); }
    return h.digest('hex');
}
const readNote = () => (fs.existsSync(NOTE) ? JSON.parse(fs.readFileSync(NOTE, 'utf8')) : {});
const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

// the installed set ('nature' or 'all'), 'vanilla' (the backup, or no backup yet), 'changed' (neither: a game update,
// another tool) or 'missing'
function status()
{
    if (!fs.existsSync(PAK)) return 'missing';
    const cur = cdHash(PAK), note = readNote();
    if (note.cdSha256 === cur) return note.set || 'nature';
    if (!fs.existsSync(ORIG)) return 'vanilla';
    return (note.origCdSha256 || cdHash(ORIG)) === cur ? 'vanilla' : 'changed';
}

// takes the current shared.pak as the original (first install, or after a game update)
function backup()
{
    const tmp = ORIG + '.tmp';
    console.log('copying shared.pak (2.1 GB) to ' + ORIG);
    fs.copyFileSync(PAK, tmp);
    const sum = fileHash(PAK);
    if (fileHash(tmp) !== sum) { fs.unlinkSync(tmp); throw new Error('the copy differs from shared.pak'); }
    fs.renameSync(tmp, ORIG);
    fs.writeFileSync(NOTE, JSON.stringify({ origSha256: sum, origCdSha256: cdHash(ORIG), origDate: stamp() }, null, 2));
}

// ---- initial.pak: four parts, built together from the original. The grass: every grass brand's FadeDistances times its
// factor. The fill light: the day states' ambient times its factor (daytime_fill.js). The stars: the star layer times
// its factor (sky_stars.js). The weather: cloud shadows, showers, evening drizzle, horizon clouds and rain drawn farther,
// as listed (daytime_weather.js). Not a part but a fact of the game folder: the photo night skies whose picture in boot.pak
// carries the stars in its alpha get their sky alpha times 3 in every build, stars part or not (without it the aurora
// comes out at a third). Changed entries are small XML
// files and are stored again whole (deflated at zlib -9 where they were deflated); everything else is copied raw.
// "7, 17, 30" -> "21, 51, 90"; null when the list is not plain numbers
function scaleList(list, factor)
{
    const parts = list.split(',').map((s) => s.trim());
    if (!parts.length || parts.some((s) => !/^\d+(\.\d+)?$/.test(s))) return null;
    return parts.map((s) => { const v = Number(s) * factor; return Number.isInteger(v) ? String(v) : v.toFixed(1); }).join(', ');
}
// parts: { grass: factor or null, fill: factor or null, stars: factor or null, weather: comma list or null }. photoWas:
// the photo skies an earlier build was made for (the note's starsPhoto, for initialAdopt); left out = what boot.pak holds
// now. A job's parts: the parts whose edit changed that entry (an entry can take two: a day state the fill light and the
// weather); its group is the first of them
function planInitial(file, parts, photoWas)
{
    const grass = parts.grass || null, fill = parts.fill || null, stars = parts.stars || null, weather = weatherCanonical(parts.weather || null);
    if (grass !== null && !(grass > 0)) throw new Error('grass factor ' + grass);
    if (fill !== null && !(fill > 0 && fill <= 2)) throw new Error('fill factor ' + fill);
    if (stars !== null && !(stars > 0 && stars <= 20)) throw new Error('stars factor ' + stars);
    const photo = photoWas || photoSkies(BOOT), wParts = weatherSpec(weather);
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd), jobs = new Map(), changed = {}, weatherCount = {};
        // the evening part asks which regions have rain in their day states: the day states read once ahead
        let ctx = { rainRegions: new Set() };
        if (wParts.has('evening'))
        {
            const texts = [];
            for (const ent of z.entries) if (WEATHER_DAYTIME.test(ent.name) && ent.flags === 0 && (ent.method === 0 || ent.method === 8)) texts.push({ name: ent.name, text: readEntry(fd, ent).data.toString('latin1') });
            ctx = weatherContext(texts);
        }
        let grow = 0;
        for (const ent of z.entries)
        {
            const isGrass = grass !== null && GRASS_ENTRY.test(ent.name), isFill = fill !== null && isFillState(ent.name), isStars = (stars !== null || photo.size > 0) && isSkyEntry(ent.name);
            const isWeather = wParts.size > 0 && isWeatherEntry(ent.name);
            if (!(isGrass || isFill || isStars || isWeather) || ent.flags !== 0 || (ent.method !== 0 && ent.method !== 8)) continue;
            const { head, data } = readEntry(fd, ent);
            const text = data.toString('latin1'), notes = [], hit = [];
            let out = text, was = text;
            if (isGrass) out = out.replace(/(<GrassBrand\b[^>]*?\bFadeDistances\s*=\s*")([^"]*)(")/gi, (all, open, list, close) =>
            {
                const scaled = scaleList(list, grass);
                if (scaled === null || scaled === list) return all;
                notes.push(list + ' -> ' + scaled);
                return open + scaled + close;
            });
            if (out !== was) { hit.push('grass'); was = out; }
            if (isFill) { const r = fillEdit(out, fill); out = r.out; notes.push(...r.notes); }
            if (out !== was) { hit.push('fill'); was = out; }
            if (isStars) { const r = starsEdit(out, stars === null ? 1 : stars, photo); out = r.out; notes.push(...r.notes); }
            if (out !== was) { hit.push('stars'); was = out; }
            if (isWeather) { const r = weatherEdit(out, ent.name, wParts, ctx); out = r.out; notes.push(...r.notes); for (const k of r.kinds) weatherCount[k] = (weatherCount[k] || 0) + 1; }
            if (out !== was) hit.push('weather');
            if (!hit.length) continue;
            const group = hit[0], next = Buffer.from(out, 'latin1');
            const comp = ent.method === 8 ? zlib.deflateRawSync(next, { level: 9, memLevel: 9 }) : next;
            jobs.set(ent, { head, crc: zlib.crc32(next), usize: next.length, length: comp.length, comp, next, type: group, group, parts: hit, notes });
            for (const h of hit) changed[h] = (changed[h] || 0) + 1;
            grow += comp.length - ent.csize;
        }
        // files the weather adds (its own rain-like types: fireflies, pollen), stored, after the last entry. Where the
        // source has the file already (an original adopted with them in) it is rewritten in place when it differs
        const adds = [], byName = new Map(z.entries.map((e) => [e.name.toLowerCase(), e]));
        for (const f of weatherAdds(wParts))
        {
            const data = Buffer.from(f.text, 'latin1'), had = byName.get(f.name.toLowerCase());
            if (had)
            {
                const { head, data: cur } = readEntry(fd, had);
                if (cur.equals(data) || had.flags !== 0 || (had.method !== 0 && had.method !== 8)) continue;
                const comp = had.method === 8 ? zlib.deflateRawSync(data, { level: 9, memLevel: 9 }) : data;
                jobs.set(had, { head, crc: zlib.crc32(data), usize: data.length, length: comp.length, comp, next: data, type: 'weather', group: 'weather', parts: ['weather'], notes: ['written anew'] });
                grow += comp.length - had.csize;
                continue;
            }
            adds.push({ name: f.name, data, comp: data, method: 0, crc: zlib.crc32(data) });
            grow += 30 + f.name.length + data.length + 46 + f.name.length;
        }
        if (adds.length) changed.weather = (changed.weather || 0) + adds.length;
        const end = z.cdOff + grow + z.cd.length + z.eocd.length;
        const size = z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end;
        return { z, set: 'initial', parts: { grass, fill, stars, weather }, photo: [...photo].sort(), factor: grass, jobs, adds, changed, weatherCount, kept: {}, noRoom: [], grow, how: { rewritten: jobs.size, added: adds.length }, size };
    }
    finally { fs.closeSync(fd); }
}
const planGrass =(file, factor = GRASS_FACTOR) => planInitial(file, { grass: factor, fill: null, stars: null });
// the written initial.pak read back: the same entries in the same order, every changed one exactly as planned, the
// others with their records unchanged (every 50th read and CRC checked)
function verifyInitial(file, p)
{
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd), adds = p.adds || [], n = p.z.entries.length;
        if (z.entries.length !== n + adds.length) throw new Error('initial.pak: entry count changed');
        adds.forEach((a, k) =>
        {
            const ent = z.entries[n + k];
            if (ent.name !== a.name || !readEntry(fd, ent).data.equals(a.data)) throw new Error('added entry reads back wrong: ' + a.name);
        });
        let sampled = 0;
        z.entries.slice(0, n).forEach((ent, i) =>
        {
            const was = p.z.entries[i];
            if (ent.name !== was.name) throw new Error('initial.pak: entry order changed at ' + i);
            const job = p.jobs.get(was);
            if (job) { if (!readEntry(fd, ent).data.equals(job.next)) throw new Error('changed ' + job.group + ' entry reads back wrong: ' + ent.name); return; }
            if (ent.crc !== was.crc || ent.csize !== was.csize || ent.usize !== was.usize || ent.method !== was.method) throw new Error('entry record changed: ' + ent.name);
            if (i % 50 === 0) { readEntry(fd, ent); sampled++; }
        });
        return sampled;
    }
    finally { fs.closeSync(fd); }
}
const readGrassNote = () => (fs.existsSync(GRASS_NOTE) ? JSON.parse(fs.readFileSync(GRASS_NOTE, 'utf8')) : {});
// what initial.pak holds: { state: 'ours', grass, fill, stars } (this tool's build; a part left out is null), 'vanilla'
// (the original, or no original kept yet), 'changed' (another tool, a game update) or 'missing'. The note is the grass
// note of old; a note from before the fill light has no fill, one from before the stars no stars.
function initialState()
{
    const none = { grass: null, fill: null, stars: null, weather: null };
    if (!fs.existsSync(INITIAL)) return Object.assign({ state: 'missing' }, none);
    const cur = cdHash(INITIAL), note = readGrassNote();
    if (note.cdSha256 === cur) return { state: 'ours', grass: note.factor || null, fill: note.fill || null, stars: note.stars || null, weather: note.weather || null };
    if (!fs.existsSync(INITIAL_ORIG)) return Object.assign({ state: 'vanilla' }, none);
    return Object.assign({ state: (note.origCdSha256 || cdHash(INITIAL_ORIG)) === cur ? 'vanilla' : 'changed' }, none);
}
// 'grass x<factor>' / 'fill <factor>' when that part is in this tool's build, 'vanilla' when it is not (the original, or
// a build of the other part alone), 'changed' or 'missing'
function grassStatus() { const s = initialState(); return s.state !== 'ours' ? s.state : s.grass ? 'grass x' + s.grass : 'vanilla'; }
function fillStatus() { const s = initialState(); return s.state !== 'ours' ? s.state : s.fill ? 'fill ' + s.fill : 'vanilla'; }
function starsStatus() { const s = initialState(); return s.state !== 'ours' ? s.state : s.stars ? 'stars x' + s.stars : 'vanilla'; }
function weatherStatus() { const s = initialState(); return s.state !== 'ours' ? s.state : s.weather ? 'weather ' + s.weather : 'vanilla'; }

// initial.pak built from its original with these parts, or the original itself when neither is asked for. Refuses a
// file that is not the original or this tool's build (label names the caller in the message).
function buildInitial(parts, label)
{
    const now = initialState();
    if (now.state === 'missing') { console.log(label + ': no initial.pak, left alone'); return; }
    if (now.state === 'changed') { console.log(label + ': initial.pak is neither the original nor this tool\'s build (another tool or a game update): left alone'); return; }
    const tmp = INITIAL + '.tmp';
    // with photo night skies in boot.pak that carry the stars in their alpha, no part still means a build: their sky alpha
    if (!parts.grass && !parts.fill && !parts.stars && !parts.weather && !photoSkies(BOOT).size)
    {
        if (now.state !== 'ours') return;
        try { fs.copyFileSync(INITIAL_ORIG, tmp); fs.renameSync(tmp, INITIAL); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
        if (cdHash(INITIAL) !== cdHash(INITIAL_ORIG)) throw new Error('initial.pak does not match its backup after the copy');
        console.log(label + ': the original initial.pak is back');
        return;
    }
    if (!fs.existsSync(INITIAL_ORIG))
    {
        const keep = INITIAL_ORIG + '.tmp';
        fs.copyFileSync(INITIAL, keep);
        if (fileHash(keep) !== fileHash(INITIAL)) { fs.unlinkSync(keep); throw new Error('the initial.pak copy differs'); }
        fs.renameSync(keep, INITIAL_ORIG);
    }
    const p = planInitial(INITIAL_ORIG, parts);
    try
    {
        writePak(INITIAL_ORIG, tmp, p);
        const sampled = verifyInitial(tmp, p);
        fs.renameSync(tmp, INITIAL);
        const has = [];
        if (p.parts.grass) has.push((p.changed.grass || 0) + ' grass types fade ' + p.parts.grass + 'x further');
        if (p.parts.fill) has.push('the fill light at ' + Math.round(p.parts.fill * 100) + ' % in ' + (p.changed.fill || 0) + ' daytime states');
        if (p.parts.stars) has.push('the stars ' + p.parts.stars + 'x as bright in ' + (p.changed.stars || 0) + ' skies');
        if (p.parts.weather) has.push('the weather (' + p.parts.weather.split(',').map((k) => k + ' ' + (p.weatherCount[k] || 0)).join(', ') + ' files)');
        if (p.photo.length) has.push('the sky alpha that boot.pak\'s photo night skies need (' + p.photo.join(', ') + ')');
        console.log(label + ': initial.pak now has ' + has.join(' and ') + ' (' + p.size + ' bytes, read back ok, ' + sampled + ' untouched entries sampled)');
    }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    fs.writeFileSync(GRASS_NOTE, JSON.stringify({ origCdSha256: cdHash(INITIAL_ORIG), factor: p.parts.grass, fill: p.parts.fill, stars: p.parts.stars, weather: p.parts.weather, starsPhoto: p.photo, cdSha256: cdHash(INITIAL), size: p.size, date: stamp(), changed: p.jobs.size }, null, 2));
}
// the parts in initial.pak now (none when it is not this tool's build)
const partsNow = () => { const s = initialState(); return s.state === 'ours' ? { grass: s.grass, fill: s.fill, stars: s.stars, weather: s.weather } : { grass: null, fill: null, stars: null, weather: null }; };
function installGrass(factor = GRASS_FACTOR) { buildInitial(Object.assign(partsNow(), { grass: factor }), 'grass'); }
function restoreGrass()
{
    const s = initialState();
    if (s.state !== 'ours' || !s.grass) { if (s.state === 'changed') console.log('grass: initial.pak changed by something else: left alone'); return; }
    buildInitial({ grass: null, fill: s.fill, stars: s.stars, weather: s.weather }, 'grass');
}
function installFill(factor = FILL_FACTOR) { buildInitial(Object.assign(partsNow(), { fill: factor }), 'fill light'); }
function restoreFill()
{
    const s = initialState();
    if (s.state !== 'ours' || !s.fill) { if (s.state === 'changed') console.log('fill light: initial.pak changed by something else: left alone'); return; }
    buildInitial({ grass: s.grass, fill: null, stars: s.stars, weather: s.weather }, 'fill light');
}
function installStars(factor = STARS_FACTOR) { buildInitial(Object.assign(partsNow(), { stars: factor }), 'stars'); }
function restoreStars()
{
    const s = initialState();
    if (s.state !== 'ours' || !s.stars) { if (s.state === 'changed') console.log('stars: initial.pak changed by something else: left alone'); return; }
    buildInitial({ grass: s.grass, fill: s.fill, stars: null, weather: s.weather }, 'stars');
}
function installWeather(spec = WEATHER_PARTS) { buildInitial(Object.assign(partsNow(), { weather: weatherCanonical(spec) }), 'weather'); }
function restoreWeather()
{
    const s = initialState();
    if (s.state !== 'ours' || !s.weather) { if (s.state === 'changed') console.log('weather: initial.pak changed by something else: left alone'); return; }
    buildInitial({ grass: s.grass, fill: s.fill, stars: s.stars, weather: null }, 'weather');
}

// the name an original is kept under when a new one replaces it: <file>.<YYYY-MM-DD>, then -2, -3 on the same day
function keptName(file)
{
    const day = new Date().toISOString().slice(0, 10);
    let name = file + '.' + day;
    for (let k = 2; fs.existsSync(name); k++) name = file + '.' + day + '-' + k;
    return name;
}
// initial-adopt: the current initial.pak becomes the original when something else changed it (another mod, a game
// update), so builds go over that and restore puts it back. The old original is kept (keptName). Entries that still
// hold this tool's last build (grass, fill light: exactly what that build wrote) go back to the old original's bytes in
// the new original; whatever the other mod changed stays as it is. When some of ours was still in, initial.pak is this
// tool's build of those parts over the new original afterwards (built again when the other mod had changed an entry
// those parts touch), and the status says so; else initial.pak is the new original and the status reads vanilla.
function initialAdopt()
{
    const now = initialState();
    if (now.state === 'missing') { console.log('initial.pak: missing, nothing to adopt'); return; }
    if (now.state === 'ours') { console.log('initial.pak is this tool\'s own build: nothing to adopt'); return; }
    if (now.state === 'vanilla') { console.log('initial.pak is already the original'); return; }
    const note = readGrassNote(), had = { grass: note.factor || null, fill: note.fill || null, stars: note.stars || null, weather: note.weather || null };
    const hadPhoto = new Set(note.starsPhoto || []);   // the photo skies the last build's sky alpha was made for
    // what the last build wrote, by entry name, with the old original's bytes of each entry
    const ours = new Map();
    if (fs.existsSync(INITIAL_ORIG) && (had.grass || had.fill || had.stars || had.weather || hadPhoto.size))
    {
        const last = planInitial(INITIAL_ORIG, had, hadPhoto), fdo = fs.openSync(INITIAL_ORIG, 'r');
        try { for (const [ent, job] of last.jobs) ours.set(ent.name, { job, orig: readEntry(fdo, ent) }); } finally { fs.closeSync(fdo); }
    }
    const fd = fs.openSync(INITIAL, 'r'), jobs = new Map(), still = { grass: 0, fill: 0, stars: 0, weather: 0 };
    let z, grow = 0;
    try
    {
        z = readZip(fd);
        for (const ent of z.entries)
        {
            const o = ours.get(ent.name);
            if (!o || ent.flags !== 0 || ent.crc !== o.job.crc || ent.usize !== o.job.usize) continue;
            const cur = readEntry(fd, ent);
            if (!cur.data.equals(o.job.next) || cur.head.readUInt16LE(8) !== o.orig.head.readUInt16LE(8)) continue;
            // still ours: the old original's compressed bytes under the current header (same method)
            jobs.set(ent, { head: cur.head, crc: zlib.crc32(o.orig.data), usize: o.orig.data.length, length: o.orig.raw.length, comp: o.orig.raw, next: o.orig.data, type: o.job.group, group: o.job.group });
            for (const g of o.job.parts || [o.job.group]) still[g]++;
            grow += o.orig.raw.length - ent.csize;
        }
    }
    finally { fs.closeSync(fd); }
    // the new original, read back
    const tmp = INITIAL_ORIG + '.new';
    try
    {
        if (jobs.size)
        {
            const end = z.cdOff + grow + z.cd.length + z.eocd.length;
            const p = { z, jobs, size: z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end };
            writePak(INITIAL, tmp, p);
            verifyInitial(tmp, p);
        }
        else
        {
            fs.copyFileSync(INITIAL, tmp);
            if (fileHash(tmp) !== fileHash(INITIAL)) throw new Error('the initial.pak copy differs');
        }
    }
    catch (err) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw err; }
    const kept = fs.existsSync(INITIAL_ORIG) ? keptName(INITIAL_ORIG) : null;
    if (kept) fs.renameSync(INITIAL_ORIG, kept);
    fs.renameSync(tmp, INITIAL_ORIG);
    const keptNote = kept ? path.basename(kept) : null, keptSay = kept ? '; the old original is kept as ' + path.basename(kept) : '';
    const parts = { grass: still.grass ? had.grass : null, fill: still.fill ? had.fill : null, stars: still.stars ? had.stars : null, weather: still.weather ? had.weather : null };
    // the photo skies' alpha (the stars group without a stars part) counts as ours while boot.pak still asks for it
    const photoNow = photoSkies(BOOT), photoKept = still.stars > 0 && hadPhoto.size > 0 && photoNow.size > 0;
    if (!parts.grass && !parts.fill && !parts.stars && !parts.weather && !photoKept)
    {
        fs.writeFileSync(GRASS_NOTE, JSON.stringify({ origCdSha256: cdHash(INITIAL_ORIG), date: stamp(), adopted: keptNote }, null, 2));
        console.log('initial.pak: the current file is the new original (none of this tool\'s changes were in it' + keptSay + ')');
        if (photoNow.size) buildInitial(parts, 'initial.pak');   // boot.pak's photo skies need their sky alpha in any case
        return;
    }
    // some of ours was still in: initial.pak is our build of those parts over the new original when every entry the
    // build changes holds its output; else built again from the new original
    const want = planInitial(INITIAL_ORIG, parts), fdc = fs.openSync(INITIAL, 'r');
    let exact = true;
    try
    {
        const byName = new Map(readZip(fdc).entries.map((e) => [e.name, e]));
        for (const [ent, job] of want.jobs)
        {
            const c = byName.get(ent.name);
            if (!c || c.crc !== job.crc || c.usize !== job.usize || !readEntry(fdc, c).data.equals(job.next)) { exact = false; break; }
        }
    }
    finally { fs.closeSync(fdc); }
    fs.writeFileSync(GRASS_NOTE, JSON.stringify({ origCdSha256: cdHash(INITIAL_ORIG), factor: parts.grass, fill: parts.fill, stars: parts.stars, weather: parts.weather, starsPhoto: want.photo, cdSha256: cdHash(INITIAL), size: fs.statSync(INITIAL).size, date: stamp(), changed: want.jobs.size, adopted: keptNote }, null, 2));
    const which = [parts.grass ? 'grass x' + parts.grass : null, parts.fill ? 'fill light ' + parts.fill : null, parts.stars ? 'stars x' + parts.stars : null, parts.weather ? 'weather ' + parts.weather : null, photoKept && !parts.stars ? 'photo skies\' alpha' : null].filter(Boolean).join(' and ');
    console.log('initial.pak: the current file is the new original (this tool\'s ' + which + ' was still in it: left out of the original; the other changes kept' + keptSay + ')');
    if (!exact) buildInitial(parts, 'initial.pak');
}

function report(p, names)
{
    const sum = (o) => Object.entries(o).map(([g, v]) => g + ' ' + v).join(', ') || 'none';
    console.log(SETS[p.set] + ': changed ' + sum(p.changed) + ' (' + p.jobs.size + ' meshes)');
    console.log('left as they are (first switch at 40 m or later): ' + sum(p.kept));
    if (p.noRoom.length) console.log('skipped, no whitespace to keep the length: ' + p.noRoom.join(', '));
    console.log('size: ' + (p.grow >= 0 ? '+' : '') + p.grow + ' bytes compressed (' + Object.entries(p.how).map(([k, v]) => k + ' ' + v).join(', ') + '), result ' + p.size + ' bytes');
    const shown = {};
    for (const [ent, job] of p.jobs)
    {
        if (!names && (shown[job.group] = (shown[job.group] || 0) + 1) > 4) continue;
        console.log('  ' + job.group.padEnd(12) + ' ' + baseName(ent.name).padEnd(48) + ' ' + job.notes.join('; '));
    }
}

if (require.main === module)
{
    const args = process.argv.slice(2), cmd = args[0];
    const set = args.find((a) => SETS[a]) || 'nature';
    const source = () => (fs.existsSync(ORIG) ? ORIG : PAK);
    try
    {
        if (cmd === 'list') { const from = source(); console.log('from ' + from); report(plan(from, set), args.includes('names')); }
        else if (cmd === 'status') console.log(status());
        else if (cmd === 'build' && args[1] && !SETS[args[1]])
        {
            const p = plan(source(), set);
            writePak(source(), args[1], p);
            console.log('built ' + args[1] + ' (' + SETS[set] + '): ' + p.jobs.size + ' meshes changed, ' + p.size + ' bytes, read back ok (' + verify(args[1], p) + ' untouched entries sampled)');
        }
        else if (cmd === 'backup')
        {
            if (SETS[status()]) throw new Error('shared.pak is our build: restore it first');
            backup();
            console.log('backup made');
        }
        else if (cmd === 'install')
        {
            const st = status();
            if (st === 'changed') throw new Error('shared.pak is neither the backup nor our build (a game update or Steam verify?). If it is the game\'s own file, run: node lod_patch.js backup');
            if (!fs.existsSync(ORIG)) backup();
            console.log('planning ' + SETS[set] + ' from the original shared.pak');
            const p = plan(ORIG, set), tmp = PAK + '.tmp';
            console.log('writing ' + p.jobs.size + ' changed meshes into a new shared.pak (' + p.size + ' bytes)');
            try
            {
                writePak(ORIG, tmp, p);
                const sampled = verify(tmp, p);
                fs.renameSync(tmp, PAK);
                console.log('read back ok (' + sampled + ' untouched entries sampled)');
            }
            finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
            const note = readNote();
            fs.writeFileSync(NOTE, JSON.stringify({ origSha256: note.origSha256, origCdSha256: note.origCdSha256, origDate: note.origDate, set, cdSha256: cdHash(PAK), size: p.size, date: stamp(), floors: FLOORS, changed: p.changed }, null, 2));
            // the grass goes with the all set only (unless the caller handles it: LOD_GRASS=leave)
            if (GRASS_WITH_SETS) { if (set === 'all') installGrass(); else restoreGrass(); }
            console.log('scenery detail: ' + SETS[set]);
        }
        else if (cmd === 'grass-status') console.log(grassStatus());
        else if (cmd === 'grass-install') installGrass(args[1] ? Number(args[1]) : GRASS_FACTOR);
        else if (cmd === 'grass-restore') restoreGrass();
        else if (cmd === 'grass-build' && args[1])
        {
            const from = fs.existsSync(INITIAL_ORIG) ? INITIAL_ORIG : INITIAL, factor = args[2] ? Number(args[2]) : GRASS_FACTOR;
            const p = planGrass(from, factor);
            writePak(from, args[1], p);
            console.log('built ' + args[1] + ' from ' + from + ': ' + p.jobs.size + ' grass types x' + factor + ', ' + p.size + ' bytes, read back ok (' + verifyInitial(args[1], p) + ' untouched entries sampled)');
            let shown = 0;
            for (const [ent, job] of p.jobs) if (shown++ < 6) console.log('  ' + baseName(ent.name).padEnd(40) + ' ' + job.notes.join('; '));
        }
        else if (cmd === 'fill-status') console.log(fillStatus());
        else if (cmd === 'fill-install') installFill(args[1] ? Number(args[1]) : FILL_FACTOR);
        else if (cmd === 'fill-restore') restoreFill();
        else if (cmd === 'stars-status') console.log(starsStatus());
        else if (cmd === 'stars-install') installStars(args[1] ? Number(args[1]) : STARS_FACTOR);
        else if (cmd === 'stars-restore') restoreStars();
        else if (cmd === 'weather-status') console.log(weatherStatus());
        else if (cmd === 'weather-install') installWeather(args[1] || WEATHER_PARTS);
        else if (cmd === 'weather-restore') restoreWeather();
        else if (cmd === 'initial-status') console.log(JSON.stringify(Object.assign(initialState(), { photoSkies: [...photoSkies(BOOT)].sort() })));
        else if (cmd === 'initial-refresh')
        {
            // the same parts built again: after sky_stars.js changed its rules, or after the photo night skies in boot.pak
            // were replaced or put back (their sky alpha follows boot.pak)
            const s = initialState();
            if (s.state === 'ours' || (s.state === 'vanilla' && photoSkies(BOOT).size)) buildInitial(partsNow(), 'initial.pak');
            else console.log(s.state === 'vanilla' ? 'initial.pak is the original and boot.pak asks for nothing: left alone' : 'initial.pak ' + s.state + ': left alone');
        }
        else if (cmd === 'initial-adopt') initialAdopt();
        else if (cmd === 'initial-restore')
        {
            const s = initialState();
            if (s.state === 'ours') buildInitial({ grass: null, fill: null, stars: null, weather: null }, 'initial.pak');
            else console.log(s.state === 'changed' ? 'initial.pak changed by something else: left alone' : 'initial.pak is already the original');
        }
        else if (cmd === 'initial-build' && args[1])
        {
            const from = fs.existsSync(INITIAL_ORIG) ? INITIAL_ORIG : INITIAL, arg = (name) => { const a = args.find((v) => v.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
            const part = (name) => (arg(name) === null ? null : Number(arg(name)));
            const p = planInitial(from, { grass: part('grass'), fill: part('fill'), stars: part('stars'), weather: arg('weather') });
            writePak(from, args[1], p);
            console.log('built ' + args[1] + ' from ' + from + ': grass ' + (p.parts.grass || 'as is') + ', fill light ' + (p.parts.fill || 'as is') + ', stars ' + (p.parts.stars || 'as is') + ', weather ' + (p.parts.weather || 'as is') + ', ' + p.jobs.size + ' entries changed ' + JSON.stringify(p.changed) + (p.parts.weather ? ' ' + JSON.stringify(p.weatherCount) : '') + ', ' + p.size + ' bytes, read back ok (' + verifyInitial(args[1], p) + ' untouched entries sampled)');
            let shown = 0;
            for (const [ent, job] of p.jobs) if (shown++ < 4 || /day__1_ru_17/.test(ent.name)) console.log('  ' + baseName(ent.name).padEnd(40) + ' ' + job.notes.join('; '));
        }
        else if (cmd === 'restore')
        {
            if (GRASS_WITH_SETS) restoreGrass();
            if (!fs.existsSync(ORIG)) { console.log('no backup: shared.pak was never changed by this tool'); return; }
            if (status() === 'vanilla') { console.log('shared.pak is already the original'); return; }
            const tmp = PAK + '.tmp';
            try { fs.copyFileSync(ORIG, tmp); fs.renameSync(tmp, PAK); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
            if (cdHash(PAK) !== readNote().origCdSha256) throw new Error('shared.pak does not match the backup after the copy');
            console.log('scenery detail: vanilla');
        }
        else console.log('usage: node lod_patch.js list [nature|all] [names] | status | install [nature|all] | restore | backup | build <file> [nature|all] | grass-status | grass-build <file> [factor] | grass-install [factor] | grass-restore | fill-status | fill-install [factor] | fill-restore | stars-status | stars-install [factor] | stars-restore | weather-status | weather-install [parts] | weather-restore | initial-status | initial-restore | initial-refresh | initial-adopt | initial-build <file> [grass=<f>] [fill=<f>] [stars=<f>] [weather=<parts>]');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
module.exports = { classify, raise, patchMesh, meshType, plan, readZip, readEntry, writePak, cdHash, fileHash, keptName, FLOORS, SETS };
