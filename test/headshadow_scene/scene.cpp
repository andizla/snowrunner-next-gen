// Offline test scene for the headlight shadows: renders scene.hlsl (which includes the helper,
// engine\replacements\headlight\headshadow.hlsl) on this PC's GPU, or on WARP when there is none, and writes the picture.
// The helper's constant buffers are filled as the game fills them: b1 CB_GLOBAL_CAMERA (c0 eye, c1 view direction,
// c2..c5 the view-projection's columns, c10..c13 the previous frame's, the same here), b2 CB_GLOBAL_SCENE (c20 the headlight's direction, c24 its position); pass 1's
// linear depth is bound at t121 for pass 2, as SnowRunner Shadows binds its copy in the game.
// usage: scene <scene.hlsl> <out.bmp> [--size W H] [--eye x y z] [--target x y z] [--fov degrees] [--mode 0|1|2] [--ss n]
//        [--time N] [-D NAME=value ...]     mode 0: with the helper's shadows, 1: the game's own light, 2: the helper's value
//        alone (3 and 4: the helper alone, timed against no helper); --time N draws the shading pass N more times between GPU timestamps and prints the fastest and the median
#include <d3d11.h>
#include <d3dcompiler.h>
#include <cmath>
#include <cstdio>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")

struct V3 { float x, y, z; };
static V3 sub(V3 a, V3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
static float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
static V3 cross(V3 a, V3 b) { return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x }; }
static V3 norm(V3 a) { float l = std::sqrt(dot(a, a)); return { a.x / l, a.y / l, a.z / l }; }

static ID3DBlob *Compile(const wchar_t *file, const char *src, const char *entry, const char *target, const std::vector<D3D_SHADER_MACRO> &defs)
{
    ID3DBlob *code = nullptr, *err = nullptr;
    HRESULT hr = file ? D3DCompileFromFile(file, defs.data(), D3D_COMPILE_STANDARD_FILE_INCLUDE, entry, target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &err)
                      : D3DCompile(src, std::strlen(src), "vs", nullptr, nullptr, entry, target, 0, 0, &code, &err);
    if (FAILED(hr)) { std::fprintf(stderr, "%s does not compile:\n%s\n", entry, err ? (const char *)err->GetBufferPointer() : "(no message)"); std::exit(2); }
    if (err) err->Release();
    return code;
}

static ID3D11Buffer *Constants(ID3D11Device *dev, const void *data, UINT bytes)
{
    D3D11_BUFFER_DESC d = { bytes, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    D3D11_SUBRESOURCE_DATA s = { data, 0, 0 };
    ID3D11Buffer *b = nullptr;
    if (FAILED(dev->CreateBuffer(&d, &s, &b))) { std::fprintf(stderr, "constant buffer failed\n"); std::exit(2); }
    return b;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc < 3) { std::fprintf(stderr, "usage: scene <scene.hlsl> <out.bmp> [options]\n"); return 2; }
    UINT W = 960, H = 540; V3 eye = { 5.5f, 3.0f, -3.0f }, target = { -0.5f, 0.3f, 10.0f }; float fov = 60, mode = 0, ss = 3; int timed = 0;
    std::vector<std::string> defText;
    for (int i = 3; i < argc; i++)
    {
        std::wstring a = argv[i];
        auto f = [&](int k) { return (float)_wtof(argv[i + k]); };
        if (a == L"--size" && i + 2 < argc) { W = (UINT)f(1); H = (UINT)f(2); i += 2; }
        else if (a == L"--eye" && i + 3 < argc) { eye = { f(1), f(2), f(3) }; i += 3; }
        else if (a == L"--target" && i + 3 < argc) { target = { f(1), f(2), f(3) }; i += 3; }
        else if (a == L"--fov" && i + 1 < argc) { fov = f(1); i += 1; }
        else if (a == L"--mode" && i + 1 < argc) { mode = f(1); i += 1; }
        else if (a == L"--ss" && i + 1 < argc) { ss = f(1); i += 1; }
        else if (a == L"--time" && i + 1 < argc) { timed = (int)f(1); i += 1; }
        else if (a == L"-D" && i + 1 < argc) { std::string d; for (const wchar_t *c = argv[++i]; *c; c++) d += (char)*c; defText.push_back(d); }
        else { std::fwprintf(stderr, L"unknown option %s\n", argv[i]); return 2; }
    }
    // -D NAME=value pairs as macros (names and values kept alive in defText)
    std::vector<std::string> names, values;
    for (auto &d : defText) { size_t eq = d.find('='); names.push_back(d.substr(0, eq)); values.push_back(eq == std::string::npos ? "1" : d.substr(eq + 1)); }
    std::vector<D3D_SHADER_MACRO> defs;
    for (size_t k = 0; k < names.size(); k++) defs.push_back({ names[k].c_str(), values[k].c_str() });
    defs.push_back({ nullptr, nullptr });

    ID3D11Device *dev = nullptr; ID3D11DeviceContext *ctx = nullptr;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    const char *driver = "hardware";
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx)))
    {
        driver = "WARP";
        if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) { std::fprintf(stderr, "no Direct3D 11 device\n"); return 2; }
    }

    const char *vsSrc = "float4 main(uint id : SV_VertexID) : SV_Position { float2 p = float2((id << 1) & 2, id & 2); return float4(p * float2(2, -2) + float2(-1, 1), 0, 1); }";
    ID3DBlob *vsCode = Compile(nullptr, vsSrc, "main", "vs_5_0", defs);
    ID3DBlob *depthCode = Compile(argv[1], nullptr, "depth_ps", "ps_5_0", defs);
    ID3DBlob *shadeCode = Compile(argv[1], nullptr, "shade_ps", "ps_5_0", defs);
    ID3DBlob *helperCode = Compile(argv[1], nullptr, "helper_ps", "ps_5_0", defs);
    ID3D11VertexShader *vs = nullptr; ID3D11PixelShader *depthPs = nullptr, *shadePs = nullptr, *helperPs = nullptr;
    dev->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, &vs);
    dev->CreatePixelShader(depthCode->GetBufferPointer(), depthCode->GetBufferSize(), nullptr, &depthPs);
    dev->CreatePixelShader(shadeCode->GetBufferPointer(), shadeCode->GetBufferSize(), nullptr, &shadePs);
    dev->CreatePixelShader(helperCode->GetBufferPointer(), helperCode->GetBufferSize(), nullptr, &helperPs);

    // the camera: x right, y up, z forward; clip = (x * sx, y * sy, depth terms, view depth)
    const V3 f = norm(sub(target, eye)), r = norm(cross({ 0, 1, 0 }, f)), u = cross(f, r);
    const float sy = 1.0f / std::tan(fov * 3.14159265f / 360.0f), sx = sy * H / W, zn = 0.1f, zf = 2000.0f, A = zf / (zf - zn), B = -zn * A;
    float cam[56] = {
        eye.x, eye.y, eye.z, 1, f.x, f.y, f.z, 0,
        r.x * sx, r.y * sx, r.z * sx, -dot(eye, r) * sx,
        u.x * sy, u.y * sy, u.z * sy, -dot(eye, u) * sy,
        f.x * A, f.y * A, f.z * A, -dot(eye, f) * A + B,
        f.x, f.y, f.z, -dot(eye, f) };
    std::memcpy(&cam[40], &cam[8], 16 * sizeof(float));   // c10..c13, the previous frame's: the camera stands still
    // the headlight: between the two lamps of a pickup's front, a little downwards
    const V3 lamp = { 0.0f, 0.95f, 0.05f }, dir = norm({ 0.0f, -0.12f, 1.0f });
    float scene[28 * 4] = {};
    std::memcpy(&scene[20 * 4], &dir, sizeof dir);
    std::memcpy(&scene[24 * 4], &lamp, sizeof lamp);
    float s3[28] = { eye.x, eye.y, eye.z, sx, r.x, r.y, r.z, sy, u.x, u.y, u.z, mode, f.x, f.y, f.z, ss,
                     lamp.x, lamp.y, lamp.z, 0, dir.x, dir.y, dir.z, 0, (float)W, (float)H, 0, 0 };
    ID3D11Buffer *cbs[3] = { Constants(dev, cam, sizeof cam), Constants(dev, scene, sizeof scene), Constants(dev, s3, sizeof s3) };

    D3D11_TEXTURE2D_DESC td = { W, H, 1, 1, DXGI_FORMAT_R32_FLOAT, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE, 0, 0 };
    ID3D11Texture2D *depth = nullptr, *color = nullptr, *staging = nullptr, *posTex = nullptr;
    dev->CreateTexture2D(&td, nullptr, &depth);
    td.Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
    dev->CreateTexture2D(&td, nullptr, &posTex);
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM; td.BindFlags = D3D11_BIND_RENDER_TARGET;
    dev->CreateTexture2D(&td, nullptr, &color);
    td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    dev->CreateTexture2D(&td, nullptr, &staging);
    ID3D11RenderTargetView *depthRtv = nullptr, *colorRtv = nullptr, *posRtv = nullptr; ID3D11ShaderResourceView *depthSrv = nullptr, *posSrv = nullptr;
    dev->CreateRenderTargetView(posTex, nullptr, &posRtv);
    dev->CreateShaderResourceView(posTex, nullptr, &posSrv);
    dev->CreateRenderTargetView(depth, nullptr, &depthRtv);
    dev->CreateRenderTargetView(color, nullptr, &colorRtv);
    dev->CreateShaderResourceView(depth, nullptr, &depthSrv);

    D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    ctx->RSSetViewports(1, &vp);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs, nullptr, 0);
    ctx->PSSetConstantBuffers(1, 3, cbs);
    ID3D11RenderTargetView *pass1[2] = { depthRtv, posRtv };
    ctx->OMSetRenderTargets(2, pass1, nullptr);
    ctx->PSSetShader(depthPs, nullptr, 0);
    ctx->Draw(3, 0);
    ctx->OMSetRenderTargets(1, &colorRtv, nullptr);
    ctx->PSSetShaderResources(121, 1, &depthSrv);
    ctx->PSSetShaderResources(0, 1, &posSrv);
    ctx->PSSetShader(mode >= 3 ? helperPs : shadePs, nullptr, 0);
    ctx->Draw(3, 0);
    // timing: the shading pass again, N times between timestamps (after a few unmeasured draws), fastest and median
    std::vector<double> ms;
    if (timed > 0)
    {
        for (int k = 0; k < 5; k++) ctx->Draw(3, 0);
        D3D11_QUERY_DESC qd = { D3D11_QUERY_TIMESTAMP_DISJOINT, 0 };
        ID3D11Query *disjoint = nullptr; dev->CreateQuery(&qd, &disjoint);
        qd.Query = D3D11_QUERY_TIMESTAMP;
        std::vector<ID3D11Query *> ts(timed * 2);
        for (auto &q : ts) dev->CreateQuery(&qd, &q);
        ctx->Begin(disjoint);
        for (int k = 0; k < timed; k++) { ctx->End(ts[k * 2]); ctx->Draw(3, 0); ctx->End(ts[k * 2 + 1]); }
        ctx->End(disjoint);
        D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj;
        while (ctx->GetData(disjoint, &dj, sizeof dj, 0) != S_OK) Sleep(1);
        for (int k = 0; k < timed; k++)
        {
            UINT64 a = 0, b = 0;
            while (ctx->GetData(ts[k * 2], &a, sizeof a, 0) != S_OK) Sleep(0);
            while (ctx->GetData(ts[k * 2 + 1], &b, sizeof b, 0) != S_OK) Sleep(0);
            if (!dj.Disjoint && b > a) ms.push_back(double(b - a) * 1000.0 / double(dj.Frequency));
        }
        std::sort(ms.begin(), ms.end());
    }
    ctx->CopyResource(staging, color);

    D3D11_MAPPED_SUBRESOURCE m;
    if (FAILED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &m))) { std::fprintf(stderr, "read back failed\n"); return 2; }
    std::vector<unsigned char> px(W * H * 4);
    for (UINT y = 0; y < H; y++)
        for (UINT x = 0; x < W; x++)
        {
            const unsigned char *s = (const unsigned char *)m.pData + y * m.RowPitch + x * 4;
            unsigned char *d = &px[(y * W + x) * 4];
            d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255;   // RGBA to the BMP's BGRA
        }
    ctx->Unmap(staging, 0);
    // mode 2: the beam's share of the screen (its pixels are grey, white or black; outside it blue, the sky dark blue)
    double beam = -1;
    if (mode == 2) { size_t n = 0; for (size_t k = 0; k < px.size(); k += 4) if (px[k] == px[k + 1] && px[k + 1] == px[k + 2]) n++; beam = double(n) / (W * H); }

    // a 32-bit top-down BMP
    BITMAPFILEHEADER fh = {}; BITMAPINFOHEADER ih = {};
    ih.biSize = sizeof ih; ih.biWidth = (LONG)W; ih.biHeight = -(LONG)H; ih.biPlanes = 1; ih.biBitCount = 32; ih.biCompression = BI_RGB;
    fh.bfType = 0x4D42; fh.bfOffBits = sizeof fh + sizeof ih; fh.bfSize = fh.bfOffBits + (DWORD)px.size();
    FILE *out = nullptr;
    if (_wfopen_s(&out, argv[2], L"wb") || !out) { std::fwprintf(stderr, L"cannot write %s\n", argv[2]); return 2; }
    std::fwrite(&fh, sizeof fh, 1, out); std::fwrite(&ih, sizeof ih, 1, out); std::fwrite(px.data(), 1, px.size(), out);
    std::fclose(out);
    std::printf("%ux%u, mode %g, %g x %g sub-samples, %s", W, H, mode, ss, ss, driver);
    if (beam >= 0) std::printf(", beam %.1f %% of the screen", beam * 100);
    if (!ms.empty()) std::printf(", shading pass %.3f ms fastest, %.3f ms median of %zu", ms.front(), ms[ms.size() / 2], ms.size());
    std::printf("\n");
    return 0;
}
