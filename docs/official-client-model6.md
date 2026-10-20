# Model6 diagnostic viewing

This page records the original control update-4 viewing. The later
[cohort handoff preparation](model6-cohort-view-preparation.md) also supports
verified version-2 manifests and derives attribution from their pinned metadata.

The viewing adapter loads the completed control PPO pilot, update 4, checkpoint
SHA256 `391e5545c303317a81bd82b4ea355681aed657ae4950c58847a26b49155f70c1`.
This is an unselected candidate, not a selected arm or qualified improvement.
The checkpoint uses `native-energy-entity-decision/1`, contract SHA256
`3c86e7c8c595e485d9bfdd6e7137a5413d89e947cda300ee0ec42fd57b70640a`.

`prepare-model6-live.mjs` accepts the retained authored-source snapshot, update
receipt, frozen pre-PPO CPU selection config and prior private input manifest.
It copies only the inference dependency closure into ignored `.cache`, retaining
raw bytes and all 12 checkpoint runtime source pins. It never edits the trainer,
checkpoints, previous manifests or previous game logs. It starts disarmed.
The current trainer working tree is not an inference source: its newer context
implementation fails the old pilot's source guard.

The matching sixteen authored runtime files are published under
`integrations/official-client/model6-frozen-source`, with raw-byte SHA256 pins in
its `manifest.json`. Supply that directory as the first preparation argument.
The snapshot includes files required by the checkpoint source guard, preserves
their original bytes and remains separate from the active training source.
Private update receipts, CPU configuration, inputs, catalogs and weights are
still required locally. Publication checks verified source bytes and reviewed
the dependency closure; they did not load a model or repeat the viewing game.

The model process verified all source/contract/catalog/checkpoint guards on CPU,
reported four optimizer updates, and loaded the frozen Model6 selection model
SHA256 `049107f7c0b99fdade1676027ad1a172cb6c68a00b116ea946b0ef21ecf7ba9b`.
There is no Model5 weight fallback.

After fresh client identity, exact AgentPult60 mechanics and account evidence are
established, a human-authorized single AI viewing uses:

```text
node scripts/official-client-model3-game.mjs --model6 --one-built-in-ai --arm --step
```

The private manifest must explicitly enable input. Session end writes both kill
markers. A stopped owned match may continue only through the resume command,
which checks the original game ID, one launch, candidate, checkpoint, active
offline match and retained launch evidence. Resume never queues another game.
Old Model5 resume remains disabled. The driver preserves visibility/background,
does not activate the client or move the shared cursor, and stops on uncertainty.

## Feature and selection parity

| Field/path | Live evidence and limits |
| --- | --- |
| Player board, public opponent board, own hand, public attachments | Existing actor-visible UI projection and per-entity bindings |
| Typed supply | Rendered `CardInfo.totalEnergy`, simple typed symbols only; unsupported symbols masked |
| Complete printed attack costs | Pinned local corpus, exact visible card definition; bindings checked |
| Effective costs, payment, retreat payment, attachment counterfactuals | Unknown in this frozen viewing slice; no invented values |
| Turn usage, item-lock expiry, previous-turn KO history | Existing explicit unknown masks |
| Ordinary actions | Frozen PPO, deterministic argmax of complete offered candidates |
| Single-card entity selections | PPO with `selectionCardinality=1` and complete client-menu `Validate` mask |
| Multi-card/reparent selections | Pinned Model6 pre-PPO BC ranking and frozen native grouping policy |
| Setup/text/opaque prizes/allocation/empty searches | Existing separately attributed helpers |

Singleton validation runs on the Unity dispatcher, requires an unchanged owned AI
prompt with minimum/maximum one and initially empty selection groups, temporarily
populates each offered choice, calls the existing menu selection validator and
clears all temporary groups in `finally`. It never submits or calls gameplay
SDK commands. It checks that the visible observation is unchanged afterward.
The model receives the complete mask in original candidate order. Actual submit
validates again. Reparent and amount selections are excluded from this endpoint.
This uses the client validator, not a guessed simulator mask.

## Private evidence and overlay

Games retain ordinary, selection and helper inputs, exact payloads, pins,
execution results and subsequent observation links in ignored JSONL journals.
Terminal handling attempts the exportable battle log and actual final reason.
Missing reasons remain unknown. Driver-interrupted results stay excluded from
clean policy performance and training admission.

`client-ui-config.json` may set an absolute `historyDatabase` inside a private
`.cache` path, allowing separate viewing checkouts to share one local SQLite
history. Model6 folders are accepted without changing game identity. Importer
version 2 distinguishes missing timestamps from the current import time and
allows a legacy preparation timestamp to be corrected only when its original
import has no launch evidence and is still declared with zero/unknown launches.
Old import snapshots remain intact. Conflicting real launch timestamps fail.

The existing read-only overlay source is reused in this checkout. Its reader
chooses the Model6 private manifest from the candidate pointer and uses the
session's contract/checkpoint pins. It never overwrites a Model5 manifest.
No model, catalog, raw logs, database, screenshots or extracted assets belong in
the source commit. No strength comparison or native-to-Live parity claim follows
from this diagnostic game.

The later [shared visible Energy helper](visible-energy-rules.md) is an opt-in
extension with separate bounded retained-record evidence. It was not enabled
for the completed viewing below; its new Live getter bindings remain unverified.

## Completed viewing evidence

The single AI launch on 2026-10-20 finished with an observed local win at
18:47:33 UTC (669.473 seconds including a startup logging interruption). The
checkpoint remained unchanged. There were 35 ordinary PPO decisions, five PPO
singleton choices, three frozen Model6 BC selections, and 12 attributed helpers.
Five Phantom Dive intents, 54 ordinary subsequent transitions and zero rejected
gameplay actions were recorded. The terminal battle export contains 268 lines;
its final-reason field is unknown.

A missing-timestamp bug paused the first controller immediately after its one
launch and before its first policy move. The same owned AI game resumed after
the importer fix. Its original paused receipt was retained separately, and both
session journals and original launch time remain in one SQLite game row. Final
import is confirmed, natural outcome is win, driver quality remains failed due
to the retained interruption, and clean_outcome remains zero. This is diagnostic
evidence, not a qualification result. Input/runtime kill markers are set and the
Model6 manifest is disarmed. No second game was launched.
