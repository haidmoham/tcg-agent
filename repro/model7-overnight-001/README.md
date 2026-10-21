# One six-hour Model7 trajectory

`protocol-v3.json` records the AlphaZero-inspired information-set search, natural-outcome policy/value distillation, opponent mixture, independent game/search seeds and separate fresh gameplay evaluation. Versions 1 and 2 preserve earlier unexecuted PPO designs. No PPO ratios enter the selected objective. Private dependencies and weights remain external; the preserved first-baseline and prerequisites in `../model7-outcome-001/README.md` supply the initial actor/critic and native scenario.

Prepare the existing archived baseline runtime first, using its private-input schema. Then supply a private execution-input JSON with absolute paths: `preparedManifest`, `sourceRoot`, `probeRecords` (actual archived ordinary/singleton records), `environmentConfig` (frozen first-baseline), `performanceConfig`, `performanceHandoff`, and qualified `searchNativeConfig`. Optional `sourceCommits` records the exact integrated sources; `providerOptions` records any explicit native transport binding.

```powershell
node scripts/prepare-model7-outcome.mjs E:/private/preparation-inputs.json
node scripts/prepare-model7-alphazero.mjs E:/private/execution-inputs.json repro/model7-overnight-001/protocol-v3.json
node E:/private/model7/alphazero-runtime/scripts/run-model7-alphazero.mjs E:/private/model7/alphazero-manifest.json
```

Preparation copies authored sources, verifies worker/source/input pins, and initializes a new policy/value checkpoint with exact first-baseline actor/critic tensors and a fresh Adam optimizer for the new objective. It runs no games or optimization steps. The supervisor waits for the fixed start, ends training at the absolute deadline and selects the last fully admitted, reload-verified update. A new authorized run needs a separately versioned time/seed protocol; do not silently rewrite historical deadlines.

The collector records actual accepted search targets only on nonforced legal domains, and assigns seat-perspective values after natural completion. Unsupported search and helper routes have explicit coverage counts and supply no invented visits. Interrupted or excluded games preserve their records without gradients. The declared whole-batch rule can discard valid trajectories and select the training distribution; retain those counts and limitations. Replay uses up to four fully admitted batches, with a 16384-target ceiling and exact retained files/hashes.

`overnight-run/player-runtime.json` identifies the immutable factory, source pins and behavior configuration. `status.json`, per-game journals and receipts, `events.jsonl`, `checkpoint-announcements.jsonl` and `final-candidate.json` preserve source/seed lineage, actual collection and fitting time, coverage and checkpoint proof. A surviving supervisor must never be duplicated. After inspecting an interrupted process and all its children, `--resume` continues the same manifest and deadline without recollecting consumed seeds. An orphan checkpoint without a reload receipt is insufficient for admission.

The independent evaluator owns the development panels and final 512-pair gameplay confirmation. Training loss, a native branch smoke or a short qualification game does not establish stronger play. Keep private records, native assets and weights local. Current explanatory documentation remains in the [project wiki](https://github.com/haidmoham/tcg-agent/wiki).
