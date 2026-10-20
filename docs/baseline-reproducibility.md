# Rebuild the frozen native learning baseline

The repository contains the authored worker source, frozen teacher, player projection, feature encoder, data generator, trainers, evaluation runners and fixed seed plans for Model1/Model2. Weights and datasets are generated locally. Model3 has a separate [reproduction recipe](model-three-reproduction.md) and [completed direct-comparison report](model-three-head-to-head-result.md); this document covers the frozen Model1/Model2 baseline.

The worker source under `integrations/local-worker/native-source/` is original Indigo glue around the native API: loading, transport, offered actions, selections and presentation. It contains no recovered engine implementation or captured card-effect programs. `teacher.mjs` is the exact original actor-visible heuristic used by baseline collection. [The prerequisite manifest](../integrations/local-worker/baseline-prerequisites.json) binds all nine source files, the teacher and private inputs by SHA-256. Git preserves the byte-pinned source line endings. The [baseline deck profile](../integrations/local-worker/baseline-decks.json) contains both exact 60-card source arrays in their original order. This baseline includes TEF-128 Dunsparce; the separate AgentPult profile requires JTG-120 and its documented extension.

## Local prerequisites

The rehearsed host uses Windows, Node 24.18.0 and .NET SDK 8.0.425 targeting net8.0. The dependency-free Node package requires Node 22 or newer. NuGet sources are cleared; the worker references four explicitly supplied local DLLs. No package download occurs during setup.

Original baseline CUDA training used PyTorch `2.5.1+cu121` with CUDA runtime 12.1. The CPU integration rehearsal uses Python 3.12.10 and PyTorch `2.12.0+cpu`. Those are different environments; CPU tests do not establish identical CUDA training weights. The original Python patch version and complete transitive Python dependency lock were not retained. The current CPU environment now has a separate [version lock](../learning/baseline-cpu-lock.json), [ten-package requirements file](../learning/requirements-baseline-cpu.txt) and runtime verifier. It covers Torch's active non-extra dependency closure on Windows AMD64, rather than unrelated desktop packages. No historical or bitwise checkpoint reproduction claim follows from this current lock.

```powershell
python scripts/verify-baseline-python.py
```

The verifier checks Python, platform, all ten installed distribution versions, the `2.12.0+cpu` runtime and absence of CUDA. The observed Torch distribution metadata says `2.12.0`, while its runtime says `2.12.0+cpu`; both are retained explicitly. Nothing is installed or changed by verification. Original wheel download URLs/archive hashes are absent from this installation. A fresh environment install has not been rehearsed, so this is a version lock, not a hash-locked wheelhouse. If you retain matching wheels, a separate fresh environment can be prepared without changing an existing training runtime:

```powershell
python -m venv .cache/baseline-cpu-venv
.cache/baseline-cpu-venv/Scripts/python.exe -m pip install --no-index --find-links C:/local/wheelhouse -r learning/requirements-baseline-cpu.txt
.cache/baseline-cpu-venv/Scripts/python.exe scripts/verify-baseline-python.py
```

Supply the wheelhouse yourself and retain its archive hashes for future installations. The version requirement alone does not certify the CPU build; the runtime verifier must pass before using it. Missing matching wheels remain an explicit environment provisioning gap.

Supply your own private `manifest.json` and these eight files in one local bundle directory:

| File | Required content |
| --- | --- |
| `MatchLogic.dll` | Previously reconstructed headless engine, not an arbitrary installed-client DLL |
| `CardDatabase.DataAccess.dll` | Matching reconstructed data-access dependency |
| `Newtonsoft.Json.dll`, `TimeProvider.dll` | The pinned runtime dependencies |
| `cardData.json` | The selected 38 captured card programs |
| `gameData.json` | The matching captured Base game rules/actions |
| `decks.json` | Both original 60-card arrays and their bundle metadata |
| `printing-joins.json` | Exact source/printing mappings used by that bundle |

The manifest digest is `492cfe02343d2342df0c07089dff9d3e4a9ce6cdb06190d9c00a85f1113c7af9`; every file's byte count and hash is recorded in the public prerequisite manifest. The repository includes the exact byte-pinned [metadata manifest](../integrations/local-worker/native-bundle-manifest.json), with relative source locations, and an authored assembly command. It contains no vendor file payloads. The inspected original `network-gameplay-bundle.py` script packages previously reconstructed dependencies and captured programs. Its source hash is retained in `baseline-prerequisites.json`; it does not extract from a stock client.

With the retained private research layout, rebuild the bundle in a new ignored directory:

```powershell
node scripts/assemble-native-bundle.mjs C:/local/private-research-root .cache/native-inputs
```

The source locations are explicit: DLLs under `offline-baseline/inputs/`, rules under `network-recon/headless/standard-game-live-first/`, selected cards/decks under `network-recon/selected-decks-v1/`, and joins at `inventory/network-selected-deck-joins.json`. Every input's byte count and hash is checked before output creation. The command preserves the canonical manifest bytes and refuses an existing output. For a flat existing bundle use `--from-bundle`. Point setup's `bundleRoot` to the newly assembled directory. This route was rehearsed and produced the original manifest hash, then passed prerequisite verification and seeded create/read/abort against the existing rebuilt worker.

Upstream generation remains partial provenance. `network-selected-deck-joins.py` relies on a pinned Indigo deck source, cached import/table data, the captured corpus and its reader; managed rebuilding relies on reconstructed private sources. Those scripts do not constitute a self-contained, verified stock-client extraction/reconstruction procedure. No reverse engineering or vendor binary changes were performed in this follow-up. Obtain the exact retained inputs locally, preserve their provenance and verify them before execution. Missing them remains an explicit native execution blocker. Public kernel and synthetic tests can still run without them.

## Fresh checkout setup

From the repository root, create ignored `runs/setup-native.json`. Replace both example paths with existing local absolute paths:

```json
{
  "schema": "native-baseline-setup/1",
  "dotnet": "C:/local/dotnet-8.0.425/dotnet.exe",
  "bundleRoot": "C:/local/private-native-bundle",
  "buildId": "native-audit-repro"
}
```

```powershell
node scripts/setup-native-baseline.mjs runs/setup-native.json --verify-only
node scripts/setup-native-baseline.mjs runs/setup-native.json
node scripts/verify-native-baseline.mjs runs/local-audit-config.json
```

Setup checks the executable, SDK version, all authored inputs, bundle manifest, eight files and exact deck order. It first builds the original worker, then applies the repository's existing seeded/audited hooks and builds the Release worker. It saves private logs, generated artifacts and absolute-path configs only in ignored `.cache/` and `runs/`. It refuses existing output instead of overwriting a run. Use a fresh checkout for another setup rehearsal. `prepare-audit.mjs` remains available for explicitly configured alternative builds.

The generated native config uses `projection-turn-v1`, the frozen teacher in this checkout and a zero-command probe budget. The final command creates a native simulation with explicit seed 1729, checks repeated seat views, the player projection and seeded audit contract, then aborts without gameplay commands. The original `probe.mjs` CLI is for the earlier unseeded worker and cannot supply the audit worker's required seed. Setup itself starts no game. No official client, training job, model or GPU process is launched.

## Generate, train and evaluate

Run the existing Node and synthetic CPU model checks with your explicit installed Python:

```powershell
npm.cmd test
python -m unittest learning.test_native_torch learning.test_train_second -v
```

The complete Model2 recipe is already fixed in [model-two-plan.json](../learning/model-two-plan.json): seeds 91001–91018 train, 91019–91024 validate, swapped deck seats, four CPU workers, 24 attempts, 400 commands and 180 seconds per game, and a 30-minute collection cap. Warmups, repeated scaling copies, failed/interrupted games and replacements do not supply labels. Data admission binds source hashes, teacher/runtime pins, accepted commands, native chance transcripts, player-safe feature records and real hidden-hand permutation checks.

```powershell
node scripts/native-collect.mjs runs/local-audit-config.json reproduce-model2-data
python learning/train_second.py runs/reproduce-model2-data runs/reproduce-model2 --device cpu --updates 200 --max-seconds 120
node scripts/native-final-evaluation.mjs runs/local-audit-config.json reproduce-model2-final runs/reproduce-model2/model-config.json
```

The shown CPU path produces a fresh local checkpoint, not the original CUDA weights. To use the recorded CUDA training environment, pass `--device cuda` and an explicitly installed matching interpreter; prepare a separate CPU inference config pointing to that same new checkpoint for the final evaluator. Final evaluation requires CPU inference and untouched seeds 92001/92002 in both policy roles against the frozen teacher. Validation-selected agreement is separate from final playing outcomes; timeouts never become fabricated losses. No setup/prompt learning or DAgger is part of these baseline trainers.

Model1's smaller ten-update recipe and seeds are in [the learning bridge](native-learning-bridge.md) and [learning README](../learning/README.md). The encoder/action boundary lives in `learning-features.mjs`, `policy-view.mjs` and `decision-domain.mjs`; `learning/native_torch.py` owns the 1,953-parameter scorer. Local graphical play additionally requires user-supplied Indigo CSS/artwork and weights as described in [checkpoint play](checkpoint-play.md). Shadow evaluation runs its explicitly synthetic example without native prerequisites and has zero real-video labels.

The [integration receipt](completed-work-integration.json) records what was actually rehearsed. The rebuild and zero-command native smoke do not rerun original collection, full-game evaluation, CUDA training, private graphical play or the stopped official-client pilot.
