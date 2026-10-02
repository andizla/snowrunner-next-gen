// Volumetric fog (0x871EF8CC, main cache): two insertions into the original ray march, nothing of it removed.
// The stock pass marches 128 steps of 0.5 m (0.5 + 0.1 x g_fLightingMode) from g_fStartDepth along the view ray,
// density = fog mask x height falloff, colour = shadow colour + light colour x (lamps, headlights), no dependence on the
// sun's direction; every pixel samples the same depth slices, which shows as layers at grazing angles.
//   1. Jitter: every pixel starts up to one step later (interleaved gradient noise on the fog target's uv), so the
//      slices turn into fine noise that the fog buffer's filtering smooths out.
//   2. Forward scattering: the in-scattered light (o0.rgb) is multiplied by P = (1 - K) + K x HG(G, cos) / isotropic,
//      cos = angle between the view ray and the direction to the directional light (g_dirLight.vDir is the direction
//      the light travels): about 1.65 toward the sun and 0.77 away with G 0.3, K 0.4. The density output (o1) is left
//      as it is, so the fog's opacity does not change, only how it is lit.
// Inserted before "loop" (rJ.x = jitter x step, rP.x = phase; two new temps), after "mad rT, rI, STEP, CB4[7].w"
// (add rT, rT, rJ.x) and before "mov o0.xyz, R" (mul R.xyz, R, rP.xxxx).
// usage: node patch_fog.js [G=0.3] [K=0.4] [outDir]
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, f32, ins } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const G = parseFloat(process.argv[2] || '0.3'), K = parseFloat(process.argv[3] || '0.4');
const outDir = process.argv[4] || path.join(W, 'replacements', 'fog_builds', 'jitter_phase');
const OP = { add: 0, dp2: 15, dp3: 16, exp: 25, frc: 26, log: 47, mad: 50, mov: 54, mul: 56, loop: 48 };
const destOne = (reg, c) => [(0x00100002 | ((1 << c) << 4)) >>> 0, reg];
const destMask = (reg, mask) => [(0x00100002 | (mask << 4)) >>> 0, reg];
const srcOne = (reg, c) => [(0x0010000a | (c << 4)) >>> 0, reg];
const srcSwz = (reg, sel) => [(0x00100006 | (sel << 4)) >>> 0, reg];            // temp, swizzle mode
const inputSwz = (reg, sel) => [(0x00101006 | (sel << 4)) >>> 0, reg];          // input vN, swizzle mode
const cbSwz = (slot, index, sel) => [(0x00208006 | (sel << 4)) >>> 0, slot, index]; // cbN[i], swizzle mode
const imm1 = (v) => [0x4001, f32(v)];
const imm4 = (a, b, c, d) => [0x4002, f32(a), f32(b), f32(c), f32(d)];
const SW = (x, y, z, w) => x | (y << 2) | (z << 4) | (w << 6);

const b = fs.readFileSync(path.join(DUMP, '0x871EF8CC.cso'));
const w = walk(b);
const T0 = b.readUInt32LE(w.insts.find((x) => x.op === 104).off + 4);
const J = T0, P = T0 + 1;
const loopAt = w.insts.findIndex((x) => x.op === OP.loop);
if (loopAt < 0 || w.insts.filter((x) => x.op === OP.loop).length !== 1) throw new Error('expected one loop');

// the step size register (mad STEP, cb2[0].y, l(0.1), l(0.5)) and the normalized view ray (the dp3/rsq/mul before it)
let step = null, ray = null;
for (let i = 0; i < loopAt; i++)
{
    const o = operands(b, w.insts[i]);
    if (w.insts[i].op === OP.mad && o[1].type === 8 && o[1].idx[0] === 2 && o[1].idx[1] === 0 && step === null) step = { reg: o[0].idx[0], c: [1, 2, 4, 8].indexOf(o[0].sel & 15) };
}
// "mad rT, rI, STEP, cb4[7].w" inside the loop: the march position
let marchAt = -1, march = null;
for (let i = loopAt; i < w.insts.length; i++)
{
    if (w.insts[i].op !== OP.mad) continue;
    const o = operands(b, w.insts[i]);
    if (o[3] && o[3].type === 8 && o[3].idx[0] === 4 && o[3].idx[1] === 7) { marchAt = i; march = { reg: o[0].idx[0], c: [1, 2, 4, 8].indexOf(o[0].sel & 15) }; break; }
}
// the view direction: first operand of "mad rX.xyz, RAY.xyzx, rT.wwww, cb1[0].xyzx" in the loop
for (let i = marchAt; i < w.insts.length && !ray; i++)
{
    if (w.insts[i].op !== OP.mad) continue;
    const o = operands(b, w.insts[i]);
    if (o[3] && o[3].type === 8 && o[3].idx[0] === 1 && o[3].idx[1] === 0 && o[1].type === 0) ray = o[1].idx[0];
}
// "mov o0.xyz, R.xyzx" after the loop
let outAt = -1, R = -1;
for (let i = w.insts.length - 1; i > loopAt; i--)
{
    if (w.insts[i].op !== OP.mov) continue;
    const o = operands(b, w.insts[i]);
    if (o[0].type === 2 && o[0].idx[0] === 0 && (o[0].sel & 15) === 7 && o[1].type === 0) { outAt = i; R = o[1].idx[0]; break; }
}
if (!step || step.c < 0 || marchAt < 0 || march.c < 0 || ray === null || outAt < 0) throw new Error('fog shape not recognised');

const g2 = G * G;
const pre = [
    // rJ.x = IGN(uv x 1024) x step
    ...ins(OP.mul, [...destMask(J, 3), ...inputSwz(0, SW(0, 1, 0, 0)), ...imm4(1024, 1024, 0, 0)]),
    ...ins(OP.dp2, [...destOne(J, 0), ...srcSwz(J, SW(0, 1, 0, 0)), ...imm4(0.06711056, 0.00583715, 0, 0)]),
    ...ins(OP.frc, [...destOne(J, 0), ...srcOne(J, 0)]),
    ...ins(OP.mul, [...destOne(J, 0), ...srcOne(J, 0), ...imm1(52.9829189)]),
    ...ins(OP.frc, [...destOne(J, 0), ...srcOne(J, 0)]),
    ...ins(OP.mul, [...destOne(J, 0), ...srcOne(J, 0), ...srcOne(step.reg, step.c)]),
    // rP.x = dot(ray, vDir) = -cos(angle to the light); ratio = (1 - G^2) / (1 + G^2 + 2 G dot)^1.5
    ...ins(OP.dp3, [...destOne(P, 0), ...srcSwz(ray, SW(0, 1, 2, 0)), ...cbSwz(2, 49, SW(0, 1, 2, 0))]),
    ...ins(OP.mad, [...destOne(P, 1), ...srcOne(P, 0), ...imm1(2 * G), ...imm1(1 + g2)]),
    ...ins(OP.log, [...destOne(P, 1), ...srcOne(P, 1)]),
    ...ins(OP.mul, [...destOne(P, 1), ...srcOne(P, 1), ...imm1(-1.5)]),
    ...ins(OP.exp, [...destOne(P, 1), ...srcOne(P, 1)]),
    ...ins(OP.mad, [...destOne(P, 0), ...srcOne(P, 1), ...imm1(K * (1 - g2)), ...imm1(1 - K)]),
];
const jitter = ins(OP.add, [...destOne(march.reg, march.c), ...srcOne(march.reg, march.c), ...srcOne(J, 0)]);
const phase = ins(OP.mul, [...destMask(R, 7), ...srcSwz(R, SW(0, 1, 2, 0)), ...srcSwz(P, 0)]);
const m = w.insts[marchAt];
const out = insertWords(b, [
    { at: w.insts[loopAt].off, words: pre },
    { at: m.off + m.len * 4, words: jitter },
    { at: w.insts[outAt].off, words: phase },
], { temps: 2, stat: { instructions: 14, floatInstructions: 14 } });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '0x871EF8CC.shader'), out);
console.log('fog: jitter + phase (G ' + G + ', K ' + K + '), ' + b.length + ' -> ' + out.length + ' bytes, step r' + step.reg + ', march r' + march.reg + ', ray r' + ray + ', out r' + R + ', new temps r' + J + ' r' + P);
