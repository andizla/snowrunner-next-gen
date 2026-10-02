// sss_lab: contact shadows offline on an F7 dump, through the DLL's own compute shaders (out\obj\g_csSSSSetup.h and
// g_csSSS.h, built from src\sss). Reads the dump's linear depth (the AO pass's t80 as copied, R32F), its scene colour
// (R11G11B10F) and the AO pass's b1 (CB_GLOBAL_CAMERA) and b2 (CB_GLOBAL_SCENE); runs the setup and the up to 8
// indirect dispatches as hid.dll does; writes <out>_mask.png (1 lit = white) and <out>_overlay.png (the scene, tone
// mapped, darkened where the mask is), and prints the sun's point, the dispatch list and the time per run.
// usage: sss_lab <dump dir> <dump prefix> <out prefix> [warp] [cover] [r32] [repeat=1] [thickness=0.005]
//        [bilinear=0.02] [contrast=4] [maxdepth=200] [sky=3000]
// cover: the variant without early out that writes the thread index (0 .. 63/64): a pixel still at the clear value 1
// was missed by every dispatch. r32: an R32F mask instead of R8. repeat=n: the whole pass n times; the wall clock over
// runs 2..n gives the time per run (GPU timestamps proved unreliable here). The device is on the adapter with the most
// video memory of its own: the default one can be an integrated GPU (it is while no display is active on the other).
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "g_csSSSSetup.h"
#include "g_csSSS.h"
#include "g_csSSSCover.h"

static std::vector<unsigned char> ReadFile(const std::string &path)
{
    std::vector<unsigned char> b;
    FILE *f = nullptr;
    if (fopen_s(&f, path.c_str(), "rb") || !f) return b;
    fseek(f, 0, SEEK_END);
    b.resize((size_t)ftell(f));
    fseek(f, 0, SEEK_SET);
    if (fread(b.data(), 1, b.size(), f) != b.size()) b.clear();
    fclose(f);
    return b;
}
// a dump file: the 64-byte 'SRDP' header (kind, width, height, format, view, row pitch, data size), then the data
struct Dump { unsigned w = 0, h = 0, fmt = 0, pitch = 0; std::vector<unsigned char> data; };
static bool ReadDump(const std::string &path, Dump &d)
{
    std::vector<unsigned char> b = ReadFile(path);
    if (b.size() < 64 || memcmp(b.data(), "SRDP", 4)) return false;
    const unsigned *u = (const unsigned *)b.data();
    d.w = u[3]; d.h = u[4]; d.fmt = u[5]; d.pitch = u[7];
    d.data.assign(b.begin() + 64, b.end());
    return true;
}

// PNG, 8-bit RGB, stored (uncompressed) deflate blocks
static unsigned Crc(const unsigned char *p, size_t n, unsigned c = 0xffffffffu)
{
    for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1; }
    return c;
}
static void Be32(std::vector<unsigned char> &o, unsigned v) { o.push_back((unsigned char)(v >> 24)); o.push_back((unsigned char)(v >> 16)); o.push_back((unsigned char)(v >> 8)); o.push_back((unsigned char)v); }
static void Chunk(std::vector<unsigned char> &o, const char *type, const std::vector<unsigned char> &data)
{
    Be32(o, (unsigned)data.size());
    const size_t at = o.size();
    o.insert(o.end(), type, type + 4);
    o.insert(o.end(), data.begin(), data.end());
    Be32(o, Crc(o.data() + at, data.size() + 4) ^ 0xffffffffu);
}
static bool WritePng(const std::string &path, unsigned w, unsigned h, const std::vector<unsigned char> &rgb)
{
    std::vector<unsigned char> raw;
    raw.reserve((size_t)(w * 3 + 1) * h);
    for (unsigned y = 0; y < h; y++) { raw.push_back(0); raw.insert(raw.end(), rgb.begin() + (size_t)y * w * 3, rgb.begin() + (size_t)(y + 1) * w * 3); }
    std::vector<unsigned char> z = { 0x78, 0x01 };
    unsigned a = 1, b = 0;
    for (unsigned char c : raw) { a = (a + c) % 65521; b = (b + a) % 65521; }
    for (size_t i = 0; i < raw.size(); i += 65535)
    {
        const size_t n = raw.size() - i < 65535 ? raw.size() - i : 65535;
        z.push_back(i + n == raw.size() ? 1 : 0);
        z.push_back((unsigned char)n); z.push_back((unsigned char)(n >> 8)); z.push_back((unsigned char)~n); z.push_back((unsigned char)(~n >> 8));
        z.insert(z.end(), raw.begin() + i, raw.begin() + i + n);
    }
    Be32(z, (b << 16) | a);
    std::vector<unsigned char> o = { 137, 80, 78, 71, 13, 10, 26, 10 }, ihdr;
    Be32(ihdr, w); Be32(ihdr, h);
    ihdr.insert(ihdr.end(), { 8, 2, 0, 0, 0 });
    Chunk(o, "IHDR", ihdr);
    Chunk(o, "IDAT", z);
    Chunk(o, "IEND", {});
    FILE *f = nullptr;
    if (fopen_s(&f, path.c_str(), "wb") || !f) return false;
    fwrite(o.data(), 1, o.size(), f);
    fclose(f);
    return true;
}
// R11G11B10_FLOAT channel -> float
static float SmallFloat(unsigned v, int mbits)
{
    const unsigned e = v >> mbits, m = v & ((1u << mbits) - 1);
    if (e == 0) return std::ldexp((float)m, -14 - mbits);
    if (e == 31) return 65504.f;
    return std::ldexp(1.f + (float)m / (float)(1u << mbits), (int)e - 15);
}
static unsigned char Srgb8(float v)
{
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    return (unsigned char)std::lround(255.f * (v <= 0.0031308f ? 12.92f * v : 1.055f * std::pow(v, 1 / 2.4f) - 0.055f));
}

int main(int argc, char **argv)
{
    if (argc < 4) { printf("usage: sss_lab <dump dir> <dump prefix> <out prefix> [warp] [cover] [r32] [repeat=] [thickness=] [bilinear=] [contrast=] [maxdepth=] [sky=]\n"); return 2; }
    const std::string base = std::string(argv[1]) + "\\" + argv[2] + "_", out = argv[3];
    bool warp = false, cover = false, maskFloat = false;
    float thickness = 0.005f, bilinear = 0.02f, contrast = 4.f, maxDepth = 200.f, sky = 3000.f, repeat = 1;
    for (int i = 4; i < argc; i++)
    {
        const std::string a = argv[i];
        const auto val = [&](const char *k, float &v) { const size_t n = strlen(k); if (a.compare(0, n, k) == 0) v = (float)atof(a.c_str() + n); };
        if (a == "warp") warp = true;
        if (a == "cover") cover = true;
        if (a == "r32") maskFloat = true;
        val("thickness=", thickness); val("bilinear=", bilinear); val("contrast=", contrast); val("maxdepth=", maxDepth); val("sky=", sky); val("repeat=", repeat);
    }
    const int runs = repeat < 1 ? 1 : (int)repeat;
    Dump depth, scene, b1, b2;
    if (!ReadDump(base + "depth.bin", depth) || depth.fmt != 39) { printf("no R32 depth at %sdepth.bin\n", base.c_str()); return 1; }
    if (!ReadDump(base + "A_b1.bin", b1) || !ReadDump(base + "A_b2.bin", b2) || b1.data.size() < 352 || b2.data.size() < 1408) { printf("no A_b1 / A_b2 constant buffers\n"); return 1; }
    const bool haveScene = ReadDump(base + "scene.bin", scene) && scene.fmt == 26 && scene.w == depth.w && scene.h == depth.h;
    const unsigned W = depth.w, H = depth.h;

    // the device: on the adapter with the most video memory of its own (or WARP)
    ID3D11Device *dev = nullptr;
    ID3D11DeviceContext *ctx = nullptr;
    IDXGIFactory1 *factory = nullptr;
    IDXGIAdapter1 *best = nullptr;
    SIZE_T bestMem = 0;
    if (!warp && SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void **)&factory)))
    {
        IDXGIAdapter1 *ad = nullptr;
        for (UINT i = 0; factory->EnumAdapters1(i, &ad) != DXGI_ERROR_NOT_FOUND; i++)
        {
            DXGI_ADAPTER_DESC1 desc = {};
            ad->GetDesc1(&desc);
            if (!(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) && desc.DedicatedVideoMemory > bestMem) { if (best) best->Release(); best = ad; bestMem = desc.DedicatedVideoMemory; }
            else ad->Release();
        }
        factory->Release();
    }
    if (best) { DXGI_ADAPTER_DESC1 desc = {}; best->GetDesc1(&desc); printf("adapter: %ls (%zu MB)\n", desc.Description, (size_t)(desc.DedicatedVideoMemory >> 20)); }
    if (FAILED(D3D11CreateDevice(best, best ? D3D_DRIVER_TYPE_UNKNOWN : warp ? D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) { printf("no device\n"); return 1; }
    if (best) best->Release();

    // the inputs as hid.dll sees them at the AO pass
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.Format = DXGI_FORMAT_R32_FLOAT; td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    std::vector<float> zrows((size_t)W * H);
    for (unsigned y = 0; y < H; y++) memcpy(&zrows[(size_t)y * W], depth.data.data() + (size_t)y * depth.pitch, W * 4);
    D3D11_SUBRESOURCE_DATA zi = { zrows.data(), W * 4, 0 };
    ID3D11Texture2D *zTex = nullptr; ID3D11ShaderResourceView *zSrv = nullptr;
    dev->CreateTexture2D(&td, &zi, &zTex);
    dev->CreateShaderResourceView(zTex, nullptr, &zSrv);
    auto makeCB = [&](const void *data, UINT size) {
        D3D11_BUFFER_DESC bd = {};
        bd.ByteWidth = (size + 15) & ~15u; bd.Usage = D3D11_USAGE_DEFAULT; bd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        std::vector<unsigned char> pad(bd.ByteWidth, 0);
        memcpy(pad.data(), data, size);
        D3D11_SUBRESOURCE_DATA si = { pad.data(), 0, 0 };
        ID3D11Buffer *b = nullptr;
        dev->CreateBuffer(&bd, &si, &b);
        return b;
    };
    ID3D11Buffer *camera = makeCB(b1.data.data(), 352), *sceneCB = makeCB(b2.data.data(), 1408);

    // the pass's own resources (as in shadows.cpp's contact-shadow section)
    td.Format = maskFloat ? DXGI_FORMAT_R32_FLOAT : DXGI_FORMAT_R8_UNORM; td.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_UNORDERED_ACCESS;
    ID3D11Texture2D *mask = nullptr; ID3D11UnorderedAccessView *maskUav = nullptr;
    dev->CreateTexture2D(&td, nullptr, &mask);
    dev->CreateUnorderedAccessView(mask, nullptr, &maskUav);
    D3D11_BUFFER_DESC bd = {};
    bd.ByteWidth = 8 * 12; bd.Usage = D3D11_USAGE_DEFAULT; bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
    bd.MiscFlags = D3D11_RESOURCE_MISC_DRAWINDIRECT_ARGS | D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
    ID3D11Buffer *args = nullptr; dev->CreateBuffer(&bd, nullptr, &args);
    D3D11_UNORDERED_ACCESS_VIEW_DESC ud = {};
    ud.Format = DXGI_FORMAT_R32_TYPELESS; ud.ViewDimension = D3D11_UAV_DIMENSION_BUFFER; ud.Buffer.NumElements = 8 * 3; ud.Buffer.Flags = D3D11_BUFFER_UAV_FLAG_RAW;
    ID3D11UnorderedAccessView *argsUav = nullptr; dev->CreateUnorderedAccessView(args, &ud, &argsUav);
    bd.ByteWidth = 9 * 16; bd.BindFlags = D3D11_BIND_UNORDERED_ACCESS | D3D11_BIND_SHADER_RESOURCE; bd.MiscFlags = D3D11_RESOURCE_MISC_BUFFER_STRUCTURED; bd.StructureByteStride = 16;
    ID3D11Buffer *list = nullptr; dev->CreateBuffer(&bd, nullptr, &list);
    ID3D11UnorderedAccessView *listUav = nullptr; dev->CreateUnorderedAccessView(list, nullptr, &listUav);
    ID3D11ShaderResourceView *listSrv = nullptr; dev->CreateShaderResourceView(list, nullptr, &listSrv);
    struct { int w, h, wave, pad; } setupC = { (int)W, (int)H, 64, 0 };
    ID3D11Buffer *setupCB = makeCB(&setupC, sizeof setupC);
    struct PassC { unsigned index; float thickness, bilinear, contrast; float invW, invH, sky, maxDepth; };
    ID3D11Buffer *passCB[8] = {};
    for (unsigned i = 0; i < 8; i++) { const PassC c = { i, thickness, bilinear, contrast, 1.f / W, 1.f / H, sky, maxDepth }; passCB[i] = makeCB(&c, sizeof c); }
    D3D11_SAMPLER_DESC sd = {};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT; sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_BORDER; sd.MaxLOD = D3D11_FLOAT32_MAX;
    ID3D11SamplerState *border = nullptr; dev->CreateSamplerState(&sd, &border);
    ID3D11ComputeShader *csSetup = nullptr, *csPass = nullptr;
    dev->CreateComputeShader(g_csSSSSetup, sizeof g_csSSSSetup, nullptr, &csSetup);
    if (cover) dev->CreateComputeShader(g_csSSSCover, sizeof g_csSSSCover, nullptr, &csPass);
    else dev->CreateComputeShader(g_csSSS, sizeof g_csSSS, nullptr, &csPass);
    if (!zSrv || !camera || !sceneCB || !maskUav || !argsUav || !listUav || !listSrv || !setupCB || !border || !csSetup || !csPass) { printf("resource creation failed\n"); return 1; }

    // the pass, runs times; the wall clock over runs 2..n
    const float clear[4] = { 1.f, 0, 0, 0 };
    LARGE_INTEGER freq = {}, w0 = {}, w1 = {};
    QueryPerformanceFrequency(&freq);
    D3D11_QUERY_DESC eqd = { D3D11_QUERY_EVENT, 0 };
    ID3D11Query *done = nullptr;
    dev->CreateQuery(&eqd, &done);
    for (int run = 0; run < runs; run++)
    {
        if (run == 1) { ctx->End(done); while (ctx->GetData(done, nullptr, 0, 0) == S_FALSE) {} QueryPerformanceCounter(&w0); }
        // the setup: the game's camera and scene at b1 and b2
        ID3D11Buffer *setupCBs[3] = { setupCB, camera, sceneCB };
        ctx->CSSetConstantBuffers(0, 3, setupCBs);
        ID3D11UnorderedAccessView *setupUavs[2] = { argsUav, listUav };
        ctx->CSSetUnorderedAccessViews(0, 2, setupUavs, nullptr);
        ctx->CSSetShader(csSetup, nullptr, 0);
        ctx->Dispatch(1, 1, 1);
        ID3D11UnorderedAccessView *none2[2] = {};
        ctx->CSSetUnorderedAccessViews(0, 2, none2, nullptr);
        // the pass: up to 8 dispatches, each with its index
        ctx->ClearUnorderedAccessViewFloat(maskUav, clear);
        ID3D11ShaderResourceView *srvs[2] = { zSrv, listSrv };
        ctx->CSSetShaderResources(0, 2, srvs);
        ctx->CSSetUnorderedAccessViews(0, 1, &maskUav, nullptr);
        ctx->CSSetSamplers(0, 1, &border);
        ctx->CSSetShader(csPass, nullptr, 0);
        for (unsigned i = 0; i < 8; i++) { ctx->CSSetConstantBuffers(0, 1, &passCB[i]); ctx->DispatchIndirect(args, i * 12); }
        ID3D11ShaderResourceView *noSrv[2] = {};
        ctx->CSSetShaderResources(0, 2, noSrv);
        ID3D11UnorderedAccessView *noUav = nullptr;
        ctx->CSSetUnorderedAccessViews(0, 1, &noUav, nullptr);
    }
    ctx->End(done);
    while (ctx->GetData(done, nullptr, 0, 0) == S_FALSE) {}
    QueryPerformanceCounter(&w1);
    if (runs > 1) printf("time: %.3f ms per run (wall clock over runs 2 to %d: the setup, the clear and the dispatches)\n", (double)(w1.QuadPart - w0.QuadPart) * 1000.0 / (double)freq.QuadPart / (runs - 1), runs);

    // read back: the list, the mask
    auto readBuffer = [&](ID3D11Buffer *b, UINT size, void *dst) {
        D3D11_BUFFER_DESC sbd = {};
        sbd.ByteWidth = size; sbd.Usage = D3D11_USAGE_STAGING; sbd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ID3D11Buffer *s = nullptr; dev->CreateBuffer(&sbd, nullptr, &s);
        ctx->CopyResource(s, b);
        D3D11_MAPPED_SUBRESOURCE m = {};
        if (SUCCEEDED(ctx->Map(s, 0, D3D11_MAP_READ, 0, &m))) { memcpy(dst, m.pData, size); ctx->Unmap(s, 0); }
        s->Release();
    };
    unsigned a[24] = {};
    int lst[36] = {};
    readBuffer(args, sizeof a, a);
    readBuffer(list, sizeof lst, lst);
    float light[4]; memcpy(light, lst, 16);
    printf("sun's point %.1f %.1f (z %g, w %g: %s)\n", light[0], light[1], light[2], light[3], light[3] > 0 ? "in front, shadows point away from it" : "behind the camera");
    for (int i = 0; i < 8; i++)
        if (a[i * 3] || a[i * 3 + 1] || a[i * 3 + 2]) printf("  dispatch %d: %u x %u x %u groups, wave offset %d %d\n", i, a[i * 3], a[i * 3 + 1], a[i * 3 + 2], lst[4 + i * 4], lst[5 + i * 4]);

    td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ID3D11Texture2D *st = nullptr; dev->CreateTexture2D(&td, nullptr, &st);
    ctx->CopyResource(st, mask);
    D3D11_MAPPED_SUBRESOURCE m = {};
    if (FAILED(ctx->Map(st, 0, D3D11_MAP_READ, 0, &m))) { printf("mask read back failed\n"); return 1; }
    std::vector<unsigned char> mrgb((size_t)W * H * 3), orgb((size_t)W * H * 3);
    size_t missed = 0, shadowed = 0, scenePx = 0;
    for (unsigned y = 0; y < H; y++)
        for (unsigned x = 0; x < W; x++)
        {
            const unsigned char *row = (const unsigned char *)m.pData + (size_t)y * m.RowPitch;
            const float mv = maskFloat ? ((const float *)row)[x] : row[x] / 255.f;
            const unsigned char v = (unsigned char)std::lround(255.f * (mv < 0 ? 0 : mv > 1 ? 1 : mv));
            const size_t o = ((size_t)y * W + x) * 3;
            mrgb[o] = mrgb[o + 1] = mrgb[o + 2] = v;
            if (cover && mv >= 1.f) missed++;
            const float z = zrows[(size_t)y * W + x];
            if (z < sky) { scenePx++; if (mv < 0.5f) shadowed++; }
            if (haveScene)
            {
                const unsigned p = *(const unsigned *)(scene.data.data() + (size_t)y * scene.pitch + x * 4);
                const float rgb[3] = { SmallFloat(p & 0x7ff, 6), SmallFloat((p >> 11) & 0x7ff, 6), SmallFloat(p >> 22, 5) };
                const float k = 0.25f + 0.75f * mv;
                for (int c = 0; c < 3; c++) { const float t = rgb[c] * k; orgb[o + c] = Srgb8(t / (1 + t)); }
            }
        }
    ctx->Unmap(st, 0);
    printf("%ux%u: %zu scene pixels, %.2f %% under 0.5 (shadowed)\n", W, H, scenePx, 100.0 * shadowed / (scenePx ? scenePx : 1));
    if (cover) printf("cover: %zu pixels the dispatches did not write (%s)\n", missed, missed ? "GAPS" : "every pixel written");
    if (WritePng(out + "_mask.png", W, H, mrgb)) printf("%s_mask.png\n", out.c_str());
    if (haveScene && WritePng(out + "_overlay.png", W, H, orgb)) printf("%s_overlay.png\n", out.c_str());
    return 0;
}
