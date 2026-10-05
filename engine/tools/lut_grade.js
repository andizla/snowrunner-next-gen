// Photo grade: the colour part of the DLSS 5 look, folded into the game's own daytime colour LUTs. Measured on four
// pairs of screenshots, the game's own against DLSS 5 shots of the same scenes: the neural pass takes 13-21 % of the
// colour out, most from the greens (x0.70) and the autumn oranges (x0.75), less from sky blue (x0.86-0.9); whites land
// a little lower. What it does to shade is the fill light's part (daytime_fill.js); what it redraws (faces, fine
// texture) no grade can make.
// The game grades the final picture with a 16x16x16 LUT per daytime state (ColorLUT="lut/<name>__vol_uncmp.tga" ->
// boot.pak [textures]\pct\env_lut_<name>__vol_uncmp.pct), sampled with the display-encoded colour in the presentation
// composite (after our tonemap). The grade runs on each texel's output, so new LUT = grade(game's LUT): the game's own
// look stays underneath. Four LUTs carry the day states (day_us_01 64, identity 44, day_us_12 34, day_us_18 19 of the
// 161); garage, minimap and us_02_night stay.
// A .pct here: 82 header bytes ("TCIP" at 6; 32 bits per texel, 16 x 16 x 16 at 0x10), 4096 texels B, G, R, A with the
// red axis fastest, then green, then blue (the identity LUT holds index x 17), then 6 bytes (the file size among them).
// The entries are stored, so boot.pak is rewritten with the same sizes: unchanged entries copied raw (lod_patch.js's
// writer), the result read back and checked before it replaces boot.pak, built from pak_backup\boot.pak.orig.
// The same build carries Next Gen's second boot.pak part, sharper smoke and particles: the 40 sfx_* particle textures
// at twice the size (each .pct with its .pct_header; SR_PARTICLES_DIR, default replacements\particles\pct), written
// stored over their entries. The grade and the particles go on and off independently; both are built from the
// original each time.
// A third part is the night sky: the star map (env_skysphere_stars__d_a, from NASA's Deep Star Maps
// 2020: point stars and the Milky Way's glow, 8192 x 2048) and the two photo night skies of Scandinavia, Kola and
// Quebec (env_cloud_01_us_11s__s_d_a, env_cloud_01_ru_03s__s_d_a) with the same star points painted in and their share
// in the picture's alpha; each .pct with its .pct_header (the stock ones are 4096 x 1024), SR_SKY_DIR, default
// replacements\sky\pct, written the way the particle set is. The photo skies need their sky alpha raised in
// initial.pak: lod_patch.js does that in every build once boot.pak holds them, so `lod_patch.js initial-refresh`
// follows a sky-install or sky-restore.
// usage: node lut_grade.js status | list [strength] | install [strength] | restore | adopt | build <file> [strength]
//        [particles] [sky] | particles-status | particles-install | particles-restore | sky-status | sky-install |
//        sky-restore
//        (strength 0-1, 1 by default: the measured grade; SR_BOOT_PAK and SR_STATE_DIR as in the other tools;
//        install, restore and adopt with the game closed; adopt: another mod's boot.pak becomes the original, see adopt();
//        status answers for the grade as before ("grade <strength>", vanilla, changed, missing), particles-status for the
//        sprites (particles, none, changed, missing), sky-status for the night sky (sky, none, changed, missing); each
//        restore takes its own part out, the others staying as they are)
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { readZip, readEntry, writePak, cdHash, fileHash, keptName, flush, renameOver, swapIn, writeJson, readJson, built, withPending, finishAdopt } = require('./lod_patch.js');

const BOOT = process.env.SR_BOOT_PAK || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/boot.pak';
const STATE = process.env.SR_STATE_DIR || path.join(__dirname, '..', 'pak_backup');
if (process.env.SR_STATE_DIR) fs.mkdirSync(STATE, { recursive: true });
const ORIG = path.join(STATE, 'boot.pak.orig');
const NOTE = path.join(STATE, 'boot.pak.grade.json');
const TARGETS = ['day_us_01', 'day_us_12', 'day_us_18', 'identity'];
const ENTRY = (name) => new RegExp('[\\\\/]env_lut_' + name + '__vol_uncmp\\.pct$', 'i');
const HEAD = 82, TEXELS = 4096, SIZE = HEAD + TEXELS * 4 + 6;
const PARTICLES = process.env.SR_PARTICLES_DIR || path.join(__dirname, '..', 'replacements', 'particles', 'pct');
const SKY = process.env.SR_SKY_DIR || path.join(__dirname, '..', 'replacements', 'sky', 'pct');
const baseName = (n) => n.split(/[\\/]/).pop().toLowerCase();

// ---- the texture sets (particles, night sky) ---------------------------------------------------------------------
// a set's files by lower-case name (.pct and .pct_header)
function setFiles(dir, what)
{
    if (!fs.existsSync(dir)) throw new Error('no ' + what + ' set at ' + dir);
    const files = new Map();
    for (const f of fs.readdirSync(dir)) if (/\.pct(_header)?$/i.test(f)) files.set(f.toLowerCase(), path.join(dir, f));
    if (!files.size) throw new Error('the ' + what + ' set at ' + dir + ' is empty');
    return files;
}
// one value for a set's names and contents, kept in the note (a build of another set reads as needing a rebuild)
function setHash(files)
{
    const h = require('crypto').createHash('sha256');
    for (const [name, file] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(name + ':' + (zlib.crc32(fs.readFileSync(file)) >>> 0) + ';');
    return h.digest('hex').slice(0, 16);
}
const particleFiles = () => setFiles(PARTICLES, 'particle');
const particleSetHash = () => setHash(particleFiles());
const skyFiles = () => setFiles(SKY, 'night sky');
const skySetHash = () => setHash(skyFiles());

// ---- the grade ------------------------------------------------------------------------------------------------
// chroma gain by CIELAB hue (degrees), from the four pairs. The per-hue ratios (0 0.90, 30 0.78, 60 0.75, 90 0.80,
// 120 0.70, 150 0.75, 240 0.86, 270 0.82, 300 0.78; cyan and sky blue, few pixels and moved by the pass's hue shifts,
// held at 0.9) took out about 6 % more colour than DLSS 5 overall (ratios of pixels picked for strong colour in the
// game's shots read low), so they are eased by 3/4: over the four scenes the result lands on DLSS 5's colourfulness
// on average.
// Magenta-red (0) is left alone: the pass shifts reds' hue, and the ratio there took out too much in three scenes.
const HUE_GAIN = [[0, 1.0], [30, 0.84], [60, 0.81], [90, 0.85], [120, 0.78], [150, 0.81], [180, 0.92], [210, 0.92], [240, 0.90], [270, 0.87], [300, 0.84], [330, 0.92]];
function gainAt(h)
{
    const step = 360 / HUE_GAIN.length, k = Math.floor(h / step) % HUE_GAIN.length, t = (h - k * step) / step;
    const a = HUE_GAIN[k][1], b = HUE_GAIN[(k + 1) % HUE_GAIN.length][1], s = (1 - Math.cos(Math.PI * t)) / 2;
    return a + (b - a) * s;
}
// whites a little lower: lightness above 75 eased into 95 at the top
const shoulder = (L) => (L <= 75 ? L : 75 + (L - 75) * (1 - 0.2 * (L - 75) / 25));

const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
const enc = (c) => { c = Math.max(0, Math.min(1, c)); return (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255; };

// sRGB in (0-255), graded sRGB out (0-255, not rounded); strength 0 = unchanged, 1 = the measured grade
function gradeRgb(r, g, b, strength = 1)
{
    const R = toLin(r), G = toLin(g), B = toLin(b);
    const fx = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), fy = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B), fz = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    let L = 116 * fy - 16, A = 500 * (fx - fy), Bb = 200 * (fy - fz);
    const C = Math.hypot(A, Bb);
    if (C > 1e-6)
    {
        const h = (Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360;
        const k = 1 + (gainAt(h) - 1) * strength * Math.min(1, C / 4);   // eased in over the first 4 units: greys stay grey
        A *= k; Bb *= k;
    }
    L += (shoulder(L) - L) * strength;
    const gy = (L + 16) / 116, X = fInv(gy + A / 500) * 0.95047, Y = fInv(gy), Z = fInv(gy - Bb / 200) * 1.08883;
    return [enc(3.2406 * X - 1.5372 * Y - 0.4986 * Z), enc(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), enc(0.0557 * X - 0.2040 * Y + 1.0570 * Z)];
}

// ---- the LUTs --------------------------------------------------------------------------------------------------
function checkLut(data, name)
{
    if (data.length !== SIZE || data.toString('latin1', 6, 10) !== 'TCIP' || data.readUInt32LE(0x10) !== 16 || data.readUInt32LE(0x14) !== 16 || data.readUInt32LE(0x18) !== 16)
        throw new Error(name + ': not the 16x16x16 LUT layout this tool knows');
}
function gradeLut(data, strength)
{
    const next = Buffer.from(data);
    for (let i = 0; i < TEXELS; i++)
    {
        const o = HEAD + i * 4, c = gradeRgb(data[o + 2], data[o + 1], data[o], strength);
        next[o] = Math.round(c[2]); next[o + 1] = Math.round(c[1]); next[o + 2] = Math.round(c[0]);
    }
    return next;
}
// the build of `file` with these parts: { grade: strength or null, particles: true or false, sky: true or false }. The
// LUTs graded in place (stored, one size); each texture of a set over its entry, stored (the set's files, by name; every
// one must be there). A number for parts is the grade alone, as before.
function plan(file, parts)
{
    if (typeof parts === 'number') parts = { grade: parts, particles: false, sky: false };
    const strength = parts.grade || null;
    if (strength !== null && !(strength > 0 && strength <= 1)) throw new Error('strength ' + strength);
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd), jobs = new Map();
        let grow = 0;
        if (strength) for (const name of TARGETS)
        {
            const ent = z.entries.find((e) => ENTRY(name).test(e.name));
            if (!ent) throw new Error('boot.pak has no LUT ' + name);
            if (ent.method !== 0 || ent.flags !== 0) throw new Error(name + ': expected a stored entry');
            const { head, data } = readEntry(fd, ent);
            checkLut(data, name);
            const next = gradeLut(data, strength);
            jobs.set(ent, { head, crc: zlib.crc32(next), usize: next.length, length: next.length, comp: next, next, type: 'lut', group: 'lut', notes: [name] });
        }
        for (const [type, files] of [['particle', parts.particles ? particleFiles() : null], ['sky', parts.sky ? skyFiles() : null]])
        {
            if (!files) continue;
            let found = 0;
            for (const ent of z.entries)
            {
                const file = files.get(baseName(ent.name));
                if (!file) continue;
                if (ent.flags !== 0) throw new Error(ent.name + ': unexpected entry flags');
                const { head } = readEntry(fd, ent);
                const next = fs.readFileSync(file);
                jobs.set(ent, { head, crc: zlib.crc32(next) >>> 0, usize: next.length, length: next.length, comp: next, next, method: 0, type, group: type, notes: [baseName(ent.name)] });
                grow += next.length - ent.csize;
                found++;
            }
            if (found !== files.size) throw new Error('boot.pak has ' + found + ' of the ' + (type === 'sky' ? 'night sky' : 'particle') + ' set\'s ' + files.size + ' textures');
        }
        const end = z.cdOff + grow + z.cd.length + z.eocd.length;
        return { z, jobs, strength, particles: !!parts.particles, sky: !!parts.sky, size: grow ? (z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end) : z.size };
    }
    finally { fs.closeSync(fd); }
}
// the written boot.pak read back: same entries in the same order, every planned entry exactly as planned (stored where
// planned so), every other record unchanged (every 50th entry read and CRC checked)
function verify(file, p)
{
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd);
        if (z.entries.length !== p.z.entries.length) throw new Error('boot.pak: entry count changed');
        let sampled = 0;
        z.entries.forEach((ent, i) =>
        {
            const was = p.z.entries[i];
            if (ent.name !== was.name) throw new Error('boot.pak: entry order changed at ' + i);
            const job = p.jobs.get(was);
            if (job)
            {
                if (job.method !== undefined && ent.method !== job.method) throw new Error('entry not stored as planned: ' + ent.name);
                if (!readEntry(fd, ent).data.equals(job.next)) throw new Error(job.type + ' reads back wrong: ' + ent.name);
                return;
            }
            if (ent.crc !== was.crc || ent.csize !== was.csize || ent.usize !== was.usize || ent.method !== was.method) throw new Error('entry record changed: ' + ent.name);
            if (i % 50 === 0) { readEntry(fd, ent); sampled++; }
        });
        return sampled;
    }
    finally { fs.closeSync(fd); }
}

// ---- status, install, restore ----------------------------------------------------------------------------------------
const readNote = () => readJson(NOTE);
// the note's record of the build boot.pak holds now (lod_patch.js built(): the note itself, or the build that was going
// in when an install stopped); the note itself when boot.pak is none of them
const record = () => { const note = readNote(); return (fs.existsSync(BOOT) && built(note, cdHash(BOOT))) || note; };
const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
// what boot.pak is: 'ours' (this tool's build, the note says which parts), 'vanilla' (the original, or none kept yet),
// 'changed' (a game update, another tool) or 'missing'
function state()
{
    if (!fs.existsSync(BOOT)) return 'missing';
    const cur = cdHash(BOOT), note = readNote();
    if (built(note, cur)) return 'ours';
    if (!fs.existsSync(ORIG)) return 'vanilla';
    return (note.origCdSha256 || cdHash(ORIG)) === cur ? 'vanilla' : 'changed';
}
// the parts in boot.pak now (none when it is not this tool's build)
function partsNow()
{
    const note = record();
    return state() === 'ours' ? { grade: note.strength || null, particles: !!note.particles, sky: !!note.sky } : { grade: null, particles: false, sky: false };
}
// for the grade, as before: 'grade <strength>', 'vanilla' (no grade in it: the original, or a build of the particles
// alone), 'changed' or 'missing'
function status()
{
    const st = state();
    if (st !== 'ours') return st;
    const note = record();
    return note.strength ? 'grade ' + note.strength : 'vanilla';
}
// for the particles: 'particles', 'none', 'changed' or 'missing'
function particleStatus()
{
    const st = state();
    return st === 'ours' ? (record().particles ? 'particles' : 'none') : st === 'vanilla' ? 'none' : st;
}
// for the night sky: 'sky', 'none', 'changed' or 'missing'
function skyStatus()
{
    const st = state();
    return st === 'ours' ? (record().sky ? 'sky' : 'none') : st === 'vanilla' ? 'none' : st;
}
// boot.pak built from its original with these parts, or the original itself when neither is asked for. Refuses a file that
// is neither the original nor this tool's build (label names the caller), unless an adopt has just made it the base
function buildBoot(parts, label, adopted = false)
{
    const st = adopted ? 'ours' : state();
    if (st === 'missing') { console.log(label + ': no boot.pak, left alone'); return; }
    if (st === 'changed') { console.log(label + ': boot.pak is neither the original nor this tool\'s build (another tool or a game update): left alone'); return; }
    const tmp = BOOT + '.tmp';
    if (!parts.grade && !parts.particles && !parts.sky)
    {
        if (st !== 'ours') return;
        // the note keeps the last build's parts (adopt reads them)
        try { fs.copyFileSync(ORIG, tmp); swapIn(tmp, BOOT); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
        if (cdHash(BOOT) !== cdHash(ORIG)) throw new Error('boot.pak does not match its backup after the copy');
        console.log(label + ': the original boot.pak is back');
        return;
    }
    if (!fs.existsSync(ORIG))
    {
        const keep = ORIG + '.tmp';
        fs.copyFileSync(BOOT, keep);
        if (fileHash(keep) !== fileHash(BOOT)) { fs.unlinkSync(keep); throw new Error('the boot.pak copy differs'); }
        swapIn(keep, ORIG);
    }
    const p = plan(ORIG, parts);
    let note;
    try
    {
        writePak(ORIG, tmp, p);
        const sampled = verify(tmp, p);
        note = { origCdSha256: cdHash(ORIG), cdSha256: cdHash(tmp), size: p.size, date: stamp() };
        if (p.strength) Object.assign(note, { strength: p.strength, luts: TARGETS });
        if (p.particles) Object.assign(note, { particles: true, particleSet: particleSetHash() });
        if (p.sky) Object.assign(note, { sky: true, skySet: skySetHash() });
        writeJson(NOTE, withPending(readNote(), note));
        swapIn(tmp, BOOT);
        const has = [];
        if (p.strength) has.push(TARGETS.length + ' daytime LUTs graded at ' + Math.round(p.strength * 100) + ' %');
        const count = (type) => [...p.jobs.values()].filter((j) => j.type === type).length;
        if (p.particles) has.push(count('particle') + ' particle files at twice the size');
        if (p.sky) has.push('the night sky (' + count('sky') + ' files: the star map and the photo skies)');
        console.log(label + ': boot.pak now has ' + has.join(' and ') + ' (' + p.size + ' bytes, read back ok, ' + sampled + ' untouched entries sampled)');
    }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    writeJson(NOTE, note);
}
function install(strength) { buildBoot(Object.assign(partsNow(), { grade: strength }), 'photo grade'); }
function restore()
{
    const st = state();
    if (st !== 'ours' || !record().strength) { if (st === 'changed') console.log('photo grade: boot.pak changed by something else: left alone'); return; }
    buildBoot(Object.assign(partsNow(), { grade: null }), 'photo grade');
}
function particlesInstall() { buildBoot(Object.assign(partsNow(), { particles: true }), 'particles'); }
function particlesRestore()
{
    const st = state();
    if (st !== 'ours' || !record().particles) { if (st === 'changed') console.log('particles: boot.pak changed by something else: left alone'); return; }
    buildBoot(Object.assign(partsNow(), { particles: false }), 'particles');
}
function skyInstall() { buildBoot(Object.assign(partsNow(), { sky: true }), 'night sky'); }
function skyRestore()
{
    const st = state();
    if (st !== 'ours' || !record().sky) { if (st === 'changed') console.log('night sky: boot.pak changed by something else: left alone'); return; }
    buildBoot(Object.assign(partsNow(), { sky: false }), 'night sky');
}

// adopt: the current boot.pak becomes the original when something else changed it (another mod, a game update), so the
// parts go over that and restore puts it back. The old original is kept (boot.pak.orig.<date>). Each entry that still
// holds this tool's last build (exactly what it wrote: a graded LUT, a particle file) goes back to the old original's
// bytes in the new original, compression included; everything else, the other mod's changes and appended entries
// included, stays as it is. When some of the last build was still in, boot.pak is this tool's build of those parts over
// the new original afterwards and the status says so; else boot.pak is the new original and the status reads vanilla.
function adopt()
{
    const st = state();
    if (st === 'missing') { console.log('photo grade: no boot.pak, nothing to adopt'); return; }
    if (st === 'ours') { console.log('photo grade: boot.pak is this tool\'s own build: nothing to adopt'); return; }
    if (st === 'vanilla') { console.log('photo grade: boot.pak is already the original'); return; }
    const note = readNote(), had = { grade: note.strength || null, particles: !!note.particles, sky: !!note.sky };
    // what the last build wrote per entry name, with the old original's entry and bytes
    const last = new Map();
    if ((had.grade || had.particles || had.sky) && fs.existsSync(ORIG))
    {
        let p;
        try { p = plan(ORIG, had); }
        catch (err)
        {
            if (!had.particles && !had.sky) throw err;
            console.log('warning: the particle and night sky files of the last build could not be worked out again (' + err.message + '): those still in boot.pak stay in the new original');
            p = had.grade ? plan(ORIG, { grade: had.grade, particles: false, sky: false }) : { jobs: new Map() };
        }
        const fdo = fs.openSync(ORIG, 'r');
        try { for (const [ent, job] of p.jobs) last.set(ent.name, { job, ent, orig: readEntry(fdo, ent) }); } finally { fs.closeSync(fdo); }
    }
    const fd = fs.openSync(BOOT, 'r'), jobs = new Map(), still = { grade: null, particles: false, sky: false };
    let z, grow = 0;
    try
    {
        z = readZip(fd);
        for (const ent of z.entries)
        {
            const l = last.get(ent.name);
            if (!l || ent.flags !== 0 || ent.crc !== l.job.crc || ent.usize !== l.job.usize) continue;
            const cur = readEntry(fd, ent);
            if (!cur.data.equals(l.job.next)) continue;
            // still ours: the old original's compressed bytes and method under the current header
            jobs.set(ent, { head: cur.head, crc: l.ent.crc, usize: l.ent.usize, length: l.orig.raw.length, comp: l.orig.raw, next: l.orig.data, method: l.ent.method, type: l.job.type, group: l.job.group, notes: l.job.notes });
            grow += l.orig.raw.length - ent.csize;
            if (l.job.type === 'lut') still.grade = had.grade; else if (l.job.type === 'sky') still.sky = true; else still.particles = true;
        }
    }
    finally { fs.closeSync(fd); }
    // the new original, read back
    const tmp = ORIG + '.new';
    try
    {
        if (jobs.size)
        {
            const end = z.cdOff + grow + z.cd.length + z.eocd.length, p = { z, jobs, size: grow ? (z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end) : z.size };
            writePak(BOOT, tmp, p);
            verify(tmp, p);
        }
        else
        {
            fs.copyFileSync(BOOT, tmp);
            if (fileHash(tmp) !== fileHash(BOOT)) throw new Error('the boot.pak copy differs');
        }
        // the parts still in must be possible over the new original before anything is replaced
        if (still.grade || still.particles || still.sky) plan(tmp, still);
    }
    catch (err) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw err; }
    flush(tmp);
    const kept = keptName(ORIG);
    renameOver(ORIG, kept);
    renameOver(tmp, ORIG);
    const keptSay = '; the old original is kept as ' + path.basename(kept);
    writeJson(NOTE, { origCdSha256: cdHash(ORIG), date: stamp(), adopted: path.basename(kept) });
    if (!jobs.size)
    {
        console.log('photo grade: the current boot.pak is the new original (none of this tool\'s parts were in it' + keptSay + ')');
        return;
    }
    const parts = [still.grade ? 'grade' : null, still.particles ? 'particles' : null, still.sky ? 'night sky' : null].filter(Boolean), which = parts.join(' and ');
    console.log('photo grade: the current boot.pak is the new original (this tool\'s ' + which + (parts.length > 1 ? ' were' : ' was') + ' still in it: left out of the original; the other changes kept' + keptSay + ')');
    // boot.pak becomes this tool's build of those parts over the new original
    buildBoot(still, 'photo grade', true);
}

module.exports = { gradeRgb, gainAt, shoulder, HUE_GAIN, TARGETS, PARTICLES, SKY };

if (require.main === module)
{
    const [cmd, a1, a2] = process.argv.slice(2);
    try
    {
        finishAdopt(ORIG);
        if (cmd === 'status') console.log(status());
        else if (cmd === 'particles-status') console.log(particleStatus());
        else if (cmd === 'install') install(a1 ? Number(a1) : 1);
        else if (cmd === 'restore') restore();
        else if (cmd === 'particles-install') particlesInstall();
        else if (cmd === 'particles-restore') particlesRestore();
        else if (cmd === 'sky-status') console.log(skyStatus());
        else if (cmd === 'sky-install') skyInstall();
        else if (cmd === 'sky-restore') skyRestore();
        else if (cmd === 'adopt') adopt();
        else if (cmd === 'build' && a1)
        {
            // build <file> [strength, 0 = no grade] [particles] [sky]
            const strength = a2 === undefined ? 1 : Number(a2), rest = process.argv.slice(5), particles = rest.includes('particles'), sky = rest.includes('sky');
            const from = fs.existsSync(ORIG) ? ORIG : BOOT, p = plan(from, { grade: strength || null, particles, sky });
            writePak(from, a1, p);
            console.log('built ' + a1 + ' from ' + from + ': ' + (p.strength ? TARGETS.length + ' LUTs at ' + Math.round(p.strength * 100) + ' %' : 'no grade') + (p.particles ? ' and the particle set' : '') + (p.sky ? ' and the night sky' : '') + ', read back ok (' + verify(a1, p) + ' untouched entries sampled)');
        }
        else if (cmd === 'list')
        {
            const strength = a1 ? Number(a1) : 1;
            console.log('chroma gain by CIELAB hue at ' + Math.round(strength * 100) + ' %: ' + [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((h) => h + ':x' + (1 + (gainAt(h) - 1) * strength).toFixed(2)).join(' '));
            console.log('lightness: ' + [60, 75, 80, 85, 90, 95, 100].map((L) => L + '->' + (L + (shoulder(L) - L) * strength).toFixed(1)).join(' '));
            console.log('LUTs: ' + TARGETS.map((n) => 'env_lut_' + n + '__vol_uncmp.pct').join(', '));
        }
        else console.log('usage: node lut_grade.js status | list [strength] | install [strength] | restore | adopt | build <file> [strength] [particles] [sky] | particles-status | particles-install | particles-restore | sky-status | sky-install | sky-restore');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
