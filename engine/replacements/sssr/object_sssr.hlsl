// Paint, glass and chrome reflections from SnowRunner Shadows' reflection pass (module sssr) in
// place of the per-material ray march of reflections\object_ssr.hlsl. Same contract with the splice
// (tools\patch_object_ssr.js): v0.xyz = the direction the shader sampled the cubemap with, v1.x = the mip level,
// v2.xyz = the pixel's world position; o0.rgb = what the cubemap sample would have given, in the cubemap's units.
// The pass ran at the AO-pass hook of the PREVIOUS frame, so during this opaque pass t123 (RGBA16F, premultiplied:
// rgb = reflection radiance x a, a = confidence, 0 = miss) and t124 (RGBA16F: xy = uv motion from the frame before to
// that frame, z = 1 where an object wrote velocity) describe last frame's screen: the pixel's world position is
// reprojected with last frame's view-projection (cb1[10..13]) and checked against last frame's depth (t121); where an
// object moved (t124.z at this pixel's uv) the previous uv is this uv minus the motion, with a looser depth test. The
// composite is premultiplied: reflection + cube x (1 - a), then faded by the same gloss gate as object_ssr. Where the
// pass has nothing for a pixel (a see-through surface such as blended window glass, whose depth the pass never saw; a
// pixel last frame did not see; a miss; the pass off with F6) the per-material march of object_ssr runs instead
// (OSSSR_MARCH=1: without it the glass keeps no reflections), so F6 compares the pass against the march alone. With
// neither the pass nor the feed bound (no DLL) the cubemap sample stays exactly as stock; F8 draws the stock shaders.
// Build: fxc -T ps_5_0 -E main object_sssr.hlsl -Fo object_sssr.cso; -D OSSSR_STRENGTH=0 -Fo object_sssr_off.cso (proof);
// -D OSSSR_DEBUG=1 -Fo debug\object_sssr.cso.
#ifndef OSSSR_STRENGTH
#define OSSSR_STRENGTH 1.0    // 0 = the cubemap sample only (the stock look, for the equality proofs)
#endif
#ifndef OSSSR_LOD_FULL
#define OSSSR_LOD_FULL 2.0    // mip level (sqrt(roughness) * 8 + 0.5) up to which the pass's reflection fully replaces the cube
#endif
#ifndef OSSSR_LOD_END
#define OSSSR_LOD_END 7.0     // mip level from which the cubemap alone remains (the pass skips rough pixels itself as well)
#endif
#ifndef OSSSR_DEPTH_TOL
#define OSSSR_DEPTH_TOL 0.03  // relative depth tolerance of the reprojection (static pixels), plus 5 cm
#endif
#ifndef OSSSR_MOVING_TOL
#define OSSSR_MOVING_TOL 0.15 // the same for pixels an object moved through (their depth changed with the motion)
#endif
#ifndef OSSSR_EDGE
#define OSSSR_EDGE 0.02       // fraction of the screen over which the reflection fades towards last frame's border
#endif
#ifndef OSSSR_BRIGHT
#define OSSSR_BRIGHT 4.0      // reflected radiance brighter than this many times the cubemap's light is compressed (lamps)
#endif
#ifndef OSSSR_DEBUG
#define OSSSR_DEBUG 0         // diagnostic build: dark red = too rough; magenta = no pass bound; white = reprojected out of
#endif                        // view; red = depth test failed; blue = moving-object path; green = used (brighter = more)
#ifndef OSSSR_DEBUG_GAIN
#define OSSSR_DEBUG_GAIN 3.0
#endif
#ifndef OSSSR_DEBUG_MARCH
#define OSSSR_DEBUG_MARCH 0   // diagnostic build: a pixel that would march shows, bright enough to see through any
#endif                        // specular weight: yellow = last frame did not have it in view, cyan = the depth there did not
                              // match, magenta = no pass bound; every other pixel as the shipped build draws it
#ifndef OSSSR_MARCH
#define OSSSR_MARCH 1         // 1: where the pass has nothing for a pixel (see-through glass, a pixel last frame did not see, a
#endif                        // miss, the pass off with F6) the per-material march of reflections\object_ssr.hlsl runs instead
#ifndef OSSSR_MARCH_BELOW
#define OSSSR_MARCH_BELOW 0.02 // the pass's confidence below which a pixel marches instead
#endif
#ifndef OSSSR_MARCH_FRONT_ONLY
#define OSSSR_MARCH_FRONT_ONLY 0  // 1 (with OSSSR_MARCH_UNSEEN_ONLY): a fragment the pass never saw marches only when it
#endif                            // lies in front of what last frame had at its pixel (see-through surfaces, thin jittering edges,
                                  // a moving object) or last frame did not have it in view; one behind it (hidden last frame: terrain
                                  // shaded under a truck or a rock drawn later, overwritten before the frame is shown) keeps the
                                  // cubemap: in a lakeside test scene those hidden fragments were most of the march's 0.26 ms of
                                  // lit pass (a debug build showed marching only on the antenna, edges and a few rocks). A surface
                                  // just uncovered by a moving object gets the cubemap for the one frame before the pass has it
#ifndef OSSSR_MARCH_DEAD
#define OSSSR_MARCH_DEAD 0     // measurements only: 1 = the march stays in the code but never runs (a condition the
#endif                         // compiler cannot see is always false), to tell its cost when it runs from the cost of carrying it
#ifndef OSSSR_MARCH_UNSEEN_ONLY
#define OSSSR_MARCH_UNSEEN_ONLY 0 // 1 = the march only where the pass never saw the pixel (not in last frame's view, or not at
#endif                            // this depth there: see-through glass, what a moving object uncovered) or the pass is off:
                                  // a pixel the pass traced and found nothing for keeps the cubemap. In a riverside test scene
                                  // the pass kept a hit for 34 % of its rays, and the other two thirds of the glossy pixels
                                  // marched 32 steps each in the lit pass (about 1 ms at 4K). 0 = a traced miss marches too
#ifndef OSSSR_HEADGLOW_ON
#define OSSSR_HEADGLOW_ON 0       // 1 (module headglow): where the mirrored ray finds nothing, the cubemap gets the
#endif                            // headlights' light in the air along that ray added to it. At night a hood shows the cubemap's
                                  // blue sky while the lamps light everything ahead warm; the game draws beam meshes at the
                                  // lamps, which a ray that leaves the screen cannot see. The beam is the game's own (HeadGlow
                                  // below); only while the pass is bound, so F6 still shows the look without it
#ifndef OSSSR_HEADGLOW
#define OSSSR_HEADGLOW 0.002      // the share of a beam's light that one metre of air sends along the ray: sized on a night
#endif                            // shot (hood 0.6 nits of blue, the beam's haze 11 nits ahead of the truck)
#ifndef OSSSR_HEADGLOW_HALO
#define OSSSR_HEADGLOW_HALO 0.2   // light scattered out of the beam: a cone of twice the angle at this share of the level
#endif
#ifndef OSSSR_HEADGLOW_STEPS
#define OSSSR_HEADGLOW_STEPS 8    // samples along the ray's stretch within a lamp's reach
#endif
// the march's settings, those of reflections\object_ssr.hlsl
#define OSSR_STEPS 32
#define OSSR_START 0.04
#define OSSR_GROWTH 1.25
#define OSSR_REFINE 5
#define OSSR_EDGE 0.08
#define OSSR_THICK 0.25
#define OSSR_BIAS 0.03
#define OSSR_BIAS_SLOPE 0.015
#define OSSR_BRIGHT 4.0
#define OSSR_CONE 0.5
cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4];     // c2..c5
    float4 g_vViewCol[4];         // c6..c9
    float4 g_vViewProjPrevCol[4]; // c10..c13
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneBefore[57];
    float4 g_vScene57;            // .y = g_fReflCubeGGXScale
};
SamplerState        sLinear : register(s2);
SamplerState        sCube   : register(s8);
TextureCube<float4> g_txReflCubeGGX : register(t86);
Texture2D<float4>   g_txPrevScene   : register(t120);   // the march's image (the DLL's feed, like t121)
Texture2D<float>    g_txPrevZ       : register(t121);
Texture2D<float4>   g_txSSR         : register(t123);
Texture2D<float4>   g_txSSRMotion   : register(t124);
float4 Clip(float3 p, float4 col[4])
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, col[0]), dot(q, col[1]), dot(q, col[2]), dot(q, col[3]));
}
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }
// The march of reflections\object_ssr.hlsl (after McGuire and Mara, JCGT 2014), unchanged: the mirrored ray
// through the previous frame's image and depth (the DLL's feed at t120/t121) in growing steps, a binary refinement at the
// hit, the edge-crossing test and the on-surface check; the hit read blurred by the roughness cone, in the cubemap's
// units with lamps compressed, used by the gloss gate and faded for rays heading back at the camera.
float3 March(float3 P, float3 R, float lod, float3 cube, float gloss, float2 size)
{
    float hitWeight = 0.0, prevT = 0.0, t = OSSR_START, prevZ = -1.0;
    float3 hit = 0.0;
    [loop] for (int i = 0; i < OSSR_STEPS; i++)
    {
        const float4 c = Clip(P + R * t, g_vViewProjPrevCol);
        if (c.w <= 0.05) break;                                   // behind the camera
        const float2 uv = ScreenUV(c);
        if (any(uv < 0.0) || any(uv > 1.0)) break;                // left the view: the cubemap stays
        const float z = g_txPrevZ.Load(int3(min(uv * size, size - 1.0), 0));
        const float bias = OSSR_BIAS + OSSR_BIAS_SLOPE * c.w;
        const float behind = c.w - z - bias;                      // > 0: behind what the camera saw there
        const float room = (t - prevT) + OSSR_THICK;
        const bool crossed = prevZ >= 0.0 && c.w > prevZ + bias && c.w - prevZ < room && z > prevZ + room;
        if (behind > 0.0 || crossed)
        {
            if (behind < room || crossed)                         // passed behind a surface within this step: a hit
            {
                float lo = prevT, hi = t;
                [loop] for (int k = 0; k < OSSR_REFINE; k++)
                {
                    const float mid = 0.5 * (lo + hi);
                    const float4 cm = Clip(P + R * mid, g_vViewProjPrevCol);
                    if (cm.w - g_txPrevZ.Load(int3(min(ScreenUV(cm) * size, size - 1.0), 0)) > 0.0) hi = mid; else lo = mid;
                }
                const float4 ch = Clip(P + R * hi, g_vViewProjPrevCol);
                const float2 huv = ScreenUV(ch);
                const float2 edge = saturate(min(huv, 1.0 - huv) / OSSR_EDGE);
                const bool onSurface = abs(ch.w - g_txPrevZ.Load(int3(min(huv * size, size - 1.0), 0))) < room;
                hitWeight = onSurface ? edge.x * edge.y : 0.0;
                const float rough = pow(saturate((lod - 0.5) / 8.0), 2.0);
                const float2 uv0 = ScreenUV(Clip(P, g_vViewProjPrevCol));
                const float distPx = length((huv - uv0) * size);
                const float level = log2(max(distPx * rough * OSSR_CONE, 1.0));
                hit = g_txPrevScene.SampleLevel(sLinear, huv, level).rgb;
            }
            break;
        }
        prevZ = z;
        prevT = t;
        t *= OSSR_GROWTH;
    }
    float3 hitCube = hit / max(g_vScene57.y, 1e-3);
    const float lum = dot(hitCube, float3(0.2126, 0.7152, 0.0722));
    const float knee = max(dot(cube, float3(0.2126, 0.7152, 0.0722)), 1e-3) * OSSR_BRIGHT;
    const float over = max(lum - knee, 0.0);
    hitCube *= (lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4);
    const float away = saturate((dot(R, normalize(P - g_vEyePos)) + 1.0) * 2.0);
    const float used = saturate(hitWeight * away * gloss);
    return lerp(cube, hitCube, used);
}
#if OSSSR_HEADGLOW_ON
// One headlight's light in the air along the ray P + t R, as a length in metres: the game's own beam (the object
// shaders' headlight block: a cone with a squared falloff from g_vHeadLightSpotAtten, nothing within 3 m of the lamp
// and full from 6 m, a linear fade to the reach in g_vHeadLightDistAtten) summed over the ray's stretch inside the
// lamp's reach, plus the halo. da = g_vHeadLightDistAtten (x fade start, y 1 / fade length, z reach), sa =
// g_vHeadLightSpotAtten (x the cone's cosine, y 1 / (inner - outer cosine))
float BeamLength(float3 P, float3 R, float4 da, float4 sa, float3 A, float3 L)
{
    const float3 oc = P - L;
    const float b = dot(oc, R), disc = b * b - dot(oc, oc) + da.z * da.z;
    float len = 0.0;
    [branch] if (disc > 0.0)
    {
        const float s = sqrt(disc), t0 = max(-b - s, 0.0), t1 = -b + s;
        [branch] if (t1 > t0)
        {
            const float dt = (t1 - t0) / OSSSR_HEADGLOW_STEPS;
            const float kw = 2.0 * sa.x * sa.x - 1.0;     // the cosine of twice the cone's angle
            float sum = 0.0;
            [loop] for (int k = 0; k < OSSSR_HEADGLOW_STEPS; k++)
            {
                const float3 D = oc + R * (t0 + (k + 0.5) * dt);
                const float d = length(D), c = dot(D, A) / max(d, 1e-3);
                const float spot = saturate((c - sa.x) * sa.y), halo = saturate((c - kw) / max(1.0 - kw, 1e-3));
                sum += max(spot * spot * 0.95, halo * halo * OSSSR_HEADGLOW_HALO) * saturate((d - 3.0) * 0.333333) * (1.0 - saturate((d - da.x) * da.y));
            }
            len = sum * dt;
        }
    }
    return len;
}
// the four headlights' light along the ray, in scene units; nothing while every reach is zero (the game's own test for
// "no headlight is on")
float3 HeadGlow(float3 P, float3 R)
{
    float3 glow = 0.0;
    [branch] if (g_vSceneBefore[8].z != 0.0 || g_vSceneBefore[9].z != 0.0 || g_vSceneBefore[10].z != 0.0 || g_vSceneBefore[11].z != 0.0)
    {
        [branch] if (g_vSceneBefore[8].z > 0.0) glow += g_vSceneBefore[16].rgb * BeamLength(P, R, g_vSceneBefore[8], g_vSceneBefore[12], g_vSceneBefore[20].xyz, g_vSceneBefore[24].xyz);
        [branch] if (g_vSceneBefore[9].z > 0.0) glow += g_vSceneBefore[17].rgb * BeamLength(P, R, g_vSceneBefore[9], g_vSceneBefore[13], g_vSceneBefore[21].xyz, g_vSceneBefore[25].xyz);
        [branch] if (g_vSceneBefore[10].z > 0.0) glow += g_vSceneBefore[18].rgb * BeamLength(P, R, g_vSceneBefore[10], g_vSceneBefore[14], g_vSceneBefore[22].xyz, g_vSceneBefore[26].xyz);
        [branch] if (g_vSceneBefore[11].z > 0.0) glow += g_vSceneBefore[19].rgb * BeamLength(P, R, g_vSceneBefore[11], g_vSceneBefore[15], g_vSceneBefore[23].xyz, g_vSceneBefore[27].xyz);
    }
    return max(glow, 0.0) * OSSSR_HEADGLOW;
}
#endif
#if OSSSR_DEBUG
#define DEBUG_WHY(c) why = c;
#else
#define DEBUG_WHY(c)
#endif
float4 main(float4 dirIn : TEXCOORD0, float4 lodIn : TEXCOORD1, float4 posIn : TEXCOORD2) : SV_Target0
{
    const float3 cube = g_txReflCubeGGX.SampleLevel(sCube, dirIn.xyz, lodIn.x).rgb;   // the stock sample
    const float gloss = saturate((OSSSR_LOD_END - lodIn.x) / (OSSSR_LOD_END - OSSSR_LOD_FULL)) * OSSSR_STRENGTH;
    uint w, h, zw, zh, sw, sh;
    g_txSSR.GetDimensions(w, h);
    g_txPrevZ.GetDimensions(zw, zh);
    g_txPrevScene.GetDimensions(sw, sh);
    float3 result = cube;
    bool passUsed = false;
#if OSSSR_HEADGLOW_ON
    float3 glow = 0.0;      // the headlights' light in the air along the mirrored ray, in the cubemap's units
#endif
#if OSSSR_DEBUG_MARCH
    float3 marchWhy = float3(500.0, 0.0, 500.0);   // magenta: no pass bound
#endif
#if OSSSR_MARCH_UNSEEN_ONLY
    bool passSaw = false;   // the pass had this pixel (in last frame's view at this depth): its miss is a miss
#endif
#if OSSSR_MARCH_FRONT_ONLY
    bool hiddenBefore = false; // in last frame's view, but behind the surface last frame had there: no march
#endif
#if OSSSR_DEBUG
    float3 why = gloss <= 0.0 ? float3(0.4, 0.0, 0.0) : float3(1.0, 0.0, 1.0);
#endif
    [branch] if (gloss > 0.0 && w != 0 && zw != 0)
    {
        const float3 P = posIn.xyz;
        const float2 uvCur = ScreenUV(Clip(P, g_vViewProjCol));
        const float4 motion = g_txSSRMotion.SampleLevel(sLinear, uvCur, 0);   // zeros when the DLL bound nothing there
        const bool moving = motion.z > 0.5;
        const float4 cPrev = Clip(P, g_vViewProjPrevCol);
        const float2 uvPrev = moving ? uvCur - motion.xy : ScreenUV(cPrev);
        const float2 zSize = float2(zw, zh);
        const float zPrev = g_txPrevZ.Load(int3(min(saturate(uvPrev) * zSize, zSize - 1.0), 0));
        const bool inView = cPrev.w > 0.05 && all(uvPrev >= 0.0) && all(uvPrev <= 1.0);
        const bool depthOK = abs(zPrev - cPrev.w) < cPrev.w * (moving ? OSSSR_MOVING_TOL : OSSSR_DEPTH_TOL) + 0.05;
        const float2 edge = saturate(min(uvPrev, 1.0 - uvPrev) / OSSSR_EDGE);
        const float keep = (inView && depthOK) ? edge.x * edge.y : 0.0;
        const float4 s = g_txSSR.SampleLevel(sLinear, uvPrev, 0) * keep;     // premultiplied, so one factor for both
        // radiance in the cubemap's units (the shader multiplies by g_fReflCubeGGXScale after us), lamps compressed
        float3 refl = s.rgb / max(g_vScene57.y, 1e-3);
        const float lum = dot(refl, float3(0.2126, 0.7152, 0.0722));
        const float knee = max(dot(cube, float3(0.2126, 0.7152, 0.0722)), 1e-3) * OSSSR_BRIGHT * max(s.a, 1e-3);
        const float over = max(lum - knee, 0.0);
        refl *= (lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4);
#if OSSSR_HEADGLOW_ON
        // behind whatever the ray did not hit lies the cubemap, and in front of that the air the headlights light
        glow = HeadGlow(P, normalize(dirIn.xyz)) / max(g_vScene57.y, 1e-3);
        const float3 mixed = refl + (cube + glow) * (1.0 - s.a);
#else
        const float3 mixed = refl + cube * (1.0 - s.a);
#endif
        passUsed = inView && depthOK && s.a > OSSSR_MARCH_BELOW;
        if (passUsed) result = lerp(cube, mixed, gloss);
#if OSSSR_HEADGLOW_ON
        else if (inView && depthOK) result = cube + glow * (gloss * (1.0 - s.a));   // the pass saw the pixel, its ray found nothing
#endif
#if OSSSR_MARCH_UNSEEN_ONLY
        passSaw = inView && depthOK;
#endif
#if OSSSR_MARCH_FRONT_ONLY
        hiddenBefore = inView && !depthOK && cPrev.w > zPrev;
#endif
#if OSSSR_DEBUG_MARCH
        marchWhy = !inView ? float3(500.0, 500.0, 0.0) : float3(0.0, 500.0, 500.0);
#endif
        DEBUG_WHY(!inView ? 1.0 : !depthOK ? float3(1, 0, 0) : moving ? float3(0, 0, 1) : float3(0, 0.25 + 0.75 * s.a, 0))
    }
#if OSSSR_MARCH
    // where the pass has nothing for this pixel: a see-through surface (the depth the pass traced lies behind it), a
    // pixel last frame did not see, a miss, or the pass switched off (F6): the per-material march, as module reflections
#if OSSSR_MARCH_UNSEEN_ONLY && OSSSR_MARCH_DEAD
    [branch] if (gloss > 0.0 && !passUsed && !passSaw && zw != 0 && sw != 0 && lodIn.x < -1.0e30)
#elif OSSSR_MARCH_UNSEEN_ONLY && OSSSR_MARCH_FRONT_ONLY
    [branch] if (gloss > 0.0 && !passUsed && !passSaw && !hiddenBefore && zw != 0 && sw != 0)
#elif OSSSR_MARCH_UNSEEN_ONLY
    [branch] if (gloss > 0.0 && !passUsed && !passSaw && zw != 0 && sw != 0)
#else
    [branch] if (gloss > 0.0 && !passUsed && zw != 0 && sw != 0)
#endif
    {
#if OSSSR_DEBUG_MARCH
        result = marchWhy;
#elif OSSSR_HEADGLOW_ON
        result = March(posIn.xyz, normalize(dirIn.xyz), lodIn.x, cube + glow * gloss, gloss, float2(zw, zh));   // glow is 0 with the pass off
#else
        result = March(posIn.xyz, normalize(dirIn.xyz), lodIn.x, cube, gloss, float2(zw, zh));
#endif
#if OSSSR_DEBUG
        why = float3(0.0, 0.7, 0.7);   // cyan: marched
#endif
    }
#endif
#if OSSSR_DEBUG
    result = why * OSSSR_DEBUG_GAIN;
#endif
    return float4(result, 1.0);
}
