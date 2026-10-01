# Builds the standalone package of SnowRunner Next Gen: out\package\SnowRunnerNextGen\ and out\SnowRunnerNextGen.zip.
# Anyone with the game unzips it anywhere and runs SnowRunnerNextGen.exe; nothing else needs to be installed.
#   SnowRunnerNextGen.exe, help\ (the pop-ups' pictures), LICENSE (GPL-3.0), THIRD_PARTY_NOTICES.md, licenses\
#   engine\ node.exe (a copy of the local Node.js), ngen.js, prepare.js, hid.dll (the pinned SnowRunner Shadows),
#           config.json ({}: no dev paths), parts.json (each part's code fingerprint), tools\ (the shader and pak tools,
#           copied from the tools project at build time: every package carries the latest tested code),
#           replacements\ (our own compiled helpers and GTAO builds, and the particle textures)
# No game shader ships: no extracted shaders (dump\), no index of them, no set of patched game shaders. The engine
# makes those on the player's machine from the player's own shader.pak (engine\prepare.js). The particle textures are
# the game's own at twice the size and ship as files.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1 [-Tools C:\Games\SnowRunner-shaders] [-Node <node.exe>]
param([string]$Tools = 'C:\Games\SnowRunner-shaders', [string]$Node = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root 'build.ps1') | Out-Host

$pkg = Join-Path $root 'out\package\SnowRunnerNextGen'
$zip = Join-Path $root 'out\SnowRunnerNextGen.zip'
if (Test-Path -LiteralPath $pkg) { [System.IO.Directory]::Delete($pkg, $true) }
$engine = Join-Path $pkg 'engine'
foreach ($d in $pkg, (Join-Path $pkg 'help'), (Join-Path $pkg 'licenses'), $engine, (Join-Path $engine 'tools'), (Join-Path $engine 'replacements')) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# the window and its pictures
Copy-Item -LiteralPath (Join-Path $root 'out\SnowRunnerNextGen.exe') -Destination $pkg
Get-ChildItem -LiteralPath (Join-Path $root 'out\help') -File | Copy-Item -Destination (Join-Path $pkg 'help')

# the engine
foreach ($f in 'ngen.js', 'prepare.js') { Copy-Item -LiteralPath (Join-Path $root "engine\$f") -Destination $engine }
Copy-Item -LiteralPath (Join-Path $root 'assets\engine\hid.dll') -Destination $engine
# the pinned SnowRunner Shadows build: the DLL must be the one named in assets\engine\hid.dll.sha256
$pin = ((Get-Content -LiteralPath (Join-Path $root 'assets\engine\hid.dll.sha256') -TotalCount 1) -split '\s+')[0].ToLower()
$dllHash = (Get-FileHash -LiteralPath (Join-Path $engine 'hid.dll') -Algorithm SHA256).Hash.ToLower()
if ($dllHash -ne $pin) { throw "assets\engine\hid.dll is $($dllHash.Substring(0, 8)), not the pinned build $($pin.Substring(0, 8))" }
Set-Content -LiteralPath (Join-Path $engine 'config.json') -Value '{}' -Encoding ASCII
if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node -or -not (Test-Path -LiteralPath $Node)) { throw 'node.exe not found: pass -Node <path> (a Node.js 20 or newer node.exe)' }
$nodeVersion = (& $Node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { throw "node.exe $nodeVersion is too old: Node.js 20 or newer" }
Copy-Item -LiteralPath $Node -Destination (Join-Path $engine 'node.exe')
# Node.js's own licence text: next to node.exe (the zip distribution has it) or in assets\licenses; without it the
# package gets a placeholder and must not be released (the Windows installer of Node.js leaves the file out)
$nodeLicence = @((Join-Path (Split-Path -Parent $Node) 'LICENSE'), (Join-Path $root 'assets\licenses\Node.js-LICENSE.txt')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$nodeLicenceOut = Join-Path $pkg 'licenses\Node.js-LICENSE.txt'
if ($nodeLicence) { Copy-Item -LiteralPath $nodeLicence -Destination $nodeLicenceOut }
else {
  Write-Warning "Node.js licence text missing: put it in assets\licenses\Node.js-LICENSE.txt before releasing this package"
  Set-Content -LiteralPath $nodeLicenceOut -Encoding ASCII -Value "PLACEHOLDER, NOT FOR RELEASE: the complete Node.js licence ($nodeVersion) is at https://github.com/nodejs/node/blob/$nodeVersion/LICENSE"
}

# the tools: the entry points the engine runs and everything they require, found from their require('./x.js') lines
$toolDir = Join-Path $Tools 'tools'
$entries = 'fidelity_bundle.js', 'pak_shader_patch.js', 'lod_patch.js', 'lut_grade.js', 'extract.js', 'shadow_filter_patch.js', 'patch_ambient.js', 'patch_fog.js', 'patch_fog_sun.js', 'patch_bloom_knee.js'
$closure = [System.Collections.Generic.SortedSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$queue = [System.Collections.Generic.Queue[string]]::new()
foreach ($e in $entries) { $queue.Enqueue($e) }
while ($queue.Count) {
  $t = $queue.Dequeue()
  if (-not $closure.Add($t)) { continue }
  $file = Join-Path $toolDir $t
  if (-not (Test-Path -LiteralPath $file)) { throw "tool missing: $file" }
  foreach ($m in [regex]::Matches((Get-Content -LiteralPath $file -Raw), "require\(\s*(?:path\.join\(__dirname,\s*)?'\./([\w.-]+?)(?:\.js)?'")) { $queue.Enqueue($m.Groups[1].Value + '.js') }
}
foreach ($t in $closure) { Copy-Item -LiteralPath (Join-Path $toolDir $t) -Destination (Join-Path $engine 'tools') }

# our own helpers and builds (written from scratch; none is a game shader or derived from one)
$helpers = @(
  'gi\gi_ambient.cso', 'gi\gi_ambient_decal.cso', 'gi\gi_only.cso', 'gi\gi_only_decal.cso', 'gi\gtao_gi.cso', 'gi\gtao_gi_far.cso',
  'puddles\puddle_ssr.cso', 'puddles\puddle_ssr_decal.cso', 'reflections\object_ssr.cso', 'smoke\smoke_glow.cso',
  'smoke\smoke_shade.cso', 'smoke\smoke_shade_off.cso',
  'sssr\gbuffer.cso', 'sssr\object_sssr.cso', 'sssr\object_sssr_glow.cso',
  'water\absorb.cso', 'water\blend.cso', 'water\blend_glow.cso', 'water\ssr.cso', 'water\ssr_planar.cso', 'water\ssr_t5.cso',
  'ambient\sky_ambient.cso', 'fog\fog_sun.cso', 'shadow_filter\hq_grid_crisp.cso', 'shadow_filter\hq_blocker.cso', 'shadow_filter\hq_revec.cso', 'shadow_filter\hq_seam.cso', 'shadow_filter\hq_seam_own.cso',
  'ssao_builds\gtao_hq\0xEA2414F8.shader', 'ssao_builds\gtao_hq_far\0xEA2414F8.shader',
  # the tonemap module's build, compiled from our reconstruction of the game's tonemap shader: prepare.js copies it
  # into the sets when the game still has shader 0x221304E2
  'tonemap_builds\fidelity\0x221304E2.shader')
foreach ($h in $helpers) {
  $src = Join-Path $Tools "replacements\$h"
  if (-not (Test-Path -LiteralPath $src)) { throw "helper missing: $src" }
  $dst = Join-Path $engine "replacements\$h"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst
}

# the particle sprites (replacements\particles: pct\*.pct with their .pct_header at twice the size, and list.csv): the
# game's own textures upscaled, so game-derived, shipped as files because they cannot be made at install time;
# lut_grade.js particles-install puts them into boot.pak beside the grade
$particles = Join-Path $Tools 'replacements\particles'
if (-not (Test-Path -LiteralPath (Join-Path $particles 'pct'))) { throw "particle set missing: $particles\pct" }
New-Item -ItemType Directory -Force -Path (Join-Path $engine 'replacements\particles\pct') | Out-Null
Copy-Item -LiteralPath (Join-Path $particles 'list.csv') -Destination (Join-Path $engine 'replacements\particles')
$sprites = @(Get-ChildItem -LiteralPath (Join-Path $particles 'pct') -File)
$sprites | Copy-Item -Destination (Join-Path $engine 'replacements\particles\pct')

# the fingerprint of each part's code: sha256 over the sorted relative paths and contents of the files it runs on
function Fingerprint([string[]]$files) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  foreach ($f in ($files | Sort-Object)) {
    $name = [Text.Encoding]::UTF8.GetBytes($f.Substring($engine.Length + 1).Replace('\', '/') + [char]0)
    [void]$sha.TransformBlock($name, 0, $name.Length, $null, 0)
    $data = [IO.File]::ReadAllBytes($f)
    [void]$sha.TransformBlock($data, 0, $data.Length, $null, 0)
  }
  [void]$sha.TransformFinalBlock([byte[]]::new(0), 0, 0)
  return -join ($sha.Hash | ForEach-Object { $_.ToString('x2') })
}
$toolFiles = @(Get-ChildItem -LiteralPath (Join-Path $engine 'tools') -File | ForEach-Object { $_.FullName })
$allRepl = @(Get-ChildItem -LiteralPath (Join-Path $engine 'replacements') -File -Recurse | ForEach-Object { $_.FullName })
$particleFiles = @($allRepl | Where-Object { $_ -like (Join-Path $engine 'replacements\particles\*') })
$replFiles = @($allRepl | Where-Object { $particleFiles -notcontains $_ })   # the shaders' helpers: the sprites are their own part
$tool = { param($n) Join-Path $engine "tools\$n" }
$parts = [ordered]@{
  shader    = Fingerprint ($toolFiles + $replFiles + (Join-Path $engine 'prepare.js'))
  scenery   = Fingerprint @((& $tool 'lod_patch.js'))
  initial   = Fingerprint @((& $tool 'lod_patch.js'), (& $tool 'daytime_fill.js'), (& $tool 'sky_stars.js'))
  grade     = Fingerprint @((& $tool 'lut_grade.js'))
  particles = Fingerprint ($particleFiles + (& $tool 'lut_grade.js'))
}
$parts | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine 'parts.json') -Encoding ASCII

# licences and notices
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $pkg 'LICENSE')
Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $pkg
Get-ChildItem -LiteralPath (Join-Path $root 'assets\licenses') -File | Where-Object { $_.Name -ne 'Node.js-LICENSE.txt' } | Copy-Item -Destination (Join-Path $pkg 'licenses')
Copy-Item -LiteralPath (Join-Path $root 'assets\README.txt') -Destination $pkg

# the zip
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -CompressionLevel Optimal
$folderBytes = (Get-ChildItem -LiteralPath $pkg -File -Recurse | Measure-Object Length -Sum).Sum
'{0}  {1:N1} MB in {2} files ({3} tools, {4} helpers, {5} sprite files; node.exe {6})' -f $pkg, ($folderBytes / 1MB), @(Get-ChildItem -LiteralPath $pkg -File -Recurse).Count, $closure.Count, $helpers.Count, $sprites.Count, $nodeVersion
'{0}  {1:N1} MB' -f $zip, ((Get-Item -LiteralPath $zip).Length / 1MB)
