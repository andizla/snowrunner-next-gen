// SPDX-License-Identifier: GPL-3.0-only
// Days of its own for a map: a set of time-of-day states and a sky under a number of its own, so that a map which
// borrows another region's light can have one that fits it, without changing the region it borrowed from. The numbers
// are ones no region of the game uses, so a later game update cannot ship a state of the same name. A set is made from
// a source region's states and sky as they stand in the build (the fill light, the weather and the rest already in
// them): the files under the new names, the state names of the sky's DayTimeOverride entries renamed with them, and
// the weather particles of the states changed as the table says. The textures the files name (the colour table, the
// clouds, the reflection cubes) stay the source region's.
// The game knows a class file only when pak.load_list names it (load_list.js); lod_patch.js adds the files and their
// names to initial.pak, level_states.js then names the set in the map's level file.
// The sets (the choices, from the game's own maps and the region's season: Maine is spring):
//   us_91  Maine, The Lowland: Michigan's days (us_01) as they are, wet and muddy without snow. The map has no more
//          snow and ice in its textures than Michigan's. (Scandinavia, the wiki's other spring region, is late winter
//          in the game: snow, not a thaw.)
//   us_92  Maine, Yellowrock National Forest: Yukon's spring (us_04), its blizzards turned to flurries (light snow at
//          0.4 of the strength). The map has two to four times the snow and ice of The Lowland, and Yukon is the
//          game's snowy spring region.
'use strict';
const OWN_DAYS = {
    us_91: { from: 'us_01' },
    us_92: { from: 'us_04', weather: { heavy_snow: ['light_snow', 0.4] } },
};
const STATE = '(?:night_to_day|day_to_night|night|day__\\d[a-z]?)';

// "us_91" or a comma list -> the codes in the table's order as a comma list, null for none; throws on a code the table
// does not have
function ownSpec(spec)
{
    const set = new Set(String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const c of set) if (!OWN_DAYS[c]) throw new Error('days of its own for "' + c + '" (the sets: ' + Object.keys(OWN_DAYS).join(', ') + ')');
    return Object.keys(OWN_DAYS).filter((c) => set.has(c)).join(',') || null;
}
const ownCodes = (spec) => (spec ? String(spec).split(',').filter(Boolean) : []);
// is this entry a state or the sky of the region `from`?
const ownSource = (name, from) => new RegExp('[\\\\/]classes[\\\\/](?:daytimes[\\\\/]' + STATE + '|skies[\\\\/]sky)_' + from + '\\.xml$', 'i').test(name);
// the entry's name under the set `to`
const ownName = (name, from, to) => name.slice(0, name.length - (from + '.xml').length) + to + '.xml';
// the weather particles of a state as the set's table says: another type, the strengths scaled
function ownWeather(text, map)
{
    return text.replace(/<WeatherParticles\b[^>]*>/g, (el) =>
    {
        const m = /\bType\s*=\s*"([a-z_0-9]+)"/.exec(el), to = m && map[m[1]];
        if (!to) return el;
        const [type, k] = to;
        return el.replace(/(\bType\s*=\s*")[a-z_0-9]+(")/, '$1' + type + '$2')
            .replace(/(\b(?:Min|Max)Intensity\s*=\s*")([0-9.]+)(")/g, (all, a, v, b) => (k === 1 ? all : a + String(Math.round(Number(v) * k * 1000) / 1000) + b));
    });
}
// the file's text under the set `to`: a sky names its states, a state has its weather; throws when a state name of
// `from` is left in it
function ownText(text, from, to)
{
    const out = ownWeather(text.replace(new RegExp('(\\bDayTime\\s*=\\s*"' + STATE + '_)' + from + '(")', 'g'), '$1' + to + '$2'), OWN_DAYS[to].weather || {});
    if (new RegExp('\\b' + STATE + '_' + from + '\\b').test(out)) throw new Error('a file of ' + from + ' names its states in a way this tool does not know');
    return out;
}
// "[media]\classes\..." in the pak is "<media>\classes\..." in the load list
const listName = (name) => name.replace(/^\[([a-z_]+)\]/, '<$1>');

module.exports = { OWN_DAYS, ownSpec, ownCodes, ownSource, ownName, ownText, ownWeather, listName };
