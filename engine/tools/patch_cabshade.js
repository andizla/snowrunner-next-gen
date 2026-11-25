// Cab shade spliced into SnowRunner's window glass shaders (replacements\glass\cabshade.hlsl, compiled to cabshade.cso
// next to it). The game lights a cab's inside like open ground, so at dusk the seats and the liner stand grey behind the
// glass. A pane is drawn over the lit scene with out = pane + scene x (1 - alpha); the helper raises the alpha where
// what lies a short way behind the pane is the cab (by the previous frame's depth, t121), so the cab loses a share of
// its light and the pane's own colour stays.
// The splice: the shader's last write of o0 (mad o0.xyzw, wet, x, colour: the same anchor as patch_glass_clear.js) goes
// to a new temp instead; behind it the helper is fed the pixel's SV_Position, that alpha and whether the pane is seen
// from its outer side (SV_IsFrontFace, added to the shader's input signature), and o0 gets the temp's
// colour and the helper's alpha. The shader also gets what the helper reads: t121 and its SV_Position input declared
// with all four components (its signature names it; the pane shaders do not read it themselves).
// A shader is left as it is unless: it is window glass, o0 is written whole once last by a mad and by nothing after it,
// its signature has SV_Position (declared here, or widened to four components where the pane reads x and y already).
// Works on a stock pane or on one the other modules patched already (they touch other instructions; where Headlight
// shadows declared t121 and the screen position, those declarations are used).
// Library: patchCabShade(blob[, helper]) -> { blob, note } or { reason }; targets() -> the hashes in dump\.
// usage: node patch_cabshade.js [outDir]
'use strict';
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange } = require('./shadow_filter_patch.js');
const { dxbcChecksum, firstTempFree } = require('./dxbc_patch.js');
const { isGlass, targets } = require('./patch_glass_clear.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');
const HELPER = path.join(W, 'replacements', 'glass', 'cabshade.cso');
const DEPTH_SLOT = 121;
const OP = { mov: 54, mad: 50, dcl_resource: 88, dcl_input_ps_siv: 100, dcl_temps: 104 };
const T_TEMP = 0, T_INPUT = 1, T_OUTPUT = 2;

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const movInst = (dest, src) => Buffer.concat([words((OP.mov | ((1 + (dest.length + src.length) / 4) << 24)) >>> 0), dest, src]);
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const outDest = (reg, mask) => words(0x00102002 | (mask << 4), reg);
const tempSrc = (reg) => words(0x00100e46, reg);    // rN.xyzw
const tempSrcX = (reg) => words(0x00100006, reg);   // rN.xxxx
const tempSrcW = (reg) => words(0x00100ff6, reg);   // rN.wwww
const inputSrc = (reg) => words(0x00101e46, reg);   // vN.xyzw
// dcl_resource_texture2d (float,float,float,float) tN, as fxc writes it
const dclTexture2D = (slot) => words(OP.dcl_resource | (3 << 11) | (4 << 24), 0x00107000, slot, 0x00005555);
// dcl_input_ps_siv linear noperspective vN.xyzw, position
// dcl_input_ps_sgv constant vN.x, is_front_face (0xFFFFFFFF where the triangle faces the camera)
const dclInputFace = (reg) => words(99 | (1 << 11) | (4 << 24), 0x00101012, reg, 9);
const faceSrc = (reg) => words(0x0010100a, reg);    // vN.x
const dclInputPosition = (reg) => words(OP.dcl_input_ps_siv | (4 << 11) | (4 << 24), 0x001010f2, reg, 1);

function screenRegister(b)
{
    const c = chunks(b).ISGN;
    if (!c) return -1;
    const n = b.readUInt32LE(c.data);
    for (let k = 0; k < n; k++)
    {
        const e = c.data + 8 + k * 24, at = c.data + b.readUInt32LE(e);
        if (b.toString('ascii', at, b.indexOf(0, at)).toUpperCase() === 'SV_POSITION' && b.readUInt32LE(e + 8) === 1) return b.readUInt32LE(e + 16);
    }
    return -1;
}

// bytes inserted in front of dcl_temps (declarations); sizes, chunk offsets and checksum follow
function insertAt(b, at, bytes)
{
    const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
    const out = Buffer.concat([b.subarray(0, at), bytes, b.subarray(at)]);
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(shex.size + bytes.length, shex.off + 4);
    out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + bytes.length / 4, shex.data + 4);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + bytes.length, 32 + i * 4); }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return out;
}

// SV_IsFrontFace in the input signature (ISGN): the game's pane shaders carry it unread, and it is added on the
// register after the last one where a shader has none. The helper shades only through a pane seen from its outer side. -> { blob, reg } or { reason }
function addFaceInput(b)
{
    const c = chunks(b).ISGN;
    if (!c) return { reason: 'no input signature' };
    const n = b.readUInt32LE(c.data);
    let reg = 0;
    for (let k = 0; k < n; k++)
    {
        const e = c.data + 8 + k * 24, at = c.data + b.readUInt32LE(e);
        if (b.toString('ascii', at, b.indexOf(0, at)).toUpperCase() === 'SV_ISFRONTFACE')
        {
            // the game's panes carry it unread (v8 in all 14): mark x as read and use that register
            const out = Buffer.from(b);
            out.writeUInt8(out.readUInt8(e + 21) | 1, e + 21);
            dxbcChecksum(out.subarray(20)).copy(out, 4);
            return { blob: out, reg: b.readUInt32LE(e + 16) };
        }
        reg = Math.max(reg, b.readUInt32LE(e + 16) + 1);
    }
    const data = Buffer.from(b.subarray(c.data, c.data + c.size));
    const head = Buffer.from(data.subarray(0, 8 + n * 24)), strings = data.subarray(8 + n * 24);
    head.writeUInt32LE(n + 1, 0);
    for (let k = 0; k < n; k++) head.writeUInt32LE(head.readUInt32LE(8 + k * 24) + 24, 8 + k * 24);
    const el = Buffer.alloc(24);
    el.writeUInt32LE(data.length + 24, 0);   // its name, behind the strings there are
    el.writeUInt32LE(0, 4); el.writeUInt32LE(9, 8); el.writeUInt32LE(1, 12); el.writeUInt32LE(reg, 16);   // index 0, system value is_front_face, uint
    el.writeUInt8(1, 20); el.writeUInt8(1, 21);   // mask x, read x
    const name = Buffer.alloc(16); name.write('SV_IsFrontFace', 'ascii');
    const neu = Buffer.concat([head, el, strings, name]), added = neu.length - data.length;
    const out = Buffer.concat([b.subarray(0, c.data), neu, b.subarray(c.data + c.size)]);
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(c.size + added, c.off + 4);
    const m = b.readUInt32LE(28);
    for (let i = 0; i < m; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > c.off) out.writeUInt32LE(o + added, 32 + i * 4); }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, reg };
}

function patchCabShade(b, helper = fs.readFileSync(HELPER))
{
    if (!isGlass(b)) return { reason: 'not window glass' };
    const face = addFaceInput(b);
    if (!face.blob) return face;
    b = face.blob;
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    const textures = new Set();
    for (const e of L) if (e.x.op === OP.dcl_resource && e.o[0]) textures.add(e.o[0].idx[0]);
    const screen = screenRegister(b);
    if (screen < 0) return { reason: 'no SV_Position in the signature' };
    // where the shader declares it already (three panes read x and y), the declaration is widened to all four in place
    const screenDcl = L.find((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0] && e.o[0].type === T_INPUT && e.o[0].idx[0] === screen);
    if (screenDcl && (screenDcl.x.op !== OP.dcl_input_ps_siv || screenDcl.o[0].mode !== 0)) return { reason: 'the screen position is declared in another way' };
    // the last write of o0, whole, by a mad; nothing writes o0 after it
    const writes = L.filter((e) => e.x.op < 88 || e.x.op > 106).filter((e) => e.o[0] && e.o[0].type === T_OUTPUT && e.o[0].idx[0] === 0 && e.o[0].mode === 0);
    const f = writes[writes.length - 1];
    if (!f || (f.o[0].sel & 0xf) !== 0xf || f.x.op !== OP.mad) return { reason: 'o0 is not written whole by a last mad' };
    const d = f.o[0];
    if (d.ext || d.dim !== 1 || d.size !== 8) return { reason: 'the o0 operand is not plain' };
    const base = firstTempFree(b);
    if (base < 0) return { reason: 'no dcl_temps' };
    const h = helperBody(helper, base, 3);
    const T = base + h.temps;
    // the instruction as it was, writing rT instead of o0
    const orig = Buffer.from(b.subarray(f.x.off, f.x.off + f.x.len * 4));
    orig.writeUInt32LE(tempDest(T, 0xf).readUInt32LE(0), d.off - f.x.off);
    orig.writeUInt32LE(T, d.off - f.x.off + 4);
    const spliced = Buffer.concat([orig,
        movInst(tempDest(h.IN(0), 0xf), inputSrc(screen)),
        movInst(tempDest(h.IN(1), 1), tempSrcW(T)),
        movInst(tempDest(h.IN(2), 1), faceSrc(face.reg)),
        ...h.body,
        movInst(outDest(0, 7), tempSrc(T)),
        movInst(outDest(0, 8), tempSrcX(h.RES))]);
    let out = replaceRange(b, f.x.off, f.x.off + f.x.len * 4, spliced, h.temps + 1, h.body.length + 5);
    const temps = w.insts.find((y) => y.op === OP.dcl_temps).off;
    if (!L.some((e) => e.x.op >= 95 && e.x.op <= 100 && e.o[0] && e.o[0].type === T_INPUT && e.o[0].idx[0] === face.reg)) out = insertAt(out, temps, dclInputFace(face.reg));
    if (!textures.has(DEPTH_SLOT)) out = insertAt(out, temps, dclTexture2D(DEPTH_SLOT));   // Headlight shadows declares it on the panes too
    if (screenDcl) { out.writeUInt32LE((out.readUInt32LE(screenDcl.o[0].off) | 0xf0) >>> 0, screenDcl.o[0].off); dxbcChecksum(out.subarray(20)).copy(out, 4); }   // in front of the code: the offset holds
    else out = insertAt(out, temps, dclInputPosition(screen));
    return { blob: out, note: 'v' + screen + (screenDcl ? ' widened' : '') + ', temp r' + T };
}

module.exports = { patchCabShade, targets };

if (require.main === module)
{
    const outDir = process.argv[2];
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    const report = { targets: 0, patched: 0, skipped: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchCabShade(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')));
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; console.log(hash + ' refused: ' + r.reason); continue; }
        report.patched++;
        if (outDir) fs.writeFileSync(path.join(outDir, '0x' + hash + '.cso'), r.blob);
    }
    console.log(JSON.stringify(report));
}
