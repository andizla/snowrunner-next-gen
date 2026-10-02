# Builds the standalone package of SnowRunner Next Gen from this repository: out\package\SnowRunnerNextGen\, and with
# -Zip the release's download, out\SnowRunnerNextGen.zip.
# Anyone with the game unzips it anywhere and runs SnowRunnerNextGen.exe; nothing else needs to be installed.
#   SnowRunnerNextGen.exe, help\ (the pop-ups' pictures), LICENSE (GPL-3.0), THIRD_PARTY_NOTICES.md, licenses\
#   engine\ node.exe (a copy of the local Node.js), ngen.js, prepare.js, hid.dll (the pinned SnowRunner Shadows),
#           config.json ({}: the engine's own folders), parts.json (each part's code fingerprint),
#           tools\ (from engine\tools: the tools the engine runs and what they require),
#           replacements\ (from engine\replacements: the compiled shaders and the texture sets)
# None of the game's shaders ship: no extracted shaders (dump\), no index of them, no set of patched game shaders. The
# engine makes those on the player's machine from the player's own shader.pak (engine\prepare.js). The texture sets
# ship as files: the particle textures and the logos are made from the game's own, the night sky from NASA's star map
# and two of the game's sky pictures.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File package.ps1 [-Node <node.exe>] [-Zip]
param([string]$Node = '', [switch]$Zip)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node -or -not (Test-Path -LiteralPath $Node)) { throw 'node.exe not found: pass -Node <path> (Node.js 22.2 or newer)' }
$nodeVersion = (& $Node --version).Trim()
# the pak tools use zlib.crc32, which Node.js has from 22.2 (and from 20.15 in the 20 line)
& $Node -e "process.exit(typeof require('zlib').crc32 === 'function' ? 0 : 1)"
if ($LASTEXITCODE -ne 0) { throw "node.exe $nodeVersion is too old: Node.js 22.2 or newer" }
# the window, and the shaders compiled and checked against the tested blobs
& (Join-Path $root 'build.ps1') -Node $Node | Out-Host

$pkg = Join-Path $root 'out\package\SnowRunnerNextGen'
$zipFile = Join-Path $root 'out\SnowRunnerNextGen.zip'
if (Test-Path -LiteralPath $pkg) { [System.IO.Directory]::Delete($pkg, $true) }
$engine = Join-Path $pkg 'engine'
foreach ($d in $pkg, (Join-Path $pkg 'help'), (Join-Path $pkg 'licenses'), $engine, (Join-Path $engine 'tools'), (Join-Path $engine 'replacements')) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# the window and its pictures
Copy-Item -LiteralPath (Join-Path $root 'out\SnowRunnerNextGen.exe') -Destination $pkg
Get-ChildItem -LiteralPath (Join-Path $root 'out\help') -File | Copy-Item -Destination (Join-Path $pkg 'help')

# the engine
foreach ($f in 'ngen.js', 'prepare.js') { Copy-Item -LiteralPath (Join-Path $root "engine\$f") -Destination $engine }
Copy-Item -LiteralPath (Join-Path $root 'assets\engine\hid.dll') -Destination $engine
# the pinned SnowRunner Shadows build: the DLL must be the one named in assets\engine\hid.dll.sha256, the build the
# modules were tested with. After a tested rebuild (dll\build.bat), its sha256 goes into that file.
$pin = ((Get-Content -LiteralPath (Join-Path $root 'assets\engine\hid.dll.sha256') -TotalCount 1) -split '\s+')[0].ToLower()
$dllHash = (Get-FileHash -LiteralPath (Join-Path $engine 'hid.dll') -Algorithm SHA256).Hash.ToLower()
if ($dllHash -ne $pin) { throw "assets\engine\hid.dll is $($dllHash.Substring(0, 8)), not the pinned build $($pin.Substring(0, 8))" }
Set-Content -LiteralPath (Join-Path $engine 'config.json') -Value '{}' -Encoding ASCII
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
$toolDir = Join-Path $root 'engine\tools'
$entries = 'fidelity_bundle.js', 'pak_shader_patch.js', 'lod_patch.js', 'lut_grade.js', 'gfx_logos.js', 'extract.js', 'shadow_filter_patch.js', 'patch_ambient.js', 'patch_fog.js', 'patch_fog_sun.js', 'patch_bloom_knee.js'
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

# the compiled shaders (build.ps1 has just built and checked them): our helpers, spliced into the game's shaders at
# install time, and the passes that replace a game shader whole. None is a game shader; the tonemap build comes from
# our reconstruction of the game's tonemap shader.
$repl = Join-Path $root 'engine\replacements'
$helpers = @(
  'gi\gi_ambient.cso', 'gi\gi_ambient_decal.cso', 'gi\gi_only.cso', 'gi\gi_only_decal.cso', 'gi\gtao_gi.cso', 'gi\gtao_gi_far.cso',
  'puddles\puddle_ssr.cso', 'puddles\puddle_ssr_decal.cso', 'reflections\object_ssr.cso', 'smoke\smoke_glow.cso',
  'smoke\smoke_shade.cso', 'smoke\smoke_shade_off.cso',
  'sssr\gbuffer.cso', 'sssr\object_sssr.cso', 'sssr\object_sssr_glow.cso',
  'water\absorb.cso', 'water\blend.cso', 'water\blend_glow.cso', 'water\ssr.cso', 'water\ssr_planar.cso', 'water\ssr_t5.cso',
  'ambient\sky_ambient.cso', 'fog\fog_sun.cso', 'shadow_filter\hq_grid_crisp.cso', 'shadow_filter\hq_blocker.cso', 'shadow_filter\hq_revec.cso', 'shadow_filter\hq_seam.cso', 'shadow_filter\hq_seam_own.cso',
  'ssao_builds\gtao_hq\0xEA2414F8.shader', 'ssao_builds\gtao_hq_far\0xEA2414F8.shader',
  # prepare.js copies the tonemap build into the sets when the game still has shader 0x221304E2
  'tonemap_builds\fidelity\0x221304E2.shader')
foreach ($h in $helpers) {
  $src = Join-Path $repl $h
  if (-not (Test-Path -LiteralPath $src)) { throw "shader missing: $src" }
  $dst = Join-Path $engine "replacements\$h"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst
}

# the texture sets, shipped as files because they cannot be made at install time: the particle textures at twice the
# size (lut_grade.js particles-install; list.csv names them), the night sky (lut_grade.js sky-install) and the logos
# (gfx_logos.js)
$textureSets = [ordered]@{ particles = 'particles\pct'; sky = 'sky\pct'; logos = 'splash\pct' }
$textures = @{}
foreach ($set in $textureSets.Keys) {
  $from = Join-Path $repl $textureSets[$set]
  $files = @(Get-ChildItem -LiteralPath $from -File -ErrorAction SilentlyContinue)
  if (-not $files.Count) { throw "texture set missing: $from" }
  $to = Join-Path $engine ('replacements\' + $textureSets[$set])
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  $files | Copy-Item -Destination $to
  $textures[$set] = @($files | ForEach-Object { Join-Path $to $_.Name })
}
Copy-Item -LiteralPath (Join-Path $repl 'particles\list.csv') -Destination (Join-Path $engine 'replacements\particles')
$textures['particles'] += (Join-Path $engine 'replacements\particles\list.csv')

# the package's text files get fixed line endings, whatever the checkout has: the engine's scripts and lists LF, the
# texts a player opens CRLF. The same commit then gives the same bytes, and the same fingerprints, on any machine.
$latin1 = [Text.Encoding]::GetEncoding(28591)   # one character per byte, so the bytes pass through unchanged
function SetLineEndings([string]$file, [string]$ending) {
  $text = $latin1.GetString([IO.File]::ReadAllBytes($file)).Replace("`r`n", "`n")
  if ($ending -ne "`n") { $text = $text.Replace("`n", $ending) }
  [IO.File]::WriteAllBytes($file, $latin1.GetBytes($text))
}
foreach ($f in @((Join-Path $engine 'ngen.js'), (Join-Path $engine 'prepare.js'), (Join-Path $engine 'replacements\particles\list.csv')) + @(Get-ChildItem -LiteralPath (Join-Path $engine 'tools') -File | ForEach-Object { $_.FullName })) { SetLineEndings $f "`n" }

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
$shaderFiles = @($helpers | ForEach-Object { Join-Path $engine "replacements\$_" })
$tool = { param($n) Join-Path $engine "tools\$n" }
$parts = [ordered]@{
  shader    = Fingerprint ($toolFiles + $shaderFiles + (Join-Path $engine 'prepare.js'))
  scenery   = Fingerprint @((& $tool 'lod_patch.js'))
  initial   = Fingerprint @((& $tool 'lod_patch.js'), (& $tool 'daytime_fill.js'), (& $tool 'sky_stars.js'))
  grade     = Fingerprint @((& $tool 'lut_grade.js'))
  particles = Fingerprint ($textures['particles'] + (& $tool 'lut_grade.js'))
  sky       = Fingerprint ($textures['sky'] + (& $tool 'lut_grade.js'))
  logos     = Fingerprint ($textures['logos'] + (& $tool 'gfx_logos.js') + (& $tool 'lod_patch.js'))
}
$parts | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine 'parts.json') -Encoding ASCII

# licences and notices
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $pkg 'LICENSE')
Copy-Item -LiteralPath (Join-Path $root 'THIRD_PARTY_NOTICES.md') -Destination $pkg
Get-ChildItem -LiteralPath (Join-Path $root 'assets\licenses') -File | Where-Object { $_.Name -ne 'Node.js-LICENSE.txt' } | Copy-Item -Destination (Join-Path $pkg 'licenses')
Copy-Item -LiteralPath (Join-Path $root 'assets\README.txt') -Destination $pkg
foreach ($f in @((Join-Path $pkg 'LICENSE'), (Join-Path $pkg 'THIRD_PARTY_NOTICES.md'), (Join-Path $pkg 'README.txt')) + @(Get-ChildItem -LiteralPath (Join-Path $pkg 'licenses') -File | ForEach-Object { $_.FullName })) { SetLineEndings $f "`r`n" }

# the zip is the release's download and is made only on request (-Zip). An older one goes either way, so that no zip
# outlives the folder it was made from
if (Test-Path -LiteralPath $zipFile) { Remove-Item -LiteralPath $zipFile }
if ($Zip) { Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zipFile -CompressionLevel Optimal }
$folderBytes = (Get-ChildItem -LiteralPath $pkg -File -Recurse | Measure-Object Length -Sum).Sum
$textureCount = ($textures.Values | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
'{0}  {1:N1} MB in {2} files ({3} tools, {4} shaders, {5} texture files; node.exe {6})' -f $pkg, ($folderBytes / 1MB), @(Get-ChildItem -LiteralPath $pkg -File -Recurse).Count, $closure.Count, $helpers.Count, $textureCount, $nodeVersion
if ($Zip) { '{0}  {1:N1} MB' -f $zipFile, ((Get-Item -LiteralPath $zipFile).Length / 1MB) }
