// Coloured depth absorption for SnowRunner's river and mud water. The stock shaders fade the refracted scene behind
// the water into the water's lit body colour with one grey factor,
//     colour = body + (behind - body) * T,     T = exp(-k * path through the water), clear or muddy k per river
// so a deep river bed goes flat grey-to-body at the same rate in every channel. Real water absorbs some wavelengths
// faster than others: clear water loses red first and deepens to teal, muddy water loses blue first and goes brown.
// Here each channel gets its own fade, T_c = T ^ w_c, with w_c larger for the channels the water's own colour is dark
// in (Beer-Lambert with an absorption spectrum shaped by that colour). The weights are normalised to a luminance
// average of 1, so the overall depth fade the artists set stays and only its hue changes. A grey water colour gives
// w = 1, the stock fade.
//
// The water's hue is read from its lit body colour with the sky light's own tint divided out (g_ambientLight.cPosY),
// so a blue sky does not make every river bluer.
//
// Contract with the splice (tools\patch_water_mix.js), which replaces the stock lerp with this code:
// v0.x = T, v1.xyz = behind - body, v2.xyz = body; o0.xyz = the result. Reads cb2[50] (CB_GLOBAL_SCENE's
// g_ambientLight.cPosY), which every river shader declares.
//
// Build: fxc -T ps_5_0 -E main absorb.hlsl -Fo absorb.cso. Knob: -D ABSORB_TINT=value.

#ifndef ABSORB_TINT
#define ABSORB_TINT 1.0   // 0 = the stock grey fade, 1 = full hue from the water's colour
#endif
#ifndef ABSORB_SHALLOW
#define ABSORB_SHALLOW 1  // 1 = clearer shallows: the optical depth tau = -ln T becomes
#endif                    // tau^2 / (tau + ABSORB_CLEAR_TAU), so thin water lets the bed show through much further while
#ifndef ABSORB_CLEAR_TAU  // deep water fades as in stock (tau >> TAU: about tau - TAU, the bed already gone). 0 = the stock T
#define ABSORB_CLEAR_TAU 0.7
#endif

cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneBefore[50];
    float3 g_cAmbientPosY; // g_ambientLight.cPosY, c50
};

float4 main(float4 seeThrough : TEXCOORD0, float4 behindMinusBody : TEXCOORD1, float4 body : TEXCOORD2) : SV_Target0
{
    const float3 hue = max(body.xyz, 1e-4) / max(g_cAmbientPosY, 1e-3);
    const float3 rel = hue / max(max(hue.r, hue.g), max(hue.b, 1e-6));
    const float3 absorb = 1.0 - log(max(rel, 0.02));                     // 1 for the brightest channel, more for darker
    const float3 w = lerp(1.0, absorb / dot(absorb, float3(0.2126, 0.7152, 0.0722)), ABSORB_TINT);
    // T can dip below 0 where the stock shader subtracts foam from it; used as it is then, like the stock lerp does
    const float  T = seeThrough.x;
#if ABSORB_SHALLOW
    const float  tau = -log(max(T, 1e-8)), clearTau = tau * tau / (tau + ABSORB_CLEAR_TAU);
    const float3 fade = T > 0.0 ? exp(-w * clearTau) : T.xxx;
#else
    const float3 fade = T > 0.0 ? exp2(w * log2(T)) : T.xxx;
#endif
    return float4(body.xyz + behindMinusBody.xyz * fade, 1.0);
}
