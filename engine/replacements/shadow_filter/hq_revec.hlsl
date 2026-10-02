// Revectorized sun shadow filter, spliced into SnowRunner's high quality shadow path (the 1269 shaders with the 16-tap
// Poisson PCF: trucks, objects, terrain) by tools/shadow_filter_patch.js, in place of the stock filter as hq_grid is.
// The engine's cascade choice, blocker search and penumbra estimate stay as they are and arrive here as the kernel.
// Why: at Factor 1-2 one shadow texel covers 2-16 screen pixels near the camera and the engine's contact penumbra is about
// half a texel, so any filter narrow enough to keep contact shadows crisp shows the texel staircase (hq_grid_crisp too).
// This filter rebuilds the straight edge inside the texels instead (revectorization, after Macedo and Apolinario,
// "Revectorization-Based Shadow Mapping", GI 2016, and Bondarev, "Shadow map silhouette revectorization", I3D 2014; the
// code is ours, written from the papers):
//  1. four GatherCmp read the depth tests of the 4 x 4 texels around the fragment; all equal: done (most pixels).
//  2. the edge's main direction from those tests (more changes between rows than between columns: a mostly horizontal
//     edge; the rest works in that frame), then the change nearest the fragment in its own column: rows R and R + 1.
//  3. the edge followed both ways (two columns per GatherCmp, at most REVEC_MAX texels, inside this cascade): where rows
//     R and R + 1 stop differing the same way, the texel beyond tells whether the edge stepped one row up or down (a
//     step: the edge crosses the step's middle there, so it joins the line fit and the follow goes on in the new rows)
//     or stopped (a corner, or a pattern that is neither: the follow ends, as it does where the edge turns back).
//  4. the edge as a line: the least-squares line through the steps' middles, weighted by their distance from the
//     fragment (REVEC_SIGMA; one or two steps alone set the slope poorly where runs are 1-2 texels long); a single
//     step fades back to the run within REVEC_MAX texels (L, as morphological antialiasing places it); when the first
//     steps both ways go the same way (U: a bump, the top of a round shape) the line bends in the middle of the
//     fragment's run; flat, halfway between the rows, where no step is in reach.
//  5. the lit fraction = the tent's profile across that line, with hq_grid_crisp's tent half width: a straight edge as
//     soft as the engine asked for, without the texel steps.
// Wide penumbrae (tent half width H_PCF texels and more) take hq_grid_crisp's tent over the texels: their steps are
// blurred already, and a 4 x 4 look cannot see an edge that far. From H_PCF / 2 the two are blended. Texture-like texel
// patterns (leaves, grass: more than REVEC_NOISE changes in the 4 x 4) take the tent as well; a fragment whose column
// and row show no change is a texel or more from the edge and keeps its own texel's test.
// REVEC_WIDE 1: the rebuilt edge serves wide penumbrae too, up to a tent half width of H_WIDE
// texels (the tent's steps on long runs stay visible well past H_PCF). There each fragment takes one or the other, no
// blend: the rebuilt edge where the 4 x 4 holds it, the edge goes on straight for the tent's half width both ways
// along it and two taps that far across it find plain light and plain shadow (no second edge in the tent's reach); the
// tent everywhere else (no edge in the 4 x 4, a corner, another edge near). REVEC_WIDE 0 builds the filter without it.
// Contract with the splice (as hq_grid): v0.xy = atlas uv, v0.z = receiver depth, v1.xy = engine kernel (cascade uv
// units), v1.zw = the cascade's atlas scale; output o0.x = lit fraction. t81 and s15 are g_txShadowmap and its comparison
// sampler, so the copied instructions address them as they are. One exit (the splice copies the code inline) and no
// arrays (no immediate or indexable constants for the splice to carry).
// REVEC_CURVE 1: before the rules of step 4, a parabola through three or more steps (weighted
// least squares) where it fits within REVEC_FIT, at most REVEC_CURVE_GAIN of the line's misfit, and bends by at least
// REVEC_CURVE_SAG texels over the steps' spread (a straight edge's steps scatter by up to half a texel, which a parabola
// through a few of them would chase): round shapes keep their round edge instead of facets. REVEC_CURVE 0 builds the
// filter without it. On test scenes: straight edges unchanged, round shapes 2-7 % closer to the reference, foliage
// the same.
// REVEC_DEBUG 1: o0.y = the path (0 tent only, 0.25 all 16 tests equal, 0.5 noise -> tent, 0.625 no change in the
// fragment's column or row -> its own texel, 0.75 rebuilt edge, 0.875 rebuilt line rejected -> tent), o0.z = the line's
// rule (0 flat, 0.25 L, 0.5 Z, 0.625 parabola, 0.75 fitted, 1 U), o0.w = the line's offset from the run's middle + 0.5.
// The splice uses o0.x only.
#ifndef SPREAD
#define SPREAD 0.8        // tent half width in engine kernel units: hq_grid_crisp's
#endif
#ifndef REVEC
#define REVEC 1           // 0 = hq_grid_crisp's filter, instruction for instruction (the proof build)
#endif
#ifndef H_PCF
#define H_PCF 1.25        // tent half width (texels) from which the tent over the texels filters alone
#endif
#ifndef H_MIN
#define H_MIN 0.0         // the smallest half width of the ramp across a rebuilt edge (texels)
#endif
#ifndef REVEC_MAX
#define REVEC_MAX 8       // how far the walk follows an edge, texels each way
#endif
#ifndef REVEC_STEPS
#define REVEC_STEPS 4     // at most this many steps each way join the line fit
#endif
#ifndef REVEC_SIGMA
#define REVEC_SIGMA 4.0   // the fit weighs a step by exp(-d^2 / 2 sigma^2), d = its distance from the fragment in texels
#endif
#ifndef REVEC_TRUST
#define REVEC_TRUST 0.6   // a texel centre this far across the rebuilt line (texels) must have that side's test ...
#endif
#ifndef REVEC_BAND
#define REVEC_BAND 1.5    // ... up to this far (beyond, another edge may begin)
#endif
#ifndef REVEC_FIT
#define REVEC_FIT 0.3     // the steps' middles must lie within this RMS (texels) of their fitted line to use it
#endif
#ifndef REVEC_SUPPORT
#define REVEC_SUPPORT 4   // an edge must go on this many columns (both ways together) to be rebuilt
#endif
#ifndef REVEC_OWN
#define REVEC_OWN 0.1     // how far (texels) beyond the fragment column's two differing texels the line may pass
#endif
#ifndef REVEC_RPDB
#define REVEC_RPDB 1      // the follow tests texels at the receiver's plane depth (1) or at the fragment's (0)
#endif
#ifndef REVEC_GMAX
#define REVEC_GMAX 0.01   // the largest receiver depth change per texel the follow takes from the derivatives
#endif
#ifndef REVEC_NOISE
#define REVEC_NOISE 10    // more texel changes than this in the 4 x 4 texels: texture-like detail, the tent
#endif
#ifndef REVEC_WIDE
#define REVEC_WIDE 1      // the rebuilt edge for wide penumbrae too (see above); 0 = narrow penumbrae only
#endif
#ifndef H_WIDE
#define H_WIDE 4.5        // the widest tent half width (texels) the rebuilt edge serves with REVEC_WIDE
#endif
#ifndef REVEC_PLAIN
#define REVEC_PLAIN 0.1   // a tap a half width across the rebuilt edge must be within this of plain light or shadow
#endif
#ifndef REVEC_CURVE
#define REVEC_CURVE 1     // round edges: a parabola through the steps where it fits clearly
#endif                    // better than the line (three steps or more); 0 = lines only
#ifndef REVEC_CURVE_GAIN
#define REVEC_CURVE_GAIN 0.5  // the parabola's weighted squared misfit must be at most this share of the line's
#endif
#ifndef REVEC_CURVE_MAX
#define REVEC_CURVE_MAX 0.25  // the largest bend taken (height per texel squared: a circle of radius 2 texels)
#endif
#ifndef REVEC_CURVE_SAG
#define REVEC_CURVE_SAG 0.3   // the least the bend must add up to over the steps' spread (texels), above their scatter
#endif
#if REVEC_CURVE
#define FIT_Q_PARAM , inout float3 fitQ
#define FIT_Q_ARG , fitQ
#else
#define FIT_Q_PARAM
#define FIT_Q_ARG
#endif
#ifndef REVEC_DEBUG
#define REVEC_DEBUG 0
#endif
Texture2D g_txShadowmap : register(t81);
SamplerComparisonState g_samShadowmapCmp : register(s15);

#if !REVEC
// hq_grid.hlsl's filter at SPREAD 0.8 = hq_grid_crisp, written out the same way so that it compiles to the same code
float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1) : SV_Target
{
    float2 size;
    g_txShadowmap.GetDimensions(size.x, size.y);
    float2 radius = SPREAD * b.xy * b.zw;             // tent half width, atlas uv
    float2 radiusTexels = radius * size;
    float widest = max(radiusTexels.x, radiusTexels.y);
    uint n = (uint)clamp(ceil(widest * (2.0 / 1.5)), 2.0, 8.0);   // taps per axis, at most 1.5 texels apart up to 6 texels
    float step = 2.0 / n;
    float sum = 0, weights = 0;
    [loop] for (uint j = 0; j < n; j++)
    {
        float ty = (j + 0.5) * step - 1.0;
        float wy = 1.0 - abs(ty);
        [loop] for (uint i = 0; i < n; i++)
        {
            float tx = (i + 0.5) * step - 1.0;
            float w = (1.0 - abs(tx)) * wy;
            sum += w * g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, saturate(a.xy + float2(tx, ty) * radius), a.z);
            weights += w;
        }
    }
    return float4(sum / weights, 0, 0, 0);
}
#else
// hq_grid_crisp's tent over the texels: half width radius (atlas uv), 2 to 8 bilinear compare taps per axis
float TentFilter(float2 uv, float z, float2 radius, float2 size)
{
    float2 radiusTexels = radius * size;
    float widest = max(radiusTexels.x, radiusTexels.y);
    uint n = (uint)clamp(ceil(widest * (2.0 / 1.5)), 2.0, 8.0);
    float step = 2.0 / n;
    float sum = 0, weights = 0;
    [loop] for (uint j = 0; j < n; j++)
    {
        float ty = (j + 0.5) * step - 1.0;
        float wy = 1.0 - abs(ty);
        [loop] for (uint i = 0; i < n; i++)
        {
            float tx = (i + 0.5) * step - 1.0;
            float w = (1.0 - abs(tx)) * wy;
            sum += w * g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, saturate(uv + float2(tx, ty) * radius), z);
            weights += w;
        }
    }
    return sum / weights;
}

// the lit fraction a tent of half width h gives at signed distance t (texels, positive on the lit side) from a
// straight edge: the tent's integral up to t
float TentStep(float t, float h)
{
    float u = saturate(0.5 + t / (2.0 * h));
    return u < 0.5 ? 2.0 * u * u : 1.0 - 2.0 * (1.0 - u) * (1.0 - u);
}

// the 4 x 4 bit matrix (bit 4 j + i = row j, column i) transposed
uint Transpose4(uint m)
{
    uint t = (m ^ (m >> 3)) & 0x0A0Au;
    m ^= t ^ (t << 3);
    t = (m ^ (m >> 6)) & 0x00CCu;
    m ^= t ^ (t << 6);
    return m;
}

// the receiver's depth at p (edge frame: p.x along, p.y across; texel-centre coordinates): the fragment's depth zp.x at
// Pf, moved along the receiver's plane (zp.yz = its depth change per texel along and across; 0 with REVEC_RPDB 0)
float DepthAt(float2 p, float2 Pf, float3 zp)
{
    return zp.x + dot(zp.yz, p - Pf);
}

// the depth test of one texel (edge frame, texel-centre coordinates), exactly 0 or 1
float TestAt(float2 p, bool horiz, float2 inv, float2 Pf, float3 zp)
{
    float2 t = horiz ? p : p.yx;
    return round(g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, (t + 0.5) * inv, DepthAt(p, Pf, zp)));
}

// where the edge went at column E, whose texels at rows R and R + 1 are pair instead of AB: -0.5 (one row down: rows
// R - 1 and R now change as AB), +0.5 (one row up: rows R + 1 and R + 2), 0 (it stopped: a corner, or a pattern that is
// neither). Only the texel that can tell is read.
float StepAt(float E, float R, float2 AB, float2 pair, bool horiz, float2 inv, float2 Pf, float3 zp)
{
    bool down = false, up = false;
    if (pair.x == AB.y) down = TestAt(float2(E, R - 1), horiz, inv, Pf, zp) == AB.x;
    if (pair.y == AB.x) up = TestAt(float2(E, R + 2), horiz, inv, Pf, zp) == AB.y;
    return down == up ? 0.0 : down ? -0.5 : 0.5;
}

// follows the edge from the fragment's column X (its change between rows R and R + 1 as AB) in direction dir (+1 / -1)
// through at most kmax columns, two per GatherCmp at the corner they share with the current rows. Each step (the change
// moving one row) adds its middle to the line fit fit (weights by distance from the fragment at Pf.x; x relative to it,
// height relative to R); the follow stops at a corner, where the edge turns back, or after REVEC_STEPS steps. first = the
// first step's height change (0: none), firstX = its position (relative to Pf.x), or where a corner ended the run;
// support = how many columns the edge went on this way (REVEC_MAX when nothing stopped it)
void Follow(float dir, float X, float R, float2 Pf, float3 zp, float2 AB, bool horiz, float2 inv, float kmax,
            inout float4 fit, inout float2 fitXH FIT_Q_PARAM, out float first, out float firstX, out float steps, out float support)
{
    first = 0;
    firstX = dir * (kmax + 1);
    steps = 0;
    support = REVEC_MAX;
    float r = R, k = 1, last = 0, px = Pf.x;
    [loop] for (int it = 0; it < REVEC_MAX; it++)
    {
        if (k > kmax) break;
        float along = X + dir * k + (dir > 0 ? 1.0 : 0.0);          // the corner between the two columns
        float2 c = horiz ? float2(along, r + 1) : float2(r + 1, along);
        float4 g = g_txShadowmap.GatherCmpRed(g_samShadowmapCmp, c * inv, DepthAt(float2(along - 0.5, r + 0.5), Pf, zp));
        float2 lo = horiz ? g.wx : g.wz;                              // rows r, r + 1 at along - 1
        float2 hi = horiz ? g.zy : g.xy;                              // rows r, r + 1 at along
        float2 nearP = dir > 0 ? lo : hi, farP = dir > 0 ? hi : lo;
        bool nearDiff = any(nearP != AB), farDiff = k + 1 <= kmax && any(farP != AB);
        if (!nearDiff && !farDiff)
        {
            k += 2;
            continue;
        }
        float col = X + dir * (nearDiff ? k : k + 1);
        float s = StepAt(col, r, AB, nearDiff ? nearP : farP, horiz, inv, Pf, zp);
        if (s == 0 || (last != 0 && s != last))
        {
            if (last == 0) firstX = col - dir * 0.5 - px;               // a corner ends the fragment's own run
            support = abs(col - X) - 1;
            break;
        }
        // a step: the edge crosses row r + 0.5 + s at the boundary before col
        float ax = col - dir * 0.5 - px, ah = r - R + 0.5 + s;
        float wgt = exp(-ax * ax * (0.5 / (REVEC_SIGMA * REVEC_SIGMA)));
        fit += wgt * float4(1, ax, ah, ax * ax);
        fitXH += wgt * float2(ax * ah, ah * ah);
#if REVEC_CURVE
        fitQ += wgt * float3(ax * ax * ax, ax * ax * ax * ax, ax * ax * ah);   // (the parabola's moments)
#endif
        if (last == 0) { first = s; firstX = ax; }
        last = s;
        steps += 1;
        if (steps >= REVEC_STEPS) break;
        r += 2 * s;
        k = abs(col - X) + 1;
    }
}

float4 main(float4 a : TEXCOORD0, float4 b : TEXCOORD1) : SV_Target
{
    float2 size;
    g_txShadowmap.GetDimensions(size.x, size.y);
    float2 inv = 1.0 / size;
    float2 radius = SPREAD * b.xy * b.zw;                 // tent half width, atlas uv (as hq_grid)
    float h = max(radius.x * size.x, radius.y * size.y);  // the same in texels
    float z = a.z;
    float vis = 1;
#if REVEC_WIDE
    float blend = 0;                                      // (each fragment takes the rebuilt edge or the tent, see the top)
    bool tent = h >= H_WIDE;
#else
    float blend = saturate(h * (2.0 / H_PCF) - 1.0);      // 0 up to H_PCF / 2, 1 (the tent alone) from H_PCF
    bool tent = blend >= 1.0;
#endif
    // the receiver's plane in the shadow map: depth change per texel along u and v, from the screen derivatives of uv
    // and depth (the follow reads texels up to REVEC_MAX away, past what the casters' slope bias covers). Where the
    // derivatives are not one plane's (a triangle's rim, a cascade seam) this is wrong; it only steers the follow, and
    // the 16 tests near the fragment, which judge the result, keep the plain depth
    float2 zGrad = 0;
#if REVEC_RPDB
    {
        float2 ux = ddx(a.xy) * size, uy = ddy(a.xy) * size;
        float zx = ddx(z), zy = ddy(z);
        float det = ux.x * uy.y - ux.y * uy.x;
        if (abs(det) > 1e-6) zGrad = clamp(float2(zx * uy.y - ux.y * zy, ux.x * zy - zx * uy.x) / det, -REVEC_GMAX, REVEC_GMAX);
    }
#endif
    float path = 0, walked = 0, lineOffset = 0;
    if (!tent)
    {
        // 1. the 4 x 4 texels around the fragment, in texel-centre space (texel i's centre at i): four gathers at the
        // corners each 2 x 2 block shares. Gather order: x (left, bottom) y (right, bottom) z (right, top) w (left, top)
        float2 P = a.xy * size - 0.5;
        float2 base = floor(P);
        float4 g00 = g_txShadowmap.GatherCmpRed(g_samShadowmapCmp, base * inv, z);
        float4 g10 = g_txShadowmap.GatherCmpRed(g_samShadowmapCmp, (base + float2(2, 0)) * inv, z);
        float4 g01 = g_txShadowmap.GatherCmpRed(g_samShadowmapCmp, (base + float2(0, 2)) * inv, z);
        float4 g11 = g_txShadowmap.GatherCmpRed(g_samShadowmapCmp, (base + float2(2, 2)) * inv, z);
        // bit 4 j + i: texel (base.x - 1 + i, base.y - 1 + j) is lit
        uint m = (uint)g00.w | (uint)g00.z << 1 | (uint)g10.w << 2 | (uint)g10.z << 3
               | (uint)g00.x << 4 | (uint)g00.y << 5 | (uint)g10.x << 6 | (uint)g10.y << 7
               | (uint)g01.w << 8 | (uint)g01.z << 9 | (uint)g11.w << 10 | (uint)g11.z << 11
               | (uint)g01.x << 12 | (uint)g01.y << 13 | (uint)g11.x << 14 | (uint)g11.y << 15;
        if (m == 0 || m == 0xFFFFu)
        {
            vis = m ? 1.0 : 0.0;
            path = 0.25;
#if REVEC_WIDE
            tent = h > 1.0;                               // a tent wider than a texel reaches past the 4 x 4
#endif
        }
        else
        {
            uint rowChanges = (m ^ (m >> 4)) & 0x0FFFu;   // bit 4 j + i: texels (i, j) and (i, j + 1) differ
            uint colChanges = (m ^ (m >> 1)) & 0x7777u;   // bit 4 j + i: texels (i, j) and (i + 1, j) differ
            uint nRow = countbits(rowChanges), nCol = countbits(colChanges);
            if (nRow + nCol > REVEC_NOISE)
            {
                tent = true;
                path = 0.5;
            }
            else
            {
                // 2. the edge frame: x along the edge's main direction, y across it; when the fragment's column shows no
                // change that way, the other way (a fragment beside a steep stretch, or near a corner)
                bool horiz = nRow < nCol;
                uint w = 0, ci = 0, j = 3u;
                float2 Pw = P, bw = base, f = P - base;
                [unroll] for (int attempt = 0; attempt < 2; attempt++)
                {
                    if (j == 3u)
                    {
                        horiz = !horiz;
                        w = horiz ? m : Transpose4(m);
                        uint across = (w ^ (w >> 4)) & 0x0FFFu;
                        Pw = horiz ? P : P.yx;
                        bw = horiz ? base : base.yx;
                        f = Pw - bw;
                        ci = f.x < 0.5 ? 1u : 2u;                                    // the fragment's column in the 4 x 4
                        uint c0 = (across >> ci) & 1u, c1 = (across >> (4u + ci)) & 1u, c2 = (across >> (8u + ci)) & 1u;
                        j = c1 ? 1u : (c0 && (!c2 || f.y < 0.5)) ? 0u : c2 ? 2u : 3u;  // the change nearest the fragment
                    }
                }
                if (j == 3u)
                {
                    // no change in the fragment's column or row: the edge is a texel or more away, the fragment's own
                    // texel decides (the tent over the texels would carry the staircase's blur this far out)
                    uint ownX = f.x < 0.5 ? 1u : 2u, ownY = f.y < 0.5 ? 1u : 2u;
                    vis = (float)((w >> (4u * ownY + ownX)) & 1u);
                    path = 0.625;
#if REVEC_WIDE
                    tent = h > H_PCF * 0.5;                       // (wider: the tent; better than the old blend here)
#endif
                }
                else
                {
                    // 3. follow the edge both ways, inside this cascade's columns of the atlas (rows: the whole height)
                    float X = bw.x - 1.0 + ci, R = bw.y - 1.0 + j;
                    float2 AB = float2((w >> (4u * j + ci)) & 1u, (w >> (4u * j + 4u + ci)) & 1u);
                    float lo = horiz ? floor(a.x / b.z) * b.z * size.x : 0.0;
                    float hi = horiz ? lo + b.z * size.x - 1.0 : size.y - 1.0;
                    float px = f.x + bw.x;
                    float2 Pf = float2(px, f.y + bw.y);
                    float3 zp = float3(z, horiz ? zGrad : zGrad.yx);
                    float4 fit = 0;
                    float2 fitXH = 0;
#if REVEC_CURVE
                    float3 fitQ = 0;
#endif
                    float firstR, firstL, xR, xL, nR, nL, supR, supL;
                    Follow(1.0, X, R, Pf, zp, AB, horiz, inv, clamp(hi - X, 0.0, REVEC_MAX), fit, fitXH FIT_Q_ARG, firstR, xR, nR, supR);
                    Follow(-1.0, X, R, Pf, zp, AB, horiz, inv, clamp(X - lo, 0.0, REVEC_MAX), fit, fitXH FIT_Q_ARG, firstL, xL, nL, supL);
                    // 4. the line, as a height above row R's change (offset) and a slope at the fragment:
                    //    U: the first steps both ways go the same way (a bump, the top of a round shape): bent in the
                    //       middle of the fragment's run;
                    //    two or more steps whose middles lie on a line (RMS off it at most REVEC_FIT texels): the
                    //       weighted least-squares line through them;
                    //    else the line through the first steps both ways (Z), or from a first step one way back to the
                    //       run's middle row within the walk's reach (L), or flat, halfway between the rows
                    float reach = REVEC_MAX - 0.5;
                    float offset = 0, slope = 0, rule = 0;
                    float W = max(fit.x, 1e-6), mx = fit.y / W, mh = fit.z / W;
                    float sxx = fit.w - W * mx * mx, sxh = fitXH.x - W * mx * mh, shh = fitXH.y - W * mh * mh;
                    bool lineFit = nR + nL >= 2 && sxx > 1e-4 * W;
                    float fitSlope = lineFit ? sxh / sxx : 0.0;
                    lineFit = lineFit && shh - fitSlope * sxh <= REVEC_FIT * REVEC_FIT * W;
#if REVEC_CURVE
                    // round edges first: the weighted least-squares parabola through three or more steps (the normal
                    // equations by Cramer's rule), where its misfit is within REVEC_FIT and at most REVEC_CURVE_GAIN of
                    // the line's; curv = its bend (height change per texel squared) for every use of the line below
                    float curv = 0;
                    bool curveFit = false;
                    if (nR + nL >= 3)
                    {
                        float S0 = fit.x, S1 = fit.y, S2 = fit.w, S3 = fitQ.x, S4 = fitQ.y, T0 = fit.z, T1 = fitXH.x, T2 = fitQ.z;
                        float m00 = S2 * S4 - S3 * S3, m01 = S1 * S4 - S3 * S2, m02 = S1 * S3 - S2 * S2;
                        float det = S0 * m00 - S1 * m01 + S2 * m02;
                        if (det > 1e-6 * S0 * S2 * S4)
                        {
                            float c0 = (T0 * m00 - S1 * (T1 * S4 - S3 * T2) + S2 * (T1 * S3 - S2 * T2)) / det;
                            float c1 = (S0 * (T1 * S4 - S3 * T2) - T0 * m01 + S2 * (S1 * T2 - T1 * S2)) / det;
                            float c2 = (S0 * (S2 * T2 - T1 * S3) - S1 * (S1 * T2 - T1 * S2) + T0 * m02) / det;
                            float misQ = fitXH.y - (c0 * T0 + c1 * T1 + c2 * T2);
                            float misL = sxx > 1e-4 * W ? shh - sxh * sxh / sxx : shh;
                            // (a straight edge's steps scatter by up to half a texel around it, which a parabola through
                            // a few of them fits as well: the bend must add up to REVEC_CURVE_SAG texels over the steps'
                            // weighted spread, sxx / W being its square)
                            curveFit = misQ <= REVEC_FIT * REVEC_FIT * W && misQ <= REVEC_CURVE_GAIN * misL && abs(c2) <= REVEC_CURVE_MAX
                                    && abs(c2) * sxx >= REVEC_CURVE_SAG * W;
                            if (curveFit)
                            {
                                offset = c0 - 0.5;
                                slope = c1;
                                curv = c2;
                                rule = 0.625;
                            }
                        }
                    }
                    if (curveFit) {}
                    else
#endif
                    if (firstR != 0 && firstR == firstL)
                    {
                        float dR = xR, dL = -xL, span = min(reach, 0.5 * (dL + dR));
                        offset = firstR * (saturate(1.0 - dL / span) + saturate(1.0 - dR / span));
                        slope = (dL < span ? -firstL / span : 0.0) + (dR < span ? firstR / span : 0.0);
                        rule = 1.0;
                    }
                    else if (lineFit)
                    {
                        slope = fitSlope;
                        offset = mh - slope * mx - 0.5;
                        rule = 0.75;
                    }
                    else if (firstR != 0 && firstL != 0)
                    {
                        slope = (firstR - firstL) / (xR - xL);
                        offset = firstL - slope * xL;
                        rule = 0.5;
                    }
                    else if (firstR != 0 || firstL != 0)
                    {
                        float d = firstR != 0 ? xR : -xL, s = firstR != 0 ? firstR : firstL;
                        offset = s * saturate(1.0 - d / reach);
                        slope = d < reach ? (firstR != 0 ? s : -s) / reach : 0.0;
                        rule = 0.25;
                    }
                    // 5. the line must agree with the 16 tests near it: every texel centre between REVEC_TRUST and
                    // REVEC_BAND texels across from it has its side's test (one that does not means another edge, a
                    // corner, or leaves, where a single line is the wrong model: the tent over the texels instead).
                    // Farther out, a second edge (the other side of a pole's shadow) is no concern of this fragment's.
                    // An edge that goes on fewer than REVEC_SUPPORT columns both ways together is a leaf's or a grass
                    // blade's, not a line's: the tent as well. And at the fragment's own column the line must pass
                    // between the two texels whose change it stands for (steps of two different edges fit a line that
                    // can lie anywhere, beyond the reach of the 16 tests)
#if REVEC_CURVE
#define BEND(dx) + curv * (dx) * (dx)
#else
#define BEND(dx)
#endif
                    bool agrees = supR + supL >= REVEC_SUPPORT && abs(offset + slope * (X - px) BEND(X - px)) <= 0.5 + REVEC_OWN;
                    [unroll] for (uint q = 0; q < 16; q++)
                    {
                        float2 t = bw - 1.0 + float2(q & 3u, q >> 2);             // texel q: along, across
                        float dv = t.y - (R + 0.5 + offset + slope * (t.x - px) BEND(t.x - px));
                        float test = (float)((w >> q) & 1u);
                        if (abs(dv) <= REVEC_BAND && ((dv > REVEC_TRUST && test != AB.y) || (dv < -REVEC_TRUST && test != AB.x))) agrees = false;
                    }
#if REVEC_WIDE
                    // a tent wider than a texel reaches past the 16 tests: the edge must go on for its half width both
                    // ways along it, and a tap that far out on each side of it must find plain light and plain shadow
                    // (a second edge within the tent's reach, which the single line would miss, fails one of them;
                    // 1.5 texels at least, where a lone straight edge leaves both plain)
                    if (agrees && h > 1.0)
                    {
                        float reachX = min(h, REVEC_MAX);
                        float len = sqrt(1.0 + slope * slope);
                        float2 nrm = float2(-slope, 1.0) / len;                     // across the line, towards row R + 1
                        float2 foot = Pf - nrm * ((f.y + bw.y - (R + 0.5 + offset)) / len); // the fragment's foot on it
                        float d = (AB.y > 0.5 ? 1.0 : -1.0) * max(h, 1.5);
                        float2 pLit = foot + nrm * d, pDark = foot - nrm * d;
                        float2 tLit = horiz ? pLit : pLit.yx, tDark = horiz ? pDark : pDark.yx;
                        float vLit = g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, (tLit + 0.5) * inv, DepthAt(pLit, Pf, zp));
                        float vDark = g_txShadowmap.SampleCmpLevelZero(g_samShadowmapCmp, (tDark + 0.5) * inv, DepthAt(pDark, Pf, zp));
                        agrees = supR >= reachX && supL >= reachX && vLit >= 1.0 - REVEC_PLAIN && vDark <= REVEC_PLAIN;
                    }
#endif
                    if (!agrees)
                    {
                        tent = true;
                        path = 0.875;
                    }
                    else
                    {
                        // 6. the tent's profile across the line; the lit side is row R + 1's when that texel is lit
                        float across0 = f.y + bw.y - (R + 0.5 + offset);
                        float s = (AB.y > 0.5 ? across0 : -across0) * rsqrt(1.0 + slope * slope);
                        vis = TentStep(s, max(h, H_MIN));
                        path = 0.75;
#if REVEC_WIDE
                        // a short edge (a leaf's, a grass blade's) keeps some of the tent, the more the shorter: the old
                        // blend up to a texel's half width, the tent alone past it, both scaled down to nothing for an
                        // edge that goes on REVEC_MAX texels both ways (foliage no worse, straight edges free of the tent)
                        blend = (h <= 1.0 ? saturate(h * (2.0 / H_PCF) - 1.0) : 1.0) * saturate((2.0 * REVEC_MAX - supR - supL) / REVEC_MAX);
#endif
                    }
                    walked = rule;
                    lineOffset = offset + 0.5;
                }
            }
        }
    }
    if (tent || blend > 0.0)
    {
        float t = TentFilter(a.xy, z, radius, size);
        vis = tent ? t : lerp(vis, t, blend);
    }
#if REVEC_DEBUG
    return float4(vis, path, walked, lineOffset);
#else
    return float4(vis, 0, 0, 0);
#endif
}
#endif
