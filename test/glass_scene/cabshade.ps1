# Offline test of Cab shade: the game's window glass shader 0x4EB34A47 with Clear glass, and the same with Cab shade
# spliced in (engine\tools\patch_cabshade.js), drawn on the GPU by out\glass_scene\glass.exe (built by run.ps1) over the
# stand-in cab, with a pane depth (SV_Position.w) and a scene depth at t121. Checks, by the clean pane over the red seat:
#   the cab 1 m behind a pane 5 m away loses its share; open ground 60 m behind keeps its light;
#   the same pane seen from its inner side (the far window through the cab, the ground close behind it) changes nothing;
#   a pane 0.8 m from the camera (the cockpit view) changes nothing; no depth bound (no DLL) changes nothing.
# usage: powershell -File test\glass_scene\cabshade.ps1 [-Dump <the game's shaders>]
param([string]$Dump = $(if ($env:SR_DUMP_DIR) { $env:SR_DUMP_DIR } else { 'C:\Games\SnowRunner-shaders\dump' }))
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent $here)
$out = Join-Path $root 'out\glass_scene'
& (Join-Path $here 'run.ps1') -Dump $Dump | Out-Null   # builds glass.exe and the Clear glass pane
$exe = Join-Path $out 'glass.exe'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$clear = Join-Path $out '0x4EB34A47_clear.cso'
$shade = Join-Path $out '0x4EB34A47_cabshade.cso'
& $node -e "const fs=require('fs');const r=require(process.argv[1]).patchCabShade(fs.readFileSync(process.argv[2]));if(!r.blob){console.error(r.reason);process.exit(1)}fs.writeFileSync(process.argv[3],r.blob)" (Join-Path $root 'engine\tools\patch_cabshade.js') $clear $shade
if ($LASTEXITCODE) { throw 'the patcher refused the pane' }
function Red([string]$cso, [string]$name, [string[]]$more) {
  $line = & $exe $cso (Join-Path $out "$name.bmp") @more
  if ($LASTEXITCODE) { throw "glass.exe failed on $name" }
  if ($line -notmatch 'clean over the red seat ([0-9.]+)') { throw "no figure for $name" }
  [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
}
$cases = @(
  @{ name = 'cab';     label = 'cab 1 m behind, pane at 5 m';    more = @('--pane-w', '5', '--scene-z', '6');    shaded = $true },
  @{ name = 'back';    label = 'pane from its inner side, 1 m';   more = @('--pane-w', '5', '--scene-z', '6', '--back'); shaded = $false },
  @{ name = 'open';    label = 'ground 60 m behind, pane at 5 m'; more = @('--pane-w', '5', '--scene-z', '65');   shaded = $false },
  @{ name = 'cockpit'; label = 'pane at 0.8 m (cockpit view)';   more = @('--pane-w', '0.8', '--scene-z', '1.8'); shaded = $false },
  @{ name = 'nodll';   label = 'no depth bound (no DLL)';        more = @('--pane-w', '5');                      shaded = $false })
$bad = 0
foreach ($c in $cases) {
  $a = Red $clear "cs_$($c.name)_clear" $c.more
  $b = Red $shade "cs_$($c.name)_shade" $c.more
  $ratio = if ($a -gt 0) { $b / $a } else { 0 }
  $ok = if ($c.shaded) { $ratio -lt 0.9 } else { [math]::Abs($ratio - 1) -lt 0.005 }
  if (-not $ok) { $bad++ }
  '{0,-34} Clear glass {1:0.0000}  with Cab shade {2:0.0000}  ratio {3:0.000}  {4}' -f $c.label, $a, $b, $ratio, $(if ($ok) { 'ok' } else { 'FAIL' })
}
if ($bad) { throw "$bad case(s) failed" }
'Cab shade offline: passed'
