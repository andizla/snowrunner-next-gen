// The stand-in for a mesh mod in shared.pak (as RLM puts its own trucks' and rocks' meshes in with WinRAR): named
// meshes replaced by other bytes, each the original mesh with its last byte changed, stored. engine_test.ps1 uses it.
// usage: node test/mod_meshes.js pick <shared.pak.orig>   JSON: { set: [three meshes the nature set changes], other: a
//        mesh no set changes, nature: how many meshes the nature set with hide=plants changes }
//        node test/mod_meshes.js put <shared.pak> <shared.pak.orig> <name>...   the named meshes replaced in place; JSON:
//        { name: "crc/size" } as engine_test.ps1's Entries gives them
const fs = require('fs'), path = require('path'), zlib = require('zlib');
// NGEN_TOOLS: the engine's tools folder (engine_test.ps1 sets it; the working tree's by default)
const lod = require(path.join(process.env.NGEN_TOOLS || path.join(__dirname, '..', 'engine', 'tools'), 'lod_patch.js'));
const [cmd, pak, orig, ...names] = process.argv.slice(2);
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
if (cmd === 'pick')
{
    const p = lod.plan(pak, 'nature', { hide: 'plants', shadows: 'off' }), set = [];
    for (const [ent, job] of p.jobs) if (job.raised && set.length < 3) set.push(ent.name);
    const fd = fs.openSync(pak, 'r');
    let other = null;
    // a truck's or a building's mesh: a model the nature set leaves alone (hide=plants takes only plants)
    const changed = new Set([...p.jobs.keys()].map((e) => e.name));
    try { other = lod.readZip(fd).entries.find((e) => /[\\/]models_/.test(e.name) && !lod.classify(e.name, 'nature') && !changed.has(e.name) && e.flags === 0).name; }
    finally { fs.closeSync(fd); }
    console.log(JSON.stringify({ set, other, nature: p.jobs.size }));
}
else if (cmd === 'put')
{
    const fo = fs.openSync(orig, 'r'), fd = fs.openSync(pak, 'r'), jobs = new Map(), out = {};
    let z, grow = 0;
    try
    {
        const zo = lod.readZip(fo), byName = new Map(zo.entries.map((e) => [e.name, e]));
        z = lod.readZip(fd);
        for (const ent of z.entries)
        {
            if (!names.includes(ent.name)) continue;
            const data = Buffer.from(lod.readEntry(fo, byName.get(ent.name)).data);
            data[data.length - 1] ^= 0xff;
            const head = lod.readEntry(fd, ent).head, crc = zlib.crc32(data);
            jobs.set(ent, { head, crc, usize: data.length, length: data.length, comp: data, method: 0 });
            grow += data.length - ent.csize;
            out[ent.name] = hex(crc) + '/' + data.length;
        }
    }
    finally { fs.closeSync(fo); fs.closeSync(fd); }
    if (jobs.size !== names.length) throw new Error('not every name is in ' + pak);
    const end = z.cdOff + grow + z.cd.length + z.eocd.length, tmp = pak + '.mod';
    lod.writePak(pak, tmp, { z, jobs, size: z.size % 4096 === 0 ? Math.ceil(end / 4096) * 4096 : end });
    fs.renameSync(tmp, pak);
    console.log(JSON.stringify(out));
}
else { console.error('usage: node mod_meshes.js pick <orig> | put <pak> <orig> <name>...'); process.exitCode = 1; }
