# Tests the engine on stand-ins for the two folder layouts the stores use, each with the original shader.pak alone and
# a stand-in SnowRunner.exe: the game in the folder itself (Steam), and everything one folder down in en_us (Epic
# Games). For each: the status finds Sources\Bin beside preload, Apply puts SnowRunner Shadows there without a note,
# a SnowRunner.exe running from that Bin stops Restore, and Restore takes everything out again. For en_us also: the
# folder above en_us and en_us itself are one install, whichever of the two an install was made through (1.0.0 kept
# two state folders for them). Last, the log names what each run found. Never the real game: the copies live in out\.
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

foreach ($layout in 'the game in the folder itself', 'the game under en_us') {
  $deep = $layout -match 'en_us'
  $top = Join-Path $work $(if ($deep) { 'epic\SnowRunner' } else { 'steam\SnowRunner' })
  $game = if ($deep) { Join-Path $top 'en_us' } else { $top }   # the folder that holds preload and Sources
  $paks = Join-Path $game 'preload\paks\client'
  $bin = Join-Path $game 'Sources\Bin'
  $pak = Join-Path $paks 'shader.pak'
  New-Item -ItemType Directory -Force -Path $paks, $bin | Out-Null
  Copy-Item -LiteralPath $original -Destination $pak
  Set-Content -LiteralPath (Join-Path $bin 'SnowRunner.exe') -Value 'stand-in'
  $env:NGEN_STATE_ROOT = Join-Path (Split-Path -Parent $top) 'state'
  $selection = Join-Path (Split-Path -Parent $top) 'selection.json'
  [ordered]@{ shader = @('gtao'); shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = $null; grass = $null; fill = $null; grade = $null } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $selection -Encoding ASCII

  "${layout}: found from $top"
  Check 'status: SnowRunner.exe is found, nothing installed' ('{0} {1}' -f (Status $top).shader.state, (Status $top).dll.state) 'stock none'
  $r = Engine $top @('apply', '--selection', $selection)
  $done = $r[$r.Count - 1]
  Check 'apply: done without a note' ('{0} {1}' -f $done.type, $done.warnings) 'done 0'
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

  $r = Engine $game @('restore')
  Check 'restore: done' ($r[$r.Count - 1].type) 'done'
  Check 'restore: shader.pak is the original byte for byte' (Hash $pak) (Hash $original)
  Check 'restore: no hid.dll, ini, stock twins or note left' ((Test-Path (Join-Path $bin 'hid.dll')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.ini')) -or (Test-Path (Join-Path $bin 'SnowRunnerShadows.stock')) -or (Test-Path (Join-Path $paks 'SnowRunnerNextGen.json'))) 'False'

  # the log: what each run was given and found, and its lines
  $log = Join-Path $env:NGEN_STATE_ROOT 'install.log'
  $text = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  Check 'the log names the run, where SnowRunner.exe was found, the selection and the end' ('{0} {1} {2} {3}' -f ($text -match '==== apply for '), $text.Contains('SnowRunner.exe in ' + $bin), ($text -match 'selection \{"shader":\["gtao"\]'), ($text -match 'done  Installed\. Start the game to see it\.')) 'True True True True'
  Check 'the log has the stop for the running game' ($text -match 'error \[running\] .* \(nothing was changed\)') 'True'
}

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed; the copies are under ' + $work
