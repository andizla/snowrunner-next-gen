@echo off
rem Builds out\hid.dll (SnowRunner Shadows: forwards hid.dll, renders the sun shadow map at a higher resolution) and
rem out\shadow_test.exe (offline test on a WARP device). x64, static CRT, Visual Studio 2022 Community; fxc of the
rem Windows SDK (on the path after vcvars64) for the reflection pass's compute shaders.
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || (echo vcvars64 failed & exit /b 1)
cd /d "%~dp0"
if not exist out mkdir out
if not exist out\obj mkdir out\obj
ml64 /nologo /c /Fo out\obj\hid_stubs.obj src\hid_stubs.asm || goto fail
cl /nologo /c /O2 /W4 /wd4201 /MT /Fo:out\obj\vtidx.obj src\vtidx.c || goto fail
rem the reflection pass's compute shaders (src\ssr) as headers for shadows.cpp
fxc /nologo /T cs_5_0 /E level0 /O3 /Vn g_csHizLevel0 /Fh out\obj\g_csHizLevel0.h src\ssr\ssr_hiz.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E reduce /O3 /Vn g_csHizReduce /Fh out\obj\g_csHizReduce.h src\ssr\ssr_hiz.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csTrace /Fh out\obj\g_csTrace.h src\ssr\ssr_trace.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csResolve /Fh out\obj\g_csResolve.h src\ssr\ssr_resolve.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csMotion /Fh out\obj\g_csMotion.h src\ssr\ssr_motion.hlsl >nul || goto fail
rem the AO pass at half size (ini AOHalf): the upsample and the blur before it (src\ao)
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csAOUpsample /Fh out\obj\g_csAOUpsample.h src\ao\ao_upsample.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /D AO_BLUR_PASS=1 /Vn g_csAOBlur /Fh out\obj\g_csAOBlur.h src\ao\ao_upsample.hlsl >nul || goto fail
rem the AO pass's depth mips (ini ZMips): levels 1..4 of its depth, decimated, at t126
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csDepthDecimate /Fh out\obj\g_csDepthDecimate.h src\ao\depth_decimate.hlsl >nul || goto fail
rem contact shadows (ini Contact): Bend Studio's screen-space shadows (src\sss, a modified copy of their Apache-2.0 code)
rem and the setup that lists their dispatches on the GPU; the cover variant (no early out) is for out\sss_lab.exe
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csSSSSetup /Fh out\obj\g_csSSSSetup.h src\sss\sss_setup.hlsl >nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /Vn g_csSSS /Fh out\obj\g_csSSS.h src\sss\sss.hlsl >nul 2>nul || goto fail
fxc /nologo /T cs_5_0 /E main /O3 /D SSS_COVER=1 /Vn g_csSSSCover /Fh out\obj\g_csSSSCover.h src\sss\sss.hlsl >nul 2>nul || goto fail
fxc /nologo /T vs_5_0 /E main /O3 /Vn g_vsContact /Fh out\obj\g_vsContact.h src\sss\contact_vs.hlsl >nul || goto fail
fxc /nologo /T ps_5_0 /E main /O3 /Vn g_psContact /Fh out\obj\g_psContact.h src\sss\contact_ps.hlsl >nul || goto fail
cl /nologo /c /O2 /W4 /EHsc /std:c++17 /utf-8 /MT /I out\obj /Fo:out\obj\shadows.obj src\shadows.cpp || goto fail
link /nologo /DLL /DEF:src\hid.def /OUT:out\hid.dll /IMPLIB:out\obj\hid_proxy.lib out\obj\hid_stubs.obj out\obj\vtidx.obj out\obj\shadows.obj user32.lib || goto fail
cl /nologo /O2 /W4 /EHsc /std:c++17 /utf-8 /MT /Fo:out\obj\ /Fe:out\shadow_test.exe test\shadow_test.cpp /link d3d11.lib dxgi.lib d3dcompiler.lib hid.lib user32.lib || goto fail
cl /nologo /O2 /W4 /EHsc /std:c++17 /utf-8 /MT /I out\obj /Fo:out\obj\ /Fe:out\sss_lab.exe test\sss_lab.cpp /link d3d11.lib dxgi.lib || goto fail
echo BUILD OK: out\hid.dll, out\shadow_test.exe, out\sss_lab.exe
exit /b 0
:fail
echo BUILD FAILED
exit /b 1
