# Executed source overrides

The pilot controller/collector was committed at `cc061208fab9bae2364cddf7c89be37a9558c57d`. It ran with the original update23 byte-pinned model dependencies and the same optional-card ranking helper as the preceding frozen comparison. It did not run all dependencies from the latest working checkout.

A read-only comparison of eighteen relevant executed source files found two content differences after normalizing line endings. Their exact authored bytes are retained here, with hashes in `manifest.json`:

- `learning/train_model6.py`: the earlier dependency version also matches commit `21e2e96b47323f7b98c3c248a376a0caa5c0b742` after line-ending normalization. PPO did not call its BC trainer, but the checkpoint source guard includes this file.
- `integrations/local-worker/card-action-policy.mjs`: the executed bounded card-ranking helper had no normalized-content match in this checkout's Git history. This copy closes that source-history gap. It supplies option ranking/preview behavior; it is not a learned update or a legal-combination probability model.

When reconstructing the recorded runtime, restore these files to their original relative paths in a fresh runtime copy, preserving the raw bytes. The source-override directory is archival, not a separately importable package. Match all remaining checkpoint/runtime source hashes, including line endings, against the retained run manifest before model loading. The complete private executed runtime is also retained alongside the run. No running file or frozen checkpoint was modified to create this archive.

These are authored source files only. Checkpoints, observations, journals, catalogs, extracted native DLLs and game assets are not included. No claim of a standalone public native simulator is made; the documented external prerequisite boundary still applies.

## Reconstructing the completed pilot

`run-spec.json` records the consumed training, validation and paired confirmation seeds, task/seat mix, PPO settings, reward, input hashes and all 29 executed runtime source hashes. Reusing these seeds reproduces this experiment; it is not a fresh strength evaluation. The runtime is reconstructed in a separate private directory, so current client code and source pins remain untouched.

The retained environment used Windows x64, Node 24.18.0, Python 3.12.10, PyTorch 2.5.1+cu121 and .NET SDK 8.0.425. Collection/inference used CPU; PPO updates used CUDA. This records the environment rather than promising bit-identical CUDA optimization across machines.

Prepare a private JSON configuration with these fields, each containing an absolute local path:

```json
{
  "outputRoot": "E:/ptcg-local/reproduction-001",
  "nativeConfig": "E:/ptcg-local/native-config.json",
  "teacherCatalogPath": "E:/ptcg-local/teacher-catalog.json",
  "ordinary": {
    "executable": "E:/ptcg-local/venv/Scripts/python.exe",
    "checkpoint": "E:/ptcg-local/model6-update23.pt",
    "catalogPath": "E:/ptcg-local/catalog.json"
  },
  "selection": {"checkpoint": "E:/ptcg-local/selection.pt"}
}
```

`nativeConfig` uses the existing `local-worker-probe-v1` schema documented in `integrations/local-worker/README.md`: explicit .NET executable, worker, bundle, helper and their hashes, plus `projectionCopyMode:"projection-turn-v1"`. Its bundle has the private pinned native runtime libraries, card/game definitions and exact deck recipe. The generated helper contains private catalog facts and must stay local. Supply the original update23 actor/critic **with its matching stored optimizer**, the separately pinned selector and catalogs; the preparation command does not initialize substitutes or fabricate missing inputs. Their expected hashes are public in `run-spec.json`.

```powershell
node scripts/prepare-model7-outcome.mjs E:/ptcg-local/inputs.json
```

This only copies and hashes files, verifies the native bundle and two exact 60-card recipes, restores the two source overrides, and creates `runtime/runs` plus a private manifest/preflight receipt. It never loads a model, starts a worker or collects a game. The preparation command passed with all 29 runtime pins and exact baseline/selector/deck copies, with zero model loads, games and fits.

The public `native-source/` snapshot contains the actual authored wrapper source used by the completed pilot, including Energy facts and offline session/preflight logic. It is isolated from the current shared native source. To build it with externally supplied, legally obtained pinned dependencies:

```powershell
dotnet build repro/model7-outcome-001/native-source/Indigo.Live.Engine.csproj -c Release -p:LiveRuntimeRoot=E:/ptcg-local/private-runtime -o E:/ptcg-local/rebuilt-worker
```

Keep a rebuilt worker's real digest and build environment. The historical exact reproduction requires the original worker hash in `run-spec.json`; a different binary is a different runtime, and must not be relabeled as the original. Private prerequisites and the original binary/checkpoints are preserved in the user's local archive; publishing authored code does not distribute them.

An explicitly authorized rerun can set `approval:"approved"` in its private preparation input and execute the resulting manifest:

```powershell
node E:/ptcg-local/reproduction-001/runtime/scripts/run-model7-outcome.mjs E:/ptcg-local/reproduction-001/manifest.json
```

The controller enforces the recorded collection/fitting/evaluation budgets and pins. Preparation defaults to `not-approved`; preparing this archive did not authorize or launch another run. The completed original attempt had one startup failure before any collection because its runtime lacked a `runs` directory; the retained retry used the original absolute deadline. Private paths change manifest/config digests when relocating, while the source, data, model and recipe digests remain verified.
