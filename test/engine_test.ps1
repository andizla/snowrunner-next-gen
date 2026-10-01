# Tests the engine (engine\ngen.js) on a copy of the game, never the real one: out\enginetest\game holds the original
# paks (copied from the project's pak_backup) and a stand-in SnowRunner.exe, with its own state folder. Checks the
# status of the untouched copy, a first install of the default set, the same apply again (nothing to rebuild), a
# change of every part, another mod's hid.dll kept beside ours, the grass and the fill light (the two parts of
# initial.pak) one without the other, another mod's files added to boot.pak and initial.pak after Next Gen's changes
# (the question naming both files, leaving them out, taking them as the originals), and restore, which then takes
# Next Gen's changes out and keeps the other mod's files: shader.pak and shared.pak are the originals byte for byte.
# Takes several minutes (shader.pak builds, 2 GB shared.pak writes) and about 7 GB of disk.
# usage (after build.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\engine_test.ps1
# -Engine <folder>: test that engine instead (a package's engine\ with its own node.exe, see package_test.ps1)
param([string]$Engine = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ngen = if ($Engine) { Join-Path $Engine 'ngen.js' } else { Join-Path $root 'out\engine\ngen.js' }
if (-not (Test-Path -LiteralPath $ngen)) { throw "$ngen is missing: run build.ps1 (or package.ps1) first" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if ($Engine) { $node = Join-Path $Engine 'node.exe' }
$originals = 'C:\Games\SnowRunner-shaders\pak_backup'

$work = Join-Path $root 'out\enginetest'
if (Test-Path -LiteralPath $work) { [System.IO.Directory]::Delete($work, $true) }   # the previous run's copy
$game = Join-Path $work 'game'
$paks = Join-Path $game 'preload\paks\client'
$bin = Join-Path $game 'Sources\Bin'
New-Item -ItemType Directory -Force -Path $paks, $bin | Out-Null
'copying the original paks into ' + $game
foreach ($p in 'shader', 'shared', 'initial', 'boot') { Copy-Item -LiteralPath (Join-Path $originals "$p.pak.orig") -Destination (Join-Path $paks "$p.pak") }
Set-Content -LiteralPath (Join-Path $bin 'SnowRunner.exe') -Value 'stand-in'
$env:NGEN_STATE_ROOT = Join-Path $work 'state'
$script:failed = 0

function Engine([string[]]$arguments) {
  $lines = & $node $ngen @arguments --game $game
  $events = @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  foreach ($e in $events) { if ($e.type -ne 'status') { '     {0,-5} {1}' -f $e.type, $e.text | Out-Host } }
  return ,$events
}
function Status { $s = Engine @('status'); return $s | Where-Object { $_.type -eq 'status' } | Select-Object -First 1 }
function Apply($selection, [string[]]$more = @()) {
  $file = Join-Path $work 'selection.json'
  $selection | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding ASCII
  return Engine (@('apply', '--selection', $file) + $more)
}
function Last($events) { return $events[$events.Count - 1].type }
function Check([string]$what, $got, $want) {
  if ("$got" -eq "$want") { "ok   $what" } else { "FAIL $what"; "     got:  $got"; "     want: $want"; $script:failed++ }
}
function Summary($s) {
  '{0} [{1}] dll {2} {3}/{4} scenery {5} grass {6}{7} fill {8}{9} grade {10}{11} particles {12} stars {13}{14}' -f $s.shader.state, ($s.shader.modules -join ','), $s.dll.state, $s.dll.factor, $s.dll.slopeBias, $s.scenery, $s.grass.state, $s.grass.factor, $s.fill.state, $s.fill.factor, $s.grade.state, $s.grade.strength, $s.particles.state, $s.stars.state, $s.stars.factor
}
function Hash($file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Warned($events, [string]$pattern) { return [bool]@($events | Where-Object { $_.type -eq 'warn' -and $_.text -match $pattern }).Count }
# a zip's end record: { at, count, cdSize, cdOffset } and the file's open stream
function EndRecord($fs) {
  $n = [int][Math]::Min(65557, $fs.Length); $tail = New-Object byte[] $n
  $fs.Position = $fs.Length - $n; [void]$fs.Read($tail, 0, $n)
  for ($i = $n - 22; $i -ge 0; $i--) {
    if ([BitConverter]::ToUInt32($tail, $i) -eq 0x06054b50) {
      return @{ count = [BitConverter]::ToUInt16($tail, $i + 10); cdSize = [BitConverter]::ToUInt32($tail, $i + 12); cdOffset = [BitConverter]::ToUInt32($tail, $i + 16) }
    }
  }
  throw 'no zip end record'
}
# a zip's entries from its central directory: name -> "crc/size"
function Entries([string]$file) {
  $fs = [IO.File]::OpenRead($file)
  try { $end = EndRecord $fs; $cd = New-Object byte[] $end.cdSize; $fs.Position = $end.cdOffset; [void]$fs.Read($cd, 0, $end.cdSize) } finally { $fs.Dispose() }
  $map = @{}
  for ($p = 0; $p -lt $cd.Length; $p += 46 + [BitConverter]::ToUInt16($cd, $p + 28) + [BitConverter]::ToUInt16($cd, $p + 30) + [BitConverter]::ToUInt16($cd, $p + 32)) {
    $map[[Text.Encoding]::ASCII.GetString($cd, $p + 46, [BitConverter]::ToUInt16($cd, $p + 28))] = '{0:x8}/{1}' -f [BitConverter]::ToUInt32($cd, $p + 16), [BitConverter]::ToUInt32($cd, $p + 24)
  }
  return $map
}
function EntriesDiff($got, $want) {
  $d = @(@($want.Keys) + @($got.Keys) | Sort-Object -Unique | Where-Object { $got[$_] -ne $want[$_] })
  if ($d.Count -eq 0) { return 'same' }
  return 'differs in ' + $d.Count + ': ' + (($d | Select-Object -First 3) -join ', ')
}
# the stand-in for another mod: a small stored file added to a pak behind its last entry (as a texture pack adds its
# textures), with the central directory and the end record written again behind it
function AddEntry([string]$file, [string]$name, [string]$text, [uint32]$crc) {
  $data = [Text.Encoding]::ASCII.GetBytes($text); $nb = [Text.Encoding]::ASCII.GetBytes($name)
  $fs = [IO.File]::Open($file, 'Open', 'ReadWrite')
  try {
    $end = EndRecord $fs
    $cd = New-Object byte[] $end.cdSize; $fs.Position = $end.cdOffset; [void]$fs.Read($cd, 0, $end.cdSize)
    $ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter($ms)
    # the file's local header and data, where the central directory began
    $w.Write([uint32]0x04034b50); $w.Write([uint16]20); $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint16]0x21)
    $w.Write($crc); $w.Write([uint32]$data.Length); $w.Write([uint32]$data.Length); $w.Write([uint16]$nb.Length); $w.Write([uint16]0); $w.Write($nb); $w.Write($data)
    $w.Flush(); $newCd = [uint32]($end.cdOffset + $ms.Length)
    # the central directory, the new file's record and the end record
    $w.Write($cd)
    $w.Write([uint32]0x02014b50); $w.Write([uint16]20); $w.Write([uint16]20); $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint16]0x21)
    $w.Write($crc); $w.Write([uint32]$data.Length); $w.Write([uint32]$data.Length); $w.Write([uint16]$nb.Length); $w.Write([uint16]0); $w.Write([uint16]0)
    $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint32]0); $w.Write([uint32]$end.cdOffset); $w.Write($nb)
    $w.Write([uint32]0x06054b50); $w.Write([uint16]0); $w.Write([uint16]0); $w.Write([uint16]($end.count + 1)); $w.Write([uint16]($end.count + 1))
    $w.Write([uint32]($end.cdSize + 46 + $nb.Length)); $w.Write($newCd); $w.Write([uint16]0)
    $w.Flush(); $bytes = $ms.ToArray()
    $fs.Position = $end.cdOffset; $fs.Write($bytes, 0, $bytes.Length); $fs.SetLength($fs.Position)
  } finally { $fs.Dispose() }
}
# the other mod's two files (CRC-32 of their text, from zlib)
$modFile1 = 'ngen_test/another_mod_1.txt'; $modText1 = "another mod's file 1"; $modCrc1 = [uint32]684587841    # 28cdfb41
$modFile2 = 'ngen_test/another_mod_2.txt'; $modText2 = "another mod's file 2"; $modCrc2 = [uint32]2982456059   # b1c4aafb

# the window's default shader modules, in the bundle's order: every module but the headlight glare cap, the 16-tap
# filter, the march-only reflections and the headlights in reflections
$default = 'gtao', 'aofar', 'revec', 'blocker', 'seam', 'ambient', 'fog', 'tonemap', 'bloom', 'water', 'rivertint', 'crestglow', 'puddles', 'gi', 'smoke', 'smokeshade', 'sssr', 'contact'
# every part changed: without the fog and the contact shadows, the 16-tap filter in place of the rebuilt edges (so
# both filters' sets get made, and the seam dither goes with the rebuilt edges), with the headlights in reflections
$less = @($default | Where-Object { $_ -notin 'fog', 'seam', 'contact' } | ForEach-Object { if ($_ -eq 'revec') { 'crisp' } elseif ($_ -eq 'sssr') { 'sssr', 'headglow' } else { $_ } })

'the untouched copy'
Check 'status: the originals' (Summary (Status)) 'stock [] dll none / scenery vanilla grass vanilla fill vanilla grade vanilla particles vanilla stars vanilla'

'the default set'
$r = Apply ([ordered]@{ shader = $default; shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = 'all'; grass = '3'; fill = '0.7'; grade = '1'; particles = '1' })
Check 'default set: done' (Last $r) 'done'
Check 'default set: status' (Summary (Status)) ('ours [' + ($default -join ',') + '] dll ours 1/1 scenery all grass ours3 fill ours0.7 grade ours1 particles ours stars vanilla')
Check 'default set: boot.pak holds the sprites and the grade' ((EntriesDiff (Entries (Join-Path $paks 'boot.pak')) (Entries (Join-Path $originals 'boot.pak.orig'))) -replace ':.*$', '') 'differs in 84'
Check 'ini: the ambient occlusion pass at half size' ((Get-Content -LiteralPath (Join-Path $bin 'SnowRunnerShadows.ini')) -contains 'AOHalf=1') 'True'
Check 'Bin has hid.dll, its ini and the stock twins' ((Test-Path (Join-Path $bin 'hid.dll')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock'))) 'True'

'the same selection again'
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Apply ([ordered]@{ shader = $default; shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = 'all'; grass = '3'; fill = '0.7'; grade = '1'; particles = '1' })
$clock.Stop()
Check 'same again: done' (Last $r) 'done'
Check 'same again: nothing rebuilt (under 30 s)' ($clock.Elapsed.TotalSeconds -lt 30) 'True'

'every part changed'
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3'; slopeBias = '0'; aoHalf = '0' }; scenery = 'nature'; grass = '2'; fill = '0.55'; grade = '0.5'; stars = '3' })
Check 'changed: done' (Last $r) 'done'
Check 'changed: the ambient occlusion pass at full size' ((Get-Content -LiteralPath (Join-Path $bin 'SnowRunnerShadows.ini')) -contains 'AOHalf=0') 'True'
Check 'changed: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3/0 scenery nature grass ours2 fill ours0.55 grade ours0.5 particles vanilla stars ours3')

'another mod''s hid.dll'
$r = Apply ([ordered]@{ shader = $less; shadows = $null; scenery = 'nature'; grass = '2'; fill = '0.55'; grade = '0.5' })
Check 'ours out: done' (Last $r) 'done'
Check 'ours out: no hid.dll, no ini' ((Test-Path (Join-Path $bin 'hid.dll')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini'))) 'False'
$foreign = [byte[]](1..64)
[System.IO.File]::WriteAllBytes((Join-Path $bin 'hid.dll'), $foreign)
$foreignHash = Hash (Join-Path $bin 'hid.dll')
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = '2'; fill = '0.55'; grade = '0.5' })
Check 'beside it: done' (Last $r) 'done'
Check 'beside it: the other one is hid_chain.dll' ((Test-Path (Join-Path $bin 'hid_chain.dll')) -and ((Hash (Join-Path $bin 'hid_chain.dll')) -eq $foreignHash)) 'True'
Check 'beside it: ours is hid.dll' ((Status).dll.state) 'ours'

'the fill light and the grass, one without the other (two parts of initial.pak)'
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = '2'; fill = $null; grade = '0.5' })
Check 'fill off: done' (Last $r) 'done'
Check 'fill off: the grass stays' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass ours2 fill vanilla grade ours0.5 particles vanilla stars vanilla')
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = $null; fill = '0.85'; grade = $null })
Check 'grass and grade off, fill on: done' (Last $r) 'done'
Check 'grass and grade off, fill on: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass vanilla fill ours0.85 grade vanilla particles vanilla stars vanilla')
Check 'grade off: boot.pak is the original byte for byte' (Hash (Join-Path $paks 'boot.pak')) (Hash (Join-Path $originals 'boot.pak.orig'))

'other mods: files added to boot.pak and initial.pak after Next Gen''s changes'
$sel = { param($grade) [ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = $null; fill = '0.85'; grade = $grade } }
$r = Apply (& $sel '0.5')
Check 'fill light and grade on: done' (Last $r) 'done'
$boot = Join-Path $paks 'boot.pak'; $initial = Join-Path $paks 'initial.pak'
AddEntry $boot $modFile1 $modText1 $modCrc1
AddEntry $initial $modFile1 $modText1 $modCrc1
$bootBefore = Hash $boot; $initialBefore = Hash $initial
$r = Apply (& $sel '1')
$e = $r[$r.Count - 1]
Check 'other mods: asks first, naming both files' ('{0} {1} {2}' -f $e.type, $e.code, (@($e.files) -join ',')) 'error adopt-files initial.pak,boot.pak'
Check 'other mods: the notice' ($e.text -match 'Next Gen then writes its changes over them, and Restore puts them back as they are now, the other mod''s changes included') 'True'
Check 'other mods: nothing written before the answer' (((Hash $boot) -eq $bootBefore) -and ((Hash $initial) -eq $initialBefore)) 'True'
$r = Apply (& $sel '1') @('--leave')
Check 'leave them out: done' (Last $r) 'done'
Check 'leave them out: says so' ((Warned $r '^boot\.pak .*so the photo grade was left out') -and (Warned $r '^initial\.pak .*the fill light was left out')) 'True'
Check 'leave them out: both untouched' (((Hash $boot) -eq $bootBefore) -and ((Hash $initial) -eq $initialBefore)) 'True'
$r = Apply (& $sel '1') @('--adopt')
Check 'take them as the originals: done' (Last $r) 'done'
Check 'take them as the originals: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass vanilla fill ours0.85 grade ours1 particles vanilla stars vanilla')
Check 'take them as the originals: the other mod''s file is still in both' ('{0} {1}' -f (Entries $boot)[$modFile1], (Entries $initial)[$modFile1]) ('{0:x8}/20 {0:x8}/20' -f $modCrc1)

'restore, with more of the other mod''s files added since the last apply'
AddEntry $boot $modFile2 $modText2 $modCrc2
AddEntry $initial $modFile2 $modText2 $modCrc2
$r = Engine @('restore')
$e = $r[$r.Count - 1]
Check 'restore: asks first, naming both files' ('{0} {1} {2}' -f $e.type, $e.code, (@($e.files) -join ',')) 'error adopt-files initial.pak,boot.pak'
Check 'restore: the notice' ($e.text -match 'Restore then takes Next Gen''s own changes out of them and keeps the other mod''s: the game''s own files do not come back') 'True'
$r = Engine @('restore', '--adopt')
Check 'restore: done' (Last $r) 'done'
Check 'restore: status' (Summary (Status)) 'stock [] dll foreign / scenery vanilla grass vanilla fill vanilla grade vanilla particles vanilla stars vanilla'
foreach ($p in 'shader', 'shared') { Check "restore: $p.pak is the original byte for byte" (Hash (Join-Path $paks "$p.pak")) (Hash (Join-Path $originals "$p.pak.orig")) }
foreach ($p in 'initial', 'boot') {
  $want = Entries (Join-Path $originals "$p.pak.orig")
  $want[$modFile1] = '{0:x8}/20' -f $modCrc1; $want[$modFile2] = '{0:x8}/20' -f $modCrc2
  Check "restore: $p.pak is the game's own plus the other mod's two files, without Next Gen's changes" (EntriesDiff (Entries (Join-Path $paks "$p.pak")) $want) 'same'
}
Check 'restore: the other mod''s hid.dll is back' (Hash (Join-Path $bin 'hid.dll')) $foreignHash
Check 'restore: no hid_chain.dll, ini or stock twins left' ((Test-Path (Join-Path $bin 'hid_chain.dll')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock'))) 'False'

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed'
