// SnowRunner tonemap pass, reconstructed from shader 0x221304E2 (ps_5_0): the pass the game draws in normal play
// (confirmed by a runtime dump). Scene plus bloom, exposure, Hable filmic curve with the daytime
// xml constants, white-point scale, sRGB encode. The daytime LUT, sharpening, bokeh and vignette follow in the
// presentation composite (0x30CE8617 and siblings). Bindings match the original for hash-based replacement.
//
// Every knob below can also be set on the fxc command line (-D NAME=value). With the defaults the file compiles to
// the instruction stream of the original shader.

#ifndef VERIFY_SWAP
#define VERIFY_SWAP 0        // 1 = inverted colours to prove the replacement is live
#endif

// CURVE: 0 = stock Hable driven by the daytime xml
//        1 = neutral Hable constants, white point 11.2
//        2 = ACES fit
//        3 = RoadCraft filmic: the same Hable operator with the constants RoadCraft ships (see RC_PRESET)
#ifndef CURVE
#define CURVE 0
#endif

// RC_PRESET (CURVE 3): 0 = pA 0.5, white point 1 (21 of RoadCraft's 26 map and weather presets)
//                      1 = pA 0.3, white point 2 (4 presets, softer shoulder)
//                      2 = engine default, pA 0.12, white point 10 (close to stock contrast, long highlight range)
// pB to pF are the engine defaults of RoadCraft's HDR parameter block: no map overrides them.
#ifndef RC_PRESET
#define RC_PRESET 0
#endif

// MATCH_GREY: 1 = a replacement curve is exposure matched to the game's own curve, so the scene value the daytime
// xml sends to display mid grey still lands there. Each daytime keeps its authored brightness and only the contrast,
// toe and shoulder change. 0 = feed the replacement curve the game's exposure unchanged.
#ifndef MATCH_GREY
#define MATCH_GREY 1
#endif
#define DISPLAY_GREY 0.18

#ifndef USE_EXPOSURE_BIAS
#define USE_EXPOSURE_BIAS 0
#endif
#ifndef EXPOSURE_STOPS
#define EXPOSURE_STOPS 0.0   // photographic stops, applied to the exposed scene ahead of grade and curve
#endif

// USE_GRADE: scene-linear grade ahead of the curve: saturation, log contrast about mid grey, gamma, gain and lift,
// once globally and once per tonal zone (the grading model RoadCraft and Unreal use). The scene is normalised so
// that 0.18 is the value the game sends to display mid grey, which makes the zone limits independent of the daytime.
// GRADE_PRESET: 0 = neutral (edit the tables below), 1 = film: chroma eases off in deep shadows and highlights,
//               2 = exaggerated on purpose (contrast 1.35, saturation 0.65): shows what the pass touches, not a look.
#ifndef USE_GRADE
#define USE_GRADE 0
#endif
#ifndef GRADE_PRESET
#define GRADE_PRESET 0
#endif
#define GRADE_SHADOWS_MAX    0.09
#define GRADE_HIGHLIGHTS_MIN 0.50
#define GRADE_HIGHLIGHTS_MAX 1.00

#ifndef USE_SATURATION
#define USE_SATURATION 0     // display-referred saturation after the curve
#endif
#ifndef SATURATION
#define SATURATION 1.0
#endif
#ifndef USE_CONTRAST
#define USE_CONTRAST 0       // display-referred contrast about 0.5 after the sRGB encode
#endif
#ifndef CONTRAST
#define CONTRAST 1.0
#endif

// USE_DITHER: one code value of triangular noise on the encoded output, hides banding in fog and sky gradients.
// Meant for an 8 bit target; leave off when the pass writes a wider format.
#ifndef USE_DITHER
#define USE_DITHER 0
#endif
#ifndef DITHER_LEVELS
#define DITHER_LEVELS 255.0
#endif
#ifndef BLOOM_SCALE
#define BLOOM_SCALE 1.0      // weight of the bloom texture in the composite; the knee pass decides what blooms at all
#endif

cbuffer CB_COMMON_DYN : register(b9)
{
    float4 COMMON_M_VIEW_PROJ[4];
    float4 COMMON_V_BB_SIZE_INV;
    float4 PS_REG_REFLECTIONS_MATRVIEW_PREV[3];
    float4 REG_COMMON_MB_PARAMS;
    float4 PS_REG_REFLECTIONS_JITTER_PARAMS;
    float4 PS_REG_COMMON_HDR_PARAMS[2];  // [0].x = exposure, [0].z = white scale (1 / curve(W))
};
cbuffer CB_PASS_HDR : register(b4)
{
    float4 PS_REG_HDR_TEX;
    float4 PS_REG_HDR_PARAMS;
    float4 PS_REG_HDR_THRESHOLD_OFFSET;
    float4 PS_REG_HDR_DOF_PARAMS;
    float4 PS_REG_HDR_EXP_PARAMS;
    float4 PS_REG_HDR_TONEMAP_PARAMS[2]; // [0] = A B C D, [1].xy = E F
    int4   PS_REG_HDR_HISTOGRAM;
    int4   CS_REG_HDR_GROUP_NUM;
    float4 PS_REG_HDR_GRADING_PARAMS[2];
};
SamplerState      samp     : register(s4);
Texture2D<float4> sceneTex : register(t0); // PS_HDR_TEX1, HDR scene colour
Texture2D<float4> bloomTex : register(t1); // PS_HDR_TEX2

float3 Hable(float3 x, float4 abcd, float2 ef)
{
    float A = abcd.x, B = abcd.y, C = abcd.z, D = abcd.w, E = ef.x, F = ef.y;
    return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
float3 AcesFit(float3 x) { return saturate((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)); }
float3 LinearToSrgb(float3 c) { return c < 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }

// Scene value that a Hable curve with white scale ws sends to display value y: the positive root of
// y / ws + E/F = (x (A x + C B) + D E) / (x (A x + B) + D F).
float HableInverse(float y, float4 abcd, float2 ef, float ws)
{
    float A = abcd.x, B = abcd.y, C = abcd.z, D = abcd.w, E = ef.x, F = ef.y;
    float t  = y / ws + E / F;
    float qa = A * (1.0 - t);
    float qb = B * (C - t);
    float qc = D * (E - t * F);
    return (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, 0.0))) / max(2.0 * qa, 1e-6);
}

#if CURVE == 1
static const float4 NEW_ABCD  = float4(0.22, 0.30, 0.10, 0.20);
static const float2 NEW_EF    = float2(0.01, 0.30);
static const float  NEW_WHITE = 11.2;
#elif CURVE == 3
  #if RC_PRESET == 1
static const float4 NEW_ABCD  = float4(0.30, 0.05, 0.45, 0.20);
static const float  NEW_WHITE = 2.0;
  #elif RC_PRESET == 2
static const float4 NEW_ABCD  = float4(0.12, 0.05, 0.45, 0.20);
static const float  NEW_WHITE = 10.0;
  #else
static const float4 NEW_ABCD  = float4(0.50, 0.05, 0.45, 0.20);
static const float  NEW_WHITE = 1.0;
  #endif
static const float2 NEW_EF    = float2(0.02, 0.08);
#endif
// Scene value the ACES fit sends to display 0.18
static const float ACES_GREY_IN = 0.13017;

#if USE_GRADE
struct GradeZone { float4 saturation, contrast, gamma, gain, lift; }; // rgb = per channel, a = master
  #if GRADE_PRESET == 1
static const GradeZone GRADE_GLOBAL     = { float4(1, 1, 1, 0.94), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_SHADOWS    = { float4(1, 1, 1, 0.85), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_MIDTONES   = { float4(1, 1, 1, 1.00), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_HIGHLIGHTS = { float4(1, 1, 1, 0.80), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
  #elif GRADE_PRESET == 2
static const GradeZone GRADE_GLOBAL     = { float4(1, 1, 1, 0.65), float4(1, 1, 1, 1.35), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_SHADOWS    = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_MIDTONES   = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_HIGHLIGHTS = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
  #else
static const GradeZone GRADE_GLOBAL     = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_SHADOWS    = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_MIDTONES   = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
static const GradeZone GRADE_HIGHLIGHTS = { float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(1, 1, 1, 1), float4(0, 0, 0, 0) };
  #endif

float3 GradeZoneApply(float3 c, float luma, GradeZone g, GradeZone z)
{
    float4 sat = g.saturation * z.saturation, con = g.contrast * z.contrast, gam = g.gamma * z.gamma;
    float4 gain = g.gain * z.gain, lift = g.lift + z.lift;
    c = max(lerp(luma.xxx, c, sat.rgb * sat.a), 0.0);
    c = pow(c / 0.18, con.rgb * con.a) * 0.18;
    c = pow(c, 1.0 / (gam.rgb * gam.a));
    return c * (gain.rgb * gain.a) + (lift.rgb + lift.a);
}
float3 Grade(float3 c)
{
    float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
    float wShadows    = 1.0 - smoothstep(0.0, GRADE_SHADOWS_MAX, luma);
    float wHighlights = smoothstep(GRADE_HIGHLIGHTS_MIN, GRADE_HIGHLIGHTS_MAX, luma);
    float3 graded = GradeZoneApply(c, luma, GRADE_GLOBAL, GRADE_SHADOWS) * wShadows
                  + GradeZoneApply(c, luma, GRADE_GLOBAL, GRADE_HIGHLIGHTS) * wHighlights
                  + GradeZoneApply(c, luma, GRADE_GLOBAL, GRADE_MIDTONES) * (1.0 - wShadows - wHighlights);
    return max(graded, 0.0);
}
#endif

float4 main(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target0
{
    float3 bloom = min(bloomTex.Sample(samp, uv).rgb, 64512.0);
    float3 scene = min(sceneTex.Sample(samp, uv).rgb, 64512.0);
    float3 c = (bloom * BLOOM_SCALE + scene) * PS_REG_COMMON_HDR_PARAMS[0].x;
    float4 abcd = PS_REG_HDR_TONEMAP_PARAMS[0];
    float2 ef   = PS_REG_HDR_TONEMAP_PARAMS[1].xy;
    float  whiteScale = PS_REG_COMMON_HDR_PARAMS[0].z;
#if USE_GRADE || (CURVE != 0 && MATCH_GREY)
    float greyIn = HableInverse(DISPLAY_GREY, abcd, ef, whiteScale);
    // Where the game's own curve cannot place display grey (the title screen: greyIn comes out zero,
    // negative or not a number), anything scaled by 1 / greyIn goes to infinity and saturate() makes it black. Such a
    // scene keeps the game's own exposure and curve, so it looks as it does without this mod. False for NaN too.
    const bool greyOk = greyIn > 1e-4 && greyIn < 1e4;
#endif
#if USE_EXPOSURE_BIAS
    c *= exp2(EXPOSURE_STOPS);
#endif
#if USE_GRADE
    if (greyOk)
        c = Grade(c * (0.18 / greyIn)) * (greyIn / 0.18);
#endif
#if CURVE == 1 || CURVE == 3
  #if MATCH_GREY
    if (greyOk)
  #endif
    {
        abcd = NEW_ABCD; ef = NEW_EF;
        whiteScale = 1.0 / Hable(NEW_WHITE, abcd, ef).x;
  #if MATCH_GREY
        c *= HableInverse(DISPLAY_GREY, abcd, ef, whiteScale) / greyIn;
  #endif
    }
#endif
#if CURVE == 2
  #if MATCH_GREY
    if (!greyOk)
        c = saturate(Hable(c, abcd, ef) * whiteScale);
    else
        c = AcesFit(c * (ACES_GREY_IN / greyIn));
  #else
    c = AcesFit(c);
  #endif
#else
    c = saturate(Hable(c, abcd, ef) * whiteScale);
#endif
#if USE_SATURATION
    float luma = dot(c, float3(0.2126, 0.7152, 0.0722));
    c = max(lerp(luma.xxx, c, SATURATION), 0.0);
#endif
    c = LinearToSrgb(c);
#if USE_CONTRAST
    c = saturate((c - 0.5) * CONTRAST + 0.5);
#endif
#if USE_DITHER
    float n = frac(sin(dot(pos.xy, float2(12.9898, 78.233))) * 43758.5453) * 2.0 - 1.0;
    c += sign(n) * (1.0 - sqrt(1.0 - abs(n))) / DITHER_LEVELS;
#endif
#if VERIFY_SWAP
    c = 1.0 - c;
#endif
    return float4(c, 0.0);
}
