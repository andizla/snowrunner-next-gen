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
$ids = 'shadows', 'edges', 'blocker', 'contact', 'gtao', 'ambient', 'gi', 'objrefl', 'headglow', 'water', 'rivertint', 'glare', 'fog', 'weather', 'smoke', 'smokeshade', 'particles', 'sky', 'stars', 'tonemap', 'bloom', 'scenery', 'grass', 'logos', 'installer'
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

  # on by default: every card but Bounce light, Headlight glare cap, Volumetric fog, Scenery detail and Grass reach
  $defaults = 'shadows edges blocker contact gtao aofar ambient fill objrefl headglow water puddles rivertint crestglow weather smoke smokeshade particles sky stars tonemap bloom grade logos'
  Check 'defaults' (Ticked) $defaults
  Check 'count' (Note) '24 of 29 selected'
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
  Check 'selection: the night sky, the stars at 3x and the logos' ('{0} {1} {2}' -f $s['sky'], $s['stars'], $s['logos']) '1 3 1'
  $cards['edges'].Choice[0] = 1
  $s = & $selection
  Check 'selection: the 16-tap filter goes without the seam dither' ((@($s['shader']) -contains 'crisp') -and -not (@($s['shader']) -contains 'seam') -and -not (@($s['shader']) -contains 'revec')) 'True'
  $cards['edges'].Choice[0] = 0
  # the headlights in reflections go out only with the reflection pass
  $s = & $selection
  Check 'selection: the headlights in reflections with the reflection pass' (@($s['shader']) -contains 'headglow') 'True'
  $cards['objrefl'].Choice[0] = 1
  $s = & $selection
  Check 'selection: not with the march-only method' (@($s['shader']) -contains 'headglow') 'False'
  $cards['objrefl'].Choice[0] = 0
  # the fog: off by default; its sun shafts: off unless picked, and then their build of the fog goes out with the fog
  $s = & $selection
  Check 'selection: no fog by default' (@($s['shader']) -contains 'fog') 'False'
  $cards['fog'].ToggleByUser()
  $s = & $selection
  Check 'sun shafts: off by default' ("$(& $keyOf 'fog')") ''
  Check 'selection: the fog without the sun shafts' ((@($s['shader']) -contains 'fog') -and -not (@($s['shader']) -contains 'fogsun')) 'True'
  $cards['fog'].Choice[0] = 1
  $s = & $selection
  Check 'selection: the sun shafts picked' ((@($s['shader']) -contains 'fog') -and (@($s['shader']) -contains 'fogsun')) 'True'
  $cards['fog'].Choice[0] = 0
  $cards['fog'].ToggleByUser()
  # the weather: the rows that are on, as the tool's comma list
  $s = & $selection
  Check 'selection: the weather, all seven parts by default' ($s['weather']) 'shadows,showers,evening,horizon,far,fireflies,pollen'
  $cards['weather'].Choice[5] = 1
  $s = & $selection
  Check 'selection: the fireflies leave the list' ($s['weather']) 'shadows,showers,evening,horizon,far,pollen'
  foreach ($row in 0..6) { $cards['weather'].Choice[$row] = 1 }
  $s = & $selection
  Check 'selection: every row off sends no weather' ("$($s['weather'])") ''
  foreach ($row in 0..6) { $cards['weather'].Choice[$row] = 0 }
  $cards['shadows'].ToggleByUser()
  # Headlights in reflections goes with Object reflections and Sun glow through waves with Water reflections, which
  # both need SnowRunner Shadows
  Check 'untick SnowRunner Shadows' (Ticked) 'edges blocker gtao aofar ambient fill rivertint weather smoke smokeshade particles sky stars tonemap bloom grade logos'
  Check 'its note' (Note) 'Contact shadows, Object reflections, Headlights in reflections, Water reflections, Sun glow through waves and Wet ground reflections need SnowRunner Shadows: unticked them too.'
  $cards['gi'].ToggleByUser()
  Check 'tick Bounce light' (Ticked) 'shadows edges blocker gtao aofar ambient fill gi rivertint weather smoke smokeshade particles sky stars tonemap bloom grade logos'
  Check 'its note' (Note) 'Bounce light needs SnowRunner Shadows: ticked it too.'
  $cards['gtao'].ToggleByUser()
  Check 'untick GTAO' (Ticked) 'shadows edges blocker ambient fill rivertint weather smoke smokeshade particles sky stars tonemap bloom grade logos'
  Check 'its note' (Note) 'Wide occlusion and Bounce light need GTAO: unticked them too.'
  $viewType.GetMethod('SetAll', $flags).Invoke($view, @($false))
  Check 'clear' (Note) '0 of 29 selected'
  $viewType.GetMethod('SetAll', $flags).Invoke($view, @($true))
  Check 'select all' (Note) '29 of 29 selected'
  foreach ($c in $list.Cards) { $c.Reset() }
  Check 'defaults again' (Ticked) $defaults

  # the cards as a game with the sun shafts installed has them, and as one with the fog alone
  $installed = [Activator]::CreateInstance($asm.GetType('SnowRunnerNextGen.GameStatus'))
  $installed.Shader = 'ours'
  foreach ($m in 'fog', 'fogsun') { $installed.Modules.Add($m) }
  $viewType.GetMethod('Mirror', $flags).Invoke($view, @($installed))
  Check 'mirror: the sun shafts as installed' ('{0} {1}' -f $cards['fog'].On, (& $keyOf 'fog')) 'True fogsun'
  [void]$installed.Modules.Remove('fogsun')
  $viewType.GetMethod('Mirror', $flags).Invoke($view, @($installed))
  Check 'mirror: the fog alone' ('{0} [{1}]' -f $cards['fog'].On, (& $keyOf 'fog')) 'True []'
  foreach ($c in $list.Cards) { $c.Reset() }
  Check 'defaults once more' (Ticked) $defaults

  # the bar for a game that has the default set installed: "as installed", and when this installer carries a newer
  # build of an installed part, that Apply updates it (the same ticks would build it again)
  $s = & $selection
  $has = [Activator]::CreateInstance($asm.GetType('SnowRunnerNextGen.GameStatus'))
  $has.Shader = 'ours'; foreach ($m in @($s['shader'])) { $has.Modules.Add($m) }
  $has.Dll = 'ours'; $has.DllCurrent = $true; $has.Factor = '1'; $has.SlopeBias = '1'; $has.AoHalf = '1'
  $has.Fill = 'ours'; $has.FillFactor = '0.7'; $has.Grade = 'ours'; $has.GradeStrength = '1'; $has.Particles = 'ours'
  $has.Stars = 'ours'; $has.StarsFactor = '3'; $has.Sky = 'ours'; $has.Logos = 'ours'
  $has.Weather = 'ours'; $has.WeatherParts = 'shadows,showers,evening,horizon,far,fireflies,pollen'
  $viewType.GetField('installed', $flags).SetValue($view, $has)
  $viewType.GetMethod('ShowCount', $flags).Invoke($view, @())
  Check 'bar: the default set as installed' (Note) "24 of 29 selected  $([char]0xB7)  as installed"
  $has.Outdated.Add('shader')
  $viewType.GetMethod('ShowCount', $flags).Invoke($view, @())
  Check 'bar: a newer build of an installed part' (Note) "24 of 29 selected  $([char]0xB7)  Apply to update the game to this version"
  $said = $viewType.GetMethod('Describe', [Reflection.BindingFlags]'NonPublic,Static').Invoke($null, @($has))
  Check 'header: says that Apply updates the game' ($said -match 'Note: this installer has a newer build of what is installed: Apply updates the game$') 'True'
  $viewType.GetField('installed', $flags).SetValue($view, $null)
  $viewType.GetMethod('ShowCount', $flags).Invoke($view, @())

  # the header for a game whose paks hold our changes while their kept originals are gone
  $status = [Activator]::CreateInstance($asm.GetType('SnowRunnerNextGen.GameStatus'))
  foreach ($f in 'initial.pak', 'boot.pak') { $status.Orphaned.Add($f) }
  $said = $viewType.GetMethod('Describe', [Reflection.BindingFlags]'NonPublic,Static').Invoke($null, @($status))
  Check 'header: paks without their kept originals' ($said -match '^initial\.pak and boot\.pak still hold SnowRunner Next Gen''s changes, but the kept originals are gone\. Have the store check the game''s files') 'True'

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
