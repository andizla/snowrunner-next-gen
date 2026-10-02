// Fill light: the daytime states' ambient light (what reaches shade: from above, from the horizon, from below) scaled by
// one factor, so shade, the insides of trees and cars in shadow get darker while sunlit parts and the sky stay as
// authored. Measured against DLSS 5 shots of the same scenes: what the neural pass darkens is what the fill light
// lights, and the stock states give a lot of it (ru_17 midday: the fill from above x3.9 against the sun's x5.15). The
// game's eye adaptation then lifts the sunlit parts a little, as those shots show too.
// The values live in initial.pak, [media]\...\classes\daytimes\*.xml (199 states, one <Ambient> each):
//   <Ambient NegY="g(179; 179; 179) x 2.1" MidY="g(192; 185; 172) x 3.2" PosY="g(172; 181; 194) x 3.9" />
// The colour stays; the multiplier is scaled (a value without one gets " x <factor>"). Only the day, dusk and dawn states
// change: night, the garage, the main menu and the map screens keep theirs. <TruckAmbient> (22 night states) stays.
// Exposure: on a sunny ru_17 day the fill light is about half the light even on sunlit ground, so less of it darkens the
// whole picture, and the game's eye adaptation lifts it all back up: shade would come out only a little darker and
// sunlit parts brighter than before. So the same states' HdrExposureScale is scaled too, by factor^0.45 (0.85 at
// 70 %), which holds sunlit parts about where they were and leaves the shade darker, the pattern of the DLSS 5 shots.
// lod_patch.js builds initial.pak with this edit next to the grass (fill-install / fill-restore).
// usage: node daytime_fill.js list [factor] [initial.pak]   what would change (default pak_backup\initial.pak.orig)
'use strict';
const path = require('path');

const DAYTIME_ENTRY = /classes[\\/]daytimes[\\/]([^\\/]+)\.xml$/i;
const FILL_STATES = /^(day__\d|day_to_night|night_to_day)/i;
const FILL_FACTOR = 0.7;   // the default: fill light at 70 %

// a daytime state whose fill light this changes: day, dusk and dawn, not the menu's own states
function isFillState(entryName)
{
    const m = DAYTIME_ENTRY.exec(entryName);
    return !!m && FILL_STATES.test(m[1]) && !/menu/i.test(m[1]);
}

const fmt = (v) => v.toFixed(3).replace(/\.?0+$/, '');
// the exposure that goes with a fill factor (see the top): 0.7 -> 0.852, 0.55 -> 0.764, 0.85 -> 0.929
const exposureFor = (factor) => Math.pow(factor, 0.45);

// the <Ambient> tag's three values with their multipliers times factor, and HdrExposureScale times exposureFor(factor);
// { out, notes }, out === text when nothing matched
function fillEdit(text, factor)
{
    if (!(factor > 0 && factor <= 2)) throw new Error('fill factor ' + factor);
    const notes = [];
    let out = text.replace(/<Ambient\b[^>]*>/g, (tag) => tag.replace(/\b(NegY|MidY|PosY)(\s*=\s*")([^"]*)(")/g, (all, name, eq, value, close) =>
    {
        const m = /^\s*(g?\([^)]*\))\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?$/.exec(value);
        if (!m) return all;
        const k = m[2] === undefined ? 1 : Number(m[2]), scaled = fmt(k * factor);
        notes.push(name + ' ' + fmt(k) + ' -> ' + scaled);
        return name + eq + m[1] + ' x ' + scaled + close;
    }));
    out = out.replace(/\b(HdrExposureScale)(\s*=\s*")(\d+(?:\.\d+)?)(")/, (all, name, eq, value, close) =>
    {
        const scaled = fmt(Number(value) * exposureFor(factor));
        notes.push(name + ' ' + fmt(Number(value)) + ' -> ' + scaled);
        return name + eq + scaled + close;
    });
    return { out, notes };
}

module.exports = { isFillState, fillEdit, exposureFor, FILL_FACTOR, DAYTIME_ENTRY };

if (require.main === module)
{
    const [cmd, factorArg, fileArg] = process.argv.slice(2);
    try
    {
        if (cmd !== 'list') { console.log('usage: node daytime_fill.js list [factor] [initial.pak]'); return; }
        const fs = require('fs'), { readZip, readEntry } = require('./lod_patch.js');
        const factor = factorArg ? Number(factorArg) : FILL_FACTOR;
        const file = fileArg || path.join(process.env.SR_STATE_DIR || path.join(__dirname, '..', 'pak_backup'), 'initial.pak.orig');
        const fd = fs.openSync(file, 'r');
        try
        {
            const z = readZip(fd);
            let states = 0, changed = 0, kept = [];
            for (const ent of z.entries)
            {
                if (!DAYTIME_ENTRY.test(ent.name)) continue;
                states++;
                if (!isFillState(ent.name)) { kept.push(DAYTIME_ENTRY.exec(ent.name)[1]); continue; }
                const r = fillEdit(readEntry(fd, ent).data.toString('latin1'), factor);
                if (!r.notes.length) { console.log('  no <Ambient> values found: ' + ent.name); continue; }
                changed++;
                if (changed <= 8 || /ru_17/.test(ent.name)) console.log('  ' + DAYTIME_ENTRY.exec(ent.name)[1].padEnd(28) + r.notes.join(', '));
            }
            console.log(file + ': ' + states + ' daytime states, ' + changed + ' with the fill light at ' + fmt(factor * 100) + ' %, ' + kept.length + ' kept (' + kept.slice(0, 6).join(', ') + (kept.length > 6 ? ', ...' : '') + ')');
        }
        finally { fs.closeSync(fd); }
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
