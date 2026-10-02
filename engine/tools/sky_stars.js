// Brighter stars: the night sky's star layer times one factor. The stars are a layer of each region's sky
// (initial.pak, [media]\...\classes\skies\sky_*.xml):
//   <Cloud DiffuseMap="env/skysphere_stars__d_a.tga" DiffuseMultiplier="g(255; 255; 255; 255) x 5" Frame="sphere_stars" ...>
//       <DayTimeOverride DayTime="night_us_01" DiffuseMap="env/skysphere_stars__d_a.tga" DiffuseMultiplier="g(255; 255; 255; 110) x 0.5" />
// and the night states draw it at x 0.07 to x 0.5 in most regions: levels set for the stock texture's one-texel stars
// (4096 x 1024). Next Gen's star map (NASA's Deep Star Maps, 8192 x 2048, point stars) puts about a quarter of the
// light into each star: at the stock levels they come out at 1 to 2 nits, the brightest at 6 to 9, on a 0.15 to 0.4
// nit sky. The texture's alpha is at its 8-bit ceiling for the bright ones, so the level is raised here. A value is
// "g(r; g; b; a) x N": N scales the colour alone (the stock sun disc is "g(255; 244; 210; 80) x 80"), the alpha is
// a / 255; the sky shader's output is the colour weighted by the alpha.
//
// 1. The star texture's own skies: N times the factor in every override of the star layer whose map is the star
//    texture (a value without a multiplier gets " x <factor>"): the nights, and dusk and dawn where a region shows
//    stars at those states. States with no map (the days, most dusks and dawns) draw nothing and stay.
// 2. The photo night skies (env/cloud_01_us_11s__s_d_a: Scandinavia; env/cloud_01_ru_03s__s_d_a: Kola and Quebec):
//    one picture holds the aurora photo and the stars, so N would brighten the photo too. The stars' share is in the
//    picture's alpha instead (the sky set's builds of them: alpha 85 where a texel is all photo, up to
//    255 on star points), and here the layer's alpha goes up PHOTO_FACTOR = 3 times (50 -> 150, 39 -> 117): the photo
//    as before (85 x 150 = 255 x 50), the star points three times as bright. Only for a picture whose build in
//    boot.pak carries that alpha (photoSkies below, by the entry's CRC): with the old picture the photo itself would
//    come out three times as dense. The factor of part 1 does not reach these skies: their 3 is in the texture.
// lod_patch.js builds initial.pak with this edit next to the grass and the fill light (stars-install / stars-restore).
// usage: node sky_stars.js list [factor] [initial.pak] [boot.pak]   what would change (default pak_backup\initial.pak.orig
//        and the game's boot.pak)
'use strict';
const fs = require('fs'), path = require('path');

const SKY_ENTRY = /classes[\\/]skies[\\/]sky_[^\\/]+\.xml$/i;
const STAR_MAP = /^env[\\/]skysphere_stars__d_a\.tga$/i;
const PHOTO_MAP = /^env[\\/](cloud_01_(?:us_11s|ru_03s)__s_d_a)\.tga$/i;
const STARS_FACTOR = 3;   // the default: stars three times as bright
const PHOTO_FACTOR = 3;   // fixed: photo_star_alpha.py's K (the pictures' alpha floor is 255 / 3)
// the builds of the photo skies with the stars' share in their alpha: boot.pak [textures]/pct/env_<name>.pct, CRC-32
const PHOTO_PCT = { cloud_01_us_11s__s_d_a: ['4977bc62'], cloud_01_ru_03s__s_d_a: ['516ff855'] };

const isSkyEntry = (entryName) => SKY_ENTRY.test(entryName);
const fmt = (v) => v.toFixed(3).replace(/\.?0+$/, '');

// a zip's central directory, read from the file's end: [{ name, method, crc, csize, local }]
function zipEntries(file)
{
    const fd = fs.openSync(file, 'r');
    try
    {
        const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(size, 65557));
        fs.readSync(fd, tail, 0, tail.length, size - tail.length);
        let e = tail.length - 22;
        while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
        if (e < 0) throw new Error('no zip directory in ' + file);
        const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
        const cd = Buffer.alloc(cdSize);
        fs.readSync(fd, cd, 0, cdSize, cdOff);
        const out = [];
        for (let i = 0, p = 0; i < count; i++)
        {
            if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory in ' + file);
            const nameLen = cd.readUInt16LE(p + 28), extra = cd.readUInt16LE(p + 30), comment = cd.readUInt16LE(p + 32);
            out.push({ name: cd.toString('latin1', p + 46, p + 46 + nameLen), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16), csize: cd.readUInt32LE(p + 20), local: cd.readUInt32LE(p + 42) });
            p += 46 + nameLen + extra + comment;
        }
        return out;
    }
    finally { fs.closeSync(fd); }
}

// the photo skies whose picture in this boot.pak carries the stars' share in its alpha: a Set of names
// ('cloud_01_us_11s__s_d_a', ...); empty when the file is missing
function photoSkies(bootPak)
{
    const ready = new Set();
    if (!bootPak || !fs.existsSync(bootPak)) return ready;
    for (const ent of zipEntries(bootPak))
    {
        const m = /(?:^|[\\/])env_(cloud_01_(?:us_11s|ru_03s)__s_d_a)\.pct$/i.exec(ent.name);
        if (m && PHOTO_PCT[m[1].toLowerCase()].includes(ent.crc.toString(16).padStart(8, '0'))) ready.add(m[1].toLowerCase());
    }
    return ready;
}

// the star layer's overrides: the star texture's times factor, the ready photo skies' alpha times PHOTO_FACTOR;
// { out, notes }, out === text when nothing matched. photo: photoSkies()'s Set (none when left out)
function starsEdit(text, factor, photo)
{
    if (!(factor > 0 && factor <= 20)) throw new Error('stars factor ' + factor);
    const notes = [];
    const out = text.replace(/<Cloud\b[^>]*\bFrame\s*=\s*"sphere_stars"[^>]*>[\s\S]*?<\/Cloud>/gi, (block) =>
        block.replace(/<DayTimeOverride\b[^>]*\/>/gi, (tag) =>
        {
            const state = /\bDayTime\s*=\s*"([^"]*)"/i.exec(tag), map = /\bDiffuseMap\s*=\s*"([^"]*)"/i.exec(tag);
            if (!state || !map) return tag;
            const picture = PHOTO_MAP.exec(map[1]);
            // factor 1 = the photo skies' alpha alone (lod_patch.js keeps it in step with boot.pak without the stars part)
            if (picture ? !(photo && photo.has(picture[1].toLowerCase())) : !STAR_MAP.test(map[1]) || factor === 1) return tag;
            return tag.replace(/\b(DiffuseMultiplier)(\s*=\s*")([^"]*)(")/i, (all, name, eq, value, close) =>
            {
                const m = /^\s*(g?)\(([^)]*)\)\s*(?:x\s*(\d+(?:\.\d+)?)\s*)?$/.exec(value);
                if (!m) return all;
                if (!picture)
                {
                    const k = m[3] === undefined ? 1 : Number(m[3]), scaled = fmt(k * factor);
                    notes.push(state[1] + ' x ' + fmt(k) + ' -> ' + scaled);
                    return name + eq + m[1] + '(' + m[2] + ') x ' + scaled + close;
                }
                const parts = m[2].split(';'), a = parts.length === 4 ? Number(parts[3]) : NaN;
                if (!(a > 0)) return all;   // no alpha of its own, or 0: the picture is not drawn at this state
                const next = Math.min(255, Math.round(a * PHOTO_FACTOR));
                notes.push(state[1] + ' photo alpha ' + fmt(a) + ' -> ' + next + (a * PHOTO_FACTOR > 255 ? ' (capped: the photo comes out darker)' : ''));
                parts[3] = ' ' + next;
                return name + eq + m[1] + '(' + parts.join(';') + ')' + (m[3] === undefined ? '' : ' x ' + m[3]) + close;
            });
        }));
    return { out, notes };
}

module.exports = { isSkyEntry, starsEdit, photoSkies, zipEntries, STARS_FACTOR, PHOTO_FACTOR, PHOTO_PCT, SKY_ENTRY };

if (require.main === module)
{
    const [cmd, a1, a2, a3] = process.argv.slice(2);
    if (cmd !== 'list') { console.log('usage: node sky_stars.js list [factor] [initial.pak] [boot.pak]'); process.exit(2); }
    const zlib = require('zlib');
    const factor = a1 ? Number(a1) : STARS_FACTOR;
    const file = a2 || path.join(path.resolve(__dirname, '..'), 'pak_backup', 'initial.pak.orig');
    const photo = photoSkies(a3 || 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/boot.pak');
    const fd = fs.openSync(file, 'r');
    let files = 0, states = 0;
    try
    {
        for (const ent of zipEntries(file))
        {
            if (!isSkyEntry(ent.name)) continue;
            const head = Buffer.alloc(30);
            fs.readSync(fd, head, 0, 30, ent.local);
            const raw = Buffer.alloc(ent.csize);
            fs.readSync(fd, raw, 0, ent.csize, ent.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
            const r = starsEdit((ent.method === 8 ? zlib.inflateRawSync(raw) : raw).toString('latin1'), factor, photo);
            if (!r.notes.length) continue;
            files++; states += r.notes.length;
            console.log(path.basename(ent.name.replace(/\\/g, '/')).padEnd(28) + r.notes.join('; '));
        }
    }
    finally { fs.closeSync(fd); }
    console.log(files + ' skies, ' + states + ' states: stars x ' + factor + '; photo skies with the stars in their alpha: ' + ([...photo].join(', ') || 'none in boot.pak'));
}
