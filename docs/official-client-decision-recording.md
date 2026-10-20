# Private Live decision records

The frozen Model3/Model4 controller now records ordinary, selection and helper decisions in the same linked journal. This prepares source data for the full-board Model5 baseline; it does not implement Model5's representation, train a model, or admit existing games into a dataset.

Every process invocation, including a resume, creates `private-decisions-<sessionId>.jsonl` inside its ignored `.cache/<candidate>-live-<gameId>/` folder. Raw observations, prompts, names, policy inputs, export text and payloads remain private. Source changes contain no captured client data or extracted assets. Windows access controls are inherited; POSIX file modes are also requested where supported.

## Decision lifecycle and joins

Events use `official-client-decision-event/1`. Every record includes `gameId`, fresh `sessionId`, monotonic `sequence`, timestamp, previous-record SHA256 and its own SHA256. Calculate the record hash from the serialized object without `recordSha256`, preserving field order. These hashes detect edits against a retained digest; they are not signatures.

| Event | Retained contract |
| --- | --- |
| `session` | Candidate identity, ordinary/selection checkpoint hashes, helper hash, config hashes, static card corpus and deck-bundle hashes, encoder/projection/loader/runtime/controller/recorder source hashes, legacy dimensions |
| `session-metadata` | Verified model feature/alias/seed contracts and runtime terminal-observation capability; no configuration paths |
| `observation` | `observationId`, revision, runtime snapshot hash, actor-visible board and full runtime actions/prompt, terminal UI evidence; navigation/synchronization fields isolated in `driverContext` |
| `proposal` | `decisionId`, `preObservationId`, kind and attributed policy/helper ID, exact `policyInput`, optional exact `encodedInput`, unmodified policy/helper `decision`, resolved client `{op,data}`, complete runtime `offered` actions/prompt, selection ranking and `pinsRef` |
| `dispatch` | Same `decisionId`, exact request ID, operation, selected action/choice IDs or allocation amounts, expected snapshot hash and arm/step fields |
| `execution-result` | Same `decisionId`, returned runtime receipt or request failure; `executionVerified:false` |
| `observation-link` | Same `decisionId` and subsequent `observationId`, with terminal/transition/unresolved status and explicit uncertainty |
| `terminal` | Final observation ID, observed winner when available, private export receipt/hash and exact observed UI reason, or explicit missing/partial evidence |

Write ordering is sequential and single-writer. Proposals and dispatches are flushed and synced before input. An interrupted process can leave a dispatch without a result. That is an uncertain execution, never authority to replay. The controller stops on journal failure and always attempts its owned runtime/model cleanup independently of journal writes.

`preObservationId` joins to the complete currently emitted actor observation, including for setup, text, empty search, prize and allocation helpers. `policyInput` retains exactly what the particular policy/helper actually received: a projected view for model/native-helper calls, raw actor projection for setup, and `{prompt}` for the text helper. These may contain less information than the pre-action observation. `encodedInput` retains the exact 224-state/191-candidate tensors for legacy ordinary and selection inference; helper calls have no invented encoded input. `ranking` is the complete selection model ordering before the existing group/min/max/duplicate logic resolves the selected IDs. Ordered `choiceIds`, allocation `choiceId/count` entries, and resolved runtime payloads are retained without reconstruction from labels. Ordinary runtime action IDs already encode their whitelisted SDK command and arguments; no memory addresses are recorded.

Reparent prompts additionally retain each group's already visible `sourceCard`. Combined with the selected group/choice ID and target identity, this preserves the exact source-to-destination pairing that otherwise lived only in the runtime's pointer map. The legacy model's projected groups still contain only its original ID/min/max fields.

Subsequent observations record `afterDecisionId` while an action is pending. An `observation-link` marks the controller's observed state transition. Neither it nor the runtime's `sent-unverified` response proves semantic execution. Proposals and links explicitly carry `trainingEligible:false`; downstream admission must exclude driver events, interruptions and unverified actions from policy examples/rewards. Game completion alone does not make every decision admissible. Old sessions are not retroactively filled or relabeled.

## Visibility and static mechanics

The observation journal retains own visible hand, both public boards, public attachments/evolution stacks, discards, stadium, counters, visible status/HP/damage/energy/retreat/action fields and all offered candidates. Opponent hand remains count-only. Decks and prizes remain count-only; an offered face-down prize is an opaque clickable slot with no underlying identity or order. Card faces from a normal visible own search prompt are retained only through that existing admitted prompt projection. The recorder rejects opponent hand faces and hidden deck/prize containers. Runtime transport/window data is not added to policy input.

The pinned local datamine card corpus and deck mapping support a structured static mechanics join using runtime source IDs and projected printing/definition IDs. Extracted data stays local. They supply printed card rules, not privileged dynamic game state. Completeness here means all fields/offers emitted by the pinned adapter, not that every client mechanic is exposed. Unexposed per-turn flags/modifiers and unmapped mechanics remain explicit unknowns. The separate Model5 trainer owns its richer actor-safe representation and teacher; no learning module was edited.

## Terminal export and exact reason

At a normal terminal observation the controller sets its own input kill marker before up to three read-only `battle_log` requests. A human kill marker is preserved and prevents these reads. Terminal capture is bounded; export failure is recorded as missing or partial evidence without rewriting the observed winner or inventing a final reason from deck/prize counts. Cleanup writes the runtime kill marker and detaches the owned adapter afterwards.

The local datamine identifies normal `BattleOutro.ShowMatchResultOverlay(bool didLocalPlayerWin, string gameEndReasonLocID)` and `CentralMessageBar.CurrText`. The adapter observes those normal presentation arguments and displayed text, never raw end-game modifications, hidden board/statistics or deck/prize identities. It caches the ordinary export model text at presentation so scene cleanup does not automatically lose the final log. `terminalUiCaptureAvailable:false` means that optional source-bound observer was unavailable; unknown reason remains unknown.

Exports include optional `official-client-terminal-reason/1` metadata: exact source, observed/unknown status, presentation boolean/time, local-win boolean, reason localization ID and displayed text. A localization ID is not an inferred English explanation. `capturePhase` distinguishes an ordinary read, a terminal read and the cached terminal presentation snapshot. Reason and phase changes produce new journal snapshots even when battle-log text is unchanged. Export text remains ordered and private, and its normal match identity is hashed before persistence. No clipboard export method is invoked. Public receipts expose status/hashes/counts, never reason/text or private paths.

The controller uses `--battle-log-terminal-only` so ordinary observations do not trigger extra export reads. Other existing runtime callers retain output-on-observe behavior when they use only `--battle-log-output`.

## Trainer integration and compatibility

Import `createDecisionRecording` from `integrations/official-client/decision-recording.mjs` for the future controller. Supply its candidate and pinned artifact/source hashes, record each actor observation, then call `propose`, `dispatch`, `result` and `link` sequentially around the existing action boundary. Pass richer already actor-safe plain JSON as `policyInput` and the actual Model5 tensor contract as `encodedInput`; do not train directly on the journal's driver envelopes. Finalize with `terminal` and `close`. The recorder is a trusted in-repo boundary, not an arbitrary untrusted observation sanitizer: the upstream projector still owns visibility and model-input legality.

The legacy ordinary-only `private-policy-decisions.jsonl` file is still written. Existing Model3/Model4 loaders, encoders, selection grouping, helper policy and checkpoint pins are unchanged. Battle-log schema `/1` gains optional metadata; old exports without it still normalize. Each resume creates a fresh journal under the same `gameId`; sessions must be joined explicitly and missing records must remain missing.

This preparation was source-reviewed only. No tests, inference, client attach, focus/input, games, checkpoint changes or training were performed. The optional Mono presentation hook, terminal timing/cache, and export formatting still need verification in a separately authorized live session before a trainer treats their output as verified evidence.

The later [single Model5 viewing diagnostic](official-client-model5-viewing.md) retained 75 linked proposals and a complete terminal export using this recorder. Its exact final reason remained unknown, and every recorded decision remains training-ineligible pending semantic execution verification and admission. This later evidence does not change the preparation-only activity described above.
