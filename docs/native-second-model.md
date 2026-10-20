# Second bounded imitation model

Model two completed 200 supervised updates on 673 fresh teacher decisions from 18 complete games. Six separate whole games supplied 218 validation decisions. The best trained checkpoint was update 200; training stopped at the preregistered update limit, rather than triggering validation patience. This is still a small imitation model for the private two-deck profile, not a competitive agent or full Standard implementation.

The [fixed plan](../learning/model-two-plan.json) was committed before collection. Training seeds are 91001-91018 and validation seeds are 91019-91024. No model-one examples, repeated scaling games, warmups or replacement seeds entered the dataset. All 24 attempts terminated naturally, with zero rejected commands, exclusions, cancellations or fatal errors.

Collection took **690.36 seconds** on four persistent CPU lanes and accepted 3,133 commands. All 6,266 hidden-world checks passed, including 6,022 real opposing-hand exchanges. Native-input pins and all nine generation source hashes matched the archived exact bytes. The largest observed native-worker lifetime peak working set was about 1.10 GB; this excludes Node and the rest of the desktop. These are diagnostics from one collection run, not a causal scaling benchmark.

The model uses the same 1,953 parameters and actor-visible 32/27 feature contract as model one, with fresh initialization seed 1729. Adam used minibatches of 64, learning rate 0.003, and seeded shuffling without replacement. It processed 12,242 examples across 18 complete epochs and part of a nineteenth. Validation checks ran every ten updates. The update loop, including periodic validation and checkpoint writes, took **1.038 seconds** on the existing RTX 3080 / Torch 2.5.1+cu121 runtime. CUDA event span was 1,038.2 ms and peak PyTorch allocated memory was 72.32 MB. The event span includes launch gaps and does not measure kernel utilization. Import, initial upload and final checks are outside the update-loop timer.

Gradients, losses and parameters stayed finite. Absolute weight change from initialization was 202.0692, and the selected checkpoint reloaded with exactly matching logits. Model one's checkpoint and its preserved result/config files retained their original hashes.

## Agreement on the same validation games

Both saved checkpoints were scored on CPU against the same 218 validation decisions. Every prediction stayed inside its legal candidate mask.

| Checkpoint | Teacher agreement | Cross-entropy loss |
| --- | ---: | ---: |
| Model one | 38.07% | 1.7681 |
| Model two | 49.08% | 1.3359 |

Model two was selected using this validation set. This comparison measures imitation fit and is optimistic as an estimate of generalization. It is not an untouched test or evidence of stronger play. Many distinct cards and actions share identical features; setup and prompts still use the fixed helper.

## Local checkpoint and handoff

The selected weights remain private at `runs/native-learning-training-v2/best-model.pt`, with runtime configuration in `runs/native-learning-training-v2/model-config.json`. SHA-256 is `144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b`. `NativeModelClient` loads this configuration using the existing inference interface. A completed `receipt.json` and `model-config.json` identify the ready checkpoint. No further updates are running.

Final seeds 92001 and 92002, each in both policy slots with learner deck 0, were unused by collection, training and checkpoint selection. Both frozen checkpoints will face the same pinned heuristic on these cases in a separate native evaluation run. This training receipt was published before those outcomes. UI and video-evaluator branches remain separate.

For the current local UI loader, `runs/native-learning-training-v2/ui-receipt.json` supplies the model-one-compatible `runtime`, `training` and `heldout` fields without changing the complete training receipt. It explicitly records both training decks: nine human-seat games per deck, with 302 and 371 labels. Each deck has three validation games, with 91 and 127 labels. The native programs and deck hashes are unchanged. The checkpoint uses the same legal-candidate inference interface and fixed setup/prompt helper.

The [safe result receipt](native-second-model-v1.json) retains collection counts, source/native pins, training history, timing scopes, checkpoint hashes and the same-set validation comparison. Full journals, numeric examples, private programs, configs and weights remain local and ignored. Source checks passed 125 Node tests and nine second-trainer CPU tests before execution. The full Standard admission gate remains closed.

To reproduce with locally authorized private inputs, choose fresh output names:

```powershell
node scripts/native-collect.mjs runs/local-audit-config-v12-turn.json <new-collection>
python learning/train_second.py runs/<new-collection> runs/<new-model>
```

The collector caps 24 attempts at 30 minutes. The trainer defaults to 200 updates, accepts at most 1,000, and stops starting updates after at most 120 seconds. Validation patience and output-path protections are described in [the learner instructions](../learning/README.md).
