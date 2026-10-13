// The load list tool (engine\tools\load_list.js) on a made-up list in the game's form: stages, a run of class files, a
// mesh. Run: node test\load_list_test.js (prints one line per check and "all passed"; the exit code is 1 when a check
// fails).
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

const stage = (name) => ({ group: { n: 1, m: 2, f: [1, 1, 1] }, name, loader: null, pak: null });
const file = (name, loader, pak) => ({ group: { n: 3, m: 2, f: [1, 1, 1, 1, 1] }, name, loader, pak });
const cls = (n) => '<media>\\classes\\daytimes\\' + n + '.xml';
// records 0 to 6; a wait names a record counted from 1
const fresh = () => ({
    types: [1, 5, 1, 1, 2, 2, 1, 2, 1],
    waits: [{ unlisted: 1 }, [1], [2], [2], [3, 4], [5], [6], [7]],
    records: [stage('FIRST load'), stage('TEMPLATES load'), file(cls('day_b'), 'cls_loader', 'initial.pak'), file(cls('day_d'), 'cls_loader', 'initial.pak'),
        stage('CLASSES load'), file('<meshes>\\a.x', 'mesh_loader', 'shared.pak'), stage('MESH load')],
    end: { n: 0, m: 2, f: [1, 1] },
});

const bytes = tool.serialise(fresh());
check('the head: 1, 1, the count, 3', [...bytes.subarray(0, 13)], [1, 0, 0, 0, 1, 9, 0, 0, 0, 3, 0, 0, 0]);
check('read back it is the list', tool.parse(bytes), fresh());
check('written again it is the same bytes', tool.serialise(tool.parse(bytes)).equals(bytes), true);
check('the made-up list keeps the rules', tool.check(fresh()), []);

let list = fresh();
check('a file between two: its index', tool.addClassFile(list, cls('day_c')), 3);
check('between: the names in order', list.records.slice(2, 5).map((r) => r.name), [cls('day_b'), cls('day_c'), cls('day_d')]);
check('between: the types', list.types, [1, 5, 1, 1, 2, 2, 2, 1, 2, 1]);
check('between: every wait', list.waits, [{ unlisted: 1 }, [1], [2], [2], [2], [3, 4, 5], [6], [7], [8]]);
check('between: the rules hold', tool.check(list), []);
// a type, a wait list of one, one more number for the stage, and the record: its shape, name, loader and pak
check('between: the bytes it adds', tool.serialise(list).length - bytes.length, 1 + 9 + 4 + (13 + 4 + cls('day_c').length + 4 + 'cls_loader'.length + 4 + 'initial.pak'.length));

list = fresh();
check('a file before the first: its index', tool.addClassFile(list, cls('day_a')), 2);
check('before the first: every wait', list.waits, [{ unlisted: 1 }, [1], [2], [2], [2], [3, 4, 5], [6], [7], [8]]);
check('before the first: the rules hold', tool.check(list), []);

list = fresh();
check('a file after the last: its index', tool.addClassFile(list, cls('day_e')), 4);
check('after the last: the stage waits for it', list.waits[5], [3, 4, 5]);
check('after the last: the rules hold', tool.check(list), []);
check('after the last: read back from its bytes', tool.parse(tool.serialise(list)), list);

check('a name the list has is refused', throws(() => tool.addClassFile(fresh(), cls('day_b'))), true);
check('a name that is not plain text is refused', throws(() => tool.addClassFile(fresh(), cls('däy'))), true);
check('a cut file is refused', throws(() => tool.parse(bytes.subarray(0, bytes.length - 3))), true);
check('another head is refused', throws(() => tool.parse(Buffer.concat([Buffer.from([2]), bytes.subarray(1)]))), true);
const broken = fresh(); broken.waits[4] = [3];
check('a stage that does not wait for its files breaks a rule', tool.check(broken).length > 0, true);
const unordered = fresh(); [unordered.records[2], unordered.records[3]] = [unordered.records[3], unordered.records[2]];
check('class files out of order break a rule', tool.check(unordered).length > 0, true);

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
