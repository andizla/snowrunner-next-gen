# Builds out\SnowRunnerNextGen.exe with the C# compiler that ships with Windows (.NET Framework 4.x), compiles the
# project's shaders (engine\tools\build_shaders.js: fxc from the Windows SDK) and sets up out\engine, which runs the
# tools and the texture sets in place from this repository's engine folder.
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 [-Node <node.exe>]
param([string]$Node = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root 'out'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw 'csc.exe not found. It ships with the .NET Framework 4.x of Windows 10 and 11.' }

$exe = Join-Path $out 'SnowRunnerNextGen.exe'
$sources = Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter *.cs -Recurse | Sort-Object FullName | ForEach-Object { $_.FullName }
& $csc /nologo /target:winexe /optimize+ /platform:anycpu /warn:4 /codepage:65001 "/out:$exe" "/win32manifest:$(Join-Path $root 'src\app.manifest')" /reference:System.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $sources
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
'{0}  {1:N0} bytes' -f $exe, (Get-Item -LiteralPath $exe).Length

# the (?) pop-ups' before/after pictures go next to the exe
$help = Join-Path $out 'help'
New-Item -ItemType Directory -Force -Path $help | Out-Null
$pictures = Get-ChildItem -LiteralPath (Join-Path $root 'assets\help') -Filter *.jpg
$pictures | Copy-Item -Destination $help -Force
'{0}  {1} pictures' -f $help, @($pictures).Count

# the shaders: every blob compiled from its source and checked against the list of tested builds
# (engine\replacements\shaders.sha256). A blob that differs stops the build.
if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node -or -not (Test-Path -LiteralPath $Node)) { throw 'node.exe not found: pass -Node <path> (Node.js 22.2 or newer)' }
$said = & $Node (Join-Path $root 'engine\tools\build_shaders.js')
if ($LASTEXITCODE -ne 0) { $said | Out-Host; throw 'the shader build differs from the tested blobs (engine\replacements\shaders.sha256)' }
$said | Select-Object -Last 1

# the engine: ngen.js and prepare.js, the pinned SnowRunner Shadows build (assets\engine\hid.dll, the one the modules
# were judged with), and a config that points at the tools in engine\tools. dev.json at the repository's root, when
# there is one, adds its keys to that config (see engine\ngen.js: devGame, devState, dump, sets).
$engine = Join-Path $out 'engine'
New-Item -ItemType Directory -Force -Path $engine | Out-Null
foreach ($f in 'ngen.js', 'prepare.js') { Copy-Item -LiteralPath (Join-Path $root "engine\$f") -Destination $engine -Force }
if (-not (Test-Path -LiteralPath (Join-Path $root 'assets\engine\hid.dll'))) { throw 'assets\engine\hid.dll is missing: build SnowRunner Shadows with dll\build.bat and copy dll\out\hid.dll there' }
Copy-Item -LiteralPath (Join-Path $root 'assets\engine\hid.dll') -Destination $engine -Force
$config = [ordered]@{
  tools = (Join-Path $root 'engine\tools')
  dll = (Join-Path $engine 'hid.dll')
}
$devFile = Join-Path $root 'dev.json'
if (Test-Path -LiteralPath $devFile) {
  $dev = Get-Content -LiteralPath $devFile -Raw | ConvertFrom-Json
  foreach ($p in $dev.PSObject.Properties) { $config[$p.Name] = $p.Value }
}
[IO.File]::WriteAllText((Join-Path $engine 'config.json'), ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
'{0}  ngen.js, hid.dll {1}, tools in {2}{3}' -f $engine, (Get-FileHash (Join-Path $engine 'hid.dll') -Algorithm SHA256).Hash.Substring(0, 8).ToLower(), $config.tools, $(if (Test-Path -LiteralPath $devFile) { ', with dev.json' } else { '' })
