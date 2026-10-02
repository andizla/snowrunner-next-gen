// SnowRunner Shadows: the AO pass drawn at half size (ini AOHalf=1), brought back to full size.
// The half-size pass computes, for each 2 x 2 block of full-size pixels, the block's top-left pixel exactly (SnowRunner-
// shaders gtao_gi.hlsl with AO_HALF_SNAP=1). A full-size pixel at even coordinates stands on its block's sample; one at
// an odd coordinate lies halfway to the next block's sample, so it takes the two (or four, odd in both) samples around it
// at equal distance, weighted by how close each sample pixel's depth is to its own: across an edge the other side's
// result does not bleed in. Where no sample is close (a feature one pixel wide between them), the nearest in depth stands
// in. The bounce light comes back with the same weights.
// Inputs: t0 the AO (half size), t1 the bounce light (half size), t2 linear depth (full size: the feed's copy of what the
// AO pass read at t80); outputs: u0 the AO (full size), u1 the bounce light (full size, only when g_gi is 1).
cbuffer AOUpsample : register(b0)
{
    uint2 g_full;      // full size in pixels
    uint2 g_half;      // half size (rounded up)
    uint  g_gi;        // 1: the bounce light too
    float g_depthTol;  // a sample whose depth differs by this share of the pixel's depth weighs e^-1 (0.02 = 2 %)
    float2 g_pad;
};
Texture2D<float>  g_aoHalf : register(t0);
Texture2D<float4> g_giHalf : register(t1);
Texture2D<float>  g_depth  : register(t2);
RWTexture2D<unorm float> g_aoFull : register(u0);
RWTexture2D<float4>      g_giFull : register(u1);

#if AO_BLUR_PASS
// Compiled with AO_BLUR_PASS=1: the half-size results blurred 3 x 3 on their own grid before the upsample (ini
// AOHalfBlur=1). The pass's noise is interleaved gradient noise on the grid it is drawn on, made to cancel under a 3 x 3
// box on that grid, which the game's apply pass gives at full size; at half size that box covers about one and a half
// samples and the noise stays as grain (a captured frame, the road behind the truck: 1.46 8-bit steps of fine texture
// against 0.51). Samples across a depth edge take no part. Inputs t0, t1 and t2 as below; outputs u0 the AO and u1 the
// bounce light, half size.
[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= g_half)) return;
    const int2 h = int2(id.xy);
    const int2 lastHalf = int2(g_half) - 1, lastFull = int2(g_full) - 1;
    const float z = g_depth[min(h * 2, lastFull)];
    const float tol = max(z * g_depthTol * 2.0, 1e-4);   // the neighbours stand two full-size pixels apart
    float weights = 0.0, ao = 0.0;
    float4 gi = 0.0;
    [unroll] for (int j = -1; j <= 1; j++)
        [unroll] for (int i = -1; i <= 1; i++)
        {
            const int2 n = clamp(h + int2(i, j), 0, lastHalf);
            const float dz = abs(g_depth[min(n * 2, lastFull)] - z);
            const float w = exp(-(dz / tol) * (dz / tol));
            weights += w;
            ao += w * g_aoHalf[n];
            if (g_gi) gi += w * g_giHalf[n];
        }
    g_aoFull[h] = ao / weights;                             // (u0 and u1 are half size in this pass)
    if (g_gi) g_giFull[h] = gi / weights;
}
#else
[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID)
{
    if (any(id.xy >= g_full)) return;
    const int2 p = int2(id.xy);
    const float z = g_depth[p];
    const int2 block = p >> 1;                  // the pixel's block: its sample is the block's top-left pixel
    const int2 odd = p & 1;                     // 1 where the pixel lies halfway to the next block's sample
    const int2 lastHalf = int2(g_half) - 1, lastFull = int2(g_full) - 1;
    const float tol = max(z * g_depthTol, 1e-4);
    float weights = 0.0, ao = 0.0, nearest = 1e30, aoNearest = 1.0;
    float4 gi = 0.0, giNearest = 0.0;
    [unroll] for (int k = 0; k < 4; k++)
    {
        const int2 step = int2(k & 1, k >> 1);
        if (any(step > odd)) continue;          // at an even coordinate the pixel stands on its sample: nothing that way
        const int2 h = min(block + step, lastHalf);
        const float dz = abs(g_depth[min(h * 2, lastFull)] - z);
        const float w = exp(-(dz / tol) * (dz / tol));
        const float a = g_aoHalf[h];
        const float4 b = g_gi ? g_giHalf[h] : 0.0;
        weights += w;
        ao += w * a;
        gi += w * b;
        if (dz < nearest) { nearest = dz; aoNearest = a; giNearest = b; }
    }
    const bool none = weights < 1e-4;
    g_aoFull[p] = none ? aoNearest : ao / weights;
    if (g_gi) g_giFull[p] = none ? giNearest : gi / weights;
}
#endif
