// Sun light for SnowRunner's volumetric fog (0x871EF8CC), spliced into its ray march by tools\patch_fog_sun.js: once
// per step, right after the step's world position is made. The stock march lights the fog with an ambient colour
// and the lamps and headlights only, so it never shows where the sun is blocked: no shafts between trees. This adds the
// sun's in-scattered light: its colour x the sun shadow map at the step (the engine's own cascade choice) x the cloud
// shadows over it x a forward-scattering phase, and the splice adds it into the march's sum with the step's density,
// the same way the stock colour goes in. Where the shadow map is not bound during the fog pass (t81 width 0), nothing
// is added: the fog stays as it was.
//
// The lookup is the one the game's high quality material shaders use: the view depth d = (P - eye) . view direction,
// cascade c = how many of g_vSMCascadeDistances lie below d, and for c < 4 the cascade k = min(c, 3):
// clip = P x g_aSMViewProjs[k] (four columns, cb2[71 + 4k ..]), atlas uv = clip.xy / clip.w x g_aSMCascadeOffsets[k].zw
// + .xy, depth = saturate(clip.z / clip.w), one comparison sample (s15, a bilinear compare the game keeps bound). The
// cloud shadow map (t89) is read as the material shaders read it: uv = (P.xz + 0.5 - g_vTerrainSize.xy) x
// g_vTerrainSize.zw, light = 1 - its red.
//
// Contract with the splice: v0.xyz = the step's world position, v1.xyz = the normalized view ray; o0.xyz = the sun's
// in-scattered light per unit of the step's density. Registers are the fog pass's (the splice declares what it lacks):
// b1 CB_GLOBAL_CAMERA (c0 eye, c1 view direction, c2..c5 the view-projection columns), b2 CB_GLOBAL_SCENE (c48 g_dirLight.vColor, c49 g_dirLight.vDir = the
// direction the light travels, c54 g_vTerrainSize, c67..c70 g_aSMCascadeOffsets, c71..c86 g_aSMViewProjs, c87
// g_vSMCascadeDistances), t81 g_txShadowmap with s15, t89 g_txCloudShadowMap with s3, t121 SnowRunner Shadows' linear
// depth (FOG_SUN_DEPTH).
//
// Build: fxc -T ps_5_0 -E main fog_sun.hlsl -Fo fog_sun.cso. Every knob can be set with -D NAME=value.

#ifndef FOG_SUN
#define FOG_SUN 0.12            // the sun term's scale (x the sun's colour; the stock fog's own colour is not changed)
#endif
#ifndef FOG_SUN_G
#define FOG_SUN_G 0.45          // Henyey-Greenstein anisotropy: shafts brighter looking towards the sun
#endif
#ifndef FOG_SUN_CLOUDS
#define FOG_SUN_CLOUDS 1        // 1 = the cloud shadows dim the sun term too
#endif
#ifndef FOG_SUN_DEBUG
#define FOG_SUN_DEBUG 0         // diagnostic builds only: 1 = green where the sun atlas (t81, 3:1) and t89 are bound, red
#endif                          // where t81 is not the atlas, blue where only t89 is missing; 1/128 per step, so a full
                                // march adds the colour itself
#ifndef FOG_SUN_DEPTH
#define FOG_SUN_DEPTH 1         // 1 = no sun from steps behind the opaque surface the pixel shows. The march runs its 64 m
#endif                          // through whatever is in the way (the pass reads no depth), so without this the shafts behind
                                // a truck are painted over it. The depth is SnowRunner Shadows' copy of the linear depth at
                                // t121, which the DLL binds to every pixel shader that declares it; without it (no DLL, the
                                // feed off) every step counts. 0 = no depth test

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
#if FOG_SUN_DEPTH && !FOG_SUN_DEBUG
    float4 g_vViewProjCol[4];       // c2..c5: clip = (dot(p, col0), dot(p, col1), dot(p, col2), dot(p, col3))
#endif
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneA[48];
    float4 g_cSunColour;            // c48: g_dirLight.vColor
    float4 g_vSunDir;               // c49: g_dirLight.vDir, the direction the light travels
    float4 g_vSceneB[4];
    float4 g_vTerrainSize;          // c54
    float4 g_vSceneC[12];
    float4 g_aSMCascadeOffsets[4];  // c67..c70: atlas offset (xy) and scale (zw) per cascade
    float4 g_aSMViewProjCols[16];   // c71..c86: per cascade the four columns of its view-projection
    float4 g_vSMCascadeDistances;   // c87
};
SamplerState           sCloud  : register(s3);
SamplerComparisonState sShadow : register(s15);
Texture2D<float4>      g_txShadowmap      : register(t81);
Texture2D<float4>      g_txCloudShadowMap : register(t89);
#if FOG_SUN_DEPTH && !FOG_SUN_DEBUG
Texture2D<float>       g_txFeedZ          : register(t121);
#endif

float4 main(float4 posIn : TEXCOORD0, float4 rayIn : TEXCOORD1) : SV_Target0
{
    // one exit only: the splice copies the code up to its first ret
    uint sw, sh, cw, ch;
    g_txShadowmap.GetDimensions(sw, sh);
    g_txCloudShadowMap.GetDimensions(cw, ch);
    float3 sun = 0.0;
#if FOG_SUN_DEBUG
    sun = (sw == 0 || sw != 3 * sh ? float3(1, 0, 0) : cw == 0 ? float3(0, 0, 1) : float3(0, 1, 0)) * (1.0 / 128.0);
#else
    // only the sun's cascade atlas (three cascades side by side, 3:1 at every Shadows setting and with SnowRunner
    // Shadows' scaling) counts; anything else left in the slot is not read
    [branch] if (sw != 0 && sw == 3 * sh)
    {
        const float3 P = posIn.xyz;
        const float d = dot(P - g_vEyePos, g_vViewDir.xyz);
#if FOG_SUN_DEPTH && !FOG_SUN_DEBUG
        // the opaque surface on this pixel's ray (every step of the march projects to the same place): a step behind it
        // is hidden by it, so its light never reaches the camera
        uint zw, zh;
        g_txFeedZ.GetDimensions(zw, zh);
        bool hidden = false;
        if (zw != 0)
        {
            const float4 q = float4(P, 1.0);
            const float4 cl = float4(dot(q, g_vViewProjCol[0]), dot(q, g_vViewProjCol[1]), dot(q, g_vViewProjCol[2]), dot(q, g_vViewProjCol[3]));
            if (cl.w > 0.05)
            {
                const float2 size = float2(zw, zh), uv = saturate(float2(cl.x / cl.w * 0.5 + 0.5, 0.5 - cl.y / cl.w * 0.5));
                hidden = d > g_txFeedZ.Load(int3(min(uv * size, size - 1.0), 0));
            }
        }
        [branch] if (!hidden)
#endif
        {
        const uint c = (uint)dot(float4(g_vSMCascadeDistances < d), 1.0);
        float light = 1.0;
        [branch] if (c < 4)
        {
            const uint k = min(c, 3u);
            const float4 q = float4(P, 1.0);
            const float4 clip = float4(dot(q, g_aSMViewProjCols[k * 4]), dot(q, g_aSMViewProjCols[k * 4 + 1]), dot(q, g_aSMViewProjCols[k * 4 + 2]),
                                       dot(q, g_aSMViewProjCols[k * 4 + 3]));
            const float2 st = clip.xy / clip.w, uv = st * g_aSMCascadeOffsets[k].zw + g_aSMCascadeOffsets[k].xy;
            // only inside the cascade's own square (outside it the atlas holds the next cascade, at another depth) and
            // inside the atlas (a cascade the game does not use has its offset far off it: 99999 for the fourth at the
            // top setting); elsewhere the sun counts as unblocked
            if (all(st >= 0.0) && all(st <= 1.0) && all(uv >= 0.0) && all(uv <= 1.0)) light = g_txShadowmap.SampleCmpLevelZero(sShadow, uv, saturate(clip.z / clip.w));
        }
#if FOG_SUN_CLOUDS
        if (cw != 0) light *= 1.0 - g_txCloudShadowMap.SampleLevel(sCloud, (P.xz + 0.5 - g_vTerrainSize.xy) * g_vTerrainSize.zw, 0).r;
#endif
        // Henyey-Greenstein relative to isotropic scattering; cos = the view ray (normalized by the march already)
        // against the direction to the sun; x^1.5 as x sqrt(x), the helper runs once per step
        const float mu = dot(rayIn.xyz, -g_vSunDir.xyz), g = FOG_SUN_G, x = max(1.0 + g * g - 2.0 * g * mu, 1e-4);
        const float phase = (1.0 - g * g) / (x * sqrt(x));
        sun = g_cSunColour.rgb * (light * phase * FOG_SUN);
        }
    }
#endif
    return float4(sun, 0.0);
}
