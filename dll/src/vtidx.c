// Method table slots of the Direct3D 11 interfaces this DLL hooks, taken from the SDK's own C layout of each
// interface (d3d11_4.h compiled as C declares every interface as a struct of function pointers), so no slot number
// is typed by hand.
#include <stddef.h>
#include <d3d11_4.h>

#define SLOT(vtbl, method) ((int)(offsetof(vtbl, method) / sizeof(void *)))

const int kSlotCreateTexture2D = SLOT(ID3D11DeviceVtbl, CreateTexture2D);
const int kSlotCreateDepthStencilView = SLOT(ID3D11DeviceVtbl, CreateDepthStencilView);
const int kSlotCreateDeferredContext = SLOT(ID3D11DeviceVtbl, CreateDeferredContext);
const int kSlotGetImmediateContext = SLOT(ID3D11DeviceVtbl, GetImmediateContext);
const int kSlotCreateDeferredContext1 = SLOT(ID3D11Device1Vtbl, CreateDeferredContext1);
const int kSlotCreateDeferredContext2 = SLOT(ID3D11Device2Vtbl, CreateDeferredContext2);
const int kSlotCreateDeferredContext3 = SLOT(ID3D11Device3Vtbl, CreateDeferredContext3);
const int kSlotCreateTexture2D1 = SLOT(ID3D11Device3Vtbl, CreateTexture2D1);

const int kSlotOMSetRenderTargets = SLOT(ID3D11DeviceContextVtbl, OMSetRenderTargets);
const int kSlotOMSetRenderTargetsAndUAVs = SLOT(ID3D11DeviceContextVtbl, OMSetRenderTargetsAndUnorderedAccessViews);
const int kSlotRSSetViewports = SLOT(ID3D11DeviceContextVtbl, RSSetViewports);
const int kSlotRSSetScissorRects = SLOT(ID3D11DeviceContextVtbl, RSSetScissorRects);
const int kSlotRSGetViewports = SLOT(ID3D11DeviceContextVtbl, RSGetViewports);
const int kSlotRSGetScissorRects = SLOT(ID3D11DeviceContextVtbl, RSGetScissorRects);
const int kSlotClearState = SLOT(ID3D11DeviceContextVtbl, ClearState);
const int kSlotExecuteCommandList = SLOT(ID3D11DeviceContextVtbl, ExecuteCommandList);
const int kSlotFinishCommandList = SLOT(ID3D11DeviceContextVtbl, FinishCommandList);
const int kSlotRSSetState = SLOT(ID3D11DeviceContextVtbl, RSSetState);
const int kSlotRSGetState = SLOT(ID3D11DeviceContextVtbl, RSGetState);

// scene feed (Feed=1) and trace: which pixel shader is bound, what it reads, and the shaders as they are created
const int kSlotPSSetShader = SLOT(ID3D11DeviceContextVtbl, PSSetShader);
const int kSlotVSSetShader = SLOT(ID3D11DeviceContextVtbl, VSSetShader);
const int kSlotPSSetShaderResources = SLOT(ID3D11DeviceContextVtbl, PSSetShaderResources);
const int kSlotCreatePixelShader = SLOT(ID3D11DeviceVtbl, CreatePixelShader);
// bounce light (GI=1): the blend state the AO pass draws with decides whether its second target is written plainly
const int kSlotOMSetBlendState = SLOT(ID3D11DeviceContextVtbl, OMSetBlendState);

// pass profile (GpuProfile): the compute passes, and the compute shaders' names
const int kSlotCSSetShader = SLOT(ID3D11DeviceContextVtbl, CSSetShader);
const int kSlotCreateComputeShader = SLOT(ID3D11DeviceVtbl, CreateComputeShader);

// trace only (SnowRunnerShadows.ini [Shadows] Trace=1): watched, never changed
const int kSlotDraw = SLOT(ID3D11DeviceContextVtbl, Draw);
const int kSlotDrawIndexed = SLOT(ID3D11DeviceContextVtbl, DrawIndexed);
const int kSlotDrawInstanced = SLOT(ID3D11DeviceContextVtbl, DrawInstanced);
const int kSlotDrawIndexedInstanced = SLOT(ID3D11DeviceContextVtbl, DrawIndexedInstanced);
const int kSlotCopyResource = SLOT(ID3D11DeviceContextVtbl, CopyResource);
const int kSlotCopySubresourceRegion = SLOT(ID3D11DeviceContextVtbl, CopySubresourceRegion);
const int kSlotClearDepthStencilView = SLOT(ID3D11DeviceContextVtbl, ClearDepthStencilView);
const int kSlotDrawIndexedInstancedIndirect = SLOT(ID3D11DeviceContextVtbl, DrawIndexedInstancedIndirect);
const int kSlotDrawInstancedIndirect = SLOT(ID3D11DeviceContextVtbl, DrawInstancedIndirect);
const int kSlotDrawAuto = SLOT(ID3D11DeviceContextVtbl, DrawAuto);
const int kSlotCreateVertexShader = SLOT(ID3D11DeviceVtbl, CreateVertexShader);
