# Seeded native runtime increment

This optional path reuses the existing Indigo Live worker with private local programs. It runs offline on the desktop. Original adapters and tests are public; recovered programs, binaries, decks, private configuration and detailed journals remain external or ignored. This is a two-deck regression profile dated October 11, 2026, not full current Standard certification.

## Ownership and deterministic execution

One process owns one canonical native match and pending operation. An isolated build copies the pinned original worker into ignored `.cache/`, adds the original `OfflineAudit.cs` hooks, and builds with the already installed local SDK and cleared package sources. It never edits Indigo Live or downloads dependencies. `prepare-audit.mjs` verifies every original source hash before applying exact hooks and refuses an existing build directory.

Each match receives an explicit uint32 root seed. A versioned `counter-mix32/1` generator supplies every canonical `MatchOperation`, including operations started by player commands. The complete emitted integer seed transcript is retained by the trusted runner. Native helper algorithms still interpret those integers; changing runtime binaries requires new pins and evidence. The offline clock is fixed to the bundle's date. Timeout and automatic-choice paths remain disabled.

Reads and previews deserialize disposable copies and receive a separate generator that throws if chance is requested. They never consume the canonical stream or replace the pending operation. Every command in the audited run checks that intervening reads/previews preserved authority and the transcript.

Native UUIDs are nondeterministic. Journal normalization `runtime-identity-minus-lastCheckedState/3` preserves generated identity relationships, ordered arrays and all game values while retaining immutable program IDs. It applies the same transformation to serialized JSON containers in native metadata. Only the named `lastCheckedState` cache field is excluded, including inside serialized knockout-history snapshots. That cache contains process/UUID-dependent hashes. These are semantic replays, not byte-identical native checkpoints or arbitrary board-resume support. Identical-printing search ties use initial physical-entity ordinals instead of random UUID order; those ordinals never enter the actor input.

## Player and decision boundary

`PolicyView` supplies a detached, deeply frozen whitelist to one trusted heuristic at a time. It replaces visible physical identities and offers with per-seat aliases, resolves only current offers, and removes accounts, native labels/details, logs, events, snapshots and seeds. Choice action keys are removed. An action key survives only when grounded in a currently visible creature. This is an accidental-disclosure boundary for trusted code, not a sandbox for hostile plugins.

The isolated worker uses state-aware native `GetUseActions`, including granted actions, and considers additional owned-zone and shared Stadium origins. An independent settled-state audit traverses native entities and compares owned legal Use tuples. Native prevalidation assumes the caller enforces origin ownership, so that ownership check is explicit in the audit. This checks Use coverage at encountered states; it does not certify every operation family.

`decision-domain.mjs` enumerates finite choice subsets/permutations and allocation products, then asks a strict native validator about every candidate. `complete: true` is emitted only after exhaustion. An exhausted candidate budget throws rather than returning a partial set as complete. Synthetic tests compare small domains with independent brute force. Actual native probes cover only small encountered nonallocation prompts.

## Run with private inputs

Start with the [local configuration contract](../integrations/local-worker/README.md). The source-build configuration additionally supplies `workerSourceRoot`, a hash map `workerSourceSha256` for the nine worker/project files listed by the preparer, and a new `auditBuildId` such as `native-audit-local-1`. All values belong in ignored `runs/`.

```sh
node integrations/local-worker/prepare-audit.mjs runs/local-source-config.json
node scripts/native.mjs record runs/local-audit-config.json native-record-1 1729
node scripts/native.mjs replay runs/local-audit-config.json native-replay-1 runs/native-record-1/journal.json
node scripts/native.mjs verify runs/local-audit-config.json native-contracts-1 runs/native-record-1/journal.json
node scripts/native.mjs benchmark runs/local-audit-config.json native-benchmark-1 runs/native-record-1/journal.json
node scripts/native.mjs gauntlet runs/local-audit-config.json native-gauntlet-1
```

Each run name creates a new directory under this repository's ignored `runs/`. Existing directories are refused. The CLI rejects redirected output roots and never prints raw views or native diagnostics. A failure diagnostic stays private. Replay and benchmark resolve exact recorded deck hashes, including swapped seats. Each process is bounded to 180 seconds and 2,000 commands at most. The frozen gauntlet uses one process at a time and four games. No renderer, service, commercial client, network connection or training loop starts.

The benchmark replays the complete recorded decision trace in one worker request. Its timer includes fresh-process startup, bundle loading, setup, accepted transitions, the worker's current legal-action enumeration and compact projections. It excludes preview requests, policy inference, per-step persisted audits, final verification and optional presentation details. After timing, it checks natural termination, command/revision counts, the complete seed transcript and final semantic state. This measures a fixed regression workload, not policy-search or learner throughput.

## Executed evidence

On October 19, the seed-1729 record completed 123 commands, 44 previews, 12 native turns and 63 seed requests with zero rejected commands. A fresh process replay matched all 124 authoritative semantic frames and both actor hashes, with an additional cached read per seat at every frame. The [safe proof receipt](native-replay-proof-v1.json) preserves audit counts. The final semantic snapshot hash is `11e646d6f9cca0143090bb413aaae9ffadd1096e2ea6f98b7b6eb7812bc99053`.

Ten hidden-world probes at revisions 0, 25, 50, 75 and 100 preserved both actor DTOs. Eight included an opposing-hand/deck exchange; initial probes only permuted hidden slots. Two settled Use audits had no missing/extra tuples; three other probes explicitly skipped pending decisions. Three small actual prompt domains were exhaustively checked against native preview. These counts describe encountered states, not exhaustive mechanics coverage.

The separate adversarial runner interleaved two owned processes after their first native chance request, preserved both streams under reads, reproduced the same-seed state in a third process, and rejected five corrupted replays. It checks changed state, seed underflow, leftover seed entries, exhausted command transcripts and wrong pins. It requires a successful unmodified full replay before the mutants, so an already-corrupt input cannot pass the suite. The initial failed verification attempt assumed `create` had already consumed randomness. Native chance starts after the first command; the retained failure led to moving the check to that actual boundary.

Three cold-process benchmark repetitions on Node 24.18.0 and a Ryzen 7 5800X completed the same 123-command game in 50.13, 43.92 and 49.79 seconds. Median throughput was **0.0201 games/s**, with range **0.01995-0.02277**, and median command throughput **2.47/s**. Each run verified the same terminal state and 63 seed requests with zero errors/truncations. The [raw safe receipt](native-benchmark-v1.json) records hardware, exact pins and work counts.

Every repetition made 5,552 measured read copies, consuming 29.16-33.53 seconds, or 66.4-67.3% of end-to-end time. Those timers cover native serialized copying and RNG guard installation; they are not a sampling CPU profile. Host load was uncontrolled, each game includes fresh startup/JIT, and this is the original default SDK build. There is no tuned-build comparison or speedup claim. Repeated native copies in legal-action validation are the measured next optimization target. The earlier historical three-card throughput is a different workload and cannot estimate this engine's speed.

The [frozen gauntlet receipt](native-gauntlet-v1-receipt.json) contains four naturally completed games, 521 accepted commands, 207 previews and zero errors, truncations or rejected commands. Seeds 2718 and 3141 each swap the exact decks between seats. Dragapult wins three games and N's Zoroark one under the same frozen heuristic. The resulting fixture score is 0.75 with paired-seed bootstrap interval [0.5, 1]. Only two seed pairs support that interval; it excludes metagame, deck-population and mechanics-coverage uncertainty. This is neither a policy improvement comparison nor a rating estimate. A future confirmatory run needs untouched seeds.

An additional fresh-process replay of the swapped-seat seed-3141 game matched all 53 frames, both actors and 33 seed requests. It completed 52 accepted commands with zero rejections. This checks the CLI's recorded-deck ordering against actual native play, separately from the original seed-1729 replay.

## Open gates

| Gate | Current limit |
|---|---|
| Dated Standard legality | Complete legal-printing denominator and per-card interaction certification remain open. Local program presence is not admission evidence. |
| Observations | Public Lost Zone, visible pending cards, authorized hand reveals and cumulative public history are incomplete. Hidden-world probes establish only the encountered information sets. |
| Actions | Settled Use traversal and small prompt probes are partial. Place, evolution, attachment, retreat and lifecycle families need independent completeness fixtures. |
| Allocation | Some ReparentDamage add prompts omit a minimum. They explicitly fail domain admission. Amounts above 1,000 and oversized candidate universes also fail explicitly. |
| Replay | UUID-isomorphic semantic replay with one named cache exclusion. No serialized continuation/branch clone guarantee. |
| Search | No native search or belief sampler. A serialization copy loses collaborators and cannot be treated as a safe canonical branch. |
| Evaluation | Two exact decks and one frozen heuristic. Designed equal weights have null observed metagame coverage. Four games cannot establish policy improvement or competitive strength. |

The next extension is complete player history and decision coverage, followed by a bounded branch mechanism that preserves continuations/RNG. Search may sample plausible worlds from player information; it must never receive the actual hidden state as a shortcut. The [data and baseline research](training-data-and-baselines.md) records suitable source boundaries and the later search/model sequence.

The [native copy experiment](native-copy-optimization.md) addresses the measured repeated serialization cost without sharing mutable validation graphs. Its explicit execution mode and cross-build conformance comparison retain the original replay and information boundaries. It does not close the observation, decision or branch gates above.
