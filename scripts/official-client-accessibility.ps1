param([Parameter(Mandatory=$true)][int]$ProcessId, [Parameter(Mandatory=$true)][long]$WindowId, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $ProcessId
if ($process.ProcessName -cne 'Pokemon TCG Live' -or $process.MainWindowHandle.ToInt64() -ne $WindowId) { throw 'accessibility-window-mismatch' }
$cache = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache')) + [IO.Path]::DirectorySeparatorChar
$output = [IO.Path]::GetFullPath($OutputPath)
if (-not $output.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase)) { throw 'private-output-required' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowId)
if ($null -eq $root -or $root.Current.ProcessId -ne $ProcessId) { throw 'accessibility-root-unavailable' }
$elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
if ($elements.Count -gt 512) { throw 'accessibility-tree-budget-exceeded' }
$nodes = @()
foreach ($element in $elements) {
    $value = $element.Current
    if ($value.ProcessId -ne $ProcessId -or $value.IsOffscreen) { continue }
    $rect = $value.BoundingRectangle
    $nodes += @{ name = $value.Name; type = $value.ControlType.ProgrammaticName; enabled = $value.IsEnabled;
        bounds = @{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height } }
}
@{ schema = 'official-client-accessibility/1'; capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); windowId = $WindowId; nodes = $nodes } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $output -Encoding utf8
@{ visibleElements = $nodes.Count; namedElements = @($nodes | Where-Object { $_.name }).Count; controlTypes = @($nodes.type | Sort-Object -Unique); inputSent = 0 } | ConvertTo-Json -Compress
