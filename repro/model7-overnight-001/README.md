# One six-hour Model7 trajectory

`protocol-v4.json` records the active recovery of the single AlphaZero-inspired search and policy/value training trajectory. Version 3 started collection but produced no fit before its first batch was excluded for two domain errors and a time limit. Versions 1 and 2 preserve earlier unexecuted PPO designs. No PPO ratios enter the selected objective. Private dependencies and weights remain external; the preserved first-baseline and prerequisites in `../model7-outcome-001/README.md` supply the initial actor/critic and native scenario.

Prepare the existing archived baseline runtime first, using its private-input schema. Then supply a private execution-input JSON with absolute paths: `preparedManifest`, `sourceRoot`, `probeRecords` (actual archived ordinary/singleton records), `environmentConfig` (frozen first-baseline), `performanceConfig`, `performanceHandoff`, and qualified `searchNativeConfig`. Optional `sourceCommits` records the exact integrated sources; `providerOptions` records any explicit native transport binding.

```powershell
node scripts/prepare-model7-outcome.mjs E:/private/preparation-inputs.json
node scripts/prepare-model7-alphazero.mjs E:/private/execution-inputs.json repro/model7-overnight-001/protocol-v3.json
node E:/private/model7/alphazero-runtime/scripts/run-model7-alphazero.mjs E:/private/model7/alphazero-manifest.json
```

Preparation copies authored sources, verifies worker/source/input pins, and initializes a policy/value checkpoint with exact first-baseline actor/critic tensors and a fresh Adam optimizer for the new objective. It runs no games or optimization steps. Version 3 started as soon as qualification passed; its first collection began at 03:38:11.728 UTC and established the six-hour deadline of 09:38:11.728 UTC. The supervisor selects the last fully admitted, reload-verified update before that deadline.

Version 4 preserves that origin, deadline and initialized training state. The qualified repair advances native-validated empty forced prompts without synthetic policy/value outputs. An isolated candidate episode driver extends the game guard to 3600 seconds; full recorded-game replay preserved every command and frame. Batch 1 remains excluded. The recovery preparer creates a separate sealed runtime, proves exact weights/optimizer/RNG/configuration/output preservation through a metadata-only reseal, and resumes with the unused declared batch 2:

```powershell
node scripts/prepare-model7-alphazero-recovery.mjs E:/private/model7/alphazero-manifest.json repro/model7-overnight-001/protocol-v4.json C:/source/tcg-agent E:/private/probe-records.jsonl
node E:/private/model7/alphazero-runtime-v4/scripts/run-model7-alphazero.mjs E:/private/model7/alphazero-manifest-v4.json --resume
```

Use recovery only after inspecting and stopping the old process tree and explicitly recording its paused state. Its narrow pre-fit guard rejects an already trained parent. Any unusable version-4 batch aborts immediately and stops the supervisor for diagnosis rather than consuming more batches blindly. A new authorized experiment needs a separately versioned time/seed protocol; do not rewrite historical deadlines.

The collector records actual accepted search targets only on nonforced legal domains, and assigns seat-perspective values after natural completion. Unsupported search and helper routes have explicit coverage counts and supply no invented visits. Interrupted or excluded games preserve their records without gradients. The declared whole-batch rule can discard valid trajectories and select the training distribution; retain those counts and limitations. Replay uses up to four fully admitted batches, with a 16384-target ceiling and exact retained files/hashes.

`overnight-run/player-runtime.json` identifies the immutable factory, source pins, behavior configuration and explicitly pinned `episodeRunner`. `status.json`, per-game journals and receipts, `events.jsonl`, `checkpoint-announcements.jsonl` and `final-candidate.json` preserve source/seed lineage, collection and fitting time, coverage and checkpoint proof. A surviving supervisor must never be duplicated. After inspecting an interrupted process and all its children, `--resume` continues the same manifest and deadline without recollecting consumed seeds. An orphan checkpoint without a reload receipt is insufficient for admission. An `archiveDirectory` in the preparation input requests a verified private archive after training; inspect `preservation.json` for its outcome.

The independent evaluator owns the development panels and final 512-pair gameplay confirmation. Training loss, a native branch smoke or a short qualification game does not establish stronger play. Keep private records, native assets and weights local. Current explanatory documentation remains in the [project wiki](https://github.com/haidmoham/tcg-agent/wiki).
