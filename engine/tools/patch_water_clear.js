// Clearer shallows for SnowRunner's lake, sea and puddle water: the bottom shows further in where the water is shallow,
// and deep water still darkens and tints. The lake shaders measure the water a pixel looks through as
//     path = max(depth behind - water depth, 0) x 1 / cos(view angle)     (metres along the view ray)
// ("add rP, rZ, -vN.w; max rP, rP, l(0); mul rP, rS, rP") and use it for the see-through fade (T = exp(path x opacity))
// and the refraction tint (sqrt(path x tint)). Right after it is made, path becomes path^2 / (path + P0): thin water much
// thinner (0.1 m reads as 0.017, 0.5 m as 0.25 with P0 0.5), deep water nearly as it was (5 m as 4.5). The rivers get
// the same through their absorb helper (ABSORB_SHALLOW in replacements\water\absorb.hlsl).
// Found by structure: the add of a register minus an input's .w, the max with 0 and the mul by a register (not an
// immediate: the refraction offset nearby multiplies by l(0.2)) on the same component, in that order.
// Library: patchClear(blob[, P0]) -> { blob } or { reason }.
'use strict';
const { walk, operands } = require('./dxbc_shex.js');
const { insertWords, ins, f32 } = require('./dxbc_patch.js');
const P0 = process.env.WATER_CLEAR_P0 !== undefined ? Number(process.env.WATER_CLEAR_P0) : 0.5;
const OP = { add: 0, div: 14, max: 52, mul: 56, dcl_temps: 104 };
const TEMP = 0, INPUT = 1, IMM = 4;
const comp = (o) => (o.ext ? -1 : o.mode === 2 ? o.sel & 3 : o.mode === 1 && [0x00, 0x55, 0xaa, 0xff].includes(o.sel) ? o.sel & 3 : -1);
const negated = (o) => o.ext && ((o.ext >>> 6) & 3) === 1;   // extended operand modifier: 1 = negate
const dstComp = (o) => (o.type === TEMP && o.mode === 0 && !o.ext ? [1, 2, 4, 8].indexOf(o.sel & 15) : -1);

function patchClear(b, p0 = P0)
{
    if (!(p0 > 0)) return { reason: 'P0 0: nothing to do' };
    const L = walk(b).insts.map((x) => ({ x, o: operands(b, x) }));
    const hits = [];
    for (let i = 0; i + 2 < L.length; i++)
    {
        const [a, m, u] = [L[i], L[i + 1], L[i + 2]];
        if (a.x.op !== OP.add || a.x.sat || m.x.op !== OP.max || m.x.sat || u.x.op !== OP.mul || u.x.sat) continue;
        const c = dstComp(a.o[0]), r = a.o[0].idx[0];
        if (c < 0 || a.o[2].type !== INPUT || !negated(a.o[2]) || (a.o[2].sel & 3) !== 3) continue;
        if (dstComp(m.o[0]) !== c || m.o[0].idx[0] !== r || m.o[1].type !== TEMP || m.o[1].idx[0] !== r || comp(m.o[1]) !== c || m.o[2].type !== IMM || m.o[2].imm[0] !== 0) continue;
        if (dstComp(u.o[0]) !== c || u.o[0].idx[0] !== r) continue;
        const [s1, s2] = [u.o[1], u.o[2]];
        const pathIn = (s) => s.type === TEMP && s.idx[0] === r && comp(s) === c;
        const scale = (s) => s.type === TEMP && comp(s) >= 0;
        if (!((pathIn(s2) && scale(s1)) || (pathIn(s1) && scale(s2)))) continue;
        hits.push({ at: u.x.off + u.x.len * 4, r, c });
    }
    if (hits.length !== 1) return { reason: 'water paths found: ' + hits.length };
    const { at, r, c } = hits[0];
    const T = b.readUInt32LE(L.find((e) => e.x.op === OP.dcl_temps).x.off + 4);
    const dst = (reg, k) => [(0x00100002 | ((1 << k) << 4)) >>> 0, reg], src = (reg, k) => [(0x0010000a | (k << 4)) >>> 0, reg];
    const words = [
        ...ins(OP.add, [...dst(T, 0), ...src(r, c), 0x00004001, f32(p0)]),     // T.x = path + P0
        ...ins(OP.mul, [...dst(r, c), ...src(r, c), ...src(r, c)]),            // path = path^2
        ...ins(OP.div, [...dst(r, c), ...src(r, c), ...src(T, 0)]),            // path = path^2 / (path + P0)
    ];
    return { blob: insertWords(b, [{ at, words }], { temps: 1, stat: { instructions: 3, floatInstructions: 3 } }) };
}

module.exports = { patchClear, P0 };
