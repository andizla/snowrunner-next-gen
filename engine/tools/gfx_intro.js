// SPDX-License-Identifier: GPL-3.0-only
// The start of the game without its intro: the Next Gen splash (the bootup loading screen) at once. The intro is one
// Flash movie in gfx.pak's [gfx]\gfxbundle.gfxbundle (and its Japanese twin): a warning and legal text for 258 frames at
// 35 a second, then a timeline that tells the loading screen it is ready (OnSkippableReadyToStart), which calls
// StartSkippables: the publisher logos, about 11 s, that a key skips; at their end OnAllAnimFinished hands over
// (OnLogoEnd) and the loading screen shows. Two edits of the movie's ActionScript bytecode, each the same size:
//   the constructor registers the "ready" script at frame 10 instead of 259 (pushshort 258 -> pushbyte 9, nop)
//   StartSkippables calls OnAllAnimFinished at once (nops, then the call): no logos, no key to wait for
// The bundle's header holds the movies' names and lengths, no offsets or checksums: a same-size edit leaves it valid.
// Each edit is found by the whole method's bytes as the game ships them, once each; a game version whose movie
// differs is left as it is (patchIntro returns found < 4).
// usage: node gfx_intro.js check <bundle>      the edits this bundle can take
'use strict';
const fs = require('fs');

// [the game's bytes, ours] as hex: two per movie (the main movie and the Japanese one, whose names have other numbers)
const EDITS = [
    ['d030d049005dce0c2401d0668e04258202d0668f04258905d06690044fce0c0647', 'd030d049005dce0c2401d0668e04240902d0668f04258905d06690044fce0c0647'],
    ['d030d04f8003005dfc01600966d50ad0668103272400264ffc01055ddb0c2cf10b4fdb0c0147', 'd030' + '02'.repeat(30) + 'd04f83030047'],
    ['d030d049005dc80c2401d0668c04258202d0668d04258c06d0668e044fc80c0647', 'd030d049005dc80c2401d0668c04240902d0668d04258c06d0668e044fc80c0647'],
    ['d030d04ffe02005dfc01600966cf0ad066ff02272400264ffc01055dd50c2ceb0b4fd50c0147', 'd030' + '02'.repeat(30) + 'd04f81030047'],
].map(([was, now]) => ({ was: Buffer.from(was, 'hex'), now: Buffer.from(now, 'hex') }));

// the bundle with the edits that find their bytes exactly once: { data, found, done } (done: those already in)
function patchIntro(bundle)
{
    const data = Buffer.from(bundle);
    let found = 0, done = 0;
    for (const e of EDITS)
    {
        if (e.was.length !== e.now.length) throw new Error('an intro edit changes the size');
        const at = data.indexOf(e.was);
        if (at >= 0 && data.indexOf(e.was, at + 1) < 0) { e.now.copy(data, at); found++; continue; }
        const mine = data.indexOf(e.now);
        if (at < 0 && mine >= 0 && data.indexOf(e.now, mine + 1) < 0) { found++; done++; }
    }
    return { data, found, done, all: EDITS.length };
}

module.exports = { patchIntro, EDITS };

if (require.main === module)
{
    const [cmd, file] = process.argv.slice(2);
    if (cmd === 'check' && file) { const r = patchIntro(fs.readFileSync(file)); console.log(JSON.stringify({ found: r.found, already: r.done, of: r.all })); }
    else { console.error('usage: node gfx_intro.js check <gfxbundle.gfxbundle>'); process.exit(2); }
}
