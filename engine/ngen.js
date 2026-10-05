// SPDX-License-Identifier: GPL-3.0-only
// SnowRunner Next Gen's engine: reads what is installed in a game folder, installs a selection of modules, and puts
// the game's own files back. The window runs it and reads one JSON object per line from it:
//   {"type":"step","text":...}    a stage begins          {"type":"log","text":...}   a line from one of the tools
//   {"type":"warn","text":...}    something left alone    {"type":"status",...}       the answer to status
//   {"type":"done","text":...,"warnings":n}   finished; n warn lines came before it, and the text says so
//   {"type":"error","code":...,"text":...,"touched":bool}   stopped; touched = files were written before the stop
//   error codes: usage, missing (no game there), running (close the game), busy (another Apply or Restore runs on this
//   game), adopt-files (files another mod or a game update changed, named in "files": run again with --adopt to take
//   them as they are now as the originals, or with --leave to leave them and their parts out), orphaned (the paks
//   named in "files" hold Next Gen's changes while their kept originals are gone: see the note in the game folder),
//   failed
// The work is done by the project's own tools (engine\tools: fidelity_bundle.js builds shader.pak, pak_shader_patch.js
// puts it back, lod_patch.js does shared.pak and the grass, the fill light and the stars in initial.pak, lut_grade.js
// the colour LUTs, the particle textures and the night sky in boot.pak, gfx_logos.js the logos in gfx.pak); SnowRunner
// Shadows (hid.dll and its ini in Sources\Bin) is copied in and out here. Every file is built from the game's
// original, kept in a state folder outside the game (one per game folder).
// usage: node ngen.js status  --game <folder>
//        node ngen.js apply   --game <folder> --selection <file.json> [--adopt | --leave]
//        node ngen.js restore --game <folder> [--adopt | --leave]
// selection: { "shader": [fidelity_bundle.js module names], "shadows": null | { "factor": "1", "slopeBias": "1", "aoHalf": "1" },
//              "scenery": null | "nature" | "all", "grass": null | "3" | "2", "fill": null | "0.7" | "0.55" | "0.85",
//              "grade": null | "1" | "0.5", "particles": null | "1", "sky": null | "1", "stars": null | "3" | "2",
//              "weather": null | "shadows,showers" (a comma list of shadows, showers, evening, horizon, far, fireflies, pollen),
//              "logos": null | "1" }
// config.json next to this file: { "tools": <folder>, "dll": <hid.dll to install> }. A dev build may add "devGame" and
//   "devState" (that game folder's state lives in devState) and "dump" and "sets" (folders that already hold the game's
//   shaders and the sets made from them, so prepare.js is not run); NGEN_STATE_ROOT moves the state folders (tests)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// the game's own shader.pak of the versions this engine knows (sha256): the first install takes such a file as the
// original without asking
const KNOWN_SHADER = ['554f67ec40e5d807d7e06afce4c0268841bc949cbdcd85cedc7a9c20d92352c2'];   // 55,689,216 bytes, 2026-07
// the modules that read the scene's picture from SnowRunner Shadows
const NEED_DLL = ['gi', 'water', 'sssr', 'reflections', 'puddles', 'contact'];

const configFile = path.join(__dirname, 'config.json');
const config = Object.assign({ tools: path.join(__dirname, 'tools'), dll: path.join(__dirname, 'hid.dll') },
    fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {});
if (!path.isAbsolute(config.tools)) config.tools = path.join(__dirname, config.tools);
if (!path.isAbsolute(config.dll)) config.dll = path.join(__dirname, config.dll);
// the tools come without the game's shaders: prepare.js makes them per game in the state folder from the player's own
// shader.pak, and the shader tools read them there (SR_DUMP_DIR, SR_SETS_DIR). A dev config names folders that hold
// them already
const ownDump = config.dump && config.sets ? { SR_DUMP_DIR: config.dump, SR_SETS_DIR: config.sets } : null;
// the fingerprint of each part's code (the package build writes parts.json): a part whose code changed is rebuilt even
// when the selection is the same, so a new installer version updates an old install
const partsFile = path.join(__dirname, 'parts.json');
const PARTS = fs.existsSync(partsFile) ? JSON.parse(fs.readFileSync(partsFile, 'utf8')) : {};

class EngineError extends Error { constructor(code, text, extra) { super(text); this.code = code; this.extra = extra; } }

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const step = (text) => emit({ type: 'step', text });
let warned = 0;   // the warn lines so far: the done event carries the count, and its text says when there were any
const warn = (text) => { warned++; emit({ type: 'warn', text }); };
const stamp = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

function sha256File(file)
{
    const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(16 << 20);
    try { for (let k; (k = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, k)); } finally { fs.closeSync(fd); }
    return h.digest('hex');
}

// the game's files: the paks (preload\paks\client, or en_us\... in some store versions) and Sources\Bin when it
// holds SnowRunner.exe (SnowRunner Shadows needs it)
function gameFiles(game)
{
    const root = path.resolve(game);
    const paks = [path.join(root, 'preload', 'paks', 'client'), path.join(root, 'en_us', 'preload', 'paks', 'client')]
        .find((p) => fs.existsSync(path.join(p, 'shader.pak')));
    if (!paks) throw new EngineError('missing', 'No SnowRunner in ' + root + ': preload\\paks\\client\\shader.pak is missing.');
    const bin = path.join(root, 'Sources', 'Bin');
    return {
        root, paks, bin: fs.existsSync(path.join(bin, 'SnowRunner.exe')) ? bin : null,
        shader: path.join(paks, 'shader.pak'), shared: path.join(paks, 'shared.pak'), initial: path.join(paks, 'initial.pak'), boot: path.join(paks, 'boot.pak'),
        gfx: path.join(paks, 'gfx.pak'),
    };
}

// the state folder of a game: its originals and the tools' notes
function stateDir(game)
{
    const full = path.resolve(game);
    if (config.devGame && config.devState && full.toLowerCase() === path.resolve(config.devGame).toLowerCase()) return config.devState;
    const root = process.env.NGEN_STATE_ROOT || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'SnowRunnerNextGen');
    const dir = path.join(root, 'games', crypto.createHash('sha256').update(full.toLowerCase()).digest('hex').slice(0, 12));
    fs.mkdirSync(dir, { recursive: true });
    const label = path.join(dir, 'game.txt');
    if (!fs.existsSync(label)) fs.writeFileSync(label, full + '\r\n');
    return dir;
}

// every pak a tool may write is named here: a tool left to its own default would reach for the Steam install
const toolEnv = (g, state) => Object.assign({}, process.env,
    { SR_SHADER_PAK: g.shader, SR_SHARED_PAK: g.shared, SR_INITIAL_PAK: g.initial, SR_BOOT_PAK: g.boot, SR_GFX_PAK: g.gfx, SR_STATE_DIR: state, LOD_GRASS: 'leave' },
    ownDump || { SR_DUMP_DIR: path.join(state, 'dump'), SR_SETS_DIR: path.join(state, 'sets') });

// the notes of the last apply: { selection, parts, date }
function lastNotes(state)
{
    const f = path.join(state, 'nextgen.json');
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch (e) { return {}; }
}
// a note written whole: into a file next to it, then renamed over the old one, so a stop while writing leaves the old
function writeJson(file, o, ending = '\n')
{
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + ending);
    fs.renameSync(tmp, file);
}
// whether a part installed before was built by the code this installer carries (true when nothing is known: dev build)
const sameCode = (notes, part) => !PARTS[part] || ((notes.parts || {})[part] === PARTS[part]);

// prepare.js: the game's shaders and the sets patched from them, made in the state folder; its events (step, log) are
// passed on, an error stops the apply
function prepare(state, modules)
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(process.execPath, [path.join(__dirname, 'prepare.js'), '--state', state, '--tools', config.tools, '--modules', modules.join(',')], { windowsHide: true });
        let rest = '', failure = null;
        const gone = [];   // modules this game's shaders cannot take (a game update changed their shader)
        const line = (l) =>
        {
            if (!l.trim()) return;
            let e;
            try { e = JSON.parse(l); } catch (x) { emit({ type: 'log', text: l }); return; }
            if (e.type === 'error') failure = e.text;
            else if (e.type === 'unavailable') { gone.push(e.module); warn(e.text); }
            else if (e.type !== 'done') emit(e);
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { rest += chunk; for (let i; (i = rest.indexOf('\n')) >= 0;) { line(rest.slice(0, i).replace(/\r$/, '')); rest = rest.slice(i + 1); } });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { for (const l of chunk.split(/\r?\n/)) if (l.trim()) emit({ type: 'log', text: l }); });
        child.on('close', (code) => { if (rest) line(rest); code === 0 && !failure ? resolve(gone) : reject(new EngineError('failed', 'preparing the shaders failed: ' + (failure || 'exit code ' + code))); });
        child.on('error', (e) => reject(new EngineError('failed', 'preparing the shaders failed: ' + e.message)));
    });
}

// runs a tool; its lines go out as log lines when shown is set. { code, out: [lines], err: [lines] }
function runTool(tool, args, env, shown)
{
    return new Promise((resolve) =>
    {
        const child = spawn(process.execPath, [path.join(config.tools, tool)].concat(args), { env, windowsHide: true });
        const out = [], err = [];
        const read = (stream, sink) =>
        {
            let rest = '';
            stream.setEncoding('utf8');
            // a tool line that starts with "warning: " is a warning: the tools say so where a chosen part changed nothing
            const line = (l) => { sink.push(l); if (!shown || !l.trim()) return; const m = /^\s*warning: (.*)$/i.exec(l); if (m) warn(m[1]); else emit({ type: 'log', text: l }); };
            stream.on('data', (chunk) =>
            {
                rest += chunk;
                for (let i; (i = rest.indexOf('\n')) >= 0;) { line(rest.slice(0, i).replace(/\r$/, '')); rest = rest.slice(i + 1); }
            });
            stream.on('end', () => { if (rest) line(rest.replace(/\r$/, '')); });
        };
        read(child.stdout, out);
        read(child.stderr, err);
        child.on('close', (code) => resolve({ code, out, err }));
        child.on('error', (e) => resolve({ code: -1, out, err: [e.message] }));
    });
}

// the reason a tool gave: its "Error: ..." or "error: ..." line (a TypeError's or a RangeError's counts the same), else
// its last line
function reason(r)
{
    const lines = r.err.concat(r.out).filter((l) => l.trim());
    const e = lines.find((l) => /^\s*(\w*Error|error): /.test(l));
    return (e || lines[lines.length - 1] || 'exit code ' + r.code).replace(/^\s*(\w*Error|error): /, '');
}

async function must(tool, args, env)
{
    const r = await runTool(tool, args, env, true);
    if (r.code !== 0) throw new EngineError('failed', tool + ' ' + args[0] + ' failed: ' + reason(r));
    return r;
}

async function answer(tool, args, env)
{
    const r = await runTool(tool, args, env, false);
    if (r.code !== 0) throw new EngineError('failed', tool + ' ' + args[0] + ' failed: ' + reason(r));
    const lines = r.out.filter((l) => l.trim());
    return (lines[lines.length - 1] || '').trim();
}

// whether the game of this folder runs (another install of it running does not count). A SnowRunner.exe whose path
// cannot be read (one started with higher rights) counts as running, and so does a failure of both probes: the engine
// then refuses to write rather than stop at the first locked file with earlier steps done. Paths are compared
// resolved, so a junction or a subst drive spells the same install
function gameRunning(g)
{
    const real = (p) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch (e) { return path.resolve(p).toLowerCase(); } };
    const ours = real(path.join(g.root, 'Sources', 'Bin', 'SnowRunner.exe'));
    try
    {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-Process SnowRunner -ErrorAction SilentlyContinue | ForEach-Object { "" + $_.Id + "|" + $_.Path }'], { encoding: 'utf8', windowsHide: true });
        return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).some((l) => { const p = l.slice(l.indexOf('|') + 1).trim(); return !p || real(p) === ours; });
    }
    catch (e)
    {
        try { return /SnowRunner\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq SnowRunner.exe', '/NH'], { encoding: 'utf8', windowsHide: true })); }
        catch (e2) { return true; }
    }
}

// ---- SnowRunner Shadows: hid.dll in Sources\Bin (another mod's hid.dll is kept as hid_chain.dll, which ours loads)

const isOurs = (data) => data.indexOf('SnowRunner Shadows', 0, 'latin1') >= 0;

function readIni(file)
{
    const values = {};
    if (fs.existsSync(file))
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^\s*([^=;\[\s]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) values[m[1]] = m[2]; }
    return values;
}

// sets these keys in the ini's [Shadows] section and keeps every other line as it is
function writeIni(file, set)
{
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    let section = lines.findIndex((l) => /^\s*\[Shadows\]\s*$/i.test(l));
    if (section < 0) { lines.unshift('[Shadows]'); section = 0; }
    for (const [key, value] of Object.entries(set))
    {
        const at = lines.findIndex((l, i) => i > section && new RegExp('^\\s*' + key + '\\s*=', 'i').test(l));
        if (at >= 0) lines[at] = key + '=' + value; else lines.splice(section + 1, 0, key + '=' + value);
    }
    fs.writeFileSync(file, lines.join('\r\n') + '\r\n');
}

function dllStatus(g)
{
    if (!g.bin) return { state: 'nobin' };
    const file = path.join(g.bin, 'hid.dll');
    if (!fs.existsSync(file)) return { state: 'none' };
    const data = fs.readFileSync(file);
    if (!isOurs(data)) return { state: 'foreign' };
    const ini = readIni(path.join(g.bin, 'SnowRunnerShadows.ini'));
    const current = fs.existsSync(config.dll) && crypto.createHash('sha256').update(data).digest('hex') === sha256File(config.dll);
    // the DLL's own fallbacks: the shadow texture at 2x, the ambient occlusion pass at half size
    return { state: 'ours', current, factor: ini.Factor || '2', slopeBias: ini.SlopeBias || '1', aoHalf: ini.AOHalf || '1' };
}

function installDll(g, want)
{
    if (!g.bin) { warn('No Sources\\Bin with SnowRunner.exe in this game folder: SnowRunner Shadows was left out.'); return; }
    if (!fs.existsSync(config.dll)) throw new EngineError('failed', 'SnowRunner Shadows (hid.dll) is missing from the installer: ' + config.dll);
    const target = path.join(g.bin, 'hid.dll'), chain = path.join(g.bin, 'hid_chain.dll');
    const source = fs.readFileSync(config.dll);
    for (const old of ['ShadowScale.addon64', 'ShadowScale.ini'])   // the older ReShade add-on would scale a second time
    {
        const f = path.join(g.bin, old);
        if (fs.existsSync(f)) { fs.unlinkSync(f); emit({ type: 'log', text: 'removed ' + old + ' (the older add-on route)' }); }
    }
    if (fs.existsSync(target) && !isOurs(fs.readFileSync(target)))
    {
        if (fs.existsSync(chain)) throw new EngineError('failed', 'Sources\\Bin has another mod\'s hid.dll and a hid_chain.dll already: SnowRunner Shadows cannot go in beside them.');
        fs.renameSync(target, chain);
        emit({ type: 'log', text: 'the other mod\'s hid.dll is kept as hid_chain.dll and still loaded' });
    }
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(source))
    {
        step('Installing SnowRunner Shadows (hid.dll)');
        const tmp = target + '.tmp';
        fs.writeFileSync(tmp, source);
        if (!fs.readFileSync(tmp).equals(source)) { fs.unlinkSync(tmp); throw new EngineError('failed', 'hid.dll did not read back as written'); }
        fs.renameSync(tmp, target);
    }
    const ini = path.join(g.bin, 'SnowRunnerShadows.ini'), before = readIni(ini);
    const set = { Factor: want.factor, SlopeBias: want.slopeBias, AOHalf: want.aoHalf };
    if (!('Trace' in before)) set.Trace = '0';
    if (!('KeyDump' in before)) set.KeyDump = '0';   // F7's dump (150 MB into the game folder per press) stays off: no key the help names
    if (before.Factor !== want.factor || before.SlopeBias !== want.slopeBias || before.AOHalf !== want.aoHalf || !fs.existsSync(ini))
    {
        writeIni(ini, set);
        emit({ type: 'log', text: 'SnowRunnerShadows.ini: shadow texture ' + want.factor + 'x, self-shadow fix ' + (want.slopeBias === '1' ? 'on' : 'off') + ', ambient occlusion at ' + (want.aoHalf === '0' ? 'full' : 'half') + ' size' });
    }
}

function removeDll(g)
{
    if (!g.bin) return;
    const target = path.join(g.bin, 'hid.dll'), chain = path.join(g.bin, 'hid_chain.dll');
    if (!fs.existsSync(target)) return;
    if (!isOurs(fs.readFileSync(target))) { warn('The hid.dll in Sources\\Bin belongs to another mod: left as it is.'); return; }
    step('Taking SnowRunner Shadows out');
    fs.unlinkSync(target);
    const ini = path.join(g.bin, 'SnowRunnerShadows.ini');
    if (fs.existsSync(ini)) fs.unlinkSync(ini);
    if (fs.existsSync(chain)) { fs.renameSync(chain, target); emit({ type: 'log', text: 'the other mod\'s hid.dll is back as hid.dll' }); }
}

// the stock twins table the bundle writes for SnowRunner Shadows' F8 switch (about 200 MB): only while shader.pak is ours
function removeStock(g)
{
    const f = g.bin && path.join(g.bin, 'SnowRunnerShadows.stock');
    if (f && fs.existsSync(f)) { fs.unlinkSync(f); emit({ type: 'log', text: 'removed SnowRunnerShadows.stock' }); }
}

// ---- status

async function readStatus(g, state)
{
    return Object.assign({ game: g.root, running: gameRunning(g) }, await readPaks(g, state), { dll: dllStatus(g), orphaned: orphaned(g, state), stateDir: state });
}
// what the paks hold, as the tools answer it
async function readPaks(g, state)
{
    const env = toolEnv(g, state);
    const said = await answer('fidelity_bundle.js', ['modules'], env);   // stock, a comma list, or unknown
    let shader;
    if (said === 'stock') shader = { state: 'stock', modules: [] };
    else if (said === 'unknown')
    {
        const known = KNOWN_SHADER.includes(sha256File(g.shader));
        shader = { state: known ? 'stock' : fs.existsSync(path.join(state, 'shader.pak.orig')) ? 'changed' : 'unknown', modules: [] };
    }
    else shader = { state: 'ours', modules: said.split(',').filter(Boolean) };
    const scenery = fs.existsSync(g.shared) ? await answer('lod_patch.js', ['status'], env) : 'missing';   // nature, all, vanilla, changed
    const { grass, fill, stars, weather, initialPak } = await readInitial(g, env), grade = await readGrade(g, env), particles = await readParticles(g, env);
    const sky = await readSky(g, env), logos = await readLogos(g, env);
    return { shader, scenery, grass, fill, stars, weather, initialPak, grade, particles, sky, logos };
}
// initial.pak: the grass, the fill light, the stars and the weather, four parts of one build, each { state, factor }
// (the weather: { state, parts }, a comma list); initialPak is the file's own state (ours also when it holds none of
// the four: the sky levels of the night sky's photo skies)
async function readInitial(g, env)
{
    const init = fs.existsSync(g.initial) ? JSON.parse(await answer('lod_patch.js', ['initial-status'], env)) : { state: 'missing' };
    const part = (v) => (init.state !== 'ours' ? { state: init.state } : v ? { state: 'ours', factor: String(v) } : { state: 'vanilla' });
    const weather = init.state !== 'ours' ? { state: init.state } : init.weather ? { state: 'ours', parts: String(init.weather) } : { state: 'vanilla' };
    return { grass: part(init.grass), fill: part(init.fill), stars: part(init.stars), weather, initialPak: init.state };   // ours (with factor), vanilla, changed, missing
}
// the weather's parts as a comma list in the tool's order, for one comparison
const WEATHER_PARTS = ['shadows', 'showers', 'evening', 'horizon', 'far', 'fireflies', 'pollen'];
const weatherList = (spec) => WEATHER_PARTS.filter((p) => String(spec || '').split(',').map((s) => s.trim()).includes(p)).join(',');
const WEATHER_WORDS = { shadows: 'cloud shadows', showers: 'showers that swell and ease', evening: 'evening drizzle', horizon: 'horizon clouds', far: 'rain and snow drawn farther', fireflies: 'fireflies', pollen: 'pollen' };
// the photo grade: the daytime colour LUTs in boot.pak ({ state, strength })
async function readGrade(g, env)
{
    const said = fs.existsSync(g.boot) ? await answer('lut_grade.js', ['status'], env) : 'missing';
    const gm = /^grade (.+)$/.exec(said);
    return gm ? { state: 'ours', strength: gm[1] } : { state: said };   // vanilla, changed, missing
}
// the particle sprites in boot.pak, beside the grade ({ state }): ours, vanilla, changed, missing
async function readParticles(g, env)
{
    const said = fs.existsSync(g.boot) ? await answer('lut_grade.js', ['particles-status'], env) : 'missing';
    return { state: said === 'particles' ? 'ours' : said === 'none' ? 'vanilla' : said };
}
// the night sky in boot.pak, the third part there ({ state }): ours, vanilla, changed, missing
async function readSky(g, env)
{
    const said = fs.existsSync(g.boot) ? await answer('lut_grade.js', ['sky-status'], env) : 'missing';
    return { state: said === 'sky' ? 'ours' : said === 'none' ? 'vanilla' : said };
}
// the Next Gen logos in gfx.pak ({ state }): ours, vanilla, changed, missing
async function readLogos(g, env)
{
    const said = fs.existsSync(g.gfx) ? await answer('gfx_logos.js', ['status'], env) : 'missing';
    return { state: said === 'logos' ? 'ours' : said };
}

// ---- the note in the game folder
// Next to the paks the engine leaves SnowRunnerNextGen.json: the paks that hold its changes now, each with the hash of
// its file directory. Their originals are kept in the state folder, outside the game. When that folder is lost (a new
// Windows install, a cleaned profile) while the game still has the changed paks, the tools would take them for
// originals and make every change a second time. The note tells the two apart: a pak it names, whose directory still
// has that hash and whose original is not in the state folder, is one of ours without its original. Apply and Restore
// stop on it before anything is written.
const NOTE_NAME = 'SnowRunnerNextGen.json';
const NOTE_ABOUT = 'SnowRunner Next Gen wrote this note. The files named here hold its changes, and their originals are kept in %LOCALAPPDATA%\\SnowRunnerNextGen. ' +
    'Should those originals ever be lost, the note tells the program that these are not the game\'s own files. Restore originals takes the note away.';
const pakFile = (g, name) => g[name.replace(/\.pak$/, '')];

// sha256 of a pak's file directory (the zip's central directory), which changes with any entry; null when the file is
// missing or has no directory
function dirHash(file)
{
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
    try
    {
        const size = fs.fstatSync(fd).size, n = Math.min(size, 65557), tail = Buffer.alloc(n);
        fs.readSync(fd, tail, 0, n, size - n);
        for (let i = n - 22; i >= 0; i--)   // the end record, behind which a pak may be padded
        {
            if (tail.readUInt32LE(i) !== 0x06054b50) continue;
            const cdSize = tail.readUInt32LE(i + 12), cdOffset = tail.readUInt32LE(i + 16);
            if (cdOffset + cdSize > size) continue;
            const cd = Buffer.alloc(cdSize);
            fs.readSync(fd, cd, 0, cdSize, cdOffset);
            return crypto.createHash('sha256').update(cd).digest('hex');
        }
        return null;
    }
    finally { fs.closeSync(fd); }
}
// the paks that hold Next Gen's changes, from what readPaks read
const holdsOurs = (s) => ({
    'shader.pak': s.shader.state === 'ours', 'shared.pak': s.scenery === 'nature' || s.scenery === 'all', 'initial.pak': s.initialPak === 'ours',
    'boot.pak': s.grade.state === 'ours' || s.particles.state === 'ours' || s.sky.state === 'ours', 'gfx.pak': s.logos.state === 'ours',
});
// the note as the game is now, or no note when no pak holds a change
async function leaveNote(g, state)
{
    const holds = holdsOurs(await readPaks(g, state)), files = {};
    for (const name of Object.keys(holds))
    {
        const hash = holds[name] ? dirHash(pakFile(g, name)) : null;
        if (hash) files[name] = hash;
    }
    const file = path.join(g.paks, NOTE_NAME);
    if (Object.keys(files).length) writeJson(file, { about: NOTE_ABOUT, date: stamp(), files }, '\r\n');
    else if (fs.existsSync(file)) fs.unlinkSync(file);
}
// the paks the note names that still are as it describes them while their original is not kept: ours, without a way back
function orphaned(g, state)
{
    let note;
    try { note = JSON.parse(fs.readFileSync(path.join(g.paks, NOTE_NAME), 'utf8')); } catch (e) { return []; }
    const files = note && typeof note.files === 'object' && note.files ? note.files : {};
    return Object.keys(files).filter((name) => pakFile(g, name) && !fs.existsSync(path.join(state, name + '.orig')) && dirHash(pakFile(g, name)) === files[name]);
}
const namesOf = (files) => (files.length < 3 ? files.join(' and ') : files.slice(0, -1).join(', ') + ' and ' + files[files.length - 1]);
function orphanText(files, restoring)
{
    const one = files.length === 1, it = one ? 'it' : 'them';
    return namesOf(files) + (one ? ' still holds' : ' still hold') + ' Next Gen\'s changes, but the ' + (one ? 'original' : 'originals') + ' kept for ' + it +
        (one ? ' is' : ' are') + ' gone: the folder %LOCALAPPDATA%\\SnowRunnerNextGen was lost, or it belongs to another Windows install. ' +
        (restoring ? 'Restore has nothing to put back for ' + it + '. ' : 'Building on ' + it + ' would make those changes a second time. ') +
        'Have the store check the game\'s files (in Steam: Properties, Installed Files, Verify integrity of game files)' +
        (restoring ? ': that puts the game\'s own files back.' : ', then Apply again.');
}

// ---- apply and restore

// the untouched shader.pak kept as the original, before the first build (and after a game update, when asked): the copy
// is made and checked first, then an earlier original moves aside under a dated name no other is lost to, and the copy
// takes its place; a file without a zip directory (a download cut short) is refused before it is kept
function keepShaderOriginal(g, state, now, adopt)
{
    const orig = path.join(state, 'shader.pak.orig');
    if (fs.existsSync(orig) && now.shader.state !== 'changed' && now.shader.state !== 'stock') return;
    const cur = sha256File(g.shader);
    if (fs.existsSync(orig) && sha256File(orig) === cur) return;
    if (!KNOWN_SHADER.includes(cur) && !adopt) throw new EngineError('adopt-files', adoptQuestion(['shader.pak'], false), { files: ['shader.pak'] });
    if (!dirHash(g.shader)) throw new EngineError('failed', 'shader.pak is not a whole pak file (its directory is missing): have the store check the game\'s files, then Apply again.');
    const tmp = orig + '.tmp';
    fs.copyFileSync(g.shader, tmp);
    if (sha256File(tmp) !== cur) { fs.unlinkSync(tmp); throw new EngineError('failed', 'the copy of shader.pak differs from the file'); }
    if (fs.existsSync(orig))
    {
        const kept = keptName(orig);
        fs.renameSync(orig, kept);
        emit({ type: 'log', text: 'the earlier original is kept as ' + path.basename(kept) });
    }
    fs.renameSync(tmp, orig);
    emit({ type: 'log', text: 'the game\'s shader.pak is kept as the original in ' + state });
}
// a dated name next to the file that no earlier one is lost to: <file>.<day>, then -2, -3 on the same day
function keptName(file)
{
    const day = stamp().slice(0, 10);
    let name = file + '.' + day;
    for (let k = 2; fs.existsSync(name); k++) name = file + '.' + day + '-' + k;
    return name;
}

// whether building shader.pak needs the player's yes to take the current file as the original (keepShaderOriginal's
// test, without writing anything)
function shaderNeedsAdopt(g, state, now)
{
    const orig = path.join(state, 'shader.pak.orig');
    if (fs.existsSync(orig) && now.shader.state !== 'changed' && now.shader.state !== 'stock') return false;
    const cur = sha256File(g.shader);
    if (fs.existsSync(orig) && sha256File(orig) === cur) return false;
    return !KNOWN_SHADER.includes(cur);
}

const sameSet = (a, b) => a.length === b.length && a.slice().sort().join() === b.slice().sort().join();
// initial.pak's sky edits depend on what boot.pak holds (lod_patch.js reads its directory when it builds), so after
// boot.pak changed the parts that are in initial.pak are built again
const fileStamp = (file) => { try { const s = fs.statSync(file); return s.size + ':' + s.mtimeMs; } catch (e) { return ''; } };
async function refreshInitial(g, env) { if (fs.existsSync(g.initial)) await must('lod_patch.js', ['initial-refresh'], env); }
// a boot.pak that is neither the original nor our build: another mod added its files to it (a texture pack, say) or
// a game update replaced it
const BOOT_CHANGED = 'boot.pak has changes from another mod (such as a texture pack) or a game update';
const GFX_CHANGED = 'gfx.pak has changes from another mod (such as an interface mod) or a game update';
// the night sky's photo skies carry their stars in the picture's alpha, and the sky levels in initial.pak are set to
// match (lod_patch.js does that whenever it builds; see refreshInitial). So the night sky goes in or out only while
// initial.pak can be written with it
const SKY_NEEDS_INITIAL = 'initial.pak was changed by another mod or a game update since its original was kept, and the night sky\'s photo skies need their levels set in it';

// ---- files another mod changed
// Every file is built from the copy the engine kept before its first change. A file that another mod (a texture pack
// in boot.pak, a tweak in initial.pak) or a game update changed since is taken as it is now as the new original
// only with the player's yes, asked once before anything is written and naming every such file: Next Gen then writes
// its changes over that state, and Restore puts it back, the other mods' changes included, not the game's own file.
// Next Gen's own changes still in boot.pak or initial.pak are left out of the new original by the tools (lut_grade.js
// adopt, lod_patch.js initial-adopt), so they are never made twice. With --leave the files stay as they are and their
// parts are left out.
function adoptQuestion(files, restoring)
{
    const one = files.length === 1, it = one ? 'it' : 'them', is = one ? 'it is' : 'they are', s = one ? '' : 's';
    const names = files.length < 3 ? files.join(' and ') : files.slice(0, -1).join(', ') + ' and ' + files[files.length - 1];
    return names + (one ? ' is not the original' : ' are not the originals') + ' Next Gen knows: another mod changed ' + it +
        ' (a texture pack, say) or a game update replaced ' + it + '. Take ' + it + ' as ' + is + ' now as the original' + s + '? ' +
        (restoring
            ? 'Restore then takes Next Gen\'s own changes out of ' + it + ' and keeps the other mod\'s: the game\'s own file' + s + (one ? ' does' : ' do') + ' not come back.'
            : 'Next Gen then writes its changes over ' + it + ', and Restore puts ' + it + ' back as ' + is + ' now, the other mod\'s changes included, not the game\'s own file' + s + '.');
}
// boot.pak, initial.pak and gfx.pak taken as they are now as the originals (after the player's yes); their parts read
// again
async function adoptPaks(g, env, now, files)
{
    const kept = (file) => new EngineError('failed', file + ' could not be taken as the original: it still reads as changed (are the tools older than this engine?)');
    if (files.includes('initial.pak'))
    {
        step('Keeping initial.pak as it is now as the original');
        await must('lod_patch.js', ['initial-adopt'], env);
        Object.assign(now, await readInitial(g, env));
        if (now.grass.state === 'changed') throw kept('initial.pak');
    }
    if (files.includes('boot.pak'))
    {
        step('Keeping boot.pak as it is now as the original (500 MB)');
        await must('lut_grade.js', ['adopt'], env);
        now.grade = await readGrade(g, env);
        now.particles = await readParticles(g, env);
        now.sky = await readSky(g, env);
        if (now.grade.state === 'changed') throw kept('boot.pak');
    }
    if (files.includes('gfx.pak'))
    {
        step('Keeping gfx.pak as it is now as the original (700 MB)');
        await must('gfx_logos.js', ['adopt'], env);
        now.logos = await readLogos(g, env);
        if (now.logos.state === 'changed') throw kept('gfx.pak');
    }
}

// ---- one engine at a time, and a look before the first write

// a lock file in the state folder: a second Apply or Restore on the same game (a second window, or one started again
// after the first was killed) stops here instead of writing next to the first; a lock left by a process that is gone
// is taken over
function lockState(state)
{
    const file = path.join(state, 'engine.lock');
    for (let tries = 0; ; tries++)
    {
        try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return file; }
        catch (e)
        {
            if (e.code !== 'EEXIST' || tries > 1) throw new EngineError('failed', 'the lock file could not be made: ' + file + ' (' + e.message + ')');
            let pid = 0;
            try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch (x) { /* an empty lock: taken over */ }
            let alive = false;
            if (pid && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch (x) { alive = x.code === 'EPERM'; } }
            if (alive) throw new EngineError('busy', 'Another Apply or Restore is running on this game (process ' + pid + '). Wait for it to finish.');
            try { fs.unlinkSync(file); } catch (x) { /* the next try says why */ }
        }
    }
}
const unlockState = (file) => { try { fs.unlinkSync(file); } catch (e) { /* nothing to remove */ } };

// before the first write: the folders the run writes in take a file, the paks it may rewrite open for writing (not
// read-only, not held by another program), and SnowRunner Shadows' preconditions hold; a run that would stop halfway
// stops here instead, with nothing changed
function preflight(g, needDll)
{
    const probe = (dir) =>
    {
        const f = path.join(dir, 'SnowRunnerNextGen.write-test');
        try { fs.writeFileSync(f, 'x'); fs.unlinkSync(f); }
        catch (e) { throw new EngineError('failed', 'The folder ' + dir + ' cannot be written (' + e.code + '): run the program as a user who can write the game folder.'); }
    };
    probe(g.paks);
    if (g.bin) probe(g.bin);
    for (const name of ['shader', 'shared', 'initial', 'boot', 'gfx'])
    {
        const file = g[name];
        if (!fs.existsSync(file)) continue;
        try { fs.closeSync(fs.openSync(file, 'r+')); }
        catch (e) { throw new EngineError('failed', path.basename(file) + ' cannot be written (' + e.code + '): it is read-only or in use by another program.'); }
    }
    if (needDll && g.bin)
    {
        if (!fs.existsSync(config.dll)) throw new EngineError('failed', 'SnowRunner Shadows (hid.dll) is missing from the installer: ' + config.dll + ' (an antivirus may have removed it).');
        const target = path.join(g.bin, 'hid.dll'), chain = path.join(g.bin, 'hid_chain.dll');
        if (fs.existsSync(target) && fs.existsSync(chain) && !isOurs(fs.readFileSync(target))) throw new EngineError('failed', 'Sources\\Bin has another mod\'s hid.dll and a hid_chain.dll already: SnowRunner Shadows cannot go in beside them.');
    }
}

const finished = (what) => ({ type: 'done', warnings: warned, text: warned ? what + ', with ' + (warned === 1 ? 'one note' : warned + ' notes') + ' above.' : what + '.' });

async function apply(g, state, sel, adopt, leave)
{
    if (gameRunning(g)) throw new EngineError('running', 'Close SnowRunner first: its files cannot be changed while it runs.');
    const env = toolEnv(g, state), bootStamp = fileStamp(g.boot);
    const shader = Array.isArray(sel.shader) ? sel.shader : [];
    const grass = sel.grass ? String(sel.grass) : null;
    if (grass && !(Number(grass) > 0)) throw new EngineError('usage', 'grass factor ' + grass);
    const fill = sel.fill ? String(sel.fill) : null;
    if (fill && !(Number(fill) > 0 && Number(fill) <= 2)) throw new EngineError('usage', 'fill light factor ' + fill);
    const stars = sel.stars ? String(sel.stars) : null;
    if (stars && !(Number(stars) > 0 && Number(stars) <= 10)) throw new EngineError('usage', 'stars factor ' + stars);
    const grade = sel.grade ? String(sel.grade) : null;
    if (grade && !(Number(grade) > 0 && Number(grade) <= 1)) throw new EngineError('usage', 'photo grade strength ' + grade);
    const particles = !!sel.particles, sky = !!sel.sky, logos = !!sel.logos;
    const weather = sel.weather ? weatherList(sel.weather) : null;
    if (sel.weather && (!weather || !/^[a-z,]+$/.test(String(sel.weather)))) throw new EngineError('usage', 'weather parts ' + sel.weather);
    if (!sel.shadows && shader.some((m) => NEED_DLL.includes(m)))
        warn('Bounce light and the reflections read the scene from SnowRunner Shadows: without it they change nothing.');
    step('Reading what is installed');
    const now = await readStatus(g, state);
    if (now.orphaned.length) throw new EngineError('orphaned', orphanText(now.orphaned, false), { files: now.orphaned });
    preflight(g, !!sel.shadows);
    const notes = lastNotes(state), last = notes.selection || {};

    // the files another mod changed that this selection writes: one question for all of them, before anything is written
    const shaderSame = now.shader.state === 'ours' && sameSet(now.shader.modules, shader) && sameCode(notes, 'shader');
    const changed = [];
    if (shader.length && !shaderSame && shaderNeedsAdopt(g, state, now)) changed.push('shader.pak');
    if (sel.scenery && now.scenery === 'changed') changed.push('shared.pak');
    if (now.grass.state === 'changed' && (grass || fill || stars || weather || sky || last.grass || last.fill || last.stars || last.weather || last.sky)) changed.push('initial.pak');
    if (now.grade.state === 'changed' && (grade || last.grade || particles || last.particles || sky || last.sky)) changed.push('boot.pak');
    if (now.logos.state === 'changed' && (logos || last.logos)) changed.push('gfx.pak');
    if (changed.length && !adopt && !leave) throw new EngineError('adopt-files', adoptQuestion(changed, false), { files: changed });
    g.touched = true;   // from here on files are written: the note in the game folder is renewed at the end, also after a stop (main)
    if (adopt) await adoptPaks(g, env, now, changed);
    const initialLeft = now.grass.state === 'changed';   // still changed after the question: left as it is

    // shader.pak
    if (!shader.length)
    {
        if (now.shader.state === 'ours') { step('Putting the original shader.pak back'); await must('pak_shader_patch.js', ['restore'], env); }
        else if (now.shader.state !== 'stock') warn('shader.pak is not this installer\'s build: left as it is.');
        removeStock(g);
    }
    else if (shaderSame) emit({ type: 'log', text: 'shader.pak already has these ' + shader.length + ' modules' });
    else if (leave && changed.includes('shader.pak')) warn('shader.pak is not the original Next Gen knows (another mod or a game update): left as it is, so the shader modules were left out.');
    else
    {
        keepShaderOriginal(g, state, now, adopt);
        const gone = ownDump ? [] : await prepare(state, shader);
        const build = shader.filter((m) => !gone.includes(m));
        if (build.length)
        {
            step('Building shader.pak with ' + build.length + ' modules (about a minute)');
            await must('fidelity_bundle.js', ['install', build.join(',')], env);
        }
        else warn('None of the chosen shader modules fits this game version: shader.pak was left as it is.');
    }

    // SnowRunner Shadows
    if (sel.shadows) installDll(g, { factor: String(sel.shadows.factor || '1'), slopeBias: String(sel.shadows.slopeBias == null ? '1' : sel.shadows.slopeBias),
        aoHalf: String(sel.shadows.aoHalf == null ? '1' : sel.shadows.aoHalf) });
    else removeDll(g);

    // scenery detail (shared.pak)
    if (now.scenery === 'missing') { if (sel.scenery) warn('No shared.pak in this game folder: scenery detail was left out.'); }
    else if (!sel.scenery)
    {
        if (now.scenery === 'nature' || now.scenery === 'all') { step('Putting the original shared.pak back (2 GB)'); await must('lod_patch.js', ['restore'], env); }
    }
    else if (now.scenery === sel.scenery && sameCode(notes, 'scenery')) emit({ type: 'log', text: 'shared.pak already has the ' + sel.scenery + ' set' });
    else if (now.scenery === 'changed' && leave) warn('shared.pak is not the original Next Gen knows (another mod or a game update): left as it is, so scenery detail was left out.');
    else
    {
        if (now.scenery === 'changed')   // the player said yes above
        {
            step('Keeping shared.pak as it is now as the original (2 GB)');
            await must('lod_patch.js', ['backup'], env);
        }
        step('Writing shared.pak: ' + (sel.scenery === 'all' ? 'every mesh' : 'rocks, trees and bushes') + ' in full detail farther out (2 GB, a minute or two)');
        await must('lod_patch.js', ['install', sel.scenery], env);
    }

    // grass reach (initial.pak)
    if (now.grass.state === 'missing') { if (grass) warn('No initial.pak in this game folder: grass reach was left out.'); }
    else if (!grass)
    {
        if (now.grass.state === 'ours') { step('Putting the original grass back (initial.pak)'); await must('lod_patch.js', ['grass-restore'], env); }
    }
    else if (now.grass.state === 'ours' && Number(now.grass.factor) === Number(grass) && sameCode(notes, 'initial')) emit({ type: 'log', text: 'the grass is already drawn ' + grass + 'x farther' });
    else if (now.grass.state === 'changed') warn('initial.pak was changed by another mod or a game update since its original was kept: grass reach was left out.');
    else { step('Drawing the grass ' + grass + 'x farther (initial.pak)'); await must('lod_patch.js', ['grass-install', grass], env); }

    // fill light (initial.pak, next to the grass: the grass steps above keep it, so the state read before still holds)
    const pct = (v) => Math.round(Number(v) * 100) + ' %';
    if (now.fill.state === 'missing') { if (fill) warn('No initial.pak in this game folder: the fill light was left out.'); }
    else if (!fill)
    {
        if (now.fill.state === 'ours') { step('Putting the game\'s own fill light back (initial.pak)'); await must('lod_patch.js', ['fill-restore'], env); }
    }
    else if (now.fill.state === 'ours' && Number(now.fill.factor) === Number(fill) && sameCode(notes, 'initial')) emit({ type: 'log', text: 'the fill light is already at ' + pct(fill) });
    else if (now.fill.state === 'changed') warn('initial.pak was changed by another mod or a game update since its original was kept: the fill light was left out.');
    else { step('Setting the fill light to ' + pct(fill) + ' (initial.pak)'); await must('lod_patch.js', ['fill-install', fill], env); }

    // brighter stars (initial.pak, the third part: the grass and fill steps above keep it)
    if (now.stars.state === 'missing') { if (stars) warn('No initial.pak in this game folder: the brighter stars were left out.'); }
    else if (!stars)
    {
        if (now.stars.state === 'ours') { step('Putting the game\'s own star brightness back (initial.pak)'); await must('lod_patch.js', ['stars-restore'], env); }
    }
    else if (now.stars.state === 'ours' && Number(now.stars.factor) === Number(stars) && sameCode(notes, 'initial')) emit({ type: 'log', text: 'the stars are already ' + stars + 'x brighter' });
    else if (now.stars.state === 'changed') warn('initial.pak was changed by another mod or a game update since its original was kept: the brighter stars were left out.');
    else { step('Making the stars ' + stars + 'x brighter (initial.pak)'); await must('lod_patch.js', ['stars-install', stars], env); }

    // the weather (initial.pak, the fourth part: the parts above keep it)
    const weatherWords = (list) => list.split(',').map((p) => WEATHER_WORDS[p] || p).join(', ');
    if (now.weather.state === 'missing') { if (weather) warn('No initial.pak in this game folder: the weather was left out.'); }
    else if (!weather)
    {
        if (now.weather.state === 'ours') { step('Putting the game\'s own weather back (initial.pak)'); await must('lod_patch.js', ['weather-restore'], env); }
    }
    else if (now.weather.state === 'ours' && weatherList(now.weather.parts) === weather && sameCode(notes, 'initial')) emit({ type: 'log', text: 'the weather already has ' + weatherWords(weather) });
    else if (now.weather.state === 'changed') warn('initial.pak was changed by another mod or a game update since its original was kept: the weather was left out.');
    else { step('Putting the weather in: ' + weatherWords(weather) + ' (initial.pak)'); await must('lod_patch.js', ['weather-install', weather], env); }

    // photo grade (the daytime colour LUTs in boot.pak)
    if (now.grade.state === 'missing') { if (grade) warn('No boot.pak in this game folder: the photo grade was left out.'); }
    else if (!grade)
    {
        if (now.grade.state === 'ours') { step('Putting the game\'s own colour grading back (boot.pak)'); await must('lut_grade.js', ['restore'], env); }
        else if (now.grade.state === 'changed' && last.grade) warn(BOOT_CHANGED + ': left as it is, so the photo grade could not be taken out.');
    }
    else if (now.grade.state === 'ours' && Number(now.grade.strength) === Number(grade) && sameCode(notes, 'grade')) emit({ type: 'log', text: 'the photo grade is already at ' + pct(grade) });
    else if (now.grade.state === 'changed') warn(BOOT_CHANGED + ': left as it is, so the photo grade was left out.');
    else { step('Grading the colour at ' + pct(grade) + ' (boot.pak, 500 MB)'); await must('lut_grade.js', ['install', grade], env); }

    // the particle sprites (boot.pak, beside the grade: lut_grade.js keeps the other part when it changes one)
    if (now.particles.state === 'missing') { if (particles) warn('No boot.pak in this game folder: the sharper particles were left out.'); }
    else if (!particles)
    {
        if (now.particles.state === 'ours') { step('Putting the game\'s own particle textures back (boot.pak, 500 MB)'); await must('lut_grade.js', ['particles-restore'], env); }
        else if (now.particles.state === 'changed' && last.particles) warn(BOOT_CHANGED + ': left as it is, so the sharper particles could not be taken out.');
    }
    else if (now.particles.state === 'ours' && sameCode(notes, 'particles')) emit({ type: 'log', text: 'boot.pak already has the sharper particles' });
    else if (now.particles.state === 'changed') warn(BOOT_CHANGED + ': left as it is, so the sharper particles were left out.');
    else { step('Putting the sharper particle textures in (boot.pak, 600 MB)'); await must('lut_grade.js', ['particles-install'], env); }

    // the night sky (boot.pak, the third part there)
    if (now.sky.state === 'missing') { if (sky) warn('No boot.pak in this game folder: the night sky was left out.'); }
    else if (!sky)
    {
        if (now.sky.state === 'ours')
        {
            if (initialLeft) warn(SKY_NEEDS_INITIAL + ': the night sky was left in.');
            else { step('Putting the game\'s own night sky back (boot.pak, 500 MB)'); await must('lut_grade.js', ['sky-restore'], env); }
        }
        else if (now.sky.state === 'changed' && last.sky) warn(BOOT_CHANGED + ': left as it is, so the night sky could not be taken out.');
    }
    else if (now.sky.state === 'ours' && sameCode(notes, 'sky')) emit({ type: 'log', text: 'boot.pak already has the night sky' });
    else if (now.sky.state === 'changed') warn(BOOT_CHANGED + ': left as it is, so the night sky was left out.');
    else if (initialLeft) warn(SKY_NEEDS_INITIAL + ': the night sky was left out.');
    else { step('Putting the night sky in (boot.pak, 600 MB)'); await must('lut_grade.js', ['sky-install'], env); }

    if (fileStamp(g.boot) !== bootStamp) await refreshInitial(g, env);

    // the Next Gen logos (gfx.pak)
    if (now.logos.state === 'missing') { if (logos) warn('No gfx.pak in this game folder: the Next Gen logo was left out.'); }
    else if (!logos)
    {
        if (now.logos.state === 'ours') { step('Putting the original gfx.pak back (700 MB)'); await must('gfx_logos.js', ['restore'], env); }
        else if (now.logos.state === 'changed' && last.logos) warn(GFX_CHANGED + ': left as it is, so the Next Gen logo could not be taken out.');
    }
    else if (now.logos.state === 'ours' && sameCode(notes, 'logos')) emit({ type: 'log', text: 'gfx.pak already has the Next Gen logo' });
    else if (now.logos.state === 'changed') warn(GFX_CHANGED + ': left as it is, so the Next Gen logo was left out.');
    else { step('Putting the Next Gen logo in (gfx.pak, 700 MB)'); await must('gfx_logos.js', ['install'], env); }

    await leaveNote(g, state);
    g.touched = false;
    writeJson(path.join(state, 'nextgen.json'), { selection: sel, parts: PARTS, date: stamp() });
    emit(warned ? finished('Installed') : { type: 'done', warnings: 0, text: 'Installed. Start the game to see it.' });
}

async function restore(g, state, adopt, leave)
{
    if (gameRunning(g)) throw new EngineError('running', 'Close SnowRunner first: its files cannot be changed while it runs.');
    const env = toolEnv(g, state), bootStamp = fileStamp(g.boot);
    step('Reading what is installed');
    const now = await readStatus(g, state);
    if (now.orphaned.length) throw new EngineError('orphaned', orphanText(now.orphaned, true), { files: now.orphaned });
    preflight(g, false);
    // files another mod changed since the last apply put Next Gen's changes in them: with the player's yes they are taken
    // as they are now, so restore takes Next Gen's changes out of them and keeps the other mod's
    const last = lastNotes(state).selection || {};
    const changed = [];
    if (now.grass.state === 'changed' && (last.grass || last.fill || last.stars || last.weather || last.sky)) changed.push('initial.pak');
    if (now.grade.state === 'changed' && (last.grade || last.particles || last.sky)) changed.push('boot.pak');
    if (now.logos.state === 'changed' && last.logos) changed.push('gfx.pak');
    if (changed.length && !adopt && !leave) throw new EngineError('adopt-files', adoptQuestion(changed, true), { files: changed });
    g.touched = true;   // files are written from here on: see apply
    if (adopt) await adoptPaks(g, env, now, changed);
    const initialLeft = now.grass.state === 'changed';   // still changed after the question: left as it is
    if (now.shader.state === 'ours') { step('Putting the original shader.pak back'); await must('pak_shader_patch.js', ['restore'], env); }
    else if (now.shader.state !== 'stock') warn('shader.pak is not this installer\'s build: left as it is.');
    removeStock(g);
    removeDll(g);
    if (now.scenery === 'nature' || now.scenery === 'all') { step('Putting the original shared.pak back (2 GB)'); await must('lod_patch.js', ['restore'], env); }
    else if (now.scenery === 'changed') warn('shared.pak is not this installer\'s build: left as it is.');
    // boot.pak before initial.pak: the sky levels initial.pak holds follow the night sky in boot.pak
    if (now.grade.state === 'ours') { step('Putting the game\'s own colour grading back (boot.pak)'); await must('lut_grade.js', ['restore'], env); }
    else if (now.grade.state === 'changed') warn(BOOT_CHANGED + ': left as it is.');
    if (now.particles.state === 'ours') { step('Putting the game\'s own particle textures back (boot.pak)'); await must('lut_grade.js', ['particles-restore'], env); }
    if (now.sky.state === 'ours')
    {
        if (initialLeft) warn(SKY_NEEDS_INITIAL + ': the night sky was left in.');
        else { step('Putting the game\'s own night sky back (boot.pak)'); await must('lut_grade.js', ['sky-restore'], env); }
    }
    if (now.grass.state === 'ours' || now.fill.state === 'ours' || now.stars.state === 'ours' || now.weather.state === 'ours') { step('Putting the original initial.pak back'); await must('lod_patch.js', ['initial-restore'], env); }
    else if (initialLeft) warn('initial.pak was changed by something else: left as it is.');
    if (fileStamp(g.boot) !== bootStamp) await refreshInitial(g, env);
    if (now.logos.state === 'ours') { step('Putting the original gfx.pak back (700 MB)'); await must('gfx_logos.js', ['restore'], env); }
    else if (now.logos.state === 'changed') warn(GFX_CHANGED + ': left as it is.');
    await leaveNote(g, state);
    g.touched = false;
    writeJson(path.join(state, 'nextgen.json'), { selection: null, date: stamp() });
    emit(finished('The game\'s own files are back'));
}

async function main()
{
    const args = process.argv.slice(2), cmd = args[0];
    const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
    let g = null, state = null, lock = null;
    try
    {
        const game = opt('game');
        if (!game || !['status', 'apply', 'restore'].includes(cmd)) throw new EngineError('usage', 'usage: node ngen.js status|apply|restore --game <folder> [--selection <file.json>] [--adopt | --leave]');
        g = gameFiles(game);
        state = stateDir(game);
        if (cmd === 'status') emit(Object.assign({ type: 'status' }, await readStatus(g, state)));
        else if (cmd === 'restore') { lock = lockState(state); await restore(g, state, args.includes('--adopt'), args.includes('--leave')); }
        else
        {
            const file = opt('selection');
            if (!file) throw new EngineError('usage', 'apply needs --selection <file.json>');
            const sel = JSON.parse(fs.readFileSync(file, 'utf8'));
            lock = lockState(state);
            await apply(g, state, sel, args.includes('--adopt'), args.includes('--leave'));
        }
    }
    catch (e)
    {
        // a stop after the first write: the note still has to name the paks that hold Next Gen's changes now, and the
        // window hears that files were changed (apply has no rollback: a stop at shared.pak leaves shader.pak built)
        if (g && g.touched) { try { await leaveNote(g, state); } catch (e2) { /* the stop itself is what is reported */ } }
        emit(Object.assign({ type: 'error', code: e.code || 'failed', text: e.message, touched: !!(g && g.touched) }, e.extra || {}));
        process.exitCode = 1;
    }
    finally { if (lock) unlockState(lock); }
}

main();
