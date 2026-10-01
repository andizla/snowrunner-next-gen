// File-access tracer for the package's runtime closure: loaded into every node process with NODE_OPTIONS=--require,
// appends "op<TAB>path" lines to TRACE_FILE for every file the process opens, reads, lists, stats or requires.
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const out = process.env.TRACE_FILE;
if (out) {
    const append = fs.appendFileSync.bind(fs), me = path.basename(process.argv[1] || 'node');
    const log = (op, p) => { try { if (typeof p === 'string' || Buffer.isBuffer(p)) append(out, op + '\t' + path.resolve(String(p)) + '\t' + me + '\n'); } catch (e) {} };
    for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'createReadStream', 'copyFileSync', 'open', 'readFile', 'readdir', 'stat'])
    {
        const orig = fs[name];
        if (typeof orig !== 'function') continue;
        fs[name] = function (p, ...rest) { log(name, p); return orig.call(this, p, ...rest); };
    }
    if (fs.promises) for (const name of ['readFile', 'open', 'readdir', 'stat'])
    {
        const orig = fs.promises[name];
        if (typeof orig === 'function') fs.promises[name] = function (p, ...rest) { log('p.' + name, p); return orig.call(this, p, ...rest); };
    }
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, ...rest) { const r = resolve.call(this, request, parent, ...rest); if (path.isAbsolute(r)) log('require', r); return r; };
}
