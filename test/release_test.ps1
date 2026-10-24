# The two checks before a release, on copies of the game made from the kept originals (the real game is never touched):
#   update: the last public release (its zip, unpacked, with its own engine) installs its window's default choices, then
#     this package applies what its window then sends (the cards mirror what is installed, so the cards the old version
#     did not have stay unticked), then the same with the new cards ticked at their defaults;
#   clean: this package installs its window's default choices on an untouched copy.
# Each ends with Restore, after which the paks are the originals byte for byte. Writes only out\releasetest.
# usage (after package.ps1 -Zip): powershell -NoProfile -ExecutionPolicy Bypass -File test\release_test.ps1 -Old <zip>
#   -Old: the last public release's download; -Originals: where shader.pak.orig ... gfx.pak.orig are ($env:SR_ORIGINALS)
param([Parameter(Mandatory = $true)][string]$Old, [string]$Originals = $env:SR_ORIGINALS)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$work = Join-Path $root 'out\releasetest'
if (Test-Path -LiteralPath $work) { [System.IO.Directory]::Delete($work, $true) }
New-Item -ItemType Directory -Force -Path $work | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:failed = 0
$paksOf = 'shader', 'shared', 'initial', 'boot', 'gfx'

# the old release, and this one's two downloads unzipped into one folder as a player does, each in a folder of its own
$oldDir = Join-Path $work 'old'; [IO.Compression.ZipFile]::ExtractToDirectory($Old, $oldDir)
$newDir = Join-Path $work 'new'; [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $root 'out\SnowRunnerNextGen.zip'), $newDir)
[IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $root 'out\SnowRunnerNextGen_Skies.zip'), $newDir)
$want = @{}; foreach ($p in $paksOf) { $want[$p] = (Get-FileHash -LiteralPath (Join-Path $Originals "$p.pak.orig") -Algorithm SHA256).Hash }

function NewGame([string]$name) {
  $game = Join-Path $work $name
  New-Item -ItemType Directory -Force -Path (Join-Path $game 'preload\paks\client'), (Join-Path $game 'Sources\Bin') | Out-Null
  foreach ($p in $paksOf) { Copy-Item -LiteralPath (Join-Path $Originals "$p.pak.orig") -Destination (Join-Path $game "preload\paks\client\$p.pak") }
  Set-Content -LiteralPath (Join-Path $game 'Sources\Bin\SnowRunner.exe') -Value 'stand-in'
  return $game
}
function Engine([string]$dir, [string]$game, [string[]]$arguments) {
  $lines = & (Join-Path $dir 'engine\node.exe') (Join-Path $dir 'engine\ngen.js') @arguments --game $game
  $events = @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  foreach ($e in $events) { if ($e.type -ne 'status' -and $e.type -ne 'step') { '     {0,-5} {1}' -f $e.type, ("$($e.text)" -replace '^(.{0,220}).*$', '$1') | Out-Host } }
  return ,$events
}
function Apply([string]$dir, [string]$game, $selection) {
  $file = Join-Path $work 'selection.json'
  $selection | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding ASCII
  $r = Engine $dir $game @('apply', '--selection', $file)
  # a game version the old release does not know asks to take the files as the originals, as its window does
  if ($r[$r.Count - 1].code -eq 'adopt-files') { '     (the question answered with yes, as a player would)' | Out-Host; $r = Engine $dir $game @('apply', '--selection', $file, '--adopt') }
  return ,$r
}
function Status([string]$dir, [string]$game) { return (Engine $dir $game @('status') | Where-Object { $_.type -eq 'status' } | Select-Object -First 1) }
function Check([string]$what, $got, $want) {
  if ("$got" -eq "$want") { "ok   $what" } else { "FAIL $what"; "     got:  $got"; "     want: $want"; $script:failed++ }
}
function Parts($s) { return ('shader {0} [{1}] dll {2} grade {3} particles {4} stars {5} sky {6} weather {7} ({8}) logos {9} fill {10} debris {11} cubes {12} skies {13}' -f $s.shader.state, ($s.shader.modules -join ','), $s.dll.state, $s.grade.state, $s.particles.state, $s.stars.state, $s.sky.state, $s.weather.state, $s.weather.parts, $s.logos.state, $s.fill.state, $s.debris.state, $s.cubes.state, $s.skies.state) }
function Restored([string]$dir, [string]$game, [string]$label) {
  $r = Engine $dir $game @('restore')
  Check "$label`: restore done" $r[$r.Count - 1].type 'done'
  $same = @($paksOf | Where-Object { (Get-FileHash -LiteralPath (Join-Path $game "preload\paks\client\$_.pak") -Algorithm SHA256).Hash -eq $want[$_] }).Count
  Check "$label`: the five paks are the originals byte for byte" $same 5
  Check "$label`: no note left in the game folder" (Test-Path -LiteralPath (Join-Path $game 'preload\paks\client\SnowRunnerNextGen.json')) $false
  Check "$label`: SnowRunner Shadows taken out" (Test-Path -LiteralPath (Join-Path $game 'Sources\Bin\hid.dll')) $false
  $left = @(Get-ChildItem -LiteralPath (Join-Path $game 'Sources\Bin') -File | Where-Object { $_.Name -ne 'SnowRunner.exe' } | ForEach-Object { $_.Name }) -join ', '
  "     left next to the game: $(if ($left) { $left } else { 'nothing' })"
  $kept = (Get-ChildItem -LiteralPath $env:NGEN_STATE_ROOT -Recurse -File | Measure-Object -Sum Length).Sum
  '     kept in the state folder after Restore: {0:N1} GB (the originals; the program never deletes them)' -f ($kept / 1GB)
}

# the windows' default choices: 1.0.2's cards, and this version's (catalog: the new cards Debris and splashes 4x,
# Reflection cubes, Skies, and Weather's Drifting clouds)
$shader = @('revec', 'seam', 'blocker', 'contact', 'gtao', 'aofar', 'ambient', 'sssr', 'headglow', 'water', 'puddles', 'rivertint', 'crestglow', 'smoke', 'smokeshade', 'tonemap', 'bloom')
$oldChoice = [ordered]@{ shader = $shader; shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = $null; sceneryHide = $null; sceneryShadows = $null
  grass = $null; fill = '0.7'; grade = '1'; particles = '1'; stars = '3'; sky = '1'; weather = 'shadows,showers,evening,horizon,far,fireflies,pollen'; logos = '1' }
$newChoice = [ordered]@{}; foreach ($k in $oldChoice.Keys) { $newChoice[$k] = $oldChoice[$k] }
$newChoice.weather = 'shadows,showers,evening,horizon,far,fireflies,pollen,drift'; $newChoice.debris = '4'; $newChoice.cubes = '1'; $newChoice.skies = '1'; $newChoice.maps = $null
$all = 'shader', 'dll', 'grade', 'particles', 'stars', 'sky', 'weather', 'logos', 'fill', 'debris', 'cubes', 'skies'
function States($s, [string[]]$names) { return (@($names | ForEach-Object { $s.$_.state }) -join ' ') }
function Hash([string]$file) { if (Test-Path -LiteralPath $file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }; return 'missing' }

'--- update: the last public release, then this one'
$env:NGEN_STATE_ROOT = Join-Path $work 'state_update'
$game = NewGame 'game_update'
$r = Apply $oldDir $game $oldChoice
Check 'update: the old release installs its defaults' $r[$r.Count - 1].type 'done'
$s = Status $newDir $game
'     as this version sees it: ' + (Parts $s)
"     outdated: $(@($s.outdated) -join ', ')"
Check 'update: the old release put its parts in' (States $s 'dll', 'grade', 'particles', 'stars', 'sky', 'weather', 'logos', 'fill') 'ours ours ours ours ours ours ours ours'
# what the window then sends: the cards mirror what is installed (the shader cards as shader.pak holds them: an old
# release that does not know the game's shader.pak leaves it), and the cards the old release did not have stay unticked
$mirror = [ordered]@{}; foreach ($k in $oldChoice.Keys) { $mirror[$k] = $oldChoice[$k] }
if ($s.shader.state -ne 'ours') { $mirror.shader = @() }
$mirror.debris = $null; $mirror.cubes = $null; $mirror.skies = $null; $mirror.maps = $null
$r = Apply $newDir $game $mirror
Check 'update: Apply with the installed choices' $r[$r.Count - 1].type 'done'
Check 'update: no warnings' @($r | Where-Object { $_.type -eq 'warn' }).Count 0
$s = Status $newDir $game
'     after: ' + (Parts $s)
Check 'update: nothing outdated' (@($s.outdated) -join ',') ''
Check "update: SnowRunner Shadows is this release's" (Hash (Join-Path $game 'Sources\Bin\hid.dll')) (Hash (Join-Path $newDir 'engine\hid.dll'))
$r = Apply $newDir $game $newChoice
Check 'update: Apply with Defaults' $r[$r.Count - 1].type 'done'
$s = Status $newDir $game
'     after: ' + (Parts $s)
Check 'update: every part of the defaults in' (States $s $all) (@($all | ForEach-Object { 'ours' }) -join ' ')
Restored $newDir $game 'update'

'--- clean: this version on an untouched game'
$env:NGEN_STATE_ROOT = Join-Path $work 'state_clean'
$game = NewGame 'game_clean'
$r = Apply $newDir $game $newChoice
Check 'clean: Apply with the defaults' $r[$r.Count - 1].type 'done'
Check 'clean: no warnings' @($r | Where-Object { $_.type -eq 'warn' }).Count 0
$s = Status $newDir $game
'     after: ' + (Parts $s)
Check 'clean: every part of the defaults in' (States $s $all) (@($all | ForEach-Object { 'ours' }) -join ' ')
Restored $newDir $game 'clean'

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed'
