// The headlight shadows on a frame dumped from the game: loads SnowRunner Shadows' dump (<stem>_depth.bin, the linear
// depth bound at t121 as the DLL binds its copy; <stem>_A_b1.bin and _A_b2.bin, the constants at b1 and b2; <stem>_scene.bin,
// the lit scene) and draws dump.hlsl, which calls the helper itself, on this PC's GPU, or on WARP when there is none.
// usage: dump <dump.hlsl> <stem> <out.bmp> [--mode 0|1] [--gain g] [-D NAME=value ...]
//        mode 0: the helper's value (white lit, black blocked); 1: the frame itself
#include <d3d11.h>
#include <d3dcompiler.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "d3dcompiler.lib")

// a dump file: a 64-byte header ('SRDP', version, kind, width, height, format, view format, row pitch, data size,
// sample count), then the data
struct Dump { UINT w = 0, h = 0, fmt = 0, pitch = 0; std::vector<unsigned char> data; };
static Dump Load(const std::wstring &file)
{
    Dump d; FILE *f = nullptr;
    if (_wfopen_s(&f, file.c_str(), L"rb") || !f) { std::fwprintf(stderr, L"cannot read %s\n", file.c_str()); std::exit(2); }
    unsigned char hdr[64]; std::fread(hdr, 1, 64, f);
    std::memcpy(&d.w, hdr + 12, 4); std::memcpy(&d.h, hdr + 16, 4); std::memcpy(&d.fmt, hdr + 20, 4); std::memcpy(&d.pitch, hdr + 28, 4);
    std::fseek(f, 0, SEEK_END); long n = std::ftell(f) - 64; std::fseek(f, 64, SEEK_SET);
    d.data.resize(n); std::fread(d.data.data(), 1, n, f); std::fclose(f);
    return d;
}

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
    D3D11_BUFFER_DESC d = { (bytes + 15) & ~15u, D3D11_USAGE_DEFAULT, D3D11_BIND_CONSTANT_BUFFER, 0, 0, 0 };
    std::vector<unsigned char> padded(d.ByteWidth, 0); std::memcpy(padded.data(), data, bytes);
    D3D11_SUBRESOURCE_DATA s = { padded.data(), 0, 0 };
    ID3D11Buffer *b = nullptr;
    if (FAILED(dev->CreateBuffer(&d, &s, &b))) { std::fprintf(stderr, "constant buffer failed\n"); std::exit(2); }
    return b;
}

static ID3D11ShaderResourceView *Texture(ID3D11Device *dev, const Dump &d, DXGI_FORMAT fmt)
{
    D3D11_TEXTURE2D_DESC td = { d.w, d.h, 1, 1, fmt, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE, 0, 0 };
    D3D11_SUBRESOURCE_DATA s = { d.data.data(), d.pitch, 0 };
    ID3D11Texture2D *t = nullptr; ID3D11ShaderResourceView *v = nullptr;
    if (FAILED(dev->CreateTexture2D(&td, &s, &t)) || FAILED(dev->CreateShaderResourceView(t, nullptr, &v))) { std::fprintf(stderr, "texture failed (format %u)\n", (UINT)fmt); std::exit(2); }
    return v;
}

int wmain(int argc, wchar_t **argv)
{
    if (argc < 4) { std::fprintf(stderr, "usage: dump <dump.hlsl> <stem> <out.bmp> [--mode 0|1] [--gain g] [-D NAME=value ...]\n"); return 2; }
    const std::wstring stem = argv[2];
    float opts[4] = { 0, 1, 0, 0 };
    std::vector<std::string> defText;
    for (int i = 4; i < argc; i++)
    {
        std::wstring a = argv[i];
        if (a == L"--mode" && i + 1 < argc) opts[0] = (float)_wtof(argv[++i]);
        else if (a == L"--gain" && i + 1 < argc) opts[1] = (float)_wtof(argv[++i]);
        else if (a == L"-D" && i + 1 < argc) { std::string d; for (const wchar_t *c = argv[++i]; *c; c++) d += (char)*c; defText.push_back(d); }
        else { std::fwprintf(stderr, L"unknown option %s\n", argv[i]); return 2; }
    }
    std::vector<std::string> names, values;
    for (auto &d : defText) { size_t eq = d.find('='); names.push_back(d.substr(0, eq)); values.push_back(eq == std::string::npos ? "1" : d.substr(eq + 1)); }
    std::vector<D3D_SHADER_MACRO> defs;
    for (size_t k = 0; k < names.size(); k++) defs.push_back({ names[k].c_str(), values[k].c_str() });
    defs.push_back({ nullptr, nullptr });

    const Dump depth = Load(stem + L"_depth.bin"), lit = Load(stem + L"_scene.bin"), b1 = Load(stem + L"_A_b1.bin"), b2 = Load(stem + L"_A_b2.bin");
    const UINT W = depth.w, H = depth.h;

    ID3D11Device *dev = nullptr; ID3D11DeviceContext *ctx = nullptr;
    D3D_FEATURE_LEVEL fl = D3D_FEATURE_LEVEL_11_0;
    const char *driver = "hardware";
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx)))
    {
        driver = "WARP";
        if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0, &fl, 1, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) { std::fprintf(stderr, "no Direct3D 11 device\n"); return 2; }
    }
    const char *vsSrc = "float4 main(uint id : SV_VertexID) : SV_Position { float2 p = float2((id << 1) & 2, id & 2); return float4(p * float2(2, -2) + float2(-1, 1), 0, 1); }";
    ID3DBlob *vsCode = Compile(nullptr, vsSrc, "main", "vs_5_0", defs), *psCode = Compile(argv[1], nullptr, "dump_ps", "ps_5_0", defs);
    ID3D11VertexShader *vs = nullptr; ID3D11PixelShader *ps = nullptr;
    dev->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, &vs);
    dev->CreatePixelShader(psCode->GetBufferPointer(), psCode->GetBufferSize(), nullptr, &ps);

    ID3D11Buffer *cbs[3] = { Constants(dev, b1.data.data(), (UINT)b1.data.size()), Constants(dev, b2.data.data(), (UINT)b2.data.size()), Constants(dev, opts, sizeof opts) };
    ID3D11ShaderResourceView *zSrv = Texture(dev, depth, DXGI_FORMAT_R32_FLOAT), *litSrv = Texture(dev, lit, (DXGI_FORMAT)lit.fmt);

    D3D11_TEXTURE2D_DESC td = { W, H, 1, 1, DXGI_FORMAT_R8G8B8A8_UNORM, { 1, 0 }, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET, 0, 0 };
    ID3D11Texture2D *color = nullptr, *staging = nullptr; ID3D11RenderTargetView *rtv = nullptr;
    dev->CreateTexture2D(&td, nullptr, &color);
    td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    dev->CreateTexture2D(&td, nullptr, &staging);
    dev->CreateRenderTargetView(color, nullptr, &rtv);

    D3D11_VIEWPORT vp = { 0, 0, (float)W, (float)H, 0, 1 };
    ctx->RSSetViewports(1, &vp);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(vs, nullptr, 0);
    ctx->PSSetShader(ps, nullptr, 0);
    ctx->PSSetConstantBuffers(1, 3, cbs);
    ctx->PSSetShaderResources(121, 1, &zSrv);
    ctx->PSSetShaderResources(0, 1, &litSrv);
    ctx->OMSetRenderTargets(1, &rtv, nullptr);
    ctx->Draw(3, 0);
    ctx->CopyResource(staging, color);

    D3D11_MAPPED_SUBRESOURCE m;
    if (FAILED(ctx->Map(staging, 0, D3D11_MAP_READ, 0, &m))) { std::fprintf(stderr, "read back failed\n"); return 2; }
    std::vector<unsigned char> px(W * H * 4);
    for (UINT y = 0; y < H; y++)
        for (UINT x = 0; x < W; x++)
        {
            const unsigned char *s = (const unsigned char *)m.pData + y * m.RowPitch + x * 4;
            unsigned char *d = &px[(y * W + x) * 4];
            d[0] = s[2]; d[1] = s[1]; d[2] = s[0]; d[3] = 255;
        }
    ctx->Unmap(staging, 0);
    // the beam's pixels are grey; their mean darkness is the blocked share
    double sum = 0; size_t n = 0;
    if (opts[0] == 0) for (size_t k = 0; k < px.size(); k += 4) if (px[k] == px[k + 1] && px[k + 1] == px[k + 2]) { sum += 1.0 - px[k] / 255.0; n++; }

    BITMAPFILEHEADER fh = {}; BITMAPINFOHEADER ih = {};
    ih.biSize = sizeof ih; ih.biWidth = (LONG)W; ih.biHeight = -(LONG)H; ih.biPlanes = 1; ih.biBitCount = 32; ih.biCompression = BI_RGB;
    fh.bfType = 0x4D42; fh.bfOffBits = sizeof fh + sizeof ih; fh.bfSize = fh.bfOffBits + (DWORD)px.size();
    FILE *out = nullptr;
    if (_wfopen_s(&out, argv[3], L"wb") || !out) { std::fwprintf(stderr, L"cannot write %s\n", argv[3]); return 2; }
    std::fwrite(&fh, sizeof fh, 1, out); std::fwrite(&ih, sizeof ih, 1, out); std::fwrite(px.data(), 1, px.size(), out);
    std::fclose(out);
    std::printf("%ux%u, mode %g, %s", W, H, opts[0], driver);
    if (n) std::printf(", grey pixels %zu, their mean darkness %.4f", n, sum / n);
    std::printf("\n");
    return 0;
}
