# Frozen checkpoint native evaluation

Both saved imitation checkpoints faced the same pinned heuristic on two preregistered seeds, each with the model in both actual policy slots. Learner deck 0 stayed fixed when seats swapped. Checkpoints were selected before seeds 92001 and 92002 were used; final outcomes did not change either model.

| Seed | Model policy slot | Model one | Model two |
| --- | --- | --- | --- |
| 92001 | human | Incomplete | Win |
| 92001 | opponent | Win | Incomplete |
| 92002 | human | Win | Loss |
| 92002 | opponent | Win | Win |

| Checkpoint | Natural completions | Wins | Losses | Wall timeouts | Fatal errors | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Model one | 3 | 3 | 0 | 1 | 0 | 0 |
| Model two | 3 | 2 | 1 | 1 | 0 | 0 |

Incomplete cases reached the preregistered 180-second per-game wall limit. Their partial traces and inference counts remain in private receipts. They are neither losses nor draws, and no replacement seeds or budget extensions were used. These limits censor the comparison. Four cases per checkpoint against one teacher do not establish stronger play, a ladder rating or full Standard correctness.

## What was held fixed

The [plan](../learning/model-two-plan.json) fixes seeds, roles, learner deck, 400-command game cap and 180-second wall cap. Each checkpoint run has a 13-minute outer limit, one retained native CPU worker and one CPU scorer. The two runs were launched concurrently on the same desktop; their wall times are diagnostics, not a throughput comparison. Setup, prompts and the other ordinary-action seat use the same pinned helper/heuristic.

The evaluator at source commit `47883f1` copies each selected checkpoint into its fresh private run directory. Original and copied checkpoint hashes, exact archived evaluation sources and native input pins were verified. CPU preflight confirmed 1,953 finite parameters. For every naturally completed game, accepted model decisions exactly matched its inference-request delta, rejected commands were zero, and per-command hidden-world checks included real opposing-hand exchanges. Journals, record hashes and case-receipt hashes were checked after execution. Fresh-process replay was not rerun for these new trajectories.

The six natural completions contain 961 accepted commands and 274 model decisions. All 1,922 hidden-world checks passed, including 1,819 real opposing-hand exchanges. These counts exclude the incomplete games; their partial activity remains separately recorded.

Model one's six preserved checkpoint/config/result files retained their original hashes. Model two's checkpoint, complete training receipt and separate UI compatibility receipt also remained unchanged. The [safe machine-readable result](native-final-checkpoints-v1.json) records all attempted outcomes, capacity limits, source/native pins and integrity checks. Raw journals, numeric examples, native programs, weights and machine-specific paths remain local and ignored.

## Interpretation and next work

The [shared validation comparison](native-second-model.md) found 38.07% teacher agreement for model one and 49.08% for model two on the same 218 decisions. Model two was selected on that set; it measures imitation fit rather than untouched playing strength. Final native outcomes above are a separate check, with incomplete cases explicitly retained.

The current 32/27 feature contract aliases many distinct cards and actions, and setup/prompt choices still belong to the helper. Improve card/effect representation and audit broader mechanics before treating more supervised updates as evidence of strategic progress. A future complete-game comparison needs a newly fixed capacity budget and evaluation plan; this result must remain intact. The full Standard admission gate remains closed. No TCG Live automation ran.

## Reproduce with authorized private inputs

All 129 Node tests passed before these jobs, including fixed-plan, outcome, capacity/fatal classification and CPU-startup failure checks. All frozen evaluation source files retained their hashes throughout.

Create separate model configs with the existing Python executable, the respective saved checkpoint, seed 1729 and `device: "cpu"`. Keep original training configurations intact, then use fresh output names:

```powershell
node scripts/native-final-evaluation.mjs runs/local-audit-config-v12-turn.json <fresh-model-one-run> <private-model-one-cpu-config.json>
node scripts/native-final-evaluation.mjs runs/local-audit-config-v12-turn.json <fresh-model-two-run> <private-model-two-cpu-config.json>
```

The CLI refuses existing run directories and never replaces a timed-out case. It writes a fatal receipt and stops remaining cases for correctness or provenance failures.
