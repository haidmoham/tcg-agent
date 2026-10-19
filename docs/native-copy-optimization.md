# Native projection copy experiment

The target is the measured repeated serialization cost in native read copies. The prior regression made 5,552 copies per 123-command game; the aggregate clone timer accounted for roughly two thirds of elapsed time. This increment compares identical root seeds, deck orders and recorded commands. It does not change card semantics or claim complete Standard coverage.

## Measured result

Five complete paired repetitions on the Ryzen 7 5800X desktop measured **26.9% more games/s**, or **21.2% less median elapsed time**, on the same root-1729 trace. This is the ratio of the two side medians. All five individual pairs favored the candidate. [The raw safe receipt](native-copy-comparison-v1.json) retains every run, exact worker/input hashes and the conformance proof. Host load and shared OS caches were uncontrolled; each repetition starts a fresh process and uses the same original project/default SDK build options, which select Debug. This historical result is specific to those options. The [subsequent hill climb](native-performance-hillclimb.md) establishes explicit Release comparisons before choosing further production changes.

| Execution | Completed games | Median seconds/game | Range | Median games/s | Median commands/s |
|---|---:|---:|---:|---:|---:|
| Original native copying | 5 | 54.58 | 47.30-55.95 | 0.01832 | 2.254 |
| Projection snapshot | 5 | 43.02 | 39.04-45.37 | 0.02325 | 2.859 |

Every repetition executed 123 accepted commands, requested 63 native seeds and made 5,552 fresh read copies. Errors and truncations were zero, and all terminal semantic hashes matched. The earlier three-run receipt has a different run block; use these fresh paired measurements for this comparison.

Before timing, the candidate matched every original authority frame, both actor DTOs and every seed request across all 124 frames. Extra reads and ten hidden-world probes passed, including eight opposing-hand/deck exchanges. The two settled Use audits and three small prompt domains matched; three pending Use probes skipped explicitly. A separate swapped-seat seed-3141 replay matched 53 frames, 52 commands and 33 native seed requests. The full suite passes 89 tests with no failures or skips.

Each timed candidate made 5,473 fresh scoped deserializations and reused the immutable input 5,225 times. Its 496 scoped serializations include both snapshot creation and exit integrity checks; 79 outside-scope command validations still copy natively. Those outside copies are not included in the scoped serialization/deserialization phase counters. Work was removed from repeated serialization, not from legal validation or the number of independent read graphs.

## Chosen boundary

The caller remains `Project(seat)`. It now owns a disposable projection lifetime. The candidate mode `projection-snapshot-v1` privately serializes authority once at the first read in that scope. Every read still deserializes a fresh graph using the native polymorphic/default/binder settings and receives the existing fail-on-read RNG. The actor DTO, native privacy transform, legal-action traversal and command path are unchanged.

The scope checks authority identity and revision before serving another copy. On exit it serializes authority again and requires byte-identical input. It clears the full-state string, owner reference and detached action-discovery copy in `finally`. The second serialization is deliberate correctness work and remains inside the end-to-end timer. Snapshots never cross seats, revisions, commands or privacy probes. Outside a projection, native `CopyOperation` remains the path, including command revalidation.

Source inspection rejected mutable validation-copy reuse. Native validation changes the operation status, selected operation, queues, end-turn flags and effect caches; a complete reset contract is unproved. Caching by revision alone was also rejected because a privacy probe temporarily swaps authority at the same revision. A per-projection immutable input removes repeated work while preserving per-candidate object isolation.

`native` remains the default when the optional mode is absent. Private prepared configurations can explicitly select the verified candidate. The adapter refuses unknown modes, and audit/benchmark runners require the requested mode to be honored. This makes the execution choice part of new journal headers while keeping older native-mode journals usable with their original pins.

## Reproducible comparison

```sh
node scripts/compare-native-copies.mjs runs/baseline-config.json runs/candidate-config.json runs/baseline-journal.json native-copy-check-1
```

Use the original pinned baseline config/journal and a newly isolated candidate build with `projectionCopyMode: "projection-snapshot-v1"`. Preserve the previous config before running the preparer, which writes the active local config pointer. Existing output/build directories remain protected. All native inputs and full journals stay private and ignored.

The comparison explicitly permits changing only the worker hash and declared copy mode in the expected replay header. Executable, private manifest, policy, decks, every expected authority/actor frame, seed transcript and command remain fixed. Ordinary replay still requires exact execution pins. This is a cross-build conformance test, not a claim that different worker binaries have the same identity.

Before timing, the candidate must pass all baseline frames with extra reads and hidden-world/Use/prompt probes. Then five pairs alternate AB, BA, AB, BA, AB. One fresh process runs at a time. Each repetition uses the existing headless trace timer and verifies the terminal state and complete native seed transcript afterward. A failed proof or repetition stops the comparison and preserves private partial diagnostics. Timing is bounded to 900 seconds total, with at most 180 seconds for one game, plus a separate bounded correctness proof.

The timer includes fresh process/bundle loading, native transitions, the worker's current legal-action enumeration and compact projections. It excludes policy inference, previews, persisted per-step audits, optional presentation details and post-timing verification. This is fixed-trace environment throughput. It is not heuristic, turn-search or model-training throughput.

## Attribution and limits

End-to-end elapsed time is the comparison endpoint. The candidate also counts snapshot hits, serialization and deserialization phases. `readCopyMilliseconds` includes initial snapshot serialization but excludes scope-exit serialization; `serializationMilliseconds` includes both. These timers overlap and must not be added. Candidate deserialization phase counters cover scoped copies, while copies outside the scope remain inside the aggregate native-copy timer.

A separate one-game phase probe, excluded from the paired medians, verified the same work and final state. Scoped deserialization consumed 21.36 of its 39.62 seconds, about 53.9%. Scoped serialization including the exit guards consumed 1.31 seconds. This is phase instrumentation, not a sampling CPU profile. Deserialization is the measured next target; the immutable-input change does not remove it.

The native snapshot contains hidden state and stays inside the trusted worker. Full player observation coverage is still incomplete, including Lost Zone, authorized reveals/pending cards and cumulative history. The optimization does not remove those gates. Exhaustive operation families, legality/card interactions and continuation-safe branching remain prerequisites for a broad native turn-search gauntlet.

Replay still compares UUID-normalized semantic state with the named `lastCheckedState` cache exclusion, including serialized history snapshots. It is not byte-identical native save-state or a proof of every Standard mechanic. The projection's separate byte-equality guard checks authority stability only within that read scope.
