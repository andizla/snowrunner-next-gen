# Tests the standalone package the way a player gets it: copies out\package\SnowRunnerNextGen to a temporary folder,
# runs test\engine_test.ps1 against that copy's engine (its own node.exe, no dev config), with the file tracer
# (test\trace_fs.js) loaded into every node process, and fails when any file outside the package copy, the test's game
# copy and state folder (out\enginetest) and %TEMP% was opened, read, listed or required: a dev path the package still
# reaches. In between, a changed code fingerprint in the copy's parts.json (a newer installer over an older install)
# must make that part again with the same selection and leave the others. Takes a few minutes.
# usage (after package.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\package_test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pkg = Join-Path $root 'out\package\SnowRunnerNextGen'
if (-not (Test-Path -LiteralPath (Join-Path $pkg 'engine\ngen.js'))) { throw 'out\package is missing: run package.ps1 first' }
$base = Join-Path ([IO.Path]::GetTempPath()) 'ngen-package-test'
if (Test-Path -LiteralPath $base) { [IO.Directory]::Delete($base, $true) }
$copy = Join-Path $base 'SnowRunnerNextGen'
New-Item -ItemType Directory -Force -Path $copy | Out-Null
Copy-Item -Path (Join-Path $pkg '*') -Destination $copy -Recurse
'package copied to ' + $copy

$trace = Join-Path $base 'trace.log'
$tracer = Join-Path $root 'test\trace_fs.js'
$env:NODE_OPTIONS = '--require ' + $tracer
$env:TRACE_FILE = $trace
try {
  & (Join-Path $root 'test\engine_test.ps1') -Engine (Join-Path $copy 'engine')

  # a newer installer over an older install (engine\parts.json): the part whose code changed is rebuilt though the
  # selection is the same, the others are left as they are, and the new fingerprint is recorded
  'a part whose code changed (the package''s parts.json)'
  $node = Join-Path $copy 'engine\node.exe'
  $ngen = Join-Path $copy 'engine\ngen.js'
  $work = Join-Path $root 'out\enginetest'
  $game = Join-Path $work 'game'
  $env:NGEN_STATE_ROOT = Join-Path $work 'state'
  $selection = Join-Path $work 'selection.json'
  [ordered]@{ shader = @('gtao'); shadows = $null; scenery = $null; grass = $null; fill = $null; grade = '0.5' } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $selection -Encoding ASCII
  function Run([string[]]$arguments) { return ,@(& $node $ngen @arguments --game $game | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }
  function Said($events, [string]$pattern) { return [bool]@($events | Where-Object { $_.text -match $pattern }).Count }
  $failed = 0
  function Expect([string]$what, [bool]$ok) { if ($ok) { "ok   $what" } else { "FAIL $what"; $script:failed++ } }
  # the files as the engine test left them: restore at the end puts them back so
  $paks = Join-Path $game 'preload\paks\client'
  $start = @{}; foreach ($p in 'shader', 'boot') { $start[$p] = (Get-FileHash -LiteralPath (Join-Path $paks "$p.pak")).Hash }
  $r = Run @('apply', '--selection', $selection)
  Expect 'gtao and the grade: done' ($r[$r.Count - 1].type -eq 'done')
  $partsFile = Join-Path $copy 'engine\parts.json'
  $partsText = [IO.File]::ReadAllText($partsFile)
  $parts = $partsText | ConvertFrom-Json
  $parts.grade = 'the grade code of a newer installer'
  $parts | ConvertTo-Json | Set-Content -LiteralPath $partsFile -Encoding ASCII
  # a newer installer's list of its files (engine\files.json) fits its own parts.json: the size goes in there too
  $listFile = Join-Path $copy 'engine\files.json'
  $listText = [IO.File]::ReadAllText($listFile)
  $list = $listText | ConvertFrom-Json
  $list.files.'engine/parts.json' = (Get-Item -LiteralPath $partsFile).Length
  $list | ConvertTo-Json | Set-Content -LiteralPath $listFile -Encoding ASCII
  try {
    $r = Run @('apply', '--selection', $selection)
    Expect 'grade code changed: done' ($r[$r.Count - 1].type -eq 'done')
    Expect 'grade code changed: the grade is made again' (Said $r '^Grading the colour at 50 %')
    Expect 'grade code changed: shader.pak is left as it is' (Said $r '^shader\.pak already has these 1 modules')
    $r = Run @('apply', '--selection', $selection)
    Expect 'same again: the new fingerprint was recorded (nothing made again)' ((Said $r '^the photo grade is already at 50 %') -and -not (Said $r '^Grading the colour'))
  }
  finally { [IO.File]::WriteAllText($partsFile, $partsText); [IO.File]::WriteAllText($listFile, $listText) }
  # the contact shadows without the shadow edges and the blocker search: the bundle reads a shadow filter set for the
  # names of the sun shadow receivers, which prepare.js makes as the rebuilt edges set for that
  $contact = Join-Path $work 'selection_contact.json'
  [ordered]@{ shader = @('contact'); shadows = [ordered]@{ factor = '1'; slopeBias = '1'; aoHalf = '1' }; scenery = $null; grass = $null; fill = $null; grade = $null } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $contact -Encoding ASCII
  $r = Run @('apply', '--selection', $contact)
  Expect 'contact shadows alone: done' ($r[$r.Count - 1].type -eq 'done')
  Expect 'contact shadows alone: the receivers'' set was made' (Said $r '^shadow filter: rebuilt edges$')
  $r = Run @('restore')
  Expect 'restore: done' ($r[$r.Count - 1].type -eq 'done')
  foreach ($p in 'shader', 'boot') {
    Expect "restore: $p.pak is as it was before, byte for byte" ((Get-FileHash -LiteralPath (Join-Path $paks "$p.pak")).Hash -eq $start[$p])
  }
  if ($failed) { throw "$failed fingerprint check(s) failed" }
}
finally { Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue; Remove-Item Env:\TRACE_FILE -ErrorAction SilentlyContinue }

# every path the package's node processes touched lies in the package copy, the test's game copy and state, or TEMP
$allowed = @($copy, (Join-Path $root 'out\enginetest'), [IO.Path]::GetTempPath().TrimEnd('\'), $tracer) | ForEach-Object { $_.ToLowerInvariant() }
$touched = @(Get-Content -LiteralPath $trace | ForEach-Object { ($_ -split "`t")[1] } | Where-Object { $_ } | Sort-Object -Unique)
$outside = @($touched | Where-Object { $p = $_.ToLowerInvariant(); -not ($allowed | Where-Object { $p.StartsWith($_) }) })
'{0} distinct paths touched by the packaged engine and its tools' -f $touched.Count
if ($outside.Count) {
  'FAIL paths outside the package, the game copy and TEMP:'
  $outside | Select-Object -First 40 | ForEach-Object { '     ' + $_ }
  throw "$($outside.Count) path(s) outside the package"
}
'ok   no dev path reached: everything came from the package copy, the game copy or TEMP'

# a copy an unzip program left incomplete (one that does not know the zip's folder paths leaves a file by the folder's
# name): the engine names what is missing and asks to unzip again, before it looks at the game
'an incomplete copy of the package'
$replacements = Join-Path $copy 'engine\replacements'
[IO.Directory]::Delete($replacements, $true)
[IO.File]::WriteAllBytes($replacements, [byte[]]::new(0))
$said = @(& (Join-Path $copy 'engine\node.exe') (Join-Path $copy 'engine\ngen.js') status --game (Join-Path $root 'out\enginetest\game') | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
$e = $said[$said.Count - 1]
if ($e.type -ne 'error' -or $e.text -notmatch '^This copy of SnowRunner Next Gen is incomplete: engine\\replacements\\' -or $e.text -notmatch 'Unzip the download again') { throw "an incomplete copy was not reported: $($e.type) $($e.text)" }
'ok   an incomplete copy says so, names the files and asks to unzip again'
