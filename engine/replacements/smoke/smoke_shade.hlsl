// Volume shading for SnowRunner's lit particle sprites (dust, exhaust, smoke, steam). The game lights each of them with
// one sun value and one ambient value per vertex, so a puff is a flat disc of light: no lit side, no shadowed side and
// no dense core. This gives
// each pixel a pseudo-normal of a soft ball: its direction from the screen gradient of the puff's alpha (outward, where
// the alpha falls off), its tilt from the alpha itself (a thin rim faces sideways, a dense core faces the camera). The
// lit colour is then scaled by
//   k = (1 + SUN/2 (n.L - f.L) + SKY/2 (n.y - f.y)) x (1 - CORE x smoothstep(0.5, 1, alpha))
// with f the flat sprite's normal (towards the camera) and L the direction to the sun: the side towards the sun
// brighter and the far side darker by the same amount, tops lighter than bottoms (sky light from above), dense cores a
// little darker (light lost inside the puff). A puff seen face-on in its middle keeps its stock light. The sprites with
// their own normal maps (water splashes, mud) are left as they are.
// White smoke is also drawn thinner (at the game's opacity it comes out too white and too dense): the output alpha times
// SMOKE_WHITE_ALPHA where the puff's own colour is light. Its own colour is the albedo the shader lights (sprite texture
// x particle colour, before any light, so a white puff in shade still counts as white); its luminance from
// SMOKE_WHITE_LO to SMOKE_WHITE_HI takes the opacity from the game's to SMOKE_WHITE_ALPHA times it. Black exhaust (dark
// particle colours) keeps the game's opacity.
//
// Contract with the splice (tools\patch_smoke_ps.js), which takes the shader's final fog blend
// "o0.xyz = lerp(lit, fog.rgb, fog.a)" into a temp and calls this at the end: v0 = that fogged colour (xyz) and the
// output alpha (w), v1 = the fog input (COLOR1: colour, amount), v2 = the albedo (xyz: the operand of "lit = albedo x
// light" that is not the light, copied where that mul reads it; 0 where the splice could not tell); o0.xyz = the fogged
// colour with only the lit part scaled: c + (k - 1)(c - fog.a fog.rgb), which is lerp(k lit, fog.rgb, fog.a); o0.w =
// the alpha, thinner for white smoke. Registers are the particle shaders' own: b1 CB_GLOBAL_CAMERA (c1 the view
// direction), b2 CB_GLOBAL_SCENE (c49 g_dirLight.vDir, the direction the light travels); the splice declares b1 where a
// shader lacks it and widens b2 to 50.
//
// Build: fxc -T ps_5_0 -E main smoke_shade.hlsl -Fo smoke_shade.cso. Every knob can be set with -D NAME=value; with
// SMOKE_SHADE=0 (smoke_shade_off.cso) the colour and the alpha pass through and every patched shader computes what the
// stock one did.

#ifndef SMOKE_SHADE
#define SMOKE_SHADE 1           // 0 = the proof build: colour and alpha pass through unchanged (the stock result)
#endif
#ifndef SMOKE_SHADE_SUN
#define SMOKE_SHADE_SUN 0.6     // how much the side towards the sun gains (and the far side loses)
#endif
#ifndef SMOKE_SHADE_SKY
#define SMOKE_SHADE_SKY 0.3     // tops lighter, bottoms darker
#endif
#ifndef SMOKE_SHADE_CORE
#define SMOKE_SHADE_CORE 0.12   // dense cores this much darker at full alpha (0.2 darkened a thick puff by a fifth overall)
#endif
#ifndef SMOKE_SHADE_TILT
#define SMOKE_SHADE_TILT 0.9    // how far a thin rim's normal turns sideways (sine of the tilt at alpha 0)
#endif
#ifndef SMOKE_WHITE_ALPHA
#define SMOKE_WHITE_ALPHA 0.6   // white smoke's opacity against the game's (1 = as the game draws it)
#endif
#ifndef SMOKE_WHITE_LO
#define SMOKE_WHITE_LO 0.1      // albedo luminance up to which a puff keeps the game's opacity
#endif
#ifndef SMOKE_WHITE_HI
#define SMOKE_WHITE_HI 0.3      // albedo luminance from which a puff counts as white (SMOKE_WHITE_ALPHA in full)
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneA[49];
    float4 g_vSunDir;               // c49: g_dirLight.vDir, the direction the light travels
};

float4 main(float4 c : TEXCOORD0, float4 fog : TEXCOORD1, float3 albedo : TEXCOORD2) : SV_Target0
{
    // one exit only: the splice copies the code up to its first ret
    const float a = saturate(c.w);
    float3 rgb = c.rgb;
    float alpha = c.w;
#if SMOKE_SHADE
    // outward on screen (x right, y down): against the alpha's gradient; none where the alpha is flat
    const float2 g = float2(ddx(a), ddy(a));
    const float gl = length(g);
    const float2 dir = gl > 1e-5 ? -g / gl : float2(0.0, 0.0);
    const float sinT = saturate((1.0 - a) * SMOKE_SHADE_TILT), cosT = sqrt(1.0 - sinT * sinT);
    // the camera's frame (left-handed on screen: right x up = forward)
    const float3 F = normalize(g_vViewDir.xyz);
    const float3 Rt = normalize(cross(float3(0.0, 1.0, 0.0), F) + float3(1e-6, 0.0, 0.0));
    const float3 Up = cross(F, Rt);
    const float3 n = -F * cosT + (Rt * dir.x - Up * dir.y) * sinT;
    const float3 L = -g_vSunDir.xyz;
    float k = 1.0 + 0.5 * SMOKE_SHADE_SUN * dot(n + F, L) + 0.5 * SMOKE_SHADE_SKY * (n.y + F.y);
    k *= 1.0 - SMOKE_SHADE_CORE * smoothstep(0.5, 1.0, a);
    rgb += (max(k, 0.0) - 1.0) * (c.rgb - fog.w * fog.rgb);
    // white smoke thinner (see the top); the gradient above keeps using the game's alpha
    const float white = smoothstep(SMOKE_WHITE_LO, SMOKE_WHITE_HI, dot(albedo, float3(0.2126, 0.7152, 0.0722)));
    alpha *= 1.0 - (1.0 - SMOKE_WHITE_ALPHA) * white;
#endif
    return float4(rgb, alpha);
}
