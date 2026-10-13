// The sun's highlight on water goes out in the sun's shadow.
// The water shaders (lakes and seas, the "domain" shaders; rivers and mud) light the water with the sun's colour times
// a shadow factor S: the cascades' lookup, never less than g_fShadowAtten (max S, x, cb2[3].w: a shadow keeps some
// light), blended into another value far off. The sun's highlight, (N'.H) ^ g_vSpecularDir_Power.w, is multiplied by that same S. It is many times
// brighter than white, so the share g_fShadowAtten leaves of it still reads as the whole highlight: the glitter path
// runs on through the shadow of a cliff or a bridge as if nothing stood in the sun's way.
// This multiplies the highlight's power term (and with it the scatter the shader derives from the highlight) by
//     g = saturate(1 - (1 - S) / max(1 - g_fShadowAtten, 0.001))
// nothing in a shadow's core, all of it in the light, the shadow filter's soft edge in between; with shadows switched
// off (g_fShadowAtten 1) it is 1. The water's diffuse light keeps the stock S.
// Found by structure, on a stock shader or one the other modules already patched:
//   A  lakes:  mul rG.xyz, rS.cccc, vN.xyzx   followed by   mad rD.xyz, vN.xyzx, rS.cccc, vM.xyzx   (the sun's colour
//              from the vertex x S, and the diffuse light)
//      rivers: mul rG.xyz, rS.cccc, cb2[48].xyzx                           (the sun's colour from the scene's constants)
//   B  log rP.c, rP.c ; mul rP.c, rP.c, cb4[k].w ; exp rP.c, rP.c          the highlight's power; k from the shader's
//                                                                           own description (4 in lakes, 5 in rivers)
// Inserted after A (rT = one new temp, a = cb2[3].w, copied from the shader's own "max S, x, cb2[3].w"):
//   mad rT.x, rS.c, l(-1), l(1) ; mad rT.y, a, l(-1), l(1) ; max rT.y, rT.y, l(0.001) ; div rT.x, rT.x, rT.y ;
//   mad_sat rT.x, rT.x, l(-1), l(1)
// and after B's exp:  mul rP.c, rP.c, rT.x
// A shader is patched only when it has exactly one A, one B and the shadow floor, and names both constants: the
// variants drawn with the sun's shadow map. The others (no shadows on water) hold nothing that says where the sun is
// hidden, and they stay as they are.
// Library: patchWaterSun(blob[, diag]) -> { blob, note } or { reason }; targets() -> the water shaders in dump\.
// usage: node patch_water_sun.js [outDir]    the set built on the stock shaders (default replacements\water\sun_set)
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { insertWords, f32, ins } = require('./dxbc_patch.js');
const ssr = require('./patch_water_ssr.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const OP = { and: 1, div: 14, exp: 25, frc: 26, log: 47, lt: 49, mad: 50, max: 52, mul: 56 };
const SAT = 1 << 13;
const T_TEMP = 0, T_INPUT = 1, T_CB = 8;
const destOne = (reg, c) => [(0x00100002 | ((1 << c) << 4)) >>> 0, reg];
const srcOne = (reg, c) => [(0x0010000a | (c << 4)) >>> 0, reg];
const imm1 = (v) => [0x4001, f32(v)];
const wordsOf = (b, o) => { const out = []; for (let p = o.off; p < o.off + o.size; p += 4) out.push(b.readUInt32LE(p)); return out; };

// the components a source operand reads for a destination's x, y and z; one component for a scalar
const swizzle = (o) => (o.mode === 1 ? [o.sel & 3, (o.sel >> 2) & 3, (o.sel >> 4) & 3] : o.mode === 2 ? [o.sel & 3, o.sel & 3, o.sel & 3] : null);
const isXyzDest = (o) => o.type === T_TEMP && o.mode === 0 && (o.sel & 15) === 7;
const isInputXyz = (o) => o.type === T_INPUT && o.mode === 1 && String(swizzle(o)) === '0,1,2';
// a temp register read as one component for all of x, y and z: [register, component], else null
const broadcast = (o) => { const s = o.type === T_TEMP ? swizzle(o) : null; return s && s[0] === s[1] && s[1] === s[2] ? [o.idx[0], s[0]] : null; };
// one component of a temp register, as a destination or a source names it
const scalar = (o) =>
{
    if (o.type !== T_TEMP) return null;
    if (o.mode === 0) { const c = [1, 2, 4, 8].indexOf(o.sel & 15); return c < 0 ? null : [o.idx[0], c]; }
    return o.mode === 2 ? [o.idx[0], o.sel & 3] : null;
};
const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const isCb = (o, slot, element, c) => o.type === T_CB && o.idx[0] === slot && o.idx[1] === element && o.mode === 2 && (o.sel & 3) === c;
const isCbXyz = (o, slot, element) => o.type === T_CB && o.idx[0] === slot && o.idx[1] === element && o.mode === 1 && String(swizzle(o)) === '0,1,2';
const SUN_COLOUR = 48;   // cb2[48]: the sun's colour in CB_GLOBAL_SCENE (offset 768), which the river shaders read

// the byte offset of a constant in its buffer, from the shader's own description of its constants (RDEF: a variable's
// record starts with where its name stands in the chunk, then its offset), or -1
function constantOffset(blob, name)
{
    const c = chunks(blob).RDEF;
    if (!c) return -1;
    const at = blob.indexOf(name + '\0', c.data, 'latin1');
    if (at < 0 || at >= c.data + c.size) return -1;
    for (let p = c.data; p + 8 <= c.data + c.size; p += 4) if (blob.readUInt32LE(p) === at - c.data) return blob.readUInt32LE(p + 4);
    return -1;
}

// diag (lab builds only, never for a release): the highlight blinks, so that one look in the game tells which case a
// stretch of water is. Where the shader has the shadow factor, the patch is applied and the highlight is on for four
// fifths of every 1.5 s; where it has the highlight but no shadow factor, it is on for one fifth. A highlight that does
// not blink is not this term.
function patchWaterSun(blob, diag)
{
    // g_vSpecularDir_Power sits at cb4[4] in the lake shaders and at cb4[5] in the river shaders; g_fShadowAtten is
    // cb2[3].w in both
    const power = constantOffset(blob, 'g_vSpecularDir_Power');
    if (power < 0 || power % 16 || constantOffset(blob, 'g_fShadowAtten') !== 60) return { reason: 'no sun highlight or no shadow floor among its constants' };
    const w = walk(blob);
    const sites = { A: [], river: [], B: [], floor: [] };
    for (let i = 0; i + 1 < w.insts.length; i++)
    {
        const x = w.insts[i], y = w.insts[i + 1];
        if (x.op === OP.mul)   // the sun's colour x S: from the vertex in the lake shaders, from the scene's constants in the rivers
        {
            const a = operands(blob, x), S = a.slice(1).map(broadcast).find(Boolean);
            const colour = a.slice(1).find(isInputXyz);
            if (isXyzDest(a[0]) && S && colour && y.op === OP.mad)
            {
                const m = operands(blob, y);
                if (isXyzDest(m[0]) && isInputXyz(m[1]) && m[1].idx[0] === colour.idx[0] && same(broadcast(m[2]), S) && isInputXyz(m[3])) sites.A.push({ after: y, S });
            }
            else if (isXyzDest(a[0]) && S && a.slice(1).some((o) => isCbXyz(o, 2, SUN_COLOUR))) sites.river.push({ after: x, S });
        }
        if (x.op === OP.mul && y.op === OP.exp && i > 0 && w.insts[i - 1].op === OP.log)
        {
            const a = operands(blob, x), e = operands(blob, y), P = scalar(a[0]);
            if (P && same(scalar(a[1]), P) && isCb(a[2], 4, power / 16, 3) && same(scalar(e[0]), P) && same(scalar(e[1]), P)) sites.B.push({ after: y, P });
        }
        if (x.op === OP.max)   // max S, S, cb2[3].w, or max S, <the filter's result>, cb2[3].w in the smaller filters
        {
            const a = operands(blob, x);
            if (scalar(a[0]) && isCb(a[2], 2, 3, 3)) sites.floor.push(wordsOf(blob, a[2]));
        }
        if (x.op === OP.mad)   // this patch's own "1 - g_fShadowAtten": the shader has it already
        {
            const a = operands(blob, x);
            if (isCb(a[1], 2, 3, 3) && a[2].type === 4 && a[2].imm.length === 1 && a[2].imm[0] === f32(-1)) return { reason: 'patched already' };
        }
    }
    // a lake shader's own form counts; some of them multiply the sun's colour from the scene's constants as well, for
    // another term
    const A = sites.A.length ? sites.A : sites.river;
    const T = blob.readUInt32LE(w.insts.find((x) => x.op === 104).off + 4);   // the new temp: first index past dcl_temps
    const TIME = [0x0020800a, 2, 0];                                           // cb2[0].x, g_fTime
    // on for `share` of every 1.5 s: 1 or 0 in rT's component c
    const blink = (c, share) => [
        ...ins(OP.mul, [...destOne(T, c), ...TIME, ...imm1(1 / 1.5)]),
        ...ins(OP.frc, [...destOne(T, c), ...srcOne(T, c)]),
        ...ins(OP.lt, [...destOne(T, c), ...srcOne(T, c), ...imm1(share)]),
        ...ins(OP.and, [...destOne(T, c), ...srcOne(T, c), ...imm1(1)]),
    ];
    const shaded = A.length === 1 && sites.B.length === 1 && sites.floor.length > 0;
    if (!shaded)
    {
        const reason = 'sun colour x shadow: ' + A.length + ', highlight power: ' + sites.B.length + ', shadow floor: ' + sites.floor.length;
        if (!diag || sites.B.length !== 1) return { reason };
        const [{ after: afterB, P }] = sites.B;
        const out = insertWords(blob, [{ at: afterB.off + afterB.len * 4, words: [...blink(0, 0.2), ...ins(OP.mul, [...destOne(P[0], P[1]), ...srcOne(P[0], P[1]), ...srcOne(T, 0)])] }],
            { temps: 1, stat: { instructions: 5, floatInstructions: 5 } });
        return { blob: out, note: 'diag: no shadow factor (' + reason + '), the highlight on for a fifth of the time' };
    }
    const [{ after: afterA, S }] = A, [{ after: afterB, P }] = sites.B;
    if (afterB.off < afterA.off) return { reason: 'the highlight comes before the shadow factor' };
    if (String(sites.floor[0]) !== String([0x0020803a, 2, 3])) return { reason: 'the shadow floor is not read as cb2[3].w is written here' };
    const sat = (words) => [(words[0] | SAT) >>> 0, ...words.slice(1)];
    const out = insertWords(blob, [
        {
            at: afterA.off + afterA.len * 4,
            words: [
                ...ins(OP.mad, [...destOne(T, 0), ...srcOne(S[0], S[1]), ...imm1(-1), ...imm1(1)]),
                ...ins(OP.mad, [...destOne(T, 1), ...sites.floor[0], ...imm1(-1), ...imm1(1)]),
                ...ins(OP.max, [...destOne(T, 1), ...srcOne(T, 1), ...imm1(0.001)]),
                ...ins(OP.div, [...destOne(T, 0), ...srcOne(T, 0), ...srcOne(T, 1)]),
                ...sat(ins(OP.mad, [...destOne(T, 0), ...srcOne(T, 0), ...imm1(-1), ...imm1(1)])),
                ...(diag ? [...blink(2, 0.8), ...ins(OP.mul, [...destOne(T, 0), ...srcOne(T, 0), ...srcOne(T, 2)])] : []),
            ],
        },
        { at: afterB.off + afterB.len * 4, words: ins(OP.mul, [...destOne(P[0], P[1]), ...srcOne(P[0], P[1]), ...srcOne(T, 0)]) },
    ], { temps: 1, stat: { instructions: diag ? 11 : 6, floatInstructions: diag ? 11 : 6 } });
    return { blob: out, note: (diag ? 'diag: the highlight on for four fifths of the time; ' : '') + 'shadow r' + S[0] + '.' + 'xyzw'[S[1]] + ', highlight r' + P[0] + '.' + 'xyzw'[P[1]] + ', temp r' + T };
}

// the lake and sea shaders and the river and mud shaders
const targets = () => ssr.domainTargets().concat(ssr.targets());
module.exports = { patchWaterSun, targets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'water', 'sun_set');
    fs.mkdirSync(outDir, { recursive: true });
    let done = 0;
    const skipped = {};
    for (const hash of targets())
    {
        const r = patchWaterSun(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')));
        if (!r.blob) { skipped[r.reason] = (skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        done++;
    }
    console.log('sun highlight in shadow: ' + done + ' of ' + targets().length + ' lake and sea shaders patched' + (Object.keys(skipped).length ? ', skipped ' + JSON.stringify(skipped) : '') + ' -> ' + outDir);
}
