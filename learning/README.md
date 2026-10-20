# native candidate learner

`native_torch.py` owns one tiny PyTorch model and its CUDA context. Native environments remain separate CPU processes. The first training objective is supervised imitation of the frozen actor-visible heuristic on ordinary legal actions. Prompt decisions still use the validated heuristic. This is a pipeline smoke test, with no reinforcement learning or strength claim.

The input contract is `native-ordinary-features/1`. Each decision contains `state` with 32 finite numbers and `candidates` with one 27-number row per legal action, in the original action order. A training record also contains `label`, an index into that list. The JavaScript encoder owns the feature definitions and maps the returned index back to the current offered action. The model receives no authority state, seed, hidden cards, or raw native identifiers.

The scorer concatenates state features with each candidate, applies a 32-unit tanh layer, and produces one score per candidate. It has 1,953 parameters. A batch pads candidate rows and masks padding with negative infinity. The service rejects an empty list, an invalid label, a nonfinite feature, or an excessive padded allocation. It never truncates the legal list.

Run a previously installed CUDA-capable Python environment with `python learning/native_torch.py --device cuda --seed 1729`. No package installation occurs. The process accepts newline-delimited JSON requests and writes one JSON response per request. Responses repeat `id` and contain `ok`.

```json
{"id":1,"op":"ping"}
{"id":2,"op":"infer","state":["32 numbers"],"candidates":[["27 numbers"]]}
{"id":3,"op":"infer_batch","items":[{"state":["32 numbers"],"candidates":[["27 numbers"]]}]}
{"id":4,"op":"train","records":[{"state":["32 numbers"],"candidates":[["27 numbers"]],"label":0}],"updates":10,"checkpoint":"absolute path inside runs/model.pt"}
{"id":5,"op":"close"}
```

The quoted feature rows above illustrate lengths. Actual requests require numbers. Inference returns `index` or `indices`. The caller must verify each index against the still-current legal list.

A process accepts one training call with at most 512 records and 10 Adam updates. It stops starting updates after ten minutes. The entire padded rollout batch and labels stay on the selected device during updates. Training checks finite losses, gradients and parameters, records actual weight changes, and writes an atomic checkpoint inside the ignored `runs` directory. It reloads the checkpoint into a new model and requires exact matching logits. Checkpoints use PyTorch's restricted weights-only loader.

Split training and evaluation by whole games and fresh seeds. Training agreement measures imitation fit only. Held-out decision agreement and fresh model-versus-fixed-opponent games answer different questions and need separate receipts. Terminal and truncated native games must remain distinct. A game that fails legality or hidden-information gates cannot contribute training records.

After fresh collection passes, run `python learning/train_fresh.py runs/<collection>/workers-1 runs/<new-training-name>`. The driver admits exactly one saved copy of each game. By default it trains on seeds 90001, 90002 and 90003, and holds out the entire game at seed 90004. Optional `--train-seeds` takes exactly three distinct seeds and `--heldout-seed` takes a fourth. It requires natural termination, zero rejected commands, real hidden-hand exchange checks and matching feature metadata for every game. It validates the numeric records and matches their canonical hash to the collection receipt. It rejects a training set larger than 512 records without dropping data.

The driver performs ten updates at most, writes `model.pt`, `receipt.json` and `model-config.json` inside its new ignored output directory, then exits. The receipt separates whole-game held-out teacher agreement from training fit. Use the model config for `node scripts/native-learning.mjs evaluate <private-native-config.json> <new-evaluation-name> runs/<new-training-name>/model-config.json`. Evaluation generates new games with seeds 90005 and 90006 and alternates the model's seat against the pinned heuristic. Training and evaluation use one CUDA owner process at a time.

Private receipts report runtime provenance, startup, update wall time, CUDA event elapsed time, peak PyTorch allocation and checkpoint hashes. CUDA event elapsed time is the device timeline span of the update loop, including gaps between queued operations. It is not a measurement of kernel utilization. `nvidia-smi` reports the whole GPU and includes unrelated desktop work.

The persistent JSON service was chosen over launching Python for every decision because one process can batch candidate scoring and own the accelerator. An offline file-only trainer would also suffice for imitation, but would require a separate inference process and checkpoint handoff for fresh game evaluation. This small service supports both without introducing a distributed learner framework.

Run the behavioral checks with `python -m unittest learning.test_native_torch -v`. These use synthetic CPU records to verify padding, ordering, rejection and checkpoint behavior. They do not establish native game coverage or CUDA training throughput.

## second model

`model-two-plan.json` fixes the second experiment before collection. It uses fresh games with seeds 91001 through 91018 for training and 91019 through 91024 for whole-game validation. No first-model or scaling records enter this dataset. The collector may explicitly exclude games that exceed its episode or global wall budget. Any other native, privacy or command error makes the collection fatal and blocks training.

Run `python learning/train_second.py runs/<second-collection> runs/<new-second-model>`. The trainer requires a completed `native-supervised-collection/1` receipt, at least eight natural training games, at least two natural validation games and more than 125 new training labels. It checks the fixed split, all outcomes, native pins, source hashes, per-game receipt and record hashes, numeric feature shapes and legal labels. It rejects more than 10,000 total records or an excessive padded allocation without dropping rows or candidates.

Model two starts from fresh seed 1729 and the same 1,953-parameter scorer. The training dataset stays on the selected device. Adam uses learning rate 0.003 and minibatches of 64, shuffled without replacement within each epoch. The default limit is 200 updates. `--updates` may choose at most 1,000, and `--max-seconds` may choose at most 120 seconds for the update loop. Validation runs every ten updates and after a final partial interval. Three checks without a loss improvement of at least 0.0001 stop training early.

The trainer atomically retains `best-model.pt`, selected only among trained checkpoints by validation loss. Validation uses complete held-out games and weights their decisions equally, so longer games contribute more weight. Initial validation loss is reported separately. It verifies finite gradients and parameters, actual changes from initialization, and exact checkpoint reload logits. Its receipt records the selected update, stop reason, examples processed, loss history, device memory, timings and hashes. A fresh output directory prevents overwriting model one. This remains supervised imitation, and validation agreement does not establish stronger play.

Seeds 92001 and 92002 remain untouched during training and checkpoint selection. Final evaluation uses both policy roles for each seed, against the same fixed opponent, after the best checkpoint has been selected. Run the synthetic CPU admission, masking, checkpoint and stopping checks with `python -m unittest learning.test_train_second -v`.
