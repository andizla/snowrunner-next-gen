// Offline test of Clear glass: draws one of the game's window glass pixel shaders (a .cso from the game's own
// shader.pak, stock or patched by engine\tools\patch_glass_clear.js) over a stand-in cab interior on this PC's GPU (WARP
// when there is none), with the blend the picture shows the game uses (ONE, INV_SRC_ALPHA: the pane's colour added as
// it is, its alpha darkening what is behind), and writes the picture plus the light the pane adds over each zone.
// The shader's inputs and constants are set as a day scene: the ambient colours of a bright overcast day, a sky cube, a
// glass texture that is clean (alpha under the truck's clean value) in the upper part of the pane and dirtier towards
// the right in its lower part, and a mud decal in the lower right corner. No lamps, no wet pane.
// Tested shader: 0x4EB34A47 (its resources: t30 t32 t57 t59 t86 t88 t90 t94, cb2 cb4 cb5; see its listing).
// usage: glass <pane.cso> <out.bmp> [--size W H] [--no-pane]
#include <d3d11.h>
#include <d3dcompiler.h>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")

static ID3DBlob *Compile(const char *src, const char *target)
{
    ID3DBlob *code = nullptr, *err = nullptr;
    if (FAILED(D3DCompile(src, std::strlen(src), "harness", nullptr, nullptr, "main", target, 0, 0, &code, &err)))
    { std::fprintf(stderr, "harness shader does not compile:\n%s\n", err ? (const char *)err->GetBufferPointer() : ""); std::exit(2); }
    return code;
}
static ID3D11Buffer *Constants(ID3D11Device *dev, const float *data, UINT regs)
{
    D3D11_BUFFER_DESC d = { regs * 16, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    D3D11_SUBRESOURCE_DATA s = { data, 0, 0 };
    ID3D11Buffer *b = nullptr;
    if (FAILED(dev->CreateBuffer(&d, &s, &b))) { std::fprintf(stderr, "constant buffer failed\n"); std::exit(2); }
    return b;
}
// a W x H float4 texture from a function of its texel centre (u, v)
template <class F> static ID3D11ShaderResourceView *Tex(ID3D11Device *dev, UINT W, UINT H, F f)
{
    std::vector<float> px(W * H * 4);
    for (UINT y = 0; y < H; y++) for (UINT x = 0; x < W; x++) f((x + 0.5f) / W, (y + 0.5f) / H, &px[(y * W + x) * 4]);
    D3D11_TEXTURE2D_DESC d = { W, H, 1, 1, DXGI_FORMAT_R32G32B32A32_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, 0 };
    D3D11_SUBRESOURCE_DATA s = { px.data(), W * 16, 0 };
    ID3D11Texture2D *t = nullptr; ID3D11ShaderResourceView *v = nullptr;
    if (FAILED(dev->CreateTexture2D(&d, &s, &t)) || FAILED(dev->CreateShaderResourceView(t, nullptr, &v))) { std::fprintf(stderr, "texture failed\n"); std::exit(2); }
    return v;
}
static ID3D11ShaderResourceView *Cube(ID3D11Device *dev, float r, float g, float b)
{
    const UINT N = 4, LEVELS = 3;   // 4, 2, 1: the shader reads mips up to 8, clamped
    std::vector<float> px(N * N * 4);
    for (UINT i = 0; i < N * N; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 1; }
    D3D11_TEXTURE2D_DESC d = { N, N, LEVELS, 6, DXGI_FORMAT_R32G32B32A32_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, D3D11_RESOURCE_MISC_TEXTURECUBE };
    std::vector<D3D11_SUBRESOURCE_DATA> s;
    for (UINT f = 0; f < 6; f++) for (UINT l = 0; l < LEVELS; l++) s.push_back({ px.data(), (N >> l) * 16, 0 });
    ID3D11Texture2D *t = nullptr; ID3D11ShaderResourceView *v = nullptr;
    if (FAILED(dev->CreateTexture2D(&d, s.data(), &t)) || FAILED(dev->CreateShaderResourceView(t, nullptr, &v))) { std::fprintf(stderr, "cube failed\n"); std::exit(2); }
    return v;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc < 3) { std::fprintf(stderr, "usage: glass <pane.cso> <out.bmp> [--size W H] [--no-pane]\n"); return 2; }
    UINT W = 640, H = 400; bool pane = true;
    for (int i = 3; i < argc; i++)
    {
        std::wstring a = argv[i];
        if (a == L"--size" && i + 2 < argc) { W = (UINT)_wtoi(argv[i + 1]); H = (UINT)_wtoi(argv[i + 2]); i += 2; }
        else if (a == L"--no-pane") pane = false;
        else { std::fwprintf(stderr, L"unknown option %s\n", argv[i]); return 2; }
    }
    std::vector<char> ps;
    { FILE *f = _wfopen(argv[1], L"rb"); if (!f) { std::fprintf(stderr, "cannot read the pane shader\n"); return 2; } char b[65536]; size_t n; while ((n = fread(b, 1, sizeof b, f)) > 0) ps.insert(ps.end(), b, b + n); fclose(f); }

    ID3D11Device *dev = nullptr; ID3D11DeviceContext *ctx = nullptr;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    const char *driver = "hardware";
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx)))
    {
        driver = "WARP";
        if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) { std::fprintf(stderr, "no Direct3D 11 device\n"); return 2; }
    }

    // a full-screen triangle with the pane shader's inputs, in its register order (v0..v6, then SV_Position)
    const char *vsSrc =
        "struct O { float4 uv : TEXCOORD0; float3 pos : TEXCOORD1; float3 view : TEXCOORD2; float3 t0 : TEXCOORD4; float3 t1 : TEXCOORD5; float3 t2 : TEXCOORD6; float4 col : COLOR0; float4 p : SV_Position; };\n"
        "O main(uint id : SV_VertexID) { O o; float2 q = float2((id << 1) & 2, id & 2); o.p = float4(q * float2(2, -2) + float2(-1, 1), 0.5, 1);\n"
        "  o.uv = float4(q, 0.5, 0.5); o.pos = float3(q * 2 - 1, 3); o.view = normalize(float3(0.15, -0.25, 1));\n"
        "  o.t0 = float3(1, 0, 0); o.t1 = float3(0, 1, 0); o.t2 = float3(0, 0, -1);\n"   // the pane's normal (t0.z, t1.z, t2.z) = (0, 0, -1): facing the camera
        "  o.col = float4(0.3, 0, 0, 0); return o; }\n";   // x: the mud amount (mud where the decal's alpha is low), y: no wet
    // the cab behind the glass: dark seats and dash with some colour, as an interior in shade
    const char *cabSrc =
        "float4 main(float4 p : SV_Position) : SV_Target { float2 u = p.xy / float2(" "%W%" ", " "%H%" ");\n"
        "  float3 c = float3(0.035, 0.032, 0.030);\n"
        "  if (u.y > 0.55) c = float3(0.06, 0.035, 0.02);\n"                                        // the dash: brown
        "  if (abs(u.x - 0.3) < 0.12 && u.y < 0.55 && u.y > 0.15) c = float3(0.02, 0.02, 0.025);\n"   // a seat: near black
        "  if (abs(u.x - 0.72) < 0.12 && u.y < 0.55 && u.y > 0.15) c = float3(0.09, 0.02, 0.015);\n"  // a red seat
        "  if (length(u - float2(0.3, 0.62)) < 0.09 && length(u - float2(0.3, 0.62)) > 0.07) c = float3(0.01, 0.01, 0.01);\n" // the wheel
        "  return float4(c, 1); }\n";
    std::string cab = cabSrc;
    for (auto [k, v] : { std::pair<std::string, UINT>{ "%W%", W }, { "%H%", H } }) cab.replace(cab.find(k), k.size(), std::to_string(v) + ".0");
    ID3DBlob *vsb = Compile(vsSrc, "vs_5_0"), *cabb = Compile(cab.c_str(), "ps_5_0");
    ID3D11VertexShader *vs = nullptr; ID3D11PixelShader *cabPs = nullptr, *panePs = nullptr;
    dev->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &vs);
    dev->CreatePixelShader(cabb->GetBufferPointer(), cabb->GetBufferSize(), nullptr, &cabPs);
    if (FAILED(dev->CreatePixelShader(ps.data(), ps.size(), nullptr, &panePs))) { std::fprintf(stderr, "the pane shader is refused by the runtime\n"); return 1; }

    D3D11_TEXTURE2D_DESC rd = { W, H, 1, 1, DXGI_FORMAT_R16G16B16A16_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET, 0, 0 };
    ID3D11Texture2D *rt = nullptr; ID3D11RenderTargetView *rtv = nullptr;
    dev->CreateTexture2D(&rd, nullptr, &rt); dev->CreateRenderTargetView(rt, nullptr, &rtv);
    D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    ctx->RSSetViewports(1, &vp); ctx->OMSetRenderTargets(1, &rtv, nullptr);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST); ctx->VSSetShader(vs, nullptr, 0);

    // pass 1: the cab
    ctx->PSSetShader(cabPs, nullptr, 0); ctx->Draw(3, 0);

    if (pane)
    {
        // CB_GLOBAL_SCENE (b2): lighting mode 0 (the light map's colour is not mixed in), light map max TC 1, no lamps
        // (c8..c11.z = 0), the static reflection multiplier (c40, the wet pane only), the ambient up / mid / down (c50..c52,
        // a bright overcast day), the reflection cube's scale (c57.y)
        std::vector<float> scene(58 * 4, 0.0f);
        auto set = [&](std::vector<float> &b, int r, float x, float y, float z, float w) { b[r * 4] = x; b[r * 4 + 1] = y; b[r * 4 + 2] = z; b[r * 4 + 3] = w; };
        set(scene, 3, 1, 1, 0, 0);
        set(scene, 40, 1, 1, 1, 0);
        set(scene, 50, 0.75f, 0.82f, 0.95f, 0); set(scene, 51, 0.55f, 0.58f, 0.62f, 0); set(scene, 52, 0.35f, 0.33f, 0.30f, 0);
        set(scene, 57, 0, 1, 0, 0);
        // CB_INSTANCE (b4): clean alpha 0.1, alpha contrast 1, detail density 1
        std::vector<float> inst(4, 0.0f); inst[0] = 0.1f; inst[1] = 1; inst[2] = 1;
        // CB_GLOBAL_OBJECT_BUFFER (b5): base colour white; backside lighting 0, reflectivity 1 (c2.zw); Fresnel F0 0.04,
        // AO intensity 1, metalness scale 0 and bias 0 (c3); roughness scale 1, bias 0 (c4.xy); tiling 1 (c11.zw)
        std::vector<float> obj(12 * 4, 0.0f);
        set(obj, 0, 1, 1, 1, 1); set(obj, 2, 0, 0, 0, 1); set(obj, 3, 0.04f, 1, 0, 0); set(obj, 4, 1, 0, 0, 0); set(obj, 11, 0, 0, 1, 1);
        ID3D11Buffer *b2 = Constants(dev, scene.data(), 58), *b4 = Constants(dev, inst.data(), 1), *b5 = Constants(dev, obj.data(), 12);
        ID3D11Buffer *cbs[6] = { nullptr, nullptr, b2, nullptr, b4, b5 };
        ctx->PSSetConstantBuffers(0, 6, cbs);

        // the glass texture (t90): a grey-green tint; alpha clean (0) in the upper 60 %, a dirt ramp to the right below
        ID3D11ShaderResourceView *diffuse = Tex(dev, 64, 64, [](float u, float v, float *o) { o[0] = 0.42f; o[1] = 0.47f; o[2] = 0.46f; o[3] = v < 0.6f ? 0.0f : 0.1f + 0.8f * u; });
        ID3D11ShaderResourceView *detail = Tex(dev, 1, 1, [](float, float, float *o) { o[0] = o[1] = o[2] = o[3] = 1; });
        ID3D11ShaderResourceView *wet = Tex(dev, 1, 1, [](float, float, float *o) { o[0] = o[1] = 0.502f; o[2] = 1; o[3] = 1; });   // flat, z 1: no wet blend
        ID3D11ShaderResourceView *light = Tex(dev, 1, 1, [](float, float, float *o) { o[0] = o[1] = o[2] = o[3] = 1; });
        // the mud decal (t59, read at twice the pane's UV): brown; its alpha is a threshold (mud shows first where it is
        // low), so with the mud amount 0.3 only a blob in the lower right is muddy
        ID3D11ShaderResourceView *mud = Tex(dev, 64, 64, [](float u, float v, float *o) { o[0] = 0.22f; o[1] = 0.15f; o[2] = 0.09f; float d = std::sqrt((u - 0.85f) * (u - 0.85f) + (v - 0.9f) * (v - 0.9f)); o[3] = d < 0.25f ? 0.0f : 1.0f; });
        ID3D11ShaderResourceView *sky = Cube(dev, 0.62f, 0.68f, 0.80f);
        ID3D11ShaderResourceView *brdf = Tex(dev, 1, 1, [](float, float, float *o) { o[0] = 0.95f; o[1] = 0.02f; o[2] = 0; o[3] = 1; });
        ID3D11ShaderResourceView *pbr = Tex(dev, 1, 1, [](float, float, float *o) { o[0] = 0; o[1] = 0.05f; o[2] = 1; o[3] = 1; });   // metal 0, roughness 0.05, AO 1
        ID3D11ShaderResourceView *none = nullptr;
        for (UINT t = 0; t < 128; t++) ctx->PSSetShaderResources(t, 1, &none);
        ctx->PSSetShaderResources(30, 1, &detail); ctx->PSSetShaderResources(32, 1, &wet); ctx->PSSetShaderResources(57, 1, &light);
        ctx->PSSetShaderResources(59, 1, &mud); ctx->PSSetShaderResources(86, 1, &sky); ctx->PSSetShaderResources(88, 1, &brdf);
        ctx->PSSetShaderResources(90, 1, &diffuse); ctx->PSSetShaderResources(94, 1, &pbr);
        D3D11_SAMPLER_DESC sd = {}; sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR; sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_WRAP; sd.MaxLOD = D3D11_FLOAT32_MAX;
        ID3D11SamplerState *smp = nullptr; dev->CreateSamplerState(&sd, &smp);
        for (UINT s = 0; s < 16; s++) ctx->PSSetSamplers(s, 1, &smp);

        // the blend: the pane's colour added as it is, its alpha darkening the cab (ONE, INV_SRC_ALPHA)
        D3D11_BLEND_DESC bd = {};
        auto &t = bd.RenderTarget[0];
        t.BlendEnable = TRUE; t.SrcBlend = D3D11_BLEND_ONE; t.DestBlend = D3D11_BLEND_INV_SRC_ALPHA; t.BlendOp = D3D11_BLEND_OP_ADD;
        t.SrcBlendAlpha = D3D11_BLEND_ONE; t.DestBlendAlpha = D3D11_BLEND_ZERO; t.BlendOpAlpha = D3D11_BLEND_OP_ADD; t.RenderTargetWriteMask = 0xF;
        ID3D11BlendState *blend = nullptr; dev->CreateBlendState(&bd, &blend);
        ctx->OMSetBlendState(blend, nullptr, 0xFFFFFFFF);
        ctx->PSSetShader(panePs, nullptr, 0); ctx->Draw(3, 0);
    }

    // read back
    rd.Usage = D3D11_USAGE_STAGING; rd.BindFlags = 0; rd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ID3D11Texture2D *st = nullptr; dev->CreateTexture2D(&rd, nullptr, &st); ctx->CopyResource(st, rt);
    D3D11_MAPPED_SUBRESOURCE m; ctx->Map(st, 0, D3D11_MAP_READ, 0, &m);
    auto half = [](unsigned short h) { unsigned s = (h >> 15) & 1, e = (h >> 10) & 31, f = h & 1023; float v = e == 0 ? std::ldexp((float)f, -24) : std::ldexp((float)(f | 1024), (int)e - 25); return s ? -v : v; };
    std::vector<float> img(W * H * 3);
    for (UINT y = 0; y < H; y++) for (UINT x = 0; x < W; x++)
    {
        const unsigned short *p = (const unsigned short *)((const char *)m.pData + y * m.RowPitch) + x * 4;
        for (int c = 0; c < 3; c++) img[(y * W + x) * 3 + c] = half(p[c]);
    }
    ctx->Unmap(st, 0);
    // the zones: the clean glass over the black seat, over the red seat, over the dash; and the dirty and muddy corner
    auto mean = [&](float u0, float v0, float u1, float v1) { double s = 0; int n = 0; for (UINT y = (UINT)(v0 * H); y < (UINT)(v1 * H); y++) for (UINT x = (UINT)(u0 * W); x < (UINT)(u1 * W); x++) { const float *p = &img[(y * W + x) * 3]; s += 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; n++; } return s / n; };
    std::printf("driver %s; luminance: clean over the black seat %.4f, clean over the red seat %.4f, clean over the dash %.4f, dirty lower middle %.4f, muddy corner %.4f\n",
        driver, mean(0.22f, 0.2f, 0.38f, 0.5f), mean(0.64f, 0.2f, 0.80f, 0.5f), mean(0.55f, 0.56f, 0.6f, 0.59f), mean(0.45f, 0.75f, 0.55f, 0.95f), mean(0.88f, 0.9f, 0.98f, 0.98f));
    // a BMP, tone-mapped x / (1 + x) and gamma 2.2, so dark interiors stay readable
    FILE *f = _wfopen(argv[2], L"wb"); if (!f) { std::fprintf(stderr, "cannot write the picture\n"); return 2; }
    UINT row = (W * 3 + 3) & ~3u, size = 54 + row * H;
    unsigned char hd[54] = { 'B', 'M' }; *(UINT *)(hd + 2) = size; *(UINT *)(hd + 10) = 54; *(UINT *)(hd + 14) = 40; *(int *)(hd + 18) = (int)W; *(int *)(hd + 22) = (int)H; *(unsigned short *)(hd + 26) = 1; *(unsigned short *)(hd + 28) = 24;
    fwrite(hd, 1, 54, f);
    std::vector<unsigned char> line(row, 0);
    for (int y = (int)H - 1; y >= 0; y--)
    {
        for (UINT x = 0; x < W; x++) for (int c = 0; c < 3; c++) { float v = img[(y * W + x) * 3 + c]; v = std::pow(v / (1 + v), 1 / 2.2f); line[x * 3 + 2 - c] = (unsigned char)(std::fmin(std::fmax(v, 0.0f), 1.0f) * 255 + 0.5f); }
        fwrite(line.data(), 1, row, f);
    }
    fclose(f);
    return 0;
}
