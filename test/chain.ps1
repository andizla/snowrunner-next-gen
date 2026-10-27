# The whole test chain, its steps side by side where they do not share a folder, each with a log of its own in
# out\chain. Order: build.ps1; package.ps1 -Zip (it builds the exe again, which run_tests holds open, and out\engine,
# which the engine test runs from); then run_tests, release_test and the engine test's four parts together; then the
# package test's four parts together (a game copy is about 8 GB, so the two sets of four do not overlap); then the
# parts' folders are deleted when every step passed. A step fails by throwing, not by the exit code of its last
# command (the package test's last one exits 1 on purpose).
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File test\chain.ps1 [-Old <last release's zip>]
param([string]$Old = (Join-Path $env:USERPROFILE 'Downloads\SnowRunnerNextGen.zip'), [string]$Originals = $env:SR_ORIGINALS)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
if (-not $Originals) { $Originals = Join-Path $env:LOCALAPPDATA 'SnowRunnerNextGen\games\349e21402e31' }
$env:SR_ORIGINALS = $Originals
$dir = Join-Path $root 'out\chain'
if (Test-Path -LiteralPath $dir) { [IO.Directory]::Delete($dir, $true) }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir 'chain.log'
$clock = [Diagnostics.Stopwatch]::StartNew()
function Note([string]$s) { $line = ('{0:mm\:ss}  {1}' -f $clock.Elapsed, $s); $line | Out-File $log -Append -Encoding utf8; $line | Out-Host }
function Start-Step([string]$name, [string]$cmd)
{
    $out = Join-Path $dir ($name + '.out')
    $p = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ("try { & $cmd } catch { `$_ | Out-String | Write-Output; exit 1 }; exit 0") -RedirectStandardOutput $out -RedirectStandardError ($out + '.err') -NoNewWindow -PassThru
    $null = $p.Handle   # without the handle taken at start, ExitCode stays empty after the process ends
    Note ('start ' + $name)
    return @{ name = $name; p = $p; out = $out }
}
$script:bad = @()
function Wait-Step($s)
{
    $s.p.WaitForExit()
    $fails = @(Select-String -LiteralPath $s.out -Pattern '^FAIL' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line })
    $ok = $s.p.ExitCode -eq 0 -and -not $fails.Count
    if (-not $ok) { $script:bad += $s.name }
    Note ('{0} {1}{2}' -f $(if ($ok) { 'passed' } else { 'FAILED' }), $s.name, $(if ($fails.Count) { ': ' + ($fails -join ' | ') } else { '' }))
}
Note 'chain start'
Wait-Step (Start-Step 'build' '.\build.ps1')
if ($script:bad) { Note 'chain stopped'; exit 1 }
Wait-Step (Start-Step 'package' '.\package.ps1 -Zip')
if ($script:bad) { Note 'chain stopped'; exit 1 }
$first = @(Start-Step 'run_tests' '.\test\run_tests.ps1'; Start-Step 'release_test' (".\test\release_test.ps1 -Old '" + $Old + "'"))
$engine = @(foreach ($n in 1..4) { Start-Step "engine_test_$n" (".\test\engine_test.ps1 -Part $n -Work '" + (Join-Path $root "out\enginetest_e$n") + "'") })
foreach ($s in $engine) { Wait-Step $s }
foreach ($n in 1..4) { $w = Join-Path $root "out\enginetest_e$n"; if (Test-Path -LiteralPath $w) { [IO.Directory]::Delete($w, $true) } }
$package = @(foreach ($n in 1..4) { Start-Step "package_test_$n" ".\test\package_test.ps1 -Part $n" })
foreach ($s in $first + $package) { Wait-Step $s }
if (-not $script:bad) {
    foreach ($n in 1..4) {
        foreach ($w in (Join-Path $root "out\enginetest_p$n"), (Join-Path ([IO.Path]::GetTempPath()) "ngen-package-test_$n")) { if (Test-Path -LiteralPath $w) { [IO.Directory]::Delete($w, $true) } }
    }
}
Note $(if ($script:bad) { 'chain FAILED: ' + ($script:bad -join ', ') } else { 'chain passed' })
if ($script:bad) { exit 1 }
