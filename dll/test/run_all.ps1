# Runs out\shadow_test.exe in every configuration (each with its SnowRunnerShadows.ini next to the DLL), the stock twins
# ones with the test's own table (shadow_test maketable, maketable1, maketable62 or maketable63: the table's version and
# modules), and removes the ini, the table and the dump files afterwards.
# Results: out\run_all.txt; exit code 0 = every configuration passed.
$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'out'
$ini = Join-Path $out 'SnowRunnerShadows.ini'
$table = Join-Path $out 'SnowRunnerShadows.stock'
$report = Join-Path $out 'run_all.txt'
$configs = @(
    @{ name = 'default';        ini = @();                          args = @() },
    @{ name = 'double';         ini = @();                          args = @('double') },
    @{ name = 'off';            ini = @('Factor=1');                args = @('off') },
    @{ name = 'off nofeed';     ini = @('Factor=1', 'Feed=0');      args = @('off', 'nofeed') },
    # the texture base rule is checked in every run (this program is a build without known addresses); off here, and
    # in 'off nofeed' above the device hook is there for the rule alone
    @{ name = 'texture rule off'; ini = @('TextureBaseRule=0');     args = @('texoff') },
    @{ name = 'nogi';           ini = @('GI=0');                    args = @('nogi') },
    @{ name = 'nomips';         ini = @('FeedMips=0');              args = @('nomips') },
    @{ name = 'runtime mips';   ini = @('FeedMips=2');              args = @() },
    @{ name = 'hw';             ini = @();                          args = @('hw') },
    @{ name = 'puddles off';    ini = @('PuddlesOn=0');             args = @('puddlesoff') },
    @{ name = 'bounce off';     ini = @('BounceOn=0');              args = @('bounceoff') },
    # the stock twins with a version-2 table (four modules): all on, the AO switch off at start, F8's state at start
    @{ name = 'twins';          ini = @();                          args = @('twins'); table = 'maketable' },
    @{ name = 'twins stock AO'; ini = @('StockAO=1');               args = @('twins', 'stockao'); table = 'maketable' },
    @{ name = 'twins stock all'; ini = @('StockAll=1');             args = @('twins', 'stockall'); table = 'maketable' },
    # a module switched off in the Graphics tab: its shaders draw as the game's own, a shader it shares with another
    # module too (Tonemap and Water reflections change one shader together), the AO pass's module through the AO switch,
    # the vertex shader's module; and F8 twice leaves the module off
    @{ name = 'twins module off'; ini = @();                        args = @('twins', 'moduleoff', 'Tonemap'); table = 'maketable' },
    @{ name = 'twins shared off'; ini = @();                        args = @('twins', 'moduleoff', 'Water reflections'); table = 'maketable' },
    @{ name = 'twins AO module off'; ini = @();                     args = @('twins', 'moduleoff', 'GTAO'); table = 'maketable' },
    @{ name = 'twins VS module off'; ini = @();                     args = @('twins', 'moduleoff', 'Smoke glow'); table = 'maketable' },
    # the table of installs up to 1.1.2 (version 1): F8 and the AO switch as before
    @{ name = 'twins v1';       ini = @();                          args = @('twins'); table = 'maketable1' },
    @{ name = 'twins v1 stock AO'; ini = @('StockAO=1');            args = @('twins', 'stockao'); table = 'maketable1' },
    @{ name = 'twins v1 stock all'; ini = @('StockAll=1');          args = @('twins', 'stockall'); table = 'maketable1' },
    @{ name = 'dump deferred';  ini = @('DumpAfter=1');             args = @('dump') },
    @{ name = 'dump immediate'; ini = @('DumpAfter=1');             args = @('dump', 'immediate') },
    @{ name = 'ssr mirror';     ini = @('SSRHalf=0', 'SSRMotion=1');               args = @('ssr') },
    @{ name = 'ssr mirror half'; ini = @('SSRMotion=1');                         args = @('ssr') },
    @{ name = 'ssr rough';      ini = @('SSRHalf=0', 'SSRCone=0', 'SSRLobe=1', 'SSRMotion=1'); args = @('ssr', 'rough') },
    @{ name = 'ssr rough half'; ini = @('SSRCone=0', 'SSRLobe=1', 'SSRMotion=1');  args = @('ssr', 'rough') },
    # the reflections' under-an-object rule is on by default in the four above; SSRUnder=0 = the pass without it
    @{ name = 'ssr under off';  ini = @('SSRHalf=0', 'SSRUnder=0', 'SSRMotion=1'); args = @('ssr') },
    @{ name = 'ssr rough under off'; ini = @('SSRHalf=0', 'SSRCone=0', 'SSRLobe=1', 'SSRUnder=0', 'SSRMotion=1'); args = @('ssr', 'rough') },
    # SSRMotion=0 (the default): t124 stays empty, the reflections reproject by the camera alone
    @{ name = 'ssr motion off'; ini = @();                         args = @('ssr', 'nomotion') },
    @{ name = 'frames';         ini = @('FrameLog=1');              args = @('frames') },
    @{ name = 'no frames';      ini = @();                          args = @('noframes') },
    @{ name = 'gpu timers';     ini = @('GpuTimers=1');             args = @('gputimers') },
    # Factor=1 with the timers: the shadow texture tagged x1 only for its timing, nothing scaled
    @{ name = 'gpu timers x1';  ini = @('GpuTimers=1', 'Factor=1'); args = @('gputimers') },
    @{ name = 'off timers';     ini = @('Factor=1', 'GpuTimers=1'); args = @('off') },
    # the pass profile: its lists; the GPU timers beside it; every check of the default run with it on
    @{ name = 'pass profile';   ini = @('GpuProfile=1');            args = @('gpuprofile') },
    @{ name = 'profile shaders'; ini = @('GpuProfile=1', 'GpuProfileShaders=1'); args = @('gpuprofile') },
    @{ name = 'timers profile'; ini = @('GpuTimers=1', 'GpuProfile=1'); args = @('gputimers') },
    @{ name = 'cpu profile';    ini = @('GpuTimers=1', 'CpuProfile=1'); args = @('gputimers') },
    @{ name = 'thread load';    ini = @('GpuTimers=1', 'CpuThreads=1'); args = @('gputimers') },
    @{ name = 'cpu profile default'; ini = @('CpuProfile=1');         args = @() },
    @{ name = 'profile default'; ini = @('GpuProfile=1');           args = @() },
    @{ name = 'profile ssr';    ini = @('GpuProfile=1', 'SSRMotion=1');            args = @('ssr') },
    @{ name = 'profile dump';   ini = @('GpuProfile=1', 'DumpAfter=1'); args = @('dump') },
    # the AO pass at half size: every check of the default run with it on, and its own
    @{ name = 'ao half';        ini = @('AOHalf=1');                args = @('aohalf') },
    @{ name = 'ao half nogi';   ini = @('AOHalf=1', 'GI=0');        args = @('nogi') },
    # half size is the default: without an ini it is on; AOHalf=0 keeps the game's own target
    @{ name = 'ao half default'; ini = @();                         args = @('aohalf') },
    @{ name = 'ao full';        ini = @('AOHalf=0');                args = @('aofull') },
    # an odd render size (a DLSS scale gives one): the half-size pass fills its last column and row too
    @{ name = 'ao half odd';    ini = @();                          args = @('aohalfodd') },
    # another program gives the device and its context tables of their own, copied from the hooked ones
    @{ name = 'private tables'; ini = @();                          args = @('retable') },
    # the AO pass's depth mips at t126: on by default; ZMips=0 leaves t126 empty; the default run with them off
    @{ name = 'zmips';          ini = @();                          args = @('zmips') },
    @{ name = 'zmips off';      ini = @('ZMips=0');                 args = @('zmipsoff') },
    @{ name = 'zmips off default'; ini = @('ZMips=0');              args = @() },
    # contact shadows: the lab with render targets 6 and 7 together, 6 alone (no reflections), the pass's switch off at start (ini ContactOn=0),
    # on the GPU; and every check of the default run with a ContactDebug view set (nothing writes output 6 there)
    @{ name = 'contact';        ini = @();                          args = @('contact') },
    @{ name = 'contact no ssr'; ini = @('SSR=0');                   args = @('contact') },
    # contact shadows without the bounce light and the reflections: they alone need the blend state hook then
    @{ name = 'contact alone';  ini = @('GI=0', 'SSR=0');           args = @('contact') },
    @{ name = 'contact off';    ini = @('ContactOn=0');             args = @('contact', 'off') },
    @{ name = 'contact hw';     ini = @();                          args = @('contact', 'hw') },
    @{ name = 'contact default'; ini = @('ContactDebug=1');         args = @() },
    # the NEXT GEN overlay's Graphics tab: without a table the passes' switches the ini turned on; with a version-2 table
    # Next Gen shaders, AO at half size and one switch per module (GTAO through the AO bit); with a version-1 table the
    # switches of 1.1.2 (GTAO from its AO pass's stock shaders), no module rows; 62 modules (the most a table may name)
    # fill the 64 switches the overlays take; 63 modules: the table is refused and the tab is as without one. And the
    # shared import slot lock with a second mod's hook in front of the DLL's; F8 stays live beside a stand-in menu
    @{ name = 'graphics';       ini = @();                          args = @('graphics', '6') },
    @{ name = 'graphics twins'; ini = @();                          args = @('graphics', '6'); table = 'maketable' },
    @{ name = 'graphics twins v1'; ini = @();                       args = @('graphics', '7'); table = 'maketable1' },
    @{ name = 'graphics 62 modules'; ini = @();                     args = @('graphics', '64'); table = 'maketable62' },
    @{ name = 'graphics 63 modules'; ini = @();                     args = @('graphics', '6', 'refused'); table = 'maketable63' },
    @{ name = 'graphics no gi ssr'; ini = @('GI=0', 'SSR=0');       args = @('graphics', '3') },
    @{ name = 'graphics none';  ini = @('Factor=1', 'Feed=0');      args = @('graphics', '0') }
)
$dumps = Join-Path $out 'SnowRunnerShadows_dump_*'
Set-Content -Path $report -Value '' -Encoding UTF8
$failed = 0
Push-Location $out
try
{
    foreach ($c in $configs)
    {
        Remove-Item $ini, $table, $dumps -ErrorAction SilentlyContinue
        if ($c.table) { & .\shadow_test.exe $c.table | Out-Null; if (-not (Test-Path $table)) { throw 'the stock twins table was not written' } }
        if ($c.ini.Count) { Set-Content -Path $ini -Value (@('[Shadows]') + $c.ini) -Encoding ASCII }
        $text = & .\shadow_test.exe @($c.args) 2>&1 | Out-String
        $code = $LASTEXITCODE
        $checks = ([regex]::Matches($text, '(?m)^(ok|FAIL) ')).Count
        $fails = ([regex]::Matches($text, '(?m)^FAIL ')).Count
        $line = '{0,-16} exit {1}, {2} checks, {3} failed' -f $c.name, $code, $checks, $fails
        Add-Content -Path $report -Value $line -Encoding UTF8
        if ($code -ne 0) { $failed++; Add-Content -Path $report -Value (($text -split "`n") | Where-Object { $_ -match '^FAIL' }) -Encoding UTF8 }
        $line
    }
}
finally
{
    Remove-Item $ini, $table, $dumps -ErrorAction SilentlyContinue
    Pop-Location
}
'configurations failed: ' + $failed
exit $(if ($failed) { 1 } else { 0 })
