// Run after package.ps1 (node test/compare_default.js). In a state folder of its own, the packaged engine's prepare.js
// makes the game's shaders and the default selection's sets from an original shader.pak, as it does on a player's
// machine. They are compared with the tools' working tree; then the default shader.pak is built with the working
// tree's tools and with the packaged tools on the prepared data. Both must be equal. The installed game's shader.pak is
// hashed (read only) for comparison. Writes only out/compare.
// SR_TOOLS_TREE names the working tree (its tools\, dump\, replacements\ and pak_backup\ folders).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DEV = process.env.SR_TOOLS_TREE || 'C:\\Games\\SnowRunner-shaders';
const pkgEngine = path.join(ROOT, 'out', 'package', 'SnowRunnerNextGen', 'engine');
const pkgTools = path.join(pkgEngine, 'tools'), pkgNode = path.join(pkgEngine, 'node.exe');
const OUT = path.join(ROOT, 'out', 'compare');
// the window's default shader modules with the fog and the bounce light, which are off by default: their sets are compared too
const MODULES = 'gtao,aofar,revec,blocker,seam,ambient,fog,tonemap,bloom,water,rivertint,crestglow,puddles,gi,smoke,smokeshade,sssr,headglow,contact';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const clean = Object.assign({}, process.env);
for (const k of Object.keys(clean)) if (/^SR_|^NODE_OPTIONS$|^TRACE_FILE$/.test(k)) delete clean[k];

// 0. the player's side: a state folder that holds the original shader.pak, and what the packaged prepare.js makes there
const state = path.join(OUT, 'state'), original = path.join(DEV, 'pak_backup', 'shader.pak.orig');
fs.mkdirSync(state);
fs.copyFileSync(original, path.join(state, 'shader.pak.orig'));
const t0 = Date.now();
const prep = spawnSync(pkgNode, [path.join(pkgEngine, 'prepare.js'), '--state', state, '--tools', pkgTools, '--modules', MODULES], { env: clean, encoding: 'utf8', maxBuffer: 64 << 20 });
if (prep.status !== 0) { console.log((prep.stdout + prep.stderr).split('\n').filter(Boolean).slice(-5).join('\n')); throw new Error('the packaged prepare.js failed'); }
console.log('state folder ' + state + ', prepared by the packaged engine in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');

// 1. blobs
const dumpA = path.join(DEV, 'dump'), dumpB = path.join(state, 'dump');
const cso = (d) => fs.readdirSync(d).filter((f) => /^0x[0-9A-F]{8}\.cso$/.test(f)).sort();
const la = cso(dumpA), lb = cso(dumpB), sa = new Set(la), sb = new Set(lb);
const onlyA = la.filter((f) => !sb.has(f)), onlyB = lb.filter((f) => !sa.has(f));
const diff = la.filter((f) => sb.has(f) && !fs.readFileSync(path.join(dumpA, f)).equals(fs.readFileSync(path.join(dumpB, f))));
console.log('blobs: dev ' + la.length + ', package ' + lb.length + ', only in dev ' + onlyA.length + (onlyA.length ? ' e.g. ' + onlyA.slice(0, 5).join(' ') : '') +
    ', only in package ' + onlyB.length + (onlyB.length ? ' e.g. ' + onlyB.slice(0, 5).join(' ') : '') + ', differing ' + diff.length);

// 2. index.json per record and field; the other files extract.js writes
const ia = JSON.parse(fs.readFileSync(path.join(dumpA, 'index.json'), 'utf8')), ib = JSON.parse(fs.readFileSync(path.join(dumpB, 'index.json'), 'utf8'));
const mb = new Map(ib.map((r) => [r.hash, r]));
const fieldDiff = {}, example = {};
for (const ra of ia)
{
    const rb = mb.get(ra.hash);
    if (!rb) continue;
    for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)]))
        if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) { fieldDiff[k] = (fieldDiff[k] || 0) + 1; if (!example[k]) example[k] = ra.hash + ': dev ' + JSON.stringify(ra[k]).slice(0, 160) + ' | package ' + JSON.stringify(rb[k]).slice(0, 160); }
}
const sameOrder = ia.map((r) => r.hash).join() === ib.map((r) => r.hash).join();
const bytesEqual = fs.readFileSync(path.join(dumpA, 'index.json')).equals(fs.readFileSync(path.join(dumpB, 'index.json')));
console.log('index.json: dev ' + ia.length + ' records, package ' + ib.length + '; byte equal ' + bytesEqual + '; same order ' + sameOrder + '; fields differing ' + JSON.stringify(fieldDiff));
for (const k in example) console.log('  ' + k + ' e.g. ' + example[k]);
const others = (d) => fs.readdirSync(d).filter((f) => !/^0x[0-9A-F]{8}\.cso$/.test(f) && f !== 'index.json').sort();
const oa = others(dumpA), ob = others(dumpB);
console.log('other files: dev [' + oa.join(' ') + ']');
console.log('             package [' + ob.join(' ') + ']');
for (const f of oa.filter((x) => ob.includes(x)))
    console.log('  ' + f + ': ' + (fs.readFileSync(path.join(dumpA, f)).equals(fs.readFileSync(path.join(dumpB, f))) ? 'equal' : 'DIFFERS'));

// 3. the sets the package prepared, against replacements\
const prepared = JSON.parse(fs.readFileSync(path.join(state, 'prepared.json'), 'utf8'));
console.log('prepared.json sets: ' + prepared.sets.join(', '));
for (const set of prepared.sets)
{
    const a = path.join(DEV, 'replacements', set), b = path.join(state, 'sets', set);
    const list = (d) => fs.readdirSync(d).filter((f) => /^0x[0-9A-F]{8}\.shader$/.test(f)).sort();
    const xa = list(a), xb = list(b);
    const d = xa.filter((f) => xb.includes(f) && !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
    console.log('  ' + set.padEnd(34) + (xa.join() === xb.join() ? (d.length ? d.length + ' of ' + xa.length + ' DIFFER' : 'equal (' + xa.length + ')') : 'file lists differ (' + xa.length + ' vs ' + xb.length + ')'));
}

// 4. the default shader.pak both ways. The packaged tool gets a pak of its own to point at: left to its default it
// would look at the Steam install
const installedPak = 'C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/shader.pak';
const INSTALLED = fs.existsSync(installedPak) ? sha(installedPak).slice(0, 8) : 'none';   // read only
const ownPak = path.join(OUT, 'shader.pak');
fs.copyFileSync(original, ownPak);
const pakA = path.join(OUT, 'default_dev.pak'), pakB = path.join(OUT, 'default_package.pak');
const t1 = Date.now();
const saidA = execFileSync(process.execPath, [path.join(DEV, 'tools', 'fidelity_bundle.js'), 'build', pakA, MODULES], { env: clean, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const saidB = execFileSync(pkgNode, [path.join(pkgTools, 'fidelity_bundle.js'), 'build', pakB, MODULES],
    { env: Object.assign({}, clean, { SR_SHADER_PAK: ownPak, SR_STATE_DIR: state, SR_DUMP_DIR: dumpB, SR_SETS_DIR: path.join(state, 'sets') }), stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const a = sha(pakA), b = sha(pakB), as = sha(pakA + '.stock'), bs = sha(pakB + '.stock');
console.log('new_default shader.pak dev ' + a.slice(0, 8) + ', package ' + b.slice(0, 8) + (a === b ? ' EQUAL' : ' DIFFER') +
    '; stock twins ' + (as === bs ? 'EQUAL' : 'DIFFER') + '; the installed pak ' + INSTALLED + (b.startsWith(INSTALLED) ? ': SAME' : ': not the same') +
    '  (' + ((Date.now() - t1) / 1000).toFixed(0) + ' s)');
console.log('            ' + saidA.split('\n')[0].replace(/; sha256 .*/, '').slice(0, 600));
if (saidA.split('\n')[0] !== saidB.split('\n')[0]) console.log('            package said: ' + saidB.split('\n')[0].slice(0, 600));
for (const f of [pakA, pakB, pakA + '.stock', pakB + '.stock', ownPak]) fs.unlinkSync(f);
if (a !== b || as !== bs || !bytesEqual || diff.length || onlyA.length || onlyB.length) process.exitCode = 1;
