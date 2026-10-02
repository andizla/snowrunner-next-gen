// Blocker search spliced into SnowRunner's high quality shadow path by tools/shadow_filter_patch.js, in place of the
// stock 16 taps at fixed positions (the step that decides how soft each shadow edge gets; stuck taps make that size
// jump in steps as they cross an occluder's edge). 16 Gather fetches on a 4 x 4 grid read 64 depth texels over the
// same area (the stock offsets reach 0.63 of the search radius; the outer grid cells are centred there), with the
// stock formula: every texel counts as min(depth, receiver - 0.001), and the result is (receiver - average) / average,
// which the engine then turns into the penumbra size exactly as before.
// Contract with the splice: v0.xy = atlas uv, v0.z = receiver depth, v0.w = maximum penumbra (g_vSMPenumbraParams.z);
// v1.xy = engine kernel (cascade uv units), v1.zw = the cascade's atlas scale. Output o0.x = the ratio.
// t81 and s2 are g_txShadowmap and the point sampler the stock blocker taps use.
Texture2D g_txShadowmap : register(t81);
SamplerState g_samPoint : register(s2);

float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1) : SV_Target
{
    float2 extent = 0.84 * a.w * b.xy * b.zw; // cell centres at +-0.25 and +-0.75 of this: the outer ones at 0.63
    float limit = a.z - 0.001;
    float sum = 0;
    [unroll] for (int j = 0; j < 4; j++)
    {
        [unroll] for (int i = 0; i < 4; i++)
        {
            float2 t = (float2(i, j) + 0.5) * 0.5 - 1.0;
            float4 d = g_txShadowmap.GatherRed(g_samPoint, saturate(a.xy + t * extent));
            sum += dot(min(d, limit), 0.25);
        }
    }
    float average = sum * (1.0 / 16.0);
    return float4((a.z - average) / average, 0, 0, 0);
}
