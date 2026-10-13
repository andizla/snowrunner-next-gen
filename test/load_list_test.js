// The load list tool (engine\tools\load_list.js) on made-up lists in the game's form: stages, a run of class files, a
// mesh, and textures with their two entries each. Run: node test\load_list_test.js (prints one line per check and
// "all passed"; the exit code is 1 when a check fails).
'use strict';
const path = require('path');
const tool = require(process.argv[2] ? path.join(process.argv[2], 'load_list.js') : '../engine/tools/load_list.js');   // an engine's tools folder, or the working tree's

let failed = 0;
function check(name, got, want)
{
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const throws = (f) => { try { f(); return false; } catch (e) { return true; } };

const START = 5, STAGE = 1, ASSET = 2, END = 6;
const entry = (type, deps, ...strings) => ({ type, deps, strings });
const cls = (n) => '<media>\\classes\\daytimes\\' + n + '.xml';
const klass = (n, wait) => entry(ASSET, [wait], cls(n), 'cls_loader', 'initial.pak');
// entries 0 to 8; a number names the entry waited for
const fresh = () => ({ entries: [
    entry(START, []), entry(STAGE, [0], 'FIRST load'), entry(STAGE, [1], 'TEMPLATES load'),
    klass('day_b', 2), klass('day_d', 2), entry(STAGE, [3, 4], 'CLASSES load'),
    entry(ASSET, [5], '<meshes>\\a.x', 'mesh_loader', 'shared.pak'), entry(STAGE, [6], 'MESH load'), entry(END, [7]),
] });
const deps = (list) => list.entries.map((x) => x.deps);

const bytes = tool.serialise(fresh());
check('the head: 1, 1, the count, 3, 1', [...bytes.subarray(0, 14)], [1, 0, 0, 0, 1, 9, 0, 0, 0, 3, 0, 0, 0, 1]);
check('the types and a 1', [...bytes.subarray(14, 24)], [5, 1, 1, 2, 2, 1, 2, 1, 6, 1]);
check('the start waits for nothing, the first stage for the start', [...bytes.subarray(24, 38)], [0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0]);
check('the end has no strings: 0, 2, 01 01', [...bytes.subarray(bytes.length - 10)], [0, 0, 0, 0, 2, 0, 0, 0, 1, 1]);
check('read back it is the list', tool.parse(bytes), fresh());
check('written again it is the same bytes', tool.serialise(tool.parse(bytes)).equals(bytes), true);
check('the made-up list keeps the rules', tool.check(fresh()), []);

let list = fresh();
check('a file between two: its entry number', tool.addClassFile(list, cls('day_c')), 4);
check('between: the names in order', list.entries.slice(3, 6).map((x) => x.strings[0]), [cls('day_b'), cls('day_c'), cls('day_d')]);
check('between: the types', list.entries.map((x) => x.type), [5, 1, 1, 2, 2, 2, 1, 2, 1, 6]);
check('between: every wait', deps(list), [[], [0], [1], [2], [2], [2], [3, 4, 5], [6], [7], [8]]);
check('between: the rules hold', tool.check(list), []);
// a type, a wait list of one, one more number for the stage, and the strings: their count, name, loader and pak
check('between: the bytes it adds', tool.serialise(list).length - bytes.length, 1 + 9 + 4 + (13 + 4 + cls('day_c').length + 4 + 'cls_loader'.length + 4 + 'initial.pak'.length));

list = fresh();
check('a file before the first: its entry number', tool.addClassFile(list, cls('day_a')), 3);
check('before the first: every wait', deps(list), [[], [0], [1], [2], [2], [2], [3, 4, 5], [6], [7], [8]]);
check('before the first: the rules hold', tool.check(list), []);

list = fresh();
check('a file after the last: its entry number', tool.addClassFile(list, cls('day_e')), 5);
check('after the last: the stage waits for it', list.entries[6].deps, [3, 4, 5]);
check('after the last: the rules hold', tool.check(list), []);
check('after the last: read back from its bytes', tool.parse(tool.serialise(list)), list);

check('a name the list has is refused', throws(() => tool.addClassFile(fresh(), cls('day_b'))), true);
check('a name that is not plain text is refused', throws(() => tool.addClassFile(fresh(), cls('däy'))), true);
check('a cut file is refused', throws(() => tool.parse(bytes.subarray(0, bytes.length - 3))), true);
check('another head is refused', throws(() => tool.parse(Buffer.concat([Buffer.from([2]), bytes.subarray(1)]))), true);
const marked = Buffer.from(bytes); marked[28] = 0;   // the byte after the start's count of waits
check('a wait list without its 1 is refused', throws(() => tool.parse(marked)), true);
const broken = fresh(); broken.entries[5].deps = [3];
check('a stage that does not wait for its files breaks a rule', tool.check(broken).length > 0, true);
const unordered = fresh(); [unordered.entries[3], unordered.entries[4]] = [unordered.entries[4], unordered.entries[3]];
check('class files out of order break a rule', tool.check(unordered).length > 0, true);
const chained = fresh(); chained.entries[4].deps = [3]; chained.entries[5].deps = [4];
check('a class file that waits for another breaks a rule', tool.check(chained).length > 0, true);

// textures, as the level paks list them: the header waits for the stage, the faces for the header, the next stage for
// the faces alone; a fourth string where the texture has a base
const tex = (n, loader, wait, ...more) => entry(ASSET, [wait], '<textures>\\pct\\' + n + '.pct_header', loader, 'level.pak', ...more);
const textures = () => ({ entries: [
    entry(START, []), entry(STAGE, [0], 'TEXTURE_PREPARE load'),
    tex('a', 'pct_mr2_header', 1, '{"pct_base_pak":"base.pak"}'), tex('a', 'pct_faces', 2, '{"pct_base_pak":"base.pak"}'),
    tex('b', 'pct_mr2_header', 1), tex('b', 'pct_faces', 4),
    entry(STAGE, [3, 5], 'TEXTURE load'), entry(END, [6]),
] });
check('textures: the list keeps the rules', tool.check(textures()), []);
check('textures: read back from its bytes', tool.parse(tool.serialise(textures())), textures());
const both = textures(); both.entries[6].deps = [2, 3, 4, 5];
check('textures: a stage that waits for the headers too breaks a rule', tool.check(both).length > 0, true);
check('textures: no class files, so none is added', throws(() => tool.addClassFile(textures(), cls('day_a'))), true);

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
