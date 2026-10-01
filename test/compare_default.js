// Run after test/package_test.ps1 (node test/compare_default.js): compares what the packaged engine prepared in the
// package test's state folder (the player's machine) with the dev workspace, then builds the default shader.pak with
// the dev tools and with the packaged tools on the player-side data; both must equal each other, and the installed
// game's shader.pak is hashed (read only) for comparison. Writes only out/compare.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const DEV = 'C:\\Games\\SnowRunner-shaders';
const games = 'C:\\Games\\snowrunner-next-gen\\out\\enginetest\\state\\games';
const state = path.join(games, fs.readdirSync(games)[0]);
const pkgTools = path.join(process.env.TEMP, 'ngen-package-test', 'SnowRunnerNextGen', 'engine', 'tools');
const OUT = path.join(__dirname, '..', 'out', 'compare');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
console.log('state folder ' + state);

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

// 4. bundles both ways: the engine test's default set, every module, and the per-material reflections instead of the pass
// the window's default shader modules
const LISTS = {
    new_default: 'gtao,aofar,revec,blocker,seam,ambient,fog,tonemap,bloom,water,rivertint,crestglow,puddles,gi,smoke,smokeshade,sssr,contact',
};
const INSTALLED = sha('C:/Program Files (x86)/Steam/steamapps/common/Snowrunner/preload/paks/client/shader.pak').slice(0, 8);   // read only
const clean = Object.assign({}, process.env);
for (const k of Object.keys(clean)) if (/^SR_|^NODE_OPTIONS$|^TRACE_FILE$/.test(k)) delete clean[k];
const gameCopy = 'C:\\Games\\snowrunner-next-gen\\out\\enginetest\\game\\preload\\paks\\client\\shader.pak';
for (const [name, MODULES] of Object.entries(LISTS))
{
    const pakA = path.join(OUT, name + '_dev.pak'), pakB = path.join(OUT, name + '_package.pak');
    const t0 = Date.now();
    const la = execFileSync(process.execPath, [path.join(DEV, 'tools', 'fidelity_bundle.js'), 'build', pakA, MODULES], { env: clean, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    const lb = execFileSync(path.join(pkgTools, '..', 'node.exe'), [path.join(pkgTools, 'fidelity_bundle.js'), 'build', pakB, MODULES],
        { env: Object.assign({}, clean, { SR_SHADER_PAK: gameCopy, SR_STATE_DIR: state, SR_DUMP_DIR: dumpB, SR_SETS_DIR: path.join(state, 'sets') }), stdio: ['ignore', 'pipe', 'inherit'] }).toString();
    const a = sha(pakA), b = sha(pakB), as = sha(pakA + '.stock'), bs = sha(pakB + '.stock');
    console.log(name.padEnd(12) + 'shader.pak dev ' + a.slice(0, 8) + ', package ' + b.slice(0, 8) + (a === b ? ' EQUAL' : ' DIFFER') +
        '; stock twins ' + (as === bs ? 'EQUAL' : 'DIFFER') + '; the installed pak ' + INSTALLED + (b.startsWith(INSTALLED) ? ': SAME' : ': not the same') +
        '  (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
    console.log('            ' + la.split('\n')[0].replace(/; sha256 .*/, '').slice(0, 600));
    if (la.split('\n')[0] !== lb.split('\n')[0]) console.log('            package said: ' + lb.split('\n')[0].slice(0, 600));
    for (const f of [pakA, pakB, pakA + '.stock', pakB + '.stock']) fs.unlinkSync(f);
}
