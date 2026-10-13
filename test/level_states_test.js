// Map days (engine\tools\level_states.js) on stand-in level paks: a small zip each, with a first entry and a stored
// [scene]\data_for_ssl.bin whose head names its states the way the game's does. Run: node test\level_states_test.js
// (prints one line per check and "all passed"; the exit code is 1 when a check fails).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngen-levels-'));
process.env.SR_PAKS_DIR = dir;
// days of a region's own go into initial.pak: the stand-in for it, its kept original and the paks it asks about all
// sit in the same folder
const initialFile = path.join(dir, 'initial.pak');
Object.assign(process.env, { SR_INITIAL_PAK: initialFile, SR_STATE_DIR: path.join(dir, 'state'), SR_BOOT_PAK: path.join(dir, 'boot.pak'), SR_SHARED_PAK: path.join(dir, 'shared.pak') });
const toolsDir = process.argv[2] || path.join(__dirname, '..', 'engine', 'tools');   // an engine's tools folder, or the working tree's
const tool = require(path.join(toolsDir, 'level_states.js')), lod = require(path.join(toolsDir, 'lod_patch.js')), loadList = require(path.join(toolsDir, 'load_list.js'));

// a level file's head: a version word, a flag word, the length, a check value, then the names
function levelData(level, region, sky)
{
    const str = (s) => { const b = Buffer.alloc(2 + s.length + 1); b.writeUInt16LE(s.length + 1, 0); b.write(s, 2, 'latin1'); return b; };
    const day = (n) => 'day__' + n + '_' + region + ';day__' + n + 'a_' + region;
    const names = [level + '_NAME', level + '_DESC', 'night_' + region, 'night_to_day_' + region, day(1), day(2), day(3), 'day_to_night_' + region, 'sky_' + sky].map(str);
    const head = Buffer.alloc(16), body = Buffer.alloc(5000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 255;   // the rest of the file: must come through untouched
    const data = Buffer.concat([head, ...names, body]);
    data.writeUInt32LE(0x013415be, 0); data.writeUInt32LE(data.length, 8); data.writeUInt32LE(0xeb707680, 12);
    return data;
}
// a zip of stored entries: [{ name, data }]
function zip(entries)
{
    const parts = [], cd = [];
    let at = 0;
    for (const e of entries)
    {
        const name = Buffer.from(e.name, 'latin1'), crc = zlib.crc32(e.data) >>> 0, local = Buffer.alloc(30), rec = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
        rec.writeUInt32LE(0x02014b50, 0); rec.writeUInt16LE(20, 4); rec.writeUInt16LE(20, 6); rec.writeUInt32LE(crc, 16); rec.writeUInt32LE(e.data.length, 20); rec.writeUInt32LE(e.data.length, 24); rec.writeUInt16LE(name.length, 28); rec.writeUInt32LE(at, 42);
        parts.push(local, name, e.data); cd.push(rec, name);
        at += 30 + name.length + e.data.length;
    }
    const dirBytes = Buffer.concat(cd), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dirBytes.length, 12); end.writeUInt32LE(at, 16);
    return Buffer.concat([...parts, dirBytes, end]);
}
const pak = (level, region, sky) => zip([{ name: '[scene]\\data.stg', data: Buffer.from('stand-in scene') }, { name: '[scene]\\data_for_ssl.bin', data: levelData(level, region, sky || region) }]);
const file = (level) => path.join(dir, level + '.pak');
// the names a level pak holds, and whether both of the entry's CRC fields are the data's CRC
function read(level)
{
    const buf = fs.readFileSync(file(level)), at = buf.indexOf(Buffer.from('data_for_ssl.bin')) + 16, local = at - 16 - 8 - 30;
    const size = buf.readUInt32LE(local + 18), data = buf.subarray(at, at + size), crc = zlib.crc32(data) >>> 0;
    const record = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    const text = data.toString('latin1', 0, 400);
    return { names: text.slice(text.indexOf('night_'), text.indexOf('sky_') + 9).replace(/[^\x20-\x7e]+/g, ' '), crcOk: buf.readUInt32LE(local + 14) === crc && buf.readUInt32LE(record + 16) === crc };
}

let failed = 0;
function check(what, got, want)
{
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok ? '' : ': ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)));
}
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { fn(); } finally { console.log = log; } };

try
{
    check('no level pak: every row missing', tool.status(), { maine: 'missing', bc: 'missing', austria: 'missing' });
    const stock = { level_us_06_01: pak('level_us_06_01', 'us_04'), level_us_06_02: pak('level_us_06_02', 'us_02'), level_us_14_01: pak('level_us_14_01', 'ru_08') };
    for (const level of Object.keys(stock)) fs.writeFileSync(file(level), stock[level]);
    check('the game\'s names: vanilla, British Columbia missing', tool.status(), { maine: 'vanilla', bc: 'missing', austria: 'vanilla' });

    quiet(() => tool.install(tool.rowSpec('maine')));
    check('install maine: its state, the others untouched', tool.status(), { maine: 'ours', bc: 'missing', austria: 'vanilla' });
    check('Maine map 1 names Michigan\'s states and sky', read('level_us_06_01').names, 'night_us_01 night_to_day_us_01 day__1_us_01;day__1a_us_01 day__2_us_01;day__2a_us_01 day__3_us_01;day__3a_us_01 day_to_night_us_01 sky_us_01');
    check('Maine map 2 too', /^night_us_01 .* sky_us_01$/.test(read('level_us_06_02').names) && !/us_02/.test(read('level_us_06_02').names), true);
    check('the zip CRC follows in both places', [read('level_us_06_01').crcOk, read('level_us_06_02').crcOk], [true, true]);
    const changed = fs.readFileSync(file('level_us_06_01')), same = changed.length === stock.level_us_06_01.length;
    let differ = 0;
    for (let i = 0; same && i < changed.length; i++) if (changed[i] !== stock.level_us_06_01[i]) differ++;
    check('only the ten region codes and the two CRCs differ', same && differ > 0 && differ <= 10 * 2 + 8, true);
    check('Austria\'s file is byte for byte the stock', fs.readFileSync(file('level_us_14_01')).equals(stock.level_us_14_01), true);

    quiet(() => tool.install(tool.rowSpec('austria')));
    check('install austria alone: Maine goes back, Austria comes in', tool.status(), { maine: 'vanilla', bc: 'missing', austria: 'ours' });
    check('Maine map 1 is byte for byte the stock again', fs.readFileSync(file('level_us_06_01')).equals(stock.level_us_06_01), true);
    check('Austria map 1 names North Carolina\'s', /^night_us_12 .* sky_us_12$/.test(read('level_us_14_01').names), true);

    quiet(() => tool.install(tool.rowSpec('maine,austria')));
    fs.writeFileSync(file('level_us_06_02'), stock.level_us_06_02);   // one of Maine's two written back: half a row
    check('half a row reads as part', tool.status().maine, 'part');
    quiet(() => tool.install([]));
    check('restore: every file byte for byte the stock', Object.keys(stock).map((l) => fs.readFileSync(file(l)).equals(stock[l])), [true, true, true]);

    fs.writeFileSync(file('level_us_06_01'), pak('level_us_06_01', 'us_03'));   // another mod's names
    const foreign = fs.readFileSync(file('level_us_06_01'));
    check('another mod\'s names: changed', tool.status().maine, 'changed');
    quiet(() => tool.install(tool.rowSpec('maine')));
    check('a changed file is left as it is, the row\'s other file is written', [fs.readFileSync(file('level_us_06_01')).equals(foreign), tool.levelState(file('level_us_06_02'), 'us_02', 'us_01')], [true, 'ours']);
    fs.writeFileSync(file('level_us_06_01'), pak('level_us_06_01', 'us_04', 'us_02'));   // states of one region, the sky of another
    check('mixed names: changed', tool.levelState(file('level_us_06_01'), 'us_04', 'us_01'), 'changed');
    let threw = '';
    try { tool.rowSpec('maine,quebec'); } catch (err) { threw = err.message; }
    check('an unknown row is refused', /quebec/.test(threw), true);

    // days of Maine's own: a stand-in initial.pak with a load list, Michigan's nine states and its sky
    for (const level of Object.keys(stock)) fs.writeFileSync(file(level), stock[level]);
    const states = ['night', 'night_to_day', 'day__1', 'day__1a', 'day__2', 'day__2a', 'day__3', 'day__3a', 'day_to_night'];
    const classes = states.map((s) => ({ name: '[media]\\classes\\daytimes\\' + s + '_us_01.xml', data: Buffer.from('<DayTimeState ColorLUT="lut/day_us_01__vol_uncmp.tga" Tag="' + s + '" />') }))
        .concat([{ name: '[media]\\classes\\daytimes\\night_us_04.xml', data: Buffer.from('<DayTimeState />') },
            { name: '[media]\\classes\\skies\\sky_us_01.xml', data: Buffer.from('<CombineSky><Cloud DiffuseMap="env/cloud_01_us_01__s_d_a.tga">' + states.map((s) => '<DayTimeOverride DayTime="' + s + '_us_01" />').join('') + '</Cloud></CombineSky>') }])
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    const E = (type, deps, ...strings) => ({ type, deps, strings }), listed = (n) => n.replace('[media]', '<media>');
    const list = { entries: [E(5, []), E(1, [0], 'RES3_INIT load'), E(1, [1], 'TEMPLATES load'), ...classes.map((c) => E(2, [2], listed(c.name), 'cls_loader', 'initial.pak')),
        E(1, classes.map((c, i) => 3 + i), 'CLASSES load'), E(6, [3 + classes.length])] };
    const initial = zip([{ name: 'pak.load_list', data: loadList.serialise(list) }, { name: '[ssl_cache]\\initial_debug.sslbundle', data: Buffer.from('a') }, { name: '[ssl_cache]\\initial_profile.sslbundle', data: Buffer.from('b') },
        { name: '[ssl_cache]\\initial_release.sslbundle', data: Buffer.from('c') }, { name: '[media]\\_templates\\environment.xml', data: Buffer.from('<e />') }, ...classes]);
    fs.writeFileSync(initialFile, initial);
    // what initial.pak holds: its names, the text of every us_06 file by its short name, its load list
    function inside()
    {
        const fd = fs.openSync(initialFile, 'r');
        try
        {
            const z = lod.readZip(fd), text = {};
            for (const e of z.entries) if (/us_06/.test(e.name)) text[e.name.split('\\').pop()] = lod.readEntry(fd, e).data.toString('latin1');
            return { names: z.entries.map((e) => e.name), text, list: loadList.parse(lod.readEntry(fd, z.entries[0]).data) };
        }
        finally { fs.closeSync(fd); }
    }
    check('own days: the stand-in list keeps the rules, the rows read as before', [loadList.check(list), tool.status().maine], [[], 'vanilla']);
    check('own days: the row is asked for as maineown', tool.rowSpec('bc,maineown'), ['maineown', 'bc']);
    threw = '';
    try { tool.rowSpec('maine,maineown'); } catch (err) { threw = err.message; }
    check('own days: a row asked for both ways is refused', /twice/.test(threw), true);

    quiet(() => tool.install(tool.rowSpec('maineown')));
    let got = inside();
    check('own days: Maine reads as own', tool.status().maine, 'own');
    check('own days: both maps name us_06, states and sky', ['level_us_06_01', 'level_us_06_02'].map((l) => /^night_us_06 .* sky_us_06$/.test(read(l).names) && !/us_0[124]/.test(read(l).names) && read(l).crcOk), [true, true]);
    check('own days: initial.pak holds the nine states and the sky under us_06', Object.keys(got.text).sort(), states.map((s) => s + '_us_06.xml').concat(['sky_us_06.xml']).sort());
    check('own days: its directory is in name order from the fifth record', got.names.slice(4), got.names.slice(4).sort());
    check('own days: the load list names every new file and keeps the rules', [loadList.check(got.list), Object.keys(got.text).every((n) => got.list.entries.some((x) => x.strings[1] === 'cls_loader' && x.strings[0].endsWith('\\' + n)))], [[], true]);
    check('own days: a state is the copy of Michigan\'s', got.text['day__1_us_06.xml'], '<DayTimeState ColorLUT="lut/day_us_01__vol_uncmp.tga" Tag="day__1" />');
    check('own days: the sky names its own states and keeps Michigan\'s clouds', [/DayTime="night_us_06"/.test(got.text['sky_us_06.xml']), /DayTime="[a-z_0-9]*us_01"/.test(got.text['sky_us_06.xml']), /cloud_01_us_01/.test(got.text['sky_us_06.xml'])], [true, false, true]);
    threw = '';
    try { quiet(() => lod.setDays(null)); } catch (err) { threw = err.message; }
    check('own days: they are not taken out of initial.pak while a level file names them', [/level file names/.test(threw), inside().names.length], [true, got.names.length]);

    quiet(() => tool.install(tool.rowSpec('maine')));
    check('own days: back to Michigan\'s days, initial.pak is byte for byte the original', [tool.status().maine, fs.readFileSync(initialFile).equals(initial)], ['ours', true]);

    quiet(() => tool.install(tool.rowSpec('maineown')));
    fs.writeFileSync(initialFile, initial);   // a game update puts the game's initial.pak back under the level files
    check('own days: named without being in initial.pak reads as part', tool.status().maine, 'part');
    quiet(() => tool.install(tool.rowSpec('maineown')));
    check('own days: the next install mends it', [tool.status().maine, Object.keys(inside().text).length], ['own', 10]);

    quiet(() => tool.install([]));
    check('own days: restore leaves every level file and initial.pak byte for byte the stock', Object.keys(stock).map((l) => fs.readFileSync(file(l)).equals(stock[l])).concat([fs.readFileSync(initialFile).equals(initial)]), [true, true, true, true]);

    const foreign2 = zip([{ name: 'pak.load_list', data: loadList.serialise(list) }, { name: '[media]\\other.xml', data: Buffer.from('<o />') }]);
    fs.writeFileSync(initialFile, foreign2);   // another tool's initial.pak
    quiet(() => tool.install(tool.rowSpec('maineown')));
    check('own days: with another tool\'s initial.pak Maine takes Michigan\'s days and initial.pak is left alone', [tool.status().maine, fs.readFileSync(initialFile).equals(foreign2)], ['ours', true]);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(failed ? failed + ' FAILED' : 'all passed');
process.exitCode = failed ? 1 : 0;
