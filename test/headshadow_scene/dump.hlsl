// The headlight shadows on a frame dumped from the game (SnowRunner Shadows' dump: its copy of the linear depth, t121, and
// the AO pass's constants b1 CB_GLOBAL_CAMERA and b2 CB_GLOBAL_SCENE, which carry the camera and the headlight). Each
// pixel's world position is rebuilt from its depth, and the helper itself, engine\replacements\headlight\headshadow.hlsl
// (included, its defines overridable with -D), says how much of the headlight reaches it. Driven by dump.cpp.
#include "../../engine/replacements/headlight/headshadow.hlsl"

#ifndef SNOW_UNDER
#define SNOW_UNDER 0.0
#endif
#ifndef BEAM_COS
#define BEAM_COS 0.82   // the beam's cone (cosine of its half angle), as the test scene's headlight
#endif
Texture2D<float4> g_txLit : register(t0);   // the dump's lit scene, for a picture of the frame
cbuffer DUMP_OPTIONS : register(b3)
{
    float o_mode;   // 0: the helper's value (white lit, black blocked, dark blue outside the beam); 1: the frame
    float o_gain;   // brightness of the frame's picture
    float2 o_pad;
};

// the world position on a pixel's camera line at linear depth z: x / w and y / w fixed by the pixel, w = z
float3 WorldOf(float2 s, float z)
{
    const float4 m0 = g_vViewProjCol[0], m1 = g_vViewProjCol[1], m3 = g_vViewProjCol[3];
    const float3 a = m0.xyz - s.x * m3.xyz, b = m1.xyz - s.y * m3.xyz, c = m3.xyz;
    const float3 r = float3(-(m0.w - s.x * m3.w), -(m1.w - s.y * m3.w), z - m3.w);
    // the rows a, b, c of the system: its inverse's columns are b x c, c x a and a x b over the determinant
    const float det = dot(a, cross(b, c));
    return (cross(b, c) * r.x + cross(c, a) * r.y + cross(a, b) * r.z) / det;
}

float4 dump_ps(float4 pos : SV_Position) : SV_Target
{
    uint w, h;
    g_txSceneZ.GetDimensions(w, h);
    if (o_mode == 1.0)
    {
        const float3 c = g_txLit.Load(int3(pos.xy, 0)).rgb * o_gain;
        return float4(pow(c / (1.0 + c), 1.0 / 2.2), 1.0);
    }
    const float z = g_txSceneZ.Load(int3(pos.xy, 0));
    if (!(z > 0.05 && z < 1e4)) return float4(0.0, 0.0, 0.05, 1.0);   // the sky: not grey, so not counted
    const float2 s = float2(pos.x / w * 2.0 - 1.0, 1.0 - pos.y / h * 2.0);
    const float3 P = WorldOf(s, z);
    const float3 L = g_vHeadLightPos[0].xyz, toP = P - L;
    const float d = length(toP);
    // mode 2: the distance from the lamp (black at it, white 30 m off) and, in red, the beam's cone; a check of the
    // positions rebuilt from the depth and of the headlight read from the dump
    if (o_mode == 2.0) { const float c = dot(toP / max(d, 1e-4), normalize(g_vHeadLightDir[0].xyz)); return float4(saturate(d / 30.0), saturate(d / 30.0) * (c > 0.82 ? 0.3 : 1.0), saturate(d / 30.0) * (c > 0.82 ? 0.3 : 1.0), 1.0); }
    const bool inBeam = dot(toP / max(d, 1e-4), normalize(g_vHeadLightDir[0].xyz)) > BEAM_COS && d < 45.0 && d > 3.0;
    if (!inBeam) return float4(0.02, 0.03, 0.08, 1.0);
    // SNOW_UNDER: the point handed to the helper that far under the visible surface, as a snow layer drawn over the
    // ground would hand the ground's position (a guess to test); 0 = on the surface
    const float v = main(float4(P - float3(0.0, SNOW_UNDER, 0.0), 1.0)).x;
    return float4(v, v, v, 1.0);
}
