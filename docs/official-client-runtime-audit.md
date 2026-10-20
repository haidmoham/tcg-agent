# Official client runtime observation audit

This is the historical pre-adapter static audit. The later [pilot receipt](official-client-ai-pilot.json) establishes the scoped experimental runtime connection and user-stopped AI sample. Its shutdown and authorization limits supersede the readiness statements below.

The local reconstruction provides concrete internal interfaces and reusable actor projection code. The missing capability is a permitted connection from those interfaces in the running official process to this external bridge. A live structured match observation has not been obtained. The verified live feed currently consists of window pixels and conservative lobby recognition.

| Source interface | Established behavior | Reuse and limit |
| --- | --- | --- |
| `NetworkMatchController.ConfigureMatchScopedClientEventSystem` | Subscribes SDK selection, operation-result, catch-up and card-reload callbacks | Identifies the live event origin; payloads are not automatically actor-safe |
| `NetworkMatchController.BeginSendingClientEventsTo` | Prepares listeners and registers them with the match event system | In-process registration; no external attach endpoint established |
| `ClientMatchMainThreadEventSystem.SendEventsTo` | Routes match-scoped events through the Unity main-thread dispatcher | Useful synchronization contract; no socket, pipe or external subscription provided |
| `IBattleLogStateProvider` | Presentation models and added/changed/cleared events | Player presentation is a useful observation boundary; not a complete legal-action snapshot |
| `BattleLogExporter.ExportBattleLog` | Formats display text, writes the clipboard, raises `OnExport` | Normal export could supply a log after verified user export; no clipboard was read |
| Indigo `MatchWorker.Project` | Copies its own authority, applies `CreatePrivatizedMatchBoardForPlayer`, projects per-seat fields and offers | Reuse privacy and DTO rules; it observes a separately created offline match |
| Indigo `EngineWorkerTransport` | Spawns a private worker and exchanges JSONL over stdio | No attachment to the installed Live session |
| `UnityInputManagerAdapter.IsLeftClickBegin` | Reads Unity device button edges | Consistent with observed window messages having no UI effect; exact backend cause unproven |
| `HUBDeckSelectController.Settings_TestDeck` | Starts the normal UI coroutine with `deckPanel.GetCurrentSelection()` | Exact permitted launch path once selected AgentPult and live UI identity are verified |
| `OfflineMatchInitiator.SwitchOfflineAndPlay` | Validates the deck, sets `GameplayType.Offline`, switches offline and joins the offline match; subsequent callback starts `BattleBoardType.TestDeck` | Confirms provided AI scope; no call has been made |
| `network-runtime-reader.js` / `network-runtime-query.py` | Frida attachment, script loading and session credential extraction | Excluded: conflicts with this task's no-credentials and no-injection scope; source inspected only |

The static UI pointer map explicitly records `runtimeActivationObserved: false` and `callbackExecutionObserved: false`. Asset pointer resolution does not establish that a control exists in the active scene or can be externally invoked. `OperationSaver.SaveOperations` sends a server operation request and is not a passive player-visible observation route; it was not invoked.

Reproduce source identity and symbol locations without loading the official client or any runtime dump:

```powershell
node scripts/official-client-source-audit.mjs <local-research-root> <local-indigo-root> runs/source-audit.json
```

The [machine-readable audit](official-client-source-audit.json) records relative source paths, SHA-256 and symbol line numbers, without copying proprietary source or private assets. It fails if a required symbol disappears. Its result is static evidence, never a live attachment receipt.

The next technical prerequisite is an actor-safe observation/command interface that operates without activating the window or using shared input. No existing external interface was proven in the inspected adapters. A scope-change question is pending for a new narrowly scoped in-process adapter attached to the known official client PID, using the identified UI/event methods. No attachment or client method invocation has happened. Credentials, full private-board objects, opponent hidden information and security changes remain excluded. No game was launched.
