# Second-model collection contract

`scripts/native-collect.mjs` collects fresh teacher games for the preregistered `learning/model-two-plan.json`. Model-one runs and examples remain intact. The [executed second-model result](native-second-model.md) records the admitted data and selected checkpoint.

```powershell
node scripts/native-collect.mjs runs/local-audit-config-v12-turn.json native-second-collection-v1
```

The collector starts four isolated CPU lanes. Each lane keeps one native process after successful natural games and runs its fixed tasks in order. Seeds 91001–91018 are training games. Seeds 91019–91024 are whole-game validation. Deck seats alternate. There are at most 24 attempts, no warmups, no replacement seeds, and no retries of incomplete games.

Each game has a 180-second native episode limit and a 400-command limit. A global 30-minute deadline stops new attempts and cancels active work. Cleanup joins the Node lanes and their native children. Post-deadline cleanup time is reported in total elapsed time. Postterminal OS process sampling is outside the episode timer.

Only an explicit episode wall-budget error permits a capacity exclusion and a fresh worker for the next declared task. A global wall-budget cancellation also excludes the interrupted game. All other failures block training and cancel every lane. These include actual rejected commands, exhausted command budgets, unsupported decisions, privacy changes, seed/RNG mismatches, unknown worker failures, and source changes. Incomplete data never enters `completed`.

Every frame uses the existing authority, RNG, hidden-world and native legal-offer gates. Records contain human-seat ordinary-action examples with schema `native-ordinary-features/1`. The fixed helper still handles prompts and both teacher players. This is the same private two-deck slice, with no full Standard claim.

## Source freeze and receipts

The controller records SHA-256 hashes for itself, the fixed plan, and every imported generation module. It archives exact bytes under the new run's `source-snapshot/`. Each lane checks the same hash map before starting, before each game, and after each game. The controller checks again after all lanes exit. Generation files stay frozen throughout collection. Any source mismatch is fatal.

`receipt.json` uses schema `native-supervised-collection/1`. It lists all fixed `tasks`, `completed` games, `capacityFailures`, `cancelled` games, `unattempted` tasks, and `fatalFailures`. `complete` means the bounded collector finished and joined its lanes. `fatal` must be false for training admission. `unattempted` tasks under the global deadline are explicitly capacity-censored. Capacity exclusions remain visible and can bias the retained dataset toward shorter games.

Each completed item includes split and seed metadata, relative `recordsPath` and `receiptPath`, command and record counts, semantic trajectory and canonical record hashes, and SHA-256 hashes of both artifact files. A separate `admitted-receipt.json` binds the game's native pins, source hash map, split, and collection identity. Original helper receipts remain intact. The trainer admits only naturally complete games with valid masks and passing privacy gates, then enforces the preregistered minimum train/validation counts.

All full journals, progress logs, configs, feature records, failure details, source snapshots and checkpoints stay in ignored `runs/`. No model training or native jobs start merely by importing or testing this controller.
