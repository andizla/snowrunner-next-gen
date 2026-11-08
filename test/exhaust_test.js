// SPDX-License-Identifier: GPL-3.0-only
// The engine on tiny stand-in paks: no game assets, DLL or shader compilation needed. Also run against a package.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), assert = require('assert/strict'), { execFileSync } = require('child_process');
const engine = path.resolve(process.argv[2] || path.join(__dirname, '../engine'));
const tools = path.resolve(process.argv[3] || path.join(engine, 'tools'));
const pak = require(path.join(tools, 'lod_patch.js'));
const workBase = process.env.NGEN_TEST_WORK || path.join(__dirname, '../out');
fs.mkdirSync(workBase, { recursive: true });
const work = fs.mkdtempSync(path.join(workBase, 'exhaust-')), game = path.join(work, 'game'), paks = path.join(game, 'preload/paks/client');
fs.mkdirSync(paks, { recursive: true });
fs.mkdirSync(path.join(game, 'Sources/Bin'), { recursive: true });
fs.writeFileSync(path.join(game, 'Sources/Bin/SnowRunner.exe'), 'stand-in');
const env = Object.assign({}, process.env, { NGEN_STATE_ROOT: path.join(work, 'state') });
const initial = path.join(paks, 'initial.pak'), selectionFile = path.join(work, 'selection.json');
const prefix = '[media]\\classes\\particles\\';
const xml = '<CombineParticles><Size Function="(1; 2; 3)" /><LifeTime Value="4" /><Color><Key At="0" Value="g(1; 2; 3; 400) x 4" /><Key At="1" Value="g(1; 2; 3; 0)" /></Color></CombineParticles>';
const entries = [['pak.load_list', Buffer.from('unchanged load list')], ...['small', 'large', 'fog', 'heat_winter', 'heat'].map((n) => [prefix + 'exhaust_' + n + '.xml', Buffer.from(xml)])];
function zip(entries)
{
    const local = [], central = [];
    let offset = 0;
    for (const [name, data] of entries)
    {
        const filename = Buffer.from(name), method = name.endsWith('large.xml') ? 8 : 0, compressed = method ? zlib.deflateRawSync(data) : data;
        const h = Buffer.alloc(30), c = Buffer.alloc(46), crc = zlib.crc32(data);
        h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(method, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(compressed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
        c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
        local.push(h, filename, compressed); central.push(c, filename); offset += h.length + filename.length + compressed.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    const body = Buffer.concat([...local, cd, end]);
    return Buffer.concat([body, Buffer.alloc(Math.ceil(body.length / 4096) * 4096 - body.length)]);
}
function contents(file)
{
    const fd = fs.openSync(file, 'r');
    try { return pak.readZip(fd).entries.map((e) => [e.name, pak.readEntry(fd, e).data]); }
    finally { fs.closeSync(fd); }
}
const original = zip(entries);
fs.writeFileSync(initial, original);
fs.writeFileSync(path.join(paks, 'shader.pak'), zip([['stand-in', Buffer.from('shader left alone')]]));
function run(command, selection, extra = [])
{
    const args = [path.join(engine, 'ngen.js'), command, '--game', game];
    if (selection !== undefined) { fs.writeFileSync(selectionFile, JSON.stringify(selection)); args.push('--selection', selectionFile); }
    const events = execFileSync(process.execPath, args.concat(extra), { env, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).map(JSON.parse);
    return events;
}
function apply(selection, extra) { const events = run('apply', selection, extra); assert.equal(events.at(-1).type, 'done'); return events; }
const status = () => run('status').find((e) => e.type === 'status');
const saved = () => contents(initial).find(([n]) => n === prefix + 'exhaust_small.xml')[1].toString();
assert.equal(status().exhaust.state, 'vanilla');
for (const percent of ['150', '0', '100', '300'])
{
    apply({ exhaust: percent });
    assert.deepEqual(status().exhaust, { state: 'ours', percent });
    assert.ok(saved().includes('Function="(' + [1, 2, 3].map((v) => v * Number(percent) / 100).join('; ') + ')"'));
    const first = fs.readFileSync(initial);
    const repeat = apply({ exhaust: percent });
    assert.ok(repeat.some((e) => e.text.includes('exhaust smoke is already at')));
    assert.deepEqual(fs.readFileSync(initial), first);
}
apply({ exhaust: '100' });
apply({});
assert.equal(status().exhaust.state, 'vanilla');
assert.deepEqual(fs.readFileSync(initial), original, 'disable restores the original archive');
apply({ exhaust: '100' });
run('restore');
assert.equal(status().exhaust.state, 'vanilla', '100 % metadata is removed even with the original hash');
assert.deepEqual(fs.readFileSync(initial), original);
apply({ exhaust: '0', debris: '4' });
assert.ok(saved().includes('Value="6"'), 'debris lifetime composes with invisible exhaust');
apply({ exhaust: '150' });
assert.ok(saved().includes('LifeTime Value="4"'), 'removing debris keeps exhaust');
apply({ debris: '4' });
assert.ok(saved().includes('Function="(1; 2; 3)"'), 'removing exhaust keeps debris');
assert.ok(saved().includes('LifeTime Value="6"'));
apply({ exhaust: '0', debris: '4' });
const changed = contents(initial); changed.push(['other-mod.txt', Buffer.from('keep me')]); fs.writeFileSync(initial, zip(changed));
const foreign = fs.readFileSync(initial);
let stopped;
try { run('apply', { exhaust: '150', debris: '4' }); } catch (e) { stopped = e.stdout; }
assert.ok(stopped && stopped.includes('adopt-files'), 'foreign changes require adoption');
apply({ exhaust: '150', debris: '4' }, ['--leave']);
assert.deepEqual(fs.readFileSync(initial), foreign, 'leave preserves the foreign archive');
apply({ exhaust: '150', debris: '4' }, ['--adopt']);
assert.ok(saved().includes('Function="(1.5; 3; 4.5)"'), 'adoption does not compound the old zero');
assert.ok(saved().includes('LifeTime Value="6"'));
run('restore');
assert.equal(status().exhaust.state, 'vanilla');
assert.deepEqual(contents(initial), entries.concat([['other-mod.txt', Buffer.from('keep me')]]), 'restore retains the other mod and removes our edits');
// A missing field in an older build note is disabled. Pending writes must preserve zero as well.
apply({ exhaust: '0' });
const state = status().stateDir, noteFile = path.join(state, 'initial.pak.grass.json'), note = JSON.parse(fs.readFileSync(noteFile));
fs.writeFileSync(noteFile, JSON.stringify({ origCdSha256: note.origCdSha256, pending: note }));
assert.deepEqual(status().exhaust, { state: 'ours', percent: '0' });
fs.writeFileSync(noteFile, JSON.stringify(Object.assign({}, note, { exhaust: undefined })));
assert.equal(status().exhaust.state, 'vanilla');
fs.writeFileSync(noteFile, JSON.stringify(note)); run('restore');
// Invalid definitions and percentages leave the archive as it was.
for (const percent of ['15', '-10', '310', '', true])
{
    const before = fs.readFileSync(initial);
    let rejected;
    try { run('apply', { exhaust: percent }); } catch (e) { rejected = e.stdout; }
    assert.ok(rejected && rejected.includes('usage'));
    assert.deepEqual(fs.readFileSync(initial), before);
}
const bad = entries.filter(([n]) => !n.endsWith('exhaust_fog.xml'));
fs.writeFileSync(initial, zip(bad));
const before = fs.readFileSync(initial);
let rejected;
try { run('apply', { exhaust: '150' }, ['--adopt']); } catch (e) { rejected = e.stdout; }
assert.ok(rejected && rejected.includes('missing exhaust definitions'));
assert.deepEqual(fs.readFileSync(initial), before);
assert.ok(!fs.existsSync(initial + '.tmp'));
console.log('all passed');
