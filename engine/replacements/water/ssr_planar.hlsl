// Screen-space reflections for SnowRunner's planar-reflection water: the 88 lake, sea and puddle shaders that reflect the
// engine's planar reflection image (g_txReflections at t4). That image is rendered for one water plane, so it fits the
// lakes at that height and shows mostly sky elsewhere (the road puddles), and it leaves out what the reflection
// pass does not draw (the trucks). This helper marches the reflected ray through this frame's depth and takes the opaque
// scene's colour where the ray passes behind a surface; where it leaves the screen or finds nothing, the planar sample
// stays exactly as the stock shader took it. A ray that ends up well behind a surface (SSR_OCCL) is not handed to the
// planar image: under an object it takes that object's colour, darkened; behind something near the camera it goes on.
//
// The march is that of ssr.hlsl (rivers): geometrically growing steps, a binary refinement at the hit (after McGuire and
// Mara, "Efficient GPU Screen-Space Ray Tracing", JCGT 2014), the edge-crossing test and the on-surface check.
//
// Contract with the splice (tools\patch_water_planar.js), which replaces the shader's one planar reflection sample
// (sample ... t4 ... s2) with this code: v0.xy = the sample's texture coordinate (screen position plus the wave
// distortion), v1.xyz = the water pixel's world position (the input the shader subtracts from the eye position cb1[0]),
// v2.xy = the world-space wave normal's x and z (the register the shader projects with the view matrix rows cb1[6].xz and
// cb1[8].xz for that distortion, copied before it is overwritten); o0 = what the sample would have written: rgb the
// reflection, a the planar image's alpha (the stock code scales the colour by 8 a, so a hit carries the alpha the planar
// image has there, or PLANAR_ALPHA where it has none). Registers are the shaders' own: b1 CB_GLOBAL_CAMERA (c0 eye, c2..c5
// view-projection columns), t4 g_txReflections and t5 g_txBBOpaque with s2, t80 g_txZ with s0.
//
// Build: fxc -T ps_5_0 -E main ssr_planar.hlsl -Fo ssr_planar.cso. Every knob can be set with -D NAME=value.

#ifndef SSR_STEPS
#define SSR_STEPS 36          // march steps
#endif
#ifndef SSR_START
#define SSR_START 0.05        // metres: the first step (small, so a wheel standing in a puddle is found)
#endif
#ifndef SSR_GROWTH
#define SSR_GROWTH 1.25       // each step this much longer than the last: 0.05 m * 1.25^36 = about 150 m of reach
#endif
#ifndef SSR_BRIGHT
#define SSR_BRIGHT 3.0        // hits much brighter than this many times the planar reflection are compressed
#endif
#ifndef SSR_REFINE
#define SSR_REFINE 5          // halvings between the last step in front of the surface and the first behind it
#endif
#ifndef SSR_EDGE
#define SSR_EDGE 0.08         // fraction of the screen over which a hit fades out towards the border
#endif
#ifndef SSR_THICK
#define SSR_THICK 0.25        // metres beyond the step a surface is taken to be thick
#endif
#ifndef SSR_BIAS
#define SSR_BIAS 0.02         // metres, plus SSR_BIAS_SLOPE times the distance: how far behind a surface counts
#endif
#ifndef SSR_BIAS_SLOPE
#define SSR_BIAS_SLOPE 0.01
#endif
#ifndef SSR_STRENGTH
#define SSR_STRENGTH 1.0      // 0 = the planar reflection only (the stock look, for the equality proofs)
#endif
#ifndef PLANAR_CALM
#define PLANAR_CALM 0.0       // 0..1: how far the wave normal is turned towards straight up before reflecting: 0 = the
#endif                        // stock ripple, 1 = a still mirror (the planar distortion of the fallback is untouched)
#ifndef PLANAR_CALM_BY_DEPTH
#define PLANAR_CALM_BY_DEPTH 1     // 1 = shallow water (the road puddles, lake margins) lies calmer; 0 = the waves everywhere
#endif
#ifndef PLANAR_CALM_SHALLOW
#define PLANAR_CALM_SHALLOW 0.85   // 0..1: the calm shallow water gets: full at no depth, gone at PLANAR_CALM_DEPTH; it also
#endif                             // steadies the planar image's own ripple
#ifndef PLANAR_CALM_DEPTH
#define PLANAR_CALM_DEPTH 0.3      // metres of water, straight down, from which the waves are the stock ones
#endif
#ifndef PLANAR_ALPHA
#define PLANAR_ALPHA 0.125    // the alpha a hit gets where the planar image has none (the stock code multiplies by 8 a)
#endif
#ifndef SSR_DEBUG
#define SSR_DEBUG 0           // diagnostic builds only (debug\ssr_planar.cso): 1 = the reflection becomes a colour for what
#endif                        // the march did: green = a hit, brighter the more of it is used; yellow = a hit faded out
                              // (heading back towards the camera); white = left the view or sky beside an edge; blue = went
                              // under an object; cyan = ran out of steps; red = behind the camera; magenta = the ray points
                              // down into the water (the planar image stays)
#ifndef SSR_DEBUG_GAIN
#define SSR_DEBUG_GAIN 4.0
#endif
#ifndef SSR_HIZ
#define SSR_HIZ 0             // 1 = walk SnowRunner Shadows' depth pyramid (t125: 1 / linear depth, the nearest surface per cell,
#endif                        // every level; the reflection pass builds it each frame) where it is bound: the ray skips whole
                              // cells while it stays in front of their nearest surface instead of taking SSR_STEPS growing
                              // steps through the depth buffer (the walk of the DLL's own trace, after AMD FidelityFX SSSR);
                              // with nothing at t125 (no DLL, the pass off) the growing steps. 0 = always the growing steps
#ifndef SSR_HIZ_STEPS
#define SSR_HIZ_STEPS 48      // walk iterations; a ray that has not ended behind a surface by then keeps the planar image
#endif
#ifndef SSR_HIZ_MIP
#define SSR_HIZ_MIP 0         // the finest pyramid level the walk uses (FidelityFX SSSR's most_detailed_mip): it starts there
#endif                        // and ends where it would step below it; 1 = hits found on 2 x 2 cells, with a check against the
                              // full-size depth where the ray stops.
                              // Measured on planar water over 40 % of a 4K frame: the walk costs 0.14 ms (0.05 in deep
                              // water), 25 steps a ray (half climbs, a fifth drops); it is bound by the texture units' rate
                              // (a load a step), not by its arithmetic (a leaner loop: no gain) nor by the wait for each load
                              // (the next cell loaded a step ahead: exact, but 0.07 ms slower). MIP 1 with SSR_HIZ_STEPS 32
                              // saves 0.026 ms but combs the reflections of a truck's wheels and chassis in the water next
                              // to it into vertical dashes, so MIP 0 and 48 steps are the defaults
#ifndef SSR_HIZ_COUNT
#define SSR_HIZ_COUNT 0       // diagnostics: 1 = the walk's steps and result kept in static globals (g_hizIters,
#endif                        // g_hizFound, g_hizDrops, g_hizClimbs) for a wrapper to read; no effect on the blob otherwise
#ifndef SSR_OCCL
#define SSR_OCCL 1            // a ray that stands behind a surface by more than the thickness (SSR_THICK): 1 = within
#endif                        // SSR_OCCL_THICK of it the ray went under that object (a truck's body over a puddle): the
                              // object's colour there, darkened by SSR_OCCL_SHADE, for the side the screen cannot show;
                              // farther behind, the surface is something well in front of the ray's path (grass, a
                              // branch, a post near the camera): the march goes on behind it. 0 = the planar image stays
                              // there: in road puddles and some lakes that image is mostly sky, which draws hard-edged
                              // light patches below every grass blade and under the trucks
#ifndef SSR_OCCL_THICK
#define SSR_OCCL_THICK 2.5    // metres behind a surface within which the ray is taken to be under that object (a truck is
#endif                        // about as wide), plus SSR_OCCL_SLOPE times the surface's distance
#ifndef SSR_OCCL_SLOPE
#define SSR_OCCL_SLOPE 0.05
#endif
#ifndef SSR_FOG
#define SSR_FOG 1             // 1 = every reflected hit gets the volumetric fog's haze over its reflected distance. The game
#endif                        // lays that fog over the frame after the water (a composite: saturate((depth - start) / 52)
                              // x density x (fog colour, amount), blended over), so what the water mirrors (the scene from
                              // before it) comes out dark and clear under a hazy shore without this.
                              // SnowRunner Shadows binds the composite's inputs here (t118 colour, t119 amount, b13 its
                              // constants); where it binds none, nothing changes. 0 = no haze on reflected hits
#ifndef SSR_OCCL_SHADE
#define SSR_OCCL_SHADE 0.5    // the object's colour times this for its unseen underside, reached SSR_OCCL_RAMP metres past
#endif                        // the thickness (from the full colour a hit just inside it gets: no step in brightness)
#ifndef SSR_OCCL_RAMP
#define SSR_OCCL_RAMP 0.5
#endif
#ifndef SSR_OCCL_NEAR
#define SSR_OCCL_NEAR 25.0    // metres from the camera: SSR_OCCL applies in full behind surfaces up to this far, fades to
#endif                        // nothing at SSR_OCCL_FAR, beyond which the planar image stays as before. Far off, thin
#ifndef SSR_OCCL_FAR          // things (trunks, reeds) lie within SSR_OCCL_THICK + slope of the water behind them, and the
#define SSR_OCCL_FAR 50.0     // waves flip those pixels between a hit, the darkened colour and the march going on:
#endif                        // flicker in distant water. Keyed on the surface the ray goes
                              // behind, so grass near the camera still lets distant water reflect the bank
#ifndef SSR_OCCL_SPECK
#define SSR_OCCL_SPECK 1      // (with SSR_OCCL) 1 = a small glowing thing with nothing around it is passed behind, not stood
#endif                        // under. A firefly (the fireflies_animated models: a few pixels of lit mesh hovering over the
                              // water) has no underside to stand for, yet every ray between it and its mirror image stands
                              // "under" it: its colour runs down the water as a streak. Small: on at least three of four
                              // sides, SSR_OCCL_SPECK_SIZE of the screen's height away, the screen shows another depth.
                              // Glowing: at least SSR_OCCL_SPECK_LUM times as bright as the brightest of those four. Grass
                              // is not isolated (the blade goes on below), a truck neither; 0 = no such test
#ifndef SSR_OCCL_SPECK_SIZE
#define SSR_OCCL_SPECK_SIZE 0.02
#endif
#ifndef SSR_OCCL_SPECK_LUM
#define SSR_OCCL_SPECK_LUM 3.0
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4]; // clip = (dot(p, col0), dot(p, col1), dot(p, col2), dot(p, col3))
};
SamplerState        sDepth : register(s0);
SamplerState        sScene : register(s2);
Texture2D<float4>   g_txReflections : register(t4);
Texture2D<float4>   g_txBBOpaque    : register(t5);
Texture2D<float4>   g_txZ           : register(t80);

float4 Clip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjCol[0]), dot(q, g_vViewProjCol[1]), dot(q, g_vViewProjCol[2]), dot(q, g_vViewProjCol[3]));
}
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }
float SceneDepth(float2 uv) { return g_txZ.SampleLevel(sDepth, uv, 0).x; }
// soft ceiling relative to the planar reflection this pixel has: luminance up to k unchanged, above it rolled off towards
// 2k, so lamps and their glow cannot dominate
float3 Ceiling(float3 c, float3 planarRgb)
{
    const float lum = dot(c, float3(0.2126, 0.7152, 0.0722));
    const float knee = max(dot(planarRgb, float3(0.2126, 0.7152, 0.0722)), 1e-3) * SSR_BRIGHT;
    const float over = max(lum - knee, 0.0);
    return c * ((lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4));
}
#if SSR_OCCL
// how far behind a surface at depth z a ray can stand and still be under that object rather than passing behind it
float UnderDepth(float z) { return SSR_OCCL_THICK + SSR_OCCL_SLOPE * z; }
// how much of SSR_OCCL a surface at depth z gets: 1 near the camera, 0 from SSR_OCCL_FAR (the planar image as before)
float OcclFade(float z) { return saturate((SSR_OCCL_FAR - z) / (SSR_OCCL_FAR - SSR_OCCL_NEAR)); }
// the darkening for a ray this far behind a surface beyond its thickness
float UnderShade(float past) { return lerp(1.0, SSR_OCCL_SHADE, saturate(past / SSR_OCCL_RAMP)); }
#if SSR_OCCL_SPECK
// whether the surface at uv (depth z) is a small glowing thing with nothing around it (see SSR_OCCL_SPECK)
bool Speck(float2 uv, float z)
{
    uint w, h;
    g_txZ.GetDimensions(w, h);
    const float2 d = float2(SSR_OCCL_SPECK_SIZE * (float)h / (float)max(w, 1u), SSR_OCCL_SPECK_SIZE);
    const float2 o[4] = { float2(d.x, 0.0), float2(-d.x, 0.0), float2(0.0, d.y), float2(0.0, -d.y) };
    const float3 lw = float3(0.2126, 0.7152, 0.0722);
    const float tol = 0.3 + 0.02 * z;                             // another depth: more than this from the thing's own
    int apart = 0;
    float around = 0.0;
    for (int i = 0; i < 4; i++)
    {
        const float2 q = uv + o[i];
        apart += abs(SceneDepth(q) - z) > tol ? 1 : 0;
        around = max(around, dot(g_txBBOpaque.SampleLevel(sScene, q, 0).rgb, lw));
    }
    return apart >= 3 && dot(g_txBBOpaque.SampleLevel(sScene, uv, 0).rgb, lw) > SSR_OCCL_SPECK_LUM * around;
}
#endif
#endif
#if SSR_FOG
Texture2D<float4> g_txFogColour : register(t118);   // SnowRunner Shadows: the fog composite's colour (its t1)
Texture2D<float4> g_txFogAmount : register(t119);   // and amount (its t2, .x)
cbuffer CB_FOG : register(b13)
{
    float4 g_vFogInst[9];                            // the composite's CB_INSTANCE: g_fDensity c0.w, g_fStartDepth c7.w
};
// the composite's fog over L metres of reflected path, at the hit's place on screen (its colour and amount there),
// blended over the hit the way the composite blends it over the frame
float3 FogOnHit(float3 c, float2 uv, float L)
{
    uint fw = 0, fh = 0;
    g_txFogColour.GetDimensions(fw, fh);
    if (fw == 0) return c;
    const float k = saturate(L / 52.0) * g_vFogInst[0].w;
    const float a = saturate(k * g_txFogAmount.SampleLevel(sScene, uv, 0).x);
    return c * (1.0 - a) + k * g_txFogColour.SampleLevel(sScene, uv, 0).rgb;
}
#endif

#if SSR_HIZ
Texture2D<float> g_txHiZ : register(t125);
#if SSR_HIZ_COUNT
static float g_hizIters = 0.0, g_hizFound = 0.0, g_hizDrops = 0.0, g_hizClimbs = 0.0;
#endif
// the pyramid's value of the cell under cellPos at a level (clamped to the level's size: its last row and column also
// cover the remainder of an odd size)
float HiZCell(float2 cellPos, int level, int2 size0)
{
    const int2 size = max(size0 >> level, 1);
    return g_txHiZ.Load(int3(clamp(int2(cellPos), 0, size - 1), level));
}
// walks the ray o + t d (uv, 1 / depth: both affine along a projected straight ray) through the pyramid: it skips a cell
// while it stays nearer than the cell's nearest surface and steps down a level when it would cross one, until it stands
// behind a surface at level 0; true then, with hit and tHit where it stands (SnowRunner Shadows' ssr_trace.hlsl Traverse,
// adapted from AMD FidelityFX SSSR's FFX_SSSR_HierarchicalRaymarch, MIT licence)
bool HiZMarch(float3 o, float3 d, int2 size0, int levels, out float3 hit, out float tHit)
{
    const float2 sizeF = float2(size0), invSize = 1.0 / sizeF;
    const float3 invD = float3(d.x != 0.0 ? 1.0 / d.x : 1e32, d.y != 0.0 ? 1.0 / d.y : 1e32, d.z != 0.0 ? 1.0 / d.z : 1e32);
    const float2 floorOffset = float2(d.xy >= 0.0);                                   // the cell's far edge in each axis
    const float2 uvOffset = 0.005 * invSize * float2(d.x >= 0.0 ? 1.0 : -1.0, d.y >= 0.0 ? 1.0 : -1.0); // just past it
    int level = SSR_HIZ_MIP;
    float2 res = sizeF * exp2(-float(SSR_HIZ_MIP));
    float2 plane = (floor(res * o.xy) + floorOffset) / res + uvOffset;               // to the edge of the first cell
    const float2 t2 = (plane - o.xy) * invD.xy;
    float t = min(t2.x, t2.y);
    float3 pos = o + t * d;
    const int top = levels - 1;
    int i = 0;
    [loop] for (; i < SSR_HIZ_STEPS && level >= SSR_HIZ_MIP; i++)
    {
        if (any(pos.xy < 0.0) || any(pos.xy > 1.0)) break;                            // left the screen
        const float2 cellPos = res * pos.xy;
        const float surface = HiZCell(cellPos, level, size0);
        plane = (floor(cellPos) + floorOffset) / res + uvOffset;
        float3 tt = (float3(plane, surface) - o) * invD;
        tt.z = d.z < 0.0 ? tt.z : 1e32;                                               // the depth plane only while moving away
        const float tMin = min(min(tt.x, tt.y), tt.z);
        const bool above = surface < pos.z;                                           // nearer than the cell's nearest surface
        const bool skipped = asuint(tMin) != asuint(tt.z) && above;
        t = above ? tMin : t;
        pos = o + t * d;
#if SSR_HIZ_COUNT
        g_hizDrops += above ? 0.0 : 1.0;                                              // down a level without moving
        g_hizClimbs += skipped ? 1.0 : 0.0;
#endif
        level += skipped ? 1 : -1;
        if (level > top) level = top;
        res = sizeF * exp2(-float(level));
    }
    hit = pos;
    tHit = t;
#if SSR_HIZ_COUNT
    g_hizIters = float(i);
    g_hizFound = level < SSR_HIZ_MIP ? 1.0 : 0.0;
#endif
    return level < SSR_HIZ_MIP;
}
#endif

float4 main(float4 uvIn : TEXCOORD0, float4 posIn : TEXCOORD1, float4 nIn : TEXCOORD2) : SV_Target0
{
    const float3 P = posIn.xyz;
#if PLANAR_CALM_BY_DEPTH
    // Shallow water lies still. The water under this pixel: the opaque depth behind it along the view ray (view depth
    // grows linearly along a ray), turned into metres straight down. The calm grows as that thins below
    // PLANAR_CALM_DEPTH, for the reflected ray and for the planar image's ripple (its sample drawn back towards the
    // pixel's own screen position, which the stock coordinate is plus the wave distortion).
    const float4 cP = Clip(P);
    const float2 screenUV = ScreenUV(cP);
    const float3 toP = P - g_vEyePos;
    const float path = length(toP) * max(SceneDepth(screenUV) / max(cP.w, 1e-3) - 1.0, 0.0);
    const float waterDepth = path * abs(toP.y) / max(length(toP), 1e-3);
    const float calm = max(PLANAR_CALM, PLANAR_CALM_SHALLOW * saturate(1.0 - waterDepth / PLANAR_CALM_DEPTH));
    // the planar reflection, sampled as the stock shader does (implicit level, outside any branch), less rippled
    const float4 planar = g_txReflections.Sample(sScene, lerp(uvIn.xy, screenUV, calm));
#else
    const float calm = PLANAR_CALM;
    // the planar reflection, sampled the way the stock shader does (implicit level, outside any branch)
    const float4 planar = g_txReflections.Sample(sScene, uvIn.xy);
#endif
#ifdef SSR_LAB_NJITTER
    const float2 nxz = nIn.xy + SSR_LAB_NJITTER;                 // lab builds only: the wave normal nudged, as the next frame's
#else                                                             // waves would (for flicker counts)
    const float2 nxz = nIn.xy;
#endif
    float3 N = float3(nxz.x, sqrt(saturate(1.0 - dot(nxz, nxz))), nxz.y);
    N = normalize(lerp(N, float3(0.0, 1.0, 0.0), calm));
    const float3 V = normalize(P - g_vEyePos);
    const float3 R = normalize(reflect(V, N));

    float  hitWeight = 0.0;
    float3 hitColour = planar.rgb;
#if SSR_DEBUG
    float3 why = float3(0.0, 1.0, 1.0);                          // cyan: ran out of steps
#endif
    [branch] if (R.y > 0.0)                                       // a ray into the water has nothing to find
    {
#if SSR_OCCL
        float marchFrom = 0.0, marchTo = SSR_START;              // the stepped march's step before the first, and its first
        bool marchOn = true;                                      // false where the walk settled the pixel
        float passed = 1.0;                                       // the least OcclFade of the surfaces the ray went on behind
#endif
#if SSR_FOG
        float2 fogUV = 0.0;                                       // where the reflected colour came from, and how far along R
        float fogL = 0.0;
#endif
#if SSR_HIZ
        uint hizW = 0, hizH = 0, hizLevels = 0;
        g_txHiZ.GetDimensions(0, hizW, hizH, hizLevels);
        [branch] if (hizW != 0)
        {
            // the ray on screen: from just off the water to far along R, or to just short of the near plane
            const float3 O = P + R * SSR_START;
            const float rz = dot(R, g_vViewDir.xyz);
            const float zo = dot(float4(O, 1.0), g_vViewDir);
            float len = 1000.0;
            if (rz < -1e-4) len = min(len, (zo - 0.7) / -rz * 0.98);
            const float4 c0 = Clip(O), c1 = Clip(O + R * len);
            float3 hitPos = 0.0;
            float tHit = 2.0;
            bool found = false;
            if (c0.w > 0.05 && c1.w > 0.05)
            {
                const float3 s0 = float3(ScreenUV(c0), 1.0 / c0.w);
                found = HiZMarch(s0, float3(ScreenUV(c1), 1.0 / c1.w) - s0, int2(hizW, hizH), (int)hizLevels, hitPos, tHit);
            }
#if SSR_DEBUG
            why = float3(1.0, 1.0, 1.0);                          // white: left the view, or nothing within the walk
#endif
#if SSR_OCCL
            marchOn = false;
#endif
            [branch] if (found && tHit <= 1.0 && all(hitPos.xy >= 0.0) && all(hitPos.xy <= 1.0))
            {
                const float2 huv = hitPos.xy;
                const float zs = SceneDepth(huv);                 // the surface the camera sees there (t80)
                const float behind = 1.0 / max(hitPos.z, 1e-6) - zs; // how far behind it the ray stands
                const float room = SSR_THICK + SSR_BIAS + SSR_BIAS_SLOPE * zs;
                const float2 edge = saturate(min(huv, 1.0 - huv) / SSR_EDGE);
#if SSR_HIZ_MIP > 0
                // a walk that ends on cells of several pixels stops at the nearest of them: where the pixel it stands on
                // is clearly farther (the ray passed beside a thin edge), no hit (it drew thin streaks)
                hitWeight = zs > 0.0 && behind < room && behind > -room ? edge.x * edge.y : 0.0;
#else
                hitWeight = zs > 0.0 && behind < room ? edge.x * edge.y : 0.0;   // further behind: it went under an object
#endif
                hitColour = Ceiling(g_txBBOpaque.SampleLevel(sScene, huv, 0).rgb, planar.rgb);
#if SSR_FOG
                fogUV = huv;
                fogL = SSR_START + len * tHit * c0.w / ((1.0 - tHit) * c1.w + tHit * c0.w);
#endif
#if SSR_DEBUG
                why = hitWeight > 0.0 ? float3(0.0, 1.0, 0.0) : float3(0.0, 0.0, 1.0);
#endif
#if SSR_OCCL
                if (zs > 0.0 && behind >= room)
                {
                    const float fade = OcclFade(zs);
#if SSR_OCCL_SPECK
                    if (fade <= 0.0 || (behind < UnderDepth(zs) && !Speck(huv, zs)))
#else
                    if (behind < UnderDepth(zs) || fade <= 0.0)
#endif
                    {
                        // under the object: its colour here, darkened, for the underside the screen cannot show (none of
                        // it beyond SSR_OCCL_FAR: the planar image as before)
                        hitWeight = edge.x * edge.y * fade;
                        hitColour *= UnderShade(behind - room);
                    }
                    else
                    {
                        // a surface well in front of the ray's path (grass, a branch near the camera): the stepped march
                        // goes on behind it from where the walk stopped (the walk's fraction of the screen segment turned
                        // into metres along R: 1 / depth is what runs linearly on screen)
                        marchFrom = SSR_START + len * tHit * c0.w / ((1.0 - tHit) * c1.w + tHit * c0.w);
                        marchTo = marchFrom * SSR_GROWTH;
                        marchOn = true;
                        passed = fade;
#if SSR_DEBUG
                        why = float3(0.0, 1.0, 1.0);                  // cyan unless the march below finds more
#endif
                    }
                }
#endif
            }
        }
#if SSR_OCCL
        [branch] if (marchOn)
#else
        else
#endif
#endif
        {
#if SSR_OCCL
        float prevT = marchFrom, t = marchTo, prevZ = -1.0;      // prevZ: the depth under the last step, -1 before the first
#else
        float prevT = 0.0, t = SSR_START, prevZ = -1.0;          // prevZ: the depth under the last step, -1 before the first
#endif
        [loop] for (int i = 0; i < SSR_STEPS; i++)
        {
            const float4 c = Clip(P + R * t);
            if (c.w <= 0.05)                                      // behind the camera
            {
#if SSR_DEBUG
                why = float3(1.0, 0.0, 0.0);
#endif
                break;
            }
            const float2 uv = ScreenUV(c);
            if (any(uv < 0.0) || any(uv > 1.0))                   // left the screen: the planar image stays
            {
#if SSR_DEBUG
                why = float3(1.0, 1.0, 1.0);
#endif
                break;
            }
            const float z = SceneDepth(uv);
            const float bias = SSR_BIAS + SSR_BIAS_SLOPE * c.w;
            const float behind = c.w - z - bias;                  // > 0: the ray is behind what the camera sees there
            const float room = (t - prevT) + SSR_THICK;
            // or the ray stepped over an edge: from in front of a surface to behind its depth, where the screen now
            // shows something far behind it (the top of a wall against the sky, a wheel's rim)
            const bool crossed = prevZ >= 0.0 && c.w > prevZ + bias && c.w - prevZ < room && z > prevZ + room;
#if SSR_OCCL
            const float fade = OcclFade(z);
            if (fade > 0.0 && behind >= UnderDepth(z))           // far behind what the screen shows here: that lies well in
            {                                                     // front of the ray's path (grass, a branch near the
                passed = min(passed, fade);                       // camera), not in its way: step on behind it
                prevZ = -1.0;
                prevT = t;
                t *= SSR_GROWTH;
                continue;
            }
#endif
            if (behind > 0.0 || crossed)
            {
                if (behind < room || crossed)                     // passed behind a surface within this step: a hit
                {
                    float lo = prevT, hi = t;
                    [loop] for (int k = 0; k < SSR_REFINE; k++)
                    {
                        const float mid = 0.5 * (lo + hi);
                        const float4 cm = Clip(P + R * mid);
#if SSR_OCCL
                        const float zm = SceneDepth(ScreenUV(cm));  // far behind a near surface counts as in front
                        if (cm.w > zm && cm.w - zm < UnderDepth(zm)) hi = mid; else lo = mid;
#else
                        if (cm.w - SceneDepth(ScreenUV(cm)) > 0.0) hi = mid; else lo = mid;
#endif
                    }
                    const float4 ch = Clip(P + R * hi);
                    const float2 huv = ScreenUV(ch);
                    const float2 edge = saturate(min(huv, 1.0 - huv) / SSR_EDGE);
                    // only where the refined point lies on a surface (not on the sky beside a stepped-over edge)
                    hitWeight = abs(ch.w - SceneDepth(huv)) < room ? edge.x * edge.y : 0.0;
                    hitColour = Ceiling(g_txBBOpaque.SampleLevel(sScene, huv, 0).rgb, planar.rgb);
#if SSR_FOG
                    fogUV = huv;
                    fogL = hi;
#endif
#if SSR_DEBUG
                    why = hitWeight > 0.0 ? float3(0.0, 1.0, 0.0) : float3(1.0, 1.0, 1.0);
#endif
                }
#if SSR_OCCL
#if SSR_OCCL_SPECK
                else if (Speck(uv, z))
                {
                    passed = min(passed, fade);                   // a firefly: the march goes on behind it
                    prevZ = -1.0;
                    prevT = t;
                    t *= SSR_GROWTH;
                    continue;
                }
#endif
                else
                {
                    // under the object: its colour here, darkened, for the underside the screen cannot show (none of it
                    // beyond SSR_OCCL_FAR: the planar image as before)
                    const float2 edge = saturate(min(uv, 1.0 - uv) / SSR_EDGE);
                    hitWeight = edge.x * edge.y * fade;
                    hitColour = Ceiling(g_txBBOpaque.SampleLevel(sScene, uv, 0).rgb, planar.rgb) * UnderShade(behind - room);
#if SSR_FOG
                    fogUV = uv;
                    fogL = t;
#endif
#if SSR_DEBUG
                    why = float3(0.0, 0.0, 1.0);
#endif
                }
#elif SSR_DEBUG
                else why = float3(0.0, 0.0, 1.0);
#endif
                break;                                            // too far behind: the ray went under an object
            }
            prevZ = z;
            prevT = t;
            t *= SSR_GROWTH;
        }
        }
#if SSR_OCCL
        hitWeight *= passed;                                      // what was found behind a surface fades with its distance
#endif
#if SSR_FOG
        if (hitWeight > 0.0) hitColour = FogOnHit(hitColour, fogUV, fogL);
#endif
    }
#if SSR_DEBUG
    else why = float3(1.0, 0.0, 1.0);
#endif
    // a ray whose ground-plane direction heads back towards the camera would need the far side of things, which no
    // screen has: let it fade (a steep ray away from the camera is fine)
    const float2 vh = normalize(V.xz + float2(1e-6, 0.0));
    const float away = saturate(dot(normalize(R.xz + float2(1e-6, 0.0)), vh) * 2.0 + 1.0) * saturate(length(R.xz) * 20.0 + 0.5);
    const float used = saturate(hitWeight * away * SSR_STRENGTH);
#if SSR_DEBUG
    if (why.g > 0.5 && why.r < 0.5 && why.b < 0.5) why = hitWeight > 0.0 && used < 0.05 ? float3(1.0, 1.0, 0.0) : float3(0.0, max(used, 0.15), 0.0);
    return float4(why * SSR_DEBUG_GAIN, planar.a > 1e-4 ? planar.a : PLANAR_ALPHA);
#else
    const float hitA = planar.a > 1e-4 ? planar.a : PLANAR_ALPHA;
    return float4(lerp(planar.rgb, hitColour, used), lerp(planar.a, hitA, used));
#endif
}
