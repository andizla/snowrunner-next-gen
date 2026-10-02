// The reflection pass's G-buffer, written by the object material shaders into render-target slot 7 (an RGBA8_UNORM
// target SnowRunner Shadows binds during the lit pass with SSR=1, cleared to (0.5, 1, 0.5, 1) = normal up, fully rough).
// The game's own normal buffer (RT1) holds a constant "up" for the vehicle materials and folds y for the rest, and no
// buffer carries roughness, so both come from here. The normal is derived at the specular cubemap sample, the anchor
// tools\patch_object_ssr.js already finds: the sampled direction R is the mirror direction of the view vector about
// the shading normal, so N = normalize(R + V) with V = normalize(eye - P). (A material that bends R towards N for rough
// pixels skews this a little there; the pass skips rough pixels anyway.) Roughness is the operand of the mip
// computation "mad mip, x, 8, 0.5": sqrt(roughness), the perceptual roughness, stored as it is.
//
// Contract with the splice (tools\patch_gbuffer.js): v0.xyz = the direction as the shader sampled it (world space),
// v1.xyz = the pixel's world position (the input the shader subtracts from the eye position cb1[0]), v2.x = the mip
// mad's operand (sqrt roughness); o0 = (N * 0.5 + 0.5, saturate(v2.x)), which the splice moves into o7. Registers: b1
// CB_GLOBAL_CAMERA (c0 the eye position). Build: fxc -T ps_5_0 -E main gbuffer.hlsl -Fo gbuffer.cso.

cbuffer CB_GLOBAL_CAMERA : register(b1) { float3 g_vEyePos; float g_fZDir; };

float4 main(float3 R : TEXCOORD0, float3 P : TEXCOORD1, float sqrtRoughness : TEXCOORD2) : SV_Target
{
    const float3 V = normalize(g_vEyePos - P);
    const float3 N = normalize(normalize(R) + V);
    return float4(N * 0.5 + 0.5, saturate(sqrtRoughness));
}
