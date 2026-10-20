# Model4 energy-context experiment

**Model4 is experimental and not promoted.** It is one bounded training candidate derived from the selected Model3 actor. Model3 remains the evaluated baseline from the [eight direct comparison games](model-three-head-to-head-result.md), whose superiority result is inconclusive. Model3 and those results are preserved unchanged. At this training snapshot Model4 was unevaluated. Its later [frozen Live qualification](official-client-frozen-qualification.md) recorded one win followed by a loss, failing the five-win gate; it does not establish comparative strength. No further games or test panels are authorized by this document.

Inspection of the preserved Model2–Model3 loss and timeout traces found Dragapult repeatedly using Jet with only one required energy type. In the inspected failure traces it selected Phantom Dive whenever Phantom Dive was legal. This supports investigating energy assembly rather than changing attack preference. The existing actor-visible teacher already prioritizes the missing Fire/Psychic energy on its preferred Dragon attacker. This is a training hypothesis, not proof of the cause or a strength claim.

The experiment collects 12 fresh DAgger training games, seeds 97001–97012, against the same frozen scripted opponent. Eight games belong to training and four to training validation; incomplete games are excluded as whole games. Ordinary decisions start from the frozen Model3 PPO actor with a 25% teacher mixture. Card selection continues to use the frozen Model3 BC selection model. The full actor-visible record and complete legal candidate list remain preserved.

Fine-tuning uses only ordinary decisions where a legal energy play exists, identified from actor-visible energy cards and action source IDs. The teacher label may still be a draw, attack, or other legal action. This avoids teaching unconditional attachment. Selection labels are excluded. The actor warm start competes at update zero; validation loss can retain it if the correction fails to improve imitation. Validation measures agreement with training labels, not game performance.

Collection is limited to four CPU lanes, 12 games, 360 seconds per game, 500 commands per game, and 1,200 seconds overall. The subsequent small GPU update is limited to 300 updates or 60 seconds, with learning rate 0.0001 and four stale validation checks. Runtime guards and checkpoint reload checks are part of training; no test suite or separate games are run.

Run `python scripts/run-model4-energy-repair.py <private-recipe.json>` with the existing Torch environment. The private recipe supplies the native profile, frozen input checkpoints, printing aliases, and dedicated model storage root. Outputs go to a fresh model group and ignored `runs/model4-energy-*` directories. No weights, private decks, native vendor inputs, or raw traces belong in Git.

The consumed comparison seeds 94301-94304 are not training inputs. Their traces inform only this engineering hypothesis. No subsequent result may call them an untouched holdout. Training loss alone does not evaluate Model4's playing strength.

Dependency risk: the recorded Torch `2.5.1+cu121` environment is affected by critical [CVE-2025-32434 / GHSA-53q9-r3pm-6pq6](https://github.com/advisories/GHSA-53q9-r3pm-6pq6), remote code execution through `torch.load` even with `weights_only=True`. The advisory lists versions before 2.6.0 as affected. This run loaded only locally generated Model3 checkpoints and their local derivatives; no third-party weights were downloaded or loaded. That constraint does not fix the dependency vulnerability. No package was installed, upgraded or patched by this source landing.

## Recorded result

The run started at 08:25:54 UTC and completed at 08:39:38 UTC on October 20, 2026. All 12 games completed naturally: eight training games and four validation games, 1,846 accepted commands, zero truncations, failures, cancellations, or replacements. Collection took 810.630 seconds. The admitted dataset contained 551 training and 272 validation records; the energy-context filter retained 185 and 127 ordinary decisions respectively.

Fine-tuning completed 175 updates in 10.651 seconds and stopped after four stale validation checks. Update 75 was selected by minimum validation cross-entropy. The selected weights differ from the initial Model3 actor. Validation cross-entropy changed from 1.413464 to 1.282938, while top-choice teacher agreement declined from 68.50% to 60.63%. The selected checkpoint's training loss was 1.240681 and training teacher agreement was 57.84%. These are mixed training-only signals, not evidence of better play. No Model4 games had run after fine-tuning when this training receipt was recorded; the later Live qualification is reported separately above.

Checkpoint SHA256: `38a6e726d528d8de3cc9924285c8d67c2700a8dde1cb64f6e388d99ae37ce8b5`. Collection dataset receipt SHA256: `3767b0c83fe44949b6692a7df7cccb954bb3f7d5d94530545f4e6f937a2c9bf6`. Both original Model3 input checkpoint hashes were checked unchanged at completion. The Model3 selection model, teacher, encodings, decks, native worker, and helper policies stayed frozen. Only the ordinary actor was fine-tuned; the PPO critic and optimizer are not part of this BC checkpoint.

The executed source commit was `0810502a1192c3d32923cc732f912acd54d0e9f6` (implementation `4f857815bcf0b30dd558368f4a7aaafff9b41aff`). The recorded command structure, with its personal interpreter path replaced by a generic local prerequisite, was:

```powershell
& 'C:/local/existing-python/python.exe' -u scripts/run-model4-energy-repair.py runs/v4-control/energy-repair.json
```

Reproduction requires the preserved private recipe, native bundle/profile, Model3 inputs, and existing runtime. Use a fresh worktree and model group to avoid overwriting the originals. No end-to-end reproduction was run under the no-tests constraint. Fresh parallel collection can change completion order and therefore the dataset/minibatch order; the preserved dataset receipt and raw records pin the actual order used here. There is no claim of identical weights from a fresh recollection. The pinned Torch dependency gap remains unresolved.

## Explicit local setup

Use the authored Model3 [profile setup](model-three-reproduction.md) with the authorized private 39-program bundle, prepared native worker/runtime, and retained Model3 PPO/BC checkpoints. The recorded PPO input hash is `8a2a98a8dad933cf5a1d273d89ccc3e54c99b5ed686edc4238e7b1dd6188828b`; frozen BC selection is `6d3a5510e36a17610de6cbd099a3deac5a3efde02181213358b49ecab65afff2`. No vendor payloads or weights are included in the repository.

The ignored recipe has six required fields:

```json
{
  "modelRoot": "C:/local/existing-private-model-store",
  "modelGroup": "model4-fresh-energy-experiment",
  "model3Ppo": "C:/local/existing-private-model-store/model3/ppo/update-039.pt",
  "model3Selection": "C:/local/existing-private-model-store/model3/bc/best-model.pt",
  "nativeConfig": "C:/local/this-checkout/runs/model3-profile/native-config.json",
  "printingAliases": {
    "ASC-158": "TWM-128", "ASC-159": "TWM-129", "ASC-160": "TWM-130",
    "ASC-99": "TWM-95", "ASC-184": "TEF-144",
    "MEE-2": "MEE-10", "MEE-7": "MEE-15", "MEE-5": "MEE-13"
  }
}
```

The aliases match `mechanicalAliases` in `learning/agentpult-deck.json`. Replace all example paths with the retained explicit local prerequisites. `modelRoot` must exist; `modelGroup` must be new. Run from a fresh checkout: the fixed `runs/model4-energy-control` and `runs/model4-energy-dagger` output directories must not already exist. The script fixes seeds 97001–97012, the 8/4 whole-game split, mixture, collection caps and update bounds; the recipe does not select additional experiments. These instructions document reproduction only and do not authorize another run. This integration performed source/privacy review with zero tests and zero model workloads.
