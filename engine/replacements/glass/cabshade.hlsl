// Cab shade for SnowRunner's window glass, spliced into the game's pane shaders (tools\patch_cabshade.js). The game
// lights the inside of a cab like open ground: nothing shades the seats and the liner from the sky, so at dusk the
// interior stands grey behind the glass (the game's own picture, there with every shader of ours off). A pane is drawn
// over the lit scene with out = pane + scene x (1 - alpha). This helper raises the pane's alpha where what lies behind
// it is the cab (a short way behind the pane, by the scene's depth), so the cab loses a share of its light and the
// pane's own colour (its reflection, dirt and mud) stays as it is.
//
// Only a pane seen from its outer side shades: seen through the cab, the far window's inner side has the ground outside
// close behind it, and two panes in a row would each take their share (seen in the game, 2026-11-23: a dark patch
// where the far window showed through the sunroof).
//
// Contract with the splice: v0 = the pixel's SV_Position (x, y the pixel, w the view depth in metres), v1.x = the alpha
// the shader made, v2.x = SV_IsFrontFace as the rasterizer gives it (all bits set, or 0); o0.x = the alpha to write. t121: SnowRunner Shadows' copy of the previous frame's linear depth
// (metres, the solid scene without the panes). Without the DLL t121 is unbound, reads 0, and the alpha stays.
//
// Build: fxc -T ps_5_0 -E main cabshade.hlsl -Fo cabshade.cso. Every knob can be set with -D NAME=value.

#ifndef CS_STRENGTH
#define CS_STRENGTH 0.6       // the share of its light the cab loses, 0 to 1
#endif
#ifndef CS_DEPTH
#define CS_DEPTH 3.0          // metres behind the pane that count as the cab; fading out to CS_DEPTH x CS_FADE
#endif
#ifndef CS_FADE
#define CS_FADE 1.5
#endif
#ifndef CS_FRONT
#define CS_FRONT 0.05         // metres behind the pane where the shade starts (the frame and the seal are closer), full
#endif                        // from CS_FRONT_FULL
#ifndef CS_FRONT_FULL
#define CS_FRONT_FULL 0.25
#endif
#ifndef CS_CAM_NEAR
#define CS_CAM_NEAR 1.2       // metres from the camera to the pane under which there is no shade (the cockpit view: the
#endif                        // camera is inside and what lies behind the pane is the bonnet and the road), full from
#ifndef CS_CAM_FULL           // CS_CAM_FULL
#define CS_CAM_FULL 2.2
#endif

#ifndef CS_FACE
#define CS_FACE 1             // 1: only panes facing the camera shade; -1: only panes seen from behind; 0: both
#endif

Texture2D<float> g_txSceneZ : register(t121);

float4 main(float4 pos : POS, float4 col : COL, float4 face : FACE) : SV_Target
{
    const float z = g_txSceneZ.Load(int3(pos.xy, 0));
    const float d = z - pos.w;                                         // metres from the pane to what is behind it
    float s = smoothstep(CS_FRONT, CS_FRONT_FULL, d) * (1.0 - smoothstep(CS_DEPTH, CS_DEPTH * CS_FADE, d));
    s *= smoothstep(CS_CAM_NEAR, CS_CAM_FULL, pos.w) * CS_STRENGTH;
    const bool front = asuint(face.x) != 0u;
    if (CS_FACE > 0 && !front) s = 0.0;
    if (CS_FACE < 0 && front) s = 0.0;
    const float a = saturate(col.x);
    return float4(1.0 - (1.0 - a) * (1.0 - s), 0, 0, 0);
}
