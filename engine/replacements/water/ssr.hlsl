// Screen-space reflections for SnowRunner's water. The stock river and mud shaders, and the lake and sea shaders that
// have no planar reflection, reflect only the sky cubemap, so banks, trees, rocks and trucks never show in the water. This helper marches the reflected ray through the scene's
// depth and takes the colour of the opaque scene where the ray passes behind a surface; where it leaves the screen or
// finds nothing, it keeps the sky cubemap exactly as the stock shader sampled it.
//
// Technique: a view-space ray march with geometrically growing steps and a binary refinement at the hit, in the spirit
// of McGuire and Mara, "Efficient GPU Screen-Space Ray Tracing" (JCGT 3(4), 2014), simplified for water, whose
// reflection rays leave the surface upwards. Written for this project.
//
// Contract with the splice (tools\patch_water_ssr.js), which replaces the river shader's one cubemap reflection sample
// with this code: v0.xyz = the reflection direction as the shader built it for that sample (world space), v1.xyz = the
// water pixel's world position; o0.xyz = the reflection colour. Registers are the water shaders' own: b1
// CB_GLOBAL_CAMERA (c0 eye position, c2..c5 view-projection columns), t80 g_txZ (linear view depth, metres) with s0,
// g_txBBOpaque (the opaque scene) with s2 at t4 in the river shaders and at t5 in the lake and sea ("domain") shaders
// (SSR_BB_REG), t86 g_txReflCubeGGX with s8.
//
// Build: fxc -T ps_5_0 -E main ssr.hlsl -Fo ssr.cso, and with -D SSR_BB_REG=t5 -Fo ssr_t5.cso. Every knob can be set
// with -D NAME=value.

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
#define SSR_BRIGHT 3.0        // hits much brighter than this many times the reflected sky are compressed: lamps and
#endif                        // their glow would otherwise come back at full strength on top of the stock highlight
#ifndef SSR_REFINE
#define SSR_REFINE 5          // halvings between the last step in front of the surface and the first behind it
#endif
#ifndef SSR_EDGE
#define SSR_EDGE 0.08         // fraction of the screen over which a hit fades out towards the border
#endif
#ifndef SSR_THICK
#define SSR_THICK 0.25        // metres beyond the step a surface is taken to be thick: deeper behind it the ray went under
#endif
#ifndef SSR_BIAS
#define SSR_BIAS 0.02         // metres, plus SSR_BIAS_SLOPE times the distance: how far behind a surface counts (depth is
#endif                        // one value per pixel, which at a grazing angle spans centimetres to decimetres)
#ifndef SSR_BIAS_SLOPE
#define SSR_BIAS_SLOPE 0.01
#endif
#ifndef SSR_FLIP_DOWN
#define SSR_FLIP_DOWN 0       // 1 = a reflection pointing into the water is mirrored upwards: no dark rims, but it
#endif                        // flattens the wave pattern, so off as in stock
#ifndef SSR_STRENGTH
#define SSR_STRENGTH 1.0      // 0 = the stock sky reflection only, for comparison
#endif
#ifndef SSR_BB_REG
#define SSR_BB_REG t4         // where the water shader has g_txBBOpaque: t4 rivers, t5 lakes and seas (ssr_t5.cso)
#endif
#ifndef SSR_DEBUG
#define SSR_DEBUG 0           // diagnostic builds only (debug\ssr.cso and debug\ssr_t5.cso; the bundle takes them with
#endif                        // HELPER_VARIANT_WATER=debug): 1 = the reflection becomes a colour for what the march did:
                              // green = a hit, brighter the more of it is used; yellow = a hit faded out because the ray heads
                              // back towards the camera; white = the ray left the view, or found only sky beside an edge;
                              // blue = it went under an object; cyan = it ran out of steps; red = behind the camera
#ifndef SSR_DEBUG_GAIN
#define SSR_DEBUG_GAIN 4.0    // their brightness, absolute (the blend's own debug build adds the reflection unscaled by Fresnel)
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4]; // clip = (dot(p, col0), dot(p, col1), dot(p, col2), dot(p, col3)), as the river shaders do
};
SamplerState        sDepth : register(s0);
SamplerState        sScene : register(s2);
SamplerState        sCube  : register(s8);
Texture2D<float4>   g_txBBOpaque    : register(SSR_BB_REG);
Texture2D<float4>   g_txZ           : register(t80);
TextureCube<float4> g_txReflCubeGGX : register(t86);

float4 Clip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjCol[0]), dot(q, g_vViewProjCol[1]), dot(q, g_vViewProjCol[2]), dot(q, g_vViewProjCol[3]));
}
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }
float SceneDepth(float2 uv) { return g_txZ.SampleLevel(sDepth, uv, 0).x; }

float4 main(float4 dirIn : TEXCOORD0, float4 posIn : TEXCOORD1) : SV_Target0
{
    float3 R = dirIn.xyz;
#if SSR_FLIP_DOWN
    R.y = abs(R.y);
#endif
    // the sky, sampled the way the stock shader does (implicit level, outside any branch)
    const float3 sky = g_txReflCubeGGX.Sample(sCube, R).rgb;
    R = normalize(R);
    const float3 P = posIn.xyz;

    float  hitWeight = 0.0;
    float3 hitColour = sky;
#if SSR_DEBUG
    float3 why = float3(0.0, 1.0, 1.0);                          // cyan: ran out of steps
#endif
    float  prevT = 0.0, t = SSR_START, prevZ = -1.0;     // prevZ: the depth under the last step, -1 before the first
    [loop] for (int i = 0; i < SSR_STEPS; i++)
    {
        const float4 c = Clip(P + R * t);
        if (c.w <= 0.05)                                          // behind the camera
        {
#if SSR_DEBUG
            why = float3(1.0, 0.0, 0.0);
#endif
            break;
        }
        const float2 uv = ScreenUV(c);
        if (any(uv < 0.0) || any(uv > 1.0))                       // left the screen: the sky stays
        {
#if SSR_DEBUG
            why = float3(1.0, 1.0, 1.0);
#endif
            break;
        }
        const float z = SceneDepth(uv);
        const float bias = SSR_BIAS + SSR_BIAS_SLOPE * c.w;
        const float behind = c.w - z - bias;                      // > 0: the ray is behind what the camera sees there
        const float room = (t - prevT) + SSR_THICK;
        // or the ray stepped over an edge: from in front of a surface to behind its depth, where the screen now shows
        // something far behind it (the top of a wall against the sky, a wheel's rim)
        const bool crossed = prevZ >= 0.0 && c.w > prevZ + bias && c.w - prevZ < room && z > prevZ + room;
        if (behind > 0.0 || crossed)
        {
            if (behind < room || crossed)                         // passed behind a surface within this step: a hit
            {
                float lo = prevT, hi = t;
                [loop] for (int k = 0; k < SSR_REFINE; k++)
                {
                    const float mid = 0.5 * (lo + hi);
                    const float4 cm = Clip(P + R * mid);
                    if (cm.w - SceneDepth(ScreenUV(cm)) > 0.0) hi = mid; else lo = mid;
                }
                const float4 ch = Clip(P + R * hi);
                const float2 huv = ScreenUV(ch);
                const float2 edge = saturate(min(huv, 1.0 - huv) / SSR_EDGE);
                // only where the refined point lies on a surface (not on the sky beside a stepped-over edge)
                hitWeight = abs(ch.w - SceneDepth(huv)) < room ? edge.x * edge.y : 0.0;
                hitColour = g_txBBOpaque.SampleLevel(sScene, huv, 0).rgb;
                // soft ceiling relative to the sky this pixel would reflect: luminance up to k unchanged, above it
                // rolled off towards 2k, so lamps and their glow cannot dominate
                const float lum = dot(hitColour, float3(0.2126, 0.7152, 0.0722));
                const float knee = max(dot(sky, float3(0.2126, 0.7152, 0.0722)), 1e-3) * SSR_BRIGHT;
                const float over = max(lum - knee, 0.0);
                hitColour *= (lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4);
#if SSR_DEBUG
                why = hitWeight > 0.0 ? float3(0.0, 1.0, 0.0) : float3(1.0, 1.0, 1.0);
#endif
            }
#if SSR_DEBUG
            else why = float3(0.0, 0.0, 1.0);
#endif
            break;                                                // too far behind: the ray went under an object
        }
        prevZ = z;
        prevT = t;
        t *= SSR_GROWTH;
    }
    // rays heading back towards the camera would need the far side of things, which no screen has: let them fade
    const float away = saturate(dot(R, normalize(P - g_vEyePos)) * 2.0 + 1.0);
#if SSR_DEBUG
    const float used = saturate(hitWeight * away * SSR_STRENGTH);
    if (why.g > 0.5 && why.r < 0.5 && why.b < 0.5) why = hitWeight > 0.0 && used < 0.05 ? float3(1.0, 1.0, 0.0) : float3(0.0, max(used, 0.15), 0.0);
    return float4(why * SSR_DEBUG_GAIN, 1.0);
#else
    return float4(lerp(sky, hitColour, saturate(hitWeight * away * SSR_STRENGTH)), 1.0);
#endif
}
