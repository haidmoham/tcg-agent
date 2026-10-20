# Reproduce the fixed-deck learner

This source snapshot includes the BC/DAgger recipe below and the later outcome-PPO campaign entrypoint. The current authorized workload is the eight direct Model2-versus-Model3 comparison games in a separate evaluation checkout. No tests, training, preparation rehearsal or model workloads were run for this source landing. Comparison source/results will be integrated after that handoff; the historical plans below are not instructions to launch additional evaluation panels now.

Model3 learns ordinary actions and supported visible card selections for the exact sixty in [agentpult-deck.json](../learning/agentpult-deck.json). Its eight mechanical reprint mappings are explicit. JTG-120 Dunsparce is required. The opponent is the frozen native deck, not a claim about the official Live AI. No client automation is needed by these commands.

The authored pieces are the [teacher](../learning/agentpult-teacher.mjs), [preparation and aggregation CLI](../scripts/prepare-agentpult-training.mjs), [rollout recorder](../scripts/card-action-rollout.mjs), [encoder](../learning/card-action-features.mjs), [scorer service](../learning/card_action_torch.py), [trainer](../learning/train_card_action.py), and [fixed experiment plan](../learning/model-three-plan.json). The teacher searches for missing evolution pieces after accounting for held cards. Its draw order is conditional on visible hand and board state. The neural policy receives no teacher scores or card-specific priorities.

## Local prerequisites

Use Node 24.18.0 and Python 3.12.10 for the recorded Windows setup. Python dependencies are pinned in [requirements-model3-windows.txt](../learning/requirements-model3-windows.txt). The tested GPU runtime is Torch 2.5.1+cu121 on an RTX 3080 with driver 610.88. NumPy is not used. There are no Node package dependencies for this path.

Supply an authorized private 39-program bundle with a `manifest.json` that pins these eight files: `MatchLogic.dll`, `CardDatabase.DataAccess.dll`, `Newtonsoft.Json.dll`, `TimeProvider.dll`, `cardData.json`, `gameData.json`, `decks.json`, and `printing-joins.json`. The bundle must include the exact JTG-120 program and original frozen opponent. The retained input extension's manifest hash is `cdc6f9fa83dac0cce72408661dabd4e7a8b55195624f3d1559afa4503d64195d`. The older 38-program bundle is insufficient.

Also supply the prepared Release headless worker and .NET executable. The accepted worker hash is `76c38d968b3703fd5a69e94a97f8c5ce7b9f6e488d8d3428bae162af4204669a`. The recorded .NET executable hash is `111da7b604cd196b49167cfeecdaef4034b58cc7de71a91cbf9e162c9e8b0931`. Worker dependencies beside the worker must match the bundle. See [native-runtime.md](native-runtime.md) for the existing native boundary. This Model3 recipe verifies those supplied artifacts; it does not reconstruct captured programs or build a missing worker. Those remain explicit local prerequisites.

Create an ignored JSON configuration, for example `.cache/private-native-inputs.json`, with `schema: "local-worker-probe-v1"`, absolute `executable`, `worker`, and `bundleRoot` paths, their `executableSha256`, `workerSha256`, and `manifestSha256` values, `buildConfiguration: "Release"`, `maxCommands: 0`, and `maxSeconds: 30`. The supplied configuration needs no policy path. Never put credentials or client/account data into it.

## Prepare and qualify

Run from the repository root. Replace the Python path with the existing Python installation. All output paths must be fresh directories inside ignored `runs/` or `.cache/`.

```powershell
& 'C:/your/Python312/python.exe' -m venv .venv
& ./.venv/Scripts/python.exe -m pip install -r learning/requirements-model3-windows.txt
node scripts/prepare-agentpult-training.mjs prepare .cache/private-native-inputs.json runs/model3-profile
node scripts/prepare-agentpult-training.mjs plans runs/model3-profile runs/model3-phase1-plans
node scripts/card-action-rollout.mjs runs/model3-profile/native-config.json model3-qualification runs/model3-phase1-plans/qualification.json
```

Preparation verifies all supplied file pins, joins all 24 card types, rebuilds only the AgentPult deck, and preserves the opponent. Expected ordered deck hashes are in the fixed plan. It writes the exact generated teacher, a private scalar card/action catalog, a native configuration, and a preparation receipt. The generated teacher embeds the public authored strategy and private catalog together, so its single policy hash and archived bytes cover the executed logic. It contains no dependency on another task directory.

Review qualification outcomes and line-building diagnostics before generating demonstrations. Qualification uses development seeds and is not training data. A failed or incomplete teacher test is not proof of competence. Never count a timeout as a loss or replace a seed silently.

## Demonstrations and behavioral cloning

```powershell
node scripts/card-action-rollout.mjs runs/model3-profile/native-config.json model3-bootstrap runs/model3-phase1-plans/bootstrap.json
& ./.venv/Scripts/python.exe learning/train_card_action.py runs/model3-bootstrap runs/model3-bc --device cuda --updates 2000 --max-seconds 180
```

The plan fixes 24 training games and eight whole-game validation games. Only naturally completed AgentPult-seat games with zero rejected commands and successful privacy checks can train. Record files retain actor-visible state, complete offered actions or individual card choices, numeric features, teacher labels, executed choices and attribution. Ordered answers, setup, noncard prompts, allocation and prizes remain explicit helpers. Individual choice coverage does not claim exhaustive enumeration of all legal multi-card answer sets.

The trainer verifies raw record-byte hashes, feature/source/native pins, split separation and legal labels. It selects by validation loss, checks finite updates, and verifies saved logits against the in-memory model. The update limit is 2,000 and the update-loop wall cap is 180 seconds for this experiment. Checkpoints and numeric examples remain private.

## One learner-state correction round

```powershell
node scripts/prepare-agentpult-training.mjs plans runs/model3-profile runs/model3-phase2-plans runs/model3-bc/model-config.json
node scripts/card-action-rollout.mjs runs/model3-profile/native-config.json model3-dagger runs/model3-phase2-plans/dagger.json
node scripts/prepare-agentpult-training.mjs aggregate runs/model3-bootstrap runs/model3-dagger runs/model3-aggregate
& ./.venv/Scripts/python.exe learning/train_card_action.py runs/model3-aggregate runs/model3-dagger-trained --device cuda --updates 2000 --max-seconds 180 --initial-checkpoint "$((Resolve-Path runs/model3-bc/best-model.pt).Path)"
```

The generated DAgger plan uses CPU inference, twelve new games and a fixed 0.25 teacher behavior mix. Labels are queried on the same visible states the learner visits. The aggregate copies each whole game once and preserves both parent receipts. Sources, rules, aliases and native pins must match. The warm-start checkpoint competes as update zero on the aggregate validation set. If updates worsen validation loss, it remains selected and the receipt says so.

## Frozen playing evaluation

```powershell
node scripts/prepare-agentpult-training.mjs plans runs/model3-profile runs/model3-final-plans runs/model3-bc/model-config.json runs/model3-dagger-trained/model-config.json .cache/model2-model-config.json
node scripts/card-action-rollout.mjs runs/model3-profile/native-config.json model3-final runs/model3-final-plans/final-evaluation.json
node scripts/card-action-rollout.mjs runs/model3-profile/native-config.json model2-final runs/model3-final-plans/baseline-evaluation.json
```

The optional frozen Model2 weights and their private configuration must already be supplied inside this checkout's `runs/` directory. Weights are deliberately not published. Plans clone model configs to CPU without modifying original training configs. Both checkpoints face the same weak native baseline on fresh fixed seeds and swapped policy roles. Run the two evaluation commands concurrently only if retaining the planned total of four native workers. Otherwise run sequentially and record the scheduling change. Ordinary and supported card-choice Model3 decisions have zero teacher overrides. Model2 card selections remain attributed helpers, so this is a comparison of those complete policy packages.

Report natural wins, losses and incomplete games separately from teacher agreement. First Phantom Dive turn, offered/chosen evolutions and Recon uses are diagnostics, not rewards. Final outcomes must not choose a checkpoint or trigger retraining. Eight cases per checkpoint cannot establish a universal zero-loss guarantee against the official AI.

## Integrity and fresh-checkout rehearsal

Keep generation sources frozen from collection through dataset admission. Each run archives source and policy bytes, exact plans and private native configuration. Changes to source, rules, teacher or checkpoint pins fail admission. Timed-out traces remain local; failed/partial games never enter training records. No retry replaces an uncertain mutation.

Rehearse `prepare` and `plans` from a fresh checkout while passing the same explicit user-supplied native prerequisite configuration. A successful assembly only proves preparation and identity checks. It does not certify worker construction, native gameplay, dataset collection, GPU training or strength. Record those checks separately. Python/runtime availability, the prepared native worker, authorized 39-program inputs and optional historical baseline weights are the explicit external dependencies.

## Outcome PPO source entrypoints

`scripts/run-model3-training.mjs` runs the later sequential BC-warm-start and outcome-PPO campaign. `scripts/ppo-native-rollout.mjs` records masked ordinary-action trajectories; `learning/ppo_runtime.py` initializes, serves and updates the actor/critic; `learning/masked_ppo.py` owns PPO/GAE. The [masked PPO contract](../learning/masked-ppo-contract.md) documents boundaries, terminal rewards, truncation bootstrap and the separately frozen BC selection policy.

The campaign command is `node scripts/run-model3-training.mjs <private-campaign-config.json>`. Its explicit config supplies absolute `python`, `nativeConfig`, `profilePlan`, `dataset`, `modelRoot` and `campaignDirectory`, plus `modelGroup`, `runPrefix`, `maximumBatches`, `gamesPerBatch`, `firstSeed` and `stopByUtc`. Optional `bcDirectory` and `initialPpoCheckpoint` reuse retained warm-start artifacts without modifying them. Generated plans and receipts preserve seeds, parent hashes, finite accepted updates and the declared stopping rule. These commands are reproduction interfaces, not newly authorized workloads.

The exact executed campaign config, dataset, checkpoints and training artifacts remain local and are not contained in this source handoff. Record their sanitized provenance and actual stopping outcome with the later comparison handoff; this landing alone does not reconstruct that exact run or establish Model3 superiority. Existing test source and historical validation receipts are retained without running or extending tests.
