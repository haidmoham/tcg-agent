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

For a cumulative result, compare the native control, previous accepted mode and one candidate in the same run block. The three-mode tool requires one Release binary and identical private execution pins. Version 2 uses five fresh sessions per mode with every pair ordered 3:2 or 2:3 and every execution position represented once or twice per mode. The same five candidate sessions supply both the incremental and native-control comparisons. Do not multiply ratios from earlier blocks.

```sh
node scripts/compare-native-modes.mjs runs/native.json runs/previous.json runs/candidate.json runs/native-cases.json three-mode-comparison-1
```

The measurement schedule has two blocks, capped at 900 seconds each, after a separately bounded candidate proof. Every session has a 180-second cap and saves its completed receipt before the next starts. A failed or interrupted block remains available for diagnosis. Recovery must preserve all completed measurements and identify any separately rerun missing session. Historical version 1 rotated three permutations but ordered the previous mode before the candidate in four of five sets. Its incremental comparison can favor the candidate under downward drift and needs a separately balanced confirmation before acceptance. Its native-versus-previous control was ordered 3:2; all raw orders remain explicit in receipts. The earlier two-mode comparator already alternates AB/BA.

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

### Reverted attack-origin candidate and direct control

The next candidate rejected attacks from hand or bench origins only under the exact closed profile, trusted attack offer kind, current actor and active projection scope. It preserved active origins and their attachments. All 602 extra rejections in the primary proof failed original native validation. The same 230 authority frames, both actor observations and seeds matched. The 115-test suite passed before measurement.

Five sessions per mode completed on one Release binary in rotating native, accepted-turn and candidate order. The attack candidate's median suite time was 38.70 seconds (37.29-58.65), compared with 39.70 seconds (36.33-46.11) for accepted turn mode. The apparent 2.6% throughput difference is smaller than the observed variation, with two slower paired candidates. The verdict is **inconclusive**. The candidate was reverted, its exact tested source and binary retained privately, and every completed receipt preserved. Long-game and privacy audits were not run for this rejected candidate. [The safe full receipt](native-warm-attack-comparison-v1.json) records the verdict explicitly.

The same block provides a provisional direct comparison for the accepted implementation. Native mode took a median 67.63 seconds (62.58-72.63), or 0.02957 games/s. Accepted snapshot plus turn mode took 39.70 seconds, or 0.05038 games/s. The apparent **70.4% higher warm throughput is provisional**, from five sessions per mode on identical work and the same binary. The native-versus-turn order was 3:2, while the incremental order was 4:1. Substantial host drift still limits attribution, so an alternating direct confirmation is required before presenting a firm cumulative gain. This ratio is not a product of earlier results. All completed games preserve terminal states and seed transcripts with zero errors or truncations. No session in this block was interrupted.

The working 2x target remains unmet. During the developed game, the accepted turn path still makes 3,132 read copies. The rejected candidate reduced that to 2,718 and managed allocation from about 13.98 to 13.23 GB, but those component savings did not establish an end-to-end speed win. One candidate developed batch took 34.98 CPU seconds over 48.30 wall seconds. That CPU-to-wall gap limits attribution on this shared desktop, whose complete host load is unavailable. Allocation is cumulative and process CPU time is diagnostic. The fixed endpoint remains wall-clock games/s.

### Reverted hand-Ability candidate

A separate turn-plus-hand-Ability mode rejected only owned, unparented Pokemon abilities in the actor's actual hand, under the exact profile and active projection scope. Both native position fields and both base/effective card formats had to match. Unknown cases fell through. Native availability necessarily rejects these out-of-play abilities in the inspected profile. All 97 additional rejections passed the native false oracle across the 230-frame primary proof. The developed game avoided 45 read copies and the short game 26. The candidate passed 115 tests before timing.

All fifteen three-mode sessions completed with zero errors/truncations and no interrupted session. Candidate median suite time was 29.61 seconds (28.47-34.43), compared with 29.03 seconds (28.89-35.12) for turn mode. The apparent 2.0% slowdown is inconclusive under overlapping variation, drift and the version 1 order imbalance. No firm regression or speed gain is claimed. The candidate was fully reverted; exact tested adapter source, private binary and all completed sessions remain local. Long-game and privacy audits were not run for this rejected mode. [The safe receipt](native-warm-hand-ability-comparison-v1.json) retains the complete record.

The ordering defect is repaired in version 2, with a test requiring balance for every pair and execution position. The restored accepted implementation and revised tool pass 114 tests. A separate alternating native-versus-turn comparison will determine the cumulative result. No additional candidate is mixed into that confirmation.

## Next material copy experiment

Fresh validation graphs remain the measured bottleneck. In the direct-control block, accepted turn mode's developed game took a median 30.69 seconds, including 13.89 seconds creating read copies. Scoped deserialization accounted for 12.85 seconds. Those phase medians come from the same five sessions and overlap; they must not be added. A small additional filter cannot remove most of this cost.

Source inspection rules out a constructor swap or partial reset as a cheap substitute. `MatchOperation.SetPlayerOperation` and `CanPerformOperation` clear queues without restoring all state. Validation changes top-level turn flags, effect dictionaries, retained passive-effect lists and cached effect values. Some of that state is serialized. Clearing effect dictionaries does not restore the retained lists. Fresh wrappers that share a board therefore do not isolate proposals. Native operation constructors also change indices, identities, timers and continuation state instead of reproducing the existing read-copy contract.

The native copy is a JSON round trip. It creates constructor-bound validators and queuers, applies defaults, converters and a type binder, excludes some caches and preserves other retained state. A generic recursive object clone would preserve fields or aliases that native serialization deliberately drops or transforms. Removing selections, queues, variables or modifications is also unproved because native conditionals and continuation code read them.

The next substantial candidate is a contract-aware immutable copy representation that creates a fresh native graph for every proposal. A lexical reader would need exact scalar lexemes and contextual typed conversion, avoiding the rejected generic token semantics. A generated copier would need equivalent defaults, converters, binder behavior, constructor bindings and ignored-field reset. Neither has a measured speedup. Before timing, inventory reachable types, test scalar and alias behavior, compare each proposal against native fresh copying under varied proposal orders, then run complete replay, long-game and hidden-information gates. This is a larger isolation project, not a safe small substitution within this bounded milestone.
