// Sky tinted ambient for SnowRunner's material shaders (replacements/ambient/sky_ambient.hlsl).
// For every ps_5_0 in dump/ that reads the three ambient colours (CB_GLOBAL_SCENE registers 50, 51, 52 at b2) and
// samples the reflection cube t86: the helper's instructions go in front of the shader's first instruction (its temps
// behind the shader's own, its sampler remapped to the one the shader uses for t86, its outputs o0/o1/o2 into three
// fresh temps), and every read of cb2[50], cb2[51], cb2[52] in the shader's own code is repointed at those temps
// (swizzle, negation and the rest of the operand kept). The engine's blend of the three by the normal stays as it is.
// A base folder (e.g. the shadow filter set) is patched on top of, so one shader can carry both.
// usage: node patch_ambient.js [baseSetDir|-] [outDir]     writes 0x<original CRC>.shader + report.json
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const baseDir = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : null;
const outDir = process.argv[3] || path.join(W, 'replacements', 'ambient', 'sky' + (baseDir ? '_on_' + path.basename(baseDir) : ''));
const helper = fs.readFileSync(path.join(W, 'replacements', 'ambient', 'sky_ambient.cso'));
const OP = { dcl_temps: 104, ret: 62, sample: 69, sample_l: 72, sample_b: 74, sample_d: 73 };
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = ~0; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 255]; return (~c) >>> 0; };
const hex8 = (v) => v.toString(16).toUpperCase().padStart(8, '0');

const isDecl = (op) => (op >= 88 && op <= 106) || (op >= 143 && op <= 183) || op === 53;
const isAmbient = (o) => o.type === 8 && o.dim === 2 && o.rep[0] === 0 && o.rep[1] === 0 && o.idx[0] === 2 && o.idx[1] >= 50 && o.idx[1] <= 52;

// the sampler register the shader uses with t86, or -1
function cubeSampler(b, w)
{
    for (const x of w.insts)
    {
        if (![OP.sample, OP.sample_l, OP.sample_b, OP.sample_d].includes(x.op)) continue;
        const o = operands(b, x);
        if (o[2] && o[2].type === 7 && o[2].idx[0] === 86 && o[3] && o[3].type === 6) return o[3].idx[0];
    }
    return -1;
}

// helper body (after dcl_temps, up to ret) with temps moved to base.., outputs oK -> RES+K, sampler -> s
function helperWords(base, sampler)
{
    const w = walk(helper);
    const dcl = w.insts.find((x) => x.op === OP.dcl_temps);
    const own = helper.readUInt32LE(dcl.off + 4);
    const res = base + own;
    const parts = [];
    for (const ins of w.insts.slice(w.insts.indexOf(dcl) + 1))
    {
        if (ins.op === OP.ret) break;
        const tok = Buffer.from(helper.subarray(ins.off, ins.off + ins.len * 4));
        for (const o of operands(helper, ins))
        {
            const at = o.off - ins.off, idxAt = at + o.size - 4;
            if (o.type === 0) tok.writeUInt32LE(base + o.idx[0], idxAt);
            else if (o.type === 2) { tok.writeUInt32LE((tok.readUInt32LE(at) & ~(0xff << 12)) >>> 0, at); tok.writeUInt32LE(res + o.idx[0], idxAt); }
            else if (o.type === 6) tok.writeUInt32LE(sampler, idxAt);
        }
        parts.push(tok);
    }
    return { words: Buffer.concat(parts), count: parts.length, temps: own + 3, res };
}

// the operand tokens of cbN[i] rewritten as rT (component selection, modifiers and extended tokens kept)
function asTemp(b, o, reg)
{
    const tok = b.readUInt32LE(o.off);
    const ext = o.size / 4 - 3; // token, extended tokens, two immediate indices
    const out = Buffer.alloc((ext + 2) * 4);
    out.writeUInt32LE(((tok & 0x80000fff) | (1 << 20)) >>> 0, 0); // type temp, one immediate index
    for (let i = 0; i < ext; i++) out.writeUInt32LE(b.readUInt32LE(o.off + 4 + i * 4), 4 + i * 4);
    out.writeUInt32LE(reg, (ext + 1) * 4);
    return out;
}

function patch(b)
{
    const w = walk(b);
    const sampler = cubeSampler(b, w);
    if (sampler < 0) return { reason: 'no t86 sample' };
    let reads = 0;
    for (const x of w.insts) if (!isDecl(x.op)) for (const o of operands(b, x)) if (isAmbient(o)) reads++;
    if (!reads) return { reason: 'no ambient read' };
    const first = w.insts.findIndex((x) => !isDecl(x.op));
    const dcl = w.insts.find((x) => x.op === OP.dcl_temps);
    if (!dcl || first < 0) return { reason: 'shape' };
    const base = b.readUInt32LE(dcl.off + 4);
    const h = helperWords(base, sampler);
    const ch = chunks(b), shex = ch.SHEX || ch.SHDR;
    const parts = [b.subarray(0, w.insts[first].off), h.words];
    for (const x of w.insts.slice(first))
    {
        const ops = operands(b, x);
        if (!ops.some(isAmbient)) { parts.push(b.subarray(x.off, x.off + x.len * 4)); continue; }
        // rebuild: opcode token(s), then every operand, the ambient reads as temps
        let p = x.off + 4;
        let t = b.readUInt32LE(x.off);
        while (t >>> 31) { t = b.readUInt32LE(p); p += 4; }
        const head = Buffer.from(b.subarray(x.off, p));
        const body = ops.map((o) => (isAmbient(o) ? asTemp(b, o, h.res + (o.idx[1] - 50)) : b.subarray(o.off, o.off + o.size)));
        const inst = Buffer.concat([head, ...body]);
        inst.writeUInt32LE(((head.readUInt32LE(0) & ~(0x7f << 24)) | ((inst.length / 4) << 24)) >>> 0, 0);
        parts.push(inst);
    }
    const end = shex.data + b.readUInt32LE(shex.data + 4) * 4;
    parts.push(b.subarray(end));
    const out = Buffer.concat(parts);
    const added = out.length - b.length;
    out.writeUInt32LE(out.length, 24);
    out.writeUInt32LE(shex.size + added, shex.off + 4);
    out.writeUInt32LE(b.readUInt32LE(shex.data + 4) + added / 4, shex.data + 4);
    out.writeUInt32LE(base + h.temps, dcl.off + 4);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++) { const o = b.readUInt32LE(32 + i * 4); if (o > shex.off) out.writeUInt32LE(o + added, 32 + i * 4); }
    if (ch.STAT)
    {
        const s = ch.STAT.data + (ch.STAT.off > shex.off ? added : 0);
        out.writeUInt32LE(out.readUInt32LE(s) + h.count, s);
        out.writeUInt32LE(out.readUInt32LE(s + 4) + h.temps, s + 4);
    }
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, reads };
}

module.exports = { patch };

if (require.main === module)
{
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const report = { base: baseDir, patched: 0, fromBase: 0, reads: 0, skipped: {} };
    for (const f of fs.readdirSync(DUMP))
    {
        if (!f.endsWith('.cso')) continue;
        const orig = fs.readFileSync(path.join(DUMP, f));
        const ch = chunks(orig), shex = ch.SHEX || ch.SHDR;
        if (!shex || (orig.readUInt32LE(shex.data) >>> 16) !== 0) continue; // pixel shaders only (program type 0)
        if (orig.indexOf('g_ambientLight') < 0) continue;
        const name = '0x' + hex8(crc32(orig)) + '.shader';
        const basePath = baseDir ? path.join(baseDir, name) : null;
        const src = basePath && fs.existsSync(basePath) ? fs.readFileSync(basePath) : orig;
        const r = patch(src);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, name), r.blob);
        report.patched++; report.reads += r.reads;
        if (src !== orig) report.fromBase++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
