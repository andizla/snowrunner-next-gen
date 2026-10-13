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
// A row can also have a set of its own (daytime_own.js): maineown gives Maine's maps the names of us_06, a region the
// game ships no states for. lod_patch.js puts that set into initial.pak, as a copy of Michigan's to begin with, and a
// level file names it only while initial.pak holds it: install sees to the order both ways. When a game update
// replaces initial.pak while the level files name the set, the status says part and the next install mends it.
// The change is made in the player's own file, in place: the names, and the zip's CRC of the entry in its local header
// and in the directory. Nothing is kept for the way back: restore writes the game's names, which the table holds, and
// the CRC comes out as it was. A level pak that is missing, whose file is compressed or whose names are neither the
// game's nor ours is left as it is.
// usage: node level_states.js status | list | install <rows, e.g. maine,bc or maineown,bc> | restore
//        status: one line of JSON, { "maine": "ours" | "own" | "vanilla" | "part" | "changed" | "missing", ... }
//        install: the rows named take our names, every other row the game's; restore: every row the game's
//        SR_PAKS_DIR points at the folder with the level paks; install and restore with the game closed
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { ownCodes } = require('./daytime_own.js');

const PAKS = process.env.SR_PAKS_DIR || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client';
const ROWS = {
    maine: { title: 'Maine', days: 'Michigan\'s days, weather and sky', own: 'us_06', levels: { level_us_06_01: ['us_04', 'us_01'], level_us_06_02: ['us_02', 'us_01'] } },
    bc: { title: 'British Columbia', days: 'North Carolina\'s days, weather and sky', levels: { level_us_10_01: ['us_01', 'us_12'], level_us_10_02: ['us_01', 'us_12'] } },
    austria: { title: 'Austria', days: 'North Carolina\'s days, weather and sky on both maps', levels: { level_us_14_01: ['ru_08', 'us_12'] } },
};
const HEAD = 1024;   // bytes of data_for_ssl.bin that hold its names
const NAME = /(?:night_to_day|day_to_night|night|day__\d[a-z]?|sky)_((?:ru|us|ca)_\d\d)(?=[;\x00])/g;

const ROW_NAMES = Object.keys(ROWS).flatMap((r) => (ROWS[r].own ? [r, r + 'own'] : [r]));

// "maine, bc" -> the rows in the table's order; a row with a set of its own may be named with "own" behind it
// (maineown). Throws on a row it does not know and on a row asked for both ways
function rowSpec(spec)
{
    const set = new Set(String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const r of set) if (!ROW_NAMES.includes(r)) throw new Error('map row "' + r + '" (the rows: ' + ROW_NAMES.join(', ') + ')');
    for (const r of Object.keys(ROWS)) if (set.has(r) && set.has(r + 'own')) throw new Error('map row "' + r + '" is asked for twice');
    return ROW_NAMES.filter((r) => set.has(r));
}
// lod_patch.js builds initial.pak. It is asked only when both tools mean the same game folder (SR_PAKS_DIR here,
// SR_INITIAL_PAK there): else a region's own days count as not there, and none are made
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function lod() { const l = require('./lod_patch.js'); return samePath(path.dirname(l.INITIAL), PAKS) ? l : null; }
const ownHeld = () => { const l = lod(); return l ? ownCodes(l.initialState().days) : []; };

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
// the region codes a level pak names (an empty list for a file this tool cannot read), or null when it is missing
function levelCodes(file)
{
    if (!fs.existsSync(file)) return null;
    const fd = fs.openSync(file, 'r');
    try
    {
        const e = sslEntry(fd);
        if (!e) return [];
        const head = Buffer.alloc(Math.min(HEAD, e.size));
        fs.readSync(fd, head, 0, head.length, e.dataAt);
        return codes(head).map((c) => c.code);
    }
    finally { fs.closeSync(fd); }
}
// what a level pak names: 'vanilla' (the game's region), 'ours', 'own' (the region's own set, where the row has one),
// 'changed' (anything else, or a file this tool cannot write) or 'missing'
function levelState(file, from, to, own)
{
    const found = levelCodes(file);
    if (!found) return 'missing';
    if (found.length < 8) return 'changed';
    return found.every((c) => c === from) ? 'vanilla' : found.every((c) => c === to) ? 'ours' : own && found.every((c) => c === own) ? 'own' : 'changed';
}
// a row's state from its levels': ours when every level there is names ours, own when every one names the region's own
// set and initial.pak holds it, vanilla when every one names the game's, part when they differ or the own set is named
// without being in initial.pak (an install that was cut short, a game update: install and restore finish it), missing
// when no level is there
function rowState(row, held = ownHeld())
{
    const spec = ROWS[row], states = Object.entries(spec.levels).map(([level, [from, to]]) => levelState(path.join(PAKS, level + '.pak'), from, to, spec.own)).filter((s) => s !== 'missing');
    if (!states.length) return 'missing';
    if (states.includes('changed')) return 'changed';
    if (states.every((s) => s === 'own')) return held.includes(spec.own) ? 'own' : 'part';
    return states.every((s) => s === 'ours') ? 'ours' : states.every((s) => s === 'vanilla') ? 'vanilla' : 'part';
}
const status = () => { const held = ownHeld(); return Object.fromEntries(Object.keys(ROWS).map((r) => [r, rowState(r, held)])); };
// the own sets some level file names, in whole or in part: initial.pak has to keep these
function ownNamed()
{
    const out = new Set();
    for (const spec of Object.values(ROWS)) if (spec.own) for (const level of Object.keys(spec.levels)) if ((levelCodes(path.join(PAKS, level + '.pak')) || []).includes(spec.own)) out.add(spec.own);
    return [...out];
}

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
// the rows in `want` take our names (a row named with "own" its own set), every other row the game's; prints what
// changed and what was left. A level file names an own set only while initial.pak holds it: the set goes into
// initial.pak before the level files are written and comes out after no level file names it any more. Where it cannot
// go in (initial.pak is another tool's, or not this game folder's), the row takes the borrowed days instead
function install(want)
{
    const l = lod(), asked = Object.keys(ROWS).filter((r) => want.includes(r + 'own')).map((r) => ROWS[r].own);
    let held = ownHeld();
    if (l && asked.some((c) => !held.includes(c))) held = ownCodes(l.setDays([...new Set(held.concat(asked))].join(',')));
    for (const row of Object.keys(ROWS))
    {
        const spec = ROWS[row], wantOwn = want.includes(row + 'own'), own = wantOwn && held.includes(spec.own), on = wantOwn || want.includes(row);
        const goal = own ? 'own' : on ? 'ours' : 'vanilla', done = [], left = [];
        if (wantOwn && !own) console.log('warning: days of its own for ' + spec.title + ' need this tool\'s build of initial.pak, which is not there: ' + spec.title + ' takes ' + spec.days + ' instead');
        for (const [level, [from, to]] of Object.entries(spec.levels))
        {
            const file = path.join(PAKS, level + '.pak'), state = levelState(file, from, to, spec.own);
            if (state === 'missing') continue;
            if (state === 'changed') { if (on) left.push(level); continue; }
            if (state === goal) continue;
            writeLevel(file, own ? spec.own : on ? to : from);
            if (levelState(file, from, to, spec.own) !== goal) throw new Error(level + '.pak does not read back as written');
            done.push(level);
        }
        if (done.length) console.log('map days: ' + spec.title + (own ? ' now has days of its own, which begin as ' + spec.days : on ? ' now has ' + spec.days : ' has the game\'s own names again') + ' (' + done.join(', ') + ')');
        if (left.length) console.log('map days: ' + left.join(', ') + ' changed by something else: left as it is');
    }
    if (l) l.setDays(ownNamed().join(','));
}

if (require.main === module)
{
    const [cmd, arg] = process.argv.slice(2);
    try
    {
        if (cmd === 'status') console.log(JSON.stringify(status()));
        else if (cmd === 'list')
            for (const row of Object.keys(ROWS))
                for (const [level, [from, to]] of Object.entries(ROWS[row].levels)) console.log(row.padEnd(8) + level + '  ' + from + ' -> ' + to + (ROWS[row].own ? ' or ' + ROWS[row].own : '') + '  ' + levelState(path.join(PAKS, level + '.pak'), from, to, ROWS[row].own));
        else if (cmd === 'install') install(rowSpec(arg));
        else if (cmd === 'restore') install([]);
        else console.log('usage: node level_states.js status | list | install <rows: ' + ROW_NAMES.join(',') + '> | restore');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}

module.exports = { ROWS, PAKS, rowSpec, status, install, levelState, ownNamed };
