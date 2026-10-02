#!/usr/bin/env node
// depth_probe.js: reads what SnowRunner Shadows (hid.dll) writes with the depth probe (ini DepthProbe=1): one
// frame's scene depth copied (0) at the immediate context's first lit-pass pixel shader, (1) before the first command
// list with a lit-pass draw, (2) at the AO pass, (3) the other depth texture of that size with (1), as SnowRunnerShadows.depth<i>.raw (a 32-byte header: 'SRDZ', width,
// height, DXGI format, bytes per texel, row bytes, copy, 0; then the rows). For contact shadows: how much of the final
// depth (2) the depth before the lit pass (0 or 1) already holds. Usage:
//   node depth_probe.js <dir> [out-prefix] [step]
// prints, for each early copy against copy 2, the share of the scene's pixels (not sky) whose depth was final already,
// drawn nearer later, or empty before; writes <out-prefix>_<i>.png (step n keeps every nth pixel; default 2): grey =
// the final depth (near = light), green tint = final already, red = drawn later, blue = empty before, black = sky.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

function readDepth(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x5A445253) throw new Error(`${file}: not a depth probe file`);
  const [w, h, fmt, bytes, row, copy] = [4, 8, 12, 16, 20, 24].map((o) => b.readUInt32LE(o));
  // the depth: the float in the first 4 bytes (D32_FLOAT_S8X24, D32_FLOAT); 24-bit unorm in the low bits (D24S8); 16-bit unorm
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = 32 + y * row + x * bytes;
      z[y * w + x] = bytes === 8 || fmt === 39 || fmt === 40 || fmt === 41 ? b.readFloatLE(o) : bytes === 4 ? (b.readUInt32LE(o) & 0xffffff) / 0xffffff : b.readUInt16LE(o) / 0xffff;
    }
  return { w, h, fmt, copy, z };
}

const crcTable = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function crc32(buf) { let crc = 0xffffffff; for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
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

function main(args) {
  if (!args.length) { console.log(fs.readFileSync(__filename, 'latin1').split('\n').filter((l) => l.startsWith('//')).join('\n')); return 2; }
  const dir = args[0], prefix = args[1] || path.join(dir, 'depth_probe'), step = Math.max(1, +args[2] || 2);
  const file = (i) => path.join(dir, `SnowRunnerShadows.depth${i}.raw`);
  if (!fs.existsSync(file(2))) throw new Error(`${file(2)} is missing: the copy at the AO pass is the reference`);
  const fin = readDepth(file(2));
  // the far value: whichever of 0 (reversed depth) and 1 more pixels hold
  let n0 = 0, n1 = 0;
  for (const v of fin.z) { if (v === 0) n0++; else if (v === 1) n1++; }
  const far = n0 >= n1 ? 0 : 1;
  console.log(`copy 2 (at the AO pass): ${fin.w} x ${fin.h}, format ${fin.fmt}; far plane = ${far} (${(100 * Math.max(n0, n1) / fin.z.length).toFixed(1)} % sky)`);
  for (const i of [0, 1, 3]) {
    if (!fs.existsSync(file(i))) { console.log(`copy ${i}: not written`); continue; }
    const pre = readDepth(file(i));
    if (pre.w !== fin.w || pre.h !== fin.h) { console.log(`copy ${i}: ${pre.w} x ${pre.h}, not the size of copy 2`); continue; }
    let scene = 0, same = 0, later = 0, empty = 0, farther = 0;
    const w = Math.ceil(fin.w / step), h = Math.ceil(fin.h / step), rgb = Buffer.alloc(w * h * 3);
    for (let y = 0; y < fin.h; y++)
      for (let x = 0; x < fin.w; x++) {
        const k = y * fin.w + x, a = pre.z[k], b = fin.z[k];
        let cls = 0; // 0 sky, 1 final already, 2 drawn nearer later, 3 empty before, 4 farther later (cleared, or a depth written behind)
        if (b !== far) {
          scene++;
          if (a === b) { same++; cls = 1; }
          else if (a === far) { empty++; cls = 3; }
          else if (far === 0 ? b > a : b < a) { later++; cls = 2; }
          else { farther++; cls = 4; }
        }
        if (x % step || y % step) continue;
        const o = ((y / step) * w + x / step) * 3;
        // grey from the final depth: reversed depth is near-linear in 1/distance; a square root spreads the far field
        const g = Math.round(40 + 200 * Math.sqrt(Math.min(1, Math.max(0, far === 0 ? b : 1 - b) * 8)));
        const tint = [[0, 0, 0], [0.35 * g, g, 0.35 * g], [g, 0.25 * g, 0.25 * g], [0.3 * g, 0.4 * g, g], [g, g, 0]][cls];
        rgb[o] = Math.round(tint[0]); rgb[o + 1] = Math.round(tint[1]); rgb[o + 2] = Math.round(tint[2]);
      }
    const pc = (v) => (100 * v / Math.max(1, scene)).toFixed(1) + ' %';
    console.log(`copy ${i} against copy 2: of ${scene} scene pixels, final already ${pc(same)}, drawn nearer later ${pc(later)}, empty before ${pc(empty)}, farther later ${pc(farther)}`);
    const out = `${prefix}_${i}.png`;
    writePng(out, w, h, rgb);
    console.log(`  ${out}: ${w} x ${h}`);
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { readDepth };
