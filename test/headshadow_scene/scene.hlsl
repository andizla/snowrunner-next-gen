// Offline test scene for the headlight shadows: a synthetic night scene ray-cast per pixel (ground, a truck body at the
// lamps, posts, a pole, a concrete block, a low block within reach of the lamps, a wall, a guardrail on posts, a thin
// marker post, and with OVERLAY_H a patch of road whose depth lies above its shaded pixels), lit by one headlight shaped like
// the game's (cone, reach, the fade within 3 to 6 m of the lamp). Pass 1 (depth_ps) writes the scene's linear depth, the
// value SnowRunner Shadows copies to t121 in the game; pass 2 (shade_ps) shades the scene and asks the helper itself,
// engine\replacements\headlight\headshadow.hlsl (included, its main called as a function, its defines overridable with -D),
// how much of the headlight reaches each point. Driven by scene.cpp; see run.ps1.

#include "../../engine/replacements/headlight/headshadow.hlsl"

cbuffer Scene : register(b3)
{
    float3 s_eye;   float s_sx;     // camera position; x scale of the projection
    float3 s_right; float s_sy;     // camera axes (orthonormal); y scale of the projection
    float3 s_up;    float s_mode;   // 0 = with the helper's shadows, 1 = the game's own light, 2 = the helper's value alone
    float3 s_fwd;   float s_ss;     // sub-samples per axis (the game's TAA averages the steps' per-pixel offset)
    float3 s_lamp;  float s_pad0;   // the headlight's position and direction, as the game hands them to its shaders
    float3 s_dir;   float s_pad1;
    float2 s_size;  float2 s_pad2;  // target size in pixels
};

struct Box { float3 lo; float3 hi; float albedo; };
// metres; x to the right of the truck, y up, z ahead of its front (the lamps at z = 0.05)
#define BOX_COUNT 20
static const Box BOXES[BOX_COUNT] =
{
    { float3(-1.00, 0.45, -4.60), float3(1.00, 1.25, 0.00), 0.12 },   // the truck's body and hood
    { float3(-0.95, 1.25, -2.60), float3(0.95, 2.00, -1.00), 0.12 },  // its cab
    { float3( 0.30, 0.00,  1.60), float3(0.90, 0.50, 2.20), 0.50 },   // a low block 1.6 m ahead of the bumper
    { float3(-1.90, 0.00,  6.00), float3(-1.60, 1.60, 6.30), 0.60 },  // a post, front left
    { float3( 1.20, 0.00,  9.00), float3(1.50, 1.60, 9.30), 0.60 },   // a post, right
    { float3(-0.10, 0.00, 13.00), float3(0.10, 2.50, 13.20), 0.45 },  // a thin pole in the middle
    { float3(-2.60, 0.00, 11.00), float3(-1.40, 0.80, 11.60), 0.50 }, // a concrete block
    { float3(-8.00, 0.00, 22.00), float3(8.00, 3.00, 22.50), 0.40 },  // a wall across the road
    { float3( 3.50, 0.00,  4.00), float3(3.80, 2.20, 4.30), 0.45 },   // a post beside the beam
    { float3(-1.05, 0.30,  0.00), float3(1.05, 0.62, 0.22), 0.20 },   // the front bumper, below the lamps
    { float3(-0.25, 0.40,  0.22), float3(0.25, 0.66, 0.45), 0.15 },   // a winch on it
    { float3(-0.50, 0.30,  0.40), float3(-0.42, 1.30, 0.48), 0.25 },  // a bull bar's two uprights, between the lamps
    { float3( 0.42, 0.30,  0.40), float3(0.50, 1.30, 0.48), 0.25 },
    // a guardrail along the left side of the road: a rail 0.3 m high on posts every 3 m (thin casters standing where the
    // verge takes their shadows, the case seen in the game on 2026-10-23)
    { float3(-3.30, 0.55,  4.00), float3(-3.24, 0.85, 19.00), 0.55 },
    { float3(-3.20, 0.00,  5.00), float3(-3.12, 0.80,  5.08), 0.50 },
    { float3(-3.20, 0.00,  8.00), float3(-3.12, 0.80,  8.08), 0.50 },
    { float3(-3.20, 0.00, 11.00), float3(-3.12, 0.80, 11.08), 0.50 },
    { float3(-3.20, 0.00, 14.00), float3(-3.12, 0.80, 14.08), 0.50 },
    { float3(-3.20, 0.00, 17.00), float3(-3.12, 0.80, 17.08), 0.50 },
    // a thin marker post at the right edge, 5 cm thick
    { float3( 2.60, 0.00, 15.00), float3(2.65, 1.40, 15.05), 0.55 },
};
// a patch of road whose depth is drawn OVERLAY_H metres above where its pixels are shaded: what the game's road overlays,
// decals with a depth bias or parallax-mapped asphalt do (the dark quad seen in the game on 2026-10-23); 0 = none
#ifndef OVERLAY_H
#define OVERLAY_H 0.0
#endif
static const float4 OVERLAY = float4(1.60, 4.6, 3.40, 9.0);    // x0, z0, x1, z1 on the ground, ahead and right of the truck, clear of every caster's shadow
static const float GROUND_ALBEDO = 0.30;
static const float AMBIENT = 0.02;
static const float3 SKY = float3(0.010, 0.014, 0.030);

struct Hit { float t; float3 n; float albedo; bool ground; };

Hit Trace(float3 o, float3 d)
{
    Hit h;
    h.t = 1e9; h.n = float3(0, 1, 0); h.albedo = 0; h.ground = false;
    if (d.y < 0.0) { h.t = -o.y / d.y; h.albedo = GROUND_ALBEDO; h.ground = true; }
    const float3 inv = 1.0 / d;
    [unroll] for (int i = 0; i < BOX_COUNT; i++)
    {
        const float3 t0 = (BOXES[i].lo - o) * inv, t1 = (BOXES[i].hi - o) * inv;
        const float3 a = min(t0, t1), b = max(t0, t1);
        const float tn = max(max(a.x, a.y), a.z), tf = min(min(b.x, b.y), b.z);
        if (tn > 0.0 && tn < tf && tn < h.t)
        {
            h.t = tn; h.albedo = BOXES[i].albedo; h.ground = false;
            h.n = tn == a.x ? float3(-sign(d.x), 0, 0) : tn == a.y ? float3(0, -sign(d.y), 0) : float3(0, 0, -sign(d.z));
        }
    }
    return h;
}

// the camera ray through a pixel; its forward component is 1, so the distance along it is the view depth
float3 CamDir(float2 px)
{
    const float2 s = float2(px.x / s_size.x * 2.0 - 1.0, 1.0 - px.y / s_size.y * 2.0);
    return s_right * (s.x / s_sx) + s_up * (s.y / s_sy) + s_fwd;
}

// the headlight as the game shapes it: a cone, a reach, the fade within 3 to 6 m of the lamp, the surface's facing
float Headlight(float3 P, float3 N)
{
    const float3 toP = P - s_lamp;
    const float d = length(toP);
    const float3 l = toP / max(d, 1e-3);
    const float cone = smoothstep(0.82, 0.94, dot(l, normalize(s_dir)));
    float reach = saturate(1.0 - d / 45.0); reach *= reach;
    const float nearFade = saturate((d - 3.0) / 3.0);
    return 30.0 * cone * reach * nearFade * saturate(dot(N, -l)) / (1.0 + 0.04 * d * d);
}

// pass 1: the linear depth (t121) and, for timing the helper alone, the world position with 1 in w inside the beam
struct DepthOut { float depth : SV_Target0; float4 pos : SV_Target1; };
DepthOut depth_ps(float4 pos : SV_Position)
{
    const float3 d = CamDir(pos.xy);
    const Hit h = Trace(s_eye, d);
    DepthOut o;
    o.depth = h.albedo > 0.0 ? h.t : 1e4;
    const float3 P = s_eye + d * h.t, toP = P - s_lamp;
    // the overlay: its depth is the plane OVERLAY_H above the ground (the view depth, as the ray's forward component is 1)
    if (OVERLAY_H > 0.0 && h.ground && P.x > OVERLAY.x && P.x < OVERLAY.z && P.z > OVERLAY.y && P.z < OVERLAY.w)
        o.depth = (OVERLAY_H - s_eye.y) / d.y;
    o.pos = float4(P, h.albedo > 0.0 && dot(normalize(toP), normalize(s_dir)) > 0.82 && length(toP) < 45.0 ? 1.0 : 0.0);
    return o;
}

// timing the helper alone (modes 3 and 4): each pixel's position from pass 1, the helper called inside the beam (mode 3)
// or not (mode 4); the difference is the helper's cost without the scene's ray casting around it
Texture2D<float4> g_txPos : register(t0);
float4 helper_ps(float4 pos : SV_Position) : SV_Target
{
    const float4 p = g_txPos.Load(int3(pos.xy, 0));
    float v = 1.0;
    if (s_mode == 3.0 && p.w > 0.5) v = main(float4(p.xyz, 1.0)).x;
    return float4(v, p.w, 0.0, 1.0);
}

float4 shade_ps(float4 pos : SV_Position) : SV_Target
{
    const int n = max((int)s_ss, 1);
    float3 acc = 0;
    for (int j = 0; j < n; j++)
        for (int i = 0; i < n; i++)
        {
            const float2 px = pos.xy - 0.5 + (float2(i, j) + 0.5) / n;
            const float3 d = CamDir(px);
            const Hit h = Trace(s_eye, d);
            if (h.albedo <= 0.0) { acc += SKY; continue; }
            const float3 P = s_eye + d * h.t;
            const float light = Headlight(P, h.n);
            // the helper runs only inside the beam, as in the game, where it sits inside the shader's own reach and cone test
            const float3 toP = P - s_lamp;
            const bool inBeam = dot(normalize(toP), normalize(s_dir)) > 0.82 && length(toP) < 45.0;
            const float v = s_mode == 1.0 || !inBeam ? 1.0 : main(float4(P, 1.0)).x;
            if (s_mode == 2.0) acc += light > 1e-4 ? v.xxx : float3(0.05, 0.05, 0.12);
            else acc += h.albedo * (AMBIENT + light * v);
        }
    acc /= n * n;
    if (s_mode != 2.0) acc = pow(acc / (1.0 + acc), 1.0 / 2.2);
    return float4(acc, 1.0);
}
