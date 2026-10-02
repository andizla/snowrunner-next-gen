// Smoke shape and softer edges (module smokeshade), spliced into SnowRunner's particle sprite pixel shaders (the 267
// ps_5_0 shaders with g_txSpritesSRGB):
//   shading  replacements\smoke\smoke_shade.hlsl (compiled to smoke_shade.cso) in the lit sprites without a normal map of
//            their own (cPosY declared, no g_txSpritesNM: dust, exhaust, smoke and steam; the normal-mapped water
//            splashes and mud keep their own shading). Every one of them ends in the fog blend "mad o0.xyz,
//            COLOR1.wwww, X, Y" (= lerp(lit, fog.rgb, fog.a)): that mad writes a fresh temp T.xyz instead, the output
//            alpha's instruction is repeated into T.w right after it, and before the ret the helper turns T, the fog
//            input and the albedo into o0.xyzw. The albedo (the helper draws white smoke thinner): the lit colour the
//            fog blend reads is "mul Y.xyz, P, Q" with one operand the light (written from TEXCOORD5/6, the vertex's
//            sun and ambient) and the other the albedo (sprite texture x particle colour), copied into T+1 right
//            before that mul; where the shader is built otherwise the helper gets 0 (the game's opacity). cb1 is
//            declared (2 registers) where a shader lacks it and cb2 widened to 50 (the helper reads the view
//            direction and g_dirLight.vDir).
//   soft     the soft-depth fade "mul_sat rF.x, rF.x, cb4[2].x" (the depth difference x g_fSoftDepthInv) in the sprites
//            that read the depth: a mul by SMOKE_SOFT right before it (0.5: the fade over twice the distance, so puffs
//            meet the ground and the trucks without a hard line; 1 leaves it out).
// With smoke_shade_off.cso (SMOKE_SHADE=0) and SMOKE_SOFT=1 every patched shader computes what the stock one did (the
// proof build). A shader whose tail or fade does not look like the above keeps that part as it was, with the reason.
// Library: patchSmokePS(blob[, helper[, { soft, shade }]]) -> { blob, note } or { reason }; targets() -> the hashes in dump\.
// usage: node patch_smoke_ps.js [outDir]    the set built on the stock shaders (default replacements\smoke\ps_set)
'use strict';
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { insertWords, dxbcChecksum, ins, f32 } = require('./dxbc_patch.js');
const { splice, words } = require('./patch_water_mix.js');
const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output)
const HELPER = path.join(W, 'replacements', 'smoke', 'smoke_shade.cso');
const SOFT = process.env.SMOKE_SOFT !== undefined ? Number(process.env.SMOKE_SOFT) : 0.5;
const OP = { mad: 50, mov: 54, mul: 56, ret: 62, dcl_constantbuffer: 89, dcl_temps: 104, dclOutput: [101, 102, 103] };
const TEMP = 0, INPUT = 1, OUTPUT = 2, IMM = 4, CB = 8;
const has = (b, s) => b.indexOf(Buffer.from(s, 'latin1')) >= 0;
const isPixel = (b) => { const w = walk(b); return (b.readUInt32LE(w.start) >>> 16) === 0; };
const isO0 = (o, mask) => o && o.type === OUTPUT && o.idx[0] === 0 && o.mode === 0 && (o.sel & 15) === mask;

let cached = null;
function targets()
{
    if (cached) return cached;
    cached = [];
    for (const f of fs.readdirSync(DUMP))
    {
        if (!/^0x[0-9A-F]{8}\.cso$/i.test(f)) continue;
        const b = fs.readFileSync(path.join(DUMP, f));
        if (has(b, 'g_txSpritesSRGB') && isPixel(b)) cached.push(f.slice(2, 10).toUpperCase());
    }
    return cached;
}

// one component of a source: select (mode 2) or a broadcast swizzle (mode 1), no modifier; -1 otherwise
const compOf = (o) => (o.ext ? -1 : o.mode === 2 ? o.sel & 3 : o.mode === 1 && [0x00, 0x55, 0xaa, 0xff].includes(o.sel) ? o.sel & 3 : -1);
// the soft-depth fade scaled: a mul by `soft` in front of the one "mul_sat rF.c, rF.c, cb4[2].x" (c any one component)
function patchSoft(b, soft)
{
    const hits = [];
    for (const x of walk(b).insts)
    {
        if (x.op !== OP.mul || !x.sat) continue;
        const o = operands(b, x);
        if (o.length !== 3 || o[0].type !== TEMP || o[0].mode !== 0 || o[0].ext || ![1, 2, 4, 8].includes(o[0].sel & 15)) continue;
        const c = [1, 2, 4, 8].indexOf(o[0].sel & 15);
        if (o[1].type !== TEMP || o[1].idx[0] !== o[0].idx[0] || compOf(o[1]) !== c) continue;
        if (o[2].type !== CB || o[2].idx[0] !== 4 || o[2].idx[1] !== 2 || compOf(o[2]) !== 0) continue;
        hits.push({ x, r: o[0].idx[0], c });
    }
    if (hits.length !== 1) return { reason: 'soft-depth fades found: ' + hits.length };
    const { x, r, c } = hits[0];
    return { blob: insertWords(b, [{ at: x.off, words: ins(OP.mul, [(0x00100002 | ((1 << c) << 4)) >>> 0, r, (0x0010000a | (c << 4)) >>> 0, r, 0x00004001, f32(soft)]) }], { stat: { instructions: 1, floatInstructions: 1 } }) };
}

// the semantic of each input register from the input signature: { 5: 'TEXCOORD5', ... }
function inputSemantics(b)
{
    const c = chunks(b).ISGN, out = {};
    if (!c) return out;
    const d = c.data, n = b.readUInt32LE(d);
    for (let i = 0; i < n; i++)
    {
        const e = d + 8 + i * 24, name = d + b.readUInt32LE(e);
        out[b.readUInt32LE(e + 16)] = b.toString('latin1', name, b.indexOf(0, name)) + b.readUInt32LE(e + 4);
    }
    return out;
}

// the albedo at the lit colour (see the header): { mul, op } with op the albedo operand of the mul, or null
function findAlbedo(b, L, fog)
{
    const sem = inputSemantics(b);
    // the last instruction before L[i] that writes any of `mask` of temp `reg` (declarations skipped)
    const lastWriter = (i, reg, mask) =>
    {
        for (let k = i - 1; k >= 0; k--)
        {
            const e = L[k], d = e.o[0];
            if (e.x.op >= 88 && e.x.op <= 106) continue;
            if (d && d.type === TEMP && d.idx[0] === reg && d.mode === 0 && (d.sel & mask)) return { e, k };
        }
        return null;
    };
    // the components a swizzled source reads for the destination components x, y, z
    const reads = (o) => (1 << (o.sel & 3)) | (1 << ((o.sel >> 2) & 3)) | (1 << ((o.sel >> 4) & 3));
    const Y = fog.o[3];
    if (!Y || Y.type !== TEMP || Y.ext || Y.mode !== 1 || (Y.sel & 0x3f) !== 0x24) return null;   // Y.xyz
    const m = lastWriter(L.indexOf(fog), Y.idx[0], 7);
    if (!m || m.e.x.op !== OP.mul || m.e.x.sat || (m.e.o[0].sel & 15) !== 7) return null;
    const src = m.e.o.slice(1);
    if (src.length !== 2 || src.some((o) => o.type !== TEMP || o.ext || o.mode !== 1)) return null;
    const light = src.map((o) =>
    {
        const w = lastWriter(m.k, o.idx[0], reads(o));
        return !!w && w.e.o.slice(1).some((s) => s.type === INPUT && /^TEXCOORD[56]$/.test(sem[s.idx[0]] || ''));
    });
    if (light[0] === light[1]) return null;
    return { mul: m.e, op: src[light[0] ? 1 : 0] };
}

// the shading at the fog blend (see the header)
function patchShade(b, helper)
{
    const L = walk(b).insts.map((x) => ({ x, o: operands(b, x) }));
    const writesO0 = L.filter((e) => !OP.dclOutput.includes(e.x.op) && e.o.length && e.o[0].type === OUTPUT && e.o[0].idx[0] === 0);
    const fogs = writesO0.filter((e) => e.x.op === OP.mad && !e.x.sat && isO0(e.o[0], 7) && e.o[1].type === INPUT && e.o[1].mode === 1 && e.o[1].sel === 0xff && !e.o[1].ext);
    const alphas = writesO0.filter((e) => isO0(e.o[0], 8));
    const rets = L.filter((e) => e.x.op === OP.ret);
    if (fogs.length !== 1 || alphas.length !== 1 || writesO0.length !== 2) return { reason: 'tail not the fog blend and one alpha write (' + fogs.length + ' blends, ' + alphas.length + ' alpha writes, ' + writesO0.length + ' o0 writes)' };
    if (rets.length !== 1 || rets[0] !== L[L.length - 1]) return { reason: 'not one ret at the end' };
    const fog = fogs[0], alpha = alphas[0], F = fog.o[1].idx[0];
    if (fog.o[0].size !== 8 || alpha.o[0].size !== 8) return { reason: 'an output operand with extra tokens' };
    // only blended puffs: an alpha-tested sprite writes a constant alpha (debris, mud chunks: "mov o0.w, l(0)")
    if (alpha.o.slice(1).every((o) => o.type === IMM)) return { reason: 'constant alpha (alpha-tested, not a puff)' };
    const T = b.readUInt32LE(L.find((e) => e.x.op === OP.dcl_temps).x.off + 4), A = T + 1;
    const alb = findAlbedo(b, L, fog);
    // the blend into T.xyz (in place: same operand size), the alpha repeated into T.w, the albedo into A.xyz right
    // before the mul that lights it (its operand's own tokens: the same swizzle), a placeholder before the ret
    const e1 = Buffer.from(b);
    e1.writeUInt32LE(0x00100072, fog.o[0].off);
    e1.writeUInt32LE(T, fog.o[0].off + 4);
    const copy = [];
    for (let k = 0; k < alpha.x.len; k++) copy.push(e1.readUInt32LE(alpha.x.off + k * 4));
    const di = (alpha.o[0].off - alpha.x.off) / 4;
    copy[di] = 0x00100082;
    copy[di + 1] = T;
    const at = [
        { at: alpha.x.off + alpha.x.len * 4, words: copy },
        { at: rets[0].x.off, words: ins(OP.mov, [0x001020f2, 0, 0x00100e46, T]) },
    ];
    if (alb)
    {
        const src = [];
        for (let k = 0; k < alb.op.size / 4; k++) src.push(e1.readUInt32LE(alb.op.off + k * 4));
        at.push({ at: alb.mul.x.off, words: ins(OP.mov, [0x00100072, A, ...src]) });
    }
    const e2 = insertWords(e1, at, { temps: alb ? 2 : 1, stat: { instructions: at.length, movInstructions: at.length - 1 } });
    // constant buffers: cb2 to 50 registers; cb1 (2 registers, cb2's declaration as the template) where missing
    const cbs = walk(e2).insts.filter((x) => x.op === OP.dcl_constantbuffer).map((x) => ({ x, o: operands(e2, x)[0] }));
    const cb2 = cbs.find((c) => c.o.idx[0] === 2), cb1 = cbs.find((c) => c.o.idx[0] === 1);
    if (!cb2 || cb2.o.dim !== 2 || cb2.o.rep[0] !== 0 || cb2.o.rep[1] !== 0) return { reason: 'cb2 not declared as expected' };
    let e3 = e2;
    if (!cb1)
    {
        const dcl = [];
        for (let k = 0; k < cb2.x.len; k++) dcl.push(e2.readUInt32LE(cb2.x.off + k * 4));
        const oi = (cb2.o.off - cb2.x.off) / 4;
        dcl[oi + 1] = 1;
        dcl[oi + 2] = 2;
        e3 = insertWords(e2, [{ at: cb2.x.off, words: dcl }]);
    }
    else if (cb1.o.dim !== 2 || cb1.o.rep[1] !== 0) return { reason: 'cb1 not declared as expected' };
    for (const c of walk(e3).insts.filter((x) => x.op === OP.dcl_constantbuffer).map((x) => ({ x, o: operands(e3, x)[0] })))
    {
        const need = c.o.idx[0] === 2 ? 50 : c.o.idx[0] === 1 ? 2 : 0, at = c.o.off + c.o.size - 4;
        if (need && e3.readUInt32LE(at) < need) e3.writeUInt32LE(need, at);
    }
    dxbcChecksum(e3.subarray(20)).copy(e3, 4);
    // the helper in place of the placeholder: v0 = T.xyzw, v1 = the fog input, v2 = the albedo (0 without one); its
    // result into o0.xyzw
    const w = walk(e3);
    const ph = w.insts.filter((x) => x.op === OP.mov).map((x) => ({ x, o: operands(e3, x) })).find((e) => isO0(e.o[0], 15) && e.o[1].type === TEMP && e.o[1].idx[0] === T);
    if (!ph) return { reason: 'placeholder lost' };
    const r = splice(e3, w, ph, helper, 3, [[15, words(0x00100e46, T)], [15, words(0x00101e46, F)], [7, alb ? words(0x00100246, A) : words(0x00004002, 0, 0, 0, 0)]], ph.o[0]);
    if (r.blob) r.white = !!alb;
    return r;
}

function patchSmokePS(b, helper = fs.readFileSync(HELPER), { soft = SOFT, shade = true } = {})
{
    const notes = [];
    let out = b, changed = false;
    if (soft !== 1 && has(b, 'g_fSoftDepthInv'))
    {
        const r = patchSoft(out, soft);
        if (r.blob) { out = r.blob; changed = true; notes.push('soft x' + soft); } else notes.push('soft: ' + r.reason);
    }
    if (shade && has(b, 'cPosY') && !has(b, 'g_txSpritesNM'))
    {
        const r = patchShade(out, helper);
        if (r.blob) { out = r.blob; changed = true; notes.push(r.white ? 'shade + white' : 'shade (white: no albedo)'); } else notes.push('shade: ' + r.reason);
    }
    return changed ? { blob: out, note: notes.join(', ') } : { reason: notes.join(', ') || 'nothing to do (unlit or normal-mapped, no soft fade)' };
}

module.exports = { patchSmokePS, targets, HELPER, SOFT };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'smoke', 'ps_set');
    fs.mkdirSync(outDir, { recursive: true });
    const helper = fs.readFileSync(HELPER), tally = {};
    let n = 0;
    for (const h of targets())
    {
        const r = patchSmokePS(fs.readFileSync(path.join(DUMP, '0x' + h + '.cso')), helper);
        const key = r.blob ? r.note : 'skipped: ' + r.reason;
        tally[key] = (tally[key] || 0) + 1;
        if (r.blob) { fs.writeFileSync(path.join(outDir, '0x' + h + '.shader'), r.blob); n++; }
    }
    console.log(JSON.stringify({ targets: targets().length, patched: n, soft: SOFT, by: tally }, null, 1));
}
