// Screen-space reflections for SnowRunner's wet ground and road puddles. The terrain lights its reflections from the
// sky cubemap alone (a normalised probe the shader scales by the local ambient light), so a puddle next to a truck
// mirrors the sky and nothing else: the wheel standing in it is missing. Terrain is drawn before the
// game has an image of the scene, so this reads the previous frame's: SnowRunner Shadows (hid.dll) copies the lit scene
// and its linear depth when the ambient occlusion pass starts, and binds them here at t120 and t121. The ray is marched
// in world space and projected with the previous frame's camera (cb1[10..13], g_tmViewProjPrev), so the depth and the
// colour it meets belong together; for a moving truck the reflection lags one frame.
// Only glossy pixels march (the cube's mip level, sqrt(roughness) * 8 + 0.5, below PSSR_LOD_END); rough ground, rays
// that leave the view, and every pixel when the DLL feeds nothing (t120 or t121 unbound: no DLL, or puddle reflections
// switched off with its hotkey, F9 by default) keep the stock cubemap sample.
//
// Technique: the view-space ray march of the water reflections (replacements\water\ssr.hlsl, after McGuire and Mara,
// JCGT 2014) with the previous frame's projection. Written for this project.
//
// Contract with the splice (tools\patch_puddle.js), which replaces the terrain's one reflection sample (sample_l of the
// cubemap with the mip level from mad x, y, 8, 0.5): v0.xyz = the direction as the shader built it for that sample,
// v1.x = the mip level, v2.xyz = the pixel's world position, v3.x and v4.xyz = the sky visibility and the ambient colour
// the shader multiplies the sample by afterwards (with g_fReflCubeGGXScale and the material's reflectivity); o0.xyz =
// what goes where the sample wrote. A hit comes back divided by scale x visibility x ambient, so after the shader's
// own multiplies it is the scene's light times the material's reflectivity.
// Registers: b1 CB_GLOBAL_CAMERA (c0 eye, c10..c13 previous view-projection columns), b2 CB_GLOBAL_SCENE c57.y
// g_fReflCubeGGXScale, t86 g_txReflCubeGGX with s8, s2 linear, t120 previous scene colour, t121 previous linear depth.
//
// Build: fxc -T ps_5_0 -E main puddle_ssr.hlsl -Fo puddle_ssr.cso. Every knob can be set with -D NAME=value.
// Diagnostic build (the bundle takes it with HELPER_VARIANT_PUDDLES=debug): -D PSSR_DEBUG=1 -Fo debug\puddle_ssr.cso.

#ifndef PSSR_STEPS
#define PSSR_STEPS 32         // march steps
#endif
#ifndef PSSR_START
#define PSSR_START 0.05       // metres: the first step
#endif
#ifndef PSSR_GROWTH
#define PSSR_GROWTH 1.25      // each step this much longer: 0.05 m * 1.25^32 = about 60 m of reach
#endif
#ifndef PSSR_REFINE
#define PSSR_REFINE 5         // halvings between the last step in front of the surface and the first behind it
#endif
#ifndef PSSR_ADAPTIVE
#define PSSR_ADAPTIVE 0       // 1 = fewer, longer steps on rough wet ground, whose reflection is read blurred anyway: from
#endif                        // PSSR_STEPS on glossy puddles (mip PSSR_LOD_FULL) down to PSSR_STEPS_ROUGH at PSSR_LOD_END, each
                              // step growing so the reach stays that of PSSR_STEPS (the refinement keeps a hit exact). Most wet
                              // mud sits in that rough range. 0 = PSSR_STEPS everywhere
#ifndef PSSR_STEPS_ROUGH
#define PSSR_STEPS_ROUGH 12
#endif
#ifndef PSSR_EDGE
#define PSSR_EDGE 0.08        // fraction of the screen over which a hit fades out towards the border
#endif
#ifndef PSSR_THICK
#define PSSR_THICK 0.25       // metres beyond the step a surface is taken to be thick: deeper behind it the ray went under
#endif
#ifndef PSSR_BIAS
#define PSSR_BIAS 0.02        // metres, plus PSSR_BIAS_SLOPE times the distance: how far behind a surface counts
#endif
#ifndef PSSR_BIAS_SLOPE
#define PSSR_BIAS_SLOPE 0.01
#endif
#ifndef PSSR_LOD_FULL
#define PSSR_LOD_FULL 2.0     // mip level up to which the reflection is fully screen-space (roughness about 0.035)
#endif
#ifndef PSSR_LOD_END
#define PSSR_LOD_END 6.0      // mip level from which only the cubemap is used (roughness about 0.47). A range of 1.0 to
#endif                        // 3.5 leaves nearly all wet ground on the cube: the mud is rougher than that. With PSSR_BLUR
                              // the rough part reflects the scene blurred, as rough wet ground does.
#ifndef PSSR_BLUR
#define PSSR_BLUR 1           // 1 = the hit is read from the feed's mip chain (SnowRunner Shadows, FeedMips=1) at the level
#endif                        // the reflection lobe covers there: sharp in glossy patches, soft on wet mud; 0 = always sharp
#ifndef PSSR_BLUR_SPREAD
#define PSSR_BLUR_SPREAD 0.5  // the lobe's width across per metre of ray per unit of roughness
#endif
#ifndef PSSR_BRIGHT
#define PSSR_BRIGHT 3.0       // hits much brighter than this many times the reflected sky's light are compressed (lamps)
#endif
#ifndef PSSR_STRENGTH
#define PSSR_STRENGTH 1.0     // 0 = the stock sample only, for comparison
#endif
#ifndef PSSR_TEST_LIVE
#define PSSR_TEST_LIVE 0      // test builds only: 1 = return a changed sample everywhere, proves the splice is wired
#endif
#ifndef PSSR_TEST_GATE
#define PSSR_TEST_GATE 0      // test builds only: 1 = a changed sample wherever a glossy pixel passes the feed check, proves
#endif                        // withholding t120 (or t121) switches the reflections off
#ifndef PSSR_DECAL
#define PSSR_DECAL 0          // 1 = the build for the water decals (puddle_ssr_decal.cso): their input is a point of the box
#endif                        // they draw, the ground they paint lies behind it along the view ray (this frame's depth, t80)
#ifndef PSSR_CALM
#define PSSR_CALM 0           // 0..100 %: how far the reflected ray is turned from the rippled surface's towards a still
#endif                        // mirror's (a flat water surface); only where the reflection is computed
#ifndef PSSR_DEBUG
#define PSSR_DEBUG 0          // diagnostic builds only (debug\puddle_ssr.cso): 1 = colours for what each pixel's reflection
#endif                        // did instead of the reflection, see main
#ifndef PSSR_DEBUG_GAIN
#define PSSR_DEBUG_GAIN 24.0  // their brightness, in multiples of the sky light a white sample would reflect
#endif
#ifndef PSSR_OCCL
#define PSSR_OCCL 1           // a ray that stands behind a surface by more than the thickness (PSSR_THICK): 1 = within
#endif                        // PSSR_OCCL_THICK of it the ray went under that object (a truck over wet ground): the object's
                              // colour there, darkened (PSSR_OCCL_SHADE, ramped in over PSSR_OCCL_RAMP metres past the
                              // thickness); farther behind, the surface lies in front of the ray's path (grass near the
                              // camera): the march goes on behind it. Behind surfaces from PSSR_OCCL_NEAR to PSSR_OCCL_FAR
                              // metres away it fades back to the sky. The same rule as the water's SSR_OCCL
                              // (water\ssr_planar.hlsl), against the same light patches below grass and under the trucks.
                              // 0 = the sky cubemap stays there
#ifndef PSSR_OCCL_THICK
#define PSSR_OCCL_THICK 2.5   // metres behind a surface within which the ray is under that object, plus PSSR_OCCL_SLOPE
#endif                        // times the surface's distance
#ifndef PSSR_OCCL_SLOPE
#define PSSR_OCCL_SLOPE 0.05
#endif
#ifndef PSSR_OCCL_SHADE
#define PSSR_OCCL_SHADE 0.5   // the object's colour times this for its unseen underside
#endif
#ifndef PSSR_OCCL_RAMP
#define PSSR_OCCL_RAMP 0.5
#endif
#ifndef PSSR_OCCL_NEAR
#define PSSR_OCCL_NEAR 25.0
#endif
#ifndef PSSR_OCCL_FAR
#define PSSR_OCCL_FAR 50.0
#endif
#ifndef PSSR_OCCL_SPECK
#define PSSR_OCCL_SPECK 1     // (with PSSR_OCCL) 1 = a small glowing thing with nothing around it (a firefly model over wet
#endif                        // ground) is passed behind, not stood under: otherwise its colour runs down the ground as a
                              // streak (water\ssr_planar.hlsl's SSR_OCCL_SPECK, the same test on the previous frame's depth
                              // and scene). 0 = no such test
#ifndef PSSR_OCCL_SPECK_SIZE
#define PSSR_OCCL_SPECK_SIZE 0.02
#endif
#ifndef PSSR_OCCL_SPECK_LUM
#define PSSR_OCCL_SPECK_LUM 3.0
#endif
#if PSSR_DEBUG
#define DEBUG_WHY(c) why = c;
#else
#define DEBUG_WHY(c)
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4];     // c2..c5
    float4 g_vViewCol[4];         // c6..c9
    float4 g_vViewProjPrevCol[4]; // c10..c13: clip = (dot(p, col0), .., dot(p, col3)), as the game's vertex shaders do
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneBefore[57];
    float4 g_vScene57;            // .y = g_fReflCubeGGXScale
};
SamplerState        sLinear : register(s2);
SamplerState        sCube   : register(s8);
TextureCube<float4> g_txReflCubeGGX : register(t86);
Texture2D<float4>   g_txPrevScene   : register(t120);
Texture2D<float>    g_txPrevZ       : register(t121);
#if PSSR_DECAL
Texture2D<float4>   g_txZ           : register(t80);   // this frame's linear depth, which the decals read already
#endif

float4 PrevClip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjPrevCol[0]), dot(q, g_vViewProjPrevCol[1]), dot(q, g_vViewProjPrevCol[2]), dot(q, g_vViewProjPrevCol[3]));
}
#if PSSR_DECAL
float4 NowClip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjCol[0]), dot(q, g_vViewProjCol[1]), dot(q, g_vViewProjCol[2]), dot(q, g_vViewProjCol[3]));
}
#endif
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }
#if PSSR_OCCL
// how far behind a surface at depth z a ray can stand and still be under that object rather than passing behind it
float UnderDepth(float z) { return PSSR_OCCL_THICK + PSSR_OCCL_SLOPE * z; }
// how much of PSSR_OCCL a surface at depth z gets: 1 near the camera, 0 from PSSR_OCCL_FAR (the sky as before)
float OcclFade(float z) { return saturate((PSSR_OCCL_FAR - z) / (PSSR_OCCL_FAR - PSSR_OCCL_NEAR)); }
// the darkening for a ray this far behind a surface beyond its thickness
float UnderShade(float past) { return lerp(1.0, PSSR_OCCL_SHADE, saturate(past / PSSR_OCCL_RAMP)); }
#if PSSR_OCCL_SPECK
// whether the surface at uv (depth z) is a small glowing thing with nothing around it (see PSSR_OCCL_SPECK): on at least
// three of four sides, PSSR_OCCL_SPECK_SIZE of the image's height away, another depth, and at least PSSR_OCCL_SPECK_LUM
// times as bright as the brightest of those four
bool Speck(float2 uv, float z, float2 size)
{
    const float2 d = float2(PSSR_OCCL_SPECK_SIZE * size.y / size.x, PSSR_OCCL_SPECK_SIZE);
    const float2 o[4] = { float2(d.x, 0.0), float2(-d.x, 0.0), float2(0.0, d.y), float2(0.0, -d.y) };
    const float3 lw = float3(0.2126, 0.7152, 0.0722);
    const float tol = 0.3 + 0.02 * z;                             // another depth: more than this from the thing's own
    int apart = 0;
    float around = 0.0;
    for (int i = 0; i < 4; i++)
    {
        const float2 q = saturate(uv + o[i]);
        apart += abs(g_txPrevZ.Load(int3(min(q * size, size - 1.0), 0)) - z) > tol ? 1 : 0;
        around = max(around, dot(g_txPrevScene.SampleLevel(sLinear, q, 0).rgb, lw));
    }
    return apart >= 3 && dot(g_txPrevScene.SampleLevel(sLinear, uv, 0).rgb, lw) > PSSR_OCCL_SPECK_LUM * around;
}
#endif
#endif

float4 main(float4 dirIn : TEXCOORD0, float4 lodIn : TEXCOORD1, float4 posIn : TEXCOORD2, float4 visIn : TEXCOORD3, float4 ambIn : TEXCOORD4) : SV_Target0
{
    // one exit only: the splice copies the code up to its first ret
    const float3 cube = g_txReflCubeGGX.SampleLevel(sCube, dirIn.xyz, lodIn.x).rgb; // the stock sample
    const float gloss = saturate((PSSR_LOD_END - lodIn.x) / (PSSR_LOD_END - PSSR_LOD_FULL)) * PSSR_STRENGTH;
    // both feed textures must be bound: SnowRunner Shadows withholds the scene colour (t120) from these shaders when
    // puddle reflections are switched off with its hotkey, while the depth (t121) stays bound for the bounce light
    uint w, h, sw, sh;
    g_txPrevZ.GetDimensions(w, h);
    g_txPrevScene.GetDimensions(sw, sh);
    float3 result = cube;
#if PSSR_DEBUG
    // the diagnostic colours, reflected like light (so they also carry the material's reflectivity). Rough ground (no
    // march): thin stripes every 2 m, yellow just above PSSR_LOD_END, red from 3 mip levels rougher. Glossy ground, in
    // full: magenta = no feed (no DLL, or F9), white = the ray left the view or found only sky beside an edge, blue = it
    // went under an object, cyan = it ran out of steps, green = a hit, brighter the more of it is used
    float3 why = -1.0;                                            // -1: the stock sample
    if (gloss <= 0.0 && frac((posIn.x + posIn.z) * 0.5) < 0.1) why = lerp(float3(1, 1, 0), float3(1, 0, 0), saturate((lodIn.x - PSSR_LOD_END) / 3.0));
    if (gloss > 0.0) why = float3(1, 0, 1);
#endif
    [branch] if (gloss > 0.0 && w != 0 && sw != 0)
    {
    float3 P = posIn.xyz;
#if PSSR_DECAL
    {
        // the ground this decal pixel paints: where the view ray through its box point meets this frame's depth (view
        // depth grows linearly along a ray from the eye)
        const float4 cBox = NowClip(P);
        uint dw, dh;
        g_txZ.GetDimensions(dw, dh);
        const float2 dSize = float2(dw, dh);
        const float zGround = g_txZ.Load(int3(min(saturate(ScreenUV(cBox)) * dSize, dSize - 1.0), 0)).x;
        P = g_vEyePos + (P - g_vEyePos) * (zGround / max(cBox.w, 1e-3));
    }
#endif
#if PSSR_CALM
    // a still water surface mirrors the view ray about the vertical: the rippled surface's ray is turned towards that
    const float3 R = normalize(lerp(normalize(dirIn.xyz), reflect(normalize(P - g_vEyePos), float3(0, 1, 0)), PSSR_CALM * 0.01));
    const float3 sky = g_txReflCubeGGX.SampleLevel(sCube, R, lodIn.x).rgb;
#else
    const float3 R = normalize(dirIn.xyz);
    const float3 sky = cube;
#endif
    const float2 size = float2(w, h);
    float hitWeight = 0.0, prevT = 0.0, t = PSSR_START, prevZ = -1.0; // prevZ: the depth under the last step, -1 before the first
    float3 hit = 0.0;
#if PSSR_ADAPTIVE
    // the step count by roughness, and the growth that keeps the reach (PSSR_START x growth^steps)
    const float roughMix = saturate((lodIn.x - PSSR_LOD_FULL) / (PSSR_LOD_END - PSSR_LOD_FULL));
    const int steps = (int)round(lerp((float)PSSR_STEPS, (float)PSSR_STEPS_ROUGH, roughMix));
    const float growth = pow(PSSR_GROWTH, (float)PSSR_STEPS / (float)steps);
#else
    const int steps = PSSR_STEPS;
    const float growth = PSSR_GROWTH;
#endif
    DEBUG_WHY(float3(0, 1, 1))                                    // until the loop ends otherwise: out of steps
#if PSSR_OCCL
    float passed = 1.0;                                           // the least OcclFade of the surfaces the ray went on behind
#endif
    [loop] for (int i = 0; i < steps; i++)
    {
        const float4 c = PrevClip(P + R * t);
        if (c.w <= 0.05) { DEBUG_WHY(1.0) break; }                // behind the camera
        const float2 uv = ScreenUV(c);
        if (any(uv < 0.0) || any(uv > 1.0)) { DEBUG_WHY(1.0) break; } // left the view: the sky stays
        const float z = g_txPrevZ.Load(int3(min(uv * size, size - 1.0), 0));
        // depth is one value per pixel: at a grazing angle a pixel of ground spans centimetres to decimetres of depth,
        // so the ray counts as behind a surface only past this bias (else it would find the ground it starts on)
        const float bias = PSSR_BIAS + PSSR_BIAS_SLOPE * c.w;
        const float behind = c.w - z - bias;                      // > 0: behind what the camera saw there
        const float room = (t - prevT) + PSSR_THICK;
        // or the ray stepped over an edge: from in front of a surface to behind its depth, where the image now shows
        // something far behind it (the top of a wall against the sky, the edge of a rim)
        const bool crossed = prevZ >= 0.0 && c.w > prevZ + bias && c.w - prevZ < room && z > prevZ + room;
#if PSSR_OCCL
        const float fade = OcclFade(z);
        if (fade > 0.0 && behind >= UnderDepth(z))               // far behind what the image shows here: that lies well in
        {                                                         // front of the ray's path (grass near the camera), not in
            passed = min(passed, fade);                           // its way: step on behind it
            prevZ = -1.0;
            prevT = t;
            t *= growth;
            continue;
        }
#endif
        if (behind > 0.0 || crossed)
        {
            DEBUG_WHY(float3(0, 0, 1))                            // went under an object, unless a hit below
            if (behind < room || crossed)                         // passed behind a surface within this step: a hit
            {
                float lo = prevT, hi = t;
                [loop] for (int k = 0; k < PSSR_REFINE; k++)
                {
                    const float mid = 0.5 * (lo + hi);
                    const float4 cm = PrevClip(P + R * mid);
#if PSSR_OCCL
                    const float zm = g_txPrevZ.Load(int3(min(ScreenUV(cm) * size, size - 1.0), 0)); // far behind a near
                    if (cm.w > zm && cm.w - zm < UnderDepth(zm)) hi = mid; else lo = mid;          // surface: in front
#else
                    if (cm.w - g_txPrevZ.Load(int3(min(ScreenUV(cm) * size, size - 1.0), 0)) > 0.0) hi = mid; else lo = mid;
#endif
                }
                const float4 ch = PrevClip(P + R * hi);
                const float2 huv = ScreenUV(ch);
                const float2 edge = saturate(min(huv, 1.0 - huv) / PSSR_EDGE);
                // only where the refined point lies on a surface (not on the sky beside a stepped-over edge)
                const bool onSurface = abs(ch.w - g_txPrevZ.Load(int3(min(huv * size, size - 1.0), 0))) < room;
                hitWeight = onSurface ? edge.x * edge.y : 0.0;
#if PSSR_BLUR
                // rough ground reflects the scene blurred over the lobe's footprint at the hit: its width grows with
                // the ray's length and the roughness (the cube's level is sqrt(roughness) * 8 + 0.5), read from the
                // feed's mip chain at the level whose texels are that wide (one pixel there spans 2 w tan(fov/2) / height)
                const float rough = saturate((lodIn.x - 0.5) / 8.0);
                const float footprint = hi * rough * rough * PSSR_BLUR_SPREAD;
                const float pxPerMetre = sh * length(g_vViewProjPrevCol[1].xyz) / (2.0 * max(ch.w, 0.05));
                hit = g_txPrevScene.SampleLevel(sLinear, huv, log2(max(footprint * pxPerMetre, 1.0))).rgb;
#else
                hit = g_txPrevScene.SampleLevel(sLinear, huv, 0).rgb;
#endif
                DEBUG_WHY(onSurface ? float3(0, 1, 0) : 1.0)
            }
#if PSSR_OCCL
#if PSSR_OCCL_SPECK
            else if (Speck(uv, z, size))
            {
                passed = min(passed, fade);                       // a firefly: the march goes on behind it
                prevZ = -1.0;
                prevT = t;
                t *= growth;
                DEBUG_WHY(float3(0, 1, 1))
                continue;
            }
#endif
            else
            {
                // under the object: its colour here, darkened, for the underside the image cannot show (none of it
                // beyond PSSR_OCCL_FAR: the sky as before); blurred like a hit at this distance
                const float2 edge = saturate(min(uv, 1.0 - uv) / PSSR_EDGE);
                hitWeight = edge.x * edge.y * fade;
#if PSSR_BLUR
                const float rough = saturate((lodIn.x - 0.5) / 8.0);
                const float footprint = t * rough * rough * PSSR_BLUR_SPREAD;
                const float pxPerMetre = sh * length(g_vViewProjPrevCol[1].xyz) / (2.0 * max(c.w, 0.05));
                hit = g_txPrevScene.SampleLevel(sLinear, uv, log2(max(footprint * pxPerMetre, 1.0))).rgb;
#else
                hit = g_txPrevScene.SampleLevel(sLinear, uv, 0).rgb;
#endif
                hit *= UnderShade(behind - room);
            }
#endif
            break;                                                // too far behind: the ray went under an object
        }
        prevZ = z;
        prevT = t;
        t *= growth;
    }
#if PSSR_OCCL
    hitWeight *= passed;                                          // what was found behind a surface fades with its distance
#endif
    // the shader turns the sample into light with these factors (and the material's reflectivity): a hit is light already
    const float3 toLight = max(g_vScene57.y * visIn.x * ambIn.xyz, 1e-4);
    // lamps and their glow are compressed above a few times the light the sky would have given here
    const float lum = dot(hit, float3(0.2126, 0.7152, 0.0722));
    const float knee = max(dot(sky * toLight, float3(0.2126, 0.7152, 0.0722)), 1e-3) * PSSR_BRIGHT;
    const float over = max(lum - knee, 0.0);
    hit *= (lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4);
    // rays heading back towards the camera would need the far side of things, which no image has: let them fade
    const float away = saturate(dot(R, normalize(P - g_vEyePos)) * 2.0 + 1.0);
    result = lerp(sky, hit / toLight, saturate(hitWeight * away * gloss));
#if PSSR_DEBUG
    if (all(why == float3(0, 1, 0))) why.g = 0.25 + 0.75 * saturate(hitWeight * away * gloss);
#endif
#if PSSR_TEST_GATE
    result = cube * 0.5 + 0.25;
#endif
    }
#if PSSR_TEST_LIVE
    result = cube * 0.5 + 0.25;
#endif
#if PSSR_DEBUG
    if (why.x >= 0.0)
    {
        // divided by what the shader multiplies the sample by, times its brightness: after those multiplies the colour
        // is PSSR_DEBUG_GAIN times the sky light a white sample would give, in the colour asked for
        const float3 toLightD = max(g_vScene57.y * visIn.x * ambIn.xyz, 1e-4);
        result = why * (PSSR_DEBUG_GAIN * dot(toLightD, float3(0.2126, 0.7152, 0.0722))) / toLightD;
    }
#endif
    return float4(result, 1.0);
}
