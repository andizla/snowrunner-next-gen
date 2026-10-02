// SnowRunner Shadows: contact shadows, the composite's vertex shader: one triangle over the whole target
// from SV_VertexID alone (no vertex buffer, no input layout); see contact_ps.hlsl.
float4 main(uint id : SV_VertexID) : SV_Position
{
    const float2 p = float2((id << 1) & 2, id & 2);
    return float4(p * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}
