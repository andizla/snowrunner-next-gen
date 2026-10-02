// Sun glow through smoke, dust and steam, spliced into SnowRunner's particle vertex shaders (the 205 vs_5_0 shaders with
// CB_INSTANCE's g_vLifeTime / g_vBillboardOffset). The helper replacements\smoke\smoke_glow.hlsl (compiled to
// smoke_glow.cso next to it) turns the vertex's world position into a factor on the puff's sun light: a forward
// scattering lobe towards the sun, 1 everywhere else. Where that factor goes depends on how the vertex shader lights
// its particles; three families, told apart by their code:
//   light map     "mul rL.xyz, rL.xyzx, l(6, 6, 6, 0)": the baked top-down light map decoded to the sun light, later
//                 faded by height, night and distance and (in the lit pixel shaders) multiplied by the shadow test.
//                 rL is multiplied by the factor right after the decode, so every fade applies to the glow as well.
//   sun colour    one "mad" with g_dirLight.vColor (cb2[48]). Added at the end of the sun term (mad a, f, cb2[48]):
//                 the mad's result is multiplied by the factor. Multiplied by a visibility factor and added to the
//                 ambient (mad cb2[48], f, ambient): the factor scales f first, through a fresh temp.
//   no sun        the sun output (TEXCOORD5) is "mov oN.xyz, l(0, 0, 0, 0)": those particles never see the sun. The mov
//                 becomes sun colour times (factor - 1), so the glow alone reaches them, still shadowed by the pixel
//                 shader like any sun light.
// The world position is the register the shader transforms with the view-projection (dp4 oPos.x, rP.xyzw, cb1[2]);
// when the shader overwrites it before the light code, a copy is saved right after the transform. cb2 is declared to
// register 50 where a shader declares fewer (the helper reads g_dirLight.vDir at cb2[49]). Shaders lighting their
// particles some other way (a combined light output without the decode, a sun output computed otherwise) are left as
// they are, with the reason in the report. With the helper built at SMOKE_GLOW=0 the factor is the literal 1 and the
// glow the literal 0, so every patched shader computes exactly what the stock one did (the proof build).
// Library: patchSmoke(blob[, helper]) -> { blob, note } or { reason }; targets() -> the hashes in dump\.
// usage: node patch_smoke.js [outDir]    the set built on the stock shaders (default replacements\smoke\set)
const fs = require('fs'), path = require('path');
const { chunks, walk, operands } = require('./dxbc_shex.js');
const { helperBody, replaceRange } = require('./shadow_filter_patch.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const DUMP = process.env.SR_DUMP_DIR || path.join(W, 'dump');   // the game's shaders (extract.js output): SR_DUMP_DIR, else dump\
const HELPER = path.join(W, 'replacements', 'smoke', 'smoke_glow.cso');
const OP = { dp4: 17, mad: 50, mov: 54, mul: 56, dcl_constantbuffer: 89, dcl_temps: 104 };
const SUN_COLOUR = 48, SUN_DIR = 49;

const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const f32 = (u) => { const b = Buffer.alloc(4); b.writeUInt32LE(u >>> 0); return b.readFloatLE(0); };
const tokens = (b, o) => b.subarray(o.off, o.off + o.size);
const inst = (op, ...ops) => { const n = ops.reduce((s, o) => s + o.length, 0) / 4; return Buffer.concat([words(op | ((1 + n) << 24)), ...ops]); };
const tempDest = (reg, mask) => words(0x00100002 | (mask << 4), reg);
const tempSwz = (reg, swz) => words(0x00100006 | (swz << 4), reg);   // rN with a swizzle: 0xe4 xyzw, 0x00 xxxx, 0x55 yyyy
const cbSrc = (slot, reg, swz) => words(0x00208006 | (swz << 4), slot, reg); // cbS[reg] with a swizzle (two indices)
const isCb = (o, slot, reg) => o && o.type === 8 && o.idx[0] === slot && o.idx[1] === reg;
const isTemp = (o) => o && o.type === 0;
const scalarSwizzle = (o) => o.mode === 1 && [0x00, 0x55, 0xaa, 0xff].includes(o.sel);

// the output signature: [{ name, index, reg, mask }]
function outputs(b)
{
    const ch = chunks(b), sig = ch.OSGN || ch.OSG5;
    if (!sig) return [];
    const d = sig.data, count = b.readUInt32LE(d), stride = ch.OSG5 ? 32 : 24, skip = ch.OSG5 ? 4 : 0, out = [];
    for (let i = 0; i < count; i++)
    {
        const e = d + 8 + i * stride + skip;
        const nameOff = b.readUInt32LE(e), end = b.indexOf(0, d + nameOff);
        out.push({ name: b.toString('latin1', d + nameOff, end), index: b.readUInt32LE(e + 4), reg: b.readUInt32LE(e + 16), mask: b[e + 20] });
    }
    return out;
}

function patchSmoke(b, helper = fs.readFileSync(HELPER))
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let cb1 = false, cb2 = null, pos = null, six = null;
    const sun = [];
    for (const e of L)
    {
        const { x, o } = e;
        if (x.op === OP.dcl_constantbuffer && o[0] && o[0].type === 8) { if (o[0].idx[0] === 1) cb1 = true; if (o[0].idx[0] === 2) cb2 = e; }
        if (x.op === OP.dp4 && !pos && o[0] && o[0].type === 2 && isTemp(o[1]) && o[1].sel === 0xe4 && isCb(o[2], 1, 2)) pos = e;
        if (x.op === OP.mul && o.length === 3 && isTemp(o[0]) && isTemp(o[1]) && o[0].idx[0] === o[1].idx[0] && (o[0].sel & 15) === 7 && o[2].type === 4 && o[2].imm.length === 4 &&
            [0, 1, 2].every((k) => Math.abs(f32(o[2].imm[k]) - 6) < 1e-6)) { if (six) return { reason: 'two light map decodes' }; six = e; }
        if (o.some((p) => isCb(p, 2, SUN_COLOUR))) sun.push(e);
    }
    if (!cb1 || !cb2) return { reason: 'no cb1 or cb2' };
    if (!pos) return { reason: 'no position transform' };
    const rP = pos.o[1].idx[0];
    const base = b.readUInt32LE(w.insts.find((x) => x.op === OP.dcl_temps).off + 4);
    const h = helperBody(helper, base, 1);
    const T = base + h.temps, TP = base + h.temps + 1;      // a scaled factor, a saved world position
    const F = tempSwz(h.RES, 0x00), GLOW = tempSwz(h.RES, 0x55);

    // the anchor and what the splice does there; keep: the anchor instruction stays and the splice follows it
    let e, family, insert, keep = true;
    if (sun.length === 0 && six)
    {
        e = six; family = 'light map';
        insert = (P) => Buffer.concat([P, ...h.body, inst(OP.mul, tokens(b, e.o[0]), tempSwz(e.o[0].idx[0], 0xe4), F)]);   // after the decode
    }
    else if (sun.length === 1 && (sun[0].x.op === OP.mad && sun[0].o.length === 4 || sun[0].x.op === OP.mul && sun[0].o.length === 3))
    {
        e = sun[0]; const o = e.o;
        const addend = e.x.op === OP.mad && isCb(o[3], 2, SUN_COLOUR);
        if (addend && isTemp(o[0]))
        {
            // the sun colour added at the end of the sun term: the result is the sun light alone, multiplied right after
            family = 'sun colour added';
            insert = (P) => Buffer.concat([P, ...h.body, inst(OP.mul, tokens(b, o[0]), tempSwz(o[0].idx[0], 0xe4), F)]);
        }
        else if (!addend)
        {
            // the sun colour times a visibility factor (a mul, straight into a temp or an output register) or that plus
            // the ambient (a mad): the factor's components are scaled into a fresh temp, which the rebuilt instruction
            // reads with the factor's own swizzle
            const k = isCb(o[1], 2, SUN_COLOUR) ? 2 : isCb(o[2], 2, SUN_COLOUR) ? 1 : 0;
            if (!k || o[k].mode !== 1 || ![0, 1, 8].includes(o[k].type)) return { reason: 'sun colour ' + (e.x.op === OP.mul ? 'mul' : 'mad') + ': the factor is not a swizzled register' };
            if (o[k].ext) return { reason: 'sun colour ' + (e.x.op === OP.mul ? 'mul' : 'mad') + ': the factor has a modifier' };
            const s = [0, 1, 2, 3].map((c) => (o[k].sel >> (2 * c)) & 3), mask = s.reduce((m, c) => m | (1 << c), 0);
            // the factor read with each of its components in place (the lanes it never names read its first one, so an
            // input is read within its declaration), scaled into T's same components
            const read = Buffer.from(tokens(b, o[k]));
            const self = [0, 1, 2, 3].map((c) => (mask & (1 << c) ? c : s[0])).reduce((p, c, i) => p | (c << (2 * i)), 0);
            read.writeUInt32LE(((read.readUInt32LE(0) & ~(0xff << 4)) | (self << 4)) >>> 0, 0);
            family = e.x.op === OP.mul ? 'sun colour times visibility' : 'sun colour times visibility, plus ambient';
            keep = false;
            const head = b.subarray(e.x.off, o[0].off);   // the opcode token(s)
            const srcs = o.slice(1).map((p, j) => (j + 1 === k ? tempSwz(T, o[k].sel) : tokens(b, p)));
            const rebuilt = Buffer.concat([Buffer.from(head), tokens(b, o[0]), ...srcs]);
            rebuilt.writeUInt32LE(((head.readUInt32LE(0) & ~(0x7f << 24)) | ((rebuilt.length / 4) << 24)) >>> 0, 0);
            insert = (P) => Buffer.concat([P, ...h.body, inst(OP.mul, tempDest(T, mask), read, F), rebuilt]);   // in place of it
        }
        else return { reason: 'the sun colour mad writes an output' };
    }
    else if (sun.length === 0)
    {
        const out = outputs(b).find((s) => s.name === 'TEXCOORD' && s.index === 5);
        if (!out) return { reason: 'no light map decode, no sun colour, no sun output' };
        // the writes to the sun output's own components (another semantic may share the register's .w)
        const writes = L.filter((q) => (q.x.op < 88 || q.x.op > 106) && q.o[0] && q.o[0].type === 2 && q.o[0].idx[0] === out.reg && ((q.o[0].sel & 15) & out.mask));
        if (writes.length !== 1) return { reason: 'sun output written ' + writes.length + ' times' };
        e = writes[0];
        if (e.x.op !== OP.mov || e.o[1].type !== 4 || !e.o[1].imm.every((v) => v === 0)) return { reason: 'sun output computed (opcode ' + e.x.op + ')' };
        family = 'no sun'; keep = false;
        insert = (P) => Buffer.concat([P, ...h.body, inst(OP.mul, tokens(b, e.o[0]), cbSrc(2, SUN_COLOUR, 0x24), GLOW)]);   // in place of the mov
    }
    else return { reason: 'sun colour used ' + sun.length + ' times (opcodes ' + sun.map((q) => q.x.op).join(',') + ')' };
    if (e.i <= pos.i) return { reason: 'the light code comes before the position transform' };

    // the world position at the anchor: the transformed register, or a copy saved right after the transform
    let clobbered = false;
    for (const q of L.slice(pos.i + 1, e.i)) if (q.o[0] && isTemp(q.o[0]) && q.o[0].idx[0] === rP && (q.o[0].sel & 7)) clobbered = true;
    const P = inst(OP.mov, tempDest(h.IN(0), 7), tempSwz(clobbered ? TP : rP, 0xe4));
    const from = keep ? e.x.off + e.x.len * 4 : e.x.off, to = e.x.off + e.x.len * 4;
    const block = insert(P);
    let out = replaceRange(b, from, to, block, h.temps + 2, block.length / 4 - (keep ? 0 : 1));
    if (clobbered)
    {
        const save = inst(OP.mov, tempDest(TP, 7), tempSwz(rP, 0xe4));
        out = replaceRange(out, pos.x.off + pos.x.len * 4, pos.x.off + pos.x.len * 4, save, 0, 1);
    }
    // cb2 declared to the sun direction where it is not (the declaration lies before the code: its offset holds)
    const declared = cb2.o[0].idx[1];
    if (declared <= SUN_DIR) out.writeUInt32LE(SUN_DIR + 1, cb2.o[0].off + cb2.o[0].size - 4);
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: family + ' at ' + e.i + ', world r' + rP + (clobbered ? ' (saved)' : '') + (declared <= SUN_DIR ? ', cb2 ' + declared + ' -> ' + (SUN_DIR + 1) : '') };
}

const index = () => JSON.parse(fs.readFileSync(path.join(DUMP, 'index.json')));
// the particle vertex shaders: CB_INSTANCE with the particle system's variables
function targets()
{
    return index().filter((r) => /^vs/.test(r.profile) && (r.cbs || []).some((c) => c.name === 'CB_INSTANCE' && (c.vars || []).some((v) => v === 'g_vLifeTime' || v === 'g_vBillboardOffset'))).map((r) => r.hash);
}

module.exports = { patchSmoke, targets };

if (require.main === module)
{
    const outDir = process.argv[2] || path.join(W, 'replacements', 'smoke', 'set');
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of fs.readdirSync(outDir)) if (f.endsWith('.shader')) fs.unlinkSync(path.join(outDir, f));
    const helper = fs.readFileSync(HELPER);
    const report = { targets: 0, patched: 0, families: {}, skipped: {}, notes: {} };
    for (const hash of targets())
    {
        report.targets++;
        const r = patchSmoke(fs.readFileSync(path.join(DUMP, '0x' + hash + '.cso')), helper);
        if (!r.blob) { report.skipped[r.reason] = (report.skipped[r.reason] || 0) + 1; continue; }
        fs.writeFileSync(path.join(outDir, '0x' + hash + '.shader'), r.blob);
        report.notes[hash] = r.note;
        const fam = r.note.replace(/ at .*/, ''); report.families[fam] = (report.families[fam] || 0) + 1;
        report.patched++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ targets: report.targets, patched: report.patched, families: report.families, skipped: report.skipped }));
}
