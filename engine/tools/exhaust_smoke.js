// SPDX-License-Identifier: GPL-3.0-only
// Exhaust size and opacity, rendered from the kept initial.pak on every build. No separate baseline or XML rewrite.
'use strict';
const NAMES = ['exhaust_small', 'exhaust_large', 'exhaust_fog', 'exhaust_heat_winter'];
const ENTRY = /^\[media\][\\/]classes[\\/]particles[\\/](exhaust_small|exhaust_large|exhaust_fog|exhaust_heat_winter)\.xml$/i;
const NUMBER = '[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
const SIZE = new RegExp('^\\(\\s*(' + NUMBER + ')\\s*;\\s*(' + NUMBER + ')\\s*;\\s*(' + NUMBER + ')\\s*\\)$');
const COLOR = new RegExp('^g\\(\\s*(' + NUMBER + ')\\s*;\\s*(' + NUMBER + ')\\s*;\\s*(' + NUMBER + ')\\s*;\\s*(' + NUMBER + ')\\s*\\)\\s*(?:x\\s*(' + NUMBER + '))?\\s*$');
const NUMBERS = new RegExp(NUMBER, 'g');

function exhaustSpec(value)
{
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') throw new Error('exhaust strength must be 0 to 300 in steps of 10');
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 300 || n % 10) throw new Error('exhaust strength must be 0 to 300 in steps of 10');
    return n;
}
const exhaustName = (name) => { const m = ENTRY.exec(name); return m ? m[1].toLowerCase() : null; };
const finite = (s) => { const n = Number(s); if (!Number.isFinite(n) || n < 0) throw new Error('exhaust values must be finite and nonnegative'); return n; };

// Only attribute spans are replaced. Comments, quotation marks, line endings, RGB and colour multipliers survive.
function exhaustEdit(text, percent)
{
    percent = exhaustSpec(percent);
    const stack = [], edits = [];
    let pos = 0, roots = 0, sizes = 0, colors = 0, keys = 0, lastAt = -1;
    const fail = () => { throw new Error('unsupported exhaust XML: expected one CombineParticles, Size Function and Color with ordered Key values'); };
    const token = /<!--[^]*?-->|<\?[^]*?\?>|<\/?[A-Za-z_][\w.-]*(?:\s+[A-Za-z_][\w.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>/y;
    const change = (attr, pattern, indices) =>
    {
        if (!attr || !pattern.test(attr.value)) fail();
        const nums = [...attr.value.matchAll(NUMBERS)];
        nums.forEach((m) => finite(m[0]));
        for (const i of indices)
        {
            const m = nums[i], value = finite(m[0]) * (percent / 100);
            if (!Number.isFinite(value)) throw new Error('scaled exhaust value exceeds the numeric range');
            if (percent !== 100) edits.push({ start: attr.start + m.index, end: attr.start + m.index + m[0].length, value: String(value) });
        }
    };
    while (pos < text.length)
    {
        const next = text.indexOf('<', pos), end = next < 0 ? text.length : next;
        if (!stack.length && text.slice(pos, end).trim()) fail();
        if (next < 0) break;
        token.lastIndex = next;
        const m = token.exec(text);
        if (!m) fail();
        const tag = m[0];
        pos = token.lastIndex;
        if (tag.startsWith('<!--') || tag.startsWith('<?')) continue;
        const name = /^<\/?([\w.-]+)/.exec(tag)[1];
        if (tag.startsWith('</'))
        {
            if (!/^<\/[\w.-]+\s*>$/.test(tag) || stack.pop() !== name) fail();
            continue;
        }
        if (!stack.length && (++roots !== 1 || name !== 'CombineParticles')) fail();
        const attrs = {};
        for (const a of tag.matchAll(/([\w.-]+)\s*=\s*(["'])(.*?)\2/gs))
        {
            if (Object.hasOwn(attrs, a[1])) fail();
            attrs[a[1]] = { value: a[3], start: next + a.index + a[0].indexOf(a[2]) + 1 };
        }
        const here = stack.concat(name).join('/');
        if (here === 'CombineParticles/Size') { sizes++; change(attrs.Function, SIZE, [0, 1, 2]); }
        if (here === 'CombineParticles/Color') { colors++; if (attrs.Value) fail(); }
        if (here === 'CombineParticles/Color/Key')
        {
            if (!attrs.At || !new RegExp('^' + NUMBER + '$').test(attrs.At.value)) fail();
            const at = finite(attrs.At.value);
            if (at <= lastAt) fail();
            lastAt = at; keys++;
            change(attrs.Value, COLOR, [3]);
        }
        if (!tag.endsWith('/>')) stack.push(name);
    }
    if (stack.length || roots !== 1 || sizes !== 1 || colors !== 1 || !keys) fail();
    let out = text;
    for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.value + out.slice(e.end);
    return { out, notes: out === text ? [] : ['exhaust size and opacity ' + percent + ' %'] };
}
module.exports = { exhaustSpec, exhaustName, exhaustEdit, NAMES };
