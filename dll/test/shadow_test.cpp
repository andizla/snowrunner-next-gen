// Offline test for SnowRunner Shadows. Imports hid.dll and d3d11.dll the way the game does, so the loader picks up
// out\hid.dll from this program's folder and the DLL hooks this program's D3D11CreateDevice import. Runs on a WARP
// device. Exit code 0 = every check passed.
//   shadow_test            expects scaling (factor from SnowRunnerShadows.ini, default 2)
//   shadow_test off        expects no scaling (factor 1, or ShadowScale.addon64 next to the DLL)
//   ... hw                 on the GPU instead of WARP (ReShade only wraps hardware devices)
//   ... double             also makes a second, unwrapped (WARP) device, as the game does: with ReShade present this
//                          hooks the runtime's device class under ReShade's wrappers (the case the layer guard covers)
//   ... nofeed             expects no scene feed (ini Feed=0), so no bounce light either
//   ... nogi               expects the scene feed but no bounce light (ini GI=0)
//   ... puddlesoff         dev switch F9 off at start (ini PuddlesOn=0): feed readers get the depth but no scene colour
//   ... nomips             expects the colour copy with one mip level (ini FeedMips=0) instead of a full chain
//   ... bounceoff          dev switch F10 off at start (ini BounceOn=0): no bounce light, as with nogi
//   ... aohalf             with ini AOHalf=1: the bounce-light checks with the AO pass drawn at half size (an R8 AO target,
//                          as the game's), plus the half-size target, the full-size result at t1, the game's viewport and t1 back
//   shadow_test aohalfodd  the AO pass at half size on a 65 x 37 target (see AOHalfOddTest): the last column and row too
//   shadow_test maketable  writes SnowRunnerShadows.stock (the stock twins table) from this test's own shaders, then exits
//   ... twins [stockall|stockao]   with that table next to the DLL: the dev switches F8 (ini StockAll=1) and F11 (ini
//                          StockAO=1) at start: a changed shader draws with its original exactly when its group is stock
//   ... dump [immediate]   with ini DumpAfter=1: the AO pass a second after the first one is saved to SnowRunnerShadows_dump_*
//                          next to this program (recorded on a deferred context, or with `immediate` on the immediate
//                          one), and the files are read back and checked; older dump files here are deleted first
//   shadow_test ssr [rough] the reflections lab alone (see SsrLab): a mirror floor (or roughness 0.3) and a wall through the
//                          DLL's pass, checked against a CPU ray cast; SSRHalf from the ini as usual
//   shadow_test ssrreplay <dump folder> [hw]   the pass on a frame the DLL dumped in game (see SsrReplay); with ini
//                          SSRMirror=1 and DumpAfter=0.1 the DLL's own dump of it lands next to this program
//   shadow_test frames     the frame timer (ini FrameLog=1): a factory from CreateDXGIFactory1, a swap chain made through
//                          it on a hidden window, 2.6 s of Present; the DLL's log must carry frames lines at that rate
//   shadow_test noframes   the same without FrameLog: no frame timer, the factory and swap chain untouched
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <share.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>
#include <vector>
#include <algorithm>

extern "C" void __stdcall HidD_GetHidGuid(GUID *guid); // hidsdi.h, declared here to keep the SDK's hid headers out

static int g_failures = 0;
static void Check(bool ok, const char *what)
{
    printf("%s  %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) g_failures++;
}

struct Rig
{
    ID3D11Device *dev = nullptr;
    ID3D11DeviceContext *ctx = nullptr;
    ID3D11VertexShader *vs = nullptr;
    ID3D11RasterizerState *rs = nullptr;
    ID3D11DepthStencilState *ds = nullptr;
};

// a full screen triangle at depth 0.25, no pixel shader: depth only, like a shadow pass
static const char *kVS = "float4 main(uint id : SV_VertexID) : SV_Position { float2 t = float2((id << 1) & 2, id & 2); return float4(t * float2(2, -2) + float2(-1, 1), 0.25, 1); }";
// the same triangle with depth 0 at the left edge of the viewport and 0.5 at the right: a slope for the depth bias
static const char *kVSSlope = "float4 main(uint id : SV_VertexID) : SV_Position { float2 t = float2((id << 1) & 2, id & 2); float2 p = t * float2(2, -2) + float2(-1, 1); return float4(p, 0.25 + 0.25 * p.x, 1); }";

struct Depth
{
    ID3D11Texture2D *tex = nullptr;
    ID3D11DepthStencilView *dsv = nullptr;
    UINT w = 0, h = 0;
};

static Depth MakeDepth(Rig &r, UINT w, UINT h)
{
    Depth d;
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R32G8X24_TYPELESS;
    td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_DEPTH_STENCIL | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(r.dev->CreateTexture2D(&td, nullptr, &d.tex))) return d;
    D3D11_TEXTURE2D_DESC real; d.tex->GetDesc(&real);
    d.w = real.Width; d.h = real.Height;
    D3D11_DEPTH_STENCIL_VIEW_DESC vd = {};
    vd.Format = DXGI_FORMAT_D32_FLOAT_S8X24_UINT; vd.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
    r.dev->CreateDepthStencilView(d.tex, &vd, &d.dsv);
    return d;
}

static void Draw(Rig &r, ID3D11DeviceContext *c, Depth &d, D3D11_VIEWPORT vp, D3D11_RECT sc, bool viewportFirst)
{
    c->VSSetShader(r.vs, nullptr, 0);
    c->PSSetShader(nullptr, nullptr, 0);
    c->IASetInputLayout(nullptr);
    c->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    c->RSSetState(r.rs);
    c->OMSetDepthStencilState(r.ds, 0);
    if (viewportFirst) { c->RSSetViewports(1, &vp); c->RSSetScissorRects(1, &sc); c->OMSetRenderTargets(0, nullptr, d.dsv); }
    else { c->OMSetRenderTargets(0, nullptr, d.dsv); c->RSSetViewports(1, &vp); c->RSSetScissorRects(1, &sc); }
    c->Draw(3, 0);
}

// depth values at the given texels, read back through a staging copy
static std::vector<float> Read(Rig &r, Depth &d, const std::vector<POINT> &at)
{
    D3D11_TEXTURE2D_DESC td; d.tex->GetDesc(&td);
    td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ID3D11Texture2D *st = nullptr;
    std::vector<float> out(at.size(), -1);
    if (FAILED(r.dev->CreateTexture2D(&td, nullptr, &st))) return out;
    r.ctx->CopyResource(st, d.tex);
    D3D11_MAPPED_SUBRESOURCE m;
    if (SUCCEEDED(r.ctx->Map(st, 0, D3D11_MAP_READ, 0, &m)))
    {
        for (size_t i = 0; i < at.size(); i++) memcpy(&out[i], (const BYTE *)m.pData + at[i].y * m.RowPitch + at[i].x * 8, 4);
        r.ctx->Unmap(st, 0);
    }
    st->Release();
    return out;
}

static uint32_t Crc32(const void *data, size_t size)
{
    static uint32_t table[256];
    if (!table[1]) for (uint32_t i = 0; i < 256; i++) { uint32_t c = i; for (int k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1; table[i] = c; }
    uint32_t c = ~0u;
    for (size_t i = 0; i < size; i++) c = table[(c ^ ((const BYTE *)data)[i]) & 255] ^ (c >> 8);
    return ~c;
}

// dev switches: two changed shaders and their originals (one of them in the AO pass's group), and one the table does
// not know; each returns its own constant colour
static const char *kTwinShaders[5] = {
    "float4 main() : SV_Target { return float4(1, 2, 3, 4); }",     // changed, group 2
    "float4 main() : SV_Target { return float4(5, 6, 7, 8); }",     // its original
    "float4 main() : SV_Target { return float4(9, 10, 11, 12); }",  // changed, the AO pass (group 1)
    "float4 main() : SV_Target { return float4(13, 14, 15, 16); }", // its original
    "float4 main() : SV_Target { return float4(17, 18, 19, 20); }", // not in the table
};
static ID3DBlob *CompilePS(const char *src)
{
    ID3DBlob *b = nullptr;
    if (FAILED(D3DCompile(src, strlen(src), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &b, nullptr))) return nullptr;
    return b;
}
static ID3DBlob *CompileVS(const char *src)
{
    ID3DBlob *b = nullptr;
    if (FAILED(D3DCompile(src, strlen(src), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &b, nullptr))) return nullptr;
    return b;
}
// a changed vertex shader (group 2): the triangle moved off screen, so it draws nothing; its original is kVS
static const char *kTwinVS = "float4 main(uint id : SV_VertexID) : SV_Position { float2 t = float2((id << 1) & 2, id & 2); return float4(t * float2(2, -2) + float2(9, 11), 0.25, 1); }";
// the stock twins table next to this program (and so next to the DLL it loads): the format of the fidelity bundle's
// engine\tools\stock_twins.js
static bool MakeTwinTable()
{
    ID3DBlob *b[6] = {};
    for (int i = 0; i < 4; i++)
    {
        b[i] = CompilePS(kTwinShaders[i]);
        if (!b[i]) return false;
    }
    b[4] = CompileVS(kTwinVS); b[5] = CompileVS(kVS);
    if (!b[4] || !b[5]) return false;
    struct E { uint32_t key, group; ID3DBlob *stock; } e[3] = { { Crc32(b[0]->GetBufferPointer(), b[0]->GetBufferSize()), 2, b[1] },
                                                              { Crc32(b[2]->GetBufferPointer(), b[2]->GetBufferSize()), 1, b[3] },
                                                              { Crc32(b[4]->GetBufferPointer(), b[4]->GetBufferSize()), 2, b[5] } };
    std::sort(e, e + 3, [](const E &x, const E &y) { return x.key < y.key; });
    std::vector<BYTE> file(16 + 3 * 16);
    const uint32_t head[4] = { 0x57545253u /* 'SRTW' */, 1, 3, 0 };
    memcpy(file.data(), head, 16);
    for (int i = 0; i < 3; i++)
    {
        const uint32_t entry[4] = { e[i].key, e[i].group, (uint32_t)file.size(), (uint32_t)e[i].stock->GetBufferSize() };
        memcpy(file.data() + 16 + i * 16, entry, 16);
        const BYTE *p = (const BYTE *)e[i].stock->GetBufferPointer();
        file.insert(file.end(), p, p + e[i].stock->GetBufferSize());
    }
    wchar_t path[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring out = path;
    out.resize(out.find_last_of(L'\\') + 1);
    out += L"SnowRunnerShadows.stock";
    FILE *f = nullptr;
    const bool ok = _wfopen_s(&f, out.c_str(), L"wb") == 0 && f && fwrite(file.data(), 1, file.size(), f) == file.size();
    if (f) fclose(f);
    for (ID3DBlob *x : b) x->Release();
    return ok;
}

// dump (shadow_test dump): the files the DLL wrote next to this program
struct DumpFile { uint32_t kind = 0, w = 0, h = 0, fmt = 0, view = 0, pitch = 0, samples = 0; std::vector<BYTE> data; };
static std::wstring ExeDir()
{
    wchar_t path[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring dir = path;
    dir.resize(dir.find_last_of(L'\\') + 1);
    return dir;
}
// the newest SnowRunnerShadows_dump_*_<suffix> next to this program, or empty
static std::wstring FindDumpFile(const wchar_t *suffix)
{
    WIN32_FIND_DATAW fd = {};
    const std::wstring dir = ExeDir(), pattern = dir + L"SnowRunnerShadows_dump_*_" + suffix;
    HANDLE h = FindFirstFileW(pattern.c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return L"";
    std::wstring best;
    FILETIME bestTime = {};
    do
    {
        if (best.empty() || CompareFileTime(&fd.ftLastWriteTime, &bestTime) > 0) { best = dir + fd.cFileName; bestTime = fd.ftLastWriteTime; }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return best;
}
static void DeleteDumpFiles()
{
    WIN32_FIND_DATAW fd = {};
    const std::wstring dir = ExeDir();
    HANDLE h = FindFirstFileW((dir + L"SnowRunnerShadows_dump_*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return;
    do DeleteFileW((dir + fd.cFileName).c_str()); while (FindNextFileW(h, &fd));
    FindClose(h);
}
// a dump file: the 64-byte header ('SRDP', version 1, kind, width, height, format, view, pitch, size, samples), then the data
static bool ReadDumpFile(const std::wstring &path, DumpFile &d)
{
    FILE *f = nullptr;
    if (path.empty() || _wfopen_s(&f, path.c_str(), L"rb") != 0 || !f) return false;
    BYTE header[64] = {};
    uint32_t words[7] = {};
    uint64_t size = 0;
    bool ok = fread(header, 1, 64, f) == 64 && memcmp(header, "SRDP", 4) == 0;
    if (ok) { memcpy(words, header + 4, sizeof words); memcpy(&size, header + 32, 8); memcpy(&d.samples, header + 40, 4); }
    ok = ok && words[0] == 1 && size < (1u << 30);
    if (ok)
    {
        d.kind = words[1]; d.w = words[2]; d.h = words[3]; d.fmt = words[4]; d.view = words[5]; d.pitch = words[6];
        d.data.resize((size_t)size);
        ok = fread(d.data.data(), 1, d.data.size(), f) == d.data.size();
    }
    fclose(f);
    return ok;
}
static float HalfToFloat(uint16_t h)
{
    const int s = (h >> 15) & 1, e = (h >> 10) & 31, m = h & 1023;
    const float sign = s ? -1.0f : 1.0f;
    if (e == 0) return sign * m * (1.0f / 16777216.0f);
    if (e == 31) return sign * (m ? std::nanf("") : INFINITY);
    return sign * std::ldexp(1.0f + m / 1024.0f, e - 15);
}
static std::string ReadTextFile(const std::wstring &path)
{
    std::string text;
    FILE *f = nullptr;
    if (path.empty() || _wfopen_s(&f, path.c_str(), L"rb") != 0 || !f) return text;
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) text.append(buf, n);
    fclose(f);
    return text;
}

// ---- reflections lab (shadow_test ssr): a synthetic scene through the DLL's pass, checked against a ray cast on the CPU.
// A camera 2 m above a mirror floor (y = 0) looks along +z at a wall 10 m away, 1.2 m high, whose colour runs with height
// (red = y / 1.2, green 0.25, blue = 1 - red); sky above. The lit pass (a full-screen ray cast in a pixel shader) writes
// colour, the normal (x/z at 0.5 n + 0.502, target 1), g_txFactor (target 2) and output 7 (normal x 0.5 + 0.5, roughness);
// a depth pass writes the linear depth; the AO pass (g_txDither, g_txFactor, g_txZ, the camera constants at b1) makes the
// DLL copy the scene and run the pass; a stand-in TAA (PS_EDGE_AA_VELOCITY_TEX at t3) makes it decode t124; readers of
// t123 and t124 draw what they get. Render target 7 appears at the first AO pass, so the checks look at later frames:
// floor pixels that see the wall in the mirror get its colour there, the ones that see the sky beyond it get nothing,
// the wall (rough) and the sky get nothing, and t124 holds the motion the velocity texture encodes.
static const char *kLabCommon =
    "cbuffer Lab : register(b0) { float2 labSize; float tanX, tanY; float floorRough, wallTop, wallZ, pad; };"
    "cbuffer Cam : register(b1) { float4 eye; float4 vdir; float4 vp[4]; float4 view[4]; float4 vpPrev[4]; float4 rest[8]; };"
    "float3 Dir(float2 uv) { return normalize(view[2].xyz + (uv.x * 2 - 1) * tanX * view[0].xyz + (1 - uv.y * 2) * tanY * view[1].xyz); }"
    "bool Hit(float3 o, float3 d, out float t, out float3 n, out float3 c, out float rough) {"
    "  t = 1e30; n = float3(0, 1, 0); c = 0; rough = 1;"
    "  if (d.y < -1e-5) { t = -o.y / d.y; n = float3(0, 1, 0); c = float3(0.2, 0.2, 0.2); rough = floorRough; }"
    "  if (d.z > 1e-5) { const float tw = (wallZ - o.z) / d.z; const float3 p = o + d * tw;"
    "    if (tw > 0 && tw < t && p.y >= 0 && p.y <= wallTop) { t = tw; n = float3(0, 0, -1); c = float3(p.y / wallTop, 0.25, 1 - p.y / wallTop); rough = 1; } }"
    "  return t < 1e29; }";
static const char *kLabLit =
    "struct O { float4 c : SV_Target0; float4 n : SV_Target1; float f : SV_Target2; float4 o7 : SV_Target7; };"
    "O main(float4 pos : SV_Position) { const float3 d = Dir(pos.xy / labSize); float t; float3 n, c; float rough; O o; o.f = 1;"
    "  if (!Hit(eye.xyz, d, t, n, c, rough)) { o.c = float4(0.3, 0.5, 1.0, 1); o.n = float4(0.501961, 0.501961, 0.5, 1); o.o7 = float4(0.5, 1, 0.5, 1); return o; }"
    "  o.c = float4(c, 1); o.n = float4(n.x * 0.5 + 0.501961, n.z * 0.5 + 0.501961, 0.5, 1); o.o7 = float4(n * 0.5 + 0.5, rough); return o; }";
static const char *kLabDepth =
    "float main(float4 pos : SV_Position) : SV_Target { const float3 d = Dir(pos.xy / labSize); float t; float3 n, c; float rough;"
    "  return Hit(eye.xyz, d, t, n, c, rough) ? t * dot(d, view[2].xyz) : 3500.0; }";
static const char *kLabAO = "Texture2D g_txDither : register(t0); Texture2D g_txFactor : register(t2); Texture2D g_txZ : register(t80);"
                            "float4 main(float4 p : SV_Position) : SV_Target { return g_txDither.Load(int3(0, 0, 0)) + g_txFactor.Load(int3(p.xy, 0)) * g_txZ.Load(int3(p.xy, 0)).x; }";
static const char *kLabTAA = "Texture2D PS_EDGE_AA_VELOCITY_TEX : register(t3); float4 main(float4 p : SV_Position) : SV_Target { return PS_EDGE_AA_VELOCITY_TEX.Load(int3(p.xy, 0)); }";
static const char *kLabReader = "Texture2D<float4> g_txRefl : register(t123); Texture2D<float4> g_txMotion : register(t124); cbuffer Pick : register(b2) { uint which; };"
                                "float4 main(float4 p : SV_Position) : SV_Target { uint w, h; if (which) g_txMotion.GetDimensions(w, h); else g_txRefl.GetDimensions(w, h);"
                                " return w ? (which ? g_txMotion.Load(int3(p.xy, 0)) : g_txRefl.Load(int3(p.xy, 0))) : float4(-1, -1, -1, -1); }";

struct LabCam { float eye[3], right[3], up[3], fwd[3], tanX, tanY, nearZ; };
// CB_GLOBAL_CAMERA as the game lays it out (88 floats): eye, view direction with -dot(dir, eye), VP rows, view rows, the
// previous VP rows (the same: a still camera)
static void LabCameraBuffer(const LabCam &c, float *cb)
{
    memset(cb, 0, 88 * sizeof(float));
    auto dot3 = [](const float *a, const float *b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    auto row = [&](int r, const float *axis, float scale) { for (int i = 0; i < 3; i++) cb[r * 4 + i] = axis[i] * scale; cb[r * 4 + 3] = -dot3(axis, c.eye) * scale; };
    for (int i = 0; i < 3; i++) cb[i] = c.eye[i];
    cb[3] = -1;
    row(1, c.fwd, 1);
    row(2, c.right, 1 / c.tanX); row(3, c.up, 1 / c.tanY); cb[4 * 4 + 3] = c.nearZ; row(5, c.fwd, 1);
    row(6, c.right, 1); row(7, c.up, 1); row(8, c.fwd, 1); cb[9 * 4 + 3] = 1;
    for (int i = 0; i < 16; i++) cb[40 + i] = cb[8 + i];
}
// what the floor pixel (px, py) must reflect: the wall's colour there (true), or nothing (false: sky beyond the wall, or not floor)
static bool LabExpected(const LabCam &c, float W, float H, float wallTop, float wallZ, int px, int py, float rgb[3], bool *isFloor)
{
    const float u = (px + 0.5f) / W, v = (py + 0.5f) / H;
    float d[3];
    for (int i = 0; i < 3; i++) d[i] = c.fwd[i] + (u * 2 - 1) * c.tanX * c.right[i] + (1 - v * 2) * c.tanY * c.up[i];
    *isFloor = false;
    if (d[1] >= -1e-5f) return false;
    const float tf = -c.eye[1] / d[1];
    const float tw = d[2] > 1e-5f ? (wallZ - c.eye[2]) / d[2] : 1e30f;
    if (tw < tf && c.eye[1] + d[1] * tw <= wallTop) return false; // the wall is in front
    *isFloor = true;
    const float P[3] = { c.eye[0] + d[0] * tf, 0, c.eye[2] + d[2] * tf };
    const float R[3] = { d[0], -d[1], d[2] };
    if (R[2] <= 1e-5f) return false;
    const float t = (wallZ - P[2]) / R[2], y = R[1] * t;
    if (y < 0 || y > wallTop) return false;
    rgb[0] = y / wallTop; rgb[1] = 0.25f; rgb[2] = 1 - y / wallTop;
    return true;
}

// The rough floor's reference: the share of the pass's lobe (GGX visible normals at alpha = roughness^2, the lobe's core
// u.x < 0.85 as the trace draws them) that meets the wall, and the mean wall colour those rays see, by n random rays
static void LabRoughReference(const LabCam &c, float W, float H, float wallTop, float wallZ, int px, int py, float rough, int n, float *share, float rgb[3])
{
    const float u = (px + 0.5f) / W, v = (py + 0.5f) / H;
    float d[3];
    for (int i = 0; i < 3; i++) d[i] = c.fwd[i] + (u * 2 - 1) * c.tanX * c.right[i] + (1 - v * 2) * c.tanY * c.up[i];
    const float tf = -c.eye[1] / d[1];
    const float P[3] = { c.eye[0] + d[0] * tf, 0, c.eye[2] + d[2] * tf };
    float V[3] = { c.eye[0] - P[0], c.eye[1] - P[1], c.eye[2] - P[2] };
    const float vl = std::sqrt(V[0] * V[0] + V[1] * V[1] + V[2] * V[2]);
    for (float &x : V) x /= vl;
    // tangent frame of the floor's normal as the trace builds it: T = (0, 0, 1), B = (1, 0, 0), N = (0, 1, 0)
    const float ve[3] = { V[2], V[0], V[1] }, alpha = rough * rough;
    uint32_t seed = 12345u + (uint32_t)(px * 7919 + py * 104729);
    auto rnd = [&]() { seed = seed * 1664525u + 1013904223u; return (seed >> 8) * (1.0f / 16777216.0f); };
    int hits = 0;
    double sum[3] = {};
    for (int k = 0; k < n; k++)
    {
        const float u1 = rnd() * 0.85f, u2 = rnd();
        float vh[3] = { alpha * ve[0], alpha * ve[1], ve[2] };
        const float hl = std::sqrt(vh[0] * vh[0] + vh[1] * vh[1] + vh[2] * vh[2]);
        for (float &x : vh) x /= hl;
        const float lensq = vh[0] * vh[0] + vh[1] * vh[1];
        float t1[3] = { 1, 0, 0 };
        if (lensq > 0) { const float il = 1 / std::sqrt(lensq); t1[0] = -vh[1] * il; t1[1] = vh[0] * il; t1[2] = 0; }
        const float t2[3] = { vh[1] * t1[2] - vh[2] * t1[1], vh[2] * t1[0] - vh[0] * t1[2], vh[0] * t1[1] - vh[1] * t1[0] };
        const float r = std::sqrt(u1), phi = 6.2831853f * u2, p1 = r * std::cos(phi), s = 0.5f * (1 + vh[2]);
        const float p2 = (1 - s) * std::sqrt(1 - p1 * p1) + s * r * std::sin(phi), pz = std::sqrt((std::max)(0.0f, 1 - p1 * p1 - p2 * p2));
        float nh[3];
        for (int i = 0; i < 3; i++) nh[i] = p1 * t1[i] + p2 * t2[i] + pz * vh[i];
        float ne[3] = { alpha * nh[0], alpha * nh[1], (std::max)(0.0f, nh[2]) };
        const float nl = std::sqrt(ne[0] * ne[0] + ne[1] * ne[1] + ne[2] * ne[2]);
        for (float &x : ne) x /= nl;
        const float H3[3] = { ne[1], ne[2], ne[0] }; // tangent (x along T = +z, y along B = +x, z along N = +y) -> world
        const float vd = V[0] * H3[0] + V[1] * H3[1] + V[2] * H3[2];
        float R[3] = { 2 * vd * H3[0] - V[0], 2 * vd * H3[1] - V[1], 2 * vd * H3[2] - V[2] };
        if (R[1] < 0.001f) { R[0] = -V[0]; R[1] = V[1]; R[2] = -V[2]; } // into the floor: the mirror direction, as the trace does
        if (R[2] <= 1e-5f) continue;
        const float tw = (wallZ - P[2]) / R[2], y = R[1] * tw;
        if (y < 0 || y > wallTop) continue;
        hits++;
        sum[0] += y / wallTop; sum[1] += 0.25; sum[2] += 1 - y / wallTop;
    }
    *share = (float)hits / n;
    for (int i = 0; i < 3; i++) rgb[i] = hits ? (float)(sum[i] / hits) : 0;
}

static int SsrLab(ID3D11Device *dev, ID3D11DeviceContext *ctx, ID3D11VertexShader *vs, ID3D11RasterizerState *rs, bool rough)
{
    const UINT W = 320, H = 180;
    const float wallTop = 1.2f, wallZ = 10.0f;
    const LabCam cam = { { 0, 2, 0 }, { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 }, 0.4f * W / H, 0.4f, 0.575f };
    auto ps = [&](const char *body, bool common) {
        const std::string src = std::string(common ? kLabCommon : "") + body;
        ID3DBlob *b = nullptr, *e = nullptr;
        ID3D11PixelShader *s = nullptr;
        if (SUCCEEDED(D3DCompile(src.c_str(), src.size(), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &b, &e))) { dev->CreatePixelShader(b->GetBufferPointer(), b->GetBufferSize(), nullptr, &s); b->Release(); }
        else if (e) { printf("lab shader: %s\n", (const char *)e->GetBufferPointer()); e->Release(); }
        return s;
    };
    ID3D11PixelShader *lit = ps(kLabLit, true), *depthPS = ps(kLabDepth, true), *ao = ps(kLabAO, false), *taa = ps(kLabTAA, false), *reader = ps(kLabReader, false);
    struct Target { ID3D11Texture2D *tex = nullptr; ID3D11RenderTargetView *rtv = nullptr; ID3D11ShaderResourceView *srv = nullptr; };
    auto target = [&](DXGI_FORMAT f, const void *init = nullptr, UINT pitch = 0) {
        Target t;
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.Format = f; td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA sd = { init, pitch, 0 };
        dev->CreateTexture2D(&td, init ? &sd : nullptr, &t.tex);
        if (t.tex) { dev->CreateRenderTargetView(t.tex, nullptr, &t.rtv); dev->CreateShaderResourceView(t.tex, nullptr, &t.srv); }
        return t;
    };
    // the velocity texture: (1, 1) = no object everywhere but a 10 x 10 patch that moved (+8, -4) pixels since last frame
    std::vector<uint8_t> vel(W * H * 4, 255);
    auto enc = [](float d) { const float e = (d < 0 ? -1.0f : 1.0f) * std::sqrt(std::fabs(d) / 256.0f); return (uint8_t)std::lround((e * 0.498039f + 0.498039f) * 255.0f); };
    for (UINT y = 20; y < 30; y++) for (UINT x = 20; x < 30; x++) { uint8_t *p = &vel[(y * W + x) * 4]; p[0] = enc(8.0f); p[1] = enc(-4.0f); p[2] = 128; p[3] = 255; }
    Target colour = target(DXGI_FORMAT_R16G16B16A16_FLOAT), normal = target(DXGI_FORMAT_R8G8B8A8_UNORM), factor = target(DXGI_FORMAT_R8_UNORM),
        z = target(DXGI_FORMAT_R32_FLOAT), aoOut = target(DXGI_FORMAT_R8_UNORM), taaOut = target(DXGI_FORMAT_R8G8B8A8_UNORM),
        velocity = target(DXGI_FORMAT_R8G8B8A8_UNORM, vel.data(), W * 4), out = target(DXGI_FORMAT_R32G32B32A32_FLOAT);
    float camData[88], labData[8] = { (float)W, (float)H, cam.tanX, cam.tanY, rough ? 0.3f : 0.0f, wallTop, wallZ, 0 };
    LabCameraBuffer(cam, camData);
    ID3D11Buffer *camCB = nullptr, *labCB = nullptr, *pickCB = nullptr;
    D3D11_BUFFER_DESC bd = { sizeof camData, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    D3D11_SUBRESOURCE_DATA cd = { camData, 0, 0 };
    dev->CreateBuffer(&bd, &cd, &camCB);
    bd.ByteWidth = sizeof labData; cd.pSysMem = labData;
    dev->CreateBuffer(&bd, &cd, &labCB);
    const UINT pick[4] = {};
    bd.ByteWidth = 16; cd.pSysMem = pick;
    dev->CreateBuffer(&bd, &cd, &pickCB);
    const bool made = lit && depthPS && ao && taa && reader && colour.rtv && normal.rtv && factor.srv && z.srv && aoOut.rtv && velocity.srv && out.rtv && camCB && labCB && pickCB;
    Check(made, "reflections lab: shaders, targets and constants made");
    if (!made) return 2;
    const D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    const D3D11_RECT sc = { 0, 0, (LONG)W, (LONG)H };
    auto begin = [&]() {
        ctx->VSSetShader(vs, nullptr, 0); ctx->IASetInputLayout(nullptr); ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx->RSSetState(rs); ctx->OMSetDepthStencilState(nullptr, 0); ctx->RSSetViewports(1, &vp); ctx->RSSetScissorRects(1, &sc);
        ID3D11Buffer *cbs[2] = { labCB, camCB };
        ctx->PSSetConstantBuffers(0, 2, cbs);
    };
    // what the readers see: t123 (which = 0) or t124 (which = 1), every pixel
    auto readAll = [&](UINT which) {
        begin();
        const UINT pickData[4] = { which, 0, 0, 0 };
        ctx->UpdateSubresource(pickCB, 0, nullptr, pickData, 0, 0);
        ctx->PSSetConstantBuffers(2, 1, &pickCB);
        ctx->OMSetRenderTargets(1, &out.rtv, nullptr);
        ctx->PSSetShader(reader, nullptr, 0);
        ctx->Draw(3, 0);
        D3D11_TEXTURE2D_DESC td; out.tex->GetDesc(&td);
        td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ID3D11Texture2D *st = nullptr;
        std::vector<float> v(W * H * 4, -9);
        if (SUCCEEDED(dev->CreateTexture2D(&td, nullptr, &st)))
        {
            ctx->CopyResource(st, out.tex);
            D3D11_MAPPED_SUBRESOURCE m;
            if (SUCCEEDED(ctx->Map(st, 0, D3D11_MAP_READ, 0, &m)))
            {
                for (UINT y = 0; y < H; y++) memcpy(&v[y * W * 4], (const BYTE *)m.pData + y * m.RowPitch, W * 16);
                ctx->Unmap(st, 0);
            }
            st->Release();
        }
        return v;
    };
    auto frame = [&]() {
        begin();
        ID3D11RenderTargetView *mrt[3] = { colour.rtv, normal.rtv, factor.rtv };
        ctx->OMSetRenderTargets(3, mrt, nullptr);
        ctx->PSSetShader(lit, nullptr, 0);
        ctx->Draw(3, 0);
        ctx->OMSetRenderTargets(1, &z.rtv, nullptr);
        ctx->PSSetShader(depthPS, nullptr, 0);
        ctx->Draw(3, 0);
        ctx->OMSetRenderTargets(1, &aoOut.rtv, nullptr);
        ctx->PSSetShaderResources(0, 1, &factor.srv);
        ctx->PSSetShaderResources(2, 1, &factor.srv);
        ctx->PSSetShaderResources(80, 1, &z.srv);
        ctx->PSSetShader(ao, nullptr, 0);
        ctx->Draw(3, 0);
        ID3D11ShaderResourceView *none = nullptr;
        ctx->PSSetShaderResources(80, 1, &none);
        ctx->OMSetRenderTargets(1, &taaOut.rtv, nullptr);
        ctx->PSSetShaderResources(3, 1, &velocity.srv);
        ctx->PSSetShader(taa, nullptr, 0);
        ctx->Draw(3, 0);
        ctx->PSSetShaderResources(3, 1, &none);
    };
    char line[240];
    std::vector<float> v;
    for (int f = 0; f < (rough ? 16 : 8); f++) frame();
    v = readAll(0);
    int otherNonZero = 0, others = 0;
    if (!rough)
    {
        // every floor pixel: the wall's colour where the mirror shows the wall (away from its edges), nothing where it shows sky
        int wallSeen = 0, wallRight = 0, skySeen = 0, skyRight = 0;
        double worst = 0;
        for (UINT y = 0; y < H; y++)
            for (UINT x = 8; x < W - 8; x++)
            {
                float rgb[3];
                bool isFloor = false;
                const bool wall = LabExpected(cam, (float)W, (float)H, wallTop, wallZ, (int)x, (int)y, rgb, &isFloor);
                const float *p = &v[(y * W + x) * 4];
                if (!isFloor) { others++; otherNonZero += p[3] != 0; continue; }
                bool inner = true; // away from the wall's mirrored edges (the rows around expect the same)
                for (int dy = -2; dy <= 2 && inner; dy++) { float q[3]; bool fl; inner = LabExpected(cam, (float)W, (float)H, wallTop, wallZ, (int)x, (int)y + dy, q, &fl) == wall && fl; }
                if (!inner) continue;
                if (wall)
                {
                    wallSeen++;
                    const float a = p[3], r = a > 0 ? p[0] / a : -1, g = a > 0 ? p[1] / a : -1, b = a > 0 ? p[2] / a : -1;
                    const double err = (std::max)(std::fabs(r - rgb[0]), (std::max)(std::fabs(g - rgb[1]), std::fabs(b - rgb[2])));
                    worst = (std::max)(worst, err);
                    wallRight += a > 0.5f && err < 0.1;
                }
                else { skySeen++; skyRight += p[3] < 0.05f; }
            }
        snprintf(line, sizeof line, "reflections lab (mirror floor): %d of %d mirror pixels show the wall's colour there (worst error %.3f)", wallRight, wallSeen, worst);
        Check(wallSeen > 1000 && wallRight >= wallSeen * 98 / 100, line);
        snprintf(line, sizeof line, "reflections lab: %d of %d floor pixels that see the sky beyond the wall have no reflection", skyRight, skySeen);
        Check(skySeen > 500 && skyRight >= skySeen * 98 / 100, line);
    }
    else
    {
        // the rough floor against its lobe (256 random rays per pixel): confidence ~ the share of the lobe that meets the
        // wall, and the colour an average of wall colours (on the line r + b = 1, g = 0.25) close to the lobe's mean
        int floor = 0, shareRight = 0, coloured = 0, onLine = 0, meanRight = 0;
        for (UINT y = 0; y < H; y++)
            for (UINT x = 0; x < W; x++)
            {
                float rgb[3];
                bool isFloor = false;
                LabExpected(cam, (float)W, (float)H, wallTop, wallZ, (int)x, (int)y, rgb, &isFloor);
                const float *p = &v[(y * W + x) * 4];
                if (!isFloor) { others++; otherNonZero += p[3] != 0; continue; }
                if (x < 40 || x >= W - 40 || y >= H - 4) continue; // the lobe's hits leave the screen near its sides
                float share = 0, ref[3] = {};
                LabRoughReference(cam, (float)W, (float)H, wallTop, wallZ, (int)x, (int)y, 0.3f, 256, &share, ref);
                floor++;
                const float a = p[3];
                shareRight += std::fabs(a - share) < 0.25f;
                if (a > 0.15f && share > 0.15f)
                {
                    coloured++;
                    const float r = p[0] / a, g = p[1] / a, b = p[2] / a;
                    const bool line = std::fabs(r + b - 1) < 0.08f && std::fabs(g - 0.25f) < 0.05f;
                    onLine += line;
                    static int shown = 0;
                    if (!line && shown++ < 12) printf("  off the wall's colours at %u,%u: %.3f %.3f %.3f a %.3f (lobe: share %.2f, mean %.3f %.3f %.3f)\n", x, y, r, g, b, a, share, ref[0], ref[1], ref[2]);
                    meanRight += std::fabs(r - ref[0]) < 0.2f;
                }
            }
        snprintf(line, sizeof line, "reflections lab (rough 0.3 floor): %d of %d floor pixels have a confidence within 0.25 of the lobe's share that meets the wall", shareRight, floor);
        Check(floor > 5000 && shareRight >= floor * 85 / 100, line);
        snprintf(line, sizeof line, "reflections lab (rough 0.3 floor): %d of %d reflecting pixels show wall colours only, %d the lobe's mean within 0.2", onLine, coloured, meanRight);
        Check(coloured > 2000 && onLine >= coloured * 95 / 100 && meanRight >= coloured * 85 / 100, line);
    }
    snprintf(line, sizeof line, "reflections lab: wall and sky pixels (not reflective): %d of %d with a reflection", otherNonZero, others);
    Check(others > 1000 && otherNonZero == 0, line);
    // t124: the patch's motion in uv units, flagged; nothing elsewhere
    v = readAll(1);
    const float *m = &v[(25 * W + 25) * 4], *still = &v[(100 * W + 200) * 4];
    snprintf(line, sizeof line, "reflections lab: t124 in the moving patch %.4f %.4f flag %g (want %.4f %.4f 1), elsewhere flag %g", m[0], m[1], m[2], 8.0f / W, -4.0f / H, still[2]);
    Check(std::fabs(m[0] - 8.0f / W) < 0.1f * 8.0f / W && std::fabs(m[1] + 4.0f / H) < 0.1f * 4.0f / H && m[2] == 1 && still[2] == 0 && still[0] == 0, line);
    // t125 (the water's march): a shader that declares it sees the pass's depth pyramid, every level, with
    // 1 / linear depth where there is ground and 0 for the sky
    {
        const char *kHiZReader = "Texture2D<float> g_txHiZ : register(t125);"
                                 "float4 main(float4 p : SV_Position) : SV_Target { uint w, h, levels; g_txHiZ.GetDimensions(0, w, h, levels);"
                                 " return w ? float4(w, h, levels, g_txHiZ.Load(int3(p.xy, 0))) : float4(-1, -1, -1, -1); }";
        ID3D11PixelShader *hizReader = ps(kHiZReader, false);
        std::swap(reader, hizReader);   // readAll draws with `reader`
        v = readAll(0);
        std::swap(reader, hizReader);
        if (hizReader) hizReader->Release();
        const float *bottom = &v[((H - 3) * W + W / 2) * 4], *top = &v[(2 * W + W / 2) * 4];
        snprintf(line, sizeof line, "reflections lab: t125 the depth pyramid, %g x %g with %g levels; 1/depth %.4f at the bottom (ground), %.4f at the top (sky)",
            bottom[0], bottom[1], bottom[2], bottom[3], top[3]);
        Check(bottom[0] == (float)W && bottom[1] == (float)H && bottom[2] >= 2 && bottom[3] > 0 && top[3] == 0, line);
    }
    for (IUnknown *u : { (IUnknown *)lit, (IUnknown *)depthPS, (IUnknown *)ao, (IUnknown *)taa, (IUnknown *)reader, (IUnknown *)camCB, (IUnknown *)labCB, (IUnknown *)pickCB })
        if (u) u->Release();
    for (Target *t : { &colour, &normal, &factor, &z, &aoOut, &taaOut, &velocity, &out })
        for (IUnknown *u : { (IUnknown *)t->tex, (IUnknown *)t->rtv, (IUnknown *)t->srv }) if (u) u->Release();
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// ---- contact shadows lab (shadow_test contact [off]): the reflections lab's scene (a floor, a wall 10 m away,
// 1.2 m high) under a low sun behind the wall (the light travels along (0, -0.3, -1)), so the wall's shadow lies on the
// floor in front of it, from z = 6 m to the wall. The lit pass writes the sun's visibility (1 on the floor and the wall,
// output 6) beside colour, normal, g_txFactor and output 7; the AO pass has the camera at b1 and CB_GLOBAL_SCENE at b2
// (sun colour c48, its direction c49, the sky c50..c52, the PBR multiplier c58.w). Checks on the colour target after the
// AO pass: the contact (the floor within 0.5 m of the wall's foot) darkened, the sunlit floor left alone (the rest of
// the wall's long shadow is the shadow map's: the pass only sees occluders within its thickness, about 0.7 m of floor
// here), none darker than the sun's share allows, the wall (facing away from the sun) and the sky exactly as drawn. With
// ContactOn=0 (off) not one pixel changes. CONTACT_LAB_PPM=<file> writes a picture of the result.
static const char *kContactLit =
    "struct O { float4 c : SV_Target0; float4 n : SV_Target1; float f : SV_Target2; float v : SV_Target6; float4 o7 : SV_Target7; };"
    "O main(float4 pos : SV_Position) { const float3 d = Dir(pos.xy / labSize); float t; float3 n, c; float rough; O o; o.f = 1;"
    "  if (!Hit(eye.xyz, d, t, n, c, rough)) { o.c = float4(0.3, 0.5, 1.0, 1); o.n = float4(0.501961, 0.501961, 0.5, 1); o.o7 = float4(0.5, 1, 0.5, 1); o.v = 0; return o; }"
    "  o.c = float4(c, 1); o.n = float4(n.x * 0.5 + 0.501961, n.z * 0.5 + 0.501961, 0.5, 1); o.o7 = float4(n * 0.5 + 0.5, 1); o.v = 1; return o; }";

static int ContactLab(ID3D11Device *dev, ID3D11DeviceContext *ctx, ID3D11VertexShader *vs, ID3D11RasterizerState *rs, bool expectOff)
{
    // at 1920 x 1080: the pass's edge test and thickness are shares of the depth, so a floor seen this low needs rows as
    // fine as the game's (at 320 x 180 neighbouring rows differ by more than the edge threshold and the floor shadows itself)
    const UINT W = 1920, H = 1080;
    const float wallTop = 1.2f, wallZ = 10.0f;
    const LabCam cam = { { 0, 2, 0 }, { 1, 0, 0 }, { 0, 1, 0 }, { 0, 0, 1 }, 0.4f * W / H, 0.4f, 0.575f };
    const float travel[3] = { 0.0f, -0.3f / std::sqrt(1.09f), -1.0f / std::sqrt(1.09f) };   // the way the light travels
    const float sunLum = 4.0f, skyLum = 0.5f;
    auto ps = [&](const char *body, bool common) {
        const std::string src = std::string(common ? kLabCommon : "") + body;
        ID3DBlob *b = nullptr, *e = nullptr;
        ID3D11PixelShader *s = nullptr;
        if (SUCCEEDED(D3DCompile(src.c_str(), src.size(), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &b, &e))) { dev->CreatePixelShader(b->GetBufferPointer(), b->GetBufferSize(), nullptr, &s); b->Release(); }
        else if (e) { printf("lab shader: %s\n", (const char *)e->GetBufferPointer()); e->Release(); }
        return s;
    };
    ID3D11PixelShader *lit = ps(kContactLit, true), *depthPS = ps(kLabDepth, true), *ao = ps(kLabAO, false);
    struct Target { ID3D11Texture2D *tex = nullptr; ID3D11RenderTargetView *rtv = nullptr; ID3D11ShaderResourceView *srv = nullptr; };
    auto target = [&](DXGI_FORMAT f) {
        Target t;
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.Format = f; td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        dev->CreateTexture2D(&td, nullptr, &t.tex);
        if (t.tex) { dev->CreateRenderTargetView(t.tex, nullptr, &t.rtv); dev->CreateShaderResourceView(t.tex, nullptr, &t.srv); }
        return t;
    };
    Target colour = target(DXGI_FORMAT_R16G16B16A16_FLOAT), normal = target(DXGI_FORMAT_R8G8B8A8_UNORM), factor = target(DXGI_FORMAT_R8_UNORM),
        z = target(DXGI_FORMAT_R32_FLOAT), aoOut = target(DXGI_FORMAT_R8_UNORM);
    float camData[88], labData[8] = { (float)W, (float)H, cam.tanX, cam.tanY, 1.0f, wallTop, wallZ, 0 }, scene[352] = {};
    LabCameraBuffer(cam, camData);
    for (int i = 0; i < 3; i++) { scene[48 * 4 + i] = sunLum; scene[49 * 4 + i] = travel[i]; scene[50 * 4 + i] = skyLum; scene[51 * 4 + i] = skyLum; scene[52 * 4 + i] = skyLum; }
    scene[58 * 4 + 3] = 1.0f;
    ID3D11Buffer *camCB = nullptr, *labCB = nullptr, *sceneCB = nullptr;
    D3D11_BUFFER_DESC bd = { sizeof camData, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    D3D11_SUBRESOURCE_DATA cd = { camData, 0, 0 };
    dev->CreateBuffer(&bd, &cd, &camCB);
    bd.ByteWidth = sizeof labData; cd.pSysMem = labData;
    dev->CreateBuffer(&bd, &cd, &labCB);
    bd.ByteWidth = sizeof scene; cd.pSysMem = scene;
    dev->CreateBuffer(&bd, &cd, &sceneCB);
    const bool made = lit && depthPS && ao && colour.rtv && normal.rtv && factor.srv && z.srv && aoOut.rtv && camCB && labCB && sceneCB;
    Check(made, "contact lab: shaders, targets and constants made");
    if (!made) return 2;
    const D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    const D3D11_RECT sc = { 0, 0, (LONG)W, (LONG)H };
    // the lit pass's blend state as the game has it: target 6 unwritten (mask 0). The DLL puts a plain copy in its
    // place for the pass, with the bounce light and the reflections off too (ini GI=0 SSR=0), or nothing reaches target 6
    D3D11_BLEND_DESC gameBlendDesc = {};
    gameBlendDesc.IndependentBlendEnable = TRUE;
    for (auto &t : gameBlendDesc.RenderTarget) t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    gameBlendDesc.RenderTarget[6].RenderTargetWriteMask = 0;
    ID3D11BlendState *gameBlend = nullptr;
    dev->CreateBlendState(&gameBlendDesc, &gameBlend);
    auto frame = [&]() {
        ctx->VSSetShader(vs, nullptr, 0); ctx->IASetInputLayout(nullptr); ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ctx->RSSetState(rs); ctx->OMSetDepthStencilState(nullptr, 0); ctx->RSSetViewports(1, &vp); ctx->RSSetScissorRects(1, &sc);
        ID3D11Buffer *cbs[3] = { labCB, camCB, sceneCB };
        ctx->PSSetConstantBuffers(0, 3, cbs);
        ID3D11RenderTargetView *mrt[3] = { colour.rtv, normal.rtv, factor.rtv };
        ctx->OMSetBlendState(gameBlend, nullptr, 0xffffffff);
        ctx->OMSetRenderTargets(3, mrt, nullptr);
        ctx->PSSetShader(lit, nullptr, 0);
        ctx->Draw(3, 0);
        ctx->OMSetRenderTargets(1, &z.rtv, nullptr);
        ctx->OMSetBlendState(nullptr, nullptr, 0xffffffff);
        ctx->PSSetShader(depthPS, nullptr, 0);
        ctx->Draw(3, 0);
        ctx->OMSetRenderTargets(1, &aoOut.rtv, nullptr);
        ctx->PSSetShaderResources(0, 1, &factor.srv);
        ctx->PSSetShaderResources(2, 1, &factor.srv);
        ctx->PSSetShaderResources(80, 1, &z.srv);
        ctx->PSSetShader(ao, nullptr, 0);
        ctx->Draw(3, 0);
        ID3D11ShaderResourceView *none = nullptr;
        ctx->PSSetShaderResources(80, 1, &none);
    };
    for (int f = 0; f < 6; f++) frame();
    // the colour target after the last AO pass (half floats)
    std::vector<float> c(W * H * 4, -9);
    {
        D3D11_TEXTURE2D_DESC td; colour.tex->GetDesc(&td);
        td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ID3D11Texture2D *st = nullptr;
        if (SUCCEEDED(dev->CreateTexture2D(&td, nullptr, &st)))
        {
            ctx->CopyResource(st, colour.tex);
            D3D11_MAPPED_SUBRESOURCE m;
            if (SUCCEEDED(ctx->Map(st, 0, D3D11_MAP_READ, 0, &m)))
            {
                for (UINT y = 0; y < H; y++)
                    for (UINT x = 0; x < W * 4; x++) c[y * W * 4 + x] = HalfToFloat(((const uint16_t *)((const BYTE *)m.pData + y * m.RowPitch))[x]);
                ctx->Unmap(st, 0);
            }
            st->Release();
        }
    }
    // per pixel: what the lit pass drew there, and whether the wall really shadows it (the floor point's ray to the sun
    // meets the wall); the darkest the composite may make a floor pixel: 1 - its sun share
    const float toSun[3] = { -travel[0], -travel[1], -travel[2] };
    const float floorSun = sunLum * toSun[1], darkest = 1.0f - floorSun / (floorSun + skyLum);
    int floorLit = 0, floorLitChanged = 0, shadowNear = 0, shadowNearFound = 0, darkened = 0, overDark = 0, other = 0, otherChanged = 0, changed = 0;
    float minK = 2;
    for (UINT y = 0; y < H; y++)
        for (UINT x = 0; x < W; x++)
        {
            const float u = (x + 0.5f) / W, v = (y + 0.5f) / H;
            float d[3];
            for (int i = 0; i < 3; i++) d[i] = cam.fwd[i] + (u * 2 - 1) * cam.tanX * cam.right[i] + (1 - v * 2) * cam.tanY * cam.up[i];
            const float tf = d[1] < -1e-5f ? -cam.eye[1] / d[1] : 1e30f, tw = d[2] > 1e-5f ? (wallZ - cam.eye[2]) / d[2] : 1e30f;
            const bool wallHit = tw < tf && cam.eye[1] + d[1] * tw >= 0 && cam.eye[1] + d[1] * tw <= wallTop;
            const bool floorHit = !wallHit && tf < 1e29f;
            const float *p = &c[(y * W + x) * 4];
            float drawn[3] = { 0.3f, 0.5f, 1.0f };
            if (wallHit) { const float h = cam.eye[1] + d[1] * tw; drawn[0] = h / wallTop; drawn[1] = 0.25f; drawn[2] = 1 - h / wallTop; }
            else if (floorHit) drawn[0] = drawn[1] = drawn[2] = 0.2f;
            const float k = drawn[0] > 0.01f ? p[0] / drawn[0] : p[1] / drawn[1];
            const bool same = std::fabs(p[0] - drawn[0]) < 2e-3f && std::fabs(p[1] - drawn[1]) < 2e-3f && std::fabs(p[2] - drawn[2]) < 2e-3f;
            changed += !same;
            if (!floorHit) { other++; otherChanged += !same; continue; }
            const float P[3] = { cam.eye[0] + d[0] * tf, 0, cam.eye[2] + d[2] * tf };
            const float t = toSun[2] > 1e-5f ? (wallZ - P[2]) / toSun[2] : -1, hy = toSun[1] * t;
            const bool shadowed = P[2] < wallZ && t > 0 && hy <= wallTop;
            if (!same) { darkened++; minK = (std::min)(minK, k); overDark += k < darkest - 0.02f; }
            if (!shadowed) { floorLit++; floorLitChanged += !same; continue; }
            if (wallZ - P[2] < 0.5f) { shadowNear++; shadowNearFound += k < 1.0f - 0.5f * (1.0f - darkest); } // the contact: within 0.5 m of the wall's foot, at least half the darkening
        }
    // CONTACT_LAB_PPM=<file>: a picture of the result (red = the darkening factor of floor pixels, green = the wall's real
    // shadow, blue = wall and sky)
    if (const char *ppm = getenv("CONTACT_LAB_PPM"))
    {
        FILE *f = nullptr;
        if (!fopen_s(&f, ppm, "wb") && f)
        {
            fprintf(f, "P6\n%u %u\n255\n", W, H);
            for (UINT y = 0; y < H; y++)
                for (UINT x = 0; x < W; x++)
                {
                    const float u = (x + 0.5f) / W, v = (y + 0.5f) / H;
                    float d[3];
                    for (int i = 0; i < 3; i++) d[i] = cam.fwd[i] + (u * 2 - 1) * cam.tanX * cam.right[i] + (1 - v * 2) * cam.tanY * cam.up[i];
                    const float tf = d[1] < -1e-5f ? -cam.eye[1] / d[1] : 1e30f, tw = d[2] > 1e-5f ? (wallZ - cam.eye[2]) / d[2] : 1e30f;
                    const bool wallHit = tw < tf && cam.eye[1] + d[1] * tw >= 0 && cam.eye[1] + d[1] * tw <= wallTop, floorHit = !wallHit && tf < 1e29f;
                    const float Pz = cam.eye[2] + d[2] * tf, t = (wallZ - Pz) / toSun[2];
                    const bool shadowed = floorHit && Pz < wallZ && t > 0 && toSun[1] * t <= wallTop;
                    const float k = c[(y * W + x) * 4] / 0.2f;
                    const unsigned char px[3] = { (unsigned char)(floorHit ? (std::min)(255.0f, (std::max)(0.0f, k * 255.0f)) : 0), (unsigned char)(shadowed ? 160 : 0), (unsigned char)(floorHit ? 0 : 120) };
                    fwrite(px, 1, 3, f);
                }
            fclose(f);
        }
    }
    char line[260];
    if (expectOff)
    {
        snprintf(line, sizeof line, "contact lab (ContactOn=0): %d of %d pixels changed by the composite (want none)", changed, (int)(W * H));
        Check(changed == 0, line);
    }
    else
    {
        snprintf(line, sizeof line, "contact lab: %d of %d floor pixels the wall shadows within 0.5 m of its foot darkened by at least half the sun's share", shadowNearFound, shadowNear);
        Check(shadowNear > 2000 && shadowNearFound >= shadowNear * 90 / 100, line);
        snprintf(line, sizeof line, "contact lab: %d of %d sunlit floor pixels changed (want under 0.2 %%)", floorLitChanged, floorLit);
        Check(floorLit > 100000 && floorLitChanged * 500 < floorLit, line);
        snprintf(line, sizeof line, "contact lab: darkest floor pixel x %.3f, %d of %d darkened pixels below the sun share's limit %.3f", minK, overDark, darkened, darkest);
        Check(darkened > 0 && overDark == 0, line);
        snprintf(line, sizeof line, "contact lab: wall and sky pixels changed %d of %d (want none: the wall faces away from the sun, the sky has no visibility)", otherChanged, other);
        Check(other > 1000 && otherChanged == 0, line);
    }
    for (IUnknown *u : { (IUnknown *)lit, (IUnknown *)depthPS, (IUnknown *)ao, (IUnknown *)camCB, (IUnknown *)labCB, (IUnknown *)sceneCB })
        if (u) u->Release();
    for (Target *t : { &colour, &normal, &factor, &z, &aoOut })
        for (IUnknown *u : { (IUnknown *)t->tex, (IUnknown *)t->rtv, (IUnknown *)t->srv }) if (u) u->Release();
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// ---- reflections replay (shadow_test ssrreplay <dump folder> [hw]): the pass on a frame the DLL dumped in game (depth,
// scene, the camera constants A_b1), through the hooks as the game drives them: the lit pass's targets bound (the scene,
// a normal target rebuilt from the depth, g_txFactor), then the AO pass with the camera at b1, twice, 150 ms apart. With
// ini SSRMirror=1 and DumpAfter=0.1 the DLL dumps its own output (ssr_out, ssr_hit, ...) next to this program for
// tools\dump_read.js: a look at the pass on real data with every surface a mirror.
static bool LoadDump(const std::wstring &dir, const wchar_t *suffix, DumpFile &d)
{
    WIN32_FIND_DATAW fd = {};
    HANDLE h = FindFirstFileW((dir + L"\\SnowRunnerShadows_dump_*_" + suffix).c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    FindClose(h);
    return ReadDumpFile(dir + L"\\" + fd.cFileName, d);
}
static int SsrReplay(ID3D11Device *dev, ID3D11DeviceContext *ctx, const char *folder)
{
    std::wstring dir;
    for (const char *c = folder; *c; c++) dir += (wchar_t)*c;
    DumpFile depth, scene, camera;
    const bool loaded = LoadDump(dir, L"depth.bin", depth) && LoadDump(dir, L"scene.bin", scene) && LoadDump(dir, L"A_b1.bin", camera) && camera.data.size() >= 352 &&
        depth.w == scene.w && depth.h == scene.h;
    Check(loaded, "reflections replay: depth, scene and camera constants read from the dump");
    if (!loaded) return 2;
    const UINT W = depth.w, H = depth.h;
    std::vector<float> cam(88);
    memcpy(cam.data(), camera.data.data(), 352);
    // the normal target from the depth: world positions as the pass rebuilds them, the neighbour nearer in depth per axis
    const float *a = &cam[8], *b = &cam[12], *c = &cam[20];
    auto cross = [](const float *x, const float *y, float *o) { o[0] = x[1] * y[2] - x[2] * y[1]; o[1] = x[2] * y[0] - x[0] * y[2]; o[2] = x[0] * y[1] - x[1] * y[0]; };
    float bc[3], ca[3], ab[3];
    cross(b, c, bc); cross(c, a, ca); cross(a, b, ab);
    const float det = a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2];
    auto Z = [&](int x, int y) { x = x < 0 ? 0 : x >= (int)W ? W - 1 : x; y = y < 0 ? 0 : y >= (int)H ? H - 1 : y; float v; memcpy(&v, depth.data.data() + (size_t)y * depth.pitch + x * 4, 4); return v; };
    auto Pos = [&](int x, int y, float z, float *p) {
        const float nx = (x + 0.5f) / W * 2 - 1, ny = 1 - (y + 0.5f) / H * 2;
        for (int i = 0; i < 3; i++) p[i] = cam[i] + z * (nx * bc[i] + ny * ca[i] + ab[i]) / det;
    };
    std::vector<uint8_t> normal((size_t)W * H * 4);
    for (UINT y = 0; y < H; y++)
        for (UINT x = 0; x < W; x++)
        {
            float P[3], L[3], R[3], U[3], D[3], dx[3], dy[3], n[3];
            const float z = Z(x, y), zl = Z(x - 1, y), zr = Z(x + 1, y), zu = Z(x, y - 1), zd = Z(x, y + 1);
            Pos(x, y, z, P); Pos(x - 1, y, zl, L); Pos(x + 1, y, zr, R); Pos(x, y - 1, zu, U); Pos(x, y + 1, zd, D);
            for (int i = 0; i < 3; i++) { dx[i] = std::fabs(zr - z) < std::fabs(z - zl) ? R[i] - P[i] : P[i] - L[i]; dy[i] = std::fabs(zd - z) < std::fabs(z - zu) ? D[i] - P[i] : P[i] - U[i]; }
            cross(dy, dx, n);
            float len = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            if (len < 1e-12f) { n[0] = 0; n[1] = 1; n[2] = 0; len = 1; }
            const float e[3] = { cam[0] - P[0], cam[1] - P[1], cam[2] - P[2] };
            const float s = (n[0] * e[0] + n[1] * e[1] + n[2] * e[2]) < 0 ? -1.0f : 1.0f; // towards the camera
            uint8_t *o = &normal[((size_t)y * W + x) * 4];
            o[0] = (uint8_t)std::lround(std::fmin(std::fmax((s * n[0] / len) * 0.5f + 0.50196f, 0.0f), 1.0f) * 255.0f);
            o[1] = (uint8_t)std::lround(std::fmin(std::fmax((s * n[2] / len) * 0.5f + 0.50196f, 0.0f), 1.0f) * 255.0f);
            o[2] = 128; o[3] = 255;
        }
    struct Target { ID3D11Texture2D *tex = nullptr; ID3D11RenderTargetView *rtv = nullptr; ID3D11ShaderResourceView *srv = nullptr; };
    auto target = [&](DXGI_FORMAT f, const void *init, UINT pitch) {
        Target t;
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.Format = f; td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA sd = { init, pitch, 0 };
        dev->CreateTexture2D(&td, init ? &sd : nullptr, &t.tex);
        if (t.tex) { dev->CreateRenderTargetView(t.tex, nullptr, &t.rtv); dev->CreateShaderResourceView(t.tex, nullptr, &t.srv); }
        return t;
    };
    std::vector<uint8_t> ones((size_t)W * H, 255);
    Target colour = target((DXGI_FORMAT)scene.fmt, scene.data.data(), scene.pitch), norm = target(DXGI_FORMAT_R8G8B8A8_UNORM, normal.data(), W * 4),
        factor = target(DXGI_FORMAT_R8_UNORM, ones.data(), W), z = target(DXGI_FORMAT_R32_FLOAT, depth.data.data(), depth.pitch), aoOut = target(DXGI_FORMAT_R8_UNORM, nullptr, 0);
    ID3D11Buffer *camCB = nullptr;
    D3D11_BUFFER_DESC bd = { 352, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    D3D11_SUBRESOURCE_DATA cd = { cam.data(), 0, 0 };
    dev->CreateBuffer(&bd, &cd, &camCB);
    ID3DBlob *code = nullptr;
    ID3D11PixelShader *ao = nullptr;
    if (SUCCEEDED(D3DCompile(kLabAO, strlen(kLabAO), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &code, nullptr))) { dev->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &ao); code->Release(); }
    const bool made = colour.rtv && norm.rtv && factor.srv && z.srv && aoOut.rtv && camCB && ao;
    Check(made, "reflections replay: targets made (the scene in its dumped format, the normal target rebuilt from the depth)");
    if (!made) return 2;
    for (int f = 0; f < 3; f++)
    {
        ID3D11RenderTargetView *mrt[3] = { colour.rtv, norm.rtv, factor.rtv };
        ctx->OMSetRenderTargets(3, mrt, nullptr);
        ctx->OMSetRenderTargets(1, &aoOut.rtv, nullptr);
        ctx->PSSetConstantBuffers(1, 1, &camCB);
        ctx->PSSetShaderResources(0, 1, &factor.srv);
        ctx->PSSetShaderResources(2, 1, &factor.srv);
        ctx->PSSetShaderResources(80, 1, &z.srv);
        ctx->PSSetShader(ao, nullptr, 0);
        ID3D11ShaderResourceView *none = nullptr;
        ctx->PSSetShaderResources(80, 1, &none);
        ctx->ClearState(); // the AO pass is over (a dump takes its outputs here)
        ctx->Flush();
        Sleep(400);
    }
    std::wstring manifest;
    for (int i = 0; i < 200 && manifest.empty(); i++) { manifest = FindDumpFile(L"manifest.txt"); if (manifest.empty()) Sleep(100); }
    Check(!manifest.empty(), "reflections replay: the DLL wrote its dump (ini DumpAfter=0.1, SSRMirror=1)");
    for (IUnknown *u : { (IUnknown *)camCB, (IUnknown *)ao }) if (u) u->Release();
    for (Target *t : { &colour, &norm, &factor, &z, &aoOut })
        for (IUnknown *u : { (IUnknown *)t->tex, (IUnknown *)t->rtv, (IUnknown *)t->srv }) if (u) u->Release();
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// the DLL's log next to this program (the DLL keeps it open for writing: read shared)
static std::string ReadDllLog()
{
    std::string text;
    FILE *f = _wfsopen((ExeDir() + L"SnowRunnerShadows.log").c_str(), L"rb", _SH_DENYNO);
    if (!f) return text;
    char buf[4096];
    for (size_t n; (n = fread(buf, 1, sizeof buf, f)) > 0;) text.append(buf, n);
    fclose(f);
    return text;
}
// the frame timer: a factory from CreateDXGIFactory1 (the import the DLL hooks with FrameLog set), a swap chain made
// through it on a hidden window, 2.6 s of Present every ~10 ms; with FrameLog=1 the log must name both hooks and carry
// frames lines at about the rate presented, without it no frame timer at all
static int FramesTest(bool expectTimer)
{
    IDXGIFactory1 *factory = nullptr;
    Check(SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&factory)) && factory, "frame timer: a factory from CreateDXGIFactory1");
    if (!factory) return 2;
    WNDCLASSW wc = {};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"shadow_test_frames";
    RegisterClassW(&wc);
    HWND wnd = CreateWindowExW(0, wc.lpszClassName, L"frames", WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, nullptr, nullptr, wc.hInstance, nullptr);
    ID3D11Device *dev = nullptr;
    ID3D11DeviceContext *ctx = nullptr;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx);
    DXGI_SWAP_CHAIN_DESC sd = {};
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 320;
    sd.BufferDesc.Height = 180;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = wnd;
    sd.SampleDesc.Count = 1;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    IDXGISwapChain *sc = nullptr;
    const HRESULT hr = dev && wnd ? factory->CreateSwapChain(dev, &sd, &sc) : E_FAIL;
    Check(SUCCEEDED(hr) && sc, "frame timer: a swap chain made through the factory");
    int presented = 0;
    ULONGLONG took = 0;
    if (sc)
    {
        const ULONGLONG t0 = GetTickCount64();
        while (GetTickCount64() - t0 < 2600) { sc->Present(0, 0); presented++; Sleep(10); }
        took = GetTickCount64() - t0;
        sc->Release();
    }
    if (ctx) ctx->Release();
    if (dev) dev->Release();
    factory->Release();
    if (wnd) DestroyWindow(wnd);
    const std::string log = ReadDllLog();
    const bool hooked = log.find("frame timer: a line every 1 s; CreateDXGIFactory1 import hooked") != std::string::npos;
    const bool present = log.find("frame timer: Present hooked on the swap chain") != std::string::npos;
    // the frames lines: count them and take the rates
    std::vector<double> rates;
    for (size_t at = log.find("frames: "); at != std::string::npos; at = log.find("frames: ", at + 8))
    {
        const size_t eq = log.find(" = ", at), nl = log.find('\n', at);
        if (eq != std::string::npos && eq < nl) rates.push_back(atof(log.c_str() + eq + 3));
    }
    char line[200];
    if (!expectTimer)
    {
        Check(!hooked && !present && rates.empty(), "no FrameLog: no frame timer (no hooks, no frames lines)");
        printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
        return g_failures ? 1 : 0;
    }
    Check(hooked, "frame timer: the CreateDXGIFactory1 import hooked (ini FrameLog=1)");
    Check(present, "frame timer: Present hooked on the swap chain made through the factory");
    snprintf(line, sizeof line, "frame timer: %zu frames lines over %.1f s of Present (2 expected)", rates.size(), took / 1000.0);
    Check(rates.size() >= 2, line);
    const double expected = presented * 1000.0 / (took ? took : 1);
    bool matches = !rates.empty();   // (not "near": windows.h defines that away)
    for (double v : rates) matches = matches && fabs(v - expected) < expected * 0.25;
    snprintf(line, sizeof line, "frame timer: the logged rates (%s) match the rate presented (%.1f fps) within 25 %%",
        rates.empty() ? "none" : (std::to_string(rates.front()) + (rates.size() > 1 ? ", " + std::to_string(rates.back()) : "")).c_str(), expected);
    Check(matches, line);
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// the GPU timers: a swap chain made through CreateDXGIFactory1 (the import the DLL hooks), then 2.6 s of frames, each a
// depth pass into a shadow-shaped texture (768 x 256: the DLL scales and tags it, or at Factor=1 tags it x1 for the
// timing alone, run_all's "gpu timers x1"), an "AO pass" (a pixel shader that
// declares g_txDither, g_txFactor and g_txZ, which the DLL tags as the AO pass) drawn into a colour target, and Present;
// with GpuTimers=1 the log must name the import and carry "gpu:" lines with time in the AO pass and the shadow maps.
// profile (run_all's "pass profile", GpuProfile=1): a compute dispatch after the AO pass as well, and the log must carry
// the pass lists, with the AO pass named by its target and its one pixel shader, the shadow texture by its depth target,
// and the compute pass by its shader, each with GPU time
static const char *kLabCS = "RWTexture2D<float4> o : register(u0); [numthreads(8, 8, 1)] void main(uint3 id : SV_DispatchThreadID) { o[id.xy] = float4(id.xy / 320.0, 0, 1); }";
static int GpuTimersTest(bool profile)
{
    IDXGIFactory1 *factory = nullptr;
    Check(SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&factory)) && factory, "GPU timers: a factory from CreateDXGIFactory1");
    if (!factory) return 2;
    WNDCLASSW wc = {};
    wc.lpfnWndProc = DefWindowProcW;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"shadow_test_gpu";
    RegisterClassW(&wc);
    HWND wnd = CreateWindowExW(0, wc.lpszClassName, L"gpu timers", WS_OVERLAPPEDWINDOW, 0, 0, 320, 180, nullptr, nullptr, wc.hInstance, nullptr);
    Rig r;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &r.dev, nullptr, &r.ctx);
    if (!r.dev || !wnd) { printf("FAIL  no device or window\n"); return 2; }
    DXGI_SWAP_CHAIN_DESC sd = {};
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 320;
    sd.BufferDesc.Height = 180;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = wnd;
    sd.SampleDesc.Count = 1;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    IDXGISwapChain *sc = nullptr;
    Check(SUCCEEDED(factory->CreateSwapChain(r.dev, &sd, &sc)) && sc, "GPU timers: a swap chain made through the factory");
    ID3DBlob *code = nullptr;
    if (SUCCEEDED(D3DCompile(kVS, strlen(kVS), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &code, nullptr))) { r.dev->CreateVertexShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &r.vs); code->Release(); }
    ID3D11PixelShader *ao = nullptr;
    if (SUCCEEDED(D3DCompile(kLabAO, strlen(kLabAO), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &code, nullptr))) { r.dev->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &ao); code->Release(); }
    D3D11_RASTERIZER_DESC rd = {};
    rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE; rd.ScissorEnable = TRUE;
    r.dev->CreateRasterizerState(&rd, &r.rs);
    D3D11_DEPTH_STENCIL_DESC dd = {};
    dd.DepthEnable = TRUE; dd.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL; dd.DepthFunc = D3D11_COMPARISON_LESS;
    r.dev->CreateDepthStencilState(&dd, &r.ds);
    Depth atlas = MakeDepth(r, 768, 256);
    D3D11_TEXTURE2D_DESC cd = {};
    cd.Width = 320; cd.Height = 180; cd.MipLevels = 1; cd.ArraySize = 1; cd.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    cd.SampleDesc.Count = 1; cd.Usage = D3D11_USAGE_DEFAULT; cd.BindFlags = D3D11_BIND_RENDER_TARGET;
    ID3D11Texture2D *colour = nullptr, *store = nullptr;
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11UnorderedAccessView *uav = nullptr;
    ID3D11ComputeShader *cs = nullptr;
    r.dev->CreateTexture2D(&cd, nullptr, &colour);
    if (colour) r.dev->CreateRenderTargetView(colour, nullptr, &rtv);
    if (profile)
    {
        cd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
        r.dev->CreateTexture2D(&cd, nullptr, &store);
        if (store) r.dev->CreateUnorderedAccessView(store, nullptr, &uav);
        if (SUCCEEDED(D3DCompile(kLabCS, strlen(kLabCS), nullptr, nullptr, nullptr, "main", "cs_5_0", 0, 0, &code, nullptr))) { r.dev->CreateComputeShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &cs); code->Release(); }
    }
    const bool ready = sc && r.vs && ao && r.rs && r.ds && atlas.dsv && rtv && (!profile || (uav && cs));
    Check(ready, "GPU timers: the scene's shaders, states and targets");
    if (ready)
    {
        const D3D11_VIEWPORT shadowVp = { 0, 0, 768, 256, 0, 1 }, colourVp = { 0, 0, 320, 180, 0, 1 };
        const D3D11_RECT shadowRect = { 0, 0, 768, 256 }, colourRect = { 0, 0, 320, 180 };
        const ULONGLONG t0 = GetTickCount64();
        while (GetTickCount64() - t0 < 2600)
        {
            r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
            Draw(r, r.ctx, atlas, shadowVp, shadowRect, true);           // the shadow texture bound: its timing starts
            r.ctx->OMSetRenderTargets(1, &rtv, nullptr);                   // and ends with the next targets
            r.ctx->RSSetViewports(1, &colourVp);
            r.ctx->RSSetScissorRects(1, &colourRect);
            r.ctx->OMSetDepthStencilState(nullptr, 0);
            r.ctx->PSSetShader(ao, nullptr, 0);
            r.ctx->Draw(3, 0);                                             // the AO pass's draw: timed on its own
            r.ctx->PSSetShader(nullptr, nullptr, 0);
            if (profile)
            {
                ID3D11UnorderedAccessView *none = nullptr;
                r.ctx->CSSetShader(cs, nullptr, 0);                        // a compute pass (profile)
                r.ctx->CSSetUnorderedAccessViews(0, 1, &uav, nullptr);
                r.ctx->Dispatch(40, 23, 1);
                r.ctx->CSSetUnorderedAccessViews(0, 1, &none, nullptr);
                r.ctx->CSSetShader(nullptr, nullptr, 0);
            }
            sc->Present(0, 0);
            Sleep(10);
        }
    }
    for (IUnknown *u : { (IUnknown *)rtv, (IUnknown *)colour, (IUnknown *)atlas.dsv, (IUnknown *)atlas.tex, (IUnknown *)ao, (IUnknown *)r.vs, (IUnknown *)r.rs, (IUnknown *)r.ds, (IUnknown *)sc,
                         (IUnknown *)uav, (IUnknown *)store, (IUnknown *)cs })
        if (u) u->Release();
    if (r.ctx) r.ctx->Release();
    if (r.dev) r.dev->Release();
    factory->Release();
    DestroyWindow(wnd);
    const std::string log = ReadDllLog();
    if (profile)
    {
        Check(log.find("pass profile: a list every 1 s") != std::string::npos && log.find("CreateDXGIFactory1 import hooked") != std::string::npos,
            "pass profile: announced, the CreateDXGIFactory1 import hooked (ini GpuProfile=1)");
        size_t lists = 0, last = std::string::npos;
        for (size_t at = log.find("profile: "); at != std::string::npos; at = log.find("profile: ", at + 9))
            if (log.compare(at, 9, "profile: ") == 0 && isdigit((unsigned char)log[at + 9]) && log.find(" frames: ", at) < log.find('\n', at)) { lists++; last = at; }
        char text[240];
        snprintf(text, sizeof text, "pass profile: %zu lists over 2.6 s of frames (2 expected)", lists);
        Check(lists >= 2, text);
        // the last list's lines: the pass whose name holds `what`, and its time per frame (the first number after "profile:")
        auto timeOf = [&](const char *what) {
            if (last == std::string::npos) return -1.0;
            for (size_t at = log.find('\n', last) + 1; at != 0 && at < log.size(); at = log.find('\n', at) + 1)
            {
                const size_t nl = log.find('\n', at);
                const std::string row = log.substr(at, nl == std::string::npos ? std::string::npos : nl - at);
                const size_t p = row.find("profile: ");
                if (p == std::string::npos || row.find(" frames: ") != std::string::npos) break; // the next list, or the end of this one
                if (row.find(what) != std::string::npos) return atof(row.c_str() + p + 9);
            }
            return -1.0;
        };
        const double aoMs = timeOf("320 x 180: RGBA8; ps "), shadowMs = timeOf(" depth D"), csMs = timeOf("compute: cs ");
        snprintf(text, sizeof text, "pass profile: the AO pass by its target and shader, the shadow texture by its depth target, the compute pass by its shader (%.4f, %.4f, %.4f ms per frame)", aoMs, shadowMs, csMs);
        Check(aoMs > 0 && shadowMs > 0 && csMs > 0, text);
        const size_t head = last == std::string::npos ? std::string::npos : log.find("ms of GPU time per frame from Present to Present", last);
        Check(head != std::string::npos && head < log.find('\n', last), "pass profile: the frame's GPU time from Present to Present in the list's first line");
        printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
        return g_failures ? 1 : 0;
    }
    Check(log.find("GPU timers: a line every 1 s") != std::string::npos && log.find("CreateDXGIFactory1 import hooked") != std::string::npos,
        "GPU timers: announced, the CreateDXGIFactory1 import hooked (ini GpuTimers=1)");
    // run_all's "cpu profile" (CpuProfile=1 as well): lines with the hooks' calls and time
    if (log.find("CPU profile: a line every 1 s") != std::string::npos)
    {
        size_t cpuLines = 0, lastCpu = std::string::npos;
        for (size_t at = log.find("cpu: per frame over "); at != std::string::npos; at = log.find("cpu: per frame over ", at + 20)) { cpuLines++; lastCpu = at; }
        const size_t nl = lastCpu == std::string::npos ? std::string::npos : log.find('\n', lastCpu);
        const size_t ps = lastCpu == std::string::npos ? std::string::npos : log.find(" PSSetShader ", lastCpu);
        const size_t om = lastCpu == std::string::npos ? std::string::npos : log.find(" OMSetRenderTargets ", lastCpu);
        char text[200];
        snprintf(text, sizeof text, "CPU profile: %zu \"cpu:\" lines (2 expected), the last with PSSetShader and OMSetRenderTargets calls", cpuLines);
        Check(cpuLines >= 2 && ps < nl && om < nl, text);
    }
    // run_all's "thread load" (CpuThreads=1 as well): lines with the threads' time per frame, the Present thread marked
    if (log.find("thread load: a line every 1 s") != std::string::npos)
    {
        size_t lines = 0, last = std::string::npos;
        for (size_t at = log.find("threads: "); at != std::string::npos; at = log.find("threads: ", at + 9)) { lines++; last = at; }
        const size_t nl = last == std::string::npos ? std::string::npos : log.find('\n', last);
        const size_t present = last == std::string::npos ? std::string::npos : log.find(" Present", last);
        char text[200];
        snprintf(text, sizeof text, "thread load: %zu \"threads:\" lines (1 or more expected), the last with the thread that calls Present", lines);
        Check(lines >= 1 && present < nl, text);
    }
    // the gpu lines: how many, and the AO pass's and the shadow maps' time per frame in the last one
    size_t lines = 0, last = std::string::npos;
    for (size_t at = log.find("gpu: per frame over "); at != std::string::npos; at = log.find("gpu: per frame over ", at + 20)) { lines++; last = at; }
    char line[240];
    snprintf(line, sizeof line, "GPU timers: %zu \"gpu:\" lines over 2.6 s of frames (2 expected)", lines);
    Check(lines >= 2, line);
    auto valueAfter = [&](const char *name) {
        if (last == std::string::npos) return -1.0;
        const size_t nl = log.find('\n', last), at = log.find(name, last);
        return at != std::string::npos && at < nl ? atof(log.c_str() + at + strlen(name)) : -1.0;
    };
    const double aoMs = valueAfter(" AO pass "), shadowMs = valueAfter(" shadow maps ");
    snprintf(line, sizeof line, "GPU timers: the AO pass and the shadow maps took GPU time (%.4f ms, %.4f ms per frame in the last line)", aoMs, shadowMs);
    Check(aoMs > 0 && shadowMs > 0, line);
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// The AO pass's depth mips (shadow_test zmips; run_all "zmips" and "zmips off" with ini ZMips=0): a 64 x 64
// depth whose texel (x, y) holds x + 100 y at t80, and an AO pass shader (g_txDither, g_txFactor: the DLL tags it) that
// declares t126 and returns what it reads there: level 1 (3, 2), level 2 (1, 1), level 3 (1, 1), level 4 (1, 1) of the
// chain, which decimated are the depths at (6, 4), (4, 4), (8, 8) and (16, 16): 406, 404, 808, 1616. Its t80 bound before
// the shader and after it, on the immediate context and on a deferred one; t126 empty again once another shader is set;
// with ZMips=0 nothing at t126 (the shader returns -1)
static int ZMipsTest(bool expectOff)
{
    Rig r;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &r.dev, nullptr, &r.ctx);
    if (!r.dev) { printf("FAIL  no device\n"); return 2; }
    const char *kVSFull = "float4 main(uint id : SV_VertexID) : SV_Position { float2 p = float2((id << 1) & 2, id & 2); return float4(p.x * 2 - 1, 1 - p.y * 2, 0.5, 1); }";
    const char *kAOZ = "Texture2D g_txDither : register(t0); Texture2D g_txFactor : register(t2); Texture2D<float> g_txZ : register(t80); Texture2D<float> g_txZMips : register(t126);"
                       "float4 main(float4 p : SV_Position) : SV_Target { uint w, h, n; g_txZMips.GetDimensions(0, w, h, n);"
                       " float keep = g_txDither.Load(int3(0, 0, 0)).x + g_txFactor.Load(int3(0, 0, 0)).x + g_txZ.Load(int3(0, 0, 0));"
                       " if (!w) return float4(-1, -1, keep, n);"
                       " return float4(g_txZMips.Load(int3(3, 2, 0)), g_txZMips.Load(int3(1, 1, 1)), g_txZMips.Load(int3(1, 1, 2)), g_txZMips.Load(int3(1, 1, 3))); }";
    const char *kOther = "float4 main(float4 p : SV_Position) : SV_Target { return 1; }";
    ID3DBlob *code = nullptr;
    ID3D11VertexShader *vs = nullptr;
    ID3D11PixelShader *aoz = nullptr, *other = nullptr;
    if (SUCCEEDED(D3DCompile(kVSFull, strlen(kVSFull), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &code, nullptr))) { r.dev->CreateVertexShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &vs); code->Release(); }
    if (SUCCEEDED(D3DCompile(kAOZ, strlen(kAOZ), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &code, nullptr))) { r.dev->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &aoz); code->Release(); }
    if (SUCCEEDED(D3DCompile(kOther, strlen(kOther), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &code, nullptr))) { r.dev->CreatePixelShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &other); code->Release(); }
    // the depth (x + 100 y), a one-texel factor and dither, a 1 x 1 RGBA32F target and its staging copy
    std::vector<float> zData(64 * 64);
    for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) zData[y * 64 + x] = (float)(x + 100 * y);
    D3D11_TEXTURE2D_DESC td = { 64, 64, 1, 1, DXGI_FORMAT_R32_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, 0 };
    D3D11_SUBRESOURCE_DATA sd = { zData.data(), 64 * 4, 0 };
    ID3D11Texture2D *zTex = nullptr, *oneTex = nullptr, *rt = nullptr, *st = nullptr;
    ID3D11ShaderResourceView *zSrv = nullptr, *oneSrv = nullptr;
    ID3D11RenderTargetView *rtv = nullptr;
    r.dev->CreateTexture2D(&td, &sd, &zTex);
    if (zTex) r.dev->CreateShaderResourceView(zTex, nullptr, &zSrv);
    const float one[4] = { 1, 1, 1, 1 };
    D3D11_TEXTURE2D_DESC od = { 1, 1, 1, 1, DXGI_FORMAT_R32G32B32A32_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, 0 };
    D3D11_SUBRESOURCE_DATA osd = { one, 16, 0 };
    r.dev->CreateTexture2D(&od, &osd, &oneTex);
    if (oneTex) r.dev->CreateShaderResourceView(oneTex, nullptr, &oneSrv);
    od.BindFlags = D3D11_BIND_RENDER_TARGET;
    r.dev->CreateTexture2D(&od, nullptr, &rt);
    if (rt) r.dev->CreateRenderTargetView(rt, nullptr, &rtv);
    od.BindFlags = 0; od.Usage = D3D11_USAGE_STAGING; od.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    r.dev->CreateTexture2D(&od, nullptr, &st);
    const bool ready = vs && aoz && other && zSrv && oneSrv && rtv && st;
    Check(ready, "AO depth mips: shaders and textures made");
    if (!ready) return 2;
    const D3D11_VIEWPORT vp = { 0, 0, 1, 1, 0, 1 };
    auto read = [&]() {
        std::vector<float> v(4, 0.0f);
        r.ctx->CopyResource(st, rt);
        D3D11_MAPPED_SUBRESOURCE m = {};
        if (SUCCEEDED(r.ctx->Map(st, 0, D3D11_MAP_READ, 0, &m))) { memcpy(v.data(), m.pData, 16); r.ctx->Unmap(st, 0); }
        return v;
    };
    // the AO pass on c: t80 before the shader (zFirst) or after it; then another shader, and what t126 holds then
    bool emptyAfter = false;
    auto pass = [&](ID3D11DeviceContext *c, bool zFirst) {
        c->OMSetRenderTargets(1, &rtv, nullptr);
        c->RSSetViewports(1, &vp);
        c->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        c->VSSetShader(vs, nullptr, 0);
        c->PSSetShaderResources(0, 1, &oneSrv);
        c->PSSetShaderResources(2, 1, &oneSrv);
        if (zFirst) c->PSSetShaderResources(80, 1, &zSrv);
        c->PSSetShader(aoz, nullptr, 0);
        if (!zFirst) c->PSSetShaderResources(80, 1, &zSrv);
        c->Draw(3, 0);
        c->PSSetShader(other, nullptr, 0);
        ID3D11ShaderResourceView *t126 = nullptr;
        c->PSGetShaderResources(126, 1, &t126);
        emptyAfter = t126 == nullptr;
        if (t126) t126->Release();
        ID3D11ShaderResourceView *none = nullptr;
        c->PSSetShaderResources(80, 1, &none);
    };
    char line[240];
    auto expect = [&](const std::vector<float> &v, const char *what) {
        snprintf(line, sizeof line, "AO depth mips, %s: the AO pass reads %g %g %g %g at t126 (%s)", what, v[0], v[1], v[2], v[3],
            expectOff ? "ZMips=0: nothing, -1" : "406 404 808 1616: the depths at (6, 4), (4, 4), (8, 8), (16, 16)");
        Check(expectOff ? v[0] == -1 && v[1] == -1 : v[0] == 406 && v[1] == 404 && v[2] == 808 && v[3] == 1616, line);
    };
    pass(r.ctx, true);
    expect(read(), "t80 before the shader");
    Check(emptyAfter, "AO depth mips: t126 empty again once another shader is set");
    pass(r.ctx, false);
    expect(read(), "t80 after the shader");
    ID3D11DeviceContext *d = nullptr;
    r.dev->CreateDeferredContext(0, &d);
    if (d)
    {
        pass(d, true);
        ID3D11CommandList *l = nullptr;
        d->FinishCommandList(FALSE, &l);
        const float clear[4] = { 0, 0, 0, 0 };
        r.ctx->ClearRenderTargetView(rtv, clear);
        if (l) { r.ctx->ExecuteCommandList(l, FALSE); l->Release(); }
        d->Release();
        expect(read(), "on a deferred context");
    }
    const std::string log = ReadDllLog();
    Check(expectOff ? log.find("AO depth mips at t126: off") != std::string::npos : log.find("AO depth mips: first made and bound at t126") != std::string::npos,
        expectOff ? "AO depth mips: announced off (ini ZMips=0)" : "AO depth mips: the log names the first ones made");
    for (IUnknown *u : { (IUnknown *)st, (IUnknown *)rtv, (IUnknown *)rt, (IUnknown *)oneSrv, (IUnknown *)oneTex, (IUnknown *)zSrv, (IUnknown *)zTex, (IUnknown *)other, (IUnknown *)aoz, (IUnknown *)vs })
        if (u) u->Release();
    r.ctx->Release();
    r.dev->Release();
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

// AO at half size on a target with an odd width and height (65 x 37; a DLSS scale gives such sizes): the half-size
// pass must fill its whole 33 x 19 target. A viewport of half the size as a fraction (32.5 x 18.5) leaves the last
// column and row undrawn, and the upsample then reads them for the picture's last columns and rows. The AO pass here
// writes 1 everywhere, the apply pass puts what it reads at t1 into the colour target's alpha: 1 in every corner.
static int AOHalfOddTest()
{
    Rig r;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &r.dev, nullptr, &r.ctx);
    if (!r.dev) { printf("FAIL  no device\n"); return 2; }
    const UINT W = 65, H = 37;
    const char *kVSFull = "float4 main(uint id : SV_VertexID) : SV_Position { float2 p = float2((id << 1) & 2, id & 2); return float4(p.x * 2 - 1, 1 - p.y * 2, 0.5, 1); }";
    const char *kLit = "float4 c; struct O { float4 c : SV_Target0; float4 v : SV_Target1; float f : SV_Target2; };"
                       "O main() { O o; o.c = c; o.v = 0; o.f = 1; return o; }";
    const char *kAOGI = "Texture2D g_txDither : register(t0); Texture2D g_txFactor : register(t2); Texture2D g_txZ : register(t80); Texture2D g_txScene : register(t120);"
                        "struct O { float4 ao : SV_Target0; float4 gi : SV_Target1; };"
                        "O main(float4 p : SV_Position) { O o; o.ao = g_txDither.Load(int3(0, 0, 0)) + g_txFactor.Load(int3(p.xy, 0)) * g_txZ.Load(int3(p.xy, 0)).x;"
                        " o.gi = float4(g_txScene.Load(int3(p.xy, 0)).rgb * 2, 1); return o; }";
    const char *kApply = "cbuffer CB_INSTANCE : register(b4) { float4 g_vSSAOColor; }; Texture2D g_txMask : register(t1); Texture2D g_txFactor : register(t2);"
                         "float4 main(float4 p : SV_Position) : SV_Target { return float4(g_vSSAOColor.rgb, g_txMask.Load(int3(p.xy, 0)).x * g_txFactor.Load(int3(p.xy, 0)).x); }";
    ID3DBlob *code = nullptr;
    ID3D11VertexShader *vs = nullptr;
    if (SUCCEEDED(D3DCompile(kVSFull, strlen(kVSFull), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &code, nullptr))) { r.dev->CreateVertexShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &vs); code->Release(); }
    auto ps = [&](const char *src) {
        ID3DBlob *b = nullptr;
        ID3D11PixelShader *s = nullptr;
        if (SUCCEEDED(D3DCompile(src, strlen(src), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &b, nullptr))) { r.dev->CreatePixelShader(b->GetBufferPointer(), b->GetBufferSize(), nullptr, &s); b->Release(); }
        return s;
    };
    ID3D11PixelShader *lit = ps(kLit), *aoGI = ps(kAOGI), *apply = ps(kApply);
    struct Target { ID3D11Texture2D *tex = nullptr; ID3D11RenderTargetView *rtv = nullptr; ID3D11ShaderResourceView *srv = nullptr; };
    auto target = [&](DXGI_FORMAT f) {
        Target t;
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.Format = f; td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        r.dev->CreateTexture2D(&td, nullptr, &t.tex);
        if (t.tex) { r.dev->CreateRenderTargetView(t.tex, nullptr, &t.rtv); r.dev->CreateShaderResourceView(t.tex, nullptr, &t.srv); }
        return t;
    };
    Target colour = target(DXGI_FORMAT_R16G16B16A16_FLOAT), velocity = target(DXGI_FORMAT_R16G16_FLOAT), factor = target(DXGI_FORMAT_R8_UNORM),
        z = target(DXGI_FORMAT_R32_FLOAT), aoMask = target(DXGI_FORMAT_R8_UNORM);
    D3D11_BUFFER_DESC bd = { 16, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    ID3D11Buffer *cb = nullptr;
    r.dev->CreateBuffer(&bd, nullptr, &cb);
    D3D11_TEXTURE2D_DESC sd = {};
    sd.Width = W; sd.Height = H; sd.MipLevels = 1; sd.ArraySize = 1; sd.Format = DXGI_FORMAT_R16G16B16A16_FLOAT; sd.SampleDesc.Count = 1;
    sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ID3D11Texture2D *st = nullptr;
    r.dev->CreateTexture2D(&sd, nullptr, &st);
    const bool ready = vs && lit && aoGI && apply && colour.srv && velocity.rtv && factor.srv && z.srv && aoMask.srv && cb && st;
    Check(ready, "AO at half size, odd size: shaders and targets made");
    if (!ready) return 2;
    const D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    const D3D11_RECT rect = { 0, 0, (LONG)W, (LONG)H };
    UINT aoRT0Width = 0, aoRT0Height = 0;
    // one frame as the game orders it: lighting, the AO pass with its second output, the apply pass onto the lit colour
    auto frame = [&](ID3D11DeviceContext *c) {
        c->VSSetShader(vs, nullptr, 0); c->IASetInputLayout(nullptr); c->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        c->RSSetViewports(1, &vp); c->RSSetScissorRects(1, &rect);
        const float lc[4] = { 0.25f, 0.5f, 0.75f, 1 };
        c->UpdateSubresource(cb, 0, nullptr, lc, 0, 0);
        c->PSSetConstantBuffers(0, 1, &cb);
        ID3D11RenderTargetView *mrt[3] = { colour.rtv, velocity.rtv, factor.rtv };
        c->OMSetRenderTargets(3, mrt, nullptr);
        c->PSSetShader(lit, nullptr, 0);
        c->Draw(3, 0);
        const float seven[4] = { 7, 7, 7, 7 };
        c->ClearRenderTargetView(z.rtv, seven);
        c->OMSetRenderTargets(1, &aoMask.rtv, nullptr);
        c->PSSetShaderResources(0, 1, &factor.srv);
        c->PSSetShaderResources(2, 1, &factor.srv);
        c->PSSetShaderResources(80, 1, &z.srv);
        c->PSSetShader(aoGI, nullptr, 0);
        ID3D11RenderTargetView *rt0 = nullptr;
        c->OMGetRenderTargets(1, &rt0, nullptr);
        if (rt0)
        {
            ID3D11Resource *res = nullptr;
            ID3D11Texture2D *t = nullptr;
            D3D11_TEXTURE2D_DESC d = {};
            rt0->GetResource(&res);
            if (res && SUCCEEDED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&t)) && t) { t->GetDesc(&d); t->Release(); }
            aoRT0Width = d.Width; aoRT0Height = d.Height;
            if (res) res->Release();
            rt0->Release();
        }
        c->Draw(3, 0);
        ID3D11ShaderResourceView *none = nullptr;
        c->PSSetShaderResources(80, 1, &none);
        c->OMSetRenderTargets(1, &colour.rtv, nullptr);
        c->PSSetShaderResources(1, 1, &aoMask.srv);
        c->PSSetShader(apply, nullptr, 0);
        c->PSSetConstantBuffers(4, 1, &cb);
        c->Draw(3, 0);
        c->PSSetShaderResources(1, 1, &none);
    };
    // the alpha of the colour target at a pixel (half float)
    auto half = [](uint16_t h) {
        const int e = (h >> 10) & 31, m = h & 1023;
        const float v = e == 0 ? ldexpf((float)m, -24) : ldexpf((float)(m + 1024), e - 25);
        return (h & 0x8000) ? -v : v;
    };
    auto alphaAt = [&](UINT x, UINT y) {
        float v = -9;
        r.ctx->CopyResource(st, colour.tex);
        D3D11_MAPPED_SUBRESOURCE m = {};
        if (SUCCEEDED(r.ctx->Map(st, 0, D3D11_MAP_READ, 0, &m)))
        {
            uint16_t a = 0;
            memcpy(&a, (const BYTE *)m.pData + y * m.RowPitch + x * 8 + 6, 2);
            v = half(a);
            r.ctx->Unmap(st, 0);
        }
        return v;
    };
    for (int i = 0; i < 4; i++) frame(r.ctx);   // the first frames show the DLL which target is the AO pass's own
    char line[240];
    snprintf(line, sizeof line, "AO at half size, odd size: the AO pass draws into a %u x %u target (half of 65 x 37, rounded up)", aoRT0Width, aoRT0Height);
    Check(aoRT0Width == 33 && aoRT0Height == 19, line);
    const float inner = alphaAt(10, 10), right = alphaAt(W - 1, 10), bottom = alphaAt(10, H - 1), corner = alphaAt(W - 1, H - 1), beforeRight = alphaAt(W - 2, 10), beforeBottom = alphaAt(10, H - 2);
    snprintf(line, sizeof line, "AO at half size, odd size: the apply pass reads %.3g inside, %.3g and %.3g in the last two columns, %.3g and %.3g in the last two rows, %.3g in the corner (1 everywhere)",
        inner, beforeRight, right, beforeBottom, bottom, corner);
    auto one = [](float v) { return std::fabs(v - 1.0f) < 1e-3f; };
    Check(one(inner) && one(right) && one(bottom) && one(corner) && one(beforeRight) && one(beforeBottom), line);
    // on a deferred context too
    ID3D11DeviceContext *d = nullptr;
    r.dev->CreateDeferredContext(0, &d);
    if (d)
    {
        frame(d);
        ID3D11CommandList *l = nullptr;
        d->FinishCommandList(FALSE, &l);
        if (l) { r.ctx->ExecuteCommandList(l, FALSE); l->Release(); }
        d->Release();
        const float r2 = alphaAt(W - 1, 10), b2 = alphaAt(10, H - 1), c2 = alphaAt(W - 1, H - 1);
        snprintf(line, sizeof line, "AO at half size, odd size, on a deferred context: %.3g, %.3g and %.3g in the last column, the last row and the corner", r2, b2, c2);
        Check(one(r2) && one(b2) && one(c2), line);
    }
    Check(ReadDllLog().find("AO at half size: targets 33 x 19 for the pass's 65 x 37") != std::string::npos, "AO at half size, odd size: the log names the targets");
    for (IUnknown *u : { (IUnknown *)st, (IUnknown *)cb, (IUnknown *)apply, (IUnknown *)aoGI, (IUnknown *)lit, (IUnknown *)vs })
        if (u) u->Release();
    for (Target *t : { &colour, &velocity, &factor, &z, &aoMask }) { if (t->srv) t->srv->Release(); if (t->rtv) t->rtv->Release(); if (t->tex) t->tex->Release(); }
    r.ctx->Release();
    r.dev->Release();
    printf("%s\n", g_failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return g_failures ? 1 : 0;
}

int main(int argc, char **argv)
{
    bool expectOff = false, hardware = false, twoDevices = false, noFeed = false, noGI = false, puddlesOff = false, bounceOff = false;
    bool makeTable = false, twins = false, stockAll = false, stockAO = false, dumpMode = false, dumpImmediate = false, noMips = false;
    bool ssrMode = false, ssrRough = false, aoHalfMode = false, aoFullMode = false, contactMode = false;
    const char *replayDir = nullptr;
    for (int i = 1; i < argc; i++)
    {
        contactMode |= strcmp(argv[i], "contact") == 0;
        ssrMode |= strcmp(argv[i], "ssr") == 0; ssrRough |= strcmp(argv[i], "rough") == 0; aoHalfMode |= strcmp(argv[i], "aohalf") == 0;
        aoFullMode |= strcmp(argv[i], "aofull") == 0;
        if (strcmp(argv[i], "ssrreplay") == 0 && i + 1 < argc) replayDir = argv[i + 1];
        expectOff |= strcmp(argv[i], "off") == 0; hardware |= strcmp(argv[i], "hw") == 0; twoDevices |= strcmp(argv[i], "double") == 0;
        noFeed |= strcmp(argv[i], "nofeed") == 0; noGI |= strcmp(argv[i], "nogi") == 0;
        puddlesOff |= strcmp(argv[i], "puddlesoff") == 0; bounceOff |= strcmp(argv[i], "bounceoff") == 0;
        makeTable |= strcmp(argv[i], "maketable") == 0; twins |= strcmp(argv[i], "twins") == 0;
        stockAll |= strcmp(argv[i], "stockall") == 0; stockAO |= strcmp(argv[i], "stockao") == 0;
        dumpMode |= strcmp(argv[i], "dump") == 0; dumpImmediate |= strcmp(argv[i], "immediate") == 0; noMips |= strcmp(argv[i], "nomips") == 0;
        if (strcmp(argv[i], "frames") == 0) return FramesTest(true);
        if (strcmp(argv[i], "noframes") == 0) return FramesTest(false);
        if (strcmp(argv[i], "gputimers") == 0) return GpuTimersTest(false);
        if (strcmp(argv[i], "gpuprofile") == 0) return GpuTimersTest(true);
        if (strcmp(argv[i], "aohalfodd") == 0) return AOHalfOddTest();
        if (strcmp(argv[i], "zmips") == 0) return ZMipsTest(false);
        if (strcmp(argv[i], "zmipsoff") == 0) return ZMipsTest(true);
    }
    if (dumpMode) DeleteDumpFiles();
    if (makeTable)
    {
        const bool ok = MakeTwinTable();
        printf(ok ? "stock twins table written next to this program\n" : "FAIL  could not write the stock twins table\n");
        return ok ? 0 : 2;
    }
    noGI |= noFeed || bounceOff || stockAll || stockAO; // the game's own SSAO has no bounce light
    GUID g = {};
    HidD_GetHidGuid(&g);
    const GUID hid = { 0x4d1e55b2, 0xf16f, 0x11cf, { 0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30 } };
    Check(memcmp(&g, &hid, sizeof g) == 0, "HidD_GetHidGuid through the proxy returns the HID class GUID");

    Rig r;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    if (FAILED(D3D11CreateDevice(nullptr, hardware ? D3D_DRIVER_TYPE_HARDWARE : D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &r.dev, nullptr, &r.ctx))) { printf("FAIL  no device\n"); return 2; }
    printf("device: %s\n", hardware ? "GPU" : "WARP");
    ID3D11Device *second = nullptr;
    if (twoDevices)
    {
        D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &second, nullptr, nullptr);
        printf("second device (WARP, never wrapped by ReShade): %s\n", second ? "made" : "FAILED");
    }
    ID3DBlob *code = nullptr, *err = nullptr;
    if (FAILED(D3DCompile(kVS, strlen(kVS), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &code, &err))) { printf("FAIL  shader\n"); return 2; }
    r.dev->CreateVertexShader(code->GetBufferPointer(), code->GetBufferSize(), nullptr, &r.vs);
    D3D11_RASTERIZER_DESC rd = {}; rd.FillMode = D3D11_FILL_SOLID; rd.CullMode = D3D11_CULL_NONE; rd.DepthClipEnable = TRUE; rd.ScissorEnable = TRUE;
    r.dev->CreateRasterizerState(&rd, &r.rs);
    D3D11_DEPTH_STENCIL_DESC dd = {}; dd.DepthEnable = TRUE; dd.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL; dd.DepthFunc = D3D11_COMPARISON_ALWAYS;
    r.dev->CreateDepthStencilState(&dd, &r.ds);
    if (ssrMode) return SsrLab(r.dev, r.ctx, r.vs, r.rs, ssrRough); // the reflections lab alone
    if (contactMode) return ContactLab(r.dev, r.ctx, r.vs, r.rs, expectOff); // the contact shadows lab alone
    if (replayDir) { DeleteDumpFiles(); return SsrReplay(r.dev, r.ctx, replayDir); } // the pass on a dumped game frame

    // the real size is only created and measured; the drawing checks use a small 3:1 texture to keep the readback light
    Depth big = MakeDepth(r, 4608, 1536);
    char line[160];
    snprintf(line, sizeof line, "4608 x 1536 shadow texture created as %u x %u", big.w, big.h);
    Check(expectOff ? (big.w == 4608 && big.h == 1536) : (big.w == 9216 && big.h == 3072), line);
    Depth scene = MakeDepth(r, 3840, 2160);
    Check(scene.w == 3840 && scene.h == 2160, "3840 x 2160 scene depth left at its size");
    Depth atlas = MakeDepth(r, 768, 256);
    const float f = (float)atlas.w / 768;
    snprintf(line, sizeof line, "768 x 256 test texture created as %u x %u (factor %g)", atlas.w, atlas.h, f);
    Check(expectOff ? f == 1 : f == 2.0f, line);

    const D3D11_VIEWPORT full = { 0, 0, 768, 256, 0, 1 };
    const D3D11_RECT fullRect = { 0, 0, 768, 256 };
    const std::vector<POINT> corners = { { 0, 0 }, { (LONG)atlas.w - 1, 0 }, { 0, (LONG)atlas.h - 1 }, { (LONG)atlas.w - 1, (LONG)atlas.h - 1 }, { (LONG)atlas.w / 2, (LONG)atlas.h / 2 } };
    auto allAt = [](const std::vector<float> &v, float x) { for (float y : v) if (y != x) return false; return true; };

    for (int order = 0; order < 2; order++)
    {
        r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
        Draw(r, r.ctx, atlas, full, fullRect, order == 0);
        D3D11_VIEWPORT back = {}; UINT n = 1;
        r.ctx->RSGetViewports(&n, &back);
        D3D11_RECT backRect = {}; UINT m = 1;
        r.ctx->RSGetScissorRects(&m, &backRect);
        Check(back.Width == 768 && back.Height == 256 && backRect.right == 768 && backRect.bottom == 256,
            order == 0 ? "viewport and scissor read back as set (set before binding)" : "viewport and scissor read back as set (set after binding)");
        const std::vector<float> v = Read(r, atlas, corners); // scaled or not, the full viewport covers the texture
        Check(allAt(v, 0.25f),
            order == 0 ? "full viewport covers the whole texture (viewport set before binding)" : "full viewport covers the whole texture (viewport set after binding)");
    }

    // the third cascade alone: the scaled region must be written and the second cascade left alone
    r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
    Draw(r, r.ctx, atlas, D3D11_VIEWPORT{ 512, 0, 256, 256, 0, 1 }, D3D11_RECT{ 512, 0, 768, 256 }, true);
    {
        const LONG x3 = (LONG)(512 * f), x2 = x3 - 2;
        const std::vector<float> v = Read(r, atlas, { { x3 + 1, 1 }, { (LONG)atlas.w - 1, (LONG)atlas.h - 1 }, { x2, 1 } });
        Check(v[0] == 0.25f && v[1] == 0.25f && v[2] == 1.0f, "third cascade viewport lands on the scaled third and nowhere else");
    }

    // Slope-scaled depth bias: it is per texel, so in a texture 3.5 times finer the game's slope factor gives 3.5 times less
    // bias. The DLL scales the factor while the shadow texture is bound: the bias in depth must come out as in a texture of
    // the game's size (768 x 255 is not 3:1, so it stays as created), and reading the state back gives the caller's own.
    {
        ID3DBlob *slopeCode = nullptr;
        ID3D11VertexShader *slopeVS = nullptr;
        if (SUCCEEDED(D3DCompile(kVSSlope, strlen(kVSSlope), nullptr, nullptr, nullptr, "main", "vs_5_0", 0, 0, &slopeCode, nullptr)))
            r.dev->CreateVertexShader(slopeCode->GetBufferPointer(), slopeCode->GetBufferSize(), nullptr, &slopeVS);
        D3D11_RASTERIZER_DESC bd = rd;
        bd.SlopeScaledDepthBias = 1.0f;
        ID3D11RasterizerState *biased = nullptr;
        r.dev->CreateRasterizerState(&bd, &biased);
        Depth ref = MakeDepth(r, 768, 255);
        // depth bias at three points along the middle row: depth drawn with the bias minus depth drawn without
        auto biasOf = [&](Depth &d, UINT w, UINT h, bool checkGet) {
            const std::vector<POINT> at = { { (LONG)d.w / 4, (LONG)d.h / 2 }, { (LONG)d.w / 2, (LONG)d.h / 2 }, { (LONG)d.w * 3 / 4, (LONG)d.h / 2 } };
            const D3D11_VIEWPORT vp = { 0, 0, (float)w, (float)h, 0, 1 };
            const D3D11_RECT sc = { 0, 0, (LONG)w, (LONG)h };
            std::vector<float> z[2];
            bool getOk = true;
            for (int pass = 0; pass < 2; pass++)
            {
                r.ctx->ClearDepthStencilView(d.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
                Draw(r, r.ctx, d, vp, sc, true);
                r.ctx->VSSetShader(slopeVS, nullptr, 0);
                r.ctx->RSSetState(pass ? biased : r.rs);
                if (checkGet && pass) { ID3D11RasterizerState *back = nullptr; r.ctx->RSGetState(&back); getOk = back == biased; if (back) back->Release(); }
                r.ctx->Draw(3, 0);
                z[pass] = Read(r, d, at);
            }
            r.ctx->RSSetState(r.rs);
            double sum = 0;
            for (size_t i = 0; i < at.size(); i++) sum += z[1][i] - z[0][i];
            return std::make_pair(sum / at.size(), getOk);
        };
        const auto refBias = biasOf(ref, 768, 255, false);
        const auto atlasBias = biasOf(atlas, 768, 256, true);
        snprintf(line, sizeof line, "slope depth bias in the shadow texture %.3g, in a texture of the game's size %.3g", atlasBias.first, refBias.first);
        Check(refBias.first > 0 && std::fabs(atlasBias.first - refBias.first) < 0.05 * refBias.first, line);
        Check(atlasBias.second, "reading the rasterizer state back gives the state the caller set");
        if (biased) biased->Release();
        if (slopeVS) slopeVS->Release();
        if (slopeCode) slopeCode->Release();
    }

    // deferred context: record on a deferred context, execute on the immediate one
    ID3D11DeviceContext *def = nullptr;
    r.dev->CreateDeferredContext(0, &def);
    r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
    Draw(r, def, atlas, full, fullRect, true);
    ID3D11CommandList *list = nullptr;
    def->FinishCommandList(FALSE, &list);
    r.ctx->ExecuteCommandList(list, FALSE);
    list->Release();
    Check(expectOff ? true : allAt(Read(r, atlas, corners), 0.25f), "deferred context: full viewport covers the whole texture");

    // after the shadow texture, a normal depth target gets the viewport exactly as set
    r.ctx->ClearDepthStencilView(scene.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
    Draw(r, r.ctx, atlas, full, fullRect, true);
    Draw(r, r.ctx, scene, D3D11_VIEWPORT{ 0, 0, 1920, 1080, 0, 1 }, D3D11_RECT{ 0, 0, 1920, 1080 }, true);
    {
        const std::vector<float> v = Read(r, scene, { { 1919, 1079 }, { 1921, 1081 } });
        Check(v[0] == 0.25f && v[1] == 1.0f, "normal depth target: viewport not scaled");
    }
    // binding order the other way round: viewport set while the shadow texture is still bound, then the scene bound
    r.ctx->ClearDepthStencilView(scene.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
    r.ctx->OMSetRenderTargets(0, nullptr, atlas.dsv);
    D3D11_VIEWPORT half = { 0, 0, 1920, 1080, 0, 1 };
    D3D11_RECT halfRect = { 0, 0, 1920, 1080 };
    r.ctx->RSSetViewports(1, &half);
    r.ctx->RSSetScissorRects(1, &halfRect);
    r.ctx->OMSetRenderTargets(0, nullptr, scene.dsv);
    r.ctx->Draw(3, 0);
    {
        const std::vector<float> v = Read(r, scene, { { 1919, 1079 }, { 1921, 1081 } });
        Check(v[0] == 0.25f && v[1] == 1.0f, "viewport set while the shadow texture was bound is put back when the scene is bound");
    }

    def->Release();

    // ClearState must not undo the hooks: after it, the shadow texture still gets the scaled viewport
    r.ctx->ClearState();
    r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
    Draw(r, r.ctx, atlas, full, fullRect, false);
    Check(expectOff ? true : allAt(Read(r, atlas, corners), 0.25f), "after ClearState: full viewport covers the whole texture");

    // many worker contexts, each with a table of its own, then all freed and made again (addresses come back)
    for (int round = 0; round < 2; round++)
    {
        std::vector<ID3D11DeviceContext *> workers(40, nullptr);
        for (auto &w : workers) r.dev->CreateDeferredContext(0, &w);
        bool all = true;
        for (size_t i = 0; i < workers.size(); i += 13)
        {
            r.ctx->ClearDepthStencilView(atlas.dsv, D3D11_CLEAR_DEPTH, 1.0f, 0);
            Draw(r, workers[i], atlas, full, fullRect, i % 2 == 0);
            ID3D11CommandList *cl = nullptr;
            workers[i]->FinishCommandList(FALSE, &cl);
            r.ctx->ExecuteCommandList(cl, FALSE);
            cl->Release();
            all &= expectOff ? true : allAt(Read(r, atlas, corners), 0.25f);
        }
        for (auto w : workers) w->Release();
        Check(all, round == 0 ? "40 worker contexts: every one tested covers the whole texture" : "40 new worker contexts on freed addresses: the same");
    }

    // Scene feed, the game's order: a lighting pass writes colour, velocity and g_txFactor (render targets 0, 1, 2); the AO
    // pass (a pixel shader naming g_txDither and g_txFactor) is set up with g_txZ at t80; later a shader that declares t120
    // and t121 must read that colour and depth there: after its slots are reset, and on deferred contexts with the calls
    // in the other order. The colour target is overwritten after the AO pass, so only a copy passes.
    {
        const char *kLit = "float4 c; struct O { float4 c : SV_Target0; float4 v : SV_Target1; float f : SV_Target2; };"
                           "O main() { O o; o.c = c; o.v = 0; o.f = 1; return o; }";
        const char *kAO = "Texture2D g_txDither : register(t0); Texture2D g_txFactor : register(t2); Texture2D g_txZ : register(t80);"
                          "float4 main(float4 p : SV_Position) : SV_Target { return g_txDither.Load(int3(0, 0, 0)) + g_txFactor.Load(int3(p.xy, 0)) * g_txZ.Load(int3(p.xy, 0)).x; }";
        const char *kReader = "Texture2D<float4> g_txPrevScene : register(t120); Texture2D<float> g_txPrevZ : register(t121);"
                              "float4 main(float4 p : SV_Position) : SV_Target { uint w, h; g_txPrevZ.GetDimensions(w, h);"
                              " return w ? float4(g_txPrevScene.Load(int3(p.xy, 0)).rgb, g_txPrevZ.Load(int3(p.xy, 0))) : float4(-1, -1, -1, -1); }";
        auto ps = [&](const char *src) {
            ID3DBlob *b = nullptr;
            ID3D11PixelShader *s = nullptr;
            if (SUCCEEDED(D3DCompile(src, strlen(src), nullptr, nullptr, nullptr, "main", "ps_5_0", 0, 0, &b, nullptr)))
            {
                r.dev->CreatePixelShader(b->GetBufferPointer(), b->GetBufferSize(), nullptr, &s);
                b->Release();
            }
            return s;
        };
        ID3D11PixelShader *lit = ps(kLit), *ao = ps(kAO), *reader = ps(kReader);
        struct Target { ID3D11Texture2D *tex = nullptr; ID3D11RenderTargetView *rtv = nullptr; ID3D11ShaderResourceView *srv = nullptr; };
        auto target = [&](DXGI_FORMAT f) {
            Target t;
            D3D11_TEXTURE2D_DESC td = {};
            td.Width = 64; td.Height = 64; td.MipLevels = 1; td.ArraySize = 1; td.Format = f; td.SampleDesc.Count = 1;
            td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
            r.dev->CreateTexture2D(&td, nullptr, &t.tex);
            if (t.tex) { r.dev->CreateRenderTargetView(t.tex, nullptr, &t.rtv); r.dev->CreateShaderResourceView(t.tex, nullptr, &t.srv); }
            return t;
        };
        Target colour = target(DXGI_FORMAT_R16G16B16A16_FLOAT), velocity = target(DXGI_FORMAT_R16G16_FLOAT), factor = target(DXGI_FORMAT_R8_UNORM),
            z = target(DXGI_FORMAT_R32_FLOAT), aoOut = target(DXGI_FORMAT_R8_UNORM), out = target(DXGI_FORMAT_R32G32B32A32_FLOAT);
        D3D11_BUFFER_DESC bd = { 16, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
        ID3D11Buffer *cb = nullptr;
        r.dev->CreateBuffer(&bd, nullptr, &cb);
        const D3D11_VIEWPORT vp64 = { 0, 0, 64, 64, 0, 1 };
        const D3D11_RECT rect64 = { 0, 0, 64, 64 };
        auto begin = [&](ID3D11DeviceContext *c) {
            c->VSSetShader(r.vs, nullptr, 0); c->IASetInputLayout(nullptr); c->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            c->RSSetState(r.rs); c->OMSetDepthStencilState(nullptr, 0); c->RSSetViewports(1, &vp64); c->RSSetScissorRects(1, &rect64);
        };
        // one frame's lighting and AO pass, the colour target overwritten afterwards
        auto frame = [&](ID3D11DeviceContext *c, const float *rgb, bool shaderFirst) {
            begin(c);
            const float lc[4] = { rgb[0], rgb[1], rgb[2], 1 };
            c->UpdateSubresource(cb, 0, nullptr, lc, 0, 0);
            c->PSSetConstantBuffers(0, 1, &cb);
            ID3D11RenderTargetView *mrt[3] = { colour.rtv, velocity.rtv, factor.rtv };
            c->OMSetRenderTargets(3, mrt, nullptr);
            c->PSSetShader(lit, nullptr, 0);
            c->Draw(3, 0);
            const float seven[4] = { 7, 7, 7, 7 };
            c->ClearRenderTargetView(z.rtv, seven);
            c->OMSetRenderTargets(1, &aoOut.rtv, nullptr);
            ID3D11ShaderResourceView *none = nullptr;
            if (shaderFirst) c->PSSetShader(ao, nullptr, 0);
            c->PSSetShaderResources(0, 1, &factor.srv);
            c->PSSetShaderResources(2, 1, &factor.srv);
            c->PSSetShaderResources(80, 1, &z.srv);
            if (!shaderFirst) c->PSSetShader(ao, nullptr, 0);
            c->Draw(3, 0);
            c->PSSetShaderResources(80, 1, &none);
            const float red[4] = { 1, 0, 0, 1 };
            c->ClearRenderTargetView(colour.rtv, red);
        };
        auto readerDraw = [&](ID3D11DeviceContext *c, bool reset) {
            begin(c);
            c->OMSetRenderTargets(1, &out.rtv, nullptr);
            c->PSSetShader(reader, nullptr, 0);
            if (reset) { ID3D11ShaderResourceView *nulls[128] = {}; c->PSSetShaderResources(0, 128, nulls); }
            c->Draw(3, 0);
        };
        auto pixel = [&]() {
            D3D11_TEXTURE2D_DESC td; out.tex->GetDesc(&td);
            td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            ID3D11Texture2D *st = nullptr;
            float v[4] = { -9, -9, -9, -9 };
            if (SUCCEEDED(r.dev->CreateTexture2D(&td, nullptr, &st)))
            {
                r.ctx->CopyResource(st, out.tex);
                D3D11_MAPPED_SUBRESOURCE m;
                if (SUCCEEDED(r.ctx->Map(st, 0, D3D11_MAP_READ, 0, &m))) { memcpy(v, (const BYTE *)m.pData + 5 * m.RowPitch + 5 * 16, 16); r.ctx->Unmap(st, 0); }
                st->Release();
            }
            return std::vector<float>(v, v + 4);
        };
        auto is = [](const std::vector<float> &v, float a, float b, float c, float d) { return std::fabs(v[0] - a) < 1e-3f && std::fabs(v[1] - b) < 1e-3f && std::fabs(v[2] - c) < 1e-3f && std::fabs(v[3] - d) < 1e-3f; };
        // what a feed reader sees: nothing without the feed, the depth but no colour with the puddles switched off (F9)
        auto feedIs = [&](const std::vector<float> &v, float a, float b, float c) {
            return noFeed ? is(v, -1, -1, -1, -1) : puddlesOff ? is(v, 0, 0, 0, 7) : is(v, a, b, c, 7);
        };
        const bool made = lit && ao && reader && colour.rtv && z.srv && out.rtv && cb;
        Check(made, "scene feed test: shaders and targets made");
        if (made)
        {
            const float first[3] = { 0.25f, 0.5f, 0.75f }, next[3] = { 0.125f, 0.625f, 0.375f };
            frame(r.ctx, first, false);
            readerDraw(r.ctx, false);
            std::vector<float> v = pixel();
            snprintf(line, sizeof line, "scene feed: the reader sees %.3g %.3g %.3g depth %.3g (the frame's colour and depth copied at the AO pass)", v[0], v[1], v[2], v[3]);
            Check(feedIs(v, 0.25f, 0.5f, 0.75f), line);
            readerDraw(r.ctx, true);
            Check(feedIs(pixel(), 0.25f, 0.5f, 0.75f), "scene feed: bound again after the game resets all 128 slots");
            ID3D11DeviceContext *d1 = nullptr, *d2 = nullptr;
            r.dev->CreateDeferredContext(0, &d1);
            r.dev->CreateDeferredContext(0, &d2);
            frame(d1, next, true);
            readerDraw(d2, false);
            ID3D11CommandList *l1 = nullptr, *l2 = nullptr;
            d1->FinishCommandList(FALSE, &l1);
            d2->FinishCommandList(FALSE, &l2);
            r.ctx->ExecuteCommandList(l1, FALSE);
            r.ctx->ExecuteCommandList(l2, FALSE);
            l1->Release(); l2->Release(); d1->Release(); d2->Release();
            Check(feedIs(pixel(), 0.125f, 0.625f, 0.375f), "scene feed: deferred contexts, the AO pass's shader set before its inputs");
            // the colour copy's mip chain (ini FeedMips, default on): a reader asks the texture for its level count
            {
                const char *kLevels = "Texture2D<float4> g_txPrevScene : register(t120); float4 main(float4 p : SV_Position) : SV_Target"
                                      " { uint w, h, levels; g_txPrevScene.GetDimensions(0, w, h, levels); return float4(levels, w, h, 0); }";
                ID3D11PixelShader *lv = ps(kLevels);
                if (lv)
                {
                    begin(r.ctx);
                    r.ctx->OMSetRenderTargets(1, &out.rtv, nullptr);
                    r.ctx->PSSetShader(lv, nullptr, 0);
                    r.ctx->Draw(3, 0);
                    const std::vector<float> lvl = pixel();
                    const float want = noMips ? 1.0f : 7.0f;
                    snprintf(line, sizeof line, "scene feed: the colour copy has %g mip levels (%g wanted for 64 x 64, %s)", lvl[0], want, noMips ? "FeedMips=0" : "a full chain");
                    Check(noFeed || puddlesOff ? true : lvl[0] == want, line);
                    lv->Release();
                }
                // and every level holds the picture, however the levels are made (FeedMips=1: a compute pass of the DLL per
                // level, 2: the runtime's GenerateMips): the frame is one colour, so the smallest level is that colour too
                const char *kLast = "Texture2D<float4> g_txPrevScene : register(t120); float4 main(float4 p : SV_Position) : SV_Target"
                                    " { uint w, h, levels; g_txPrevScene.GetDimensions(0, w, h, levels);"
                                    " return float4(g_txPrevScene.Load(int3(0, 0, levels - 1)).rgb, g_txPrevScene.Load(int3(0, 0, min(levels - 1, 1))).g); }";
                ID3D11PixelShader *last = ps(kLast);
                if (last)
                {
                    begin(r.ctx);
                    r.ctx->OMSetRenderTargets(1, &out.rtv, nullptr);
                    r.ctx->PSSetShader(last, nullptr, 0);
                    r.ctx->Draw(3, 0);
                    const std::vector<float> c = pixel();
                    snprintf(line, sizeof line, "scene feed: the colour copy's smallest level holds %.3g %.3g %.3g and its second level's green is %.3g (the frame's 0.125 0.625 0.375)",
                        c[0], c[1], c[2], c[3]);
                    Check(noFeed || puddlesOff ? true : is(c, 0.125f, 0.625f, 0.375f, 0.625f), line);
                    last->Release();
                }
            }
        }
        // Fog for the water's reflections: the volumetric fog's composite (a pixel shader naming g_txFogColor and g_txZMS)
        // draws with its fog colour at t1, its amount at t2 and its CB_INSTANCE (a dynamic buffer, as the game's) at b4;
        // later a shader that declares t118/t119 reads those textures there and a copy of the constants at b13: right
        // away, after the game resets all 128 slots, and on deferred contexts. Nothing without the feed (ini Feed=0).
        {
            const char *kComposite = "Texture2D g_txFogColor : register(t1); Texture2D g_txFogMask : register(t2); Texture2DMS<float> g_txZMS : register(t3);"
                                     "cbuffer CB_INSTANCE : register(b4) { float4 c[9]; };"
                                     "float4 main(float4 p : SV_Position) : SV_Target { return c[0].w * float4(g_txFogColor.Load(int3(0, 0, 0)).rgb,"
                                     " g_txFogMask.Load(int3(0, 0, 0)).x) + g_txZMS.Load(int2(0, 0), 0) * c[1].x; }";
            const char *kWater = "Texture2D<float4> g_txFogC : register(t118); Texture2D<float4> g_txFogM : register(t119); cbuffer F : register(b13) { float4 f[9]; };"
                                 "float4 main(float4 p : SV_Position) : SV_Target { uint w, h; g_txFogC.GetDimensions(w, h);"
                                 " return w ? float4(g_txFogC.Load(int3(0, 0, 0)).r, g_txFogM.Load(int3(0, 0, 0)).x, f[0].w, f[7].w) : float4(-1, -1, -1, -1); }";
            ID3D11PixelShader *comp = ps(kComposite), *water = ps(kWater);
            Target fogC = target(DXGI_FORMAT_R16G16B16A16_FLOAT), fogM = target(DXGI_FORMAT_R16G16B16A16_FLOAT), sink = target(DXGI_FORMAT_R16G16B16A16_FLOAT);
            D3D11_BUFFER_DESC cd = { 144, D3D11_USAGE_DYNAMIC, D3D11_BIND_CONSTANT_BUFFER, D3D11_CPU_ACCESS_WRITE, 0, 0 };
            ID3D11Buffer *compCB = nullptr;
            r.dev->CreateBuffer(&cd, nullptr, &compCB);
            // one composite draw: fog colour red channel `fog`, amount `amount`, density c0.w, start depth c7.w
            auto composite = [&](ID3D11DeviceContext *c, float fog, float amount, float density, float start) {
                begin(c);
                const float fc[4] = { fog, 0.5f, 0.5f, 1 }, fm[4] = { amount, 0, 0, 1 };
                c->ClearRenderTargetView(fogC.rtv, fc);
                c->ClearRenderTargetView(fogM.rtv, fm);
                D3D11_MAPPED_SUBRESOURCE m;
                if (SUCCEEDED(c->Map(compCB, 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) { float k[36] = {}; k[3] = density; k[31] = start; memcpy(m.pData, k, sizeof k); c->Unmap(compCB, 0); }
                c->OMSetRenderTargets(1, &sink.rtv, nullptr);
                c->PSSetShader(comp, nullptr, 0);
                c->PSSetShaderResources(1, 1, &fogC.srv);
                c->PSSetShaderResources(2, 1, &fogM.srv);
                c->PSSetConstantBuffers(4, 1, &compCB);
                c->Draw(3, 0);
                ID3D11ShaderResourceView *none[2] = {};
                c->PSSetShaderResources(1, 2, none);
            };
            auto waterDraw = [&](ID3D11DeviceContext *c, bool reset) {
                begin(c);
                c->OMSetRenderTargets(1, &out.rtv, nullptr);
                c->PSSetShader(water, nullptr, 0);
                if (reset) { ID3D11ShaderResourceView *nulls[128] = {}; c->PSSetShaderResources(0, 128, nulls); }
                c->Draw(3, 0);
            };
            const bool fogMade = comp && water && fogC.srv && fogM.srv && sink.rtv && compCB;
            Check(fogMade, "water fog test: shaders, targets and the composite's buffer made");
            if (fogMade)
            {
                // the game records its frame on deferred contexts (the immediate context's Draw slot is the runtime's own
                // after its first call): the composite on one, the water on the immediate context
                ID3D11DeviceContext *d0 = nullptr;
                r.dev->CreateDeferredContext(0, &d0);
                composite(d0, 0.25f, 0.6f, 0.5f, 3.0f);
                ID3D11CommandList *l0 = nullptr;
                d0->FinishCommandList(FALSE, &l0);
                r.ctx->ExecuteCommandList(l0, FALSE);
                l0->Release(); d0->Release();
                waterDraw(r.ctx, false);
                std::vector<float> v = pixel();
                snprintf(line, sizeof line, "water fog: the water reads fog %.3g, amount %.3g, density %.3g, start %.3g at t118/t119/b13 (the composite's inputs)", v[0], v[1], v[2], v[3]);
                Check(noFeed ? is(v, -1, -1, -1, -1) : is(v, 0.25f, 0.6f, 0.5f, 3.0f), line);
                waterDraw(r.ctx, true);
                Check(noFeed ? is(pixel(), -1, -1, -1, -1) : is(pixel(), 0.25f, 0.6f, 0.5f, 3.0f), "water fog: bound again after the game resets all 128 slots");
                ID3D11DeviceContext *d1 = nullptr, *d2 = nullptr;
                r.dev->CreateDeferredContext(0, &d1);
                r.dev->CreateDeferredContext(0, &d2);
                composite(d1, 0.125f, 0.3f, 0.75f, 5.0f);
                waterDraw(d2, false);
                ID3D11CommandList *l1 = nullptr, *l2 = nullptr;
                d1->FinishCommandList(FALSE, &l1);
                d2->FinishCommandList(FALSE, &l2);
                r.ctx->ExecuteCommandList(l1, FALSE);
                r.ctx->ExecuteCommandList(l2, FALSE);
                l1->Release(); l2->Release(); d1->Release(); d2->Release();
                v = pixel();
                snprintf(line, sizeof line, "water fog: deferred contexts, the composite's next frame read by the water: %.3g %.3g %.3g %.3g", v[0], v[1], v[2], v[3]);
                Check(noFeed ? is(v, -1, -1, -1, -1) : is(v, 0.125f, 0.3f, 0.75f, 5.0f), line);
            }
            for (ID3D11DeviceChild *x : std::initializer_list<ID3D11DeviceChild *>{ comp, water, compCB, fogC.tex, fogC.rtv, fogC.srv, fogM.tex, fogM.rtv, fogM.srv, sink.tex, sink.rtv, sink.srv }) if (x) x->Release();
        }
        // Bounce light: an AO pass whose shader writes a second output (here: this frame's lit colour from t120, doubled)
        // gets the DLL's texture as render target 1, but only once the AO apply pass (g_txMask at t1, g_vSSAOColor) has
        // shown which target is the AO pass's own; a shader that declares t122 reads it the next frame; the game's next
        // OMSetRenderTargets takes it off again; an AO pass without the second output never gets it; 250 ms after the
        // last AO pass nothing is bound.
        const char *kAOGI = "Texture2D g_txDither : register(t0); Texture2D g_txFactor : register(t2); Texture2D g_txZ : register(t80); Texture2D g_txScene : register(t120);"
                            "struct O { float4 ao : SV_Target0; float4 gi : SV_Target1; };"
                            "O main(float4 p : SV_Position) { O o; o.ao = g_txDither.Load(int3(0, 0, 0)) + g_txFactor.Load(int3(p.xy, 0)) * g_txZ.Load(int3(p.xy, 0)).x;"
                            " o.gi = float4(g_txScene.Load(int3(p.xy, 0)).rgb * 2, 1); return o; }";
        const char *kApply = "cbuffer CB_INSTANCE : register(b4) { float4 g_vSSAOColor; }; Texture2D g_txMask : register(t1); Texture2D g_txFactor : register(t2);"
                             "float4 main(float4 p : SV_Position) : SV_Target { return float4(g_vSSAOColor.rgb, g_txMask.Load(int3(p.xy, 0)).x * g_txFactor.Load(int3(p.xy, 0)).x); }";
        const char *kGIReader = "Texture2D<float4> g_txBounce : register(t122); Texture2D<float> g_txPrevZ : register(t121);"
                                "float4 main(float4 p : SV_Position) : SV_Target { uint w, h; g_txBounce.GetDimensions(w, h);"
                                " return w ? float4(g_txBounce.Load(int3(p.xy, 0)).rgb, g_txPrevZ.Load(int3(p.xy, 0))) : float4(-1, -1, -1, -1); }";
        ID3D11PixelShader *aoGI = ps(kAOGI), *apply = ps(kApply), *giReader = ps(kGIReader);
        Target aoMask = target(aoHalfMode || aoFullMode ? DXGI_FORMAT_R8_UNORM : DXGI_FORMAT_R16_FLOAT); // (aohalf, aofull: the game's format)
        const bool madeGI = made && aoGI && apply && giReader && aoMask.rtv;
        Check(madeGI, "bounce light test: shaders and targets made");
        if (madeGI)
        {
            ID3D11RenderTargetView *probe[2] = {};
            ID3D11DepthStencilView *probeDsv = nullptr;
            // what is bound as render target 1 right now (released at once: only its presence matters)
            auto hasSecond = [&](ID3D11DeviceContext *c) {
                c->OMGetRenderTargets(2, probe, &probeDsv);
                const bool has = probe[1] != nullptr;
                for (auto *v : probe) if (v) v->Release();
                if (probeDsv) probeDsv->Release();
                probe[0] = probe[1] = nullptr; probeDsv = nullptr;
                return has;
            };
            bool duringAO = false, duringApply = true;
            // AO at half size (shadow_test aohalf, ini AOHalf=1): the width of render target 0 while the AO pass draws, and
            // what the apply pass reads at t1 (its width, and whether it is the AO pass's own target)
            UINT aoRT0Width = 0, applyT1Width = 0;
            bool applyT1IsMask = true;
            auto widthOf = [](ID3D11Resource *res) {
                ID3D11Texture2D *t = nullptr;
                D3D11_TEXTURE2D_DESC d = {};
                if (res && SUCCEEDED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&t)) && t) { t->GetDesc(&d); t->Release(); }
                return d.Width;
            };
            // one frame: lighting, the AO pass with the second output (targets first, or its shader first), the apply pass
            auto frameGI = [&](ID3D11DeviceContext *c, const float *rgb, bool shaderFirst) {
                begin(c);
                const float lc[4] = { rgb[0], rgb[1], rgb[2], 1 };
                c->UpdateSubresource(cb, 0, nullptr, lc, 0, 0);
                c->PSSetConstantBuffers(0, 1, &cb);
                ID3D11RenderTargetView *mrt[3] = { colour.rtv, velocity.rtv, factor.rtv };
                c->OMSetRenderTargets(3, mrt, nullptr);
                c->PSSetShader(lit, nullptr, 0);
                c->Draw(3, 0);
                const float seven[4] = { 7, 7, 7, 7 };
                c->ClearRenderTargetView(z.rtv, seven);
                if (shaderFirst) c->PSSetShader(aoGI, nullptr, 0);
                c->OMSetRenderTargets(1, &aoMask.rtv, nullptr);
                c->PSSetShaderResources(0, 1, &factor.srv);
                c->PSSetShaderResources(2, 1, &factor.srv);
                c->PSSetShaderResources(80, 1, &z.srv);
                if (!shaderFirst) c->PSSetShader(aoGI, nullptr, 0);
                duringAO = hasSecond(c);
                if (aoHalfMode || aoFullMode)
                {
                    ID3D11RenderTargetView *rt0 = nullptr;
                    c->OMGetRenderTargets(1, &rt0, nullptr);
                    ID3D11Resource *res = nullptr;
                    if (rt0) { rt0->GetResource(&res); rt0->Release(); }
                    aoRT0Width = widthOf(res);
                    if (res) res->Release();
                }
                c->Draw(3, 0);
                ID3D11ShaderResourceView *none = nullptr;
                c->PSSetShaderResources(80, 1, &none);
                // the apply pass: back onto the lit colour, the AO target read at t1
                c->OMSetRenderTargets(1, &colour.rtv, nullptr);
                duringApply = hasSecond(c);
                c->PSSetShaderResources(1, 1, &aoMask.srv);
                c->PSSetShader(apply, nullptr, 0);
                c->PSSetConstantBuffers(4, 1, &cb);
                if (aoHalfMode || aoFullMode)
                {
                    ID3D11ShaderResourceView *t1 = nullptr;
                    c->PSGetShaderResources(1, 1, &t1);
                    ID3D11Resource *res = nullptr;
                    if (t1) { t1->GetResource(&res); t1->Release(); }
                    applyT1Width = widthOf(res);
                    applyT1IsMask = res == aoMask.tex;
                    if (res) res->Release();
                }
                c->Draw(3, 0);
                c->PSSetShaderResources(1, 1, &none);
            };
            auto giDraw = [&](ID3D11DeviceContext *c) {
                begin(c);
                c->OMSetRenderTargets(1, &out.rtv, nullptr);
                c->PSSetShader(giReader, nullptr, 0);
                c->Draw(3, 0);
            };
            const float a[3] = { 0.25f, 0.5f, 0.75f }, b[3] = { 0.125f, 0.25f, 0.375f }, c3[3] = { 0.375f, 0.125f, 0.25f };
            frameGI(r.ctx, a, false);
            Check(!duringAO, "bounce light: no second target before the apply pass has shown the AO pass's own");
            giDraw(r.ctx);
            Check(is(pixel(), -1, -1, -1, -1), "bounce light: a reader sees nothing bound before the AO pass wrote it");
            frameGI(r.ctx, b, false);
            Check(noGI ? !duringAO : duringAO, noGI ? "bounce light: off (ini), no second target" : "bounce light: bound as render target 1 of the AO pass, the next frame");
            Check(!duringApply, "bounce light: taken off again by the game's next OMSetRenderTargets");
            if (aoHalfMode)
            {
                snprintf(line, sizeof line, "AO at half size: the AO pass draws into a %u wide target (the game's is 64 wide)", aoRT0Width);
                Check(aoRT0Width == 32, line);
                snprintf(line, sizeof line, "AO at half size: the apply pass reads a %u wide texture of this DLL at t1 (not the AO pass's own target)", applyT1Width);
                Check(applyT1Width == 64 && !applyT1IsMask, line);
                D3D11_VIEWPORT vpNow[2] = {};
                UINT nvp = 2;
                r.ctx->RSGetViewports(&nvp, vpNow);
                snprintf(line, sizeof line, "AO at half size: the game's viewport is back after the AO pass (%u of %g x %g)", nvp, nvp ? vpNow[0].Width : 0.f, nvp ? vpNow[0].Height : 0.f);
                Check(nvp == 1 && vpNow[0].Width == 64 && vpNow[0].Height == 64, line);
                ID3D11ShaderResourceView *t1 = nullptr;
                r.ctx->PSGetShaderResources(1, 1, &t1);
                Check(t1 == nullptr, "AO at half size: t1 as the game left it after the apply pass (nothing)");
                if (t1) t1->Release();
            }
            if (aoFullMode)
            {
                // ini AOHalf=0 (half size is the default): the game's own R8 target and t1, untouched
                snprintf(line, sizeof line, "AO at full size (ini AOHalf=0): the AO pass draws into the game's own %u wide target", aoRT0Width);
                Check(aoRT0Width == 64, line);
                Check(applyT1Width == 64 && applyT1IsMask, "AO at full size: the apply pass reads the AO pass's own target at t1");
            }
            giDraw(r.ctx);
            std::vector<float> v = pixel();
            snprintf(line, sizeof line, "bounce light: the reader sees %.3g %.3g %.3g depth %.3g (twice this frame's lit colour, as the AO pass wrote it)", v[0], v[1], v[2], v[3]);
            Check(noGI ? is(v, -1, -1, -1, -1) : is(v, 0.25f, 0.5f, 0.75f, 7), line);
            // the plain AO pass (no second output): never a second target
            begin(r.ctx);
            r.ctx->OMSetRenderTargets(1, &aoMask.rtv, nullptr);
            r.ctx->PSSetShader(ao, nullptr, 0);
            Check(!hasSecond(r.ctx), "bounce light: an AO pass without the second output gets no second target");
            // the AO pass's shader set before its target (dump immediate: the frame the DLL records, see the end)
            if (dumpMode && dumpImmediate) Sleep(1300);
            frameGI(r.ctx, c3, true);
            Check(noGI ? !duringAO : duringAO, "bounce light: bound too when the AO pass's shader is set before its target");
            if (aoHalfMode) Check(aoRT0Width == 32 && applyT1Width == 64 && !applyT1IsMask, "AO at half size: also when the AO pass's shader is set before its target");
            giDraw(r.ctx);
            Check(noGI ? is(pixel(), -1, -1, -1, -1) : is(pixel(), 0.75f, 0.25f, 0.5f, 7), "bounce light: the reader sees that frame's");
            // deferred contexts: the frame on one, the reader on another, executed in that order (dump: the frame the DLL
            // records, on d1, see the end)
            if (dumpMode && !dumpImmediate) Sleep(1300);
            ID3D11DeviceContext *d1 = nullptr, *d2 = nullptr;
            r.dev->CreateDeferredContext(0, &d1);
            r.dev->CreateDeferredContext(0, &d2);
            frameGI(d1, a, true);
            giDraw(d2);
            ID3D11CommandList *l1 = nullptr, *l2 = nullptr;
            d1->FinishCommandList(FALSE, &l1);
            d2->FinishCommandList(FALSE, &l2);
            r.ctx->ExecuteCommandList(l1, FALSE);
            r.ctx->ExecuteCommandList(l2, FALSE);
            l1->Release(); l2->Release(); d1->Release(); d2->Release();
            Check(noGI ? is(pixel(), -1, -1, -1, -1) : is(pixel(), 0.5f, 1.0f, 1.5f, 7), "bounce light: deferred contexts");
            // blend states: the game drawing its one-channel AO target with red only would leave the second target red
            // alone: the AO pass then draws with a copy of the game's state that writes the second target plainly (the
            // first as the game's), and the game's own state is back once it moves on
            D3D11_BLEND_DESC bdesc = {};
            for (auto &t : bdesc.RenderTarget)
            {
                t.SrcBlend = t.SrcBlendAlpha = D3D11_BLEND_ONE; t.DestBlend = t.DestBlendAlpha = D3D11_BLEND_ZERO;
                t.BlendOp = t.BlendOpAlpha = D3D11_BLEND_OP_ADD; t.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
            }
            bdesc.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_RED;
            ID3D11BlendState *redOnly = nullptr;
            r.dev->CreateBlendState(&bdesc, &redOnly);
            Check(redOnly != nullptr, "bounce light test: red-only blend state made");
            if (redOnly)
            {
                // what the context draws with now: its second target written plainly, its first red only
                auto blendNow = [&](bool &secondPlain, bool &firstRed) {
                    ID3D11BlendState *bs = nullptr;
                    FLOAT f[4];
                    UINT m = 0;
                    r.ctx->OMGetBlendState(&bs, f, &m);
                    D3D11_BLEND_DESC d = {};
                    if (bs) bs->GetDesc(&d); else d.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
                    const D3D11_RENDER_TARGET_BLEND_DESC &t1 = d.RenderTarget[d.IndependentBlendEnable ? 1 : 0];
                    secondPlain = !t1.BlendEnable && t1.RenderTargetWriteMask == D3D11_COLOR_WRITE_ENABLE_ALL;
                    firstRed = d.RenderTarget[0].RenderTargetWriteMask == D3D11_COLOR_WRITE_ENABLE_RED;
                    const bool isRed = bs == redOnly;
                    if (bs) bs->Release();
                    return isRed;
                };
                // the game's state set first, then the AO pass: bound, drawn with the copy, the reader gets all three channels
                begin(r.ctx);
                const float lc[4] = { 0.125f, 0.25f, 0.375f, 1 };
                r.ctx->UpdateSubresource(cb, 0, nullptr, lc, 0, 0);
                r.ctx->PSSetConstantBuffers(0, 1, &cb);
                ID3D11RenderTargetView *mrt[3] = { colour.rtv, velocity.rtv, factor.rtv };
                r.ctx->OMSetRenderTargets(3, mrt, nullptr);
                r.ctx->PSSetShader(lit, nullptr, 0);
                r.ctx->Draw(3, 0);
                r.ctx->OMSetBlendState(redOnly, nullptr, 0xffffffff);
                r.ctx->OMSetRenderTargets(1, &aoMask.rtv, nullptr);
                r.ctx->PSSetShaderResources(2, 1, &factor.srv);
                r.ctx->PSSetShaderResources(80, 1, &z.srv);
                r.ctx->PSSetShader(aoGI, nullptr, 0);
                bool secondPlain = false, firstRed = false;
                const bool gameState = blendNow(secondPlain, firstRed);
                Check(noGI ? (!hasSecond(r.ctx) && gameState) : (hasSecond(r.ctx) && !gameState && secondPlain && firstRed),
                    noGI ? "bounce light: off (ini), the game's red-only blend state untouched" : "bounce light: under the game's red-only blend state, bound and drawn with a copy (second target plain, first still red only)");
                r.ctx->Draw(3, 0);
                ID3D11ShaderResourceView *none = nullptr;
                r.ctx->PSSetShaderResources(80, 1, &none);
                r.ctx->OMSetRenderTargets(1, &colour.rtv, nullptr);
                Check(blendNow(secondPlain, firstRed), "bounce light: the game's own blend state is back once it moves on");
                r.ctx->OMSetBlendState(nullptr, nullptr, 0xffffffff);
                giDraw(r.ctx);
                Check(noGI ? is(pixel(), -1, -1, -1, -1) : is(pixel(), 0.25f, 0.5f, 0.75f, 7), "bounce light: written in all three channels under it");
                // the game changes its blend state while the AO pass is set up: the copy follows
                begin(r.ctx);
                r.ctx->OMSetRenderTargets(1, &aoMask.rtv, nullptr);
                r.ctx->PSSetShader(aoGI, nullptr, 0);
                r.ctx->OMSetBlendState(redOnly, nullptr, 0xffffffff);
                const bool follows = !blendNow(secondPlain, firstRed) && secondPlain && firstRed && hasSecond(r.ctx);
                Check(noGI ? true : follows, "bounce light: a blend state set after the targets gets its copy too");
                r.ctx->OMSetRenderTargets(1, &out.rtv, nullptr);
                r.ctx->OMSetBlendState(nullptr, nullptr, 0xffffffff);
                redOnly->Release();
            }
            // the AO pass stops: 250 ms later a reader gets nothing
            Sleep(300);
            giDraw(r.ctx);
            Check(is(pixel(), -1, -1, -1, -1), "bounce light: nothing bound 250 ms after the last AO pass");
            // the dump (shadow_test dump): the AO pass recorded a second after the first one was the frame with the
            // colour `want` (on the deferred context d1, or with `immediate` on the immediate context): its files hold
            // that frame's lit colour, depth, factor, AO, twice the colour as the bounce light, and the constants
            if (dumpMode)
            {
                const float *want = dumpImmediate ? c3 : a;
                std::wstring manifest;
                for (int i = 0; i < 200 && manifest.empty(); i++) { manifest = FindDumpFile(L"manifest.txt"); if (manifest.empty()) Sleep(50); }
                Check(!manifest.empty(), dumpImmediate ? "dump: written (recorded on the immediate context)" : "dump: written (recorded on a deferred context, read back after its command list ran)");
                const std::string text = ReadTextFile(manifest);
                Check(text.find("inputs recorded on context") != std::string::npos && text.find("outputs recorded on context") != std::string::npos &&
                    text.find(dumpImmediate ? "(immediate)" : "(deferred)") != std::string::npos, "dump: the manifest names the inputs and the outputs and the context's kind");
                auto half4 = [](const DumpFile &d, int x, int y, float out[4]) {
                    const BYTE *p = d.data.data() + (size_t)y * d.pitch + x * 8;
                    for (int c = 0; c < 4; c++) { uint16_t h; memcpy(&h, p + c * 2, 2); out[c] = HalfToFloat(h); }
                };
                auto near3 = [](const float *pv, const float *w, float scale) { return std::fabs(pv[0] - w[0] * scale) < 2e-3f && std::fabs(pv[1] - w[1] * scale) < 2e-3f && std::fabs(pv[2] - w[2] * scale) < 2e-3f; };
                DumpFile dScene, dDepth, dGi, dAo, dFactor, dDither, dB0a, dB0b;
                float pv[4] = {};
                const bool sceneOk = ReadDumpFile(FindDumpFile(L"scene.bin"), dScene) && dScene.kind == 1 && dScene.w == 64 && dScene.h == 64 && dScene.fmt == DXGI_FORMAT_R16G16B16A16_FLOAT &&
                    dScene.view == DXGI_FORMAT_R16G16B16A16_FLOAT && dScene.data.size() == (size_t)dScene.pitch * 64;
                Check(sceneOk, "dump: scene.bin is the 64 x 64 RGBA16F lit colour");
                if (sceneOk) half4(dScene, 5, 5, pv);
                snprintf(line, sizeof line, "dump: the scene file holds that frame's lit colour %.3g %.3g %.3g (%.3g %.3g %.3g)", pv[0], pv[1], pv[2], want[0], want[1], want[2]);
                Check(sceneOk && near3(pv, want, 1.0f), line);
                const bool depthOk = ReadDumpFile(FindDumpFile(L"depth.bin"), dDepth) && dDepth.kind == 1 && dDepth.w == 64 && dDepth.fmt == DXGI_FORMAT_R32_FLOAT && dDepth.data.size() == (size_t)dDepth.pitch * 64;
                float dz = 0;
                if (depthOk) memcpy(&dz, dDepth.data.data() + 5 * dDepth.pitch + 5 * 4, 4);
                snprintf(line, sizeof line, "dump: depth.bin is the 64 x 64 R32 depth, %g at (5, 5)", dz);
                Check(depthOk && dz == 7.0f, line);
                const bool giOk = ReadDumpFile(FindDumpFile(L"gi.bin"), dGi) && dGi.kind == 1 && dGi.w == 64 && dGi.fmt == DXGI_FORMAT_R16G16B16A16_FLOAT && dGi.data.size() == (size_t)dGi.pitch * 64;
                if (giOk) half4(dGi, 5, 5, pv);
                snprintf(line, sizeof line, "dump: gi.bin holds the bounce light the pass wrote, %.3g %.3g %.3g (twice the colour)", pv[0], pv[1], pv[2]);
                Check(giOk && near3(pv, want, 2.0f), line);
                const bool aoOk = ReadDumpFile(FindDumpFile(L"ao.bin"), dAo) && dAo.kind == 1 && dAo.w == 64 && dAo.fmt == DXGI_FORMAT_R16_FLOAT && dAo.view == DXGI_FORMAT_R16_FLOAT && dAo.data.size() == (size_t)dAo.pitch * 64;
                uint16_t aoHalf = 0;
                if (aoOk) memcpy(&aoHalf, dAo.data.data() + 5 * dAo.pitch + 5 * 2, 2);
                snprintf(line, sizeof line, "dump: ao.bin is the pass's own R16 target, %g at (5, 5) (dither 1 + factor 1 x depth 7)", HalfToFloat(aoHalf));
                Check(aoOk && HalfToFloat(aoHalf) == 8.0f, line);
                const bool factorOk = ReadDumpFile(FindDumpFile(L"factor.bin"), dFactor) && dFactor.kind == 1 && dFactor.w == 64 && dFactor.fmt == DXGI_FORMAT_R8_UNORM && dFactor.data.size() == (size_t)dFactor.pitch * 64;
                Check(factorOk && dFactor.data[5 * dFactor.pitch + 5] == 255, "dump: factor.bin is the R8 g_txFactor, 1.0");
                Check(ReadDumpFile(FindDumpFile(L"dither.bin"), dDither) && dDither.kind == 1 && dDither.w == 64 && dDither.fmt == DXGI_FORMAT_R8_UNORM, "dump: dither.bin is the texture at t0");
                float k[4] = {};
                const bool b0Ok = ReadDumpFile(FindDumpFile(L"A_b0.bin"), dB0a) && dB0a.kind == 2 && dB0a.w == 16 && dB0a.data.size() == 16;
                if (b0Ok) memcpy(k, dB0a.data.data(), 16);
                snprintf(line, sizeof line, "dump: A_b0.bin holds the constants at the setup, %.3g %.3g %.3g %.3g", k[0], k[1], k[2], k[3]);
                Check(b0Ok && near3(k, want, 1.0f) && k[3] == 1.0f, line);
                const bool b0bOk = ReadDumpFile(FindDumpFile(L"B_b0.bin"), dB0b) && dB0b.kind == 2 && dB0b.data.size() == 16;
                if (b0bOk) memcpy(k, dB0b.data.data(), 16);
                Check(b0bOk && near3(k, want, 1.0f), "dump: B_b0.bin holds the same constants after the pass");
            }
        }
        for (ID3D11PixelShader *s : { aoGI, apply, giReader }) if (s) s->Release();
        if (aoMask.srv) aoMask.srv->Release();
        if (aoMask.rtv) aoMask.rtv->Release();
        if (aoMask.tex) aoMask.tex->Release();

        for (ID3D11PixelShader *s : { lit, ao, reader }) if (s) s->Release();
        for (Target *t : { &colour, &velocity, &factor, &z, &aoOut, &out }) { if (t->srv) t->srv->Release(); if (t->rtv) t->rtv->Release(); if (t->tex) t->tex->Release(); }
        if (cb) cb->Release();
    }

    // Dev switches, the stock twins (after "shadow_test maketable"): each changed shader draws its own colour, or its
    // original's while its group is switched to stock (F8 every changed shader, F11 the AO pass's group); a shader the
    // table does not know always draws its own; on a deferred context too.
    if (twins)
    {
        ID3DBlob *blob[5] = {};
        ID3D11PixelShader *ps[5] = {};
        bool made = true;
        for (int i = 0; i < 5; i++)
        {
            blob[i] = CompilePS(kTwinShaders[i]);
            made = made && blob[i] && SUCCEEDED(r.dev->CreatePixelShader(blob[i]->GetBufferPointer(), blob[i]->GetBufferSize(), nullptr, &ps[i]));
        }
        // a changed vertex shader (the table knows it): its original in place of it under F8
        ID3DBlob *cvsBlob = CompileVS(kTwinVS);
        ID3D11VertexShader *cvs = nullptr;
        made = made && cvsBlob && SUCCEEDED(r.dev->CreateVertexShader(cvsBlob->GetBufferPointer(), cvsBlob->GetBufferSize(), nullptr, &cvs));
        D3D11_TEXTURE2D_DESC td = {};
        td.Width = 16; td.Height = 16; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R32G32B32A32_FLOAT; td.SampleDesc.Count = 1;
        td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET;
        D3D11_TEXTURE2D_DESC sd = td;
        sd.Usage = D3D11_USAGE_STAGING; sd.BindFlags = 0; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ID3D11Texture2D *rt = nullptr, *st = nullptr;
        ID3D11RenderTargetView *rtv = nullptr;
        made = made && SUCCEEDED(r.dev->CreateTexture2D(&td, nullptr, &rt)) && SUCCEEDED(r.dev->CreateRenderTargetView(rt, nullptr, &rtv)) && SUCCEEDED(r.dev->CreateTexture2D(&sd, nullptr, &st));
        Check(made, "stock twins test: shaders and target made");
        if (made)
        {
            auto drawWith = [&](ID3D11DeviceContext *c, ID3D11PixelShader *s, ID3D11VertexShader *v = nullptr) {
                const D3D11_VIEWPORT vp = { 0, 0, 16, 16, 0, 1 };
                const D3D11_RECT sc = { 0, 0, 16, 16 };
                c->VSSetShader(v ? v : r.vs, nullptr, 0); c->IASetInputLayout(nullptr); c->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                c->RSSetState(r.rs); c->OMSetDepthStencilState(nullptr, 0); c->RSSetViewports(1, &vp); c->RSSetScissorRects(1, &sc);
                c->OMSetRenderTargets(1, &rtv, nullptr);
                c->PSSetShader(s, nullptr, 0);
                c->Draw(3, 0);
            };
            auto red = [&]() {
                float v = -1;
                r.ctx->CopyResource(st, rt);
                D3D11_MAPPED_SUBRESOURCE m;
                if (SUCCEEDED(r.ctx->Map(st, 0, D3D11_MAP_READ, 0, &m))) { memcpy(&v, (const BYTE *)m.pData + 5 * m.RowPitch + 5 * 16, 4); r.ctx->Unmap(st, 0); }
                return v;
            };
            const float wantOther = stockAll ? 5.f : 1.f, wantAO = stockAll || stockAO ? 13.f : 9.f;
            drawWith(r.ctx, ps[0]);
            float v = red();
            snprintf(line, sizeof line, "stock twins: a changed shader draws %g (%s)", v, stockAll ? "its original, every effect switched off" : "itself");
            Check(v == wantOther, line);
            drawWith(r.ctx, ps[2]);
            v = red();
            snprintf(line, sizeof line, "stock twins: a changed AO pass shader draws %g (%s)", v, stockAll || stockAO ? "its original: the game's own AO" : "itself");
            Check(v == wantAO, line);
            drawWith(r.ctx, ps[4]);
            Check(red() == 17.f, "stock twins: a shader the table does not know draws itself");
            const float zero[4] = {};
            r.ctx->ClearRenderTargetView(rtv, zero);
            drawWith(r.ctx, ps[4], cvs);
            v = red();
            snprintf(line, sizeof line, "stock twins: a changed vertex shader draws %g (%s)", v, stockAll ? "its original: the triangle is back on screen" : "itself: nothing on screen");
            Check(v == (stockAll ? 17.f : 0.f), line);
            ID3D11DeviceContext *d = nullptr;
            ID3D11CommandList *l = nullptr;
            r.dev->CreateDeferredContext(0, &d);
            if (d)
            {
                drawWith(d, ps[2]);
                d->FinishCommandList(FALSE, &l);
                r.ctx->ExecuteCommandList(l, FALSE);
                if (l) l->Release();
                d->Release();
            }
            Check(red() == wantAO, "stock twins: the same on a deferred context");
        }
        for (ID3D11PixelShader *s : ps) if (s) s->Release();
        if (cvs) cvs->Release();
        if (cvsBlob) cvsBlob->Release();
        for (ID3DBlob *b : blob) if (b) b->Release();
        if (rtv) rtv->Release();
        if (rt) rt->Release();
        if (st) st->Release();
    }

    printf(g_failures ? "%d check(s) FAILED\n" : "all checks passed\n", g_failures);
    return g_failures ? 1 : 0;
}
