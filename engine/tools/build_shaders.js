// Compiles Next Gen's own shaders (replacements\**\*.hlsl) into the blobs the tools splice into the game's shaders or
// install whole, with fxc from the Windows SDK, and checks every blob against the list of tested builds
// (replacements\shaders.sha256). fxc writes the same bytes for the same source, defines and flags, so a blob that
// differs means another source, another setting or another compiler version.
// usage: node build_shaders.js [build]   compile every blob into replacements\, then check them
//        node build_shaders.js check     compile to a temporary folder and compare with the list and with the blobs on
//                                        disk; writes nothing into replacements\
//        node build_shaders.js pin       compile, then write the list from the result (after a tested change)
//        FXC points at another fxc.exe; without it the newest Windows SDK under Program Files (x86)\Windows Kits\10
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const R = path.join(__dirname, '..', 'replacements');
const PINS = path.join(R, 'shaders.sha256');
// the GTAO pass with bounce light as shipped: three directions, drawn at half size, depth taps from the DLL's depth
// mips, the visibility bitmask, the bounce light from the scene feed's mips with one read per horizon
const GI = ['AO_SLICES=3', 'AO_HALF_SNAP=1', 'AO_DEPTH_LOD=2', 'AO_VB=1', 'GI_LOD=1', 'GI_GATHER_TOP=1'];
const FAR = ['AO_FAR=1', 'AO_FAR_SHARE=1'];
// the reflection reader marches only what the pass never saw, and of that only what lies in front
const READER = ['OSSSR_MARCH_UNSEEN_ONLY=1', 'OSSSR_MARCH_FRONT_ONLY=1'];
const O3 = ['-O3'];
// [blob, source, defines, fxc flags]; every one is a ps_5_0 shader with the entry point main
const BUILDS = [
    ['ambient/sky_ambient.cso', 'ambient/sky_ambient.hlsl', [], O3],
    ['fog/fog_sun.cso', 'fog/fog_sun.hlsl'],
    ['gi/gi_ambient.cso', 'gi/gi_ambient.hlsl'],
    ['gi/gi_ambient_decal.cso', 'gi/gi_ambient.hlsl', ['GI_DECAL=1']],
    ['gi/gi_only.cso', 'gi/gi_ambient.hlsl', ['STRENGTH=0']],
    ['gi/gi_only_decal.cso', 'gi/gi_ambient.hlsl', ['STRENGTH=0', 'GI_DECAL=1']],
    ['gi/gtao_gi.cso', 'gi/gtao_gi.hlsl', GI],
    ['gi/gtao_gi_far.cso', 'gi/gtao_gi.hlsl', [...FAR, ...GI]],
    ['puddles/puddle_ssr.cso', 'puddles/puddle_ssr.hlsl', ['PSSR_ADAPTIVE=1']],
    ['puddles/puddle_ssr_decal.cso', 'puddles/puddle_ssr.hlsl', ['PSSR_ADAPTIVE=1', 'PSSR_DECAL=1']],
    ['reflections/object_ssr.cso', 'reflections/object_ssr.hlsl'],
    ['shadow_filter/hq_blocker.cso', 'shadow_filter/hq_blocker.hlsl', [], O3],
    ['shadow_filter/hq_grid_crisp.cso', 'shadow_filter/hq_grid.hlsl', ['SPREAD=0.8'], O3],
    ['shadow_filter/hq_revec.cso', 'shadow_filter/hq_revec.hlsl', [], O3],
    ['shadow_filter/hq_seam.cso', 'shadow_filter/hq_seam.hlsl', [], O3],
    ['shadow_filter/hq_seam_own.cso', 'shadow_filter/hq_seam.hlsl', ['SEAM_OWN_DEPTH=1'], O3],
    ['smoke/smoke_glow.cso', 'smoke/smoke_glow.hlsl'],
    ['smoke/smoke_shade.cso', 'smoke/smoke_shade.hlsl'],
    ['smoke/smoke_shade_off.cso', 'smoke/smoke_shade.hlsl', ['SMOKE_SHADE=0']],
    ['sssr/gbuffer.cso', 'sssr/gbuffer.hlsl'],
    ['sssr/object_sssr.cso', 'sssr/object_sssr.hlsl', READER],
    ['sssr/object_sssr_glow.cso', 'sssr/object_sssr.hlsl', [...READER, 'OSSSR_HEADGLOW_ON=1']],
    ['water/absorb.cso', 'water/absorb.hlsl'],
    ['water/blend.cso', 'water/blend.hlsl'],
    ['water/blend_glow.cso', 'water/blend.hlsl', ['MIX_GLOW=1']],
    ['water/ssr.cso', 'water/ssr.hlsl'],
    ['water/ssr_t5.cso', 'water/ssr.hlsl', ['SSR_BB_REG=t5']],
    ['water/ssr_planar.cso', 'water/ssr_planar.hlsl', ['SSR_HIZ=1']],
    // whole passes, named by the hash of the game shader they replace
    ['ssao_builds/gtao_hq/0xEA2414F8.shader', 'ssao_0xEA2414F8.hlsl', ['AO_SLICES=4', 'AO_STEPS=8']],
    ['ssao_builds/gtao_hq_far/0xEA2414F8.shader', 'ssao_0xEA2414F8.hlsl', ['AO_SLICES=4', 'AO_STEPS=8', ...FAR]],
    ['tonemap_builds/fidelity/0x221304E2.shader', 'tonemap_0x221304E2.hlsl', ['CURVE=3', 'BLOOM_SCALE=0.6']],
];

function findFxc()
{
    if (process.env.FXC) return process.env.FXC;
    const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Windows Kits', '10', 'bin');
    const versions = fs.existsSync(kits) ? fs.readdirSync(kits).filter((v) => /^10\./.test(v)).sort().reverse() : [];
    for (const v of versions)
    {
        const exe = path.join(kits, v, 'x64', 'fxc.exe');
        if (fs.existsSync(exe)) return exe;
    }
    throw new Error('fxc.exe not found: install the Windows SDK, or set FXC to its path');
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// the list: one "<sha256>  <blob>" line per tested build
function readPins()
{
    const pins = new Map();
    if (!fs.existsSync(PINS)) return pins;
    for (const line of fs.readFileSync(PINS, 'utf8').split(/\r?\n/))
    {
        const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
        if (m) pins.set(m[2], m[1]);
    }
    return pins;
}

function main()
{
    const mode = process.argv[2] || 'build';
    if (!['build', 'check', 'pin'].includes(mode)) throw new Error('usage: node build_shaders.js [build | check | pin]');
    const fxc = findFxc();
    const outRoot = mode === 'check' ? fs.mkdtempSync(path.join(os.tmpdir(), 'ngen_shaders_')) : R;
    const pins = readPins(), built = [];
    let wrong = 0;
    for (const [blob, src, defines = [], flags = []] of BUILDS)
    {
        const out = path.join(outRoot, blob);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const args = ['-nologo', '-T', 'ps_5_0', '-E', 'main', ...flags, '-Fo', out];
        for (const d of defines) args.push('-D', d);
        args.push(path.join(R, src));
        try { execFileSync(fxc, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { throw new Error(src + ' does not compile:\n' + String(e.stderr || e.message)); }
        const hash = sha256(out);
        built.push([blob, hash]);
        if (mode === 'pin') continue;
        const notes = [];
        if (pins.get(blob) !== hash) notes.push(pins.has(blob) ? 'differs from the tested build ' + pins.get(blob).slice(0, 8) : 'not in the list');
        if (mode === 'check')
        {
            const disk = path.join(R, blob);
            if (!fs.existsSync(disk)) notes.push('not built in replacements');
            else if (sha256(disk) !== hash) notes.push('the blob in replacements is another build');
        }
        if (notes.length) wrong++;
        console.log((notes.length ? 'DIFFERENT ' : 'ok        ') + hash.slice(0, 8) + '  ' + blob + (notes.length ? '  (' + notes.join('; ') + ')' : ''));
    }
    if (mode === 'check') fs.rmSync(outRoot, { recursive: true, force: true });
    if (mode === 'pin')
    {
        fs.writeFileSync(PINS, built.map(([blob, hash]) => hash + '  ' + blob).join('\n') + '\n');
        console.log('wrote ' + PINS + ': ' + built.length + ' blobs');
        return;
    }
    console.log(built.length + ' blobs, ' + (wrong ? wrong + ' different' : 'all as tested') + ' (' + fxc + ')');
    if (wrong) process.exitCode = 1;
}

if (require.main === module)
{
    try { main(); }
    catch (e) { console.error(String(e.message || e)); process.exitCode = 1; }
}
module.exports = { BUILDS };
