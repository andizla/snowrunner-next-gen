// SPDX-License-Identifier: GPL-3.0-only
// Reflection cubes for SnowRunner from a panoramic sky picture. The game's daytime states name a reflection cube
// (EnvMap="env/day_al_01__d_ggxrefl.tga": boot.pak [textures]\pct\env_<name>__d_ggxrefl.pct): six 256 x 256 faces in
// the Direct3D order +X -X +Y -Y +Z -Z, BC7 blocks, 8 mip levels down to 2 x 2 (each a plain downsample of the one
// before), in a .pct of 138 header bytes, 6 x 87392 block bytes and a 6 byte tail (a u16 1 and the file size). The
// materials sample it at the mip sqrt(roughness) * 8 + 0.5; Sky ambient and Bounce light read its last level as the
// sky's and the ground's colour. This build-time tool makes such a cube from an equirectangular panorama in Radiance
// .hdr (RGBE): each face texel looks up the panorama (3 x 3 samples), the picture is exposed so that its upper half
// lands at the brightness of the stock cube's sky (an sRGB luminance, SKY_MEAN), encoded sRGB, box-filtered down the
// mips and written as BC7 mode 6 (one subset, 7 bit endpoints with a shared low bit, 4 bit indices, refined by least
// squares). The header and the tail come from a stock cube's file, so the game sees exactly what it ships with.
// usage: node make_cube.js build <panorama.hdr> <out.pct> --header <stock.pct> [--exposure <x> | --sky-mean <0..1>]
//            [--sky-rgb <r,g,b>] [--ground-mean <0..1>] [--yaw <degrees>] [--preview]   writes the .pct and its
//            .pct_header; --sky-rgb white-balances the picture to a mean sky colour (a dusk, dawn or night at the hue
//            of the game's cube), --ground-mean exposes the ground half apart from the sky; --preview also
//            <out>_faces.png (the six faces side by side) and <out>_pano.png (the cube unwrapped again, to check the
//            orientation)
//        node make_cube.js preview <panorama.hdr> <out.png> [--exposure <x> | --sky-mean <0..1>] [--yaw <degrees>]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const SIZE = 256, MIPS = 8, HEAD = 138, TAIL = 6, FACE_BYTES = 87392;
const SKY_MEAN = 0.68;   // the stock day cubes' sky half: sRGB luminance 0.65 to 0.70 (day_al_01: 0.679)
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];   // BC7 4 bit interpolation weights

// ---- Radiance .hdr: { w, h, data: Float32Array of linear r, g, b per texel, row 0 at the top }
function readHdr(file)
{
    const buf = fs.readFileSync(file);
    let pos = 0;
    const line = () => { let s = ''; while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]); pos++; return s; };
    if (!/^#\?/.test(line())) throw new Error(file + ': not a Radiance .hdr file');
    for (let l = line(); l !== ''; l = line()) if (/^FORMAT=/.test(l) && !/32-bit_rle_rgbe/.test(l)) throw new Error(file + ': ' + l + ' is not supported');
    const res = /^-Y (\d+) \+X (\d+)$/.exec(line());
    if (!res) throw new Error(file + ': only the -Y +X orientation is supported');
    const h = Number(res[1]), w = Number(res[2]), data = new Float32Array(w * h * 3), scan = new Uint8Array(w * 4);
    for (let y = 0; y < h; y++)
    {
        if (w >= 8 && w < 32768 && buf[pos] === 2 && buf[pos + 1] === 2 && ((buf[pos + 2] << 8) | buf[pos + 3]) === w)
        {
            pos += 4;
            for (let c = 0; c < 4; c++)
                for (let x = 0; x < w;)
                {
                    let n = buf[pos++];
                    if (n > 128) { n -= 128; const v = buf[pos++]; while (n-- > 0) scan[(x++) * 4 + c] = v; }
                    else while (n-- > 0) scan[(x++) * 4 + c] = buf[pos++];
                }
        }
        else { scan.set(buf.subarray(pos, pos + w * 4)); pos += w * 4; }
        for (let x = 0; x < w; x++)
        {
            const e = scan[x * 4 + 3], i = (y * w + x) * 3;
            if (e === 0) continue;
            const f = Math.pow(2, e - 136);   // 2^(e - 128) / 256
            data[i] = (scan[x * 4] + 0.5) * f; data[i + 1] = (scan[x * 4 + 1] + 0.5) * f; data[i + 2] = (scan[x * 4 + 2] + 0.5) * f;
        }
    }
    return { w, h, data };
}
// the panorama at (u, v), u wrapping, v clamped, bilinear: into out[0..2]
function sample(p, u, v, out)
{
    let x = (u - Math.floor(u)) * p.w - 0.5, y = v * p.h - 0.5;
    if (y < 0) y = 0; else if (y > p.h - 1) y = p.h - 1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = ((x0 % p.w) + p.w) % p.w, xb = (xa + 1) % p.w, yb = Math.min(y0 + 1, p.h - 1);
    const ra = (y0 * p.w) * 3, rb = (yb * p.w) * 3;
    for (let c = 0; c < 3; c++)
        out[c] = (p.data[ra + xa * 3 + c] * (1 - fx) + p.data[ra + xb * 3 + c] * fx) * (1 - fy) + (p.data[rb + xa * 3 + c] * (1 - fx) + p.data[rb + xb * 3 + c] * fx) * fy;
}
// a direction (y up) to the panorama's (u, v); yaw turns the picture about the vertical
function dirToUv(x, y, z, yaw)
{
    const len = Math.sqrt(x * x + y * y + z * z);
    return [0.5 + Math.atan2(x, z) / (2 * Math.PI) + yaw / 360, Math.acos(Math.max(-1, Math.min(1, y / len))) / Math.PI];
}
// the direction of a face texel (s, t in 0..1 across the face, t down the picture): Direct3D's cube faces
function faceDir(f, s, t)
{
    const a = s * 2 - 1, b = t * 2 - 1;
    switch (f)
    {
        case 0: return [1, -b, -a];
        case 1: return [-1, -b, a];
        case 2: return [a, 1, b];
        case 3: return [a, -1, -b];
        case 4: return [a, -b, 1];
        default: return [-a, -b, -1];
    }
}
// the face and (s, t) a direction falls on
function dirToFace(x, y, z)
{
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let f, ma, sc, tc;
    if (ax >= ay && ax >= az) { ma = ax; if (x > 0) { f = 0; sc = -z; tc = -y; } else { f = 1; sc = z; tc = -y; } }
    else if (ay >= az) { ma = ay; if (y > 0) { f = 2; sc = x; tc = z; } else { f = 3; sc = x; tc = -z; } }
    else { ma = az; if (z > 0) { f = 4; sc = x; tc = -y; } else { f = 5; sc = -x; tc = -y; } }
    return [f, (sc / ma + 1) / 2, (tc / ma + 1) / 2];
}

const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
// the picture's range into 0..1: a value times the exposure through a shoulder that reaches 1 at TONE.white (Reinhard
// with a white point; white 0 = a hard clip), after a cap (linear, before the exposure) that takes the sun down to a
// bright patch: TONE.cap is 0 for none, else the value a texel may reach, set from the sky's median by the caller
const TONE = { white: 4, cap: 0 };
function encode(v, exposure)
{
    if (TONE.cap > 0 && v > TONE.cap) v = TONE.cap;
    let x = Math.max(0, v * exposure);
    x = TONE.white > 0 ? x * (1 + x / (TONE.white * TONE.white)) / (1 + x) : x;
    return Math.max(0, Math.min(255, Math.round(srgb(Math.min(1, x)) * 255)));
}
// the median linear luminance of the sky half (for the cap)
function skyMedian(p, yaw)
{
    const out = [0, 0, 0], lum = [];
    for (let j = 0; j < 64; j++)
        for (let i = 0; i < 128; i++)
        {
            const theta = (j + 0.5) / 64 * (Math.PI / 2), phi = (i + 0.5) / 128 * 2 * Math.PI;
            const [u, v] = dirToUv(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi), yaw);
            sample(p, u, v, out);
            lum.push(0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]);
        }
    lum.sort((a, b) => a - b);
    return lum[lum.length >> 1];
}
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const linear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
// the ground gain: a factor on everything below the horizon, faded in over the first GROUND_FADE of elevation, as a
// graduated filter over the lower half of a lens: it sets the ground half's brightness apart from the sky's
const GROUND_FADE = 6 * Math.PI / 180;
const groundFactor = (elevation, gain) => { if (elevation >= 0) return 1; const t = Math.min(1, -elevation / GROUND_FADE); return 1 + (gain - 1) * t * t * (3 - 2 * t); };
// the mean sRGB colour (0..1) of the sky half at an exposure, from a fixed set of directions; with down, that of the
// ground half under a ground gain
function halfColour(p, exposure, yaw, down, gain)
{
    const out = [0, 0, 0], sum = [0, 0, 0];
    let n = 0;
    for (let j = 0; j < 64; j++)
        for (let i = 0; i < 128; i++)
        {
            const theta = (j + 0.5) / 64 * (Math.PI / 2), phi = (i + 0.5) / 128 * 2 * Math.PI;   // a hemisphere from its pole, equal solid angle weight
            const w = Math.sin(theta), k = down ? groundFactor(theta - Math.PI / 2, gain) : 1;
            const [u, v] = dirToUv(Math.sin(theta) * Math.sin(phi), (down ? -1 : 1) * Math.cos(theta), Math.sin(theta) * Math.cos(phi), yaw);
            sample(p, u, v, out);
            for (let c = 0; c < 3; c++) sum[c] += w * encode(out[c] * k, exposure) / 255;
            n += w;
        }
    return sum.map((s) => s / n);
}
// the mean sRGB luminance of the sky half at an exposure
const skyMean = (p, exposure, yaw) => lum(halfColour(p, exposure, yaw, false, 1));
// the exposure that puts the sky half at the target (bisection in log space)
function exposureFor(p, target, yaw)
{
    let lo = -14, hi = 14;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (skyMean(p, Math.pow(2, mid), yaw) < target) lo = mid; else hi = mid; }
    return Math.pow(2, (lo + hi) / 2);
}
// the ground gain that puts the ground half at the target (bisection in log space), and the gain laid into the picture
function groundGainFor(p, exposure, yaw, target)
{
    let lo = -10, hi = 10;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (lum(halfColour(p, exposure, yaw, true, Math.pow(2, mid))) < target) lo = mid; else hi = mid; }
    return Math.pow(2, (lo + hi) / 2);
}
function applyGround(p, gain)
{
    for (let j = 0; j < p.h; j++)
    {
        const k = groundFactor((0.5 - (j + 0.5) / p.h) * Math.PI, gain);
        if (k !== 1) for (let i = j * p.w * 3, end = i + p.w * 3; i < end; i++) p.data[i] *= k;
    }
}

// the six faces as RGBA8, SIZE x SIZE each, 3 x 3 samples per texel
function renderFaces(p, exposure, yaw)
{
    const faces = [], out = [0, 0, 0];
    for (let f = 0; f < 6; f++)
    {
        const face = new Uint8Array(SIZE * SIZE * 4);
        for (let j = 0; j < SIZE; j++)
            for (let i = 0; i < SIZE; i++)
            {
                let r = 0, g = 0, b = 0;
                for (let sy = 0; sy < 3; sy++)
                    for (let sx = 0; sx < 3; sx++)
                    {
                        const d = faceDir(f, (i + (sx + 0.5) / 3) / SIZE, (j + (sy + 0.5) / 3) / SIZE), [u, v] = dirToUv(d[0], d[1], d[2], yaw);
                        sample(p, u, v, out);
                        r += out[0]; g += out[1]; b += out[2];
                    }
                const o = (j * SIZE + i) * 4;
                face[o] = encode(r / 9, exposure); face[o + 1] = encode(g / 9, exposure); face[o + 2] = encode(b / 9, exposure); face[o + 3] = 255;
            }
        faces.push(face);
    }
    return faces;
}
// the next mip: a 2 x 2 box
function halve(face, size)
{
    const n = size >> 1, out = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++)
            for (let c = 0; c < 4; c++)
            {
                const a = ((2 * j) * size + 2 * i) * 4 + c, b = a + 4, d = a + size * 4, e = d + 4;
                out[(j * n + i) * 4 + c] = (face[a] + face[b] + face[d] + face[e] + 2) >> 2;
            }
    return out;
}

// ---- BC7 mode 6: a 4 x 4 block of RGBA8 texels (px[16][4]) into 16 bytes
function encodeBlock(px)
{
    // the two texels farthest apart start the line
    let best = -1, e0 = px[0], e1 = px[0];
    for (let a = 0; a < 16; a++)
        for (let b = a + 1; b < 16; b++)
        {
            let d = 0;
            for (let c = 0; c < 4; c++) d += (px[a][c] - px[b][c]) * (px[a][c] - px[b][c]);
            if (d > best) { best = d; e0 = px[a]; e1 = px[b]; }
        }
    let p0 = e0.slice(), p1 = e1.slice(), idx = new Array(16).fill(0);
    const assign = () =>
    {
        for (let k = 0; k < 16; k++)
        {
            let bi = 0, be = Infinity;
            for (let w = 0; w < 16; w++)
            {
                let e = 0;
                for (let c = 0; c < 4; c++) { const v = ((64 - W4[w]) * p0[c] + W4[w] * p1[c] + 32) >> 6; e += (v - px[k][c]) * (v - px[k][c]); }
                if (e < be) { be = e; bi = w; }
            }
            idx[k] = bi;
        }
    };
    for (let it = 0; it < 3; it++)
    {
        assign();
        // least squares per channel: c = a e0 + b e1, a = (64 - w) / 64, b = w / 64
        let saa = 0, sab = 0, sbb = 0;
        const sac = [0, 0, 0, 0], sbc = [0, 0, 0, 0];
        for (let k = 0; k < 16; k++)
        {
            const b = W4[idx[k]] / 64, a = 1 - b;
            saa += a * a; sab += a * b; sbb += b * b;
            for (let c = 0; c < 4; c++) { sac[c] += a * px[k][c]; sbc[c] += b * px[k][c]; }
        }
        const det = saa * sbb - sab * sab;
        if (Math.abs(det) < 1e-6) break;
        for (let c = 0; c < 4; c++)
        {
            p0[c] = Math.max(0, Math.min(255, (sbb * sac[c] - sab * sbc[c]) / det));
            p1[c] = Math.max(0, Math.min(255, (saa * sbc[c] - sab * sac[c]) / det));
        }
    }
    // 7 bit endpoints with one shared low bit each: the bit that rounds the four channels best
    const quant = (e) =>
    {
        let bestP = 0, bestErr = Infinity, bestQ = null;
        for (let p = 0; p < 2; p++)
        {
            const q = [], err = e.reduce((s, v, c) => { q[c] = Math.max(0, Math.min(127, Math.round((v - p) / 2))); return s + (q[c] * 2 + p - v) * (q[c] * 2 + p - v); }, 0);
            if (err < bestErr) { bestErr = err; bestP = p; bestQ = q; }
        }
        return { q: bestQ, p: bestP, v: bestQ.map((x) => x * 2 + bestP) };
    };
    let q0 = quant(p0), q1 = quant(p1);
    p0 = q0.v; p1 = q1.v;
    assign();
    if (idx[0] >= 8) { [q0, q1] = [q1, q0]; idx = idx.map((i) => 15 - i); }
    // the bits, least significant first: mode (bit 6), R0 R1 G0 G1 B0 B1 A0 A1 (7 each), P0 P1, 3 + 15 x 4 index bits
    const bits = new Uint8Array(16);
    let at = 0;
    const put = (value, count) => { for (let k = 0; k < count; k++, at++) if ((value >> k) & 1) bits[at >> 3] |= 1 << (at & 7); };
    put(1 << 6, 7);
    for (let c = 0; c < 4; c++) { put(q0.q[c], 7); put(q1.q[c], 7); }
    put(q0.p, 1); put(q1.p, 1);
    put(idx[0], 3);
    for (let k = 1; k < 16; k++) put(idx[k], 4);
    return bits;
}
// a face at one mip size as BC7 blocks (sizes under 4 repeat their edge texels)
function encodeFace(face, size)
{
    const blocks = Math.max(1, size >> 2), out = new Uint8Array(blocks * blocks * 16), px = [];
    for (let k = 0; k < 16; k++) px.push([0, 0, 0, 0]);
    for (let by = 0; by < blocks; by++)
        for (let bx = 0; bx < blocks; bx++)
        {
            for (let k = 0; k < 16; k++)
            {
                const x = Math.min(size - 1, bx * 4 + (k & 3)), y = Math.min(size - 1, by * 4 + (k >> 2)), o = (y * size + x) * 4;
                px[k][0] = face[o]; px[k][1] = face[o + 1]; px[k][2] = face[o + 2]; px[k][3] = face[o + 3];
            }
            out.set(encodeBlock(px), (by * blocks + bx) * 16);
        }
    return out;
}

// ---- PNG, 8 bit RGB
function png(file, w, h, rgb)
{
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
    const chunk = (type, data) =>
    {
        const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
        len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
// the six faces side by side
function facesPng(file, faces)
{
    const rgb = new Uint8Array(SIZE * 6 * SIZE * 3);
    for (let f = 0; f < 6; f++)
        for (let j = 0; j < SIZE; j++)
            for (let i = 0; i < SIZE; i++)
            {
                const s = (j * SIZE + i) * 4, d = (j * SIZE * 6 + f * SIZE + i) * 3;
                rgb[d] = faces[f][s]; rgb[d + 1] = faces[f][s + 1]; rgb[d + 2] = faces[f][s + 2];
            }
    png(file, SIZE * 6, SIZE, rgb);
}
// the cube unwrapped to a panorama again, 1024 x 512
function panoPng(file, faces)
{
    const w = 1024, h = 512, rgb = new Uint8Array(w * h * 3);
    for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++)
        {
            const theta = (j + 0.5) / h * Math.PI, phi = ((i + 0.5) / w - 0.5) * 2 * Math.PI;
            const [f, s, t] = dirToFace(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi));
            const o = (Math.min(SIZE - 1, Math.floor(t * SIZE)) * SIZE + Math.min(SIZE - 1, Math.floor(s * SIZE))) * 4, d = (j * w + i) * 3;
            rgb[d] = faces[f][o]; rgb[d + 1] = faces[f][o + 1]; rgb[d + 2] = faces[f][o + 2];
        }
    png(file, w, h, rgb);
}

// ---- the .pct: a stock cube's header, the blocks face by face and mip by mip, the stock tail
function writePct(file, faces, stockFile)
{
    const stock = fs.readFileSync(stockFile);
    if (stock.length !== HEAD + 6 * FACE_BYTES + TAIL) throw new Error(stockFile + ' is not a 256 px cube .pct (' + stock.length + ' bytes)');
    const parts = [stock.subarray(0, HEAD)];
    for (let f = 0; f < 6; f++)
    {
        let face = faces[f], size = SIZE;
        for (let m = 0; m < MIPS; m++)
        {
            parts.push(encodeFace(face, size));
            if (m < MIPS - 1) { face = halve(face, size); size >>= 1; }
        }
    }
    parts.push(stock.subarray(stock.length - TAIL));
    const out = Buffer.concat(parts);
    if (out.length !== stock.length) throw new Error('the cube came out at ' + out.length + ' bytes, the stock one has ' + stock.length);
    fs.writeFileSync(file, out);
    fs.writeFileSync(file + '_header', stock.subarray(0, HEAD));
}

// ---- a sky texture: the sphere_sky layer of a region's sky (classes\skies\sky_<region>.xml) is a panorama of the
// upper hemisphere, w x h BC7 with mips down to 4 x 4 blocks (the stock ones 8192 x 2048, 12 mips), azimuth across,
// elevation 90 degrees at the top row and the horizon at the bottom, its alpha fading out over the lowest rows.
// Rendered from the panorama one bilinear sample per texel, the same exposure as the cubes, alpha 255 down to
// HORIZON_FADE of the height, then to 0 (the stock sky_01_ru_03_day fades over its lowest 11 %). The layers are drawn
// times their DiffuseMultiplier (4 to 8 by day), so the texture itself is darker than a cube: SKY_TEX_MEAN
const HORIZON_FADE = 0.11, SKY_TEX_MEAN = 0.45;   // the stock Kola day skies: 0.42 and 0.47
function renderSky(p, exposure, yaw, w, h)
{
    const rgba = new Uint8Array(w * h * 4), out = [0, 0, 0];
    for (let j = 0; j < h; j++)
    {
        const v = (j + 0.5) / h / 2, fade = (h - 1 - j) / (h * HORIZON_FADE), alpha = Math.max(0, Math.min(255, Math.round(fade * 255)));
        for (let i = 0; i < w; i++)
        {
            sample(p, (i + 0.5) / w - yaw / 360, v, out);
            const o = (j * w + i) * 4;
            rgba[o] = encode(out[0], exposure); rgba[o + 1] = encode(out[1], exposure); rgba[o + 2] = encode(out[2], exposure); rgba[o + 3] = alpha;
        }
    }
    return rgba;
}
// the texture's mip sizes as the game stores them: each dimension halves, a level is at least 4 x 4 (one block)
const mipDims = (w, h, mips) => Array.from({ length: mips }, (_, k) => [Math.max(w >> k, 4), Math.max(h >> k, 4)]);
// a 2 x 2 box of a w x h RGBA picture (a dimension of 4 or less stays)
function halveRect(pic, w, h)
{
    const nw = Math.max(w >> 1, 4), nh = Math.max(h >> 1, 4), sx = w > 4 ? 2 : 1, sy = h > 4 ? 2 : 1, out = new Uint8Array(nw * nh * 4);
    for (let j = 0; j < nh; j++)
        for (let i = 0; i < nw; i++)
            for (let c = 0; c < 4; c++)
            {
                let sum = 0, n = 0;
                for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) { const x = Math.min(w - 1, i * sx + dx), y = Math.min(h - 1, j * sy + dy); sum += pic[(y * w + x) * 4 + c]; n++; }
                out[(j * nw + i) * 4 + c] = Math.round(sum / n);
            }
    return out;
}
// a w x h RGBA picture as BC7 blocks (rows and columns beyond the picture repeat its edge)
function encodeRect(pic, w, h)
{
    const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), out = new Uint8Array(bw * bh * 16), px = [];
    for (let k = 0; k < 16; k++) px.push([0, 0, 0, 0]);
    for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++)
        {
            for (let k = 0; k < 16; k++)
            {
                const x = Math.min(w - 1, bx * 4 + (k & 3)), y = Math.min(h - 1, by * 4 + (k >> 2)), o = (y * w + x) * 4;
                px[k][0] = pic[o]; px[k][1] = pic[o + 1]; px[k][2] = pic[o + 2]; px[k][3] = pic[o + 3];
            }
            out.set(encodeBlock(px), (by * bw + bx) * 16);
        }
    return out;
}
// the .pct of a sky texture: the stock file's header (its size and mip count read from it), the blocks, the stock tail
function writeSkyPct(file, p, exposure, yaw, stockFile)
{
    const stock = fs.readFileSync(stockFile);
    const w = stock.readUInt32LE(0x10), h = stock.readUInt32LE(0x14), mips = stock.readUInt32LE(0x30);
    const dims = mipDims(w, h, mips), dataLen = dims.reduce((s, [mw, mh]) => s + mw * mh, 0), head = stock.length - dataLen - TAIL;
    if (head < 48 || head > 256 || stock.readUInt32LE(stock.length - 4) !== stock.length) throw new Error(stockFile + ': not a BC7 texture of ' + w + ' x ' + h + ' with ' + mips + ' mips (' + stock.length + ' bytes)');
    let pic = renderSky(p, exposure, yaw, w, h), pw = w, ph = h;
    const parts = [stock.subarray(0, head)];
    for (let m = 0; m < mips; m++)
    {
        parts.push(encodeRect(pic, pw, ph));
        if (m < mips - 1) { pic = halveRect(pic, pw, ph); pw = Math.max(pw >> 1, 4); ph = Math.max(ph >> 1, 4); }
    }
    parts.push(stock.subarray(stock.length - TAIL));
    const out = Buffer.concat(parts);
    if (out.length !== stock.length) throw new Error('the sky came out at ' + out.length + ' bytes, the stock one has ' + stock.length);
    fs.writeFileSync(file, out);
    fs.writeFileSync(file + '_header', stock.subarray(0, head));
    return { w, h, mips };
}

// ---- a copy of a pak with cubes written over their entries (the same size, stored), for a look in the game:
// replacements maps an entry's base name (lower case) to the file that replaces it
function writeTestPak(src, dst, replacements)
{
    const { readZip, readEntry, writePak } = require('./lod_patch.js');
    const fd = fs.openSync(src, 'r');
    try
    {
        const z = readZip(fd), jobs = new Map();
        let grow = 0;
        for (const ent of z.entries)
        {
            const base = ent.name.slice(Math.max(ent.name.lastIndexOf('/'), ent.name.lastIndexOf('\\')) + 1).toLowerCase();
            const file = replacements.get(base);
            if (!file) continue;
            const next = fs.readFileSync(file), { head } = readEntry(fd, ent);
            if (next.length !== ent.usize) throw new Error(base + ': ' + next.length + ' bytes, the entry has ' + ent.usize);
            jobs.set(ent, { head, crc: zlib.crc32(next) >>> 0, usize: next.length, length: next.length, comp: next, next, method: 0, type: 'cube', group: 'cube', notes: [base] });
            grow += next.length - ent.csize;
            replacements.delete(base);
        }
        if (replacements.size) throw new Error('not in the pak: ' + [...replacements.keys()].join(', '));
        const end = z.cdOff + grow + z.cd.length + z.eocd.length;
        writePak(src, dst, { z, jobs, size: z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end });
        return jobs.size;
    }
    finally { fs.closeSync(fd); }
}

if (require.main === module)
{
    const args = process.argv.slice(2), cmd = args[0];
    const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
    try
    {
        const yaw = Number(opt('yaw') || 0);
        if (opt('white') !== null) TONE.white = Number(opt('white'));
        // the cap: --cap N clamps the picture at N times the sky's median (10 by default; 0 for none)
        const capOf = (p) => { const n = opt('cap') === null ? 10 : Number(opt('cap')); TONE.cap = n > 0 ? n * skyMedian(p, yaw) : 0; };
        // the grade of a cube. --sky-rgb r,g,b sets the sky half's mean colour (sRGB, 0..1) and with it its brightness:
        // the picture's white balance moves until the sky half lands on it (a dusk, a dawn or a night at the hue of
        // the game's own cube; with a dark target, a day picture graded to a night). --ground-mean x exposes the
        // ground half apart from the sky, so that its mean luminance lands on x. Returns the exposure and the gain
        const graded = (p) =>
        {
            const rgb = opt('sky-rgb') === null ? null : opt('sky-rgb').split(',').map(Number);
            if (rgb && !(rgb.length === 3 && rgb.every((v) => v > 0 && v < 1))) throw new Error('--sky-rgb takes three values between 0 and 1');
            const target = rgb ? lum(rgb) : Number(opt('sky-mean') || SKY_MEAN);
            capOf(p);
            let exposure = opt('exposure') ? Number(opt('exposure')) : exposureFor(p, target, yaw);
            for (let k = 0; rgb && k < 6; k++)
            {
                const now = halfColour(p, exposure, yaw, false, 1), t = rgb.map((c, i) => linear(c) / Math.max(1e-6, linear(now[i]))), norm = lum(t);
                for (let i = 0; i < p.data.length; i += 3) { p.data[i] *= t[0] / norm; p.data[i + 1] *= t[1] / norm; p.data[i + 2] *= t[2] / norm; }
                capOf(p);
                exposure = exposureFor(p, target, yaw);
            }
            const gain = opt('ground-mean') === null ? 1 : groundGainFor(p, exposure, yaw, Number(opt('ground-mean')));
            if (gain !== 1) applyGround(p, gain);
            return { exposure, gain };
        };
        const rgbText = (c) => c.map((v) => v.toFixed(2)).join('/');
        if (cmd === 'build' && args[1] && args[2] && opt('header'))
        {
            const p = readHdr(args[1]), { exposure, gain } = graded(p);
            const faces = renderFaces(p, exposure, yaw);
            writePct(args[2], faces, opt('header'));
            if (args.includes('--preview')) { facesPng(args[2].replace(/\.pct$/i, '') + '_faces.png', faces); panoPng(args[2].replace(/\.pct$/i, '') + '_pano.png', faces); }
            console.log('built ' + args[2] + ' from ' + path.basename(args[1]) + ' (' + p.w + ' x ' + p.h + '): exposure ' + exposure.toFixed(4) + ', sky mean ' + skyMean(p, exposure, yaw).toFixed(3) + ' (' + rgbText(halfColour(p, exposure, yaw, false, 1)) + '), ground ' + lum(halfColour(p, exposure, yaw, true, 1)).toFixed(3) + ' (' + rgbText(halfColour(p, exposure, yaw, true, 1)) + ', gain ' + gain.toFixed(3) + '), white ' + TONE.white + ', cap ' + TONE.cap.toFixed(3) + ', yaw ' + yaw);
        }
        else if (cmd === 'preview' && args[1] && args[2])
        {
            const p = readHdr(args[1]), { exposure } = graded(p), w = 1024, h = 512, rgb = new Uint8Array(w * h * 3), out = [0, 0, 0];
            for (let j = 0; j < h; j++)
                for (let i = 0; i < w; i++)
                {
                    sample(p, (i + 0.5) / w - yaw / 360, (j + 0.5) / h, out);
                    const d = (j * w + i) * 3;
                    rgb[d] = encode(out[0], exposure); rgb[d + 1] = encode(out[1], exposure); rgb[d + 2] = encode(out[2], exposure);
                }
            png(args[2], w, h, rgb);
            console.log('wrote ' + args[2] + ': exposure ' + exposure.toFixed(4));
        }
        else if (cmd === 'sky' && args[1] && args[2] && opt('header'))
        {
            const p = readHdr(args[1]);
            capOf(p);
            const exposure = opt('exposure') ? Number(opt('exposure')) : exposureFor(p, Number(opt('sky-mean') || SKY_TEX_MEAN), yaw);
            const t = writeSkyPct(args[2], p, exposure, yaw, opt('header'));
            console.log('built ' + args[2] + ' from ' + path.basename(args[1]) + ' (' + p.w + ' x ' + p.h + '): ' + t.w + ' x ' + t.h + ', ' + t.mips + ' mips, exposure ' + exposure.toFixed(4) + ', white ' + TONE.white + ', cap ' + TONE.cap.toFixed(3) + ', yaw ' + yaw);
        }
        else if (cmd === 'pak' && args[1] && args[2] && args.length > 3)
        {
            const map = new Map();
            for (const a of args.slice(3)) { const m = /^([^=]+)=(.+)$/.exec(a); if (!m) throw new Error('expected <entry name>=<file>: ' + a); map.set(m[1].toLowerCase(), m[2]); }
            console.log('wrote ' + args[2] + ' with ' + writeTestPak(args[1], args[2], map) + ' entries replaced');
        }
        else console.log('usage: node make_cube.js build <panorama.hdr> <out.pct> --header <stock.pct> [--exposure <x> | --sky-mean <0..1>] [--sky-rgb <r,g,b>] [--ground-mean <0..1>] [--white <w>] [--cap <n>] [--yaw <degrees>] [--preview] | preview <panorama.hdr> <out.png> [the same options] | pak <in.pak> <out.pak> <entry name>=<cube.pct> ...');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
module.exports = { readHdr, renderFaces, encodeBlock, encodeFace, writePct, faceDir, dirToFace, SIZE, MIPS };
