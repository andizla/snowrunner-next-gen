// SnowRunner Shadows: renders SnowRunner's sun shadow map at a higher resolution, with no loader.
//
// The game keeps its three sun shadow cascades side by side in one depth texture, 4608 x 1536 at the top Shadows
// setting. No game file sets that size (the daytime xml values and video.cfg were measured to do nothing; the size
// comes from the exe's code, which Steam's DRM encrypts), so it is changed where the texture is made: when the game
// creates a depth texture three times as wide as it is high, this DLL creates it Factor times larger, and while that
// texture is the bound depth target it scales the viewports and scissor rects the game sets by the same factor. The
// shaders read the texture with normalized coordinates (cascade offsets 0, 1/3, 2/3), so they need no change. This is
// the ReShade add-on ShadowScale as a standalone DLL.
//
// Loading: the game imports hid.dll and no core Windows DLL does, so this DLL sits in Sources\Bin as hid.dll. Every
// hid.dll export jumps straight to the real function (hid_stubs.asm, generated from System32\hid.dll): the real one
// from System32, or hid_chain.dll from the same folder when another mod used the name first (dimerge's convention).
//
// Hooks: the game's import of D3D11CreateDevice is repointed at this DLL, and on the device it gets back (ReShade's
// wrapper when ReShade is installed, the runtime's own device otherwise) these methods are replaced in its method
// table: CreateTexture2D(1), CreateDepthStencilView, CreateDeferredContext(1/2/3); on its contexts, immediate and
// deferred: OMSetRenderTargets(AndUnorderedAccessViews), RSSetViewports, RSSetScissorRects, RSGetViewports,
// RSGetScissorRects, ClearState, ExecuteCommandList, FinishCommandList. The viewport and scissor state is kept per
// context as the caller set it: reads return those values, so a layer that saves and restores state (ReShade, an
// overlay) never scales twice. Scaled textures and their depth views carry a private data tag, which survives
// pointer reuse. Nothing else in the game is touched.
//
// Settings: SnowRunnerShadows.ini next to this DLL, [Shadows] Factor=2 (the default: 3.5 costs 7 ms more at 4K; 1 = off;
// steps of 0.5; 3.5 is the largest that fits 4608 into Direct3D 11's 16384, a larger value falls back to it). If the
// ReShade add-on ShadowScale.addon64 is in the same folder, this DLL leaves the scaling to it. Log:
// SnowRunnerShadows.log, rewritten each start.
// SlopeBias=1 (default): while the scaled texture is drawn, the rasterizer states the game sets are swapped for copies with
// the slope-scaled depth bias multiplied by the factor. That bias is per shadow map texel (the depth slope across one
// texel), so without this a texture Factor times finer gets Factor times less bias, while the game's shadow filters still
// reach as far as at the original size: surfaces that face the sun at a grazing angle start to shadow themselves, and
// differently in each cascade (the dark side of a boulder flips at the 15 m cascade border at dusk).
// With it every primitive gets exactly the bias it gets at the original size. 0 = the game's states as they are.
// Trace=1 (diagnostics, changes nothing on screen): more hooks (draws, shader resources, copies, clears, shader creation)
// write what happens around the shadow texture to SnowRunnerShadows.trace.log in short bursts; totals go to the log.
//
// Scene feed (Feed=1, default): shaders drawn before the game has an image of the scene (the terrain's puddles, patched
// in shader.pak by Next Gen's tools) get the previous frame's. When the ambient occlusion pass is set up
// (the pixel shader whose resource table names g_txDither and g_txFactor: the game's own and the GTAO replacement), the
// lit scene is complete: its colour (render target 0 of the pass that wrote the g_txFactor target as render target 2)
// and its linear depth (what the pass reads at t80, g_txZ) are copied into two textures of this DLL. Every pixel shader
// that declares t120 gets them bound at t120 (colour) and t121 (depth) when it is set, again when the game resets those
// slots. Nothing else is bound or changed, and a shader that reads the feed before the first copy sees nothing bound.
// FeedMips=1 (default): the colour copy carries a full mip chain, generated right after each copy, so a shader may sample a
// blurred previous frame (rougher reflections); 0 = one level.
// Hooks for it: PSSetShader and PSSetShaderResources on the contexts, CreatePixelShader on the device (it looks at each
// pixel shader's resource table and declarations once and tags the shader). With Factor=1 or the ReShade add-on in
// charge of the scaling, the feed still runs.
//
// Bounce light (GI=1, default; needs the feed): when the AO pass's pixel shader writes a second output (the GTAO pass
// with bounce light, engine\replacements\gi\gtao_gi.hlsl), a texture of this DLL (RGBA16F, the size of
// the AO pass's target) is bound beside that target as render target 1 while the AO pass draws, and every pixel shader
// that declares t122 (the material shaders' ambient, next frame) gets it bound at t122, as long as the AO pass wrote it
// within the last 250 ms (else nothing: no stale light when the AO pass stops). The AO pass's target is learnt from the
// AO apply pass, which reads it back at t1 (g_txMask): only that target ever gets the second one beside it. When the
// game's blend state would not write a second target plainly (blending, or red only for a one-channel target), the
// AO pass draws with a copy of that state with target 1 plain and target 0 as the game's; the game's own state is put
// back at its next OMSetRenderTargets (hook: OMSetBlendState too). Every pixel shader that declares t120 or t121 gets
// the feed.
//
// AO pass at half size (AOHalf=1, the default; 0 = full size; KeyAOHalf = F5 flips it): that AO pass (with its bounce
// light) draws into two half-size targets of this DLL instead, its viewports halved until the game sets new targets
// (RSSetViewports and RSGetViewports keep the game's own values). When the apply pass is set next on that context, compute
// passes (src\ao\ao_upsample.hlsl) blur the half-size result 3 x 3 on its own grid (AOHalfBlur=1: the pass's noise cancels
// on the grid it is drawn on) and bring it back to full size, weighing each half-size sample by how near its pixel's
// depth is to the full-size pixel's (AOHalfDepthTol, a share of the depth): the AO into a full-size texture of this DLL,
// which the apply pass reads at t1 in place of the AO pass's own target (the game's t1 goes back after it), the bounce
// light into the bounce-light texture. Needs the GTAO blob built with AO_HALF_SNAP=1 (each half-size pixel computes the
// top-left full-size pixel of its block exactly); a depth target bound with the pass or a dump in progress keeps it at
// full size. On a captured 4K frame: the pass 4.77 -> 1.39 ms, blur and upsample 0.20 ms.
//
// Dev switches, for A/B comparisons in game (hotkeys, read while a window of the game is in front; every flip is
// written to the log):
//   F8   every shader.pak effect off / on: the game draws with the original of every shader the fidelity bundle
//        changed. The originals come from SnowRunnerShadows.stock next to this DLL (written by the bundle builder,
//        engine\tools\stock_twins.js, mapped read-only): when the game creates a changed shader, its
//        original is made beside it, and PSSetShader passes the original on while the switch is off.
//   F9   puddle reflections (effect E) off / on: the scene colour (t120) is withheld from every reader but the AO pass;
//        the puddle helper then keeps the stock cubemap sample (the same pixels as the build without E).
//   F10  bounce light (effect I) off / on: no second target for the AO pass, nothing at t122 (the same pixels as the
//        build without I).
//   F11  the AO pass: the game's own SSAO (its stock twin) or GTAO; the bounce light is off with the game's SSAO.
// Ini: KeyStock=119 KeyPuddles=120 KeyBounce=121 KeyAO=122 (virtual-key codes, 0 = no key) and the states at start:
// StockAll=0 PuddlesOn=1 BounceOn=1 StockAO=0.
// Dump (KeyDump=118 = F7; DumpAfter=<seconds>: once, that long after the AO pass first runs, 0 = off; DumpDir=<folder>,
// default this DLL's): one frame's bounce-light chain saved to files for offline measurement. The next AO pass set up
// with the feed copied has its inputs copied (the scene and depth as copied for it, t120/t121; g_txFactor at t2;
// g_txDither at t0; its pixel shader constant buffers) and, when it is over, its outputs (the AO target, the bounce-light
// texture, the constant buffers again), into staging resources; once the command lists holding those copies have run
// they are read on the immediate context and written by a worker thread: DumpDir\SnowRunnerShadows_dump_<time>_<name>.bin
// (a 64-byte header, see the dump section below) and ..._manifest.txt (what each file is; the pass's viewports, blend
// state, samplers, counts). About 150 MB at 4K. Reader: tools\dump_read.js.
//
// Screen-space reflections (SSR=1, default; needs the feed): one reflection pass for the material shaders instead of
// every glossy pixel marching on its own. The fidelity bundle's 'sssr' module makes the PBR material shaders write their
// normal and roughness as output 7 (spliced at their specular cubemap sample). While the game draws its lit pass (three
// targets, the third a g_txFactor target an AO pass has read), a texture of this DLL (RGBA8, the lit pass's size) is
// bound beside them as render target 7, drawn with blend-state copies that write it plainly, and cleared to "up, fully
// rough" after each pass. At the AO pass, after the feed copies and on the same context, compute passes of this DLL
// (src\ssr) build a depth pyramid, trace one ray per pixel, or per 2 x 2 block with SSRHalf=1 (default), through it and
// resolve the hits with a history of their own into t123 (RGBA16F: reflection x confidence, confidence). Every pixel
// shader that declares t123 or t124 gets t123 and t124 (the object motion, decoded from the game's velocity texture when
// its TAA pass is set up) bound there while the pass has run within the last 250 ms. The projection comes from the
// game's CB_GLOBAL_CAMERA, bound at b1 for the AO pass. Nothing runs before a shader that writes output 7 and one that
// reads t123 exist; F8 stops all of it. Knobs: SSRRoughMax, SSRThickness, SSRTemporal, SSRCone, SSRSteps; SSRMirror=1
// (debug: every pixel a mirror with its normal from the depth buffer, no splice needed). SSRProbe=1 (default): 20 s after the AO
// pass first runs and with every dump request, the order of a few frames' passes (lit pass, velocity, AO pass, TAA;
// command lists in the order they run) is written to SnowRunnerShadows.probe.log, the formats involved to the log.
//
// Frame timer (FrameLog=<seconds>, 0 = off, the default): the game's swap chain Present, reached through the game's own
// import of dxgi.dll!CreateDXGIFactory1 (the factory's CreateSwapChain and CreateSwapChainForHwnd hooked, then the swap
// chain's Present and Present1; with ReShade in front, its proxy objects are the ones hooked, so the time is the game's
// frame from one Present to the next). Every FrameLog seconds one log line: frames, frame rate, average frame time, the
// 1 % low (99th percentile frame time) and the longest frame. For benchmark runs; nothing else changes.
//
// GPU timers (GpuTimers=<seconds>, 0 = off, the default): timestamp queries around the passes this DLL
// knows, on the context that records them, read back at Present, one log line every GpuTimers seconds with each pass's
// GPU time per frame: the AO pass and the AO apply pass (from their pixel shader being set until the next shader or target
// change: the draw call itself cannot be timed, the runtime rewrites the Draw entries of the method table), the shadow
// texture (from each bind as the depth target to its unbind; at Factor=1 the texture is tagged x1 for this alone),
// the lit pass (its three targets bound until they change)
// and the scene feed copy. The reflection pass has its own line. The per-pass numbers replace whole-game benchmark runs
// (frame time +-0.3 ms from run to run) when a change is small.
//
// Depth probe (DepthProbe, dev; 0 = off, the default): for contact shadows, whether the scene depth is
// complete before the lit pass draws. Within a recording of the probe (SSRProbe; DepthProbe=1 its first, N >= 2 one of
// its own N s after the AO pass first ran, so past the title screen's scene) the timeline also gets each binding with a
// depth target of the scene depth's size (its draws, how many without a pixel shader, their depth-stencil states and
// vertex shaders), and one frame's scene depth is copied before the lit pass draws and at the AO pass, written to
// SnowRunnerShadows.depth<i>.raw for tools\depth_probe.js.
#include <windows.h>
#include <d3d11_4.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <intrin.h>
#include <mutex>
#include <share.h>
#include <tlhelp32.h>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include "hid_names.h"
// the reflection pass's compute shaders, compiled from src\ssr by build.bat (fxc -Fh into out\obj)
#include "g_csHizLevel0.h"
#include "g_csHizReduce.h"
#include "g_csTrace.h"
#include "g_csResolve.h"
#include "g_csMotion.h"
#include "g_csAOUpsample.h"
#include "g_csAOBlur.h"
#include "g_csDepthDecimate.h"
#include "g_csSSSSetup.h"
#include "g_csSSS.h"
#include "g_vsContact.h"
#include "g_psContact.h"

extern "C" {
void *g_hidReal[kHidCount]; // read by hid_stubs.asm
extern const int kSlotCreateTexture2D, kSlotCreateDepthStencilView, kSlotCreateDeferredContext, kSlotGetImmediateContext,
    kSlotCreateDeferredContext1, kSlotCreateDeferredContext2, kSlotCreateDeferredContext3, kSlotCreateTexture2D1,
    kSlotOMSetRenderTargets, kSlotOMSetRenderTargetsAndUAVs, kSlotRSSetViewports, kSlotRSSetScissorRects,
    kSlotRSGetViewports, kSlotRSGetScissorRects, kSlotClearState, kSlotExecuteCommandList, kSlotFinishCommandList,
    kSlotPSSetShaderResources, kSlotDraw, kSlotDrawIndexed, kSlotDrawInstanced, kSlotDrawIndexedInstanced,
    kSlotCopyResource, kSlotCopySubresourceRegion, kSlotClearDepthStencilView, kSlotDrawIndexedInstancedIndirect,
    kSlotDrawInstancedIndirect, kSlotDrawAuto, kSlotCreateVertexShader, kSlotCreatePixelShader, kSlotRSSetState, kSlotRSGetState,
    kSlotPSSetShader, kSlotOMSetBlendState, kSlotVSSetShader, kSlotCSSetShader, kSlotCreateComputeShader;
}

// {6A1F0C52-3E8B-4D57-9B21-5C7F3E0D9A44}: set on every scaled texture and its depth views, value = the factor
static const GUID kScaledTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x44 } };
// trace only: a shader's CRC32 (the name the shader dump uses), and what a command list holds
static const GUID kHashTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x45 } };
static const GUID kListTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x46 } };
// scene feed: what a pixel shader is to it (kFeed* bits), set when the shader is created
static const GUID kFeedTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x47 } };
enum : uint32_t { kFeedAO = 1, kFeedReads = 2, kFeedGIWrites = 4, kFeedGIReads = 8, kFeedAOApply = 16,
    kFeedWritesO7 = 32, kFeedSSRReads = 64, kFeedVelocity = 128, kFeedTAA = 256, // reflections: output 7, t123/t124, the game's velocity and TAA shaders
    kFeedHiZReads = 512,                                                             // the water: the reflection pass's depth pyramid at t125
    kFeedWater = 1024,                                                               // a planar-reflection water shader (g_txReflections, g_txBBOpaque): GPU timers
    kFeedZMips = 2048,                                                               // the AO pass's depth mips at t126 (GTAO AO_DEPTH_LOD=2)
    kFeedFogComposite = 4096,                                                        // the volumetric fog's composite (g_txFogColor, g_txZMS)
    kFeedFogReads = 8192,                                                            // the water: that composite's inputs at t118/t119, b13
    kFeedWritesO6 = 16384 };                                                         // contact shadows: a material that writes the sun's visibility to o6
// dev switches: a changed shader's original (private data interface) and its group (1 the AO pass, 2 any other)
static const GUID kTwinTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x48 } };
static const GUID kTwinGroupTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x49 } };
static const UINT kFeedSlot = 120; // t120 the previous frame's scene colour, t121 its linear depth
static const UINT kGISlot = 122;   // t122 the bounce light the AO pass measured last frame
static const UINT kSSRSlot = 123;  // t123 the reflections of the last pass, t124 the object motion of the last frame
static const UINT kHiZSlot = 125;  // t125 the reflection pass's depth pyramid (1 / linear depth, the nearest per cell, all levels)
static const UINT kZMipsSlot = 126; // t126 the AO pass's depth mips (levels 1..4 of its t80, decimated)
static const UINT kFogSlot = 118;   // t118 the volumetric fog's colour buffer, t119 its amount (the composite's t1 and t2)
static const UINT kFogCB = 13;      // b13 a copy of the fog composite's CB_INSTANCE (g_fDensity c0.w, g_fStartDepth c7.w)
static const UINT kRT7 = 7;        // the render target the splice writes normal and roughness to
static const UINT kRT6 = 6;        // the render target the shadow receivers write the sun's visibility to (contact shadows)
static const uint32_t kVelocityPS = 0x2EDA6865; // the game's velocity writer (CRC32 of its code; the probe notes it)

static std::wstring g_dir;          // this DLL's folder, with a trailing backslash
static FILE *g_log = nullptr;
static std::mutex g_logLock;
static float g_factor = 2.0f;       // from the ini
static bool g_scaling = true;       // false when the factor is 1 or the ReShade add-on does the job
static bool g_slopeBias = true;     // ini SlopeBias: scale the slope-scaled depth bias with the texture
static bool g_feed = true;          // ini Feed: the scene feed (previous frame's colour and depth at t120/t121)
static bool g_gi = true;            // ini GI: the bounce light (render target 1 of the AO pass, t122 for its readers)
static UINT g_frameLog = 0;         // ini FrameLog: seconds between frame timer lines, 0 = no frame timer
static UINT g_gpuTimers = 0;        // ini GpuTimers: seconds between GPU timer lines (the passes' GPU time per frame), 0 = off
static UINT g_gpuProfile = 0;       // ini GpuProfile: seconds between pass profile lists (every pass's GPU time per frame), 0 = off
static bool g_gpuProfileShaders = false; // ini GpuProfileShaders: the passes split by pixel shader as well (each material's time)
static UINT g_cpuProfile = 0;       // ini CpuProfile: seconds between CPU profile lines (the CPU time in this DLL's context hooks), 0 = off
static UINT g_cpuThreads = 0;       // ini CpuThreads: seconds between thread load lines (each game thread's CPU time per frame), 0 = off
static UINT g_memLog = 0;           // ini MemLog: seconds between lines of the game's large reserved regions and what they hold, 0 = off
static bool g_feedMips = true;      // ini FeedMips: the colour copy with a full mip chain (a blurred previous frame for rougher reflections)
static bool g_ssr = true;           // ini SSR: the reflection pass (render target 7 of the lit pass, t123/t124)
static bool g_ssrHalf = true;       // ini SSRHalf: one ray per 2 x 2 block (0: one per pixel)
static bool g_ssrMirror = false;    // ini SSRMirror (debug): every pixel a mirror with its normal from the depth buffer
static bool g_ssrProbe = true;      // ini SSRProbe: the order of a few frames' passes, once, to SnowRunnerShadows.probe.log
static UINT g_depthProbe = 0;       // ini DepthProbe (dev): 1 = with the probe's first recording, N >= 2 = N s after the AO pass first ran (see DPArm)
static bool g_ssrLobe = false;      // ini SSRLobe: rays drawn from the GGX lobe (0: the mirror direction, roughness only blurs the hit)
static float g_ssrRoughMax = 0.85f, g_ssrThickness = 0.3f, g_ssrTemporal = 0.9f, g_ssrCone = 0.5f; // ini SSRRoughMax etc. (0.85: the paint reaches ~0.8; the composite's gate ends at 0.81)
static float g_ssrUnder = 2.5f, g_ssrUnderShade = 0.5f, g_ssrUnderNear = 25.0f, g_ssrUnderFar = 50.0f; // ini SSRUnder etc.: a ray deeper behind a surface than
                                    // the thickness went under that object and takes its colour, darkened (ssr_trace.hlsl);
                                    // SSRUnder=0 = no reflection there (the material's sky cubemap)
static UINT g_ssrSteps = 80;        // ini SSRSteps: traversal iterations per ray
static bool g_aoHalfBlur = true;    // ini AOHalfBlur: the half-size AO blurred 3 x 3 on its own grid before the upsample (AOHalf: see ReadSettings)
static float g_aoHalfTol = 0.02f;   // ini AOHalfDepthTol: the depth tolerance of that blur and the upsample (share of the depth)
static bool g_zMips = true;         // ini ZMips: the AO pass's depth mips at t126 (for an AO pass that declares it; 0 = it reads t80 alone)
static bool g_fogRefl = true;       // ini FogReflections: the water gets the volumetric fog's inputs (t118/t119, b13) to haze its
                                    // reflections like the objects they mirror; 0 = nothing bound
static bool g_texBaseRule = true;   // ini TextureBaseRule: the game's small-texture side for the resident low mips 256 -> 128 (see TextureBaseRule)
static bool g_contact = true;       // ini Contact: contact shadows (render target 6 of the lit pass, the screen-space sun shadows and their
                                    // composite at the AO pass, see ContactRun); 0 = none of it
static UINT g_contactDebug = 0;     // ini ContactDebug: 1 = the mask alone darkens the whole scene, 2 = the sun share as darkness
static float g_contactStrength = 1.0f, g_contactThickness = 0.005f, g_contactContrast = 4.0f, g_contactBilinear = 0.02f,
             g_contactFadeStart = 30.0f, g_contactMaxDepth = 50.0f, g_contactSky = 3000.0f; // ini ContactStrength etc. (the composite's and the pass's knobs, src\sss)
// dev switches (see the top): the states the hotkeys flip, and the keys (virtual-key codes, 0 = none); g_aoHalfOn starts
// as ini AOHalf (the AO pass at half size)
static std::atomic<bool> g_stockAll{ false }, g_puddlesOn{ true }, g_bounceOn{ true }, g_stockAO{ false }, g_ssrOn{ true }, g_aoHalfOn{ false }, g_contactOn{ true };
static UINT g_keyStock = VK_F8, g_keyPuddles = VK_F9, g_keyBounce = VK_F10, g_keyAO = VK_F11, g_keySSR = VK_F6, g_keyAOHalf = VK_F5, g_keyContact = VK_F4;
// dump (see the top): the key, the timer, the folder, and what the feed needs of it; the machinery follows the bounce light
static UINT g_keyDump = VK_F7;
static float g_dumpAfter = 0;
static std::wstring g_dumpDir;
enum DumpState : int { kDumpIdle = 0, kDumpRequested, kDumpRecording, kDumpFinal };
static std::atomic<int> g_dumpState{ kDumpIdle };
static std::atomic<ULONGLONG> g_dumpFirstAO{ 0 };  // when the feed was first copied: DumpAfter counts from it
struct ContextState;
// GPU timers (see the section): the passes timed, and the calls the hooks make
enum GpuSection : int { kGpuAO, kGpuAOApply, kGpuAOUp, kGpuShadows, kGpuLit, kGpuFeed, kGpuWater, kGpuSections };
struct GpuTimer;
static GpuTimer *GpuBegin(ID3D11DeviceContext *ctx, int sec);
static void GpuEnd(ID3D11DeviceContext *ctx, GpuTimer *&t);
// pass profile (see the section): what a pass is (the key its time is summed under is the hash of these bytes)
enum : uint8_t { kProfTargets = 0, kProfCompute = 1, kProfOurs = 2 };
enum : uint16_t { kProfFeed = 1, kProfSSR = 2, kProfAOUp = 3, kProfZMips = 4, kProfSSRHiZ = 5, kProfSSRTrace = 6, kProfSSRResolve = 7,
    kProfSSRHistory = 8, kProfSSRMotion = 9, kProfContact = 10, kProfOursCount = 11 }; // this DLL's own work (kProfOurs)
struct ProfDesc
{
    uint8_t kind = kProfTargets;
    uint8_t rts = 0;      // render targets bound
    uint8_t uav = 0;      // with unordered-access views beside them
    uint8_t many = 0;     // drew with more than one pixel shader
    uint16_t fmt[8] = {}; // the render targets' view formats
    uint16_t dsvFmt = 0;  // the depth target's view format (0: none)
    uint16_t ours = 0;    // kProfOurs: which work
    uint32_t w = 0, h = 0; // the first target's size (the depth target's without one)
    uint32_t shader = 0;  // the one pixel shader it drew with, or the compute shader (CRC32 of the code; 0 none or many)
};
static_assert(sizeof(ProfDesc) == 36, "ProfDesc is hashed as bytes: no padding");
struct ProfTimer;
static void ProfForget(ContextState *s);
static void ProfOurs(ID3D11DeviceContext *ctx, ContextState *s, uint16_t which);
static void ProfResume(ID3D11DeviceContext *ctx, ContextState *s);
static void DumpRequest(const char *why);
static void DumpTick(ULONGLONG now);
static void ProbeTick(ULONGLONG now);
static void DumpInputs(ID3D11DeviceContext *ctx, ContextState *s);
static void DumpOutputs(ID3D11DeviceContext *ctx, ContextState *s, const char *when);
static std::atomic<uint64_t> g_atlasBinds{ 0 }, g_restores{ 0 }, g_resets{ 0 };
static std::atomic<int> g_bindLines{ 0 };

// ---- trace (ini Trace=1): what happens around the shadow texture, in bursts of 0.4 s every 30 s, into
// SnowRunnerShadows.trace.log. Watches only; the extra hooks are not installed without Trace=1.
static bool g_trace = false;
static FILE *g_traceFile = nullptr;
static std::mutex g_traceLock;
static std::atomic<ULONGLONG> g_burstUntil{ 0 };    // read without the lock on the hot paths
static ULONGLONG g_nextBurst = 0;                   // the rest under g_traceLock
static int g_burstLines = 0, g_bursts = 0;
static bool g_burstFlushed = true;
static std::vector<const void *> g_described;       // state objects already described in this burst
static const ULONGLONG kBurstEvery = 30000, kBurstLength = 400;
static const int kBurstLines = 12000;
static std::atomic<uint64_t> g_drawsBound{ 0 }, g_viewportMismatch{ 0 }, g_scissorMismatch{ 0 }, g_copiesSeen{ 0 }, g_clearsSeen{ 0 },
    g_untracked{ 0 }, g_indirect{ 0 };
static std::atomic<uint32_t> g_listIds{ 0 };

static bool InBurst() { return GetTickCount64() < g_burstUntil.load(std::memory_order_relaxed); }

// A burst starts with the first event after the pause (binds of the shadow texture come every frame) and ends after
// kBurstLength or kBurstLines lines, whichever is first.
static void Trace(const char *fmt, ...)
{
    std::lock_guard<std::mutex> lock(g_traceLock);
    if (!g_traceFile) return;
    const ULONGLONG now = GetTickCount64();
    if (now >= g_nextBurst)
    {
        g_nextBurst = now + kBurstEvery;
        g_burstUntil.store(now + kBurstLength, std::memory_order_relaxed);
        g_burstLines = 0;
        g_burstFlushed = false;
        g_described.clear();
        fprintf(g_traceFile, "---- burst %d\n", ++g_bursts);
    }
    if (now < g_burstUntil.load(std::memory_order_relaxed) && g_burstLines >= kBurstLines) g_burstUntil.store(now, std::memory_order_relaxed);
    if (now >= g_burstUntil.load(std::memory_order_relaxed))
    {
        if (!g_burstFlushed) { g_burstFlushed = true; fflush(g_traceFile); }
        return;
    }
    g_burstLines++;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_traceFile, "%02d:%02d:%02d.%03d t%05lu ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentThreadId());
    va_list args; va_start(args, fmt); vfprintf(g_traceFile, fmt, args); va_end(args);
    fputc('\n', g_traceFile);
}
static bool FirstInBurst(const void *p)
{
    std::lock_guard<std::mutex> lock(g_traceLock);
    for (const void *q : g_described) if (q == p) return false;
    g_described.push_back(p);
    return true;
}

static uint32_t Crc32(const void *data, size_t size)
{
    static uint32_t table[256];
    static std::once_flag once;
    std::call_once(once, [] { for (uint32_t i = 0; i < 256; i++) { uint32_t c = i; for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1; table[i] = c; } });
    uint32_t c = ~0u;
    for (size_t i = 0; i < size; i++) c = table[(c ^ ((const uint8_t *)data)[i]) & 255] ^ (c >> 8);
    return ~c;
}

static void Log(const char *fmt, ...)
{
    std::lock_guard<std::mutex> lock(g_logLock);
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d  ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list args; va_start(args, fmt); vfprintf(g_log, fmt, args); va_end(args);
    fputc('\n', g_log);
    fflush(g_log);
}

// ---- dev switches (see the top)

// the stock twins table (SnowRunnerShadows.stock), mapped read-only: 'SRTW', version 1, count, 0, then count entries
// { CRC32 of the changed code, group, offset, size } sorted by CRC, then the original code
struct TwinEntry { uint32_t key, group, offset, size; };
static const uint8_t *g_twinBase = nullptr;
static const TwinEntry *g_twins = nullptr;
static uint32_t g_twinCount = 0;
static std::atomic<uint32_t> g_twinsMade{ 0 }, g_twinsFailed{ 0 };

static void LoadTwins()
{
    const std::wstring path = g_dir + L"SnowRunnerShadows.stock";
    HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    LARGE_INTEGER size = {};
    GetFileSizeEx(f, &size);
    HANDLE m = size.QuadPart >= 16 ? CreateFileMappingW(f, nullptr, PAGE_READONLY, 0, 0, nullptr) : nullptr;
    CloseHandle(f);
    const uint8_t *base = m ? (const uint8_t *)MapViewOfFile(m, FILE_MAP_READ, 0, 0, 0) : nullptr;
    if (m) CloseHandle(m); // the view keeps the mapping alive
    if (!base) { Log("stock twins: SnowRunnerShadows.stock could not be read"); return; }
    uint32_t head[4];
    memcpy(head, base, sizeof head);
    const uint64_t bytes = (uint64_t)size.QuadPart, n = head[2];
    bool ok = memcmp(base, "SRTW", 4) == 0 && head[1] == 1 && 16 + n * sizeof(TwinEntry) <= bytes;
    const TwinEntry *e = (const TwinEntry *)(base + 16);
    uint32_t ao = 0;
    for (uint64_t i = 0; ok && i < n; i++)
    {
        ok = e[i].size >= 32 && (uint64_t)e[i].offset + e[i].size <= bytes && (i == 0 || e[i - 1].key < e[i].key);
        ao += e[i].group == 1;
    }
    if (!ok) { Log("stock twins: SnowRunnerShadows.stock is not a valid table, ignored"); UnmapViewOfFile(base); return; }
    g_twinBase = base; g_twins = e; g_twinCount = (uint32_t)n;
    Log("stock twins: %u shaders (%u of the AO pass) in SnowRunnerShadows.stock", g_twinCount, ao);
}
static const TwinEntry *FindTwin(uint32_t key)
{
    uint32_t lo = 0, hi = g_twinCount;
    while (lo < hi) { const uint32_t mid = lo + (hi - lo) / 2; if (g_twins[mid].key < key) lo = mid + 1; else hi = mid; }
    return lo < g_twinCount && g_twins[lo].key == key ? &g_twins[lo] : nullptr;
}

static void KeyName(UINT vk, char *out, size_t n)
{
    if (!vk) snprintf(out, n, "none");
    else if (vk >= VK_F1 && vk <= VK_F24) snprintf(out, n, "F%u", vk - VK_F1 + 1);
    else snprintf(out, n, "key 0x%02X", vk);
}
// watches the hotkeys while a window of this process is in front; each press flips its switch
static DWORD WINAPI HotkeyThread(void *)
{
    struct Switch { UINT key; std::atomic<bool> *state; const char *what, *whenTrue, *whenFalse; bool down; };
    Switch sw[] = {
        { g_keyStock, &g_stockAll, "every shader.pak effect", "off (the game's own shaders)", "on", false },
        { g_keyPuddles, &g_puddlesOn, "puddle reflections", "on", "off", false },
        { g_keyBounce, &g_bounceOn, "bounce light", "on", "off", false },
        { g_keyAO, &g_stockAO, "ambient occlusion", "the game's own SSAO (no bounce light with it)", "GTAO", false },
        { g_ssr ? g_keySSR : 0, &g_ssrOn, "reflection pass", "on", "off (the materials' own cubemap)", false },
        { g_gi ? g_keyAOHalf : 0, &g_aoHalfOn, "AO pass", "at half size (upsampled)", "at full size", false },
        { g_contact ? g_keyContact : 0, &g_contactOn, "contact shadows", "on", "off", false },
    };
    bool dumpDown = false;
    for (;;)
    {
        Sleep(30);
        DWORD pid = 0;
        const HWND fg = GetForegroundWindow();
        if (fg) GetWindowThreadProcessId(fg, &pid);
        const bool front = pid == GetCurrentProcessId();
        for (Switch &s : sw)
        {
            const bool down = front && s.key && (GetAsyncKeyState((int)s.key) & 0x8000) != 0;
            if (down && !s.down)
            {
                const bool now = !s.state->load();
                s.state->store(now);
                char name[16];
                KeyName(s.key, name, sizeof name);
                Log("%s: %s %s", name, s.what, now ? s.whenTrue : s.whenFalse);
            }
            s.down = down;
        }
        // the dump key: one shot per press; and the dump's timer and timeout
        const bool dumpNow = front && g_keyDump && (GetAsyncKeyState((int)g_keyDump) & 0x8000) != 0;
        if (dumpNow && !dumpDown) { char name[16]; KeyName(g_keyDump, name, sizeof name); DumpRequest(name); }
        dumpDown = dumpNow;
        DumpTick(GetTickCount64());
        ProbeTick(GetTickCount64());
    }
}
static void StartHotkeys()
{
    static std::once_flag once;
    std::call_once(once, [] {
        if (!g_keyStock && !g_keyPuddles && !g_keyBounce && !g_keyAO && !g_keyAOHalf && !g_keyDump && g_dumpAfter <= 0 && !(g_ssr && g_ssrProbe) && !(g_contact && g_keyContact)) return;
        HANDLE t = CreateThread(nullptr, 0, &HotkeyThread, nullptr, 0, nullptr);
        if (t) CloseHandle(t);
        char a[16], b[16], c[16], d[16];
        KeyName(g_keyStock, a, sizeof a); KeyName(g_keyPuddles, b, sizeof b); KeyName(g_keyBounce, c, sizeof c); KeyName(g_keyAO, d, sizeof d);
        Log("dev switches: %s every shader.pak effect%s, %s puddle reflections, %s bounce light, %s AO (GTAO / the game's own)%s", a,
            g_twinCount ? "" : " (no SnowRunnerShadows.stock: nothing to switch)", b, c, d, t ? "" : "; the hotkey thread could not be started");
        if (g_ssr) { char k[16]; KeyName(g_keySSR, k, sizeof k); Log("dev switches: %s the reflection pass alone (on: %s)", k, g_ssrOn ? "yes" : "no"); }
        if (g_gi) { char k[16]; KeyName(g_keyAOHalf, k, sizeof k); Log("dev switches: %s the AO pass at half or full size (now: %s)", k, g_aoHalfOn ? "half" : "full"); }
        if (g_contact) { char k[16]; KeyName(g_keyContact, k, sizeof k); Log("dev switches: %s contact shadows alone (on: %s)", k, g_contactOn ? "yes" : "no"); }
        char e[16];
        KeyName(g_keyDump, e, sizeof e);
        if (g_dumpAfter > 0) Log("dump: %s, or DumpAfter %g s after the AO pass first runs, saves one frame's bounce-light chain to %ls", e, g_dumpAfter, g_dumpDir.c_str());
        else Log("dump: %s saves one frame's bounce-light chain to %ls", e, g_dumpDir.c_str());
    });
}

// ---- hid.dll forwarding

static BOOLEAN WINAPI HidDMissing() { return FALSE; }                 // HidD_*: BOOLEAN, FALSE = failed
static LONG WINAPI HidPMissing() { return (LONG)0xC0110020; }         // HidP_*: HIDP_STATUS_NOT_IMPLEMENTED

static void LoadRealHid()
{
    std::wstring real = g_dir + L"hid_chain.dll";
    if (GetFileAttributesW(real.c_str()) == INVALID_FILE_ATTRIBUTES)
    {
        wchar_t sys[MAX_PATH] = {};
        GetSystemDirectoryW(sys, MAX_PATH);
        real = std::wstring(sys) + L"\\hid.dll";
    }
    HMODULE m = LoadLibraryW(real.c_str());
    int missing = 0;
    for (int i = 0; i < kHidCount; i++)
    {
        void *p = m ? (void *)GetProcAddress(m, kHidNames[i]) : nullptr;
        if (!p) { missing++; p = kHidNames[i][3] == 'D' ? (void *)&HidDMissing : (void *)&HidPMissing; }
        g_hidReal[i] = p;
    }
    Log("hid.dll functions from %ls%s, %d missing", real.c_str(), m ? "" : " (NOT LOADED)", missing);
}

// ---- method table patching

static bool PatchSlot(void **vt, int slot, void *hook)
{
    DWORD old;
    if (!VirtualProtect(&vt[slot], sizeof(void *), PAGE_READWRITE, &old)) return false;
    vt[slot] = hook;
    VirtualProtect(&vt[slot], sizeof(void *), old, &old);
    return true;
}

typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateTexture2D)(ID3D11Device *, const D3D11_TEXTURE2D_DESC *, const D3D11_SUBRESOURCE_DATA *, ID3D11Texture2D **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateTexture2D1)(ID3D11Device3 *, const D3D11_TEXTURE2D_DESC1 *, const D3D11_SUBRESOURCE_DATA *, ID3D11Texture2D1 **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateDepthStencilView)(ID3D11Device *, ID3D11Resource *, const D3D11_DEPTH_STENCIL_VIEW_DESC *, ID3D11DepthStencilView **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateDeferredContext)(ID3D11Device *, UINT, ID3D11DeviceContext **);
typedef void(STDMETHODCALLTYPE *PFN_OMSetRenderTargets)(ID3D11DeviceContext *, UINT, ID3D11RenderTargetView *const *, ID3D11DepthStencilView *);
typedef void(STDMETHODCALLTYPE *PFN_OMSetRenderTargetsAndUAVs)(ID3D11DeviceContext *, UINT, ID3D11RenderTargetView *const *, ID3D11DepthStencilView *, UINT, UINT, ID3D11UnorderedAccessView *const *, const UINT *);
typedef void(STDMETHODCALLTYPE *PFN_RSSetViewports)(ID3D11DeviceContext *, UINT, const D3D11_VIEWPORT *);
typedef void(STDMETHODCALLTYPE *PFN_RSSetScissorRects)(ID3D11DeviceContext *, UINT, const D3D11_RECT *);
typedef void(STDMETHODCALLTYPE *PFN_RSGetViewports)(ID3D11DeviceContext *, UINT *, D3D11_VIEWPORT *);
typedef void(STDMETHODCALLTYPE *PFN_RSGetScissorRects)(ID3D11DeviceContext *, UINT *, D3D11_RECT *);
typedef void(STDMETHODCALLTYPE *PFN_ClearState)(ID3D11DeviceContext *);
typedef void(STDMETHODCALLTYPE *PFN_ExecuteCommandList)(ID3D11DeviceContext *, ID3D11CommandList *, BOOL);
typedef HRESULT(STDMETHODCALLTYPE *PFN_FinishCommandList)(ID3D11DeviceContext *, BOOL, ID3D11CommandList **);
typedef void(STDMETHODCALLTYPE *PFN_RSSetState)(ID3D11DeviceContext *, ID3D11RasterizerState *);
typedef void(STDMETHODCALLTYPE *PFN_RSGetState)(ID3D11DeviceContext *, ID3D11RasterizerState **);
typedef void(STDMETHODCALLTYPE *PFN_PSSetShaderResources)(ID3D11DeviceContext *, UINT, UINT, ID3D11ShaderResourceView *const *);
typedef void(STDMETHODCALLTYPE *PFN_PSSetShader)(ID3D11DeviceContext *, ID3D11PixelShader *, ID3D11ClassInstance *const *, UINT);
typedef void(STDMETHODCALLTYPE *PFN_VSSetShader)(ID3D11DeviceContext *, ID3D11VertexShader *, ID3D11ClassInstance *const *, UINT);
typedef void(STDMETHODCALLTYPE *PFN_CSSetShader)(ID3D11DeviceContext *, ID3D11ComputeShader *, ID3D11ClassInstance *const *, UINT);
typedef void(STDMETHODCALLTYPE *PFN_OMSetBlendState)(ID3D11DeviceContext *, ID3D11BlendState *, const FLOAT[4], UINT);
typedef void(STDMETHODCALLTYPE *PFN_Draw)(ID3D11DeviceContext *, UINT, UINT);
typedef void(STDMETHODCALLTYPE *PFN_DrawIndexed)(ID3D11DeviceContext *, UINT, UINT, INT);
typedef void(STDMETHODCALLTYPE *PFN_DrawInstanced)(ID3D11DeviceContext *, UINT, UINT, UINT, UINT);
typedef void(STDMETHODCALLTYPE *PFN_DrawIndexedInstanced)(ID3D11DeviceContext *, UINT, UINT, UINT, INT, UINT);
typedef void(STDMETHODCALLTYPE *PFN_CopyResource)(ID3D11DeviceContext *, ID3D11Resource *, ID3D11Resource *);
typedef void(STDMETHODCALLTYPE *PFN_CopySubresourceRegion)(ID3D11DeviceContext *, ID3D11Resource *, UINT, UINT, UINT, UINT, ID3D11Resource *, UINT, const D3D11_BOX *);
typedef void(STDMETHODCALLTYPE *PFN_ClearDepthStencilView)(ID3D11DeviceContext *, ID3D11DepthStencilView *, UINT, FLOAT, UINT8);
typedef void(STDMETHODCALLTYPE *PFN_DrawIndirect)(ID3D11DeviceContext *, ID3D11Buffer *, UINT);
typedef void(STDMETHODCALLTYPE *PFN_DrawAuto)(ID3D11DeviceContext *);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateVertexShader)(ID3D11Device *, const void *, SIZE_T, ID3D11ClassLinkage *, ID3D11VertexShader **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreatePixelShader)(ID3D11Device *, const void *, SIZE_T, ID3D11ClassLinkage *, ID3D11PixelShader **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateComputeShader)(ID3D11Device *, const void *, SIZE_T, ID3D11ClassLinkage *, ID3D11ComputeShader **);

// The original functions of every method table patched, found again through the object's own table pointer. An entry
// is published before its slots are patched, so lookups need no lock. Devices share one table per class (in d3d11.dll,
// or in ReShade's wrapper), but the runtime gives every context a table of its own inside the context object, so
// context tables go into a hash table sized for thousands of contexts. A freed context's address can come back as a
// new context with an unpatched table: whether a table is hooked is read from the table itself, never from the list.
struct DeviceOrig
{
    void **vt;
    PFN_CreateTexture2D createTexture2D;
    PFN_CreateTexture2D1 createTexture2D1;
    PFN_CreateDepthStencilView createDSV;
    PFN_CreateDeferredContext createDeferred, createDeferred1, createDeferred2, createDeferred3;
    PFN_CreateVertexShader createVS; // trace and the stock twins
    PFN_CreatePixelShader createPS;
    PFN_CreateComputeShader createCS; // pass profile
};
struct ContextOrig
{
    void **vt;
    PFN_OMSetRenderTargets omSet;
    PFN_OMSetRenderTargetsAndUAVs omSetUAV;
    PFN_RSSetViewports setViewports;
    PFN_RSSetScissorRects setScissors;
    PFN_RSGetViewports getViewports;
    PFN_RSGetScissorRects getScissors;
    PFN_ClearState clearState;
    PFN_ExecuteCommandList execute;
    PFN_FinishCommandList finish;
    PFN_RSSetState setRS;
    PFN_RSGetState getRS;
    // scene feed and trace
    PFN_PSSetShaderResources psSRV;
    PFN_PSSetShader psSet;
    // the stock twins (dev switches) of vertex shaders
    PFN_VSSetShader vsSet;
    // pass profile
    PFN_CSSetShader csSet;
    // bounce light
    PFN_OMSetBlendState omSetBlend;
    // trace only
    PFN_Draw draw;
    PFN_DrawIndexed drawIndexed;
    PFN_DrawInstanced drawInstanced;
    PFN_DrawIndexedInstanced drawIndexedInstanced;
    PFN_CopyResource copyResource;
    PFN_CopySubresourceRegion copyRegion;
    PFN_ClearDepthStencilView clearDSV;
    PFN_DrawIndirect drawIndexedInstancedIndirect, drawInstancedIndirect;
    PFN_DrawAuto drawAuto;
};
static DeviceOrig g_devices[16];
static std::atomic<int> g_deviceCount{ 0 };
static const int kContextSlots = 8192; // power of two
static std::atomic<void **> g_contextKeys[kContextSlots];
static ContextOrig g_contextValues[kContextSlots];
static int g_contextEntries = 0; // under g_patchLock
static std::mutex g_patchLock;

static const DeviceOrig *DevOrig(void *self)
{
    void **vt = *(void ***)self;
    for (int i = 0, n = g_deviceCount.load(std::memory_order_acquire); i < n; i++) if (g_devices[i].vt == vt) return &g_devices[i];
    return nullptr;
}
static size_t Bucket(void **vt)
{
    uint64_t x = (uint64_t)(uintptr_t)vt;
    x ^= x >> 33; x *= 0xff51afd7ed558ccdULL; x ^= x >> 33;
    return (size_t)x & (kContextSlots - 1);
}
static const ContextOrig *CtxOrig(void *self)
{
    void **vt = *(void ***)self;
    for (size_t i = Bucket(vt), n = 0; n < kContextSlots; i = (i + 1) & (kContextSlots - 1), n++)
    {
        void **key = g_contextKeys[i].load(std::memory_order_acquire);
        if (key == vt) return &g_contextValues[i];
        if (!key) break;
    }
    return nullptr;
}
// under g_patchLock: the entry for vt, filled with e (a reused table gets the same originals again)
static bool PublishContext(void **vt, const ContextOrig &e)
{
    for (size_t i = Bucket(vt), n = 0; n < kContextSlots; i = (i + 1) & (kContextSlots - 1), n++)
    {
        void **key = g_contextKeys[i].load(std::memory_order_relaxed);
        if (key == vt) { g_contextValues[i] = e; return true; }
        if (key) continue;
        if (g_contextEntries >= kContextSlots * 3 / 4) return false;
        g_contextValues[i] = e;
        g_contextKeys[i].store(vt, std::memory_order_release);
        g_contextEntries++;
        return true;
    }
    return false;
}

// ---- per context viewport and scissor state, as the callers set it

struct ContextState
{
    std::vector<D3D11_VIEWPORT> viewports;
    std::vector<D3D11_RECT> scissors;
    bool atlas = false;  // a scaled texture is the bound depth target
    bool scaled = false; // the scaled values are what the context holds
    float factor = 1;
    ID3D11RasterizerState *rs = nullptr; // the rasterizer state as the caller set it
    bool rsScaled = false;               // the context holds its copy with the scaled slope bias
    // scene feed
    uint32_t psFlags = 0;                                           // the bound pixel shader's kFeed* bits
    ID3D11ShaderResourceView *aoFactor = nullptr, *aoZ = nullptr;   // bound at t2 and t80 (the context holds them)
    bool captured = false;                                          // the scene was copied for this setting of the AO pass
    bool giBound = false;                                           // the bounce-light texture is render target 1 now
    bool blendSwapped = false;                                      // the context holds a copy of gameBlend (see GIBlend)
    ID3D11BlendState *gameBlend = nullptr;                          // the blend state the game set, with its factor and mask
    FLOAT blendFactor[4] = {};
    UINT blendMask = 0xffffffff;
    // reflections
    bool rt7Bound = false;                                          // this DLL's render target 7 sits beside the lit pass's targets now
    bool rt6Bound = false;                                          // contact shadows: render target 6 likewise
    bool motionDone = false;                                        // t124 was decoded for this setting of the TAA pass
    // the AO pass at half size (ini AOHalf, see AOHalfEnd and AOHalfApply)
    bool aoHalf = false;                                            // the AO pass draws into this DLL's half-size targets now (viewports halved)
    bool aoHalfReady = false;                                       // it was upsampled when it ended: the next apply pass reads the result
    bool aoHalfSubst = false;                                       // the apply pass reads the full-size result at t1 now
    ID3D11RenderTargetView *aoHalfGameRtv = nullptr;                // the AO pass's own target (held), put back if the pass ends with the targets kept
    ID3D11ShaderResourceView *aoHalfGameT1 = nullptr;               // what the game bound at t1 for the apply pass (held), put back after it
    // the AO pass's depth mips (ini ZMips, see ZMipsBuild)
    bool zMipsBound = false;                                        // this DLL's mips are at t126 for the AO pass set now
    const void *zMipsFrom = nullptr;                                // the t80 view they were made from (compared, never used)
    std::string probe;                                              // the probe's events recorded here since the last FinishCommandList
    // depth probe (ini DepthProbe, see DPDraw)
    bool dpLit = false;                                             // the lit pass's three targets are bound now
    bool dpPs = false;                                              // a pixel shader is bound now
    bool dpListLit = false;                                         // a lit-pass draw with a pixel shader recorded since the last FinishCommandList
    bool dpBinding = false;                                         // the targets bound now are counted for the probe's timeline
    std::string dpTargets;                                          // what they are
    UINT dpDraws = 0, dpNoPs = 0;                                   // their draws so far, and how many had no pixel shader
    std::vector<std::pair<uint32_t, UINT>> dpStates, dpVS;          // depth-stencil state key -> draws; vertex shader -> draws
    const void *dpLastDS = nullptr;                                 // the depth-stencil state of the last draw, and its key
    uint32_t dpLastKey = 0;
    // dump
    uint32_t dumpGen = 0;                             // the dump this context recorded copies for
    bool dumpAwaiting = false;                        // the inputs were recorded here; the outputs follow when the AO pass is over
    bool dumpRecorded = false;                        // copies recorded since the last FinishCommandList (deferred contexts)
    ID3D11Resource *dumpAO = nullptr;                 // the AO pass's own target, held until the outputs are recorded
    DXGI_FORMAT dumpAOView = DXGI_FORMAT_UNKNOWN;     // and the format it is drawn through
    // GPU timers: the timings open on this context (the shadow texture bound as the depth target, the lit pass's targets)
    GpuTimer *gpuShadow = nullptr, *gpuLit = nullptr, *gpuPass = nullptr; // (gpuPass: the AO pass or an apply pass, see GpuShaderSet)
    // pass profile: the pass timed on this context now, the targets set last (a pass goes on with them after compute work
    // or a command list kept the state), and the game's pass this DLL's own work paused
    ProfTimer *prof = nullptr;
    UINT profPs = 0;                                  // pixel shaders set since the pass began
    uint32_t profCurPs = 0;                           // the pixel shader bound now (its CRC32; 0 none or unnamed)
    ProfDesc profTargets = {};
    bool profHaveTargets = false;
    ProfDesc profPaused = {};
    UINT profPausedPs = 0;
    bool profHavePaused = false;
    // trace only
    UINT draws = 0;                                  // draws since the shadow texture was bound
    UINT listShadowDraws = 0, listOtherDraws = 0, listBinds = 0; // since the last FinishCommandList
    const void *lastVS = nullptr, *lastPS = nullptr, *lastRS = nullptr, *lastDS = nullptr;
};
static std::shared_mutex g_stateLock;
static std::unordered_map<void *, ContextState *> g_states;

// A context is used by one thread at a time, so each thread remembers the last one it touched; states are never freed
// (a reused address gets its state reset when the new context is made), so the remembered pointer stays valid.
static thread_local void *t_lastContext = nullptr;
static thread_local ContextState *t_lastState = nullptr;

static ContextState *State(void *ctx)
{
    if (ctx == t_lastContext) return t_lastState;
    ContextState *found = nullptr;
    {
        std::shared_lock<std::shared_mutex> lock(g_stateLock);
        const auto it = g_states.find(ctx);
        if (it != g_states.end()) found = it->second;
    }
    if (!found)
    {
        std::unique_lock<std::shared_mutex> lock(g_stateLock);
        ContextState *&s = g_states[ctx];
        if (!s) s = new ContextState();
        found = s;
    }
    t_lastContext = ctx;
    t_lastState = found;
    return found;
}
static void ResetState(void *ctx)
{
    ContextState *s = State(ctx);
    s->viewports.clear(); s->scissors.clear(); s->atlas = false; s->scaled = false; s->factor = 1; s->draws = 0;
    s->rs = nullptr; s->rsScaled = false;
    s->psFlags = 0; s->aoFactor = s->aoZ = nullptr; s->captured = false; s->giBound = false; s->blendSwapped = false; s->gameBlend = nullptr;
    s->rt7Bound = false; s->rt6Bound = false; s->motionDone = false;
    s->aoHalf = false; s->aoHalfReady = false; s->aoHalfSubst = false;
    s->zMipsBound = false; s->zMipsFrom = nullptr;
    s->profHaveTargets = false; s->profHavePaused = false; s->profCurPs = 0; // (a pass timed here was ended by the caller: ProfClose)
    s->dpLit = s->dpPs = s->dpBinding = false; s->dpLastDS = nullptr; // (the probe's counts were written by the caller: DPFlush)
    ProfForget(s); // one still open belongs to a context that is gone (a new context at a freed one's address)
    if (s->aoHalfGameRtv) { s->aoHalfGameRtv->Release(); s->aoHalfGameRtv = nullptr; }
    if (s->aoHalfGameT1) { s->aoHalfGameT1->Release(); s->aoHalfGameT1 = nullptr; }
}

// The copy of a rasterizer state with its slope-scaled depth bias multiplied by the factor, made the first time the state
// is used for the scaled texture (see SlopeBias at the top). A state without slope bias, or with fields the base
// description does not carry (forced sample count, conservative rasterization), is used as it is. Every original that
// gets an entry is held for the life of the process, so a state the game releases while a context still has to be given
// it back stays valid; the game makes a few hundred states at most.
static std::mutex g_rsLock;
static std::unordered_map<ID3D11RasterizerState *, ID3D11RasterizerState *> g_rsScaled;
static std::atomic<int> g_rsCopies{ 0 };
static ID3D11RasterizerState *ScaledRS(ID3D11RasterizerState *rs, float factor)
{
    if (!rs) return nullptr;
    std::lock_guard<std::mutex> lock(g_rsLock);
    const auto it = g_rsScaled.find(rs);
    if (it != g_rsScaled.end()) return it->second;
    ID3D11RasterizerState *use = rs;
    D3D11_RASTERIZER_DESC d = {};
    rs->GetDesc(&d);
    if (d.SlopeScaledDepthBias != 0)
    {
        bool extended = false;
        ID3D11RasterizerState1 *r1 = nullptr;
        if (SUCCEEDED(rs->QueryInterface(__uuidof(ID3D11RasterizerState1), (void **)&r1)) && r1) { D3D11_RASTERIZER_DESC1 d1 = {}; r1->GetDesc1(&d1); extended |= d1.ForcedSampleCount != 0; r1->Release(); }
        ID3D11RasterizerState2 *r2 = nullptr;
        if (SUCCEEDED(rs->QueryInterface(__uuidof(ID3D11RasterizerState2), (void **)&r2)) && r2) { D3D11_RASTERIZER_DESC2 d2 = {}; r2->GetDesc2(&d2); extended |= d2.ConservativeRaster != D3D11_CONSERVATIVE_RASTERIZATION_MODE_OFF; r2->Release(); }
        ID3D11Device *dev = nullptr;
        rs->GetDevice(&dev);
        const float slope = d.SlopeScaledDepthBias;
        d.SlopeScaledDepthBias = slope * factor;
        ID3D11RasterizerState *made = nullptr;
        const HRESULT hr = extended || !dev ? E_FAIL : dev->CreateRasterizerState(&d, &made);
        if (SUCCEEDED(hr) && made) use = made;
        if (dev) dev->Release();
        if (g_rsCopies++ < 16)
            Log("rasterizer state %p (depth bias %d, clamp %g, slope %g): %s", (void *)rs, d.DepthBias, d.DepthBiasClamp, slope,
                use != rs ? "copy with the slope bias scaled" : extended ? "extended state, left as it is" : "copy failed, left as it is");
    }
    rs->AddRef();
    g_rsScaled.emplace(rs, use);
    return use;
}

static bool Tagged(ID3D11DeviceChild *obj, float *factor)
{
    UINT size = sizeof(float);
    return obj && SUCCEEDED(obj->GetPrivateData(kScaledTag, &size, factor)) && size == sizeof(float);
}

static LONG Scale(LONG v, float f) { return (LONG)std::lround(v * f); }

// Layers: with ReShade installed, the game's device and contexts are ReShade's wrappers, and a wrapper calls the
// runtime object it wraps. The game also creates a device ReShade does not wrap, and hooking that one patches the
// runtime's own device class, which sits under ReShade's wrappers too (every call is then handled twice: the
// viewports scaled 12.25 times, the shadow map empty). So a hook that finds itself inside
// another of these hooks on the same thread only passes the call on: the outermost layer, the one the game called,
// does the work.
static thread_local int t_hookDepth = 0;
struct HookScope
{
    const bool outer;
    HookScope() : outer(t_hookDepth == 0) { t_hookDepth++; }
    ~HookScope() { t_hookDepth--; }
};

// ---- CPU profile (ini CpuProfile=<seconds>, 0 = off, the default): the CPU time the game's calls spend in this DLL's
// context hooks. Per hook: the calls per frame, the time per frame in the hook, and the part of it in the call passed on
// (the runtime, ReShade's layer, an inner hook); the rest is this DLL's own work. Timed with the processor's time stamp
// counter on the outermost layer only (the hook the game called), summed over every thread; a line every <seconds>.
enum CpuHook : int { kCpuPSSetShader, kCpuPSSRV, kCpuVSSetShader, kCpuCSSetShader, kCpuOMSet, kCpuOMSetUAV, kCpuBlend, kCpuViewports,
    kCpuScissors, kCpuGetViewports, kCpuGetScissors, kCpuRSSet, kCpuRSGet, kCpuClearState, kCpuExecute, kCpuFinish, kCpuHooks };
static const char *const kCpuNames[kCpuHooks] = { "PSSetShader", "PSSetShaderResources", "VSSetShader", "CSSetShader", "OMSetRenderTargets",
    "OMSetRenderTargetsAndUAVs", "OMSetBlendState", "RSSetViewports", "RSSetScissorRects", "RSGetViewports", "RSGetScissorRects", "RSSetState",
    "RSGetState", "ClearState", "ExecuteCommandList", "FinishCommandList" };
static std::atomic<uint64_t> g_cpuCalls[kCpuHooks], g_cpuTicks[kCpuHooks], g_cpuOrigTicks[kCpuHooks];
struct CpuScope
{
    const int k;
    uint64_t t0 = 0, orig = 0;
    explicit CpuScope(int kind) : k(kind) { if (g_cpuProfile && t_hookDepth == 0) t0 = __rdtsc(); } // (made before the hook's HookScope)
    ~CpuScope()
    {
        if (!t0) return;
        const uint64_t t = __rdtsc() - t0;
        g_cpuCalls[k].fetch_add(1, std::memory_order_relaxed);
        g_cpuTicks[k].fetch_add(t, std::memory_order_relaxed);
        g_cpuOrigTicks[k].fetch_add(orig, std::memory_order_relaxed);
    }
    // the call passed on, timed apart
    template <class F> void Orig(F f)
    {
        if (!t0) { f(); return; }
        const uint64_t a = __rdtsc();
        f();
        orig += __rdtsc() - a;
    }
};
// Present: the frame counted, and the line when its interval is over (the counter's rate from the performance counter)
static void CpuFrame()
{
    static uint64_t frames = 0, tsc0 = 0;
    static LARGE_INTEGER qpc0 = {}, freq = {};
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    const uint64_t tsc = __rdtsc();
    if (!freq.QuadPart) { QueryPerformanceFrequency(&freq); qpc0 = now; tsc0 = tsc; for (int k = 0; k < kCpuHooks; k++) { g_cpuCalls[k] = 0; g_cpuTicks[k] = 0; g_cpuOrigTicks[k] = 0; } return; }
    frames++;
    const double secs = (double)(now.QuadPart - qpc0.QuadPart) / (double)freq.QuadPart;
    if (secs < g_cpuProfile || !frames) return;
    const double msPerTick = secs * 1000.0 / (double)(tsc - tsc0);
    char line[2048];
    double all = 0, own = 0;
    int at = 0;
    for (int k = 0; k < kCpuHooks; k++)
    {
        const uint64_t calls = g_cpuCalls[k].exchange(0), ticks = g_cpuTicks[k].exchange(0), orig = g_cpuOrigTicks[k].exchange(0);
        if (!calls) continue;
        const double ms = ticks * msPerTick / frames, mine = (ticks - (orig < ticks ? orig : ticks)) * msPerTick / frames;
        all += ms; own += mine;
        if (at >= 0 && at < (int)sizeof line)
            at += snprintf(line + at, sizeof line - at, "%s %s %.0f calls %.3f ms (own %.3f)", at ? "," : "", kCpuNames[k], (double)calls / frames, ms, mine);
    }
    Log("cpu: per frame over %llu frames: %.3f ms in the hooks, %.3f ms of it this DLL's own work:%s", (unsigned long long)frames, all, own, at > 0 ? line : " no calls");
    frames = 0; qpc0 = now; tsc0 = tsc;
}

// ---- thread load (ini CpuThreads=<seconds>, 0 = off, the default): which of the game's threads keep a frame waiting.
// Every <seconds>, each thread's CPU cycles (QueryThreadCycleTime) since the last line, per frame and as a share of the
// time; the thread that calls Present and those that finish command lists (the recording threads) are marked, with the
// name the game gave a thread if any. A thread near 100 % sets the frame rate when the GPU waits.
static std::atomic<DWORD> g_presentThread{ 0 };
static std::atomic<uint64_t> g_presentWait{ 0 };           // performance-counter ticks spent inside the real Present since the last line
static const int kListThreads = 32;
static std::atomic<DWORD> g_listThreads[kListThreads];   // the threads seen finishing command lists
static void NoteListThread(DWORD id)
{
    for (auto &t : g_listThreads)
    {
        DWORD cur = t.load(std::memory_order_relaxed);
        if (cur == id) return;
        if (cur == 0 && t.compare_exchange_strong(cur, id)) return;
        if (cur == id) return;
    }
}
typedef HRESULT(WINAPI *PFN_GetThreadDescription)(HANDLE, PWSTR *);
static void ThreadTick()
{
    struct Sample { DWORD id; ULONG64 cycles; };
    static std::vector<Sample> prev;
    static uint64_t tsc0 = 0, frames = 0;
    static LARGE_INTEGER qpc0 = {}, freq = {};
    static PFN_GetThreadDescription describe = (PFN_GetThreadDescription)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "GetThreadDescription");
    g_presentThread.store(GetCurrentThreadId(), std::memory_order_relaxed);
    frames++;
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
    const double secs = qpc0.QuadPart ? (double)(now.QuadPart - qpc0.QuadPart) / (double)freq.QuadPart : 0;
    if (qpc0.QuadPart && secs < g_cpuThreads) return;
    const uint64_t tsc = __rdtsc();
    std::vector<Sample> cur;
    const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return;
    THREADENTRY32 te = { sizeof te };
    const DWORD pid = GetCurrentProcessId();
    struct Row { double share, ms; DWORD id; std::wstring name; };
    std::vector<Row> rows;
    const double msPerTick = qpc0.QuadPart && tsc > tsc0 ? secs * 1000.0 / (double)(tsc - tsc0) : 0;
    for (BOOL ok = Thread32First(snap, &te); ok; ok = Thread32Next(snap, &te))
    {
        if (te.th32OwnerProcessID != pid) continue;
        const HANDLE h = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, te.th32ThreadID);
        if (!h) continue;
        ULONG64 cycles = 0;
        if (QueryThreadCycleTime(h, &cycles))
        {
            cur.push_back({ te.th32ThreadID, cycles });
            for (const Sample &p : prev)
                if (p.id == te.th32ThreadID && cycles >= p.cycles && msPerTick > 0 && frames)
                {
                    Row r = { (double)(cycles - p.cycles) / (double)(tsc - tsc0), (double)(cycles - p.cycles) * msPerTick / frames, te.th32ThreadID, L"" };
                    PWSTR name = nullptr;
                    if (r.share >= 0.02 && describe && SUCCEEDED(describe(h, &name)) && name) { r.name = name; LocalFree(name); }
                    rows.push_back(r);
                }
        }
        CloseHandle(h);
    }
    CloseHandle(snap);
    if (!rows.empty())
    {
        std::sort(rows.begin(), rows.end(), [](const Row &a, const Row &b) { return a.share > b.share; });
        char line[3072];
        int at = snprintf(line, sizeof line, "threads: %.1f s, %llu frames (%.2f ms each), CPU ms per frame and share of the time:", secs, (unsigned long long)frames, secs * 1000.0 / frames);
        double total = 0;
        for (const Row &r : rows) total += r.ms;
        for (size_t i = 0; i < rows.size() && i < 14 && rows[i].share >= 0.02 && at > 0 && at < (int)sizeof line; i++)
        {
            const Row &r = rows[i];
            bool list = false;
            for (auto &t : g_listThreads) list |= t.load(std::memory_order_relaxed) == r.id;
            char name[80] = {};
            if (!r.name.empty()) WideCharToMultiByte(CP_UTF8, 0, r.name.c_str(), -1, name, sizeof name - 1, nullptr, nullptr);
            at += snprintf(line + at, sizeof line - at, "%s %.2f ms %.0f %% tid %lu%s%s%s%s%s", i ? "," : "", r.ms, r.share * 100.0, (unsigned long)r.id,
                r.id == g_presentThread.load(std::memory_order_relaxed) ? " Present" : "", list ? " lists" : "", name[0] ? " '" : "", name, name[0] ? "'" : "");
        }
        Log("%s; all %zu threads %.2f ms per frame; Present itself waited %.2f ms per frame", line, rows.size(), total,
            frames ? (double)g_presentWait.load() * 1000.0 / (double)freq.QuadPart / frames : 0.0);
    }
    prev = cur;
    tsc0 = tsc; qpc0 = now; frames = 0;
    g_presentWait.store(0);
}
// ---- memory log (ini MemLog=<seconds>, 0 = off, the default): the game's calls to VirtualAlloc (its import
// from kernel32, patched): every reserve of 16 MB or more with its size and call chain (offsets into SnowRunner.exe), every
// failure, and every <seconds> how much each of those regions has committed. For the texture streamer's fixed region
// (streaming2\strm2_texmem_mng.cpp reports "Page reserve failed." and "Page commit failed."): which region it is, its
// size, and whose code sizes it. Watches only.
typedef LPVOID(WINAPI *PFN_VirtualAlloc)(LPVOID, SIZE_T, DWORD, DWORD);
static PFN_VirtualAlloc g_realVirtualAlloc = nullptr;
struct MemRegion { uintptr_t base; SIZE_T size; uint64_t committed, commits; void *chain[8]; USHORT frames; };
static const int kMemRegions = 128;
static MemRegion g_memRegions[kMemRegions];
static int g_memRegionCount = 0;
static std::mutex g_memLock;                        // the regions
static std::atomic<int> g_memFailLines{ 0 };
static uintptr_t g_exeBase = 0, g_exeEnd = 0;
// an address as "exe+0x..." (the game's code) or "module+0x..." (the first eight characters of a DLL's name)
static void MemWhere(void *a, char *out, size_t size)
{
    const uintptr_t p = (uintptr_t)a;
    if (p >= g_exeBase && p < g_exeEnd) { snprintf(out, size, "exe+0x%llx", (unsigned long long)(p - g_exeBase)); return; }
    HMODULE m = nullptr;
    wchar_t name[MAX_PATH] = {};
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)a, &m) && m && GetModuleFileNameW(m, name, MAX_PATH))
    {
        const wchar_t *n = wcsrchr(name, L'\\');
        snprintf(out, size, "%.8ls+0x%llx", n ? n + 1 : name, (unsigned long long)(p - (uintptr_t)m));
        return;
    }
    snprintf(out, size, "0x%llx", (unsigned long long)p);
}
static void MemChain(void *const *frames, USHORT n, char *out, size_t size)
{
    int at = 0;
    for (USHORT i = 0; i < n && at >= 0 && at < (int)size; i++)
    {
        char w[64];
        MemWhere(frames[i], w, sizeof w);
        at += snprintf(out + at, size - at, "%s%s", i ? " < " : "", w);
    }
}
static LPVOID WINAPI Hook_VirtualAlloc(LPVOID addr, SIZE_T size, DWORD type, DWORD protect)
{
    const LPVOID r = g_realVirtualAlloc(addr, size, type, protect);
    const bool reserve = (type & MEM_RESERVE) != 0, commit = (type & MEM_COMMIT) != 0;
    if (reserve && size >= (16u << 20) && r)
    {
        MemRegion g = {};
        g.base = (uintptr_t)r; g.size = size;
        g.frames = RtlCaptureStackBackTrace(1, 8, g.chain, nullptr);
        if (commit) { g.committed = size; g.commits = 1; }
        char chain[640];
        MemChain(g.chain, g.frames, chain, sizeof chain);
        {
            std::lock_guard<std::mutex> lock(g_memLock);
            if (g_memRegionCount < kMemRegions) g_memRegions[g_memRegionCount++] = g;
        }
        Log("mem: reserve %.1f MB at %p (%s%s, protect 0x%lx) from %s", size / 1048576.0, r, commit ? "reserve+commit" : "reserve", (type & MEM_LARGE_PAGES) ? ", large pages" : "",
            protect, chain);
    }
    else if (commit && !reserve && addr && r)
    {
        std::lock_guard<std::mutex> lock(g_memLock);
        for (int i = 0; i < g_memRegionCount; i++)
            if ((uintptr_t)addr >= g_memRegions[i].base && (uintptr_t)addr < g_memRegions[i].base + g_memRegions[i].size) { g_memRegions[i].committed += size; g_memRegions[i].commits++; break; }
    }
    if (!r && g_memFailLines++ < 64)
    {
        void *frames[8];
        const USHORT n = RtlCaptureStackBackTrace(1, 8, frames, nullptr);
        char chain[640];
        MemChain(frames, n, chain, sizeof chain);
        int region = -1;
        {
            std::lock_guard<std::mutex> lock(g_memLock);
            for (int i = 0; i < g_memRegionCount && addr; i++)
                if ((uintptr_t)addr >= g_memRegions[i].base && (uintptr_t)addr < g_memRegions[i].base + g_memRegions[i].size) region = i;
        }
        Log("mem: VirtualAlloc FAILED (error %lu): %.2f MB at %p, type 0x%lx, protect 0x%lx%s from %s", GetLastError(), size / 1048576.0, addr, type, protect,
            region >= 0 ? " (inside a logged region)" : "", chain);
    }
    return r;
}
// Present: every <seconds>, the regions that have commits, with how much of each is committed (commits the game frees
// again are not seen: the numbers are what it asked for)
static void MemTick()
{
    static ULONGLONG last = 0;
    const ULONGLONG now = GetTickCount64();
    if (last && now - last < g_memLog * 1000ULL) return;
    last = now;
    std::lock_guard<std::mutex> lock(g_memLock);
    for (int i = 0; i < g_memRegionCount; i++)
    {
        const MemRegion &g = g_memRegions[i];
        if (g.commits < 2) continue;
        char where[64] = "?";
        if (g.frames) MemWhere(g.chain[0], where, sizeof where);
        Log("mem: region %d at 0x%llx, %.1f MB reserved from %s: %llu commits, %.1f MB asked", i, (unsigned long long)g.base, g.size / 1048576.0, where,
            (unsigned long long)g.commits, g.committed / 1048576.0);
    }
}

// the real Present, timed for the thread load line (how long the game's render thread waits in it)
template <class F> static HRESULT TimedPresent(F f)
{
    if (!g_cpuThreads) return f();
    LARGE_INTEGER a, b;
    QueryPerformanceCounter(&a);
    const HRESULT hr = f();
    QueryPerformanceCounter(&b);
    g_presentWait.fetch_add((uint64_t)(b.QuadPart - a.QuadPart), std::memory_order_relaxed);
    return hr;
}

static void ApplyScaled(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    if (!s->viewports.empty())
    {
        std::vector<D3D11_VIEWPORT> v = s->viewports;
        for (D3D11_VIEWPORT &x : v) { x.TopLeftX *= s->factor; x.TopLeftY *= s->factor; x.Width *= s->factor; x.Height *= s->factor; }
        o->setViewports(ctx, (UINT)v.size(), v.data());
    }
    if (!s->scissors.empty())
    {
        std::vector<D3D11_RECT> r = s->scissors;
        for (D3D11_RECT &x : r) { x.left = Scale(x.left, s->factor); x.top = Scale(x.top, s->factor); x.right = Scale(x.right, s->factor); x.bottom = Scale(x.bottom, s->factor); }
        o->setScissors(ctx, (UINT)r.size(), r.data());
    }
    s->scaled = true;
}

static void RestoreOriginal(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    o->setViewports(ctx, (UINT)s->viewports.size(), s->viewports.empty() ? nullptr : s->viewports.data());
    o->setScissors(ctx, (UINT)s->scissors.size(), s->scissors.empty() ? nullptr : s->scissors.data());
    s->scaled = false;
    g_restores++;
}

static void DepthTargetChanged(ID3D11DeviceContext *ctx, const ContextOrig *o, ID3D11DepthStencilView *dsv, UINT rtvs)
{
    ContextState *s = State(ctx);
    float f = 1;
    if (Tagged(dsv, &f))
    {
        // tagged x1 (the GPU timers at factor 1, TagForTimers): the shadow pass is timed and nothing else happens (no
        // atlas state, so the viewport, scissor and rasterizer hooks leave the calls alone); the timing ends in the else
        if (f <= 1)
        {
            if (g_gpuTimers && !s->gpuShadow) s->gpuShadow = GpuBegin(ctx, kGpuShadows);
            return;
        }
        if (g_trace)
        {
            const D3D11_VIEWPORT v = s->viewports.empty() ? D3D11_VIEWPORT{} : s->viewports[0];
            const D3D11_RECT r = s->scissors.empty() ? D3D11_RECT{} : s->scissors[0];
            D3D11_DEPTH_STENCIL_VIEW_DESC vd = {};
            dsv->GetDesc(&vd);
            Trace("BIND ctx %p rtvs %u, dsv %p (flags %u), set before: vp %g %g %g %g (%zu), sc %ld %ld %ld %ld (%zu)%s", (void *)ctx, rtvs, (void *)dsv, vd.Flags,
                v.TopLeftX, v.TopLeftY, v.Width, v.Height, s->viewports.size(), r.left, r.top, r.right, r.bottom, s->scissors.size(), s->atlas ? " [already bound]" : "");
            s->listBinds++;
            s->lastVS = s->lastPS = s->lastRS = s->lastDS = nullptr;
        }
        s->atlas = true;
        s->factor = f;
        s->draws = 0;
        g_atlasBinds++;
        if (g_gpuTimers && !s->gpuShadow) s->gpuShadow = GpuBegin(ctx, kGpuShadows);
        if (g_bindLines < 12)
        {
            g_bindLines++;
            const D3D11_VIEWPORT v = s->viewports.empty() ? D3D11_VIEWPORT{} : s->viewports[0];
            Log("shadow texture bound on context %p: viewport %g %g %g %g -> x%g", (void *)ctx, v.TopLeftX, v.TopLeftY, v.Width, v.Height, f);
        }
        ApplyScaled(ctx, o, s);
        if (g_slopeBias && s->rs) { o->setRS(ctx, ScaledRS(s->rs, f)); s->rsScaled = true; }
    }
    else
    {
        if (g_trace && s->atlas) Trace("UNBIND ctx %p after %u draws, new rtvs %u, dsv %p", (void *)ctx, s->draws, rtvs, (void *)dsv);
        if (s->gpuShadow) GpuEnd(ctx, s->gpuShadow);
        if (s->scaled) RestoreOriginal(ctx, o, s);
        if (s->rsScaled) { o->setRS(ctx, s->rs); s->rsScaled = false; }
        s->atlas = false;
    }
}

// ---- scene feed (see the top): the previous frame's lit scene and linear depth for shaders that declare t120

// What a pixel shader is to the feed, from its code: the ambient occlusion pass (textures named g_txDither and
// g_txFactor in its resource table; kFeedGIWrites too when it declares output o1), the AO apply pass (texture g_txMask,
// no g_txDither, and the constant g_vSSAOColor), a reader of the feed (dcl_resource at t120 or t121) and/or a reader of
// the bounce light (dcl_resource at t122); for the reflections, a writer of output 7 and a reader of t123 or t124.
static uint32_t FeedFlags(const void *code, SIZE_T size)
{
    const uint8_t *b = (const uint8_t *)code;
    if (!b || size < 32 || memcmp(b, "DXBC", 4) != 0) return 0;
    uint32_t chunks = 0, flags = 0;
    bool dither = false, factor = false, mask = false, ssaoColour = false, output1 = false, planarRefl = false, opaque = false, fogColour = false, zMS = false;
    memcpy(&chunks, b + 28, 4);
    for (uint32_t i = 0; i < chunks && 32 + (size_t)i * 4 + 4 <= size; i++)
    {
        uint32_t at = 0, len = 0;
        memcpy(&at, b + 32 + i * 4, 4);
        if ((size_t)at + 8 > size) continue;
        memcpy(&len, b + at + 4, 4);
        if ((size_t)at + 8 + len > size) continue;
        const uint8_t *c = b + at + 8;
        if (!memcmp(b + at, "RDEF", 4) && len >= 16)
        {
            uint32_t count = 0, table = 0;
            memcpy(&count, c + 8, 4);
            memcpy(&table, c + 12, 4);
            for (uint32_t k = 0; k < count && (size_t)table + k * 32 + 32 <= len; k++)
            {
                uint32_t name = 0, type = 0;
                memcpy(&name, c + table + k * 32, 4);
                memcpy(&type, c + table + k * 32 + 4, 4);
                if (type != 2 || name >= len) continue; // textures only
                const char *s = (const char *)c + name;
                const size_t room = len - name;
                if (strnlen(s, room) == room) continue;
                dither |= strcmp(s, "g_txDither") == 0;
                factor |= strcmp(s, "g_txFactor") == 0;
                mask |= strcmp(s, "g_txMask") == 0;
                planarRefl |= strcmp(s, "g_txReflections") == 0;
                opaque |= strcmp(s, "g_txBBOpaque") == 0;
                fogColour |= strcmp(s, "g_txFogColor") == 0;
                zMS |= strcmp(s, "g_txZMS") == 0;
                if (!strncmp(s, "PS_EDGE_AA_VELOCITY_TEX", 23)) flags |= kFeedTAA; // the game's TAA (4F5C33DA) reads the velocity under this name
            }
            // the constant's name sits in the chunk's string area
            static const char kColour[] = "g_vSSAOColor";
            for (uint32_t k = 0; k + sizeof kColour <= len && !ssaoColour; k++) ssaoColour = memcmp(c + k, kColour, sizeof kColour) == 0;
        }
        if ((!memcmp(b + at, "SHEX", 4) || !memcmp(b + at, "SHDR", 4)) && len >= 8)
        {
            const uint32_t *t = (const uint32_t *)c;
            const uint32_t words = t[1] < len / 4 ? t[1] : len / 4;
            for (uint32_t p = 2; p < words;)
            {
                const uint32_t tok = t[p], op = tok & 0x7ff;
                uint32_t n = (tok >> 24) & 0x7f;
                if (op == 53 && p + 1 < words) n = t[p + 1]; // customdata carries its length in the next token
                if (!n) break;
                if (op == 88 && p + 2 < words && (t[p + 2] == kFeedSlot || t[p + 2] == kFeedSlot + 1)) flags |= kFeedReads; // dcl_resource t120, t121
                if (op == 88 && p + 2 < words && t[p + 2] == kGISlot) flags |= kFeedGIReads;                               // dcl_resource t122
                if (op == 101 && p + 2 < words && t[p + 2] == 1) output1 = true;                                            // dcl_output o1
                if (op == 101 && p + 2 < words && t[p + 2] == kRT7) flags |= kFeedWritesO7;                                 // dcl_output o7
                if (op == 101 && p + 2 < words && t[p + 2] == kRT6) flags |= kFeedWritesO6;                                 // dcl_output o6
                if (op == 88 && p + 2 < words && (t[p + 2] == kSSRSlot || t[p + 2] == kSSRSlot + 1)) flags |= kFeedSSRReads; // t123, t124
                if (op == 88 && p + 2 < words && t[p + 2] == kHiZSlot) flags |= kFeedHiZReads;                             // t125
                if (op == 88 && p + 2 < words && t[p + 2] == kZMipsSlot) flags |= kFeedZMips;                              // t126
                if (op == 88 && p + 2 < words && (t[p + 2] == kFogSlot || t[p + 2] == kFogSlot + 1)) flags |= kFeedFogReads; // t118, t119
                p += n;
            }
        }
    }
    if (dither && factor) flags |= kFeedAO | (output1 ? kFeedGIWrites : 0);
    if (mask && !dither && ssaoColour) flags |= kFeedAOApply;
    if (planarRefl && opaque) flags |= kFeedWater;
    if (fogColour && zMS) flags |= kFeedFogComposite;
    return flags;
}

// The feed's two textures (0 scene colour, 1 linear depth) and their views, under g_feedLock; the views are also
// published for binding without the lock. A texture replaced after a size change is released a few replacements later,
// by when no binder can still be holding its old view pointer.
struct FeedTexture { ID3D11Texture2D *tex; ID3D11ShaderResourceView *srv; UINT w, h; DXGI_FORMAT fmt, view; UINT mips; };
static std::mutex g_feedLock;
static FeedTexture g_feedTex[2] = {};
static std::atomic<ID3D11ShaderResourceView *> g_feedView[2];
static std::vector<IUnknown *> g_feedRetired;
static std::atomic<uint64_t> g_feedCaptures{ 0 }, g_feedBinds{ 0 }, g_feedReaders{ 0 };
// the render targets the lighting pass wrote together: its g_txFactor target (render target 2) -> its colour target
// (render target 0) and that view's format, and its render target 1 and that view's format (only the dump saves it: in
// game it holds a clear colour by the time the AO pass runs); the resources held, under g_feedLock. Reflections:
// `confirmed` once an AO pass has read the g_txFactor target (so it is the lit pass indeed); then this DLL's render
// target 7 for it (its size). Contact shadows: render target 6 (the sun's visibility the receivers found) likewise, and
// the view this DLL draws the composite into the colour target through.
struct LitPass
{
    ID3D11Resource *factor, *colour, *normal;
    DXGI_FORMAT view, normalView;
    bool confirmed;
    ID3D11Texture2D *rt7;
    ID3D11RenderTargetView *rt7Rtv;
    ID3D11ShaderResourceView *rt7Srv;
    ID3D11Texture2D *rt6;
    ID3D11RenderTargetView *rt6Rtv;
    ID3D11ShaderResourceView *rt6Srv;
    ID3D11RenderTargetView *colourRtv; // made for `colour` (as `view`) by ContactRun; remade when the colour target changes
    ID3D11Resource *colourRtvOf;
};
static std::vector<LitPass> g_litPasses;
static void ReleaseLitPass(LitPass &p)
{
    for (IUnknown *u : { (IUnknown *)p.factor, (IUnknown *)p.colour, (IUnknown *)p.normal, (IUnknown *)p.rt7, (IUnknown *)p.rt7Rtv, (IUnknown *)p.rt7Srv,
                         (IUnknown *)p.rt6, (IUnknown *)p.rt6Rtv, (IUnknown *)p.rt6Srv, (IUnknown *)p.colourRtv })
        if (u) u->Release();
}
static void ProbeLitPass(ID3D11RenderTargetView *const *rtvs); // reflections: the formats, once
static bool Desc2D(ID3D11Resource *r, D3D11_TEXTURE2D_DESC *d);
static bool RT7Wanted();
static void ProbeEvent(ID3D11DeviceContext *ctx, ContextState *s, const char *fmt, ...);
static bool ProbeOn();
static bool ContactWanted();
static void ContactMakeRT6(LitPass &p, ID3D11DeviceContext *ctx);
static void ContactRun(ID3D11DeviceContext *ctx, ContextState *s, ID3D11Resource *factor);
static bool SSRPassWanted();
static void SSRMakeRT7(LitPass &p, ID3D11DeviceContext *ctx);
static void SSRRun(ID3D11DeviceContext *ctx, ContextState *s, ID3D11Resource *factor);

static void RememberLitPass(ID3D11RenderTargetView *colourRtv, ID3D11RenderTargetView *normalRtv, ID3D11RenderTargetView *factorRtv)
{
    ID3D11Resource *factor = nullptr, *colour = nullptr, *normal = nullptr;
    factorRtv->GetResource(&factor);
    colourRtv->GetResource(&colour);
    if (normalRtv) normalRtv->GetResource(&normal);
    D3D11_RENDER_TARGET_VIEW_DESC v = {}, nv = {};
    colourRtv->GetDesc(&v);
    if (normalRtv) normalRtv->GetDesc(&nv);
    std::lock_guard<std::mutex> lock(g_feedLock);
    for (LitPass &p : g_litPasses)
    {
        if (p.factor != factor) continue;
        std::swap(p.colour, colour);
        std::swap(p.normal, normal);
        p.view = v.Format;
        p.normalView = nv.Format;
        factor->Release();
        colour->Release();
        if (normal) normal->Release();
        return;
    }
    if (g_litPasses.size() >= 8) { ReleaseLitPass(g_litPasses.front()); g_litPasses.erase(g_litPasses.begin()); }
    LitPass p = {};
    p.factor = factor; p.colour = colour; p.normal = normal; p.view = v.Format; p.normalView = nv.Format;
    g_litPasses.push_back(p);
}

// under g_feedLock: feed texture i, (re)made to take src (its size; its format, or the view format when src is
// multisampled and has to be resolved), viewed as `view`
static bool FeedTarget(int i, ID3D11Texture2D *src, DXGI_FORMAT view)
{
    D3D11_TEXTURE2D_DESC d = {};
    src->GetDesc(&d);
    const DXGI_FORMAT fmt = d.SampleDesc.Count > 1 ? view : d.Format;
    FeedTexture &f = g_feedTex[i];
    if (f.tex && f.w == d.Width && f.h == d.Height && f.fmt == fmt && f.view == view) return true;
    ID3D11Device *dev = nullptr;
    src->GetDevice(&dev);
    if (!dev) return false;
    // the colour copy gets a full mip chain (ini FeedMips) when the format can generate one: a shader may then sample a
    // blurred previous frame for rougher reflections; the depth copy stays one level
    UINT support = 0;
    if (i == 0 && g_feedMips) dev->CheckFormatSupport(fmt, &support);
    const bool mips = i == 0 && g_feedMips && (support & D3D11_FORMAT_SUPPORT_MIP_AUTOGEN) && (support & D3D11_FORMAT_SUPPORT_RENDER_TARGET);
    UINT levels = 1;
    if (mips) for (UINT s = d.Width > d.Height ? d.Width : d.Height; s > 1; s >>= 1) levels++;
    D3D11_TEXTURE2D_DESC n = {};
    n.Width = d.Width; n.Height = d.Height; n.MipLevels = levels; n.ArraySize = 1; n.Format = fmt; n.SampleDesc.Count = 1;
    n.Usage = D3D11_USAGE_DEFAULT; n.BindFlags = D3D11_BIND_SHADER_RESOURCE | (mips ? D3D11_BIND_RENDER_TARGET : 0);
    n.MiscFlags = mips ? D3D11_RESOURCE_MISC_GENERATE_MIPS : 0;
    ID3D11Texture2D *tex = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;
    HRESULT hr = dev->CreateTexture2D(&n, nullptr, &tex);
    if (SUCCEEDED(hr))
    {
        D3D11_SHADER_RESOURCE_VIEW_DESC v = {};
        v.Format = view; v.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; v.Texture2D.MipLevels = levels;
        hr = dev->CreateShaderResourceView(tex, &v, &srv);
    }
    dev->Release();
    if (FAILED(hr))
    {
        if (tex) tex->Release();
        Log("scene feed: %s texture %u x %u (format %u, view %u) could not be made (0x%08lX)", i ? "depth" : "colour", d.Width, d.Height, (unsigned)fmt, (unsigned)view, (unsigned long)hr);
        return false;
    }
    if (f.tex) { g_feedRetired.push_back(f.tex); g_feedRetired.push_back(f.srv); }
    while (g_feedRetired.size() > 12) { g_feedRetired.front()->Release(); g_feedRetired.erase(g_feedRetired.begin()); }
    f = { tex, srv, d.Width, d.Height, fmt, view, levels };
    g_feedView[i].store(srv, std::memory_order_release);
    Log("scene feed: %s texture %u x %u, format %u, view %u, %u mip level(s)%s", i ? "depth" : "colour", d.Width, d.Height, (unsigned)fmt, (unsigned)view, levels,
        d.SampleDesc.Count > 1 ? " (the scene is multisampled: resolved into it)" : "");
    return true;
}

// the AO pass is set up with its inputs bound: copy the lit scene and the linear depth, once for this setting (only
// when a shader that reads the feed exists: with none installed the copies would be wasted)
static void FeedCapture(ID3D11DeviceContext *ctx, ContextState *s)
{
    const bool feed = g_feedReaders.load(std::memory_order_relaxed) > 0 || SSRPassWanted(), contact = ContactWanted();
    if (!s->aoFactor || !s->aoZ || (!feed && !contact)) return;
    s->captured = true;
    // GPU timers: the AO pass timed from its shader on pauses for the copy and the reflection pass (timed on their own)
    const bool resumeAO = s->gpuPass != nullptr;
    if (resumeAO) GpuEnd(ctx, s->gpuPass);
    bool copied = false;
    ID3D11Resource *factor = nullptr, *z = nullptr;
    s->aoFactor->GetResource(&factor);
    s->aoZ->GetResource(&z);
    D3D11_SHADER_RESOURCE_VIEW_DESC zv = {};
    s->aoZ->GetDesc(&zv);
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        ID3D11Texture2D *colour = nullptr, *depth = nullptr;
        DXGI_FORMAT colourView = DXGI_FORMAT_UNKNOWN;
        for (LitPass &p : g_litPasses)
            if (p.factor == factor)
            {
                p.colour->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&colour);
                colourView = p.view;
                p.confirmed = true; // an AO pass reads its g_txFactor target: the lit pass indeed
                if (RT7Wanted()) SSRMakeRT7(p, ctx);
                if (contact) ContactMakeRT6(p, ctx);
            }
        if (z) z->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&depth);
        if (feed && colour && depth && FeedTarget(0, colour, colourView) && FeedTarget(1, depth, zv.Format))
        {
            D3D11_TEXTURE2D_DESC cd = {}, zd = {};
            colour->GetDesc(&cd);
            depth->GetDesc(&zd);
            GpuTimer *timer = g_gpuTimers ? GpuBegin(ctx, kGpuFeed) : nullptr;
            ProfOurs(ctx, s, kProfFeed);
            if (cd.SampleDesc.Count > 1) ctx->ResolveSubresource(g_feedTex[0].tex, 0, colour, 0, colourView);
            else if (g_feedTex[0].mips > 1) ctx->CopySubresourceRegion(g_feedTex[0].tex, 0, 0, 0, 0, colour, 0, nullptr); // into level 0 (the mip counts differ)
            else ctx->CopyResource(g_feedTex[0].tex, colour);
            if (g_feedTex[0].mips > 1) ctx->GenerateMips(g_feedTex[0].srv);
            if (zd.SampleDesc.Count > 1) ctx->ResolveSubresource(g_feedTex[1].tex, 0, depth, 0, zv.Format); else ctx->CopyResource(g_feedTex[1].tex, depth);
            if (timer) GpuEnd(ctx, timer);
            ProfResume(ctx, s);
            if (g_feedCaptures++ == 0) Log("scene feed: first copy of the lit scene and its depth (on context %p)", (void *)ctx);
            copied = true;
        }
        else if (feed && g_feedCaptures == 0 && !colour)
        {
            static std::atomic<int> said{ 0 };
            if (said++ == 0) Log("scene feed: the AO pass is set up, but no lighting pass wrote its g_txFactor target yet");
        }
        if (colour) colour->Release();
        if (depth) depth->Release();
    }
    if (copied && SSRPassWanted()) { ProfOurs(ctx, s, kProfSSR); SSRRun(ctx, s, factor); ProfResume(ctx, s); } // the reflections, from this frame's copies (before a dump records them)
    if (contact) { ProfOurs(ctx, s, kProfContact); ContactRun(ctx, s, factor); ProfResume(ctx, s); }             // contact shadows (after the copies: the reflections see the scene without them)
    if (resumeAO) s->gpuPass = GpuBegin(ctx, kGpuAO);
    if (factor) factor->Release();
    if (z) z->Release();
    if (copied)
    {
        ULONGLONG none = 0;
        g_dumpFirstAO.compare_exchange_strong(none, GetTickCount64());
        if (g_dumpState.load(std::memory_order_relaxed) == kDumpRequested) DumpInputs(ctx, s);
    }
}

// a shader that reads the feed is set (or the game reset its slots): bind the feed at t120 and t121. With the puddle
// reflections switched off (F9) the scene colour is withheld from every reader but the AO pass (the bounce light gathers
// from it); the puddle helper then keeps the stock cubemap sample.
static void FeedBind(ID3D11DeviceContext *ctx, const ContextOrig *o, uint32_t flags)
{
    ID3D11ShaderResourceView *v[2] = { g_feedView[0].load(std::memory_order_acquire), g_feedView[1].load(std::memory_order_acquire) };
    if (!v[0] || !v[1]) return;
    if (!(flags & kFeedAO) && !g_puddlesOn.load(std::memory_order_relaxed)) v[0] = nullptr;
    o->psSRV(ctx, kFeedSlot, 2, v);
    g_feedBinds++;
}

// ---- the volumetric fog for the water's reflections
// The game's volumetric fog is applied after the water, by a full-screen composite (0x124778F2 / 0x99641654): o0 =
// saturate((depth - g_fStartDepth) / 52) x g_fDensity x (g_txFogColor at t1 .rgb, g_txFogMask at t2 .x), blended over the
// frame. What the water reflects comes from the scene before it, so a hazy shore mirrors dark and clear. At each draw of
// the composite its two inputs are kept and its CB_INSTANCE copied (on the GPU) into g_fogCB; a shader that declares
// t118/t119 (the water's reflection helper) gets them at t118, t119 and b13 when it is set, and again when the game
// resets those slots under it. The water drawn before the composite in a frame reads the textures as the fog pass left
// them and the constants of the composite's previous draw.
static std::atomic<ID3D11ShaderResourceView *> g_fogView[2];
static ID3D11Buffer *g_fogCB = nullptr;
static std::mutex g_fogLock;
static std::atomic<uint64_t> g_fogCaptures{ 0 }, g_fogBinds{ 0 };
static void FogCapture(ID3D11DeviceContext *ctx)
{
    if (!g_fogRefl) return;
    ID3D11ShaderResourceView *v[2] = {};
    ID3D11Buffer *cb = nullptr;
    ctx->PSGetShaderResources(1, 2, v);
    ctx->PSGetConstantBuffers(4, 1, &cb);
    static std::atomic<int> logs{ 0 };
    if (logs++ < 4) Log("fog: composite draw on ctx %p (%s): t1 %p, t2 %p, b4 %p", (void *)ctx, ctx->GetType() == D3D11_DEVICE_CONTEXT_IMMEDIATE ? "immediate" : "deferred", (void *)v[0], (void *)v[1], (void *)cb);
    if (v[0] && v[1] && cb)
    {
        std::lock_guard<std::mutex> lock(g_fogLock);
        if (!g_fogCB)
        {
            ID3D11Device *dev = nullptr;
            ctx->GetDevice(&dev);
            D3D11_BUFFER_DESC d = { 144, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
            if (dev) { dev->CreateBuffer(&d, nullptr, &g_fogCB); dev->Release(); }
        }
        D3D11_BUFFER_DESC have = {};
        cb->GetDesc(&have);
        if (g_fogCB && have.ByteWidth >= 144)
        {
            const D3D11_BOX box = { 0, 0, 0, 144, 1, 1 };
            ctx->CopySubresourceRegion(g_fogCB, 0, 0, 0, 0, cb, 0, &box);
            for (int i = 0; i < 2; i++)
            {
                v[i]->AddRef();
                if (ID3D11ShaderResourceView *old = g_fogView[i].exchange(v[i], std::memory_order_acq_rel)) old->Release();
            }
            g_fogCaptures++;
        }
    }
    for (auto *x : v) if (x) x->Release();
    if (cb) cb->Release();
}
static void FogBind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    if (!g_fogRefl) return;
    ID3D11ShaderResourceView *v[2] = { g_fogView[0].load(std::memory_order_acquire), g_fogView[1].load(std::memory_order_acquire) };
    ID3D11Buffer *cb = g_fogCB;
    if (!v[0] || !v[1] || !cb) return;
    o->psSRV(ctx, kFogSlot, 2, v);
    ctx->PSSetConstantBuffers(kFogCB, 1, &cb);
    g_fogBinds++;
}

// ---- bounce light (see the top): render target 1 of the AO pass, t122 for its readers next frame

// the AO pass's targets as the apply pass reads them back (its g_txMask at t1), most recently seen last, under
// g_feedLock: only these ever get the bounce-light texture beside them
static std::vector<ID3D11Resource *> g_aoTargets;
static ID3D11Resource *g_aoHalfFullTex = nullptr; // the half-size AO pass's full-size result (see AOHalfSetup): never an AO target
struct GITexture { ID3D11Texture2D *tex; ID3D11RenderTargetView *rtv; ID3D11ShaderResourceView *srv; UINT w, h; ID3D11UnorderedAccessView *uav; }; // uav: the AO upsample writes it
static GITexture g_giTex = {};
static std::atomic<ID3D11ShaderResourceView *> g_giView{ nullptr };
static std::atomic<ULONGLONG> g_giLastWrite{ 0 };
static std::atomic<uint64_t> g_giWrites{ 0 }, g_giBinds{ 0 }, g_giReaders{ 0 };

static void RememberAOTarget(ID3D11ShaderResourceView *mask)
{
    ID3D11Resource *r = nullptr;
    mask->GetResource(&r);
    if (!r) return;
    std::lock_guard<std::mutex> lock(g_feedLock);
    if (r == g_aoHalfFullTex) { r->Release(); return; } // this DLL's own, still at t1 from the last apply pass
    for (size_t i = 0; i < g_aoTargets.size(); i++)
        if (g_aoTargets[i] == r)
        {
            g_aoTargets.erase(g_aoTargets.begin() + i);
            g_aoTargets.push_back(r);
            r->Release(); // the list holds its own reference already
            return;
        }
    if (g_aoTargets.size() >= 8) { g_aoTargets.front()->Release(); g_aoTargets.erase(g_aoTargets.begin()); }
    g_aoTargets.push_back(r);
    static std::atomic<int> said{ 0 };
    if (said++ < 4) Log("bounce light: the AO pass's target %p is known from the apply pass", (void *)r);
}

// under g_feedLock: the bounce-light texture, (re)made to the size of the AO pass's target ao (single sampled), cleared
// when new; null when it cannot be made
static ID3D11RenderTargetView *GITarget(ID3D11DeviceContext *ctx, ID3D11Texture2D *ao)
{
    D3D11_TEXTURE2D_DESC d = {};
    ao->GetDesc(&d);
    if (d.SampleDesc.Count != 1) return nullptr;
    GITexture &g = g_giTex;
    if (g.tex && g.w == d.Width && g.h == d.Height) return g.rtv;
    ID3D11Device *dev = nullptr;
    ao->GetDevice(&dev);
    if (!dev) return nullptr;
    D3D11_TEXTURE2D_DESC n = {};
    n.Width = d.Width; n.Height = d.Height; n.MipLevels = 1; n.ArraySize = 1; n.Format = DXGI_FORMAT_R16G16B16A16_FLOAT; n.SampleDesc.Count = 1;
    n.Usage = D3D11_USAGE_DEFAULT; n.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
    ID3D11Texture2D *tex = nullptr;
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;
    ID3D11UnorderedAccessView *uav = nullptr;
    HRESULT hr = dev->CreateTexture2D(&n, nullptr, &tex);
    if (SUCCEEDED(hr)) hr = dev->CreateRenderTargetView(tex, nullptr, &rtv);
    if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(tex, nullptr, &srv);
    if (SUCCEEDED(hr)) hr = dev->CreateUnorderedAccessView(tex, nullptr, &uav);
    dev->Release();
    if (FAILED(hr))
    {
        if (uav) uav->Release();
        if (srv) srv->Release();
        if (rtv) rtv->Release();
        if (tex) tex->Release();
        Log("bounce light: texture %u x %u could not be made (0x%08lX)", d.Width, d.Height, (unsigned long)hr);
        return nullptr;
    }
    const float zero[4] = {};
    ctx->ClearRenderTargetView(rtv, zero);
    if (g.tex) { g_feedRetired.push_back(g.tex); g_feedRetired.push_back(g.rtv); g_feedRetired.push_back(g.srv); g_feedRetired.push_back(g.uav); }
    while (g_feedRetired.size() > 16) { g_feedRetired.front()->Release(); g_feedRetired.erase(g_feedRetired.begin()); }
    g = { tex, rtv, srv, d.Width, d.Height, uav };
    g_giView.store(srv, std::memory_order_release);
    Log("bounce light: texture %u x %u", d.Width, d.Height);
    return rtv;
}

// The entry a target of this DLL needs in blend description d: no blending; render target 1 of the AO pass (the bounce
// light) all four channels; render target 7 of the lit pass (normal and roughness) all four channels exactly when the
// draw writes render target 1 (the game's normal), else none, so it follows the normal it belongs to; render target 6
// of the lit pass (contact shadows: the sun's visibility) likewise all four exactly when the draw writes render target 0
// (the colour that visibility lit), else none.
static D3D11_RENDER_TARGET_BLEND_DESC WantedEntry(const D3D11_BLEND_DESC &d, UINT slot)
{
    D3D11_RENDER_TARGET_BLEND_DESC t = d.RenderTarget[d.IndependentBlendEnable ? slot : 0];
    t.BlendEnable = FALSE;
    t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    if (slot == kRT7 && !d.RenderTarget[d.IndependentBlendEnable ? 1 : 0].RenderTargetWriteMask) t.RenderTargetWriteMask = 0;
    if (slot == kRT6 && !d.RenderTarget[0].RenderTargetWriteMask) t.RenderTargetWriteMask = 0;
    return t;
}

// whether every target in `slots` (bit i = target i) is written as this DLL needs under blend state bs (none = the
// default: every target plainly): each its own entry with independent blending, else target 0's (which then applies)
static bool PlainFor(ID3D11BlendState *bs, UINT slots)
{
    if (!bs) return true;
    D3D11_BLEND_DESC d = {};
    bs->GetDesc(&d);
    for (UINT slot = 0; slot < 8; slot++)
    {
        if (!(slots & (1u << slot))) continue;
        const D3D11_RENDER_TARGET_BLEND_DESC &t = d.RenderTarget[d.IndependentBlendEnable ? slot : 0];
        if (t.BlendEnable || t.RenderTargetWriteMask != WantedEntry(d, slot).RenderTargetWriteMask) return false;
    }
    return true;
}

// The game's blend states that would not write a target of this DLL as it needs (a one-channel AO target may well be
// drawn with red only; the lit pass blends some draws) -> copies that do: those targets as WantedEntry says, every other
// target exactly as the game's state has it. Made once per state and set of targets, both held (so an address cannot
// come back as another state), under g_blendLock.
static std::mutex g_blendLock;
static std::unordered_map<uintptr_t, ID3D11BlendState *> g_blendCopies; // key: the state's address | the targets' bits << 56
static std::atomic<int> g_blendCopyLines{ 0 };

static ID3D11BlendState *BlendCopy(ID3D11DeviceContext *ctx, ID3D11BlendState *bs, UINT slots)
{
    std::lock_guard<std::mutex> lock(g_blendLock);
    const uintptr_t key = (uintptr_t)bs | ((uintptr_t)slots << 56);
    const auto it = g_blendCopies.find(key);
    if (it != g_blendCopies.end()) return it->second;
    D3D11_BLEND_DESC game = {};
    bs->GetDesc(&game);
    D3D11_BLEND_DESC d = game;
    if (!d.IndependentBlendEnable) for (int i = 1; i < 8; i++) d.RenderTarget[i] = d.RenderTarget[0];
    d.IndependentBlendEnable = TRUE;
    char what[160] = "";
    int at = 0;
    for (UINT slot = 0; slot < 8; slot++)
    {
        if (!(slots & (1u << slot))) continue;
        const D3D11_RENDER_TARGET_BLEND_DESC g = game.RenderTarget[game.IndependentBlendEnable ? slot : 0];
        d.RenderTarget[slot] = WantedEntry(game, slot);
        if (at >= 0 && at < (int)sizeof what)
            at += snprintf(what + at, sizeof what - at, "%starget %u blend %d mask 0x%X -> %s", at ? ", " : "", slot, (int)g.BlendEnable, (unsigned)g.RenderTargetWriteMask,
                d.RenderTarget[slot].RenderTargetWriteMask ? "plainly" : "not at all");
    }
    ID3D11Device *dev = nullptr;
    ctx->GetDevice(&dev);
    ID3D11BlendState *copy = nullptr;
    if (dev) { dev->CreateBlendState(&d, &copy); dev->Release(); }
    bs->AddRef();
    g_blendCopies[key] = copy;
    if (g_blendCopyLines++ < 12)
        Log("%s: blend state %p drawn with a copy (%p): %s", (slots & 2u) ? "bounce light" : "lit pass targets of this DLL", (void *)bs, (void *)copy, what);
    return copy;
}

// the blend state in place writes the targets in `slots` as this DLL needs: the game's own, or a copy of it put in its
// place (the game's state, factor and mask remembered to go back later); false when no copy could be made
static bool PlainBlend(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s, UINT slots)
{
    if (s->blendSwapped) return true;
    ID3D11BlendState *bs = nullptr;
    FLOAT factor[4] = {};
    UINT mask = 0xffffffff;
    ctx->OMGetBlendState(&bs, factor, &mask);
    bool plain = PlainFor(bs, slots);
    if (!plain)
    {
        ID3D11BlendState *copy = BlendCopy(ctx, bs, slots);
        if (copy)
        {
            o->omSetBlend(ctx, copy, factor, mask);
            s->blendSwapped = true;
            s->gameBlend = bs; // held by g_giBlends
            memcpy(s->blendFactor, factor, sizeof factor);
            s->blendMask = mask;
            plain = true;
        }
    }
    if (bs) bs->Release();
    return plain;
}

// the game's own blend state back where the context holds a copy
static void RestoreBlend(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    if (!s->blendSwapped) return;
    o->omSetBlend(ctx, s->gameBlend, s->blendFactor, s->blendMask);
    s->blendSwapped = false;
}

// the compute state a pass of this DLL touches (the reflections, the AO upsample, the AO depth mips, contact shadows: up
// to 4 UAVs, 3 constant buffers), saved before and put back after (the game's HDR pass uses compute shaders too)
struct CSState { ID3D11ComputeShader *cs; ID3D11Buffer *cb[3]; ID3D11ShaderResourceView *srv[8]; ID3D11UnorderedAccessView *uav[4]; ID3D11SamplerState *sam[2]; };
static void SaveCS(ID3D11DeviceContext *ctx, CSState &st)
{
    st = {};
    ctx->CSGetShader(&st.cs, nullptr, nullptr);
    ctx->CSGetConstantBuffers(0, 3, st.cb);
    ctx->CSGetShaderResources(0, 8, st.srv);
    ctx->CSGetUnorderedAccessViews(0, 4, st.uav);
    ctx->CSGetSamplers(0, 2, st.sam);
}
static void RestoreCS(ID3D11DeviceContext *ctx, CSState &st)
{
    ID3D11UnorderedAccessView *none[4] = {};
    ctx->CSSetUnorderedAccessViews(0, 4, none, nullptr);
    ctx->CSSetShader(st.cs, nullptr, 0);
    ctx->CSSetConstantBuffers(0, 3, st.cb);
    ctx->CSSetShaderResources(0, 8, st.srv);
    const UINT keep[4] = { (UINT)-1, (UINT)-1, (UINT)-1, (UINT)-1 };
    ctx->CSSetUnorderedAccessViews(0, 4, st.uav, keep);
    ctx->CSSetSamplers(0, 2, st.sam);
    if (st.cs) st.cs->Release();
    for (auto *b : st.cb) if (b) b->Release();
    for (auto *v : st.srv) if (v) v->Release();
    for (auto *u : st.uav) if (u) u->Release();
    for (auto *s : st.sam) if (s) s->Release();
}

// ---- the AO pass at half size (ini AOHalf=1, KeyAOHalf = F5 flips it; see the top): the AO pass with a
// bounce-light output draws into two half-size targets of this DLL, its viewports halved while it is set up; when the
// apply pass is set, compute passes (src\ao\ao_upsample.hlsl) blur that result 3 x 3 on its own grid (AOHalfBlur=1) and
// bring it back to full size, weighted by depth: the AO into a full-size texture of this DLL, which the apply pass reads
// at t1 in place of the AO pass's own target, and the bounce light into the bounce-light texture as ever. The AO pass and
// its apply pass follow each other on one context (the probe: one command list holds both).
struct AOHalfResources
{
    UINT w = 0, h = 0, hw = 0, hh = 0;              // full size (the AO pass's target) and half of it, rounded up
    bool broken = false;                            // could not be made at this size: the pass stays at full size
    ID3D11Texture2D *tex[5] = {};                   // 0 AO, 1 bounce light (half size, the pass's targets), 2 and 3 their blur, 4 AO full size
    ID3D11RenderTargetView *rtv[2] = {};
    ID3D11ShaderResourceView *srv[5] = {};
    ID3D11UnorderedAccessView *uav[5] = {};         // 2, 3 (the blur writes them) and 4 (the upsample)
    ID3D11ComputeShader *csUp = nullptr, *csBlur = nullptr;
    ID3D11Buffer *cb = nullptr;
};
static AOHalfResources g_aoHalfRes;                 // under g_feedLock; a set made for another size is kept, never released
static std::vector<AOHalfResources> g_aoHalfOld;    // (a command list recorded before the size changed may still use it)
static std::atomic<uint64_t> g_aoHalfPasses{ 0 }, g_aoHalfUpsamples{ 0 };

// under g_feedLock: the set for an AO pass target of w x h; false when it cannot be made (then never tried again at that size)
static bool AOHalfSetup(ID3D11Device *dev, UINT w, UINT h)
{
    AOHalfResources &r = g_aoHalfRes;
    if (r.w == w && r.h == h) return !r.broken;
    if (r.w) g_aoHalfOld.push_back(r);
    r = AOHalfResources();
    r.w = w; r.h = h; r.hw = (w + 1) / 2; r.hh = (h + 1) / 2;
    struct Spec { UINT w, h; DXGI_FORMAT f; bool target; } spec[5] = {
        { r.hw, r.hh, DXGI_FORMAT_R8_UNORM, true }, { r.hw, r.hh, DXGI_FORMAT_R16G16B16A16_FLOAT, true },
        { r.hw, r.hh, DXGI_FORMAT_R8_UNORM, false }, { r.hw, r.hh, DXGI_FORMAT_R16G16B16A16_FLOAT, false }, { w, h, DXGI_FORMAT_R8_UNORM, false } };
    bool ok = true;
    for (int i = 0; i < 5 && ok; i++)
    {
        D3D11_TEXTURE2D_DESC d = {};
        d.Width = spec[i].w; d.Height = spec[i].h; d.MipLevels = 1; d.ArraySize = 1; d.Format = spec[i].f; d.SampleDesc.Count = 1; d.Usage = D3D11_USAGE_DEFAULT;
        d.BindFlags = D3D11_BIND_SHADER_RESOURCE | (spec[i].target ? D3D11_BIND_RENDER_TARGET : D3D11_BIND_UNORDERED_ACCESS);
        ok = SUCCEEDED(dev->CreateTexture2D(&d, nullptr, &r.tex[i])) && SUCCEEDED(dev->CreateShaderResourceView(r.tex[i], nullptr, &r.srv[i]));
        if (ok && spec[i].target) ok = SUCCEEDED(dev->CreateRenderTargetView(r.tex[i], nullptr, &r.rtv[i]));
        if (ok && !spec[i].target) ok = SUCCEEDED(dev->CreateUnorderedAccessView(r.tex[i], nullptr, &r.uav[i]));
    }
    ok = ok && SUCCEEDED(dev->CreateComputeShader(g_csAOUpsample, sizeof g_csAOUpsample, nullptr, &r.csUp)) &&
         SUCCEEDED(dev->CreateComputeShader(g_csAOBlur, sizeof g_csAOBlur, nullptr, &r.csBlur));
    if (ok)
    {
        struct { UINT full[2], half[2], gi; float tol; float pad[2]; } c = { { w, h }, { r.hw, r.hh }, 1u, g_aoHalfTol, { 0, 0 } };
        D3D11_BUFFER_DESC bd = { sizeof c, D3D11_USAGE_IMMUTABLE, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
        D3D11_SUBRESOURCE_DATA sd = { &c, 0, 0 };
        ok = SUCCEEDED(dev->CreateBuffer(&bd, &sd, &r.cb));
    }
    r.broken = !ok;
    if (ok) g_aoHalfFullTex = r.tex[4];
    if (ok) Log("AO at half size: targets %u x %u for the pass's %u x %u, the upsample%s", r.hw, r.hh, w, h, g_aoHalfBlur ? " after a 3 x 3 blur at half size" : "");
    else Log("AO at half size: the textures or shaders for %u x %u could not be made: the pass stays at full size", w, h);
    return ok;
}

// the context's viewports as the game set them (else the AO target's size), halved
static void AOHalfViewports(ID3D11DeviceContext *ctx, const ContextOrig *o, const ContextState *s)
{
    std::vector<D3D11_VIEWPORT> v = s->viewports;
    if (v.empty()) v.push_back({ 0.0f, 0.0f, (float)g_aoHalfRes.w, (float)g_aoHalfRes.h, 0.0f, 1.0f });
    for (D3D11_VIEWPORT &x : v) { x.TopLeftX *= 0.5f; x.TopLeftY *= 0.5f; x.Width *= 0.5f; x.Height *= 0.5f; }
    o->setViewports(ctx, (UINT)v.size(), v.data());
}

// a half-size AO pass is over: blur and upsample (the compute state saved and put back; the AO pass's GPU timing ends
// here, the upsample has its own); false when it could not run
static bool AOHalfResolve(ID3D11DeviceContext *ctx, ContextState *s)
{
    AOHalfResources r;
    ID3D11ShaderResourceView *depth = nullptr;
    ID3D11UnorderedAccessView *giUav = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        r = g_aoHalfRes;
        const FeedTexture &z = g_feedTex[1];
        if (z.srv && z.w == r.w && z.h == r.h) { depth = z.srv; depth->AddRef(); }
        if (g_giTex.uav && g_giTex.w == r.w && g_giTex.h == r.h) { giUav = g_giTex.uav; giUav->AddRef(); }
    }
    if (!depth || !giUav || r.broken || !r.csUp)
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("AO at half size: no depth copy or bounce-light texture of the pass's size for the upsample: the apply pass reads the game's target");
        if (depth) depth->Release();
        if (giUav) giUav->Release();
        return false;
    }
    if (s->gpuPass) GpuEnd(ctx, s->gpuPass);
    GpuTimer *timer = g_gpuTimers ? GpuBegin(ctx, kGpuAOUp) : nullptr;
    ProfOurs(ctx, s, kProfAOUp);
    CSState saved;
    SaveCS(ctx, saved);
    ctx->CSSetConstantBuffers(0, 1, &r.cb);
    ID3D11ShaderResourceView *in[3] = { r.srv[0], r.srv[1], depth };
    ID3D11UnorderedAccessView *none[2] = {};
    if (g_aoHalfBlur)
    {
        ID3D11UnorderedAccessView *blurred[2] = { r.uav[2], r.uav[3] };
        ctx->CSSetShader(r.csBlur, nullptr, 0);
        ctx->CSSetShaderResources(0, 3, in);
        ctx->CSSetUnorderedAccessViews(0, 2, blurred, nullptr);
        ctx->Dispatch((r.hw + 7) / 8, (r.hh + 7) / 8, 1);
        ctx->CSSetUnorderedAccessViews(0, 2, none, nullptr); // read next
        in[0] = r.srv[2]; in[1] = r.srv[3];
    }
    ID3D11UnorderedAccessView *full[2] = { r.uav[4], giUav };
    ctx->CSSetShader(r.csUp, nullptr, 0);
    ctx->CSSetShaderResources(0, 3, in);
    ctx->CSSetUnorderedAccessViews(0, 2, full, nullptr);
    ctx->Dispatch((r.w + 7) / 8, (r.h + 7) / 8, 1);
    RestoreCS(ctx, saved);
    if (timer) GpuEnd(ctx, timer);
    ProfResume(ctx, s);
    depth->Release();
    giUav->Release();
    if (g_aoHalfUpsamples++ == 0) Log("AO at half size: first upsample (on context %p)", (void *)ctx);
    return true;
}

// the half-size AO pass is over (the game set new targets, or another shader with the targets kept: then the AO pass's
// own target goes back, alone): the game's viewports back, and the upsample, whose result the next apply pass reads
static void AOHalfEnd(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s, bool targetsBack)
{
    if (!s->aoHalf) return;
    s->aoHalf = false;
    if (!s->viewports.empty()) o->setViewports(ctx, (UINT)s->viewports.size(), s->viewports.data());
    if (targetsBack && s->aoHalfGameRtv)
    {
        o->omSetUAV(ctx, 1, &s->aoHalfGameRtv, nullptr, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
        s->giBound = false;
    }
    s->aoHalfReady = AOHalfResolve(ctx, s);
}

// the apply pass reads the full-size result at t1 (what the game bound there is held, and put back after it)
static void AOHalfSubstitute(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    ID3D11ShaderResourceView *ours = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        ours = g_aoHalfRes.srv[4];
    }
    if (!ours) return;
    ID3D11ShaderResourceView *cur = nullptr;
    ctx->PSGetShaderResources(1, 1, &cur);
    if (cur != ours)
    {
        if (s->aoHalfGameT1) s->aoHalfGameT1->Release();
        s->aoHalfGameT1 = cur; // held
        cur = nullptr;
    }
    if (cur) cur->Release();
    o->psSRV(ctx, 1, 1, &ours);
    s->aoHalfSubst = true;
}
static void AOHalfUnsubstitute(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    if (!s->aoHalfSubst) return;
    s->aoHalfSubst = false;
    o->psSRV(ctx, 1, 1, &s->aoHalfGameT1);
    if (s->aoHalfGameT1) { s->aoHalfGameT1->Release(); s->aoHalfGameT1 = nullptr; }
}

// ---- the AO pass's depth mips (ini ZMips=1, the default): for an AO pass that declares t126 (GTAO built with
// AO_DEPTH_LOD=2), levels 1..4 of the linear depth it reads at t80, decimated (src\ao\depth_decimate.hlsl: a level-k
// texel holds the full-size depth at its multiples of 2^k), made on the AO pass's context once its shader and t80 are
// set, bound at t126 until another shader is set. The pass's far taps move onto those texels and read the same depth there
// as at t80, from a small cached texture: the picture is the same with the mips or without (the shader reads t80 where
// t126 holds nothing); only the time changes (on a captured frame: 0.63 ms against 1.10 at half size).
struct ZMipsResources
{
    UINT w = 0, h = 0;                              // the depth's size (the texture is half of it, 4 levels)
    bool broken = false;                            // could not be made at this size: t126 stays empty
    ID3D11Texture2D *tex = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;        // its 4 levels
    ID3D11UnorderedAccessView *uav[4] = {};         // one per level
    ID3D11ComputeShader *cs = nullptr;
    ID3D11Buffer *cb = nullptr;
};
static ZMipsResources g_zMipsRes;                   // under g_feedLock; a set made for another size is kept, never released
static std::vector<ZMipsResources> g_zMipsOld;      // (a command list recorded before the size changed may still use it)
static std::atomic<uint64_t> g_zMipsBuilds{ 0 };

// under g_feedLock: the set for a depth of w x h; false when it cannot be made (then never tried again at that size)
static bool ZMipsSetup(ID3D11Device *dev, UINT w, UINT h)
{
    ZMipsResources &r = g_zMipsRes;
    if (r.w == w && r.h == h) return !r.broken;
    if (r.w) g_zMipsOld.push_back(r);
    r = ZMipsResources();
    r.w = w; r.h = h;
    const UINT w1 = w / 2 ? w / 2 : 1, h1 = h / 2 ? h / 2 : 1;
    D3D11_TEXTURE2D_DESC d = {};
    d.Width = w1; d.Height = h1; d.MipLevels = 4; d.ArraySize = 1; d.Format = DXGI_FORMAT_R32_FLOAT; d.SampleDesc.Count = 1; d.Usage = D3D11_USAGE_DEFAULT;
    d.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
    bool ok = SUCCEEDED(dev->CreateTexture2D(&d, nullptr, &r.tex)) && SUCCEEDED(dev->CreateShaderResourceView(r.tex, nullptr, &r.srv));
    for (UINT k = 0; k < 4 && ok; k++)
    {
        D3D11_UNORDERED_ACCESS_VIEW_DESC u = {};
        u.Format = DXGI_FORMAT_R32_FLOAT; u.ViewDimension = D3D11_UAV_DIMENSION_TEXTURE2D; u.Texture2D.MipSlice = k;
        ok = SUCCEEDED(dev->CreateUnorderedAccessView(r.tex, &u, &r.uav[k]));
    }
    ok = ok && SUCCEEDED(dev->CreateComputeShader(g_csDepthDecimate, sizeof g_csDepthDecimate, nullptr, &r.cs));
    if (ok)
    {
        const UINT c[4] = { w1, h1, w, h };
        D3D11_BUFFER_DESC bd = { sizeof c, D3D11_USAGE_IMMUTABLE, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
        D3D11_SUBRESOURCE_DATA sd = { c, 0, 0 };
        ok = SUCCEEDED(dev->CreateBuffer(&bd, &sd, &r.cb));
    }
    r.broken = !ok;
    if (ok) Log("AO depth mips: levels 1..4 of the %u x %u depth (from %u x %u down) for the AO pass at t126", w, h, w1, h1);
    else Log("AO depth mips: the texture or shader for a %u x %u depth could not be made: the AO pass reads t80 alone", w, h);
    return ok;
}

// the AO pass (a shader that declares t126) is set with depth at t80: its mips made from it, bound at t126 (once per
// depth view while the pass stays set)
static void ZMipsBuild(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s, ID3D11ShaderResourceView *depth)
{
    if (!g_zMips || !depth || (s->zMipsBound && s->zMipsFrom == depth)) return;
    ID3D11Resource *res = nullptr;
    depth->GetResource(&res);
    D3D11_TEXTURE2D_DESC td = {};
    const bool is2D = res && Desc2D(res, &td);
    if (res) res->Release();
    D3D11_SHADER_RESOURCE_VIEW_DESC vd = {};
    depth->GetDesc(&vd);
    if (!is2D || vd.ViewDimension != D3D11_SRV_DIMENSION_TEXTURE2D || td.SampleDesc.Count != 1)
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("AO depth mips: the AO pass's t80 is not a plain 2D texture view (dimension %d, %u samples): no mips", (int)vd.ViewDimension, td.SampleDesc.Count);
        return;
    }
    const UINT mip = vd.Texture2D.MostDetailedMip, w = td.Width >> mip ? td.Width >> mip : 1, h = td.Height >> mip ? td.Height >> mip : 1;
    ZMipsResources r;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        ID3D11Device *dev = nullptr;
        ctx->GetDevice(&dev);
        const bool ok = dev && ZMipsSetup(dev, w, h);
        if (dev) dev->Release();
        if (!ok) return;
        r = g_zMipsRes;
    }
    // the AO pass's GPU timing pauses for it, as for the feed copy; the pass profile times it on its own
    const bool resumeAO = s->gpuPass != nullptr;
    if (resumeAO) GpuEnd(ctx, s->gpuPass);
    ProfOurs(ctx, s, kProfZMips);
    CSState saved;
    SaveCS(ctx, saved);
    ctx->CSSetShader(r.cs, nullptr, 0);
    ctx->CSSetConstantBuffers(0, 1, &r.cb);
    ctx->CSSetShaderResources(0, 1, &depth);
    ctx->CSSetUnorderedAccessViews(0, 4, r.uav, nullptr);
    const UINT w1 = w / 2 ? w / 2 : 1, h1 = h / 2 ? h / 2 : 1;
    ctx->Dispatch((w1 + 7) / 8, (h1 + 7) / 8, 1);
    RestoreCS(ctx, saved);
    ProfResume(ctx, s);
    if (resumeAO) s->gpuPass = GpuBegin(ctx, kGpuAO);
    o->psSRV(ctx, kZMipsSlot, 1, &r.srv);
    s->zMipsBound = true;
    s->zMipsFrom = depth;
    if (g_zMipsBuilds++ == 0) Log("AO depth mips: first made and bound at t126 (on context %p)", (void *)ctx);
}
// the game set t126 while the AO pass is set (it never uses the slot, but a range may cover it): the mips back there
static void ZMipsRebind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11ShaderResourceView *v = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        v = g_zMipsRes.srv;
    }
    if (v) o->psSRV(ctx, kZMipsSlot, 1, &v);
}
// the AO pass is over (another shader is set): t126 empty again, so the mips are never bound where they get made
static void ZMipsUnbind(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s)
{
    if (!s->zMipsBound) return;
    s->zMipsBound = false;
    s->zMipsFrom = nullptr;
    ID3D11ShaderResourceView *none = nullptr;
    o->psSRV(ctx, kZMipsSlot, 1, &none);
}

// the AO pass with a bounce-light output is set up to draw into rtv (with dsv): when rtv is the AO pass's own target,
// bind the bounce-light texture beside it as render target 1, with a blend state that writes it plainly (the game's
// next OMSetRenderTargets takes it off again and puts the game's blend state back)
static void GIBindTarget(ID3D11DeviceContext *ctx, const ContextOrig *o, ID3D11RenderTargetView *rtv, ID3D11DepthStencilView *dsv)
{
    // switched off (F10), or the game's own SSAO drawn instead (F11, F8)
    if (!g_bounceOn.load(std::memory_order_relaxed) || g_stockAO.load(std::memory_order_relaxed) || g_stockAll.load(std::memory_order_relaxed)) return;
    D3D11_RENDER_TARGET_VIEW_DESC v = {};
    rtv->GetDesc(&v);
    if (v.ViewDimension != D3D11_RTV_DIMENSION_TEXTURE2D || v.Texture2D.MipSlice != 0) return;
    ID3D11Resource *r = nullptr;
    rtv->GetResource(&r);
    if (!r) return;
    ContextState *s = State(ctx);
    // at half size (AOHalf, F5): not with a depth target bound (its size would not match) nor for a dump's frame, and only
    // for the game's one-channel 8-bit AO target (this DLL's half- and full-size AO textures are that format)
    bool half = g_aoHalfOn.load(std::memory_order_relaxed) && !dsv && !s->dumpAwaiting;
    if (half && v.Format != DXGI_FORMAT_R8_UNORM)
    {
        half = false;
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("AO at half size: the AO pass's target is drawn as format %u, not R8_UNORM: the pass stays at full size", (unsigned)v.Format);
    }
    ID3D11RenderTargetView *gi = nullptr, *halfRtv[2] = {};
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        bool known = false;
        for (ID3D11Resource *k : g_aoTargets) known |= k == r;
        ID3D11Texture2D *t = nullptr;
        if (known) r->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&t);
        if (t)
        {
            gi = GITarget(ctx, t);
            if (gi && half)
            {
                D3D11_TEXTURE2D_DESC td = {};
                t->GetDesc(&td);
                ID3D11Device *dev = nullptr;
                t->GetDevice(&dev);
                if (dev && AOHalfSetup(dev, td.Width, td.Height)) { halfRtv[0] = g_aoHalfRes.rtv[0]; halfRtv[1] = g_aoHalfRes.rtv[1]; }
                if (dev) dev->Release();
            }
            t->Release();
        }
    }
    if (!gi) { r->Release(); return; }
    if (!PlainBlend(ctx, o, s, 1u << 1)) { r->Release(); return; }
    if (halfRtv[0])
    {
        // the pass into the half-size targets, its viewports halved until it is over (AOHalfEnd, which upsamples)
        o->omSetUAV(ctx, 2, halfRtv, nullptr, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
        s->giBound = true;
        s->aoHalf = true;
        s->aoHalfReady = false;
        if (s->aoHalfGameRtv) s->aoHalfGameRtv->Release();
        rtv->AddRef();
        s->aoHalfGameRtv = rtv;
        AOHalfViewports(ctx, o, s);
        r->Release();
        g_giLastWrite.store(GetTickCount64(), std::memory_order_relaxed);
        g_giWrites++;
        if (g_aoHalfPasses++ == 0) Log("AO at half size: first pass drawn at half size (on context %p)", (void *)ctx);
        return;
    }
    ID3D11RenderTargetView *both[2] = { rtv, gi };
    o->omSetUAV(ctx, 2, both, dsv, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
    s->giBound = true;
    // dump: this is the AO pass's own target (its inputs may have been recorded before the game bound it)
    if (s->dumpAwaiting && !s->dumpAO) { r->AddRef(); s->dumpAO = r; s->dumpAOView = v.Format; }
    r->Release();
    g_giLastWrite.store(GetTickCount64(), std::memory_order_relaxed);
    if (g_giWrites++ == 0) Log("bounce light: first bound as render target 1 of the AO pass (on context %p)", (void *)ctx);
}

// the bounce-light texture off again (no copy of a new blend state could be made): the AO pass's target stays alone
static void GIUnbindTarget(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11DepthStencilView *dsv = nullptr;
    ctx->OMGetRenderTargets(1, &rtv, &dsv);
    o->omSetUAV(ctx, 1, &rtv, dsv, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
    if (rtv) rtv->Release();
    if (dsv) dsv->Release();
    State(ctx)->giBound = false;
}

// a shader that reads the bounce light is set (or the game reset its slot): bind it at t122 while the AO pass keeps
// writing it, else nothing, so a stopped AO pass (setting off, menus) leaves no stale light behind
static void GIBind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11ShaderResourceView *v = g_giView.load(std::memory_order_acquire);
    const ULONGLONG last = g_giLastWrite.load(std::memory_order_relaxed);
    if (!last || GetTickCount64() - last > 250 || !g_bounceOn.load(std::memory_order_relaxed) || g_stockAO.load(std::memory_order_relaxed) ||
        g_stockAll.load(std::memory_order_relaxed)) v = nullptr;
    o->psSRV(ctx, kGISlot, 1, &v);
    g_giBinds++;
}

// ---- reflections (see the top): render target 7 of the lit pass, the pass at the AO pass, t123/t124 for its readers

static std::atomic<uint64_t> g_o7Writers{ 0 }, g_ssrReaders{ 0 }, g_ssrRuns{ 0 }, g_ssrBinds{ 0 }, g_rt7Binds{ 0 }, g_motionRuns{ 0 };
static std::atomic<uint64_t> g_o6Writers{ 0 }, g_rt6Binds{ 0 }, g_contactRuns{ 0 }; // contact shadows (see ContactRun)
static std::atomic<ID3D11ShaderResourceView *> g_ssrView{ nullptr }, g_motionView{ nullptr }, g_hizView{ nullptr }; // g_hizView: the pass's pyramid, all levels
static std::atomic<uint64_t> g_hizBinds{ 0 }, g_hizReaders{ 0 };
static std::atomic<ULONGLONG> g_ssrLastRun{ 0 }, g_motionLastRun{ 0 };
static std::atomic<ID3D11Resource *> g_velocityRes{ nullptr }; // what the TAA reads at t3 (compared, never used)
static const FLOAT kUpRough[4] = { 0.5f, 1.0f, 0.5f, 1.0f };   // render target 7 between passes: normal up, fully rough

// render target 7 beside the lit pass: on (ini and F6), not the stock switch, and a shader that writes it exists
static bool RT7Wanted()
{
    return g_ssr && g_ssrOn.load(std::memory_order_relaxed) && g_o7Writers.load(std::memory_order_relaxed) > 0 && !g_stockAll.load(std::memory_order_relaxed);
}
// the pass: on (ini and F6), its inputs (the splice's writers, or the debug mirror) and someone to read it (a shader, or a dump)
static bool SSRPassWanted()
{
    if (!g_ssr || !g_ssrOn.load(std::memory_order_relaxed) || g_stockAll.load(std::memory_order_relaxed)) return false;
    const bool inputs = g_o7Writers.load(std::memory_order_relaxed) > 0 || g_ssrMirror;
    const bool outputs = g_ssrReaders.load(std::memory_order_relaxed) > 0 || g_ssrMirror || g_dumpState.load(std::memory_order_relaxed) == kDumpRequested;
    return inputs && outputs;
}
// contact shadows (render target 6 beside the lit pass, and the pass with its composite): on (ini and F4), not the stock
// switch, and a shader that writes the sun's visibility exists
static bool ContactWanted()
{
    return g_contact && g_contactOn.load(std::memory_order_relaxed) && g_o6Writers.load(std::memory_order_relaxed) > 0 && !g_stockAll.load(std::memory_order_relaxed);
}

// under g_feedLock: render target 6 for lit pass p (R8: the sun's visibility), (re)made at the size of its colour
// target (single sampled only) and cleared to 0 (no sun: the composite leaves a pixel no receiver drew as it is)
static void ContactMakeRT6(LitPass &p, ID3D11DeviceContext *ctx)
{
    D3D11_TEXTURE2D_DESC cd = {};
    if (!Desc2D(p.colour, &cd)) return;
    if (cd.SampleDesc.Count != 1)
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("contact shadows: the lit pass is multisampled (%u samples): no render target 6, no contact shadows", cd.SampleDesc.Count);
        return;
    }
    if (p.rt6) { D3D11_TEXTURE2D_DESC d = {}; p.rt6->GetDesc(&d); if (d.Width == cd.Width && d.Height == cd.Height) return; }
    ID3D11Device *dev = nullptr;
    p.colour->GetDevice(&dev);
    if (!dev) return;
    D3D11_TEXTURE2D_DESC n = {};
    n.Width = cd.Width; n.Height = cd.Height; n.MipLevels = 1; n.ArraySize = 1; n.Format = DXGI_FORMAT_R8_UNORM; n.SampleDesc.Count = 1;
    n.Usage = D3D11_USAGE_DEFAULT; n.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    ID3D11Texture2D *tex = nullptr;
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;
    HRESULT hr = dev->CreateTexture2D(&n, nullptr, &tex);
    if (SUCCEEDED(hr)) hr = dev->CreateRenderTargetView(tex, nullptr, &rtv);
    if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(tex, nullptr, &srv);
    dev->Release();
    if (FAILED(hr))
    {
        if (srv) srv->Release();
        if (rtv) rtv->Release();
        if (tex) tex->Release();
        Log("contact shadows: render target 6 (%u x %u) could not be made (0x%08lX)", cd.Width, cd.Height, (unsigned long)hr);
        return;
    }
    const FLOAT zero[4] = {};
    ctx->ClearRenderTargetView(rtv, zero);
    if (p.rt6) { g_feedRetired.push_back(p.rt6); g_feedRetired.push_back(p.rt6Rtv); g_feedRetired.push_back(p.rt6Srv); }
    while (g_feedRetired.size() > 12) { g_feedRetired.front()->Release(); g_feedRetired.erase(g_feedRetired.begin()); }
    p.rt6 = tex; p.rt6Rtv = rtv; p.rt6Srv = srv;
    Log("contact shadows: render target 6, %u x %u, for the lit pass whose colour target is %p", cd.Width, cd.Height, (void *)p.colour);
}

// under g_feedLock: render target 7 for lit pass p, (re)made at the size of its colour target (single sampled only) and
// cleared to up/rough
static void SSRMakeRT7(LitPass &p, ID3D11DeviceContext *ctx)
{
    D3D11_TEXTURE2D_DESC cd = {};
    if (!Desc2D(p.colour, &cd)) return;
    if (cd.SampleDesc.Count != 1)
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("reflections: the lit pass is multisampled (%u samples): no render target 7, no reflection pass", cd.SampleDesc.Count);
        return;
    }
    if (p.rt7) { D3D11_TEXTURE2D_DESC d = {}; p.rt7->GetDesc(&d); if (d.Width == cd.Width && d.Height == cd.Height) return; }
    ID3D11Device *dev = nullptr;
    p.colour->GetDevice(&dev);
    if (!dev) return;
    D3D11_TEXTURE2D_DESC n = {};
    n.Width = cd.Width; n.Height = cd.Height; n.MipLevels = 1; n.ArraySize = 1; n.Format = DXGI_FORMAT_R8G8B8A8_UNORM; n.SampleDesc.Count = 1;
    n.Usage = D3D11_USAGE_DEFAULT; n.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    ID3D11Texture2D *tex = nullptr;
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11ShaderResourceView *srv = nullptr;
    HRESULT hr = dev->CreateTexture2D(&n, nullptr, &tex);
    if (SUCCEEDED(hr)) hr = dev->CreateRenderTargetView(tex, nullptr, &rtv);
    if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(tex, nullptr, &srv);
    dev->Release();
    if (FAILED(hr))
    {
        if (srv) srv->Release();
        if (rtv) rtv->Release();
        if (tex) tex->Release();
        Log("reflections: render target 7 (%u x %u) could not be made (0x%08lX)", cd.Width, cd.Height, (unsigned long)hr);
        return;
    }
    ctx->ClearRenderTargetView(rtv, kUpRough);
    if (p.rt7) { g_feedRetired.push_back(p.rt7); g_feedRetired.push_back(p.rt7Rtv); g_feedRetired.push_back(p.rt7Srv); }
    while (g_feedRetired.size() > 12) { g_feedRetired.front()->Release(); g_feedRetired.erase(g_feedRetired.begin()); }
    p.rt7 = tex; p.rt7Rtv = rtv; p.rt7Srv = srv;
    Log("reflections: render target 7, %u x %u, for the lit pass whose colour target is %p", cd.Width, cd.Height, (void *)p.colour);
}


// the lit pass's targets are bound on ctx (rtvs[0..2], no UAVs): render target 7 (reflections) and render target 6
// (contact shadows) beside them, those wanted that this lit pass has (a confirmed one), with a blend state that writes
// them as needed (the game's next OMSetRenderTargets takes them off)
static void LitBind(ID3D11DeviceContext *ctx, const ContextOrig *o, ContextState *s, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv)
{
    const bool want7 = RT7Wanted(), want6 = ContactWanted();
    if (!want7 && !want6) return;
    ID3D11Resource *factor = nullptr;
    rtvs[2]->GetResource(&factor);
    ID3D11RenderTargetView *rt7 = nullptr, *rt6 = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        for (const LitPass &p : g_litPasses)
            if (p.factor == factor && p.confirmed)
            {
                if (want7 && p.rt7Rtv && !rt7) { rt7 = p.rt7Rtv; rt7->AddRef(); }
                if (want6 && p.rt6Rtv && !rt6) { rt6 = p.rt6Rtv; rt6->AddRef(); }
            }
    }
    if (factor) factor->Release();
    const UINT slots = (rt6 ? 1u << kRT6 : 0u) | (rt7 ? 1u << kRT7 : 0u);
    if (slots && PlainBlend(ctx, o, s, slots))
    {
        ID3D11RenderTargetView *all[8] = { rtvs[0], rtvs[1], rtvs[2], nullptr, nullptr, nullptr, rt6, rt7 };
        o->omSetUAV(ctx, 8, all, dsv, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
        s->rt7Bound = rt7 != nullptr;
        s->rt6Bound = rt6 != nullptr;
        if (rt7 && g_rt7Binds++ == 0) Log("reflections: render target 7 first bound beside the lit pass (on context %p)", (void *)ctx);
        if (rt6 && g_rt6Binds++ == 0) Log("contact shadows: render target 6 first bound beside the lit pass (on context %p)", (void *)ctx);
    }
    if (rt7) rt7->Release();
    if (rt6) rt6->Release();
}

// render targets 6 and 7 off again (no copy of a new blend state could be made): the game's three targets stay
static void LitUnbind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11RenderTargetView *rtvs[3] = {};
    ID3D11DepthStencilView *dsv = nullptr;
    ctx->OMGetRenderTargets(3, rtvs, &dsv);
    o->omSetUAV(ctx, 3, rtvs, dsv, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
    for (auto *r : rtvs) if (r) r->Release();
    if (dsv) dsv->Release();
    ContextState *s = State(ctx);
    s->rt7Bound = false;
    s->rt6Bound = false;
}

// ---- contact shadows (ini Contact=1, KeyContact = F4 flips them):
// the shadow receivers of shader.pak's module contact write the sun's visibility they found (the shadow map's lit
// fraction) to render target 6 of the lit pass (LitBind); at the AO pass, Bend Studio's screen-space shadows (src\sss, a
// modified copy of their Apache-2.0 code) march each pixel towards the sun on the AO pass's linear depth (t80), their
// dispatches listed on the GPU (sss_setup.hlsl, from the game's camera and sun), into a mask (1 lit .. 0 shadowed); then
// a composite (contact_vs/ps.hlsl) is drawn over the lit pass's colour target with a multiplying blend: each pixel's
// colour x (1 - (1 - mask) x its sun share), the share from render target 6, render target 7's normal (when the
// reflections have it) and the game's sun and sky constants (CB_GLOBAL_SCENE at b2 of the AO pass). Render target 6 is
// cleared to 0 again for the next lit pass. Everything the pass and the draw set is put back as the game had it.
struct ContactResources
{
    UINT w = 0, h = 0;                                                  // the size the mask and the pass constants were made for
    ID3D11Texture2D *mask = nullptr;                                    // R32F: the pass's result
    ID3D11UnorderedAccessView *maskUav = nullptr;
    ID3D11ShaderResourceView *maskSrv = nullptr;
    ID3D11Buffer *args = nullptr, *list = nullptr;                      // the dispatches' arguments (8 x 3 uints) and their list (9 int4)
    ID3D11UnorderedAccessView *argsUav = nullptr, *listUav = nullptr;
    ID3D11ShaderResourceView *listSrv = nullptr;
    ID3D11Buffer *setupCB = nullptr, *passCB[8] = {}, *compCB[2] = {};  // (size-dependent) compCB[1]: render target 7 bound
    ID3D11SamplerState *border = nullptr;
    ID3D11ComputeShader *csSetup = nullptr, *csPass = nullptr;
    ID3D11VertexShader *vs = nullptr;
    ID3D11PixelShader *ps = nullptr;
    ID3D11BlendState *multiply = nullptr;
    ID3D11DepthStencilState *noDepth = nullptr;
    ID3D11RasterizerState *raster = nullptr;
    bool made = false, failed = false;                                  // the size-independent part
    ULONGLONG lastRun = 0;
};
static std::mutex g_contactLock;
static ContactResources g_contactRes;

// an immutable constant buffer holding `size` bytes (at most 64) of data
static ID3D11Buffer *ContactCB(ID3D11Device *dev, const void *data, UINT size)
{
    D3D11_BUFFER_DESC bd = {};
    bd.ByteWidth = (size + 15) & ~15u; bd.Usage = D3D11_USAGE_IMMUTABLE; bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    uint8_t pad[64] = {};
    memcpy(pad, data, size < sizeof pad ? size : sizeof pad);
    D3D11_SUBRESOURCE_DATA si = { pad, 0, 0 };
    ID3D11Buffer *b = nullptr;
    return SUCCEEDED(dev->CreateBuffer(&bd, &si, &b)) ? b : nullptr;
}

static void ContactReleaseSized(ContactResources &r)
{
    for (IUnknown *u : { (IUnknown *)r.mask, (IUnknown *)r.maskUav, (IUnknown *)r.maskSrv, (IUnknown *)r.setupCB }) if (u) u->Release();
    for (ID3D11Buffer *&b : r.passCB) { if (b) b->Release(); b = nullptr; }
    for (ID3D11Buffer *&b : r.compCB) { if (b) b->Release(); b = nullptr; }
    r.mask = nullptr; r.maskUav = nullptr; r.maskSrv = nullptr; r.setupCB = nullptr;
    r.w = r.h = 0;
}

// under g_contactLock: the pass's resources for a w x h depth (the mask and the constants that carry the size remade when
// it changes; a command list still holding the old ones keeps them alive)
static bool ContactSetup(ID3D11Device *dev, UINT w, UINT h)
{
    ContactResources &r = g_contactRes;
    if (r.failed) return false;
    HRESULT hr = S_OK;
    if (!r.made)
    {
        hr = dev->CreateComputeShader(g_csSSSSetup, sizeof g_csSSSSetup, nullptr, &r.csSetup);
        if (SUCCEEDED(hr)) hr = dev->CreateComputeShader(g_csSSS, sizeof g_csSSS, nullptr, &r.csPass);
        if (SUCCEEDED(hr)) hr = dev->CreateVertexShader(g_vsContact, sizeof g_vsContact, nullptr, &r.vs);
        if (SUCCEEDED(hr)) hr = dev->CreatePixelShader(g_psContact, sizeof g_psContact, nullptr, &r.ps);
        D3D11_BUFFER_DESC bd = {};
        if (SUCCEEDED(hr))
        {
            bd.ByteWidth = 8 * 12; bd.Usage = D3D11_USAGE_DEFAULT; bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
            bd.MiscFlags = D3D11_RESOURCE_MISC_DRAWINDIRECT_ARGS | D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
            hr = dev->CreateBuffer(&bd, nullptr, &r.args);
        }
        if (SUCCEEDED(hr))
        {
            D3D11_UNORDERED_ACCESS_VIEW_DESC ud = {};
            ud.Format = DXGI_FORMAT_R32_TYPELESS; ud.ViewDimension = D3D11_UAV_DIMENSION_BUFFER; ud.Buffer.NumElements = 8 * 3; ud.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
            hr = dev->CreateUnorderedAccessView(r.args, &ud, &r.argsUav);
        }
        if (SUCCEEDED(hr))
        {
            bd = {};
            bd.ByteWidth = 9 * 16; bd.Usage = D3D11_USAGE_DEFAULT; bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE;
            bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED; bd.StructureByteStride = 16;
            hr = dev->CreateBuffer(&bd, nullptr, &r.list);
        }
        if (SUCCEEDED(hr)) hr = dev->CreateUnorderedAccessView(r.list, nullptr, &r.listUav);
        if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(r.list, nullptr, &r.listSrv);
        if (SUCCEEDED(hr))
        {
            D3D11_SAMPLER_DESC sd = {};
            sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT; sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_BORDER; sd.MaxLOD = D3D11_FLOAT32_MAX;
            hr = dev->CreateSamplerState(&sd, &r.border);
        }
        if (SUCCEEDED(hr))
        {
            // colour x what the composite returns; the colour target's alpha kept
            D3D11_BLEND_DESC d = {};
            D3D11_RENDER_TARGET_BLEND_DESC &t = d.RenderTarget[0];
            t.BlendEnable = TRUE; t.SrcBlend = D3D11_BLEND_ZERO; t.DestBlend = D3D11_BLEND_SRC_COLOR; t.BlendOp = D3D11_BLEND_OP_ADD;
            t.SrcBlendAlpha = D3D11_BLEND_ZERO; t.DestBlendAlpha = D3D11_BLEND_ONE; t.BlendOpAlpha = D3D11_BLEND_OP_ADD;
            t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_RED | D3D11_COLOR_WRITE_ENABLE_GREEN | D3D11_COLOR_WRITE_ENABLE_BLUE;
            hr = dev->CreateBlendState(&d, &r.multiply);
        }
        if (SUCCEEDED(hr))
        {
            D3D11_DEPTH_STENCIL_DESC d = {};
            d.DepthEnable = FALSE; d.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO; d.DepthFunc = D3D11_COMPARISON_ALWAYS; d.StencilEnable = FALSE;
            hr = dev->CreateDepthStencilState(&d, &r.noDepth);
        }
        if (SUCCEEDED(hr))
        {
            D3D11_RASTERIZER_DESC d = {};
            d.FillMode = D3D11_FILL_SOLID; d.CullMode = D3D11_CULL_NONE; d.DepthClipEnable = TRUE;
            hr = dev->CreateRasterizerState(&d, &r.raster);
        }
        if (FAILED(hr))
        {
            r.failed = true;
            Log("contact shadows: the pass's resources could not be made (0x%08lX): no contact shadows", (unsigned long)hr);
            return false;
        }
        r.made = true;
    }
    if (r.mask && r.w == w && r.h == h) return true;
    ContactReleaseSized(r);
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R32_FLOAT; td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
    hr = dev->CreateTexture2D(&td, nullptr, &r.mask);
    if (SUCCEEDED(hr)) hr = dev->CreateUnorderedAccessView(r.mask, nullptr, &r.maskUav);
    if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(r.mask, nullptr, &r.maskSrv);
    const struct { int w, h, wave, pad; } setup = { (int)w, (int)h, 64, 0 };
    if (SUCCEEDED(hr)) { r.setupCB = ContactCB(dev, &setup, sizeof setup); if (!r.setupCB) hr = E_FAIL; }
    struct PassC { UINT index; float thickness, bilinear, contrast, invW, invH, sky, maxDepth; };
    for (UINT i = 0; i < 8 && SUCCEEDED(hr); i++)
    {
        const PassC c = { i, g_contactThickness, g_contactBilinear, g_contactContrast, 1.0f / (float)w, 1.0f / (float)h, g_contactSky, g_contactMaxDepth };
        r.passCB[i] = ContactCB(dev, &c, sizeof c);
        if (!r.passCB[i]) hr = E_FAIL;
    }
    // the composite's constants (contact_ps.hlsl), without and with render target 7
    struct CompC { float strength; UINT debug, haveNormal; float fadeStart, fadeEnd, invW, invH, pad; };
    for (UINT i = 0; i < 2 && SUCCEEDED(hr); i++)
    {
        const CompC c = { g_contactStrength, g_contactDebug, i, g_contactFadeStart, g_contactMaxDepth, 1.0f / (float)w, 1.0f / (float)h, 0.0f };
        r.compCB[i] = ContactCB(dev, &c, sizeof c);
        if (!r.compCB[i]) hr = E_FAIL;
    }
    if (FAILED(hr))
    {
        ContactReleaseSized(r);
        r.failed = true;
        Log("contact shadows: the pass's mask (%u x %u) could not be made (0x%08lX): no contact shadows", w, h, (unsigned long)hr);
        return false;
    }
    r.w = w; r.h = h;
    Log("contact shadows: the pass's mask, %u x %u", w, h);
    return true;
}

// the graphics state the composite touches, saved before its draw and put back after (all 128 pixel-shader resource
// slots: binding the colour target as a render target takes it off any slot it sits in)
struct ContactGfxState
{
    D3D11_PRIMITIVE_TOPOLOGY topology;
    ID3D11InputLayout *layout;
    ID3D11VertexShader *vs;
    ID3D11GeometryShader *gs;
    ID3D11HullShader *hs;
    ID3D11DomainShader *ds;
    ID3D11PixelShader *ps;
    ID3D11ShaderResourceView *srv[D3D11_COMMONSHADER_INPUT_RESOURCE_SLOT_COUNT];
    ID3D11Buffer *cb12;
    ID3D11RenderTargetView *rtv[8];
    ID3D11DepthStencilView *dsv;
    ID3D11BlendState *blend;
    FLOAT blendFactor[4];
    UINT sampleMask;
    ID3D11DepthStencilState *dss;
    UINT stencilRef;
    ID3D11RasterizerState *rs;
    UINT viewports, scissors;
    D3D11_VIEWPORT vp[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE];
    D3D11_RECT sc[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE];
};
static void ContactSaveGfx(ID3D11DeviceContext *ctx, ContactGfxState &st)
{
    memset(&st, 0, sizeof st);
    ctx->IAGetPrimitiveTopology(&st.topology);
    ctx->IAGetInputLayout(&st.layout);
    ctx->VSGetShader(&st.vs, nullptr, nullptr);
    ctx->GSGetShader(&st.gs, nullptr, nullptr);
    ctx->HSGetShader(&st.hs, nullptr, nullptr);
    ctx->DSGetShader(&st.ds, nullptr, nullptr);
    ctx->PSGetShader(&st.ps, nullptr, nullptr);
    ctx->PSGetShaderResources(0, D3D11_COMMONSHADER_INPUT_RESOURCE_SLOT_COUNT, st.srv);
    ctx->PSGetConstantBuffers(12, 1, &st.cb12);
    ctx->OMGetRenderTargets(8, st.rtv, &st.dsv);
    ctx->OMGetBlendState(&st.blend, st.blendFactor, &st.sampleMask);
    ctx->OMGetDepthStencilState(&st.dss, &st.stencilRef);
    ctx->RSGetState(&st.rs);
    st.viewports = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    ctx->RSGetViewports(&st.viewports, st.vp);
    st.scissors = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    ctx->RSGetScissorRects(&st.scissors, st.sc);
}
static void ContactRestoreGfx(ID3D11DeviceContext *ctx, ContactGfxState &st)
{
    // the game's targets first (the colour target leaves the output merger before it may go back into a resource slot)
    ctx->OMSetRenderTargetsAndUnorderedAccessViews(8, st.rtv, st.dsv, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
    ctx->OMSetBlendState(st.blend, st.blendFactor, st.sampleMask);
    ctx->OMSetDepthStencilState(st.dss, st.stencilRef);
    ctx->RSSetState(st.rs);
    ctx->RSSetViewports(st.viewports, st.vp);
    ctx->RSSetScissorRects(st.scissors, st.sc);
    ctx->IASetPrimitiveTopology(st.topology);
    ctx->IASetInputLayout(st.layout);
    ctx->VSSetShader(st.vs, nullptr, 0);
    ctx->GSSetShader(st.gs, nullptr, 0);
    ctx->HSSetShader(st.hs, nullptr, 0);
    ctx->DSSetShader(st.ds, nullptr, 0);
    ctx->PSSetShader(st.ps, nullptr, 0);
    ctx->PSSetConstantBuffers(12, 1, &st.cb12);
    ctx->PSSetShaderResources(0, D3D11_COMMONSHADER_INPUT_RESOURCE_SLOT_COUNT, st.srv);
    for (IUnknown *u : { (IUnknown *)st.layout, (IUnknown *)st.vs, (IUnknown *)st.gs, (IUnknown *)st.hs, (IUnknown *)st.ds, (IUnknown *)st.ps, (IUnknown *)st.cb12,
                         (IUnknown *)st.dsv, (IUnknown *)st.blend, (IUnknown *)st.dss, (IUnknown *)st.rs })
        if (u) u->Release();
    for (auto *v : st.srv) if (v) v->Release();
    for (auto *v : st.rtv) if (v) v->Release();
}

// the AO pass is set up on ctx (its inputs bound) and its lit pass is the one whose g_txFactor target is `factor`: the
// contact-shadow pass and its composite (see the top of this section)
static void ContactRun(ID3D11DeviceContext *ctx, ContextState *s, ID3D11Resource *factor)
{
    ID3D11Buffer *cbs[3] = {};
    ctx->PSGetConstantBuffers(0, 3, cbs);
    D3D11_BUFFER_DESC camera = {}, scene = {};
    if (cbs[1]) cbs[1]->GetDesc(&camera);
    if (cbs[2]) cbs[2]->GetDesc(&scene);
    ID3D11ShaderResourceView *z = s->aoZ;
    ID3D11Resource *zRes = nullptr;
    D3D11_TEXTURE2D_DESC zd = {};
    if (z) { z->AddRef(); z->GetResource(&zRes); }
    const bool zOk = zRes && Desc2D(zRes, &zd) && zd.SampleDesc.Count == 1;
    ID3D11Device *dev = nullptr;
    ctx->GetDevice(&dev);
    // the lit pass: its colour target (and a view of this DLL's to draw into it), render targets 6 and 7
    ID3D11RenderTargetView *colourRtv = nullptr, *rt6Rtv = nullptr;
    ID3D11ShaderResourceView *rt6 = nullptr, *rt7 = nullptr;
    UINT cw = 0, ch = 0;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        for (LitPass &p : g_litPasses)
        {
            if (p.factor != factor || !p.rt6Srv || rt6) continue;
            if (p.colourRtv && p.colourRtvOf != p.colour) { g_feedRetired.push_back(p.colourRtv); p.colourRtv = nullptr; }
            if (!p.colourRtv && dev)
            {
                D3D11_RENDER_TARGET_VIEW_DESC v = {};
                v.Format = p.view; v.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
                const HRESULT hr = dev->CreateRenderTargetView(p.colour, &v, &p.colourRtv);
                if (SUCCEEDED(hr)) p.colourRtvOf = p.colour;
                else
                {
                    p.colourRtv = nullptr;
                    static std::atomic<int> said{ 0 };
                    if (said++ == 0) Log("contact shadows: no view of the colour target (format %u) could be made (0x%08lX)", (unsigned)p.view, (unsigned long)hr);
                }
            }
            D3D11_TEXTURE2D_DESC cd = {};
            if (Desc2D(p.colour, &cd)) { cw = cd.Width; ch = cd.Height; }
            rt6 = p.rt6Srv; rt6->AddRef();
            rt6Rtv = p.rt6Rtv; rt6Rtv->AddRef();
            if (p.colourRtv) { colourRtv = p.colourRtv; colourRtv->AddRef(); }
            if (RT7Wanted() && p.rt7Srv) { rt7 = p.rt7Srv; rt7->AddRef(); }
        }
    }
    bool ran = false;
    const bool ready = dev && zOk && colourRtv && rt6 && cw == zd.Width && ch == zd.Height && camera.ByteWidth >= 352 && scene.ByteWidth >= 60 * 16;
    if (ready)
    {
        std::lock_guard<std::mutex> lock(g_contactLock);
        ContactResources &r = g_contactRes;
        if (ContactSetup(dev, zd.Width, zd.Height))
        {
            // the pass: its dispatches listed by one thread (the sun's screen point from the camera and CB_GLOBAL_SCENE),
            // then up to 8 dispatches into the mask
            CSState saved;
            SaveCS(ctx, saved);
            ID3D11Buffer *setupCBs[3] = { r.setupCB, cbs[1], cbs[2] };
            ctx->CSSetConstantBuffers(0, 3, setupCBs);
            ID3D11UnorderedAccessView *setupOut[2] = { r.argsUav, r.listUav };
            ctx->CSSetUnorderedAccessViews(0, 2, setupOut, nullptr);
            ctx->CSSetShader(r.csSetup, nullptr, 0);
            ctx->Dispatch(1, 1, 1);
            ID3D11UnorderedAccessView *none[2] = {};
            ctx->CSSetUnorderedAccessViews(0, 2, none, nullptr);
            const FLOAT lit[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
            ctx->ClearUnorderedAccessViewFloat(r.maskUav, lit);
            ID3D11ShaderResourceView *in[2] = { z, r.listSrv };
            ctx->CSSetShaderResources(0, 2, in);
            ctx->CSSetUnorderedAccessViews(0, 1, &r.maskUav, nullptr);
            ctx->CSSetSamplers(0, 1, &r.border);
            ctx->CSSetShader(r.csPass, nullptr, 0);
            for (UINT i = 0; i < 8; i++) { ctx->CSSetConstantBuffers(0, 1, &r.passCB[i]); ctx->DispatchIndirect(r.args, i * 12); }
            RestoreCS(ctx, saved);
            // the composite over the colour target
            ContactGfxState gfx;
            ContactSaveGfx(ctx, gfx);
            ctx->OMSetRenderTargetsAndUnorderedAccessViews(1, &colourRtv, nullptr, 0, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, nullptr, nullptr);
            const FLOAT noFactor[4] = {};
            ctx->OMSetBlendState(r.multiply, noFactor, 0xffffffff);
            ctx->OMSetDepthStencilState(r.noDepth, 0);
            ctx->RSSetState(r.raster);
            const D3D11_VIEWPORT vp = { 0.0f, 0.0f, (float)zd.Width, (float)zd.Height, 0.0f, 1.0f };
            ctx->RSSetViewports(1, &vp);
            ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx->IASetInputLayout(nullptr);
            ctx->VSSetShader(r.vs, nullptr, 0);
            ctx->GSSetShader(nullptr, nullptr, 0);
            ctx->HSSetShader(nullptr, nullptr, 0);
            ctx->DSSetShader(nullptr, nullptr, 0);
            ctx->PSSetShader(r.ps, nullptr, 0);
            ID3D11ShaderResourceView *compIn[4] = { r.maskSrv, rt6, rt7, z };
            ctx->PSSetShaderResources(112, 4, compIn);
            ctx->PSSetConstantBuffers(12, 1, &r.compCB[rt7 ? 1 : 0]);
            ctx->Draw(3, 0);
            ContactRestoreGfx(ctx, gfx);
            r.lastRun = GetTickCount64();
            ran = true;
            if (g_contactRuns++ == 0)
                Log("contact shadows: first pass on context %p (%s), %u x %u, %s render target 7's normal%s", (void *)ctx,
                    ctx->GetType() == D3D11_DEVICE_CONTEXT_DEFERRED ? "deferred" : "immediate", zd.Width, zd.Height, rt7 ? "with" : "without",
                    g_contactDebug == 1 ? " (ContactDebug 1: the mask alone darkens everything)" : g_contactDebug == 2 ? " (ContactDebug 2: the sun share as darkness)" : "");
        }
    }
    else
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0)
            Log("contact shadows: the pass is wanted but lacks %s", !zOk ? "the AO pass's depth (t80, single sampled)" : !colourRtv || !rt6 ? "the lit pass's colour view or render target 6"
                : cw != zd.Width || ch != zd.Height ? "a depth the size of the colour target" : "the camera or scene constants (b1 352 bytes, b2 960 bytes)");
    }
    // render target 6 back to 0 for the next lit pass (a dump about to record it clears it after its copy)
    if (rt6Rtv && g_dumpState.load(std::memory_order_relaxed) != kDumpRequested) { const FLOAT zero[4] = {}; ctx->ClearRenderTargetView(rt6Rtv, zero); }
    if (ProbeOn()) ProbeEvent(ctx, s, "AO pass: contact shadows %s", ran ? "ran" : "not run");
    for (IUnknown *u : { (IUnknown *)cbs[0], (IUnknown *)cbs[1], (IUnknown *)cbs[2], (IUnknown *)z, (IUnknown *)zRes, (IUnknown *)dev, (IUnknown *)colourRtv,
                         (IUnknown *)rt6Rtv, (IUnknown *)rt6, (IUnknown *)rt7 })
        if (u) u->Release();
}

// The pass's own resources, under g_ssrLock: the depth pyramid (R32F, all levels, a view and a UAV per level), the trace
// grid (RGBA16F at the trace size), the output twice (RGBA16F: t123 and next frame's history, in turn), t124 (RGBA16F),
// last frame's depth (R32F), the constants, two samplers, the five compute shaders. Made again when the size changes;
// the old ones are released a few replacements later (binders may still hold a published view).
struct SSRTex { ID3D11Texture2D *tex; ID3D11ShaderResourceView *srv; ID3D11UnorderedAccessView *uav; };
struct SSRResources
{
    UINT w, h, step, tw, th, levels;
    SSRTex hit, out[2], motion, prev;
    ID3D11Texture2D *hiz;
    ID3D11ShaderResourceView *hizAll;
    std::vector<ID3D11ShaderResourceView *> hizSrv;
    std::vector<ID3D11UnorderedAccessView *> hizUav;
    UINT cur;             // the out[] the next pass writes
    bool prevValid;       // prev holds last frame's depth at this size
    uint32_t frame;
    ULONGLONG lastRun;
    ID3D11Buffer *cb;
    ID3D11SamplerState *linear, *point;
    ID3D11ComputeShader *csHiz0, *csReduce, *csTrace, *csResolve, *csMotion;
    ID3D11Buffer *stats;                  // the trace's counters: rays traced, rays that kept a hit (16 bytes, raw)
    ID3D11UnorderedAccessView *statsUav;
    bool broken;          // something could not be made: the pass stays off
};
static std::mutex g_ssrLock;
static SSRResources g_ssrRes = {};
static std::vector<IUnknown *> g_ssrRetired; // under g_ssrLock

// the cbuffer SSRConstants of src\ssr\ssr_common.hlsli
struct SSRConstants { float size[2], invSize[2]; UINT traceSize[2], step, frame; float roughMax, thickness, temporal; UINT maxSteps, levels, flags; float cone, under;
                      float underShade, underNear, underFar, pad; };
static_assert(sizeof(SSRConstants) == 80, "the cbuffer's layout");
static const UINT kFlagHistory = 1, kFlagMotion = 2, kFlagMirror = 4, kFlagLobe = 8;

static void SSRRetire(IUnknown *u) { if (u) g_ssrRetired.push_back(u); }
static void SSRRetireTex(SSRTex &t) { SSRRetire(t.tex); SSRRetire(t.srv); SSRRetire(t.uav); t = {}; }

static bool SSRTexMake(ID3D11Device *dev, UINT w, UINT h, DXGI_FORMAT fmt, bool uav, SSRTex &t)
{
    D3D11_TEXTURE2D_DESC d = {};
    d.Width = w; d.Height = h; d.MipLevels = 1; d.ArraySize = 1; d.Format = fmt; d.SampleDesc.Count = 1; d.Usage = D3D11_USAGE_DEFAULT;
    d.BindFlags = D3D11_BIND_SHADER_RESOURCE | (uav ? D3D11_BIND_UNORDERED_ACCESS : 0);
    HRESULT hr = dev->CreateTexture2D(&d, nullptr, &t.tex);
    if (SUCCEEDED(hr)) hr = dev->CreateShaderResourceView(t.tex, nullptr, &t.srv);
    if (SUCCEEDED(hr) && uav) hr = dev->CreateUnorderedAccessView(t.tex, nullptr, &t.uav);
    return SUCCEEDED(hr);
}

// under g_ssrLock: everything the pass needs at size w x h; false when something cannot be made (the pass stays off)
static bool SSRSetup(ID3D11Device *dev, UINT w, UINT h)
{
    SSRResources &r = g_ssrRes;
    if (r.broken) return false;
    if (!r.csHiz0)
    {
        HRESULT hr = dev->CreateComputeShader(g_csHizLevel0, sizeof g_csHizLevel0, nullptr, &r.csHiz0);
        if (SUCCEEDED(hr)) hr = dev->CreateComputeShader(g_csHizReduce, sizeof g_csHizReduce, nullptr, &r.csReduce);
        if (SUCCEEDED(hr)) hr = dev->CreateComputeShader(g_csTrace, sizeof g_csTrace, nullptr, &r.csTrace);
        if (SUCCEEDED(hr)) hr = dev->CreateComputeShader(g_csResolve, sizeof g_csResolve, nullptr, &r.csResolve);
        if (SUCCEEDED(hr)) hr = dev->CreateComputeShader(g_csMotion, sizeof g_csMotion, nullptr, &r.csMotion);
        D3D11_BUFFER_DESC b = { sizeof(SSRConstants), D3D11_USAGE_DYNAMIC, D3D11_BIND_CONSTANT_BUFFER, D3D11_CPU_ACCESS_WRITE, 0, 0 };
        if (SUCCEEDED(hr)) hr = dev->CreateBuffer(&b, nullptr, &r.cb);
        D3D11_SAMPLER_DESC sd = {};
        sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR; sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP; sd.MaxLOD = D3D11_FLOAT32_MAX;
        sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
        if (SUCCEEDED(hr)) hr = dev->CreateSamplerState(&sd, &r.linear);
        sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
        if (SUCCEEDED(hr)) hr = dev->CreateSamplerState(&sd, &r.point);
        D3D11_BUFFER_DESC sb = { 16, D3D11_USAGE_DEFAULT, D3D11_BIND_UNORDERED_ACCESS, 0, D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS, 0 };
        if (SUCCEEDED(hr)) hr = dev->CreateBuffer(&sb, nullptr, &r.stats);
        D3D11_UNORDERED_ACCESS_VIEW_DESC su = {};
        su.Format = DXGI_FORMAT_R32_TYPELESS; su.ViewDimension = D3D11_UAV_DIMENSION_BUFFER; su.Buffer.NumElements = 4; su.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
        if (SUCCEEDED(hr)) hr = dev->CreateUnorderedAccessView(r.stats, &su, &r.statsUav);
        if (FAILED(hr)) { r.broken = true; Log("reflections: the compute shaders or their states could not be made (0x%08lX): no reflection pass", (unsigned long)hr); return false; }
    }
    const UINT step = g_ssrHalf ? 2 : 1;
    if (r.w == w && r.h == h && r.step == step && r.hiz) return true;
    // size-dependent resources, anew
    SSRRetireTex(r.hit); SSRRetireTex(r.out[0]); SSRRetireTex(r.out[1]); SSRRetireTex(r.motion); SSRRetireTex(r.prev);
    SSRRetire(r.hiz); SSRRetire(r.hizAll);
    for (auto *v : r.hizSrv) SSRRetire(v);
    for (auto *v : r.hizUav) SSRRetire(v);
    r.hiz = nullptr; r.hizAll = nullptr; r.hizSrv.clear(); r.hizUav.clear();
    g_ssrView.store(nullptr); g_motionView.store(nullptr); g_hizView.store(nullptr);
    while (g_ssrRetired.size() > 64) { g_ssrRetired.front()->Release(); g_ssrRetired.erase(g_ssrRetired.begin()); }
    r.w = w; r.h = h; r.step = step; r.tw = (w + step - 1) / step; r.th = (h + step - 1) / step; r.cur = 0; r.prevValid = false;
    r.levels = 1;
    for (UINT s = w > h ? w : h; s > 1; s >>= 1) r.levels++;
    bool ok = SSRTexMake(dev, r.tw, r.th, DXGI_FORMAT_R16G16B16A16_FLOAT, true, r.hit) && SSRTexMake(dev, w, h, DXGI_FORMAT_R16G16B16A16_FLOAT, true, r.out[0]) &&
        SSRTexMake(dev, w, h, DXGI_FORMAT_R16G16B16A16_FLOAT, true, r.out[1]) && SSRTexMake(dev, w, h, DXGI_FORMAT_R16G16B16A16_FLOAT, true, r.motion) &&
        SSRTexMake(dev, w, h, DXGI_FORMAT_R32_FLOAT, false, r.prev);
    if (ok)
    {
        D3D11_TEXTURE2D_DESC d = {};
        d.Width = w; d.Height = h; d.MipLevels = r.levels; d.ArraySize = 1; d.Format = DXGI_FORMAT_R32_FLOAT; d.SampleDesc.Count = 1;
        d.Usage = D3D11_USAGE_DEFAULT; d.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
        ok = SUCCEEDED(dev->CreateTexture2D(&d, nullptr, &r.hiz)) && SUCCEEDED(dev->CreateShaderResourceView(r.hiz, nullptr, &r.hizAll));
        for (UINT i = 0; ok && i < r.levels; i++)
        {
            D3D11_SHADER_RESOURCE_VIEW_DESC sv = {};
            sv.Format = DXGI_FORMAT_R32_FLOAT; sv.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; sv.Texture2D.MostDetailedMip = i; sv.Texture2D.MipLevels = 1;
            D3D11_UNORDERED_ACCESS_VIEW_DESC uv = {};
            uv.Format = DXGI_FORMAT_R32_FLOAT; uv.ViewDimension = D3D11_UAV_DIMENSION_TEXTURE2D; uv.Texture2D.MipSlice = i;
            ID3D11ShaderResourceView *s = nullptr;
            ID3D11UnorderedAccessView *u = nullptr;
            ok = SUCCEEDED(dev->CreateShaderResourceView(r.hiz, &sv, &s)) && SUCCEEDED(dev->CreateUnorderedAccessView(r.hiz, &uv, &u));
            if (s) r.hizSrv.push_back(s);
            if (u) r.hizUav.push_back(u);
        }
    }
    if (!ok) { r.broken = true; Log("reflections: the textures for %u x %u could not be made: no reflection pass", w, h); return false; }
    Log("reflections: textures for %u x %u, trace grid %u x %u (a ray per %s), depth pyramid of %u levels", w, h, r.tw, r.th, step == 1 ? "pixel" : "2 x 2 block", r.levels);
    return true;
}

// under g_ssrLock: the constants for this context's next dispatches (a dynamic buffer is mapped on every context that uses it)
static void SSRConstantsWrite(ID3D11DeviceContext *ctx, const SSRResources &r, UINT flags)
{
    D3D11_MAPPED_SUBRESOURCE m = {};
    if (FAILED(ctx->Map(r.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &m)) || !m.pData) return;
    const SSRConstants c = { { (float)r.w, (float)r.h }, { 1.0f / r.w, 1.0f / r.h }, { r.tw, r.th }, r.step, r.frame, g_ssrRoughMax, g_ssrThickness, g_ssrTemporal,
                             g_ssrSteps, r.levels, flags, g_ssrCone, g_ssrUnder, g_ssrUnderShade, g_ssrUnderNear, g_ssrUnderFar, 0 };
    memcpy(m.pData, &c, sizeof c);
    ctx->Unmap(r.cb, 0);
}

// The pass's GPU time: timestamp queries around its dispatches (on the pass's own context), read on the immediate context
// once the command lists have run; the average goes to the log every 10 s and at exit. Queries that never answer (no
// timestamps from deferred contexts on some driver) switch the timing off. Under g_ssrLock.
struct SSRTimer { ID3D11Query *disjoint, *begin, *end; ID3D11Buffer *stats; ULONGLONG issued; bool pending; }; // stats: a staging copy of the trace's counters
static const int kSSRTimers = 8;
static SSRTimer g_ssrTimers[kSSRTimers] = {};
static int g_ssrTimerNext = 0;
static std::atomic<bool> g_ssrTimingOff{ false };
static double g_ssrGpuSum = 0, g_ssrGpuAll = 0;
static uint64_t g_ssrGpuN = 0, g_ssrGpuAllN = 0, g_ssrRaySum = 0, g_ssrHitSum = 0, g_ssrStatN = 0, g_ssrCells = 0;
static ULONGLONG g_ssrGpuLogged = 0;

static SSRTimer *SSRTimerStart(ID3D11Device *dev, ID3D11DeviceContext *ctx)
{
    if (g_ssrTimingOff) return nullptr;
    SSRTimer &t = g_ssrTimers[g_ssrTimerNext % kSSRTimers];
    if (t.pending)
    {
        if (GetTickCount64() - t.issued > 3000) { g_ssrTimingOff = true; Log("reflections: the GPU timing queries get no answers: timing off"); }
        return nullptr;
    }
    if (!t.disjoint)
    {
        D3D11_QUERY_DESC qd = { D3D11_QUERY_TIMESTAMP_DISJOINT, 0 };
        dev->CreateQuery(&qd, &t.disjoint);
        qd.Query = D3D11_QUERY_TIMESTAMP;
        dev->CreateQuery(&qd, &t.begin);
        dev->CreateQuery(&qd, &t.end);
        D3D11_BUFFER_DESC sb = { 16, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0, 0 };
        dev->CreateBuffer(&sb, nullptr, &t.stats);
        if (!t.disjoint || !t.begin || !t.end) { g_ssrTimingOff = true; Log("reflections: no timestamp queries: timing off"); return nullptr; }
    }
    ctx->Begin(t.disjoint);
    ctx->End(t.begin);
    g_ssrTimerNext++;
    return &t;
}
static void SSRTimerEnd(ID3D11DeviceContext *ctx, SSRTimer *t, ID3D11Buffer *stats)
{
    if (t->stats && stats) ctx->CopyResource(t->stats, stats);
    ctx->End(t->end);
    ctx->End(t->disjoint);
    t->pending = true;
    t->issued = GetTickCount64();
}
// the immediate context, after a command list ran: the answered timers
static void SSRPollTimers(ID3D11DeviceContext *immediate)
{
    if (g_ssrTimingOff) return;
    std::lock_guard<std::mutex> lock(g_ssrLock);
    for (SSRTimer &t : g_ssrTimers)
    {
        if (!t.pending) continue;
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj = {};
        UINT64 a = 0, b = 0;
        if (immediate->GetData(t.disjoint, &dj, sizeof dj, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        if (immediate->GetData(t.begin, &a, sizeof a, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK || immediate->GetData(t.end, &b, sizeof b, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        t.pending = false;
        D3D11_MAPPED_SUBRESOURCE m = {};
        if (t.stats && SUCCEEDED(immediate->Map(t.stats, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &m)) && m.pData)
        {
            uint32_t c[2];
            memcpy(c, m.pData, sizeof c);
            immediate->Unmap(t.stats, 0);
            g_ssrRaySum += c[0]; g_ssrHitSum += c[1]; g_ssrStatN++;
        }
        if (dj.Disjoint || !dj.Frequency || b < a) continue;
        const double ms = (double)(b - a) * 1000.0 / (double)dj.Frequency;
        g_ssrGpuSum += ms; g_ssrGpuN++;
        g_ssrGpuAll += ms; g_ssrGpuAllN++;
    }
    const ULONGLONG now = GetTickCount64();
    if (g_ssrGpuN >= 30 && now - g_ssrGpuLogged >= 10000)
    {
        const double rays = g_ssrStatN ? (double)g_ssrRaySum / g_ssrStatN : 0, hits = g_ssrStatN ? (double)g_ssrHitSum / g_ssrStatN : 0;
        Log("reflections: the pass took %.3f ms of GPU time on average over the last %llu passes; per pass %.0f rays (%.2f %% of the trace grid), %.1f %% of them kept a hit",
            g_ssrGpuSum / g_ssrGpuN, (unsigned long long)g_ssrGpuN, rays, g_ssrCells ? 100.0 * rays / g_ssrCells : 0.0, rays > 0 ? 100.0 * hits / rays : 0.0);
        g_ssrGpuSum = 0; g_ssrGpuN = 0; g_ssrGpuLogged = now;
        g_ssrRaySum = g_ssrHitSum = g_ssrStatN = 0;
    }
}

static void ProbeEvent(ID3D11DeviceContext *ctx, ContextState *s, const char *fmt, ...);
static bool ProbeOn();

// The AO pass is set up on ctx and the feed copied for it (its g_txFactor target: factor): the pass, recorded on the same
// context, so it runs where the lit scene is complete and before anything is drawn over it. With a dump requested,
// render target 7 is cleared by the dump after its copy instead of here.
static void SSRRun(ID3D11DeviceContext *ctx, ContextState *s, ID3D11Resource *factor)
{
    ID3D11Buffer *camera = nullptr;
    ctx->PSGetConstantBuffers(1, 1, &camera);
    D3D11_BUFFER_DESC cbd = {};
    if (camera) camera->GetDesc(&cbd);
    if (!camera || cbd.ByteWidth < 352)
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("reflections: no camera constants at b1 of the AO pass (%s, %u bytes): no reflection pass", camera ? "a buffer" : "nothing", cbd.ByteWidth);
        if (camera) camera->Release();
        return;
    }
    ID3D11ShaderResourceView *colour = nullptr, *depth = nullptr, *normal = nullptr, *rt7 = nullptr;
    ID3D11Texture2D *depthTex = nullptr;
    ID3D11RenderTargetView *rt7Rtv = nullptr;
    UINT w = 0, h = 0;
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        const FeedTexture &c = g_feedTex[0], &z = g_feedTex[1];
        if (c.srv && z.srv && c.w == z.w && c.h == z.h)
        {
            colour = c.srv; depth = z.srv; depthTex = z.tex; w = z.w; h = z.h;
            colour->AddRef(); depth->AddRef(); depthTex->AddRef();
        }
        for (LitPass &p : g_litPasses)
            if (p.factor == factor && p.rt7Srv) { rt7 = p.rt7Srv; rt7->AddRef(); rt7Rtv = p.rt7Rtv; rt7Rtv->AddRef(); }
    }
    const bool mirror = g_ssrMirror;
    ID3D11Device *dev = nullptr;
    ctx->GetDevice(&dev);
    bool ran = false;
    if (dev && colour && depth && (rt7 || mirror))
    {
        std::lock_guard<std::mutex> lock(g_ssrLock);
        SSRResources &r = g_ssrRes;
        if (SSRSetup(dev, w, h))
        {
            const ULONGLONG now = GetTickCount64(), lastMotion = g_motionLastRun.load(std::memory_order_relaxed);
            UINT flags = (mirror ? kFlagMirror : 0) | (g_ssrLobe ? kFlagLobe : 0);
            if (r.prevValid && now - r.lastRun < 200) flags |= kFlagHistory;
            if (lastMotion && now - lastMotion < 250) flags |= kFlagMotion;
            SSRConstantsWrite(ctx, r, flags);
            CSState saved;
            SaveCS(ctx, saved);
            ID3D11Buffer *cbs[2] = { r.cb, camera };
            ctx->CSSetConstantBuffers(0, 2, cbs);
            ID3D11SamplerState *samplers[2] = { r.linear, r.point };
            ctx->CSSetSamplers(0, 2, samplers);
            SSRTimer *timer = SSRTimerStart(dev, ctx);
            // the depth pyramid (the pass profile times each stage on its own)
            ProfOurs(ctx, s, kProfSSRHiZ);
            ctx->CSSetShader(r.csHiz0, nullptr, 0);
            ctx->CSSetUnorderedAccessViews(0, 1, &r.hizUav[0], nullptr);
            ctx->CSSetShaderResources(0, 1, &depth);
            ctx->Dispatch((w + 7) / 8, (h + 7) / 8, 1);
            ctx->CSSetShader(r.csReduce, nullptr, 0);
            for (UINT i = 1; i < r.levels; i++)
            {
                ctx->CSSetUnorderedAccessViews(0, 1, &r.hizUav[i], nullptr);
                ctx->CSSetShaderResources(0, 1, &r.hizSrv[i - 1]);
                const UINT lw = w >> i ? w >> i : 1, lh = h >> i ? h >> i : 1;
                ctx->Dispatch((lw + 7) / 8, (lh + 7) / 8, 1);
            }
            // the trace (its counters cleared first)
            ProfOurs(ctx, s, kProfSSRTrace);
            const UINT zeros[4] = {};
            ctx->ClearUnorderedAccessViewUint(r.statsUav, zeros);
            ID3D11UnorderedAccessView *traceOut[2] = { r.hit.uav, r.statsUav };
            ctx->CSSetUnorderedAccessViews(0, 2, traceOut, nullptr);
            ID3D11ShaderResourceView *traceIn[5] = { colour, depth, normal, rt7, r.hizAll };
            ctx->CSSetShaderResources(0, 5, traceIn);
            ctx->CSSetShader(r.csTrace, nullptr, 0);
            ctx->Dispatch((r.tw + 7) / 8, (r.th + 7) / 8, 1);
            g_ssrCells = (uint64_t)r.tw * r.th;
            // the resolve into this frame's output, with the last one as the history
            ProfOurs(ctx, s, kProfSSRResolve);
            ID3D11UnorderedAccessView *resolveOut[2] = { r.out[r.cur].uav, nullptr };
            ctx->CSSetUnorderedAccessViews(0, 2, resolveOut, nullptr);
            ID3D11ShaderResourceView *resolveIn[7] = { r.hit.srv, depth, normal, rt7, r.out[r.cur ^ 1].srv, r.prev.srv, r.motion.srv };
            ctx->CSSetShaderResources(0, 7, resolveIn);
            ctx->CSSetShader(r.csResolve, nullptr, 0);
            ctx->Dispatch((w + 7) / 8, (h + 7) / 8, 1);
            if (timer) SSRTimerEnd(ctx, timer, r.stats);
            RestoreCS(ctx, saved);
            // next frame's history needs this frame's depth; render target 7 back to up/rough for the next lit pass
            ProfOurs(ctx, s, kProfSSRHistory);
            ctx->CopyResource(r.prev.tex, depthTex);
            if (rt7Rtv && g_dumpState.load(std::memory_order_relaxed) != kDumpRequested) ctx->ClearRenderTargetView(rt7Rtv, kUpRough);
            r.prevValid = true;
            r.lastRun = now;
            r.frame++;
            g_ssrView.store(r.out[r.cur].srv, std::memory_order_release);
            g_hizView.store(r.hizAll, std::memory_order_release); // this frame's pyramid, for the water's march (t125)
            r.cur ^= 1;
            g_ssrLastRun.store(now, std::memory_order_relaxed);
            ran = true;
            if (g_ssrRuns++ == 0)
                Log("reflections: first pass on context %p (%s), %u x %u%s", (void *)ctx, ctx->GetType() == D3D11_DEVICE_CONTEXT_DEFERRED ? "deferred" : "immediate", w, h,
                    mirror ? ", SSRMirror (debug): every pixel a mirror" : "");
        }
    }
    else
    {
        static std::atomic<int> said{ 0 };
        if (said++ == 0) Log("reflections: the pass is wanted but lacks %s", !colour || !depth ? "the feed's copies" : "render target 7");
    }
    if (ProbeOn()) ProbeEvent(ctx, s, "AO pass: feed copied, reflection pass %s", ran ? "ran" : "not run");
    for (IUnknown *u : { (IUnknown *)camera, (IUnknown *)colour, (IUnknown *)depth, (IUnknown *)depthTex, (IUnknown *)normal, (IUnknown *)rt7, (IUnknown *)rt7Rtv, (IUnknown *)dev })
        if (u) u->Release();
}

// The TAA pass is set up on ctx with the game's velocity texture at t3: t124 decoded from it, for this frame (the
// material shaders read it next frame beside t123, the resolve reads it next frame too). Only while the pass runs.
static void ProbeTAA(ID3D11DeviceContext *ctx);
static void SSRMotionAtTAA(ID3D11DeviceContext *ctx, ContextState *s)
{
    ID3D11ShaderResourceView *vel = nullptr;
    ctx->PSGetShaderResources(3, 1, &vel);
    if (!vel) return;
    s->motionDone = true;
    ProbeTAA(ctx);
    const ULONGLONG now = GetTickCount64(), last = g_ssrLastRun.load(std::memory_order_relaxed);
    if (last && now - last < 250 && SSRPassWanted())
    {
        std::lock_guard<std::mutex> lock(g_ssrLock);
        SSRResources &r = g_ssrRes;
        if (!r.broken && r.motion.uav)
        {
            SSRConstantsWrite(ctx, r, 0);
            ProfOurs(ctx, s, kProfSSRMotion);
            CSState saved;
            SaveCS(ctx, saved);
            ctx->CSSetConstantBuffers(0, 1, &r.cb);
            ctx->CSSetSamplers(1, 1, &r.point);
            ctx->CSSetUnorderedAccessViews(0, 1, &r.motion.uav, nullptr);
            ctx->CSSetShaderResources(0, 1, &vel);
            ctx->CSSetShader(r.csMotion, nullptr, 0);
            ctx->Dispatch((r.w + 7) / 8, (r.h + 7) / 8, 1);
            RestoreCS(ctx, saved);
            ProfResume(ctx, s);
            g_motionView.store(r.motion.srv, std::memory_order_release);
            g_motionLastRun.store(now, std::memory_order_relaxed);
            if (g_motionRuns++ == 0) Log("reflections: t124 first decoded from the TAA's velocity texture (on context %p)", (void *)ctx);
            if (ProbeOn()) ProbeEvent(ctx, s, "TAA: t124 decoded");
        }
    }
    vel->Release();
}

// a shader that reads the reflections is set (or the game reset its slots): t123 and t124 while the pass keeps running
// (t124 while the TAA keeps feeding it), else nothing, so a stopped pass leaves no stale reflections behind
static void SSRBind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11ShaderResourceView *v[2] = { g_ssrView.load(std::memory_order_acquire), g_motionView.load(std::memory_order_acquire) };
    const ULONGLONG now = GetTickCount64(), last = g_ssrLastRun.load(std::memory_order_relaxed), lastMotion = g_motionLastRun.load(std::memory_order_relaxed);
    if (!last || now - last > 250 || g_stockAll.load(std::memory_order_relaxed) || !g_ssrOn.load(std::memory_order_relaxed)) v[0] = v[1] = nullptr;
    if (!lastMotion || now - lastMotion > 250) v[1] = nullptr;
    o->psSRV(ctx, kSSRSlot, 2, v);
    g_ssrBinds++;
}

// a shader that marches the depth pyramid is set (or the game reset its slot): the pass's pyramid at t125 while the pass
// keeps running, else nothing (the water's helper then marches the depth buffer as it did before the pyramid)
static void HiZBind(ID3D11DeviceContext *ctx, const ContextOrig *o)
{
    ID3D11ShaderResourceView *v = g_hizView.load(std::memory_order_acquire);
    const ULONGLONG now = GetTickCount64(), last = g_ssrLastRun.load(std::memory_order_relaxed);
    if (!last || now - last > 250 || g_stockAll.load(std::memory_order_relaxed) || !g_ssrOn.load(std::memory_order_relaxed)) v = nullptr;
    o->psSRV(ctx, kHiZSlot, 1, &v);
    g_hizBinds++;
}

// ---- probe (SSRProbe=1): 20 s after the AO pass first ran, and again with every dump request (F7, DumpAfter: the first
// may fall into a menu), 200 ms of the frame's passes in the order they run (events recorded on a deferred context
// travel with its command list and join the timeline when the list is executed), written to SnowRunnerShadows.probe.log
// (rewritten each time); the formats involved go to the log as each is first seen.
enum ProbeState : int { kProbeWaiting = 0, kProbeRecording, kProbeDone };
static std::atomic<int> g_probeState{ kProbeWaiting };
static std::atomic<ULONGLONG> g_probeStart{ 0 };
static std::mutex g_probeLock;
static std::string g_probeTimeline;                                        // under g_probeLock
static std::unordered_map<ID3D11CommandList *, std::string> g_probeLists;  // under g_probeLock: finished, not yet run
static const ULONGLONG kProbeAfter = 20000, kProbeLength = 200;

static bool ProbeOn() { return g_probeState.load(std::memory_order_relaxed) == kProbeRecording; }
// the hotkey thread (a dump request, the depth probe's time): 200 ms recorded again from now; the file is rewritten when
// they are over
static bool ProbeRestart(const char *why = "with the dump")
{
    if (!g_ssr || !g_ssrProbe || g_probeState.load() == kProbeRecording) return false;
    {
        std::lock_guard<std::mutex> lock(g_probeLock);
        g_probeTimeline.clear();
        g_probeLists.clear();
    }
    g_probeStart = GetTickCount64();
    g_probeState = kProbeRecording;
    Log("probe: recording %llu ms of the frame's passes (%s)", kProbeLength, why);
    return true;
}
static void DPArm(); // the depth probe copies in the next frame of the recording
static void ProbeEvent(ID3D11DeviceContext *ctx, ContextState *s, const char *fmt, ...)
{
    char line[1024];
    va_list args; va_start(args, fmt); vsnprintf(line, sizeof line, fmt, args); va_end(args);
    if (ctx->GetType() == D3D11_DEVICE_CONTEXT_DEFERRED) { s->probe += "    "; s->probe += line; s->probe += "\r\n"; return; }
    std::lock_guard<std::mutex> lock(g_probeLock);
    g_probeTimeline += "  immediate context: ";
    g_probeTimeline += line;
    g_probeTimeline += "\r\n";
}
static void ProbeFinished(ContextState *s, ID3D11CommandList *list)
{
    if (list && ProbeOn()) { std::lock_guard<std::mutex> lock(g_probeLock); g_probeLists[list] = std::move(s->probe); }
    s->probe.clear();
}
static void ProbeExecuted(ID3D11CommandList *list)
{
    std::lock_guard<std::mutex> lock(g_probeLock);
    const auto it = g_probeLists.find(list);
    char head[80];
    snprintf(head, sizeof head, "  command list %p runs%s\r\n", (void *)list, it == g_probeLists.end() ? " (nothing of note recorded in it)" : ":");
    g_probeTimeline += head;
    if (it != g_probeLists.end()) { g_probeTimeline += it->second; g_probeLists.erase(it); }
}
// the hotkey thread, every 30 ms: start and stop, and the file
static void ProbeTick(ULONGLONG now)
{
    if (!g_ssrProbe) return;
    const int state = g_probeState.load();
    const ULONGLONG first = g_dumpFirstAO.load(std::memory_order_relaxed);
    // the depth probe at its own time (DepthProbe=N: N s after the AO pass first ran), once
    static bool depthTimed = false;
    if (g_depthProbe > 1 && !depthTimed && first && now - first >= g_depthProbe * 1000ULL && state != kProbeRecording)
    {
        depthTimed = true;
        if (ProbeRestart("the depth probe's time")) DPArm();
        return;
    }
    if (state == kProbeWaiting && first && now - first >= kProbeAfter)
    {
        g_probeStart = now;
        g_probeState = kProbeRecording;
        Log("probe: recording %llu ms of the frame's passes", kProbeLength);
        if (g_depthProbe == 1) DPArm();
    }
    else if (state == kProbeRecording && now - g_probeStart.load() >= kProbeLength)
    {
        g_probeState = kProbeDone;
        std::string text;
        {
            std::lock_guard<std::mutex> lock(g_probeLock);
            text.swap(g_probeTimeline);
            g_probeLists.clear();
        }
        const std::wstring path = g_dir + L"SnowRunnerShadows.probe.log";
        FILE *f = nullptr;
        if (_wfopen_s(&f, path.c_str(), L"wb") == 0 && f)
        {
            static const char head[] = "SnowRunner Shadows probe: the passes of about 200 ms in the order they ran (deferred contexts' events under the command list that carried them)\r\n";
            fwrite(head, 1, sizeof head - 1, f);
            fwrite(text.data(), 1, text.size(), f);
            fclose(f);
            Log("probe: %zu bytes written to %ls", text.size(), path.c_str());
        }
        else Log("probe: %ls could not be written", path.c_str());
    }
}

// a texture view's resource in a few words: size, format, samples, bind flags (and the view's format)
static std::string DescribeView(ID3D11View *v, DXGI_FORMAT viewFormat)
{
    char s[160];
    if (!v) return "none";
    ID3D11Resource *r = nullptr;
    v->GetResource(&r);
    D3D11_TEXTURE2D_DESC d = {};
    if (Desc2D(r, &d))
        snprintf(s, sizeof s, "%p %u x %u format %u (view %u) mips %u samples %u bind 0x%X", (void *)r, d.Width, d.Height, (unsigned)d.Format, (unsigned)viewFormat, d.MipLevels,
            d.SampleDesc.Count, d.BindFlags);
    else snprintf(s, sizeof s, "%p (not a 2D texture)", (void *)r);
    if (r) r->Release();
    return s;
}
static std::string DescribeRTV(ID3D11RenderTargetView *v) { D3D11_RENDER_TARGET_VIEW_DESC d = {}; if (v) v->GetDesc(&d); return DescribeView(v, d.Format); }
static std::string DescribeSRV(ID3D11ShaderResourceView *v) { D3D11_SHADER_RESOURCE_VIEW_DESC d = {}; if (v) v->GetDesc(&d); return DescribeView(v, d.Format); }

static void ProbeLitPass(ID3D11RenderTargetView *const *rtvs)
{
    static std::atomic<int> said{ 0 };
    if (!g_ssr || said.exchange(1)) return;
    Log("reflections: the lit pass's targets: 0 %s; 1 %s; 2 %s", DescribeRTV(rtvs[0]).c_str(), DescribeRTV(rtvs[1]).c_str(), DescribeRTV(rtvs[2]).c_str());
}
static void ProbeTAA(ID3D11DeviceContext *ctx)
{
    ID3D11ShaderResourceView *v[7] = {};
    ctx->PSGetShaderResources(0, 7, v);
    ID3D11Resource *vel = nullptr;
    if (v[3]) v[3]->GetResource(&vel);
    g_velocityRes.store(vel);
    if (vel) vel->Release(); // compared by address only
    static std::atomic<int> said{ 0 };
    if (said.exchange(1) == 0)
        Log("reflections: the TAA pass reads t2 %s; t3 (velocity) %s; t6 %s", DescribeSRV(v[2]).c_str(), DescribeSRV(v[3]).c_str(), DescribeSRV(v[6]).c_str());
    for (auto *x : v) if (x) x->Release();
}
static void ProbeVelocityShader(ID3D11DeviceContext *ctx, ContextState *s)
{
    ID3D11RenderTargetView *rtvs[2] = {};
    ID3D11DepthStencilView *dsv = nullptr;
    ctx->OMGetRenderTargets(2, rtvs, &dsv);
    static std::atomic<int> said{ 0 };
    if (said.exchange(1) == 0)
        Log("reflections: the game's velocity shader draws into 0 %s; 1 %s; depth %s", DescribeRTV(rtvs[0]).c_str(), DescribeRTV(rtvs[1]).c_str(), dsv ? "bound" : "none");
    if (ProbeOn()) ProbeEvent(ctx, s, "velocity shader set (target 0 %p)", (void *)rtvs[0]);
    for (auto *r : rtvs) if (r) r->Release();
    if (dsv) dsv->Release();
}
// the game changed its targets: note the ones that matter to the timeline
static void ProbeTargets(ID3D11DeviceContext *ctx, ContextState *s, UINT n, ID3D11RenderTargetView *const *rtvs, bool uavs)
{
    if (!rtvs || !n || !rtvs[0]) return;
    ID3D11Resource *r = nullptr;
    rtvs[0]->GetResource(&r);
    if (n == 3) ProbeEvent(ctx, s, "lit pass targets bound (colour %p)%s", (void *)r, uavs ? " with UAVs" : "");
    else if (r && r == g_velocityRes.load()) ProbeEvent(ctx, s, "velocity texture bound as target 0 (%u targets)", n);
    else
    {
        bool ao = false;
        {
            std::lock_guard<std::mutex> lock(g_feedLock);
            for (ID3D11Resource *k : g_aoTargets) ao |= k == r;
        }
        if (ao) ProbeEvent(ctx, s, "AO target bound");
    }
    if (r) r->Release();
}

// ---- depth probe (ini DepthProbe, dev): for contact shadows, whether the scene depth is complete before
// the lit pass draws. While the probe above records, each binding of targets whose depth target is the size of the scene
// depth adds a line to the timeline when it ends: its targets, the depth texture, its draws, how many had no pixel
// shader, the depth-stencil states and vertex shaders they drew with. In one frame of a recording (DepthProbe=1: the
// probe's first, 20 s after the AO pass first ran, which may be the title screen's scene; N >= 2: one of its own N s
// after that) the scene depth (the lit pass's depth target) is copied three times: (0) at the immediate context's first
// lit-pass pixel shader, (1) on the immediate context right before the first command list with a lit-pass draw runs,
// (2) at the AO pass; and with (1), (3) the other depth texture of the scene's size bound last, if any. The log names
// the depth texture each of that frame's and the next two frames' lit passes used. Two Presents later the copies are
// read on the immediate context and written to SnowRunnerShadows.depth<i>.raw (a 32-byte header: 'SRDZ', width,
// height, DXGI format, bytes per texel, row bytes, copy, 0; then the rows as the GPU holds them) for
// tools\depth_probe.js. What the game draws is not changed.
static const GUID kDPListTag = { 0x3c2b7d10, 0x5a41, 0x4f0e, { 0x8d, 0x6b, 0x21, 0x9e, 0x47, 0x0a, 0xc3, 0x55 } };
enum DPPhase : int { kDPIdle = 0, kDPCopying, kDPWaiting, kDPDone };
static std::atomic<int> g_dpPhase{ kDPIdle };
static std::atomic<bool> g_dpArmed{ false };    // the next frame of the recording is copied
static int g_dpWaited = 0;                      // Presents since the copied frame (the thread that presents)
static std::mutex g_dpLock;                     // the rest
static ID3D11Resource *g_dpDepth = nullptr;     // the lit pass's depth target, held
static ID3D11Resource *g_dpOther = nullptr;     // the other depth texture of its size bound last, held
static ID3D11Texture2D *g_dpCopy[4] = {};       // staging copies of them
static const char *const kDPWhere[4] = { "at the immediate context's first lit-pass pixel shader", "before the first command list with a lit-pass draw",
    "at the AO pass", "the other depth texture of the scene's size, before the first command list with a lit-pass draw" };
static const char *ProfFormat(UINT f);
static uint32_t ShaderHash(ID3D11DeviceChild *s);

// the hotkey thread, with a recording just begun: copies in its next frame (again, after an earlier one)
static void DPArm()
{
    int phase = g_dpPhase.load();
    if (phase == kDPCopying || phase == kDPWaiting) return;
    g_dpPhase = kDPIdle;
    g_dpArmed = true;
}
// the lit pass's targets were bound with dsv: its texture is the scene depth
static void DPRememberDepth(ID3D11DepthStencilView *dsv)
{
    if (!dsv) return;
    ID3D11Resource *r = nullptr;
    dsv->GetResource(&r);
    std::lock_guard<std::mutex> lock(g_dpLock);
    if (r == g_dpDepth) { if (r) r->Release(); return; }
    if (g_dpDepth) g_dpDepth->Release();
    g_dpDepth = r; // (GetResource's reference)
}
// copy i recorded on ctx now (of the scene depth; copy 3 of the other depth texture), once, in the frame being copied
static void DPCopy(ID3D11DeviceContext *ctx, ContextState *s, int i)
{
    if (g_dpPhase.load() != kDPCopying) return;
    {
        std::lock_guard<std::mutex> lock(g_dpLock);
        ID3D11Resource *src = i == 3 ? g_dpOther : g_dpDepth;
        if (!src || g_dpCopy[i]) return;
        D3D11_TEXTURE2D_DESC d = {};
        if (!Desc2D(src, &d)) return;
        if (d.SampleDesc.Count != 1) { Log("depth probe: copy %d is of a multisampled texture (%u samples): not copied", i, d.SampleDesc.Count); return; }
        d.Usage = D3D11_USAGE_STAGING; d.BindFlags = 0; d.CPUAccessFlags = D3D11_CPU_ACCESS_READ; d.MiscFlags = 0;
        ID3D11Device *dev = nullptr;
        ctx->GetDevice(&dev);
        const HRESULT hr = dev ? dev->CreateTexture2D(&d, nullptr, &g_dpCopy[i]) : E_FAIL;
        if (dev) dev->Release();
        if (FAILED(hr) || !g_dpCopy[i]) { g_dpCopy[i] = nullptr; Log("depth probe: no staging texture for copy %d (format %u, 0x%08lX)", i, (unsigned)d.Format, (unsigned long)hr); return; }
        ctx->CopyResource(g_dpCopy[i], src);
    }
    if (ProbeOn()) ProbeEvent(ctx, s, "DEPTH PROBE: copy %d (%s)", i, kDPWhere[i]);
}
// the counts of the binding that ends now, as a line of the timeline
static void DPFlush(ID3D11DeviceContext *ctx, ContextState *s)
{
    if (!s->dpBinding) return;
    s->dpBinding = false;
    if (!ProbeOn()) return;
    static const char *const funcs[9] = { "?", "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always" };
    std::string line = s->dpTargets;
    char part[96];
    snprintf(part, sizeof part, ": %u draws, %u without a pixel shader", s->dpDraws, s->dpNoPs);
    line += part;
    if (!s->dpStates.empty()) line += "; depth";
    for (const auto &k : s->dpStates)
    {
        const uint32_t func = (k.first >> 2) & 15;
        if (k.first == 0xffffffffu) snprintf(part, sizeof part, " [default state] x%u", k.second);
        else snprintf(part, sizeof part, " [test %u write %u %s%s] x%u", k.first & 1, (k.first >> 1) & 1, funcs[func < 9 ? func : 0], (k.first & 64) ? " stencil" : "", k.second);
        line += part;
    }
    std::sort(s->dpVS.begin(), s->dpVS.end(), [](const std::pair<uint32_t, UINT> &x, const std::pair<uint32_t, UINT> &y) { return x.second > y.second; });
    if (!s->dpVS.empty()) line += "; vertex shaders";
    for (size_t i = 0; i < s->dpVS.size() && i < 12; i++) { snprintf(part, sizeof part, " %08X x%u", s->dpVS[i].first, s->dpVS[i].second); line += part; }
    if (s->dpVS.size() > 12) { snprintf(part, sizeof part, " (+%zu more)", s->dpVS.size() - 12); line += part; }
    ProbeEvent(ctx, s, "%s", line.c_str());
}
// targets were bound on ctx: the lit pass's depth remembered; a binding whose depth target is the scene depth's size
// counted for the timeline
static void DPTargets(ID3D11DeviceContext *ctx, ContextState *s, UINT n, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv)
{
    DPFlush(ctx, s);
    s->dpLit = n == 3 && rtvs && rtvs[0] && rtvs[2];
    if (s->dpLit) DPRememberDepth(dsv);
    if (!ProbeOn() || !dsv) return;
    ID3D11Resource *r = nullptr;
    dsv->GetResource(&r);
    D3D11_TEXTURE2D_DESC d = {}, sd = {};
    const bool known = Desc2D(r, &d);
    bool scene = false, sized = false;
    {
        std::lock_guard<std::mutex> lock(g_dpLock);
        scene = r && r == g_dpDepth;
        sized = g_dpDepth && Desc2D(g_dpDepth, &sd) && known && d.Width == sd.Width && d.Height == sd.Height;
        if (!scene && sized && r != g_dpOther) { if (g_dpOther) g_dpOther->Release(); g_dpOther = r; r->AddRef(); } // (for copy 3)
    }
    const void *tex = r;
    if (r) r->Release();
    if (!scene && !sized) return;
    s->dpBinding = true;
    s->dpDraws = s->dpNoPs = 0;
    s->dpStates.clear();
    s->dpVS.clear();
    s->dpLastDS = nullptr;
    char t[240];
    int at = snprintf(t, sizeof t, "targets");
    for (UINT i = 0; rtvs && i < n && i < 8 && at > 0 && at < (int)sizeof t; i++)
    {
        D3D11_RENDER_TARGET_VIEW_DESC v = {};
        if (rtvs[i]) rtvs[i]->GetDesc(&v);
        const char *name = rtvs[i] ? ProfFormat(v.Format) : "none";
        at += name ? snprintf(t + at, sizeof t - at, " %s", name) : snprintf(t + at, sizeof t - at, " fmt%u", (unsigned)v.Format);
    }
    if (at > 0 && at < (int)sizeof t) snprintf(t + at, sizeof t - at, " + depth %u x %u %p%s", d.Width, d.Height, tex, scene ? " (the scene depth)" : " (another of its size)");
    s->dpTargets = t;
}
// a draw recorded on ctx: counted for the binding's line; a lit-pass draw with a pixel shader marks the command list
static void DPDraw(ID3D11DeviceContext *ctx, ContextState *s)
{
    if (s->dpLit && s->dpPs) s->dpListLit = true;
    if (!s->dpBinding) return;
    s->dpDraws++;
    if (!s->dpPs) s->dpNoPs++;
    ID3D11DepthStencilState *ds = nullptr;
    UINT ref = 0;
    ctx->OMGetDepthStencilState(&ds, &ref);
    if (ds != s->dpLastDS || !ds)
    {
        uint32_t key = 0xffffffffu; // (no state set: the default, test and write with less)
        if (ds)
        {
            D3D11_DEPTH_STENCIL_DESC d = {};
            ds->GetDesc(&d);
            key = (d.DepthEnable ? 1u : 0u) | (d.DepthWriteMask == D3D11_DEPTH_WRITE_MASK_ALL ? 2u : 0u) | ((uint32_t)d.DepthFunc << 2) | (d.StencilEnable ? 64u : 0u);
        }
        s->dpLastDS = ds; // (compared by address only)
        s->dpLastKey = key;
    }
    if (ds) ds->Release();
    auto bump = [](std::vector<std::pair<uint32_t, UINT>> &v, uint32_t k) {
        for (auto &e : v) if (e.first == k) { e.second++; return; }
        if (v.size() < 64) v.push_back({ k, 1 });
    };
    bump(s->dpStates, s->dpLastKey);
    ID3D11VertexShader *vs = nullptr;
    ctx->VSGetShader(&vs, nullptr, nullptr);
    bump(s->dpVS, ShaderHash(vs));
    if (vs) vs->Release();
}
// a command list finished on a deferred context: tagged when it holds a lit-pass draw with a pixel shader
static void DPListFinished(ContextState *s, ID3D11CommandList *list)
{
    if (list && s->dpListLit) { const uint32_t one = 1; list->SetPrivateData(kDPListTag, sizeof one, &one); }
    s->dpListLit = false;
}
// a command list is about to run on the immediate context: copy 1 before the first one with a lit-pass draw
static void DPExecute(ID3D11DeviceContext *immediate, ID3D11CommandList *list)
{
    if (g_dpPhase.load(std::memory_order_relaxed) != kDPCopying || !list) return;
    uint32_t lit = 0;
    UINT size = sizeof lit;
    if (FAILED(list->GetPrivateData(kDPListTag, &size, &lit)) || size != sizeof lit || !lit) return;
    DPCopy(immediate, State(immediate), 1);
    DPCopy(immediate, State(immediate), 3);
}
static UINT DPTexelBytes(DXGI_FORMAT f)
{
    switch (f)
    {
    case DXGI_FORMAT_R32G8X24_TYPELESS: case DXGI_FORMAT_D32_FLOAT_S8X24_UINT: return 8;
    case DXGI_FORMAT_R32_TYPELESS: case DXGI_FORMAT_D32_FLOAT: case DXGI_FORMAT_R24G8_TYPELESS: case DXGI_FORMAT_D24_UNORM_S8_UINT: return 4;
    case DXGI_FORMAT_R16_TYPELESS: case DXGI_FORMAT_D16_UNORM: return 2;
    default: return 0;
    }
}
// Present: the frame after the recording began is copied; two Presents after it the copies are read and written
static ID3D11DeviceContext *ImmediateContext(IDXGISwapChain *sc);
static void DPFrame(IDXGISwapChain *sc)
{
    const int phase = g_dpPhase.load();
    if (phase == kDPCopying || phase == kDPWaiting)
    {
        // which depth texture this frame's lit pass used (one the game alternates between frames would show here)
        std::lock_guard<std::mutex> lock(g_dpLock);
        Log("depth probe: %s frame's lit pass drew into depth %p (other one of its size seen: %p)", phase == kDPCopying ? "the copied" : "a following", (void *)g_dpDepth, (void *)g_dpOther);
    }
    if (phase == kDPIdle) { if (ProbeOn() && g_dpArmed.exchange(false)) { g_dpPhase = kDPCopying; Log("depth probe: the scene depth is copied in this frame"); } return; }
    if (phase == kDPCopying) { g_dpPhase = kDPWaiting; g_dpWaited = 0; return; }
    if (phase != kDPWaiting || ++g_dpWaited < 2) return;
    g_dpPhase = kDPDone;
    ID3D11DeviceContext *immediate = ImmediateContext(sc);
    std::lock_guard<std::mutex> lock(g_dpLock);
    for (int i = 0; i < 4; i++)
    {
        ID3D11Texture2D *t = g_dpCopy[i];
        if (!t) { Log("depth probe: copy %d (%s) was not taken", i, kDPWhere[i]); continue; }
        D3D11_TEXTURE2D_DESC d = {};
        t->GetDesc(&d);
        const UINT bytes = DPTexelBytes(d.Format);
        D3D11_MAPPED_SUBRESOURCE m = {};
        const HRESULT hr = immediate && bytes ? immediate->Map(t, 0, D3D11_MAP_READ, 0, &m) : E_FAIL;
        if (FAILED(hr)) { Log("depth probe: copy %d (format %u) could not be read (0x%08lX)", i, (unsigned)d.Format, (unsigned long)hr); continue; }
        wchar_t name[48];
        swprintf_s(name, L"SnowRunnerShadows.depth%d.raw", i);
        const std::wstring path = g_dir + name;
        FILE *f = nullptr;
        if (_wfopen_s(&f, path.c_str(), L"wb") == 0 && f)
        {
            const uint32_t head[8] = { 0x5A445253u /* SRDZ */, d.Width, d.Height, (uint32_t)d.Format, bytes, d.Width * bytes, (uint32_t)i, 0 };
            fwrite(head, sizeof head, 1, f);
            for (UINT y = 0; y < d.Height; y++) fwrite((const uint8_t *)m.pData + (size_t)y * m.RowPitch, 1, (size_t)d.Width * bytes, f);
            fclose(f);
            Log("depth probe: copy %d (%s), %u x %u format %u, written to %ls", i, kDPWhere[i], d.Width, d.Height, (unsigned)d.Format, path.c_str());
        }
        else Log("depth probe: %ls could not be written", path.c_str());
        immediate->Unmap(t, 0);
    }
    for (ID3D11Texture2D *&t : g_dpCopy) if (t) { t->Release(); t = nullptr; }
}

// ---- dump (see the top): one frame's bounce-light chain, saved to files for offline measurement
//
// A request (the key, or DumpAfter) is served by the next AO pass whose setting copies the feed: on that pass's own
// context, copies of its inputs are recorded into staging resources of this DLL (the scene and depth as copied for it,
// its g_txFactor at t2, its g_txDither at t0, its pixel shader constant buffers) and, when the pass is over (the game's
// next OMSetRenderTargets takes the bounce-light texture off, the pixel shader changes, or the context's command list
// ends), copies of its outputs (the AO target, the bounce-light texture, the constant buffers again). Map works on the
// immediate context alone and needs the copies executed: a deferred context's command list is tagged when it is
// finished, and once every tagged list has run (ExecuteCommandList) the staging resources are read on the immediate
// context; a worker thread writes DumpDir\SnowRunnerShadows_dump_<time>_<name>.bin (a 64-byte header: 'SRDP', version
// 1, kind 1 texture / 2 buffer, width, height, DXGI format, view format, row pitch, data size (8 bytes), sample count;
// then the rows) and ..._manifest.txt (what each file holds; the pass's viewports, blend state, samplers; counts).
// A dump that does not complete within five seconds is dropped, with the reason in the log.
static std::atomic<uint32_t> g_dumpGen{ 0 };          // one per request: an older dump's contexts and lists are ignored
static std::atomic<int> g_dumpPendingLists{ 0 };      // tagged command lists not executed yet
static std::atomic<int> g_dumpUnfinished{ 0 };        // deferred contexts with copies recorded whose list is not finished
static std::atomic<bool> g_dumpAfterFired{ false };
static std::mutex g_dumpLock;                         // the rest
struct DumpItem { char name[24]; ID3D11Resource *staging; UINT kind, w, h, fmt, view, pitch, samples; std::vector<uint8_t> data; };
static std::vector<DumpItem> g_dumpItems;
static std::string g_dumpNotes;                       // the manifest's lines, gathered as the dump goes
static ULONGLONG g_dumpStarted = 0;                   // when the inputs were recorded, for the timeout
static int g_dumpsDone = 0;
static const GUID kDumpListTag = { 0x6a1f0c52, 0x3e8b, 0x4d57, { 0x9b, 0x21, 0x5c, 0x7f, 0x3e, 0x0d, 0x9a, 0x4a } };
static const ULONGLONG kDumpTimeout = 5000;
static bool Desc2D(ID3D11Resource *r, D3D11_TEXTURE2D_DESC *d);
static void DumpTryMapLocked(ID3D11DeviceContext *immediate);
static DWORD WINAPI DumpWriter(void *p);

// under g_dumpLock: a line of the manifest
static void DumpNote(const char *fmt, ...)
{
    char line[640];
    va_list args; va_start(args, fmt); vsnprintf(line, sizeof line, fmt, args); va_end(args);
    g_dumpNotes += line;
    g_dumpNotes += "\r\n";
}

static void DumpRequest(const char *why)
{
    int expected = kDumpIdle;
    if (!g_dumpState.compare_exchange_strong(expected, kDumpRequested)) { Log("dump: %s, but a dump is in progress", why); return; }
    g_dumpGen++;
    Log("dump: requested (%s); the next AO pass set up with the feed copied is saved", why);
    ProbeRestart(); // reflections: the frame's order recorded again (the first may have been in a menu)
}

// under g_dumpLock: everything back to idle
static void DumpDrop(const char *why)
{
    for (DumpItem &i : g_dumpItems) if (i.staging) i.staging->Release();
    g_dumpItems.clear();
    g_dumpNotes.clear();
    g_dumpPendingLists = 0;
    g_dumpUnfinished = 0;
    g_dumpStarted = 0;
    g_dumpState = kDumpIdle;
    if (why) Log("dump: dropped: %s", why);
}

// the hotkey thread, every 30 ms: DumpAfter, and a dump that never completes
static void DumpTick(ULONGLONG now)
{
    if (g_dumpAfter > 0 && !g_dumpAfterFired.load(std::memory_order_relaxed))
    {
        const ULONGLONG first = g_dumpFirstAO.load(std::memory_order_relaxed);
        if (first && now - first >= (ULONGLONG)(g_dumpAfter * 1000)) { g_dumpAfterFired = true; DumpRequest("DumpAfter"); }
    }
    const int state = g_dumpState.load(std::memory_order_relaxed);
    if (state != kDumpRecording && state != kDumpFinal) return;
    std::lock_guard<std::mutex> lock(g_dumpLock);
    const int again = g_dumpState.load();
    if ((again == kDumpRecording || again == kDumpFinal) && g_dumpStarted && now - g_dumpStarted > kDumpTimeout)
    {
        char why[200];
        snprintf(why, sizeof why, "%s within %llu ms (%d command lists with copies not executed, %d contexts not finished)",
            again == kDumpRecording ? "the AO pass did not end" : "the copies did not run", (unsigned long long)kDumpTimeout, g_dumpPendingLists.load(), g_dumpUnfinished.load());
        DumpDrop(why);
    }
}

// copies were recorded on ctx: a deferred context's command list has to run before the files can be read
static void DumpMark(ID3D11DeviceContext *ctx, ContextState *s)
{
    if (ctx->GetType() != D3D11_DEVICE_CONTEXT_DEFERRED) return;
    if (s->dumpRecorded && s->dumpGen == g_dumpGen.load()) return;
    s->dumpRecorded = true;
    s->dumpGen = g_dumpGen.load();
    g_dumpUnfinished++;
}

// under g_dumpLock: a copy of the texture or buffer src into a staging resource of its own, recorded on ctx
static void DumpAdd(ID3D11DeviceContext *ctx, ContextState *s, const char *name, ID3D11Resource *src, DXGI_FORMAT view, const char *what)
{
    if (!src) { DumpNote("%s: nothing (%s)", name, what); return; }
    DumpItem item = {};
    snprintf(item.name, sizeof item.name, "%s", name);
    item.view = view;
    ID3D11Device *dev = nullptr;
    src->GetDevice(&dev);
    D3D11_RESOURCE_DIMENSION dim = D3D11_RESOURCE_DIMENSION_UNKNOWN;
    src->GetType(&dim);
    ID3D11Resource *staging = nullptr;
    HRESULT hr = E_FAIL;
    const char *why = "not a 2D texture or a buffer";
    if (dev && dim == D3D11_RESOURCE_DIMENSION_TEXTURE2D)
    {
        ID3D11Texture2D *t = nullptr;
        if (SUCCEEDED(src->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&t)) && t)
        {
            D3D11_TEXTURE2D_DESC d = {};
            t->GetDesc(&d);
            t->Release();
            item.kind = 1; item.w = d.Width; item.h = d.Height; item.fmt = d.Format; item.samples = d.SampleDesc.Count;
            if (d.SampleDesc.Count == 1)
            {
                d.Usage = D3D11_USAGE_STAGING; d.BindFlags = 0; d.CPUAccessFlags = D3D11_CPU_ACCESS_READ; d.MiscFlags = 0;
                ID3D11Texture2D *st = nullptr;
                hr = dev->CreateTexture2D(&d, nullptr, &st);
                staging = st;
                why = "the staging texture could not be made";
            }
            else why = "multisampled";
        }
    }
    else if (dev && dim == D3D11_RESOURCE_DIMENSION_BUFFER)
    {
        ID3D11Buffer *b = nullptr;
        if (SUCCEEDED(src->QueryInterface(__uuidof(ID3D11Buffer), (void **)&b)) && b)
        {
            D3D11_BUFFER_DESC d = {};
            b->GetDesc(&d);
            b->Release();
            item.kind = 2; item.w = d.ByteWidth; item.h = 1; item.fmt = 0; item.samples = 1;
            d.Usage = D3D11_USAGE_STAGING; d.BindFlags = 0; d.CPUAccessFlags = D3D11_CPU_ACCESS_READ; d.MiscFlags = 0; d.StructureByteStride = 0;
            ID3D11Buffer *sb = nullptr;
            hr = dev->CreateBuffer(&d, nullptr, &sb);
            staging = sb;
            why = "the staging buffer could not be made";
        }
    }
    if (dev) dev->Release();
    if (FAILED(hr) || !staging)
    {
        if (staging) staging->Release();
        DumpNote("%s: %u x %u, format %u: not copied, %s (0x%08lX) (%s)", name, item.w, item.h, item.fmt, why, (unsigned long)hr, what);
        return;
    }
    ctx->CopyResource(staging, src);
    item.staging = staging;
    if (item.kind == 1) DumpNote("%s: texture %u x %u, format %u, view format %u: %s", name, item.w, item.h, item.fmt, item.view, what);
    else DumpNote("%s: buffer, %u bytes: %s", name, item.w, what);
    g_dumpItems.push_back(std::move(item));
    DumpMark(ctx, s);
}

// under g_dumpLock: the pixel shader constant buffers bound on ctx, as <prefix>_b<slot>
static void DumpConstants(ID3D11DeviceContext *ctx, ContextState *s, const char *prefix)
{
    ID3D11Buffer *bufs[14] = {};
    ctx->PSGetConstantBuffers(0, 14, bufs);
    for (UINT i = 0; i < 14; i++)
    {
        if (!bufs[i]) continue;
        char name[24];
        snprintf(name, sizeof name, "%s_b%u", prefix, i);
        DumpAdd(ctx, s, name, bufs[i], DXGI_FORMAT_UNKNOWN, i == 0 ? "pixel shader constants b0 (the AO pass: CB_GLOBAL_TARGET, g_vBBSizeInv, g_vVPSizeInv, g_iBBSampleCount)" :
            i == 4 ? "pixel shader constants b4 (the AO pass: CB_INSTANCE, g_vDitherTile, g_vRadiusMinMax, g_vSSAOColor)" : "pixel shader constants");
        bufs[i]->Release();
    }
}

// under g_dumpLock: what a blend state does to the first two targets
static void DumpNoteBlend(ID3D11BlendState *bs, const char *what)
{
    if (!bs) { DumpNote("blend state, %s: none (no blending, every channel written)", what); return; }
    D3D11_BLEND_DESC d = {};
    bs->GetDesc(&d);
    for (int i = 0; i < 2; i++)
    {
        const D3D11_RENDER_TARGET_BLEND_DESC &t = d.RenderTarget[d.IndependentBlendEnable ? i : 0];
        DumpNote("blend state %p, %s, target %d: blend %d (src %d, dest %d, op %d; alpha src %d, dest %d, op %d), write mask 0x%X%s", (void *)bs, what, i,
            (int)t.BlendEnable, (int)t.SrcBlend, (int)t.DestBlend, (int)t.BlendOp, (int)t.SrcBlendAlpha, (int)t.DestBlendAlpha, (int)t.BlendOpAlpha,
            (unsigned)t.RenderTargetWriteMask, d.IndependentBlendEnable ? "" : " (all targets share entry 0)");
    }
}

// under g_dumpLock: the texture behind a view, its size and format, and the view's format
static void DumpNoteView(const char *what, ID3D11View *view, DXGI_FORMAT viewFormat)
{
    ID3D11Resource *r = nullptr;
    view->GetResource(&r);
    D3D11_TEXTURE2D_DESC d = {};
    if (Desc2D(r, &d))
        DumpNote("%s: %u x %u, format %u, mips %u, samples %u, bind 0x%X, viewed as format %u", what, d.Width, d.Height, (unsigned)d.Format, d.MipLevels, d.SampleDesc.Count, d.BindFlags, (unsigned)viewFormat);
    else DumpNote("%s: not a 2D texture, viewed as format %u", what, (unsigned)viewFormat);
    if (r) r->Release();
}

// under g_dumpLock: the reflections of this AO pass: its lit pass's normal target and render target 7 as the pass read
// them (render target 7 is cleared after its copy; the pass leaves it for the dump), and what the pass made of them
static void DumpSSR(ID3D11DeviceContext *ctx, ContextState *s)
{
    ID3D11Resource *factor = nullptr, *normal = nullptr;
    ID3D11Texture2D *rt7 = nullptr;
    ID3D11RenderTargetView *rt7Rtv = nullptr;
    DXGI_FORMAT normalView = DXGI_FORMAT_UNKNOWN;
    if (s->aoFactor) s->aoFactor->GetResource(&factor);
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        for (const LitPass &p : g_litPasses)
            if (p.factor == factor)
            {
                if (p.normal) { normal = p.normal; normal->AddRef(); normalView = p.normalView; }
                if (p.rt7) { rt7 = p.rt7; rt7->AddRef(); rt7Rtv = p.rt7Rtv; rt7Rtv->AddRef(); }
            }
    }
    DumpAdd(ctx, s, "normal", normal, normalView, "render target 1 of the lit pass (world normal x/z at 0.5 n + 0.502; w a flag the decals read)");
    DumpAdd(ctx, s, "rt7", rt7, DXGI_FORMAT_R8G8B8A8_UNORM, "render target 7 (the splice's normal x 0.5 + 0.5, roughness) as the pass read it");
    if (rt7Rtv) ctx->ClearRenderTargetView(rt7Rtv, kUpRough);
    ID3D11Texture2D *hit = nullptr, *out = nullptr, *motion = nullptr, *hiz = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_ssrLock);
        const SSRResources &r = g_ssrRes;
        if (r.lastRun && GetTickCount64() - r.lastRun < 100) // the pass ran for this AO pass
        {
            hit = r.hit.tex; out = r.out[r.cur ^ 1].tex; motion = r.motion.tex; hiz = r.hiz;
            for (ID3D11Texture2D *t : { hit, out, motion, hiz }) if (t) t->AddRef();
        }
    }
    DumpAdd(ctx, s, "ssr_hit", hit, DXGI_FORMAT_R16G16B16A16_FLOAT, "the trace grid (hit colour x confidence, confidence)");
    DumpAdd(ctx, s, "ssr_out", out, DXGI_FORMAT_R16G16B16A16_FLOAT, "t123 after the resolve (radiance x confidence, confidence)");
    DumpAdd(ctx, s, "ssr_motion", motion, DXGI_FORMAT_R16G16B16A16_FLOAT, "t124 as last decoded (uv motion xy, object flag z)");
    DumpAdd(ctx, s, "ssr_hiz", hiz, DXGI_FORMAT_R32_FLOAT, "the depth pyramid, level 0 (1 / linear depth, 0 = sky)");
    for (IUnknown *u : { (IUnknown *)factor, (IUnknown *)normal, (IUnknown *)rt7, (IUnknown *)rt7Rtv, (IUnknown *)hit, (IUnknown *)out, (IUnknown *)motion, (IUnknown *)hiz })
        if (u) u->Release();
}

// under g_dumpLock: contact shadows of this AO pass: render target 6 as the composite read it (cleared after its copy;
// the pass leaves it for the dump), the pass's mask, and the lit pass's colour after the composite
static void DumpContact(ID3D11DeviceContext *ctx, ContextState *s)
{
    ID3D11Resource *factor = nullptr, *colour = nullptr;
    ID3D11Texture2D *rt6 = nullptr, *mask = nullptr;
    ID3D11RenderTargetView *rt6Rtv = nullptr;
    DXGI_FORMAT colourView = DXGI_FORMAT_UNKNOWN;
    if (s->aoFactor) s->aoFactor->GetResource(&factor);
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        for (const LitPass &p : g_litPasses)
            if (p.factor == factor)
            {
                if (p.rt6 && !rt6) { rt6 = p.rt6; rt6->AddRef(); rt6Rtv = p.rt6Rtv; rt6Rtv->AddRef(); }
                if (p.colour && !colour) { colour = p.colour; colour->AddRef(); colourView = p.view; }
            }
    }
    {
        std::lock_guard<std::mutex> lock(g_contactLock);
        const ContactResources &r = g_contactRes;
        if (r.mask && r.lastRun && GetTickCount64() - r.lastRun < 100) { mask = r.mask; mask->AddRef(); } // the pass ran for this AO pass
    }
    DumpAdd(ctx, s, "rt6", rt6, DXGI_FORMAT_R8_UNORM, "render target 6 (the sun's visibility the receivers found; 0 = none drew there) as the composite read it");
    if (rt6Rtv) { const FLOAT zero[4] = {}; ctx->ClearRenderTargetView(rt6Rtv, zero); }
    DumpAdd(ctx, s, "contact_mask", mask, DXGI_FORMAT_R32_FLOAT, "the contact-shadow pass's mask (1 lit .. 0 shadowed)");
    DumpAdd(ctx, s, "lit_contact", colour, colourView, "the lit pass's colour target after the contact-shadow composite");
    for (IUnknown *u : { (IUnknown *)factor, (IUnknown *)colour, (IUnknown *)rt6, (IUnknown *)rt6Rtv, (IUnknown *)mask })
        if (u) u->Release();
}

// the AO pass is set up on ctx and the feed copied for it: with a dump requested, its inputs
static void DumpInputs(ID3D11DeviceContext *ctx, ContextState *s)
{
    int expected = kDumpRequested;
    if (!g_dumpState.compare_exchange_strong(expected, kDumpRecording)) return;
    FeedTexture feed[2] = {};
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        for (int i = 0; i < 2; i++) { feed[i] = g_feedTex[i]; if (feed[i].tex) feed[i].tex->AddRef(); }
    }
    std::lock_guard<std::mutex> lock(g_dumpLock);
    g_dumpStarted = GetTickCount64();
    const bool deferred = ctx->GetType() == D3D11_DEVICE_CONTEXT_DEFERRED;
    SYSTEMTIME t; GetLocalTime(&t);
    DumpNote("SnowRunner Shadows dump, %04d-%02d-%02d %02d:%02d:%02d.%03d", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    DumpNote("inputs recorded on context %p (%s) as the AO pass was set up: pixel shader flags 0x%X%s; feed copies so far %llu, bounce-light writes %llu; bounce light %s, AO %s, effects %s",
        (void *)ctx, deferred ? "deferred" : "immediate", s->psFlags, (s->psFlags & kFeedGIWrites) ? " (writes the bounce light)" : " (no bounce-light output)",
        (unsigned long long)g_feedCaptures.load(), (unsigned long long)g_giWrites.load(), g_bounceOn ? "on" : "off (F10)", g_stockAO ? "the game's own" : "GTAO", g_stockAll ? "stock (F8)" : "on");
    for (size_t i = 0; i < s->viewports.size(); i++)
        DumpNote("viewport %zu (as the game set it): %g %g %g %g, depth %g..%g", i, s->viewports[i].TopLeftX, s->viewports[i].TopLeftY, s->viewports[i].Width, s->viewports[i].Height,
            s->viewports[i].MinDepth, s->viewports[i].MaxDepth);
    for (size_t i = 0; i < s->scissors.size(); i++)
        DumpNote("scissor %zu: %ld %ld %ld %ld", i, s->scissors[i].left, s->scissors[i].top, s->scissors[i].right, s->scissors[i].bottom);
    // the targets bound now: with the bounce light beside it already, target 0 is the AO pass's own
    ID3D11RenderTargetView *rtvs[2] = {};
    ID3D11DepthStencilView *dsv = nullptr;
    ctx->OMGetRenderTargets(2, rtvs, &dsv);
    for (int k = 0; k < 2; k++)
    {
        if (!rtvs[k]) { DumpNote("render target %d bound now: none", k); continue; }
        D3D11_RENDER_TARGET_VIEW_DESC v = {};
        rtvs[k]->GetDesc(&v);
        char what[64];
        snprintf(what, sizeof what, "render target %d bound now%s", k, k == 1 && s->giBound ? " (the bounce-light texture)" : "");
        DumpNoteView(what, rtvs[k], v.Format);
        if (k == 0 && s->giBound && !s->dumpAO) { rtvs[0]->GetResource(&s->dumpAO); s->dumpAOView = v.Format; }
    }
    DumpNote("depth-stencil bound now: %s", dsv ? "yes" : "none");
    for (auto *v : rtvs) if (v) v->Release();
    if (dsv) dsv->Release();
    ID3D11BlendState *bs = nullptr;
    FLOAT bf[4] = {};
    UINT bm = 0;
    ctx->OMGetBlendState(&bs, bf, &bm);
    DumpNoteBlend(bs, s->blendSwapped ? "this DLL's copy, in place now" : "in place now");
    if (bs) bs->Release();
    if (s->blendSwapped) DumpNoteBlend(s->gameBlend, "the game's own, put back after the pass");
    ID3D11SamplerState *sam[16] = {};
    ctx->PSGetSamplers(0, 16, sam);
    for (UINT i = 0; i < 16; i++)
    {
        if (!sam[i]) continue;
        D3D11_SAMPLER_DESC d = {};
        sam[i]->GetDesc(&d);
        DumpNote("sampler s%u: filter %d, address %d %d %d, mip lod bias %g, max anisotropy %u, comparison %d, lod %g..%g", i, (int)d.Filter, (int)d.AddressU, (int)d.AddressV,
            (int)d.AddressW, d.MipLODBias, d.MaxAnisotropy, (int)d.ComparisonFunc, d.MinLOD, d.MaxLOD);
        sam[i]->Release();
    }
    DumpAdd(ctx, s, "scene", feed[0].tex, feed[0].view, "the lit scene as copied for this AO pass (t120)");
    DumpAdd(ctx, s, "depth", feed[1].tex, feed[1].view, "the linear depth as copied for this AO pass (t121; the pass reads the game's own at t80, the same values)");
    for (int i = 0; i < 2; i++) if (feed[i].tex) feed[i].tex->Release();
    const struct { UINT slot; const char *name, *what; } slots[] = {
        { 0, "dither", "g_txDither (t0)" }, { 2, "factor", "g_txFactor (t2): x = the game's per-pixel AO factor, the radius scale" } };
    for (const auto &sl : slots)
    {
        ID3D11ShaderResourceView *srv = nullptr;
        ctx->PSGetShaderResources(sl.slot, 1, &srv);
        if (!srv) { DumpNote("%s: nothing bound at t%u", sl.name, sl.slot); continue; }
        D3D11_SHADER_RESOURCE_VIEW_DESC v = {};
        srv->GetDesc(&v);
        DumpNoteView(sl.what, srv, v.Format);
        ID3D11Resource *r = nullptr;
        srv->GetResource(&r);
        DumpAdd(ctx, s, sl.name, r, v.Format, sl.what);
        if (r) r->Release();
        srv->Release();
    }
    {
        ID3D11ShaderResourceView *srv = nullptr;
        ctx->PSGetShaderResources(80, 1, &srv);
        if (srv)
        {
            D3D11_SHADER_RESOURCE_VIEW_DESC v = {};
            srv->GetDesc(&v);
            DumpNoteView("g_txZ (t80, the game's linear depth; not saved, the depth file is its copy)", srv, v.Format);
            srv->Release();
        }
    }
    if (g_ssr) DumpSSR(ctx, s);
    if (g_contact) DumpContact(ctx, s);
    DumpConstants(ctx, s, "A");
    s->dumpAwaiting = true;
    s->dumpGen = g_dumpGen.load();
    Log("dump: inputs recorded on context %p (%s), %zu copies; the outputs follow when the pass is over", (void *)ctx, deferred ? "deferred" : "immediate", g_dumpItems.size());
}

// the AO pass that recorded the inputs is over on ctx: its outputs (and the constants again), then the dump is final
static void DumpOutputs(ID3D11DeviceContext *ctx, ContextState *s, const char *when)
{
    s->dumpAwaiting = false;
    ID3D11Resource *ao = s->dumpAO;
    s->dumpAO = nullptr;
    const bool stale = s->dumpGen != g_dumpGen.load() || g_dumpState.load() != kDumpRecording;
    GITexture gi = {};
    if (!stale)
    {
        std::lock_guard<std::mutex> lock(g_feedLock);
        gi = g_giTex;
        if (gi.tex) gi.tex->AddRef();
    }
    if (!stale)
    {
        std::lock_guard<std::mutex> lock(g_dumpLock);
        if (g_dumpState.load() == kDumpRecording)
        {
            DumpNote("outputs recorded on context %p at %s, %llu ms after the inputs; feed copies %llu, bounce-light writes %llu; the bounce-light texture %s render target 1 now",
                (void *)ctx, when, (unsigned long long)(GetTickCount64() - g_dumpStarted), (unsigned long long)g_feedCaptures.load(), (unsigned long long)g_giWrites.load(),
                s->giBound ? "is" : "is not");
            DumpAdd(ctx, s, "ao", ao, s->dumpAOView, "the AO pass's own target after the pass (render target 0; x = visibility, through the game's blend state)");
            DumpAdd(ctx, s, "gi", gi.tex, DXGI_FORMAT_R16G16B16A16_FLOAT, "the bounce-light texture after the pass (render target 1; t122 for the material shaders next frame)");
            DumpConstants(ctx, s, "B");
            g_dumpState = kDumpFinal;
            Log("dump: outputs recorded on context %p (%s), %zu copies in all%s", (void *)ctx, when, g_dumpItems.size(),
                g_dumpUnfinished.load() || g_dumpPendingLists.load() ? "; read back once the command lists have run" : "");
            if (ctx->GetType() != D3D11_DEVICE_CONTEXT_DEFERRED) DumpTryMapLocked(ctx);
        }
    }
    if (ao) ao->Release();
    if (gi.tex) gi.tex->Release();
}

// a deferred context's command list with the dump's copies is finished: tagged, so that its execution can be seen
static void DumpListFinished(ContextState *s, HRESULT hr, ID3D11CommandList *list)
{
    s->dumpRecorded = false;
    if (s->dumpGen != g_dumpGen.load()) return; // an earlier dump's
    std::lock_guard<std::mutex> lock(g_dumpLock);
    if (g_dumpState.load() == kDumpIdle) return;
    if (FAILED(hr) || !list) { DumpDrop("the command list holding the copies could not be finished"); return; }
    const uint32_t gen = s->dumpGen;
    list->SetPrivateData(kDumpListTag, sizeof gen, &gen);
    g_dumpPendingLists++;
    g_dumpUnfinished--;
    DumpNote("a command list carrying copies was finished (%d to run)", g_dumpPendingLists.load());
}

// the immediate context executed a command list (listGen: the dump it carries copies for, 0 none)
static void DumpExecuted(ID3D11DeviceContext *immediate, uint32_t listGen)
{
    std::lock_guard<std::mutex> lock(g_dumpLock);
    if (g_dumpState.load() == kDumpIdle) return;
    if (listGen && listGen == g_dumpGen.load() && g_dumpPendingLists.load() > 0)
    {
        g_dumpPendingLists--;
        DumpNote("a command list carrying copies ran (%d to go)", g_dumpPendingLists.load());
    }
    DumpTryMapLocked(immediate);
}

// a context is made anew at an address seen before: nothing of an old dump sticks to it
static void DumpForget(ContextState *s)
{
    if (s->dumpAO) { s->dumpAO->Release(); s->dumpAO = nullptr; }
    if (s->dumpRecorded)
    {
        std::lock_guard<std::mutex> lock(g_dumpLock);
        if (s->dumpGen == g_dumpGen.load() && g_dumpState.load() != kDumpIdle && g_dumpUnfinished.load() > 0) g_dumpUnfinished--;
    }
    s->dumpRecorded = s->dumpAwaiting = false;
}

struct DumpJob { std::vector<DumpItem> items; std::string notes; std::wstring dir; int number; };

// under g_dumpLock, on the immediate context: once every copy has run, read the staging resources and hand the data to
// the writer thread
static void DumpTryMapLocked(ID3D11DeviceContext *immediate)
{
    if (g_dumpState.load() != kDumpFinal || g_dumpPendingLists.load() != 0 || g_dumpUnfinished.load() != 0) return;
    const ULONGLONG t0 = GetTickCount64();
    size_t bytes = 0;
    int read = 0;
    for (DumpItem &i : g_dumpItems)
    {
        if (!i.staging) continue;
        D3D11_MAPPED_SUBRESOURCE m = {};
        const HRESULT hr = immediate->Map(i.staging, 0, D3D11_MAP_READ, 0, &m);
        if (FAILED(hr) || !m.pData) DumpNote("%s: Map failed (0x%08lX)", i.name, (unsigned long)hr);
        else
        {
            i.pitch = i.kind == 1 ? m.RowPitch : i.w;
            const size_t size = (size_t)i.pitch * i.h;
            i.data.assign((const uint8_t *)m.pData, (const uint8_t *)m.pData + size);
            immediate->Unmap(i.staging, 0);
            bytes += size;
            read++;
        }
        i.staging->Release();
        i.staging = nullptr;
    }
    const ULONGLONG took = GetTickCount64() - t0;
    DumpNote("%d of %zu copies read back on the immediate context %p in %llu ms, %zu bytes", read, g_dumpItems.size(), (void *)immediate, (unsigned long long)took, bytes);
    Log("dump: %d of %zu copies read back (%zu MB) in %llu ms; the files are written in the background", read, g_dumpItems.size(), bytes >> 20, (unsigned long long)took);
    DumpJob *job = new DumpJob{ std::move(g_dumpItems), std::move(g_dumpNotes), g_dumpDir, ++g_dumpsDone };
    g_dumpItems.clear();
    g_dumpNotes.clear();
    g_dumpStarted = 0;
    g_dumpState = kDumpIdle;
    HANDLE thread = CreateThread(nullptr, 0, &DumpWriter, job, 0, nullptr);
    if (thread) CloseHandle(thread); else DumpWriter(job);
}

// the worker thread: the files and the manifest
static DWORD WINAPI DumpWriter(void *p)
{
    DumpJob *job = (DumpJob *)p;
    const ULONGLONG t0 = GetTickCount64();
    SYSTEMTIME t; GetLocalTime(&t);
    wchar_t stamp[40];
    swprintf_s(stamp, L"%04d%02d%02d_%02d%02d%02d", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    CreateDirectoryW(job->dir.c_str(), nullptr);
    const std::wstring base = job->dir + L"SnowRunnerShadows_dump_" + stamp + L"_";
    std::string manifest = job->notes + "\r\nfiles (64-byte header: 'SRDP', version 1, kind 1 texture / 2 buffer, width, height, format, view format, row pitch, data size (8 bytes), sample count; then the data):\r\n";
    size_t total = 0;
    int written = 0;
    for (DumpItem &i : job->items)
    {
        if (i.data.empty()) continue;
        std::wstring path = base;
        for (const char *c = i.name; *c; c++) path += (wchar_t)*c;
        path += L".bin";
        FILE *f = nullptr;
        if (_wfopen_s(&f, path.c_str(), L"wb") != 0 || !f) { Log("dump: %ls could not be written", path.c_str()); continue; }
        uint8_t header[64] = {};
        memcpy(header, "SRDP", 4);
        const uint32_t words[7] = { 1, i.kind, i.w, i.h, i.fmt, i.view, i.pitch };
        memcpy(header + 4, words, sizeof words);
        const uint64_t size = i.data.size();
        memcpy(header + 32, &size, 8);
        memcpy(header + 40, &i.samples, 4);
        const bool ok = fwrite(header, 1, sizeof header, f) == sizeof header && fwrite(i.data.data(), 1, i.data.size(), f) == i.data.size();
        fclose(f);
        char line[400];
        snprintf(line, sizeof line, "%s = SnowRunnerShadows_dump_%ls_%s.bin (%s, %u x %u, format %u, view %u, pitch %u, %zu bytes)%s", i.name, stamp, i.name,
            i.kind == 1 ? "texture" : "buffer", i.w, i.h, i.fmt, i.view, i.pitch, i.data.size(), ok ? "" : " WRITE FAILED");
        manifest += line;
        manifest += "\r\n";
        if (ok) { written++; total += i.data.size(); }
        std::vector<uint8_t>().swap(i.data);
    }
    const std::wstring mpath = base + L"manifest.txt";
    FILE *f = nullptr;
    if (_wfopen_s(&f, mpath.c_str(), L"wb") == 0 && f) { fwrite(manifest.data(), 1, manifest.size(), f); fclose(f); }
    else Log("dump: %ls could not be written", mpath.c_str());
    Log("dump %d: %d files (%zu MB) and %ls written in %llu ms", job->number, written, total >> 20, mpath.c_str(), (unsigned long long)(GetTickCount64() - t0));
    delete job;
    return 0;
}

// ---- GPU timers (ini GpuTimers=<seconds>, 0 = off, the default): each pass's GPU time per frame, from timestamp
// queries on the context that draws it (deferred contexts included), read back on the immediate context at Present once
// the frame's command lists have run; a line every <seconds> and the averages at exit. Timed: the AO pass and the AO apply
// pass (their shader set until the next shader or target change; the AO pass pauses for the feed copy and the reflection
// pass), the shadow texture (each bind as the depth target until the unbind), the lit pass (its three targets bound
// until they change) and the scene feed copy (with its mips). The reflection pass keeps its own timer. A timing
// whose queries give no answer within 3 s (a command list never executed) is dropped and counted.
struct GpuTimer { ID3D11Query *disjoint = nullptr, *begin = nullptr, *end = nullptr; int sec = 0; ULONGLONG issued = 0; bool pending = false, open = false; };
static const int kGpuPool = 512;
static GpuTimer g_gpuPool[kGpuPool];
static int g_gpuNext = 0;
static std::mutex g_gpuLock;                       // the pool's flags and the sums
static std::atomic<ID3D11DeviceContext *> g_gpuImmediate{ nullptr }; // seen executing command lists: where the timings are read
static double g_gpuSum[kGpuSections] = {}, g_gpuAll[kGpuSections] = {};
static uint64_t g_gpuCount[kGpuSections] = {}, g_gpuIssued[kGpuSections] = {}, g_gpuAnswered[kGpuSections] = {}, g_gpuFrames = 0, g_gpuAllFrames = 0, g_gpuDropped = 0;
static ULONGLONG g_gpuLogged = 0;
static const char *const kGpuNames[kGpuSections] = { "AO pass", "AO apply", "AO upsample", "shadow maps", "lit pass", "scene feed copy", "water" };

static GpuTimer *GpuBegin(ID3D11DeviceContext *ctx, int sec)
{
    if (!g_gpuTimers || !ctx) return nullptr;
    GpuTimer *t = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_gpuLock);
        const ULONGLONG now = GetTickCount64();
        for (int k = 0; k < kGpuPool && !t; k++)
        {
            GpuTimer &c = g_gpuPool[(g_gpuNext + k) % kGpuPool];
            if (c.open) continue;
            if (c.pending) { if (now - c.issued < 3000) continue; c.pending = false; g_gpuDropped++; }
            t = &c;
            g_gpuNext = (g_gpuNext + k + 1) % kGpuPool;
        }
        if (!t) return nullptr;
        t->open = true;
    }
    if (!t->begin)
    {
        ID3D11Device *dev = nullptr;
        ctx->GetDevice(&dev);
        D3D11_QUERY_DESC qd = { D3D11_QUERY_TIMESTAMP_DISJOINT, 0 };
        if (dev)
        {
            if (!t->disjoint) dev->CreateQuery(&qd, &t->disjoint);
            qd.Query = D3D11_QUERY_TIMESTAMP;
            if (!t->end) dev->CreateQuery(&qd, &t->end);
            if (t->disjoint && t->end) dev->CreateQuery(&qd, &t->begin);
            dev->Release();
        }
        if (!t->begin) { std::lock_guard<std::mutex> lock(g_gpuLock); t->open = false; return nullptr; }
    }
    t->sec = sec;
    ctx->Begin(t->disjoint);
    ctx->End(t->begin);
    return t;
}
static void GpuEnd(ID3D11DeviceContext *ctx, GpuTimer *&t)
{
    if (!t) return;
    ctx->End(t->end);
    ctx->End(t->disjoint);
    {
        std::lock_guard<std::mutex> lock(g_gpuLock);
        t->issued = GetTickCount64();
        t->pending = true;
        t->open = false;
        g_gpuIssued[t->sec]++;
    }
    t = nullptr;
}
// the timings still open on a context end here (it is cleared, its command list finished, or the frame presented)
static void GpuCloseContext(ID3D11DeviceContext *ctx)
{
    ContextState *s = State(ctx);
    if (s->gpuShadow) GpuEnd(ctx, s->gpuShadow);
    if (s->gpuLit) GpuEnd(ctx, s->gpuLit);
    if (s->gpuPass) GpuEnd(ctx, s->gpuPass);
}
// a draw with the AO pass's or the AO apply pass's pixel shader bound: timed on its own
// the pixel shader changed (flags: the new one's kFeed* bits): an AO or apply pass timed so far is over, and one starts
// when the new shader is the AO pass's or an apply pass's. The game binds a pass's targets before its shader, so the time
// from here to the next shader or target change is the pass's draw. (Timing the draw call itself does not work: the
// runtime rewrites the Draw entries of the context's method table after the first frame, see CheckHooks.)
static void GpuShaderSet(ID3D11DeviceContext *ctx, ContextState *s, uint32_t flags)
{
    if (s->gpuPass) GpuEnd(ctx, s->gpuPass);
    if (flags & kFeedAO) s->gpuPass = GpuBegin(ctx, kGpuAO);
    else if (flags & kFeedAOApply) s->gpuPass = GpuBegin(ctx, kGpuAOApply);
    else if (flags & kFeedWater) s->gpuPass = GpuBegin(ctx, kGpuWater); // its draws until the next shader or target change
}
// the immediate context: the timings whose command lists have run
static void GpuPoll(ID3D11DeviceContext *immediate)
{
    std::lock_guard<std::mutex> lock(g_gpuLock);
    for (GpuTimer &t : g_gpuPool)
    {
        if (!t.pending) continue;
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj = {};
        UINT64 a = 0, b = 0;
        if (immediate->GetData(t.disjoint, &dj, sizeof dj, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        if (immediate->GetData(t.begin, &a, sizeof a, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK || immediate->GetData(t.end, &b, sizeof b, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        t.pending = false;
        g_gpuAnswered[t.sec]++;
        if (dj.Disjoint || !dj.Frequency || b < a) { g_gpuDropped++; continue; }
        const double ms = (double)(b - a) * 1000.0 / (double)dj.Frequency;
        g_gpuSum[t.sec] += ms; g_gpuAll[t.sec] += ms; g_gpuCount[t.sec]++;
    }
}
// the immediate context: the one seen executing command lists; a game that draws on it alone gets it from the swap
// chain's device
static ID3D11DeviceContext *ImmediateContext(IDXGISwapChain *sc)
{
    ID3D11DeviceContext *immediate = g_gpuImmediate.load();
    if (!immediate && sc)
    {
        ID3D11Device *dev = nullptr;
        if (SUCCEEDED(sc->GetDevice(__uuidof(ID3D11Device), (void **)&dev)) && dev)
        {
            dev->GetImmediateContext(&immediate);
            if (immediate) { g_gpuImmediate.store(immediate); immediate->Release(); } // the device keeps it alive
            dev->Release();
        }
    }
    return immediate;
}
// Present: read what has come back, count the frame, and write the line when its interval is over
static void GpuFrame(IDXGISwapChain *sc)
{
    ID3D11DeviceContext *immediate = ImmediateContext(sc);
    if (!immediate) return;
    GpuCloseContext(immediate);
    GpuPoll(immediate);
    std::lock_guard<std::mutex> lock(g_gpuLock);
    g_gpuFrames++; g_gpuAllFrames++;
    const ULONGLONG now = GetTickCount64();
    if (!g_gpuLogged) g_gpuLogged = now;
    if (now - g_gpuLogged < g_gpuTimers * 1000ULL) return;
    char line[640];
    int at = snprintf(line, sizeof line, "gpu: per frame over %llu frames:", (unsigned long long)g_gpuFrames);
    for (int k = 0; k < kGpuSections && at > 0 && at < (int)sizeof line; k++)
        at += snprintf(line + at, sizeof line - at, "%s %s %.3f ms (%.1f timings)", k ? "," : "", kGpuNames[k], g_gpuSum[k] / g_gpuFrames, (double)g_gpuCount[k] / g_gpuFrames);
    Log("%s%s", line, g_gpuDropped ? "; some timings got no answer" : "");
    for (int k = 0; k < kGpuSections; k++) { g_gpuSum[k] = 0; g_gpuCount[k] = 0; }
    g_gpuFrames = 0;
    g_gpuLogged = now;
}

// ---- pass profile (ini GpuProfile=<seconds>, 0 = off, the default): where the frame's GPU time goes, pass by pass.
// Each setting of the render targets starts a pass on its context, and so does each compute shader the game sets; a pass
// is timed until the next one starts on that context (or its command list ends, a ClearState, the frame's Present), with
// timestamp queries as the GPU timers take them. This DLL's own work inside a game pass (the scene feed copy, the
// reflection pass, the AO blur and upsample) is timed on its own, and the game's pass goes on after it. A pass is named by
// its targets (their view formats, the first one's size, the depth target's format) and, when it drew with one pixel
// shader only, by that shader (CRC32 of its code: the shader dump's name); a compute pass by its compute shader. Every
// <seconds> the log gets the passes by GPU time per frame, each with where it starts in the frame on average (after the
// Present before it); at exit the same over the whole run.
struct ProfTimer { ID3D11Query *disjoint = nullptr, *begin = nullptr, *end = nullptr; ProfDesc desc; ULONGLONG issued = 0; uint64_t frame = 0; bool pending = false, open = false; };
struct ProfMark { ID3D11Query *q = nullptr; UINT64 at = 0; uint64_t seq = 0; bool pending = false, known = false; };
struct ProfEntry { ProfDesc desc; double ms = 0, all = 0, at = 0, allAt = 0; uint64_t n = 0, alln = 0, atN = 0, allAtN = 0; };
static const int kProfPool = 16384, kProfMarks = 64; // (GpuProfileShaders: hundreds of passes a frame, three frames in flight)
static ProfTimer g_profPool[kProfPool];
static int g_profNext = 0;
static ProfMark g_profMarks[kProfMarks];            // a timestamp at each Present, where the frames meet
static uint64_t g_profMarkSeq = 0;
static std::mutex g_profLock;                       // the pool's flags, the marks and the sums
static std::unordered_map<uint64_t, ProfEntry> g_prof;
static uint64_t g_profFrameNo = 0, g_profFrames = 0, g_profAllFrames = 0, g_profGpuN = 0, g_profAllGpuN = 0, g_profDropped = 0, g_profFull = 0;
static double g_profGpuMs = 0, g_profAllGpuMs = 0, g_profLastFrameMs = 0, g_profFreq = 0;
static ULONGLONG g_profLogged = 0;
static uint32_t ShaderHash(ID3D11DeviceChild *s);

static uint64_t ProfKey(const ProfDesc &d)
{
    uint64_t h = 1469598103934665603ULL; // FNV-1a over the bytes
    const uint8_t *p = (const uint8_t *)&d;
    for (size_t i = 0; i < sizeof d; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}

// a pass begins on ctx: a timer from the pool (none when every one is busy: that pass goes untimed, and is counted)
static ProfTimer *ProfBegin(ID3D11DeviceContext *ctx, const ProfDesc &d)
{
    ProfTimer *t = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_profLock);
        const ULONGLONG now = GetTickCount64();
        for (int k = 0; k < kProfPool && !t; k++)
        {
            ProfTimer &c = g_profPool[(g_profNext + k) % kProfPool];
            if (c.open) continue;
            if (c.pending) { if (now - c.issued < 3000) continue; c.pending = false; g_profDropped++; }
            t = &c;
            g_profNext = (g_profNext + k + 1) % kProfPool;
        }
        if (!t) { g_profFull++; return nullptr; }
        t->open = true;
    }
    if (!t->begin)
    {
        ID3D11Device *dev = nullptr;
        ctx->GetDevice(&dev);
        D3D11_QUERY_DESC qd = { D3D11_QUERY_TIMESTAMP_DISJOINT, 0 };
        if (dev)
        {
            if (!t->disjoint) dev->CreateQuery(&qd, &t->disjoint);
            qd.Query = D3D11_QUERY_TIMESTAMP;
            if (!t->end) dev->CreateQuery(&qd, &t->end);
            if (t->disjoint && t->end) dev->CreateQuery(&qd, &t->begin);
            dev->Release();
        }
        if (!t->begin) { std::lock_guard<std::mutex> lock(g_profLock); t->open = false; return nullptr; }
    }
    t->desc = d;
    ctx->Begin(t->disjoint);
    ctx->End(t->begin);
    return t;
}
// the pass timed on ctx ends; one that drew with more than one pixel shader is summed under its targets alone
static void ProfEnd(ID3D11DeviceContext *ctx, ContextState *s)
{
    ProfTimer *t = s->prof;
    if (!t) return;
    s->prof = nullptr;
    if (t->desc.many) t->desc.shader = 0;
    ctx->End(t->end);
    ctx->End(t->disjoint);
    std::lock_guard<std::mutex> lock(g_profLock);
    t->issued = GetTickCount64();
    t->frame = g_profFrameNo;
    t->pending = true;
    t->open = false;
}
static void ProfStart(ID3D11DeviceContext *ctx, ContextState *s, const ProfDesc &d, UINT ps = 0)
{
    ProfEnd(ctx, s);
    s->prof = ProfBegin(ctx, d);
    s->profPs = ps;
}
// a timer left open on a context that is gone goes back to the pool unread
static void ProfForget(ContextState *s)
{
    if (!s->prof) return;
    std::lock_guard<std::mutex> lock(g_profLock);
    s->prof->open = false;
    s->prof = nullptr;
}
// the pass on ctx is over for good: its command list ends, a ClearState, Present, a command list runs on the immediate context
static void ProfClose(ID3D11DeviceContext *ctx)
{
    ContextState *s = State(ctx);
    ProfEnd(ctx, s);
    s->profHavePaused = false;
}
// the context kept its state (ExecuteCommandList or FinishCommandList with restore): the pass on its targets goes on
static void ProfKept(ID3D11DeviceContext *ctx)
{
    ContextState *s = State(ctx);
    if (s->profHaveTargets) ProfStart(ctx, s, s->profTargets);
}

// the size of a target view's texture at the view's mip level (0 x 0 for anything but a 2D texture)
static void ProfTargetSize(ID3D11View *v, UINT mip, uint32_t *w, uint32_t *h)
{
    ID3D11Resource *r = nullptr;
    v->GetResource(&r);
    D3D11_TEXTURE2D_DESC d = {};
    if (r && Desc2D(r, &d)) { *w = (d.Width >> mip) ? (d.Width >> mip) : 1; *h = (d.Height >> mip) ? (d.Height >> mip) : 1; }
    if (r) r->Release();
}
// the game set its render targets: a pass on them begins
static void ProfTargets(ID3D11DeviceContext *ctx, ContextState *s, UINT n, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv, bool uavs)
{
    ProfDesc d = {};
    d.kind = kProfTargets;
    d.uav = uavs ? 1 : 0;
    for (UINT i = 0; rtvs && i < n && i < 8; i++)
    {
        if (!rtvs[i]) continue;
        D3D11_RENDER_TARGET_VIEW_DESC v = {};
        rtvs[i]->GetDesc(&v);
        d.fmt[i] = (uint16_t)v.Format;
        d.rts++;
        if (!d.w) ProfTargetSize(rtvs[i], v.ViewDimension == D3D11_RTV_DIMENSION_TEXTURE2D ? v.Texture2D.MipSlice : v.ViewDimension == D3D11_RTV_DIMENSION_TEXTURE2DARRAY ? v.Texture2DArray.MipSlice : 0, &d.w, &d.h);
    }
    if (dsv)
    {
        D3D11_DEPTH_STENCIL_VIEW_DESC v = {};
        dsv->GetDesc(&v);
        d.dsvFmt = (uint16_t)v.Format;
        if (!d.w) ProfTargetSize(dsv, v.ViewDimension == D3D11_DSV_DIMENSION_TEXTURE2D ? v.Texture2D.MipSlice : v.ViewDimension == D3D11_DSV_DIMENSION_TEXTURE2DARRAY ? v.Texture2DArray.MipSlice : 0, &d.w, &d.h);
    }
    s->profTargets = d;
    s->profHaveTargets = true;
    s->profHavePaused = false;
    // the pixel shader bound already names it (the game sets a full-screen pass's shader before its target at times)
    d.shader = s->profCurPs;
    ProfStart(ctx, s, d, d.shader ? 1 : 0);
}
// the game set a pixel shader: the pass on the targets is named by it while it is the only one (after compute work with
// the targets kept, the pass on them goes on; unbinding the shader names nothing). GpuProfileShaders: each pixel shader
// starts a pass of its own on the same targets.
static void ProfPixelShader(ID3D11DeviceContext *ctx, ContextState *s, ID3D11PixelShader *ps)
{
    const uint32_t h = ps ? ShaderHash(ps) : 0;
    s->profCurPs = h;
    if (!ps) return;
    if (s->prof && s->prof->desc.kind == kProfCompute && s->profHaveTargets) ProfStart(ctx, s, s->profTargets);
    if (!s->prof || s->prof->desc.kind != kProfTargets) return;
    if (g_gpuProfileShaders && s->profPs && h != s->prof->desc.shader)
    {
        ProfDesc d = s->prof->desc;
        d.shader = h;
        d.many = 0;
        ProfStart(ctx, s, d, 1);
        return;
    }
    if (s->profPs++ == 0) s->prof->desc.shader = h;
    else if (h != s->prof->desc.shader) s->prof->desc.many = 1;
}
// the game set a compute shader: a compute pass begins (the same shader again goes on with the one timed)
static void ProfCompute(ID3D11DeviceContext *ctx, ContextState *s, ID3D11ComputeShader *cs)
{
    const uint32_t h = ShaderHash(cs);
    if (s->prof && s->prof->desc.kind == kProfCompute && s->prof->desc.shader == h) return;
    ProfDesc d = {};
    d.kind = kProfCompute;
    d.shader = h;
    s->profHavePaused = false;
    ProfStart(ctx, s, d);
}
// this DLL's own work inside the game's pass on ctx: timed on its own, the game's pass paused (ProfResume goes on with it)
static void ProfOurs(ID3D11DeviceContext *ctx, ContextState *s, uint16_t which)
{
    if (!g_gpuProfile) return;
    if (s->prof && s->prof->desc.kind != kProfOurs) { s->profPaused = s->prof->desc; s->profPausedPs = s->profPs; s->profHavePaused = true; }
    ProfDesc d = {};
    d.kind = kProfOurs;
    d.ours = which;
    ProfStart(ctx, s, d);
}
static void ProfResume(ID3D11DeviceContext *ctx, ContextState *s)
{
    if (!g_gpuProfile) return;
    ProfEnd(ctx, s);
    if (s->profHavePaused) { s->profHavePaused = false; ProfStart(ctx, s, s->profPaused, s->profPausedPs); }
}

static const char *ProfFormat(UINT f)
{
    switch (f)
    {
    case DXGI_FORMAT_R32G32B32A32_FLOAT: return "RGBA32F";
    case DXGI_FORMAT_R16G16B16A16_FLOAT: return "RGBA16F";
    case DXGI_FORMAT_R16G16B16A16_UNORM: return "RGBA16";
    case DXGI_FORMAT_R32G32_FLOAT: return "RG32F";
    case DXGI_FORMAT_R10G10B10A2_UNORM: return "RGB10A2";
    case DXGI_FORMAT_R11G11B10_FLOAT: return "R11G11B10F";
    case DXGI_FORMAT_R8G8B8A8_UNORM: return "RGBA8";
    case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB: return "RGBA8_SRGB";
    case DXGI_FORMAT_R8G8B8A8_SNORM: return "RGBA8S";
    case DXGI_FORMAT_B8G8R8A8_UNORM: return "BGRA8";
    case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB: return "BGRA8_SRGB";
    case DXGI_FORMAT_R16G16_FLOAT: return "RG16F";
    case DXGI_FORMAT_R16G16_UNORM: return "RG16";
    case DXGI_FORMAT_R16G16_SNORM: return "RG16S";
    case DXGI_FORMAT_R32_FLOAT: return "R32F";
    case DXGI_FORMAT_R32_UINT: return "R32U";
    case DXGI_FORMAT_R16_FLOAT: return "R16F";
    case DXGI_FORMAT_R16_UNORM: return "R16";
    case DXGI_FORMAT_R8G8_UNORM: return "RG8";
    case DXGI_FORMAT_R8_UNORM: return "R8";
    case DXGI_FORMAT_D32_FLOAT: return "D32F";
    case DXGI_FORMAT_D24_UNORM_S8_UINT: return "D24S8";
    case DXGI_FORMAT_D32_FLOAT_S8X24_UINT: return "D32FS8";
    case DXGI_FORMAT_D16_UNORM: return "D16";
    default: return nullptr;
    }
}
static void ProfName(const ProfDesc &d, char *out, size_t size)
{
    static const char *const ours[kProfOursCount] = { "?", "scene feed copy", "reflection pass (setup)", "AO blur and upsample", "AO depth mips",
        "reflections: depth pyramid", "reflections: trace", "reflections: resolve", "reflections: history depth copy, target 7 clear", "reflections: motion decode",
        "contact shadows" };
    if (d.kind == kProfOurs) { snprintf(out, size, "this DLL: %s", d.ours < kProfOursCount ? ours[d.ours] : "?"); return; }
    if (d.kind == kProfCompute) { snprintf(out, size, "compute: cs %08X", d.shader); return; }
    int at = d.rts || d.dsvFmt ? snprintf(out, size, "%u x %u:", d.w, d.h) : snprintf(out, size, "no targets:");
    for (int i = 0; i < 8 && at > 0 && at < (int)size; i++)
        if (d.fmt[i]) { const char *f = ProfFormat(d.fmt[i]); at += f ? snprintf(out + at, size - at, " %s", f) : snprintf(out + at, size - at, " fmt%u", d.fmt[i]); }
    if (d.dsvFmt && at > 0 && at < (int)size) { const char *f = ProfFormat(d.dsvFmt); at += f ? snprintf(out + at, size - at, " depth %s", f) : snprintf(out + at, size - at, " depth fmt%u", d.dsvFmt); }
    if (d.uav && at > 0 && at < (int)size) at += snprintf(out + at, size - at, " + UAVs");
    if (at > 0 && at < (int)size) snprintf(out + at, size - at, d.many ? "; many pixel shaders" : d.shader ? "; ps %08X" : "; no pixel shader", d.shader);
}

// under g_profLock, on the immediate context: the marks and the timers that have answered
static void ProfPoll(ID3D11DeviceContext *immediate)
{
    for (ProfMark &m : g_profMarks)
    {
        UINT64 v = 0;
        if (!m.pending || immediate->GetData(m.q, &v, sizeof v, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        m.pending = false; m.known = true; m.at = v;
        // the frame that ends here: from the mark before it
        for (const ProfMark &p : g_profMarks)
            if (p.known && p.seq + 1 == m.seq && p.at < v && g_profFreq > 0)
            {
                const double ms = (double)(v - p.at) * 1000.0 / g_profFreq;
                if (ms < 1000) { g_profGpuMs += ms; g_profGpuN++; g_profAllGpuMs += ms; g_profAllGpuN++; g_profLastFrameMs = ms; }
            }
    }
    for (ProfTimer &t : g_profPool)
    {
        if (!t.pending || t.frame == g_profFrameNo) continue; // (this frame's: not run yet)
        UINT64 a = 0, b = 0;
        if (immediate->GetData(t.end, &b, sizeof b, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj = {};
        if (immediate->GetData(t.disjoint, &dj, sizeof dj, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK || immediate->GetData(t.begin, &a, sizeof a, D3D11_ASYNC_GETDATA_DONOTFLUSH) != S_OK) continue;
        t.pending = false;
        if (dj.Disjoint || !dj.Frequency || b < a) { g_profDropped++; continue; }
        g_profFreq = (double)dj.Frequency;
        const double ms = (double)(b - a) * 1000.0 / g_profFreq;
        ProfEntry &e = g_prof[ProfKey(t.desc)];
        e.desc = t.desc;
        e.ms += ms; e.n++; e.all += ms; e.alln++;
        // where it starts: after the last mark before it (a mark not read yet leaves an older one: more than a frame, skipped)
        bool found = false;
        UINT64 start = 0;
        for (const ProfMark &m : g_profMarks) if (m.known && m.at <= a && (!found || m.at > start)) { start = m.at; found = true; }
        const double at = found ? (double)(a - start) * 1000.0 / g_profFreq : -1;
        if (found && (g_profLastFrameMs <= 0 || at < g_profLastFrameMs * 1.5)) { e.at += at; e.atN++; e.allAt += at; e.allAtN++; }
    }
}
// the passes, the biggest first (whole: over the run, else since the last list)
static void ProfList(bool whole)
{
    const uint64_t frames = whole ? g_profAllFrames : g_profFrames;
    if (!frames) return;
    std::vector<std::pair<double, uint64_t>> order;
    double sum = 0;
    for (const auto &kv : g_prof)
    {
        const double ms = whole ? kv.second.all : kv.second.ms;
        if ((whole ? kv.second.alln : kv.second.n) == 0) continue;
        order.push_back({ ms, kv.first });
        sum += ms;
    }
    std::sort(order.begin(), order.end(), [](const std::pair<double, uint64_t> &x, const std::pair<double, uint64_t> &y) { return x.first > y.first; });
    const double gpu = whole ? (g_profAllGpuN ? g_profAllGpuMs / g_profAllGpuN : 0) : (g_profGpuN ? g_profGpuMs / g_profGpuN : 0);
    Log("profile%s: %llu frames: %.3f ms of GPU time per frame from Present to Present, %.3f ms of it in %zu kinds of pass%s%s", whole ? " over the run" : "",
        (unsigned long long)frames, gpu, sum / frames, order.size(), g_profFull ? "; some passes untimed (every timer busy)" : "", g_profDropped ? "; some timings got no answer" : "");
    for (size_t i = 0; i < order.size() && i < (g_gpuProfileShaders ? 250u : 60u); i++)
    {
        const ProfEntry &e = g_prof[order[i].second];
        const double at = whole ? (e.allAtN ? e.allAt / e.allAtN : -1) : (e.atN ? e.at / e.atN : -1);
        char name[200];
        ProfName(e.desc, name, sizeof name);
        Log("profile: %8.3f ms %6.1f x at %7.3f ms  %016llX  %s", order[i].first / frames, (double)(whole ? e.alln : e.n) / frames, at, (unsigned long long)order[i].second, name);
    }
}
// Present: the frame's end marked on the immediate context, what has answered read, the list when its interval is over;
// the immediate context's work from here to its next targets (Present's own, copies, clears) timed as a pass of no targets
static void ProfFrameLocked(ID3D11DeviceContext *immediate);
static void ProfFrame(IDXGISwapChain *sc)
{
    ID3D11DeviceContext *immediate = ImmediateContext(sc);
    if (!immediate) return;
    ProfClose(immediate);
    {
        std::lock_guard<std::mutex> lock(g_profLock);
        ProfFrameLocked(immediate);
    }
    ProfStart(immediate, State(immediate), ProfDesc{});
}
static void ProfFrameLocked(ID3D11DeviceContext *immediate)
{
    ProfMark &m = g_profMarks[g_profMarkSeq % kProfMarks];
    if (!m.q)
    {
        ID3D11Device *dev = nullptr;
        immediate->GetDevice(&dev);
        D3D11_QUERY_DESC qd = { D3D11_QUERY_TIMESTAMP, 0 };
        if (dev) { dev->CreateQuery(&qd, &m.q); dev->Release(); }
    }
    if (m.q && !m.pending) { immediate->End(m.q); m.pending = true; m.known = false; m.seq = g_profMarkSeq++; }
    ProfPoll(immediate);
    g_profFrameNo++; g_profFrames++; g_profAllFrames++;
    const ULONGLONG now = GetTickCount64();
    if (!g_profLogged) g_profLogged = now;
    if (now - g_profLogged < g_gpuProfile * 1000ULL) return;
    ProfList(false);
    for (auto &kv : g_prof) { kv.second.ms = 0; kv.second.n = 0; kv.second.at = 0; kv.second.atN = 0; }
    g_profFrames = 0; g_profGpuMs = 0; g_profGpuN = 0;
    g_profLogged = now;
}

// ---- context hooks

// the game set its render targets (after the call went through): the lit pass remembered; the blend state the game set
// back in place of a copy; the bounce light beside the AO pass's target, render target 7 beside the lit pass's
static void TargetsChanged(ID3D11DeviceContext *self, const ContextOrig *o, UINT n, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv, bool uavs)
{
    if (g_gpuProfile) ProfTargets(self, State(self), n, rtvs, dsv, uavs); // (before the AO upsample below: timed on its own inside the new pass)
    if (g_depthProbe) DPTargets(self, State(self), n, rtvs, dsv);
    {
        ContextState *hs = State(self);
        if (hs->aoHalf) AOHalfEnd(self, o, hs, false); // the half-size AO pass is over: the game's viewports back
    }
    const bool lit = g_feed && n == 3 && rtvs && rtvs[0] && rtvs[2];
    if (lit) { RememberLitPass(rtvs[0], rtvs[1], rtvs[2]); ProbeLitPass(rtvs); }
    if (g_gpuTimers)
    {
        ContextState *gs = State(self);
        if (gs->gpuPass) GpuEnd(self, gs->gpuPass); // an AO or apply pass is over with its targets
        if (gs->gpuLit) GpuEnd(self, gs->gpuLit);
        if (lit) gs->gpuLit = GpuBegin(self, kGpuLit);
    }
    if (!g_gi && !g_ssr && !g_contact) return;
    ContextState *s = State(self);
    RestoreBlend(self, o, s);
    if (s->dumpAwaiting && s->giBound) DumpOutputs(self, s, "the game's next OMSetRenderTargets"); // the AO pass is over
    s->giBound = false;
    s->rt7Bound = false;
    s->rt6Bound = false;
    if (ProbeOn()) ProbeTargets(self, s, n, rtvs, uavs);
    if (g_gi && n == 1 && rtvs && rtvs[0] && (s->psFlags & kFeedGIWrites)) GIBindTarget(self, o, rtvs[0], dsv);
    if (lit && rtvs[1] && !uavs) LitBind(self, o, s, rtvs, dsv);
}

static void STDMETHODCALLTYPE Hook_OMSetRenderTargets(ID3D11DeviceContext *self, UINT n, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv)
{
    CpuScope cpu(kCpuOMSet);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->omSet(self, n, rtvs, dsv); });
    if (!scope.outer) return;
    DepthTargetChanged(self, o, dsv, n);
    TargetsChanged(self, o, n, rtvs, dsv, false);
}

static void STDMETHODCALLTYPE Hook_OMSetRenderTargetsAndUAVs(ID3D11DeviceContext *self, UINT n, ID3D11RenderTargetView *const *rtvs, ID3D11DepthStencilView *dsv,
    UINT uavStart, UINT uavCount, ID3D11UnorderedAccessView *const *uavs, const UINT *counts)
{
    CpuScope cpu(kCpuOMSetUAV);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->omSetUAV(self, n, rtvs, dsv, uavStart, uavCount, uavs, counts); });
    if (!scope.outer || n == D3D11_KEEP_RENDER_TARGETS_AND_DEPTH_STENCIL) return;
    DepthTargetChanged(self, o, dsv, n);
    TargetsChanged(self, o, n, rtvs, dsv, uavs && uavCount && uavCount != D3D11_KEEP_UNORDERED_ACCESS_VIEWS);
}

// bounce light, reflections: the game sets a blend state (it replaces any copy the context held); while a target of this
// DLL is bound, the new state gets its copy if it would not write that target as needed (no copy: the target goes)
static void STDMETHODCALLTYPE Hook_OMSetBlendState(ID3D11DeviceContext *self, ID3D11BlendState *bs, const FLOAT factor[4], UINT mask)
{
    CpuScope cpu(kCpuBlend);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->omSetBlend(self, bs, factor, mask); });
    if (!scope.outer || (!g_gi && !g_ssr && !g_contact)) return;
    ContextState *s = State(self);
    s->blendSwapped = false;
    if (s->giBound && !PlainBlend(self, o, s, 1u << 1)) GIUnbindTarget(self, o);
    const UINT lit = (s->rt6Bound ? 1u << kRT6 : 0u) | (s->rt7Bound ? 1u << kRT7 : 0u);
    if (lit && !PlainBlend(self, o, s, lit)) LitUnbind(self, o);
}

static void STDMETHODCALLTYPE Hook_RSSetViewports(ID3D11DeviceContext *self, UINT n, const D3D11_VIEWPORT *vps)
{
    CpuScope cpu(kCpuViewports);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (!scope.outer) { o->setViewports(self, n, vps); return; }
    ContextState *s = State(self);
    s->viewports.assign(vps, vps + (vps ? n : 0));
    if (s->aoHalf) { AOHalfViewports(self, o, s); return; } // the AO pass drawn at half size
    if (g_trace && s->atlas)
        Trace("VP ctx %p n %u: %g %g %g %g", (void *)self, n, n ? vps[0].TopLeftX : 0.f, n ? vps[0].TopLeftY : 0.f, n ? vps[0].Width : 0.f, n ? vps[0].Height : 0.f);
    if (s->atlas && !s->viewports.empty())
    {
        std::vector<D3D11_VIEWPORT> v = s->viewports;
        for (D3D11_VIEWPORT &x : v) { x.TopLeftX *= s->factor; x.TopLeftY *= s->factor; x.Width *= s->factor; x.Height *= s->factor; }
        cpu.Orig([&] { o->setViewports(self, (UINT)v.size(), v.data()); });
        s->scaled = true;
    }
    else
        cpu.Orig([&] { o->setViewports(self, n, vps); });
}

static void STDMETHODCALLTYPE Hook_RSSetScissorRects(ID3D11DeviceContext *self, UINT n, const D3D11_RECT *rects)
{
    CpuScope cpu(kCpuScissors);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (!scope.outer) { o->setScissors(self, n, rects); return; }
    ContextState *s = State(self);
    s->scissors.assign(rects, rects + (rects ? n : 0));
    if (g_trace && s->atlas)
        Trace("SC ctx %p n %u: %ld %ld %ld %ld", (void *)self, n, n ? rects[0].left : 0L, n ? rects[0].top : 0L, n ? rects[0].right : 0L, n ? rects[0].bottom : 0L);
    if (s->atlas && !s->scissors.empty())
    {
        std::vector<D3D11_RECT> r = s->scissors;
        for (D3D11_RECT &x : r) { x.left = Scale(x.left, s->factor); x.top = Scale(x.top, s->factor); x.right = Scale(x.right, s->factor); x.bottom = Scale(x.bottom, s->factor); }
        cpu.Orig([&] { o->setScissors(self, (UINT)r.size(), r.data()); });
        s->scaled = true;
    }
    else
        cpu.Orig([&] { o->setScissors(self, n, rects); });
}

static void STDMETHODCALLTYPE Hook_RSGetViewports(ID3D11DeviceContext *self, UINT *n, D3D11_VIEWPORT *vps)
{
    CpuScope cpu(kCpuGetViewports);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->getViewports(self, n, vps); });
    if (!scope.outer) return;
    ContextState *s = State(self);
    if (vps && n && s->aoHalf) { for (UINT i = 0; i < *n && i < s->viewports.size(); i++) vps[i] = s->viewports[i]; return; } // the game's own
    if (vps && n && s->scaled)
        for (UINT i = 0; i < *n; i++) { vps[i].TopLeftX /= s->factor; vps[i].TopLeftY /= s->factor; vps[i].Width /= s->factor; vps[i].Height /= s->factor; }
}

static void STDMETHODCALLTYPE Hook_RSGetScissorRects(ID3D11DeviceContext *self, UINT *n, D3D11_RECT *rects)
{
    CpuScope cpu(kCpuGetScissors);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->getScissors(self, n, rects); });
    if (!scope.outer) return;
    ContextState *s = State(self);
    if (rects && n && s->scaled)
        for (UINT i = 0; i < *n; i++)
        {
            const float inv = 1.0f / s->factor;
            rects[i].left = Scale(rects[i].left, inv); rects[i].top = Scale(rects[i].top, inv);
            rects[i].right = Scale(rects[i].right, inv); rects[i].bottom = Scale(rects[i].bottom, inv);
        }
}

// the rasterizer state as the caller set it; while the scaled texture is bound the context holds the copy with the
// scaled slope bias, and reads give the caller its own state back
static void STDMETHODCALLTYPE Hook_RSSetState(ID3D11DeviceContext *self, ID3D11RasterizerState *rs)
{
    CpuScope cpu(kCpuRSSet);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (!scope.outer) { o->setRS(self, rs); return; }
    ContextState *s = State(self);
    s->rs = rs;
    s->rsScaled = g_slopeBias && s->atlas && rs;
    ID3D11RasterizerState *use = s->rsScaled ? ScaledRS(rs, s->factor) : rs;
    cpu.Orig([&] { o->setRS(self, use); });
}

static void STDMETHODCALLTYPE Hook_RSGetState(ID3D11DeviceContext *self, ID3D11RasterizerState **out)
{
    CpuScope cpu(kCpuRSGet);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->getRS(self, out); });
    if (!scope.outer || !out) return;
    ContextState *s = State(self);
    if (!s->rsScaled) return;
    if (*out) (*out)->Release();
    *out = s->rs; // held by g_rsScaled, so still alive
    if (*out) (*out)->AddRef();
}

static void STDMETHODCALLTYPE Hook_ClearState(ID3D11DeviceContext *self)
{
    CpuScope cpu(kCpuClearState);
    HookScope scope;
    if (scope.outer) { ContextState *s = State(self); if (s->dumpAwaiting) DumpOutputs(self, s, "ClearState"); } // the AO pass is over
    if (scope.outer && g_depthProbe) DPFlush(self, State(self));
    if (scope.outer && g_gpuTimers) GpuCloseContext(self);
    if (scope.outer && g_gpuProfile) ProfClose(self);
    cpu.Orig([&] { CtxOrig(self)->clearState(self); });
    if (scope.outer) { ResetState(self); g_resets++; }
}

// trace: what a recorded command list holds, so the order the lists run in shows where the shadow passes fall
struct ListInfo { uint32_t id, shadowDraws, otherDraws, binds; };
static void CheckHooks(ID3D11DeviceContext *ctx);

static void STDMETHODCALLTYPE Hook_ExecuteCommandList(ID3D11DeviceContext *self, ID3D11CommandList *list, BOOL restore)
{
    CpuScope cpu(kCpuExecute);
    HookScope scope;
    // dump: an AO pass on the immediate context ends here; and which dump this list carries copies for, if any
    const bool dumping = scope.outer && g_dumpState.load(std::memory_order_relaxed) != kDumpIdle;
    uint32_t dumpList = 0;
    if (dumping)
    {
        ContextState *s = State(self);
        if (s->dumpAwaiting) DumpOutputs(self, s, "ExecuteCommandList");
        UINT size = sizeof dumpList;
        if (!list || FAILED(list->GetPrivateData(kDumpListTag, &size, &dumpList)) || size != sizeof dumpList) dumpList = 0;
    }
    if (g_trace && scope.outer) CheckHooks(self);
    if (g_trace && scope.outer && list && InBurst())
    {
        ListInfo li = {};
        UINT size = sizeof li;
        if (FAILED(list->GetPrivateData(kListTag, &size, &li)) || size != sizeof li) li = {};
        Trace("EXEC ctx %p list #%u: shadow draws %u in %u binds, other draws %u, restore %d", (void *)self, li.id, li.shadowDraws, li.binds, li.otherDraws, restore);
    }
    if (scope.outer && g_depthProbe) { DPFlush(self, State(self)); DPExecute(self, list); }
    if (scope.outer && ProbeOn()) ProbeExecuted(list);
    if (scope.outer && (g_gpuTimers || g_gpuProfile))
    {
        ID3D11DeviceContext *none = nullptr;
        g_gpuImmediate.compare_exchange_strong(none, self); // the context that executes command lists is the immediate one
        if (g_gpuTimers) GpuCloseContext(self);
        if (g_gpuProfile) ProfClose(self); // (the list's passes are timed in it)
    }
    cpu.Orig([&] { CtxOrig(self)->execute(self, list, restore); });
    if (scope.outer && !restore) { ResetState(self); g_resets++; } // the immediate context's state is cleared afterwards
    if (scope.outer && g_gpuProfile) { if (restore) ProfKept(self); else ProfStart(self, State(self), ProfDesc{}); } // (its work until the next targets: no targets)
    if (scope.outer && g_ssr && g_ssrRuns.load(std::memory_order_relaxed)) SSRPollTimers(self);
    if (dumping) DumpExecuted(self, dumpList);
}

static HRESULT STDMETHODCALLTYPE Hook_FinishCommandList(ID3D11DeviceContext *self, BOOL restore, ID3D11CommandList **list)
{
    CpuScope cpu(kCpuFinish);
    HookScope scope;
    ContextState *ds = scope.outer ? State(self) : nullptr;
    if (ds && ds->dumpAwaiting) DumpOutputs(self, ds, "FinishCommandList"); // the AO pass ends with this command list
    if (ds && g_gpuTimers) GpuCloseContext(self);
    if (ds && g_gpuProfile) ProfClose(self);
    if (ds && g_cpuThreads) NoteListThread(GetCurrentThreadId());
    if (ds && g_depthProbe) DPFlush(self, ds); // (into the list's events, before they are handed over below)
    HRESULT hr = S_OK;
    cpu.Orig([&] { hr = CtxOrig(self)->finish(self, restore, list); });
    if (ds && g_depthProbe) DPListFinished(ds, SUCCEEDED(hr) && list ? *list : nullptr);
    if (ds && ds->dumpRecorded) DumpListFinished(ds, hr, list ? *list : nullptr);
    if (ds && !ds->probe.empty()) ProbeFinished(ds, SUCCEEDED(hr) && list ? *list : nullptr);
    if (g_trace && scope.outer)
    {
        CheckHooks(self);
        ContextState *s = State(self);
        if (SUCCEEDED(hr) && list && *list)
        {
            const ListInfo li = { ++g_listIds, s->listShadowDraws, s->listOtherDraws, s->listBinds };
            (*list)->SetPrivateData(kListTag, sizeof li, &li);
            if (li.shadowDraws && InBurst())
                Trace("FINISH ctx %p list #%u: shadow draws %u in %u binds, other draws %u, restore %d", (void *)self, li.id, li.shadowDraws, li.binds, li.otherDraws, restore);
        }
        s->listShadowDraws = s->listOtherDraws = s->listBinds = 0;
    }
    if (scope.outer && !restore) { ResetState(self); g_resets++; } // the deferred context's state is cleared afterwards
    if (scope.outer && restore && g_gpuProfile) ProfKept(self);
    return hr;
}

// ---- trace hooks (Trace=1 only): watch, never change

static bool Desc2D(ID3D11Resource *r, D3D11_TEXTURE2D_DESC *d)
{
    ID3D11Texture2D *t = nullptr;
    if (!r || FAILED(r->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&t)) || !t) return false;
    t->GetDesc(d);
    t->Release();
    return true;
}
static bool DepthFamily(DXGI_FORMAT f)
{
    switch (f)
    {
    case DXGI_FORMAT_R32G8X24_TYPELESS: case DXGI_FORMAT_D32_FLOAT_S8X24_UINT: case DXGI_FORMAT_R32_FLOAT_X8X24_TYPELESS: case DXGI_FORMAT_X32_TYPELESS_G8X24_UINT:
    case DXGI_FORMAT_R32_TYPELESS: case DXGI_FORMAT_D32_FLOAT: case DXGI_FORMAT_R32_FLOAT: case DXGI_FORMAT_R24G8_TYPELESS: case DXGI_FORMAT_D24_UNORM_S8_UINT:
    case DXGI_FORMAT_R24_UNORM_X8_TYPELESS: case DXGI_FORMAT_X24_TYPELESS_G8_UINT: case DXGI_FORMAT_R16_TYPELESS: case DXGI_FORMAT_D16_UNORM: return true;
    default: return false;
    }
}
// worth reporting in a copy: the scaled texture, anything sized like the stock shadow texture or a cascade, any depth
static bool Interesting(ID3D11Resource *r, D3D11_TEXTURE2D_DESC *d, float *f)
{
    *f = 1;
    if (!Desc2D(r, d)) return false;
    if (Tagged(r, f)) return true;
    return d->Width % 1536 == 0 || d->Height % 1536 == 0 || (d->BindFlags & D3D11_BIND_DEPTH_STENCIL) != 0 || DepthFamily(d->Format);
}
static uint32_t ShaderHash(ID3D11DeviceChild *s)
{
    uint32_t h = 0;
    UINT size = sizeof h;
    if (!s || FAILED(s->GetPrivateData(kHashTag, &size, &h)) || size != sizeof h) return 0;
    return h;
}

// dev switches: the original to draw with instead of sh (a pixel or a vertex shader) while its group is switched to
// stock (F8 every changed shader, F11 the AO pass), with a reference for the caller to release; null: draw sh itself
template <class T> static T *StockTwin(T *sh)
{
    const bool all = g_stockAll.load(std::memory_order_relaxed), ao = g_stockAO.load(std::memory_order_relaxed);
    if (!sh || !g_twinCount || (!all && !ao)) return nullptr;
    uint32_t group = 0;
    UINT size = sizeof group;
    if (FAILED(sh->GetPrivateData(kTwinGroupTag, &size, &group)) || size != sizeof group || !(all || group == 1)) return nullptr;
    IUnknown *twin = nullptr;
    size = sizeof twin;
    if (FAILED(sh->GetPrivateData(kTwinTag, &size, &twin)) || !twin) return nullptr;
    T *out = nullptr;
    twin->QueryInterface(__uuidof(T), (void **)&out);
    twin->Release();
    return out;
}

// pass profile: a compute shader the game sets begins a compute pass
static void STDMETHODCALLTYPE Hook_CSSetShader(ID3D11DeviceContext *self, ID3D11ComputeShader *cs, ID3D11ClassInstance *const *inst, UINT n)
{
    CpuScope cpu(kCpuCSSetShader);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->csSet(self, cs, inst, n); });
    if (scope.outer && g_gpuProfile && cs) ProfCompute(self, State(self), cs);
}

// dev switches: a vertex shader the fidelity bundle changed (the sun glow through smoke lives in the particle vertex
// shaders) is set as its original while F8 holds
static void STDMETHODCALLTYPE Hook_VSSetShader(ID3D11DeviceContext *self, ID3D11VertexShader *vs, ID3D11ClassInstance *const *inst, UINT n)
{
    CpuScope cpu(kCpuVSSetShader);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (!scope.outer) { o->vsSet(self, vs, inst, n); return; }
    ID3D11VertexShader *twin = StockTwin(vs);
    cpu.Orig([&] { o->vsSet(self, twin ? twin : vs, inst, n); });
    if (twin) twin->Release(); // the context holds it now
}

// scene feed: which pixel shader is set; the AO pass copies the scene, a reader gets the feed bound (dev switches: the
// shader's original is set in its place while switched to stock)
static void STDMETHODCALLTYPE Hook_PSSetShader(ID3D11DeviceContext *self, ID3D11PixelShader *ps, ID3D11ClassInstance *const *inst, UINT n)
{
    CpuScope cpu(kCpuPSSetShader);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (!scope.outer) { o->psSet(self, ps, inst, n); return; }
    ID3D11PixelShader *twin = StockTwin(ps), *use = twin ? twin : ps;
    cpu.Orig([&] { o->psSet(self, use, inst, n); });
    ContextState *s = State(self);
    uint32_t flags = 0;
    UINT size = sizeof flags;
    if (!use || FAILED(use->GetPrivateData(kFeedTag, &size, &flags)) || size != sizeof flags) flags = 0;
    if (twin) twin->Release(); // the context holds it now
    if (s->dumpAwaiting && !(flags & kFeedAO)) DumpOutputs(self, s, "the next pixel shader"); // the AO pass is over
    s->psFlags = flags;
    if (g_depthProbe)
    {
        s->dpPs = use != nullptr;
        if (s->dpLit && use && self->GetType() == D3D11_DEVICE_CONTEXT_IMMEDIATE) DPCopy(self, s, 0);
        if (flags & kFeedAO) DPCopy(self, s, 2);
    }
    if (g_gpuProfile) ProfPixelShader(self, s, use);
    s->captured = false;
    s->motionDone = false;
    if (ProbeOn() && (flags & (kFeedAO | kFeedAOApply))) ProbeEvent(self, s, (flags & kFeedAO) ? "AO pass shader set" : "AO apply shader set");
    if (s->aoHalf && !(flags & kFeedAO)) AOHalfEnd(self, o, s, true); // a half-size AO pass is over (upsampled here), its targets kept
    if (g_gpuTimers && s->gpuPass) GpuEnd(self, s->gpuPass); // the pass timed so far is over (before this one's feed copy)
    if (flags & kFeedAO) FeedCapture(self, s);
    const bool zMipsPass = (flags & kFeedAO) && (flags & kFeedZMips);
    if (s->zMipsBound && !zMipsPass) ZMipsUnbind(self, o, s);   // the AO pass is over
    if (zMipsPass) ZMipsBuild(self, o, s, s->aoZ);              // (its t80 as bound so far; the game setting it later remakes them)
    if (g_gpuTimers) GpuShaderSet(self, s, flags);
    if (flags & kFeedReads) FeedBind(self, o, flags);
    if (flags & kFeedSSRReads) SSRBind(self, o);
    if (flags & kFeedHiZReads) HiZBind(self, o);
    if (flags & kFeedFogReads) FogBind(self, o);
    if (flags & kFeedVelocity) ProbeVelocityShader(self, s);
    if (flags & kFeedTAA) { if (ProbeOn()) ProbeEvent(self, s, "TAA shader set"); SSRMotionAtTAA(self, s); }
    if (!g_gi) return;
    if (flags & kFeedAOApply)
    {
        // the apply pass reads the AO pass's target at t1 (bound already when the game sets resources first)
        ID3D11ShaderResourceView *mask = nullptr;
        self->PSGetShaderResources(1, 1, &mask);
        if (mask) { RememberAOTarget(mask); mask->Release(); }
    }
    // the AO pass at half size: the apply pass after it reads the full-size result at t1; the game's t1 back once the
    // apply pass is over
    if (s->aoHalfSubst && !(flags & kFeedAOApply)) AOHalfUnsubstitute(self, o, s);
    if ((flags & kFeedAOApply) && s->aoHalfReady) { s->aoHalfReady = false; AOHalfSubstitute(self, o, s); }
    if (flags & kFeedGIWrites)
    {
        // the AO pass's target bound already (the game sets its targets first): the bounce light beside it
        ID3D11RenderTargetView *rtvs[2] = {};
        ID3D11DepthStencilView *dsv = nullptr;
        self->OMGetRenderTargets(2, rtvs, &dsv);
        if (rtvs[0] && !rtvs[1]) GIBindTarget(self, o, rtvs[0], dsv);
        for (auto *r : rtvs) if (r) r->Release();
        if (dsv) dsv->Release();
    }
    if (flags & kFeedGIReads) GIBind(self, o);
}

// scene feed: what is bound at t2 and t80 (the AO pass's g_txFactor and g_txZ), and the feed bound again when the game
// resets t120/t121 under a reader (t122, t123/t124 the same); the TAA's velocity texture at t3. Trace: what the shaders
// read while drawing into the shadow texture, when it is not an ordinary material texture.
static void STDMETHODCALLTYPE Hook_PSSetShaderResources(ID3D11DeviceContext *self, UINT start, UINT n, ID3D11ShaderResourceView *const *srvs)
{
    CpuScope cpu(kCpuPSSRV);
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    cpu.Orig([&] { o->psSRV(self, start, n, srvs); });
    if (!scope.outer) return;
    if (g_feed)
    {
        ContextState *s = State(self);
        if (start <= 2 && start + n > 2) s->aoFactor = srvs ? srvs[2 - start] : nullptr;
        if (start <= 80 && start + n > 80) s->aoZ = srvs ? srvs[80 - start] : nullptr;
        if ((s->psFlags & kFeedAO) && !s->captured) FeedCapture(self, s);
        if ((s->psFlags & kFeedAO) && (s->psFlags & kFeedZMips) && start <= 80 && start + n > 80 && srvs && srvs[80 - start]) ZMipsBuild(self, o, s, srvs[80 - start]);
        if (s->zMipsBound && start <= kZMipsSlot && start + n > kZMipsSlot) ZMipsRebind(self, o);
        if ((s->psFlags & kFeedReads) && start < kFeedSlot + 2 && start + n > kFeedSlot) FeedBind(self, o, s->psFlags);
        if (g_gi && (s->psFlags & kFeedAOApply) && start <= 1 && start + n > 1 && srvs && srvs[1 - start]) RememberAOTarget(srvs[1 - start]);
        if (s->aoHalfSubst && (s->psFlags & kFeedAOApply) && start <= 1 && start + n > 1)
        {
            // the game set t1 again under the apply pass: ours in place of a texture; nothing bound stays nothing
            if (srvs && srvs[1 - start]) AOHalfSubstitute(self, o, s);
            else
            {
                if (s->aoHalfGameT1) { s->aoHalfGameT1->Release(); s->aoHalfGameT1 = nullptr; }
                s->aoHalfSubst = false;
            }
        }
        if (g_gi && (s->psFlags & kFeedGIReads) && start <= kGISlot && start + n > kGISlot) GIBind(self, o);
        if ((s->psFlags & kFeedSSRReads) && start < kSSRSlot + 2 && start + n > kSSRSlot) SSRBind(self, o);
        if ((s->psFlags & kFeedHiZReads) && start <= kHiZSlot && start + n > kHiZSlot) HiZBind(self, o);
        if ((s->psFlags & kFeedFogReads) && start < kFogSlot + 2 && start + n > kFogSlot) FogBind(self, o);
        if ((s->psFlags & kFeedTAA) && !s->motionDone && start <= 3 && start + n > 3) SSRMotionAtTAA(self, s);
    }
    if (!g_trace || !srvs || !InBurst() || !State(self)->atlas) return;
    for (UINT i = 0; i < n; i++)
    {
        if (!srvs[i]) continue;
        ID3D11Resource *r = nullptr;
        srvs[i]->GetResource(&r);
        D3D11_TEXTURE2D_DESC d = {};
        float f = 1;
        if (!Desc2D(r, &d)) Trace("SRV ctx %p t%u: not a 2D texture", (void *)self, start + i);
        else if (Tagged(r, &f) || DepthFamily(d.Format) || (d.BindFlags & D3D11_BIND_DEPTH_STENCIL))
            Trace("SRV ctx %p t%u: %u x %u fmt %u mips %u array %u%s", (void *)self, start + i, d.Width, d.Height, (unsigned)d.Format, d.MipLevels, d.ArraySize, f > 1 ? " [SHADOW TEXTURE]" : "");
        if (r) r->Release();
    }
}

// Every draw is counted for its command list. While the shadow texture is the depth target, every draw is also checked:
// are the viewport and scissor the context really holds the scaled ones? In a burst the first draws after a bind, every
// change of shaders or states and every mismatch are written out, with the shaders' dump names and the states' values.
// Draws that are not into the shadow texture are sampled in a burst for a bind this DLL did not see.
static thread_local unsigned t_drawTick = 0;
static void CheckDraw(ID3D11DeviceContext *self, const ContextOrig *o, const char *kind, UINT a, UINT b)
{
    ContextState *s = State(self);
    if (!s->atlas)
    {
        s->listOtherDraws++;
        if ((++t_drawTick & 31) == 0 && InBurst())
        {
            ID3D11DepthStencilView *dsv = nullptr;
            self->OMGetRenderTargets(0, nullptr, &dsv);
            float f = 1;
            if (dsv && Tagged(dsv, &f)) { g_untracked++; Trace("UNTRACKED %s ctx %p: the shadow texture is the depth target, but it was not seen being bound", kind, (void *)self); }
            if (dsv) dsv->Release();
        }
        return;
    }
    s->draws++;
    s->listShadowDraws++;
    g_drawsBound++;
    D3D11_VIEWPORT vp[16]; UINT nv = 16;
    o->getViewports(self, &nv, vp);
    D3D11_RECT sc[16]; UINT ns = 16;
    o->getScissors(self, &ns, sc);
    bool vpBad = false, scBad = false;
    for (UINT i = 0; i < nv && i < s->viewports.size(); i++)
    {
        const D3D11_VIEWPORT &l = s->viewports[i];
        vpBad |= fabsf(vp[i].TopLeftX - l.TopLeftX * s->factor) > 0.5f || fabsf(vp[i].TopLeftY - l.TopLeftY * s->factor) > 0.5f ||
                 fabsf(vp[i].Width - l.Width * s->factor) > 0.5f || fabsf(vp[i].Height - l.Height * s->factor) > 0.5f;
    }
    vpBad |= nv != s->viewports.size();
    for (UINT i = 0; i < ns && i < s->scissors.size(); i++)
    {
        const D3D11_RECT &l = s->scissors[i];
        scBad |= sc[i].left != Scale(l.left, s->factor) || sc[i].top != Scale(l.top, s->factor) || sc[i].right != Scale(l.right, s->factor) || sc[i].bottom != Scale(l.bottom, s->factor);
    }
    scBad |= ns != s->scissors.size();
    if (vpBad) g_viewportMismatch++;
    if (scBad) g_scissorMismatch++;
    if (!InBurst()) return;
    ID3D11VertexShader *vs = nullptr;
    ID3D11PixelShader *ps = nullptr;
    ID3D11RasterizerState *rs = nullptr;
    ID3D11DepthStencilState *ds = nullptr;
    UINT ref = 0;
    self->VSGetShader(&vs, nullptr, nullptr);
    self->PSGetShader(&ps, nullptr, nullptr);
    self->RSGetState(&rs);
    self->OMGetDepthStencilState(&ds, &ref);
    const bool changed = vs != s->lastVS || ps != s->lastPS || rs != s->lastRS || ds != s->lastDS;
    s->lastVS = vs; s->lastPS = ps; s->lastRS = rs; s->lastDS = ds;
    if (rs && FirstInBurst(rs))
    {
        D3D11_RASTERIZER_DESC d = {};
        rs->GetDesc(&d);
        Trace("RS %p: fill %d cull %d ccw %d depth bias %d clamp %g slope %g, depth clip %d, scissor %d", (void *)rs, d.FillMode, d.CullMode, d.FrontCounterClockwise,
            d.DepthBias, d.DepthBiasClamp, d.SlopeScaledDepthBias, d.DepthClipEnable, d.ScissorEnable);
    }
    if (ds && FirstInBurst(ds))
    {
        D3D11_DEPTH_STENCIL_DESC d = {};
        ds->GetDesc(&d);
        Trace("DS %p: depth %d write %d func %d, stencil %d masks %02X %02X, front %d %d %d %d, back %d %d %d %d", (void *)ds, d.DepthEnable, d.DepthWriteMask, d.DepthFunc,
            d.StencilEnable, d.StencilReadMask, d.StencilWriteMask, d.FrontFace.StencilFailOp, d.FrontFace.StencilDepthFailOp, d.FrontFace.StencilPassOp, d.FrontFace.StencilFunc,
            d.BackFace.StencilFailOp, d.BackFace.StencilDepthFailOp, d.BackFace.StencilPassOp, d.BackFace.StencilFunc);
    }
    if (vpBad || scBad || changed || s->draws <= 4)
        Trace("%s ctx %p #%u (%u, %u) vs %08X ps %08X rs %p ds %p ref %u, phys vp %g %g %g %g (%u) sc %ld %ld %ld %ld (%u)%s%s", kind, (void *)self, s->draws, a, b,
            ShaderHash(vs), ShaderHash(ps), (void *)rs, (void *)ds, ref,
            nv ? vp[0].TopLeftX : 0.f, nv ? vp[0].TopLeftY : 0.f, nv ? vp[0].Width : 0.f, nv ? vp[0].Height : 0.f, nv,
            ns ? sc[0].left : 0L, ns ? sc[0].top : 0L, ns ? sc[0].right : 0L, ns ? sc[0].bottom : 0L, ns,
            vpBad ? " VIEWPORT MISMATCH" : "", scBad ? " SCISSOR MISMATCH" : "");
    if (vs) vs->Release();
    if (ps) ps->Release();
    if (rs) rs->Release();
    if (ds) ds->Release();
}
// Draw and DrawIndexed: the volumetric fog's inputs kept at the composite's draw (its CB_INSTANCE holds the composite's own
// values only then); installed for that alone when there is no trace (ini FogReflections), else they also trace
// (on the immediate context the runtime rewrites its own Draw slot after the first call, so only the game's deferred
// contexts, where it records its frame, are seen here; FogCapture logs which kind the composite came on)
static void FogAtDraw(ID3D11DeviceContext *self)
{
    if (g_fogRefl && (State(self)->psFlags & kFeedFogComposite)) FogCapture(self);
}
static void STDMETHODCALLTYPE Hook_Draw(ID3D11DeviceContext *self, UINT count, UINT start)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { FogAtDraw(self); if (g_depthProbe) DPDraw(self, State(self)); if (g_trace) CheckDraw(self, o, "DRAW", count, start); }
    o->draw(self, count, start);
}
static void STDMETHODCALLTYPE Hook_DrawIndexed(ID3D11DeviceContext *self, UINT count, UINT start, INT base)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { FogAtDraw(self); if (g_depthProbe) DPDraw(self, State(self)); if (g_trace) CheckDraw(self, o, "DRAWIDX", count, start); }
    o->drawIndexed(self, count, start, base);
}
static void STDMETHODCALLTYPE Hook_DrawInstanced(ID3D11DeviceContext *self, UINT perInstance, UINT instances, UINT start, UINT startInstance)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { if (g_depthProbe) DPDraw(self, State(self)); if (g_trace) CheckDraw(self, o, "DRAWINST", perInstance, instances); }
    o->drawInstanced(self, perInstance, instances, start, startInstance);
}
static void STDMETHODCALLTYPE Hook_DrawIndexedInstanced(ID3D11DeviceContext *self, UINT perInstance, UINT instances, UINT start, INT base, UINT startInstance)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { if (g_depthProbe) DPDraw(self, State(self)); if (g_trace) CheckDraw(self, o, "DRAWIDXINST", perInstance, instances); }
    o->drawIndexedInstanced(self, perInstance, instances, start, base, startInstance);
}
static void STDMETHODCALLTYPE Hook_DrawIndexedInstancedIndirect(ID3D11DeviceContext *self, ID3D11Buffer *args, UINT offset)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { if (State(self)->atlas) g_indirect++; CheckDraw(self, o, "DRAWIDXINDIRECT", offset, 0); }
    o->drawIndexedInstancedIndirect(self, args, offset);
}
static void STDMETHODCALLTYPE Hook_DrawInstancedIndirect(ID3D11DeviceContext *self, ID3D11Buffer *args, UINT offset)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { if (State(self)->atlas) g_indirect++; CheckDraw(self, o, "DRAWINSTINDIRECT", offset, 0); }
    o->drawInstancedIndirect(self, args, offset);
}
static void STDMETHODCALLTYPE Hook_DrawAuto(ID3D11DeviceContext *self)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    if (scope.outer) { if (State(self)->atlas) g_indirect++; CheckDraw(self, o, "DRAWAUTO", 0, 0); }
    o->drawAuto(self);
}
static void STDMETHODCALLTYPE Hook_CopyResource(ID3D11DeviceContext *self, ID3D11Resource *dst, ID3D11Resource *src)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    o->copyResource(self, dst, src);
    if (!scope.outer) return;
    D3D11_TEXTURE2D_DESC a = {}, b = {};
    float fa = 1, fb = 1;
    const bool ia = Interesting(dst, &a, &fa), ib = Interesting(src, &b, &fb);
    if (!ia && !ib) return;
    g_copiesSeen++;
    Trace("COPY ctx %p %u x %u fmt %u%s <- %u x %u fmt %u%s", (void *)self, a.Width, a.Height, (unsigned)a.Format, fa > 1 ? " [SHADOW TEXTURE]" : "",
        b.Width, b.Height, (unsigned)b.Format, fb > 1 ? " [SHADOW TEXTURE]" : "");
}
static void STDMETHODCALLTYPE Hook_CopySubresourceRegion(ID3D11DeviceContext *self, ID3D11Resource *dst, UINT dstSub, UINT x, UINT y, UINT z, ID3D11Resource *src, UINT srcSub, const D3D11_BOX *box)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    o->copyRegion(self, dst, dstSub, x, y, z, src, srcSub, box);
    if (!scope.outer) return;
    D3D11_TEXTURE2D_DESC a = {}, b = {};
    float fa = 1, fb = 1;
    const bool ia = Interesting(dst, &a, &fa), ib = Interesting(src, &b, &fb);
    if (!ia && !ib) return;
    g_copiesSeen++;
    Trace("COPYREGION ctx %p %u x %u fmt %u%s sub %u at %u %u <- %u x %u fmt %u%s sub %u box %s %u %u %u %u", (void *)self, a.Width, a.Height, (unsigned)a.Format,
        fa > 1 ? " [SHADOW TEXTURE]" : "", dstSub, x, y, b.Width, b.Height, (unsigned)b.Format, fb > 1 ? " [SHADOW TEXTURE]" : "", srcSub, box ? "set" : "none",
        box ? box->left : 0, box ? box->top : 0, box ? box->right : 0, box ? box->bottom : 0);
}
static void STDMETHODCALLTYPE Hook_ClearDepthStencilView(ID3D11DeviceContext *self, ID3D11DepthStencilView *dsv, UINT flags, FLOAT depth, UINT8 stencil)
{
    const ContextOrig *o = CtxOrig(self);
    HookScope scope;
    o->clearDSV(self, dsv, flags, depth, stencil);
    float f = 1;
    if (scope.outer && Tagged(dsv, &f)) { g_clearsSeen++; Trace("CLEAR ctx %p flags %u depth %g stencil %u", (void *)self, flags, depth, (unsigned)stencil); }
}

// trace: is every hook of this context's table still in place? The runtime rewrites the entries of its own context tables
// that submit work (Draw*, Dispatch*, Copy*, Clear*, UpdateSubresource, ...) when its immediate context flushes or maps,
// measured on WARP and the GPU; the state setters the scaling hooks sit on were never touched. ReShade's
// wrapper tables are not rewritten. Each lost entry is logged once.
static std::mutex g_lostLock;
static std::vector<std::pair<void **, int>> g_lostHooks; // under g_lostLock
static void CheckHooks(ID3D11DeviceContext *ctx)
{
    void **vt = *(void ***)ctx;
    const struct { int slot; const void *hook; const char *name; } hooks[] = {
        { kSlotOMSetRenderTargets, (const void *)&Hook_OMSetRenderTargets, "OMSetRenderTargets (scaling)" },
        { kSlotOMSetRenderTargetsAndUAVs, (const void *)&Hook_OMSetRenderTargetsAndUAVs, "OMSetRenderTargetsAndUnorderedAccessViews (scaling)" },
        { kSlotRSSetViewports, (const void *)&Hook_RSSetViewports, "RSSetViewports (scaling)" },
        { kSlotRSSetScissorRects, (const void *)&Hook_RSSetScissorRects, "RSSetScissorRects (scaling)" },
        { kSlotRSGetViewports, (const void *)&Hook_RSGetViewports, "RSGetViewports (scaling)" },
        { kSlotRSGetScissorRects, (const void *)&Hook_RSGetScissorRects, "RSGetScissorRects (scaling)" },
        { kSlotClearState, (const void *)&Hook_ClearState, "ClearState (scaling)" },
        { kSlotExecuteCommandList, (const void *)&Hook_ExecuteCommandList, "ExecuteCommandList (scaling)" },
        { kSlotFinishCommandList, (const void *)&Hook_FinishCommandList, "FinishCommandList (scaling)" },
        { kSlotRSSetState, (const void *)&Hook_RSSetState, "RSSetState (slope bias)" },
        { kSlotRSGetState, (const void *)&Hook_RSGetState, "RSGetState (slope bias)" },
        { kSlotPSSetShaderResources, (const void *)&Hook_PSSetShaderResources, "PSSetShaderResources (scene feed, trace)" },
        { kSlotPSSetShader, (const void *)&Hook_PSSetShader, "PSSetShader (scene feed)" },
        { kSlotVSSetShader, (const void *)&Hook_VSSetShader, "VSSetShader (dev switches)" },
        { kSlotOMSetBlendState, (const void *)&Hook_OMSetBlendState, "OMSetBlendState (bounce light)" },
        { kSlotDraw, (const void *)&Hook_Draw, "Draw (trace)" },
        { kSlotDrawIndexed, (const void *)&Hook_DrawIndexed, "DrawIndexed (trace)" },
        { kSlotDrawInstanced, (const void *)&Hook_DrawInstanced, "DrawInstanced (trace)" },
        { kSlotDrawIndexedInstanced, (const void *)&Hook_DrawIndexedInstanced, "DrawIndexedInstanced (trace)" },
        { kSlotCopyResource, (const void *)&Hook_CopyResource, "CopyResource (trace)" },
        { kSlotCopySubresourceRegion, (const void *)&Hook_CopySubresourceRegion, "CopySubresourceRegion (trace)" },
        { kSlotClearDepthStencilView, (const void *)&Hook_ClearDepthStencilView, "ClearDepthStencilView (trace)" },
    };
    for (const auto &h : hooks)
    {
        if (vt[h.slot] == h.hook || (h.slot == kSlotOMSetBlendState && !g_gi && !g_ssr) || (h.slot == kSlotVSSetShader && !g_twinCount)) continue; // (not installed with GI=0 SSR=0 / no table)
        std::lock_guard<std::mutex> lock(g_lostLock);
        bool known = false;
        for (const auto &l : g_lostHooks) known |= l.first == vt && l.second == h.slot;
        if (known || g_lostHooks.size() >= 64) continue;
        g_lostHooks.emplace_back(vt, h.slot);
        Log("trace: %s of context table %p no longer calls this DLL", h.name, (void *)vt);
    }
}

static std::atomic<int> g_contextLines{ 0 };

static void HookContext(ID3D11DeviceContext *ctx)
{
    if (!ctx) return;
    std::lock_guard<std::mutex> lock(g_patchLock);
    void **vt = *(void ***)ctx;
    if (vt[kSlotRSSetViewports] == (void *)&Hook_RSSetViewports) return; // this table is hooked already
    ContextOrig e = {};
    e.vt = vt;
    e.omSet = (PFN_OMSetRenderTargets)vt[kSlotOMSetRenderTargets];
    e.omSetUAV = (PFN_OMSetRenderTargetsAndUAVs)vt[kSlotOMSetRenderTargetsAndUAVs];
    e.setViewports = (PFN_RSSetViewports)vt[kSlotRSSetViewports];
    e.setScissors = (PFN_RSSetScissorRects)vt[kSlotRSSetScissorRects];
    e.getViewports = (PFN_RSGetViewports)vt[kSlotRSGetViewports];
    e.getScissors = (PFN_RSGetScissorRects)vt[kSlotRSGetScissorRects];
    e.clearState = (PFN_ClearState)vt[kSlotClearState];
    e.execute = (PFN_ExecuteCommandList)vt[kSlotExecuteCommandList];
    e.finish = (PFN_FinishCommandList)vt[kSlotFinishCommandList];
    e.setRS = (PFN_RSSetState)vt[kSlotRSSetState];
    e.getRS = (PFN_RSGetState)vt[kSlotRSGetState];
    if (g_feed || g_trace || g_twinCount || g_gpuProfile)
    {
        e.psSRV = (PFN_PSSetShaderResources)vt[kSlotPSSetShaderResources];
        e.psSet = (PFN_PSSetShader)vt[kSlotPSSetShader];
    }
    if (g_twinCount) e.vsSet = (PFN_VSSetShader)vt[kSlotVSSetShader];
    if (g_gpuProfile) e.csSet = (PFN_CSSetShader)vt[kSlotCSSetShader];
    if (g_gi || g_ssr) e.omSetBlend = (PFN_OMSetBlendState)vt[kSlotOMSetBlendState];
    if (g_trace || (g_feed && g_fogRefl) || g_depthProbe)
    {
        e.draw = (PFN_Draw)vt[kSlotDraw];               // also hooked for the fog composite's draw (FogAtDraw)
        e.drawIndexed = (PFN_DrawIndexed)vt[kSlotDrawIndexed];
    }
    if (g_depthProbe)
    {
        e.drawInstanced = (PFN_DrawInstanced)vt[kSlotDrawInstanced];
        e.drawIndexedInstanced = (PFN_DrawIndexedInstanced)vt[kSlotDrawIndexedInstanced];
    }
    if (g_trace)
    {
        e.draw = (PFN_Draw)vt[kSlotDraw];
        e.drawIndexed = (PFN_DrawIndexed)vt[kSlotDrawIndexed];
        e.drawInstanced = (PFN_DrawInstanced)vt[kSlotDrawInstanced];
        e.drawIndexedInstanced = (PFN_DrawIndexedInstanced)vt[kSlotDrawIndexedInstanced];
        e.copyResource = (PFN_CopyResource)vt[kSlotCopyResource];
        e.copyRegion = (PFN_CopySubresourceRegion)vt[kSlotCopySubresourceRegion];
        e.clearDSV = (PFN_ClearDepthStencilView)vt[kSlotClearDepthStencilView];
        e.drawIndexedInstancedIndirect = (PFN_DrawIndirect)vt[kSlotDrawIndexedInstancedIndirect];
        e.drawInstancedIndirect = (PFN_DrawIndirect)vt[kSlotDrawInstancedIndirect];
        e.drawAuto = (PFN_DrawAuto)vt[kSlotDrawAuto];
    }
    if (!PublishContext(vt, e)) { Log("context table list full, context %p left alone", (void *)ctx); return; }
    bool ok = PatchSlot(vt, kSlotOMSetRenderTargets, (void *)&Hook_OMSetRenderTargets);
    ok &= PatchSlot(vt, kSlotOMSetRenderTargetsAndUAVs, (void *)&Hook_OMSetRenderTargetsAndUAVs);
    ok &= PatchSlot(vt, kSlotRSSetViewports, (void *)&Hook_RSSetViewports);
    ok &= PatchSlot(vt, kSlotRSSetScissorRects, (void *)&Hook_RSSetScissorRects);
    ok &= PatchSlot(vt, kSlotRSGetViewports, (void *)&Hook_RSGetViewports);
    ok &= PatchSlot(vt, kSlotRSGetScissorRects, (void *)&Hook_RSGetScissorRects);
    ok &= PatchSlot(vt, kSlotClearState, (void *)&Hook_ClearState);
    ok &= PatchSlot(vt, kSlotExecuteCommandList, (void *)&Hook_ExecuteCommandList);
    ok &= PatchSlot(vt, kSlotFinishCommandList, (void *)&Hook_FinishCommandList);
    ok &= PatchSlot(vt, kSlotRSSetState, (void *)&Hook_RSSetState);
    ok &= PatchSlot(vt, kSlotRSGetState, (void *)&Hook_RSGetState);
    if (g_feed || g_trace || g_twinCount || g_gpuProfile)
    {
        ok &= PatchSlot(vt, kSlotPSSetShaderResources, (void *)&Hook_PSSetShaderResources);
        ok &= PatchSlot(vt, kSlotPSSetShader, (void *)&Hook_PSSetShader);
    }
    if (g_twinCount) ok &= PatchSlot(vt, kSlotVSSetShader, (void *)&Hook_VSSetShader);
    if (g_gpuProfile) ok &= PatchSlot(vt, kSlotCSSetShader, (void *)&Hook_CSSetShader);
    if (g_gi || g_ssr) ok &= PatchSlot(vt, kSlotOMSetBlendState, (void *)&Hook_OMSetBlendState);
    if (!g_trace && ((g_feed && g_fogRefl) || g_depthProbe))
    {
        // the fog composite's draw (the water's reflections, see FogCapture): these two alone
        ok &= PatchSlot(vt, kSlotDraw, (void *)&Hook_Draw);
        ok &= PatchSlot(vt, kSlotDrawIndexed, (void *)&Hook_DrawIndexed);
    }
    if (!g_trace && g_depthProbe)
    {
        // the depth probe counts every draw (see DPDraw)
        ok &= PatchSlot(vt, kSlotDrawInstanced, (void *)&Hook_DrawInstanced);
        ok &= PatchSlot(vt, kSlotDrawIndexedInstanced, (void *)&Hook_DrawIndexedInstanced);
    }
    if (g_trace)
    {
        ok &= PatchSlot(vt, kSlotDraw, (void *)&Hook_Draw);
        ok &= PatchSlot(vt, kSlotDrawIndexed, (void *)&Hook_DrawIndexed);
        ok &= PatchSlot(vt, kSlotDrawInstanced, (void *)&Hook_DrawInstanced);
        ok &= PatchSlot(vt, kSlotDrawIndexedInstanced, (void *)&Hook_DrawIndexedInstanced);
        ok &= PatchSlot(vt, kSlotCopyResource, (void *)&Hook_CopyResource);
        ok &= PatchSlot(vt, kSlotCopySubresourceRegion, (void *)&Hook_CopySubresourceRegion);
        ok &= PatchSlot(vt, kSlotClearDepthStencilView, (void *)&Hook_ClearDepthStencilView);
        ok &= PatchSlot(vt, kSlotDrawIndexedInstancedIndirect, (void *)&Hook_DrawIndexedInstancedIndirect);
        ok &= PatchSlot(vt, kSlotDrawInstancedIndirect, (void *)&Hook_DrawInstancedIndirect);
        ok &= PatchSlot(vt, kSlotDrawAuto, (void *)&Hook_DrawAuto);
    }
    if (!ok || g_contextLines < 24)
    {
        g_contextLines++;
        Log("context %p hooked (method table %p, %d tables known)%s", (void *)ctx, (void *)vt, g_contextEntries, ok ? "" : ", a slot could not be written");
    }
}

// ---- device hooks

// The sun shadow texture's shape: a depth texture of three square cascades side by side, one mip, one layer, one sample
static bool ShadowShape(UINT width, UINT height, DXGI_FORMAT format, UINT mips, UINT layers, UINT samples, UINT bind)
{
    if (!(bind & D3D11_BIND_DEPTH_STENCIL) || mips != 1 || layers != 1 || samples != 1) return false;
    if (height < 256 || width != 3 * height) return false;
    switch (format)
    {
    case DXGI_FORMAT_R32G8X24_TYPELESS: case DXGI_FORMAT_D32_FLOAT_S8X24_UINT: case DXGI_FORMAT_R24G8_TYPELESS: case DXGI_FORMAT_D24_UNORM_S8_UINT:
    case DXGI_FORMAT_R32_TYPELESS: case DXGI_FORMAT_D32_FLOAT: case DXGI_FORMAT_R16_TYPELESS: case DXGI_FORMAT_D16_UNORM: return true;
    default: return false;
    }
}

// The GPU timers at factor 1 (nothing scaled): the shadow texture is still tagged, as x1, so that its binds are timed.
// A x1 tag only opens and closes the timing (DepthTargetChanged); without GpuTimers nothing is tagged at factor 1.
static void TagForTimers(ID3D11Texture2D *tex, UINT width, UINT height, DXGI_FORMAT format, UINT mips, UINT layers, UINT samples, UINT bind)
{
    if (!g_gpuTimers || g_scaling || !tex || !ShadowShape(width, height, format, mips, layers, samples, bind)) return;
    const float one = 1;
    tex->SetPrivateData(kScaledTag, sizeof(float), &one);
    Log("shadow texture %u x %u tagged x1 for the GPU timers (factor 1: not scaled)", width, height);
}

// The factor for a texture the game is about to create: > 1 for the sun shadow texture, 1 for everything else
static float ShadowFactor(UINT width, UINT height, DXGI_FORMAT format, UINT mips, UINT layers, UINT samples, UINT bind)
{
    if (!g_scaling || !ShadowShape(width, height, format, mips, layers, samples, bind)) return 1;
    float f = std::floor(g_factor * 2) / 2; // steps of 0.5 keep every cascade edge on a whole texel
    while (f > 1 && width * f > D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION) f -= 0.5f;
    return f;
}

// trace: the depth textures the game makes (and anything else in a depth format or sized in cascades), into the main log
static std::atomic<int> g_textureLines{ 0 };
static void TraceTexture(UINT width, UINT height, DXGI_FORMAT format, UINT mips, UINT layers, UINT samples, UINT bind, UINT misc)
{
    if (!(bind & D3D11_BIND_DEPTH_STENCIL) && !DepthFamily(format) && width % 1536 && height % 1536) return;
    if (g_textureLines++ < 300)
        Log("trace: texture %u x %u, format %u, mips %u, layers %u, samples %u, bind 0x%X, misc 0x%X", width, height, (unsigned)format, mips, layers, samples, bind, misc);
}

static HRESULT STDMETHODCALLTYPE Hook_CreateTexture2D(ID3D11Device *self, const D3D11_TEXTURE2D_DESC *desc, const D3D11_SUBRESOURCE_DATA *init, ID3D11Texture2D **out)
{
    const DeviceOrig *o = DevOrig(self);
    HookScope scope;
    if (g_trace && scope.outer && desc) TraceTexture(desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags, desc->MiscFlags);
    if (g_memLog && scope.outer && desc && (desc->MiscFlags & (D3D11_RESOURCE_MISC_TILED | D3D11_RESOURCE_MISC_TILE_POOL)))
    {
        static std::atomic<int> said{ 0 };
        if (said++ < 8) Log("mem: a tiled texture: %u x %u format %u, %u mips, %u layers, misc 0x%x", desc->Width, desc->Height, (unsigned)desc->Format, desc->MipLevels, desc->ArraySize, desc->MiscFlags);
    }
    const float f = scope.outer && desc && out && !init ? ShadowFactor(desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags) : 1;
    if (f <= 1)
    {
        const HRESULT hr = o->createTexture2D(self, desc, init, out);
        if (g_gpuTimers && scope.outer && desc && out && !init && SUCCEEDED(hr))
            TagForTimers(*out, desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags);
        return hr;
    }
    D3D11_TEXTURE2D_DESC d = *desc;
    d.Width = (UINT)std::lround(d.Width * f);
    d.Height = (UINT)std::lround(d.Height * f);
    HRESULT hr = o->createTexture2D(self, &d, init, out);
    if (SUCCEEDED(hr) && *out)
    {
        (*out)->SetPrivateData(kScaledTag, sizeof(float), &f);
        Log("shadow texture %u x %u created as %u x %u (x%g)", desc->Width, desc->Height, d.Width, d.Height, f);
        return hr;
    }
    Log("shadow texture %u x %u at x%g failed (0x%08lX), created at its own size", desc->Width, desc->Height, f, (unsigned long)hr);
    return o->createTexture2D(self, desc, init, out);
}

static HRESULT STDMETHODCALLTYPE Hook_CreateTexture2D1(ID3D11Device3 *self, const D3D11_TEXTURE2D_DESC1 *desc, const D3D11_SUBRESOURCE_DATA *init, ID3D11Texture2D1 **out)
{
    const DeviceOrig *o = DevOrig(self);
    HookScope scope;
    if (g_trace && scope.outer && desc) TraceTexture(desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags, desc->MiscFlags);
    const float f = scope.outer && desc && out && !init ? ShadowFactor(desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags) : 1;
    if (f <= 1)
    {
        const HRESULT hr = o->createTexture2D1(self, desc, init, out);
        if (g_gpuTimers && scope.outer && desc && out && !init && SUCCEEDED(hr))
            TagForTimers(*out, desc->Width, desc->Height, desc->Format, desc->MipLevels, desc->ArraySize, desc->SampleDesc.Count, desc->BindFlags);
        return hr;
    }
    D3D11_TEXTURE2D_DESC1 d = *desc;
    d.Width = (UINT)std::lround(d.Width * f);
    d.Height = (UINT)std::lround(d.Height * f);
    HRESULT hr = o->createTexture2D1(self, &d, init, out);
    if (SUCCEEDED(hr) && *out)
    {
        (*out)->SetPrivateData(kScaledTag, sizeof(float), &f);
        Log("shadow texture %u x %u created as %u x %u (x%g, CreateTexture2D1)", desc->Width, desc->Height, d.Width, d.Height, f);
        return hr;
    }
    return o->createTexture2D1(self, desc, init, out);
}

static HRESULT STDMETHODCALLTYPE Hook_CreateDepthStencilView(ID3D11Device *self, ID3D11Resource *res, const D3D11_DEPTH_STENCIL_VIEW_DESC *desc, ID3D11DepthStencilView **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createDSV(self, res, desc, out);
    float f = 1;
    if (scope.outer && SUCCEEDED(hr) && out && *out && Tagged(res, &f)) (*out)->SetPrivateData(kScaledTag, sizeof(float), &f);
    return hr;
}

// trace: every shader carries its dump name (CRC32 of its code), so the trace can say which shaders draw into the texture
static HRESULT STDMETHODCALLTYPE Hook_CreateVertexShader(ID3D11Device *self, const void *code, SIZE_T size, ID3D11ClassLinkage *link, ID3D11VertexShader **out)
{
    HookScope scope;
    const DeviceOrig *d = DevOrig(self);
    const HRESULT hr = d->createVS(self, code, size, link, out);
    if (!scope.outer || FAILED(hr) || !code || !out || !*out) return hr;
    const uint32_t crc = Crc32(code, size);
    if (g_trace || g_depthProbe) (*out)->SetPrivateData(kHashTag, sizeof crc, &crc);
    // dev switches: a vertex shader the fidelity bundle changed gets its original beside it, as the pixel shaders do
    if (const TwinEntry *t = g_twinCount ? FindTwin(crc) : nullptr)
    {
        ID3D11VertexShader *twin = nullptr;
        if (SUCCEEDED(d->createVS(self, g_twinBase + t->offset, t->size, link, &twin)) && twin)
        {
            if (g_trace || g_depthProbe) { const uint32_t th = Crc32(g_twinBase + t->offset, t->size); twin->SetPrivateData(kHashTag, sizeof th, &th); }
            (*out)->SetPrivateDataInterface(kTwinTag, twin);
            (*out)->SetPrivateData(kTwinGroupTag, sizeof t->group, &t->group);
            twin->Release(); // the changed shader holds it
            g_twinsMade++;
        }
        else if (g_twinsFailed++ < 4) Log("stock twins: the original of vertex shader %08X could not be made", crc);
    }
    return hr;
}
// pass profile: every compute shader carries its name (CRC32 of its code), as the pixel shaders do
static HRESULT STDMETHODCALLTYPE Hook_CreateComputeShader(ID3D11Device *self, const void *code, SIZE_T size, ID3D11ClassLinkage *link, ID3D11ComputeShader **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createCS(self, code, size, link, out);
    if (!scope.outer || FAILED(hr) || !code || !out || !*out) return hr;
    const uint32_t crc = Crc32(code, size);
    (*out)->SetPrivateData(kHashTag, sizeof crc, &crc);
    return hr;
}

// scene feed: what each pixel shader is to the feed (the AO pass, a reader of t120), looked at once as it is created
static HRESULT STDMETHODCALLTYPE Hook_CreatePixelShader(ID3D11Device *self, const void *code, SIZE_T size, ID3D11ClassLinkage *link, ID3D11PixelShader **out)
{
    HookScope scope;
    const DeviceOrig *d = DevOrig(self);
    const HRESULT hr = d->createPS(self, code, size, link, out);
    if (!scope.outer || FAILED(hr) || !code || !out || !*out) return hr;
    const uint32_t crc = g_trace || g_twinCount || g_ssr || g_gpuProfile ? Crc32(code, size) : 0;
    if (g_trace || g_gpuProfile) (*out)->SetPrivateData(kHashTag, sizeof crc, &crc);
    // dev switches: a shader the fidelity bundle changed gets its original beside it
    if (const TwinEntry *t = g_twinCount ? FindTwin(crc) : nullptr)
    {
        ID3D11PixelShader *twin = nullptr;
        const uint8_t *stock = g_twinBase + t->offset;
        if (SUCCEEDED(d->createPS(self, stock, t->size, link, &twin)) && twin)
        {
            const uint32_t tflags = g_feed ? FeedFlags(stock, t->size) : 0;
            if (tflags) twin->SetPrivateData(kFeedTag, sizeof tflags, &tflags);
            if (g_trace || g_gpuProfile) { const uint32_t th = Crc32(stock, t->size); twin->SetPrivateData(kHashTag, sizeof th, &th); }
            (*out)->SetPrivateDataInterface(kTwinTag, twin);
            (*out)->SetPrivateData(kTwinGroupTag, sizeof t->group, &t->group);
            twin->Release(); // the changed shader holds it
            g_twinsMade++;
        }
        else if (g_twinsFailed++ < 4) Log("stock twins: the original of shader %08X could not be made", crc);
    }
    if (g_feed)
    {
        uint32_t flags = FeedFlags(code, size);
        if (g_ssr && crc == kVelocityPS) flags |= kFeedVelocity;
        if (!g_ssr) flags &= ~(uint32_t)(kFeedWritesO7 | kFeedSSRReads | kFeedTAA | kFeedHiZReads);
        if (flags) (*out)->SetPrivateData(kFeedTag, sizeof flags, &flags);
        if (!g_contact) flags &= ~(uint32_t)kFeedWritesO6;
        if ((flags & kFeedWritesO7) && g_o7Writers++ == 0) Log("reflections: the first shader that writes output 7 was created (%p)", (void *)*out);
        if ((flags & kFeedWritesO6) && g_o6Writers++ == 0) Log("contact shadows: the first shader that writes the sun's visibility (output 6) was created (%p)", (void *)*out);
        if ((flags & kFeedSSRReads) && g_ssrReaders++ == 0) Log("reflections: the first shader that reads t123/t124 was created (%p)", (void *)*out);
        if ((flags & kFeedHiZReads) && g_hizReaders++ == 0) Log("reflections: the first shader that reads the depth pyramid (t125) was created (%p)", (void *)*out);
        static std::atomic<int> velocityLines{ 0 }, taaLines{ 0 };
        if ((flags & kFeedVelocity) && velocityLines++ < 2) Log("reflections: the game's velocity shader was created (%p)%s", (void *)*out, velocityLines > 1 ? " (more follow, not logged)" : "");
        if ((flags & kFeedTAA) && taaLines++ < 2) Log("reflections: the game's TAA shader was created (%p)", (void *)*out);
        if (flags & kFeedAO) Log("scene feed: the AO pass's pixel shader was created (%p)%s", (void *)*out, (flags & kFeedGIWrites) ? ", with a bounce-light output" : "");
        if (flags & kFeedAOApply) Log("scene feed: an AO apply pass's pixel shader was created (%p)", (void *)*out);
        if ((flags & kFeedReads) && g_feedReaders++ == 0) Log("scene feed: the first shader that reads it was created (%p)", (void *)*out);
        if ((flags & kFeedGIReads) && g_giReaders++ == 0) Log("bounce light: the first shader that reads it was created (%p)", (void *)*out);
    }
    return hr;
}

// only the context the game gets back is hooked; the runtime context a wrapper makes inside is left alone
static HRESULT DeferredCreated(const HookScope &scope, HRESULT hr, ID3D11DeviceContext *ctx)
{
    if (scope.outer && SUCCEEDED(hr) && ctx) { HookContext(ctx); ResetState(ctx); DumpForget(State(ctx)); } // a new context may reuse a freed one's address
    return hr;
}
static HRESULT STDMETHODCALLTYPE Hook_CreateDeferredContext(ID3D11Device *self, UINT flags, ID3D11DeviceContext **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createDeferred(self, flags, out);
    return DeferredCreated(scope, hr, out ? *out : nullptr);
}
static HRESULT STDMETHODCALLTYPE Hook_CreateDeferredContext1(ID3D11Device *self, UINT flags, ID3D11DeviceContext **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createDeferred1(self, flags, out);
    return DeferredCreated(scope, hr, out ? *out : nullptr);
}
static HRESULT STDMETHODCALLTYPE Hook_CreateDeferredContext2(ID3D11Device *self, UINT flags, ID3D11DeviceContext **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createDeferred2(self, flags, out);
    return DeferredCreated(scope, hr, out ? *out : nullptr);
}
static HRESULT STDMETHODCALLTYPE Hook_CreateDeferredContext3(ID3D11Device *self, UINT flags, ID3D11DeviceContext **out)
{
    HookScope scope;
    const HRESULT hr = DevOrig(self)->createDeferred3(self, flags, out);
    return DeferredCreated(scope, hr, out ? *out : nullptr);
}

// true when the object answers for the interface with the same method table, so that table has the interface's slots
static bool SameTableFor(ID3D11Device *dev, REFIID iid)
{
    IUnknown *p = nullptr;
    if (FAILED(dev->QueryInterface(iid, (void **)&p)) || !p) return false;
    const bool same = *(void ***)p == *(void ***)dev;
    p->Release();
    return same;
}

static void HookDevice(ID3D11Device *dev)
{
    {
        std::lock_guard<std::mutex> lock(g_patchLock);
        void **vt = *(void ***)dev;
        if (!DevOrig(dev))
        {
            const int n = g_deviceCount.load();
            if (n >= 16) { Log("too many device method tables, %p left alone", (void *)vt); return; }
            const bool v1 = SameTableFor(dev, __uuidof(ID3D11Device1)), v2 = SameTableFor(dev, __uuidof(ID3D11Device2)), v3 = SameTableFor(dev, __uuidof(ID3D11Device3));
            DeviceOrig &e = g_devices[n];
            e.vt = vt;
            e.createTexture2D = (PFN_CreateTexture2D)vt[kSlotCreateTexture2D];
            e.createDSV = (PFN_CreateDepthStencilView)vt[kSlotCreateDepthStencilView];
            e.createDeferred = (PFN_CreateDeferredContext)vt[kSlotCreateDeferredContext];
            if (v1) e.createDeferred1 = (PFN_CreateDeferredContext)vt[kSlotCreateDeferredContext1];
            if (v2) e.createDeferred2 = (PFN_CreateDeferredContext)vt[kSlotCreateDeferredContext2];
            if (v3) { e.createDeferred3 = (PFN_CreateDeferredContext)vt[kSlotCreateDeferredContext3]; e.createTexture2D1 = (PFN_CreateTexture2D1)vt[kSlotCreateTexture2D1]; }
            if (g_trace || g_twinCount) e.createVS = (PFN_CreateVertexShader)vt[kSlotCreateVertexShader];
            if (g_trace || g_feed || g_twinCount || g_gpuProfile) e.createPS = (PFN_CreatePixelShader)vt[kSlotCreatePixelShader];
            if (g_gpuProfile) e.createCS = (PFN_CreateComputeShader)vt[kSlotCreateComputeShader];
            g_deviceCount.store(n + 1, std::memory_order_release);
            bool ok = PatchSlot(vt, kSlotCreateTexture2D, (void *)&Hook_CreateTexture2D);
            ok &= PatchSlot(vt, kSlotCreateDepthStencilView, (void *)&Hook_CreateDepthStencilView);
            ok &= PatchSlot(vt, kSlotCreateDeferredContext, (void *)&Hook_CreateDeferredContext);
            if (v1) ok &= PatchSlot(vt, kSlotCreateDeferredContext1, (void *)&Hook_CreateDeferredContext1);
            if (v2) ok &= PatchSlot(vt, kSlotCreateDeferredContext2, (void *)&Hook_CreateDeferredContext2);
            if (v3) { ok &= PatchSlot(vt, kSlotCreateDeferredContext3, (void *)&Hook_CreateDeferredContext3); ok &= PatchSlot(vt, kSlotCreateTexture2D1, (void *)&Hook_CreateTexture2D1); }
            if (g_trace || g_twinCount) ok &= PatchSlot(vt, kSlotCreateVertexShader, (void *)&Hook_CreateVertexShader);
            if (g_trace || g_feed || g_twinCount || g_gpuProfile) ok &= PatchSlot(vt, kSlotCreatePixelShader, (void *)&Hook_CreatePixelShader);
            if (g_gpuProfile) ok &= PatchSlot(vt, kSlotCreateComputeShader, (void *)&Hook_CreateComputeShader);
            Log("device method table %p hooked (interfaces 1/2/3: %d%d%d)%s", (void *)vt, v1, v2, v3, ok ? "" : " (a slot could not be written)");
        }
    }
    ID3D11DeviceContext *ctx = nullptr;
    dev->GetImmediateContext(&ctx);
    if (ctx) { HookContext(ctx); ResetState(ctx); ctx->Release(); }
    if (g_feed || g_twinCount) StartHotkeys();
}

// ---- frame timer (FrameLog): the time from one Present of the game's swap chain to the next
typedef HRESULT(WINAPI *PFN_CreateDXGIFactory1)(REFIID, void **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateSwapChain)(IDXGIFactory *, IUnknown *, DXGI_SWAP_CHAIN_DESC *, IDXGISwapChain **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_CreateSwapChainForHwnd)(IDXGIFactory2 *, IUnknown *, HWND, const DXGI_SWAP_CHAIN_DESC1 *, const DXGI_SWAP_CHAIN_FULLSCREEN_DESC *, IDXGIOutput *, IDXGISwapChain1 **);
typedef HRESULT(STDMETHODCALLTYPE *PFN_Present)(IDXGISwapChain *, UINT, UINT);
typedef HRESULT(STDMETHODCALLTYPE *PFN_Present1)(IDXGISwapChain1 *, UINT, UINT, const DXGI_PRESENT_PARAMETERS *);
static PFN_CreateDXGIFactory1 g_realCreateFactory1 = nullptr;
static PFN_CreateSwapChain g_realCreateSwapChain = nullptr;
static PFN_CreateSwapChainForHwnd g_realCreateSwapChainForHwnd = nullptr;
static PFN_Present g_realPresent = nullptr;
static PFN_Present1 g_realPresent1 = nullptr;
static std::mutex g_frameLock;
static std::vector<float> g_frameMs;          // this window's frame times
static LARGE_INTEGER g_frameFreq = {}, g_frameLast = {}, g_frameStart = {};

static void FrameTick()
{
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    std::lock_guard<std::mutex> lock(g_frameLock);
    if (!g_frameLast.QuadPart) { g_frameLast = g_frameStart = now; return; }
    g_frameMs.push_back((float)((now.QuadPart - g_frameLast.QuadPart) * 1000.0 / g_frameFreq.QuadPart));
    g_frameLast = now;
    const double span = (now.QuadPart - g_frameStart.QuadPart) / (double)g_frameFreq.QuadPart;
    if (span < g_frameLog) return;
    std::vector<float> s = g_frameMs;
    std::sort(s.begin(), s.end());
    double sum = 0;
    for (float v : s) sum += v;
    size_t k = (size_t)(s.size() * 0.99);
    if (k >= s.size()) k = s.size() - 1;
    const float low = s[k];
    Log("frames: %zu in %.2f s = %.1f fps, average %.2f ms, 1%% low %.2f ms (%.1f fps), longest %.2f ms",
        s.size(), span, s.size() / span, sum / s.size(), low, 1000.0 / low, s.back());
    g_frameMs.clear();
    g_frameStart = now;
}
static HRESULT STDMETHODCALLTYPE Hook_Present(IDXGISwapChain *sc, UINT sync, UINT flags)
{
    if (!(flags & DXGI_PRESENT_TEST)) { if (g_frameLog) FrameTick(); if (g_gpuTimers) GpuFrame(sc); if (g_gpuProfile) ProfFrame(sc); if (g_cpuProfile) CpuFrame(); if (g_cpuThreads) ThreadTick(); if (g_memLog) MemTick(); if (g_depthProbe) DPFrame(sc); }
    return TimedPresent([&] { return g_realPresent(sc, sync, flags); });
}
static HRESULT STDMETHODCALLTYPE Hook_Present1(IDXGISwapChain1 *sc, UINT sync, UINT flags, const DXGI_PRESENT_PARAMETERS *p)
{
    if (!(flags & DXGI_PRESENT_TEST)) { if (g_frameLog) FrameTick(); if (g_gpuTimers) GpuFrame(sc); if (g_gpuProfile) ProfFrame(sc); if (g_cpuProfile) CpuFrame(); if (g_cpuThreads) ThreadTick(); if (g_memLog) MemTick(); if (g_depthProbe) DPFrame(sc); }
    return TimedPresent([&] { return g_realPresent1(sc, sync, flags, p); });
}
// the swap chain's Present (slot 8) and Present1 (slot 22 of IDXGISwapChain1), once: every swap chain of that class
// shares the table
static void HookSwapChain(IDXGISwapChain *sc)
{
    void **vt = *(void ***)sc;
    const bool first = !g_realPresent && !g_realPresent1;
    if (!g_realPresent && vt[8] != (void *)&Hook_Present) { g_realPresent = (PFN_Present)vt[8]; PatchSlot(vt, 8, (void *)&Hook_Present); }
    IDXGISwapChain1 *sc1 = nullptr;
    if (SUCCEEDED(sc->QueryInterface(__uuidof(IDXGISwapChain1), (void **)&sc1)) && sc1)
    {
        void **vt1 = *(void ***)sc1;
        if (!g_realPresent1 && vt1[22] != (void *)&Hook_Present1) { g_realPresent1 = (PFN_Present1)vt1[22]; PatchSlot(vt1, 22, (void *)&Hook_Present1); }
        sc1->Release();
    }
    if (first) Log("frame timer: Present hooked on the swap chain (a line every %u s)", g_frameLog);
}
static HRESULT STDMETHODCALLTYPE Hook_CreateSwapChain(IDXGIFactory *f, IUnknown *dev, DXGI_SWAP_CHAIN_DESC *desc, IDXGISwapChain **out)
{
    const HRESULT hr = g_realCreateSwapChain(f, dev, desc, out);
    if (SUCCEEDED(hr) && out && *out) HookSwapChain(*out);
    return hr;
}
static HRESULT STDMETHODCALLTYPE Hook_CreateSwapChainForHwnd(IDXGIFactory2 *f, IUnknown *dev, HWND wnd, const DXGI_SWAP_CHAIN_DESC1 *desc,
    const DXGI_SWAP_CHAIN_FULLSCREEN_DESC *fs, IDXGIOutput *output, IDXGISwapChain1 **out)
{
    const HRESULT hr = g_realCreateSwapChainForHwnd(f, dev, wnd, desc, fs, output, out);
    if (SUCCEEDED(hr) && out && *out) HookSwapChain(*out);
    return hr;
}
// the factory's CreateSwapChain (slot 10) and CreateSwapChainForHwnd (slot 15 of IDXGIFactory2), once
static HRESULT WINAPI Hook_CreateDXGIFactory1(REFIID riid, void **out)
{
    const HRESULT hr = g_realCreateFactory1(riid, out);
    IDXGIFactory *f = nullptr;
    if (SUCCEEDED(hr) && out && *out && SUCCEEDED(((IUnknown *)*out)->QueryInterface(__uuidof(IDXGIFactory), (void **)&f)) && f)
    {
        void **vt = *(void ***)f;
        if (!g_realCreateSwapChain && vt[10] != (void *)&Hook_CreateSwapChain) { g_realCreateSwapChain = (PFN_CreateSwapChain)vt[10]; PatchSlot(vt, 10, (void *)&Hook_CreateSwapChain); }
        IDXGIFactory2 *f2 = nullptr;
        if (SUCCEEDED(f->QueryInterface(__uuidof(IDXGIFactory2), (void **)&f2)) && f2)
        {
            void **vt2 = *(void ***)f2;
            if (!g_realCreateSwapChainForHwnd && vt2[15] != (void *)&Hook_CreateSwapChainForHwnd) { g_realCreateSwapChainForHwnd = (PFN_CreateSwapChainForHwnd)vt2[15]; PatchSlot(vt2, 15, (void *)&Hook_CreateSwapChainForHwnd); }
            f2->Release();
        }
        f->Release();
    }
    return hr;
}

// ---- texture base rule (ini TextureBaseRule=1, the default): the game keeps each texture's smallest mips
// resident, read from its .pct_base entry, and decides itself where that block starts (SnowRunner.exe rva 0x14d7eb0): a
// texture with a side under 256 (half the int at rva 0x29d931c, 512) keeps all its mips there, any other starts at the
// first mip with a side of 128 or less (block-compressed: backed off until that mip's sides are multiples of 4). Textures
// upscaled 1.5x get sides like 192 (from 128), where the Image Editor starts the block at 96: the game then expects a
// longer block than the file holds, its reader (rva 0x14e1340) seeks backwards by the difference and copies from before
// its buffer, and the map load crashes (all 39 such textures of a 1.5x set; the crash signatures 0x60090/0x18090,
// 0xC0120/0x30120 and 0x30050/0xC050). With 256 there the game's rule is the editor's: the
// 1.5x set then matches everywhere, and of the 13,893 stock texture headers only four 192 x 192 garage maps move, towards
// a shorter block than their file holds, which the reader already handles (it skips the extra leading bytes). The value
// has one reader and no writer; it is set here, before any game code runs (the code is still encrypted then, its data is
// not), for this game build only, and TextureBaseCheck looks at the reader once the code is decrypted.
static const uintptr_t kTexSmallRva = 0x29d931c, kTexSmallReadRva = 0x14d8037;
static const BYTE kTexSmallRead[] = { 0x8b, 0x0d, 0xdf, 0x12, 0x50, 0x01, 0x8b, 0xc1, 0x99, 0x2b, 0xc2, 0xd1, 0xf8 }; // mov ecx,[that int]; mov eax,ecx; cdq; sub eax,edx; sar eax,1
static bool g_texBaseSet = false;

static void TextureBaseRule()
{
    BYTE *exe = (BYTE *)GetModuleHandleW(nullptr);
    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)(exe + ((const IMAGE_DOS_HEADER *)exe)->e_lfanew);
    int *side = (int *)(exe + kTexSmallRva);
    if (nt->FileHeader.TimeDateStamp != 0x6a607c05 || nt->OptionalHeader.SizeOfImage != 0x2e02000 || *side != 512)
    {
        Log("texture base rule: not the game build this was made for (stamp %08x, image size %x), left as the game has it", (unsigned)nt->FileHeader.TimeDateStamp,
            (unsigned)nt->OptionalHeader.SizeOfImage);
        return;
    }
    *side = 256;
    g_texBaseSet = true;
    Log("texture base rule: resident low mips of a texture with a side under 128 (the game: 256) are the whole texture, as the Image Editor builds them (upscaled textures load)");
}

static void TextureBaseCheck()
{
    static std::atomic<bool> checked{ false };
    if (!g_texBaseSet || checked.exchange(true)) return;
    BYTE *exe = (BYTE *)GetModuleHandleW(nullptr);
    if (memcmp(exe + kTexSmallReadRva, kTexSmallRead, sizeof kTexSmallRead) == 0) Log("texture base rule: the game's reader of the value is where expected");
    else
    {
        *(int *)(exe + kTexSmallRva) = 512;
        Log("texture base rule: the game's code differs from the build this was made for, 512 restored");
    }
}

// ---- crash log (ini CrashLog=1, off by default): a first vectored exception handler that writes the first 20
// access violations, stack overflows, illegal instructions and fail-fasts of any thread to the log, as module+offset with
// the faulting address and a stack unwound from the exception's context; then the exception goes on as it would have.
// For crashes that leave nothing behind (no dump, no Windows error).
static bool g_crashLog = false;

static void ModuleOffset(DWORD64 addr, char *out, size_t n)
{
    HMODULE mod = nullptr;
    wchar_t path[MAX_PATH] = L"?";
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)addr, &mod) && mod)
    {
        GetModuleFileNameW(mod, path, MAX_PATH);
        const wchar_t *name = wcsrchr(path, L'\\');
        snprintf(out, n, "%ls+0x%llx", name ? name + 1 : path, (unsigned long long)(addr - (DWORD64)mod));
    }
    else snprintf(out, n, "0x%llx", (unsigned long long)addr);
}

static int CrashStack(CONTEXT ctx, DWORD64 *frames, int max)   // unwinds a copy of the context; SEH guards the reads
{
    int n = 0;
    __try
    {
        for (; n < max && ctx.Rip; n++)
        {
            frames[n] = ctx.Rip;
            DWORD64 imageBase = 0;
            PRUNTIME_FUNCTION fn = RtlLookupFunctionEntry(ctx.Rip, &imageBase, nullptr);
            if (fn)
            {
                void *handlerData = nullptr;
                DWORD64 frame = 0;
                RtlVirtualUnwind(UNW_FLAG_NHANDLER, imageBase, ctx.Rip, fn, &ctx, &handlerData, &frame, nullptr);
            }
            else { ctx.Rip = *(DWORD64 *)ctx.Rsp; ctx.Rsp += 8; }  // a leaf: the return address is on top
        }
    }
    __except (EXCEPTION_EXECUTE_HANDLER) {}
    return n;
}

static LONG CALLBACK CrashVeh(EXCEPTION_POINTERS *ep)
{
    const DWORD code = ep->ExceptionRecord->ExceptionCode;
    if (code != EXCEPTION_ACCESS_VIOLATION && code != EXCEPTION_STACK_OVERFLOW && code != EXCEPTION_ILLEGAL_INSTRUCTION && code != 0xC0000409) return EXCEPTION_CONTINUE_SEARCH;
    static std::atomic<int> count{ 0 };
    if (count.fetch_add(1) >= 20) return EXCEPTION_CONTINUE_SEARCH;
    char where[192];
    ModuleOffset((DWORD64)ep->ExceptionRecord->ExceptionAddress, where, sizeof where);
    const ULONG_PTR *info = ep->ExceptionRecord->ExceptionInformation;
    if (code == EXCEPTION_ACCESS_VIOLATION && ep->ExceptionRecord->NumberParameters >= 2)
        Log("crash log: exception %08x at %s, %s %p, thread %lu", code, where, info[0] == 1 ? "writing" : info[0] == 8 ? "executing" : "reading", (void *)info[1], GetCurrentThreadId());
    else Log("crash log: exception %08x at %s, thread %lu", code, where, GetCurrentThreadId());
    DWORD64 frames[24];
    const int n = CrashStack(*ep->ContextRecord, frames, 24);
    for (int i = 1; i < n; i++)
    {
        ModuleOffset(frames[i], where, sizeof where);
        Log("crash log:    %s", where);
    }
    return EXCEPTION_CONTINUE_SEARCH;
}

typedef HRESULT(WINAPI *PFN_D3D11CreateDevice)(IDXGIAdapter *, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL *, UINT, UINT, ID3D11Device **, D3D_FEATURE_LEVEL *, ID3D11DeviceContext **);
static PFN_D3D11CreateDevice g_realCreateDevice = nullptr;

static HRESULT WINAPI Hook_D3D11CreateDevice(IDXGIAdapter *adapter, D3D_DRIVER_TYPE type, HMODULE sw, UINT flags, const D3D_FEATURE_LEVEL *levels, UINT count,
    UINT sdk, ID3D11Device **device, D3D_FEATURE_LEVEL *level, ID3D11DeviceContext **context)
{
    TextureBaseCheck();
    const HRESULT hr = g_realCreateDevice(adapter, type, sw, flags, levels, count, sdk, device, level, context);
    if (SUCCEEDED(hr) && device && *device) HookDevice(*device);
    return hr;
}

// Points the game's own import of d3d11.dll!D3D11CreateDevice at the hook. The game resolves nothing else from d3d11.
static bool PatchImport(HMODULE module, const char *dll, const char *func, void *hook, void **orig)
{
    BYTE *base = (BYTE *)module;
    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)(base + ((const IMAGE_DOS_HEADER *)base)->e_lfanew);
    const IMAGE_DATA_DIRECTORY &dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress) return false;
    for (const IMAGE_IMPORT_DESCRIPTOR *imp = (const IMAGE_IMPORT_DESCRIPTOR *)(base + dir.VirtualAddress); imp->Name; imp++)
    {
        if (_stricmp((const char *)(base + imp->Name), dll) != 0) continue;
        const IMAGE_THUNK_DATA *names = (const IMAGE_THUNK_DATA *)(base + (imp->OriginalFirstThunk ? imp->OriginalFirstThunk : imp->FirstThunk));
        IMAGE_THUNK_DATA *slots = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);
        for (; names->u1.AddressOfData; names++, slots++)
        {
            if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
            if (strcmp((const char *)((const IMAGE_IMPORT_BY_NAME *)(base + names->u1.AddressOfData))->Name, func) != 0) continue;
            DWORD old;
            if (!VirtualProtect(&slots->u1.Function, sizeof(void *), PAGE_READWRITE, &old)) return false;
            *orig = (void *)slots->u1.Function;
            slots->u1.Function = (ULONGLONG)hook;
            VirtualProtect(&slots->u1.Function, sizeof(void *), old, &old);
            return true;
        }
    }
    return false;
}

static void ReadSettings()
{
    const std::wstring ini = g_dir + L"SnowRunnerShadows.ini";
    wchar_t value[32] = L"2";
    GetPrivateProfileStringW(L"Shadows", L"Factor", L"2", value, 32, ini.c_str());
    const float f = (float)_wtof(value);
    g_factor = f < 1 ? 1 : f > 4 ? 4 : f;
    g_scaling = g_factor > 1;
    g_trace = GetPrivateProfileIntW(L"Shadows", L"Trace", 0, ini.c_str()) != 0;
    g_slopeBias = GetPrivateProfileIntW(L"Shadows", L"SlopeBias", 1, ini.c_str()) != 0;
    g_feed = GetPrivateProfileIntW(L"Shadows", L"Feed", 1, ini.c_str()) != 0;
    g_gi = g_feed && GetPrivateProfileIntW(L"Shadows", L"GI", 1, ini.c_str()) != 0;
    g_feedMips = GetPrivateProfileIntW(L"Shadows", L"FeedMips", 1, ini.c_str()) != 0;
    const UINT frameLog = GetPrivateProfileIntW(L"Shadows", L"FrameLog", 0, ini.c_str());
    g_frameLog = frameLog > 600 ? 600 : frameLog;
    const UINT gpuTimers = GetPrivateProfileIntW(L"Shadows", L"GpuTimers", 0, ini.c_str());
    g_gpuTimers = gpuTimers > 600 ? 600 : gpuTimers;
    const UINT gpuProfile = GetPrivateProfileIntW(L"Shadows", L"GpuProfile", 0, ini.c_str());
    g_gpuProfile = gpuProfile > 600 ? 600 : gpuProfile;
    g_gpuProfileShaders = GetPrivateProfileIntW(L"Shadows", L"GpuProfileShaders", 0, ini.c_str()) != 0;
    const UINT cpuProfile = GetPrivateProfileIntW(L"Shadows", L"CpuProfile", 0, ini.c_str());
    g_cpuProfile = cpuProfile > 600 ? 600 : cpuProfile;
    const UINT cpuThreads = GetPrivateProfileIntW(L"Shadows", L"CpuThreads", 0, ini.c_str());
    g_cpuThreads = cpuThreads > 600 ? 600 : cpuThreads;
    const UINT memLog = GetPrivateProfileIntW(L"Shadows", L"MemLog", 0, ini.c_str());
    g_memLog = memLog > 600 ? 600 : memLog;
    // reflections: the switches and the knobs (clamped to sane ranges)
    g_ssr = g_feed && GetPrivateProfileIntW(L"Shadows", L"SSR", 1, ini.c_str()) != 0;
    g_ssrHalf = GetPrivateProfileIntW(L"Shadows", L"SSRHalf", 1, ini.c_str()) != 0;
    g_ssrMirror = GetPrivateProfileIntW(L"Shadows", L"SSRMirror", 0, ini.c_str()) != 0;
    const UINT depthProbe = GetPrivateProfileIntW(L"Shadows", L"DepthProbe", 0, ini.c_str());
    g_depthProbe = depthProbe > 3600 ? 3600 : depthProbe;
    g_ssrProbe = GetPrivateProfileIntW(L"Shadows", L"SSRProbe", 1, ini.c_str()) != 0;
    g_ssrLobe = GetPrivateProfileIntW(L"Shadows", L"SSRLobe", 0, ini.c_str()) != 0;
    const UINT steps = GetPrivateProfileIntW(L"Shadows", L"SSRSteps", 80, ini.c_str());
    g_ssrSteps = steps < 8 ? 8 : steps > 512 ? 512 : steps;
    auto knob = [&](const wchar_t *key, float def, float lo, float hi) {
        wchar_t text[32];
        swprintf_s(text, L"%g", def);
        GetPrivateProfileStringW(L"Shadows", key, text, text, 32, ini.c_str());
        const float v = (float)_wtof(text);
        return v < lo ? lo : v > hi ? hi : v;
    };
    // the AO pass at half size: the state at start, the blur, the depth tolerance, the key
    g_aoHalfOn = GetPrivateProfileIntW(L"Shadows", L"AOHalf", 1, ini.c_str()) != 0; // on by default
    g_aoHalfBlur = GetPrivateProfileIntW(L"Shadows", L"AOHalfBlur", 1, ini.c_str()) != 0;
    g_aoHalfTol = knob(L"AOHalfDepthTol", 0.02f, 0.001f, 0.5f);
    g_zMips = GetPrivateProfileIntW(L"Shadows", L"ZMips", 1, ini.c_str()) != 0;
    g_fogRefl = GetPrivateProfileIntW(L"Shadows", L"FogReflections", 1, ini.c_str()) != 0;
    g_texBaseRule = GetPrivateProfileIntW(L"Shadows", L"TextureBaseRule", 1, ini.c_str()) != 0;
    g_crashLog = GetPrivateProfileIntW(L"Shadows", L"CrashLog", 0, ini.c_str()) != 0;
    g_keyAOHalf = GetPrivateProfileIntW(L"Shadows", L"KeyAOHalf", VK_F5, ini.c_str());
    g_ssrRoughMax = knob(L"SSRRoughMax", 0.85f, 0.05f, 1.0f);
    g_ssrThickness = knob(L"SSRThickness", 0.3f, 0.01f, 10.0f);
    g_ssrTemporal = knob(L"SSRTemporal", 0.9f, 0.0f, 0.98f);
    g_ssrCone = knob(L"SSRCone", 0.5f, 0.0f, 8.0f);
    g_ssrUnder = knob(L"SSRUnder", 2.5f, 0.0f, 20.0f);
    g_ssrUnderShade = knob(L"SSRUnderShade", 0.5f, 0.0f, 1.0f);
    g_ssrUnderNear = knob(L"SSRUnderNear", 25.0f, 0.0f, 3000.0f);
    g_ssrUnderFar = knob(L"SSRUnderFar", 50.0f, g_ssrUnderNear, 3500.0f);
    // contact shadows: the switch (nothing happens without shader.pak's module contact: no shader writes output 6), the
    // debug views, the composite's strength, the pass's knobs (src\sss), the key and the state at start
    g_contact = g_feed && GetPrivateProfileIntW(L"Shadows", L"Contact", 1, ini.c_str()) != 0;
    const UINT contactDebug = GetPrivateProfileIntW(L"Shadows", L"ContactDebug", 0, ini.c_str());
    g_contactDebug = contactDebug > 2 ? 0 : contactDebug;
    g_contactStrength = knob(L"ContactStrength", 1.0f, 0.0f, 1.0f);
    g_contactThickness = knob(L"ContactThickness", 0.005f, 0.0001f, 1.0f);
    g_contactContrast = knob(L"ContactContrast", 4.0f, 0.0f, 32.0f);
    g_contactBilinear = knob(L"ContactBilinear", 0.02f, 0.0f, 1.0f);
    g_contactMaxDepth = knob(L"ContactMaxDepth", 50.0f, 1.0f, 3500.0f);
    g_contactFadeStart = knob(L"ContactFadeStart", 30.0f, 0.0f, g_contactMaxDepth);
    g_contactSky = knob(L"ContactSky", 3000.0f, 100.0f, 100000.0f);
    g_keyContact = GetPrivateProfileIntW(L"Shadows", L"KeyContact", VK_F4, ini.c_str());
    g_contactOn = GetPrivateProfileIntW(L"Shadows", L"ContactOn", 1, ini.c_str()) != 0;
    // dev switches: keys and the states at start
    g_keyStock = GetPrivateProfileIntW(L"Shadows", L"KeyStock", VK_F8, ini.c_str());
    g_keyPuddles = GetPrivateProfileIntW(L"Shadows", L"KeyPuddles", VK_F9, ini.c_str());
    g_keyBounce = GetPrivateProfileIntW(L"Shadows", L"KeyBounce", VK_F10, ini.c_str());
    g_keyAO = GetPrivateProfileIntW(L"Shadows", L"KeyAO", VK_F11, ini.c_str());
    g_stockAll = GetPrivateProfileIntW(L"Shadows", L"StockAll", 0, ini.c_str()) != 0;
    g_puddlesOn = GetPrivateProfileIntW(L"Shadows", L"PuddlesOn", 1, ini.c_str()) != 0;
    g_bounceOn = GetPrivateProfileIntW(L"Shadows", L"BounceOn", 1, ini.c_str()) != 0;
    g_stockAO = GetPrivateProfileIntW(L"Shadows", L"StockAO", 0, ini.c_str()) != 0;
    g_keySSR = GetPrivateProfileIntW(L"Shadows", L"KeySSR", VK_F6, ini.c_str());
    g_ssrOn = GetPrivateProfileIntW(L"Shadows", L"SSROn", 1, ini.c_str()) != 0;
    // dump: the key, the timer (seconds after the AO pass first runs, 0 = none), the folder (default this DLL's; a relative one is under it)
    g_keyDump = GetPrivateProfileIntW(L"Shadows", L"KeyDump", VK_F7, ini.c_str());
    GetPrivateProfileStringW(L"Shadows", L"DumpAfter", L"0", value, 32, ini.c_str());
    g_dumpAfter = (float)_wtof(value);
    wchar_t dir[MAX_PATH] = {};
    GetPrivateProfileStringW(L"Shadows", L"DumpDir", L"", dir, MAX_PATH, ini.c_str());
    g_dumpDir = dir;
    if (!g_dumpDir.empty() && g_dumpDir.back() != L'\\' && g_dumpDir.back() != L'/') g_dumpDir += L'\\';
    if (g_dumpDir.empty()) g_dumpDir = g_dir;
    else if (!(g_dumpDir.size() > 1 && (g_dumpDir[1] == L':' || g_dumpDir[0] == L'\\'))) g_dumpDir = g_dir + g_dumpDir;
    if (g_scaling && GetFileAttributesW((g_dir + L"ShadowScale.addon64").c_str()) != INVALID_FILE_ATTRIBUTES)
    {
        g_scaling = false;
        Log("ShadowScale.addon64 is in this folder: the ReShade add-on does the scaling, this DLL only forwards hid.dll");
    }
}

BOOL WINAPI DllMain(HINSTANCE self, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        DisableThreadLibraryCalls(self);
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(self, path, MAX_PATH);
        g_dir = path;
        g_dir.resize(g_dir.find_last_of(L'\\') + 1);
        g_log = _wfsopen((g_dir + L"SnowRunnerShadows.log").c_str(), L"w", _SH_DENYWR); // others may read it while the game runs
        Log("SnowRunner Shadows loaded as %ls", path);
        LoadRealHid();
        ReadSettings();
        if (g_crashLog)
        {
            AddVectoredExceptionHandler(1, CrashVeh);
            Log("crash log: on (ini CrashLog=1): the first 20 access violations, stack overflows, illegal instructions and fail-fasts, with stacks");
        }
        if (g_texBaseRule) TextureBaseRule();
        else Log("texture base rule: off (ini TextureBaseRule=0), the game's own");
        LoadTwins();
        if (g_trace)
        {
            _wfopen_s(&g_traceFile, (g_dir + L"SnowRunnerShadows.trace.log").c_str(), L"w");
            Log("trace on: SnowRunnerShadows.trace.log, bursts of %llu ms every %llu s", kBurstLength, kBurstEvery / 1000);
        }
        if (g_scaling || g_feed || g_twinCount || g_gpuProfile)
        {
            const bool ok = PatchImport(GetModuleHandleW(nullptr), "d3d11.dll", "D3D11CreateDevice", (void *)&Hook_D3D11CreateDevice, (void **)&g_realCreateDevice);
            Log("factor %g%s, slope bias %s, scene feed %s, bounce light %s; D3D11CreateDevice import %s", g_factor, g_scaling ? "" : " (not scaling)",
                g_slopeBias ? "scaled with it" : "as the game sets it", g_feed ? "on" : "off", g_gi ? "on" : "off", ok ? "hooked" : "NOT FOUND, nothing will be done");
            if (g_ssr)
                Log("reflections: on (a ray per %s, %s, roughness up to %g, thickness %g m, history %g, cone %g, %u steps; waits for shaders writing output 7 and reading t123)%s%s",
                    g_ssrHalf ? "2 x 2 block" : "pixel", g_ssrLobe ? "rays from the GGX lobe" : "mirror rays blurred by roughness", g_ssrRoughMax, g_ssrThickness, g_ssrTemporal, g_ssrCone,
                    g_ssrSteps, g_ssrMirror ? "; SSRMirror (debug): every pixel a mirror" : "",
                    g_ssrProbe ? "; probe 20 s after the AO pass first runs" : "");
            else Log("reflections: off");
            if (g_ssr && g_ssrUnder > 0)
                Log("reflections: a ray within %g m (+ 5 %% of the depth) behind a surface went under that object: its colour x %g, in full to %g m, none from %g m",
                    g_ssrUnder, g_ssrUnderShade, g_ssrUnderNear, g_ssrUnderFar);
            else if (g_ssr) Log("reflections: SSRUnder=0: a ray deeper behind a surface than the thickness reflects nothing (the material's cubemap)");
            if (g_contact)
                Log("contact shadows: on (strength %g, thickness %g, contrast %g, bilinear %g, fading out from %g to %g m, sky from %g m%s; waits for shaders writing output 6)",
                    g_contactStrength, g_contactThickness, g_contactContrast, g_contactBilinear, g_contactFadeStart, g_contactMaxDepth, g_contactSky,
                    g_contactDebug == 1 ? "; ContactDebug 1: the mask alone darkens everything" : g_contactDebug == 2 ? "; ContactDebug 2: the sun share as darkness" : "");
            else Log("contact shadows: off");
            if (g_gi)
            {
                char k[16];
                KeyName(g_keyAOHalf, k, sizeof k);
                Log("AO pass at half size: %s at start (%s flips it), %s, depth tolerance %g", g_aoHalfOn ? "on" : "off", k,
                    g_aoHalfBlur ? "blurred 3 x 3 at half size before the upsample" : "upsampled as drawn", g_aoHalfTol);
            }
            if (g_feed) Log("AO depth mips at t126: %s", g_zMips ? "on (for an AO pass that declares t126)" : "off (ini ZMips=0: the AO pass reads t80 alone)");
        }
        if (g_memLog)
        {
            // the game's VirtualAlloc import, watched (the memory log); its image's range for the call chains
            HMODULE exe = GetModuleHandleW(nullptr);
            const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)((BYTE *)exe + ((const IMAGE_DOS_HEADER *)exe)->e_lfanew);
            g_exeBase = (uintptr_t)exe;
            g_exeEnd = g_exeBase + nt->OptionalHeader.SizeOfImage;
            const bool ok = PatchImport(exe, "kernel32.dll", "VirtualAlloc", (void *)&Hook_VirtualAlloc, (void **)&g_realVirtualAlloc);
            Log("memory log: reserves of 16 MB or more and failures, a line of each region's commits every %u s; VirtualAlloc import %s", g_memLog, ok ? "hooked" : "NOT FOUND, no memory log");
        }
        if (g_frameLog || g_gpuTimers || g_gpuProfile || g_cpuProfile || g_cpuThreads || g_memLog || g_depthProbe)
        {
            QueryPerformanceFrequency(&g_frameFreq);
            const bool ok = PatchImport(GetModuleHandleW(nullptr), "dxgi.dll", "CreateDXGIFactory1", (void *)&Hook_CreateDXGIFactory1, (void **)&g_realCreateFactory1);
            if (g_frameLog) Log("frame timer: a line every %u s; CreateDXGIFactory1 import %s", g_frameLog, ok ? "hooked" : "NOT FOUND, no frame timer");
            if (g_gpuTimers) Log("GPU timers: a line every %u s (AO pass, AO apply, AO upsample, shadow maps, lit pass, scene feed copy, water); CreateDXGIFactory1 import %s", g_gpuTimers, ok ? "hooked" : "NOT FOUND, no GPU timers");
            if (g_gpuProfile) Log("pass profile: a list every %u s (every pass's GPU time per frame%s); CreateDXGIFactory1 import %s", g_gpuProfile,
                g_gpuProfileShaders ? ", split by pixel shader" : "", ok ? "hooked" : "NOT FOUND, no pass profile");
            if (g_cpuProfile) Log("CPU profile: a line every %u s (the CPU time in this DLL's context hooks); CreateDXGIFactory1 import %s", g_cpuProfile, ok ? "hooked" : "NOT FOUND, no CPU profile");
            if (g_cpuThreads) Log("thread load: a line every %u s (each thread's CPU time per frame); CreateDXGIFactory1 import %s", g_cpuThreads, ok ? "hooked" : "NOT FOUND, no thread load");
            if (g_depthProbe) Log("depth probe: one frame's scene depth before the lit pass and at the AO pass, %s%s; CreateDXGIFactory1 import %s",
                g_depthProbe > 1 ? "at its own time after the AO pass first runs" : "in the probe's first recording", g_ssr && g_ssrProbe ? "" : " (NONE: it needs SSR=1 and SSRProbe=1)", ok ? "hooked" : "NOT FOUND, no depth probe");
        }
    }
    else if (reason == DLL_PROCESS_DETACH)
    {
        Log("shadow texture binds %llu, viewport restores %llu, state resets %llu, rasterizer states seen with it %d (with slope bias %d)",
            (unsigned long long)g_atlasBinds.load(), (unsigned long long)g_restores.load(), (unsigned long long)g_resets.load(),
            (int)g_rsScaled.size(), g_rsCopies.load());
        if (g_feed)
            Log("scene feed: copies %llu, binds %llu, shaders that read it %llu", (unsigned long long)g_feedCaptures.load(), (unsigned long long)g_feedBinds.load(),
                (unsigned long long)g_feedReaders.load());
        if (g_fogRefl)
            Log("fog for the water's reflections: composite draws captured %llu, water binds %llu", (unsigned long long)g_fogCaptures.load(), (unsigned long long)g_fogBinds.load());
        if (g_gi)
            Log("bounce light: written %llu times, binds %llu, shaders that read it %llu", (unsigned long long)g_giWrites.load(), (unsigned long long)g_giBinds.load(),
                (unsigned long long)g_giReaders.load());
        if (g_gi && g_aoHalfPasses.load())
            Log("AO at half size: %llu passes, %llu upsamples", (unsigned long long)g_aoHalfPasses.load(), (unsigned long long)g_aoHalfUpsamples.load());
        if (g_zMipsBuilds.load()) Log("AO depth mips: made %llu times", (unsigned long long)g_zMipsBuilds.load());
        if (g_twinCount)
            Log("stock twins: %u made, %u could not be made; switches at exit: effects %s, puddles %s, bounce light %s, AO %s", g_twinsMade.load(), g_twinsFailed.load(),
                g_stockAll ? "stock" : "on", g_puddlesOn ? "on" : "off", g_bounceOn ? "on" : "off", g_stockAO ? "the game's own" : "GTAO");
        if (g_ssr)
        {
            Log("reflections: shaders writing output 7 %llu, reading t123 %llu; render target 7 binds %llu, passes %llu, t124 decodes %llu, binds %llu; switch at exit %s",
                (unsigned long long)g_o7Writers.load(), (unsigned long long)g_ssrReaders.load(), (unsigned long long)g_rt7Binds.load(), (unsigned long long)g_ssrRuns.load(),
                (unsigned long long)g_motionRuns.load(), (unsigned long long)g_ssrBinds.load(), g_ssrOn ? "on" : "off");
            if (g_ssrGpuAllN) Log("reflections: GPU time of the pass %.3f ms on average over %llu timed passes", g_ssrGpuAll / g_ssrGpuAllN, (unsigned long long)g_ssrGpuAllN);
        }
        if (g_contact)
            Log("contact shadows: shaders writing output 6 %llu; render target 6 binds %llu, passes %llu; switch at exit %s", (unsigned long long)g_o6Writers.load(),
                (unsigned long long)g_rt6Binds.load(), (unsigned long long)g_contactRuns.load(), g_contactOn ? "on" : "off");
        if (g_dumpsDone) Log("dumps written: %d", g_dumpsDone);
        if (g_gpuTimers && g_gpuAllFrames)
        {
            char line[640];
            int at = snprintf(line, sizeof line, "GPU timers: per frame over %llu frames:", (unsigned long long)g_gpuAllFrames);
            for (int k = 0; k < kGpuSections && at > 0 && at < (int)sizeof line; k++)
                at += snprintf(line + at, sizeof line - at, "%s %s %.3f ms (%llu of %llu timings answered)", k ? "," : "", kGpuNames[k], g_gpuAll[k] / g_gpuAllFrames,
                    (unsigned long long)g_gpuAnswered[k], (unsigned long long)g_gpuIssued[k]);
            Log("%s; timings without an answer %llu", line, (unsigned long long)g_gpuDropped);
        }
        if (g_gpuProfile)
        {
            std::lock_guard<std::mutex> lock(g_profLock);
            ProfList(true);
            Log("pass profile: passes untimed because every timer was busy %llu, timings without an answer %llu", (unsigned long long)g_profFull, (unsigned long long)g_profDropped);
        }
        if (g_trace)
        {
            Log("trace: draws into the shadow texture %llu (indirect or auto %llu), viewport mismatches %llu, scissor mismatches %llu, draws into it not seen bound %llu, "
                "copies seen %llu, clears of it %llu, command lists %u, bursts %d",
                (unsigned long long)g_drawsBound.load(), (unsigned long long)g_indirect.load(), (unsigned long long)g_viewportMismatch.load(),
                (unsigned long long)g_scissorMismatch.load(), (unsigned long long)g_untracked.load(), (unsigned long long)g_copiesSeen.load(),
                (unsigned long long)g_clearsSeen.load(), g_listIds.load(), g_bursts);
            std::lock_guard<std::mutex> lock(g_traceLock);
            if (g_traceFile) { fclose(g_traceFile); g_traceFile = nullptr; }
        }
        std::lock_guard<std::mutex> lock(g_logLock);
        if (g_log) { fclose(g_log); g_log = nullptr; }
    }
    return TRUE;
}
