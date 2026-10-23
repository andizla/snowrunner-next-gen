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
//            [--sky-rgb <r,g,b>] [--top-mean <0..1>] [--ground-mean <0..1>] [--yaw <degrees>] [--preview]   writes the
//            .pct and its .pct_header; --sky-rgb white-balances the picture to a mean sky colour (a dusk, dawn or night
//            at the hue of the game's cube), --top-mean sets how bright the sky is straight overhead, --ground-mean
//            exposes the ground half apart from the sky, --bottom-mean sets how bright the ground is straight down
//            (the three take r,g,b for a colour in place of a luminance);
//            --preview also
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
// ground half under a ground gain (one per channel)
function halfColour(p, exposure, yaw, down, gain = [1, 1, 1])
{
    const out = [0, 0, 0], sum = [0, 0, 0];
    let n = 0;
    for (let j = 0; j < 64; j++)
        for (let i = 0; i < 128; i++)
        {
            const theta = (j + 0.5) / 64 * (Math.PI / 2), phi = (i + 0.5) / 128 * 2 * Math.PI;   // a hemisphere from its pole, equal solid angle weight
            const w = Math.sin(theta), e = theta - Math.PI / 2;
            const [u, v] = dirToUv(Math.sin(theta) * Math.sin(phi), (down ? -1 : 1) * Math.cos(theta), Math.sin(theta) * Math.cos(phi), yaw);
            sample(p, u, v, out);
            for (let c = 0; c < 3; c++) sum[c] += w * encode(down ? out[c] * groundFactor(e, gain[c]) : out[c], exposure) / 255;
            n += w;
        }
    return sum.map((s) => s / n);
}
// the mean sRGB luminance of the sky half at an exposure
const skyMean = (p, exposure, yaw) => lum(halfColour(p, exposure, yaw, false));
// the zenith gain: a factor on the sky, one per channel, that goes from 1 at ZENITH_FROM of elevation to the gain at
// ZENITH_TO and above. It sets how much of the sky's light comes from straight up, and in what colour: the game's night
// cubes are dark overhead with a glow at the horizon, a photograph of a night sky is even. Laid into the picture's rows
// With down the same below the horizon, towards straight down: a photograph is brightest at the camera's feet, the
// game's cubes are darkest there.
const ZENITH_FROM = 15 * Math.PI / 180, ZENITH_TO = 50 * Math.PI / 180;
function applyZenith(p, gain, down = false)
{
    for (let j = 0; j < p.h; j++)
    {
        const e = (0.5 - (j + 0.5) / p.h) * Math.PI * (down ? -1 : 1), t = Math.max(0, Math.min(1, (e - ZENITH_FROM) / (ZENITH_TO - ZENITH_FROM))), s = t * t * (3 - 2 * t);
        if (s > 0) for (let i = j * p.w * 3, end = i + p.w * 3; i < end; i += 3) for (let c = 0; c < 3; c++) p.data[i + c] *= 1 + (gain[c] - 1) * s;
    }
}
// the mean sRGB colour of the top face (+Y), or with down of the bottom face (-Y), at an exposure, from 32 x 32 directions
function topColour(p, exposure, yaw, down = false)
{
    const out = [0, 0, 0], sum = [0, 0, 0];
    for (let j = 0; j < 32; j++)
        for (let i = 0; i < 32; i++)
        {
            const d = faceDir(down ? 3 : 2, (i + 0.5) / 32, (j + 0.5) / 32), [u, v] = dirToUv(d[0], d[1], d[2], yaw);
            sample(p, u, v, out);
            for (let c = 0; c < 3; c++) sum[c] += encode(out[c], exposure) / 255;
        }
    return sum.map((s) => s / 1024);
}
// the exposure that puts the sky half at the target (bisection in log space)
function exposureFor(p, target, yaw)
{
    let lo = -14, hi = 14;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (skyMean(p, Math.pow(2, mid), yaw) < target) lo = mid; else hi = mid; }
    return Math.pow(2, (lo + hi) / 2);
}
// the ground gains [r, g, b] that put the ground half at the target (bisection in log space): one gain for all three
// when the target is a luminance, a gain per channel when it is a colour. And the gains laid into the picture
function groundGainFor(p, exposure, yaw, target)
{
    const solve = (below) =>
    {
        let lo = -10, hi = 10;
        for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (below(Math.pow(2, mid))) lo = mid; else hi = mid; }
        return Math.pow(2, (lo + hi) / 2);
    };
    if (Array.isArray(target)) return target.map((t, c) => solve((g) => halfColour(p, exposure, yaw, true, [g, g, g])[c] < t));
    const one = solve((g) => lum(halfColour(p, exposure, yaw, true, [g, g, g])) < target);
    return [one, one, one];
}
function applyGround(p, gain)
{
    for (let j = 0; j < p.h; j++)
    {
        const e = (0.5 - (j + 0.5) / p.h) * Math.PI;
        if (e < 0) for (let i = j * p.w * 3, end = i + p.w * 3; i < end; i += 3) for (let c = 0; c < 3; c++) p.data[i + c] *= groundFactor(e, gain[c]);
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
    fs.writeFileSync(file + '_header', pctHeader(stock.subarray(0, HEAD)));
}
// the .pct_header the game keeps beside a .pct: the .pct's header with its last record (type 0xff, the length of the data
// after it) turned into type 1 with the header's own length, as every pair in the stock boot.pak has it (349 of them,
// checked 2026-10-23; written as the .pct's head before then)
function pctHeader(head)
{
    const h = Buffer.from(head);
    if (h.length >= 8 && h[h.length - 6] === 0xff) { h[h.length - 6] = 1; h.writeUInt32LE(h.length, h.length - 4); }
    return h;
}

// ---- a sky texture: the sphere_sky layer of a region's sky (classes\skies\sky_<region>.xml) is a panorama of the
// upper hemisphere, w x h BC7 with mips down to 4 x 4 blocks (the stock ones 8192 x 2048, 12 mips), azimuth across,
// elevation 90 degrees at the top row and the horizon at the bottom, its alpha fading out over the lowest rows.
// Rendered from the panorama one bilinear sample per texel, the same exposure as the cubes, alpha 255 down to
// HORIZON_FADE of the height, then to 0 (the stock sky_01_ru_03_day fades over its lowest 11 %). The layers are drawn
// times their DiffuseMultiplier (4 to 8 by day), so the texture itself is darker than a cube: SKY_TEX_MEAN
const HORIZON_FADE = 0.11, SKY_TEX_MEAN = 0.45;   // the stock Kola day skies: 0.42 and 0.47
const RAW_HEAD = 82;   // the header of a one-level texture, compressed or not
// the zenith cap: every column of a dome texture meets at the zenith, so what a row holds up there is squeezed into
// wedges around a point, and the game closes its dome above about 81 degrees with a fan of triangles that shows as a
// ring (seen in the game, 2026-10-23); from CAP_FROM up each row is blended towards its own mean colour and alpha, wholly
// at CAP_TO, so the zenith holds a plain sky. elevationOf(j): the elevation in degrees of row j
const CAP_FROM = 66, CAP_TO = 86;
function zenithCap(rgba, w, h, elevationOf)
{
    for (let j = 0; j < h; j++)
    {
        const e = elevationOf(j);
        if (e <= CAP_FROM) continue;
        const t0 = Math.min(1, (e - CAP_FROM) / (CAP_TO - CAP_FROM)), t = t0 * t0 * (3 - 2 * t0), m = [0, 0, 0, 0];
        for (let i = 0; i < w; i++) for (let c = 0; c < 4; c++) m[c] += rgba[(j * w + i) * 4 + c];
        for (let c = 0; c < 4; c++) m[c] /= w;
        for (let i = 0; i < w; i++) for (let c = 0; c < 4; c++) { const o = (j * w + i) * 4 + c; rgba[o] = Math.round(rgba[o] + (m[c] - rgba[o]) * t); }
    }
    return rgba;
}
// look: { fade: the share of the height the alpha fades over at the bottom (0: opaque), grey: luminance only (the
// game's grey cloud skies, which a state tints), cap: false leaves the zenith as the panorama has it }
function renderSky(p, exposure, yaw, w, h, look = { fade: HORIZON_FADE, grey: false })
{
    const rgba = new Uint8Array(w * h * 4), out = [0, 0, 0];
    for (let j = 0; j < h; j++)
    {
        const v = (j + 0.5) / h / 2, fade = look.fade > 0 ? (h - 1 - j) / (h * look.fade) : 1, alpha = Math.max(0, Math.min(255, Math.round(fade * 255)));
        for (let i = 0; i < w; i++)
        {
            sample(p, (i + 0.5) / w - yaw / 360, v, out);
            const o = (j * w + i) * 4;
            rgba[o] = encode(out[0], exposure); rgba[o + 1] = encode(out[1], exposure); rgba[o + 2] = encode(out[2], exposure); rgba[o + 3] = alpha;
            if (look.grey) rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round(0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2]);
        }
    }
    return look.cap === false ? rgba : zenithCap(rgba, w, h, (j) => 90 * (1 - (j + 0.5) / h));
}
// the mean sRGB colour (0..1) of a sky texture at an exposure: the panorama's upper half, every row the same weight
// as in the texture, from 256 x 64 samples
function texColour(p, exposure)
{
    const out = [0, 0, 0], sum = [0, 0, 0];
    for (let j = 0; j < 64; j++)
        for (let i = 0; i < 256; i++)
        {
            sample(p, (i + 0.5) / 256, (j + 0.5) / 128, out);
            for (let c = 0; c < 3; c++) sum[c] += encode(out[c], exposure) / 255;
        }
    return sum.map((s) => s / (256 * 64));
}
// the sun taken out of a panorama: the game draws its own sun, and a sky layer may turn. The brightest spot of the
// upper half is the sun when it stands far above the sky's median. Its glare is measured as a gain over each row's
// sky on the far side, by the angle from the sun, and divided out as far as SUN_REACH degrees, so the clouds near
// the sun stay and the sky around it comes down to the far side's; the disc itself, where the glare is over SUN_GLARE,
// is filled from around it. Returns the disc's radius in degrees, 0 when the sky has no sun to take out. SUN_LOW: the
// share of a ring under its glare gain (clouds lit by the sun stand above the sky; the median of a ring half covered
// by them took the sky beside them too far down, a dark ring around the sun seen in the game, 2026-10-23)
const SUN_GLARE = 30, SUN_REACH = 100, SUN_REACH_COS = Math.cos(SUN_REACH * Math.PI / 180), SUN_CLEAR = 0.12, SUN_LOW = 0.25, SUN_EDGE = 4;
function removeSun(p)
{
    const lumAt = (i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2], half = p.h >> 1, lums = [];
    let best = -1, bx = 0, by = 0;
    for (let y = 0; y < half; y += 4)
        for (let x = 0; x < p.w; x += 4) { const l = lumAt((y * p.w + x) * 3); lums.push(l); if (l > best) { best = l; bx = x; by = y; } }
    lums.sort((a, b) => a - b);
    const median = lums[lums.length >> 1];
    if (!(best > 20 * median)) return 0;
    const dirOf = (u, v) => { const phi = u * 2 * Math.PI, theta = v * Math.PI; return [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)]; };
    const uvOf = (d) => [((Math.atan2(d[0], d[2]) / (2 * Math.PI)) % 1 + 1) % 1, Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI];
    const sun = dirOf((bx + 0.5) / p.w, (by + 0.5) / p.h), up = Math.abs(sun[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
    const e1 = unit(cross(sun, up)), e2 = cross(sun, e1), out = [0, 0, 0], SECTORS = 96;
    const ringAt = (deg, k) =>
    {
        const r = deg * Math.PI / 180, f = (k / SECTORS) * 2 * Math.PI, d = [0, 1, 2].map((c) => Math.cos(r) * sun[c] + Math.sin(r) * (Math.cos(f) * e1[c] + Math.sin(f) * e2[c]));
        const [u, v] = uvOf(d);
        sample(p, u, Math.min(v, 0.5), out);   // below the horizon a pure sky holds nothing of its own: the horizon's row stands in
        return [out[0], out[1], out[2]];
    };
    // each row's own sky on the side away from the sun: the median colour of its texels more than 90 degrees from it
    const farSky = new Float32Array(half * 3);
    for (let y = 0; y < half; y++)
    {
        let far = [];
        for (let x = 0; x < p.w; x += 8)
        {
            const d = dirOf((x + 0.5) / p.w, (y + 0.5) / p.h), o = (y * p.w + x) * 3;
            if (d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2] < 0) far.push([lumAt(o), o]);
        }
        if (far.length < 16) { far = []; for (let x = 0; x < p.w; x += 8) far.push([lumAt((y * p.w + x) * 3), (y * p.w + x) * 3]); }
        far.sort((a, b) => a[0] - b[0]);
        const m = far[far.length >> 1][1];
        farSky[y * 3] = p.data[m]; farSky[y * 3 + 1] = p.data[m + 1]; farSky[y * 3 + 2] = p.data[m + 2];
    }
    // the glare by its angle from the sun, a gain per channel: for each degree, around the ring, the texels over their
    // row's far sky, ranked by brightness, the mean of the ones about SUN_LOW up (each channel from the same texels, so
    // the gain keeps one hue). Made to fall steadily outwards, eased over the degrees (a step from one degree to the
    // next showed as a coloured ring), and to end at 1 at SUN_REACH
    const glare = [];
    for (let deg = 1; deg <= SUN_REACH; deg++)
    {
        const ratios = [];
        for (let k = 0; k < SECTORS; k++)
        {
            const r = deg * Math.PI / 180, f = (k / SECTORS) * 2 * Math.PI, d = [0, 1, 2].map((c) => Math.cos(r) * sun[c] + Math.sin(r) * (Math.cos(f) * e1[c] + Math.sin(f) * e2[c]));
            const [u, v] = uvOf(d);
            if (v >= 0.5) continue;   // below the horizon
            sample(p, u, v, out);
            const y = Math.min(half - 1, Math.floor(v * p.h)), g = [0, 1, 2].map((c) => out[c] / Math.max(1e-9, farSky[y * 3 + c]));
            ratios.push([0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2], g]);
        }
        if (ratios.length < 8) { glare.push(null); continue; }
        ratios.sort((a, b) => a[0] - b[0]);
        const lo = Math.floor(ratios.length * (SUN_LOW - 0.1)), hi = Math.max(lo + 1, Math.floor(ratios.length * (SUN_LOW + 0.1))), g = [0, 0, 0];
        for (let i = lo; i < hi; i++) for (let c = 0; c < 3; c++) g[c] += ratios[i][1][c] / (hi - lo);
        glare.push(g.map((x) => Math.max(1, x)));
    }
    for (let i = glare.length - 1; i >= 0; i--)
    {
        if (!glare[i]) glare[i] = i + 1 < glare.length ? glare[i + 1].slice() : [1, 1, 1];
        if (i + 1 < glare.length) for (let c = 0; c < 3; c++) glare[i][c] = Math.max(glare[i][c], glare[i + 1][c]);
    }
    for (let pass = 0; pass < 3; pass++)
    {
        const was = glare.map((g) => g.map(Math.log));
        for (let i = 2; i < glare.length - 1; i++) for (let c = 0; c < 3; c++) glare[i][c] = Math.exp((was[i - 1][c] + 2 * was[i][c] + was[i + 1][c]) / 4);
    }
    // under a cloud sheet the light around the sun is the sheet's own, not a glare over a clear sky: there only the
    // disc is filled. A sky counts as clear when the median blueness of its far side is over SUN_CLEAR
    const blues = [];
    for (let y = 0; y < half; y += 8) blues.push((farSky[y * 3 + 2] - farSky[y * 3]) / (farSky[y * 3 + 2] + farSky[y * 3] + 1e-9));
    blues.sort((a, b) => a - b);
    const clear = blues[blues.length >> 1] > SUN_CLEAR, core = glare.slice(0, 6).map((g) => g.slice()), glow = glare.map((g) => 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]);
    if (!clear) for (const g of glare) g[0] = g[1] = g[2] = 1;
    const step = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let y = 0; y < half; y++)
        for (let x = 0; x < p.w; x++)
        {
            const d = dirOf((x + 0.5) / p.w, (y + 0.5) / p.h), dot = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
            if (dot <= SUN_REACH_COS) continue;
            const deg = Math.acos(Math.min(1, dot)) * 180 / Math.PI, at = Math.max(0, Math.min(glare.length - 1.001, deg - 1)), i0 = Math.floor(at), t = at - i0;
            const keep = 1 - step(SUN_REACH - 25, SUN_REACH, deg), o = (y * p.w + x) * 3;
            for (let c = 0; c < 3; c++) p.data[o + c] /= 1 + (glare[i0][c] * (1 - t) + glare[i0 + 1][c] * t - 1) * keep;
        }
    // the disc itself, out to where the glare was under SUN_GLARE times the far sky (2 to 6 degrees): what is left
    // there is noise, and it is filled from what stands around it, as the picture is now
    let radius = 6;
    for (let i = 1; i < 6; i++) if (0.2126 * core[i][0] + 0.7152 * core[i][1] + 0.0722 * core[i][2] < SUN_GLARE) { radius = Math.max(2, i + 1); break; }
    // (a membrane stretched over the ring just outside it: at the rim each direction has the colour that stands there, sky
    // or cloud, and towards the middle the differences fade, faster the finer they are, to the ring's mean at the centre;
    // carrying each direction's colour straight in met at the centre as a pinwheel, seen in the game, 2026-10-23. On it
    // goes the detail of a patch as big at the same elevation far round the sky, as its brightness over that patch's own
    // membrane, so a cloud deck carries on through the disc; of the patches the one whose ring varies most like the
    // disc's. Under a cloud sheet the glow stays, and the fill rises with it towards the middle, level from the disc's
    // edge in: a level fill under the glow came out as a dark spot)
    const edge = clear ? SUN_EDGE : 1.5, rim = radius + edge + 0.5, HARM = SECTORS >> 1;
    const glowAt = (deg) => { const at = Math.max(0, Math.min(glow.length - 1.001, deg - 1)), i0 = Math.floor(at); return glow[i0] + (glow[i0 + 1] - glow[i0]) * (at - i0); };
    const rise = (deg) => (clear ? 1 : glowAt(Math.max(deg, radius)) / glowAt(rim));
    const lum = (q) => 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2];
    const spin = (d, a) => [Math.cos(a) * d[0] + Math.sin(a) * d[2], d[1], -Math.sin(a) * d[0] + Math.cos(a) * d[2]];
    const ringOf = (turn) => { const ring = []; for (let k = 0; k < SECTORS; k++) { const r = rim * Math.PI / 180, f = (k / SECTORS) * 2 * Math.PI, d = spin([0, 1, 2].map((c) => Math.cos(r) * sun[c] + Math.sin(r) * (Math.cos(f) * e1[c] + Math.sin(f) * e2[c])), turn), [u, v] = uvOf(d); sample(p, u, Math.min(v, 0.499), out); ring.push([out[0], out[1], out[2]]); } return ring; };
    const membraneOf = (ring) =>
    {
        const ca = [], sa = [];
        for (let n = 0; n <= HARM; n++)
        {
            const a = [0, 0, 0], b = [0, 0, 0], s = n === 0 || n === HARM ? 1 / SECTORS : 2 / SECTORS;
            for (let k = 0; k < SECTORS; k++) { const f = 2 * Math.PI * n * k / SECTORS; for (let c = 0; c < 3; c++) { a[c] += ring[k][c] * Math.cos(f) * s; b[c] += ring[k][c] * Math.sin(f) * s; } }
            ca.push(a); sa.push(b);
        }
        return (rho, f, c) => { let v = ca[0][c], pw = 1; for (let n = 1; n <= HARM; n++) { pw *= rho; if (pw < 1e-4) break; v += pw * (ca[n][c] * Math.cos(n * f) + sa[n][c] * Math.sin(n * f)); } return v; };
    };
    const around = ringOf(0), membrane = membraneOf(around);
    // the patch: turned about the vertical 60 to 300 degrees, clear of the glare (none near the zenith, where a turn
    // moves little)
    const spread = (ring) => { const l = ring.map(lum), m = l.reduce((s, x) => s + x, 0) / l.length; return Math.sqrt(l.reduce((s, x) => s + (x - m) ** 2, 0) / l.length) / Math.max(1e-9, m); };
    const elev = Math.asin(Math.max(-1, Math.min(1, sun[1]))), want = spread(around);
    let patch = null;
    if (Math.cos(elev) * Math.sin(Math.PI / 6) > Math.sin((2 * rim + 1) / 2 * Math.PI / 180))
    {
        let bestErr = Infinity;
        for (let deg = 60; deg <= 300; deg += 30)
        {
            const turn = deg * Math.PI / 180, ring = ringOf(turn), err = Math.abs(spread(ring) - want);
            if (err < bestErr) { bestErr = err; patch = { turn, membrane: membraneOf(ring) }; }
        }
    }
    const rows = Math.ceil((rim + 1) / 180 * p.h), cosEdge = Math.cos((radius + edge) * Math.PI / 180), src = [0, 0, 0], pm = [0, 0, 0];
    for (let y = Math.max(0, by - rows); y <= Math.min(half - 1, by + rows); y++)
        for (let x = 0; x < p.w; x++)
        {
            const d = dirOf((x + 0.5) / p.w, (y + 0.5) / p.h), dot = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
            if (dot <= cosEdge) continue;
            const f = Math.atan2(d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2], d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2]), deg = Math.acos(Math.min(1, dot)) * 180 / Math.PI;
            const w = 1 - step(radius, radius + edge, deg), o = (y * p.w + x) * 3;
            let detail = 1;
            if (patch)
            {
                const [u, v] = uvOf(spin(d, patch.turn));
                sample(p, u, Math.min(v, 0.499), src);
                for (let c = 0; c < 3; c++) pm[c] = patch.membrane(deg / rim, f, c);
                detail = Math.max(0.5, Math.min(2, lum(src) / Math.max(1e-9, lum(pm))));
            }
            const gain = rise(deg) * detail;
            for (let c = 0; c < 3; c++) p.data[o + c] += (Math.max(0, membrane(deg / rim, f, c)) * gain - p.data[o + c]) * w;
        }
    p.sun = { dir: sun, radius, outer: radius + edge + 1 };   // where it was and how far the disc's fill reaches, for a caller that cuts clouds out
    return radius;
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
function writeSkyPct(file, p, exposure, yaw, stockFile, look)
{
    const stock = fs.readFileSync(stockFile);
    const w = stock.readUInt32LE(0x10), h = stock.readUInt32LE(0x14), mips = stock.readUInt32LE(0x30);
    if (stock.length === RAW_HEAD + w * h * 4 + TAIL)
    {
        // an uncompressed texture (Kola's two variant skies, 4098 x 1024, one level): the picture as B, G, R, A bytes
        const rgba = renderSky(p, exposure, yaw, w, h, look), raw = Buffer.alloc(w * h * 4);
        for (let i = 0; i < w * h; i++) { raw[i * 4] = rgba[i * 4 + 2]; raw[i * 4 + 1] = rgba[i * 4 + 1]; raw[i * 4 + 2] = rgba[i * 4]; raw[i * 4 + 3] = rgba[i * 4 + 3]; }
        if (look && look.preview) { const pv = renderSky(p, exposure, yaw, 1024, 256, look), rgb = new Uint8Array(1024 * 256 * 3); for (let i = 0; i < 1024 * 256; i++) { rgb[i * 3] = pv[i * 4]; rgb[i * 3 + 1] = pv[i * 4 + 1]; rgb[i * 3 + 2] = pv[i * 4 + 2]; } png(look.preview, 1024, 256, rgb); }
        fs.writeFileSync(file, Buffer.concat([stock.subarray(0, RAW_HEAD), raw, stock.subarray(stock.length - TAIL)]));
        fs.writeFileSync(file + '_header', pctHeader(stock.subarray(0, RAW_HEAD)));
        return { w, h, mips: 1 };
    }
    const dims = mipDims(w, h, mips), dataLen = dims.reduce((s, [mw, mh]) => s + Math.ceil(mw / 4) * Math.ceil(mh / 4) * 16, 0), head = stock.length - dataLen - TAIL;   // whole blocks: a level 550 texels high has 138 rows of them
    if (head < 48 || head > 256 || stock.readUInt32LE(stock.length - 4) !== stock.length) throw new Error(stockFile + ': not a BC7 texture of ' + w + ' x ' + h + ' with ' + mips + ' mips (' + stock.length + ' bytes)');
    let pic = renderSky(p, exposure, yaw, w, h, look), pw = w, ph = h;
    if (look && look.preview) { const pv = renderSky(p, exposure, yaw, 1024, 256, look), rgb = new Uint8Array(1024 * 256 * 3); for (let i = 0; i < 1024 * 256; i++) { rgb[i * 3] = pv[i * 4]; rgb[i * 3 + 1] = pv[i * 4 + 1]; rgb[i * 3 + 2] = pv[i * 4 + 2]; } png(look.preview, 1024, 256, rgb); }
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
    fs.writeFileSync(file + '_header', pctHeader(stock.subarray(0, head)));
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
        // the game's own cube; with a dark target, a day picture graded to a night). --top-mean x moves the sky's light
        // between straight up and the horizon until the top face's mean luminance lands on x, the sky half keeping
        // its own. --ground-mean x exposes the ground half apart from the sky, so that its mean luminance lands on
        // x, and --bottom-mean x does below the horizon what --top-mean does above it, for the bottom face. The three
        // take a colour r,g,b in place of x: then the face, or the ground half, lands on that colour. Returns the
        // exposure and the ground gains
        const graded = (p) =>
        {
            const value = (name) =>
            {
                if (opt(name) === null) return null;
                const v = opt(name).split(',').map(Number);
                if (!((v.length === 1 || v.length === 3) && v.every((x) => x > 0 && x < 1))) throw new Error('--' + name + ' takes one value or three between 0 and 1');
                return v.length === 1 ? v[0] : v;
            };
            const rgb = value('sky-rgb'), top = value('top-mean'), ground = value('ground-mean'), bottom = value('bottom-mean');
            if (rgb !== null && !Array.isArray(rgb)) throw new Error('--sky-rgb takes three values');
            const target = rgb ? lum(rgb) : Number(opt('sky-mean') || SKY_MEAN);
            capOf(p);
            let exposure = opt('exposure') ? Number(opt('exposure')) : exposureFor(p, target, yaw);
            const ratio = (want, now) => linear(want) / Math.max(1e-6, linear(now));
            for (let k = 0; (rgb || top !== null) && k < 12; k++)
            {
                if (rgb)
                {
                    const now = halfColour(p, exposure, yaw, false), t = rgb.map((c, i) => ratio(c, now[i])), norm = lum(t);
                    for (let i = 0; i < p.data.length; i += 3) { p.data[i] *= t[0] / norm; p.data[i + 1] *= t[1] / norm; p.data[i + 2] *= t[2] / norm; }
                    capOf(p);
                    exposure = exposureFor(p, target, yaw);
                }
                if (top !== null)
                {
                    const now = topColour(p, exposure, yaw), one = Array.isArray(top) ? 0 : ratio(top, lum(now));
                    applyZenith(p, Array.isArray(top) ? top.map((c, i) => ratio(c, now[i])) : [one, one, one]);
                    capOf(p);
                    exposure = exposureFor(p, target, yaw);
                }
            }
            // below the horizon: the bottom face to its target, then the whole ground half to its own, in turns
            let gain = [1, 1, 1];
            for (let k = 0; (ground !== null || bottom !== null) && k < (bottom !== null ? 12 : 1); k++)
            {
                if (bottom !== null)
                {
                    const now = topColour(p, exposure, yaw, true), one = Array.isArray(bottom) ? 0 : ratio(bottom, lum(now));
                    applyZenith(p, Array.isArray(bottom) ? bottom.map((c, i) => ratio(c, now[i])) : [one, one, one], true);
                }
                if (ground !== null) { const g = groundGainFor(p, exposure, yaw, ground); applyGround(p, g); gain = gain.map((v, c) => v * g[c]); }
            }
            return { exposure, gain };
        };
        const rgbText = (c) => c.map((v) => v.toFixed(2)).join('/');
        if (cmd === 'build' && args[1] && args[2] && opt('header'))
        {
            const p = readHdr(args[1]), { exposure, gain } = graded(p);
            const faces = renderFaces(p, exposure, yaw);
            writePct(args[2], faces, opt('header'));
            if (args.includes('--preview')) { facesPng(args[2].replace(/\.pct$/i, '') + '_faces.png', faces); panoPng(args[2].replace(/\.pct$/i, '') + '_pano.png', faces); }
            console.log('built ' + args[2] + ' from ' + path.basename(args[1]) + ' (' + p.w + ' x ' + p.h + '): exposure ' + exposure.toFixed(4) + ', sky mean ' + skyMean(p, exposure, yaw).toFixed(3) + ' (' + rgbText(halfColour(p, exposure, yaw, false)) + '), top ' + lum(topColour(p, exposure, yaw)).toFixed(3) + ' (' + rgbText(topColour(p, exposure, yaw)) + '), ground ' + lum(halfColour(p, exposure, yaw, true)).toFixed(3) + ' (' + rgbText(halfColour(p, exposure, yaw, true)) + ', gain ' + gain.map((g) => g.toFixed(3)).join('/') + '), white ' + TONE.white + ', cap ' + TONE.cap.toFixed(3) + ', yaw ' + yaw);
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
            // --no-sun takes the panorama's sun out; --tex-rgb r,g,b white-balances and exposes the picture until the
            // texture's own mean colour lands on it (the stock texture's, so a state's tint works on it as before);
            // --fade x sets the share of the height the alpha fades over at the bottom (0: opaque); --grey writes the
            // luminance alone; --preview writes <out>.png, 1024 x 256
            const p = readHdr(args[1]), sunRadius = args.includes('--no-sun') ? removeSun(p) : 0;
            capOf(p);
            const want = opt('tex-rgb') === null ? null : opt('tex-rgb').split(',').map(Number);
            if (want && !(want.length === 3 && want.every((v) => v > 0 && v < 1))) throw new Error('--tex-rgb takes three values between 0 and 1');
            let exposure = opt('exposure') ? Number(opt('exposure')) : exposureFor(p, Number(opt('sky-mean') || SKY_TEX_MEAN), yaw);
            for (let k = 0; want && k < 12; k++)
            {
                // a grey texture keeps the picture's own balance (a blue sky is darker than its clouds) and takes the brightness alone
                const now = texColour(p, exposure), one = linear(lum(want)) / Math.max(1e-6, linear(lum(now)));
                const t = args.includes('--grey') ? [one, one, one] : want.map((c, i) => linear(c) / Math.max(1e-6, linear(now[i])));
                for (let i = 0; i < p.data.length; i += 3) { p.data[i] *= t[0]; p.data[i + 1] *= t[1]; p.data[i + 2] *= t[2]; }
                capOf(p);
            }
            const look = { fade: opt('fade') === null ? HORIZON_FADE : Number(opt('fade')), grey: args.includes('--grey'), cap: !args.includes('--no-cap'), preview: args.includes('--preview') ? args[2].replace(/\.pct$/i, '') + '.png' : null };
            const t = writeSkyPct(args[2], p, exposure, yaw, opt('header'), look);
            console.log('built ' + args[2] + ' from ' + path.basename(args[1]) + ' (' + p.w + ' x ' + p.h + '): ' + t.w + ' x ' + t.h + ', ' + t.mips + ' mips, exposure ' + exposure.toFixed(4) + ', mean ' + texColour(p, exposure).map((v) => v.toFixed(2)).join('/') + ', sun ' + (sunRadius ? 'taken out, ' + sunRadius + ' degrees' : 'left') + ', fade ' + look.fade + (look.grey ? ', grey' : '') + ', white ' + TONE.white + ', cap ' + TONE.cap.toFixed(3) + ', yaw ' + yaw);
        }
        else if (cmd === 'pak' && args[1] && args[2] && args.length > 3)
        {
            const map = new Map();
            for (const a of args.slice(3)) { const m = /^([^=]+)=(.+)$/.exec(a); if (!m) throw new Error('expected <entry name>=<file>: ' + a); map.set(m[1].toLowerCase(), m[2]); }
            console.log('wrote ' + args[2] + ' with ' + writeTestPak(args[1], args[2], map) + ' entries replaced');
        }
        else console.log('usage: node make_cube.js build <panorama.hdr> <out.pct> --header <stock.pct> [--exposure <x> | --sky-mean <0..1>] [--sky-rgb <r,g,b>] [--top-mean <x | r,g,b>] [--ground-mean <x | r,g,b>] [--bottom-mean <x | r,g,b>] [--white <w>] [--cap <n>] [--yaw <degrees>] [--preview] | preview <panorama.hdr> <out.png> [the same options] | pak <in.pak> <out.pak> <entry name>=<cube.pct> ...');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}
module.exports = { readHdr, renderFaces, encodeBlock, encodeFace, writePct, faceDir, dirToFace, removeSun, zenithCap, pctHeader, SIZE, MIPS };
