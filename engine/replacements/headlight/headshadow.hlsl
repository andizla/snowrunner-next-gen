// Headlight shadows for SnowRunner, spliced into the game's lit shaders. The game lights a pixel with its truck's
// headlight (g_vHeadLightPos[0], with a projected light pattern, g_txHeadLightMap, through g_tmHeadLightViewProj) but
// nothing between the lamp and the pixel blocks that light. This helper says how much of it arrives: it walks from the
// pixel towards the lamp through the scene's depth and finds what stands in the way. The splice
// (tools\patch_headshadow.js) multiplies the light pattern's sample by it.
//
// Technique: a ray from the surface to each of two lamps HS_SPREAD metres apart across the truck (each lamp's light is
// tested on its own and the two are averaged), stepped evenly across the screen so thin casters
// are not stepped over, each step's depth compared with the scene's linear depth there. A step behind what the camera
// sees, by more than a bias and less than a thickness, is blocked; the comparison is soft over HS_SOFT metres, and the
// steps start at a per-pixel offset (interleaved gradient noise, Jimenez 2014) that the game's temporal anti-aliasing
// smooths. Screen-space: only what the camera sees can cast. Written for this project.
//
// Contract with the splice: v0.xyz = the pixel's world position (the point the shader measures from the headlight);
// o0.x = the share of the headlight that arrives, 0 to 1. Registers are the lit shaders' own: b1 CB_GLOBAL_CAMERA (c0 eye
// position, c2..c5 view-projection columns, c10..c13 the previous frame's; the splice widens the shader's declaration to
// 14), b2 CB_GLOBAL_SCENE (g_vHeadLightPos[0] at c24, g_vHeadLightDir[0] at c20), and t121: SnowRunner Shadows' copy of
// the previous frame's linear depth (metres), taken at the ambient occlusion pass, which comes after the lit pass. The
// rays are projected with the previous frame's camera, so each step meets the depth that camera saw there: projected
// with this frame's, a camera that moved (shaking on a rough road) compared the steps with whatever the last frame had
// at that spot on the screen, and the road ahead went dark until the camera settled (seen in the game, 2026-10-23).
// Without the DLL t121 is unbound: every pixel gets 1, the game's own light.
//
// Build: fxc -T ps_5_0 -E main headshadow.hlsl -Fo headshadow.cso. Every knob can be set with -D NAME=value.

#ifndef HS_STEPS
#define HS_STEPS 24           // steps along each ray, at least
#endif
#ifndef HS_STEPS_MAX
#define HS_STEPS_MAX 64       // and at most, one step per HS_PX pixels of the ray on the screen in between
#endif
#ifndef HS_PX
#define HS_PX 6.0
#endif
#ifndef HS_SPREAD
#define HS_SPREAD 1.4         // metres between the two lamps of the pair (0: one lamp in the middle)
#endif
#ifndef HS_NEAR
#define HS_NEAR 2.5           // metres short of the lamp where a ray stops: the truck's own body is there, and the game
#endif                        // fades its headlight out within 3 to 6 m of the lamp anyway
#ifndef HS_START
#define HS_START 0.12         // metres off the surface where a ray starts
#endif
#ifndef HS_BIAS
#define HS_BIAS 0.04          // metres, plus HS_BIAS_SLOPE times the distance from the camera: how far in front of a step
#endif                        // the scene must be to block it (depth is one value per pixel)
#ifndef HS_BIAS_SLOPE
#define HS_BIAS_SLOPE 0.006
#endif
#ifndef HS_THICK
#define HS_THICK 1.5          // metres a caster is taken to be thick (plus 3 % of the distance): deeper behind it the ray
#endif                        // went behind the caster, not through it
#ifndef HS_SOFT
#define HS_SOFT 0.15          // metres over which a step goes from lit to blocked
#endif
#ifndef HS_EDGE
#define HS_EDGE 0.03          // fraction of the screen over which blocking fades out towards the border
#endif
#ifndef HS_PLANE
#define HS_PLANE 0.3          // metres in front of the lamps' plane an obstacle must stand to block: whatever is behind a
#endif                        // lamp (the truck's own cab, bed, roof rack) cannot be between the lamp and a lit point
#ifndef HS_BODY
#define HS_BODY HS_NEAR       // metres around a lamp within which what the camera sees is the truck's own front and does
#endif                        // not block (0: it does)
#ifndef HS_DEBUG
#define HS_DEBUG 0            // 1: no shadows; the beam shows how the pixel's position agrees with the depth (a test build)
#endif
#ifndef HS_LIFT
#define HS_LIFT 0.1           // metres above the surface (straight up) where a ray starts: lumps lower than that do not block
#endif
#ifndef HS_ROWS
#define HS_ROWS 0             // pixel rows above and below a step whose farther depth counts (0: the step's own pixel only)
#endif
#ifndef HS_STRENGTH
#define HS_STRENGTH 1.0       // 1 = a fully blocked lamp gives no light; less leaves some
#endif
#ifndef HS_SNAP
#define HS_SNAP 3.0           // metres, plus HS_SNAP_SLOPE times the distance: a pixel up to this far off the depth the
#endif                        // camera saw where it lies starts its walk on that surface; 0 = never. At a grazing view
#ifndef HS_SNAP_SLOPE         // 15 cm under a surface is about a metre behind it along the view
#define HS_SNAP_SLOPE 0.25
#endif
#ifndef HS_PIXEL
#define HS_PIXEL 1            // 1: the walk starts where the pixel's own camera ray meets the depth (the splice hands the
#endif                        // helper the pixel's screen position); 0: from the position the shader was given, as before
#ifndef HS_PIXEL_AGREE
#define HS_PIXEL_AGREE 0.15   // metres, plus 2 % of the distance: how far the last frame's depth may stay from the point
#endif                        // after its reprojection before the pixel counts as one the last frame did not see

cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float3 g_vEyePos;
    float  g_fZDir;
    float4 g_vViewDir;
    float4 g_vViewProjCol[4]; // c2..c5: clip = (dot(p, col0), dot(p, col1), dot(p, col2), dot(p, col3))
    float4 g_vViewCol[4];     // c6..c9
    float4 g_vViewProjPrevCol[4]; // c10..c13: the previous frame's, the camera t121 was seen from
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_vSceneHead[20];  // c0..c19: what comes before the headlight's direction
    float4 g_vHeadLightDir[4];
    float4 g_vHeadLightPos[4];
};
Texture2D<float> g_txSceneZ : register(t121);

float4 Clip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjCol[0]), dot(q, g_vViewProjCol[1]), dot(q, g_vViewProjCol[2]), dot(q, g_vViewProjCol[3]));
}
float4 PrevClip(float3 p)
{
    const float4 q = float4(p, 1.0);
    return float4(dot(q, g_vViewProjPrevCol[0]), dot(q, g_vViewProjPrevCol[1]), dot(q, g_vViewProjPrevCol[2]), dot(q, g_vViewProjPrevCol[3]));
}
// the point on this frame's camera ray through screen position s (-1..1, y up) whose distance from the camera is z:
// x / w and y / w fixed by s, w = z; the rows a, b, c of that system, solved with its inverse's columns (b x c, c x a,
// a x b over the determinant)
float3 OnRay(float2 s, float z)
{
    const float4 m0 = g_vViewProjCol[0], m1 = g_vViewProjCol[1], m3 = g_vViewProjCol[3];
    const float3 a = m0.xyz - s.x * m3.xyz, b = m1.xyz - s.y * m3.xyz, c = m3.xyz;
    const float3 r = float3(-(m0.w - s.x * m3.w), -(m1.w - s.y * m3.w), z - m3.w);
    return (cross(b, c) * r.x + cross(c, a) * r.y + cross(a, b) * r.z) / dot(a, cross(b, c));
}

// one lamp: 1 = its light arrives, 0 = blocked (one exit: the splice inlines the helper, which cannot return early);
// lampDir: the way the lamp points
float Lamp(float3 P, float3 L, float3 lampDir, float2 size, float jitter)
{
    const float3 toL = L - P;
    const float d = max(length(toL), 1e-3);
    const float span = d - HS_NEAR - HS_START;
    const float3 dir = toL / d;
    // the walk starts HS_LIFT above the surface: snow's surface is rough by a few centimetres, and a ray leaving it at
    // the flat angle of a low headlight ran that close above it for the first metre, where any lump blocked it, at a
    // different point for each pixel's offset: a fine grain over the whole lit snow (seen in the game, 2026-10-26)
    const float3 w0 = P + float3(0.0, HS_LIFT, 0.0) + dir * HS_START;
    float3 w1 = P + dir * (HS_START + max(span, 0.0));
    const float4 c0 = PrevClip(w0), c1 = PrevClip(w1);       // the previous frame's camera, as t121 is that frame's
    // a ray end behind the camera: shortened to where it is still in front of it (the same share of the way in the world)
    float4 e1 = c1;
    if (e1.w <= 0.05) { const float cut = (c0.w - 0.05) / max(c0.w - c1.w, 1e-4); e1 = lerp(c0, c1, cut); w1 = lerp(w0, w1, cut); }
    // screen positions and 1 / w of both ends: evenly in screen space, depth interpolated as 1 / w
    const float cw = max(c0.w, 0.05), ew = max(e1.w, 0.05);
    const float2 s0 = c0.xy / cw, s1 = e1.xy / ew;
    const float iw0 = 1.0 / cw, iw1 = 1.0 / ew;
    // no ray: the pixel is within the lamp's reach of the truck, or behind the camera
    // one step per HS_PX pixels of the ray on the screen, HS_STEPS to HS_STEPS_MAX: a long ray in 24 steps jumped over a
    // caster a few pixels thin (a fence's rail), whose shadow came out as a comb of bars, the worse the wider the field
    // of view (seen in the game, 2026-10-27)
    const float pxLen = length((s1 - s0) * 0.5 * size);
    const int steps = (span > 0.0 && c0.w > 0.05) ? (int)clamp(ceil(pxLen / HS_PX), HS_STEPS, HS_STEPS_MAX) : 0;
    float blocked = 0.0;
    [loop] for (int i = 0; i < steps; i++)
    {
        const float f = (i + jitter) / steps;
        const float2 s = lerp(s0, s1, f);
        const float2 uv = float2(s.x * 0.5 + 0.5, 0.5 - s.y * 0.5);
        if (any(uv < 0.0) || any(uv > 1.0)) break;          // off the screen: nothing known further on
        const float w = 1.0 / lerp(iw0, iw1, f);            // the step's distance from the camera
        const int2 px = int2(uv * size);
        float z = g_txSceneZ.Load(int3(px, 0));
        const float bias = HS_BIAS + HS_BIAS_SLOPE * w;
        // the ground seen at a grazing angle is one depth per pixel row, in steps that grow with the distance; a ray
        // running close above it met the near side of a step and took the ground itself for a caster, in stripes that
        // followed the steps' per-pixel offset (on lit snow, seen in the game, 2026-10-26). Where a step seems blocked,
        // the farther of the depths one row up and down counts: the ground's own steps no longer block, an upright
        // caster still does (read only there: most steps are not blocked)
        if (HS_ROWS > 0 && w - z - bias > 0.0) z = max(z, max(g_txSceneZ.Load(int3(px + int2(0, HS_ROWS), 0)), g_txSceneZ.Load(int3(px - int2(0, HS_ROWS), 0))));
        const float inFront = w - z - bias;                 // > 0: the scene is in front of the step there
        const float thick = HS_THICK + 0.03 * w;
        const float2 edge = saturate(min(uv, 1.0 - uv) / HS_EDGE);
        // where the obstacle is in the world: on the camera's line through the step, at the scene's depth there (the step
        // itself by its 1 / w share of the way); behind the lamps' plane it cannot block. From this frame's eye: the
        // previous one is a frame's movement away, which moves O by that times (1 - z / w), a few centimetres
        const float3 S = lerp(w0 * iw0, w1 * iw1, f) * w;
        const float3 O = g_vEyePos + (S - g_vEyePos) * (z / w);
        const float ahead = dot(O - L, lampDir) > HS_PLANE ? 1.0 : 0.0;
        // within HS_BODY of the lamp stands the truck's own front (a bumper, a winch, a bull bar). The ray stops short of
        // it, yet a step further out that the camera saw behind it took it for an obstacle: from a low view beside the
        // bumper every ray passing behind it was blocked, a hard-edged dark quad on the road (seen in the game, 2026-10-24)
        const float own = dot(O - L, O - L) < HS_BODY * HS_BODY ? 0.0 : 1.0;
        const float b = saturate(inFront / HS_SOFT) * (inFront < thick ? 1.0 : 0.0) * ahead * own * edge.x * edge.y;
        blocked = max(blocked, b);
        if (blocked >= 0.999) break;
    }
    return 1.0 - blocked * HS_STRENGTH;
}

float4 main(float4 posIn : TEXCOORD0, float4 screen : SV_Position) : SV_Target0
{
    uint w, h;
    g_txSceneZ.GetDimensions(w, h);
    float3 P = posIn.xyz;
    const float3 L = g_vHeadLightPos[0].xyz;
    const float2 size = float2(w, h);
    // the pixel's own point: where its camera ray meets the depth. The position the shader is given does not always lie
    // on the surface the camera saw there (the terrain's: metres off on a snow bank, and on lit snow a little off at
    // every pixel, so the first steps of each walk met the depth's own steps: a grain and stripes over the snow, worse
    // without TAA; seen in the game, 2026-10-27). The depth (t121) is the last frame's: read at the pixel itself (exact
    // with the camera still), then twice where that point was in the last frame, the point moved along the ray by the
    // difference. A point the last frame did not see (the depth stays off) keeps the game's own light for that frame.
    // screen.x < 0: the splice found no screen position in the shader (24 of 5,569), so the old way below
    bool onPixel = false;
    float agree = 0.0;   // HS_DEBUG 1: 1 within 10 cm of the depth, 0.5 within the snap's reach, 0.25 beyond it, 0 off the screen
    if (HS_PIXEL && w != 0 && screen.x >= 0.0)
    {
        const float2 s = float2(screen.x / size.x * 2.0 - 1.0, 1.0 - screen.y / size.y * 2.0);
        float z = g_txSceneZ.Load(int3(screen.xy, 0));
        float off = 1e9;
        if (z > 0.05)
        {
            [unroll] for (int k = 0; k < 2; k++)
            {
                const float4 pc = PrevClip(OnRay(s, z));
                const float2 suv = float2(pc.x / max(pc.w, 0.05) * 0.5 + 0.5, 0.5 - pc.y / max(pc.w, 0.05) * 0.5);
                const float zs = pc.w > 0.05 && all(suv >= 0.0) && all(suv < 1.0) ? g_txSceneZ.Load(int3(suv * size, 0)) : 0.0;
                off = zs > 0.05 ? zs - pc.w : 1e9;
                if (zs > 0.05) z += off;
            }
            onPixel = true;
            P = OnRay(s, z);
            agree = abs(off) < 0.1 ? 1.0 : abs(off) < HS_PIXEL_AGREE + 0.02 * z ? 0.5 : 0.25;
        }
    }
    // a pixel shaded below the surface the camera saw there starts on that surface: a road overlay or decal over the
    // ground, parallax-mapped asphalt or a depth bias leave the point the shader lights a few centimetres under the depth,
    // and seen at a grazing angle those centimetres put the first steps tens of centimetres behind the road itself, which
    // then blocks them all (a hard-edged dark patch the size of the overlay, gone from a steep view; seen in the game,
    // 2026-10-23). A pixel shaded in front of that surface does the same: an overlay's or a decal's own geometry stands
    // above the ground the camera saw through it, and a whole stretch of road or snow in the beam went dark with straight
    // edges (seen in the game, 2026-10-27). A shaded pixel is a visible one, so the surface the camera saw there is
    // where it lies: moved along this frame's camera ray to the depth there, as O below, from either side; a pixel
    // further off (an edge, or something the last frame did not see) stays where it is
    if (!onPixel && w != 0 && HS_SNAP > 0.0)
    {
        const float4 pc = PrevClip(P);
        const float2 suv = float2(pc.x / max(pc.w, 0.05) * 0.5 + 0.5, 0.5 - pc.y / max(pc.w, 0.05) * 0.5);
        if (pc.w > 0.05 && all(suv >= 0.0) && all(suv < 1.0))
        {
            const float zs = g_txSceneZ.Load(int3(suv * size, 0));
            const float off = pc.w - zs;
            if (zs > 0.05 && abs(off) < HS_SNAP + HS_SNAP_SLOPE * pc.w) { P = g_vEyePos + (P - g_vEyePos) * (zs / pc.w); agree = abs(off) < 0.1 ? 1.0 : 0.5; }
            // further off than that, with the depth there: the position the shader was given is not where the pixel lies
            // (on a snow bank it was metres off in every direction, so no walk along its own camera line found the
            // surface, and the whole bank went dark with straight edges; seen in the game, 2026-10-27). Its walk would
            // start from the wrong place: the game's own light, unshadowed
            else if (zs > 0.05) agree = 0.25;
        }
    }
    const float3 hd = g_vHeadLightDir[0].xyz, lampDir = dot(hd, hd) > 1e-6 ? normalize(hd) : float3(0.0, 0.0, 1.0);
    // the pixel's place on the screen, for the per-pixel offset of the steps
    const float4 cp = Clip(P);
    const float2 pix = onPixel ? screen.xy : (float2(cp.x / cp.w * 0.5 + 0.5, 0.5 - cp.y / cp.w * 0.5)) * size;
    const float jitter = frac(52.9829189 * frac(dot(pix, float2(0.06711056, 0.00583715))));
    float v = 1.0;                                            // no depth from the DLL: the game's own light
    if (w == 0 || agree == 0.25) v = 1.0;                   // (one exit: the splice inlines this, no early return)
    else if (HS_SPREAD > 0.0)
    {
        // the pair across the truck: sideways from the headlight's direction, level
        float3 side = cross(g_vHeadLightDir[0].xyz, float3(0.0, 1.0, 0.0));
        side = dot(side, side) > 1e-6 ? normalize(side) * (0.5 * HS_SPREAD) : float3(0.0, 0.0, 0.0);
        v = 0.5 * (Lamp(P, L - side, lampDir, size, jitter) + Lamp(P, L + side, lampDir, size, frac(jitter + 0.5)));
    }
    else v = Lamp(P, L, lampDir, size, jitter);
    if (HS_DEBUG == 1) v = agree;
    return float4(v, v, v, 1.0);
}
