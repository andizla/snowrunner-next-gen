// Sun shadow filter spliced into SnowRunner's high quality shadow path (the 1269 shaders with the 16-tap Poisson PCF,
// trucks, objects and terrain) by tools/shadow_filter_patch.js. It replaces only the filter: the engine's cascade
// choice, blocker search and penumbra estimate stay as they are and arrive here as the kernel size.
// The stock filter takes 16 compare taps at fixed Poisson positions, stretched per axis and scaled by the penumbra.
// When the penumbra spans more texels than 16 taps cover, every tap adds its own stair stepped copy of the edge.
// This filter is a tent over a grid of bilinear compare taps whose spacing is measured in real texels (from the
// texture itself), with as many taps per axis as the width needs (2 to 8). No noise, so it needs no TAA.
// Contract with the splice: v0.xy = atlas uv, v0.z = receiver depth, v1.xy = engine kernel (cascade uv units),
// v1.zw = the cascade's atlas scale; output o0.x = lit fraction. t81 and s15 are g_txShadowmap and its comparison
// sampler, so the copied instructions address them as they are.
#ifndef SPREAD
#define SPREAD 1.6   // tent half width in engine kernel units; 1.6 matches the spread of the stock taps
#endif
Texture2D g_txShadowmap : register(t81);
SamplerComparisonState g_samShadowmapCmp : register(s15);

float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1) : SV_Target
{
    float2 size;
    g_txShadowmap.GetDimensions(size.x, size.y);
    float2 radius = SPREAD * b.xy * b.zw;             // tent half width, atlas uv
    float2 radiusTexels = radius * size;
    float widest = max(radiusTexels.x, radiusTexels.y);
    uint n = (uint)clamp(ceil(widest * (2.0 / 1.5)), 2.0, 8.0);   // taps per axis, at most 1.5 texels apart up to 6 texels
    float step = 2.0 / n;
    float sum = 0, weights = 0;
    [loop] for (uint j = 0; j < n; j++)
    {
        float ty = (j + 0.5) * step - 1.0;
        float wy = 1.0 - abs(ty);
        [loop] for (uint i = 0; i < n; i++)
        {
            float tx = (i + 0.5) * step - 1.0;
            float w = (1.0 - abs(tx)) * wy;
            sum += w * g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, saturate(a.xy + float2(tx, ty) * radius), a.z);
            weights += w;
        }
    }
    return float4(sum / weights, 0, 0, 0);
}
