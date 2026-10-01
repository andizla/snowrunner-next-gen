# Builds out\SnowRunnerNextGen.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
# usage: powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
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

# the engine: ngen.js, the pinned SnowRunner Shadows build (assets\engine\hid.dll, the one the modules were judged
# with), and where its tools are. This dev build runs the project's tools in place (SnowRunner-shaders\tools) and, for
# the clean install their menu works on, shares their backups (pak_backup), so the menu and the window agree.
$engine = Join-Path $out 'engine'
New-Item -ItemType Directory -Force -Path $engine | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'engine\ngen.js') -Destination $engine -Force
if (-not (Test-Path -LiteralPath (Join-Path $root 'assets\engine\hid.dll'))) { throw 'assets\engine\hid.dll is missing: put the SnowRunner Shadows build named in assets\engine\hid.dll.sha256 there' }
Copy-Item -LiteralPath (Join-Path $root 'assets\engine\hid.dll') -Destination $engine -Force
$config = [ordered]@{
  tools = 'C:\Games\SnowRunner-shaders\tools'
  dll = (Join-Path $engine 'hid.dll')
  devGame = 'C:\Program Files (x86)\Steam\steamapps\common\Snowrunner'
  devState = 'C:\Games\SnowRunner-shaders\pak_backup'
}
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $engine 'config.json') -Encoding ASCII
'{0}  ngen.js, hid.dll {1}, tools in {2}' -f $engine, (Get-FileHash (Join-Path $engine 'hid.dll') -Algorithm SHA256).Hash.Substring(0, 8).ToLower(), $config.tools
