// The start without the intro (engine\tools\gfx_intro.js) on a made-up bundle that holds the start-up movies' methods as
// the game ships them. Run: node test\gfx_intro_test.js (prints one line per check and "all passed"; the exit code is 1
// when a check fails).
'use strict';
const path = require('path');
const { patchIntro, EDITS } = require(process.argv[2] ? path.join(process.argv[2], 'gfx_intro.js') : '../engine/tools/gfx_intro.js');   // an engine's tools folder, or the working tree's

let failed = 0;
function check(name, got, want)
{
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)));
}
const filler = (n, k) => Buffer.alloc(n, 0x41 + k);
const bundle = (parts) => Buffer.concat(parts.flatMap((p, k) => [filler(97 + k, k), p]).concat([filler(50, 9)]));
const stock = bundle(EDITS.map((e) => e.was)), ours = bundle(EDITS.map((e) => e.now));

check('every edit keeps the size', EDITS.every((e) => e.was.length === e.now.length), true);
let r = patchIntro(stock);
check('the stock bundle takes the four edits', [r.found, r.done, r.all], [4, 0, 4]);
check('the result is the bundle with our methods', r.data.equals(ours), true);
check('the size stays', r.data.length, stock.length);
check('the input is left as it was', stock.equals(bundle(EDITS.map((e) => e.was))), true);
r = patchIntro(ours);
check('a bundle that has them already: found, nothing changed', [r.found, r.done, r.data.equals(ours)], [4, 4, true]);
r = patchIntro(bundle(EDITS.slice(1).map((e) => e.was)));
check('a bundle without one of the methods: three found', r.found, 3);
r = patchIntro(bundle([EDITS[0].was, EDITS[0].was, EDITS[1].was, EDITS[2].was, EDITS[3].was]));
check('a method that stands twice is left alone', [r.found, r.data.indexOf(EDITS[0].now)], [3, -1]);
// the warning's "ready" script moves to frame 10: pushshort 258 becomes pushbyte 9 and a nop
check('the constructor registers the ready script at frame 10', EDITS[0].now.toString('hex').includes('240902') && !EDITS[0].now.toString('hex').includes('258202'), true);
// StartSkippables: getlocal0, pushscope, nops, getlocal0, callpropvoid (OnAllAnimFinished, 0), returnvoid
check('StartSkippables ends the logos at once', /^d030(02)+d04f[0-9a-f]{4}0047$/.test(EDITS[1].now.toString('hex')), true);

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
