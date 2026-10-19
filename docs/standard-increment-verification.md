# Standard reuse increment verification

Verified on the Windows desktop on October 19, 2026, using Node 24.18.0. The reference kernel is still `0.1.0`; the project tooling is `0.2.0`. Original implementation and public metadata are published; source caches and local run files remain ignored.

## Commands and observed results

| Command | Result |
|---|---|
| `npm.cmd run engine:prepare` | Pinned public Twinleaf and exact tooling prepared; repeated preparation succeeded. |
| `npm.cmd run engine:smoke` | Seven modern printed-card assertions passed. |
| `npm.cmd test` | 57 passed, zero failed, zero skipped, including the local reuse addition. |
| `npm.cmd run eval:suite` | 240 historical-profile games, zero errors or truncations; weighted score 0.6625. |
| `node scripts/ladder-records.mjs examples/ladder-records.example.jsonl` | Three synthetic records accepted; zero actual matches. |
| `npm.cmd run coverage:require-full` | Exit 2, explicitly incomplete. |
| `npm.cmd run bench -- --games 500 --repeats 5 --output runs/benchmark-workstream-v2.json` | Five repeats per mode; work counts agree across every repeat. |

The independent review reran 33 focused tests, including external-engine conformance, with no blocking findings. The final full suite includes the remaining reference-kernel contracts. The optional engine case skips on an unprepared machine; it did not skip here.

The compact [evaluation receipt](evaluation-suite-v2-receipt.json) retains suite and source SHA-256 hashes. Its paired-seed intervals describe seed variation within each fixed matchup/opponent cell. They do not measure deck-population, metagame or rule-coverage uncertainty. The tactical scorer's mirror score against greedy is 0.475 and its score against greedy with a Machop-heavy opponent deck is 0.325. These negative comparisons remain in the receipt.

## Bounded CPU remeasurement

This uses the same developed-board three-card workload described in [the original benchmark](benchmark.md), with seeds 1–500 rather than 1–1000. One JavaScript game worker runs on the Ryzen 7 5800X desktop. Every repeat consumes 58,457 actions and 34,745 turns, ends 291 games through Prizes and 209 through no Pokémon, and yields checksum 1,098,270. Errors and truncations are zero.

| Mode | Median games/s | Minimum | Maximum | Completed games |
|---|---:|---:|---:|---:|
| No event/action recording | 2,737 | 2,509 | 3,257 | 2,500 |
| Replay recording | 2,706 | 2,672 | 3,097 | 2,500 |

[Raw measurements](benchmark-workstream-v2.json) preserve exact wall/CPU times, host facts and work counts. Host load was not controlled. These short runs have scheduling/JIT variation and are not a speed comparison with the earlier run. No public Twinleaf or Standard throughput was measured. The full safe evaluation runner has additional copying/history work and is not this timed benchmark.

## Source pins and proof limits

- Public Twinleaf: `d89efe580127a05aff8b0456fd2ad587edbbee2d`.
- TCGdex catalog: `cbddf7e54033b1b58e44af1049c88832e55b94d0`.
- PTCG-Bench inspected prior art: `bc2fdde7dfbe70f824e84dca8e65a1a206ade359`.
- Python ptcg-engine inspected alternative: `92c3cc4fe85a26f102d7bb6b3e8be7678512d2e5`.

The standalone tutorial's new oracle chapter was inspected in Chrome through the loopback preview. Its desktop viewport had no horizontal overflow and no captured console errors. Earlier interactive lessons remain unchanged.

Full Standard is incomplete. The reference kernel has zero verified Standard printings. Seven constructed public-engine assertions do not certify complete games, seeded upstream execution, prompts, every card, or every interaction. [The remaining gates](full-standard.md) include the full legality denominator, per-game RNG/chance replay, a serializable decision protocol, detached player histories, per-card admission, whole-game conformance and an actual Standard benchmark. There is no Live session, trained agent, observed rating or competitive-strength claim in this release.

## Local reuse follow-up

The existing Indigo Live worker built with .NET 8.0.425 and zero warnings/errors into ignored task output. An original opt-in [headless process probe](../integrations/local-worker/README.md) verified all eight external private bundle files, executable/worker/dependency pins and the existing local strategy module. One natural modern-deck game completed with 82 accepted commands, 30 previews, zero rejections and final revision 82 in 25,560 ms. It used no authored board or winner. Native randomness was not controlled. The compact pinned receipt remains local; this elapsed time is not a throughput estimate.

The eight new synthetic tests check transport and input integrity independently of that real game. Independent review caught a valid-JSON-null reply crashing the callback; object validation and a regression test fixed it. The final complete suite passes 57 tests, zero failures/skips. Local card/program coverage and original worker evidence change the primary extension path, while all full Standard admission gates remain open. No private raw data or recovered code is redistributed.

## Seeded native follow-up

The latest full `npm.cmd test` run passes **88 tests**, zero failures or skips, including the prepared public engine's seven assertions. The native integration additionally executed actual private-input checks, separate from those synthetic tests.

| Check | Observed result |
|---|---|
| Seeded natural record, root 1729 | 123 accepted commands, 44 previews, 63 native seed calls, zero rejections. |
| Fresh-process replay with extra seat reads | All 124 semantic authority frames, both actor DTOs and every seed request match. |
| Swapped-seat replay, root 3141 | All 53 frames and 33 seed requests match across 52 commands. |
| Hidden-world probes | Ten equal actor DTOs, including eight opposing-hand/deck exchanges. |
| Native decision audits | Two settled Use comparisons have no missing/extra tuple; three pending-decision probes skipped explicitly. Three small nonallocation domains exhausted. |
| Native adversarial verification | Independent interleaved streams/reset, positive replay control and five corrupted replay rejections pass. An already-corrupt input fails without a success receipt. |
| Headless fixed-trace benchmark | Three complete cold-process games; median 0.0201 games/s, range 0.01995-0.02277; zero errors/truncations. |
| Frozen paired-deck gauntlet | Four natural games, 521 commands, 207 previews, zero errors/truncations/rejections. Dragapult fixture score 0.75, paired-seed interval [0.5, 1]. |
| Direct coverage CLI | Child exit code 2, full Standard admission remains incomplete. |
| Original Indigo checkout | Read-only Git status remains clean. |

[The runtime contract](native-runtime.md), [safe replay proof](native-replay-proof-v1.json), [raw benchmark receipt](native-benchmark-v1.json), [frozen manifest](../experiments/native-gauntlet-v1.json) and [gauntlet receipt](native-gauntlet-v1-receipt.json) retain exact scope and provenance. The native semantic comparison normalizes runtime identities and excludes the named `lastCheckedState` cache, including serialized history snapshots. It is not a byte-identical native save-state claim.

The native timer measures real transition, legal-action and compact-projection work with a fresh process per game. It excludes previews, actor inference, persisted per-step audits, optional presentation details and final verification. Instrumented native read copies consumed 66.4-67.3% of elapsed time. No speedup, optimized-build or Standard-general throughput claim follows. Gauntlet games are separately audited policy runs and are not the benchmark.

Independent reviews exercised focused JS tests and found swapped-seat admission and existing-output preservation defects; both were fixed and checked. Comments defining external ownership/selection constraints were retained. Original private sources and programs remain unchanged and external. The tutorial text was updated and its inline script syntax checked. No browser was opened during this follow-up, preserving the other desktop task's session.

Remaining gates include the dated legal denominator, per-card/mechanics interactions, all operation families, public Lost Zone and authorized reveal/history projection, and a continuation/RNG-safe branch mechanism before native search. No native search, learned policy, sustained training or Live interaction occurred.
