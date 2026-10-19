# Native performance hill climb

This campaign measures complete fixed native games on one CPU worker. The working target is twice the frozen warm suite's starting throughput, with at least three candidate attempts or a documented correctness/cost limit. An improvement must preserve recorded commands, both players' observations, authority states and native seed requests. Full Standard coverage and competitive policy strength remain separate gates.

## Fixed work and measurement

The primary suite uses a short reversed-seat root-3141 game with 52 commands and a developed root-1729 game with 123 commands. Each repetition completes both games. A longer root-2718 game with 191 commands is an additional conformance workload. These are frozen regression traces from the same two exact private decks, not a sample of the full metagame.

The warm harness retains one process and pinned program bundle. Between naturally terminated games it replaces the entire worker object, including RNG, pending operations, offers, identity maps and projection scopes. It requires fresh epoch and match identities and refuses failed, stopped or unfinished games. No mutable per-match worker state is manually recycled. The native program caches remain shared; finite reset replay is required before using this execution path for a profile.

One complete warm-up game is retained in the receipt. Warm throughput excludes that game, process startup and terminal audit verification. Complete session time includes all three. Every timed game includes fresh seeded setup, all recorded commands, legal enumeration, compact player projections and natural termination. It excludes policy inference, preview requests, per-step persisted audits and optional presentation details. This is environment throughput under fixed decisions.

The receipt reports complete work counts, errors, truncations, game latency, reset latency, native command p50/p95/max, current-thread managed allocation and process GC collection deltas. Native command timings, allocation and GC deltas cover the batch and omit initial setup; game latency and copy counters include setup. Allocation is managed allocation on the executing thread, not retained heap or total process memory. Copy timers overlap and must not be added. End-to-end games/s is the endpoint.

## Reproduce locally

```sh
node scripts/benchmark-native-warm.mjs proof runs/config.json warm-proof-1 runs/cases.json
node scripts/benchmark-native-warm.mjs benchmark runs/config.json warm-run-1 runs/cases.json 5
```

The private case manifest has schema `native-warm-cases-v1` and two or three rows of `{id, journalPath}`. Paths resolve relative to the manifest. Journals must pin the exact executable, worker, private manifest, policy, copy mode, normalization version and both deck hashes. Output names must be new. Each game is bounded to 180 seconds and each session to 900 seconds. Keep one native process active and avoid concurrent builds/tests while timing.

The proof executes every case, then repeats the first after the intervening matches. It compares every authority frame, both actor hashes and the complete seed transcript. Extra cached reads and selection previews must leave authority and RNG unchanged. This tests the admitted traces across reset; it does not certify all possible native global state.

The [Release reset proof](native-warm-proof-v1.json) passed all 422 frames and 418 commands across short, developed, long and short again, with zero errors/truncations. Both deck orders and three root seeds are represented. These full-presentation proof times are diagnostic; they are not batch benchmark results. The foundation test suite passes 105 checks with no skips.

The paired comparison uses the same frozen timing endpoint, five fresh sessions per side, and alternating AB/BA order. Each session contains one complete warm-up and the two measured games. Both adapter builds must explicitly use Release; the already pinned native assemblies stay identical. New prepared builds default to Release. Historical Debug measurements are retained separately.

```sh
node scripts/compare-native-warm.mjs runs/baseline.json runs/candidate.json runs/baseline-cases.json warm-comparison-1 5
```

The endpoint is the ratio of the two side medians of total timed suite milliseconds. Aggregate games/s is 2,000 divided by that median, since a suite contains two games. Every completed session is saved before the next begins. The measurement phase is bounded to 900 seconds, in addition to a separate bounded candidate proof. Host load and shared OS caches are uncontrolled; sandbox process/load counters cannot see the complete desktop.

Ordinary replay never silently changes binary pins. A cross-build experiment may explicitly retarget only the worker hash and declared execution mode after preserving the original programs, decks, policy, seeds, commands and expected frames. Full journals, inputs, builds and raw diagnostics remain ignored and private.

## Decisions

The first accepted change caches immutable serialized input for one projection while deserializing a fresh graph for every legality test. Its separate cold-process comparison measured 26.9% higher throughput across five alternating pairs. [The experiment](native-copy-optimization.md) records that historical build configuration, raw measurements and correctness limits. Do not combine its number with warm results from a different workload.

Further candidates and measurements are recorded below as they complete. The local attempt ledger is `runs/native-hillclimb-v1/decision.tsv`.

### Release snapshot recheck

Five completed sessions per side measured **28.3% higher warm throughput** for immutable projection input. Both modes use the same Release adapter binary and the same native inputs. Each session completes one short warm-up followed by the fixed 52-command and 123-command games. The endpoint is the side median of the two measured game times added together.

| Mode | Median suite seconds | Range | Aggregate games/s |
|---|---:|---:|---:|
| Native copy | 78.74 | 76.94–87.43 | 0.02540 |
| Projection snapshot | 61.38 | 57.85–64.24 | 0.03258 |

All five completed pairs favor the snapshot mode. Every completed measured game preserves the terminal semantic hash and complete seed transcript, with zero errors/truncations. The candidate's pre-timing reset proof compares all 230 frames across short, developed and short again. The separate 422-frame proof also includes the longer game. [The safe receipt](native-warm-copy-comparison-v1.json) retains all complete sessions, phase timings, allocations and command latencies.

The original comparison reached its 900-second cap during the final candidate session. Its error diagnostic and nine complete sessions were preserved. Only that missing session was rerun with a fresh process, the same complete warm-up and measured workloads, using the exact harness archived from commit `611590f15945d8ccda42c40b14c0952ae4325843`. Recovery had a separate 180-second cap. The receipt reports one interrupted session explicitly; this is not a zero-interruption experiment. No completed session was discarded, and the incomplete session is excluded from the completed-session medians.

The native developed-game batch allocated about 22.90 GB over time; snapshot mode allocated about 18.26 GB. These are allocations, not resident memory. Copy calls remain 5,552 per developed game and 1,825 per short game. In the first snapshot session, scoped deserialization took 27.72 of 49.03 developed-game seconds. This is phase instrumentation inside a benchmark, not a separate sampling CPU profile. Avoiding unnecessary fresh graphs is the next hypothesis.

A missing session can be run independently with the same case manifest and `benchmark` command above using one repetition. Preserve previous output and explicitly record its pair/side when assembling the completed-session comparison. The generic comparator does not overwrite or automatically resume an interrupted directory. The exact private recovery script and failed block remain under `runs/` in this workspace.

### Pinned turn-rule preflight

Mode `projection-turn-v1` retains the immutable snapshot strategy and avoids a fresh validation graph when the admitted native IsTurn rules necessarily fail. Its three runtime/card/rule hashes must match the inspected closed profile. The guard preserves full validation for debug, unknown operation/profile/account, empty or unresolved origins, board origins, quit operations, inconsistent player flags and missing metadata. It resolves the actor and reads current metadata exactly as native validation does. It infers no general card-ownership rule.

The native rules admit the current actor, a board origin, or an actor still in setup. A known nonboard operation from a finished-setup off-turn actor therefore cannot pass. The empty-origin fallback matters because the native grouping containment condition can succeed vacuously for an empty grouping. Guards do not cache this decision across revisions or call native effect queries on canonical state.

Five alternating Release pairs measured **30.0% higher throughput** than snapshot mode on the same binary and fixed suite. Median suite time fell from 58.21 seconds (57.37–60.05) to 44.78 seconds (44.03–45.95), or 0.03436 to 0.04466 games/s. This is an incremental comparison within its own run block. Do not multiply it by an earlier block's ratio to claim a directly measured overall result. [All raw sessions and proof](native-warm-turn-comparison-v1.json) are retained. This comparison completed without errors, truncations or budget interruptions.

Before timing, all 230 frames, both actor hashes and seed transcripts matched across short, developed and short again. Its 3,812 preflight rejections all failed independent original native validation. Proof mode requires positive rejection coverage and exact verified/rejected equality. Timing refuses that extra verification work and requires verification counts to remain zero. The read-only `audit-preflight` RPC keeps changing counters outside the ordinary authority/RNG immutability audit.

The developed game still proposes 5,146 operations and executes the same 123 commands. Its fresh read copies fall from 5,552 to 3,132, exactly the 2,420 turn rejections. The short game's proposals remain 1,653 and copies fall from 1,825 to 1,129. These are avoided impossible validations, not fewer game transitions or reduced legal enumeration. In the first candidate session, developed-game managed batch allocation fell from about 18.26 to 13.98 GB. Its scoped deserialization took 14.29 of 34.08 game seconds. Process CPU time was 32.39 seconds for a 34.00-second batch, and process lifetime peak working set was about 199 MB. Those diagnostic scopes differ from end-to-end time and cumulative allocation.

The [additional conformance receipt](native-turn-extra-proof-v1.json) passes the 192-frame longer trace and the 124-frame developed trace with extra reads. Ten hidden-world probes pass, including eight opposing-hand/deck exchanges. Both settled Use audits and three small actual prompt domains match; three pending Use audits skip explicitly. The relevant 107-test suite passes. The general Standard, observation and continuation gates remain open regardless of these fixture results.

### Rejected scalar shortcut

Parsing the JSON once into a `JToken` tree, then deserializing fresh operations through `JTokenReader`, would remove repeated text parsing. The [original scalar gate](../experiments/token-reader-scalars.cs) rejects generic equivalence with the pinned Newtonsoft assembly. Default token parsing changes a declared ISO string into a formatted date string and rounds a high-precision typed decimal. Disabling date parsing preserves that string but changes the same object-valued scalar from `DateTime` to `String`. Native operation metadata contains object-valued fields.

The [safe exact result](token-reader-scalar-gate-v1.json) compares CLR types and values. It also records the additional-content behavior of `JsonConvert` versus a default `JsonSerializer`. No production token cache or speed claim was retained. A future contract-aware reader would need to preserve contextual scalar reads and fresh graph ownership before native replay or timing.
