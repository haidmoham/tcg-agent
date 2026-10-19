# Record observed ladder results locally

This offline tool validates user-entered or user-exported match observations. It reports wins, losses, draws, unknown outcomes and maximum **observed** ratings. It has no network adapter, client control, login or automation permission check. A record is a user assertion, not independently verified evidence of a played game or permission to run an agent.

Keep personal match records in the Git-ignored `runs/` directory. Do not add usernames, account identifiers, credentials or private export contents to this public repository. The committed [example](../examples/ladder-records.example.jsonl) contains three invented records. They are all labeled `synthetic` and are excluded from actual-result summaries.

## Try the synthetic example

From the repository root, run this command. Node 22 or later is sufficient.

```powershell
node scripts/ladder-records.mjs examples/ladder-records.example.jsonl
```

The report prints to stdout. Expect `recordsRead: 3`, `syntheticRecordsExcluded: 3`, zero actual matches and no rating series. The tool writes no file by default.

For your own observations, create `runs/my-matches.jsonl` with one JSON object per line. Keep the original file; the summarizer does not modify or copy it. To save a report, give an explicit output path directly inside this repository's `runs/` directory.

```powershell
node scripts/ladder-records.mjs runs/my-matches.jsonl --output runs/my-summary.json
```

The command refuses to overwrite an existing report, write outside `runs/`, or follow a `runs` symlink or junction. It validates the entire import before writing anything. A malformed record or duplicate ID stops the import with its line number. Blank lines are allowed.

## Record contract

Every key below is required. Extra keys are rejected, including opponent usernames and arbitrary result counts. Use public provenance identifiers of 1 to 120 characters, starting with a letter or digit and containing only letters, digits, `.`, `_`, `/` or `-`.

| Field | Value and meaning |
| --- | --- |
| `schema` | Exactly `ladder-record-v1`. |
| `id` | Unique local match identifier. Re-importing the same ID in one input is an error. |
| `dataset` | `actual` for a real observation; `synthetic` for fixtures or demonstrations. Never relabel an example as an actual match. |
| `source` | `manual` or `user-export`. An export must already be obtained by the user. The tool does not request or fetch one. |
| `pilot` | `human` or `authorized-agent`. This label records the user's assertion. It supplies no authorization and triggers no client integration. This work cycle uses human records only. |
| `platform` | Exactly `tcg-live`. Offline simulator evaluation has its own report format. |
| `ladder` | Named queue, such as `ranked-standard`. Keep distinct queues separate. |
| `season` | Explicit season identifier. Do not merge a reset into the preceding season. |
| `observedAt` | Time this result was observed, in canonical UTC ISO form such as `2026-10-19T12:01:00.000Z`. Impossible dates are rejected. |
| `patch` | Observed client patch/version identifier. Use `unknown` if it was not recorded. |
| `policy` | Object with `id`, `version` and lowercase 40-character Git `commit`. Record the evaluated policy or human-reference protocol, not a claim that software piloted a human game. Use the actual protocol commit for real records. |
| `playedDeck` | Object with `id`, `version` and lowercase 64-character SHA-256 `hash`. Hash a stable, normalized deck-list representation and keep that convention with the deck version. A hash records provenance; it does not validate Standard legality. |
| `outcome` | `win`, `loss`, `draw` or `unknown`. |
| `resultEvidence` | `observed-result` for a known outcome; `not-observed` for `unknown`. A disconnect alone is never evidence of a loss. |
| `disconnected` | Boolean recording a connection interruption. A known outcome after a disconnect still requires an observed result. |
| `opponentDeck` | One of the shapes below. |
| `rating` | `null`, or the rating-observation object below. |

The parser cannot tell whether an identifier or free-text evidence contains private information. Review your input and reports before sharing. Summaries contain provenance identifiers but omit the evidence text.

### Opponent deck evidence

Use `{ "status": "unknown" }` when the opponent identity is unknown. This shape must not contain an ID or evidence.

For `observed` or `inferred`, also supply `id` and a concise `evidence` string of 1 to 500 characters without newlines. An observed deck identity needs direct evidence, such as a complete deck list supplied by the user. An archetype guess from a few revealed cards is `inferred`, even when likely correct. Do not invent unseen cards or promote inference to observation. Write evidence without usernames, account IDs, private file paths or credentials.

```json
{"status":"inferred","id":"example-archetype","evidence":"Hypothesis based on revealed cards; full deck list unknown."}
```

The report has separate `observed`, `inferred` and `unknown` opponent aggregates. Inferred matchups are never added to observed-deck totals.

### Rating observations

Record exactly the metric shown or established by the user's source. The accepted names are `competitive_elo`, `progressive_elo` and `rank_points`. These are separate quantities. The tool neither converts between them nor derives ratings from wins.

```json
{
  "metric": "competitive_elo",
  "before": {"value": 1500, "observedAt": "2026-10-19T11:50:00.000Z"},
  "after": {"value": 1510, "observedAt": "2026-10-19T12:00:00.000Z"}
}
```

Each value must be a finite nonnegative number. Both `before` and `after` are required, but either may be `null` when unobserved. Use `rating: null` if neither was observed. A before observation cannot occur after an after observation. Neither may occur after the record's `observedAt` time. This format describes observations, so the tool does not require one record's after value to equal the next record's before value. Matches or observations may be missing.

Peak rating is the maximum recorded before or after value within a platform, queue, season and metric. A policy/deck/patch/pilot stratum also receives its own observed peak. An absent rating remains `null`; unseen peaks are never estimated. Input order does not determine the latest rating. Conflicting values at the latest observation timestamp produce a null latest rating and `conflictingLatestObservations: true`.

## Interpret a comparison

`totals` counts all actual observations. `strata` separates policy ID/version/commit, deck ID/version/hash, client patch, season, queue, metric and pilot. Compare matching strata before crediting a policy change. The season rating series describes the player's observed series across versions; it is not a policy-strength estimate.

`decisiveWinRate` is wins divided by wins plus losses. Draws and unknown outcomes remain visible and are excluded from that denominator. Its Wilson 95% interval assumes independent games. Repeated opponents, selected submissions, changing matchmaking, changing decks and patch changes violate or limit that interpretation. A collection of human games is not evidence that an autonomous policy achieves the same performance. No interval or offline result is converted into Live Elo.

## Module boundary and design

```js
import { parseLadderRecords, summarizeLadderRecords } from './src/ladder-records.mjs';
const records = parseLadderRecords(jsonlText);
const report = summarizeLadderRecords(records);
```

The module owns validation and reporting without filesystem effects. The CLI owns local file reads and explicit report writes. The alternative of importing arbitrary exports directly was rejected because export formats and privacy fields are not established. A strict small interchange format keeps input errors visible and avoids silently inventing missing outcomes or deck identities. Source files stay local and unchanged. There is no mutable accumulator shared with simulator evaluation.

Run the contract and CLI checks with `node --test tests/ladder-records.test.mjs`. Tests cover synthetic exclusion, unknown disconnects, opponent inference, duplicate IDs, date validation, rating chronology, metrics, seasons, provenance, confidence intervals and output-path restrictions.
