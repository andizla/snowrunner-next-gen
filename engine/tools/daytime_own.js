// SPDX-License-Identifier: GPL-3.0-only
// Days of its own for a region: a set of time-of-day states and a sky under the region's own number, so that a map which
// borrows another region's light can be given its own without changing the region it borrowed from. The game ships no
// states under these numbers. A set begins as a copy of the source region's states and sky as they stand in the build
// (the fill light, the weather and the rest already in them): the files under the new names, and in the sky file the
// state names of its DayTimeOverride entries renamed with them. The textures the files name (the colour table, the
// clouds) stay the source region's.
// The game knows a class file only when pak.load_list names it (load_list.js); lod_patch.js adds the files and their
// names to initial.pak, level_states.js then names the set in the map's level files.
//   us_06 (Maine) from us_01 (Michigan)
'use strict';
const OWN_DAYS = { us_06: 'us_01' };
const STATE = '(?:night_to_day|day_to_night|night|day__\\d[a-z]?)';

// "us_06" or a comma list -> the codes in the table's order as a comma list, null for none; throws on a code the table
// does not have
function ownSpec(spec)
{
    const set = new Set(String(spec || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    for (const c of set) if (!OWN_DAYS[c]) throw new Error('days of its own for "' + c + '" (the regions: ' + Object.keys(OWN_DAYS).join(', ') + ')');
    return Object.keys(OWN_DAYS).filter((c) => set.has(c)).join(',') || null;
}
const ownCodes = (spec) => (spec ? String(spec).split(',').filter(Boolean) : []);
// is this entry a state or the sky of the region `from`?
const ownSource = (name, from) => new RegExp('[\\\\/]classes[\\\\/](?:daytimes[\\\\/]' + STATE + '|skies[\\\\/]sky)_' + from + '\\.xml$', 'i').test(name);
// the entry's name under the region `to`
const ownName = (name, from, to) => name.slice(0, name.length - (from + '.xml').length) + to + '.xml';
// the file's text under the region `to`: a sky names its states; throws when a state name of `from` is left in it
function ownText(text, from, to)
{
    const out = text.replace(new RegExp('(\\bDayTime\\s*=\\s*"' + STATE + '_)' + from + '(")', 'g'), '$1' + to + '$2');
    if (new RegExp('\\b' + STATE + '_' + from + '\\b').test(out)) throw new Error('a file of ' + from + ' names its states in a way this tool does not know');
    return out;
}
// "[media]\classes\..." in the pak is "<media>\classes\..." in the load list
const listName = (name) => name.replace(/^\[([a-z_]+)\]/, '<$1>');

module.exports = { OWN_DAYS, ownSpec, ownCodes, ownSource, ownName, ownText, listName };
