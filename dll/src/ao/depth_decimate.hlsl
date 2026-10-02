// Levels 1..4 of the linear depth the AO pass reads (t80), decimated, for GTAO's AO_DEPTH_LOD=2 far taps:
// a level-k texel holds the full-size depth at (texel * 2^k), exactly, so a tap the AO pass moves there reads the same
// value from this small texture as from the full-size one, from a few cached texels. One thread per level-1 texel reads
// one depth and writes it to every level whose grid it falls on. Output texture: half the depth's size, 4 levels
// (its level i = level i + 1 of the chain; sizes rounded down, as D3D rounds mips).
// Build: fxc -T cs_5_0 -E main depth_decimate.hlsl

cbuffer DepthDecimate : register(b0)
{
    uint2 g_size1;        // level 1's size (the output texture's level 0)
    uint2 g_full;         // the depth's size
};
Texture2D<float>   g_depth : register(t0);
RWTexture2D<float> g_l1 : register(u0);
RWTexture2D<float> g_l2 : register(u1);
RWTexture2D<float> g_l3 : register(u2);
RWTexture2D<float> g_l4 : register(u3);

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= g_size1)) return;
    const float z = g_depth[min(id.xy * 2, g_full - 1)];
    g_l1[id.xy] = z;
    if (all((id.xy & 1u) == 0u)) g_l2[id.xy >> 1] = z;
    if (all((id.xy & 3u) == 0u)) g_l3[id.xy >> 2] = z;
    if (all((id.xy & 7u) == 0u)) g_l4[id.xy >> 3] = z;
}
