# Tests the engine and the window's game finder on stand-ins for the three folder layouts the stores use, each with the
# original shader.pak alone and a stand-in SnowRunner.exe: the game in the folder itself (Steam), everything one folder
# down in en_us (Epic Games), and the Xbox app's (Microsoft Store, Game Pass: <library>\<title>\Content with the paks
# under paks and SnowRunner.exe next to them; a stand-in built from a player's description, no real install was at
# hand). For each: a picked SnowRunner.exe or shader.pak leads to the game folder, the status finds SnowRunner.exe,
# Apply puts SnowRunner Shadows next to it, a SnowRunner.exe running from there stops Restore, and Restore takes
# everything out again. For en_us also: the folder above en_us and en_us itself are one install, whichever of the two
# an install was made through (1.0.0 kept two state folders for them). For the Xbox app's: a pak only an administrator
# may change stops Apply with what to do, the title's folder and Content are one install, and the library is read from
# a drive's .GamingRoot. Last, the log names what each run found. Never the real game: the copies live in out\.
# The running check starts a small Windows program under the name SnowRunner.exe from the copy's Bin for a few seconds.
# Takes about three minutes and 300 MB of disk.
# usage (after build.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\layout_test.ps1
# -Engine <folder>: test that engine instead (a package's engine\ with its own node.exe)
# -Originals <folder>: where shader.pak.orig is
param([string]$Engine = '', [string]$Originals = 'C:\Games\SnowRunner-shaders\pak_backup')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ngen = if ($Engine) { Join-Path $Engine 'ngen.js' } else { Join-Path $root 'out\engine\ngen.js' }
if (-not (Test-Path -LiteralPath $ngen)) { throw "$ngen is missing: run build.ps1 (or package.ps1) first" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
if ($Engine) { $node = Join-Path $Engine 'node.exe' }
$original = Join-Path $Originals 'shader.pak.orig'

$work = Join-Path $root 'out\layouttest'
if (Test-Path -LiteralPath $work) { [System.IO.Directory]::Delete($work, $true) }   # the previous run's copies
$script:failed = 0

function Engine([string]$game, [string[]]$arguments) {
  $lines = & $node $ngen @arguments --game $game
  $events = @($lines | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
  foreach ($e in $events) { if ($e.type -ne 'status') { '     {0,-5} {1}' -f $e.type, $e.text | Out-Host } }
  return ,$events
}
function Status([string]$game) { $s = Engine $game @('status'); return $s | Where-Object { $_.type -eq 'status' } | Select-Object -First 1 }
function Check([string]$what, $got, $want) {
  if ("$got" -eq "$want") { "ok   $what" } else { "FAIL $what"; "     got:  $got"; "     want: $want"; $script:failed++ }
}
function Hash($file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
# the state folder's name for a game folder (engine\ngen.js stateDir)
function Named([string]$folder) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $hex = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($folder.ToLowerInvariant())) | ForEach-Object { $_.ToString('x2') })
  return Join-Path (Join-Path $env:NGEN_STATE_ROOT 'games') $hex.Substring(0, 12)
}

# the window's own finder (src\GameFinder.cs), from the exe next to the engine under test
$exe = if ($Engine) { Join-Path (Split-Path -Parent $Engine) 'SnowRunnerNextGen.exe' } else { Join-Path $root 'out\SnowRunnerNextGen.exe' }
$finder = [Reflection.Assembly]::LoadFrom($exe).GetType('SnowRunnerNextGen.GameFinder')
function Finder([string]$method, [object[]]$arguments) {
  # (PowerShell hands its own wrapper around a value on: the method wants the value itself)
  $plain = New-Object object[] $arguments.Count
  for ($i = 0; $i -lt $arguments.Count; $i++) {   # (assigned in place: an empty list sent through an if expression arrives as nothing)
    if ($arguments[$i] -is [psobject]) { $plain[$i] = $arguments[$i].PSObject.BaseObject } else { $plain[$i] = $arguments[$i] }
  }
  return $finder.GetMethod($method).Invoke($null, $plain)
}

# each layout: top = the folder a store names as the install, game = the folder in it that holds the game's own
# folders, then where the paks and SnowRunner.exe lie in that one
$layouts = @(
  @{ name = 'the game in the folder itself'; top = 'steam\SnowRunner'; game = ''; paks = 'preload\paks\client'; bin = 'Sources\Bin' },
  @{ name = 'the game under en_us'; top = 'epic\SnowRunner'; game = 'en_us'; paks = 'preload\paks\client'; bin = 'Sources\Bin' },
  @{ name = 'the Xbox app''s folders'; top = 'xbox\Games\SnowRunner - Windows10'; game = 'Content'; paks = 'paks\client'; bin = '' })
foreach ($l in $layouts) {
  $layout = $l.name
  $deep = $l.game -eq 'en_us'
  $flat = $l.bin -eq ''   # SnowRunner.exe in the game's own folder, as the Xbox app keeps it
  $top = Join-Path $work $l.top
  $game = if ($l.game) { Join-Path $top $l.game } else { $top }   # the folder that holds preload and Sources, or paks and the exe
  $paks = Join-Path $game $l.paks
  $bin = if ($l.bin) { Join-Path $game $l.bin } else { $game }
  $pak = Join-Path $paks 'shader.pak'
  New-Item -ItemType Directory -Force -Path $paks, $bin | Out-Null
  Copy-Item -LiteralPath $original -Destination $pak
  Set-Content -LiteralPath (Join-Path $bin 'SnowRunner.exe') -Value 'stand-in'
  $base = Join-Path $work ($l.top -split '\\')[0]
  $env:NGEN_STATE_ROOT = Join-Path $base 'state'
  $selection = Join-Path $base 'selection.json'
  [ordered]@{ shader = @('gtao'); shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = $null; grass = $null; fill = $null; grade = $null } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $selection -Encoding ASCII

  "${layout}: found from $top"
  # the window: a picked SnowRunner.exe or shader.pak leads to a folder the engine takes (the folder above en_us for
  # a pak there, as before)
  Check 'window: the folder of a picked SnowRunner.exe' (Finder 'FolderOfPick' @((Join-Path $bin 'SnowRunner.exe'))) $game
  Check 'window: the folder of a picked shader.pak' (Finder 'FolderOfPick' @($pak)) $(if ($deep) { $top } else { $game })
  Check 'window: the store''s folder is a game folder' (Finder 'IsGame' @($top)) 'True'
  Check 'status: SnowRunner.exe is found, nothing installed' ('{0} {1}' -f (Status $top).shader.state, (Status $top).dll.state) 'stock none'
  if ($flat) {
    # the Xbox app's files: Windows lets only an administrator change them
    & icacls $pak /deny "${env:USERNAME}:(WD,AD)" | Out-Null
    try {
      $r = Engine $top @('apply', '--selection', $selection)
      $e = $r[$r.Count - 1]
      Check 'a pak only an administrator may change: Apply stops before any change and says what to do' ('{0} {1} {2}' -f $e.type, $e.touched, ($e.text -match '^shader\.pak cannot be written .*Run as administrator')) 'error False True'
    }
    finally { & icacls $pak /remove:d $env:USERNAME | Out-Null }
  }
  $r = Engine $top @('apply', '--selection', $selection)
  $done = $r[$r.Count - 1]
  # (in the Xbox app's layout one note: SnowRunner Shadows is not tested on that version)
  Check $(if ($flat) { 'apply: done, with the note that SnowRunner Shadows is untested there' } else { 'apply: done without a note' }) ('{0} {1}' -f $done.type, $done.warnings) $(if ($flat) { 'done 1' } else { 'done 0' })
  if ($flat) { Check 'apply: the note names the Xbox app''s version' ([bool]@($r | Where-Object { $_.type -eq 'warn' -and $_.text -match 'Xbox app.*not tested there' }).Count) 'True' }
  Check 'apply: hid.dll, its ini and the stock twins are beside SnowRunner.exe' ((Test-Path (Join-Path $bin 'hid.dll')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -and (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock'))) 'True'
  Check 'apply: status' ('{0} {1}' -f (Status $top).shader.state, (Status $top).dll.state) 'ours ours'

  # a game running from this Bin: a small Windows program under the game's name
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\ping.exe') -Destination (Join-Path $bin 'SnowRunner.exe') -Force
  $running = Start-Process -FilePath (Join-Path $bin 'SnowRunner.exe') -ArgumentList '-n', '60', '127.0.0.1' -WindowStyle Hidden -PassThru
  try {
    Start-Sleep -Milliseconds 500
    Check 'a SnowRunner.exe running from this Bin: the status says so' (Status $top).running 'True'
    $r = Engine $top @('restore')
    $e = $r[$r.Count - 1]
    Check 'a SnowRunner.exe running from this Bin: Restore stops' ('{0} {1} {2}' -f $e.type, $e.code, $e.touched) 'error running False'
  }
  finally { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue; $running.WaitForExit() }
  Check 'the game closed: the status says so' (Status $top).running 'False'

  if ($deep) {
    'the same install through en_us (SnowRunner.exe picked in the window)'
    Check 'en_us: the same install' ('{0} {1}' -f (Status $game).shader.state, (Status $game).dll.state) 'ours ours'
    $ownState = Named $game; $earlier = Named $top
    Check 'en_us: one state folder, named after the folder that holds preload' ('{0} {1}' -f (Test-Path -LiteralPath (Join-Path $ownState 'shader.pak.orig')), (Test-Path -LiteralPath $earlier)) 'True False'
    # 1.0.0 named the state after the folder it was given. After its Restore the folder above en_us kept its original
    # while a later install through en_us is the live one: that one counts
    New-Item -ItemType Directory -Force -Path $earlier | Out-Null
    Copy-Item -LiteralPath (Join-Path $ownState 'shader.pak.orig') -Destination $earlier
    Check 'two state folders with originals: the one of en_us counts, from either folder' ('{0} {1}' -f (Status $top).shader.state, (Status $game).shader.state) 'ours ours'
    # and an install 1.0.0 made through the folder above en_us alone: its state is found from either folder
    [System.IO.Directory]::Delete($earlier, $true)
    Rename-Item -LiteralPath $ownState -NewName (Split-Path -Leaf $earlier)
    Check 'the state of a 1.0.0 install: found from either folder' ('{0} {1}' -f (Status $top).shader.state, (Status $game).shader.state) 'ours ours'
    Check 'the state of a 1.0.0 install: no second folder was made for it' (@(Get-ChildItem -LiteralPath (Join-Path $env:NGEN_STATE_ROOT 'games') -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'shader.pak.orig') }).Count) 1
  }

  if ($flat) {
    'the same install through Content (SnowRunner.exe picked in the window), and the Xbox app''s library on a drive'
    Check 'Content: the same install' ('{0} {1}' -f (Status $game).shader.state, (Status $game).dll.state) 'ours ours'
    Check 'Content: one state folder, named after the folder with SnowRunner.exe' ('{0} {1}' -f (Test-Path -LiteralPath (Join-Path (Named $game) 'shader.pak.orig')), (Test-Path -LiteralPath (Named $top))) 'True False'
    # a drive the Xbox app installs to names its library folder in .GamingRoot: "RGBX", a count, the names in UTF-16
    $drive = Join-Path $work 'xbox'
    [IO.File]::WriteAllBytes((Join-Path $drive '.GamingRoot'), [byte[]](0x52, 0x47, 0x42, 0x58, 1, 0, 0, 0) + [Text.Encoding]::Unicode.GetBytes("Games`0"))
    Check 'window: .GamingRoot names the library folder' ((Finder 'GamingRoot' @((Join-Path $drive '.GamingRoot'))) -join '|') 'Games'
    $roots = New-Object 'System.Collections.Generic.List[string]'
    [void](Finder 'XboxTitles' @($drive, $roots))
    Check 'window: the title is found in that library by its name' ($roots -join '|') $game
  }

  $r = Engine $game @('restore')
  Check 'restore: done' ($r[$r.Count - 1].type) 'done'
  Check 'restore: shader.pak is the original byte for byte' (Hash $pak) (Hash $original)
  Check 'restore: no hid.dll, ini, stock twins or note left' ((Test-Path (Join-Path $bin 'hid.dll')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock')) -or (Test-Path (Join-Path $paks 'SnowRunnerNextGen.json'))) 'False'

  # the log: what each run was given and found, and its lines
  $log = Join-Path $env:NGEN_STATE_ROOT 'install.log'
  $text = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  Check 'the log names the run, where SnowRunner.exe was found, the selection and the end' ('{0} {1} {2} {3}' -f ($text -match '==== apply for '), $text.Contains('SnowRunner.exe in ' + $bin), ($text -match 'selection \{"shader":\["gtao"\]'), ($text -match $(if ($flat) { 'done  Installed, with one note above\.' } else { 'done  Installed\. Start the game to see it\.' }))) 'True True True True'
  Check 'the log has the stop for the running game' ($text -match 'error \[running\] .* \(nothing was changed\)') 'True'
}

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed; the copies are under ' + $work
