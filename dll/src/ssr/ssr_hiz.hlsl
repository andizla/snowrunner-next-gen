// SnowRunner Shadows: screen-space reflections, the depth pyramid. Level 0 = 1 / linear depth (0 for the sky, so no
// ray ever meets it); every coarser level holds the largest value (the nearest surface) of the texels it covers,
// including the extra row and column of an odd-sized level below, so a cell never claims more room than there is.
// Entry points: level0 (t0 = this frame's linear depth, u0 = level 0), reduce (t0 = the level below, u0 = the level).
#include "ssr_common.hlsli"

Texture2D<float> g_src : register(t0);
RWTexture2D<float> g_dst : register(u0);

[numthreads(8, 8, 1)]
void level0(uint3 id : SV_DispatchThreadID)
{
    uint w, h;
    g_dst.GetDimensions(w, h);
    if (id.x >= w || id.y >= h) return;
    const float z = g_src.Load(int3(id.xy, 0));
    g_dst[id.xy] = z > 0.0 && z < kSky ? 1.0 / z : 0.0;
}

[numthreads(8, 8, 1)]
void reduce(uint3 id : SV_DispatchThreadID)
{
    uint w, h, pw, ph;
    g_dst.GetDimensions(w, h);
    g_src.GetDimensions(pw, ph);
    if (id.x >= w || id.y >= h) return;
    const int2 p = int2(id.xy) * 2;
    const int2 last = int2(pw, ph) - 1;
    float m = max(max(g_src.Load(int3(min(p, last), 0)), g_src.Load(int3(min(p + int2(1, 0), last), 0))),
                  max(g_src.Load(int3(min(p + int2(0, 1), last), 0)), g_src.Load(int3(min(p + int2(1, 1), last), 0))));
    const bool extraX = (pw & 1u) && id.x == w - 1, extraY = (ph & 1u) && id.y == h - 1;
    if (extraX) m = max(m, max(g_src.Load(int3(min(p + int2(2, 0), last), 0)), g_src.Load(int3(min(p + int2(2, 1), last), 0))));
    if (extraY) m = max(m, max(g_src.Load(int3(min(p + int2(0, 2), last), 0)), g_src.Load(int3(min(p + int2(1, 2), last), 0))));
    if (extraX && extraY) m = max(m, g_src.Load(int3(min(p + int2(2, 2), last), 0)));
    g_dst[id.xy] = m;
}
