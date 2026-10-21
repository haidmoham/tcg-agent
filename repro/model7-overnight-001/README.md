# One six-hour Model7 trajectory

`protocol.json` records the selected method, inherited settings, complete seed schedule, batch admission rule and separate gameplay evaluation. The baseline actor, stored optimizer, selector, native environment and learning implementation stay byte-pinned. Private dependencies and weights remain external; use the prerequisites and source reconstruction in `../model7-outcome-001/README.md`.

Prepare a fresh runtime using the existing private-input schema, then verify its inherited optimizer and CUDA device and prepare this execution:

```powershell
node scripts/prepare-model7-outcome.mjs E:/private/preparation-inputs.json
node scripts/prepare-model7-overnight.mjs E:/private/model7/manifest.json repro/model7-overnight-001/protocol.json
node E:/private/model7/runtime/scripts/run-model7-overnight.mjs E:/private/model7/overnight-manifest.json
```

The supervisor waits until the protocol start, ends training at its absolute deadline, and uses the existing collector and update service. Historical deadlines must not be silently changed and called an exact rerun; a new authorized execution needs a separately versioned protocol. There is one continuing checkpoint lineage, with no result-based checkpoint selection. Only full admitted 64-game batches can contribute gradients. Every discarded batch retains its raw records and attribution. A surviving supervisor must never be duplicated. After inspecting an interrupted supervisor and its child processes, `--resume` recovers the same manifest and deadline, never recollecting consumed seeds. An update needs its immutable reload receipt to be admitted; an orphan checkpoint alone is insufficient.

`overnight-run/status.json` is replaced atomically. `checkpoint-announcements.jsonl` contains only admitted immutable checkpoints, including absolute checkpoint path, SHA256, completion time, game/update counts, optimizer steps and reload proof. `final-candidate.json` marks availability and the last admitted checkpoint; `receipt.json` retains timing, skipped batches and failures. These are operational and training artifacts, not proof of stronger play.

```powershell
node scripts/export-model7-training.mjs E:/private/model7/overnight-manifest.json E:/private/model7/sanitized-training-result.json
```

The sanitized export includes source hashes and attempted, admitted and discarded games and decisions by batch, parent checkpoint, opponent, seat and reason. Review it before publication. The independent research evaluator owns the predeclared development panels and final 512-pair gameplay confirmation; training losses or short smoke games cannot substitute for that result. Current explanatory documentation remains in the [project wiki](https://github.com/haidmoham/tcg-agent/wiki).
