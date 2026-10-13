// pak.load_list, the first entry of initial.pak, boot.pak and gfx.pak: everything the pak loads and what each thing waits
// for. The game knows a class file (a truck, a daytime state, a sky) only when this list names it, so a file added to
// the pak needs a line here. Read from the game's own lists (2026-10-13); three of them come back byte for byte.
//   head     u32 1, u8 1, u32 N, u32 3
//   types    N bytes: 1 and 5 for two entries without a name, then one per record: 1 a stage, 2 a file
//   11 bytes 06 01 00 00 00 00 01 01 00 00 00, the same in every list
//   waits    N - 1 lists, one per record and one for the list's end: u32 count, u8 listed, and when listed count x u32.
//            A number names the record it waits for, counted from 1. A file waits for the stage before its run of
//            files (a class file for "TEMPLATES load"), the stage after a run for every file of the run, a stage
//            after a stage for that stage, the end for the last record. The first record alone is not listed (count 1)
//   11 bytes 01 00 00 00 00 02 00 00 00 01 01, the same in every list
//   records  N - 2 times: u32 n, u32 m, n + m bytes of 01, the name, and for a file its loader and its pak
//            (a stage: n 1, m 2; a file: n 3, m 2). Names are u32 length and text: "<media>\classes\daytimes\x.xml",
//            "cls_loader", "initial.pak"; "CLASSES load" for a stage
//   end      u32 0, u32 2, 01 01
// The class files stand together, in the byte order of their names. check holds initial.pak's rules: boot.pak's and
// gfx.pak's lists read and write back the same, but their textures wait in another pattern, which check reports.
// The level paks' lists hold records this does not read (parse throws on them).
// Not proven in the game yet: whether a class file added here and to the pak is then known to the game.
// Library: parse(buffer) -> list; serialise(list) -> buffer; check(list) -> the rules it breaks ([] when sound);
//          addClassFile(list, name[, pak]) -> the record index it took (the list is changed in place)
// usage: node load_list.js check <pak.load_list>                 reads it, writes it back in memory, checks the rules
//        node load_list.js add <in> <out> <class file> [...]     the list with those class files added
const fs = require('fs');

const HEAD = Buffer.from([1, 0, 0, 0, 1]), THREE = Buffer.from([3, 0, 0, 0]);
const FIXED_1 = Buffer.from('0601000000000101000000', 'hex'), FIXED_2 = Buffer.from('0100000000020000000101', 'hex');
const STAGE = 1, FILE = 2;
const GROUP = { [STAGE]: { n: 1, m: 2 }, [FILE]: { n: 3, m: 2 } };
const CLASS = 'cls_loader';

function parse(b)
{
    if (b.length < 13 || !b.subarray(0, 5).equals(HEAD) || !b.subarray(9, 13).equals(THREE)) throw new Error('not a load list this tool knows (the head differs)');
    const N = b.readUInt32LE(5);
    if (N < 3 || 13 + N + 11 > b.length) throw new Error('the load list is shorter than its count says');
    const types = [...b.subarray(13, 13 + N)];
    let o = 13 + N;
    const need = (n) => { if (o + n > b.length) throw new Error('the load list ends inside an entry (at ' + o + ')'); };
    const fixed = (f, what) => { need(f.length); if (!b.subarray(o, o + f.length).equals(f)) throw new Error('the load list differs from the known form (' + what + ', at ' + o + ')'); o += f.length; };
    const u32 = () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; };
    const str = () => { const l = u32(); need(l); const s = b.toString('latin1', o, o + l); o += l; return s; };
    const group = () => { const n = u32(), m = u32(); need(n + m); const f = [...b.subarray(o, o + n + m)]; o += n + m; return { n, m, f }; };
    fixed(FIXED_1, 'before the waits');
    const waits = [];
    for (let i = 0; i < N - 1; i++)
    {
        const count = u32(); need(1);
        const listed = b[o++];
        if (listed > 1) throw new Error('the load list differs from the known form (a wait list, at ' + (o - 1) + ')');
        if (!listed) { waits.push({ unlisted: count }); continue; }
        need(4 * count);
        const l = []; for (let k = 0; k < count; k++) l.push(u32());
        waits.push(l);
    }
    fixed(FIXED_2, 'before the records');
    const records = [];
    for (let i = 0; i < N - 2; i++)
    {
        const g = group(), name = str(), file = types[i + 2] === FILE;
        records.push({ group: g, name, loader: file ? str() : null, pak: file ? str() : null });
    }
    const end = group();
    if (o !== b.length) throw new Error('the load list goes on after its last entry (' + (b.length - o) + ' bytes)');
    return { types, waits, records, end };
}

function serialise(list)
{
    const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); return x; };
    const str = (s) => Buffer.concat([u32(s.length), Buffer.from(s, 'latin1')]);
    const group = (g) => Buffer.concat([u32(g.n), u32(g.m), Buffer.from(g.f)]);
    const out = [HEAD, u32(list.types.length), THREE, Buffer.from(list.types), FIXED_1];
    for (const w of list.waits) out.push(Array.isArray(w) ? Buffer.concat([u32(w.length), Buffer.from([1]), ...w.map(u32)]) : Buffer.concat([u32(w.unlisted), Buffer.from([0])]));
    out.push(FIXED_2);
    for (const r of list.records)
    {
        out.push(group(r.group), str(r.name));
        if (r.loader !== null) out.push(str(r.loader), str(r.pak));
    }
    out.push(group(list.end));
    return Buffer.concat(out);
}

// the runs of files between two stages: [{ loaders, from, to }] (record indices, both ends in)
function runs(list)
{
    const out = [];
    list.records.forEach((r, i) =>
    {
        if (r.loader === null) return;
        const last = out[out.length - 1];
        if (last && last.to === i - 1) { last.to = i; last.loaders.add(r.loader); } else out.push({ loaders: new Set([r.loader]), from: i, to: i });
    });
    return out;
}
const classRun = (list) => runs(list).find((g) => g.loaders.size === 1 && g.loaders.has(CLASS));

// what the game's own lists keep to; a list that breaks one of these is not one to hand the game
function check(list)
{
    const bad = [], K = list.records.length;
    if (list.types.length !== K + 2 || list.waits.length !== K + 1) return ['the counts of types, waits and records do not fit'];
    if (list.types[0] !== 1 || list.types[1] !== 5) bad.push('the two leading types are not 1 and 5');
    if (Array.isArray(list.waits[0]) || list.waits[0].unlisted !== 1) bad.push('the first record lists what it waits for');
    const end = list.waits[K];
    if (!Array.isArray(end) || end.length !== 1 || end[0] !== K) bad.push('the end does not wait for the last record');
    if (list.end.n !== 0 || list.end.m !== 2 || list.end.f.join('') !== '11') bad.push('the closing entry is not 0, 2, 01 01');
    const names = new Set();
    list.records.forEach((r, i) =>
    {
        const t = list.types[i + 2], g = GROUP[t];
        if (!g) { bad.push('record ' + i + ' has type ' + t); return; }
        if (r.group.n !== g.n || r.group.m !== g.m || r.group.f.some((v) => v !== 1)) bad.push('record ' + i + ' (' + r.name + ') has another shape than its type');
        if ((t === FILE) !== (r.loader !== null)) bad.push('record ' + i + ' (' + r.name + ') has a loader and is no file, or the other way round');
        const w = list.waits[i];
        if (i && (!Array.isArray(w) || !w.length || w.some((v) => v < 1 || v > i))) bad.push('record ' + i + ' (' + r.name + ') waits for nothing or for something after it');
        const key = r.name + '|' + r.loader;   // a texture stands there twice, once per loader
        if (names.has(key)) bad.push(r.name + ' is named twice');
        names.add(key);
    });
    for (const g of runs(list))
    {
        // every file waits for the record before the run; the record after it waits for all of them, in order
        for (let i = g.from; i <= g.to; i++)
        {
            const w = list.waits[i];
            if (g.from && (!Array.isArray(w) || w.length !== 1 || w[0] !== g.from)) bad.push(list.records[i].name + ' does not wait for the stage before its run');
        }
        const after = list.waits[g.to + 1];
        if (!(Array.isArray(after) && after.length === g.to - g.from + 1 && after.every((v, k) => v === g.from + 1 + k))) bad.push('the entry after the files ending with ' + list.records[g.to].name + ' does not wait for exactly them');
    }
    const c = classRun(list);
    if (c) for (let i = c.from + 1; i <= c.to; i++) if (!(list.records[i - 1].name < list.records[i].name)) bad.push(list.records[i].name + ' is out of order');
    return bad.slice(0, 20);
}

// a class file added where its name belongs among the class files; returns its record index
function addClassFile(list, name, pak = 'initial.pak')
{
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('a load list name is plain text: ' + name);
    if (list.records.some((r) => r.name === name)) throw new Error(name + ' is in the load list already');
    const g = classRun(list);
    if (!g) throw new Error('the load list has no run of class files');
    let q = g.from;
    while (q <= g.to && list.records[q].name < name) q++;
    // the records from q on move up by one, and with them the numbers that name them
    list.waits = list.waits.map((w) => (Array.isArray(w) ? w.map((v) => (v >= q + 1 ? v + 1 : v)) : w));
    const stage = list.waits[g.to + 1];   // the stage after the run waits for the new file as well
    const at = stage.findIndex((v) => v > q + 1);
    stage.splice(at < 0 ? stage.length : at, 0, q + 1);
    list.waits.splice(q, 0, [g.from]);    // like every class file, it waits for the record before the run
    list.records.splice(q, 0, { group: { n: GROUP[FILE].n, m: GROUP[FILE].m, f: [1, 1, 1, 1, 1] }, name, loader: CLASS, pak });
    list.types.splice(q + 2, 0, FILE);
    return q;
}

module.exports = { parse, serialise, check, runs, addClassFile };

if (require.main === module)
{
    const [cmd, file, out, ...names] = process.argv.slice(2);
    if (cmd === 'check' && file)
    {
        const b = fs.readFileSync(file), list = parse(b), bad = check(list);
        if (!serialise(list).equals(b)) bad.unshift('written back it is not the same file');
        console.log(JSON.stringify({ entries: list.types.length, records: list.records.length, runs: runs(list).map((g) => [...g.loaders].join('+') + ' ' + (g.to - g.from + 1)), sound: !bad.length, bad }));
        process.exit(bad.length ? 1 : 0);
    }
    else if (cmd === 'add' && file && out && names.length)
    {
        const list = parse(fs.readFileSync(file));
        const took = names.map((n) => n + ' at ' + addClassFile(list, n));
        const bad = check(list);
        if (bad.length) { console.error('the list would break its own rules: ' + bad.join('; ')); process.exit(1); }
        fs.writeFileSync(out, serialise(list));
        console.log(JSON.stringify({ entries: list.types.length, added: took }));
    }
    else { console.error('usage: node load_list.js check <pak.load_list> | add <in> <out> <class file> [...]'); process.exit(2); }
}
