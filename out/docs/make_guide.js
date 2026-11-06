// The Next Gen guide as a PDF: a part for beginners written here, and the cards in depth from catalog.json (the window's
// own cards, rows and help texts, dumped by dump_catalog.ps1), printed by Edge. usage: node make_guide.js [--lang ru] [--pack]
// Writes guide.html and SnowRunner_Next_Gen_Guide.pdf next to this file; with --lang ru, guide_ru.html and
// SnowRunner_Next_Gen_Guide_RU.pdf from the Russian texts in ru\:
//   ru\strings.json  { key: { en, ru } }: every short text (the cards' descriptions and help, the window's How it works,
//                    headings and labels), with the English it was translated from
//   ru\part1.html, ru\intro.html, ru\files.html, ru\credits.html: the hand-written parts ({{on}}, {{off}}, {{table}} filled in)
//   ru\tech\*.html  the chapters of part 4, the same names and h2 ids as tech\
//   ru\sources.json  { file: sha256 of the English it was translated from } for the files above
// The card names, their rows and values stay in English, as the window shows them. The Russian build stops when an
// English text changed since its translation (or has none), naming each, so a change brings its Russian text along.
// --pack: writes ru\ for a translator instead: strings.json with every English text (ru left empty where none is
// current), and each part or chapter without a current Russian file as <name>.en to translate.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const here = __dirname, cat = JSON.parse(fs.readFileSync(path.join(here, 'catalog.json'), 'utf8').replace(/^\uFEFF/, ''));
const RU = process.argv.includes('--lang') && process.argv[process.argv.indexOf('--lang') + 1] === 'ru', PACK = process.argv.includes('--pack');
const ruDir = path.join(here, 'ru'), sha = (t) => crypto.createHash('sha256').update(t.replace(/\r\n/g, '\n')).digest('hex');
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : d);
const strings = readJson(path.join(ruDir, 'strings.json'), {}), sources = readJson(path.join(ruDir, 'sources.json'), {});
const used = {}, usedFiles = {}, stale = [];
// T(key, en): the English, or in the Russian build its translation
const T = (key, en) =>
{
    used[key] = en;
    if (!RU || PACK) return en;
    const s = strings[key];
    if (!s || !s.ru) { stale.push(key + ': no Russian text'); return en; }
    if (s.en !== en) stale.push(key + ': the English changed since it was translated');
    return s.ru;
};
// F(name, en): a hand-written part or a chapter, the English text or in the Russian build the file ru\<name>
const F = (name, en) =>
{
    usedFiles[name] = en;
    if (!RU || PACK) return en;
    const file = path.join(ruDir, name);
    if (!fs.existsSync(file)) { stale.push(name + ': no Russian file'); return en; }
    if (sources[name] !== sha(en)) stale.push(name + ': the English changed since it was translated');
    return fs.readFileSync(file, 'utf8');
};
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug = (s) => 'c-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
const titleOf = (id) => (cat.modules.find((m) => m.id === id) || { title: id }).title;
const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();
const groups = [...new Set(cat.modules.map((m) => m.group))];
const on = cat.modules.filter((m) => m.on), off = cat.modules.filter((m) => !m.on);
// part 4, how it works in depth: the hand-written chapters in tech\, in name order, each opening with <h2 id="...">
const techDir = path.join(here, 'tech');
const techHtml = fs.existsSync(techDir) ? fs.readdirSync(techDir).filter((f) => /\.html$/.test(f)).sort().map((f) => F('tech/' + f, fs.readFileSync(path.join(techDir, f), 'utf8'))).join('\n') : '';
const techToc = [...techHtml.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)].map((m) => [m[1], m[2]]);
// each card's chapters in part 4 (by their h2 id; a chapter not written yet is left out)
const DEEP = {
    shadows: ['t-found', 't-shadowmap'], edges: ['t-shadowmap'], blocker: ['t-shadowmap'], contact: ['t-contact'], headshadow: ['t-headshadow'], gtao: ['t-gtao'], aofar: ['t-gtao'],
    ambient: ['t-ambient'], fill: ['t-ambient'], gi: ['t-gi'], objrefl: ['t-sssr'], headglow: ['t-headglow'], water: ['t-water'], puddles: ['t-puddles'],
    rivertint: ['t-water'], crestglow: ['t-water'], glare: ['t-puddles'], cubes: ['t-cubes'], fog: ['t-fog'], weather: ['t-weather'], maps: ['t-maps', 't-loadlist'],
    smoke: ['t-smoke'], smokeshade: ['t-smoke'], particles: ['t-particles'], debris: ['t-weather'], sky: ['t-sky'], skies: ['t-sky'], stars: ['t-sky'],
    tonemap: ['t-tonemap'], bloom: ['t-tonemap'], grade: ['t-tonemap'], scenery: ['t-scenery'], grass: ['t-scenery'], logos: ['t-interface'],
};

function table()
{
    let h = '<table class="cards"><thead><tr><th>' + T('ui.card', 'Card') + '</th><th>' + T('ui.default', 'Default') + '</th><th>' + T('ui.whatitdoes', 'What it does') + '</th></tr></thead><tbody>';
    for (const g of groups)
    {
        h += '<tr class="grp"><td colspan="3">' + esc(g) + '</td></tr>';
        for (const m of cat.modules.filter((x) => x.group === g))
            h += '<tr><td><a href="#' + slug(m.id) + '">' + esc(m.title) + '</a></td><td class="' + (m.on ? 'on' : 'off') + '">' + (m.on ? T('ui.on', 'on') : T('ui.off', 'off')) + '</td><td>' + esc(T('card.' + m.id + '.description', m.description)) + '</td></tr>';
    }
    return h + '</tbody></table>';
}

// ---- part 1, by hand: what it is, how to put it in, what to switch on
const fill = (t) => t.replace(/\{\{on\}\}/g, on.length).replace(/\{\{off\}\}/g, off.length).replace(/\{\{table\}\}/g, table());
const dummies = fill(F('part1.html', `
<p class="lead">This part is for everyone: what Next Gen does, how to put it in and what to switch on. Part 3 has a page for
every card in the same plain words; Part 4 explains how each one works, with the math.</p>
<h2 id="p1-what">What Next Gen is</h2>
<p>Next Gen is a free graphics mod for SnowRunner. A small program, <b>SnowRunnerNextGen.exe</b>, changes a few of the
game's own files on your PC: the shaders that draw light, shadow, water and smoke, and some of the game's pictures and
settings. The game then draws sharper shadows, shade where things meet, reflections on paint and water, fog that glows
toward the sun, smoke with a lit side and a truer night sky.</p>
<p>Apart from one small DLL, SnowRunner Shadows, nothing runs next to the game. You do not need ReShade or any other
loader, and the program keeps a copy of every file it changes, so you can always go back.</p>

<h2 id="p1-need">What you need</h2>
<ul>
<li>SnowRunner from Steam, Epic Games or the Microsoft Store, on Windows.</li>
<li>Room on the system drive for the copies of the original files: up to about 4 GB, depending on what you switch on.
shared.pak alone is 2 GB, and only the Scenery detail card changes it.</li>
<li>The game closed while you install, change or remove anything. The program will not write while it runs. A game started
during an Apply stops it: close the game and click Apply again, the parts already done stay in.</li>
</ul>

<h2 id="p1-install">Put it in, step by step</h2>
<ol class="steps">
<li>Download the newest zip and the sky pack, <b>SnowRunnerNextGen_Skies.zip</b>, from the project's releases page,
<b>github.com/andizla/snowrunner-next-gen/releases</b>.</li>
<li>Close SnowRunner.</li>
<li>Unzip the folder anywhere, your desktop for example, unzip the sky pack into the same folder, and run
<b>SnowRunnerNextGen.exe</b>. Nothing else needs to be installed.</li>
<li>The bar at the top shows the game folder the program found. If it found none, or the wrong one, click <b>Change</b> and
pick the folder that holds SnowRunner.</li>
<li>Click <b>Defaults</b>, then <b>Apply</b>. The first Apply reads your game's own shaders and takes a minute or two. A
window then says Installed.</li>
<li>Start the game.</li>
</ol>
<p>To update, unzip the new version and its sky pack into a folder of their own and click <b>Apply</b>: an install made with
an older version is updated in place. The window shows what is installed, so a card that is new in this version starts
unticked; <b>Defaults</b> ticks every card as it comes.</p>

<h2 id="p1-switch">What to switch on</h2>
<p><b>Defaults</b> gives you the recommended set: the {{on}} cards marked "on" in the table below. Start with it
and play for a while.</p>
<p>The {{off}} cards that are off by default are off for a reason: they are experimental, a matter of taste, or they
cost more frame rate. Each has its own page in Part 3 that says what it does, what you will notice and what it costs.
Switch one on, click Apply, and look in the game. With SnowRunner Shadows in, <b>F8</b> switches every shader effect off
and on, so you can compare from the same spot.</p>
<p>Some cards have rows of buttons: a resolution, a strength, or which maps a change applies to. The values a card starts
with are the recommended ones. Part 3 lists every row with its values.</p>
{{table}}

<h2 id="p1-change">Change your mind, or take it all out</h2>
<p>Tick or untick cards and click <b>Apply</b> again: the program builds the files for exactly what is ticked, every time
from the game's original files. <b>Restore originals</b> puts every file back as it was before Next Gen changed it and
takes SnowRunner Shadows out. The copies of the original files stay in <b>%LOCALAPPDATA%\\SnowRunnerNextGen</b> (2 to 4 GB):
to remove Next Gen for good, delete that folder by hand after Restore.</p>

<h2 id="p1-update">After a game update</h2>
<p>A game update, or the store's check of the game files, puts the game's own files back, and Next Gen's changes are gone
with them. Run SnowRunnerNextGen.exe and click <b>Apply</b> again.</p>
<p>One card needs this sooner than the others: with Map days set to "map by map" for Maine, Maine stops loading after such
an update until you have run Apply again. The card's page says why.</p>

<h2 id="p1-mods">Other mods</h2>
<p>If another mod, a texture pack say, has changed one of the files Next Gen works on, the program asks before it writes.
<b>Take it as the original</b>: Next Gen writes its changes over the file as it is now, and Restore later puts that
modded state back. <b>Leave it out</b>: that file and its cards stay as they are, and the rest is applied.</p>

<h2 id="p1-wrong">When something goes wrong</h2>
<p>Every Apply and Restore is written to <b>install.log</b> in <b>%LOCALAPPDATA%\\SnowRunnerNextGen</b>: what the program
found and each step it took. In the result window, <b>Show the log</b> opens that folder. Send the file along when you
report a problem.</p>
<p>Support, questions and talk about the mod: the channel on <a href="https://discord.com/invite/MssDb2Pvcj">EnthusiastRunner's
Discord</a>, with thanks to EnthusiastRunner for it.</p>`));

// ---- part 2: the window, from the program's own "How it works"
const installer = '<p class="lead">' + esc(T('installer.summary', cat.installer.summary)) + '</p>' + cat.installer.sections.map((s, i) => '<h3>' + esc(T('installer.' + i + '.heading', s.heading)) + '</h3><p>' + esc(T('installer.' + i + '.text', s.text)) + '</p>').join('');

// ---- part 3: every card, from the program's own texts
function card(m)
{
    let h = '<section class="card" id="' + slug(m.id) + '"><h3>' + esc(m.title) + '</h3>';
    const deep = (DEEP[m.id] || []).filter((id) => techHtml.includes('id="' + id + '"'));
    h += '<p class="meta">' + esc(cap(m.category)) + ' &middot; ' + (m.on ? T('ui.onbydefault', 'on by default') : T('ui.offbydefault', 'off by default')) + (m.requires.length ? ' &middot; ' + T('ui.needs', 'needs') + ' ' + m.requires.map((r) => '<a href="#' + slug(r) + '">' + esc(titleOf(r)) + '</a>').join(', ') : '') +
        (deep.length ? ' &middot; ' + T('ui.indepth', 'in depth:') + ' ' + deep.map((id) => '<a href="#' + id + '">' + esc((techHtml.match(new RegExp('<h2 id="' + id + '">([^<]+)<')) || [])[1] || id) + '</a>').join(', ') : '') + '</p>';
    h += '<p class="lead">' + esc(T('card.' + m.id + '.description', m.description)) + '</p>';
    if (m.options.length)
    {
        h += '<table class="rows"><thead><tr><th>' + T('ui.row', 'Row') + '</th><th>' + T('ui.values', 'Values (the default in bold)') + '</th></tr></thead><tbody>';
        for (const o of m.options) h += '<tr><td>' + esc(o.name) + '</td><td>' + o.labels.map((l, i) => (i === o.default ? '<b>' + esc(l) + '</b>' : esc(l))).join(' &middot; ') + '</td></tr>';
        h += '</tbody></table>';
    }
    m.help.forEach((s, i) => { h += '<h4>' + esc(T('heading.' + s.heading, s.heading)) + '</h4><p>' + esc(T('card.' + m.id + '.help.' + i, s.text)) + '</p>'; });
    return h + '</section>';
}
const cards = groups.map((g) => '<h2 class="group" id="' + slug('g ' + g) + '">' + esc(g) + '</h2>' + cat.modules.filter((m) => m.group === g).map(card).join('')).join('');
const techIntro = F('intro.html', '<p class="lead">This part explains how each card works: the technique from first principles, the formulas and numbers it uses, ' +
    'the passes and buffers it reads and writes, what the patch changes in the game and why, what it costs and where it falls short. ' +
    'The numbers are the ones in the code; where a knob of SnowRunnerShadows.ini sets one, its name is given.</p>');

// ---- part 4: the files
const files = F('files.html', `
<p>All under the game's <b>preload\\paks\\client</b> folder, and only those that a ticked card needs:</p>
<table class="rows"><thead><tr><th>File</th><th>What Next Gen puts in it</th></tr></thead><tbody>
<tr><td>shader.pak</td><td>the shader modules: shadows, occlusion, light, reflections, water, fog, smoke, the tonemap</td></tr>
<tr><td>shared.pak</td><td>Scenery detail</td></tr>
<tr><td>initial.pak</td><td>Grass reach, the fill light, Brighter stars, Weather, Debris and splashes, and Maine's own days (Map days, map by map)</td></tr>
<tr><td>boot.pak</td><td>Photo grade, Sharper smoke and particles, Night sky, Reflection cubes, Winter skies</td></tr>
<tr><td>gfx.pak</td><td>Next Gen logo, and the start without the intro</td></tr>
<tr><td>level files</td><td>with Map days, a few names in the level files of Maine, British Columbia, Austria and Washington, changed in place</td></tr>
</tbody></table>
<p>In the folder with SnowRunner.exe (Sources\\Bin on Steam): <b>hid.dll</b>, which is SnowRunner Shadows, and its settings,
<b>SnowRunnerShadows.ini</b>. Another mod's hid.dll stays loaded as hid_chain.dll.</p>
<p>The copies of the original files live in <b>%LOCALAPPDATA%\\SnowRunnerNextGen</b>. Every new file is written next to the
old one, read back and checked before it takes the old one's place. Next to the paks the program leaves a small note,
<b>SnowRunnerNextGen.json</b>, naming the files that hold its changes; Restore originals takes it away.</p>`);

const credits = F('credits.html', `
<p>Next Gen is free software under the GNU General Public License, version 3 (the file LICENSE in the download). The
methods and code it builds on are named in <b>THIRD_PARTY_NOTICES.md</b>, with their authors and licences, and each card's
page above credits the work it uses. The game's files remain Saber Interactive's: Next Gen changes them on your PC and
ships none of them, apart from the few textures the notices name.</p>`);

const parts = [
    ['p1', T('part.p1', 'Part 1. Next Gen for dummies'), dummies, [['p1-what', 'What Next Gen is'], ['p1-need', 'What you need'], ['p1-install', 'Put it in, step by step'], ['p1-switch', 'What to switch on'], ['p1-change', 'Change your mind, or take it all out'], ['p1-update', 'After a game update'], ['p1-mods', 'Other mods'], ['p1-wrong', 'When something goes wrong']].map(([id, t]) => [id, T('toc.' + id, t)])],
    ['p2', T('part.p2', 'Part 2. The window'), installer, []],
    ['p3', T('part.p3', 'Part 3. Every card at a glance'), cards, groups.map((g) => [slug('g ' + g), g])],
    ['p4', T('part.p4', 'Part 4. How it works, in depth'), techIntro + '<div class="tech">' + techHtml + '</div>', techToc],
    ['p5', T('part.p5', 'Part 5. What it changes on your PC'), files, []],
    ['p6', T('part.p6', 'Part 6. Licence and credits'), credits, []],
];
const toc = '<ol class="toc">' + parts.map(([id, t, , subs]) => '<li><a href="#' + id + '">' + esc(t) + '</a>' + (subs.length ? '<ol>' + subs.map(([sid, st]) => '<li><a href="#' + sid + '">' + esc(st) + '</a></li>').join('') + '</ol>' : '') + '</li>').join('') + '</ol>';

const css = `
@page { size: A4; margin: 18mm 17mm 18mm 17mm; }
body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.3pt; line-height: 1.45; color: #1b2229; }
h1 { font-size: 30pt; margin: 0; color: #12324a; letter-spacing: 0.5pt; }
h2 { font-size: 15pt; color: #12324a; margin: 18pt 0 6pt; border-bottom: 1.2pt solid #d5dde4; padding-bottom: 3pt; }
h2.part { font-size: 20pt; border: none; margin-top: 0; }
h2.group { page-break-before: always; font-size: 16pt; color: #8a4b12; border-bottom-color: #ead9c6; }
h3 { font-size: 12.5pt; color: #12324a; margin: 12pt 0 3pt; }
h4 { font-size: 10pt; color: #44515c; margin: 7pt 0 1pt; text-transform: uppercase; letter-spacing: 0.4pt; }
p { margin: 3pt 0 6pt; }
a { color: #1d5d8c; text-decoration: none; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: center; }
.cover .sub { font-size: 15pt; color: #44515c; margin-top: 6pt; }
.cover .ed { font-size: 10pt; color: #6b7883; margin-top: 30pt; }
.partpage { page-break-before: always; }
.lead { font-size: 10.8pt; color: #26313a; }
.meta { color: #6b7883; font-size: 9pt; margin: 0 0 4pt; }
.card { page-break-inside: avoid; border-left: 3pt solid #d5dde4; padding: 1pt 0 2pt 9pt; margin: 10pt 0 14pt; }
.card h3 { margin-top: 2pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9.3pt; }
th { text-align: left; background: #eef2f5; color: #12324a; padding: 3pt 5pt; border-bottom: 1pt solid #c9d3db; }
td { padding: 3pt 5pt; border-bottom: 0.6pt solid #e3e8ec; vertical-align: top; }
tr.grp td { background: #f7f2ec; color: #8a4b12; font-weight: 600; }
td.on { color: #1f6b3a; font-weight: 600; } td.off { color: #8a8f94; }
table.cards tr { page-break-inside: avoid; }
ol.steps li { margin-bottom: 4pt; }
ol.toc { padding-left: 16pt; } ol.toc > li { margin: 6pt 0; font-weight: 600; } ol.toc ol { font-weight: 400; margin: 2pt 0; }
.tech h2 { page-break-before: always; }
.tech h3 { margin-top: 14pt; }
.eq { font-family: "Cambria Math", Cambria, "Times New Roman", serif; font-size: 11.5pt; background: #f6f8fa; border-left: 2.5pt solid #9fb0bd; padding: 5pt 10pt; margin: 6pt 0 9pt; page-break-inside: avoid; }
figure { margin: 10pt 0 12pt; page-break-inside: avoid; } figure svg { width: 100%; height: auto; }
figcaption { font-size: 9pt; color: #6b7883; margin-top: 3pt; }
.tech table, .tech ul, .tech ol { page-break-inside: avoid; }`;

const nRows = cat.modules.reduce((a, m) => a + m.options.length, 0);
const html = '<!doctype html><html' + (RU ? ' lang="ru"' : '') + '><head><meta charset="utf-8"><title>' + esc(T('ui.title', 'Next Gen Graphics: the guide')) + '</title><style>' + css + '</style></head><body>' +
    '<div class="cover"><h1>Next Gen Graphics</h1><div class="sub">' + esc(T('ui.sub', 'for SnowRunner (SnowRunner Next Gen before October 2026). The guide: for beginners, and every card in depth')) + '</div>' +
    '<div class="ed">' + esc(T('ui.edition', 'For Next Gen 1.0.2 and the changes since. The card texts are the program\'s own, from the build of {built}.').replace('{built}', cat.built)) + '<br>' +
    esc(T('ui.count', '{cards} cards, {rows} rows of options.').replace('{cards}', cat.modules.length).replace('{rows}', nRows)) + '</div></div>' +
    '<div class="partpage"><h2 class="part">' + T('ui.contents', 'Contents') + '</h2>' + toc + '</div>' +
    parts.map(([id, t, body]) => '<div class="partpage"><h2 class="part" id="' + id + '">' + esc(t) + '</h2>' + body + '</div>').join('') + '</body></html>';

if (PACK)
{
    // the translator's pack: every English text, the Russian kept where it is still current
    fs.mkdirSync(path.join(ruDir, 'tech'), { recursive: true });
    const out = {};
    for (const [k, en] of Object.entries(used)) out[k] = { en, ru: strings[k] && strings[k].en === en ? strings[k].ru : '' };
    fs.writeFileSync(path.join(ruDir, 'strings.json'), JSON.stringify(out, null, 1) + '\n');
    const todo = [];
    for (const [name, en] of Object.entries(usedFiles))
        if (!fs.existsSync(path.join(ruDir, name)) || sources[name] !== sha(en))         {
            // a Russian file of an older English goes aside as .old, so the build sees none until the new one is in
            const ru = path.join(ruDir, name);
            if (fs.existsSync(ru)) fs.renameSync(ru, ru + '.old');
            fs.writeFileSync(ru + '.en', en); todo.push(name); sources[name] = sha(en);
        }
    // the hashes of the English handed out: a Russian file made from it counts as current until that English changes
    fs.writeFileSync(path.join(ruDir, 'sources.json'), JSON.stringify(sources, null, 1) + '\n');
    console.log('ru\\strings.json: ' + Object.keys(out).length + ' texts, ' + Object.values(out).filter((v) => !v.ru).length + ' to translate; files to translate (the English beside each as .en): ' + (todo.join(', ') || 'none'));
    process.exit(0);
}
if (RU && stale.length) throw new Error('the Russian guide is not up to date:\n  ' + stale.join('\n  '));
if (/\u2014/.test(html)) throw new Error('an em dash is in the text');
const htmlFile = path.join(here, RU ? 'guide_ru.html' : 'guide.html'), pdf = path.join(here, RU ? 'SnowRunner_Next_Gen_Guide_RU.pdf' : 'SnowRunner_Next_Gen_Guide.pdf');
fs.writeFileSync(htmlFile, html);
execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf-no-header', '--print-to-pdf=' + pdf, 'file:///' + htmlFile.replace(/\\/g, '/')], { stdio: 'ignore', timeout: 120000 });
console.log(pdf + ': ' + fs.statSync(pdf).size + ' bytes; ' + cat.modules.length + ' cards');
