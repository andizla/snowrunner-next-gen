// Contact shadows (module contact; SnowRunner Shadows hid.dll Contact=1): every shader with the sun shadow
// map's high quality path writes the sun's visibility it found (the shadow map's lit fraction after the game's floor,
// "max S, S, cb2[3].w" = g_fShadowAtten, the end of the shadow block) into render-target slot 6, as o6.x. hid.dll binds
// an R8 target there during the lit pass (cleared to 0: no sun) and, after the lit pass, darkens each pixel's sunlight
// by its screen-space contact shadow (Bend Studio's screen-space shadows, the DLL's src\sss): the share of a
// pixel's light that is sunlight comes from this visibility, the shading normal (render target 7) and the game's sun
// and sky constants. Without that target bound the write is discarded by D3D and the shader draws as before.
// The write sits right after the endif that closes the shadow block's branch (outside the shadow range the game sets S
// to 1 in the else). A shader is left as it is unless: exactly one "max S, S, cb2[3].w" with S a temp's single
// component; its branch closes later at the same nesting; no output 6 yet. Adds "dcl_output o6.x" after the last
// output declaration and an SV_Target6 element (mask x) to the output signature, in front of any target with a higher
// register and of the system values (fxc's order; the runtime refuses a signature with a target after them, see
// patch_gbuffer.js).
// Library: patchContact(blob) -> { blob, note } or { reason }.
// usage: node patch_contact.js <in.shader|cso> [out]    one shader (the note, or the reason it is left as it is)
const fs = require('fs'), path = require('path');
const { walk, operands, chunks } = require('./dxbc_shex.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const OP = { max: 52, mov: 54, if: 31, else: 18, endif: 21, loop: 48, endloop: 22, switch: 76, endswitch: 23, dcl_output: 101 };
const SLOT = 6;
const words = (...w) => { const b = Buffer.alloc(w.length * 4); w.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4)); return b; };
const inst = (op, ...ops) => { const n = ops.reduce((s, o) => s + o.length, 0) / 4; return Buffer.concat([words(op | ((1 + n) << 24)), ...ops]); };
const outDest = (reg, mask) => words(0x00102002 | (mask << 4), reg);    // oN.mask
const tempSel = (reg, c) => words(0x0010000a | (c << 4), reg);          // rN.c (select one component)
const isCb = (o, slot, reg) => o && o.type === 8 && o.idx[0] === slot && o.idx[1] === reg;

// bytes inserted at a byte offset inside the container (as patch_gbuffer.js): the chunk that holds the offset grows,
// every chunk that starts after it moves, the total size follows (the checksum is redone by the caller)
function insertBytes(b, at, bytes)
{
    const out = Buffer.concat([b.subarray(0, at), bytes, b.subarray(at)]);
    out.writeUInt32LE(out.length, 24);
    const n = b.readUInt32LE(28);
    for (let i = 0; i < n; i++)
    {
        const off = b.readUInt32LE(32 + i * 4), size = b.readUInt32LE(off + 4);
        if (off + 8 <= at && at <= off + 8 + size) out.writeUInt32LE(size + bytes.length, off + 4);
        else if (off >= at) out.writeUInt32LE(off + bytes.length, 32 + i * 4);
    }
    return out;
}

// the output signature gains SV_Target<slot> with the mask given: a copy of element 0 with its index, register and mask
// changed, in front of the first element with a higher register (system values have 0xffffffff); every element's name
// offset moves by one element (the strings follow the element array)
function addOutputElement(b, slot, mask)
{
    const ch = chunks(b), sig = ch.OSGN || ch.OSG5;
    if (!sig) return null;
    const stride = ch.OSG5 ? 32 : 24, skip = ch.OSG5 ? 4 : 0, d = sig.data;
    const count = b.readUInt32LE(d), first = d + b.readUInt32LE(d + 4);
    const el = Buffer.from(b.subarray(first, first + stride));
    el.writeUInt32LE(slot, skip + 4);   // semantic index
    el.writeUInt32LE(slot, skip + 16);  // register
    el[skip + 20] = mask;               // components
    el[skip + 21] = ~mask & 0x0f;       // never-written components: the rest (as fxc writes SV_Target2's .x)
    let at = count;
    for (let i = 0; i < count; i++) if (b.readUInt32LE(first + i * stride + skip + 16) > slot) { at = i; break; }
    const out = insertBytes(b, first + at * stride, el);
    out.writeUInt32LE(count + 1, d);
    for (let i = 0; i <= count; i++) { const e = d + out.readUInt32LE(d + 4) + i * stride + skip; out.writeUInt32LE(out.readUInt32LE(e) + stride, e); }
    return out;
}

function patchContact(b)
{
    const w = walk(b);
    const L = w.insts.map((x, i) => ({ x, i, o: operands(b, x) }));
    let lastDclOut = null;
    const maxes = [];
    for (const e of L)
    {
        const { x, o } = e;
        if (x.op === OP.dcl_output && o[0] && o[0].type === 2) { lastDclOut = e; if (o[0].idx[0] === SLOT) return { reason: 'output 6 in use' }; }
        if (x.op === OP.max && o.length === 3 && o[0].type === 0 && o[1].type === 0 && o[0].idx[0] === o[1].idx[0] && isCb(o[2], 2, 3)) maxes.push(e);
    }
    if (maxes.length !== 1) return { reason: 'shadow floors (max S, S, cb2[3].w): ' + maxes.length };
    if (!lastDclOut) return { reason: 'no output declaration' };
    const m = maxes[0], dst = m.o[0];
    // the destination's one component: mask mode with a single bit
    const mask = dst.sel & 0xf;
    if (dst.mode !== 0 || [1, 2, 4, 8].indexOf(mask) < 0) return { reason: 'the floor writes more than one component' };
    const c = [1, 2, 4, 8].indexOf(mask);
    // the endif that closes the branch the floor sits in (an else on the way is the same branch)
    let depth = 0, close = null;
    for (let k = m.i + 1; k < L.length; k++)
    {
        const op = L[k].x.op;
        if (op === OP.if || op === OP.loop || op === OP.switch) depth++;
        else if (op === OP.endif || op === OP.endloop || op === OP.endswitch)
        {
            if (depth === 0) { if (op === OP.endif) close = L[k]; break; }
            depth--;
        }
    }
    if (!close) return { reason: 'the floor is not inside an if that closes later' };
    const at = close.x.off + close.x.len * 4;
    let out = insertBytes(b, at, inst(OP.mov, outDest(SLOT, 1), tempSel(dst.idx[0], c)));
    // dcl_output o6.x after the last output declaration (in front of the code, so the write above is placed first)
    const after = lastDclOut.x.off + lastDclOut.x.len * 4;
    out = insertBytes(out, after, inst(OP.dcl_output, outDest(SLOT, 1)));
    const ch = chunks(out), shex = ch.SHEX || ch.SHDR;
    out.writeUInt32LE(out.readUInt32LE(shex.data + 4) + 5 + 3, shex.data + 4);      // the code's token count: mov 5, dcl 3
    if (ch.STAT) out.writeUInt32LE(out.readUInt32LE(ch.STAT.data) + 1, ch.STAT.data); // instruction count
    const withSig = addOutputElement(out, SLOT, 0x1);
    if (!withSig) return { reason: 'no output signature chunk' };
    out = withSig;
    dxbcChecksum(out.subarray(20)).copy(out, 4);
    return { blob: out, note: 'floor at ' + m.i + ' (r' + dst.idx[0] + '.' + 'xyzw'[c] + '), o6.x after the endif at ' + close.i };
}

module.exports = { patchContact };

if (require.main === module)
{
    const [inp, outp] = process.argv.slice(2);
    if (!inp) { console.log('usage: node patch_contact.js <in> [out]'); process.exit(2); }
    const r = patchContact(fs.readFileSync(inp));
    if (!r.blob) { console.log('left as it is: ' + r.reason); process.exit(1); }
    if (outp) fs.writeFileSync(outp, r.blob);
    console.log(r.note);
}
