// SPDX-License-Identifier: GPL-3.0-only
// Attribute-only exhaust edits, including the lexical forms accepted by the standalone tuner.
'use strict';
const assert = require('assert/strict'), path = require('path');
const tool = require(path.join(process.argv[2] || path.join(__dirname, '../engine/tools'), 'exhaust_smoke.js'));
const sample = `<CombineParticles Wind="(0.05; 0.1; 0)">
    <!-- <Size Function="(99; 99; 99)" /> -->
    <Size Median='0.5' Function='(1.40; 2.20; 2.60)' />
    <LifeTime Value="4" Random="2.0" />
    <Color>
        <Key At="0.0" Value="g(119; 150; 184; 0)" />
        <Key At="0.1" Value="g(119; 150; 184; 400) x 4" />
        <Key At="0.6" Value="g(119; 150; 184; 600) x 4" />
        <Key At="1.0" Value="g(119; 150; 184; 800) x 4" />
    </Color>
</CombineParticles>
`.replace(/\n/g, '\r\r\n');
for (let percent = 0; percent <= 300; percent += 10)
{
    const out = tool.exhaustEdit(sample, percent).out, f = percent / 100;
    assert.equal(out.match(/Function='([^']+)'/g)[0], "Function='(" + (percent === 100 ? '1.40; 2.20; 2.60' : [1.4, 2.2, 2.6].map((n) => String(n * f)).join('; ')) + ")'");
    for (const n of [0, 400, 600, 800]) assert.ok(out.includes('g(119; 150; 184; ' + n * f + ')'));
    const strip = (t) => t.replace(/Function='[^']*'/g, 'Function').replace(/(g\(119; 150; 184; )[^)]+/g, '$1alpha');
    assert.equal(strip(out), strip(sample), 'unrelated bytes at ' + percent);
    if (percent === 100) assert.equal(out, sample);
}
const lexical = sample.replace('(1.40; 2.20; 2.60)', '(+1e-6; .5; 2.)').replace('184; 400', '184; 4e2');
assert.ok(tool.exhaustEdit(lexical, 200).out.includes('(0.000002; 1; 4)'));
assert.ok(tool.exhaustEdit(lexical, 200).out.includes('184; 800) x 4'));
for (const value of [-10, 310, 15, NaN, Infinity, '', ' ', null, undefined, true, {}, []]) assert.throws(() => tool.exhaustSpec(value));
for (const bad of [
    sample.replace(" Function='(1.40; 2.20; 2.60)'", ''),
    sample.replace('2.60', 'NaN'), sample.replace('2.60', '-1'), sample.replace('2.60', '1e999'),
    sample.replace('184; 400', '184; -400'), sample.replace('x 4', 'x -4'),
    sample.replace('<Color>', '<Color Value="g(1; 1; 1; 1)">'),
    sample.replace('At="0.1"', 'At="0.0"'), sample.replace('At="0.1"', 'At="bad"'),
    sample.replace('</Color>', '</Bad>'), sample + '<Other />', sample.replace('</CombineParticles>', ''),
    sample.replace('<Size Median=', '<Size Other="a" Other="b" Median='),
    sample.replace('<LifeTime', '<Bad:LifeTime'), sample.replace('<Color>', '<Size Function="(1; 2; 3)" /><Color>'),
]) assert.throws(() => tool.exhaustEdit(bad, 150), bad);
assert.throws(() => tool.exhaustEdit(sample.replace('2.60', '1e308'), 300));
assert.equal(tool.exhaustEdit(sample.replace('2.60', '1e308'), 100).out, sample.replace('2.60', '1e308'));
assert.ok(tool.exhaustEdit(sample.replace('1.40', '1e-20'), 10).out.includes('1e-21'));
for (const name of tool.NAMES)
{
    assert.equal(tool.exhaustName('[media]\\classes\\particles\\' + name + '.xml'), name);
    assert.equal(tool.exhaustName('[MEDIA]/classes/particles/' + name.toUpperCase() + '.XML'), name);
}
for (const name of ['exhaust_heat', 'dust_small', 'exhaust_small_extra']) assert.equal(tool.exhaustName('[media]/classes/particles/' + name + '.xml'), null);
console.log('all passed');
