// SnowRunner GTAO with bounce light: the GTAO pass (replacement for the game's two SSAO generation shaders, full and
// half resolution; the ambient occlusion part is the released SnowRunner GTAO, gtao.hlsl) that also measures the light
// nearby surfaces bounce onto each pixel, for SnowRunner's material shaders to add to their ambient light next frame.
//
// Bounce light: the horizon search of GTAO already finds, per screen direction, which surfaces hide the sky from the
// pixel. Each step that raises the horizon hides a further arc of the sky, and that arc sees the surface the step
// found: its colour in this frame's lit image (copied before this pass by SnowRunner Shadows, hid.dll, bound at t120),
// weighted by the arc's cosine-weighted share, the same measure GTAO integrates for the visibility. So a pixel boxed in
// by sunlit snow gathers the snow's light, and one next to a red truck gathers red. Own derivation from the GTAO arc
// integral; the idea is that of horizon-based indirect lighting.
// The result, times GI_STRENGTH, is stored divided by the darkening the AO apply pass will give the pixel (so after it
// the bounce keeps its strength), but never above GI_CAP times the brightest surface it came from, which keeps the loop
// (bounce light becomes part of the lit image the next frame gathers from) bounded whatever the strength.
//
// Contract with the engine: that of gtao.hlsl (same constant buffers, textures, samplers, input signature; output 0 x =
// visibility, yzw = the centre depth), plus t120 (this frame's lit scene) and output 1 = the bounce light (rgb). Output
// 1 goes nowhere unless SnowRunner Shadows binds its bounce-light texture there, and without the DLL t120 reads zero:
// then this pass is GTAO alone.
//
// Horizon integration after Intel's XeGTAO (MIT, see THIRD_PARTY_NOTICES.md of SnowRunner GTAO).
//
// Build: fxc -T ps_5_0 -E main gtao_gi.hlsl. Every value below can be set with -D NAME=value.

#ifndef AO_SLICES
#define AO_SLICES 4            // screen directions per pixel
#endif
#ifndef AO_STEPS
#define AO_STEPS 8             // depth taps per direction and side
#endif
#ifndef AO_RADIUS
#define AO_RADIUS 1.5          // metres
#endif
#ifndef AO_RADIUS_MAX_DEPTH_FRACTION
#define AO_RADIUS_MAX_DEPTH_FRACTION 0.12   // caps the radius near the camera and keeps the kernel bounded on screen
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
                               // The near search keeps every direction, so the contact shadows and the bounce light stay as
                               // they are. On in the shipped build: the AO buffer alone shows a faint lattice on flat ground
                               // next to big objects, the finished picture does not. 0 = every direction searches far
                               // (byte-identical blob)
#ifndef AO_HALF_SNAP
#define AO_HALF_SNAP 0         // 1 = ready to be drawn at half size (SnowRunner Shadows, ini AOHalf=1): a target
#endif                         // pixel that covers 2 x 2 full-size pixels computes the top-left one of them exactly (uv moved
                               // to its centre: the DLL's upsample weighs each half-size result by that pixel's depth), with
                               // the noise of the target's own pixel grid. Drawn at full size the output is the same as with 0
                               // (every pixel is its own top-left one). 0 = the pass as it is (byte-identical blob)
#ifndef AO_DEPTH_LOD
#define AO_DEPTH_LOD 0         // 1 = the horizon taps (near and far) read the depth's mip chain, as XeGTAO does: the level whose
#endif                         // texels are the tap's distance / 2^AO_DEPTH_LOD_OFFSET pixels wide, at that texel's centre, so a
                               // tap far out reads a few cached texels instead of one full-size texel hundreds of pixels away
                               // (the AO pass is bound by its depth taps: 1.14 ms at half size). Needs a depth with mips at
                               // t80; the centre and the normal keep level 0. A mean or XeGTAO's weighted mean makes phantom
                               // surfaces at edges (speckles on flat ground next to a truck); the nearest darkens (1 %).
                               // 2 = the shipped way: a tap moves to the top-left full-size pixel of that level's
                               // texel and reads its exact depth, from SnowRunner Shadows' decimated levels 1..4 at t126
                               // (hid.dll, src\ao\depth_decimate.hlsl: each texel the full-size depth there) or, where t126
                               // holds nothing, from t80: the same picture either way, the mips only make it fast (on a
                               // captured frame 0.57 ms against 1.15 at half size; flat ground, the truck and the grass
                               // unchanged, mean visibility 0.7593 against 0.7589). 0 = level 0 everywhere (byte-identical blob)
#ifndef AO_DEPTH_LOD_OFFSET
#define AO_DEPTH_LOD_OFFSET 3.3        // XeGTAO's DepthMIPSamplingOffset: level 0 up to ~10 pixels out, level 1 to ~20, ...
#endif
#ifndef AO_DEPTH_LOD_MAX
#define AO_DEPTH_LOD_MAX 4.0
#endif
#ifndef AO_DEPTH_LOD_SNAP
#define AO_DEPTH_LOD_SNAP 1            // 1 = a tap moves to the centre of the level's texel it reads; 0 = it keeps its full-size
#endif                                 // pixel's place (XeGTAO's way) and only its depth comes from the coarser level; 2 = it
                                       // moves to the top-left full-size pixel of that texel's block, whose exact depth the
                                       // texel holds when the levels are decimated (SnowRunner Shadows' depth_decimate.hlsl)
#ifndef AO_FADE_START
#define AO_FADE_START 150.0    // metres: the effect fades out between start and end, fog owns the distance
#endif
#ifndef AO_FADE_END
#define AO_FADE_END 300.0
#endif
#ifndef TAN_HALF_FOV_Y
#define TAN_HALF_FOV_Y 0.5275
#endif
#ifndef AO_FOV_FROM_CAMERA
#define AO_FOV_FROM_CAMERA 1   // 1 = the field of view of the game's camera, every frame (CB_GLOBAL_CAMERA, b1); 0 = the
#endif                         // fixed TAN_HALF_FOV_Y of SnowRunner GTAO 1.0. The game's view is narrower than that value
                               // assumes (tan 0.4005 = 43.7 degrees vertical in a captured frame against 0.5275 = 55.7):
                               // the fixed value sizes the radius and the horizon angles for a wider view than the screen's
#ifndef AO_VB
#define AO_VB 0                // 1 = visibility bitmask (after Therrien, Levesque and Gilet 2023, "Screen Space Indirect Lighting
#endif                         // with Visibility Bitmask"; own implementation): each direction keeps 32 sectors of
                               // its half circle instead of two horizon angles, and a tap hides only the sectors between the
                               // front of what it hit and a point VB_THICKNESS behind it. Thin things (grass, poles, fences,
                               // trunks) stop darkening as if they were solid walls, and the bounce light counts the light
                               // seen between them. The sectors are laid out evenly in GTAO's cosine-weighted measure, so each
                               // weighs the same; with an endless thickness the result is GTAO's up to the sector width.
                               // 0 = the pass as it is (byte-identical blob)
#ifndef VB_THICKNESS
#define VB_THICKNESS 0.5       // metres a tap's surface is assumed to reach behind its front, along the camera ray
#endif
#ifndef VB_THICKNESS_Z
#define VB_THICKNESS_Z 0.0     // plus this share of the tap's depth
#endif
#ifndef GI_STRENGTH
#define GI_STRENGTH 4.0        // bounce light scale, applied before GI_CAP (so the loop through the lit image stays bounded):
#endif                         // 1 = the physical amount (measured in game: about 1 % of the sky ambient, invisible next to
                               // the game's dark surfaces); 4 = the default, so the effect shows; 0 = none
#ifndef GI_CAP
#define GI_CAP 0.9             // the stored bounce never exceeds this share of the brightest surface it gathered
#endif
#ifndef GI_SAMPLE_MAX
#define GI_SAMPLE_MAX 64.0     // lit image values above this (sun glints) are clipped before they are gathered
#endif
#ifndef GI_LOD
#define GI_LOD 0               // 1 = a tap's light comes from the scene feed's mip chain (SnowRunner Shadows makes it, FeedMips=1),
#endif                         // the level whose texels are a quarter of the tap's distance wide: the light of the area around
                               // the tap from a few cached texels instead of one full-resolution texel hundreds of pixels
                               // away (without it the bounce light costs 1.7 ms at 4K); smoother, and never the pixel's own
                               // light. Without the DLL's mips it reads level 0. 0 = level 0 (byte-identical blob)
#ifndef GI_LOD_MAX
#define GI_LOD_MAX 5.0         // the coarsest level a tap reads (32 x 32 pixels per texel)
#endif
#ifndef GI_GATHER_TOP
#define GI_GATHER_TOP 0        // 1 = each direction's side takes the light of the one tap that set its final horizon (the highest
#endif                         // thing it found), read once after the search and weighted by the arc that side has hidden:
                               // at most 8 light reads per pixel and no branch in the tap loop, instead of a read for every
                               // tap that raised a horizon (that gather costs 1.5 ms at 4K even with GI_LOD and
                               // GI_WEIGHT_COS). 0 = every raising tap gathers (byte-identical blob)
#ifndef GI_WEIGHT_COS
#define GI_WEIGHT_COS 0        // 1 = a tap that raises the horizon weighs its light by how far it raised the horizon's cosine,
#endif                         // not by the exact arc it hid (an acos and a cos per raise, inside a branch: the gather costs
                               // 1.9 ms of GI's 2.4 at 4K; with it compiled out the frame is as fast as with GI off).
                               // The amount of bounce stays the AO's hidden share; only the mix of the colours gathered
                               // changes. 0 = the exact arcs (byte-identical blob)
#ifndef GI_UNDO_AO
#define GI_UNDO_AO 1           // 1 = stored undone by the apply pass's darkening (with the cap); 0 = the bare bounce (tests)
#endif
#ifndef GI_OFF
#define GI_OFF 0               // 1 = the pass without the bounce light: no tap reads the lit image, and output 1 is zero. The output
#endif                         // stays declared: SnowRunner Shadows takes the pass by it and draws it at half size. For an
                               // install with GTAO and without the Bounce light module
#ifndef GI_WHITE
#define GI_WHITE 0             // 1 = GI_STRENGTH holds back on bright surfaces: it raises a tap's light at most to what a white
#endif                         // surface gives off under the sky's ambient light (GI_WHITE_LEVEL x the brightest of the three
                               // ambient colours the materials read, CB_GLOBAL_SCENE c50..c52, bound while the AO pass
                               // draws), and a tap brighter than that counts as it is. Without it the strength multiplies
                               // every tap: snow is near white already, so a crease in it gathers more light than the snow
                               // around it gives off, the lit image feeds that back, and tracks in shaded snow glow blue.
                               // 0 = the strength on every tap (byte-identical blob)
#ifndef GI_WHITE_LEVEL
#define GI_WHITE_LEVEL 1.0     // with GI_WHITE: the ceiling of the raised light, in multiples of that ambient light
#endif
#ifndef GI_PROBE
#define GI_PROBE 0             // diagnostics only (the pass run again on a frame SnowRunner Shadows dumped in game):
#endif                         // output 1 = intermediate values instead of the bounce light: 1 (1 - open, hidden, brightest,
                               // radiusPx), 2 (the mean light gathered rgb, hidden), 3 (the bare bounce rgb, the darkening),
                               // 4 (factorRaw, factor, rScale, radiusPx), 5 (the scene sampled at the pixel rgb, depth).
                               // 0 = the pass as it is (the blob is byte-identical with these blocks compiled out).

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
#if GI_WHITE
cbuffer CB_GLOBAL_SCENE : register(b2)              // the game's scene constants, bound while its AO pass draws
{
    float4 g_vSceneHead[50];
    float4 g_cAmbientPosY, g_cAmbientMidY, g_cAmbientNegY;   // c50..c52: g_ambientLight, rgb
};
#endif
SamplerState      _SAMPLERS[16] : register(s0);   // the engine's sampler array: 0 = depth, 1 = dither (wrap), 2 = factor
Texture2D<float4> g_txDither : register(t0);
Texture2D<float4> g_txFactor : register(t2);
Texture2D<float4> g_txZ      : register(t80);
Texture2D<float4> g_txScene  : register(t120);    // this frame's lit scene, from SnowRunner Shadows (hid.dll)
#if AO_DEPTH_LOD == 2
Texture2D<float4> g_txZMips  : register(t126);    // SnowRunner Shadows: levels 1..4 of g_txZ, decimated (its level k = level k + 1)
static bool s_haveZMips = false;                  // set in main: t126 holds them
#endif

static const float PI = 3.14159265;
static const float HALF_PI = 1.57079633;

float Depth(float2 uv) { return g_txZ.SampleLevel(_SAMPLERS[0], uv, 0).x; }

// a horizon tap's depth, dPx pixels out from the centre (px: one full-size pixel). AO_DEPTH_LOD: from the level whose
// texels are dPx / 2^AO_DEPTH_LOD_OFFSET wide, with uvTap moved to that texel's centre (the place the depth stands for)
float TapDepth(inout float2 uvTap, float dPx, float2 px)
{
#if AO_DEPTH_LOD == 2
    // (at level 0 the tap stays on its pixel's centre, where it came: the plain tap; one off the screen reads level 0,
    // whose clamped edge is another texel than a level's edge: so the picture is the same with t126 and without)
    float lod = clamp(floor(log2(max(dPx, 1.0)) - AO_DEPTH_LOD_OFFSET), 0.0, AO_DEPTH_LOD_MAX);
    float2 cell = px * exp2(lod);
    uvTap = floor(uvTap / cell) * cell + 0.5 * px;
    float zTap;
    [branch] if (lod >= 1.0 && s_haveZMips && all(uvTap == saturate(uvTap))) zTap = g_txZMips.SampleLevel(_SAMPLERS[0], uvTap, lod - 1.0).x;
    else zTap = Depth(uvTap);
    return zTap;
#elif AO_DEPTH_LOD
    float lod = clamp(floor(log2(max(dPx, 1.0)) - AO_DEPTH_LOD_OFFSET), 0.0, AO_DEPTH_LOD_MAX);
#if AO_DEPTH_LOD_SNAP == 2
    float2 cell = px * exp2(lod);
    uvTap = floor(uvTap / cell) * cell + 0.5 * px;
#elif AO_DEPTH_LOD_SNAP
    float2 cell = px * exp2(lod);
    uvTap = (floor(uvTap / cell) + 0.5) * cell;
#endif
    return g_txZ.SampleLevel(_SAMPLERS[0], uvTap, lod).x;
#else
    return Depth(uvTap);
#endif
}

// the light a step found: the lit image there, clipped, never negative or NaN
#if GI_OFF
#define TAP_LIGHT(uv, dPx) float3(0.0, 0.0, 0.0)
#elif GI_LOD
// the light a tap found, from the level of the feed's mip chain whose texels are at most a quarter of the tap's distance
// (dPx, in pixels) wide: the light of the area around the tap, never the pixel's own
float3 SceneLight(float2 uv, float dPx)
{
    float lod = clamp(log2(max(dPx * 0.25, 1.0)), 0.0, GI_LOD_MAX);
    return min(max(g_txScene.SampleLevel(_SAMPLERS[2], uv, lod).rgb, 0.0), GI_SAMPLE_MAX);
}
#define TAP_LIGHT(uv, dPx) SceneLight(uv, dPx)
#else
float3 SceneLight(float2 uv) { return min(max(g_txScene.SampleLevel(_SAMPLERS[2], uv, 0).rgb, 0.0), GI_SAMPLE_MAX); }
#define TAP_LIGHT(uv, dPx) SceneLight(uv)
#endif

// GI_STRENGTH on one tap's light. With GI_WHITE the tap is raised at most to white (the light of a white surface under
// the sky's ambient light), and a tap brighter than that keeps its own light; the stored sum is then not scaled again
#if GI_WHITE
float3 Raised(float3 L, float white)
{
    return L * clamp(white / max(dot(L, float3(0.2126, 0.7152, 0.0722)), 1e-6), min(1.0, GI_STRENGTH), GI_STRENGTH);
}
#define TAP_RAISED(L) Raised(L, white)
#define GI_SUM_STRENGTH 1.0
#else
#define TAP_RAISED(L) (L)
#define GI_SUM_STRENGTH GI_STRENGTH
#endif

// View space: x right, y up, z forward. uv (0,0) is the top left corner.
float3 ViewPos(float2 uv, float z, float2 tanHalfFov)
{
    return float3((uv.x * 2.0 - 1.0) * tanHalfFov.x, (1.0 - uv.y * 2.0) * tanHalfFov.y, 1.0) * z;
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

float InterleavedGradientNoise(float2 pixel)
{
    return frac(52.9829189 * frac(dot(pixel, float2(0.06711056, 0.00583715))));
}

// GTAO's cosine-weighted arc between the view direction and horizon angle h (slice normal angle n), the measure the
// visibility sums: a horizon that rises by one step hides arc(old h) - arc(new h)
float Arc(float h, float n, float sinN, float cosN) { return (cosN + 2.0 * h * sinN - cos(2.0 * h - n)) * 0.25; }

#if AO_VB
// acos to about 1e-4 radians (Abramowitz and Stegun 4.4.45), a fraction of a sector's width
float FastAcos(float x)
{
    float a = abs(x);
    float r = sqrt(1.0 - a) * (1.5707288 + a * (-0.2121144 + a * (0.0742610 - 0.0187293 * a)));
    return x < 0.0 ? PI - r : r;
}
// the slice's cosine-weighted measure from the view direction to angle h, signed (Arc is the measure between h and the
// view direction on h's side), so it grows steadily from the low end of the half circle (n - pi/2) to the high end
float SliceMeasure(float h, float n, float sinN, float cosN) { return h < 0.0 ? -Arc(h, n, sinN, cosN) : Arc(h, n, sinN, cosN); }
// the sectors a span covers, its ends a and b (a <= b) as shares of the slice's measure, rounded with the pixel's jitter
uint SpanBits(float a, float b, float jitter)
{
    int lo = clamp((int)floor(a * 32.0 + jitter), 0, 32);
    int count = clamp((int)floor(b * 32.0 + jitter), 0, 32) - lo;
    return count >= 32 ? 0xFFFFFFFFu : (count <= 0 ? 0u : ((1u << (uint)count) - 1u) << (uint)lo);
}
#endif

#if AO_FAR
// Far taps along one screen direction, both sides, from the near radius to the far one. What they find raises the
// horizons (cosines; they start at the near search's) only part of the way: AO_FAR_STRENGTH at the near radius, nothing
// at the far one. So a canopy, a truck body or a wall a few metres off darkens gently, and the contact shadow stays the
// near search's (the horizon is the higher of the two, never their product). Taps off the screen find nothing.
void FarHorizons(float2 uv, float2 px, float3 P, float3 V, float2 tanHalfFov, float2 dir, float radiusPxFar, float radiusFar,
                 float nearEnd, float farSpan, float noiseSample, float lowHorizon0, float lowHorizon1,
                 inout float horizonAll0, inout float horizonAll1)
{
    float2 omegaFar = float2(dir.x, -dir.y) * radiusPxFar * px;
    for (int farStep = 0; farStep < AO_FAR_STEPS; farStep++)
    {
        float t = (farStep + frac(noiseSample + (farStep + AO_STEPS) * 0.6180339887)) / AO_FAR_STEPS;
        float2 offset = lerp(nearEnd, 1.0, t) * omegaFar;

        float2 uv0 = (floor((uv + offset) / px) + 0.5) * px;
        float  dPx = lerp(nearEnd, 1.0, t) * radiusPxFar;
        float  z0 = TapDepth(uv0, dPx, px);
        float3 d0 = ViewPos(uv0, z0, tanHalfFov) - P;
        float  l0 = length(d0);
        float  w0 = all(uv0 == saturate(uv0)) ? AO_FAR_STRENGTH * saturate((radiusFar - l0) / farSpan) : 0.0;
        horizonAll0 = max(horizonAll0, lerp(lowHorizon0, dot(d0 / max(l0, 1e-5), V), w0));

        float2 uv1 = (floor((uv - offset) / px) + 0.5) * px;
        float  z1 = TapDepth(uv1, dPx, px);
        float3 d1 = ViewPos(uv1, z1, tanHalfFov) - P;
        float  l1 = length(d1);
        float  w1 = all(uv1 == saturate(uv1)) ? AO_FAR_STRENGTH * saturate((radiusFar - l1) / farSpan) : 0.0;
        horizonAll1 = max(horizonAll1, lerp(lowHorizon1, dot(d1 / max(l1, 1e-5), V), w1));
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

struct PSOut { float4 ao : SV_Target0; float4 gi : SV_Target1; };

PSOut main(float2 uv : TEXCOORD0, uint frontFace : SV_IsFrontFace)
{
    PSOut o;
    o.gi = 0.0;
    float2 px = g_vBBSizeInv;
#if AO_HALF_SNAP
    // the full-size pixels this target pixel covers (1 x 1, or 2 x 2 drawn at half size) and the centre of the top-left one;
    // at full size uv stays exactly as it came (moving it to the same centre changes it by a rounding step, and the noise
    // and the taps at depth edges follow such steps: 815 of 8.3 M pixels of a captured frame change by over 0.2)
    float2 cover = max(round(float2(ddx_fine(uv.x), ddy_fine(uv.y)) / px), 1.0);
    bool halfSize = any(cover > 1.0);
    uv = halfSize ? (floor(uv / (px * cover)) * cover + 0.5) * px : uv;
#endif
#if AO_DEPTH_LOD == 2
    uint zmW = 0, zmH = 0, zmLevels = 0;
    g_txZMips.GetDimensions(0, zmW, zmH, zmLevels);
    s_haveZMips = zmW > 0 && zmLevels >= (uint)AO_DEPTH_LOD_MAX;
#endif
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
    {
        o.ao = float4(1.0, z, z, z);
        return o;
    }
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

    // Radius: the game's min/max radius and its per pixel factor keep their meaning as a scale on the metric radius
    float factorRaw = g_txFactor.SampleLevel(_SAMPLERS[2], uv, 0).x;
    float factor  = saturate(factorRaw * 2.0 - 1.0);
    float rScale  = lerp(g_vRadiusMinMax.x, g_vRadiusMinMax.y, factor) / max(g_vRadiusMinMax.y, 1e-4);
    float radius  = min(AO_RADIUS * rScale, z * AO_RADIUS_MAX_DEPTH_FRACTION);
    float radiusPx = radius / (z * 2.0 * tanHalfFov.y * px.y);   // one pixel covers z * 2 tan(fov/2) / height
#if GI_PROBE == 4
    o.ao = float4(1.0, z, z, z);
    o.gi = float4(factorRaw, factor, rScale, radiusPx);
    return o;
#elif GI_PROBE == 5
    o.ao = float4(1.0, z, z, z);
    o.gi = float4(TAP_LIGHT(uv, 0.0), z);
    return o;
#endif
#if AO_FAR && AO_FAR_SHARE
    active = active && radiusPx >= 1.5;
#else
    if (radiusPx < 1.5)
    {
        o.ao = float4(1.0, z, z, z);
        return o;
    }
#endif

    float falloffRange = 0.615 * radius;
    float falloffMul   = -1.0 / falloffRange;
    float falloffAdd   = (radius - falloffRange) / falloffRange + 1.0;

    float2 pixel = uv / px;
#if AO_HALF_SNAP
    float2 noisePixel = halfSize ? floor(pixel / cover) + 0.5 : pixel;   // the target's own pixel grid
#else
    float2 noisePixel = pixel;
#endif
    // The dither texture only nudges the noise. It stays referenced so the shader declares every resource and constant
    // the original declares: the engine sees this blob alone and may bind by those names.
    float ditherNudge = g_txDither.SampleLevel(_SAMPLERS[1], uv * g_vDitherTile, 0).x * (1.0 / 1024.0);
    float noiseSlice  = frac(InterleavedGradientNoise(noisePixel) + ditherNudge);
    float noiseSample = InterleavedGradientNoise(noisePixel + float2(17.0, 43.0));

#if AO_FAR
    // The far reach, in the same directions: its own radius under looser caps, taps from the near radius out to it.
    // Only the output's visibility takes it; the bounce light keeps the near search's share.
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
    float farN = 0.0, farSinN = 0.0, farCosN = 1.0, farLow0 = 0.0, farLow1 = 0.0, farH0 = 0.0, farH1 = 0.0, farProj = 0.0, farNear = 0.0;
#if AO_VB
    uint farMask = 0u;   // that direction's near sectors, and its measure's start, scale, sector share and jitter
    float farLowM = 0.0, farScale = 0.0, farSector = 0.0, farJitter = 0.0;
#endif
#else
    float visibilityAll = 0.0;
#endif
#endif
    float visibility = 0.0;
    float3 bounce = 0.0;      // the light of the steps that raised a horizon, each weighted by the arc it hid
    float hidden = 0.0;       // the sum of those weights
    float brightest = 0.0;
#if GI_WHITE
    const float3 lumaOf = float3(0.2126, 0.7152, 0.0722);
    float white = GI_WHITE_LEVEL * max(dot(g_cAmbientPosY.rgb, lumaOf), max(dot(g_cAmbientMidY.rgb, lumaOf), dot(g_cAmbientNegY.rgb, lumaOf)));
#endif
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
        float  sinN = sin(n);

        float lowHorizon0 = cos(n + HALF_PI), lowHorizon1 = cos(n - HALF_PI);
#if AO_VB
        // the slice's 32 sectors: where its measure starts, its total, one sector's share, and the rounding jitter
        float mLow = SliceMeasure(n - HALF_PI, n, sinN, cosN);
        float mTotal = SliceMeasure(n + HALF_PI, n, sinN, cosN) - mLow;
        float mScale = 1.0 / max(mTotal, 1e-5), mSector = mTotal * (1.0 / 32.0);
        float bitJitter = InterleavedGradientNoise(noisePixel + float2(5.0, 11.0) * (slice + 1));
        uint mask = 0u;
#else
        float horizon0 = lowHorizon0, horizon1 = lowHorizon1;
        // the arc each side still sees, starting from the whole quarter (nothing hides it yet)
        float arcOpen0 = Arc(n + HALF_PI, n, sinN, cosN), arcOpen1 = Arc(n - HALF_PI, n, sinN, cosN);
#if GI_GATHER_TOP
        float2 topUv0 = uv, topUv1 = uv;   // where each side's highest tap so far was, and its distance along the search
        float topS0 = 0.0, topS1 = 0.0;
#endif
#endif
        float3 sliceBounce = 0.0;
        float sliceHidden = 0.0;
        for (int step = 0; step < AO_STEPS; step++)
        {
            float s = (step + frac(noiseSample + step * 0.6180339887)) / AO_STEPS;
            s = s * s + 1.3 / radiusPx;   // denser near the centre, never closer than about a pixel
            float2 offset = s * omega;

#if AO_VB
            // each side: the front of what the tap hit and a point VB_THICKNESS behind it along the camera ray, as angles
            // from the view direction (both pulled toward the tangent by the falloff, like GTAO's horizon), mark the
            // sectors between them; the sectors no earlier tap marked take this tap's light, each with its share
            float2 uv0 = (floor((uv + offset) / px) + 0.5) * px;
            float3 s0 = ViewPos(uv0, Depth(uv0), tanHalfFov);
            float3 d0 = s0 - P;
            float  l0 = length(d0);
            float  w0 = saturate(l0 * falloffMul + falloffAdd);
            float3 e0 = d0 + s0 * rsqrt(max(dot(s0, s0), 1e-8)) * (VB_THICKNESS + VB_THICKNESS_Z * s0.z);
            float  f0 = n + clamp(FastAcos(clamp(lerp(lowHorizon0, dot(d0, V) / max(l0, 1e-5), w0), -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
            float  b0 = n + clamp(FastAcos(clamp(lerp(lowHorizon0, dot(e0, V) / max(length(e0), 1e-5), w0), -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
            float  uf0 = (SliceMeasure(f0, n, sinN, cosN) - mLow) * mScale, ub0 = (SliceMeasure(b0, n, sinN, cosN) - mLow) * mScale;
            uint   bits0 = SpanBits(min(uf0, ub0), max(uf0, ub0), bitJitter);
            [branch] if ((bits0 & ~mask) != 0u)
            {
                float3 L = TAP_LIGHT(uv0, s * radiusPx);
                float share = countbits(bits0 & ~mask) * mSector;
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
                mask |= bits0;
            }

            float2 uv1 = (floor((uv - offset) / px) + 0.5) * px;
            float3 s1 = ViewPos(uv1, Depth(uv1), tanHalfFov);
            float3 d1 = s1 - P;
            float  l1 = length(d1);
            float  w1 = saturate(l1 * falloffMul + falloffAdd);
            float3 e1 = d1 + s1 * rsqrt(max(dot(s1, s1), 1e-8)) * (VB_THICKNESS + VB_THICKNESS_Z * s1.z);
            float  f1 = n + clamp(-FastAcos(clamp(lerp(lowHorizon1, dot(d1, V) / max(l1, 1e-5), w1), -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
            float  b1 = n + clamp(-FastAcos(clamp(lerp(lowHorizon1, dot(e1, V) / max(length(e1), 1e-5), w1), -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
            float  uf1 = (SliceMeasure(f1, n, sinN, cosN) - mLow) * mScale, ub1 = (SliceMeasure(b1, n, sinN, cosN) - mLow) * mScale;
            uint   bits1 = SpanBits(min(uf1, ub1), max(uf1, ub1), bitJitter);
            [branch] if ((bits1 & ~mask) != 0u)
            {
                float3 L = TAP_LIGHT(uv1, s * radiusPx);
                float share = countbits(bits1 & ~mask) * mSector;
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
                mask |= bits1;
            }
#else
            float2 uv0 = (floor((uv + offset) / px) + 0.5) * px;
            float  z0 = TapDepth(uv0, s * radiusPx, px);
            float3 d0 = ViewPos(uv0, z0, tanHalfFov) - P;
            float  l0 = length(d0);
            float  c0 = lerp(lowHorizon0, dot(d0 / max(l0, 1e-5), V), saturate(l0 * falloffMul + falloffAdd));
#if GI_GATHER_TOP
            [flatten] if (c0 > horizon0) { topUv0 = uv0; topS0 = s; }
#else
            [branch] if (c0 > horizon0)
            {
#if GI_WEIGHT_COS
                float share = c0 - horizon0;   // how far this tap raised the horizon's cosine: its light's weight
                float3 L = TAP_LIGHT(uv0, s * radiusPx);
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
#else
                float a = Arc(n + clamp(acos(clamp(c0, -1.0, 1.0)) - n, -HALF_PI, HALF_PI), n, sinN, cosN);
                float3 L = TAP_LIGHT(uv0, s * radiusPx);
                float share = max(arcOpen0 - a, 0.0);
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
                arcOpen0 = min(arcOpen0, a);
#endif
            }
#endif
            horizon0 = max(horizon0, c0);

            float2 uv1 = (floor((uv - offset) / px) + 0.5) * px;
            float  z1 = TapDepth(uv1, s * radiusPx, px);
            float3 d1 = ViewPos(uv1, z1, tanHalfFov) - P;
            float  l1 = length(d1);
            float  c1 = lerp(lowHorizon1, dot(d1 / max(l1, 1e-5), V), saturate(l1 * falloffMul + falloffAdd));
#if GI_GATHER_TOP
            [flatten] if (c1 > horizon1) { topUv1 = uv1; topS1 = s; }
#else
            [branch] if (c1 > horizon1)
            {
#if GI_WEIGHT_COS
                float share = c1 - horizon1;   // how far this tap raised the horizon's cosine: its light's weight
                float3 L = TAP_LIGHT(uv1, s * radiusPx);
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
#else
                float a = Arc(n + clamp(-acos(clamp(c1, -1.0, 1.0)) - n, -HALF_PI, HALF_PI), n, sinN, cosN);
                float3 L = TAP_LIGHT(uv1, s * radiusPx);
                float share = max(arcOpen1 - a, 0.0);
                sliceBounce += share * TAP_RAISED(L);
                sliceHidden += share;
                brightest = max(brightest, max(L.r, max(L.g, L.b)));
                arcOpen1 = min(arcOpen1, a);
#endif
            }
#endif
            horizon1 = max(horizon1, c1);
#endif
        }
#if AO_FAR && AO_VB && !AO_FAR_SHARE
        // the far taps alone, as horizons (what they find is taken as endlessly thick, as before): every sector below
        // them joins the near mask for the output's visibility
        float farC0 = lowHorizon0, farC1 = lowHorizon1;
        FarHorizons(uv, px, P, V, tanHalfFov, dir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, lowHorizon0, lowHorizon1, farC0, farC1);
#elif AO_FAR && !AO_FAR_SHARE
        // the far taps along the same direction
        float horizonAll0 = horizon0, horizonAll1 = horizon1;
        FarHorizons(uv, px, P, V, tanHalfFov, dir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, lowHorizon0, lowHorizon1, horizonAll0, horizonAll1);
#endif

        projLen = lerp(projLen, 1.0, 0.05);
#if AO_VB
        visibility += projLen * mSector * (32.0 - countbits(mask));
#if AO_FAR && AO_FAR_SHARE
        // this pixel's far direction: what the far search after the loop needs of it
        [flatten] if (slice == farSlice)
        {
            farDir = dir; farN = n; farSinN = sinN; farCosN = cosN; farLow0 = lowHorizon0; farLow1 = lowHorizon1; farProj = projLen;
            farMask = mask; farLowM = mLow; farScale = mScale; farSector = mSector; farJitter = bitJitter;
        }
#elif AO_FAR
        float gf0 = n + clamp( FastAcos(clamp(farC0, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
        float gf1 = n + clamp(-FastAcos(clamp(farC1, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
        uint maskAll = mask | SpanBits((SliceMeasure(gf0, n, sinN, cosN) - mLow) * mScale, 1.0, bitJitter)
                            | SpanBits(0.0, (SliceMeasure(gf1, n, sinN, cosN) - mLow) * mScale, bitJitter);
        visibilityAll += projLen * mSector * (32.0 - countbits(maskAll));
#endif
#else
        float h0 = -acos(clamp(horizon1, -1.0, 1.0));
        float h1 =  acos(clamp(horizon0, -1.0, 1.0));
        h0 = n + clamp(h0 - n, -HALF_PI, HALF_PI);
        h1 = n + clamp(h1 - n, -HALF_PI, HALF_PI);
        float arc0 = (cosN + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) * 0.25;
        float arc1 = (cosN + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) * 0.25;
        visibility += projLen * (arc0 + arc1);
#if GI_GATHER_TOP
        // each side's hidden arc (its whole quarter less what it still sees) takes the light of the tap that set its horizon
        float hid0 = max(arcOpen0 - arc1, 0.0), hid1 = max(arcOpen1 - arc0, 0.0);   // side 0's horizon is h1, side 1's h0
        [branch] if (hid0 > 1e-5)
        {
            float3 L = TAP_LIGHT(topUv0, topS0 * radiusPx);
            sliceBounce += hid0 * TAP_RAISED(L);
            sliceHidden += hid0;
            brightest = max(brightest, max(L.r, max(L.g, L.b)));
        }
        [branch] if (hid1 > 1e-5)
        {
            float3 L = TAP_LIGHT(topUv1, topS1 * radiusPx);
            sliceBounce += hid1 * TAP_RAISED(L);
            sliceHidden += hid1;
            brightest = max(brightest, max(L.r, max(L.g, L.b)));
        }
#endif
#if AO_FAR && !AO_FAR_SHARE
        float g0 = n + clamp(-acos(clamp(horizonAll1, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
        float g1 = n + clamp( acos(clamp(horizonAll0, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
        visibilityAll += projLen * (Arc(g0, n, sinN, cosN) + Arc(g1, n, sinN, cosN));
#elif AO_FAR
        // this pixel's far direction: what the far search after the loop needs of it
        [flatten] if (slice == farSlice)
        {
            farDir = dir; farN = n; farSinN = sinN; farCosN = cosN; farLow0 = lowHorizon0; farLow1 = lowHorizon1;
            farH0 = horizon0; farH1 = horizon1; farProj = projLen; farNear = arc0 + arc1;
        }
#endif
#endif
        bounce += projLen * sliceBounce;
        hidden += projLen * sliceHidden;
    }
#if AO_FAR && AO_FAR_SHARE
    // the far search in this pixel's one direction: how much it lowers that direction's visibility (0 or less; min
    // before max turns a NaN into 0, so none reaches the neighbours)
    float farDelta = 0.0;
    [branch] if (active)
    {
#if AO_VB
        // the far taps alone, endlessly thick: the sectors below them that the near mask left open
        float c0 = farLow0, c1 = farLow1;
        FarHorizons(uv, px, P, V, tanHalfFov, farDir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, farLow0, farLow1, c0, c1);
        float gf0 = farN + clamp( FastAcos(clamp(c0, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        float gf1 = farN + clamp(-FastAcos(clamp(c1, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        uint maskAll = farMask | SpanBits((SliceMeasure(gf0, farN, farSinN, farCosN) - farLowM) * farScale, 1.0, farJitter)
                               | SpanBits(0.0, (SliceMeasure(gf1, farN, farSinN, farCosN) - farLowM) * farScale, farJitter);
        farDelta = -farProj * farSector * (float)(countbits(maskAll) - countbits(farMask));
#else
        float all0 = farH0, all1 = farH1;
        FarHorizons(uv, px, P, V, tanHalfFov, farDir, radiusPxFar, radiusFar, nearEnd, farSpan, noiseSample, farLow0, farLow1, all0, all1);
        float g0 = farN + clamp(-acos(clamp(all1, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        float g1 = farN + clamp( acos(clamp(all0, -1.0, 1.0)) - farN, -HALF_PI, HALF_PI);
        farDelta = max(min(farProj * (Arc(g0, farN, farSinN, farCosN) + Arc(g1, farN, farSinN, farCosN) - farNear), 0.0), -2.0);
#endif
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
    {
        o.ao = float4(1.0, zTrue, zTrue, zTrue);
        return o;
    }
    float open = saturate(visibility / AO_SLICES);
    visibility = pow(saturate(visibility / AO_SLICES + farShare), AO_POWER);   // the output: near and far together
#else
    float open = saturate(visibility / AO_SLICES);
#if AO_FAR
    visibility = pow(saturate(visibilityAll / AO_SLICES), AO_POWER);   // the output: near and far horizons together
#else
    visibility = pow(open, AO_POWER);
#endif
#endif
    visibility = lerp(1.0, visibility, fade);
    o.ao = float4(visibility, z, z, z);
#if GI_PROBE == 1
    o.gi = float4(1.0 - open, hidden, brightest, radiusPx);
    return o;
#endif

    // The bounce light: the share of the sky the AO found hidden (1 - open, before its power) times the light of what
    // hides it (the arc-weighted mean of the steps' light). The slices' own sums only estimate that share (for a
    // tilted normal each slice's full arc differs from 1), so the mean light is taken from them and the share from the
    // AO, which keeps the two consistent: the sky the AO takes away is exactly the sky the bounce light replaces.
#if GI_PROBE == 2
    o.gi = float4(hidden > 1e-5 ? bounce / hidden : 0.0, hidden);
    return o;
#endif
    bounce = hidden > 1e-5 ? bounce / hidden * ((1.0 - open) * fade) : 0.0;
    // The apply pass darkens the finished pixel by a = (1 - AO) x g_txFactor.x x g_vSSAOColor.w (its 3x3 blur aside):
    // the bounce light is stored undone by that, but never above GI_CAP x the brightest light gathered (the bounce
    // itself is at most the hidden share x that light)
#if GI_UNDO_AO
    float darkening = 1.0 - saturate((1.0 - visibility) * factorRaw * g_vSSAOColor.w);
    float3 stored = bounce * GI_SUM_STRENGTH / max(darkening, 0.05);
    float peak = max(stored.r, max(stored.g, stored.b));
    stored *= min(1.0, GI_CAP * brightest / max(peak, 1e-6));
#if GI_PROBE == 3
    o.gi = float4(bounce, darkening);
    return o;
#endif
#else
    float3 stored = bounce * GI_SUM_STRENGTH;
#endif
    o.gi = float4(stored, 1.0);
    return o;
}
