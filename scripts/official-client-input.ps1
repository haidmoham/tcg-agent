param(
    [Parameter(Mandatory = $true)][string]$ProposalPath,
    [Parameter(Mandatory = $true)][string]$StepId
)
$ErrorActionPreference = 'Stop'
$stateStream = $null
try {
    $cache = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.cache')) + [IO.Path]::DirectorySeparatorChar
    function PrivatePath([string]$value) {
        $full = [IO.Path]::GetFullPath($value)
        if (-not $full.StartsWith($cache, [StringComparison]::OrdinalIgnoreCase)) { throw 'private-cache-path-required' }
        return $full
    }
    function CheckKill {
        if ((Test-Path -LiteralPath (Join-Path $cache 'official-client.kill')) -or (Test-Path -LiteralPath (Join-Path $cache 'official-client-input.kill'))) { throw 'input-killed' }
    }
    function CheckFresh($proposal) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        foreach ($time in @($proposal.createdAt, $proposal.evidence.capturedAt)) {
            if ($null -eq $time -or $time -lt 1 -or $time -gt $now -or $now - $time -gt 5000) { throw 'input-stale-evidence' }
        }
        return $now
    }
    function PersistState($value) {
        $encoded = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 5 -Compress))
        $stateStream.SetLength(0); $stateStream.Position = 0; $stateStream.Write($encoded); $stateStream.Flush($true)
    }
    $proposalFile = PrivatePath $ProposalPath
    $proposal = Get-Content -LiteralPath $proposalFile -Raw | ConvertFrom-Json
    if ($proposal.schema -cne 'official-client-input/1' -or $proposal.id -cne $StepId -or $StepId -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw 'input-proposal-mismatch' }
    if ($proposal.armed -ne $true -or $proposal.disarmed -ne $false -or $proposal.humanReviewed -ne $true) { throw 'input-not-armed-and-reviewed' }
    if ($proposal.action -cne 'click' -or $proposal.targetLabel -cne 'Decks') { throw 'input-target-not-allowed' }
    $transport = $proposal.transport
    if ($transport -cne 'window-message') { throw 'input-transport-not-allowed' }
    $screens = @{ 'Decks' = @('home', 'ranked-ladder') }
    if ($proposal.expectedScreen -cnotin $screens[$proposal.targetLabel]) { throw 'input-screen-not-allowed' }
    CheckKill
    $now = CheckFresh $proposal
    $evidenceDirectory = PrivatePath $proposal.evidence.captureDirectory
    $receipt = Get-Content -LiteralPath (Join-Path $evidenceDirectory 'receipt.json') -Raw | ConvertFrom-Json
    $image = Join-Path $evidenceDirectory 'client.png'
    $sameCapture = $receipt.schema -ceq 'official-client-capture/1' -and $receipt.window.app -ceq 'Pokemon TCG Live'
    $sameCapture = $sameCapture -and $receipt.window.processId -eq $proposal.processId -and $receipt.window.id -eq $proposal.windowId
    $sameCapture = $sameCapture -and $receipt.capturedAt -eq $proposal.evidence.capturedAt -and $receipt.width -eq $proposal.evidence.width -and $receipt.height -eq $proposal.evidence.height
    $sameCapture = $sameCapture -and $receipt.imageSha256 -ceq $proposal.evidence.imageSha256 -and (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.imageSha256
    if (-not $sameCapture) { throw 'input-capture-binding-mismatch' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OfficialClientInput {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref Point p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessageW(IntPtr h, uint message, UIntPtr parameter, IntPtr coordinates);
    public static int PostClientClick(IntPtr window, int x, int y) {
        if (window == IntPtr.Zero || window.ToInt64() == 0xffff || x < 0 || y < 0 || x > 32767 || y > 32767) throw new InvalidOperationException("input-message-target-invalid");
        var coordinates = new IntPtr((y << 16) | x);
        int queued = 0;
        if (PostMessageW(window, 0x0200, UIntPtr.Zero, coordinates)) queued++; else return queued;
        if (PostMessageW(window, 0x0201, new UIntPtr(1), coordinates)) queued++; else return queued;
        if (PostMessageW(window, 0x0202, UIntPtr.Zero, coordinates)) queued++;
        return queued;
    }
}
'@
    $process = Get-Process -Id $proposal.processId
    $window = [IntPtr][long]$proposal.windowId
    [uint32]$owner = 0
    [OfficialClientInput]::GetWindowThreadProcessId($window, [ref]$owner) | Out-Null
    if ($process.ProcessName -cne 'Pokemon TCG Live' -or $process.MainWindowHandle -ne $window -or $owner -ne $proposal.processId -or -not [OfficialClientInput]::IsWindowVisible($window) -or [OfficialClientInput]::IsIconic($window)) { throw 'input-window-mismatch' }
    if ([OfficialClientInput]::GetForegroundWindow() -eq $window) { throw 'input-background-required' }
    $rect = New-Object OfficialClientInput+Rect
    if (-not [OfficialClientInput]::GetClientRect($window, [ref]$rect) -or $rect.Right -ne $receipt.width -or $rect.Bottom -ne $receipt.height) { throw 'input-client-bounds-changed' }
    $point = New-Object OfficialClientInput+Point
    if ($proposal.action -ceq 'click') {
        if ($proposal.x -isnot [long] -and $proposal.x -isnot [int] -or $proposal.y -isnot [long] -and $proposal.y -isnot [int]) { throw 'input-coordinate-invalid' }
        if ($proposal.x -lt 0 -or $proposal.y -lt 0 -or $proposal.x -ge $rect.Right -or $proposal.y -ge $rect.Bottom) { throw 'input-coordinate-invalid' }
        $box = $proposal.evidence.targetBox
        if ($null -eq $box -or $box.x -lt 0 -or $box.y -lt 0 -or $box.width -lt 1 -or $box.height -lt 1 -or $box.x + $box.width -gt $rect.Right -or $box.y + $box.height -gt $rect.Bottom -or $proposal.x -lt $box.x -or $proposal.y -lt $box.y -or $proposal.x -ge $box.x + $box.width -or $proposal.y -ge $box.y + $box.height) { throw 'input-target-box-invalid' }
        if ($proposal.targetLabel -ceq 'Decks' -and ($proposal.y -gt $rect.Bottom * 0.08 -or $proposal.x -lt $rect.Right * 0.06 -or $proposal.x -gt $rect.Right * 0.16)) { throw 'input-decks-anchor-mismatch' }
        $point.X = $proposal.x; $point.Y = $proposal.y
        if (-not [OfficialClientInput]::ClientToScreen($window, [ref]$point) -or [OfficialClientInput]::GetAncestor([OfficialClientInput]::WindowFromPoint($point), 2) -ne $window) { throw 'input-point-not-target-window' }
    }
    $statePath = Join-Path $cache 'official-client-input-state.json'
    $stateStream = [IO.File]::Open($statePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    if ($stateStream.Length -gt 262144) { throw 'input-state-budget-exceeded' }
    $state = @{ schema = 'official-client-input-state/1'; lastActionAt = 0; consumedIds = @() }
    if ($stateStream.Length -gt 0) {
        $bytes = [byte[]]::new($stateStream.Length)
        $stateStream.ReadExactly($bytes, 0, $bytes.Length)
        $state = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable
        if ($state.schema -cne 'official-client-input-state/1' -or $null -eq $state.consumedIds) { throw 'input-state-invalid' }
    }
    $now = CheckFresh $proposal
    if ($state.lastOutcome -ceq 'uncertain-until-transition-verified') { throw 'input-previous-transition-unverified' }
    if ($state.consumedIds -ccontains $StepId) { throw 'input-proposal-already-consumed' }
    if ($state.consumedIds.Count -ge 512) { throw 'input-session-budget-exceeded' }
    if ($now - $state.lastActionAt -lt 1000) { throw 'input-rate-limited' }
    CheckKill
    $state.lastActionAt = $now
    $state.consumedIds = @($state.consumedIds) + $StepId
    $state.lastId = $StepId
    $state.lastOutcome = 'uncertain-until-transition-verified'
    PersistState $state
    CheckKill
    $null = CheckFresh $proposal
    $point.X = $proposal.x; $point.Y = $proposal.y
    if (-not [OfficialClientInput]::ClientToScreen($window, [ref]$point) -or [OfficialClientInput]::GetAncestor([OfficialClientInput]::WindowFromPoint($point), 2) -ne $window) { throw 'input-point-not-target-window' }
    $priorForeground = [OfficialClientInput]::GetForegroundWindow()
    if ($priorForeground -eq $window) { throw 'input-background-required' }
    $priorCursor = New-Object OfficialClientInput+Point
    $afterCursor = New-Object OfficialClientInput+Point
    if (-not [OfficialClientInput]::GetCursorPos([ref]$priorCursor)) { throw 'input-cursor-proof-unavailable' }
    $queued = [OfficialClientInput]::PostClientClick($window, $proposal.x, $proposal.y)
    if ($queued -ne 3) { throw 'input-message-outcome-uncertain-no-retry' }
    if (-not [OfficialClientInput]::GetCursorPos([ref]$afterCursor) -or $priorCursor.X -ne $afterCursor.X -or $priorCursor.Y -ne $afterCursor.Y -or [OfficialClientInput]::GetForegroundWindow() -ne $priorForeground) { throw 'input-desktop-changed-stop' }
    $status = 'executed-unverified'; $sent = 1
    @{ schema = 'official-client-input-receipt/1'; id = $StepId; status = $status; targetLabel = $proposal.targetLabel; transport = $transport; clientInputsSent = $sent; verifyTransitionRequired = $true } | ConvertTo-Json -Compress
} catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^(input-|private-cache-path-required$)') { $code = 'input-adapter-failed' }
    @{ schema = 'official-client-input-receipt/1'; id = $StepId; status = 'blocked'; error = $code; verifyTransitionRequired = $true } | ConvertTo-Json -Compress
    exit 1
} finally { if ($null -ne $stateStream) { $stateStream.Dispose() } }
