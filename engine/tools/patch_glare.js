// Tamer headlight shine on wet ground. SnowRunner's terrain (and the models that get wet) lights every surface with a
// GGX highlight per truck headlight, its distribution term capped at 32 (min(D, 32)). On the smooth, rippled surface of
// a road puddle that cap is reached along a long stretch in front of the truck, and the lamps draw a long bright band
// across the water. This lowers the cap for
// the headlights only (default 6): the band's core dims and its tail sinks below the rest of the lighting sooner; rough
// surfaces, whose highlight never gets near the cap, look as they did. The sun's highlight and the baked local lights
// from the terrain lightmap keep their 32.
// A cap belongs to a headlight when a read of g_cHeadLightColor[k] (cb2[16..19]) lies between it and the previous cap:
// each headlight block reads its colour before it works out its highlight. The immediate is rewritten in place, so
// nothing else in the shader moves; works on a stock shader or one the other modules already patched.
// Targets: the pixel shaders that read g_txWaterMap (terrain and the models that get wet).
// Library: patchGlare(blob[, cap]) -> { blob, caps, others } or { reason }; targets(); CAP.
// usage: node patch_glare.js [cap]    what it would do to the stock shaders
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const CAP = 6;
const F32 = 0x42000000; // 32.0f
const OP_MIN = 51;
const bitsOfFloat = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readUInt32LE(0); };

function patchGlare(b, cap = CAP)
{
    const out = Buffer.from(b);
    let lamp = false, caps = 0, others = 0;
    for (const x of walk(b).insts)
    {
        const o = operands(b, x);
        if (o.some((p) => p.type === 8 && p.idx[0] === 2 && typeof p.idx[1] === 'number' && p.idx[1] >= 16 && p.idx[1] <= 19)) lamp = true;
        if (x.op !== OP_MIN) continue;
        const imm = o.slice(1).filter((p) => p.type === 4 && p.imm.includes(F32));
        if (!imm.length) continue;
        if (!lamp) { others++; continue; }
        for (const p of imm) p.imm.forEach((v, k) => { if (v === F32) out.writeUInt32LE(bitsOfFloat(cap), p.off + p.size - 4 * (p.imm.length - k)); });
        caps++;
        lamp = false;
    }
    if (!caps) return { reason: 'no headlight highlight caps' };
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, caps, others };
}

// the pixel shaders that read the terrain water map
function targets()
{
    const idx = JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
    return idx.filter((r) => /^ps/.test(r.profile) && (r.res || []).some((x) => x.name === 'g_txWaterMap')).map((r) => r.hash);
}

module.exports = { patchGlare, targets, CAP };

if (require.main === module)
{
    const cap = process.argv[2] ? Number(process.argv[2]) : CAP;
    const report = { targets: 0, patched: 0, caps: {}, others: {}, skipped: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchGlare(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), cap);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        report.patched++;
        report.caps[r.caps] = (report.caps[r.caps] || 0) + 1;
        report.others[r.others] = (report.others[r.others] || 0) + 1;
    }
    console.log(JSON.stringify(report));
}
