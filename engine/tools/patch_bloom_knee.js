// Soft knee for SnowRunner's bloom (knee and downsample pass 0x52879E18, common_pc_sm50_hdr.sdc).
// Stock, per sample: k = max(lum * exposure - threshold, 0); w = 10 * (0.1 k)^BloomGamma with BloomGamma 0.6 from the
// daytime xml. An exponent under 1 lifts faint values: snow in daylight (k ~ 1.4) gets w ~ 3.1, which is the grey haze
// over bright surfaces. This patch keeps the original code and multiplies each of the four weights by
// f = k^2 / (k^2 + KNEE^2): about 0.18 for snow, 0.4 for sky, ~1 for the sun and headlights (k >> KNEE). Bloom stays
// on for real highlights.
// Inserted after every "max rK.c, rK.c, l(0)" that is followed by "mul rK.c, rK.c, l(0.1)":
//   mul rT.x, rK.c, rK.c ; add rT.y, rT.x, l(KNEE^2) ; div rT.x, rT.x, rT.y
// and after the matching "mul rK.c, rK.c, l(10)":  mul rK.c, rK.c, rT.x      (rT = one new temp)
// usage: node patch_bloom_knee.js [knee=3] [outDir]
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, f32, ins } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const KNEE = parseFloat(process.argv[2] || '3');
const outDir = process.argv[3] || path.join(W, 'replacements', 'bloom_builds', 'softknee');
const OP = { add: 0, div: 14, max: 52, mul: 56, log: 47, exp: 25 };
const asFloat = (u) => { const t = Buffer.alloc(4); t.writeUInt32LE(u >>> 0); return t.readFloatLE(0); };
const destOne = (reg, c) => [(0x00100002 | ((1 << c) << 4)) >>> 0, reg];
const srcOne = (reg, c) => [(0x0010000a | (c << 4)) >>> 0, reg];
const imm1 = (v) => [0x4001, f32(v)];
const oneComp = (mask) => [1, 2, 4, 8].indexOf(mask & 15);
const isImm = (o, v) => o && o.type === 4 && o.imm.length === 1 && Math.abs(asFloat(o.imm[0]) - v) < 1e-6;

const b = fs.readFileSync(path.join(DUMP, '0x52879E18.cso'));
const w = walk(b);
const T = b.readUInt32LE(w.insts.find((x) => x.op === 104).off + 4); // the new temp: first index past dcl_temps
const insertions = [];
let knees = 0;
for (let i = 0; i + 1 < w.insts.length; i++)
{
    const a = w.insts[i], m = w.insts[i + 1];
    if (a.op !== OP.max || m.op !== OP.mul) continue;
    const oa = operands(b, a), om = operands(b, m);
    if (oa[0].type !== 0 || !isImm(oa[2], 0) || !isImm(om[2], 0.1) || om[0].idx[0] !== oa[0].idx[0]) continue;
    const K = oa[0].idx[0], c = oneComp(oa[0].sel);
    if (c < 0) throw new Error('knee register with more than one component');
    // the "* 10" that closes this evaluation: log, mul (exponent), exp, mul 10 on the same register
    let j = i + 2, ten = -1;
    for (; j < Math.min(i + 8, w.insts.length); j++)
    {
        const x = w.insts[j];
        if (x.op !== OP.mul) continue;
        const ox = operands(b, x);
        if (ox[0].idx[0] === K && isImm(ox[2], 10)) { ten = j; break; }
    }
    if (ten < 0) throw new Error('no "* 10" after the knee at instruction ' + i);
    insertions.push({
        at: m.off,
        words: [
            ...ins(OP.mul, [...destOne(T, 0), ...srcOne(K, c), ...srcOne(K, c)]),
            ...ins(OP.add, [...destOne(T, 1), ...srcOne(T, 0), ...imm1(KNEE * KNEE)]),
            ...ins(OP.div, [...destOne(T, 0), ...srcOne(T, 0), ...srcOne(T, 1)]),
        ],
    });
    const t = w.insts[ten];
    insertions.push({ at: t.off + t.len * 4, words: ins(OP.mul, [...destOne(K, c), ...srcOne(K, c), ...srcOne(T, 0)]) });
    knees++;
}
if (knees !== 4) throw new Error('expected 4 knee evaluations, found ' + knees);
const out = insertWords(b, insertions, { temps: 1, stat: { instructions: knees * 4, floatInstructions: knees * 4 } });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '0x52879E18.shader'), out);
console.log('bloom knee: ' + knees + ' evaluations patched, knee ' + KNEE + ', ' + b.length + ' -> ' + out.length + ' bytes, temp r' + T);
