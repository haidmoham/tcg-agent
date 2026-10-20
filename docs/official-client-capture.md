# Capture the official client privately

`scripts/official-client-capture.mjs` runs a read-only PowerShell capture worker with a 15-second timeout. A stalled `PrintWindow` call stops only this owned worker process. `scripts/capture-official-client.ps1` captures the client area of one already running Pokémon TCG Live window. It accepts the process ID and window handle from current local process discovery and verifies both before capture. It checks visibility, minimized state, client bounds, and ownership. It rechecks ownership and dimensions after capture. It never activates a window, sends keys, clicks, joins a match, or inspects process memory. Its output path must be inside this checkout's ignored `.cache` directory and must be fresh. Use the Node entry point to retain the timeout.

The adapter calls the Windows [PrintWindow API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow). `PW_CLIENTONLY` is 1 and `PW_RENDERFULLCONTENT` is 2 in the installed Windows SDK 10.0.26100.0 `WinUser.h`. Microsoft's [Windows bindings](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/UI/WindowsAndMessaging/constant.PW_RENDERFULLCONTENT.html) also identify the latter constant. Both flags are required here. Client-only without full-content rendering returned a white image; that result was rejected during visual inspection. The final adapter also rejects near-uniform frames and never equates API success with verified game content.

The existing PowerShell runtime already includes `System.Drawing.Common`. No package, driver, service, account, privacy, or security setting was installed or changed. The bundled computer-use config contains display strings and an accent color; it exposes no documented capture-enable setting. The disabled automation tool was not modified. The user's explicit local-capture request authorized this independent Windows implementation.

Discover a unique current client process, then pass its returned identity. Do not reuse the example's old IDs after a restart.

```powershell
$clientProcesses = @(Get-Process | Where-Object { $_.ProcessName -ceq 'Pokemon TCG Live' -and $_.MainWindowHandle -ne 0 })
if ($clientProcesses.Count -ne 1) { throw 'expected-one-official-client-window' }
$clientProcess = $clientProcesses[0]
$capturePowerShell = (Get-Process -Id $PID).Path
node scripts/official-client-capture.mjs $capturePowerShell $clientProcess.Id $clientProcess.MainWindowHandle.ToInt64() .cache/capture-new
```

The restricted shell could not see this desktop process; the approved desktop-context execution could. That was a capability boundary, not an action denial. Use the supported execution approval path when required. The script does not request or change Windows security permissions.

Output consists of private `client.png` and `receipt.json`. The receipt records the pixel hash, dimensions, capture times, method, window identity, and observed focus. `pixelsVerified` remains false until a reviewer actually inspects the pixels. Do not upload, commit, or distribute these files. A fresh capture is required after a state change. A meaningful screenshot does not certify accessibility, control reliability, game legality, or candidate mappings.

Two captures with full-content rendering were inspected directly at 1366 by 768. They show the Home lobby, Ranked selected, AgentPult as the selected deck, and the Play button. No match is running. The target was not foreground. No login, deck selection, deck contents, or client controls were changed. Account and currency details are omitted from the authored verification summary.

The safe policy projection remains incomplete.

| Field | Current observation |
|---|---|
| Source | Supported Windows client pixels, manually inspected |
| Deck display name | AgentPult |
| Screen | Lobby |
| Foreground | False in the tested captures |
| Exact loaded card printings | Unknown |
| Current game, turn, hand, board | No current game; no playing PolicyView |
| Legal gameplay candidates | None mapped |
| Action targets | None authorized |

The bridge stays disarmed and rejects this state. Reading the Play button does not authorize pressing it.
