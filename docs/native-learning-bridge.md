# Native learning bridge

The bridge generates fresh native games with the pinned heuristic. A small PyTorch model learns from human-seat ordinary actions and can evaluate from either seat. The heuristic handles setup, prompts, and the other player. This is a bounded learning smoke test for the private two-deck profile. It does not establish competitive strength or full Standard support.

## Prior art and bounded choice

[Gymnasium AsyncVectorEnv](https://gymnasium.farama.org/v1.2.3/api/vector/async_vector_env/) provides the useful process-per-environment pattern, explicit observation ownership, seeded resets and shutdown semantics. The existing native RPC already supplies those boundaries, so this bridge retains it instead of introducing another environment framework. Independent seed assignments remain fixed as the number of lanes changes.

[SEED RL](https://research.google/pubs/seed-rl-scalable-and-efficient-deep-rl-with-accelerated-central-inference/) separates CPU actors from centralized accelerated inference. This bridge borrows that ownership pattern with one local PyTorch process and a batched scoring API. It does not reproduce the paper's distributed system or measured performance. The rules and private reconstructed programs remain CPU work; rewriting them for GPU is outside this milestone.

[Huang and Ontanon's invalid-action masking study](https://arxiv.org/abs/2006.14171) motivates preserving the legal candidate mask. Here the mask gates a supervised imitation scorer; this is not the policy-gradient experiment studied in that paper. Whole-game heldout data and fresh policy-driven games separate fitting the teacher from actually running the resulting checkpoint.

The bounded choice is a 1,953-parameter candidate scorer, at most 10 optimizer updates and no new packages. A larger PPO stack would add rollout/value/return correctness work before proving this basic actor-visible data and checkpoint path. The user authorized imitation as the first training endpoint.

## Execution and ownership

`scripts/native-learning.mjs` owns the local commands. Each CPU lane is a separate Node process with one persistent native worker. Native static state is therefore isolated between lanes. A lane runs one match at a time. After a natural terminal result, `LocalWorker.nextMatch` creates a fresh match with new identities and a specified seed. Each match receives fresh `PolicyView` projectors and semantic normalization state.

`runAuditedEpisode` owns command acceptance, RNG verification, semantic frames, and hidden-world probes. Its optional trusted session retains only the worker between games. A timeout, invalid command, unsupported decision, privacy mismatch, or failed episode closes the worker. The scaling controller cancels through IPC and waits for lane exits. A parent disconnect also closes the lane's native worker.

`learning-features.mjs` owns the model boundary. The model receives numeric arrays derived from one actor's `PolicyView`. It receives no authority, native identifiers, seed transcript, RNG state, opponent hand identities, or teacher ranking. Policy code is trusted local code; this boundary is not a hostile-code sandbox.

## Numeric feature contract

The schema is `native-ordinary-features/1`. Each imitation record contains exactly `state`, `candidates`, and `label`. `label` is the accepted action's index in the original legal offer order. Teacher choice never sorts the candidate list.

`state` has 32 numbers in this order.

| Positions | Features |
| --- | --- |
| 0–1 | Current actor turn bit, turn number divided by 100. |
| 2–14 | Actor side features below. |
| 15–27 | Opponent side features below. |
| 28–30 | Actor hand counts for Pokémon, Trainer, and Energy, each divided by 60. |
| 31 | Public Stadium presence bit. |

Each side has 13 features. They are prizes/6, deck count/60, hand count/60, discard count/60, bench count/5, active presence, active HP/400, active damage/400, active energy/10, active retreat/5, bench HP sum/2000, bench damage sum/2000, and bench energy sum/50.

Each candidate has 27 numbers in this order.

| Positions | Features |
| --- | --- |
| 0–5 | One-hot action kind in `play`, `attack`, `ability`, `retreat`, `pass`, `concede` order. |
| 6–11 | One-hot source zone. |
| 12–17 | One-hot target zone. |
| 18–20 | Source HP/400, damage/400, energy/10. |
| 21–23 | Target HP/400, damage/400, energy/10. |
| 24–26 | One-hot source category in Pokémon, Trainer, Energy order. |

Zones are absent or other public zone, actor hand, actor active, actor bench, opponent active, and opponent bench. Public attachments inherit their host's zone. Unknown referenced cards fail encoding. No candidates are truncated. States with more than 512 legal actions fail explicitly. Distinct cards and attacks can have identical features. This intentionally weak first encoding cannot learn all card semantics.

Only `playing` states on the current actor's turn with no prompt become records or model decisions. Collection records belong to the human seat. Evaluation selects the model's seat separately for each game. The variable candidate list is the legal-action mask. The PyTorch scorer pads batches and masks padding before selection. The JS client checks that each response selects an integer index inside the current legal list.

## Collection and scaling commands

All commands require an existing private, pinned Release worker configuration. Generated programs, configs, full journals, records, and checkpoints remain in ignored `runs/` directories.

```powershell
node scripts/native-learning.mjs gate runs/local-audit-config-v12-turn.json native-learning-gate-v1
node scripts/native-learning.mjs scale runs/local-audit-config-v12-turn.json native-learning-scaling-v1
```

`gate` generates one fresh game at seed 90001. `scale` measures one four-game set at each of 1, 2, and 4 workers. Seeds are 90001 through 90004. Deck seats alternate together. Every lane first completes a separately reported warmup game at seed 80000. All lanes wait at a barrier before measured collection. One persistent worker serves the warmup and subsequent games in that lane.

The same main-game trajectory hashes, accepted commands, native seed counts, and feature-record hashes must match across worker counts. Completed receipts survive later failures. This single-set scaling smoke does not support a statistical claim about the best concurrency.

Game time includes fresh setup or reset, policy decisions, native commands, legal offers, actor projections, full per-frame RNG/authority checks, and privacy probes. Level time also includes private output writes and OS process samples. Measured level throughput excludes the separately reported warmup and initial process startup. Cold wall time retains those costs.

Each main game is capped at 400 commands and 180 seconds. A scaling level has a 20-minute cancellation cap. Hidden-world probes run at every nonterminal revision for both seats, including legal-view comparison and settled native Use enumeration checks. A game requires at least one real opponent-hand exchange. Actual rejected commands block training. These checks validate the collected trajectories, rather than certify every state reachable with these decks.

OS samples report native cumulative CPU time and process peak working set. Native CPU deltas cover successive games within the same process. Peak working set includes earlier games in that lane. Node CPU time is reported separately. These measurements describe the full audited generation path; compact fixed-command replay has different costs.

## Training and fresh evaluation

Use one copy of the human-seat records from the 1-worker level. Split by whole game. Seeds 90001 through 90003 are training games; seed 90004 is held out. Warmup data and repeated scaling copies do not enter training. The initial supervised imitation budget is at most 10 optimizer updates and 10 minutes. This objective does not use episode returns or implement PPO.

The local PyTorch service accepts JSON Lines. An inference request is `{id, op: "infer", state, candidates}`. A successful response contains the same `id`, `ok: true`, and `index`. `infer_batch` accepts an `items` array. A training request supplies labeled `records`, `updates`, and an absolute `.pt` checkpoint path under ignored `runs/`. The service validates the feature schema, finite gradients and parameters, changed weights, and exact checkpoint reload logits.

Default fresh evaluation uses seed 90005 with the checkpoint in the human seat, then seed 90006 with the checkpoint in the opponent seat. Deck order flips with the policy role, so the learner keeps pinned deck 0. The fixed heuristic handles the other seat and all prompts. Each game reports `ordinaryPolicySeat` and the number of accepted model decisions. Human record count is reported separately.

```powershell
node scripts/native-learning.mjs evaluate runs/local-audit-config-v12-turn.json native-learning-eval-v1 runs/private-model-config.json
node scripts/native-learning.mjs evaluate-opponent runs/local-audit-config-v12-turn.json native-learning-eval-opponent-v1 runs/private-model-config.json
```

`evaluate-opponent` runs exactly one fresh corrective game at seed 90007 with the model in the opponent seat and deck order `[1, 0]`. Earlier evaluation games remain intact. The private model config has `executable`, `checkpoint`, `seed`, and `device` fields. Both paths are absolute. The device is explicitly `cuda` or `cpu`. The client checks the loaded feature contract and reports inference time. Evaluation runs the same acceptance and privacy checks as collection. These fresh games are integration smoke tests, with no win-rate or ladder-strength claim.

## Executed milestone, October 20, 2026

All three worker levels completed the same four fresh heuristic games naturally. Every level accepted 607 commands, produced 185 ordinary-action records, and passed 1,214 hidden-world checks including 1,184 real opposing-hand exchanges. Full semantic trajectories, actor observations, record hashes and native seed transcripts matched across levels. There were no rejected commands, errors or truncations. Warmup games and repeated scaling copies were excluded from training.

| CPU workers | Measured four-game seconds | Games/s | Commands/s | Ordinary records/s |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 395.48 | 0.01011 | 1.535 | 0.468 |
| 2 | 297.97 | 0.01342 | 2.037 | 0.621 |
| 4 | 160.67 | 0.02490 | 3.778 | 1.151 |

These are one-set descriptive scaling observations on a shared Ryzen 7 5800X desktop, not a statistically established concurrency winner. Cold level wall times, including full warmups, were 488.53, 438.72 and 286.39 seconds. A small encoder arithmetic/allocation refactor landed between first and later lane imports before the freeze acknowledgement: integer Energy times 40 divided by 400 became integer Energy divided by 10. Observed feature hashes are identical, and native work, seeds, policies, privacy cadence and resets did not change. This harness drift prevents a clean causal speedup claim. Completed receipts and precise provenance remain private; the safe milestone receipt retains aggregate diagnostics. One-worker native peak working set reached about 1.20 GB. This audited collection path costs more than compact fixed-command replay.

One 1,953-parameter model then completed **10 CUDA Adam updates on 125 records** from seeds 90001-90003. Gradients, losses and parameters stayed finite; total absolute weight change was 39.8426. The checkpoint reloaded with exactly matching logits. Update-loop wall time was 0.667 seconds, CUDA event span 653.4 ms, and peak PyTorch allocated memory about 70.16 MB. Python/Torch import took another 9.30 seconds and model startup 0.44 seconds. The CUDA event span includes launch gaps; it is not GPU kernel utilization. Full GPU context/reserved memory and unrelated desktop use are outside the tensor-allocation counter.

Training teacher agreement was 47.2%. The entire held-out seed-90004 game supplied 60 decisions with 40.0% teacher agreement, finite loss 1.7497 and all predictions inside legal masks. These figures measure imitation fit, not wins or improvement over the teacher. The feature encoding aliases many distinct cards and actions, and the model still depends on the fixed prompt helper.

The existing Torch 2.5.1+cu121 runtime and RTX 3080 were reused without installation. A separate warmed inference-only check used 32 alternating CPU/CUDA calls per device and batch. Median CPU/CUDA times were 0.234/0.914 ms for one item with two candidates, and 0.348/1.293 ms for four items with candidate counts 2, 2, 1 and 2. It included padding, transfers, checks and readback, but excluded IPC and startup. That tiny workload shows no CUDA inference advantage. The actual training batch stayed on CUDA; native rules stayed on CPU.

The saved checkpoint then completed three fresh games against the fixed heuristic with 425 accepted commands and 111 model decisions. All terminated naturally with zero rejections, errors or truncations; 850 hidden-world checks passed. The first two games had inadvertently swapped decks while leaving the model in the human slot. Those receipts remain unchanged. A third fresh game corrected the policy-role coverage, and the default evaluator now alternates actual policy seats while keeping learner deck 0.

| Seed | Model slot | Model deck | Accepted model decisions | Result for model |
| ---: | --- | ---: | ---: | --- |
| 90005 | human | 0 | 40 | win |
| 90006 | human | 1 | 26 | loss |
| 90007 | opponent | 0 | 45 | loss |

Seeds 90005 and 90007 supply the role-balanced integration pair; 90006 is retained additional evidence. These three games cannot establish win rate or strength. Prompts and setup used the fixed helper throughout. The checkpoint SHA-256 is `1c405966d9539aca89fdf49413663f327859ece6c74c96b12e4453490062fe43`; its weights and all detailed records remain ignored and private. The [safe milestone receipt](native-learning-milestone-v1.json) contains measured scaling, training, heldout and fresh-game results. Final checks pass 121 Node tests and four learner tests; the full-Standard admission gate deliberately exits 2.
