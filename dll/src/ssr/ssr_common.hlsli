// SnowRunner Shadows: screen-space reflections, shared definitions (the pass: Hi-Z build, trace, resolve, motion).
//
// Screen space here: uv (0..1, y down) and iz = 1 / linear depth. Both are affine along the projection of a straight
// world-space ray, so a ray is a straight line in (uv, iz) and the depth pyramid holds iz (its maximum = the nearest
// surface of a cell). The trace's traversal is adapted from AMD FidelityFX SSSR (ffx_sssr.hlsli, Copyright (c) 2021
// Advanced Micro Devices, Inc., MIT licence) and follows Uludag 2014 (Hi-Z screen-space reflections).

cbuffer SSRConstants : register(b0)
{
    float2 g_size;        // render size in pixels
    float2 g_invSize;     // 1 / g_size
    uint2  g_traceSize;   // trace grid (g_size / g_step, rounded up)
    uint   g_step;        // 1: a ray per pixel, 2: one per 2 x 2 block (its pixel changes every frame)
    uint   g_frame;       // frame counter: noise and the block's pixel
    float  g_roughMax;    // perceptual roughness from which no ray is traced (faded out below it)
    float  g_thickness;   // metres a hit may lie behind the surface it lands on (plus 2 % of its depth)
    float  g_temporal;    // history weight
    uint   g_maxSteps;    // traversal iterations per ray
    uint   g_levels;      // levels of the depth pyramid
    uint   g_flags;       // kFlag* below
    float  g_cone;        // blur of the hit colour: mip = log2(1 + travelled pixels x roughness^2 x g_cone)
    float  g_under;       // ini SSRUnder: metres behind a surface (plus 5 % of its depth) within which a ray went under that
                          // object and takes its colour, darkened (ssr_trace.hlsl); 0 = no reflection there, as before
    float  g_underShade;  // ini SSRUnderShade: that colour times this, reached half a metre past the thickness
    float  g_underNear;   // ini SSRUnderNear / SSRUnderFar: in full behind surfaces up to this many metres away, none from
    float  g_underFar;    // the far one on
    float  g_pad0;
};
static const uint kFlagHistory = 1;  // the history texture holds last frame's result
static const uint kFlagMotion = 2;   // t124 of the previous frame is bound (object motion)
static const uint kFlagMirror = 4;   // debug: every pixel a mirror with its normal from the depth buffer (no o7 needed)
static const uint kFlagLobe = 8;     // rays drawn from the GGX lobe (ini SSRLobe=1); without it every ray is the mirror direction
                                     // and roughness only blurs the hit (the look of the per-material march, the default: the
                                     // game's paint is rough enough that a lobe average leaves it faint)

// the game's CB_GLOBAL_CAMERA (b1 while its AO pass draws), 352 bytes; verified on a dump (A_b1)
cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float4 g_vEyePos;       // xyz eye, w g_fZDir
    float4 g_vViewDir;      // xyz forward, w = -dot(forward, eye): dot(float4(P, 1), g_vViewDir) = linear depth
    float4 g_vp[4];         // g_tmViewProj: clip[i] = dot(float4(P, 1), g_vp[i]); g_vp[3] = g_vViewDir (reversed-Z, infinite)
    float4 g_view[4];       // g_tmView: right, up, forward (left-handed view space), translation in w
    float4 g_vpPrev[4];     // g_tmViewProjPrev: last frame's
    float4 g_vWorldClipPlane;
    uint4  g_iCameraIndex;
    float4 g_vShadowClipPlanes[6];
};

static const float kSky = 3000.0;    // linear depth from which a pixel is sky (the far plane is at 3500)

// the world direction through screen point uv, scaled so that its depth component is 1: P = eye + z * ViewRay(uv)
// (solves the projection's x, y and w rows; exact with the jittered projection too)
float3 ViewRay(float2 uv)
{
    const float2 ndc = float2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    const float3 a = g_vp[0].xyz, b = g_vp[1].xyz, c = g_vp[3].xyz;
    const float3 bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
    return (ndc.x * bc + ndc.y * ca + ab) / dot(a, bc);
}
float3 WorldPos(float2 uv, float z) { return g_vEyePos.xyz + z * ViewRay(uv); }

// world point -> uv and linear depth, this frame's or last frame's projection
float3 Project(float3 P, bool prev)
{
    const float4 q = float4(P, 1.0);
    const float4 clip = prev ? float4(dot(q, g_vpPrev[0]), dot(q, g_vpPrev[1]), dot(q, g_vpPrev[2]), dot(q, g_vpPrev[3]))
                             : float4(dot(q, g_vp[0]), dot(q, g_vp[1]), dot(q, g_vp[2]), dot(q, g_vp[3]));
    return float3(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5, clip.w);
}

// The splice's render target 7 (xyz = world normal x 0.5 + 0.5, w = perceptual roughness; written at the specular
// cubemap anchor of the 3229 object material shaders, cleared to up/rough after every pass). false = no ray here (cleared, or
// fully rough). The lit pass's own render target 1 is not used: in game it holds a clear colour by the time the AO pass
// runs ((1, 0, 0, 1) everywhere in a dump), and it was never a normal on vehicles. A pixel an o7 draw
// wrote and a later draw covered keeps a stale value: its ray is wasted, but no reader looks there (the material shaders
// reproject with their own depth check).
bool Rt7(float4 rt7, out float3 n, out float rough)
{
    n = normalize(rt7.xyz * 2.0 - 1.0);
    rough = rt7.w;
    return rt7.w < 0.999;
}

// the geometric normal of a pixel from the depth buffer (per axis the neighbour nearer in depth, so edges stay sharp),
// turned to face the eye: the normal of a hit surface that did not write render target 7, and of every pixel in the
// SSRMirror debug mode
float3 DepthNormal(Texture2D<float> depth, int2 pix, float3 toEye)
{
    const int2 last = int2(g_size) - 1;
    const float z = depth.Load(int3(pix, 0));
    const float zl = depth.Load(int3(max(pix - int2(1, 0), 0), 0)), zr = depth.Load(int3(min(pix + int2(1, 0), last), 0));
    const float zu = depth.Load(int3(max(pix - int2(0, 1), 0), 0)), zd = depth.Load(int3(min(pix + int2(0, 1), last), 0));
    const float2 uv = (float2(pix) + 0.5) * g_invSize;
    const float3 P = WorldPos(uv, z);
    const float3 dx = abs(zr - z) < abs(z - zl) ? WorldPos(uv + float2(g_invSize.x, 0.0), zr) - P : P - WorldPos(uv - float2(g_invSize.x, 0.0), zl);
    const float3 dy = abs(zd - z) < abs(z - zu) ? WorldPos(uv + float2(0.0, g_invSize.y), zd) - P : P - WorldPos(uv - float2(0.0, g_invSize.y), zu);
    const float3 c = cross(dy, dx);
    if (dot(c, c) < 1e-20) return toEye;
    const float3 n = normalize(c);
    return dot(n, toEye) < 0.0 ? -n : n;
}

// Jimenez's interleaved gradient noise, shifted per frame (two decorrelated streams)
float Noise(float2 pixel, uint frame, uint stream)
{
    pixel += float(frame % 64u) * float2(5.588238, 5.588238) + float(stream) * float2(47.0, 17.0);
    return frac(52.9829189 * frac(dot(pixel, float2(0.06711056, 0.00583715))));
}

// the pixel a trace-grid cell stands for this frame (2 x 2: all four in turn)
uint2 CellPixel(uint2 cell, uint frame)
{
    if (g_step == 1u) return cell;
    static const uint2 order[4] = { uint2(0, 0), uint2(1, 1), uint2(1, 0), uint2(0, 1) };
    return min(cell * 2u + order[frame & 3u], uint2(g_size) - 1u);
}
