# The headlight shadows' cost in the offline test scene: for each camera, the beam's share of the screen and the GPU time
# of a pass that reads each pixel's world position (from the scene's first pass) without the helper and with it inside
# the beam, one sample per pixel as in the game, the fastest of N timed draws each; the difference is the helper's cost.
# Builds scene.exe as run.ps1 does. A running game shares the GPU: the fastest draw filters most of it.
# usage: powershell -File test\headshadow_scene\measure.ps1 [-Define HS_STEPS=16] [-Size 3840x2160] [-Draws 60]
param([string[]]$Define = @(), [string]$Size = '3840x2160', [int]$Draws = 60)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent $here)
$out = Join-Path $root 'out\headshadow_scene'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$exe = Join-Path $out 'scene.exe'
if (-not (Test-Path $exe) -or (Get-Item $exe).LastWriteTime -lt (Get-Item (Join-Path $here 'scene.cpp')).LastWriteTime) {
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  if (-not (Test-Path $vcvars)) { throw 'Visual Studio C++ tools not found (vcvars64.bat)' }
  cmd /c "call `"$vcvars`" >nul 2>nul && cl /nologo /O2 /EHsc /W3 `"$here\scene.cpp`" /Fe:`"$exe`" /Fo:`"$out\scene.obj`"" | Where-Object { $_ -and $_ -notmatch '^scene\.cpp$' }
  if ($LASTEXITCODE) { throw 'scene.cpp does not build' }
}
$w, $h = $Size -split 'x'
$views = [ordered]@{
  side   = @('--eye', '5.5', '3.0', '-3.0', '--target', '-0.5', '0.3', '10.0')
  behind = @('--eye', '0.8', '2.6', '-8.0', '--target', '0.0', '0.6', '12.0')
  above  = @('--eye', '0.5', '24.0', '-4.0', '--target', '0.0', '0.0', '10.0')
  low    = @('--eye', '0.3', '1.4', '0.6', '--target', '0.0', '0.0', '9.0')    # just above the lamps, looking down the beam
}
$defs = @(); foreach ($d in $Define) { if ($d) { $defs += '-D'; $defs += $d } }
$tmp = Join-Path $out 'measure.bmp'
$hlsl = Join-Path $here 'scene.hlsl'
"{0,-7} {1,7} {2,12} {3,12} {4,12}   ({5} draws each, {6}x{7}, one sample per pixel{8})" -f 'camera', 'beam', 'no helper', 'helper', 'cost', $Draws, $w, $h, $(if ($Define) { ', ' + ($Define -join ' ') } else { '' })
foreach ($v in $views.Keys) {
  $beam = (& $exe $hlsl $tmp --size $w $h --ss 1 --mode 2 @($views[$v]) @defs) -replace '.*beam ([\d.]+) %.*', '$1'
  $t = foreach ($m in '4', '3') { (& $exe $hlsl $tmp --size $w $h --ss 1 --mode $m --time $Draws @($views[$v]) @defs) -replace '.*shading pass ([\d.]+) ms fastest.*', '$1' }
  "{0,-7} {1,6}% {2,9:N3} ms {3,9:N3} ms {4,9:N3} ms" -f $v, $beam, [double]$t[0], [double]$t[1], ([double]$t[1] - [double]$t[0])
}
Remove-Item $tmp -ErrorAction SilentlyContinue
