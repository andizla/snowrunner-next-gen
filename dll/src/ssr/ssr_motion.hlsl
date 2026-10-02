// SnowRunner Shadows: screen-space reflections, t124: the object motion of this frame in plain numbers for the
// material shaders' reprojection (and the resolve's next frame). The game's velocity texture (written by pixel shader
// 2EDA6865 for moving objects, read by its TAA 4F5C33DA at t3) holds per pixel xy = sign(d) x sqrt(|d| / 256) x 0.498
// + 0.498 with d = this pixel - where the point was last frame, in pixels, and (1, 1) where no object wrote (the TAA
// then reprojects by the camera). Decoded as the TAA does: e = xy x 2.007874 - 1, d = sign(e) e^2 x 256.
// Output: xy = uv motion from last frame to this one (current uv - previous uv), z = 1 where an object wrote, else 0.
// Inputs: t0 the game's velocity texture; s1 point clamp; u0 t124.
#include "ssr_common.hlsli"

Texture2D<float4> g_velocity : register(t0);
SamplerState      g_point    : register(s1);
RWTexture2D<float4> g_out    : register(u0);

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= uint2(g_size))) return;
    const float4 v = g_velocity.SampleLevel(g_point, (float2(id.xy) + 0.5) * g_invSize, 0);
    if (all(v.xy > 0.999)) { g_out[id.xy] = 0.0; return; }
    const float2 e = v.xy * 2.007874 - 1.0;
    g_out[id.xy] = float4(sign(e) * e * e * 256.0 * g_invSize, 1.0, 0.0);
}
