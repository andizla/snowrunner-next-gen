// Next Gen logos: NEXT GEN under the game's logo wherever the interface shows it. Five textures in gfx.pak
// ([textures]\ui\flash_auto), shipped as files (replacements\splash\pct):
//   title_screen_ia      the title screen's logo, 2280 x 624 (the stock picture is 1140 x 312; the movie draws either
//                        at its own size). The logo sits where the stock has it: the movie plays a glint on the star.
//   loading_screen_i6b   the first loading screen, 3840 x 2160
//   main_menu_ie0        the main menu's logo, 1600 x 544
//   exit_menu_ia         the pause menu's sheet, 500 x 504: the logo is one sprite among others
//   minimap_i1           the map screen's sheet, 512 x 508: the same
// The first three are pictures of their own: the entry and its .pct_header are replaced, whatever was there. On the
// two sheets only the logo sprite changes: the textures are BC7, which keeps every 4 x 4 block of texels in 16 bytes
// of its own, so the sprite's blocks are copied out of our build into the sheet the pak holds and every other sprite
// stays bit for bit, the game's or another interface mod's. A sheet of another size or format is left as it is.
// gfx.pak is built from its original (pak_backup\gfx.pak.orig, kept at the first install; SR_STATE_DIR moves it) in
// one pass, read back and checked before it replaces the file, like boot.pak in lut_grade.js.
// With "intro" the build also starts the game without its intro, on the Next Gen splash (gfx_intro.js).
// usage: node gfx_logos.js status | list [intro] | install [intro] | restore | adopt | build <file> [intro]
//        status: logos (logos intro with the start without the intro), vanilla, changed (another tool or a game update
//        wrote gfx.pak since) or missing
//        adopt: a changed gfx.pak becomes the original, with whatever of the last build is still in it taken out
//        SR_GFX_PAK and SR_LOGOS_DIR point at another gfx.pak and another set (default replacements\splash\pct);
//        install, restore and adopt with the game closed
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { readZip, readEntry, writePak, cdHash, fileHash, keptName, flush, renameOver, swapIn, keepCopy, writeJson, readJson, built, withPending, finishAdopt } = require('./lod_patch.js');
const { patchIntro } = require('./gfx_intro.js');

const GFX = process.env.SR_GFX_PAK || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/gfx.pak';
const STATE = process.env.SR_STATE_DIR || path.join(__dirname, '..', 'pak_backup');
if (process.env.SR_STATE_DIR) fs.mkdirSync(STATE, { recursive: true });
const ORIG = path.join(STATE, 'gfx.pak.orig');
const NOTE = path.join(STATE, 'gfx.pak.logos.json');
const LOGOS = process.env.SR_LOGOS_DIR || path.join(__dirname, '..', 'replacements', 'splash', 'pct');
const WHOLE = ['title_screen_ia', 'loading_screen_i6b', 'main_menu_ie0'];
// the sheets: their size and the logo sprite's rectangle in texels (multiples of 4). Around it both the game's sheet
// and our build hold nothing: the rows between the sprites above and below, the columns left of the next sprite
const SHEETS = {
    exit_menu_ia: { w: 500, h: 504, x0: 0, y0: 312, x1: 400, y1: 444 },
    minimap_i1: { w: 512, h: 508, x0: 0, y0: 0, x1: 400, y1: 132 },
};
const HEAD = 82, TAIL = 6;   // a one-mip .pct: 82 header bytes, the blocks, 6 bytes
const baseName = (n) => n.split(/[\\/]/).pop().toLowerCase();

// the set's files by lower-case name; every one of the eight must be there
function logoFiles()
{
    const files = new Map();
    for (const t of WHOLE) for (const e of ['.pct', '.pct_header']) files.set(t + e, path.join(LOGOS, t + e));
    for (const t of Object.keys(SHEETS)) files.set(t + '.pct', path.join(LOGOS, t + '.pct'));
    for (const [name, file] of files) if (!fs.existsSync(file)) throw new Error('the logo set at ' + LOGOS + ' lacks ' + name);
    return files;
}
function setHash()
{
    const h = require('crypto').createHash('sha256');
    for (const [name, file] of [...logoFiles()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(name + ':' + (zlib.crc32(fs.readFileSync(file)) >>> 0) + ';');
    return h.digest('hex').slice(0, 16);
}
// our sheet's logo blocks in a copy of the pak's sheet; null when the pak's sheet has another size or header
function patchSheet(cur, ours, s)
{
    const bw = Math.ceil(s.w / 4), bh = Math.ceil(s.h / 4);
    if (ours.length !== HEAD + bw * bh * 16 + TAIL) throw new Error('our sheet is not ' + s.w + ' x ' + s.h + ' BC7');
    if (cur.length !== ours.length || !cur.subarray(0, HEAD).equals(ours.subarray(0, HEAD))) return null;
    const next = Buffer.from(cur);
    for (let by = s.y0 >> 2; by < s.y1 >> 2; by++)
    {
        const from = HEAD + (by * bw + (s.x0 >> 2)) * 16, to = HEAD + (by * bw + (s.x1 >> 2)) * 16;
        ours.copy(next, from, from, to);
    }
    return next;
}

// the build of `file` with the logos, and with `intro` the start without the intro (gfx_intro.js): { z, jobs, size,
// left, intro } (left: the sheets it could not take; intro: whether the start-up movie took its edits)
function plan(file, intro = false)
{
    const files = logoFiles(), fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd), jobs = new Map(), left = [], seen = new Set();
        let grow = 0, introIn = false;
        for (const ent of z.entries)
        {
            if (intro && /(^|[\\/])gfxbundle\.gfxbundle$/i.test(ent.name))
            {
                if (ent.flags !== 0) throw new Error(ent.name + ': unexpected entry flags');
                const { head, data } = readEntry(fd, ent), r = patchIntro(data);
                if (r.found < r.all) { left.push('intro'); continue; }
                introIn = true;
                if (r.done === r.all && ent.method === 0) continue;
                jobs.set(ent, { head, crc: zlib.crc32(r.data) >>> 0, usize: r.data.length, length: r.data.length, comp: r.data, next: r.data, method: 0, type: 'intro', group: 'logo', notes: ['the start without the intro'] });
                grow += r.data.length - ent.csize;
                continue;
            }
            const name = baseName(ent.name), source = files.get(name);
            if (!source) continue;
            if (ent.flags !== 0) throw new Error(ent.name + ': unexpected entry flags');
            seen.add(name);
            const { head, data } = readEntry(fd, ent), ours = fs.readFileSync(source), sheet = SHEETS[name.replace(/\.pct$/, '')];
            const next = sheet ? patchSheet(data, ours, sheet) : ours;
            if (!next) { left.push(name.replace(/\.pct$/, '')); continue; }
            if (next.equals(data) && ent.method === 0) continue;
            jobs.set(ent, { head, crc: zlib.crc32(next) >>> 0, usize: next.length, length: next.length, comp: next, next, method: 0, type: sheet ? 'sheet' : 'picture', group: 'logo', notes: [name] });
            grow += next.length - ent.csize;
        }
        // a picture this game version lacks (renamed or gone in an update) is left out with a warning instead of stopping every
        // Apply (review 3, N5)
        const missing = [...files.keys()].filter((name) => !seen.has(name));
        if (intro && !introIn && !left.includes('intro')) left.push('intro');
        const end = z.cdOff + grow + z.cd.length + z.eocd.length;
        return { z, jobs, left, missing, intro: introIn, size: z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end };
    }
    finally { fs.closeSync(fd); }
}
// the written gfx.pak read back: the same entries in the same order, every planned one exactly as planned and stored,
// every other record unchanged (every 50th read and CRC checked)
function verify(file, p)
{
    const fd = fs.openSync(file, 'r');
    try
    {
        const z = readZip(fd);
        if (z.entries.length !== p.z.entries.length) throw new Error('gfx.pak: entry count changed');
        let sampled = 0;
        z.entries.forEach((ent, i) =>
        {
            const was = p.z.entries[i];
            if (ent.name !== was.name) throw new Error('gfx.pak: entry order changed at ' + i);
            const job = p.jobs.get(was);
            if (job)
            {
                if (job.method !== undefined && ent.method !== job.method) throw new Error('entry not stored as planned: ' + ent.name);
                if (!readEntry(fd, ent).data.equals(job.next)) throw new Error('logo reads back wrong: ' + ent.name);
                return;
            }
            if (ent.crc !== was.crc || ent.csize !== was.csize || ent.usize !== was.usize || ent.method !== was.method) throw new Error('entry record changed: ' + ent.name);
            if (i % 50 === 0) { readEntry(fd, ent); sampled++; }
        });
        return sampled;
    }
    finally { fs.closeSync(fd); }
}

const readNote = () => readJson(NOTE);
const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
// 'ours' (this tool's build), 'vanilla' (the original, or none kept yet), 'changed' or 'missing'
function state()
{
    if (!fs.existsSync(GFX)) return 'missing';
    const cur = cdHash(GFX), note = readNote();
    if (built(note, cur)) return 'ours';
    if (!fs.existsSync(ORIG)) return 'vanilla';
    return (note.origCdSha256 || cdHash(ORIG)) === cur ? 'vanilla' : 'changed';
}
// 'logos', 'logos intro' (the start without the intro as well), or the state
const status = () => { const st = state(); if (st !== 'ours') return st; const rec = built(readNote(), cdHash(GFX)); return rec && rec.intro ? 'logos intro' : 'logos'; };

// gfx.pak built from its original with the logos, and with `intro` the start without the intro. Refuses a file that is
// neither the original nor this tool's build, unless an adopt has just made it the base
function install(adopted = false, intro = false)
{
    const st = adopted ? 'ours' : state();
    if (st === 'missing') { console.log('logos: no gfx.pak, left alone'); return; }
    if (st === 'changed') { console.log('logos: gfx.pak is neither the original nor this tool\'s build (another tool or a game update): left alone'); return; }
    if (!fs.existsSync(ORIG))
    {
        keepCopy(GFX, ORIG, 'the original gfx.pak');
    }
    const p = plan(ORIG, intro), tmp = GFX + '.tmp';
    let next;
    try
    {
        writePak(ORIG, tmp, p);
        const sampled = verify(tmp, p);
        next = { origCdSha256: cdHash(ORIG), cdSha256: cdHash(tmp), size: p.size, date: stamp(), logos: true, intro: p.intro, set: setHash(), left: p.left };
        writeJson(NOTE, withPending(readNote(), next));
        swapIn(tmp, GFX);
        const sheets = [...p.jobs.values()].filter((j) => j.type === 'sheet').length, sheetsLeft = p.left.filter((l) => l !== 'intro');
        console.log('logos: gfx.pak now has the Next Gen logo on the title screen, the loading screen and the main menu' + (sheets ? ' and in ' + sheets + ' of the 2 menu sheets' : '') +
            (p.intro ? ', and the game starts with the Next Gen splash, without its intro' : '') +
            (sheetsLeft.length ? ' (left as they are, another layout: ' + sheetsLeft.join(', ') + ')' : '') + ' (' + p.size + ' bytes, read back ok, ' + sampled + ' untouched entries sampled)');
        if (sheetsLeft.length) console.log('warning: the Next Gen logo is not in ' + sheetsLeft.join(' and ') + ': this game version lays ' + (sheetsLeft.length > 1 ? 'these sheets' : 'this sheet') + ' out another way');
        if (p.left.includes('intro')) console.log('warning: the intro stays: this game version\'s start-up movie is not the one the edits were made for');
        if (p.missing.length) console.log('warning: gfx.pak has no ' + p.missing.join(', ') + ' (renamed or gone in a game update): the Next Gen logo is left out there');
    }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    writeJson(NOTE, next);
}
function restore()
{
    const st = state();
    if (st !== 'ours') { if (st === 'changed') console.log('logos: gfx.pak changed by something else: left alone'); return; }
    const tmp = GFX + '.tmp', kept = readNote().origCdSha256;
    // the kept original against the hash noted for it: a backup damaged on disk does not go into the game
    if (kept && cdHash(ORIG) !== kept) throw new Error('the kept gfx.pak.orig is not the file it was when it was kept: gfx.pak left as it is');
    // the note keeps the last build (adopt reads it)
    try { fs.copyFileSync(ORIG, tmp); swapIn(tmp, GFX); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    if (cdHash(GFX) !== cdHash(ORIG)) throw new Error('gfx.pak does not match its backup after the copy');
    console.log('logos: the original gfx.pak is back');
}
// adopt: the current gfx.pak becomes the original when something else changed it (an interface mod, a game update). The
// old original is kept (gfx.pak.orig.<date>). Each entry that still holds exactly what the last build wrote goes back
// to the old original's bytes in the new original; everything else stays as it is. When some of the last build was
// still in, gfx.pak is this tool's build over the new original afterwards; else it is the new original.
function adopt()
{
    const st = state();
    if (st === 'missing') { console.log('logos: no gfx.pak, nothing to adopt'); return; }
    if (st === 'ours') { console.log('logos: gfx.pak is this tool\'s own build: nothing to adopt'); return; }
    if (st === 'vanilla') { console.log('logos: gfx.pak is already the original'); return; }
    const note = readNote(), last = new Map();
    if (note.logos && fs.existsSync(ORIG))
    {
        const p = plan(ORIG, !!note.intro), fdo = fs.openSync(ORIG, 'r');
        try { for (const [ent, job] of p.jobs) last.set(ent.name, { job, ent, orig: readEntry(fdo, ent) }); } finally { fs.closeSync(fdo); }
    }
    const fd = fs.openSync(GFX, 'r'), jobs = new Map();
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
            jobs.set(ent, { head: cur.head, crc: l.ent.crc, usize: l.ent.usize, length: l.orig.raw.length, comp: l.orig.raw, next: l.orig.data, method: l.ent.method, type: l.job.type, group: 'logo', notes: l.job.notes });
            grow += l.orig.raw.length - ent.csize;
        }
    }
    finally { fs.closeSync(fd); }
    const tmp = ORIG + '.new';
    try
    {
        if (jobs.size)
        {
            const end = z.cdOff + grow + z.cd.length + z.eocd.length, p = { z, jobs, size: z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end };
            writePak(GFX, tmp, p);
            verify(tmp, p);
            plan(tmp);   // the logos must be possible over the new original before anything is replaced
        }
        else
        {
            fs.copyFileSync(GFX, tmp);
            if (fileHash(tmp) !== fileHash(GFX)) throw new Error('the gfx.pak copy differs');
        }
    }
    catch (err) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw err; }
    let keptSay = '';
    flush(tmp);
    if (fs.existsSync(ORIG)) { const kept = keptName(ORIG); renameOver(ORIG, kept); keptSay = '; the old original is kept as ' + path.basename(kept); }
    renameOver(tmp, ORIG);
    writeJson(NOTE, { origCdSha256: cdHash(ORIG), date: stamp() });
    if (!jobs.size) { console.log('logos: the current gfx.pak is the new original (none of this tool\'s logos were in it' + keptSay + ')'); return; }
    console.log('logos: the current gfx.pak is the new original (this tool\'s logos were still in it: left out of the original; the other changes kept' + keptSay + ')');
    install(true, !!note.intro);
}

module.exports = { plan, patchSheet, SHEETS, WHOLE, LOGOS };

if (require.main === module)
{
    const [cmd, a1] = process.argv.slice(2);
    try
    {
        finishAdopt(ORIG);
        if (cmd === 'status') console.log(status());
        else if (cmd === 'install') install(false, a1 === 'intro');
        else if (cmd === 'restore') restore();
        else if (cmd === 'adopt') adopt();
        else if (cmd === 'list' || (cmd === 'build' && a1))
        {
            const from = cmd === 'build' && fs.existsSync(ORIG) ? ORIG : GFX, p = plan(from, process.argv.includes('intro'));
            for (const [ent, job] of p.jobs) console.log('  ' + baseName(ent.name).padEnd(30) + (job.type === 'sheet' ? ' the logo sprite\'s blocks' : ' replaced') + ', ' + ent.usize + ' -> ' + job.usize + ' bytes');
            if (p.left.length) console.log('  left as they are (another layout): ' + p.left.join(', '));
            if (cmd === 'list') console.log(p.jobs.size + ' entries would change in ' + from);
            else { writePak(from, a1, p); console.log('built ' + a1 + ' from ' + from + ', read back ok (' + verify(a1, p) + ' untouched entries sampled)'); }
        }
        else console.log('usage: node gfx_logos.js status | list [intro] | install [intro] | restore | adopt | build <file> [intro]');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
