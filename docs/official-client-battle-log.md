# Private exportable battle log

The thin observation service can retain the client's player-visible export text. It records complete export snapshots in their original entry order, with source, observation time, sequence, content hash and a previous-record hash. It does not infer actions, rewards, hidden state or training examples from that text. Duplicate captures refresh the receipt without duplicating the journal; edits to earlier entries produce a new complete snapshot. CRLF is normalized to LF in the journal.

Raw text stays in ignored `.cache/battle-log-<uuid>/exports.jsonl`. This may contain player names and must remain private. `receipt.json` and HTTP `GET /battle-log` expose only versioned metadata, counts, hashes, evidence type and freshness. They exclude text, paths and match identities. The hash chain detects accidental changes when checked against a retained receipt; it is not an authenticated signature. Local files inherit the user's Windows access controls.

## Service usage

Add an absolute `battleLogExportFile` under this checkout's ignored `.cache` to the existing private observation configuration. The producer replaces that JSON file atomically. The service creates a fresh private journal for each run and continues recording even if screenshot capture fails.

```json
{
  "battleLogExportFile": "C:/absolute/path/to/tcg-agent-live-bridge/.cache/battle-log-latest.json"
}
```

Retain the configuration's existing Python, PowerShell, process/window identity and `AgentPult` fields. Start the usual bounded service:

```powershell
node scripts/official-client-observe.mjs .cache/client-ui-config.json
$service = Get-Content .cache/observation-service.json -Raw | ConvertFrom-Json
Invoke-RestMethod ($service.url + '/battle-log')
```

Without the optional configuration the route reports `disabled`. Missing, invalid or failed reads return a fixed HTTP 503 error. An unchanged export older than five seconds reports `stale: true` with HTTP 503; its timestamp is never silently refreshed by polling a file. The same GET, Origin, Host and request-body restrictions apply as for `/observation`. There is no raw log or input endpoint.

## Scoped producer for a future authorized session

The existing runtime adapter accepts `--battle-log-output <absolute-cache-json-path>`. Its read-only JSONL request `{"id":"log-1","op":"battle_log"}` writes the private export file and returns only a write receipt. With that flag, normal `observe` requests also refresh the file. Closing the adapter does not close or concede the client game.

Add `--battle-log-terminal-only` to refresh only on explicit `battle_log` requests. The frozen-game controller uses this mode for bounded terminal capture after disarming input. Optional private `terminalReason` metadata retains the normal result UI's localization ID and displayed reason text, with explicit observed/unknown status. `capturePhase` identifies a live read, terminal read or cached terminal-presentation export. Changes to this metadata produce a new snapshot even when text is unchanged. Neither field is exposed through the public summary receipt. See [decision recording](official-client-decision-recording.md) for lifecycle joins, visibility limits and trainer admission notes.

The implementation reads `MatchManager.BattleLogExportData` through the export interfaces, mirroring `BattleLogExporter`'s plain-text phase, entry and subentry formatting. It does not invoke the exporter, touch the clipboard, read arbitrary model fields or enable gameplay input. The transient normal match identity is hashed before persistence. The existing process/window checks, session bounds and kill markers still apply.

The stopped pilot remains paused. This extension does not attach an adapter, remove kill markers, resume the sample or start another game. The source-bound Mono getter projection has not been exercised against the running client. Its next live check belongs in a newly authorized supervised session and requires no game launch: request one export, compare it locally with the ordinary user export, then close the adapter.

## Fixture contract and verification

This synthetic file demonstrates the private input contract; it is not evidence from a client game:

```json
{
  "schema": "official-client-battle-log-export/1",
  "source": "synthetic-fixture",
  "observedAt": 1792470000000,
  "matchIdSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "text": "Player A turn\nPlayer A drew a card.\n"
}
```

The other admitted sources are `MatchManager.BattleLogExportData` and `user-exported-battle-log`. Future timestamps, regressing observations, invalid hashes, NUL text, oversized exports and storage outside the private cache fail closed. Synthetic evidence stays labeled synthetic.

Focused checks: `node --test tests/official-client-battle-log.test.mjs tests/official-client-observation-service.test.mjs`. These exercise ordering, edits, deduplication, provenance chaining, field redaction, freshness, route restrictions and independent capture failure. They do not establish live getter compatibility or gameplay readiness.
