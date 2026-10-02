// Screen-space reflections for SnowRunner's object materials: vehicle paint, glass, chrome, painted and polished metal,
// the 3229 PBR pixel shaders that reflect the environment cubemap (g_txReflCubeGGX, one sample per pixel at the mip
// level sqrt(roughness) * 8 + 0.5). The cubemap is one painted sky per weather state, so a truck never mirrors the road,
// the snow bank or the building beside it. This helper marches the mirrored ray through the previous frame's image and
// depth, which SnowRunner Shadows (hid.dll) copies at the ambient occlusion pass and binds at t120 / t121 for every pixel
// shader that declares them, reprojected with last frame's camera; where the ray passes behind a surface the scene's
// colour there replaces the cubemap sample, where it leaves the view or finds nothing the cubemap stays exactly as the
// stock shader sampled it. Only glossy pixels march: the reflection fades out from OSSR_LOD_FULL to OSSR_LOD_END mip
// levels, rougher surfaces keep the blurred cubemap (the previous frame's image has no blurred levels).
//
// The march is that of puddle_ssr.hlsl (the wet-ground helper, the same previous-frame image): growing steps, a binary
// refinement at the hit (after McGuire and Mara, JCGT 2014), the edge-crossing test and the on-surface check.
//
// Contract with the splice (tools\patch_object_ssr.js), which replaces the cubemap sample with this code: v0.xyz = the
// direction as the shader sampled it (world space), v1.x = the mip level it sampled with, v2.xyz = the pixel's world
// position (the input the shader subtracts from the eye position cb1[0]); o0.rgb = what the sample would have given,
// in the cubemap's units: the stock code multiplies it by g_fReflCubeGGXScale (cb2[57].y), the material's reflectivity
// and its Fresnel term afterwards, so a hit from the lit image is divided by that scale here. Registers: b1
// CB_GLOBAL_CAMERA (c0 eye, c10..c13 last frame's view-projection columns; the splice widens the declaration), b2
// CB_GLOBAL_SCENE (c57.y), t86 with s8, t120 and t121 (declared by the splice), s2 (linear) for t120.
//
// Build: fxc -T ps_5_0 -E main object_ssr.hlsl -Fo object_ssr.cso; -D OSSR_DEBUG=1 -Fo debug\object_ssr.cso.

#ifndef OSSR_STEPS
#define OSSR_STEPS 32
#endif
#ifndef OSSR_START
#define OSSR_START 0.04       // metres: the first step
#endif
#ifndef OSSR_GROWTH
#define OSSR_GROWTH 1.25      // 0.04 m * 1.25^32 = about 50 m of reach
#endif
#ifndef OSSR_REFINE
#define OSSR_REFINE 5
#endif
#ifndef OSSR_EDGE
#define OSSR_EDGE 0.08        // fraction of the screen over which a hit fades out towards the border
#endif
#ifndef OSSR_THICK
#define OSSR_THICK 0.25       // metres beyond the step a surface is taken to be thick
#endif
#ifndef OSSR_BIAS
#define OSSR_BIAS 0.03        // metres, plus OSSR_BIAS_SLOPE times the distance: how far behind a surface counts (the ray
#endif                        // starts on the object itself, whose depth at a grazing angle spans decimetres)
#ifndef OSSR_BIAS_SLOPE
#define OSSR_BIAS_SLOPE 0.015
#endif
#ifndef OSSR_BRIGHT
#define OSSR_BRIGHT 4.0       // hits brighter than this many times the cubemap's light are compressed (lamps)
#endif
#ifndef OSSR_LOD_FULL
#define OSSR_LOD_FULL 2.0     // mip level (sqrt(roughness) * 8 + 0.5) up to which the reflection is fully sharp scene
#endif
#ifndef OSSR_LOD_END
#define OSSR_LOD_END 7.0      // mip level from which the cubemap alone remains (roughness about 0.66; between LOD_FULL and here
#endif                        // the hit is read blurred from the previous frame's mip chain, see OSSR_CONE)
#ifndef OSSR_CONE
#define OSSR_CONE 0.5         // the reflection cone's half-width per unit of GGX roughness: the hit is read from the mip whose
#endif                        // texel spans the cone at the distance the ray travelled on screen (SnowRunner Shadows FeedMips=1
                              // gives the previous frame a mip chain; without it the level clamps to the sharp image)
#ifndef OSSR_STRENGTH
#define OSSR_STRENGTH 1.0     // 0 = the cubemap sample only (the stock look, for the equality proofs)
#endif
#ifndef OSSR_DEBUG
#define OSSR_DEBUG 0          // diagnostic builds only (debug\object_ssr.cso): the sample becomes a colour for what happened:
#endif                        // dark red = too rough to march; magenta = no feed (no DLL, or F9); green = a hit, brighter
                              // the more of it is used; yellow = a hit faded out (heading back at the camera); white = the
                              // ray left the view or found only sky beside an edge; blue = it went under an object; cyan =
                              // out of steps
#ifndef OSSR_DEBUG_GAIN
#define OSSR_DEBUG_GAIN 3.0   // in multiples of the cubemap light a white sample would give
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

float4 PrevClip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjPrevCol[0]), dot(q, g_vViewProjPrevCol[1]), dot(q, g_vViewProjPrevCol[2]), dot(q, g_vViewProjPrevCol[3]));
}
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }

#if OSSR_DEBUG
#define DEBUG_WHY(c) why = c;
#else
#define DEBUG_WHY(c)
#endif

float4 main(float4 dirIn : TEXCOORD0, float4 lodIn : TEXCOORD1, float4 posIn : TEXCOORD2) : SV_Target0
{
    // one exit only: the splice copies the code up to its first ret
    const float3 cube = g_txReflCubeGGX.SampleLevel(sCube, dirIn.xyz, lodIn.x).rgb;   // the stock sample
    const float gloss = saturate((OSSR_LOD_END - lodIn.x) / (OSSR_LOD_END - OSSR_LOD_FULL)) * OSSR_STRENGTH;
    uint w, h, sw, sh;
    g_txPrevZ.GetDimensions(w, h);
    g_txPrevScene.GetDimensions(sw, sh);
    float3 result = cube;
#if OSSR_DEBUG
    float3 why = gloss <= 0.0 ? float3(0.4, 0.0, 0.0) : float3(1.0, 0.0, 1.0);   // too rough to march; no feed
#endif
    [branch] if (gloss > 0.0 && w != 0 && sw != 0)
    {
        const float3 P = posIn.xyz;
        const float3 R = normalize(dirIn.xyz);
        const float2 size = float2(w, h);
        float hitWeight = 0.0, prevT = 0.0, t = OSSR_START, prevZ = -1.0;
        float3 hit = 0.0;
        DEBUG_WHY(float3(0, 1, 1))                                    // until the loop ends otherwise: out of steps
        [loop] for (int i = 0; i < OSSR_STEPS; i++)
        {
            const float4 c = PrevClip(P + R * t);
            if (c.w <= 0.05) { DEBUG_WHY(1.0) break; }                // behind the camera
            const float2 uv = ScreenUV(c);
            if (any(uv < 0.0) || any(uv > 1.0)) { DEBUG_WHY(1.0) break; } // left the view: the cubemap stays
            const float z = g_txPrevZ.Load(int3(min(uv * size, size - 1.0), 0));
            const float bias = OSSR_BIAS + OSSR_BIAS_SLOPE * c.w;
            const float behind = c.w - z - bias;                      // > 0: behind what the camera saw there
            const float room = (t - prevT) + OSSR_THICK;
            const bool crossed = prevZ >= 0.0 && c.w > prevZ + bias && c.w - prevZ < room && z > prevZ + room;
            if (behind > 0.0 || crossed)
            {
                DEBUG_WHY(float3(0, 0, 1))                            // went under an object, unless a hit below
                if (behind < room || crossed)                         // passed behind a surface within this step: a hit
                {
                    float lo = prevT, hi = t;
                    [loop] for (int k = 0; k < OSSR_REFINE; k++)
                    {
                        const float mid = 0.5 * (lo + hi);
                        const float4 cm = PrevClip(P + R * mid);
                        if (cm.w - g_txPrevZ.Load(int3(min(ScreenUV(cm) * size, size - 1.0), 0)) > 0.0) hi = mid; else lo = mid;
                    }
                    const float4 ch = PrevClip(P + R * hi);
                    const float2 huv = ScreenUV(ch);
                    const float2 edge = saturate(min(huv, 1.0 - huv) / OSSR_EDGE);
                    const bool onSurface = abs(ch.w - g_txPrevZ.Load(int3(min(huv * size, size - 1.0), 0))) < room;
                    hitWeight = onSurface ? edge.x * edge.y : 0.0;
                    // blur with roughness: mip = sqrt(roughness) * 8 + 0.5 came in, so roughness = ((mip - 0.5) / 8)^2; the cone
                    // this wide at the on-screen distance the ray travelled picks the previous frame's mip level
                    const float rough = pow(saturate((lodIn.x - 0.5) / 8.0), 2.0);
                    const float2 uv0 = ScreenUV(PrevClip(P));
                    const float distPx = length((huv - uv0) * size);
                    const float level = log2(max(distPx * rough * OSSR_CONE, 1.0));
                    hit = g_txPrevScene.SampleLevel(sLinear, huv, level).rgb;
                    DEBUG_WHY(onSurface ? float3(0, 1, 0) : 1.0)
                }
                break;
            }
            prevZ = z;
            prevT = t;
            t *= OSSR_GROWTH;
        }
        // the hit is lit-scene light; the shader multiplies the sample by g_fReflCubeGGXScale, so hand it back in the
        // cubemap's units, and compress lamps above a few times the cubemap's light here
        float3 hitCube = hit / max(g_vScene57.y, 1e-3);
        const float lum = dot(hitCube, float3(0.2126, 0.7152, 0.0722));
        const float knee = max(dot(cube, float3(0.2126, 0.7152, 0.0722)), 1e-3) * OSSR_BRIGHT;
        const float over = max(lum - knee, 0.0);
        hitCube *= (lum - over + over / (1.0 + over / knee)) / max(lum, 1e-4);
        // a ray heading straight back at the camera would need what is behind it, which no image has: let it fade
        const float away = saturate((dot(R, normalize(P - g_vEyePos)) + 1.0) * 2.0);
        const float used = saturate(hitWeight * away * gloss);
        result = lerp(cube, hitCube, used);
#if OSSR_DEBUG
        if (all(why == float3(0, 1, 0))) why = hitWeight > 0.0 && used < 0.05 ? float3(1, 1, 0) : float3(0, 0.25 + 0.75 * used, 0);
#endif
    }
#if OSSR_DEBUG
    result = why * OSSR_DEBUG_GAIN;
#endif
    return float4(result, 1.0);
}
