// Sun shafts in SnowRunner's volumetric fog (0x871EF8CC): replacements\fog\fog_sun.hlsl, compiled to fog_sun.cso,
// spliced into the fog's ray march once per step, on top of the jitter + phase build of tools\patch_fog.js (or the
// stock blob). The march (128 steps) makes each step's world position with "mad rP.xyz, RAY.xyzx, rT.wwww, cb1[0].xyzx"
// and adds the step's light with "mad rA.xyz, COLOUR, DENSITY, rA.xyzx" into the register that becomes o0.xyz after the
// loop. The helper goes right after the position (its result kept in a fresh temp rS), and one instruction after the
// stock accumulation adds it with the same density: "mad rA.xyz, rS.xyzx, DENSITY, rA.xyzx" (debug build: "add rA.xyz,
// rA.xyzx, rS.xyzx", so the pass shows the helper's colour code wherever it draws). The fog's density output (o1) is
// left as it is: the fog's opacity does not change, only how much sunlight it scatters where the sun reaches it.
// The shader also gets what the helper reads and it lacked: cb1 up to register 1 (the view direction), cb2 up to
// register 87 with dynamic indexing (the cascade matrices, g_aSMViewProjs, picked per step), the comparison sampler s15
// and t81 (g_txShadowmap), t89 (g_txCloudShadowMap); whether the game has them bound during this pass is not known yet,
// so the helper adds nothing when t81 reads as unbound (width 0).
// Library: patchFogSun(blob[, helper, { debug }]) -> { blob } or { reason }.
// usage: node patch_fog_sun.js [variant] [inDir] [outDir]    variant sun (default) or sun_debug: writes
//        <outDir>\0x871EF8CC.shader (default replacements\fog_builds\jitter_phase_<variant>) from the jitter_phase build
//        in <inDir> (default replacements\fog_builds\jitter_phase)
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, dxbcChecksum, ins } = require('./dxbc_patch.js');
const { splice, tokens, words } = require('./patch_water_mix.js');
const dwords = (buf) => Array.from({ length: buf.length / 4 }, (_, k) => buf.readUInt32LE(k * 4));

const W = path.resolve(__dirname, '..');
const HELPER = path.join(W, 'replacements', 'fog', 'fog_sun.cso');
const HELPER_DEBUG = path.join(W, 'replacements', 'fog', 'fog_sun_debug.cso');
const OP = { add: 0, loop: 48, endloop: 22, mad: 50, mov: 54, dcl_resource: 88, dcl_constantbuffer: 89, dcl_sampler: 90, dcl_temps: 104 };
const tempDst = (reg, mask) => [(0x00100002 | (mask << 4)) >>> 0, reg];   // rN.<mask>
const tempXYZX = (reg) => [0x00100246, reg];                               // rN.xyzx
const IMM0 = [0x00004002, 0, 0, 0, 0];                                     // l(0, 0, 0, 0)

// the march's pieces: the step's world position "mad rP.xyz, RAY.xyzx, rT.w, cb1[0].xyzx" and the accumulation
// "mad rA.xyz, X, D, rA.xyzx" of the register that becomes o0.xyz after the loop
function locate(b)
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    const loopAt = L.findIndex((e) => e.x.op === OP.loop), endAt = L.findIndex((e) => e.x.op === OP.endloop);
    if (loopAt < 0 || endAt < loopAt || L.filter((e) => e.x.op === OP.loop).length !== 1) return { reason: 'expected one loop' };
    const inLoop = L.slice(loopAt + 1, endAt);
    const isEye = (o) => o && o.type === 8 && o.idx[0] === 1 && o.idx[1] === 0;
    const pos = inLoop.filter((e) => e.x.op === OP.mad && isEye(e.o[3]) && e.o[0].type === 0 && (e.o[0].sel & 15) === 7 && e.o[1].type === 0);
    if (pos.length !== 1) return { reason: 'step positions found: ' + pos.length };
    const out = L.slice(endAt).find((e) => e.x.op === OP.mov && e.o[0].type === 2 && e.o[0].idx[0] === 0 && (e.o[0].sel & 15) === 7 && e.o[1].type === 0);
    if (!out) return { reason: 'no mov o0.xyz after the loop' };
    const A = out.o[1].idx[0];
    const acc = inLoop.filter((e) => e.x.op === OP.mad && e.o[0].type === 0 && e.o[0].idx[0] === A && (e.o[0].sel & 15) === 7 && e.o[3].type === 0 && e.o[3].idx[0] === A);
    if (acc.length !== 1) return { reason: 'accumulations found: ' + acc.length };
    if (acc[0].i < pos[0].i) return { reason: 'the accumulation comes before the position' };
    return { w, L, pos: pos[0], acc: acc[0], P: pos[0].o[0].idx[0], RAY: pos[0].o[1].idx[0], A };
}

// what the helper declares: its texture slots and each constant buffer's register count (it may also read the
// camera's view-projection, cb1 c2..c5, and SnowRunner Shadows' linear depth at t121)
function helperNeeds(h)
{
    const tex = [], cb = {};
    for (const x of walk(h).insts)
    {
        if (x.op !== OP.dcl_resource && x.op !== OP.dcl_constantbuffer) continue;
        const o = operands(h, x)[0];
        if (x.op === OP.dcl_resource) tex.push(o.idx[0]);
        else cb[o.idx[0]] = h.readUInt32LE(o.off + o.size - 4);
    }
    return { tex, cb };
}

function patchFogSun(b, helper = fs.readFileSync(HELPER), { debug = false } = {})
{
    const f0 = locate(b);
    if (f0.reason) return f0;
    const { L } = f0;
    const needs = helperNeeds(helper);
    // declarations: an existing sampler and texture declaration as templates for s15 (comparison) and t81, t89 (the
    // fog's textures are all texture2d); inserted first and on their own, because insertWords writes a new temp count
    // where dcl_temps sat before the insertions
    const samplers = L.filter((e) => e.x.op === OP.dcl_sampler), textures = L.filter((e) => e.x.op === OP.dcl_resource);
    const has = (list, n) => list.some((e) => e.o[0].idx[0] === n);
    if (!samplers.length || !textures.length) return { reason: 'no sampler or texture declaration to copy' };
    if (!has(samplers, 3)) return { reason: 's3 not declared' };
    const copyDcl = (e, index, tokenFix) =>
    {
        const words = [];
        for (let k = 0; k < e.x.len; k++) words.push(b.readUInt32LE(e.x.off + k * 4));
        if (tokenFix) words[0] = tokenFix(words[0]);
        words[2] = index;   // opcode, operand token, index (, return type)
        return words;
    };
    const lastSampler = samplers[samplers.length - 1], lastTexture = textures[textures.length - 1];
    const dcls = [];
    if (!has(samplers, 15)) dcls.push({ at: lastSampler.x.off + lastSampler.x.len * 4, words: copyDcl(samplers[0], 15, (t) => ((t & ~(15 << 11)) | (1 << 11)) >>> 0) });
    const newTextures = [...new Set([81, 89, ...needs.tex])].filter((t) => !has(textures, t)).sort((x, y) => x - y);
    if (newTextures.length) dcls.push({ at: lastTexture.x.off + lastTexture.x.len * 4, words: newTextures.flatMap((t) => copyDcl(textures[0], t)) });
    const b1 = dcls.length ? insertWords(b, dcls) : b;
    // the placeholder after the position, the added accumulation after the stock one; one new temp for the result
    const f = locate(b1);
    if (f.reason) return f;
    const { P, RAY, A } = f;
    const S = b1.readUInt32LE(f.w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const placeholder = ins(OP.mov, [...tempDst(S, 7), ...IMM0]);
    const density = dwords(tokens(b1, f.acc.o[2]));
    const addSun = debug ? ins(OP.add, [...tempDst(A, 7), ...tempXYZX(A), ...tempXYZX(S)]) : ins(OP.mad, [...tempDst(A, 7), ...tempXYZX(S), ...density, ...tempXYZX(A)]);
    const d = insertWords(b1, [
        { at: f.pos.x.off + f.pos.x.len * 4, words: placeholder },
        { at: f.acc.x.off + f.acc.x.len * 4, words: addSun },
    ], { temps: 1, stat: { instructions: 2, floatInstructions: 1, movInstructions: 1 } });
    // constant buffers: cb1 to 2 registers (6 when the helper reads the view-projection), cb2 to 88 with dynamic
    // indexing (the helper picks the cascade's matrix)
    const w1 = walk(d);
    const need = { 1: [Math.max(2, needs.cb[1] || 0), false], 2: [88, true] };
    for (const x of w1.insts.filter((y) => y.op === OP.dcl_constantbuffer))
    {
        const o = operands(d, x)[0];
        const n = need[o.idx[0]];
        if (!n) continue;
        const at = o.off + o.size - 4;
        if (d.readUInt32LE(at) < n[0]) d.writeUInt32LE(n[0], at);
        if (n[1]) d.writeUInt32LE((d.readUInt32LE(x.off) | (1 << 11)) >>> 0, x.off);
        delete need[o.idx[0]];
    }
    if (Object.keys(need).length) return { reason: 'cb1 or cb2 not declared' };
    dxbcChecksum(d.subarray(20)).copy(d, 4);
    // the helper in place of the placeholder: v0 = the position, v1 = the ray; its result into rS.xyz
    const w2 = walk(d);
    const ph = w2.insts.find((x) => x.op === OP.mov && (() => { const o = operands(d, x); return o[0].type === 0 && o[0].idx[0] === S; })());
    if (!ph) return { reason: 'placeholder lost' };
    return splice(d, w2, { x: ph, o: operands(d, ph) }, helper, 2, [[7, words(...tempXYZX(P))], [7, words(...tempXYZX(RAY))]], operands(d, ph)[0]);
}

module.exports = { patchFogSun };

if (require.main === module)
{
    const variant = process.argv[2] || 'sun';
    if (!/^(sun|sun_debug)$/.test(variant)) throw new Error('variant sun or sun_debug');
    const debug = variant === 'sun_debug';
    const src = path.join(process.argv[3] || path.join(W, 'replacements', 'fog_builds', 'jitter_phase'), '0x871EF8CC.shader');
    const r = patchFogSun(fs.readFileSync(src), fs.readFileSync(debug ? HELPER_DEBUG : HELPER), { debug });
    if (!r.blob) throw new Error('not patched: ' + r.reason);
    const outDir = process.argv[4] || path.join(W, 'replacements', 'fog_builds', 'jitter_phase_' + variant);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '0x871EF8CC.shader'), r.blob);
    console.log('fog + sun' + (debug ? ' (debug)' : '') + ': ' + fs.statSync(src).size + ' -> ' + r.blob.length + ' bytes, in ' + outDir);
}
