// SPDX-License-Identifier: GPL-3.0-only
// Map days: which region's time-of-day states and sky a map cycles through. A level's pak (level_us_06_01.pak) holds
// [scene]\data_for_ssl.bin, stored, and that file begins with its names, each a u16 length, the text and a zero: the
// level's name, its description, then the states of the night, the dawn, the three days (each a ; list of a state and
// its weather variants) and the dusk, and the region's sky file. A few maps have no states of their own and name
// another region's. The game takes the names as they stand: the file's own check value (the u32 at 12) is not
// compared, and any state initial.pak knows can be named (tested in the game on 2026-10-13). A name initial.pak does
// not know stops the load, so a row only ever puts in names the game ships, of the same length.
// The rows:
//   maine    Maine's two maps name the states and the sky of Yukon and of Alaska, two snow regions: snow in the air
//            and the snow regions' light on a map without snow. They take Michigan's.
//   bc       British Columbia's two maps name Michigan's. They take North Carolina's, which the game gives
//            Washington, the region next to it.
//   austria  Austria's first map names ru_08's, its second North Carolina's. The first takes the second's.
// The change is made in the player's own file, in place: the names, and the zip's CRC of the entry in its local header
// and in the directory. Nothing is kept for the way back: restore writes the game's names, which the table holds, and
// the CRC comes out as it was. A level pak that is missing, whose file is compressed or whose names are neither the
// game's nor ours is left as it is.
// usage: node level_states.js status | list | install <rows, e.g. maine,bc> | restore
//        status: one line of JSON, { "maine": "ours" | "vanilla" | "part" | "changed" | "missing", ... }
//        install: the rows named take our names, every other row the game's; restore: every row the game's
//        SR_PAKS_DIR points at the folder with the level paks; install and restore with the game closed
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const PAKS = process.env.SR_PAKS_DIR || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client';
const ROWS = {
    maine: { title: 'Maine', days: 'Michigan\'s days, weather and sky', levels: { level_us_06_01: ['us_04', 'us_01'], level_us_06_02: ['us_02', 'us_01'] } },
    bc: { title: 'British Columbia', days: 'North Carolina\'s days, weather and sky', levels: { level_us_10_01: ['us_01', 'us_12'], level_us_10_02: ['us_01', 'us_12'] } },
    austria: { title: 'Austria', days: 'North Carolina\'s days, weather and sky on both maps', levels: { level_us_14_01: ['ru_08', 'us_12'] } },
};
const HEAD = 1024;   // bytes of data_for_ssl.bin that hold its names
const NAME = /(?:night_to_day|day_to_night|night|day__\d[a-z]?|sky)_((?:ru|us|ca)_\d\d)(?=[;\x00])/g;

// "maine, bc" -> the rows in the table's order; throws on a row it does not know
function rowSpec(spec)
{
    const set = new Set(String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const r of set) if (!ROWS[r]) throw new Error('map row "' + r + '" (the rows: ' + Object.keys(ROWS).join(', ') + ')');
    return Object.keys(ROWS).filter((r) => set.has(r));
}

// a level pak's data_for_ssl.bin: { local, record, dataAt, size } (local: the entry's local header, record: its
// directory record, both file offsets), or null when the pak has no such entry or holds it compressed
function sslEntry(fd)
{
    const size = fs.fstatSync(fd).size, n = Math.min(size, 65557), tail = Buffer.alloc(n);
    fs.readSync(fd, tail, 0, n, size - n);
    let at = n - 22;
    while (at >= 0 && tail.readUInt32LE(at) !== 0x06054b50) at--;
    if (at < 0) return null;
    const cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16), cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;)
    {
        const nameLen = cd.readUInt16LE(p + 28), next = p + 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
        if (/data_for_ssl\.bin$/i.test(cd.toString('latin1', p + 46, p + 46 + nameLen)))
        {
            if (cd.readUInt16LE(p + 10) !== 0 || (cd.readUInt16LE(p + 8) & 1)) return null;   // compressed or encrypted
            const local = cd.readUInt32LE(p + 42), head = Buffer.alloc(30);
            fs.readSync(fd, head, 0, 30, local);
            if (head.readUInt32LE(0) !== 0x04034b50) return null;
            return { local, record: cdOffset + p, dataAt: local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), size: cd.readUInt32LE(p + 20) };
        }
        p = next;
    }
    return null;
}
// the region codes in the head of the level file: [{ at, code }], one for each state name and for the sky file
function codes(head)
{
    const text = head.toString('latin1'), out = [];
    NAME.lastIndex = 0;
    for (let m = NAME.exec(text); m; m = NAME.exec(text)) out.push({ at: m.index + m[0].length - m[1].length, code: m[1] });
    return out;
}
// what a level pak names: 'vanilla' (the game's region), 'ours', 'changed' (anything else, or a file this tool cannot
// write) or 'missing'
function levelState(file, from, to)
{
    if (!fs.existsSync(file)) return 'missing';
    const fd = fs.openSync(file, 'r');
    try
    {
        const e = sslEntry(fd);
        if (!e) return 'changed';
        const head = Buffer.alloc(Math.min(HEAD, e.size));
        fs.readSync(fd, head, 0, head.length, e.dataAt);
        const found = codes(head);
        if (found.length < 8) return 'changed';
        return found.every((c) => c.code === from) ? 'vanilla' : found.every((c) => c.code === to) ? 'ours' : 'changed';
    }
    finally { fs.closeSync(fd); }
}
// a row's state from its levels': ours when every level there is names ours, vanilla when every one names the game's,
// part when both occur (an install that was cut short: install and restore finish it), missing when no level is there
function rowState(row)
{
    const states = Object.entries(ROWS[row].levels).map(([level, [from, to]]) => levelState(path.join(PAKS, level + '.pak'), from, to)).filter((s) => s !== 'missing');
    if (!states.length) return 'missing';
    if (states.includes('changed')) return 'changed';
    return states.every((s) => s === 'ours') ? 'ours' : states.every((s) => s === 'vanilla') ? 'vanilla' : 'part';
}
const status = () => Object.fromEntries(Object.keys(ROWS).map((r) => [r, rowState(r)]));

// every region code in the head of a level's file becomes `code`; the entry's CRC follows in both of its places
function writeLevel(file, code)
{
    const fd = fs.openSync(file, 'r+');
    try
    {
        const e = sslEntry(fd), data = Buffer.alloc(e.size);
        fs.readSync(fd, data, 0, e.size, e.dataAt);
        const head = data.subarray(0, Math.min(HEAD, e.size)), found = codes(head);
        for (const c of found) data.write(code, c.at, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32LE(zlib.crc32(data) >>> 0);
        fs.writeSync(fd, head, 0, head.length, e.dataAt);
        fs.writeSync(fd, crc, 0, 4, e.local + 14);
        fs.writeSync(fd, crc, 0, 4, e.record + 16);
        fs.fsyncSync(fd);
        return found.length;
    }
    finally { fs.closeSync(fd); }
}
// the rows in `want` take our names, every other row the game's; prints what changed and what was left
function install(want)
{
    for (const row of Object.keys(ROWS))
    {
        const on = want.includes(row), done = [], left = [];
        for (const [level, [from, to]] of Object.entries(ROWS[row].levels))
        {
            const file = path.join(PAKS, level + '.pak'), state = levelState(file, from, to);
            if (state === 'missing') continue;
            if (state === 'changed') { if (on) left.push(level); continue; }
            if (state === (on ? 'ours' : 'vanilla')) continue;
            writeLevel(file, on ? to : from);
            if (levelState(file, from, to) !== (on ? 'ours' : 'vanilla')) throw new Error(level + '.pak does not read back as written');
            done.push(level);
        }
        if (done.length) console.log('map days: ' + ROWS[row].title + (on ? ' now has ' + ROWS[row].days : ' has the game\'s own names again') + ' (' + done.join(', ') + ')');
        if (left.length) console.log('map days: ' + left.join(', ') + ' changed by something else: left as it is');
    }
}

if (require.main === module)
{
    const [cmd, arg] = process.argv.slice(2);
    try
    {
        if (cmd === 'status') console.log(JSON.stringify(status()));
        else if (cmd === 'list')
            for (const row of Object.keys(ROWS))
                for (const [level, [from, to]] of Object.entries(ROWS[row].levels)) console.log(row.padEnd(8) + level + '  ' + from + ' -> ' + to + '  ' + levelState(path.join(PAKS, level + '.pak'), from, to));
        else if (cmd === 'install') install(rowSpec(arg));
        else if (cmd === 'restore') install([]);
        else console.log('usage: node level_states.js status | list | install <rows: ' + Object.keys(ROWS).join(',') + '> | restore');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}

module.exports = { ROWS, rowSpec, status, install, levelState };
