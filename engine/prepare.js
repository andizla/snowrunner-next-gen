// SPDX-License-Identifier: GPL-3.0-only
// SnowRunner Next Gen: builds, on the player's machine and from the player's own shader.pak, what the shader tools read
// besides their own code. Nothing of the game ships with the installer: its shaders (the tools' dump\ folder and its
// index.json) and the shader sets patched from them are made here, in the game's state folder, from the original
// shader.pak the engine keeps there:
//   <state>\dump\     every shader of the pak's main cache and small caches, named by CRC32, and index.json (extract.js)
//   <state>\sets\     the prebuilt sets the bundle's modules take whole: the shadow filter, the sky ambient on it, the
//                     fog and the bloom knee, each only when the selection needs it
//   <state>\prepared.json   { orig, tools, sets, date }: remade when the original pak, the tools or this file change
// usage (from ngen.js): node prepare.js --state <folder> --tools <folder> --modules <comma list>
// The shader tools read these folders through SR_DUMP_DIR and SR_SETS_DIR.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const state = opt('state'), tools = opt('tools'), modules = (opt('modules') || '').split(',').filter(Boolean);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const fail = (text) => { emit({ type: 'error', code: 'failed', text }); process.exit(1); };
if (!state || !tools) fail('usage: node prepare.js --state <folder> --tools <folder> --modules <list>');

const orig = path.join(state, 'shader.pak.orig'), dump = path.join(state, 'dump'), sets = path.join(state, 'sets');
if (!fs.existsSync(orig)) fail('the original shader.pak is not kept yet: ' + orig);

function sha256File(file)
{
    const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(16 << 20);
    try { for (let k; (k = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, k)); } finally { fs.closeSync(fd); }
    return h.digest('hex');
}
// the tools' code and helpers, and this file: a change in any of them remakes the dump and the sets (a new installer
// version over an old install)
function toolsFingerprint()
{
    const h = crypto.createHash('sha256');
    h.update('prepare.js\0');
    h.update(fs.readFileSync(__filename));
    const walk = (dir, rel) =>
    {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)))
        {
            const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(p, r);
            else { h.update(r + '\0'); h.update(fs.readFileSync(p)); }
        }
    };
    walk(tools, 'tools');
    const repl = path.join(tools, '..', 'replacements');
    if (fs.existsSync(repl)) walk(repl, 'replacements');
    return h.digest('hex');
}

// the sets a selection takes whole (fidelity_bundle.js plan(): shadow filter, sky ambient on it, fog, bloom)
function setsFor(mods)
{
    const crisp = mods.includes('crisp'), blocker = mods.includes('blocker'), revec = mods.includes('revec'), seam = mods.includes('seam');
    const shadow = revec ? (blocker ? 'hq_revec_blocker' : 'hq_revec') + (seam ? '_seam' : '')
        : crisp && blocker ? 'hq_crisp_blocker' : crisp ? 'hq_grid_crisp' : blocker ? 'hq_blocker' : null;
    const need = [];
    if (shadow) need.push('shadow_filter/' + shadow);
    if (mods.includes('ambient')) need.push('ambient/' + (shadow ? 'sky_on_' + shadow : 'sky'));
    if (mods.includes('fog')) need.push('fog_builds/jitter_phase', 'fog_builds/jitter_phase_sun');
    if (mods.includes('bloom')) need.push('bloom_builds/softknee');
    if (mods.includes('tonemap')) need.push('tonemap_builds/fidelity');
    return need;
}
// the game's own shader each module's set is made from (or, for the tonemap, the one the shipped build replaces): when
// a game update changed it, the module is reported unavailable instead of failing the whole install
const SOURCE = { fog: '871EF8CC', bloom: '52879E18', tonemap: '221304E2' };
const MODULE_OF = { 'fog_builds/jitter_phase': 'fog', 'fog_builds/jitter_phase_sun': 'fog', 'bloom_builds/softknee': 'bloom', 'tonemap_builds/fidelity': 'tonemap' };

const env = Object.assign({}, process.env, { SR_DUMP_DIR: dump, SR_SETS_DIR: sets });
function run(tool, toolArgs, what)
{
    emit({ type: 'log', text: what });
    const r = spawnSync(process.execPath, [path.join(tools, tool)].concat(toolArgs), { env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
    if (r.status !== 0)
    {
        const lines = (r.stderr + '\n' + r.stdout).split(/\r?\n/).filter((l) => l.trim());
        fail(tool + ' failed: ' + (lines.find((l) => /^\s*(Error|error): /.test(l)) || lines[lines.length - 1] || 'exit code ' + r.status));
    }
}

const stampFile = path.join(state, 'prepared.json');
const before = fs.existsSync(stampFile) ? JSON.parse(fs.readFileSync(stampFile, 'utf8')) : {};
const now = { orig: sha256File(orig), tools: toolsFingerprint() };
const fresh = before.orig === now.orig && before.tools === now.tools;
const have = new Set(fresh ? before.sets || [] : []);
const need = setsFor(modules);

// 1. the dump: every shader of the original pak's caches, as the tools' dump\ holds them
if (!fresh || !fs.existsSync(path.join(dump, 'index.json')))
{
    emit({ type: 'step', text: 'Reading the game\'s own shaders (first time only, about a minute)' });
    fs.rmSync(dump, { recursive: true, force: true });
    fs.rmSync(sets, { recursive: true, force: true });
    have.clear();
    const pak = require(path.join(tools, 'pak_shader_patch.js')), side = require(path.join(tools, 'sdc_side.js'));
    const buf = fs.readFileSync(orig), z = pak.parseZip(buf);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngen-caches-'));
    try
    {
        // the inputs as the tools' own dump was made: each small cache's streams inflated whole (the entries between
        // the shaders carry the names index.json keeps as tags), in pak order, then the main cache
        const inputs = [];
        for (const e of z.entries.filter((x) => /common_pc_sm50_[a-z_]+\.sdc$/.test(x.name)))
        {
            const streams = side.parseSide(pak.readEntry(buf, e)).streams;
            const file = path.join(tmp, path.basename(e.name).replace(/\.sdc$/, '.bin'));
            fs.writeFileSync(file, Buffer.concat(streams.flatMap((s) => s.entries)));
            inputs.push(file);
        }
        const main = z.entries.find((e) => e.name.endsWith(pak.ENTRY_TAIL));
        if (!main) fail('shader.pak has no main shader cache');
        const mainFile = path.join(tmp, 'shadercachedx11.bin');
        fs.writeFileSync(mainFile, pak.readSdc(pak.readEntry(buf, main)).inflated);
        inputs.push(mainFile);
        run('extract.js', [dump].concat(inputs), 'extracted the shaders of ' + inputs.length + ' caches');
    }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 2. the sets this selection needs that are not made yet (each builder writes into its own folder)
const build = {
    'shadow_filter/hq_crisp_blocker': () => run('shadow_filter_patch.js', ['hq_crisp_blocker', path.join(sets, 'shadow_filter', 'hq_crisp_blocker')], 'shadow filter: crisp edges and the blocker search'),
    'shadow_filter/hq_grid_crisp': () => run('shadow_filter_patch.js', ['hq_grid_crisp', path.join(sets, 'shadow_filter', 'hq_grid_crisp')], 'shadow filter: crisp edges'),
    'shadow_filter/hq_revec_blocker': () => run('shadow_filter_patch.js', ['hq_revec_blocker', path.join(sets, 'shadow_filter', 'hq_revec_blocker')], 'shadow filter: rebuilt edges and the blocker search'),
    'shadow_filter/hq_revec': () => run('shadow_filter_patch.js', ['hq_revec', path.join(sets, 'shadow_filter', 'hq_revec')], 'shadow filter: rebuilt edges'),
    'shadow_filter/hq_revec_blocker_seam': () => run('shadow_filter_patch.js', ['hq_revec_blocker_seam', path.join(sets, 'shadow_filter', 'hq_revec_blocker_seam')], 'shadow filter: rebuilt edges, the blocker search and the cascade seam dither'),
    'shadow_filter/hq_revec_seam': () => run('shadow_filter_patch.js', ['hq_revec_seam', path.join(sets, 'shadow_filter', 'hq_revec_seam')], 'shadow filter: rebuilt edges and the cascade seam dither'),
    'shadow_filter/hq_blocker': () => run('shadow_filter_patch.js', ['hq_blocker', path.join(sets, 'shadow_filter', 'hq_blocker')], 'shadow filter: the blocker search'),
    'ambient/sky': () => run('patch_ambient.js', ['-', path.join(sets, 'ambient', 'sky')], 'sky ambient'),
    'fog_builds/jitter_phase': () => run('patch_fog.js', ['0.3', '0.4', path.join(sets, 'fog_builds', 'jitter_phase')], 'fog: jitter and forward scattering'),
    'fog_builds/jitter_phase_sun': () => run('patch_fog_sun.js', ['sun', path.join(sets, 'fog_builds', 'jitter_phase'), path.join(sets, 'fog_builds', 'jitter_phase_sun')], 'fog: the sun\'s light through it'),
    'bloom_builds/softknee': () => run('patch_bloom_knee.js', ['3', path.join(sets, 'bloom_builds', 'softknee')], 'bloom: the soft knee'),
    // the tonemap ships built (it is compiled from our shader, not patched from the game's): copied into the sets
    'tonemap_builds/fidelity': () =>
    {
        const src = path.join(tools, '..', 'replacements', 'tonemap_builds', 'fidelity', '0x221304E2.shader');
        const dst = path.join(sets, 'tonemap_builds', 'fidelity');
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(src, path.join(dst, '0x221304E2.shader'));
        emit({ type: 'log', text: 'tonemap: the filmic curve build' });
    },
};
// modules whose game shader this pak does not have (a game update): left out, with the reason
const unavailable = new Set();
for (const [mod, crc] of Object.entries(SOURCE))
    if (modules.includes(mod) && !fs.existsSync(path.join(dump, '0x' + crc + '.cso')))
    {
        unavailable.add(mod);
        emit({ type: 'unavailable', module: mod, text: 'The ' + mod + ' module was not applied: this game version no longer has the shader it was made for (0x' + crc + ').' });
    }
for (let i = need.length - 1; i >= 0; i--) if (unavailable.has(MODULE_OF[need[i]])) need.splice(i, 1);
for (const shadow of ['hq_crisp_blocker', 'hq_grid_crisp', 'hq_blocker', 'hq_revec_blocker', 'hq_revec', 'hq_revec_blocker_seam', 'hq_revec_seam'])
    build['ambient/sky_on_' + shadow] = () => run('patch_ambient.js', [path.join(sets, 'shadow_filter', shadow), path.join(sets, 'ambient', 'sky_on_' + shadow)], 'sky ambient on the shadow filter');
const todo = need.filter((n) => !have.has(n));
if (todo.length) emit({ type: 'step', text: 'Preparing ' + todo.length + ' shader set' + (todo.length > 1 ? 's' : '') + ' from the game\'s own shaders' });
for (const n of todo)
{
    if (!build[n]) fail('no builder for the set ' + n);
    build[n]();
    have.add(n);
}
fs.writeFileSync(stampFile, JSON.stringify(Object.assign({}, now, { sets: [...have].sort(), date: new Date().toISOString() }), null, 2));
emit({ type: 'done', text: 'prepared: ' + (need.length ? need.join(', ') : 'nothing needed') });
