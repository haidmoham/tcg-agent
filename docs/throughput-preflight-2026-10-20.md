# Guarded cohort turn preflight

The six-deck cohort card-data hash was absent from the existing conservative offline turn preflight. Consequently, out-of-turn action proposals paid for detached native operation copies before returning false. Admit only that exact card hash, retaining the existing runtime, rules, board-mode, setup, origin and operation guards. Policy code, candidate enumeration/order, observations, rewards, sampling and PPO remain unchanged.

## Measurement

2026-10-20, Windows, Ryzen 7 5800X (8 physical/16 logical cores), RTX 3080. Five interleaved pairs of full production collection calls, one lane, retained Hydrapple/Alakazam game seed 220221, frozen PPO checkpoint `cohort-update-005.pt`, unchanged plan seed 81729 (per-game categorical seed `220221 XOR 81729 = 156540`), CPU inference. Each completed naturally with 144 commands and 40 learned transitions, zero errors/rejections. Timing includes model startup, actual inference, encoding, native requests, previews, audits, journals and receipt writes. Live training and desktop load continued, uncontrolled, throughout both sides. Pair order alternated AB/BA.

| Pair | Baseline seconds | Candidate seconds |
| --- | ---: | ---: |
| 1 | 84.140 | 71.772 |
| 2 | 93.869 | 75.219 |
| 3 | 88.272 | 71.593 |
| 4 | 87.862 | 74.714 |
| 5 | 84.957 | 74.302 |
| Median | 87.862 | 74.302 |

Verdict: faster on this workload, **1.1825x throughput (+18.25%, 15.43% less time)**. Baseline range 84.140–93.869 s; candidate range 71.593–75.219 s. This is not a measured whole-campaign or mixed-deck throughput ratio.

Every run had exactly equal saved PPO records after removing only the run-specific episode ID: actual behavior log probabilities, critic values, legal masks, complete candidates/order, rewards, policy versions and episode flags. All actor-frame hashes, commands and RNG transcripts also matched exactly.

## Wider equivalence

Six retained training traces replayed through the production episode runner. Original native legality was invoked for every shortcut rejection in proof mode. All frames, accepted commands, RNG transcripts and terminal state hashes matched retained originals; zero errors/rejections. Oracle mode is excluded from the speed measurement.

| Learner | Retained seed | Commands | Native-verified shortcut rejections |
| --- | ---: | ---: | ---: |
| Alakazam | 220201 | 179 | 4,407 |
| Hammerpult | 220205 | 63 | 1,200 |
| Basic Box | 220210 | 185 | 4,360 |
| Seaking | 220213 | 119 | 2,681 |
| Dhelmise | 220217 | 107 | 1,664 |
| Hydrapple | 220221 | 144 | 2,762 |
| Total | | 797 | 17,074 |

There were 803 exact actor frames. This qualifies retained states for the exact guarded data/runtime/rules; it does not establish arbitrary-card correctness. Release compilation of the patch succeeded with zero warnings/errors. No unit-test suite or framework was added.

## Attribution and remaining cost

The live owner's 15.625-second sample attributed 7.124 CPU-core equivalents to .NET collectors, 0.092 to Python and 0.130 to Node. Intra-op math threads were already set to one. Inter-op configuration was not separately introspected. In the first repeated baseline, 40 PPO act calls consumed 0.438 s, while 144 native command requests consumed 63.721 s; these are request wall times, including IPC, rather than pure engine CPU. Native startup/reset was below 0.5% of summed episode-wrapper time in the owner's existing receipts. GPU batching, more actors and startup changes were therefore deferred, not claimed slower based on an unrun comparison.

One separate candidate native-only retained batch took 50.734 s and 48.078 CPU seconds. Counters recorded 3,590 read copies taking 22.415 s, including 3,509 deserializations taking 20.480 s; 580 serializations took 2.141 s. Cumulative current-thread managed allocation was 17.340 GB, with 278 MB peak working set. Counters include create overhead. This compact batch excludes policy inference, previews, per-step IPC/audits and optional presentation; terminal state and seeds were exact. It identifies remaining copies/allocations as a concrete next profiling target, not a second speedup claim. Rust work remains deferred.

## Evidence and application boundary

Local raw evidence, all diagnostic rollouts, source snapshots and one-off scripts remain under `runs/throughput-hillclimb/`: `repeat-results.json`, `repeat-summary.json`, `six-deck-proof.json`, `native-profile.json`, `release-build.log`, `deliverable-pins.json` and `application-config-pins.json`.

The exact tested worker SHA256 is `d471d0a1d7c05d23f34c555499ea21f299e306e19a8c3536222bae0af34c25c4`. `tested-bin/` is a verified byte-for-byte copy of it and its dependencies; `tested-source/` preserves its pinned sources. `release-bin/` is an independent build of the same guard change with different source formatting/build identity; deployment guidance uses the already-tested `tested-bin/` artifact.

Six prepared native configurations and `application-pair-manifest.json` change only worker/source paths and their hashes. Their deck bundles, manifests, deck order and all other configuration fields are preserved and verified. No running source, campaign, checkpoint, rollout or process was changed or stopped. Only the separate live-training owner may perform a checkpoint-boundary continuation, preserve the seed/deck schedule and update the existing freeze pointer. This is qualified for the cohort worker; the fixed arms' different worker is not covered by this binary.

If the observed 18.25% collection gain transfers to the mixed cohort, its observed 7.9% fit fraction implies about 1.166x campaign throughput. A two-minute interruption then repays in about fourteen minutes from the switch. This is a conditional payback estimate, not a production measurement or a strength claim.

Source publication integrates only the authored delta from
`8943ca117fa2e7facdafa5d20475adcd9dd0b108`. Integration reviewed the source and
existing receipts, including all six exact-match traces and ten timing runs;
it ran no tests, builds or new benchmarks and changed no active runtime or client.
Private binaries, card programs, weights, raw logs and local configurations remain
external. Publication alone does not establish operational adoption.
