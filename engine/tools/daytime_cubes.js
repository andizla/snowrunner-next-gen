// SPDX-License-Identifier: GPL-3.0-only
// Winter cubes in the day states: which reflection cube a snow region's clear days name. Each daytime state
// (initial.pak, [media]\...\classes\daytimes\*.xml) names a reflection cube, EnvMap="env/day_al_01__d_ggxrefl.tga",
// the painted sky that paint, glass and chrome mirror and that Sky ambient and Bounce light read the sky's and the
// ground's colour from. Kola (ru_03) and Yukon (us_04) give their clear days 1 and 2 the Michigan summer cube
// (day_mich_01) and only day 3 the Alaska snow cube (day_al_01), which Alaska and Amur use for all three. When
// boot.pak holds Next Gen's winter cube over day_al_01 (the Winter reflection cubes card, lut_grade.js), a clear day
// state (no variant letter) of a snow region (a region with snow in any of its states) that names a summer cube
// (mich, taim, mexico) takes the cube the region's other clear days use, or day_al_01 when they have none. Not a part
// of its own but a fact of the game folder, like the photo night skies' sky alpha: lod_patch.js makes the edit in
// every build of initial.pak while boot.pak holds the winter cube, and takes it out again when the stock cube is back.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { stateName } = require('./daytime_weather.js');
const { zipEntries } = require('./sky_stars.js');

const DAYTIME_ENTRY = /classes[\\/]daytimes[\\/]([^\\/]+)\.xml$/i;
const SUMMER_CUBE = /^env[\\/]day_(?:a_)?(?:mich|taim|mexico)_\d+__d_ggxrefl\.tga$/i;
const SNOW_CUBE = 'env/day_al_01__d_ggxrefl.tga';
const CUBE_PCT = 'env_day_al_01__d_ggxrefl.pct';   // the entry in boot.pak the winter cube replaces
const CUBES = process.env.SR_CUBES_DIR || path.join(__dirname, '..', 'replacements', 'cubes', 'pct');

const isCubeState = (entryName) => DAYTIME_ENTRY.test(entryName);
// the root tag of a state: the part of the text the edit may touch
function rootTag(text)
{
    const m = /<DayTimeState\b[^>]*>/.exec(text);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
}
const attr = (tag, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag); return m ? m[1] : null; };

// whether boot.pak holds the winter cube: its day_al_01 entry's CRC is that of the set's file (false when the set or
// the pak is missing, so a dev checkout without the set changes nothing)
function winterCubes(bootPak)
{
    const file = path.join(CUBES, CUBE_PCT);
    if (!fs.existsSync(file) || !fs.existsSync(bootPak)) return false;
    const want = zlib.crc32(fs.readFileSync(file)) >>> 0;
    const ent = zipEntries(bootPak).find((e) => e.name.toLowerCase().endsWith(CUBE_PCT));
    return !!ent && (ent.crc >>> 0) === want;
}
// what the whole pak tells: the snow regions, and for each the cube its clear days use (the most common one that is
// not a summer cube). entries: [{ name, text }] of the daytime files
function cubeContext(entries)
{
    const snowRegions = new Set(), clear = new Map();
    for (const { name, text } of entries)
    {
        const d = DAYTIME_ENTRY.exec(name), s = d && stateName(d[1]);
        if (!s) continue;
        if (/<WeatherParticles\b[^>]*\bType\s*=\s*"[^"]*snow/i.test(text)) snowRegions.add(s.region);
        const r = rootTag(text), env = r && attr(text.slice(r.start, r.end), 'EnvMap');
        if (!env || !s.segment.startsWith('day__') || s.variant || SUMMER_CUBE.test(env)) continue;
        if (!clear.has(s.region)) clear.set(s.region, new Map());
        clear.get(s.region).set(env, (clear.get(s.region).get(env) || 0) + 1);
    }
    const clearCube = new Map();
    for (const [region, counts] of clear) clearCube.set(region, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
    return { snowRegions, clearCube };
}
// the edit of one entry: { out, notes }, out === text when nothing changed
function cubeEdit(text, entryName, ctx)
{
    const notes = [], d = DAYTIME_ENTRY.exec(entryName), r = d && rootTag(text);
    if (!r) return { out: text, notes };
    const s = stateName(d[1]);
    if (!s || !ctx.snowRegions.has(s.region) || !s.segment.startsWith('day__') || s.variant) return { out: text, notes };
    const tag = text.slice(r.start, r.end).replace(/(\bEnvMap\s*=\s*")([^"]*)(")/, (all, open, value, close) =>
    {
        if (!SUMMER_CUBE.test(value)) return all;
        const next = ctx.clearCube.get(s.region) || SNOW_CUBE;
        const short = (v) => v.replace(/^env[\\/]/, '').replace(/__d_ggxrefl\.tga$/, '');
        notes.push('cube ' + short(value) + ' -> ' + short(next));
        return open + next + close;
    });
    return { out: text.slice(0, r.start) + tag + text.slice(r.end), notes };
}

module.exports = { isCubeState, cubeContext, cubeEdit, winterCubes, DAYTIME_ENTRY, SNOW_CUBE };
