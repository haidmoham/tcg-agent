param(
    [Parameter(Mandatory=$true)][string]$Latest,
    [string]$Python = 'pythonw.exe',
    [switch]$Capture,
    [switch]$CapturePages,
    [switch]$Close
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runtimeDir = Join-Path $repoRoot '.cache\diagnostic-overlay'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$closeFile = Join-Path $runtimeDir 'close.request'
if ($Close) {
    Set-Content -LiteralPath $closeFile -Value 'Close this overlay only' -Encoding ascii
    return
}
$receiptFile = Join-Path $runtimeDir 'launch-receipt.json'
if (Test-Path -LiteralPath $receiptFile) {
    $receipt = Get-Content -LiteralPath $receiptFile -Raw | ConvertFrom-Json
    $running = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
    if ($running -and $running.ProcessName -like 'python*') {
        throw 'An overlay receipt points to a running Python process. Close the existing overlay before launching another.'
    }
}
if (Test-Path -LiteralPath $closeFile) { Remove-Item -LiteralPath $closeFile }
if (-not (Test-Path -LiteralPath $Latest)) { throw 'The latest log pointer does not exist.' }
$overlaySource = Join-Path $repoRoot 'integrations\diagnostic-overlay\overlay.py'
if ($Latest.Contains('"') -or $overlaySource.Contains('"')) { throw 'Paths containing quotes are not supported.' }
$overlayArgs = @('"' + $overlaySource + '"', '--latest', '"' + $Latest + '"')
if ($Capture) { $overlayArgs += '--capture' }
if ($CapturePages) { $overlayArgs += '--capture-pages' }
$process = Start-Process -FilePath $Python -ArgumentList $overlayArgs -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $runtimeDir 'stderr.txt')
Write-Output "Overlay launched with PID $($process.Id). Close × or use this script with -Close."
