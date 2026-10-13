// Map days (engine\tools\level_states.js) on stand-in level paks: a small zip each, with a first entry and a stored
// [scene]\data_for_ssl.bin whose head names its states the way the game's does. Run: node test\level_states_test.js
// (prints one line per check and "all passed"; the exit code is 1 when a check fails).
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngen-levels-'));
process.env.SR_PAKS_DIR = dir;
const tool = require('../engine/tools/level_states.js');

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
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(failed ? failed + ' FAILED' : 'all passed');
process.exitCode = failed ? 1 : 0;
