# Local in-client game history

The SQLite history indexes retained official-client games. AI tests and ranked play are separate modes in every query. It neither starts games nor authorizes a ranked session. The JSONL logs used by the desktop overlay remain unchanged.

## Usage

Use the already installed Python with its standard-library `sqlite3`; no package installation or model load is required. From the checkout:

```powershell
python scripts/official-client-history.py import <absolute-private-run-folder> [<another-run-folder> ...]
python scripts/official-client-history.py summary
python scripts/official-client-history.py list --mode ai_test --clean
python scripts/official-client-history.py list --mode ranked --checkpoint <sha256> --clean
```

The default database is `.cache/client-history/games.sqlite3` under this checkout. Pass `--db <absolute-private-cache-path.sqlite3>` before the command to select another local database. The path must remain under a `.cache` directory, and symlink/junction database paths are rejected. The database, WAL/SHM sidecars, raw journals, exported logs and local artifact locations stay ignored and private. Back up the database using SQLite's backup API or close writers before copying it; do not copy only the main file while WAL writes are active. Do not upload it as a source artifact.

Current Windows preparation used the existing Python 3.12 executable and SQLite 3.49.1. No client attach/input, game, simulation, training or unit-test suite was needed for this extension. Runtime imports and database readback are the validation performed here.

## Ownership and identity

`clientGameHistory` is the controller's only persistence interface: `begin`, `observed`, and `checkpoint`. It invokes the independent Python importer using argument arrays; policy/model code never owns SQL or database state. Callers provide `declaredMode` and `modeSource`; omission means unknown, never ranked or AI by default. The current AI-only controller explicitly declares `ai_test` before any launch, records the observed offline flag once when it changes, and imports at preparation, launch, first mode observation and final cleanup. The final import follows runtime/model shutdown, journal close and receipt write. A failed or uncertain final import writes a private `history-import-status.json`; retained artifacts can be imported later without replaying client input. Early persistence failure stops before the launch.

The chosen design stores normalized game/session/decision metadata with immutable artifact references. Copying every board snapshot into SQL and deriving all games through event queries was considered; it would duplicate the authoritative logs and make ordinary mode/status queries harder. The normalized index is rebuildable while original JSONL remains the authority. This is one persistence module and CLI, not an additional telemetry service or dashboard.

The original controller UUID is `games.game_id`; a resumed process keeps that UUID and has its own session ID. Copying an unchanged run folder does not create another game. An import snapshot is identified by importer version, game UUID, artifact relative names and raw-byte hashes. Repeating it adds no import or game. Append operations create a new immutable snapshot attached to the same game. Artifact locations are private; copying identical artifacts can add a location without duplicating their identity. A conflicting start for the same UUID or changed decision/session identity is rejected transactionally. Older snapshots cannot overwrite a later completed game.

Raw files are read only. Only explicit receipt/run schemas and owned `model3/4/5-live-<uuid>` folders directly under a private `.cache` are accepted. Arbitrary simulator run folders are not admitted. Version 1 does not ingest the earlier ad-hoc Model2 sample format; a future adapter must establish its launch/session provenance first.

## Meaning of the fields

| Field/domain | Rule |
| --- | --- |
| Mode | Enum `ai_test`, `ranked`, `casual_other`, `unknown`. `casual_other` means casual/other non-ranked play. Declaration, source and observed evidence are retained separately in JSON |
| AI provenance | Original `launch-intent.mode=provided-ai`, explicit new controller declaration and/or observed `runtime-ui:offline=true` |
| Ranked provenance | Requires explicit ranked declaration/evidence. `offline=false` supplies only non-AI evidence with unknown queue; it never implies ranked |
| Mode conflicts | Contradictory known modes, or AI declaration plus observed non-AI, produce `mode=unknown`, `mode_conflict=1`, and exclusion from clean results |
| Account | `account_alias` is NULL. No account name, credential, platform ID or Windows user identity is extracted or pseudonymized unnecessarily |
| Perspective | Local player. Opponent hidden hand, deck order and prize identities are never supplied to the importer from any privileged source |
| Time | Start is the original launch-intent UTC timestamp; before launch it remains NULL. End is the terminal event timestamp, or controller-stop time for an aborted/failed run, distinguished by `end_source`. Running resumed sessions do not retain an old stop as their current end |
| Outcome | `win`, `loss`, `draw`, `unknown`; requires a `game-finished` event plus a completed receipt. Missing winner is unknown, never loss/draw. Contradictory outcomes remain unknown |
| Driver status | `declared`, `running`, `completed`, `aborted`, `driver_failed`, `unknown`, independently of policy outcome |
| Driver quality | `clean`, `interrupted`, `failed`, `unknown`; earlier pauses/resumes, timing sessions, rejections, failure/cleanup evidence remain relevant after a later completion |
| Deck | Canonical sorted exact-source/count composition hash. `mechanics_profile_sha256` is the source-pinned deck-bundle/profile hash when retained; it is not a claim that the current UI mechanics are identical |
| Model versions | Candidate/checkpoint/feature/helper columns plus complete per-session source/encoder/helper/catalog pins in `sessions.pins_json` when available. Missing historical versions stay NULL; conflicting checkpoint evidence is explicit |
| Decisions | Rich journals retain exact selected/resolved payloads, policy/helper attribution, pre-observation ID, result state and raw artifact/line/hash reference. Full offered choices/actor views/tensors remain in that raw journal |
| Legacy decisions | Original proposed-event attribution is retained with payload/execution unknown; raw ordinary-decision files remain referenced. Selection/helper payloads are not reconstructed from labels |
| Training | Every decision has `training_eligible=0`; driver state transitions and completed games alone do not verify semantic execution or admit policy examples/rewards |
| Terminal reason | Stored only when the normal result UI reason was explicitly observed. Exported battle log is referenced and hashed; no reason is inferred from counters or parsed into a guessed outcome |

`clean_outcome=1` requires a completed known result, clean driver history, no mode conflict and no partial artifact warning. The `clean_policy_results` view also excludes unknown mode. Clean driver outcome and complete learning-data coverage are different: old Model4 games can be clean outcomes while their recording coverage remains `legacy_partial`.

## Transactions and queries

Schema is `official-client-history/1`, `PRAGMA user_version=1`; unsupported schema versions fail closed. Imports use `BEGIN IMMEDIATE`, foreign keys, WAL, a 15-second busy timeout and `synchronous=FULL`. Parsing/chain validation precedes the write transaction. Game, import, artifact, session, decision and attribution changes commit together or roll back. Rich journal hash chains are checked against their original JSON lexemes. A partial trailing JSONL line is excluded and flagged; malformed complete lines fail rather than silently disappearing.

Indexes cover checkpoint/mode/clean outcome, mode/status/start time, policy/kind and artifact roles. For direct local SQL:

```sql
-- Keep the mode filter: AI wins are never ranked results.
SELECT checkpoint_sha256, mode, outcome, count(*) AS games
FROM clean_policy_results
WHERE mode = 'ranked'
GROUP BY checkpoint_sha256, mode, outcome;

SELECT candidate, status, driver_quality, outcome, count(*) AS games
FROM games
WHERE mode = 'ai_test'
GROUP BY candidate, status, driver_quality, outcome;
```

Mode evidence distinguishes a declaration from an observation; this extension does not implement ranked queue discovery or authorize ranked actions. Future ranked producers must retain their actual mode evidence and use the same importer contract.

## Imported history and observed readback

Seven existing in-client run folders were imported without modifying their original logs: four Model3 starts, two Model4 games, and the one completed Model5 viewing game. All seven have explicit AI provenance; ranked/casual/unknown counts are zero.

| Mode / status / driver quality | Games |
| --- | ---: |
| AI test / completed / clean | 3 |
| AI test / completed / interrupted | 1 |
| AI test / completed / failed | 1 |
| AI test / driver failed / failed | 2 |

The three clean AI outcomes are the Model4 win/loss and Model5 win. Interrupted/driver-failed Model3 records remain outside that clean set; unknown aborted outcomes are not counted as losses. The database contains seven import snapshots and 507 attributed decision rows, including Model5's 75 fully linked proposals. Repeat imports reported `newSnapshot:false` for all seven with unchanged row counts. Normal readback reported SQLite integrity `ok`, foreign keys enabled, zero foreign-key violations, zero invalid clean outcomes and zero training-eligible decision rows. Raw battle text, datamine data, screenshots and the database are not part of the authored source commit.
