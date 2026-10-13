// SPDX-License-Identifier: GPL-3.0-only
// The snow cubes in the day states: which reflection cube a state names while boot.pak holds our cubes. Each daytime
// state (initial.pak, [media]\...\classes\daytimes\*.xml) names a reflection cube,
// EnvMap="env/day_al_01__d_ggxrefl.tga", the painted sky that paint, glass and chrome mirror and that Sky ambient and
// Bounce light read the sky's and the ground's colour from. The game shares its cubes between regions, and two of its
// choices do not hold once the snow families' cubes (Alaska's and Scandinavia's) are photographs of snow (the
// Reflection cubes card, lut_grade.js):
// 1. Kola (ru_03) and Yukon (us_04) give their clear days 1 and 2 the Michigan summer cube (day_mich_01) and only day 3
//    the Alaska snow cube (day_al_01), which Alaska and Amur use for all three. A clear day state (no variant letter)
//    of a snow region (a region with snow in any of its states) that names a summer cube (mich, taim, mexico) takes the
//    cube the region's other clear days use, or day_al_01 when they have none.
// 2. Regions without snow name the snow cubes in a few states (a weather variant of Wisconsin names day_al_02, North
//    Carolina's dusk and dawn evn_al_01). Such a state takes the cube the region's other states of its kind use (clear
//    days, weather variants, dusk, dawn, night), or the cube of that kind from the family of the region's clear days
//    (day_taim_01 gives evn_taim_01).
// Not a part of its own but a fact of the game folder, like the photo night skies' sky alpha: lod_patch.js makes the
// edit in every build of initial.pak while boot.pak holds the winter cube, and takes it out again when the stock cube
// is back.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { stateName } = require('./daytime_weather.js');
const { zipEntries } = require('./sky_stars.js');

const DAYTIME_ENTRY = /classes[\\/]daytimes[\\/]([^\\/]+)\.xml$/i;
const SUMMER_CUBE = /^env[\\/]day_(?:a_)?(?:mich|taim|mexico)_\d+__d_ggxrefl\.tga$/i;
const SNOW_CUBE = 'env/day_al_01__d_ggxrefl.tga';
const SNOW_FAMILY = /^env\/[a-z_]+_(?:al|scand)_\d+__d_ggxrefl\.tga$/;   // the cubes that show snow: Alaska's and Scandinavia's
const CUBE_PCT = 'env_day_al_01__d_ggxrefl.pct';   // the entry in boot.pak the winter cube replaces
const CUBES = process.env.SR_CUBES_DIR || path.join(__dirname, '..', 'replacements', 'cubes', 'pct');
// how the game names a family's cube of a kind: day_a_taim_01, evn_taim_01, morning_taim_02, mrn_scand_01, nght_scand_01
const KIND_CUBE = { weather: 'day_a', day_to_night: '(?:evn|evening)', night_to_day: '(?:morning|mrn)', night: '(?:night|nght)' };

const isCubeState = (entryName) => DAYTIME_ENTRY.test(entryName);
const norm = (env) => env.toLowerCase().replace(/\\/g, '/');
// a state's kind for the cube it names: the clear days, their weather variants, dusk, dawn, night
const kindOf = (s) => s.segment.startsWith('day__') ? (s.variant ? 'weather' : 'clear') : s.segment;
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
// the set's cubes as the states name them, in lower case: 'env/day_al_01__d_ggxrefl.tga'
function setCubes()
{
    if (!fs.existsSync(CUBES)) return new Set();
    return new Set(fs.readdirSync(CUBES).filter((f) => /^env_.*__d_ggxrefl\.pct$/i.test(f)).map((f) => 'env/' + f.slice(4, -4).toLowerCase() + '.tga'));
}
// what the whole pak tells: the snow regions; for each the cube its clear days use (the most common one that is not a
// summer cube); for each region and kind of state the cube most of them name, the snow families' left out; every cube
// named. entries: [{ name, text }] of the daytime files
function cubeContext(entries)
{
    const snowRegions = new Set(), clear = new Map(), own = new Map(), named = new Set(), replaced = setCubes();
    const count = (map, key, env) => { if (!map.has(key)) map.set(key, new Map()); map.get(key).set(env, (map.get(key).get(env) || 0) + 1); };
    for (const { name, text } of entries)
    {
        const d = DAYTIME_ENTRY.exec(name), s = d && stateName(d[1]);
        if (!s) continue;
        if (/<WeatherParticles\b[^>]*\bType\s*=\s*"[^"]*snow/i.test(text)) snowRegions.add(s.region);
        const r = rootTag(text), env = r && attr(text.slice(r.start, r.end), 'EnvMap');
        if (!env) continue;
        named.add(norm(env));
        if (!SNOW_FAMILY.test(norm(env))) count(own, s.region + ' ' + kindOf(s), env);
        if (kindOf(s) === 'clear' && !SUMMER_CUBE.test(env)) count(clear, s.region, env);
    }
    const most = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const clearCube = new Map(), ownCube = new Map();
    for (const [region, counts] of clear) clearCube.set(region, most(counts));
    for (const [key, counts] of own) ownCube.set(key, most(counts));
    return { snowRegions, clearCube, ownCube, named, replaced };
}
// for a region without snow: the cube its own states of that kind name, or that kind's cube of its clear days' family
function ownKindCube(ctx, region, kind)
{
    const own = ctx.ownCube.get(region + ' ' + kind);
    if (own || kind === 'clear') return own || null;
    const family = /^env\/day_(?:a_)?([a-z]+)_\d+__/.exec(norm(ctx.ownCube.get(region + ' clear') || ''));
    if (!family) return null;
    const cube = new RegExp('^env/' + KIND_CUBE[kind] + '_' + family[1] + '_\\d+__d_ggxrefl\\.tga$');
    return [...ctx.named].filter((n) => cube.test(n)).sort()[0] || null;
}
// the edit of one entry: { out, notes }, out === text when nothing changed
function cubeEdit(text, entryName, ctx)
{
    const notes = [], d = DAYTIME_ENTRY.exec(entryName), r = d && rootTag(text);
    if (!r) return { out: text, notes };
    const s = stateName(d[1]);
    if (!s) return { out: text, notes };
    const snow = ctx.snowRegions.has(s.region), kind = kindOf(s);
    const tag = text.slice(r.start, r.end).replace(/(\bEnvMap\s*=\s*")([^"]*)(")/, (all, open, value, close) =>
    {
        let next = null;
        if (snow) { if (kind === 'clear' && SUMMER_CUBE.test(value)) next = ctx.clearCube.get(s.region) || SNOW_CUBE; }
        else if (SNOW_FAMILY.test(norm(value)) && ctx.replaced.has(norm(value))) next = ownKindCube(ctx, s.region, kind);
        if (!next || norm(next) === norm(value)) return all;
        const short = (v) => v.replace(/^env[\\/]/, '').replace(/__d_ggxrefl\.tga$/, '');
        notes.push('cube ' + short(value) + ' -> ' + short(next));
        return open + next + close;
    });
    return { out: text.slice(0, r.start) + tag + text.slice(r.end), notes };
}

module.exports = { isCubeState, cubeContext, cubeEdit, winterCubes, setCubes, DAYTIME_ENTRY, SNOW_CUBE };
