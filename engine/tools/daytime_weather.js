// Weather: more of what the game's own day and weather states carry. The game cycles each region through its day states
// and their variants (day__1, day__1a, on the newer maps up to day__1e; which one comes is the game's code). A state can
// carry rain or snow, <WeatherParticles Type MinIntensity MaxIntensity IntensityChangeInterval> (the intensity is drawn
// anew within the range every interval), and moving cloud shadows, <CloudShadowMap Map Scale Speed Direction>. Stock, 16
// regions have rain or snow in their variants, dusk and night weather only in the snow regions, and cloud shadows only on
// ru_17 and us_18 (39 of 199 states); the five cloud shadow maps sit in boot.pak, so every map can use them.
// The files are in initial.pak: [media]\...\classes\daytimes\*.xml (the states), ...\classes\skies\sky_*.xml (each
// region's sky layers), ...\classes\weather\*.xml (what a rain or snow type looks like). Five parts, each on its own:
//   shadows  cloud shadows in every day state that has none, the way ru_17 has them (scale 6, speed 2, direction
//            (1; 0.5)): the plain states the light map (cloud_shadow_01), the variants the medium one (02), the
//            variants with heavy rain or snow the dense one (03)
//   showers  the rain and snow of the day states swell and ease: a range (min, max) becomes (0.3 min, 1.2 max)
//   evening  the regions with rain in their day states get a light drizzle at dusk, at night and at dawn, the way the
//            snow regions have flurries then: light_rain 0 to 0.15 at dusk and dawn, 0 to 0.2 at night
//   horizon  the horizon cloud layer (env/cloud_01_horizon__d_a, frame sphere_ground) that 17 sky files hold commented
//            out, put in. The stock blocks name another region's states (sky_us_01's names us_02's), so the overrides are
//            written anew for the file's own states, each from the block's line for the same part of the day
//   far      rain and snow drawn out to 1.5 times as far from the camera (32 m -> 48 m)
//   fireflies  fireflies at night in the regions with rain in their day states (where the night has no weather of its
//            own; with the evening part their nights take the fireflies and the drizzle keeps to dusk and dawn)
//   pollen   pollen drifting in the clear day states of the same regions
//   Fireflies and pollen are weather types of the game's later engine (Expeditions: fireflies drawn to 90 m at an
//   intensity of 0.0005 to 0.001, pollen to 64 m at 0.01 to 0.05, its own 4-frame sprite). Here they are two new files
//   in classes\weather, with SnowRunner's own firefly sprite (boot.pak, sfx/particles_firefly__d_a, one frame).
// lod_patch.js builds initial.pak with this edit next to the grass, the fill light and the stars (weather-install /
// weather-restore). The parts go in as one comma list in that order, e.g. "shadows,showers".
// usage: node daytime_weather.js list [parts] [initial.pak]   what would change (default: every part over
//        pak_backup\initial.pak.orig)
'use strict';
const path = require('path');

const DAYTIME_ENTRY = /classes[\\/]daytimes[\\/]([^\\/]+)\.xml$/i;
const SKY_ENTRY = /classes[\\/]skies[\\/](sky_[^\\/]+)\.xml$/i;
const WEATHER_ENTRY = /classes[\\/]weather[\\/]([^\\/]+)\.xml$/i;
const PARTS = ['shadows', 'showers', 'evening', 'horizon', 'far', 'fireflies', 'pollen'];
const WEATHER_DEFAULT = 'shadows,showers,evening,horizon,far,fireflies,pollen';
const RAIN_SNOW = /^(light|heavy)_(rain|snow)(_|$)/i;
const SHADOW_LINE = (map) => '<CloudShadowMap Map="env/shadow_clouds/cloud_shadow_0' + map + '.tga" Scale="6" Speed="2.0" Direction="(1.0; 0.5)"/>';
const fmt = (v) => v.toFixed(3).replace(/\.?0+$/, '');
// the two new weather types: Expeditions' values, SnowRunner's firefly sprite
const insect = (color, distance) => ['<WeatherParticles', '\tColorMult="' + color + '"', '\tDrawDistance="' + distance + '"', '\tFallSpeed="0.2"', '\tLifeTime="30"',
    '\tTurbulenceIntensity="0.01"', '\tTurbulenceMagnitude="0.2"', '\tWind="(0.15; 0.1; 0.15)"', '>', '\t<Flying', '\t\tAvgSize="0.01"',
    '\t\tDiffuse="sfx/particles_firefly__d_a.tga"', '\t\tNumFramesX="1"', '\t\tRotationSpeed="3"', '\t\tIsAlignToVelocty="true"', '\t/>',
    '\t<Collided AgeIncreaseWater="5" />', '</WeatherParticles>', ''].join('\r\n');
const NEW_TYPES = {
    fireflies: { type: 'nextgen_fireflies', text: insect('g(247; 247; 10; 200) x 3000.9', 90), line: '<WeatherParticles Type="nextgen_fireflies" MinIntensity="0.0005" MaxIntensity="0.001" IntensityChangeInterval="30" />' },
    pollen: { type: 'nextgen_pollen', text: insect('g(247; 247; 10; 39) x 3.9', 64), line: '<WeatherParticles Type="nextgen_pollen" MinIntensity="0.01" MaxIntensity="0.05" IntensityChangeInterval="30" />' },
};
// the files those parts add: [{ name, text }]
const weatherAdds = (parts) => Object.keys(NEW_TYPES).filter((p) => parts.has(p)).map((p) => ({ name: '[media]\\classes\\weather\\' + NEW_TYPES[p].type + '.xml', text: NEW_TYPES[p].text }));

// "shadows, showers" -> Set of parts; throws on a part it does not know
function weatherSpec(spec)
{
    if (spec === null || spec === undefined || spec === '' || spec === true) return new Set(spec === true ? WEATHER_DEFAULT.split(',') : []);
    const set = new Set(String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const p of set) if (!PARTS.includes(p)) throw new Error('weather part "' + p + '" (the parts: ' + PARTS.join(', ') + ')');
    return set;
}
// the parts as one comma list in PARTS order, or null for none
function weatherCanonical(spec) { const s = weatherSpec(spec); return s.size ? PARTS.filter((p) => s.has(p)).join(',') : null; }

const isWeatherEntry = (entryName) => DAYTIME_ENTRY.test(entryName) || SKY_ENTRY.test(entryName) || WEATHER_ENTRY.test(entryName);

// a daytime state's name in parts: { segment: 'day__1' | 'day_to_night' | 'night_to_day' | 'night', variant: 'a' or '',
// region: 'us_01' }, or null for the menus' own states, the garage and the map screens
function stateName(name)
{
    if (/menu|garage|navigation/i.test(name)) return null;
    const m = /^(day__\d|day_to_night|night_to_day|night)([a-z]?)_(.+)$/i.exec(name);
    return m ? { segment: m[1].toLowerCase(), variant: m[2].toLowerCase(), region: m[3].toLowerCase() } : null;
}

// what the whole pak tells: the regions whose day states have rain. entries: [{ name, text }] of the daytime files
function weatherContext(entries)
{
    const rainRegions = new Set();
    for (const { name, text } of entries)
    {
        const d = DAYTIME_ENTRY.exec(name), s = d && stateName(d[1]);
        if (s && s.segment.startsWith('day__') && /<WeatherParticles\b[^>]*\bType="(?:light|heavy)_rain"/i.test(text)) rainRegions.add(s.region);
    }
    return { rainRegions };
}

// one line put in before the closing tag of the state, indented and ended like the file's own lines
function insertBeforeClose(text, closeTag, line)
{
    const i = text.lastIndexOf(closeTag);
    if (i < 0) return text;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    // the start of the closing tag's line: anything between it and the last newline is that line's indent
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    const before = text.slice(lineStart, i).trim() === '' ? lineStart : i;
    return text.slice(0, before) + '\t' + line + nl + text.slice(before);
}

// the horizon layer, put in: the commented block's own tag, and one override per state of the file's region, each
// copied from the block's line for the same part of the day (exact name, else the 'a' variant, else the plain state)
function horizonEdit(text, fileRegion, notes)
{
    const block = /<!--\s*(<Cloud\b[^>]*\bFrame="sphere_ground"[^>]*>)([\s\S]*?)(<\/Cloud>)\s*-->/.exec(text);
    if (!block) return text;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    // the block's overrides by part of the day ('day__1', 'day__1a', 'night', 'mainmenu', ...), whatever region they name
    const lines = new Map();
    for (const m of block[2].matchAll(/<DayTimeOverride\b([^>]*?)\/?>/g))
    {
        const dt = /\bDayTime="([^"]+)"/.exec(m[1]);
        if (!dt) continue;
        const key = dt[1].replace(/_(?:ru|us|ca)_\d+.*$/i, '').toLowerCase();
        lines.set(key, m[1].replace(/\s*\bDayTime="[^"]+"/, '').trim());
    }
    // the region's states: every DayTime this file names for its own region (the other layers list them all)
    const own = new Set();
    for (const m of text.matchAll(/\bDayTime="([^"]+)"/g)) if (m[1].toLowerCase().endsWith('_' + fileRegion)) own.add(m[1]);
    const out = [];
    for (const state of [...own].sort())
    {
        const key = state.slice(0, state.length - fileRegion.length - 1).toLowerCase();
        const seg = /^(day__\d)([a-z])$/.exec(key);
        const attrs = lines.get(key) || (seg && lines.get(seg[1] + 'a')) || (seg && lines.get(seg[1])) || (key === 'mainmenu' && lines.get('day__1')) || null;
        if (attrs) out.push('\t\t<DayTimeOverride DayTime="' + state + '" ' + attrs + ' />');
    }
    if (!out.length) return text;
    notes.push('horizon clouds in ' + out.length + ' states');
    return text.slice(0, block.index) + block[1] + nl + out.join(nl) + nl + '\t' + block[3] + text.slice(block.index + block[0].length);
}

// the edit of one entry: { out, notes, kinds }, out === text when nothing changed. parts: weatherSpec()'s Set; ctx:
// weatherContext()'s answer (the evening part needs it)
function weatherEdit(text, entryName, parts, ctx = { rainRegions: new Set() })
{
    const notes = [], kinds = new Set();
    let out = text;
    const d = DAYTIME_ENTRY.exec(entryName), sky = SKY_ENTRY.exec(entryName), def = WEATHER_ENTRY.exec(entryName);
    if (d)
    {
        const s = stateName(d[1]);
        if (!s) return { out, notes, kinds };
        const isDay = s.segment.startsWith('day__');
        if (parts.has('showers') && isDay)
            out = out.replace(/<WeatherParticles\b[^>]*>/g, (tag) =>
            {
                const type = /\bType="([^"]+)"/.exec(tag), lo = /\bMinIntensity="([^"]+)"/.exec(tag), hi = /\bMaxIntensity="([^"]+)"/.exec(tag);
                if (!type || !lo || !hi || !RAIN_SNOW.test(type[1]) || !(Number(hi[1]) < 10) || !(Number(lo[1]) >= 0)) return tag;
                const a = fmt(Number(lo[1]) * 0.3), b = fmt(Number(hi[1]) * 1.2);
                notes.push(type[1] + ' ' + lo[1] + '-' + hi[1] + ' -> ' + a + '-' + b);
                kinds.add('showers');
                return tag.replace(/\bMinIntensity="[^"]+"/, 'MinIntensity="' + a + '"').replace(/\bMaxIntensity="[^"]+"/, 'MaxIntensity="' + b + '"');
            });
        if (parts.has('shadows') && isDay && !/<CloudShadowMap\b/.test(out))
        {
            const w = /<WeatherParticles\b[^>]*\bType="([^"]+)"/.exec(out);
            const map = w && /^heavy_(rain|snow)/i.test(w[1]) ? 3 : (w && RAIN_SNOW.test(w[1])) || s.variant ? 2 : 1;
            const next = insertBeforeClose(out, '</DayTimeState>', SHADOW_LINE(map));
            if (next !== out) { out = next; notes.push('cloud shadows (map 0' + map + ')'); kinds.add('shadows'); }
        }
        const rainy = ctx.rainRegions.has(s.region), free = () => !/<WeatherParticles\b/.test(out);
        // the night goes to the fireflies when both parts are in; dusk and dawn keep the drizzle
        if (parts.has('evening') && !isDay && rainy && free() && !(s.segment === 'night' && parts.has('fireflies')))
        {
            const max = s.segment === 'night' ? '0.2' : '0.15';
            const next = insertBeforeClose(out, '</DayTimeState>', '<WeatherParticles Type="light_rain" MinIntensity="0.0" MaxIntensity="' + max + '" IntensityChangeInterval="30" />');
            if (next !== out) { out = next; notes.push('drizzle 0-' + max); kinds.add('evening'); }
        }
        if (parts.has('fireflies') && s.segment === 'night' && rainy && free())
        {
            const next = insertBeforeClose(out, '</DayTimeState>', NEW_TYPES.fireflies.line);
            if (next !== out) { out = next; notes.push('fireflies'); kinds.add('fireflies'); }
        }
        if (parts.has('pollen') && isDay && !s.variant && rainy && free())
        {
            const next = insertBeforeClose(out, '</DayTimeState>', NEW_TYPES.pollen.line);
            if (next !== out) { out = next; notes.push('pollen'); kinds.add('pollen'); }
        }
    }
    else if (sky && parts.has('horizon'))
    {
        const region = /^sky_(.+)$/i.exec(sky[1])[1].toLowerCase();
        const next = horizonEdit(out, region, notes);
        if (next !== out) { out = next; kinds.add('horizon'); }
    }
    else if (def && parts.has('far') && RAIN_SNOW.test(def[1]))
    {
        out = out.replace(/\bDrawDistance="(\d+(?:\.\d+)?)"/, (all, v) =>
        {
            const n = fmt(Number(v) * 1.5);
            notes.push('drawn to ' + n + ' m (was ' + v + ')');
            kinds.add('far');
            return 'DrawDistance="' + n + '"';
        });
    }
    return { out, notes, kinds };
}

module.exports = { isWeatherEntry, weatherEdit, weatherContext, weatherSpec, weatherCanonical, weatherAdds, stateName, PARTS, WEATHER_DEFAULT, DAYTIME_ENTRY };

if (require.main === module)
{
    const [cmd, specArg, fileArg] = process.argv.slice(2);
    try
    {
        if (cmd !== 'list') { console.log('usage: node daytime_weather.js list [parts] [initial.pak]'); return; }
        const fs = require('fs'), { readZip, readEntry } = require('./lod_patch.js');
        const parts = weatherSpec(specArg || PARTS.join(','));
        const file = fileArg || path.join(process.env.SR_STATE_DIR || path.join(__dirname, '..', 'pak_backup'), 'initial.pak.orig');
        const fd = fs.openSync(file, 'r');
        try
        {
            const z = readZip(fd), texts = [];
            for (const ent of z.entries) if (DAYTIME_ENTRY.test(ent.name)) texts.push({ name: ent.name, text: readEntry(fd, ent).data.toString('latin1') });
            const ctx = weatherContext(texts), count = {};
            console.log('regions with rain in their day states: ' + [...ctx.rainRegions].sort().join(', '));
            for (const ent of z.entries)
            {
                if (!isWeatherEntry(ent.name)) continue;
                const r = weatherEdit(readEntry(fd, ent).data.toString('latin1'), ent.name, parts, ctx);
                if (!r.kinds.size) continue;
                for (const k of r.kinds) count[k] = (count[k] || 0) + 1;
                const n = /([^\\/]+)\.xml$/i.exec(ent.name)[1];
                if (/us_01|ru_17|weather|sky_us_02/i.test(ent.name)) console.log('  ' + n.padEnd(30) + r.notes.join('; '));
            }
            console.log(file + ': ' + PARTS.filter((p) => parts.has(p)).map((p) => p + ' ' + (count[p] || 0)).join(', ') + ' files changed');
        }
        finally { fs.closeSync(fd); }
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
