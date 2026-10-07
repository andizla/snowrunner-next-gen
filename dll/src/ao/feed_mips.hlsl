// One level of the scene feed's mip chain from the level above it. SnowRunner Shadows makes the chain itself, a dispatch
// per level, because the runtime's GenerateMips left the levels empty under a ReShade add-on that changes texture
// formats. Each texel is the mean of the texels above it that it covers (one bilinear read at its centre: the four of a
// level twice its size), never negative, NaN or infinite, so one broken pixel of the lit scene cannot spread down the
// chain.
// Build: fxc -T cs_5_0 -E main feed_mips.hlsl

Texture2D<float4>   g_above : register(t0);    // the level above, alone in its view
RWTexture2D<float4> g_level : register(u0);    // the level to make
SamplerState        g_linear : register(s0);   // linear, clamped

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    uint w, h;
    g_level.GetDimensions(w, h);
    if (id.x >= w || id.y >= h) return;
    const float4 c = g_above.SampleLevel(g_linear, (float2(id.xy) + 0.5) / float2(w, h), 0);
    g_level[id.xy] = min(max(c, 0.0), 64000.0);
}
