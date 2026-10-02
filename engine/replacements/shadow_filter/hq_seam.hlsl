// Cascade seam dither, spliced into SnowRunner's high quality shadow path (the 1269 shaders with the 16-tap Poisson PCF)
// by tools/shadow_filter_patch.js in place of the cascade choice's compare: "lt MASK, cb2[87].xyzw, DEPTH", the split
// distances g_vSMCascadeDistances against the pixel's view depth (the dp3 of its offset from the eye with the view
// direction, right before it). The game counts the splits (15.5 / 40.5 / 100.5 m) below the depth, so at each split a
// shadow jumps from one cascade's texels and penumbra kernel to the next one's (texels 2-2.5 times larger, a kernel e^-1
// narrower): a line across the ground and the rocks 15.5 m from the camera.
// Here the depth compared is raised by up to SEAM_BAND of itself with a noise per pixel and frame, so over the last
// SEAM_BAND / (1 + SEAM_BAND) of each cascade's range (7.4 %: 14.4-15.5 m, 37.5-40.5 m, 93.1-100.5 m) a growing share of
// the pixels takes the next cascade, and the game's TAA averages the two. Pixels never take a nearer cascade.
// Noise: interleaved gradient noise (Jimenez) at the pixel's screen position, rebuilt from its world position and
// g_tmViewProj as the shader's own checker does, shifted per frame by g_fTime.
// Contract with the splice: v0.x = the view depth (the lt's second operand), v1.xyz = the pixel's position minus the eye
// (the dp3's first operand), v2 = the split distances (the lt's first operand); output o0 = the lt's four-lane mask
// (all bits set where the split lies below the depth), copied whole into the lt's destination. cb0 / cb1 / cb2 are the
// host's CB_GLOBAL_TARGET / CB_GLOBAL_CAMERA / CB_GLOBAL_SCENE, read at registers every high quality shader declares
// (cb0[0], cb1[0..5] for its checker, cb2[0..87]). SEAM_BAND 0: the stock compare.
// SEAM_OWN_DEPTH 1 (hq_seam_own.cso): the build for the 50 shaders whose dp3 writes over its own input (dp3 r9.x,
// r9.xzwx, ...), where the offset from the eye is gone by the compare: the splice then takes the dp3 as well and this
// computes the view depth itself, the same dp3 of v1.xyz with the view direction (cb1[1]); v0 is not read.
#ifndef SEAM_BAND
#define SEAM_BAND 0.08    // how far (a share of the depth) a pixel's depth may be raised for the compare
#endif
#ifndef SEAM_OWN_DEPTH
#define SEAM_OWN_DEPTH 0
#endif
cbuffer CB_GLOBAL_TARGET : register(b0) { float4 g_target0; };   // xy = g_vBBSizeInv
cbuffer CB_GLOBAL_CAMERA : register(b1) { float4 g_camera[6]; }; // 0 the eye, 1 the view direction, 2..5 g_tmViewProj
cbuffer CB_GLOBAL_SCENE : register(b2) { float4 g_scene0; };     // x = g_fTime

float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1, float4 c : TEXCOORD2) : SV_Target
{
    float4 P = float4(b.xyz + g_camera[0].xyz, 1.0);
    float cx = dot(P, g_camera[2]), cy = dot(P, g_camera[3]), cw = dot(P, g_camera[5]);
    float2 pixel = floor(float2(0.5 + 0.5 * cx / cw, 0.5 - 0.5 * cy / cw) / g_target0.xy);
    pixel += 5.588238 * floor(frac(g_scene0.x * (60.0 / 64.0)) * 64.0);   // the frame (60 a second, 64 apart)
    float n = frac(52.9829189 * frac(dot(pixel, float2(0.06711056, 0.00583715))));
#if SEAM_OWN_DEPTH
    float depth = dot(b.xyz, g_camera[1].xyz) * (1.0 + SEAM_BAND * n);
#else
    float depth = a.x * (1.0 + SEAM_BAND * n);
#endif
    return asfloat(c < depth ? 0xFFFFFFFFu : 0u);
}
