// pak.load_list, the first entry of every pak: everything the pak loads, in order, and what each thing waits for. The
// game knows a class file (a truck, a daytime state, a sky) only when this list names it, so a file added to a pak
// needs an entry here. Seen in the game on 2026-10-13: daytime states added to initial.pak and named in its list were
// loaded by a level that asks for them; without the entries the same level crashed.
// The layout follows the reading in SnowRunnerTools by chase-000 (https://github.com/chase-000/SnowRunnerTools, MIT
// licence). No code of it is here.
//   head     i32 1, u8 1, i32 count, i32 3, u8 1
//   types    count bytes, one per entry: 5 the start (first), 1 a stage, 2 an asset, 6 the end (last)
//   u8 1
//   waits    per entry: i32 n, u8 1, n x i32. The numbers name the entries it waits for, counted from 0, ascending.
//            The start waits for nothing. An asset waits for one entry: the stage before its run (a class file
//            always) or an asset of the run (a texture's faces for its header). A stage after assets waits for those
//            of them nothing else waits for, a stage after a stage for that stage, the end likewise
//   u8 1
//   strings  per entry: i32 s, i32 2, s + 2 bytes of 01, then s strings (u32 length and text). The start and the end
//            have none, a stage one ("CLASSES load"), an asset three ("<media>\classes\daytimes\x.xml", "cls_loader",
//            "initial.pak") or four (a texture of a level or a garage: a JSON text last, naming its base)
// Only initial.pak holds class files. They stand together, in the byte order of their names.
// Library: parse(buffer) -> { entries: [{ type, deps, strings }] }; serialise(list) -> buffer;
//          check(list) -> the rules it breaks ([] when sound); runs(list) -> the runs of assets between stages;
//          addClassFile(list, name[, pak]) -> the entry number it took (the list is changed in place)
// usage: node load_list.js check <pak.load_list>                 reads it, writes it back in memory, checks the rules
//        node load_list.js add <in> <out> <class file> [...]     the list with those class files added
const fs = require('fs');

const START = 5, STAGE = 1, ASSET = 2, END = 6;
const CLASS = 'cls_loader';

function parse(b)
{
    let o = 0;
    const need = (n) => { if (o + n > b.length) throw new Error('the load list ends inside an entry (at ' + o + ')'); };
    const differs = (what, at) => new Error('the load list differs from the known form (' + what + ', at ' + at + ')');
    const u32 = () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; };
    const one = (what) => { need(1); if (b[o++] !== 1) throw differs(what, o - 1); };
    const is = (v, what) => { if (u32() !== v) throw differs(what, o - 4); };
    is(1, 'the head'); one('the head');
    const count = u32();
    is(3, 'the head'); one('the head');
    need(count);
    const entries = [...b.subarray(o, o + count)].map((type) => ({ type, deps: [], strings: [] }));
    o += count;
    one('before the waits');
    for (const e of entries)
    {
        const n = u32();
        one('a wait list'); need(4 * n);
        for (let k = 0; k < n; k++) e.deps.push(u32());
    }
    one('before the strings');
    for (const e of entries)
    {
        const s = u32();
        is(2, 'the strings of an entry'); need(s + 2);
        for (let k = 0; k < s + 2; k++) one('the strings of an entry');
        for (let k = 0; k < s; k++) { const l = u32(); need(l); e.strings.push(b.toString('latin1', o, o + l)); o += l; }
    }
    if (o !== b.length) throw new Error('the load list goes on after its last entry (' + (b.length - o) + ' bytes)');
    return { entries };
}

function serialise(list)
{
    const e = list.entries;
    let size = 16 + e.length;   // the head, the types and the two single bytes
    for (const x of e) size += 15 + 4 * x.deps.length + x.strings.reduce((a, s) => a + 5 + s.length, 0);
    const b = Buffer.alloc(size);
    let o = 0;
    const u8 = (v) => { b[o++] = v; }, u32 = (v) => { b.writeUInt32LE(v, o); o += 4; };
    u32(1); u8(1); u32(e.length); u32(3); u8(1);
    for (const x of e) u8(x.type);
    u8(1);
    for (const x of e) { u32(x.deps.length); u8(1); for (const d of x.deps) u32(d); }
    u8(1);
    for (const x of e)
    {
        u32(x.strings.length); u32(2);
        b.fill(1, o, o + x.strings.length + 2); o += x.strings.length + 2;
        for (const s of x.strings) { u32(s.length); o += b.write(s, o, 'latin1'); }
    }
    return b;
}

// the runs of assets between two stages: [{ loaders, from, to }] (entry numbers, both ends in)
function runs(list)
{
    const out = [];
    list.entries.forEach((x, i) =>
    {
        if (x.type !== ASSET) return;
        const last = out[out.length - 1];
        if (last && last.to === i - 1) { last.to = i; last.loaders.add(x.strings[1]); } else out.push({ loaders: new Set([x.strings[1]]), from: i, to: i });
    });
    return out;
}
const classRuns = (list) => runs(list).filter((g) => g.loaders.size === 1 && g.loaders.has(CLASS));

// what the game's own lists keep to; a list that breaks one of these is not one to hand the game
function check(list)
{
    const bad = [], e = list.entries, last = e.length - 1;
    if (last < 1 || e[0].type !== START || e[last].type !== END) return ['the list does not begin with its start and end with its end'];
    const names = new Set();
    let since = 0;   // the last entry before this one that is no asset
    const waited = new Set();   // the assets after it that another asset waits for
    e.forEach((x, i) =>
    {
        const what = 'entry ' + i + (x.strings.length ? ' (' + x.strings[0] + ')' : '');
        const inner = i > 0 && i < last, asset = x.type === ASSET;
        if (inner && !asset && x.type !== STAGE) { bad.push(what + ' has type ' + x.type); return; }
        if (!(asset ? [3, 4] : [inner ? 1 : 0]).includes(x.strings.length)) bad.push(what + ' has ' + x.strings.length + ' strings');
        if (x.deps.some((d, k) => d >= i || (k && d <= x.deps[k - 1]))) bad.push(what + ' waits for an entry after it, or its numbers are out of order');
        if (i === 0) { if (x.deps.length) bad.push('the start waits for something'); return; }
        if (asset)
        {
            if (x.deps.length !== 1 || x.deps[0] < since) bad.push(what + ' waits for something other than the stage before its run or an asset of the run');
            else if (x.deps[0] > since) waited.add(x.deps[0]);
            const key = x.strings[0] + '|' + x.strings[1];   // a texture stands there twice, once per loader
            if (names.has(key)) bad.push(x.strings[0] + ' is named twice');
            names.add(key);
            return;
        }
        // a stage or the end: after assets it waits for those nothing else waits for, otherwise for the entry before it
        const want = [];
        for (let k = since + 1; k < i; k++) if (!waited.has(k)) want.push(k);
        if (!want.length) want.push(i - 1);
        if (x.deps.length !== want.length || x.deps.some((d, k) => d !== want[k])) bad.push(what + (i - 1 > since ? ' does not wait for exactly the assets before it that nothing else waits for' : ' does not wait for the entry before it'));
        since = i; waited.clear();
    });
    for (const g of classRuns(list))
    {
        for (let i = g.from; i <= g.to; i++)
        {
            if (e[i].deps[0] !== g.from - 1) bad.push(e[i].strings[0] + ' does not wait for the stage before the class files');
            if (i > g.from && !(e[i - 1].strings[0] < e[i].strings[0])) bad.push(e[i].strings[0] + ' is out of order');
        }
    }
    return bad.slice(0, 20);
}

// a class file added where its name belongs among the class files; returns its entry number
function addClassFile(list, name, pak = 'initial.pak')
{
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error('a load list name is plain text: ' + name);
    const e = list.entries;
    if (e.some((x) => x.strings[0] === name)) throw new Error(name + ' is in the load list already');
    const found = classRuns(list);
    if (found.length !== 1) throw new Error(found.length ? 'the load list has several runs of class files' : 'the load list has no run of class files');
    const g = found[0];
    let q = g.from;
    while (q <= g.to && e[q].strings[0] < name) q++;
    // the entries from q on move up by one, and with them the numbers that name them
    for (const x of e) x.deps = x.deps.map((d) => (d >= q ? d + 1 : d));
    const stage = e[g.to + 1].deps;   // the stage after the run waits for the new file as well
    const at = stage.findIndex((d) => d > q);
    stage.splice(at < 0 ? stage.length : at, 0, q);
    e.splice(q, 0, { type: ASSET, deps: [g.from - 1], strings: [name, CLASS, pak] });   // like every class file, it waits for the stage before the run
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
        const assets = {};
        for (const x of list.entries) if (x.type === ASSET) assets[x.strings[1]] = (assets[x.strings[1]] || 0) + 1;
        console.log(JSON.stringify({ entries: list.entries.length, stages: list.entries.filter((x) => x.type === STAGE).length, assets, sound: !bad.length, bad }));
        process.exit(bad.length ? 1 : 0);
    }
    else if (cmd === 'add' && file && out && names.length)
    {
        const list = parse(fs.readFileSync(file));
        const took = names.map((n) => n + ' at ' + addClassFile(list, n));
        const bad = check(list);
        if (bad.length) { console.error('the list would break its own rules: ' + bad.join('; ')); process.exit(1); }
        fs.writeFileSync(out, serialise(list));
        console.log(JSON.stringify({ entries: list.entries.length, added: took }));
    }
    else { console.error('usage: node load_list.js check <pak.load_list> | add <in> <out> <class file> [...]'); process.exit(2); }
}
