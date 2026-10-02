// SnowRunner Shadows: contact shadows, the screen-space sun shadow pass. Bend Studio's screen-space
// shadows (bend_sss_gpu_dx11.hlsli: a modified copy of their Apache-2.0 bend_sss_gpu.h) march this frame's depth
// towards the sun for every pixel and write 1 (lit) .. 0 (shadowed) into the contact texture. The depth is the game's
// linear depth (the AO pass's t80, metres; read as 1 / z). One group is one wavefront of 64 pixels on a line towards the
// sun's point on screen; the dispatches that cover the screen, and the sun's point, come from sss_setup.hlsl through
// g_dispatch (DispatchIndirect, one dispatch per entry). The knobs come from the ini through b0.
#ifndef SAMPLE_COUNT
#define SAMPLE_COUNT 60     // samples per pixel: the shadow's length in pixels
#endif
#define WAVE_SIZE 64
#define HARD_SHADOW_SAMPLES 4
#define FADE_OUT_SAMPLES 8
#define USE_HALF_PIXEL_OFFSET 1     // (the header sets these two for DXC alone; fxc is what builds this DLL)
#define USE_UV_PIXEL_BIAS 1
#include "bend_sss_gpu_dx11.hlsli"

Texture2D<float> g_txLinearZ : register(t0);
StructuredBuffer<int4> g_dispatch : register(t1);  // [0] the sun's point (float bits); [1 + i] dispatch i's wave offset
RWTexture2D<float> g_uContact : register(u0);
SamplerState g_sBorder : register(s0);              // point, border 0 (a read off screen is the far plane)

cbuffer SSSPass : register(b0)
{
    uint g_index;           // which dispatch of the list this is
    float g_thickness;      // SurfaceThickness (share of the depth)
    float g_bilinear;       // BilinearThreshold
    float g_contrast;       // ShadowContrast
    float2 g_invSize;       // 1 / the depth's size
    float g_skyDepth;       // linear depth at which a read is the sky
    float g_maxDepth;       // pixels farther than this get no contact shadow (early out)
};

[numthreads(WAVE_SIZE, 1, 1)]
void main(int3 gid : SV_GroupID, int gtid : SV_GroupThreadID)
{
    DispatchParameters p;
    p.SetDefaults();
    p.SurfaceThickness = g_thickness;
    p.BilinearThreshold = g_bilinear;
    p.ShadowContrast = g_contrast;
    p.LightCoordinate = asfloat(g_dispatch[0]);
    p.WaveOffset = g_dispatch[1 + g_index].xy;
    p.FarDepthValue = 0;
    p.NearDepthValue = 1;
    p.InvDepthTextureSize = g_invSize;
    p.SkyDepth = g_skyDepth;
    p.DepthTexture = g_txLinearZ;
    p.OutputTexture = g_uContact;
    p.PointBorderSampler = g_sBorder;
    // early out beyond g_maxDepth (1 / z below its inverse) and for the sky (0); SSS_COVER (out\sss_lab.exe): none, and
    // Bend's thread-index view (0 .. 63/64), so a pixel the dispatches missed keeps the lab's clear value 1
#if SSS_COVER
    p.UseEarlyOut = false;
    p.DebugOutputThreadIndex = true;
#else
    p.UseEarlyOut = true;
#endif
    p.DepthBounds = float2(1.0 / g_maxDepth, 1e30);
    WriteScreenSpaceShadow(p, gid, gtid);
}
