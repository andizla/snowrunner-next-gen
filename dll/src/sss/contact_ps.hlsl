// SnowRunner Shadows: contact shadows, the composite. Drawn once over the lit pass's colour target at the
// AO pass (before the game's AO apply), with a multiplying blend (colour x what this returns): each pixel's sunlight
// is taken away by its screen-space contact shadow (sss.hlsl's mask, t112: 1 lit .. 0 shadowed). How much of a
// pixel's light is sunlight: the sun's visibility its material shader found (render target 6, t113: the shadow map's
// lit fraction, 0 where no shadow-receiving material drew), its normal against the sun's direction, and the game's sun
// and sky levels (CB_GLOBAL_SCENE at b2, the AO pass's own: c48 the sun's colour x c58.w its PBR multiplier, c49 the way
// the light travels, c50..c52 the sky above, at the horizon and below). share = sun / (sun + sky), so a pixel the sun
// lights fully darkens to about what the shadow map's shadows show there, and one the sun does not reach (shadowed,
// facing away) not at all. The normal: render target 7's (t114, the reflections' splice) where a material wrote it,
// else one rebuilt from the AO pass's linear depth (t115) and the camera (CB_GLOBAL_CAMERA at b1), each axis from the
// neighbour nearer in depth so object edges keep their own surface. With distance the contact shadow fades out from
// g_fadeStart to g_fadeEnd metres: far away it is below a pixel, and ground seen that flat makes the pass shadow itself
// (seen in the contact lab, test\shadow_test.cpp).
Texture2D<float> g_txContact : register(t112);
Texture2D<float> g_txSunVis : register(t113);
Texture2D<float4> g_txNormal : register(t114);
Texture2D<float> g_txZ : register(t115);
cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float4 g_vEyePos;
    float4 g_vViewDir;
    float4 g_vp[4];     // view-projection rows: right / tan(half fov x), up / tan(half fov y), near (reversed-Z, infinite), forward
};
cbuffer CB_GLOBAL_SCENE : register(b2) { float4 g_scene[60]; };
cbuffer ContactComposite : register(b12)
{
    float g_strength;   // ini ContactStrength: 1 = the sunlight fully taken where the contact shadow is full
    uint g_debug;       // ini ContactDebug: 1 = the mask alone darkens everything, 2 = the sun share as darkness
    uint g_haveNormal;  // render target 7 is bound
    float g_fadeStart;  // ini ContactFadeStart: the contact shadow in full up to this depth (metres) ...
    float g_fadeEnd;    // ini ContactMaxDepth: ... and gone from here (the pass skips pixels beyond it)
    float2 g_invSize;   // 1 / the target's size
    float g_pad;
};

// the world position at pixel q (its centre), from its linear depth along the view direction
float3 PosAt(int2 q, float z)
{
    const float2 ndc = float2((q.x + 0.5) * g_invSize.x * 2.0 - 1.0, 1.0 - (q.y + 0.5) * g_invSize.y * 2.0);
    const float3 dir = g_vp[3].xyz + ndc.x * g_vp[0].xyz / dot(g_vp[0].xyz, g_vp[0].xyz) + ndc.y * g_vp[1].xyz / dot(g_vp[1].xyz, g_vp[1].xyz);
    return g_vEyePos.xyz + z * dir;
}

float3 DepthNormal(int2 q)
{
    const float zc = g_txZ.Load(int3(q, 0));
    const float zl = g_txZ.Load(int3(q - int2(1, 0), 0)), zr = g_txZ.Load(int3(q + int2(1, 0), 0));
    const float zu = g_txZ.Load(int3(q - int2(0, 1), 0)), zd = g_txZ.Load(int3(q + int2(0, 1), 0));
    const float3 P = PosAt(q, zc);
    const float3 dx = abs(zl - zc) < abs(zr - zc) ? P - PosAt(q - int2(1, 0), zl) : PosAt(q + int2(1, 0), zr) - P;
    const float3 dy = abs(zu - zc) < abs(zd - zc) ? P - PosAt(q - int2(0, 1), zu) : PosAt(q + int2(0, 1), zd) - P;
    float3 n = cross(dy, dx);
    const float l = dot(n, n);
    if (l < 1e-20) return float3(0, 1, 0);
    n *= rsqrt(l);
    return dot(n, g_vEyePos.xyz - P) < 0 ? -n : n;      // the side that faces the camera
}

float4 main(float4 pos : SV_Position) : SV_Target
{
    const int3 p = int3(pos.xy, 0);
    const float c = g_txContact.Load(p);
    if (g_debug == 0 && c >= 0.999) discard;            // most pixels: no contact shadow, nothing to blend
    const float vis = g_txSunVis.Load(p);
    const float4 m = g_haveNormal ? g_txNormal.Load(p) : float4(0.5, 1.0, 0.5, 1.0);
    const float3 n = m.w < 0.999 ? normalize(m.xyz * 2.0 - 1.0) : DepthNormal(p.xy);   // w < 1: a material wrote it (its roughness)
    const float ndl = saturate(dot(n, -g_scene[49].xyz));
    const float3 lum = float3(0.2126, 0.7152, 0.0722);
    const float sun = dot(g_scene[48].rgb, lum) * g_scene[58].w * ndl * vis;
    const float3 sky = n.y >= 0 ? lerp(g_scene[51].rgb, g_scene[50].rgb, n.y) : lerp(g_scene[51].rgb, g_scene[52].rgb, -n.y);
    const float share = sun / max(sun + dot(sky, lum), 1e-4);
    const float fade = 1.0 - smoothstep(g_fadeStart, g_fadeEnd, g_txZ.Load(p));
    float k = 1.0 - (1.0 - c) * share * g_strength * fade;
    if (g_debug == 1) k = c;
    else if (g_debug == 2) k = 1.0 - share;
    return float4(k, k, k, 1.0);
}
