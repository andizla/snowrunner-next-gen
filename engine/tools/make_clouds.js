// SPDX-License-Identifier: GPL-3.0-only
// Cloud bands for SnowRunner from a panoramic picture of a real sky. Three of a sky's layers (clouds_rear, clouds_mid,
// clouds_near in classes\skies\sky_<region>.xml) turn a band of clouds around the map: a texture eight times as wide as
// it is high (4096 x 512, 2048 x 256, 1024 x 128) or four times (4096 x 1024), BC7 with mips, whose alpha is the
// clouds' shape and whose colour is their shading in grey, or plain white where the state alone colours them
// (DiffuseMultiplier). This build-time tool cuts such a band out of an equirectangular panorama in Radiance .hdr:
// azimuth across, an elevation window from top to bottom. What is cloud and what is sky is told by colour: a clear sky
// is blue, a cloud is not. For each row the sky's blueness is the row's 85th percentile of (B - R) / (B + R); a texel's
// cloudiness is how far its own blueness falls below that, and the alpha is a soft step over the cloudiness, set so
// that the band's mean alpha lands on --coverage (the stock band's). The band fades out at its upper and lower edge, as
// the game's bands do. The colour is the texel's luminance over the brightest cloud's, so a state's tint works on it
// as on the game's. The header and the tail come from the stock texture, so size, mips and format are the game's.
// usage: node make_clouds.js band <panorama.hdr> <out.pct> --header <stock.pct> --from <deg> --to <deg>
//            [--coverage <0..1>] [--shade <0..1>] [--white] [--yaw <degrees>] [--preview]
//        --from and --to: the elevation of the band's lower and upper edge; --shade: the clouds' mean grey (the stock
//        band's, weighted by its alpha); --white: plain white colour;
//        --preview writes <out>.png, the band over a mid grey
'use strict';
const fs = require('fs'), zlib = require('zlib');
const { readHdr, encodeBlock, removeSun } = require('./make_cube.js');

const TAIL = 6, EDGE = 0.16, FOOT_MIN = 0.12;   // the .pct's last bytes; the share of the height each edge fades over; the least cloudiness that counts as cloud
const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// a bilinear sample of the panorama at (u, v), u wrapping
function sample(p, u, v, out)
{
    const x = ((u % 1) + 1) % 1 * p.w - 0.5, y = Math.max(0, Math.min(p.h - 1, v * p.h - 0.5)), x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = ((x0 % p.w) + p.w) % p.w, xb = (xa + 1) % p.w, ya = Math.max(0, y0), yb = Math.min(p.h - 1, y0 + 1);
    for (let c = 0; c < 3; c++)
        out[c] = (p.data[(ya * p.w + xa) * 3 + c] * (1 - fx) + p.data[(ya * p.w + xb) * 3 + c] * fx) * (1 - fy) + (p.data[(yb * p.w + xa) * 3 + c] * (1 - fx) + p.data[(yb * p.w + xb) * 3 + c] * fx) * fy;
}
// the band as linear luminance and cloudiness per texel: { lum, cloud } (Float32Array w * h each)
function readBand(p, w, h, from, to, yaw)
{
    const lum = new Float32Array(w * h), blue = new Float32Array(w * h), cloud = new Float32Array(w * h), out = [0, 0, 0], row = new Float32Array(w);
    for (let j = 0; j < h; j++)
    {
        const v = 0.5 - (to - (j + 0.5) / h * (to - from)) / 180;
        for (let i = 0; i < w; i++)
        {
            sample(p, (i + 0.5) / w - yaw / 360, v, out);
            lum[j * w + i] = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
            blue[j * w + i] = row[i] = (out[2] - out[0]) / (out[2] + out[0] + 1e-9);
        }
        // the row's clear sky: its 85th percentile of blueness; a row without any blue is all cloud
        const sorted = Float32Array.from(row).sort(), sky = sorted[Math.floor(w * 0.85)];
        for (let i = 0; i < w; i++)
        {
            let c = sky > 0.06 ? 1 - Math.max(0, Math.min(1, blue[j * w + i] / sky)) : 1;
            if (p.sun)
            {
                // around the sun that was taken out the picture is a fill: no cloud is cut from there
                const phi = ((i + 0.5) / w - yaw / 360) * 2 * Math.PI, theta = v * Math.PI;
                const dot = Math.sin(theta) * Math.sin(phi) * p.sun.dir[0] + Math.cos(theta) * p.sun.dir[1] + Math.sin(theta) * Math.cos(phi) * p.sun.dir[2];
                const reach = Math.max(12, p.sun.outer) * Math.PI / 180;
                c *= smooth(reach, reach * 1.35, Math.acos(Math.max(-1, Math.min(1, dot))));
            }
            cloud[j * w + i] = c;
        }
    }
    return { lum, cloud };
}
// the band as RGBA8: the alpha a soft step over the cloudiness whose foot is found so the mean alpha is `coverage`
function renderBand(band, w, h, coverage, white, shade = 0)
{
    const env = new Float32Array(h);
    for (let j = 0; j < h; j++) { const t = (j + 0.5) / h; env[j] = smooth(0, EDGE, t) * smooth(0, EDGE, 1 - t); }
    const alphaAt = (k, j, foot) => smooth(foot, foot + 0.3, band.cloud[k]) * env[j];
    const meanAlpha = (foot) => { let s = 0; for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i += 2) s += alphaAt(j * w + i, j, foot); return s / (Math.ceil(h / 2) * Math.ceil(w / 2)); };
    // the foot never goes under FOOT_MIN: below it the clear sky's own haze would come in as a veil, so a sky with
    // fewer clouds than the coverage asks for gives a thinner band
    let lo = FOOT_MIN, hi = 0.95;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (meanAlpha(mid) > coverage) lo = mid; else hi = mid; }
    const foot = (lo + hi) / 2, alpha = new Float32Array(w * h), bright = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = j * w + i; alpha[k] = alphaAt(k, j, foot); if (alpha[k] > 0.8 && (i & 3) === 0 && (j & 3) === 0) bright.push(band.lum[k]); }
    bright.sort((a, b) => a - b);
    const top = bright.length ? bright[Math.floor(bright.length * 0.97)] : 1, rgba = new Uint8Array(w * h * 4), grey = new Float32Array(w * h);
    // the clouds' grey, and its mean weighted by the alpha: with a shade given the grey is scaled so that this mean
    // lands on it (the stock band's: a state's tint and strength are set for that brightness)
    let sum = 0, weight = 0;
    for (let k = 0; k < w * h; k++) { grey[k] = srgb(Math.max(0, Math.min(1, band.lum[k] / top))); sum += grey[k] * alpha[k]; weight += alpha[k]; }
    const scale = shade > 0 && sum > 0 ? shade / (sum / weight) : 1;
    for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++)
        {
            // the alpha softened over its eight neighbours: no single hard texels at a cloud's edge
            let a = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const y = j + dy; if (y < 0 || y >= h) continue; a += alpha[y * w + (i + dx + w) % w]; n++; }
            const k = j * w + i, g = white ? 255 : Math.round(Math.max(0, Math.min(1, grey[k] * scale)) * 255);
            rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = g; rgba[k * 4 + 3] = Math.round(a / n * 255);
        }
    return { rgba, foot, mean: meanAlpha(foot), shade: sum > 0 ? sum / weight * scale : 0 };
}
// the next mip (a 2 x 2 box; a dimension of 4 stays) and a picture as BC7 blocks
function halve(pic, w, h)
{
    const nw = Math.max(w >> 1, 4), nh = Math.max(h >> 1, 4), sx = w > 4 ? 2 : 1, sy = h > 4 ? 2 : 1, out = new Uint8Array(nw * nh * 4);
    for (let j = 0; j < nh; j++)
        for (let i = 0; i < nw; i++)
            for (let c = 0; c < 4; c++)
            {
                let sum = 0;
                for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) sum += pic[(Math.min(h - 1, j * sy + dy) * w + Math.min(w - 1, i * sx + dx)) * 4 + c];
                out[(j * nw + i) * 4 + c] = Math.round(sum / (sx * sy));
            }
    return out;
}
function blocks(pic, w, h)
{
    const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4)), out = new Uint8Array(bw * bh * 16), px = [];
    for (let k = 0; k < 16; k++) px.push([0, 0, 0, 0]);
    for (let by = 0; by < bh; by++)
        for (let bx = 0; bx < bw; bx++)
        {
            for (let k = 0; k < 16; k++) { const o = (Math.min(h - 1, by * 4 + (k >> 2)) * w + Math.min(w - 1, bx * 4 + (k & 3))) * 4; px[k][0] = pic[o]; px[k][1] = pic[o + 1]; px[k][2] = pic[o + 2]; px[k][3] = pic[o + 3]; }
            out.set(encodeBlock(px), (by * bw + bx) * 16);
        }
    return out;
}
// the stock texture's size, mip count and header length
function stockShape(stock)
{
    const w = stock.readUInt32LE(0x10), h = stock.readUInt32LE(0x14), mips = stock.readUInt32LE(0x30);
    let data = 0;
    for (let m = 0, a = w, b = h; m < mips; m++, a = Math.max(a >> 1, 4), b = Math.max(b >> 1, 4)) data += a * b;
    const head = stock.length - data - TAIL;
    if (head < 48 || head > 256) throw new Error('not a BC7 texture of ' + w + ' x ' + h + ' with ' + mips + ' mips (' + stock.length + ' bytes)');
    return { w, h, mips, head };
}
// a PNG of an RGB picture
function png(file, w, h, rgb)
{
    const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); b.writeUInt32BE(zlib.crc32(b.subarray(4, 8 + data.length)) >>> 0, 8 + data.length); return b; };
    const head = Buffer.alloc(13), raw = Buffer.alloc((w * 3 + 1) * h);
    head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
    for (let j = 0; j < h; j++) Buffer.from(rgb.buffer, rgb.byteOffset + j * w * 3, w * 3).copy(raw, j * (w * 3 + 1) + 1);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

if (require.main === module)
{
    const args = process.argv.slice(2), opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
    try
    {
        if (args[0] === 'band' && args[1] && args[2] && opt('header') && opt('from') !== null && opt('to') !== null)
        {
            const stock = fs.readFileSync(opt('header')), { w, h, mips, head } = stockShape(stock), p = readHdr(args[1]);
            removeSun(p);   // the sun and its glare are as white as a cloud: out with them before the clouds are told from the sky
            const from = Number(opt('from')), to = Number(opt('to')), coverage = Number(opt('coverage') || 0.3), yaw = Number(opt('yaw') || 0);
            if (!(to > from && from >= -10 && to <= 90)) throw new Error('--from and --to: the band\'s lower and upper elevation in degrees');
            const band = readBand(p, w, h, from, to, yaw), r = renderBand(band, w, h, coverage, args.includes('--white'), Number(opt('shade') || 0));
            const parts = [stock.subarray(0, head)];
            let pic = r.rgba, pw = w, ph = h;
            for (let m = 0; m < mips; m++) { parts.push(blocks(pic, pw, ph)); if (m < mips - 1) { pic = halve(pic, pw, ph); pw = Math.max(pw >> 1, 4); ph = Math.max(ph >> 1, 4); } }
            parts.push(stock.subarray(stock.length - TAIL));
            const out = Buffer.concat(parts);
            if (out.length !== stock.length) throw new Error('the band came out at ' + out.length + ' bytes, the stock one has ' + stock.length);
            fs.writeFileSync(args[2], out);
            fs.writeFileSync(args[2] + '_header', stock.subarray(0, head));
            if (args.includes('--preview'))
            {
                const pwv = Math.min(w, 1024), phv = Math.max(1, Math.round(h * pwv / w)), rgb = new Uint8Array(pwv * phv * 3);
                for (let j = 0; j < phv; j++)
                    for (let i = 0; i < pwv; i++)
                    {
                        const k = (Math.min(h - 1, Math.floor(j * h / phv)) * w + Math.min(w - 1, Math.floor(i * w / pwv))) * 4, a = r.rgba[k + 3] / 255;
                        rgb[(j * pwv + i) * 3] = Math.round(r.rgba[k] * a + 150 * (1 - a)); rgb[(j * pwv + i) * 3 + 1] = Math.round(r.rgba[k + 1] * a + 40 * (1 - a)); rgb[(j * pwv + i) * 3 + 2] = Math.round(r.rgba[k + 2] * a + 150 * (1 - a));
                    }
                png(args[2].replace(/\.pct$/i, '') + '.png', pwv, phv, rgb);
            }
            console.log('built ' + args[2] + ' from ' + args[1].split(/[\\/]/).pop() + ': ' + w + ' x ' + h + ', ' + mips + ' mips, elevation ' + from + ' to ' + to + ', mean alpha ' + r.mean.toFixed(3) + ' (the step\'s foot at ' + r.foot.toFixed(3) + '), clouds\' grey ' + r.shade.toFixed(2) + (args.includes('--white') ? ', white' : '') + ', yaw ' + yaw);
        }
        else console.log('usage: node make_clouds.js band <panorama.hdr> <out.pct> --header <stock.pct> --from <deg> --to <deg> [--coverage <0..1>] [--white] [--yaw <degrees>] [--preview]');
    }
    catch (err) { console.error('error: ' + err.message); process.exitCode = 1; }
}

module.exports = { readBand, renderBand };
