// Builds SnowRunner's shader.pak with the chosen fidelity modules, always from the original (pak_backup\shader.pak.orig),
// and installs it. Modules and where their shaders come from (replacements\):
//   gtao     ssao_builds\gtao_hq                      main cache: 0xEA2414F8, 0xA3716E2B (ground truth AO)
//   aofar    ssao_builds\gtao_hq_far, gi\gtao_gi_far.cso: the same pass with the far reach (AO_FAR=1: each direction's
//            search goes on to 6 m, and what it finds there raises the horizon only part of the way: soft shade under
//            trucks, roofs and tree crowns, contact shadows unchanged); implies gtao; in DEFAULT
//   crisp    shadow_filter\hq_grid_crisp              main cache: 1269 material shaders (crisp 16 tap grid filter)
//   revec    shadow_filter\hq_revec                   the same 1269: the revectorized filter, straight shadow edges rebuilt
//            inside the texels (crisp's tent where the penumbra is wide); an alternative to crisp, in DEFAULT instead
//            of it
//   blocker  shadow_filter\hq_blocker                 the same 1269 (blocker search: how soft each shadow edge gets)
//            both on: shadow_filter\hq_crisp_blocker (hq_revec_blocker with revec); "shadows" means crisp + blocker
//   seam     shadow_filter\hq_revec(_blocker)_seam     the same 1269: the cascade seam dither (the last 7 % of each
//            cascade's range takes the next cascade by chance, TAA averages them: no line where the shadow's texels change,
//            15.5 m from the camera); built on revec, which it needs; in DEFAULT
//   ambient  ambient\sky_on_<shadow set in use>       main cache: ~4570 material shaders (sky tinted ambient, built on
//            (ambient\sky with no shadow change)      top of the shadow set in use, so a shader can carry both)
//   fog      fog_builds\jitter_phase                  main cache: 0x871EF8CC (slice jitter + forward scattering)
//   tonemap  tonemap_builds\fidelity                  common_pc_sm50_hdr.sdc: 0x221304E2 (the Next Gen filmic curve, bloom x0.6)
//   bloom    bloom_builds\softknee                    common_pc_sm50_hdr.sdc: 0x52879E18 (soft knee, no haze)
//   water    tools\patch_water_ssr.js + water\ssr.cso main cache: the 20 river and mud water shaders and the 176 lake
//            (the 88 with the planar reflection through tools\patch_water_planar.js + water\ssr_planar.cso: the SSR at
//            their planar sample, the planar image as the fallback; lakes, sea and the road puddles)
//            and sea ("domain") shaders: screen-space reflections instead of the sky cubemap alone (rivers, and the 88
//            lakes and seas without a planar reflection; water\ssr_t5.cso), and tools\patch_water_mix.js +
//            water\blend.cso in all of them (the water's colour gives way to the reflection with Fresnel instead of
//            the reflection being added on top); patched at build time on top of whatever the other modules made of
//            each shader; and tools\patch_refl_hits.js on the engine's own reflection pass (0x44F6CB1D, 0x8E21C0FB), whose
//            image those 88 read: its hit rule without the target's resolution in it, so what stands in the water is
//            mirrored at 3840 x 2160 as at 1920 x 1080 (REFL_HITS, see hitsRule)
//   crestglow tools\patch_water_mix.js patchGlow + water\blend_glow.cso in place of the blend, in the river shaders that
//            sample the sun shadow map (12 of the 20): sunlight through the thin backs of waves in the water's colour,
//            looking into a low sun (implies water; in DEFAULT)
//   rivertint tools\patch_water_mix.js + water\absorb.cso, the same 20: the see-through fade per colour channel, so
//            deeper water tints teal or brown from its own colour instead of fading grey
//   glare    tools\patch_glare.js, main cache: the ~1216 wet-ground shaders (g_txWaterMap): the headlights' highlight
//            capped at 6 instead of 32, so the lamps no longer draw a long bright band across puddles; patched at build
//            time on top of whatever the other modules made of each shader
//   puddles  tools\patch_puddle.js + puddles\puddle_ssr.cso, the same wet-ground shaders (1208): screen-space
//            reflections on wet ground (rough mud too, blurred from the feed's mips) from the previous frame's scene,
//            which SnowRunner Shadows (hid.dll, Feed=1) binds at t120/t121; without that DLL they keep the sky
//            reflection as before. With PUDDLE_DECALS=1 also the water decals (60 of the 105 terrain decals that name
//            g_txWaterNormals), with puddles\puddle_ssr_decal.cso (still-mirror knob PSSR_CALM) on top of what the
//            bounce light made of them; the road puddles are not among those, the water module's planar shaders draw
//            them. In DEFAULT
//   reflections tools\patch_object_ssr.js + reflections\object_ssr.cso: the 3229 vehicle and prop PBR shaders reflect
//            the previous frame's scene (SnowRunner Shadows' feed, t120/t121) at their cubemap sample where a glossy pixel's
//            mirrored ray hits something on screen (paint, glass, chrome), the cubemap elsewhere
//   smoke    tools\patch_smoke.js + smoke\smoke_glow.cso: the particle vertex shaders (exhaust, dust, steam, smoke):
//            sunlight scattered forward through a puff, so smoke between the eye and the sun glows; in DEFAULT
//   smokeshade tools\patch_smoke_ps.js + smoke\smoke_shade.cso: the particle sprite pixel shaders: the 80 lit, blended
//            puffs without a normal map of their own get a lit side, a shaded side, lighter tops and denser cores
//            (a pseudo-normal from the puff's alpha), and the 110 that fade against the depth fade over twice the
//            distance (SMOKE_SOFT 0.5), so puffs meet the ground without a hard line; in DEFAULT
//   contact  tools\patch_contact.js: the 1269 sun shadow receivers write the sun's visibility they found (after the game's
//            shadow floor) to render target 6, which SnowRunner Shadows (hid.dll Contact=1) binds beside the lit pass and
//            uses for its contact shadows (screen-space sun shadows at the AO pass, darkening each pixel's sunlight; F4);
//            patched last, on top of whatever the other modules made of each receiver; without the DLL the write goes
//            nowhere; in DEFAULT
//   sssr     tools\patch_gbuffer.js + sssr\gbuffer.cso, then tools\patch_object_ssr.js + sssr\object_sssr.cso: the 3229
//            object materials write the reflection pass's G-buffer (render target 7: normal, sqrt roughness) and read
//            the pass's result (SnowRunner Shadows SSR=1: t123 reflections, t124 motion) at their cubemap sample;
//            alternative to 'reflections'; in DEFAULT
//   headglow sssr's reader built with OSSSR_HEADGLOW_ON (sssr\object_sssr_glow.cso): where a mirrored ray finds nothing,
//            the cubemap gets the headlights' light in the air along that ray added to it (the game's own beam: cone,
//            reach and colour from CB_GLOBAL_SCENE), so a hood at night shows the lamps' warm light where its rays cross
//            the beam, not the blue sky alone; needs sssr; with the lamps off or the pass unbound the reader's output
//            is the plain reader's at no cost; with two lamps on it adds 0.15 ms for a whole 4K screen of glossy pixels
//            on an RTX 4080, so far less in a real frame; in DEFAULT
//   gi       bounce light: gi\gtao_gi.cso in the AO pass (GTAO, which it implies, plus the light the surfaces that hide
//            each pixel's sky send it, into a second target SnowRunner Shadows provides, hid.dll GI=1), and
//            tools\patch_gi.js + gi\gi_ambient.cso (gi_only.cso without the ambient module; the _decal builds for the
//            120 terrain decals) in the ~4270 material shaders that read the ambient colours and know their world
//            position: last frame's bounce light added to their ambient light; spliced at build time on the shadow
//            set's version of each shader (the helper carries the sky tint too), ahead of the water and wet-ground
//            splices; without the DLL nothing changes
// Every changed main-cache shader is then checked (tools\dxbc_lint.js) and the build refuses to write a pak when one
// reads an input component its dcl_input does not declare (vN.xyzw on a three-component input): D3D ignores the read,
// NVIDIA's driver (616.92) crashes compiling such a shader.
// The resolution half of the shadows (SnowRunner Shadows, hid.dll) is separate: the DLL and its ini.
// usage: node fidelity_bundle.js install [module,module,...]    default: the DEFAULT list below; game closed
//        node fidelity_bundle.js build <out file> [modules]   the same build written elsewhere, with <out file>.stock
//        (HELPER_VARIANT_PUDDLES=debug, HELPER_VARIANT_GI=debug or HELPER_VARIANT_WATER=debug before either: that effect's diagnostic helper, see
//        helperDir; HELPER_VARIANT=debug both)
//        node fidelity_bundle.js status
//        node fidelity_bundle.js modules      the installed modules as one comma list, "stock" or "unknown"
//        SR_DUMP_DIR (the game's shaders as tools\extract.js writes them, else dump\) and SR_SETS_DIR (the sets built from
//        them: shadow_filter, ambient, fog_builds, tonemap_builds, bloom_builds, else replacements\) let the installer
//        build everything from the player's own shader.pak
const fs = require('fs'), path = require('path');
const pak = require('./pak_shader_patch.js');
const side = require('./sdc_side.js');
const ssr = require('./patch_water_ssr.js');
const mix = require('./patch_water_mix.js');
const clear = require('./patch_water_clear.js');
const planar = require('./patch_water_planar.js');
const hits = require('./patch_refl_hits.js');
const smoke = require('./patch_smoke.js');
const smokeps = require('./patch_smoke_ps.js');
const gbuffer = require('./patch_gbuffer.js');
const objssr = require('./patch_object_ssr.js');
const glare = require('./patch_glare.js');
const puddle = require('./patch_puddle.js');
const gi = require('./patch_gi.js');
const lint = require('./dxbc_lint.js');
const twins = require('./stock_twins.js');
const { dxbcChecksum } = require('./dxbc_patch.js');

const W = path.resolve(__dirname, '..');
const R = (...p) => path.join(W, 'replacements', ...p);
// the sets built from the game's own shaders (shadow filter, ambient, fog, tonemap, bloom): SR_SETS_DIR when the installer
// builds them from the player's shader.pak (same folder names), else replacements\; our own helpers always come from R()
const SETS = process.env.SR_SETS_DIR || path.join(W, 'replacements');
const S = (...p) => path.join(SETS, ...p);
const ALL = ['gtao', 'aofar', 'crisp', 'revec', 'blocker', 'seam', 'ambient', 'fog', 'tonemap', 'bloom', 'water', 'rivertint', 'crestglow', 'glare', 'puddles', 'gi', 'reflections', 'smoke', 'smokeshade', 'sssr', 'headglow', 'contact'];
// what install and build take without a list: every module but these three, which stay selectable by name
//   reflections  the per-material march alone: sssr took its place (the DLL's reflection pass, with that march only
//                where the pass has nothing), and normalize refuses the two together
//   glare        the lower cap on the headlights' highlight on wet ground: off since the reflections were reworked
//   crisp        revec took its place (with it the shadow resolution default is 1x, SnowRunner Shadows' ini Factor=1)
// The fill light and the photo grade, defaults too, live in initial.pak and boot.pak (the installer's cards)
const DEFAULT = ALL.filter((m) => m !== 'reflections' && m !== 'glare' && m !== 'crisp');

// known names in ALL's order, "shadows" (older notes and commands) as crisp + blocker, gtao with gi (the bounce light is
// measured by the GTAO pass); throws on an unknown name
function normalize(list)
{
    const want = new Set();
    for (const m of list)
    {
        if (m === 'shadows') { want.add('crisp'); want.add('blocker'); }
        else if (ALL.includes(m)) want.add(m);
        else throw new Error('unknown module ' + m + ' (known: ' + ALL.join(', ') + ')');
    }
    if (want.has('gi') || want.has('aofar')) want.add('gtao');
    if (want.has('crestglow')) want.add('water');
    if (want.has('sssr') && want.has('reflections')) throw new Error('modules sssr and reflections are alternatives (both replace the object cubemap sample): pick one');
    if (want.has('revec') && want.has('crisp')) throw new Error('modules revec and crisp are alternatives (both replace the sun shadow filter): pick one');
    if (want.has('seam') && !want.has('revec')) throw new Error('module seam (the cascade seam dither) is built on revec: add revec');
    if (want.has('headglow') && !want.has('sssr')) throw new Error('module headglow (the headlights in reflections) is a build of the reflection pass\'s reader: add sssr');
    return ALL.filter((m) => want.has(m));
}
// the GTAO build to install: GTAO_VARIANT names a folder in replacements\ssao_builds (default gtao_hq, the released one;
// gtao_hq_nocap keeps the full radius up close instead of shrinking it inside 12.5 m)
function gtaoVariant()
{
    const v = process.env.GTAO_VARIANT || 'gtao_hq';
    if (!/^[\w-]+$/.test(v) || !fs.existsSync(R('ssao_builds', v, '0xEA2414F8.shader'))) throw new Error('unknown GTAO variant ' + v);
    return v;
}
// the GTAO build as notes and summaries name it: the variant, with the far reach when aofar is in
const gtaoBuild = (modules) => (modules.includes('aofar') ? 'gtao_hq_far' : gtaoVariant());
// the fog build to install: FOG_VARIANT names a folder in replacements\fog_builds (default jitter_phase_sun: the
// sun's light where the shadow map lets it through, tools\patch_fog_sun.js; jitter_phase = the fog without it;
// jitter_phase_sun_debug paints the fog pass green where the shadow map is bound)
const FOG_DEFAULT = 'jitter_phase_sun';
function fogVariant()
{
    const v = process.env.FOG_VARIANT || FOG_DEFAULT;
    if (!/^[\w-]+$/.test(v) || !fs.existsSync(S('fog_builds', v, '0x871EF8CC.shader'))) throw new Error('unknown fog variant ' + v);
    return v;
}
// the hit rule of the lakes' reflection image, with module water: REFL_HITS names the mode tools\patch_refl_hits.js
// patches into the engine's own pass (default slope; off = every step within 1 m over the water counts, as in
// Expeditions; slope:0.4 and the like = another share of an upright wall's rise) or stock, which leaves the pass alone
const HITS_DEFAULT = 'slope';
const hitsRule = () => { const v = process.env.REFL_HITS || HITS_DEFAULT; return v === 'stock' ? null : hits.parseMode(v); };
// the rule when it is not the default one, for notes and summaries
const hitsNote = (modules) => (modules.includes('water') && (process.env.REFL_HITS || HITS_DEFAULT) !== HITS_DEFAULT ? process.env.REFL_HITS : null);
// where the puddle and bounce light helpers come from: HELPER_VARIANT_PUDDLES and HELPER_VARIANT_GI (or HELPER_VARIANT
// for both) name a subfolder of replacements\puddles and replacements\gi (debug: colours for what each pixel's
// reflection and bounce light did, see puddle_ssr.hlsl and gi_ambient.hlsl; one at a time reads best, both paint the
// ground); unset, the released helpers
const HELPER_EFFECTS = ['puddles', 'gi', 'water', 'reflections', 'smoke', 'sssr'];   // water: HELPER_VARIANT_WATER (debug: ssr.hlsl's SSR_DEBUG colours)
const helperVariant = (effect) => process.env['HELPER_VARIANT_' + effect.toUpperCase()] || process.env.HELPER_VARIANT || null;
function helperDir(effect)
{
    const v = helperVariant(effect);
    if (!v) return R(effect);
    if (!/^[\w-]+$/.test(v) || !fs.existsSync(R(effect, v))) throw new Error('unknown helper variant ' + v + ' (no replacements\\' + effect + '\\' + v + ')');
    return R(effect, v);
}
// the helper variants in use among the chosen modules, e.g. "puddles debug", or ''
const helperNote = (modules) => HELPER_EFFECTS.filter((e) => modules.includes(e) && helperVariant(e)).map((e) => e + ' ' + helperVariant(e)).join(', ');
// the shadow filter set for the chosen modules, or null
function shadowSet(modules)
{
    const crisp = modules.includes('crisp'), blocker = modules.includes('blocker'), revec = modules.includes('revec');
    if (revec) return (blocker ? 'hq_revec_blocker' : 'hq_revec') + (modules.includes('seam') ? '_seam' : '');
    return crisp && blocker ? 'hq_crisp_blocker' : crisp ? 'hq_grid_crisp' : blocker ? 'hq_blocker' : null;
}
const SIDE_ENTRY = 'common_pc_sm50_hdr.sdc';

function setFrom(dir)
{
    const m = new Map();
    for (const f of fs.readdirSync(dir)) if (/^0x[0-9A-F]{8}\.shader$/.test(f)) m.set(f.slice(2, 10), fs.readFileSync(path.join(dir, f)));
    if (!m.size) throw new Error('no shaders in ' + dir);
    return m;
}

// The same shader under a second name: the first letter of the compiler's name in its resource table (RDEF, which
// neither the runtime nor the driver uses to run it) in the other case, checksum repaired. The AO pass fills two slots
// with one shader; SnowRunner Shadows' stock twins (tools\stock_twins.js) tell the slots apart by their code's CRC.
function distinctCopy(b)
{
    const out = Buffer.from(b);
    for (let i = 0, n = out.readUInt32LE(28); i < n; i++)
    {
        const at = out.readUInt32LE(32 + i * 4);
        if (out.toString('latin1', at, at + 4) !== 'RDEF') continue;
        const creator = at + 8 + out.readUInt32LE(at + 8 + 24);
        if (!/[A-Za-z]/.test(String.fromCharCode(out[creator]))) throw new Error('unexpected compiler name in the AO pass shader');
        out[creator] ^= 0x20;
        dxbcChecksum(out.subarray(20)).copy(out, 4);
        return out;
    }
    throw new Error('no RDEF in the AO pass shader to tell its two copies apart');
}

function plan(modules)
{
    const main = new Map(), hdr = new Map();
    const add = (target, m) => { for (const [k, v] of m) target.set(k, v); };
    const shadows = shadowSet(modules);
    if (shadows) add(main, setFrom(S('shadow_filter', shadows)));
    if (modules.includes('ambient')) add(main, setFrom(S('ambient', shadows ? 'sky_on_' + shadows : 'sky')));
    if (modules.includes('fog')) add(main, setFrom(S('fog_builds', fogVariant())));
    if (modules.includes('gtao'))
    {
        // with the bounce light, the GTAO pass that also measures it (GTAO HQ inside); aofar: the builds with the far reach
        const far = modules.includes('aofar');
        const g = modules.includes('gi') ? fs.readFileSync(R('gi', far ? 'gtao_gi_far.cso' : 'gtao_gi.cso'))
            : fs.readFileSync(R('ssao_builds', far ? 'gtao_hq_far' : gtaoVariant(), '0xEA2414F8.shader'));
        main.set('EA2414F8', g); main.set('A3716E2B', distinctCopy(g));
    }
    if (modules.includes('tonemap')) add(hdr, setFrom(S('tonemap_builds', 'fidelity')));
    if (modules.includes('bloom')) add(hdr, setFrom(S('bloom_builds', 'softknee')));
    return { main, hdr };
}

function build(orig, modules)
{
    const { main, hdr } = plan(modules);
    const water = modules.includes('water'), tint = modules.includes('rivertint'), river = water || tint;
    const cap = modules.includes('glare'), puddles = modules.includes('puddles'), wet = cap || puddles, bounce = modules.includes('gi'), refl = modules.includes('reflections'), glow = modules.includes('smoke'), shape = modules.includes('smokeshade'), sssr = modules.includes('sssr'), cont = modules.includes('contact');
    let out = orig, mainHits = 0, hdrHits = 0, waterHits = 0, waterPlanned = 0, lakeHits = 0, lakePlanned = 0, glareHits = 0, glarePlanned = 0, puddleHits = 0, decalHits = 0, decalPlanned = 0, giHits = 0, giPlanned = 0, reflHits = 0, reflPlanned = 0, smokeHits = 0, smokePlanned = 0, shapeHits = 0, shapePlanned = 0, sssrHits = 0, sssrPlanned = 0, sssrGlass = 0, contactHits = 0, contactPlanned = 0, checked = 0;
    const z = pak.parseZip(orig);
    // whether any module touches the main cache (the check of the untouched entries at the end asks the same)
    const mainRebuilt = !!(main.size || river || wet || bounce || refl || glow || shape || sssr || cont);
    if (mainRebuilt)
    {
        const ent = z.entries.find((x) => x.name.endsWith(pak.ENTRY_TAIL));
        const { stamp, inflated } = pak.readSdc(pak.readEntry(orig, ent));
        const parsed = pak.parseCache(inflated);
        const repl = new Map(), seen = new Set();
        parsed.blobs.forEach((bl, i) =>
        {
            const h = pak.hex8(pak.crc32(inflated.subarray(bl.off, bl.off + bl.size)));
            if (main.has(h)) { repl.set(i, main.get(h)); seen.add(h); }
        });
        // bounce light, ahead of the water and wet-ground splices: the material shaders' ambient gets last frame's
        // bounce light, spliced on each shader as the shadow set left it (the sky tint comes with the same helper when
        // the ambient module is on); a shader it cannot take keeps what the other modules made of it
        if (bounce)
        {
            const targets = new Set(gi.targets());
            const shadows = shadowSet(modules), shadowMap = shadows ? setFrom(S('shadow_filter', shadows)) : new Map();
            const name = modules.includes('ambient') ? 'gi_ambient' : 'gi_only';
            const helper = fs.readFileSync(path.join(helperDir('gi'), name + '.cso')), decalHelper = fs.readFileSync(path.join(helperDir('gi'), name + '_decal.cso'));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size), h = pak.hex8(pak.crc32(own));
                if (!targets.has(h)) return;
                giPlanned++;
                const base = shadowMap.get(h) || Buffer.from(own);
                const r = gi.patchGI(base, gi.isDecal(base) ? decalHelper : helper);
                if (r.blob) { repl.set(i, r.blob); giHits++; }
            });
        }
        // the water goes on top of whatever the other modules made of each water shader. Rivers: reflections, then the
        // Fresnel blend (both effect 8), then the depth tint (effect 9); a river shader any step fails on stays as it
        // was. Lakes and seas (effect 8 only; they tint by depth already): reflections where they reflect the cubemap
        // (the others have a planar reflection of their own), then the blend.
        if (river)
        {
            const rivers = new Set(ssr.targets()), lakes = new Set(water ? ssr.domainTargets() : []);
            const wd = helperDir('water');
            const helper = { ssr: fs.readFileSync(path.join(wd, 'ssr.cso')), ssr5: fs.readFileSync(path.join(wd, 'ssr_t5.cso')), blend: fs.readFileSync(path.join(wd, 'blend.cso')), absorb: fs.readFileSync(path.join(wd, 'absorb.cso')),
                planar: fs.readFileSync(path.join(wd, 'ssr_planar.cso')),
                glow: modules.includes('crestglow') ? fs.readFileSync(path.join(W, 'replacements', 'water', 'blend_glow.cso')) : null };
            let glowHits = 0;
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size), h = pak.hex8(pak.crc32(own));
                if (!rivers.has(h) && !lakes.has(h)) return;
                waterPlanned++;
                let r = { blob: repl.get(i) || Buffer.from(own) };
                if (rivers.has(h))
                {
                    if (water) r = ssr.patchWater(r.blob, helper.ssr);
                    // crestglow: the blend with the sun glow through wave crests where the shader has the sun's shadow map
                    const g = water && r.blob && helper.glow ? mix.patchGlow(r.blob, helper.glow) : null;
                    if (g && g.blob) { r = g; glowHits++; }
                    else if (water && r.blob) r = mix.patchBlend(r.blob, helper.blend);
                    if (tint && r.blob) r = mix.patchAbsorb(r.blob, helper.absorb);
                }
                else
                {
                    // a lake that reflects the cubemap gets the SSR at that sample; one that reflects the engine's planar
                    // image (88 shaders: the lakes, sea and road puddles seen in play) gets it at that sample
                    // instead, with the planar image as the fallback (patch_water_planar.js)
                    let s = ssr.patchWater(r.blob, helper.ssr5, 5);
                    if (!s.blob) s = planar.patchPlanar(r.blob, helper.planar);
                    r = mix.patchBlend(s.blob || r.blob, helper.blend, 5);
                    // clearer shallows: the water path through thin water shortened
                    // (tools\patch_water_clear.js; the rivers get it in their absorb helper)
                    const k = r.blob ? clear.patchClear(r.blob) : null;
                    if (k && k.blob) r = k;
                }
                if (r.blob) { repl.set(i, r.blob); waterHits++; }
                else console.log('note: water shader ' + i + ' left as it was: ' + r.reason);
            });
            if (helper.glow) console.log('crest glow: ' + glowHits + ' river shaders (those with the sun shadow map)');
        }
        // the lakes' reflection image (module water): the engine's own pass, whose result the planar water shaders read
        // at t4, finds what stands in the water at every resolution (tools\patch_refl_hits.js). No other module
        // touches its two shaders; both are patched or neither, and a game version with other shaders there keeps its
        // own
        const hitRule = water ? hitsRule() : null;
        if (hitRule)
        {
            const found = [];
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size), h = pak.hex8(pak.crc32(own));
                if (hits.TARGETS.includes(h)) found.push([i, h, own]);
            });
            lakePlanned = hits.TARGETS.length;
            try
            {
                if (found.length !== lakePlanned) throw new Error(found.length + ' of its ' + lakePlanned + ' shaders are in this game version\'s shader.pak');
                if (found.some(([i]) => repl.has(i))) throw new Error('another module changed its shaders');
                const done = found.map(([i, h, own]) => [i, hits.patchReflHits(h, Buffer.from(own), hitRule)]);
                for (const [i, blob] of done) repl.set(i, blob);
                lakeHits = done.length;
            }
            catch (e) { console.log('warning: the lakes\' reflection image keeps the game\'s own hit rule: ' + e.message); }
        }
        // wet ground, on top of whatever the other modules made of each shader: the headlights' highlight capped
        // (effect 0), then the puddle reflections (effect E); a shader a step fails on keeps what it had
        if (wet)
        {
            const targets = new Set(glare.targets());
            const helper = puddles ? fs.readFileSync(path.join(helperDir('puddles'), 'puddle_ssr.cso')) : null;
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!targets.has(pak.hex8(pak.crc32(own)))) return;
                glarePlanned++;
                let blob = repl.get(i) || Buffer.from(own), changed = false;
                if (cap) { const r = glare.patchGlare(blob); if (r.blob) { blob = r.blob; glareHits++; changed = true; } }
                if (puddles) { const r = puddle.patchPuddle(blob, helper); if (r.blob) { blob = r.blob; puddleHits++; changed = true; } }
                if (changed) repl.set(i, blob);
            });
        }
        // object reflections (module reflections): the previous frame's scene marched from the cubemap sample of the
        // vehicle and prop material shaders (tools\patch_object_ssr.js), on top of whatever the other modules made of
        // each (the bounce light and the sky ambient touch other instructions); a shader it fails on keeps what it had
        if (refl)
        {
            const set = new Set(objssr.targets());
            const helper = fs.readFileSync(path.join(helperDir('reflections'), 'object_ssr.cso'));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!set.has(pak.hex8(pak.crc32(own)))) return;
                reflPlanned++;
                const r = objssr.patchObject(repl.get(i) || Buffer.from(own), helper);
                if (r.blob) { repl.set(i, r.blob); reflHits++; }
            });
        }
        // the reflection pass (module sssr): the object materials write the pass's G-buffer at render
        // target 7 (tools\patch_gbuffer.js: normal + sqrt roughness before their cubemap sample) and then read the pass's
        // result at that sample (sssr\object_sssr.cso through tools\patch_object_ssr.js) instead of marching; on top of
        // whatever the other modules made of each shader; a shader a step fails on keeps what it had (the G-buffer write
        // alone is harmless). Alternative to 'reflections' (normalize refuses both)
        if (sssr)
        {
            const set = new Set(objssr.targets());
            // with module headglow the reader built with OSSSR_HEADGLOW_ON: where a ray finds nothing it adds the headlights'
            // light in the air along that ray to the cubemap (object_sssr.hlsl); the same reader otherwise
            const gbHelper = fs.readFileSync(path.join(helperDir('sssr'), 'gbuffer.cso')), helper = fs.readFileSync(path.join(helperDir('sssr'), modules.includes('headglow') ? 'object_sssr_glow.cso' : 'object_sssr.cso'));
            // the windshield and window glass (the 14 targets naming g_txWindshieldDetail: one output, drawn blended after
            // the AO pass, so absent from the depth and the render target 7 the pass traces; the reader's depth check
            // fails on every glass pixel) keeps the marching helper of module reflections, which works from the glass's
            // own position; no G-buffer write for it
            const glassHelper = fs.readFileSync(path.join(helperDir('reflections'), 'object_ssr.cso')), GLASS = Buffer.from('g_txWindshieldDetail');
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!set.has(pak.hex8(pak.crc32(own)))) return;
                sssrPlanned++;
                const base = repl.get(i) || Buffer.from(own);
                if (own.includes(GLASS))
                {
                    const m = objssr.patchObject(base, glassHelper);
                    if (m.blob) { repl.set(i, m.blob); sssrHits++; sssrGlass++; }
                    return;
                }
                const g = gbuffer.patchGBuffer(base, gbHelper);
                const r = objssr.patchObject(g.blob || base, helper);
                if (r.blob) { repl.set(i, r.blob); sssrHits++; }
                else if (g.blob) repl.set(i, g.blob);
            });
        }
        // the sun glow through smoke (module smoke): the particle vertex shaders' sun light scaled by a forward scattering
        // lobe towards the sun (tools\patch_smoke.js); the other modules never touch these shaders. A shader the patcher
        // does not recognise keeps what it had
        if (glow)
        {
            const set = new Set(smoke.targets());
            const helper = fs.readFileSync(path.join(helperDir('smoke'), 'smoke_glow.cso'));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!set.has(pak.hex8(pak.crc32(own)))) return;
                smokePlanned++;
                const r = smoke.patchSmoke(repl.get(i) || Buffer.from(own), helper);
                if (r.blob) { repl.set(i, r.blob); smokeHits++; }
            });
        }
        // smoke shape and softer edges (module smokeshade): the lit puffs shaded by a pseudo-normal from their alpha and
        // the soft-depth fade over twice the distance (tools\patch_smoke_ps.js), on top of whatever the other modules made
        // of each particle pixel shader (the shadow filter's sun lookup); a shader it does not take keeps what it had
        if (shape)
        {
            const set = new Set(smokeps.targets());
            const helper = fs.readFileSync(path.join(helperDir('smoke'), 'smoke_shade.cso'));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!set.has(pak.hex8(pak.crc32(own)))) return;
                shapePlanned++;
                const r = smokeps.patchSmokePS(repl.get(i) || Buffer.from(own), helper);
                if (r.blob) { repl.set(i, r.blob); shapeHits++; }
            });
        }
        // the water decals, with the decal build of the puddle helper, on top of whatever the other modules made of
        // each (the bounce light patches the terrain decals too); a decal it fails on keeps what it had. Opt-in
        // (PUDDLE_DECALS=1): the road puddles are not these decals, the planar water shaders draw them
        if (puddles && process.env.PUDDLE_DECALS === '1')
        {
            const targets = new Set(puddle.decalTargets());
            const helper = fs.readFileSync(path.join(helperDir('puddles'), 'puddle_ssr_decal.cso'));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!targets.has(pak.hex8(pak.crc32(own)))) return;
                const blob = repl.get(i) || Buffer.from(own);
                if (!gi.isDecal(blob)) return;
                decalPlanned++;
                const r = puddle.patchPuddle(blob, helper);
                if (r.blob) { repl.set(i, r.blob); decalHits++; }
            });
        }
        // contact shadows (module contact): the sun shadow receivers (the shadow filter sets' 1269) write the sun's
        // visibility they found to render target 6 (tools\patch_contact.js), last, on top of whatever the other modules
        // made of each receiver; a shader it does not take keeps what it had
        if (cont)
        {
            const contact = require('./patch_contact.js'); // here, not at the top: a package without it still builds every other module
            const dir = S('shadow_filter', shadowSet(modules) || 'hq_revec');
            const set = new Set(fs.readdirSync(dir).filter((f) => /^0x[0-9A-F]{8}\.shader$/.test(f)).map((f) => f.slice(2, 10)));
            parsed.blobs.forEach((bl, i) =>
            {
                const own = inflated.subarray(bl.off, bl.off + bl.size);
                if (!set.has(pak.hex8(pak.crc32(own)))) return;
                contactPlanned++;
                const r = contact.patchContact(repl.get(i) || Buffer.from(own));
                if (r.blob) { repl.set(i, r.blob); contactHits++; }
                else console.log('note: shadow receiver ' + i + ' writes no sun visibility: ' + r.reason);
            });
        }
        // no changed shader may read an input component it does not declare (see the top)
        for (const [i, blob] of repl)
        {
            const bad = lint.undeclaredInputReads(blob);
            if (bad.length) throw new Error('main cache blob ' + i + ' reads v' + bad[0].reg + ' components 0x' + bad[0].selected.toString(16) + ' where only 0x' + bad[0].declared.toString(16) + ' is declared');
            checked++;
        }
        const rebuilt = pak.rebuildCache(inflated, parsed, repl);
        const check = pak.parseCache(rebuilt);
        if (check.count !== parsed.count || !rebuilt.subarray(check.tableOff).equals(inflated.subarray(parsed.tableOff))) throw new Error('main cache failed its read back');
        parsed.blobs.forEach((bl, i) =>
        {
            const got = rebuilt.subarray(check.blobs[i].off, check.blobs[i].off + check.blobs[i].size);
            if (!got.equals(repl.get(i) || inflated.subarray(bl.off, bl.off + bl.size))) throw new Error('main cache differs at blob ' + i);
        });
        const sdc = pak.writeSdc(stamp, rebuilt);
        if (!pak.readSdc(sdc).inflated.equals(rebuilt)) throw new Error('packed main cache failed its read back');
        out = pak.rewriteZip(out, ent.name, sdc);
        mainHits = seen.size;
        if (seen.size !== main.size) console.log('warning: ' + (main.size - seen.size) + ' of the ' + main.size + ' replaced shaders are not in this game version\'s shader.pak: their modules are in only in part');
    }
    if (hdr.size)
    {
        const z2 = pak.parseZip(out);
        const ent = z2.entries.find((x) => x.name.endsWith(SIDE_ENTRY));
        const s = side.parseSide(pak.readEntry(out, ent));
        const r = side.rebuildSide(s, hdr);
        const back = side.sideBlobs(side.parseSide(r.out));
        for (const [h, blob] of hdr) if (!back.some((b) => b.blob.equals(blob))) throw new Error('side cache lost the replacement for 0x' + h);
        out = pak.rewriteZip(out, ent.name, r.out);
        hdrHits = new Set(r.replaced).size;
    }
    // every entry that was not rebuilt must be byte for byte the original
    const za = pak.parseZip(orig), zb = pak.parseZip(out);
    for (const e of za.entries)
    {
        const e2 = zb.entries.find((x) => x.name === e.name);
        if (!e2) throw new Error('entry lost: ' + e.name);
        const changed = (mainRebuilt && e.name.endsWith(pak.ENTRY_TAIL)) || (hdr.size && e.name.endsWith(SIDE_ENTRY));
        if (!changed && !pak.readEntry(orig, e).equals(pak.readEntry(out, e2))) throw new Error('entry changed: ' + e.name);
        if (pak.crc32(pak.readEntry(out, e2)) !== e2.crc) throw new Error('crc check failed: ' + e.name);
    }
    return { out, mainHits, hdrHits, mainPlanned: main.size, hdrPlanned: hdr.size, waterHits, waterPlanned, lakeHits, lakePlanned, glareHits, glarePlanned, puddleHits, decalHits, decalPlanned, giHits, giPlanned, reflHits, reflPlanned, smokeHits, smokePlanned, shapeHits, shapePlanned, sssrHits, sssrPlanned, sssrGlass, contactHits, contactPlanned, checked };
}

// what a build holds, one line
function summary(modules, r, gtao)
{
    const helpers = helperNote(modules);
    const fog = modules.includes('fog') && fogVariant() !== FOG_DEFAULT ? fogVariant() : null, rule = hitsNote(modules);
    return modules.join(', ') + (gtao ? ' (GTAO build ' + gtao + ')' : '') + (fog ? ' (fog build ' + fog + ')' : '') + (rule ? ' (lake image rule ' + rule + ')' : '') + (helpers ? ' (helpers: ' + helpers + ')' : '') + ': main cache ' + r.mainHits + '/' + r.mainPlanned + ' shaders, side cache ' + r.hdrHits + '/' + r.hdrPlanned +
        (r.waterPlanned ? ', water ' + r.waterHits + '/' + r.waterPlanned : '') + (r.lakePlanned ? ', lake reflection image ' + r.lakeHits + '/' + r.lakePlanned : '') + (r.glarePlanned ? ', wet ground ' + (modules.includes('glare') ? 'glare ' + r.glareHits + ' ' : '') + (modules.includes('puddles') ? 'puddles ' + r.puddleHits + ' ' : '') + 'of ' + r.glarePlanned : '') +
        (r.decalPlanned ? ', water decals ' + r.decalHits + ' of ' + r.decalPlanned : '') +
        (r.giPlanned ? ', bounce light ' + r.giHits + ' of ' + r.giPlanned : '') + (r.reflPlanned ? ', object reflections ' + r.reflHits + ' of ' + r.reflPlanned : '') +
        (r.smokePlanned ? ', sun glow through smoke ' + r.smokeHits + ' of ' + r.smokePlanned : '') +
        (r.shapePlanned ? ', smoke shape and soft edges ' + r.shapeHits + ' of ' + r.shapePlanned : '') +
        (r.sssrPlanned ? ', reflection pass readers ' + r.sssrHits + ' of ' + r.sssrPlanned + (r.sssrGlass ? ' (' + r.sssrGlass + ' windshield glass marched instead)' : '') : '') +
        (r.contactPlanned ? ', contact shadow receivers ' + r.contactHits + ' of ' + r.contactPlanned : '') +
        (r.checked ? '; ' + r.checked + ' changed shaders checked' : '') +
        '; shader.pak ' + r.out.length + ' bytes';
}

// the stock twins table, one line
const twinsNote = (t) => t.count + ' shaders, ' + t.bytes + ' bytes' + (t.shared ? ' (' + t.shared + ' changed shaders share a key with another and have no twin)' : '');

if (require.main === module)
{
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'install')
    {
        const modules = arg ? normalize(arg.split(',')) : DEFAULT;
        if (!modules.length) throw new Error('no modules given; the original shader.pak is put back by pak_shader_patch.js restore');
        if (!fs.existsSync(pak.ORIG)) throw new Error('no original backup at ' + pak.ORIG);
        const orig = fs.readFileSync(pak.ORIG);
        const r = build(orig, modules);
        // the stock twins for SnowRunner Shadows' dev switches (F8 every effect, F11 the AO pass), next to hid.dll: made
        // before the first write, so a table that cannot be made stops the install with the game untouched
        const t = twins.buildTwins(orig, r.out);
        const gtao = modules.includes('gtao') ? gtaoBuild(modules) : null, helpers = helperNote(modules) || null;
        const fog = modules.includes('fog') && fogVariant() !== FOG_DEFAULT ? fogVariant() : null, rule = hitsNote(modules);
        pak.installBuild(r.out, { variant: 'fidelity: ' + modules.join(',') + (fog ? ' (fog build ' + fog + ')' : '') + (rule ? ' (lake image rule ' + rule + ')' : '') + (helpers ? ' (helpers: ' + helpers + ')' : ''), modules, gtaoVariant: gtao, fogVariant: fog, hitsRule: rule, helpers, patchedSha256: pak.sha256(r.out), date: pak.localStamp() });
        // the table goes in last: the pak and its note stand without it, and the switches then have nothing to switch
        const bin = path.join(path.dirname(pak.PAK), '..', '..', '..', 'Sources', 'Bin');
        if (fs.existsSync(bin))
        {
            const stock = path.join(bin, 'SnowRunnerShadows.stock');
            try { pak.writeSwap(stock, t.file); console.log('stock twins for the dev switches: ' + twinsNote(t)); }
            catch (e)
            {
                // an earlier build's table would name other shaders: better none
                try { fs.unlinkSync(stock); } catch (e2) { /* there is none, or it cannot be removed */ }
                console.log('note: the stock twins table for the dev switches was not written (' + e.message + '): F8 and F11 switch nothing until the next install');
            }
        }
        console.log('installed ' + summary(modules, r, gtao));
    }
    else if (cmd === 'build')
    {
        // the build install would make, written to the given file with its stock twins table next to it (<file>.stock);
        // nothing in the game folder changes
        const modules = process.argv[4] ? normalize(process.argv[4].split(',')) : DEFAULT;
        if (!arg || !modules.length) throw new Error('usage: build <out file> [modules]');
        if (!fs.existsSync(pak.ORIG)) throw new Error('no original backup at ' + pak.ORIG);
        if (path.resolve(arg) === path.resolve(pak.PAK)) throw new Error('build writes a copy; install replaces the game\'s shader.pak');
        const r = build(fs.readFileSync(pak.ORIG), modules);
        fs.writeFileSync(arg, r.out);
        const t = twins.buildTwins(fs.readFileSync(pak.ORIG), r.out);
        fs.writeFileSync(arg + '.stock', t.file);
        console.log('built ' + summary(modules, r, modules.includes('gtao') ? gtaoBuild(modules) : null) + '; sha256 ' + pak.sha256(r.out));
        console.log('stock twins for the dev switches: ' + twinsNote(t) + ', in ' + arg + '.stock');
    }
    else if (cmd === 'status')
    {
        const note = pak.noteFor(pak.readNote(), pak.sha256(fs.readFileSync(pak.PAK)));
        console.log(note ? 'shader.pak holds "' + note.variant + '" since ' + note.date : 'shader.pak is not a fidelity build of this tool');
    }
    else if (cmd === 'modules')
    {
        const cur = pak.sha256(fs.readFileSync(pak.PAK));
        if (fs.existsSync(pak.ORIG) && pak.sha256(fs.readFileSync(pak.ORIG)) === cur) console.log('stock');
        else
        {
            const note = pak.noteFor(pak.readNote(), cur);
            console.log(note && Array.isArray(note.modules) ? normalize(note.modules).join(',') : 'unknown');
        }
    }
    else if (cmd === 'gtao')
    {
        const note = pak.noteFor(pak.readNote(), pak.sha256(fs.readFileSync(pak.PAK)));
        console.log(note && note.gtaoVariant ? note.gtaoVariant : 'gtao_hq');
    }
    else console.log('usage: install [' + ALL.join(',') + '] | build <out file> [modules] | status | modules | gtao');
}
module.exports = { build, ALL, normalize, shadowSet };
