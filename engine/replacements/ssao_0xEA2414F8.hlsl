// Replacement for SnowRunner's SSAO generation pass 0xEA2414F8 (full resolution) and 0xA3716E2B (half resolution).
// The original is a 2007 style depth-only SSAO: 8 samples on a reflected cube-corner kernel, a radius that grows with
// depth so it covers a constant 8 percent of the screen, and a range check instead of a horizon.
// This version integrates the visible horizon in a few screen directions (ground truth AO after Jimenez 2016, laid
// out like Intel XeGTAO) with a radius in metres, a normal rebuilt from depth, and interleaved gradient noise that the
// game's own 3x3 blur in the apply pass averages out.
//
// Contract kept from the original: same resource names, bindings and input signature, o0.x = visibility (1 = open), o0.yzw = the
// centre depth. The pass has no projection constants, so the field of view is assumed (the original hard codes the
// same assumption as a pixel footprint of 0.000977 per unit depth, which is 55.6 degrees vertical at 1080 lines).
// Every knob can be set on the fxc command line (-D NAME=value).

#ifndef AO_SLICES
#define AO_SLICES 3            // screen directions per pixel
#endif
#ifndef AO_STEPS
#define AO_STEPS 6             // depth taps per direction and side
#endif
#ifndef AO_RADIUS
#define AO_RADIUS 1.5          // metres
#endif
#ifndef AO_RADIUS_MAX_DEPTH_FRACTION
#define AO_RADIUS_MAX_DEPTH_FRACTION 0.12   // caps the radius near the camera (and keeps the kernel bounded on screen)
#endif
#ifndef AO_POWER
#define AO_POWER 1.6           // final exponent on the visibility
#endif
#ifndef AO_FAR
#define AO_FAR 0               // 1 = the far reach: each direction's search goes on past AO_RADIUS to AO_FAR_RADIUS, and what
#endif                         // it finds there raises the horizon only part of the way (wide shelter darkens gently)
#ifndef AO_FAR_RADIUS
#define AO_FAR_RADIUS 6.0      // metres
#endif
#ifndef AO_FAR_STEPS
#define AO_FAR_STEPS 4         // taps per direction and side between the near and the far radius (2 with AO_FAR_STRENGTH 0.6
#endif                         // is the cheaper full-direction variant: the 4-tap look on a captured frame, 2.0 ms, not 3.3)
#ifndef AO_FAR_STRENGTH
#define AO_FAR_STRENGTH 0.5    // how far a far occluder raises the horizon at the near radius (fading to 0 at the far one)
#endif
#ifndef AO_FAR_MAX_DEPTH_FRACTION
#define AO_FAR_MAX_DEPTH_FRACTION 0.5   // caps the far radius near the camera, like AO_RADIUS_MAX_DEPTH_FRACTION
#endif
#ifndef AO_FAR_SHARE
#define AO_FAR_SHARE 0         // 1 = the far reach searches one of the pixel's directions, not all of them, and each 2 x 2 quad
#endif                         // of pixels shares what its four found (ddx_fine / ddy_fine; only pixels at a similar depth,
                               // so nothing bleeds across an edge): a quarter of the far reads, 0.9 ms instead of 3.3 at 4K.
                               // The near search keeps every direction, so the contact shadows stay as they are. On in the
                               // shipped far build. 0 = every direction searches far (byte-identical blob)
#ifndef AO_FADE_START
#define AO_FADE_START 150.0    // metres: AO fades out between start and end (fog owns the distance)
#endif
#ifndef AO_FADE_END
#define AO_FADE_END 300.0
#endif
#ifndef TAN_HALF_FOV_Y
#define TAN_HALF_FOV_Y 0.5275
#endif
#ifndef AO_FOV_FROM_CAMERA
#define AO_FOV_FROM_CAMERA 1   // 1 = the field of view of the game's camera, every frame (CB_GLOBAL_CAMERA, b1); 0 = the
#endif                         // fixed TAN_HALF_FOV_Y, which assumes a wider view (tan 0.5275 = 55.7 degrees vertical) than
                               // the game's (tan 0.4005 = 43.7 degrees in a captured frame): radius and angles come out off
#ifndef VERIFY_SWAP
#define VERIFY_SWAP 0          // 1 = stripes in the AO target to prove the replacement is live
#endif

cbuffer CB_INSTANCE : register(b4)
{
    float2 g_vDitherTile;
    float2 g_vRadiusMinMax;
    float4 g_vSSAOColor;
};
cbuffer CB_GLOBAL_TARGET : register(b0)
{
    float2 g_vBBSizeInv;
    float2 g_vVPSizeInv;
    uint   g_iBBSampleCount;
};
#if AO_FOV_FROM_CAMERA
cbuffer CB_GLOBAL_CAMERA : register(b1)             // the game's camera, bound while its AO pass draws
{
    float4 g_vEyePos;
    float4 g_vViewDir;
    float4 g_tmViewProj[4];                          // clip[i] = dot(float4(P, 1), g_tmViewProj[i]): row 0 = x, row 1 = y
};
#endif
SamplerState      _SAMPLERS[16] : register(s0);   // the engine names its samplers as one array: 0 = depth, 1 = dither (wrap), 2 = factor
Texture2D<float4> g_txDither : register(t0);
Texture2D<float4> g_txFactor : register(t2);
Texture2D<float4> g_txZ      : register(t80);

static const float PI = 3.14159265;
static const float HALF_PI = 1.57079633;

float Depth(float2 uv) { return g_txZ.SampleLevel(_SAMPLERS[0], uv, 0).x; }

// View space: x right, y up, z forward. uv (0,0) is the top left corner.
float3 ViewPos(float2 uv, float z, float2 tanHalfFov)
{
    return float3((uv.x * 2.0 - 1.0) * tanHalfFov.x, (1.0 - uv.y * 2.0) * tanHalfFov.y, 1.0) * z;
}

float InterleavedGradientNoise(float2 pixel)
{
    return frac(52.9829189 * frac(dot(pixel, float2(0.06711056, 0.00583715))));
}

// tan(half the field of view) across and up: 1 / the scale of the projection's x and y rows (their xyz are the camera's
// right and up axes times it; the jitter's share is far below a pixel); the fixed value where b1 holds nothing
float2 TanHalfFov(float2 px)
{
    float2 fixedFov = float2(TAN_HALF_FOV_Y * px.y / px.x, TAN_HALF_FOV_Y);
#if AO_FOV_FROM_CAMERA
    float2 scale = float2(length(g_tmViewProj[0].xyz), length(g_tmViewProj[1].xyz));
    return scale.x > 1e-6 && scale.y > 1e-6 ? 1.0 / scale : fixedFov;
#else
    return fixedFov;
#endif
}

#if AO_FAR
// Far taps along one screen direction, both sides, from the near radius to the far one. What they find raises the
// horizons (cosines; they start at the near search's) only part of the way: AO_FAR_STRENGTH at the near radius, nothing
// at the far one. So a canopy, a truck body or a wall a few metres off darkens gently, and the contact shadow stays the
// near search's (the horizon is the higher of the two, never their product). Taps off the screen find nothing.
void FarHorizons(float2 uv, float2 px, float3 P, float3 V, float2 tanHalfFov, float2 dir, float radiusPxFar, float radiusFar,
                 float nearEnd, float farSpan, float noiseSample, float lowHorizon0, float lowHorizon1,
                 inout float horizon0, inout float horizon1)
{
    float2 omegaFar = float2(dir.x, -dir.y) * radiusPxFar * px;
    for (int farStep = 0; farStep < AO_FAR_STEPS; farStep++)
    {
        float t = (farStep + frac(noiseSample + (farStep + AO_STEPS) * 0.6180339887)) / AO_FAR_STEPS;
        float2 offset = lerp(nearEnd, 1.0, t) * omegaFar;

        float2 uv0 = (floor((uv + offset) / px) + 0.5) * px;
        float3 d0 = ViewPos(uv0, Depth(uv0), tanHalfFov) - P;
        float  l0 = length(d0);
        float  w0 = all(uv0 == saturate(uv0)) ? AO_FAR_STRENGTH * saturate((radiusFar - l0) / farSpan) : 0.0;
        horizon0 = max(horizon0, lerp(lowHorizon0, dot(d0 / max(l0, 1e-5), V), w0));

        float2 uv1 = (floor((uv - offset) / px) + 0.5) * px;
        float3 d1 = ViewPos(uv1, Depth(uv1), tanHalfFov) - P;
        float  l1 = length(d1);
        float  w1 = all(uv1 == saturate(uv1)) ? AO_FAR_STRENGTH * saturate((radiusFar - l1) / farSpan) : 0.0;
        horizon1 = max(horizon1, lerp(lowHorizon1, dot(d1 / max(l1, 1e-5), V), w1));
    }
}
#endif

#if AO_FAR && AO_FAR_SHARE
// a value summed over this pixel and those of its quad neighbours that take part (w: across, up or down, diagonal).
// ddx_fine / ddy_fine are the difference to the neighbour in the quad, so the neighbour's value is ours plus or minus it
// (qs: +1 where the neighbour lies to the right or below); the diagonal one is the neighbour's neighbour
float QuadShare(float v, float2 qs, float wh, float wv, float wd)
{
    float h = v + qs.x * ddx_fine(v);
    return v + wh * h + wv * (v + qs.y * ddy_fine(v)) + wd * (h + qs.y * ddy_fine(h));
}
#endif

float4 main(float2 uv : TEXCOORD0, uint frontFace : SV_IsFrontFace) : SV_Target0
{
    float2 px = g_vBBSizeInv;
    float  z  = Depth(uv);
    float fade = saturate((AO_FADE_END - z) / (AO_FADE_END - AO_FADE_START));
#if AO_FAR && AO_FAR_SHARE
    // no early way out: the quad's exchange below needs all four of its pixels. One with nothing to search skips the
    // search, takes no part in its neighbours' results, and writes the plain output at the end
    float zTrue = z;
    bool active = fade > 0.0 && z > 0.0;
    z = active ? z : 1.0;
#else
    if (fade <= 0.0 || z <= 0.0)
        return float4(1.0, z, z, z);
#endif

    float2 tanHalfFov = TanHalfFov(px);
    float3 P = ViewPos(uv, z, tanHalfFov);

    // Normal from depth: per axis keep the neighbour whose depth is closer to the centre, so edges stay sharp
    float zl = Depth(uv - float2(px.x, 0.0)), zr = Depth(uv + float2(px.x, 0.0));
    float zu = Depth(uv - float2(0.0, px.y)), zd = Depth(uv + float2(0.0, px.y));
    float3 dx = abs(zr - z) < abs(z - zl) ? ViewPos(uv + float2(px.x, 0.0), zr, tanHalfFov) - P : P - ViewPos(uv - float2(px.x, 0.0), zl, tanHalfFov);
    float3 dy = abs(zd - z) < abs(z - zu) ? ViewPos(uv + float2(0.0, px.y), zd, tanHalfFov) - P : P - ViewPos(uv - float2(0.0, px.y), zu, tanHalfFov);
    float3 N = normalize(cross(dx, dy));   // dx points right, dy points down the screen: the cross product faces the camera
    float3 V = normalize(-P);

    // Radius: the xml min/max and the per pixel factor keep their meaning as a scale on the metric radius
    float factor  = saturate(g_txFactor.SampleLevel(_SAMPLERS[2], uv, 0).x * 2.0 - 1.0);
    float rScale  = lerp(g_vRadiusMinMax.x, g_vRadiusMinMax.y, factor) / max(g_vRadiusMinMax.y, 1e-4);
    float radius  = min(AO_RADIUS * rScale, z * AO_RADIUS_MAX_DEPTH_FRACTION);
    float radiusPx = radius / (z * 2.0 * tanHalfFov.y * px.y);   // one pixel covers z * 2 tan(fov/2) / height
#if AO_FAR && AO_FAR_SHARE
    active = active && radiusPx >= 1.5;
#else
    if (radiusPx < 1.5)
        return float4(1.0, z, z, z);
#endif

    float falloffRange = 0.615 * radius;
    float falloffMul   = -1.0 / falloffRange;
    float falloffAdd   = (radius - falloffRange) / falloffRange + 1.0;

    float2 pixel = uv / px;
    // The dither texture only nudges the noise. It stays referenced so the shader declares every resource and constant
    // the original declares: inside shader.pak the engine sees this blob alone and may bind by those names.
    float ditherNudge = g_txDither.SampleLevel(_SAMPLERS[1], uv * g_vDitherTile, 0).x * (1.0 / 1024.0);
    float noiseSlice  = frac(InterleavedGradientNoise(pixel) + ditherNudge);
    float noiseSample = InterleavedGradientNoise(pixel + float2(17.0, 43.0));

#if AO_FAR
    // The far reach, in the same directions: its own radius under looser caps, taps from the near radius out to it
    float radiusFar   = max(min(AO_FAR_RADIUS * rScale, z * AO_FAR_MAX_DEPTH_FRACTION), radius);
    float radiusPxFar = radiusFar / (z * 2.0 * tanHalfFov.y * px.y);
    float nearEnd     = radiusPx / max(radiusPxFar, 1e-4);   // where the far taps start, in units of the far radius
    float farSpan     = max(radiusFar - radius, 1e-3);
#if AO_FAR_SHARE
    // the one direction this pixel's far search takes: the slice its place in its 2 x 2 quad picks. The quads are the
    // render target's: pixel counts g_vBBSizeInv's pixels, and a pass drawn at half that size steps two per target pixel
    float2 target = floor(pixel / max(round(float2(ddx_fine(pixel.x), ddy_fine(pixel.y))), 1.0));
    int farSlice = ((((int)target.x & 1) + 2 * ((int)target.y & 1)) * AO_SLICES) >> 2;
    float2 farDir = 0.0;
    float farN = 0.0, farCosN = 1.0, farLow0 = 0.0, farLow1 = 0.0, farH0 = 0.0, farH1 = 0.0, farProj = 0.0, farNear = 0.0;
#endif
#endif
    float visibility = 0.0;
#if AO_FAR && AO_FAR_SHARE
    for (int slice = 0; slice < (active ? AO_SLICES : 0); slice++)   // a pixel with nothing to search skips it
#else
    for (int slice = 0; slice < AO_SLICES; slice++)
#endif
    {
        float  phi = (slice + noiseSlice) / AO_SLICES * PI;
        float2 dir = float2(cos(phi), sin(phi));
        float2 omega = float2(dir.x, -dir.y) * radiusPx * px;   // screen y runs down

        float3 directionVec = float3(dir.x, dir.y, 0.0);
        float3 orthoDirection = directionVec - dot(directionVec, V) * V;
        float3 axis = normalize(cross(orthoDirection, V));
        float3 projN = N - axis * dot(N, axis);
        float  projLen = length(projN);
        float  signN = sign(dot(orthoDirection, projN));
        float  cosN = saturate(dot(projN, V) / max(projLen, 1e-5));
        float  n = signN * acos(cosN);

        float lowHorizon0 = cos(n + HALF_PI), lowHorizon1 = cos(n - HALF_PI);
        float horizon0 = lowHorizon0, horizon1 = lowHorizon1;
        for (int step = 0; step < AO_STEPS; step++)
        {
            float s = (step + frac(noiseSample + step * 0.6180339887)) / AO_STEPS;
            s = s * s + 1.3 / radiusPx;   // denser near the centre, never closer than about a pixel
            float2 offset = s * omega;

            float2 uv0 = (floor((uv + offset) / px) + 0.5) * px;
            float3 d0 = ViewPos(uv0, Depth(uv0), tanHalfFov) - P;
            float  l0 = length(d0);
            float  c0 = lerp(lowHorizon0, dot(d0 / max(l0, 1e-5), V), saturate(l0 * falloffMul + falloffAdd));
            horizon0 = max(horizon0, c0);

            float2 uv1 = (floor((uv - offset) / px) + 0.5) * px;
            float3 d1 = ViewPos(uv1, Depth(uv1), tanHalfFov) - P;
            float  l1 = length(d1);
            float  c1 = lerp(lowHorizon1, dot(d1 / max(l1, 1e-5), V), saturate(l1 * falloffMul + falloffAdd));
            horizon1 = max(horizon1, c1);
        }
#if AO_FAR && !AO_FAR_SHARE
        // the far taps along the same direction
        FarHorizons(uv, px, P, V, tanHalfFov, dir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, lowHorizon0, lowHorizon1, horizon0, horizon1);
#endif

        projLen = lerp(projLen, 1.0, 0.05);
        float h0 = -acos(clamp(horizon1, -1.0, 1.0));
        float h1 =  acos(clamp(horizon0, -1.0, 1.0));
        h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
        h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
        float arc0 = (cosN + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) * 0.25;
        float arc1 = (cosN + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) * 0.25;
        visibility += projLen * (arc0 + arc1);
#if AO_FAR && AO_FAR_SHARE
        // this pixel's far direction: what the far search after the loop needs of it
        [flatten] if (slice == farSlice)
        {
            farDir = dir; farN = n; farCosN = cosN; farLow0 = lowHorizon0; farLow1 = lowHorizon1;
            farH0 = horizon0; farH1 = horizon1; farProj = projLen; farNear = arc0 + arc1;
        }
#endif
    }
#if AO_FAR && AO_FAR_SHARE
    // the far search in this pixel's one direction: how much it lowers that direction's visibility (0 or less; min
    // before max turns a NaN into 0, so none reaches the neighbours)
    float farDelta = 0.0;
    [branch] if (active)
    {
        float all0 = farH0, all1 = farH1;
        FarHorizons(uv, px, P, V, tanHalfFov, farDir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, farLow0, farLow1, all0, all1);
        float g0 = farN + clamp(-acos(clamp(all1, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        float g1 = farN + clamp( acos(clamp(all0, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        float arcAll0 = (farCosN + 2.0 * g0 * sin(farN) - cos(2.0 * g0 - farN)) * 0.25;
        float arcAll1 = (farCosN + 2.0 * g1 * sin(farN) - cos(2.0 * g1 - farN)) * 0.25;
        farDelta = max(min(farProj * (arcAll0 + arcAll1 - farNear), 0.0), -2.0);
    }
    // the quad's exchange (all four pixels reach it): the mean of this pixel's far result and those of its neighbours
    // at a similar depth stands for every direction; a pixel with nothing to search (sky, far, too small a radius)
    // matches no one
    float2 qs = float2(((int)target.x & 1) ? -1.0 : 1.0, ((int)target.y & 1) ? -1.0 : 1.0);
    float qz = active ? z : -1e4;
    float qzh = qz + qs.x * ddx_fine(qz), qzv = qz + qs.y * ddy_fine(qz), qzd = qzh + qs.y * ddy_fine(qzh);
    float tol = 0.03 * z + 0.05;
    float wh = abs(qzh - qz) < tol ? 1.0 : 0.0, wv = abs(qzv - qz) < tol ? 1.0 : 0.0, wd = abs(qzd - qz) < tol ? 1.0 : 0.0;
    float farShare = QuadShare(farDelta, qs, wh, wv, wd) / (1.0 + wh + wv + wd);
    if (!active)
        return float4(1.0, zTrue, zTrue, zTrue);
    visibility = pow(saturate(visibility / AO_SLICES + farShare), AO_POWER);
#else
    visibility = pow(saturate(visibility / AO_SLICES), AO_POWER);
#endif
    visibility = lerp(1.0, visibility, fade);
#if VERIFY_SWAP
    // Stripes instead of AO. The real result keeps a 1/1024 share, so this build declares the same resources.
    visibility = lerp(frac(uv.x * 20.0) < 0.5 ? 0.0 : 1.0, visibility, 1.0 / 1024.0);
#endif
    return float4(visibility, z, z, z);
}
