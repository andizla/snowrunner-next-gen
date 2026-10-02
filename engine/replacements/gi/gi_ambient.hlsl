// Sky tinted ambient plus bounce light, spliced by tools\patch_gi.js at the start of the material shaders that read the
// three ambient colours (g_ambientLight.cPosY/cMidY/cNegY = CB_GLOBAL_SCENE registers 50, 51, 52) and know their world
// position. The sky tint is that of replacements\ambient\sky_ambient.hlsl (STRENGTH 0 = the authored colours). On top,
// the bounce light the GTAO pass measured last frame (replacements\gi\gtao_gi.hlsl, handed over by SnowRunner Shadows,
// hid.dll, at t122) is added to all three colours: the engine's blend of them by the normal then carries it, and the
// shader's own code multiplies it by the surface colour, so only the ambient light gains, and by the real albedo.
//
// Where last frame saw this pixel: the world position projected with last frame's camera (cb1[10..13]) if the world
// stood still, or the same screen position if it moved with the camera (the player's truck, followed by the camera).
// Last frame's depth (t121, the DLL's copy) decides: the hypothesis whose depth there matches, within
// GI_DEPTH_TOLERANCE, wins; where neither does (just uncovered), no bounce light this frame.
// Safety: the bounce light added never exceeds GI_AMBIENT_CAP times the brightest ambient colour, so light feeding back
// through the lit image (bounce of bounce, next frames) stays bounded even on foliage whose ambient the game triples.
//
// Contract with the splice: v0.xyz = the pixel's world position (the input the shader subtracts from the eye
// position); o0/o1/o2.rgb = the new cPosY/cMidY/cNegY. The sampler register is remapped to the one the target uses for
// t86. Registers: b1 CB_GLOBAL_CAMERA (c2..c5 view-projection, c10..c13 last frame's), b2 CB_GLOBAL_SCENE c50..c52,
// t86 g_txReflCubeGGX, t121 last frame's linear depth, t122 last frame's bounce light. Without the DLL (t122 or t121
// unbound) the result is the sky tint alone.
#ifndef STRENGTH
#define STRENGTH 0.6            // sky tint, as in sky_ambient.hlsl; 0 = the authored colours
#endif
#ifndef GI_STRENGTH
#define GI_STRENGTH 1.0         // 0 = no bounce light (the sky tint alone)
#endif
#ifndef GI_AMBIENT_CAP
#define GI_AMBIENT_CAP 6.0      // bounce light adds at most this many times the brightest ambient colour
#endif
#ifndef GI_DEPTH_TOLERANCE
#define GI_DEPTH_TOLERANCE 0.06 // relative depth difference at which last frame's pixel no longer counts as this one
#endif
#ifndef GI_TEST_LIVE
#define GI_TEST_LIVE 0          // test builds only: 1 = 0.25 more on every colour, proves the splice is wired
#endif
#ifndef GI_DECAL
#define GI_DECAL 0              // 1 = the build for the terrain decals (gi_ambient_decal.cso, gi_only_decal.cso): their
#endif                          // input is a point of the box they draw, the lit ground lies behind it along the view ray
#ifndef GI_DEBUG
#define GI_DEBUG 0              // diagnostic builds only (debug\gi_*.cso, the bundle's HELPER_VARIANT_GI=debug): 1 = the
#endif                          // ambient light shows what the bounce light found instead, see the end of main
#ifndef GI_DEBUG_GAIN
#define GI_DEBUG_GAIN 3.0       // the debug colours' brightness, in multiples of the brightest ambient colour
#endif

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4];     // c2..c5: clip = (dot(p, col0), .., dot(p, col3)), as the game's vertex shaders do
    float4 g_vViewCol[4];         // c6..c9
    float4 g_vViewProjPrevCol[4]; // c10..c13, last frame's
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 pad[50];
    float3 cPosY; float padPos;
    float3 cMidY; float padMid;
    float3 cNegY; float padNeg;
};
TextureCube       g_txReflCubeGGX : register(t86);
#if GI_DECAL
Texture2D<float4> g_txZ           : register(t80);  // this frame's linear depth, which the decals read already
#endif
Texture2D<float>  g_txPrevZ       : register(t121);
Texture2D<float4> g_txBounce      : register(t122);
SamplerState      g_samCube       : register(s0);

static const float3 LUMA = float3(0.2126, 0.7152, 0.0722);

float3 SkyTint(float3 authored, float3 sky)
{
    float la = dot(authored, LUMA);
    float ls = max(dot(sky, LUMA), 1e-4);
    return lerp(authored, sky * (la / ls), STRENGTH);
}

float4 Project(float4 cols[4], float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, cols[0]), dot(q, cols[1]), dot(q, cols[2]), dot(q, cols[3]));
}
float2 ScreenUV(float4 c) { return float2(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5); }

// 1 where last frame's depth at uv is the expected depth, falling to 0 at GI_DEPTH_TOLERANCE; 0 off screen
float Match(float2 uv, float expected, float2 size)
{
    if (expected <= 0.05 || any(uv < 0.0) || any(uv > 1.0)) return 0.0;
    const float z = g_txPrevZ.Load(int3(min(uv * size, size - 1.0), 0));
    return saturate(1.0 - abs(z - expected) / (expected * GI_DEPTH_TOLERANCE));
}

struct Out { float4 up : SV_Target0; float4 mid : SV_Target1; float4 down : SV_Target2; };

Out main(float4 worldIn : TEXCOORD0)
{
    float3 up = g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 1, 0), 16).rgb;
    float3 down = g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, -1, 0), 16).rgb;
    float3 side = (g_txReflCubeGGX.SampleLevel(g_samCube, float3(1, 0, 0), 16).rgb + g_txReflCubeGGX.SampleLevel(g_samCube, float3(-1, 0, 0), 16).rgb
                 + g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 0, 1), 16).rgb + g_txReflCubeGGX.SampleLevel(g_samCube, float3(0, 0, -1), 16).rgb) * 0.25;

    float3 bounce = 0.0;
#if GI_DEBUG
    float3 dbg = float3(1, 0, 1);   // magenta: t122 or t121 unbound (no DLL, or F10)
#endif
    uint bw, bh, zw, zh;
    g_txBounce.GetDimensions(bw, bh);
    g_txPrevZ.GetDimensions(zw, zh);
    [branch] if (GI_STRENGTH > 0.0 && bw != 0 && zw != 0)
    {
        float3 P = worldIn.xyz;
#if GI_DECAL
        // a decal draws a box around the ground it paints: the lit point is where the view ray through this point of
        // the box meets this frame's depth (view depth grows linearly along a ray from the eye)
        {
            const float4 cBox = Project(g_vViewProjCol, P);
            uint dw, dh;
            g_txZ.GetDimensions(dw, dh);
            const float2 dSize = float2(dw, dh);
            const float zGround = g_txZ.Load(int3(min(saturate(ScreenUV(cBox)) * dSize, dSize - 1.0), 0)).x;
            P = g_vEyePos + (P - g_vEyePos) * (zGround / max(cBox.w, 1e-3));
        }
#endif
        const float2 zSize = float2(zw, zh);
        const float4 cPrev = Project(g_vViewProjPrevCol, P), cNow = Project(g_vViewProjCol, P);
        const float2 uvStill = ScreenUV(cPrev), uvCarried = ScreenUV(cNow);
        const float mStill = Match(uvStill, cPrev.w, zSize), mCarried = Match(uvCarried, cNow.w, zSize);
        const float2 uv = mStill >= mCarried ? uvStill : uvCarried;
        // a 3x3 tent over the bounce texture (four bilinear taps half a texel off): GTAO's noise is sized for it
        const float2 t = 0.5 / float2(bw, bh);
        bounce = (g_txBounce.SampleLevel(g_samCube, uv + float2(-t.x, -t.y), 0).rgb + g_txBounce.SampleLevel(g_samCube, uv + float2(t.x, -t.y), 0).rgb
                + g_txBounce.SampleLevel(g_samCube, uv + float2(-t.x, t.y), 0).rgb + g_txBounce.SampleLevel(g_samCube, uv + float2(t.x, t.y), 0).rgb) * 0.25;
        bounce = min(max(bounce, 0.0), 65504.0) * (max(mStill, mCarried) * GI_STRENGTH);
        const float cap = GI_AMBIENT_CAP * max(dot(cPosY, LUMA), max(dot(cMidY, LUMA), dot(cNegY, LUMA)));
        bounce *= min(1.0, cap / max(dot(bounce, LUMA), 1e-6));
#if GI_DEBUG
        // red: last frame's bounce light where this pixel was, before the depth test, as a fraction of the brightest
        // ambient colour (square root: 0.3 = a tenth, 0.1 = a hundredth); green: the depth test's weight
        const float amb = max(dot(cPosY, LUMA), max(dot(cMidY, LUMA), dot(cNegY, LUMA)));
        dbg = float3(sqrt(saturate(dot(g_txBounce.SampleLevel(g_samCube, uv, 0).rgb, LUMA) / max(amb, 1e-6))), max(mStill, mCarried), 0);
#endif
    }
#if GI_TEST_LIVE
    bounce += 0.25;
#endif
    Out o;
    o.up = float4(SkyTint(cPosY, up) + bounce, 0);
    o.mid = float4(SkyTint(cMidY, side) + bounce, 0);
    o.down = float4(SkyTint(cNegY, down) + bounce, 0);
#if GI_DEBUG
    // the three ambient colours all become the debug colour (so the normal does not matter), GI_DEBUG_GAIN times as
    // bright as the brightest of them: black = no bounce light and no depth match, red = bounce light but the depth test
    // failed, green = a match but nothing to add, yellow = bounce light added
    const float3 d = dbg * (GI_DEBUG_GAIN * max(dot(cPosY, LUMA), max(dot(cMidY, LUMA), dot(cNegY, LUMA))));
    o.up = float4(d, 0);
    o.mid = float4(d, 0);
    o.down = float4(d, 0);
#endif
    return o;
}
