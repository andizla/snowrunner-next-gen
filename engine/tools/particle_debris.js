// SPDX-License-Identifier: GPL-3.0-only
// Debris and splashes: what the wheels throw up lives longer and comes to rest. The game's particle types are small XML
// files in initial.pak, [media]\...\classes\particles\*.xml, one <CombineParticles> each. Three families, one rule each:
//   fragments  leaves, grass, twigs, dirt and stones thrown up by the wheels (fragments_grass*, fragments_leaves*,
//              fragments_twigs*, fragments_spruce_twigs, fragments_firs_road, fragments_dirt*, fragments_mushroom,
//              fragments_drilling). Stock they vanish after 3 or 4 seconds, in the air or on the ground. They now live
//              30 to 40 seconds (LifeTime 30, Random 10) and collide with the ground, the truck and its wheels
//              (Collisions: Enable, DetectWheels, DetectFullOcclusionBox, a 1 cm radius so a piece lies flat, a little
//              bounce); the friction a file has stays, a file without a collision block gets 0.5. Dandelion seeds
//              (fragments_dandelion) float, so they only live longer: 12 to 16 seconds.
//   splashes   mud, water and snow thrown by the wheels, and the dirt bursts (mud_splash_*, snow_splash_*,
//              water_burst_medium, water_splash_small, water_surf_splash*, water_flow, dirt_burst_*): a splash throws
//              DROPS times its drops (Subparticles Density, at least 12 x DROPS and at most 64 x DROPS), the drops lie
//              twice as long (ExtraLifeTime x2), the splash itself lasts twice as long (LifeTime x2) and leaves twice
//              the mud and water marks on the truck (MudDecals, WetDecals x2, at most 1).
//   puffs      exhaust, dust and steam (exhaust_small, exhaust_large, exhaust_fog, dust_small*, honk_dust, steam) hang
//              in the air half as long again (LifeTime and its Random x1.5).
//   snow       the snow splashes and bursts (snow_splash_*, dirt_burst_medium_snow, dirt_burst_medium_skid_snow) last
//              three times as long instead of twice, and the snow drops they throw (snow__subparticles,
//              snow_frag__subparticles) fall at half the gravity with 0.6 of the air resistance and live 15 seconds:
//              light snow hangs in the air, as it does.
// Nothing else changes: air resistance, gravity, wind, size, scale and the textures stay the game's. DROPS is the part's
// one number, 4 by default (an installer may offer 8). Every attribute written is one the game's own particle files use.
// lod_patch.js builds initial.pak with this edit next to the grass, the fill light, the stars and the weather
// (debris-install / debris-restore).
// usage: node particle_debris.js list [drops] [initial.pak]   what would change (default: 4 over pak_backup\initial.pak.orig)
'use strict';
const path = require('path');

const PARTICLE_ENTRY = /classes[\\/]particles[\\/]([^\\/]+)\.xml$/i;
const DEBRIS_FACTOR = 4;
const SETTLE = /^fragments_(grass|leaves|twigs|spruce_twigs|firs_road|dirt|mushroom|drilling)(_|$)/i;
const FLOAT = /^fragments_dandelion$/i;
const SPLASH = /^(mud_splash_(large|small)|snow_splash_(large|small)|water_burst_medium|water_splash_small|water_surf_splash2?|water_flow|dirt_burst_(large|medium(_snow|_fast|_skid|_skid_snow)?))$/i;
const PUFF = /^(exhaust_(small|large|fog)|dust_small(_autumn|_needles|_snow|_summer)?|honk_dust|steam)$/i;
const SNOW_SPLASH = /^(snow_splash_(large|small)|dirt_burst_medium(_skid)?_snow)$/i;   // splashes that get the snow life
const SNOW_DROPS = /^snow(_frag)?__subparticles$/i;
const FAMILIES = ['settle', 'float', 'splash', 'puff', 'snowdrops'];
// "30", "2.4", "0.5": no trailing zeros
const fmt = (v) => { const s = v.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '' || s === '-' ? '0' : s; };

const isDebrisEntry = (entryName) => PARTICLE_ENTRY.test(entryName);
// the drops factor as a number; throws on anything but 1 to 16
function debrisSpec(value)
{
    const d = Number(value);
    if (!(d >= 1 && d <= 16)) throw new Error('drops factor "' + value + '" (1 to 16)');
    return d;
}
// the family of a particle type by its file name, or null for one this part leaves alone
function family(base)
{
    if (SETTLE.test(base)) return 'settle';
    if (FLOAT.test(base)) return 'float';
    if (SPLASH.test(base)) return 'splash';
    if (PUFF.test(base)) return 'puff';
    if (SNOW_DROPS.test(base)) return 'snowdrops';
    return null;
}
// a vector attribute "(0; -2.5; 0)" times f
const vecTimes = (f) => (v) =>
{
    const m = /^\(\s*([^;]+);\s*([^;]+);\s*([^)]+)\)$/.exec(v || '');
    if (!m) return null;
    const next = '(' + m.slice(1).map((s) => fmt(Number(s) * f)).join('; ') + ')';
    return next === v ? null : next;
};

// one attribute of a tag's text ("<Name ... >" or "<Name ... />"): fn(value, or null when the tag has none) gives the
// new value, null leaves it. A missing attribute goes in right after the tag's name. notes gets "label old -> new"
function setAttr(tag, name, fn, notes, label)
{
    const m = new RegExp('(\\s' + name + '\\s*=\\s*")([^"]*)(")').exec(tag);
    if (m)
    {
        const next = fn(m[2]);
        if (next === null || next === m[2]) return tag;
        notes.push((label || name) + ' ' + m[2] + ' -> ' + next);
        return tag.slice(0, m.index) + m[1] + next + m[3] + tag.slice(m.index + m[0].length);
    }
    const next = fn(null);
    if (next === null) return tag;
    notes.push((label || name) + ' ' + next);
    const head = /^<[A-Za-z_][\w.]*/.exec(tag)[0];
    return head + ' ' + name + '="' + next + '"' + tag.slice(head.length);
}
// one line put in before the closing tag, indented and ended like the file's own lines
function insertBeforeClose(text, closeTag, line)
{
    const i = text.lastIndexOf(closeTag);
    if (i < 0) return text;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    const before = text.slice(lineStart, i).trim() === '' ? lineStart : i;
    return text.slice(0, before) + '\t' + line + nl + text.slice(before);
}

// the edit of one entry: { out, notes, kinds }, out === text when nothing changed. drops: debrisSpec()'s number
function debrisEdit(text, entryName, drops)
{
    const notes = [], kinds = new Set(), m = PARTICLE_ENTRY.exec(entryName), fam = m && family(m[1]);
    if (!fam || !/<CombineParticles\b/.test(text)) return { out: text, notes, kinds };
    let out = text;
    // the first tag of that name through fn(tag text); false when the file has none
    const tag = (name, fn) =>
    {
        const t = new RegExp('<' + name + '\\b[^>]*>').exec(out);
        if (!t) return false;
        const next = fn(t[0]);
        if (next !== t[0]) out = out.slice(0, t.index) + next + out.slice(t.index + t[0].length);
        return true;
    };
    // a value times f, capped: null (left) when the tag has none or it would not change
    const times = (f, cap) => (v) =>
    {
        if (v === null) return null;
        const n = Number(v);
        if (!(n > 0)) return null;
        const next = cap === undefined ? n * f : Math.min(n * f, cap);
        return next === n ? null : fmt(next);
    };
    if (fam === 'settle' || fam === 'float')
    {
        const [life, random] = fam === 'settle' ? ['30', '10'] : ['12', '4'];
        tag('LifeTime', (t) => setAttr(setAttr(t, 'Value', () => life, notes, 'life'), 'Random', () => random, notes, 'random'));
        if (fam === 'settle')
        {
            const on = [['Enable', 'true'], ['DetectWheels', 'true'], ['DetectFullOcclusionBox', 'true'], ['Radius', '0.01'], ['Restitution', '0.1']];
            const had = tag('Collisions', (t) =>
            {
                const set = [];
                for (const [k, v] of on) t = setAttr(t, k, () => v, set);
                t = setAttr(t, 'Friction', (v) => (v === null ? '0.5' : null), set);
                if (set.length) notes.push('collisions: ' + set.join(', '));
                return t;
            });
            if (!had)
            {
                out = insertBeforeClose(out, '</CombineParticles>', '<Collisions DetectFullOcclusionBox="true" DetectWheels="true" Enable="true" Friction="0.5" Radius="0.01" Restitution="0.1" />');
                notes.push('collisions on (ground and wheels, 1 cm)');
            }
        }
    }
    else if (fam === 'splash')
    {
        tag('Subparticles', (t) => setAttr(t, 'Density', (v) => (v === null ? null : fmt(Math.min(Math.max(Number(v) * drops, 12 * drops), 64 * drops))), notes, 'drops'));
        tag('ExtraLifeTime', (t) => setAttr(t, 'Value', times(2), notes, 'drops life'));
        tag('LifeTime', (t) => setAttr(t, 'Value', times(SNOW_SPLASH.test(m[1]) ? 3 : 2), notes, 'life'));
        tag('CombineParticles', (t) => setAttr(setAttr(t, 'MudDecals', times(2, 1), notes, 'mud marks'), 'WetDecals', times(2, 1), notes, 'wet marks'));
    }
    else if (fam === 'puff')
    {
        tag('LifeTime', (t) => setAttr(setAttr(t, 'Value', times(1.5), notes, 'life'), 'Random', times(1.5), notes, 'random'));
    }
    else if (fam === 'snowdrops')
    {
        tag('CombineParticles', (t) => setAttr(setAttr(t, 'Gravity', vecTimes(0.5), notes, 'gravity'), 'AirResistance', times(0.6), notes, 'air'));
        if (!tag('LifeTime', (t) => setAttr(t, 'Value', () => '15', notes, 'life'))) { out = insertBeforeClose(out, '</CombineParticles>', '<LifeTime Value="15" />'); notes.push('life 15'); }
    }
    if (out !== text) kinds.add(fam);
    return { out, notes, kinds };
}

module.exports = { isDebrisEntry, debrisEdit, debrisSpec, family, DEBRIS_FACTOR, FAMILIES, PARTICLE_ENTRY };

if (require.main === module)
{
    const [cmd, dropsArg, fileArg] = process.argv.slice(2);
    try
    {
        if (cmd !== 'list') { console.log('usage: node particle_debris.js list [drops] [initial.pak]'); return; }
        const fs = require('fs'), { readZip, readEntry } = require('./lod_patch.js');
        const drops = debrisSpec(dropsArg || DEBRIS_FACTOR);
        const file = fileArg || path.join(process.env.SR_STATE_DIR || path.join(__dirname, '..', 'pak_backup'), 'initial.pak.orig');
        const fd = fs.openSync(file, 'r');
        try
        {
            const z = readZip(fd), count = {};
            for (const ent of z.entries)
            {
                if (!isDebrisEntry(ent.name)) continue;
                const r = debrisEdit(readEntry(fd, ent).data.toString('latin1'), ent.name, drops);
                if (!r.kinds.size) continue;
                for (const k of r.kinds) count[k] = (count[k] || 0) + 1;
                console.log('  ' + [...r.kinds][0].padEnd(10) + PARTICLE_ENTRY.exec(ent.name)[1].padEnd(32) + r.notes.join('; '));
            }
            console.log(file + ': ' + FAMILIES.map((f) => f + ' ' + (count[f] || 0)).join(', ') + ' files changed (' + drops + 'x drops)');
        }
        finally { fs.closeSync(fd); }
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
