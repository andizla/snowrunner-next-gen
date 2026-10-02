// Sky tinted ambient, spliced by tools/patch_ambient.js at the start of every material shader that reads the three
// ambient colours (g_ambientLight.cPosY/cMidY/cNegY = CB_GLOBAL_SCENE registers 50, 51, 52). Stock SnowRunner fills
// those from the daytime xml with one warm grey at three strengths, so fill light has no colour variation. Here each
// colour keeps its authored brightness (luminance) and takes the hue of the sky in its direction from the reflection
// cube the shader already binds (g_txReflCubeGGX, roughest mip ~ irradiance): up for cPosY, down for cNegY, the mean
// of four horizontal directions for cMidY; blended STRENGTH of the way. The engine's own blend by the normal is kept:
// every read of registers 50 to 52 is repointed at this helper's three results.
// Contract with the splice: no inputs; o0/o1/o2.rgb = the new cPosY/cMidY/cNegY. The sampler register is remapped to
// the one the target uses for t86.
#ifndef STRENGTH
#define STRENGTH 0.6
#endif
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 pad[50];
    float3 cPosY; float padPos;
    float3 cMidY; float padMid;
    float3 cNegY; float padNeg;
};
TextureCube g_txReflCubeGGX : register(t86);
SamplerState g_samCube : register(s0);

static const float3 LUMA = float3(0.2126, 0.7152, 0.0722);

float3 SkyTint(float3 authored, float3 sky)
{
    float la = dot(authored, LUMA);
    float ls = max(dot(sky, LUMA), 1e-4);
    return lerp(authored, sky * (la / ls), STRENGTH);
}

struct Out { float4 up : SV_Target0; float4 mid : SV_Target1; float4 down : SV_Target2; };

Out main()
{
    float3 up = g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 1, 0), 16).rgb;
    float3 down = g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, -1, 0), 16).rgb;
    float3 side = (g_txReflCubeGGX.SampleLevel(g_samCube, float3(1, 0, 0), 16).rgb + g_txReflCubeGGX.SampleLevel(g_samCube, float3(-1, 0, 0), 16).rgb
                 + g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 0, 1), 16).rgb + g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 0, -1), 16).rgb) * 0.25;
    Out o;
    o.up = float4(SkyTint(cPosY, up), 0);
    o.mid = float4(SkyTint(cMidY, side), 0);
    o.down = float4(SkyTint(cNegY, down), 0);
    return o;
}
