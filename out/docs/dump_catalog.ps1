# The window's cards, their rows and their help texts, read from the built program itself, as JSON for the guide
# (make_guide.js); the exe field holds the program's file name only, so the tracked catalog carries no local path. usage: powershell -File dump_catalog.ps1 [-Exe <SnowRunnerNextGen.exe>] [-Out <catalog.json>]
param([string]$Exe = (Join-Path $PSScriptRoot '..\package\SnowRunnerNextGen\SnowRunnerNextGen.exe'), [string]$Out = (Join-Path $PSScriptRoot 'catalog.json'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$asm = [Reflection.Assembly]::LoadFrom((Resolve-Path $Exe).Path)
$flags = [Reflection.BindingFlags]'Static,Public,NonPublic'
$catalog = $asm.GetType('SnowRunnerNextGen.Catalog'); $help = $asm.GetType('SnowRunnerNextGen.Help')
$sections = { param($entry) @($entry.Sections | ForEach-Object { [ordered]@{ heading = $_.Heading; text = $_.Text } }) }
$mods = foreach ($m in $catalog.GetMethod('All', $flags).Invoke($null, $null))
{
    $t = $help.GetMethod('TopicFor', $flags).Invoke($null, @($m))
    [ordered]@{ id = $m.Id; title = $m.Title; category = $m.Category; group = $m.Group; description = $m.Description; on = $m.DefaultOn; requires = @($m.Requires)
        options = @($m.Options | ForEach-Object { $row = [ordered]@{ name = $_.Name; labels = @($_.Labels); keys = @($_.Keys); default = $_.Default }; if ($_.Stepper) { $row['stepper'] = $true }; $row }); help = (& $sections $t.Entry) }
}
$inst = $help.GetMethod('InstallerTopic', $flags).Invoke($null, $null)
$doc = [ordered]@{ exe = Split-Path -Leaf $Exe; built = (Get-Item $Exe).LastWriteTime.ToString('yyyy-MM-dd HH:mm'); modules = @($mods); installer = [ordered]@{ title = $inst.Title; summary = $inst.Summary; sections = (& $sections $inst.Entry) } }
[IO.File]::WriteAllText($Out, ($doc | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))
"cards: " + @($mods).Count + ", rows: " + (@($mods | ForEach-Object { $_.options.Count }) | Measure-Object -Sum).Sum + ", help sections: " + (@($mods | ForEach-Object { $_.help.Count }) | Measure-Object -Sum).Sum + " -> " + $Out
