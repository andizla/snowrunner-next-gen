# Offline test of Clear glass: builds glass.exe (Visual Studio's C++ compiler) into out\glass_scene, patches the game's
# window glass shader 0x4EB34A47 with engine\tools\patch_glass_clear.js, draws the cab alone, under the game's own glass
# and under Clear glass, prints the light each adds over the zones and puts the three side by side in out\glass_scene\glass.png.
# usage: powershell -File test\glass_scene\run.ps1 [-Dump <the game's shaders, as tools\extract.js writes them>]
param([string]$Dump = $(if ($env:SR_DUMP_DIR) { $env:SR_DUMP_DIR } else { 'C:\Games\SnowRunner-shaders\dump' }))
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent $here)
$out = Join-Path $root 'out\glass_scene'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$exe = Join-Path $out 'glass.exe'
if (-not (Test-Path $exe) -or (Get-Item $exe).LastWriteTime -lt (Get-Item (Join-Path $here 'glass.cpp')).LastWriteTime) {
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  if (-not (Test-Path $vcvars)) { throw 'Visual Studio C++ tools not found (vcvars64.bat)' }
  cmd /c "call `"$vcvars`" >nul 2>nul && cl /nologo /O2 /EHsc /W3 /std:c++17 `"$here\glass.cpp`" /Fe:`"$exe`" /Fo:`"$out\glass.obj`"" | Where-Object { $_ -and $_ -notmatch '^glass\.cpp$' }
  if ($LASTEXITCODE) { throw 'glass.cpp does not build' }
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$stock = Join-Path $Dump '0x4EB34A47.cso'
$patched = Join-Path $out '0x4EB34A47_clear.cso'
& $node -e "const fs=require('fs');const r=require(process.argv[1]).patchGlass(fs.readFileSync(process.argv[2]));if(!r.blob){console.error(r.reason);process.exit(1)}fs.writeFileSync(process.argv[3],r.blob)" (Join-Path $root 'engine\tools\patch_glass_clear.js') $stock $patched
if ($LASTEXITCODE) { throw 'the patcher refused the pane' }

$runs = @(@{ name = 'cab'; label = 'the cab, no glass'; args = @($stock, '--no-pane') }, @{ name = 'stock'; label = "the game's own glass"; args = @($stock) }, @{ name = 'clear'; label = 'Clear glass'; args = @($patched) })
Add-Type -AssemblyName System.Drawing
$imgs = @()
foreach ($r in $runs) {
  $bmp = Join-Path $out "$($r.name).bmp"
  $line = & $exe $r.args[0] $bmp @($r.args | Select-Object -Skip 1)
  if ($LASTEXITCODE) { throw "glass.exe failed on $($r.name)" }
  '{0,-22} {1}' -f $r.label, $line
  $imgs += [Drawing.Image]::FromFile($bmp)
}
$w = $imgs[0].Width; $h = $imgs[0].Height
$sheet = New-Object Drawing.Bitmap ($w * 3), ($h + 28)
$g = [Drawing.Graphics]::FromImage($sheet)
$g.Clear([Drawing.Color]::FromArgb(20, 20, 22))
$font = New-Object Drawing.Font 'Segoe UI', 11
for ($i = 0; $i -lt 3; $i++) { $g.DrawImage($imgs[$i], $w * $i, 28, $w, $h); $g.DrawString($runs[$i].label, $font, [Drawing.Brushes]::Gainsboro, $w * $i + 8, 5) }
$png = Join-Path $out 'glass.png'
$sheet.Save($png, [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $sheet.Dispose(); $imgs | ForEach-Object { $_.Dispose() }
$png
