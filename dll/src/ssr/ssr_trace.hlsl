// SnowRunner Shadows: screen-space reflections, the trace. One ray per cell of the trace grid (a pixel, or the pixel of
// a 2 x 2 block whose turn it is this frame): the surface's normal and roughness from the splice's render target 7, a
// reflection direction drawn from the GGX distribution of visible normals (Heitz 2018) with per-frame noise, then a
// walk through the depth pyramid (ssr_hiz.hlsl): the ray skips whole cells while it stays nearer than their nearest
// surface and steps down a level when it would cross one, until it stands behind a surface at level 0 (Traverse() is
// adapted from AMD FidelityFX SSSR's FFX_SSSR_InitialAdvanceRay / FFX_SSSR_AdvanceRay / FFX_SSSR_HierarchicalRaymarch in
// ffx_sssr.hlsli, Copyright (c) 2021 Advanced Micro Devices, Inc., MIT licence, whose notice ships with the DLL; after
// Uludag's Hi-Z tracing). The hit is
// kept when it is on screen, beyond the first pixels, not sky, not a back face and not deeper behind the surface there
// than the thickness allows; its colour is this frame's lit scene (the feed's copy, blurred by the ray's cone on
// rougher surfaces). Output per cell: (colour x confidence, confidence), 0 = no reflection.
// Inputs: t0 lit scene (mips), t1 linear depth, t3 render target 7, t4 the pyramid (all levels); s0 linear clamp; u0 the
// trace grid. (t2 is not used: it held the lit pass's render target 1, which the game has cleared by then.)
#include "ssr_common.hlsli"

Texture2D<float3> g_colour : register(t0);
Texture2D<float>  g_depth  : register(t1);
Texture2D<float4> g_rt7    : register(t3);
Texture2D<float>  g_hiz    : register(t4);
SamplerState      g_linear : register(s0);
RWTexture2D<float4> g_hit  : register(u0);
RWByteAddressBuffer g_stats : register(u1);   // [0] rays traced, [4] rays that kept a hit (the log's share of glossy pixels)
groupshared uint gs_rays, gs_hits;

static const float PI = 3.14159265;

// a visible normal of the GGX distribution with roughness alpha seen from direction v (tangent space, z = normal),
// for the uniform numbers u (Heitz 2018, "Sampling the GGX Distribution of Visible Normals")
float3 SampleVisibleNormal(float3 v, float alpha, float2 u)
{
    const float3 vh = normalize(float3(alpha * v.x, alpha * v.y, v.z));
    const float lensq = vh.x * vh.x + vh.y * vh.y;
    const float3 t1 = lensq > 0.0 ? float3(-vh.y, vh.x, 0.0) * rsqrt(lensq) : float3(1.0, 0.0, 0.0);
    const float3 t2 = cross(vh, t1);
    const float r = sqrt(u.x), phi = 2.0 * PI * u.y;
    const float p1 = r * cos(phi);
    const float s = 0.5 * (1.0 + vh.z);
    const float p2 = (1.0 - s) * sqrt(1.0 - p1 * p1) + s * r * sin(phi);
    const float3 nh = p1 * t1 + p2 * t2 + sqrt(max(0.0, 1.0 - p1 * p1 - p2 * p2)) * vh;
    return normalize(float3(alpha * nh.x, alpha * nh.y, max(0.0, nh.z)));
}

// the pyramid's value of the cell under uv at a level (clamped to the level's real size: its last row and column
// also cover the remainder of an odd size)
float Pyramid(float2 cellPos, int level)
{
    const int2 size = max(int2(uint2(g_size) >> uint(level)), 1);
    return g_hiz.Load(int3(clamp(int2(cellPos), 0, size - 1), level));
}

// walks the ray o + t d (uv, iz) through the pyramid; true when it ends behind a surface at level 0 within g_maxSteps
bool Traverse(float3 o, float3 d, out float3 hit, out float tHit)
{
    const float3 invD = float3(d.x != 0.0 ? 1.0 / d.x : 1e32, d.y != 0.0 ? 1.0 / d.y : 1e32, d.z != 0.0 ? 1.0 / d.z : 1e32);
    const float2 floorOffset = float2(d.xy >= 0.0);                                 // the cell's far edge in each axis
    const float2 uvOffset = 0.005 * g_invSize * float2(d.x >= 0.0 ? 1.0 : -1.0, d.y >= 0.0 ? 1.0 : -1.0); // just past it
    int level = 0;
    float2 res = g_size;
    // to the edge of the level-0 cell the ray starts in
    float2 plane = (floor(res * o.xy) + floorOffset) / res + uvOffset;
    float2 t2 = (plane - o.xy) * invD.xy;
    float t = min(t2.x, t2.y);
    float3 pos = o + t * d;
    uint i = 0;
    const int top = int(g_levels) - 1;
    [loop] while (i < g_maxSteps && level >= 0)
    {
        if (any(pos.xy < 0.0) || any(pos.xy > 1.0)) break;                          // left the screen
        const float2 cellPos = res * pos.xy;
        const float surface = Pyramid(cellPos, level);
        plane = (floor(cellPos) + floorOffset) / res + uvOffset;
        float3 tt = (float3(plane, surface) - o) * invD;
        tt.z = d.z < 0.0 ? tt.z : 1e32;                                             // the depth plane only while moving away
        const float tMin = min(min(tt.x, tt.y), tt.z);
        const bool above = surface < pos.z;                                         // nearer than the cell's nearest surface
        const bool skipped = asuint(tMin) != asuint(tt.z) && above;
        t = above ? tMin : t;
        pos = o + t * d;
        level += skipped ? 1 : -1;
        if (level > top) level = top;
        res = g_size * exp2(-float(level));
        ++i;
    }
    hit = pos;
    tHit = t;
    return level < 0;
}

// whether the surface at pixel hp (depth zs) is a small glowing thing with nothing around it (a firefly model; the
// water's SSR_OCCL_SPECK, engine\replacements\water\ssr_planar.hlsl): on at least three of four sides, 2 %
// of the screen's height away, another depth, and at least three times as bright as the brightest of those four. Such
// a thing has no underside to stand for: a ray behind it passed behind it
bool Speck(int2 hp, float zs)
{
    const int r = max(int(0.02 * g_size.y), 2);
    const int2 o[4] = { int2(r, 0), int2(-r, 0), int2(0, r), int2(0, -r) };
    const float3 lw = float3(0.2126, 0.7152, 0.0722);
    const float tol = 0.3 + 0.02 * zs;
    int apart = 0;
    float around = 0.0;
    for (int i = 0; i < 4; i++)
    {
        const int2 q = clamp(hp + o[i], 0, int2(g_size) - 1);
        apart += abs(g_depth.Load(int3(q, 0)) - zs) > tol ? 1 : 0;
        around = max(around, dot(g_colour.Load(int3(q, 0)), lw));
    }
    return apart >= 3 && dot(g_colour.Load(int3(hp, 0)), lw) > 3.0 * around;
}

float4 TracePixel(uint2 pix, float2 uv, float z, out bool traced)
{
    traced = false;
    const float3 P = WorldPos(uv, z);
    const float3 V = normalize(g_vEyePos.xyz - P);
    const bool mirror = (g_flags & kFlagMirror) != 0;
    float3 n7;
    float rough7;
    const bool written = Rt7(g_rt7.Load(int3(pix, 0)), n7, rough7);
    if (!mirror && !written) return 0.0;
    float3 N = mirror ? DepthNormal(g_depth, int2(pix), V) : n7;
    const float rough = mirror ? 0.0 : rough7;
    if (rough >= g_roughMax) return 0.0;
    traced = true;
    const float nv = dot(N, V);
    if (nv < 0.01) N = normalize(N + V * (0.01 - nv));                              // a normal-mapped normal facing away

    // the reflection direction: the mirror (roughness then only blurs the hit, see the cone below), or with SSRLobe=1 a
    // visible GGX normal's mirror on surfaces that are not smooth
    const float alpha = rough * rough;
    float3 H = N;
    if ((g_flags & kFlagLobe) && alpha > 0.0025)
    {
        const float3 T = normalize(cross(abs(N.y) < 0.999 ? float3(0.0, 1.0, 0.0) : float3(1.0, 0.0, 0.0), N));
        const float3 B = cross(N, T);
        const float2 u = float2(Noise(float2(pix), g_frame, 0u), Noise(float2(pix), g_frame, 1u)) * float2(0.85, 1.0); // the lobe's core
        const float3 h = SampleVisibleNormal(float3(dot(V, T), dot(V, B), dot(V, N)), alpha, u);
        H = normalize(h.x * T + h.y * B + h.z * N);
    }
    float3 R = reflect(-V, H);
    if (dot(R, N) < 0.001) R = reflect(-V, N);

    // the ray on screen: from just off the surface to a point far along it, or to just short of the near plane
    const float3 O = P + N * (0.002 * z + 0.01);
    const float rz = dot(R, g_vViewDir.xyz);
    const float zo = dot(float4(O, 1.0), g_vViewDir);
    float len = 1000.0;
    if (rz < -1e-4) len = min(len, (zo - 0.7) / -rz * 0.98);
    if (len <= 0.01) return 0.0;
    const float3 s0 = Project(O, false), s1 = Project(O + R * len, false);
    const float3 o = float3(s0.xy, 1.0 / s0.z);
    const float3 d = float3(s1.xy, 1.0 / s1.z) - o;

    float3 hit;
    float tHit;
    if (!Traverse(o, d, hit, tHit) || tHit > 1.0) return 0.0;
    if (any(hit.xy < 0.0) || any(hit.xy > 1.0)) return 0.0;
    const int2 hp = int2(hit.xy * g_size);
    if (all(abs(hp - int2(pix)) <= 1)) return 0.0;                                  // never left the pixel
    const float zs = g_depth.Load(int3(hp, 0));
    if (zs <= 0.0 || zs >= kSky) return 0.0;
    const float3 Ps = WorldPos(hit.xy, zs);
    float3 ns7;
    float roughS;
    const bool writtenS = Rt7(g_rt7.Load(int3(hp, 0)), ns7, roughS);
    const float3 Ns = !mirror && writtenS ? ns7 : DepthNormal(g_depth, hp, normalize(g_vEyePos.xyz - Ps));
    if (dot(Ns, R) > 0.0) return 0.0;                                               // the back of a surface (or a ray grazing away from it)

    // how far behind the surface there the ray stands; the thickness grows with depth
    const float behind = 1.0 / max(hit.z, 1e-6) - zs;
    const float thick = g_thickness * (1.0 + 0.02 * zs);
    float conf = 1.0 - smoothstep(0.0, thick, behind);
    conf *= conf;
    // Deeper behind it than the thickness, the ray went under that object (the cab over the hood, a load over the bed).
    // With no reflection there the material falls back on the game's fixed sky cubemap, which draws bright patches beside
    // what the pass does reflect (a hood under the cab's roof). So, as the water's SSR_OCCL: within g_under metres (plus
    // 5 % of the depth) the ray takes that object's
    // colour, darkened towards g_underShade over half a metre past the thickness, for the side the screen cannot show;
    // in full behind surfaces up to g_underNear metres away, none from g_underFar; not behind a firefly (Speck)
    float shade = 1.0;
    [branch] if (g_under > 0.0 && behind > 0.0)
    {
        const float fade = saturate((g_underFar - zs) / max(g_underFar - g_underNear, 1e-3));
        const float under = g_under + 0.05 * zs;
        if (fade > 0.0 && behind < under && !Speck(hp, zs))
        {
            shade = lerp(1.0, g_underShade, saturate((behind - thick) / 0.5));
            conf = max(conf, fade * (1.0 - smoothstep(0.8 * under, under, behind)));
        }
    }
    const float2 fade = 0.05 * float2(g_size.y * g_invSize.x, 1.0);
    const float2 border = smoothstep(0.0, fade, hit.xy) * (1.0 - smoothstep(1.0 - fade, 1.0, hit.xy));
    conf *= border.x * border.y;
    conf *= saturate((g_roughMax - rough) / (0.2 * g_roughMax));
    conf *= saturate((dot(R, -V) + 1.0) * 2.0);   // a ray heading back at the camera fades (what is behind it no image has)
    if (conf <= 0.0) return 0.0;

    // the colour of the pixel whose depth was checked (the walk ends on a pixel's edge: sampling there would mix in the
    // neighbour across it, e.g. the floor under a wall), blurred by the ray's cone on rougher surfaces
    const float travelled = length((hit.xy - uv) * g_size);
    const float mip = log2(1.0 + travelled * alpha * g_cone);
    const float3 c = min(max(g_colour.SampleLevel(g_linear, (float2(hp) + 0.5) * g_invSize, mip), 0.0), 64.0) * shade;
    return float4(c * conf, conf);
}

[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID, uint gi : SV_GroupIndex)
{
    if (gi == 0) { gs_rays = 0; gs_hits = 0; }
    GroupMemoryBarrierWithGroupSync();
    if (all(id.xy < g_traceSize))
    {
        const uint2 pix = CellPixel(id.xy, g_frame);
        const float2 uv = (float2(pix) + 0.5) * g_invSize;
        const float z = g_depth.Load(int3(pix, 0));
        bool traced = false;
        float4 result = 0.0;
        [branch] if (z > 0.0 && z < kSky) result = TracePixel(pix, uv, z, traced);
        g_hit[id.xy] = result;
        if (traced) InterlockedAdd(gs_rays, 1u);
        if (result.a > 0.0) InterlockedAdd(gs_hits, 1u);
    }
    GroupMemoryBarrierWithGroupSync();
    if (gi == 0 && gs_rays) { uint old; g_stats.InterlockedAdd(0, gs_rays, old); g_stats.InterlockedAdd(4, gs_hits, old); }
}
