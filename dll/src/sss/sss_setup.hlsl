// SnowRunner Shadows: contact shadows, the setup. One thread works out this frame's list of dispatches for
// sss.hlsl: the sun's point on screen from the game's camera (CB_GLOBAL_CAMERA, b1) and sun direction
// (CB_GLOBAL_SCENE g_dirLight.vDir, b2), and the up to 8 rectangles of wavefronts around it. It is Bend Studio's
// BuildDispatchList (bend_sss_cpu.h, Apache-2.0, Copyright 2023 Sony Interactive Entertainment) moved to the GPU, so the
// list follows the camera in the same frame without a read back: the dispatch sizes go to g_args (DispatchIndirect
// arguments, 3 uints each; an unused entry is 0 0 0) and the sun's point and the wave offsets to g_dispatch.

cbuffer SSSSetup : register(b0)
{
    int2 g_size;            // the depth's size in pixels
    int g_waveSize;         // 64
    int g_pad;
};
cbuffer CB_GLOBAL_CAMERA : register(b1)
{
    float4 g_vEyePos;
    float4 g_vViewDir;
    float4 g_vp[4];         // g_tmViewProj rows: clip[i] = dot(float4(P, 1), g_vp[i]) (reversed-Z, infinite)
};
cbuffer CB_GLOBAL_SCENE : register(b2)
{
    float4 g_scene[50];     // g_dirLight: vColor c48, vDir c49 (the way the light travels: the sun is at -vDir)
};
RWByteAddressBuffer g_args : register(u0);          // 8 x (x, y, z) groups
RWStructuredBuffer<int4> g_dispatch : register(u1); // [0] the sun's point (float bits); [1 + i] dispatch i's wave offset

struct Disp { int3 count; int2 offset; };

[numthreads(1, 1, 1)]
void main()
{
    // the sun as a point at infinity: float4(direction to the sun, 0) through the view-projection
    const float3 toSun = -g_scene[49].xyz;
    const float4 lp = float4(dot(toSun, g_vp[0].xyz), dot(toSun, g_vp[1].xyz), dot(toSun, g_vp[2].xyz), dot(toSun, g_vp[3].xyz));
    const int wave = g_waveSize;

    // (from here on Bend's BuildDispatchList, line for line but for the list removal, which keeps the same parts)
    float xy_light_w = lp.w;
    const float FP_limit = 0.000002f * (float)wave;
    if (xy_light_w >= 0 && xy_light_w < FP_limit) xy_light_w = FP_limit;
    else if (xy_light_w < 0 && xy_light_w > -FP_limit) xy_light_w = -FP_limit;

    float4 light;
    light.x = ((lp.x / xy_light_w) * +0.5f + 0.5f) * (float)g_size.x;
    light.y = ((lp.y / xy_light_w) * -0.5f + 0.5f) * (float)g_size.y;
    light.z = 0;                    // the far plane: a direction has 1 / z = 0 in sss.hlsl's depth (Bend: z / w)
    light.w = lp.w > 0 ? 1 : -1;

    const int2 light_xy = int2((int)(light.x + 0.5f), (int)(light.y + 0.5f));
    const int biased[4] = { -light_xy.x, -(g_size.y - light_xy.y), g_size.x - light_xy.x, light_xy.y };

    Disp d[8];
    int count = 0;
    [loop] for (int i0 = 0; i0 < 8; i0++) { d[i0].count = int3(0, 0, 0); d[i0].offset = int2(0, 0); }

    [loop] for (int q = 0; q < 4; q++)
    {
        const bool vertical = q == 0 || q == 3;
        const int b0 = max(0, ((q & 1) ? biased[0] : -biased[2])) / wave;
        const int b1 = max(0, ((q & 2) ? biased[1] : -biased[3])) / wave;
        const int b2 = max(0, (((q & 1) ? biased[2] : -biased[0]) + wave * (vertical ? 1 : 2) - 1)) / wave;
        const int b3 = max(0, (((q & 2) ? biased[3] : -biased[1]) + wave * (vertical ? 2 : 1) - 1)) / wave;
        if ((b2 - b0) <= 0 || (b3 - b1) <= 0) continue;

        const int bias_x = (q == 2 || q == 3) ? 1 : 0;
        const int bias_y = (q == 1 || q == 3) ? 1 : 0;
        Disp disp;
        disp.count = int3(wave, b2 - b0, b3 - b1);
        disp.offset = int2(((q & 1) ? b0 : -b2) + bias_x, ((q & 2) ? -b3 : b1) + bias_y);

        int axis_delta = +biased[0] - biased[1];
        if (q == 1) axis_delta = +biased[2] + biased[1];
        if (q == 2) axis_delta = -biased[0] - biased[3];
        if (q == 3) axis_delta = -biased[2] + biased[3];
        axis_delta = (axis_delta + wave - 1) / wave;

        if (axis_delta > 0)
        {
            Disp disp2 = disp;
            if (q == 0)
            {
                disp2.count.z = min(disp.count.z, axis_delta);
                disp.count.z -= disp2.count.z;
                disp2.offset.y = disp.offset.y + disp.count.z;
                disp2.offset.x--;
                disp2.count.y++;
            }
            if (q == 1)
            {
                disp2.count.y = min(disp.count.y, axis_delta);
                disp.count.y -= disp2.count.y;
                disp2.offset.x = disp.offset.x + disp.count.y;
                disp2.count.z++;
            }
            if (q == 2)
            {
                disp2.count.y = min(disp.count.y, axis_delta);
                disp.count.y -= disp2.count.y;
                disp.offset.x += disp2.count.y;
                disp2.count.z++;
                disp2.offset.y--;
            }
            if (q == 3)
            {
                disp2.count.z = min(disp.count.z, axis_delta);
                disp.count.z -= disp2.count.z;
                disp.offset.y += disp2.count.z;
                disp2.count.y++;
            }
            // each part that is not empty, in Bend's order
            if (disp.count.y > 0 && disp.count.z > 0) { d[count] = disp; count++; }
            if (disp2.count.y > 0 && disp2.count.z > 0) { d[count] = disp2; count++; }
        }
        else { d[count] = disp; count++; }
    }

    g_dispatch[0] = asint(light);
    [loop] for (int i = 0; i < 8; i++)
    {
        const bool used = i < count;
        g_args.Store3(i * 12, used ? uint3(d[i].count) : uint3(0, 0, 0));
        g_dispatch[1 + i] = int4(used ? d[i].offset * wave : int2(0, 0), 0, 0);
    }
}
