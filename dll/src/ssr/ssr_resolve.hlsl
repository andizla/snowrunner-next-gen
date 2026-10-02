// SnowRunner Shadows: screen-space reflections, the resolve (full resolution). Every reflecting pixel gathers the rays
// of the 3 x 3 trace cells around it (their hit colours stand for parallel rays from nearby points; weighted by the
// distance, the depth and the normal, so nothing crosses an edge), then blends with its own result of the last frame,
// found where the pixel was then (the camera's reprojection, or the object motion of the previous t124 where a moving
// object was) and trusted only where last frame's depth there agrees; the history is clipped toward the current samples'
// mean (variance clipping) so a stale reflection cannot linger. The output is t123 for the material shaders and next frame's
// history: (radiance x confidence, confidence), 0 on pixels that do not reflect.
// Inputs: t0 the trace grid, t1 linear depth, t3 render target 7, t4 the history (last frame's output), t5 last frame's
// linear depth, t6 last frame's t124; s0 linear clamp, s1 point clamp; u0 the output. (t2 not used.)
// (The 3 x 3 cells read once per 8 x 8 group into group memory give the same output to the bit but no time,
// 0.21 ms either way at 4K: the pass is bound by its full-size reads and writes, the cells come from the cache anyway)
#include "ssr_common.hlsli"

Texture2D<float4> g_hit       : register(t0);
Texture2D<float>  g_depth     : register(t1);
Texture2D<float4> g_rt7       : register(t3);
Texture2D<float4> g_history   : register(t4);
Texture2D<float>  g_prevDepth : register(t5);
Texture2D<float4> g_motion    : register(t6);
SamplerState      g_linear    : register(s0);
SamplerState      g_point     : register(s1);
RWTexture2D<float4> g_out     : register(u0);

// the surface at a pixel as the trace saw it: normal and roughness; false where no ray is traced
bool Surface(uint2 pix, float3 toEye, out float3 n, out float rough)
{
    if (g_flags & kFlagMirror) { n = DepthNormal(g_depth, int2(pix), toEye); rough = 0.0; return true; }
    return Rt7(g_rt7.Load(int3(pix, 0)), n, rough) && rough < g_roughMax;
}

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    const uint2 pix = id.xy;
    if (any(pix >= uint2(g_size))) return;
    const float z = g_depth.Load(int3(pix, 0));
    const float2 uv = (float2(pix) + 0.5) * g_invSize;
    float3 N;
    float rough;
    const float3 P = WorldPos(uv, z);
    const float3 V = normalize(g_vEyePos.xyz - P);
    if (z <= 0.0 || z >= kSky || !Surface(pix, V, N, rough)) { g_out[pix] = 0.0; return; }

    // this frame's rays around the pixel
    const int2 cell = int2(pix / g_step);
    const float sigma2 = 2.0 * float(g_step * g_step) * (1.0 + 8.0 * rough * rough);
    float4 sum = 0.0, sum2 = 0.0;
    float wsum = 0.0;
    [unroll] for (int dy = -1; dy <= 1; dy++)
    [unroll] for (int dx = -1; dx <= 1; dx++)
    {
        const int2 c = cell + int2(dx, dy);
        if (any(c < 0) || any(c >= int2(g_traceSize))) continue;
        const uint2 sp = CellPixel(uint2(c), g_frame);
        const float zs = g_depth.Load(int3(sp, 0));
        float3 ns;
        float rs;
        if (zs <= 0.0 || zs >= kSky || !Surface(sp, V, ns, rs)) continue;
        const float2 off = float2(sp) - float2(pix);
        const float w = exp(-dot(off, off) / sigma2) * saturate(1.0 - abs(zs - z) / (0.03 * z + 0.02)) * pow(saturate(dot(ns, N)), 16.0);
        if (w <= 1e-4) continue;
        const float4 h = g_hit.Load(int3(c, 0));
        sum += h * w;
        sum2 += h * h * w;
        wsum += w;
    }
    const bool haveCurrent = wsum > 1e-4;
    const float4 current = haveCurrent ? sum / wsum : 0.0;
    const float4 spread = haveCurrent ? sqrt(max(sum2 / wsum - current * current, 0.0)) : 0.0;

    // last frame's result where this surface was then
    float4 history = 0.0;
    bool valid = false;
    if (g_flags & kFlagHistory)
    {
        bool object = false;
        float2 uvPrev = uv;
        float zExpected = z;
        if (g_flags & kFlagMotion)
        {
            const float4 m = g_motion.SampleLevel(g_point, uv, 0);
            if (m.z > 0.5) { uvPrev = uv - m.xy; object = true; }
        }
        if (!object) { const float3 pp = Project(P, true); uvPrev = pp.xy; zExpected = pp.z; }
        if (all(uvPrev >= 0.0) && all(uvPrev <= 1.0))
        {
            const float zp = g_prevDepth.SampleLevel(g_point, uvPrev, 0);
            valid = object ? abs(zp - z) < 0.1 * z + 0.3 : abs(zp - zExpected) < 0.02 * zExpected + 0.05;
            if (valid) history = g_history.SampleLevel(g_linear, uvPrev, 0);
        }
    }

    float4 result = current;
    if (valid && haveCurrent)
    {
        // variance clipping toward the mean (Salvi 2016): the history moves along the line to this frame's mean until it
        // lies within 1.5 standard deviations of the rays around it, all channels by the same factor, so it stays a blend
        // of colours that are there (a per-channel clamp against a few noisy rays biases rough surfaces)
        const float4 ext = max(1.5 * spread, 0.01 + 0.02 * abs(current));
        const float4 d = history - current;
        const float4 u = abs(d) / ext;
        const float m = max(max(u.x, u.y), max(u.z, u.w));
        if (m > 1.0) history = current + d / m;
        const float keep = lerp(0.6, g_temporal, saturate(rough / 0.3));            // mirrors need little history
        result = lerp(current, history, keep);
    }
    else if (valid) result = history * 0.9;                                         // no ray landed near: fade what was
    g_out[pix] = max(result, 0.0);
}
