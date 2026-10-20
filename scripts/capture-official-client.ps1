param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][long]$WindowId,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing.Common
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OfficialClientCapture {
    public const uint ClientOnly = 0x00000001;
    public const uint RenderFullContent = 0x00000002;
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$process = Get-Process -Id $ProcessId
if ($process.ProcessName -cne 'Pokemon TCG Live' -or $process.MainWindowHandle.ToInt64() -ne $WindowId) { throw 'official-window-identity-mismatch' }
$window = [IntPtr]$WindowId
[uint32]$owner = 0
[OfficialClientCapture]::GetWindowThreadProcessId($window, [ref]$owner) | Out-Null
if ($owner -ne $ProcessId -or -not [OfficialClientCapture]::IsWindow($window) -or -not [OfficialClientCapture]::IsWindowVisible($window) -or [OfficialClientCapture]::IsIconic($window)) { throw 'official-window-unavailable' }
$rect = New-Object OfficialClientCapture+Rect
if (-not [OfficialClientCapture]::GetClientRect($window, [ref]$rect)) { throw 'client-bounds-unavailable' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 100 -or $height -lt 100 -or $width -gt 7680 -or $height -gt 4320) { throw 'client-bounds-invalid' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache')) + [IO.Path]::DirectorySeparatorChar
if (-not ($destination + [IO.Path]::DirectorySeparatorChar).StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'private-cache-output-required' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$path = Join-Path $destination 'client.png'
if (Test-Path -LiteralPath $path) { throw 'fresh-output-directory-required' }
$bitmap = [Drawing.Bitmap]::new($width, $height)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$targetDc = $graphics.GetHdc()
$focused = [OfficialClientCapture]::GetForegroundWindow() -eq $window
$captureStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    $captured = [OfficialClientCapture]::PrintWindow($window, $targetDc, [OfficialClientCapture]::ClientOnly -bor [OfficialClientCapture]::RenderFullContent)
    if (-not $captured) { throw 'capture-api-failed' }
} finally {
    $graphics.ReleaseHdc($targetDc)
    $graphics.Dispose()
}
try {
    [uint32]$currentOwner = 0
    [OfficialClientCapture]::GetWindowThreadProcessId($window, [ref]$currentOwner) | Out-Null
    if ($currentOwner -ne $ProcessId -or -not [OfficialClientCapture]::IsWindow($window) -or -not [OfficialClientCapture]::IsWindowVisible($window) -or [OfficialClientCapture]::IsIconic($window)) { throw 'capture-window-changed' }
    $currentRect = New-Object OfficialClientCapture+Rect
    if (-not [OfficialClientCapture]::GetClientRect($window, [ref]$currentRect) -or $currentRect.Right -ne $rect.Right -or $currentRect.Bottom -ne $rect.Bottom) { throw 'capture-bounds-changed' }
    $colors = [Collections.Generic.HashSet[int]]::new()
    for ($y = 0; $y -lt $height; $y += [Math]::Max(1, [int]($height / 24))) {
        for ($x = 0; $x -lt $width; $x += [Math]::Max(1, [int]($width / 32))) { $colors.Add($bitmap.GetPixel($x, $y).ToArgb()) | Out-Null }
    }
    if ($colors.Count -lt 8) { throw 'capture-blank-or-unusable' }
    $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }
$receipt = [ordered]@{
    schema = 'official-client-capture/1'
    capturedAt = $captureStartedAt
    completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    window = @{ id = $WindowId; processId = $ProcessId; app = 'Pokemon TCG Live'; visible = $true; focused = $focused }
    method = 'PrintWindow-client-only-render-full-content'
    width = $width
    height = $height
    image = 'client.png'
    imageSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    pixelsVerified = $false
    unknowns = @('screen-classification', 'deck-printings', 'policy-view', 'legal-candidates', 'action-targets')
    clientInputsSent = 0
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $destination 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 5 -Compress
