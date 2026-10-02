# Tests the engine (engine\ngen.js) on a copy of the game, never the real one: out\enginetest\game holds the original
# paks (copied from the kept originals) and a stand-in SnowRunner.exe, with its own state folder. Checks the status of
# the untouched copy, a first install of every part, the same apply again (nothing to rebuild), a change of every
# part, another mod's hid.dll kept beside ours, the grass and the fill light (two parts of initial.pak) one without the
# other, another mod's files added to boot.pak, initial.pak and gfx.pak after Next Gen's changes (the question naming
# the files, leaving them out, taking them as the originals), the night sky waiting for a changed initial.pak, and
# restore, which then takes Next Gen's changes out and keeps the other mod's files: shader.pak and shared.pak are the
# originals byte for byte. Last, the kept originals are lost while the changes are still in the game: Apply and
# Restore stop on the note in the game folder until the files are the game's own again.
# Takes several minutes (shader.pak builds, 2 GB shared.pak writes) and about 10 GB of disk.
# usage (after build.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\engine_test.ps1
# -Engine <folder>: test that engine instead (a package's engine\ with its own node.exe, see package_test.ps1)
# -Originals <folder>: where shader.pak.orig, shared.pak.orig, initial.pak.orig, boot.pak.orig and gfx.pak.orig are
param([string]$Engine = '', [string]$Originals = 'C:\Games\SnowRunner-shaders\pak_backup')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ngen = if ($Engine) { Join-Path $Engine 'ngen.js' } else { Join-Path $root 'out\engine\ngen.js' }
if (-not (Test-Path -LiteralPath $ngen)) { throw "$ngen is missing: run build.ps1 (or package.ps1) first" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if ($Engine) { $node = Join-Path $Engine 'node.exe' }
$originals = $Originals

$work = Join-Path $root 'out\enginetest'
if (Test-Path -LiteralPath $work) { [System.IO.Directory]::Delete($work, $true) }   # the previous run's copy
$game = Join-Path $work 'game'
$paks = Join-Path $game 'preload\paks\client'
$bin = Join-Path $game 'Sources\Bin'
New-Item -ItemType Directory -Force -Path $paks, $bin | Out-Null
'copying the original paks into ' + $game
foreach ($p in 'shader', 'shared', 'initial', 'boot', 'gfx') { Copy-Item -LiteralPath (Join-Path $originals "$p.pak.orig") -Destination (Join-Path $paks "$p.pak") }
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
  '{0} [{1}] dll {2} {3}/{4} scenery {5} grass {6}{7} fill {8}{9} grade {10}{11} particles {12} stars {13}{14} sky {15} logos {16}' -f $s.shader.state, ($s.shader.modules -join ','), $s.dll.state, $s.dll.factor, $s.dll.slopeBias, $s.scenery, $s.grass.state, $s.grass.factor, $s.fill.state, $s.fill.factor, $s.grade.state, $s.grade.strength, $s.particles.state, $s.stars.state, $s.stars.factor, $s.sky.state, $s.logos.state
}
function Hash($file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Warned($events, [string]$pattern) { return [bool]@($events | Where-Object { $_.type -eq 'warn' -and $_.text -match $pattern }).Count }
# what the last build of initial.pak in an apply said it holds
function LastInitial($events) { return "$(@($events | Where-Object { $_.text -match 'initial\.pak now has' } | Select-Object -Last 1).text)" }
# the paks the engine's note in the game folder names, or none
function Note {
  $file = Join-Path $paks 'SnowRunnerNextGen.json'
  if (-not (Test-Path -LiteralPath $file)) { return 'none' }
  return (@((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).files.PSObject.Properties | ForEach-Object { $_.Name }) | Sort-Object) -join ' '
}
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
# the other mod's three files (CRC-32 of their text, from zlib)
$modFile1 = 'ngen_test/another_mod_1.txt'; $modText1 = "another mod's file 1"; $modCrc1 = [uint32]684587841    # 28cdfb41
$modFile2 = 'ngen_test/another_mod_2.txt'; $modText2 = "another mod's file 2"; $modCrc2 = [uint32]2982456059   # b1c4aafb
$modFile3 = 'ngen_test/another_mod_3.txt'; $modText3 = "another mod's file 3"; $modCrc3 = [uint32]3334707821   # c6c39a6d
$boot = Join-Path $paks 'boot.pak'; $initial = Join-Path $paks 'initial.pak'; $gfx = Join-Path $paks 'gfx.pak'

# the window's default shader modules, in the bundle's order: every module but the headlight glare cap, the 16-tap
# filter and the march-only reflections
$default = 'gtao', 'aofar', 'revec', 'blocker', 'seam', 'ambient', 'fog', 'tonemap', 'bloom', 'water', 'rivertint', 'crestglow', 'puddles', 'gi', 'smoke', 'smokeshade', 'sssr', 'headglow', 'contact'
# every part changed: without the fog, the contact shadows and the headlights in reflections, the 16-tap filter in
# place of the rebuilt edges (so both filters' sets get made, and the seam dither goes with the rebuilt edges)
$less = @($default | Where-Object { $_ -notin 'fog', 'seam', 'contact', 'headglow' } | ForEach-Object { if ($_ -eq 'revec') { 'crisp' } else { $_ } })

'the untouched copy'
Check 'status: the originals' (Summary (Status)) 'stock [] dll none / scenery vanilla grass vanilla fill vanilla grade vanilla particles vanilla stars vanilla sky vanilla logos vanilla'

'every part: the default set with the scenery detail and the grass reach'
$everything = [ordered]@{ shader = $default; shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = 'all'; grass = '3'; fill = '0.7'; grade = '1'; particles = '1'; sky = '1'; stars = '3'; logos = '1' }
$r = Apply $everything
Check 'every part: done' (Last $r) 'done'
Check 'every part: status' (Summary (Status)) ('ours [' + ($default -join ',') + '] dll ours 1/1 scenery all grass ours3 fill ours0.7 grade ours1 particles ours stars ours3 sky ours logos ours')
Check 'every part: boot.pak holds the grade, the sprites and the night sky' ((EntriesDiff (Entries $boot) (Entries (Join-Path $originals 'boot.pak.orig'))) -replace ':.*$', '') 'differs in 90'
Check 'every part: gfx.pak holds the logos' ((EntriesDiff (Entries $gfx) (Entries (Join-Path $originals 'gfx.pak.orig'))) -replace ':.*$', '') 'differs in 8'
Check 'every part: initial.pak has the sky levels the photo skies need' ((LastInitial $r) -match 'the sky alpha that boot\.pak''s photo night skies need') 'True'
Check 'every part: the note in the game folder names the five paks' (Note) 'boot.pak gfx.pak initial.pak shader.pak shared.pak'
Check 'ini: the ambient occlusion pass at half size' ((Get-Content -LiteralPath (Join-Path $bin 'SnowRunnerShadows.ini')) -contains 'AOHalf=1') 'True'
Check 'Bin has hid.dll, its ini and the stock twins' ((Test-Path (Join-Path $bin 'hid.dll')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock'))) 'True'

'the same selection again'
$clock = [Diagnostics.Stopwatch]::StartNew()
$r = Apply $everything
$clock.Stop()
Check 'same again: done' (Last $r) 'done'
Check 'same again: nothing rebuilt (under 30 s)' ($clock.Elapsed.TotalSeconds -lt 30) 'True'

'every part changed'
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3'; slopeBias = '0'; aoHalf = '0' }; scenery = 'nature'; grass = '2'; fill = '0.55'; grade = '0.5'; stars = '2' })
Check 'changed: done' (Last $r) 'done'
Check 'changed: the ambient occlusion pass at full size' ((Get-Content -LiteralPath (Join-Path $bin 'SnowRunnerShadows.ini')) -contains 'AOHalf=0') 'True'
Check 'changed: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3/0 scenery nature grass ours2 fill ours0.55 grade ours0.5 particles vanilla stars ours2 sky vanilla logos vanilla')
Check 'changed: gfx.pak is the original byte for byte' (Hash $gfx) (Hash (Join-Path $originals 'gfx.pak.orig'))
Check 'changed: boot.pak holds the grade alone' ((EntriesDiff (Entries $boot) (Entries (Join-Path $originals 'boot.pak.orig'))) -replace ':.*$', '') 'differs in 4'
Check 'changed: initial.pak is built again without the photo skies'' sky levels' ('{0} {1}' -f ((LastInitial $r) -match 'initial\.pak now has'), ((LastInitial $r) -match 'sky alpha')) 'True False'

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
Check 'fill off: the grass stays' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass ours2 fill vanilla grade ours0.5 particles vanilla stars vanilla sky vanilla logos vanilla')
$r = Apply ([ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = $null; fill = '0.85'; grade = $null })
Check 'grass and grade off, fill on: done' (Last $r) 'done'
Check 'grass and grade off, fill on: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass vanilla fill ours0.85 grade vanilla particles vanilla stars vanilla sky vanilla logos vanilla')
Check 'grade off: boot.pak is the original byte for byte' (Hash $boot) (Hash (Join-Path $originals 'boot.pak.orig'))

'other mods: files added to boot.pak, initial.pak and gfx.pak after Next Gen''s changes'
$sel = { param($grade, $sky) [ordered]@{ shader = $less; shadows = [ordered]@{ factor = '3.5'; slopeBias = '1' }; scenery = 'nature'; grass = $null; fill = '0.85'; grade = $grade; sky = $sky; logos = '1' } }
$r = Apply (& $sel '0.5' $null)
Check 'fill light, grade and logos on: done' (Last $r) 'done'
foreach ($pak in $boot, $initial, $gfx) { AddEntry $pak $modFile1 $modText1 $modCrc1 }
$before = @{}; foreach ($pak in $boot, $initial, $gfx) { $before[$pak] = Hash $pak }
function Untouched { return [bool](-not @($boot, $initial, $gfx | Where-Object { (Hash $_) -ne $before[$_] }).Count) }
$r = Apply (& $sel '1' '1')
$e = $r[$r.Count - 1]
Check 'other mods: asks first, naming the three files' ('{0} {1} {2}' -f $e.type, $e.code, (@($e.files) -join ',')) 'error adopt-files initial.pak,boot.pak,gfx.pak'
Check 'other mods: the notice' ($e.text -match 'Next Gen then writes its changes over them, and Restore puts them back as they are now, the other mod''s changes included') 'True'
Check 'other mods: nothing written before the answer' (Untouched) 'True'
$r = Apply (& $sel '1' '1') @('--leave')
Check 'leave them out: done' (Last $r) 'done'
Check 'leave them out: says so' ((Warned $r '^boot\.pak .*so the photo grade was left out') -and (Warned $r '^boot\.pak .*so the night sky was left out') -and (Warned $r '^initial\.pak .*the fill light was left out') -and (Warned $r '^gfx\.pak .*so the Next Gen logo was left out')) 'True'
Check 'leave them out: the three untouched' (Untouched) 'True'
$r = Apply (& $sel '1' '1') @('--adopt')
Check 'take them as the originals: done' (Last $r) 'done'
Check 'take them as the originals: status' (Summary (Status)) ('ours [' + ($less -join ',') + '] dll ours 3.5/1 scenery nature grass vanilla fill ours0.85 grade ours1 particles vanilla stars vanilla sky ours logos ours')
Check 'take them as the originals: the other mod''s file is still in the three' ('{0} {1} {2}' -f (Entries $boot)[$modFile1], (Entries $initial)[$modFile1], (Entries $gfx)[$modFile1]) ('{0:x8}/20 {0:x8}/20 {0:x8}/20' -f $modCrc1)

'the night sky and a changed initial.pak: its photo skies need their levels set there'
AddEntry $initial $modFile3 $modText3 $modCrc3
$bootBefore = Hash $boot
$r = Apply (& $sel '1' $null) @('--leave')
Check 'night sky unticked, initial.pak left out: done' (Last $r) 'done'
Check 'night sky unticked, initial.pak left out: the night sky stays in' ('{0} {1} {2}' -f (Warned $r '^initial\.pak .*the night sky was left in'), ((Hash $boot) -eq $bootBefore), (Status).sky.state) 'True True ours'
$r = Apply (& $sel '1' $null) @('--adopt')
Check 'night sky unticked, initial.pak taken as the original: the night sky goes out' ('{0} {1} {2}' -f (Last $r), (Status).sky.state, ((LastInitial $r) -match 'sky alpha')) 'done vanilla False'

'restore, with more of the other mod''s files added since the last apply'
foreach ($pak in $boot, $initial, $gfx) { AddEntry $pak $modFile2 $modText2 $modCrc2 }
$r = Engine @('restore')
$e = $r[$r.Count - 1]
Check 'restore: asks first, naming the three files' ('{0} {1} {2}' -f $e.type, $e.code, (@($e.files) -join ',')) 'error adopt-files initial.pak,boot.pak,gfx.pak'
Check 'restore: the notice' ($e.text -match 'Restore then takes Next Gen''s own changes out of them and keeps the other mod''s: the game''s own files do not come back') 'True'
$r = Engine @('restore', '--adopt')
Check 'restore: done' (Last $r) 'done'
Check 'restore: status' (Summary (Status)) 'stock [] dll foreign / scenery vanilla grass vanilla fill vanilla grade vanilla particles vanilla stars vanilla sky vanilla logos vanilla'
foreach ($p in 'shader', 'shared') { Check "restore: $p.pak is the original byte for byte" (Hash (Join-Path $paks "$p.pak")) (Hash (Join-Path $originals "$p.pak.orig")) }
foreach ($p in 'initial', 'boot', 'gfx') {
  $want = Entries (Join-Path $originals "$p.pak.orig")
  $want[$modFile1] = '{0:x8}/20' -f $modCrc1; $want[$modFile2] = '{0:x8}/20' -f $modCrc2
  if ($p -eq 'initial') { $want[$modFile3] = '{0:x8}/20' -f $modCrc3 }
  Check "restore: $p.pak is the original plus the other mod's files, without Next Gen's changes" (EntriesDiff (Entries (Join-Path $paks "$p.pak")) $want) 'same'
}
Check 'restore: the other mod''s hid.dll is back' (Hash (Join-Path $bin 'hid.dll')) $foreignHash
Check 'restore: no hid_chain.dll, ini or stock twins left' ((Test-Path (Join-Path $bin 'hid_chain.dll')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock'))) 'False'
Check 'restore: the note in the game folder is gone' (Note) 'none'

'the kept originals lost while the changes are still in the game'
$small = [ordered]@{ shader = @('gtao'); shadows = $null; scenery = $null; grass = $null; fill = '0.7'; grade = '1' }
$r = Apply $small
Check 'a small set: done' (Last $r) 'done'
Check 'a small set: the note names its three paks' (Note) 'boot.pak initial.pak shader.pak'
# the state folder goes: the engine makes an empty one at the same place
Rename-Item -LiteralPath $env:NGEN_STATE_ROOT -NewName 'state.lost'
$shaderPak = Join-Path $paks 'shader.pak'
$was = @{}; foreach ($pak in $shaderPak, $boot, $initial) { $was[$pak] = Hash $pak }
Check 'originals lost: the status names the three paks' ((@((Status).orphaned) | Sort-Object) -join ' ') 'boot.pak initial.pak shader.pak'
$r = Apply $small
$e = $r[$r.Count - 1]
Check 'originals lost: Apply stops' ('{0} {1} {2}' -f $e.type, $e.code, ((@($e.files) | Sort-Object) -join ',')) 'error orphaned boot.pak,initial.pak,shader.pak'
Check 'originals lost: it says why and what to do' (($e.text -match 'would make those changes a second time') -and ($e.text -match 'Have the store check the game''s files')) 'True'
$r = Engine @('restore')
$e = $r[$r.Count - 1]
Check 'originals lost: Restore stops too' ('{0} {1}' -f $e.type, $e.code) 'error orphaned'
Check 'originals lost: nothing was written' ([bool](-not @($shaderPak, $boot, $initial | Where-Object { (Hash $_) -ne $was[$_] }).Count)) 'True'

'after the store''s file check: the game''s own files are back, the state folder still empty'
foreach ($p in 'shader', 'boot', 'initial') { Copy-Item -LiteralPath (Join-Path $originals "$p.pak.orig") -Destination (Join-Path $paks "$p.pak") -Force }
Check 'after the file check: no pak is named any more' (@((Status).orphaned).Count) 0
$r = Apply ([ordered]@{ shader = @(); shadows = $null; scenery = $null; grass = $null; fill = '0.7'; grade = '1' })
Check 'after the file check: Apply works again' (Last $r) 'done'
Check 'after the file check: the note names the two paks' (Note) 'boot.pak initial.pak'
$r = Engine @('restore')
Check 'after the file check: restore, and the note is gone' ('{0} {1}' -f (Last $r), (Note)) 'done none'
foreach ($p in 'boot', 'initial') { Check "after the file check: $p.pak is the original byte for byte" (Hash (Join-Path $paks "$p.pak")) (Hash (Join-Path $originals "$p.pak.orig")) }

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed'
