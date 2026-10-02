// Sun glow through smoke, dust and steam: the forward scattering the game's particles lack. SnowRunner lights a puff
// with one sun value per vertex (a baked top-down light map, or the sun colour times a visibility factor, see
// tools\patch_smoke.js) and one ambient value; nothing depends on where the sun is relative to the camera, so a puff
// between the eye and a low sun looks the same as one lit from behind the camera. Real smoke scatters sunlight mostly
// forward: seen against the sun it glows, often brighter than the sky behind it (the "silver lining" of exhaust in low
// light). This helper computes that as a factor on the puff's sun light: 1 + SMOKE_GLOW * (4 pi HG(mu) - 1)+, where HG
// is the Henyey-Greenstein phase function with anisotropy SMOKE_G and mu the cosine between the view ray and the sun's
// light direction: 1 with the sun straight behind the puff, no change from 90 degrees on. The factor rides on the sun
// term, so the pixel shader's shadow test, the light map's baked shade, the night fade and the fog still apply to it.
//
// Contract with the splice (tools\patch_smoke.js): v0.xyz = the vertex's world position (the register the vertex shader
// transforms with the view-projection); o0.x = the factor for the sun light, o0.y = the factor minus one (the glow alone,
// for particles whose vertex shader gives them no sun light at all: they get sun colour times o0.y). Registers: b1
// CB_GLOBAL_CAMERA (c0 the eye position), b2 CB_GLOBAL_SCENE (c49 g_dirLight.vDir, the direction the light travels; the
// splice widens the declaration where a shader declares fewer registers). Pure arithmetic, so the pixel-shader compile
// (helperBody wants ps_5_0) splices into a vertex shader unchanged.
//
// Build: fxc -T ps_5_0 -E main smoke_glow.hlsl -Fo smoke_glow.cso; -D SMOKE_GLOW=0 -Fo smoke_glow_off.cso (the proof).

#ifndef SMOKE_GLOW
#define SMOKE_GLOW 0.15       // strength: the sun term is multiplied by 1 + SMOKE_GLOW * (4 pi HG - 1); 0 = stock (0.35 is too bright)
#endif
#ifndef SMOKE_G
#define SMOKE_G 0.7           // Henyey-Greenstein anisotropy: how tightly the glow hugs the sun direction (0.6 glowed 60 degrees wide)
#endif
#ifndef SMOKE_GLOW_MAX
#define SMOKE_GLOW_MAX 2.0    // cap on the factor (looking straight at the sun through a puff); 4 was too bright
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1) { float3 g_vEyePos; float g_fZDir; };
cbuffer CB_GLOBAL_SCENE : register(b2) { float4 g_scenePad[49]; float3 g_vSunDir; float g_scenePad2; };

float2 main(float3 P : TEXCOORD0) : SV_Target
{
    const float3 V = normalize(P - g_vEyePos);                 // from the eye to the vertex
    const float mu = dot(V, -g_vSunDir);                       // 1: the sun straight behind the puff
    const float g = SMOKE_G;
    const float x = 1.0 + g * g - 2.0 * g * mu;                // at least (1 - g)^2, never zero
    const float hg = (1.0 - g * g) * rsqrt(x) / x;             // 4 pi HG(mu): 1 for isotropic scattering
    const float glow = min(max(hg - 1.0, 0.0) * SMOKE_GLOW, SMOKE_GLOW_MAX - 1.0);
    return float2(1.0 + glow, glow);
}
