# Native performance hill climb

This campaign measures complete fixed native games on one CPU worker. The working target is twice the frozen warm suite's starting throughput, with at least three candidate attempts or a documented correctness/cost limit. An improvement must preserve recorded commands, both players' observations, authority states and native seed requests. Full Standard coverage and competitive policy strength remain separate gates.

## Fixed work and measurement

The primary suite uses a short reversed-seat root-3141 game with 52 commands and a developed root-1729 game with 123 commands. Each repetition completes both games. A longer root-2718 game with 191 commands is an additional conformance workload. These are frozen regression traces from the same two exact private decks, not a sample of the full metagame.

The warm harness retains one process and pinned program bundle. Between naturally terminated games it replaces the entire worker object, including RNG, pending operations, offers, identity maps and projection scopes. It requires fresh epoch and match identities and refuses failed, stopped or unfinished games. No mutable per-match worker state is manually recycled. The native program caches remain shared; finite reset replay is required before using this execution path for a profile.

One complete warm-up game is retained in the receipt. Warm throughput excludes that game, process startup and terminal audit verification. Complete session time includes all three. Every timed game includes fresh seeded setup, all recorded commands, legal enumeration, compact player projections and natural termination. It excludes policy inference, preview requests, per-step persisted audits and optional presentation details. This is environment throughput under fixed decisions.

The receipt reports complete work counts, errors, truncations, game latency, reset latency, native command p50/p95/max, current-thread managed allocation and process GC collection deltas. Native command timings omit initial setup; game latency includes it. Allocation is managed allocation on the executing thread, not retained heap or total process memory. Copy timers overlap and must not be added. End-to-end games/s is the endpoint.

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

### Rejected scalar shortcut

Parsing the JSON once into a `JToken` tree, then deserializing fresh operations through `JTokenReader`, would remove repeated text parsing. The [original scalar gate](../experiments/token-reader-scalars.cs) rejects generic equivalence with the pinned Newtonsoft assembly. Default token parsing changes a declared ISO string into a formatted date string and rounds a high-precision typed decimal. Disabling date parsing preserves that string but changes the same object-valued scalar from `DateTime` to `String`. Native operation metadata contains object-valued fields.

The [safe exact result](token-reader-scalar-gate-v1.json) compares CLR types and values. It also records the additional-content behavior of `JsonConvert` versus a default `JsonSerializer`. No production token cache or speed claim was retained. A future contract-aware reader would need to preserve contextual scalar reads and fresh graph ownership before native replay or timing.
