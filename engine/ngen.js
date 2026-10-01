// SPDX-License-Identifier: GPL-3.0-only
// SnowRunner Next Gen's engine: reads what is installed in a game folder, installs a selection of modules, and puts
// the game's own files back. The window runs it and reads one JSON object per line from it:
//   {"type":"step","text":...}    a stage begins          {"type":"log","text":...}   a line from one of the tools
//   {"type":"warn","text":...}    something left alone    {"type":"status",...}       the answer to status
//   {"type":"done","text":...}    finished                {"type":"error","code":...,"text":...}   stopped
//   error codes: usage, missing (no game there), running (close the game), adopt-files (files another mod or a game
//   update changed, named in "files": run again with --adopt to take them as they are now as the originals, or with
//   --leave to leave them and their parts out), failed
// The work is done by the project's own tools, the code the modules are tested with (SnowRunner-shaders\tools:
// fidelity_bundle.js builds shader.pak, pak_shader_patch.js puts it back, lod_patch.js does shared.pak and the
// grass and the fill light in initial.pak, lut_grade.js the colour LUTs in boot.pak); SnowRunner Shadows (hid.dll and
// its ini in Sources\Bin) is copied in and out here. Every
// file is built from the game's original, kept in a state folder outside the game (one per game folder).
// usage: node ngen.js status  --game <folder>
//        node ngen.js apply   --game <folder> --selection <file.json> [--adopt | --leave]
//        node ngen.js restore --game <folder> [--adopt | --leave]
// selection: { "shader": [fidelity_bundle.js module names], "shadows": null | { "factor": "1", "slopeBias": "1", "aoHalf": "1" },
//              "scenery": null | "nature" | "all", "grass": null | "3" | "2", "fill": null | "0.7" | "0.55" | "0.85",
//              "grade": null | "1" | "0.5", "particles": null | "1", "stars": null | "3" | "2" }
// config.json next to this file: { "tools": <folder>, "dll": <hid.dll to install>, "devGame": <folder>,
//   "devState": <folder> } (the dev build shares devState, the project's pak_backup, with its menu for devGame);
//   NGEN_STATE_ROOT moves the state folders (tests)
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
// packaged: the tools come without the game's shaders (their dump\ folder); prepare.js makes them per game in the state
// folder from the player's own shader.pak, and the shader tools read them there (SR_DUMP_DIR, SR_SETS_DIR)
const packaged = !fs.existsSync(path.join(config.tools, '..', 'dump', 'index.json'));
// the fingerprint of each part's code (the package build writes parts.json): a part whose code changed is rebuilt even
// when the selection is the same, so a new installer version updates an old install
const partsFile = path.join(__dirname, 'parts.json');
const PARTS = fs.existsSync(partsFile) ? JSON.parse(fs.readFileSync(partsFile, 'utf8')) : {};

class EngineError extends Error { constructor(code, text, extra) { super(text); this.code = code; this.extra = extra; } }

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const step = (text) => emit({ type: 'step', text });
const warn = (text) => emit({ type: 'warn', text });
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

const toolEnv = (g, state) => Object.assign({}, process.env,
    { SR_SHADER_PAK: g.shader, SR_SHARED_PAK: g.shared, SR_INITIAL_PAK: g.initial, SR_BOOT_PAK: g.boot, SR_STATE_DIR: state, LOD_GRASS: 'leave' },
    packaged ? { SR_DUMP_DIR: path.join(state, 'dump'), SR_SETS_DIR: path.join(state, 'sets') } : {});

// the notes of the last apply: { selection, parts, date }
function lastNotes(state)
{
    const f = path.join(state, 'nextgen.json');
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; } catch (e) { return {}; }
}
// whether a part installed before was built by the code this installer carries (true when nothing is known: dev build)
const sameCode = (notes, part) => !PARTS[part] || ((notes.parts || {})[part] === PARTS[part]);

// prepare.js (packaged only): the game's shaders and the sets patched from them, made in the state folder; its events
// (step, log) are passed on, an error stops the apply
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
            const line = (l) => { sink.push(l); if (shown && l.trim()) emit({ type: 'log', text: l }); };
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

// the reason a tool gave: its "Error: ..." or "error: ..." line, else its last line
function reason(r)
{
    const lines = r.err.concat(r.out).filter((l) => l.trim());
    const e = lines.find((l) => /^\s*(Error|error): /.test(l));
    return (e || lines[lines.length - 1] || 'exit code ' + r.code).replace(/^\s*(Error|error): /, '');
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

// whether the game of this folder runs (another install of it running does not count); when the running game's path
// cannot be read, any SnowRunner.exe counts
function gameRunning(g)
{
    const exe = path.join(g.root, 'Sources', 'Bin', 'SnowRunner.exe').toLowerCase();
    try
    {
        const paths = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-Process SnowRunner -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'], { encoding: 'utf8', windowsHide: true });
        return paths.split(/\r?\n/).some((p) => p.trim().toLowerCase() === exe);
    }
    catch (e)
    {
        try { return /SnowRunner\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq SnowRunner.exe', '/NH'], { encoding: 'utf8', windowsHide: true })); }
        catch (e2) { return false; }
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
    const { grass, fill, stars } = await readInitial(g, env), grade = await readGrade(g, env), particles = await readParticles(g, env);
    return { game: g.root, running: gameRunning(g), shader, dll: dllStatus(g), scenery, grass, fill, stars, grade, particles, stateDir: state };
}
// initial.pak: the grass and the fill light, two parts of one build: { grass, fill }, each { state, factor }
async function readInitial(g, env)
{
    const init = fs.existsSync(g.initial) ? JSON.parse(await answer('lod_patch.js', ['initial-status'], env)) : { state: 'missing' };
    const part = (v) => (init.state !== 'ours' ? { state: init.state } : v ? { state: 'ours', factor: String(v) } : { state: 'vanilla' });
    return { grass: part(init.grass), fill: part(init.fill), stars: part(init.stars) };   // ours (with factor), vanilla, changed, missing
}
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

// ---- apply and restore

// the untouched shader.pak kept as the original, before the first build (and after a game update, when asked)
function keepShaderOriginal(g, state, now, adopt)
{
    const orig = path.join(state, 'shader.pak.orig');
    if (fs.existsSync(orig) && now.shader.state !== 'changed' && now.shader.state !== 'stock') return;
    const cur = sha256File(g.shader);
    if (fs.existsSync(orig) && sha256File(orig) === cur) return;
    if (!KNOWN_SHADER.includes(cur) && !adopt) throw new EngineError('adopt-files', adoptQuestion(['shader.pak'], false), { files: ['shader.pak'] });
    if (fs.existsSync(orig))
    {
        const kept = orig + '.' + stamp().slice(0, 10);
        fs.renameSync(orig, kept);
        emit({ type: 'log', text: 'the earlier original is kept as ' + path.basename(kept) });
    }
    const tmp = orig + '.tmp';
    fs.copyFileSync(g.shader, tmp);
    if (sha256File(tmp) !== cur) { fs.unlinkSync(tmp); throw new EngineError('failed', 'the copy of shader.pak differs from the file'); }
    fs.renameSync(tmp, orig);
    emit({ type: 'log', text: 'the game\'s shader.pak is kept as the original in ' + state });
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
// boot.pak and initial.pak taken as they are now as the originals (after the player's yes); their parts read again
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
        if (now.grade.state === 'changed') throw kept('boot.pak');
    }
}

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
    const particles = !!sel.particles;
    if (!sel.shadows && shader.some((m) => NEED_DLL.includes(m)))
        warn('Bounce light and the reflections read the scene from SnowRunner Shadows: without it they change nothing.');
    step('Reading what is installed');
    const now = await readStatus(g, state);
    const notes = lastNotes(state), last = notes.selection || {};

    // the files another mod changed that this selection writes: one question for all of them, before anything is written
    const shaderSame = now.shader.state === 'ours' && sameSet(now.shader.modules, shader) && sameCode(notes, 'shader');
    const changed = [];
    if (shader.length && !shaderSame && shaderNeedsAdopt(g, state, now)) changed.push('shader.pak');
    if (sel.scenery && now.scenery === 'changed') changed.push('shared.pak');
    if (now.grass.state === 'changed' && (grass || fill || stars || last.grass || last.fill || last.stars)) changed.push('initial.pak');
    if (now.grade.state === 'changed' && (grade || last.grade || particles || last.particles)) changed.push('boot.pak');
    if (changed.length && !adopt && !leave) throw new EngineError('adopt-files', adoptQuestion(changed, false), { files: changed });
    if (adopt) await adoptPaks(g, env, now, changed);

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
        const gone = packaged ? await prepare(state, shader) : [];
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

    if (fileStamp(g.boot) !== bootStamp) await refreshInitial(g, env);
    fs.writeFileSync(path.join(state, 'nextgen.json'), JSON.stringify({ selection: sel, parts: PARTS, date: stamp() }, null, 2));
    emit({ type: 'done', text: 'Installed. Start the game to see it.' });
}

async function restore(g, state, adopt, leave)
{
    if (gameRunning(g)) throw new EngineError('running', 'Close SnowRunner first: its files cannot be changed while it runs.');
    const env = toolEnv(g, state), bootStamp = fileStamp(g.boot);
    step('Reading what is installed');
    const now = await readStatus(g, state);
    // files another mod changed since the last apply put Next Gen's changes in them: with the player's yes they are taken
    // as they are now, so restore takes Next Gen's changes out of them and keeps the other mod's
    const last = lastNotes(state).selection || {};
    const changed = [];
    if (now.grass.state === 'changed' && (last.grass || last.fill || last.stars)) changed.push('initial.pak');
    if (now.grade.state === 'changed' && (last.grade || last.particles)) changed.push('boot.pak');
    if (changed.length && !adopt && !leave) throw new EngineError('adopt-files', adoptQuestion(changed, true), { files: changed });
    if (adopt) await adoptPaks(g, env, now, changed);
    if (now.shader.state === 'ours') { step('Putting the original shader.pak back'); await must('pak_shader_patch.js', ['restore'], env); }
    else if (now.shader.state !== 'stock') warn('shader.pak is not this installer\'s build: left as it is.');
    removeStock(g);
    removeDll(g);
    if (now.scenery === 'nature' || now.scenery === 'all') { step('Putting the original shared.pak back (2 GB)'); await must('lod_patch.js', ['restore'], env); }
    else if (now.scenery === 'changed') warn('shared.pak is not this installer\'s build: left as it is.');
    if (now.grass.state === 'ours' || now.fill.state === 'ours' || now.stars.state === 'ours') { step('Putting the original initial.pak back'); await must('lod_patch.js', ['initial-restore'], env); }
    else if (now.grass.state === 'changed') warn('initial.pak was changed by something else: left as it is.');
    if (now.grade.state === 'ours') { step('Putting the original boot.pak back'); await must('lut_grade.js', ['restore'], env); }
    else if (now.grade.state === 'changed') warn(BOOT_CHANGED + ': left as it is.');
    if (now.particles.state === 'ours') { step('Putting the game\'s own particle textures back (boot.pak)'); await must('lut_grade.js', ['particles-restore'], env); }
    if (fileStamp(g.boot) !== bootStamp) await refreshInitial(g, env);
    fs.writeFileSync(path.join(state, 'nextgen.json'), JSON.stringify({ selection: null, date: stamp() }, null, 2));
    emit({ type: 'done', text: 'The game\'s own files are back.' });
}

async function main()
{
    const args = process.argv.slice(2), cmd = args[0];
    const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
    try
    {
        const game = opt('game');
        if (!game || !['status', 'apply', 'restore'].includes(cmd)) throw new EngineError('usage', 'usage: node ngen.js status|apply|restore --game <folder> [--selection <file.json>] [--adopt | --leave]');
        const g = gameFiles(game), state = stateDir(game);
        if (cmd === 'status') emit(Object.assign({ type: 'status' }, await readStatus(g, state)));
        else if (cmd === 'restore') await restore(g, state, args.includes('--adopt'), args.includes('--leave'));
        else
        {
            const file = opt('selection');
            if (!file) throw new EngineError('usage', 'apply needs --selection <file.json>');
            await apply(g, state, JSON.parse(fs.readFileSync(file, 'utf8')), args.includes('--adopt'), args.includes('--leave'));
        }
    }
    catch (e)
    {
        emit(Object.assign({ type: 'error', code: e.code || 'failed', text: e.message }, e.extra || {}));
        process.exitCode = 1;
    }
}

main();
