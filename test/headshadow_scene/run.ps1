# Offline test scene for the headlight shadows: builds scene.exe (Visual Studio's C++ compiler) into
# out\headshadow_scene, renders each view three times (the game's own light, with the helper's shadows, the helper's
# value alone: white lit, black blocked, blue outside the beam) and puts the three side by side in one PNG per view.
# The helper is engine\replacements\headlight\headshadow.hlsl itself; -Define overrides its knobs for a try.
# usage: powershell -File test\headshadow_scene\run.ps1 [-Define HS_NEAR=1.5,HS_SOFT=0.3] [-Name try1] [-Size 960x540]
#   -SS: sub-samples per axis (3 by default; 1 shows the steps' per-pixel offset as the game does where its TAA cannot
#   average it: the offset is the same every frame)
param([string[]]$Define = @(), [string]$Name = 'default', [string]$Size = '960x540', [int]$SS = 3)
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
  $cmd = "call `"$vcvars`" >nul 2>nul && cl /nologo /O2 /EHsc /W3 `"$here\scene.cpp`" /Fe:`"$exe`" /Fo:`"$out\scene.obj`""
  cmd /c $cmd | Where-Object { $_ -and $_ -notmatch '^scene\.cpp$' }
  if ($LASTEXITCODE) { throw 'scene.cpp does not build' }
}

$w, $h = $Size -split 'x'
# camera views: beside the truck (shadows visible), behind it (the chase camera: each shadow hides behind its caster),
# from high up (the beam's whole footprint), and two of the game's shots of 2026-10-23 with the dark quad: low in front
# of the truck beside its bumper (front), and high behind it to the left, further off (chase)
$views = [ordered]@{
  side   = @('--eye', '5.5', '3.0', '-3.0', '--target', '-0.5', '0.3', '10.0')
  behind = @('--eye', '0.8', '2.6', '-8.0', '--target', '0.0', '0.6', '12.0')
  above  = @('--eye', '0.5', '24.0', '-4.0', '--target', '0.0', '0.0', '10.0')
  front  = @('--eye', '1.6', '1.3', '0.6', '--target', '0.3', '0.0', '9.0')
  chase  = @('--eye', '-3.5', '4.5', '-9.0', '--target', '1.0', '0.0', '6.0')
}
$modes = @(@{ m = '1'; label = "the game's own light" }, @{ m = '0'; label = 'with headlight shadows' }, @{ m = '2'; label = "helper's value (black = blocked)" })
$defs = @(); foreach ($d in (($Define -join ',') -split ',')) { if ($d) { $defs += '-D'; $defs += $d } }   # run with -File, a list comes as one string
Add-Type -AssemblyName System.Drawing
foreach ($v in $views.Keys) {
  $bmps = @()
  foreach ($m in $modes) {
    $bmp = Join-Path $out "$Name`_$v`_$($m.m).bmp"
    & $exe (Join-Path $here 'scene.hlsl') $bmp --size $w $h --mode $m.m --ss $SS @($views[$v]) @defs | Out-Null
    if ($LASTEXITCODE) { throw "scene.exe failed on view $v, mode $($m.m)" }
    $bmps += $bmp
  }
  $imgs = $bmps | ForEach-Object { [Drawing.Image]::FromFile($_) }
  $sheet = New-Object Drawing.Bitmap ([int]$w * 3), ([int]$h + 28)
  $g = [Drawing.Graphics]::FromImage($sheet)
  $g.Clear([Drawing.Color]::FromArgb(20, 20, 22))
  $font = New-Object Drawing.Font 'Segoe UI', 11
  for ($i = 0; $i -lt 3; $i++) {
    $g.DrawImage($imgs[$i], [int]$w * $i, 28, [int]$w, [int]$h)
    $g.DrawString("$v, $($modes[$i].label)", $font, [Drawing.Brushes]::Gainsboro, [int]$w * $i + 8, 5)
  }
  $png = Join-Path $out "$Name`_$v.png"
  $sheet.Save($png, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $sheet.Dispose(); $imgs | ForEach-Object { $_.Dispose() }
  $bmps | ForEach-Object { Remove-Item $_ }
  $png
}
