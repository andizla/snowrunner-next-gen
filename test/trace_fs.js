// File-access tracer for the package's runtime closure: loaded into every node process with NODE_OPTIONS=--require,
// appends "op<TAB>path" lines to TRACE_FILE for every file the process opens, reads, lists, stats or requires, and for
// every file or folder it writes, renames (both names), copies to, deletes or makes (review 3, T3: renames, deletes and
// new folders went unseen).
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const out = process.env.TRACE_FILE;
if (out) {
    const append = fs.appendFileSync.bind(fs), me = path.basename(process.argv[1] || 'node');
    // never while a line is being written: Node's appendFileSync calls fs.writeFileSync, which is traced too, and each
    // line set off another until the stack ran out (a 32 GB trace of the trace, 2026-10-23)
    let busy = false;
    const log = (op, p) =>
    {
        if (busy) return;
        busy = true;
        try { if (typeof p === 'string' || Buffer.isBuffer(p)) append(out, op + '\t' + path.resolve(String(p)) + '\t' + me + '\n'); }
        catch (e) {}
        finally { busy = false; }
    };
    // the calls with a second path (rename, copy, link) log both
    const two = new Set(['copyFileSync', 'renameSync', 'cpSync', 'linkSync', 'symlinkSync', 'copyFile', 'rename']);
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'copyFileSync', 'open', 'readFile', 'readdir', 'stat',
        'writeFileSync', 'appendFileSync', 'createWriteStream', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'truncateSync', 'cpSync', 'linkSync', 'symlinkSync',
        'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'copyFile'])
    {
        const orig = fs[name];
        if (typeof orig !== 'function') continue;
        fs[name] = function (p, ...rest) { log(name, p); if (two.has(name)) log(name + '.to', rest[0]); return orig.call(this, p, ...rest); };
    }
    if (fs.promises) for (const name of ['readFile', 'open', 'readdir', 'stat', 'writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'mkdir', 'copyFile'])
    {
        const orig = fs.promises[name];
        if (typeof orig === 'function') fs.promises[name] = function (p, ...rest) { log('p.' + name, p); if (name === 'rename' || name === 'copyFile') log('p.' + name + '.to', rest[0]); return orig.call(this, p, ...rest); };
    }
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) { const r = resolve.call(this, request, parent, ...rest); if (path.isAbsolute(r)) log('require', r); return r; };
}
