// Fresnel-weighted mix for SnowRunner's river and mud water. The stock shaders end with
//     out = reflection * F + colour
// where colour is the water's own look (its lit body colour faded into the refracted scene behind it) and F the
// Schlick Fresnel term (0.02 looking straight down, 1 at grazing). Adding the reflection on top only looks right while
// the reflection is bright sky; with the screen-space reflections (ssr.hlsl) mirroring darker banks and trees, the
// full body colour stays underneath and the water turns milky. Here the
// colour gives way to the reflection as F rises, as light splits at a water surface:
//     out = colour * (1 - F) + reflection * F
// except for the sun highlight, which the larger variants add into the body colour and which is reflected light
// already: its share of the colour, highlight * (1 - T), stays as it is.
//
// Contract with the splice (tools\patch_water_mix.js), which replaces the stock combine with this code:
// v0.xyz = colour, v1.xyz = reflection (with the stock factors after the sample), v2.x = F, v3.x = T (the see-through
// fade the colour was made with), v4.xyz = the sun highlight added into the body colour (0 where a variant has none);
// o0.xyz = the result. No resources.
//
// Build: fxc -T ps_5_0 -E main blend.hlsl -Fo blend.cso. Knob: -D MIX_FRESNEL=value.

#ifndef MIX_FRESNEL
#define MIX_FRESNEL 1.0   // 1 = the colour gives way to the reflection with Fresnel, 0 = the stock sum
#endif
#ifndef MIX_DEBUG
#define MIX_DEBUG 0       // diagnostic builds only (debug\blend.cso, the bundle's HELPER_VARIANT_WATER=debug): 1 = the water
#endif                    // shows a flat magenta base plus half the reflection unscaled by Fresnel, so every shader this splice
                          // reaches is marked whatever the light, and the SSR helper's own debug colours come through on top

#ifndef MIX_GLOW
#define MIX_GLOW 0        // 1 = the build with the sun glow through wave crests (blend_glow.cso): two more inputs, see below
#endif
#ifndef GLOW_STRENGTH
#define GLOW_STRENGTH 0.15 // the glow: x the sun's colour x its shadow there x the water's own hue
#endif
#ifndef GLOW_POWER
#define GLOW_POWER 6.0    // how closely it gathers around looking straight into the light through a wave
#endif
#ifndef GLOW_DISTORT
#define GLOW_DISTORT 0.5  // how far the wave's normal bends the light that comes through it
#endif
#ifndef GLOW_CREST
#define GLOW_CREST 4.0    // how soon a facet counts as a thin crest as it tilts from flat
#endif

#if MIX_GLOW
// Sun glow through wave crests: sunlight that enters the back of a wave and leaves through its thin top towards the eye,
// in the water's own colour, strongest looking into the light (the waves between the eye and a low sun). The term is
// the "fast translucency" of Barre-Brisebois and Bouchard (GDC 2011): the direction to the sun bent by the surface
// normal, against the view. Only where the sun reaches the water: the sun shadow map, looked up as the game's material
// shaders do (see replacements\fog\fog_sun.hlsl). Added outside the reflection: the light that comes through the water is
// not reflected, so it takes the share (1 - F).
// Extra inputs (tools\patch_water_mix.js patchGlow): v5.xyz = the water pixel's world position (the input the shader
// subtracts from the eye), v6.xyz = the wave normal the shader built its Fresnel term with (copied right after that dot
// product). Registers: b1 (c0 eye), b2 (c48 the sun's colour, c49 the direction its light travels, c67..c70 cascade
// offsets, c71..c86 cascade view-projections, c87 cascade distances), t81 g_txShadowmap with s15, as the water
// shaders that take this already sample it.
cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneA[48];
    float4 g_cSunColour;            // c48
    float4 g_vSunDir;               // c49: the direction the light travels
    float4 g_vSceneB[17];
    float4 g_aSMCascadeOffsets[4];  // c67..c70
    float4 g_aSMViewProjCols[16];   // c71..c86
    float4 g_vSMCascadeDistances;   // c87
};
SamplerComparisonState sShadow : register(s15);
Texture2D<float4>      g_txShadowmap : register(t81);

// the sun at P: 1 unless the shadow map says it is blocked (the cascade atlas only, 3:1; elsewhere unblocked)
float SunLight(float3 P)
{
    uint sw, sh;
    g_txShadowmap.GetDimensions(sw, sh);
    float light = 1.0;
    [branch] if (sw != 0 && sw == 3 * sh)
    {
        const float d = dot(P - g_vEyePos, g_vViewDir.xyz);
        const uint c = (uint)dot(float4(g_vSMCascadeDistances < d), 1.0);
        [branch] if (c < 4)
        {
            const uint k = min(c, 3u);
            const float4 q = float4(P, 1.0);
            const float4 clip = float4(dot(q, g_aSMViewProjCols[k * 4]), dot(q, g_aSMViewProjCols[k * 4 + 1]), dot(q, g_aSMViewProjCols[k * 4 + 2]),
                                       dot(q, g_aSMViewProjCols[k * 4 + 3]));
            const float2 st = clip.xy / clip.w, uv = st * g_aSMCascadeOffsets[k].zw + g_aSMCascadeOffsets[k].xy;
            if (all(st >= 0.0) && all(st <= 1.0) && all(uv >= 0.0) && all(uv <= 1.0)) light = g_txShadowmap.SampleCmpLevelZero(sShadow, uv, saturate(clip.z / clip.w));
        }
    }
    return light;
}
#endif

float4 main(float4 colour : TEXCOORD0, float4 refl : TEXCOORD1, float4 fresnel : TEXCOORD2, float4 seeThrough : TEXCOORD3,
            float4 highlight : TEXCOORD4
#if MIX_GLOW
            , float4 posIn : TEXCOORD5, float4 normalIn : TEXCOORD6
#endif
            ) : SV_Target0
{
    const float  f = saturate(fresnel.x);
    const float3 kept = highlight.xyz * saturate(1.0 - seeThrough.x);
#if MIX_DEBUG
    return float4(refl.xyz * 0.5 + float3(0.3, 0.0, 0.3), 1.0);
#elif MIX_GLOW
    const float3 P = posIn.xyz, N = normalize(normalIn.xyz);
    const float3 V = normalize(g_vEyePos - P);
    const float3 bent = normalize(-g_vSunDir.xyz + N * GLOW_DISTORT);            // the way to the sun, bent by the wave
    const float  through = pow(saturate(dot(V, -bent)), GLOW_POWER);            // looking into it through the water
    const float  crest = saturate((1.0 - N.y) * GLOW_CREST);                    // tilted facets: the thin backs of waves
    const float3 hue = colour.xyz / max(max(colour.x, colour.y), max(colour.z, 1e-4));
    const float3 glow = g_cSunColour.rgb * hue * (SunLight(P) * through * crest * GLOW_STRENGTH * (1.0 - f));
    return float4((colour.xyz - kept) * (1.0 - f * MIX_FRESNEL) + kept + refl.xyz * f + glow, 1.0);
#else
    return float4((colour.xyz - kept) * (1.0 - f * MIX_FRESNEL) + kept + refl.xyz * f, 1.0);
#endif
}
