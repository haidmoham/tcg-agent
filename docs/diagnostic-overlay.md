# Local read-only Live diagnostics

`integrations/diagnostic-overlay/overlay.py` runs a separate always-on-top Windows
window. It reads the private log pointer and JSONL journals; it never loads a
policy, attaches to the game, imports controller code, sends RPCs, or sends input.
It uses installed Python 3.12, Tk, and Win32 window styles. Pillow is only needed
for optional private screenshots. No installation or network listener is needed.

Launch from this worktree (set the pointer to the active viewing checkout):

```powershell
.\scripts\diagnostic-overlay.ps1 -Latest 'C:\path\to\viewing-worktree\.cache\model5-live-latest.json'
```

The launcher defaults to `pythonw.exe`, resolved from the local executable search
path. Use `-Python <absolute-pythonw-path>` for an installed Python with Tk that is
not on that path. For a foreground diagnostic
launch, invoke `python.exe integrations/diagnostic-overlay/overlay.py --latest <pointer>`.
The overlay follows pointer-folder changes and polls append-only files once per
second. It handles unfinished trailing lines and truncation. UI rendering stays
on its own thread; file reading happens on a worker. No tests or games are started.

The display starts at the right edge of the existing Pokemon client, using only
window-title/geometry enumeration. It never activates or moves the client.
Both overlay windows use `WS_EX_NOACTIVATE`, return `MA_NOACTIVATE`, and are topmost.
The body additionally uses layered `WS_EX_TRANSPARENT` for click-through display.
The control strip remains clickable. Drag its title to move; drag `resize` to
resize; use the six view buttons and ▲/▼ to read every line while passive.
`Inspect: ON` explicitly enables mouse scrolling within the body while retaining
non-activation. Switch it off to restore click-through. `Hide` collapses only the
body and leaves `Show` and `Close ×` visible. Closing does not stop the game.

Close with `Close ×`, or from this worktree:

```powershell
.\scripts\diagnostic-overlay.ps1 -Latest 'C:\path\to\viewing-worktree\.cache\model5-live-latest.json' -Close
```

This writes only this overlay's `.cache/diagnostic-overlay/close.request`; the
overlay notices it within 200 ms. No global shortcuts or keyboard hooks exist.
Keep the control strip reachable when moving/resizing. There is no game stop
button here, and existing game/controller stop controls are untouched.

## Data and interpretation

- Overview: actual actor-visible board, typed energy, known conditions, tools,
  counts, latest choice attribution, checkpoint and feature-contract identifiers.
  HP is shown as recorded HP minus recorded damage; neither field is silently
  treated as remaining HP. The adapter phase code is retained; its human-readable
  phase name remains unavailable pending an authoritative enum mapping.
- Offers: current observed legal actions/prompt candidates and a separately
  labeled historical offer snapshot for the last choice. Prize slots are opaque.
  The last policy input's effect origin and its evidence label remain historical.
- Driver: proposal, dispatch, returned result, execution verification, subsequent
  observation, processing/acknowledgement, and journal wall-time duration.
  Subsequent state observation does not establish semantic success.
- Masks: explicit runtime unknowns, named known/unknown features and their value
  counts from recorded encoded inputs, unknown vocabulary counts, public-context
  knowledge flags. These are the last choice's masks, not inferred current masks.
- History: last 60 decision/driver events, model/helper attribution, error/stop
  event types. Free-text runtime errors and arbitrary payloads are not displayed.
- Cards: own visible hand and both public discards. Opponent hand/deck/prize faces,
  account identifiers, paths, credentials, and arbitrary raw runtime objects are
  excluded from the UI. Labels join the local extracted catalog eagerly and use
  observed actor-visible names. No catalog/datamine payload is copied into Git.

An observation older than 10 seconds is marked `STALE / last observed`; this is
an age threshold, not proof that the game has stopped. The game may already show
a menu or have changed while logs are stale. The overlay cannot determine the
current screen from an old log. Terminal fields remain unknown until recorded.
Current actor state and historical policy input can differ; their timestamps and
turn numbers are displayed separately. Log timestamp age is not capture/frame age.

The inspected schema records choices and sometimes an ordered list of candidate
indices, but no neural logits/probabilities or inference duration. The overlay
labels those fields unavailable and labels rankings as candidate indices only.
It does not compute softmax, invent confidence, or explain a choice from scores.

## Minimal optional telemetry addition for the controller owner

Do not edit the live controller to install this overlay. In a later owner-approved
change, extend the proposal journal event with a versioned `policyTelemetry` field:

```text
candidateIds: ordered semantic candidate IDs matching policyInput/encodedInput
logits: exact raw neural output, or null when the worker does not expose it
probabilities: only actually recorded sampling probabilities, otherwise null
probabilitySemantics: explicit distribution/sampling description, otherwise null
inferenceMs: measured worker elapsed duration
observationCapturedAt: capture timestamp (separate from journal write timestamp)
```

Also record a structured current prompt origin bound to its observation ID, an
authoritative phase enum name, RPC start/end timestamps, and a structured
acknowledgement type/status. Preserve model/helper attribution and explicit
`executionVerified`. Do not infer semantic success from a transport return or
state change. Scores are diagnostics, not reasons or calibrated confidence.
The current renderer intentionally supports only the inspected journal schema;
new score telemetry needs an explicit typed projection before display.

## Native rendering verification and privacy

`-Capture -CapturePages` exercises the overlay's own six views and writes private
screen crops under ignored `.cache/diagnostic-overlay/`, returning to Overview.
It does not focus/click the game or move the mouse. `launch-receipt.json` records
only overlay process/window IDs, styles, geometry, client detection, reader time,
and foreground window ID before/after launch. Inspect the screenshot locally;
these files contain private game state and may include faint underlying pixels.
Never stage, upload, or publish runtime receipts, screenshots, journals, models,
datamine assets, or catalogs. Commit only overlay source and this documentation.
