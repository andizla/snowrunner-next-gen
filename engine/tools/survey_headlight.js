// Survey (read only) of the game's headlight lighting, for the headlight shadows splice: every pixel shader that binds
// g_txHeadLightMap, how it samples it (instruction, texture and sampler slot), and whether the world position the
// shader measures from the headlight (add rX, <pos>, -cb2[24].xyz: the pixel minus g_vHeadLightPos[0]) can be found.
// usage: node survey_headlight.js        (SR_DUMP_DIR: the game's shaders as extract.js writes them, else dump\)
'use strict';
const fs = require('fs'), path = require('path');
const { walk, operands } = require('./dxbc_shex.js');
const DUMP = process.env.SR_DUMP_DIR || path.join(__dirname, '..', 'dump');
const OP = { add: 0, sample: 69, sample_l: 72, sample_d: 73, sample_b: 74, loop: 48, endloop: 22, dcl_constantbuffer: 89 };
const SAMPLES = [OP.sample, OP.sample_l, OP.sample_d, OP.sample_b];
const idx = JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
const recs = idx.filter((r) => /^ps/.test(r.profile) && (r.res || []).some((x) => x.name === 'g_txHeadLightMap'));
const tally = (m, k) => { m[k] = (m[k] || 0) + 1; };
const slots = {}, how = {}, worldFrom = {}, cb1 = {}, counts = {}, inLoop = {};
for (const r of recs)
{
    const slot = r.res.find((x) => x.name === 'g_txHeadLightMap').bind;
    tally(slots, 't' + slot);
    const b = fs.readFileSync(path.join(DUMP, '0x' + r.hash + '.cso')), w = walk(b);
    let n = 0, depth = 0, world = null, cbSize = 0;
    w.insts.forEach((x) =>
    {
        const o = operands(b, x);
        if (x.op === OP.loop) depth++; if (x.op === OP.endloop) depth--;
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8 && o[0].idx[0] === 1) cbSize = o[0].idx[1];
        if (SAMPLES.includes(x.op) && o[2] && o[2].type === 7 && o[2].idx[0] === slot)
        {
            n++; tally(how, ['sample', '', '', 'sample_l', 'sample_d', 'sample_b'][x.op - 69] + ' s' + (o[3] ? o[3].idx[0] : '?'));
            if (depth) tally(inLoop, 'in a loop');
        }
        // pixel minus g_vHeadLightPos[0]: add rX, <p>, -cb2[24]
        if (x.op === OP.add && o.length === 3 && !world)
        {
            const lamp = (p) => p.type === 8 && p.idx[0] === 2 && p.idx[1] === 24;
            const kind = (p) => (p.type === 1 ? 'input v' : p.type === 0 ? 'temp r' : 'type ' + p.type);
            if (lamp(o[2])) world = kind(o[1]); else if (lamp(o[1])) world = kind(o[2]);
        }
    });
    tally(counts, n + ' sample(s)'); tally(worldFrom, world || 'not found'); tally(cb1, 'cb1[' + cbSize + ']');
}
console.log(JSON.stringify({ shaders: recs.length, slots, how, counts, inLoop, worldFrom, cb1 }, null, 1));
