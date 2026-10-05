# Runs the packaged engine and the packaged exe on a copy of the game whose every path has a space and a letter outside
# ASCII in it, as a player gets them from a Windows user name like "Jörg Müller": the package unpacked under such a
# folder, the state root (LOCALAPPDATA) and TEMP under it, and the game copy under one as well. Status, Apply with the
# window's default selection, the same Apply again, an Apply through the exe (its command line), Restore, and the byte
# check against the originals. Never the real game: the copy lives in out\. Takes a few minutes and about 8 GB of disk.
# usage (after package.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\paths_test.ps1
# -Package <folder>: the package to test (default out\package\SnowRunnerNextGen)
# -Originals <folder>: where shader.pak.orig, shared.pak.orig, initial.pak.orig, boot.pak.orig and gfx.pak.orig are
param([string]$Package = '', [string]$Originals = 'C:\Games\SnowRunner-shaders\pak_backup')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $Package) { $Package = Join-Path $root 'out\package\SnowRunnerNextGen' }
if (-not (Test-Path -LiteralPath (Join-Path $Package 'engine\ngen.js'))) { throw "$Package is missing: run package.ps1 first" }

# the letters come from their codes, so this file stays ASCII whatever reads it
$o = [string][char]0xF6; $u = [string][char]0xFC
$user = Join-Path $root ('out\J' + $o + 'rg M' + $u + 'ller')
if (Test-Path -LiteralPath $user) { [IO.Directory]::Delete($user, $true) }
$pkg = Join-Path $user 'Downloads\SnowRunnerNextGen'
$local = Join-Path $user 'AppData\Local'
$temp = Join-Path $local 'Temp'
$game = Join-Path $user 'Spiele (SSD)\SteamLibrary\steamapps\common\SnowRunner'
$paks = Join-Path $game 'preload\paks\client'
$bin = Join-Path $game 'Sources\Bin'
foreach ($d in $pkg, $local, $temp, $paks, $bin) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
'copying the package and the original paks under ' + $user
Copy-Item -Path (Join-Path $Package '*') -Destination $pkg -Recurse
foreach ($p in 'shader', 'shared', 'initial', 'boot', 'gfx') { Copy-Item -LiteralPath (Join-Path $Originals "$p.pak.orig") -Destination (Join-Path $paks "$p.pak") }
Set-Content -LiteralPath (Join-Path $bin 'SnowRunner.exe') -Value 'stand-in'
# the player's folders for every process started from here: the engine, its tools and the exe
$env:LOCALAPPDATA = $local
$env:TEMP = $temp
$env:TMP = $temp
Remove-Item Env:\NGEN_STATE_ROOT -ErrorAction SilentlyContinue
$node = Join-Path $pkg 'engine\node.exe'
$ngen = Join-Path $pkg 'engine\ngen.js'
$exe = Join-Path $pkg 'SnowRunnerNextGen.exe'
$script:failed = 0

function Check([string]$what, $got, $want) {
  if ("$got" -eq "$want") { "ok   $what" } else { "FAIL $what"; "     got:  $got"; "     want: $want"; $script:failed++ }
}
function Engine([string[]]$arguments) {
  $lines = & $node $ngen @arguments --game $game
  $events = @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  foreach ($e in $events) { if ($e.type -ne 'status') { '     {0,-5} {1}' -f $e.type, $e.text | Out-Host } }
  return ,$events
}
function Status { $s = Engine @('status'); return $s | Where-Object { $_.type -eq 'status' } | Select-Object -First 1 }
function Last($events) { return $events[$events.Count - 1].type }
function Said($events, [string]$pattern) { return [bool]@($events | Where-Object { $_.text -match $pattern }).Count }
function Hash($file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }

# the window's default selection (see test\run_tests.ps1 and engine\ngen.js), in a file whose name has the letters too
$default = 'gtao', 'aofar', 'revec', 'blocker', 'seam', 'ambient', 'fog', 'tonemap', 'bloom', 'water', 'rivertint', 'crestglow', 'puddles', 'gi', 'smoke', 'smokeshade', 'sssr', 'headglow', 'contact'
$selection = [ordered]@{ shader = $default; shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = $null; grass = $null; fill = '0.7'; grade = '1'; particles = '1'; sky = '1'; stars = '3'; weather = 'shadows,showers,evening,horizon,far,fireflies,pollen'; logos = '1' }
$file = Join-Path $user ('Auswahl ' + $o + $u + '.json')
$selection | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding ASCII

'the untouched copy'
$s = Status
Check 'status: the originals' ('{0} {1} {2} {3}' -f $s.shader.state, $s.dll.state, $s.grass.state, $s.logos.state) 'stock none vanilla vanilla'
Check 'status: the state folder lies under the user folder' ((Test-Path -LiteralPath (Join-Path $local 'SnowRunnerNextGen\games'))) 'True'

'apply with the default selection'
$r = Engine @('apply', '--selection', $file)
Check 'apply: done' (Last $r) 'done'
$s = Status
Check 'apply: status' ('{0} {1} {2} {3} {4} {5} {6} {7} {8}' -f $s.shader.state, $s.shader.modules.Count, $s.dll.state, $s.fill.state, $s.stars.factor, $s.weather.parts, $s.grade.state, $s.sky.state, $s.logos.state) 'ours 19 ours ours 3 shadows,showers,evening,horizon,far,fireflies,pollen ours ours ours'
$built = @{}; foreach ($p in 'shader', 'initial', 'boot', 'gfx') { $built[$p] = Hash (Join-Path $paks "$p.pak") }
Check 'apply: shared.pak untouched (no scenery detail)' (Hash (Join-Path $paks 'shared.pak')) (Hash (Join-Path $Originals 'shared.pak.orig'))
Check 'apply: hid.dll and the note are there' ((Test-Path -LiteralPath (Join-Path $bin 'hid.dll')) -and (Test-Path -LiteralPath (Join-Path $paks 'SnowRunnerNextGen.json'))) 'True'

'the same apply again'
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Engine @('apply', '--selection', $file)
$clock.Stop()
Check 'again: done, nothing rebuilt (under 30 s)' ('{0} {1}' -f (Last $r), ($clock.Elapsed.TotalSeconds -lt 30)) 'done True'
Check 'again: says already' (Said $r 'already') 'True'

'apply through the exe: its command line with these paths, the progress window drawn without a screen'
$png = Join-Path $user ('Bild ' + $o + '.png')
$p = Start-Process -FilePath $exe -ArgumentList @('--shot', "`"$png`"", '--progress', 'apply', "`"$file`"", '--game', "`"$game`"") -Wait -PassThru
$why = if (Test-Path -LiteralPath "$png.error.txt") { Get-Content -Raw -LiteralPath "$png.error.txt" } else { '' }
Check 'exe: exit code 0, the picture drawn' ('{0} {1} {2}' -f $p.ExitCode, (Test-Path -LiteralPath $png), $why.Trim()) '0 True '
Check 'exe: the files as before' (((Hash (Join-Path $paks 'shader.pak')) -eq $built['shader']) -and ((Hash (Join-Path $paks 'boot.pak')) -eq $built['boot'])) 'True'

'restore'
$r = Engine @('restore')
Check 'restore: done' (Last $r) 'done'
foreach ($p in 'shader', 'shared', 'initial', 'boot', 'gfx') { Check "restore: $p.pak is the original byte for byte" (Hash (Join-Path $paks "$p.pak")) (Hash (Join-Path $Originals "$p.pak.orig")) }
Check 'restore: no hid.dll, ini or note left' ((Test-Path -LiteralPath (Join-Path $bin 'hid.dll')) -or (Test-Path -LiteralPath (Join-Path $bin 'SnowRunnerShadows.ini')) -or (Test-Path -LiteralPath (Join-Path $paks 'SnowRunnerNextGen.json'))) 'False'
'files written under the user folder''s TEMP: ' + (Get-ChildItem -LiteralPath $temp -Recurse -File | Measure-Object).Count

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed; the copy is under ' + $user
