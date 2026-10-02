#!/usr/bin/env node
// dump_read.js: reads what SnowRunner Shadows (hid.dll) writes on a dump (ini KeyDump, default F7, or DumpAfter): one
// frame's bounce-light chain, the AO pass's inputs and outputs, as SnowRunnerShadows_dump_<time>_<name>.bin files next to a
// ..._manifest.txt. Usage:
//   node dump_read.js <manifest.txt>                                 the manifest, then statistics per file
//   node dump_read.js <manifest.txt> png <item> <out.png> [gain] [step]   a texture as an 8-bit sRGB PNG: values x gain,
//                                                                    clamped; step n keeps every nth pixel (4K -> step 4)
//   node dump_read.js <manifest.txt> pixel <item> <x> <y>            one pixel's values
//   node dump_read.js <manifest.txt> diff <item> <other.bin>         the largest and mean difference to another dump file
//                                                                    of the same size (a replay's output against the dumped)
// A .bin file: a 64-byte header ('SRDP', version 1, kind 1 texture / 2 buffer, width, height, DXGI format, view format,
// row pitch, data size (8 bytes), sample count), then the rows (textures) or the bytes (buffers).
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function readDump(file) {
  const b = fs.readFileSync(file);
  if (b.length < 64 || b.toString('latin1', 0, 4) !== 'SRDP') throw new Error(file + ': not a dump file');
  const u = (o) => b.readUInt32LE(o);
  const d = { file, version: u(4), kind: u(8), w: u(12), h: u(16), fmt: u(20), view: u(24), pitch: u(28), size: Number(b.readBigUInt64LE(32)), samples: u(40) };
  d.data = b.subarray(64, 64 + d.size);
  return d;
}

// the manifest: the items' files by name, and the text
function readManifest(manifestPath) {
  const text = fs.readFileSync(manifestPath, 'latin1');
  const dir = path.dirname(manifestPath);
  const items = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\w+) = (SnowRunnerShadows_dump_\S+\.bin) /.exec(line);
    if (m) items[m[1]] = path.join(dir, m[2]);
  }
  return { text, items, dir };
}

const half = (h) => { const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
// an 11- or 10-bit float of R11G11B10_FLOAT: 5 exponent bits, 6 or 5 mantissa bits, no sign
const f11 = (v, mbits) => { const e = (v >> mbits) & 31, m = v & ((1 << mbits) - 1); return e === 0 ? m * 2 ** (-14 - mbits) : e === 31 ? (m ? NaN : Infinity) : (1 + m / (1 << mbits)) * 2 ** (e - 15); };

// a pixel as [r, g, b, a] in linear values, for the formats the game's chain uses (a one-channel format fills r, g, b)
function decoder(fmt) {
  switch (fmt) {
    case 2: return (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8), b.readFloatLE(o + 12)];                // R32G32B32A32_FLOAT
    case 10: return (b, o) => [half(b.readUInt16LE(o)), half(b.readUInt16LE(o + 2)), half(b.readUInt16LE(o + 4)), half(b.readUInt16LE(o + 6))]; // R16G16B16A16_FLOAT
    case 11: return (b, o) => [b.readUInt16LE(o) / 65535, b.readUInt16LE(o + 2) / 65535, b.readUInt16LE(o + 4) / 65535, b.readUInt16LE(o + 6) / 65535]; // R16G16B16A16_UNORM
    case 16: return (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4), 0, 1];                                                           // R32G32_FLOAT
    case 19: return (b, o) => { const v = b.readFloatLE(o); return [v, v, v, 1]; };                                                   // R32G8X24_TYPELESS (the shadow atlas: depth, then stencil)
    case 24: return (b, o) => { const v = b.readUInt32LE(o); return [(v & 1023) / 1023, ((v >> 10) & 1023) / 1023, ((v >> 20) & 1023) / 1023, (v >>> 30) / 3]; }; // R10G10B10A2_UNORM
    case 26: return (b, o) => { const v = b.readUInt32LE(o); return [f11(v & 2047, 6), f11((v >> 11) & 2047, 6), f11((v >>> 22) & 1023, 5), 1]; };        // R11G11B10_FLOAT
    case 28: case 29: return (b, o) => [b[o] / 255, b[o + 1] / 255, b[o + 2] / 255, b[o + 3] / 255];                                    // R8G8B8A8_UNORM(_SRGB)
    case 87: case 88: case 90: case 91: return (b, o) => [b[o + 2] / 255, b[o + 1] / 255, b[o] / 255, b[o + 3] / 255];                   // B8G8R8A8_UNORM(_SRGB) / TYPELESS
    case 34: return (b, o) => [half(b.readUInt16LE(o)), half(b.readUInt16LE(o + 2)), 0, 1];                                             // R16G16_FLOAT
    case 35: return (b, o) => [b.readUInt16LE(o) / 65535, b.readUInt16LE(o + 2) / 65535, 0, 1];                                         // R16G16_UNORM
    case 39: case 41: return (b, o) => { const v = b.readFloatLE(o); return [v, v, v, 1]; };                                           // R32_TYPELESS / R32_FLOAT
    case 49: return (b, o) => [b[o] / 255, b[o + 1] / 255, 0, 1];                                                                       // R8G8_UNORM
    case 53: case 54: return (b, o) => { const v = half(b.readUInt16LE(o)); return [v, v, v, 1]; };                                    // R16_TYPELESS / R16_FLOAT
    case 55: case 56: return (b, o) => { const v = b.readUInt16LE(o) / 65535; return [v, v, v, 1]; };                                  // D16_UNORM / R16_UNORM
    case 60: case 61: return (b, o) => { const v = b[o] / 255; return [v, v, v, 1]; };                                                 // R8_TYPELESS / R8_UNORM
    default: return null;
  }
}
const bytesPerPixel = { 2: 16, 10: 8, 11: 8, 16: 8, 19: 8, 24: 4, 26: 4, 28: 4, 29: 4, 87: 4, 88: 4, 90: 4, 91: 4, 34: 4, 35: 4, 39: 4, 41: 4, 49: 2, 53: 2, 54: 2, 55: 2, 56: 2, 60: 1, 61: 1 };

// every pixel of a texture (every step-th in x and y) through fn(x, y, [r, g, b, a])
function eachPixel(d, fn, step = 1) {
  const dec = decoder(d.fmt), bpp = bytesPerPixel[d.fmt];
  if (!dec) throw new Error(d.file + ': format ' + d.fmt + ' is not decoded here (add it to decoder())');
  for (let y = 0; y < d.h; y += step) for (let x = 0; x < d.w; x += step) fn(x, y, dec(d.data, y * d.pitch + x * bpp));
}
function pixelAt(d, x, y) {
  const dec = decoder(d.fmt), bpp = bytesPerPixel[d.fmt];
  if (!dec) throw new Error(d.file + ': format ' + d.fmt + ' is not decoded here');
  return dec(d.data, y * d.pitch + x * bpp);
}
const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

// statistics of one file: a buffer as floats, a texture's luminance (one-channel formats: the value itself)
function stats(d, name) {
  if (d.kind === 2) {
    const n = Math.min(Math.floor(d.size / 4), 64), f = [];
    for (let i = 0; i < n; i++) f.push(d.data.readFloatLE(i * 4));
    console.log(`${name}: buffer, ${d.size} bytes; as floats (the first ${n}), one register per line:`);
    for (let i = 0; i < n; i += 4) console.log(`  c${i / 4}: ${f.slice(i, i + 4).map((v) => v.toPrecision(6)).join('  ')}`);
    return;
  }
  const step = Math.max(1, Math.floor(Math.sqrt((d.w * d.h) / 2e6)));   // about 2 M samples at most
  let n = 0, sum = 0, max = -Infinity, min = Infinity, zeros = 0, bad = 0, sumA = 0;
  const hist = new Array(12).fill(0);   // decades of luminance from below 1e-6
  eachPixel(d, (x, y, p) => {
    const l = luma(p);
    n++;
    if (!Number.isFinite(l)) { bad++; return; }
    sum += l; sumA += p[3];
    if (l > max) max = l;
    if (l < min) min = l;
    if (l === 0) zeros++; else hist[Math.max(0, Math.min(11, Math.floor(Math.log10(l)) + 7))]++;
  }, step);
  const ok = n - bad || 1;
  console.log(`${name}: ${d.w} x ${d.h}, format ${d.fmt} (view ${d.view}), pitch ${d.pitch}, every ${step}. pixel: ${n} px, mean ${(sum / ok).toPrecision(4)}, min ${min.toPrecision(4)}, max ${max.toPrecision(4)}, zero ${(100 * zeros / n).toFixed(2)} %, not finite ${bad}, mean alpha ${(sumA / ok).toPrecision(4)}`);
  const labels = ['<1e-6', '1e-6', '1e-5', '1e-4', '1e-3', '0.01', '0.1', '1', '10', '100', '1e3', '>=1e4'];
  console.log('  decades: ' + hist.map((c, i) => `${labels[i]}: ${(100 * c / n).toFixed(1)} %`).filter((s) => !s.endsWith(' 0.0 %')).join(', '));
}

const crcTable = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(buf) { let crc = 0xffffffff; for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
// an 8-bit RGB PNG from a w x h x 3 buffer
function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const srgb8 = (v) => { v = Math.min(1, Math.max(0, v)); return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); };

function main(args) {
  if (!args.length) { console.log(fs.readFileSync(__filename, 'latin1').split('\n').filter((l) => l.startsWith('//')).join('\n')); return 2; }
  const manifest = readManifest(args[0]);
  const mode = args[1] || 'stats';
  const item = (name) => { if (!manifest.items[name]) throw new Error(`no item ${name}; the manifest has: ${Object.keys(manifest.items).join(', ')}`); return readDump(manifest.items[name]); };
  if (mode === 'stats') {
    console.log(manifest.text.trimEnd());
    console.log('\n---- statistics (luminance = 0.2126 r + 0.7152 g + 0.0722 b; a one-channel format is its own value)');
    for (const name of Object.keys(manifest.items)) { try { stats(item(name), name); } catch (e) { console.log(`${name}: ${e.message}`); } }
  } else if (mode === 'png') {
    const d = item(args[2]), gain = +args[4] || 1, step = Math.max(1, +args[5] || 1), w = Math.ceil(d.w / step), h = Math.ceil(d.h / step);
    const rgb = Buffer.alloc(w * h * 3);
    eachPixel(d, (x, y, p) => { const o = ((y / step) * w + x / step) * 3; rgb[o] = srgb8(p[0] * gain); rgb[o + 1] = srgb8(p[1] * gain); rgb[o + 2] = srgb8(p[2] * gain); }, step);
    writePng(args[3], w, h, rgb);
    console.log(`${args[3]}: ${w} x ${h}, ${args[2]} x ${gain}`);
  } else if (mode === 'pixel') {
    const d = item(args[2]), x = +args[3], y = +args[4];
    console.log(`${args[2]} (${x}, ${y}): ${pixelAt(d, x, y).map((v) => v.toPrecision(6)).join('  ')}`);
  } else if (mode === 'diff') {
    const a = item(args[2]), b = readDump(args[3]);
    if (a.w !== b.w || a.h !== b.h || a.kind !== b.kind) throw new Error('the two files differ in size or kind');
    if (a.kind === 2) { let n = 0; for (let i = 0; i < a.size; i++) if (a.data[i] !== b.data[i]) n++; console.log(`${n} of ${a.size} bytes differ`); return n ? 1 : 0; }
    let maxD = 0, sumD = 0, n = 0, sumA = 0, sumB = 0, at = [0, 0];
    const decB = decoder(b.fmt), bppB = bytesPerPixel[b.fmt];
    eachPixel(a, (x, y, p) => {
      const q = decB(b.data, y * b.pitch + x * bppB);
      for (let c = 0; c < 3; c++) { const dd = Math.abs(p[c] - q[c]); sumD += dd; if (dd > maxD) { maxD = dd; at = [x, y]; } }
      sumA += luma(p); sumB += luma(q); n++;
    });
    console.log(`${args[2]} vs ${path.basename(args[3])}: largest difference ${maxD.toPrecision(4)} at (${at}), mean ${(sumD / (3 * n)).toPrecision(4)}; mean luminance ${(sumA / n).toPrecision(4)} vs ${(sumB / n).toPrecision(4)}`);
  } else throw new Error('unknown mode ' + mode);
  return 0;
}
process.exitCode = main(process.argv.slice(2));
