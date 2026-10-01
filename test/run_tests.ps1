# Checks the window without a screen: draws it into out\shots at 100, 150, 200 and 225 % (first size and as tall as
# every card), narrow and wide; then drives the tick rules through the exe's own classes.
# usage (after build.ps1): powershell -NoProfile -ExecutionPolicy Bypass -File test\run_tests.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe = Join-Path $root 'out\SnowRunnerNextGen.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'out\SnowRunnerNextGen.exe is missing: run build.ps1 first' }
$shots = Join-Path $root 'out\shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$script:failed = 0

function Shot([string]$name, [string[]]$options) {
  $png = Join-Path $shots "$name.png"
  $p = Start-Process -FilePath $exe -ArgumentList (@('--shot', "`"$png`"") + $options) -Wait -PassThru
  if ($p.ExitCode -ne 0) { "FAIL shot ${name}: " + (Get-Content -Raw -LiteralPath "$png.error.txt"); $script:failed++; return }
  $img = [System.Drawing.Image]::FromFile($png)
  try { 'ok   shot {0,-10} {1} x {2}' -f $name, $img.Width, $img.Height } finally { $img.Dispose() }
}

foreach ($s in '1', '1.5', '2', '2.25') {
  Shot "scale$s" @('--scale', $s)
  Shot "scale$s-all" @('--scale', $s, '--size', '0x0')
}
Shot 'narrow' @('--scale', '1', '--size', '560x0')
Shot 'wide' @('--scale', '1', '--size', '1600x0')

# every (?) pop-up, and the one with pictures at 200 and 225 %
$ids = 'shadows', 'edges', 'blocker', 'contact', 'gtao', 'ambient', 'gi', 'objrefl', 'headglow', 'water', 'rivertint', 'glare', 'fog', 'smoke', 'smokeshade', 'particles', 'stars', 'tonemap', 'bloom', 'scenery', 'grass', 'installer'
foreach ($id in $ids) { Shot "help-$id" @('--scale', '1', '--help', $id) }
Shot 'help-gtao-2' @('--scale', '2', '--help', 'gtao')
Shot 'help-gtao-2.25' @('--scale', '2.25', '--help', 'gtao')

function Check([string]$what, [string]$got, [string]$want) {
  if ($got -eq $want) { "ok   $what" } else { "FAIL $what"; "     got:  $got"; "     want: $want"; $script:failed++ }
}

# the tick rules: ticking a card ticks what it needs, unticking one unticks what needs it
$asm = [Reflection.Assembly]::LoadFrom($exe)
$flags = [Reflection.BindingFlags]'NonPublic,Public,Instance'
$viewType = $asm.GetType('SnowRunnerNextGen.MainView')
$font = $asm.GetType('SnowRunnerNextGen.Look').GetMethod('BaseFont').Invoke($null, @([single]1))
$view = [Activator]::CreateInstance($viewType, $flags, $null, @($font, $null), $null)
try {
  $list = $viewType.GetField('list', $flags).GetValue($view)
  $bar = $viewType.GetField('bar', $flags).GetValue($view)
  $cards = @{}
  foreach ($c in $list.Cards) { $cards[$c.Module.Id] = $c }
  function Ticked { ($list.Cards | Where-Object { $_.On } | ForEach-Object { $_.Module.Id }) -join ' ' }
  function Note { $bar.GetType().GetField('note', $flags).GetValue($bar) }

  # on by default: every card but Headlight glare cap, Headlights in reflections, Brighter stars, Scenery detail and Grass reach
  $defaults = 'shadows edges blocker contact gtao aofar ambient fill gi objrefl water puddles rivertint crestglow fog smoke smokeshade particles tonemap bloom grade'
  Check 'defaults' (Ticked) $defaults
  Check 'count' (Note) '21 of 26 selected'
  # the options' defaults: the rebuilt shadow edges and the game's own shadow size
  $keyOf = { param($id) $c = $cards[$id]; $c.Module.Options[0].Keys[$c.Choice[0]] }
  Check 'shadow edges: rebuilt by default' (& $keyOf 'edges') 'revec'
  Check 'SnowRunner Shadows: 1x by default' (& $keyOf 'shadows') '1'
  Check 'cascade seams: blended by default' ($cards['edges'].Module.Options[1].Keys[$cards['edges'].Choice[1]]) 'seam'
  Check 'GTAO: half size by default' (& $keyOf 'gtao') 'half'
  # what Apply sends: the seam dither only with the rebuilt edges (the bundle refuses it with the 16-tap filter)
  $selection = { $viewType.GetMethod('Selection', $flags).Invoke($view, @()) }
  $s = & $selection
  Check 'selection: rebuilt edges, the seam dither, AO at half size' ((@($s['shader']) -contains 'revec') -and (@($s['shader']) -contains 'seam') -and ($s['shadows']['aoHalf'] -eq '1')) 'True'
  $cards['edges'].Choice[0] = 1
  $s = & $selection
  Check 'selection: the 16-tap filter goes without the seam dither' ((@($s['shader']) -contains 'crisp') -and -not (@($s['shader']) -contains 'seam') -and -not (@($s['shader']) -contains 'revec')) 'True'
  $cards['edges'].Choice[0] = 0
  # the headlights in reflections go out only with the reflection pass
  $cards['headglow'].On = $true
  $s = & $selection
  Check 'selection: the headlights in reflections with the reflection pass' (@($s['shader']) -contains 'headglow') 'True'
  $cards['objrefl'].Choice[0] = 1
  $s = & $selection
  Check 'selection: not with the march-only method' (@($s['shader']) -contains 'headglow') 'False'
  $cards['objrefl'].Choice[0] = 0
  $cards['headglow'].On = $false
  $cards['shadows'].ToggleByUser()
  # Sun glow through waves goes with Water reflections, which needs SnowRunner Shadows
  Check 'untick SnowRunner Shadows' (Ticked) 'edges blocker gtao aofar ambient fill rivertint fog smoke smokeshade particles tonemap bloom grade'
  Check 'its note' (Note) 'Contact shadows, Bounce light, Object reflections, Water reflections, Sun glow through waves and Wet ground reflections need SnowRunner Shadows: unticked them too.'
  $cards['gi'].ToggleByUser()
  Check 'tick Bounce light' (Ticked) 'shadows edges blocker gtao aofar ambient fill gi rivertint fog smoke smokeshade particles tonemap bloom grade'
  Check 'its note' (Note) 'Bounce light needs SnowRunner Shadows: ticked it too.'
  $cards['gtao'].ToggleByUser()
  Check 'untick GTAO' (Ticked) 'shadows edges blocker ambient fill rivertint fog smoke smokeshade particles tonemap bloom grade'
  Check 'its note' (Note) 'Wide occlusion and Bounce light need GTAO: unticked them too.'
  $viewType.GetMethod('SetAll', $flags).Invoke($view, @($false))
  Check 'clear' (Note) '0 of 26 selected'
  $viewType.GetMethod('SetAll', $flags).Invoke($view, @($true))
  Check 'select all' (Note) '26 of 26 selected'
  foreach ($c in $list.Cards) { $c.Reset() }
  Check 'defaults again' (Ticked) $defaults

  # every module explains itself, and every picture it names is next to the exe
  $help = $asm.GetType('SnowRunnerNextGen.Help')
  $without = @(); $missing = @()
  foreach ($c in $list.Cards) {
    $topic = $help.GetMethod('TopicFor').Invoke($null, @($c.Module))
    if ($topic.Entry.Sections.Count -eq 0) { $without += $c.Module.Id }
    foreach ($p in $topic.Entry.Pictures) {   # (loaded here, the exe's own help folder would be PowerShell's)
      foreach ($side in 'before', 'after') { if (-not (Test-Path -LiteralPath (Join-Path $root "out\help\$($p.Stem)_$side.jpg"))) { $missing += "$($p.Stem)_$side" } }
    }
  }
  Check 'every module has help' ($without -join ' ') ''
  Check 'every help picture is there' ($missing -join ' ') ''
}
finally { $view.Dispose() }

if ($script:failed) { throw "$($script:failed) check(s) failed" }
'all passed; pictures in ' + $shots
