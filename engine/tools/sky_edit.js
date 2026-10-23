// SPDX-License-Identifier: GPL-3.0-only
// Hand edits of a sky dome texture (a .pct make_cube.js wrote: BC7 mode 6, the upper hemisphere, azimuth across,
// elevation 90 degrees at the top row): flat views of a part of the dome cut out as pictures for an image editor
// (an image model repaints a marked circle), and later put back. Two kinds of view: around a direction (the spot where
// a photograph's sun was taken out), and straight up (the zenith, where the game closes its dome with a fan of
// triangles and only one plain colour holds without wedges, so the sky around it must come to that colour).
// usage: node sky_edit.js crops <dome.pct> <out folder> <name> [--sun <panorama.hdr> [--yaw deg]] [--zenith]
//        [--sun-circle deg] [--zenith-circle deg]
//        writes <name>_<view>.png (the view), <name>_<view>_marked.png (the same with the circle to repaint drawn
//        in red) and <name>.json (the views' geometry, for putting the edits back)
//        node sky_edit.js apply <folder> <name> [--out <dome.pct>]
//        puts <name>_<view>_edit.png back into the dome <name>.json names and writes it to --out (default: the
//        folder, under the dome's own file name) with its .pct_header, plus <name>_<view>_compare.png (before, after)
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const SIZE = 1024;                                        // a view's side in pixels
const VIEWS = { sun: { fov: 50, circle: 10 }, zenith: { fov: 110, circle: 35 } };   // degrees: the view's width, the circle's radius

// ---- the texture: its header (size, mip count) and the top level decoded to RGBA
function readDome(file)
{
    const buf = fs.readFileSync(file), head = fs.readFileSync(file + '_header').length;
    const w = buf.readUInt32LE(0x10), h = buf.readUInt32LE(0x14), mips = buf.readUInt32LE(0x30);
    const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), rgba = new Uint8Array(w * h * 4);
    for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++)
        {
            const px = decodeMode6(buf, head + (by * bw + bx) * 16);
            for (let k = 0; k < 16; k++)
            {
                const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2);
                if (x < w && y < h) rgba.set(px[k], (y * w + x) * 4);
            }
        }
    return { w, h, mips, head, rgba };
}
// one BC7 block in mode 6 (the only mode make_cube.js writes): 7 bit endpoints with a shared low bit, 4 bit indices
function decodeMode6(buf, at)
{
    let pos = 0;
    const bit = () => { const v = (buf[at + (pos >> 3)] >> (pos & 7)) & 1; pos++; return v; };
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit() << i; return v; };
    if (bits(7) !== 64) throw new Error('a block at ' + at + ' is not BC7 mode 6 (not a texture of make_cube.js)');
    const e = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let c = 0; c < 4; c++) { e[0][c] = bits(7); e[1][c] = bits(7); }
    const p0 = bit(), p1 = bit();
    for (let c = 0; c < 4; c++) { e[0][c] = (e[0][c] << 1) | p0; e[1][c] = (e[1][c] << 1) | p1; }
    const out = [];
    for (let k = 0; k < 16; k++)
    {
        const w = W4[bits(k === 0 ? 3 : 4)];
        out.push([0, 1, 2, 3].map((c) => ((64 - w) * e[0][c] + w * e[1][c] + 32) >> 6));
    }
    return out;
}

// ---- directions: y up; the texture's column i is the azimuth (the panorama's u, turned by the build's yaw), its row j
// the angle from the zenith over 90 degrees
const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function texAt(d, dome, yaw, out)
{
    const theta = Math.acos(Math.max(-1, Math.min(1, d[1]))), u = Math.atan2(d[0], d[2]) / (2 * Math.PI) + yaw / 360;
    let x = (u - Math.floor(u)) * dome.w - 0.5, y = theta / (Math.PI / 2) * dome.h - 0.5;
    y = Math.max(0, Math.min(dome.h - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, y1 = Math.min(dome.h - 1, y0 + 1);
    const xa = ((x0 % dome.w) + dome.w) % dome.w, xb = (xa + 1) % dome.w, t = dome.rgba, W = dome.w;
    for (let c = 0; c < 4; c++)
        out[c] = (t[(y0 * W + xa) * 4 + c] * (1 - fx) + t[(y0 * W + xb) * 4 + c] * fx) * (1 - fy) + (t[(y1 * W + xa) * 4 + c] * (1 - fx) + t[(y1 * W + xb) * 4 + c] * fx) * fy;
}
// a view's frame: its centre and the two directions across it (e1 to the right, e2 up in the picture)
function frame(center)
{
    if (Math.abs(center[1]) > 0.999) return { c: [0, 1, 0], e1: [1, 0, 0], e2: [0, 0, 1] };
    const c = norm(center), e1 = norm(cross([0, 1, 0], c)), e2 = cross(c, e1);
    return { c, e1, e2 };
}
function renderView(dome, yaw, f, fov)
{
    const t = Math.tan(fov / 2 * Math.PI / 180), rgb = new Uint8Array(SIZE * SIZE * 3), out = [0, 0, 0, 0];
    for (let j = 0; j < SIZE; j++)
        for (let i = 0; i < SIZE; i++)
        {
            const a = ((i + 0.5) / SIZE * 2 - 1) * t, b = (1 - (j + 0.5) / SIZE * 2) * t;
            texAt(norm([0, 1, 2].map((k) => f.c[k] + a * f.e1[k] + b * f.e2[k])), dome, yaw, out);
            for (let k = 0; k < 3; k++) rgb[(j * SIZE + i) * 3 + k] = Math.round(out[k]);
        }
    return rgb;
}
// the circle of radius deg around the view's centre drawn in red, 3 pixels wide
function marked(rgb, fov, deg)
{
    const m = Uint8Array.from(rgb), r = Math.tan(deg * Math.PI / 180) / Math.tan(fov / 2 * Math.PI / 180) * SIZE / 2;
    for (let j = 0; j < SIZE; j++)
        for (let i = 0; i < SIZE; i++)
        {
            const d = Math.hypot(i + 0.5 - SIZE / 2, j + 0.5 - SIZE / 2);
            if (Math.abs(d - r) < 1.5) { const o = (j * SIZE + i) * 3; m[o] = 255; m[o + 1] = 0; m[o + 2] = 0; }
        }
    return m;
}
function png(file, w, h, rgb)
{
    const crcOf = (b) => zlib.crc32(b) >>> 0;
    const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(crcOf(b.subarray(4, 8 + data.length)), 8 + data.length); return b; };
    const head = Buffer.alloc(13), raw = Buffer.alloc((w * 3 + 1) * h);
    head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
    for (let j = 0; j < h; j++) Buffer.from(rgb.buffer, rgb.byteOffset + j * w * 3, w * 3).copy(raw, j * (w * 3 + 1) + 1);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// the sun's direction in a panorama: its brightest spot in the upper half, as make_cube.js's removeSun finds it
function sunOf(hdrFile)
{
    const { readHdr } = require('./make_cube.js'), p = readHdr(hdrFile);
    let best = -1, bx = 0, by = 0;
    for (let y = 0; y < p.h >> 1; y += 4) for (let x = 0; x < p.w; x += 4) { const o = (y * p.w + x) * 3, l = 0.2126 * p.data[o] + 0.7152 * p.data[o + 1] + 0.0722 * p.data[o + 2]; if (l > best) { best = l; bx = x; by = y; } }
    const phi = (bx + 0.5) / p.w * 2 * Math.PI, th = (by + 0.5) / p.h * Math.PI;
    return [Math.sin(th) * Math.sin(phi), Math.cos(th), Math.sin(th) * Math.cos(phi)];
}

// ---- putting the edits back. An edit is matched to the original in colour just outside its circle (an image model
// shifts the whole picture a little), taken wholly up to FEATHER[0] degrees past the circle and faded out by FEATHER[1].
// Zenith views go first, so a sun spot's edit, which can reach into the zenith's circle, has the last word there.
// With a zenith edit the cap follows: from CAP.blend up every texel is blended towards one colour, wholly at CAP.plain,
// the median of the edited sky between CAP.ring's elevations (the clear sky's colour where clouds still reach the ring;
// their mean made a lighter disc), so the game's fan above about 81 degrees shows the colour the sky around it has.
// The blend is long, as the sky around the zenith is not one colour (darker away from the sun): over 7 degrees its edge
// still showed as a circle
const FEATHER = [0.5, 4], BAND = [1, 6];   // degrees past the circle: the fade; where the colour is matched
const CAP = { blend: 64, plain: 80, ring: [76, 80] };
const ss = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
function readPng(file)
{
    const b = fs.readFileSync(file);
    if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw new Error(file + ': not a PNG (save the picture as .png)');
    let at = 8, w = 0, h = 0, depth = 0, type = 0, lace = 0;
    const idat = [];
    while (at + 8 <= b.length)
    {
        const len = b.readUInt32BE(at), kind = b.toString('latin1', at + 4, at + 8), data = b.subarray(at + 8, at + 8 + len);
        if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; lace = data[12]; }
        else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        at += 12 + len;
    }
    const n = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
    if (depth !== 8 || !n || lace) throw new Error(file + ': an 8 bit grey or RGB PNG without interlacing expected (bit depth ' + depth + ', colour type ' + type + ')');
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * n, px = new Uint8Array(h * stride), rgb = new Uint8Array(w * h * 3);
    for (let j = 0; j < h; j++)
    {
        const f = raw[j * (stride + 1)], src = j * (stride + 1) + 1, row = j * stride, up = row - stride;
        for (let i = 0; i < stride; i++)
        {
            const x = raw[src + i], a = i >= n ? px[row + i - n] : 0, u = j ? px[up + i] : 0, c = i >= n && j ? px[up + i - n] : 0;
            let p;
            if (f === 0) p = x;
            else if (f === 1) p = x + a;
            else if (f === 2) p = x + u;
            else if (f === 3) p = x + ((a + u) >> 1);
            else if (f === 4) { const q = a + u - c, qa = Math.abs(q - a), qb = Math.abs(q - u), qc = Math.abs(q - c); p = x + (qa <= qb && qa <= qc ? a : qb <= qc ? u : c); }
            else throw new Error(file + ': filter ' + f + ' in row ' + j);
            px[row + i] = p & 255;
        }
        for (let i = 0; i < w; i++) for (let k = 0; k < 3; k++) rgb[(j * w + i) * 3 + k] = px[row + i * n + (n < 3 ? 0 : k)];
    }
    return { w, h, rgb };
}
// a picture halved (2 x 2 boxes) until it is less than twice a view's size
function shrink(img)
{
    while (img.w >= 2 * SIZE && img.h >= 2 * SIZE)
    {
        const w = img.w >> 1, h = img.h >> 1, rgb = new Uint8Array(w * h * 3), s = img.rgb, W = img.w;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) for (let k = 0; k < 3; k++)
            rgb[(j * w + i) * 3 + k] = (s[(2 * j * W + 2 * i) * 3 + k] + s[(2 * j * W + 2 * i + 1) * 3 + k] + s[((2 * j + 1) * W + 2 * i) * 3 + k] + s[((2 * j + 1) * W + 2 * i + 1) * 3 + k] + 2) >> 2;
        img = { w, h, rgb };
    }
    return img;
}
// the picture at a view's pixel (x, y) (pixel centres on whole numbers), bilinear, whatever the picture's own size
function samplePic(img, x, y, out)
{
    const X = Math.max(0, Math.min(img.w - 1, (x + 0.5) * img.w / SIZE - 0.5)), Y = Math.max(0, Math.min(img.h - 1, (y + 0.5) * img.h / SIZE - 0.5));
    const x0 = Math.floor(X), y0 = Math.floor(Y), x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1), fx = X - x0, fy = Y - y0, s = img.rgb;
    for (let k = 0; k < 3; k++)
        out[k] = (s[(y0 * img.w + x0) * 3 + k] * (1 - fx) + s[(y0 * img.w + x1) * 3 + k] * fx) * (1 - fy) + (s[(y1 * img.w + x0) * 3 + k] * (1 - fx) + s[(y1 * img.w + x1) * 3 + k] * fx) * fy;
}
// degrees past a view's circle at view pixel (i, j)
const pastCircle = (v, t, i, j) => Math.atan(Math.hypot(((i + 0.5) / SIZE * 2 - 1) * t, (1 - (j + 0.5) / SIZE * 2) * t)) * 180 / Math.PI - v.circle;
function apply(dir, name, outFile)
{
    const { encodeRect, halveRect, TAIL } = require('./make_cube.js');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8')), yaw = meta.yaw;
    const dome = readDome(meta.dome), W = dome.w, H = dome.h, rgba = Uint8Array.from(dome.rgba);
    const editOf = (v) => path.join(dir, name + '_' + v.view + '_edit.png');
    let grey = true;
    for (let i = 0; i < W * H && grey; i += 97) { const o = i * 4; grey = Math.abs(dome.rgba[o] - dome.rgba[o + 1]) <= 2 && Math.abs(dome.rgba[o + 1] - dome.rgba[o + 2]) <= 2; }
    const views = meta.views.filter((v) => fs.existsSync(editOf(v))).sort((a, b) => (a.view === 'zenith' ? 0 : 1) - (b.view === 'zenith' ? 0 : 1));
    if (!views.length) throw new Error('no ' + name + '_<view>_edit.png in ' + dir);
    const px = [0, 0, 0], befores = new Map();
    for (const v of views)
    {
        const img = shrink(readPng(editOf(v))), t = Math.tan(v.fov / 2 * Math.PI / 180), before = renderView(dome, yaw, v, v.fov);
        if (Math.abs(img.w / img.h - 1) > 0.02) throw new Error(editOf(v) + ': ' + img.w + ' x ' + img.h + ', the view was square (a crop or a border changes where things are)');
        befores.set(v, before);
        // the colour gain from the band outside the circle, then how far the edit strayed there and how much of the red
        // circle it left
        const sum = [0, 0, 0, 0, 0, 0];
        let n = 0, red = 0, dev = 0;
        for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++)
        {
            const deg = pastCircle(v, t, i, j);
            if (Math.abs(deg) < 1.5) { samplePic(img, i, j, px); if (px[0] > 150 && px[0] > 2 * px[1] && px[0] > 2 * px[2]) red++; }
            if (deg < BAND[0] || deg > BAND[1]) continue;
            samplePic(img, i, j, px);
            for (let k = 0; k < 3; k++) { sum[k] += before[(j * SIZE + i) * 3 + k]; sum[3 + k] += px[k]; }
            n++;
        }
        const gain = [0, 1, 2].map((k) => sum[k] / Math.max(1, sum[3 + k]));
        for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++)
        {
            const deg = pastCircle(v, t, i, j);
            if (deg < BAND[0] || deg > BAND[1]) continue;
            samplePic(img, i, j, px);
            for (let k = 0; k < 3; k++) dev += Math.abs(before[(j * SIZE + i) * 3 + k] - px[k] * gain[k]) / 3;
        }
        dev /= Math.max(1, n);
        // every texel within reach of the circle, its direction the way texAt reads it
        const reach = v.circle + FEATHER[1], cosReach = Math.cos(reach * Math.PI / 180), thC = Math.acos(Math.max(-1, Math.min(1, v.c[1]))) * 180 / Math.PI;
        const j0 = Math.max(0, Math.floor((thC - reach) / 90 * H) - 1), j1 = Math.min(H - 1, Math.ceil((thC + reach) / 90 * H) + 1);
        let touched = 0;
        for (let j = j0; j <= j1; j++)
        {
            const th = (j + 0.5) / H * Math.PI / 2, st = Math.sin(th), ct = Math.cos(th);
            for (let i = 0; i < W; i++)
            {
                const phi = ((i + 0.5) / W - yaw / 360) * 2 * Math.PI, d = [st * Math.sin(phi), ct, st * Math.cos(phi)];
                const dot = d[0] * v.c[0] + d[1] * v.c[1] + d[2] * v.c[2];
                if (dot < cosReach) continue;
                const deg = Math.acos(Math.min(1, dot)) * 180 / Math.PI - v.circle, wgt = 1 - ss((deg - FEATHER[0]) / (FEATHER[1] - FEATHER[0]));
                const pa = (d[0] * v.e1[0] + d[1] * v.e1[1] + d[2] * v.e1[2]) / dot, pb = (d[0] * v.e2[0] + d[1] * v.e2[1] + d[2] * v.e2[2]) / dot;
                samplePic(img, (pa / t + 1) / 2 * SIZE - 0.5, (1 - pb / t) / 2 * SIZE - 0.5, px);
                let r = px[0] * gain[0], g = px[1] * gain[1], b = px[2] * gain[2];
                if (grey) r = g = b = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                const o = (j * W + i) * 4;
                rgba[o] = Math.max(0, Math.min(255, Math.round(rgba[o] + (r - rgba[o]) * wgt)));
                rgba[o + 1] = Math.max(0, Math.min(255, Math.round(rgba[o + 1] + (g - rgba[o + 1]) * wgt)));
                rgba[o + 2] = Math.max(0, Math.min(255, Math.round(rgba[o + 2] + (b - rgba[o + 2]) * wgt)));
                touched++;
            }
        }
        console.log(name + ' ' + v.view + ': ' + img.w + ' x ' + img.h + ', gain ' + gain.map((g) => g.toFixed(3)).join('/') + ', off by ' + dev.toFixed(1) + ' levels outside the circle' + (dev > 8 ? ' (the edit changed more than its circle: look at the compare picture)' : '') + (red > 50 ? ', ' + red + ' red pixels left on the circle' : '') + ', ' + touched + ' texels' + (grey ? ', grey' : ''));
    }
    if (views.some((v) => v.view === 'zenith'))
    {
        // the ring's median and spread per channel (counts of the 256 levels)
        const el = (j) => 90 * (1 - (j + 0.5) / H), hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], m = [0, 0, 0], sq = [0, 0, 0], mean = [0, 0, 0];
        let n = 0;
        for (let j = 0; j < H; j++)
        {
            const e = el(j);
            if (e < CAP.ring[0] || e > CAP.ring[1]) continue;
            for (let i = 0; i < W; i++) for (let k = 0; k < 3; k++) { const x = rgba[(j * W + i) * 4 + k]; hist[k][x]++; mean[k] += x; sq[k] += x * x; }
            n += W;
        }
        for (let k = 0; k < 3; k++)
        {
            let c = 0, v = 0;
            while (v < 255 && c + hist[k][v] < n / 2) c += hist[k][v++];
            m[k] = v;
            mean[k] /= n;
            sq[k] = Math.sqrt(Math.max(0, sq[k] / n - mean[k] * mean[k]));
        }
        for (let j = 0; j < H; j++)
        {
            const e = el(j);
            if (e <= CAP.blend) continue;
            const t = ss((e - CAP.blend) / (CAP.plain - CAP.blend));
            for (let i = 0; i < W; i++) for (let k = 0; k < 3; k++) { const o = (j * W + i) * 4 + k; rgba[o] = Math.round(rgba[o] + (m[k] - rgba[o]) * t); }
        }
        console.log(name + ' zenith cap: ' + m.map((x) => Math.round(x)).join('/') + ' from ' + CAP.plain + ' degrees up, the sky around it varies by ' + sq.map((x) => x.toFixed(1)).join('/') + (Math.max(...sq) > 12 ? ' (clouds reach the cap: the edit should clear the middle)' : ''));
    }
    // the dome again: its own head, every level from the edited top one, its own tail
    const buf = fs.readFileSync(meta.dome), parts = [buf.subarray(0, dome.head)];
    let pic = rgba, pw = W, ph = H;
    for (let m = 0; m < dome.mips; m++)
    {
        parts.push(encodeRect(pic, pw, ph));
        if (m < dome.mips - 1) { pic = halveRect(pic, pw, ph); pw = Math.max(pw >> 1, 4); ph = Math.max(ph >> 1, 4); }
    }
    parts.push(buf.subarray(buf.length - TAIL));
    const out = Buffer.concat(parts);
    if (out.length !== buf.length) throw new Error('the dome came out at ' + out.length + ' bytes, it was ' + buf.length);
    fs.writeFileSync(outFile, out);
    fs.copyFileSync(meta.dome + '_header', outFile + '_header');
    // before and after side by side, the after view read back from the written file
    const after = readDome(outFile);
    for (const v of meta.views)
    {
        const b = befores.get(v) || renderView(dome, yaw, v, v.fov), a = renderView(after, yaw, v, v.fov), both = new Uint8Array(SIZE * 2 * SIZE * 3);
        for (let j = 0; j < SIZE; j++) { both.set(b.subarray(j * SIZE * 3, (j + 1) * SIZE * 3), j * SIZE * 6); both.set(a.subarray(j * SIZE * 3, (j + 1) * SIZE * 3), j * SIZE * 6 + SIZE * 3); }
        png(path.join(dir, name + '_' + v.view + '_compare.png'), SIZE * 2, SIZE, both);
    }
    console.log('wrote ' + outFile);
}

if (require.main === module)
{
    const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
    if (args[0] === 'crops' && args[1] && args[2] && args[3])
    {
        const dome = readDome(args[1]), dir = args[2], name = args[3], yaw = Number(opt('yaw') || 0), views = [];
        fs.mkdirSync(dir, { recursive: true });
        if (opt('sun'))
        {
            // the panorama's sun as the texture holds it: the texture's azimuth is the panorama's u minus the yaw, so a
            // direction is turned back by the yaw before it is looked up (texAt adds it again)
            const s = sunOf(opt('sun')), a = -yaw * Math.PI / 180;
            views.push({ view: 'sun', center: [Math.cos(a) * s[0] + Math.sin(a) * s[2], s[1], -Math.sin(a) * s[0] + Math.cos(a) * s[2]] });
        }
        if (args.includes('--zenith')) views.push({ view: 'zenith', center: [0, 1, 0] });
        for (const v of views)
        {
            const fov = VIEWS[v.view].fov, circle = Number(opt(v.view + '-circle') || VIEWS[v.view].circle), f = frame(v.center), rgb = renderView(dome, yaw, f, fov);
            png(path.join(dir, name + '_' + v.view + '.png'), SIZE, SIZE, rgb);
            png(path.join(dir, name + '_' + v.view + '_marked.png'), SIZE, SIZE, marked(rgb, fov, circle));
            Object.assign(v, { fov, circle, size: SIZE, e1: f.e1, e2: f.e2, c: f.c });
            console.log(name + ' ' + v.view + ': ' + fov + ' degree view, circle ' + circle + ' degrees' + (v.view === 'sun' ? ', centre ' + (90 - Math.acos(f.c[1]) * 180 / Math.PI).toFixed(1) + ' degrees up' : ''));
        }
        fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ dome: path.resolve(args[1]), w: dome.w, h: dome.h, yaw, views }, null, 2));
    }
    else if (args[0] === 'apply' && args[1] && args[2])
    {
        const meta = JSON.parse(fs.readFileSync(path.join(args[1], args[2] + '.json'), 'utf8'));
        apply(args[1], args[2], opt('out') || path.join(args[1], path.basename(meta.dome)));
    }
    else console.log('usage: node sky_edit.js crops <dome.pct> <out folder> <name> [--sun <panorama.hdr> [--yaw deg]] [--zenith] [--sun-circle deg] [--zenith-circle deg]\n       node sky_edit.js apply <folder> <name> [--out <dome.pct>]');
}
module.exports = { readDome, decodeMode6, texAt, frame, png, readPng, apply, VIEWS, SIZE };
