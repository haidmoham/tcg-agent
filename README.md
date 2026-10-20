# tcg-agent

A public, CPU-first Pokémon TCG simulation and learning project. **Full current Standard support is the target and is not complete.** The runnable reference profile has complete seeded games, legal choices, player-safe observations and replay. A pinned public Twinleaf integration executes modern printed-card conformance fixtures. The first bounded imitation checkpoint runs on a private two-deck native profile. It is not a competitive agent.

Open **[the visual tutorial](tutorial.html)** in a browser. It explains what transfers from VGC bots, where existing analytics fit, and which technical decisions remain the learner's work.

The optional [checkpoint table](docs/checkpoint-play.md) lets a human play a saved ordinary-action model through the private native worker, with local Indigo card artwork and board styling. Its helper-controlled setup/prompts and learned opponent actions are labeled separately.

## Run on the desktop

Use Node.js 22 or newer. The measured Windows machine uses Node 24.18.0. There are no package dependencies or install steps.

That dependency-free statement applies to the reference kernel. The optional public-engine conformance tool has a separate pinned preparation step below.

```sh
npm test
npm run demo
node scripts/demo.mjs --replay runs/demo-replay.json
npm run bench -- --games 1000 --repeats 5
npm run eval -- 100
npm run eval:suite
npm run coverage:report
npm run tutorial
```

On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. The demo saves a replay and reports its terminal result. The tutorial preview binds only `127.0.0.1:3849`; stop it with Ctrl+C. The HTML also works directly from disk without the server.

## Full Standard progress

The [versioned coverage ledger](coverage/README.md) inventories 4,996 source printings from 29 current-era set directories. It identifies 3,234 literal H/I/J candidates, **not** the complete legal pool. Exact release availability, older equivalent printings, errata, card semantics and interactions still require review. It verifies zero playable Standard printings for the reference kernel. `npm run coverage:require-full` deliberately exits 2.

The [public Twinleaf integration](integrations/twinleaf/README.md) reuses a pinned broad card/rules corpus. Seven real-engine assertions cover modern evolution, typed Energy, attack resolution, controlled coin outcomes, weakness and last-Pokémon KO. These use constructed midgame states. They are not complete Standard games, seeded engine certification or a policy-ready full-game adapter.

The [optional native adapter](docs/native-runtime.md) reuses the existing Indigo Live headless engine and privately supplied card/game programs. A natural seeded modern-deck game completed with 123 accepted commands and zero rejections. Fresh-process semantic replay matched all 124 frames, both player observations and 63 native seed requests with extra reads. This is the primary local extension path; recovered inputs stay private and external. The public Twinleaf work remains an independent comparator. Full Standard, complete observations and exhaustive legal decisions remain open.

The [native copy experiment](docs/native-copy-optimization.md) preserves fresh detached reads while sharing an immutable serialized input within one seat projection. Explicit copy modes remain pinned in new journals. A bounded comparison tool checks every original frame and player observation before alternating identical baseline/candidate workloads. This read optimization does not provide a continuation-safe search branch.

The [native performance campaign](docs/native-performance-hillclimb.md) adds complete warm games in one retained process, guarded fresh match objects, Release A/B comparisons, command latency and allocation counters. Reset replay preserves all 422 checked frames across four games. A typed-scalar experiment rejected a tempting token cache before production use.

The accepted native optimizations share immutable projection input and avoid copies for proposals necessarily rejected by the pinned turn rules. Every remaining validation receives a fresh graph. Repeated direct native controls, reverted candidates and the unmet 2x working target are recorded in the campaign document. These fixture measurements do not establish training throughput or close the Standard coverage gates.

The [native learning bridge](docs/native-learning-bridge.md) runs fresh audited policy games in 1, 2 or 4 persistent CPU processes and exposes a small actor-visible legal-candidate scorer to one local PyTorch owner. Its first objective is bounded supervised imitation, with whole-game heldout data, checkpoint reload checks and fresh evaluation seeds. Setup and prompts remain with the fixed helper. The [learner instructions](learning/README.md) describe the optional existing Python/CUDA runtime; no packages are installed automatically.

```sh
npm run engine:prepare
npm run engine:smoke
```

Preparation downloads pinned public source into ignored `.cache/` and installs two exact tooling packages with lifecycle scripts disabled. No server or database starts. Without preparation, the optional external-engine test skips explicitly. The [Standard roadmap](docs/full-standard.md) records remaining gates. No source registration count is presented as mechanics correctness.

## What runs

`basic-duel-v1` admits only Machop `base1-52`, Rattata `base1-61`, and basic Fighting Energy `base1-97`. The default deck has four of each Pokémon and 52 Energy. It is a small research deck, not a competitive deck or current Standard format.

Games start with the coin winner choosing who goes first, followed by shuffled 60-card decks, seven-card hands, forced mulligans, face-down setup and six prizes. Decisions include optional mulligan bonus draws, initial Active and bench, turn draws, benching, once-per-turn attachment and retreat, attacks, weakness/resistance, KO, prize selection, promotion and terminal results. Identical copies share one equivalent hand action; different targets and choices remain distinct.

An unsupported card or rules profile raises `UnsupportedMechanicError` at admission. Evolution, Trainers, abilities, Pokémon ex, multi-prize rules, special conditions, special Energy and all other cards are **unsupported**. No card is accepted merely because its name or set is recognized. The factual attack registry and official 2023 core-rule baseline are documented in [research and sources](docs/reuse-and-research.md).

## Use the environment

```js
import { Environment } from './src/environment.mjs';
import { greedyPolicy } from './src/policies.mjs';

const env = new Environment({ seed: 42, record: false });
while (!env.terminated) {
  const observation = env.observe(env.currentPlayer);
  env.step(greedyPolicy(observation));
}
console.log(env.outcome);
```

`observe(player)` exposes the player's hand, public board/discard/counts, the public first-player choice, and that player's offered actions. It hides the opponent hand, deck order, prizes and the seed. Transitions have no global RNG, timers, GPU, filesystem or network dependency. `stepBatch` interleaves independent environments synchronously. It does not launch worker threads.

`replayRecord()` contains privileged decks and a seed for offline debugging. Never put it into policy inputs or training features. `replay(record)` re-executes every action and verifies events and outcome. `record: false` removes logging overhead while retaining identical gameplay. An action budget creates an explicit truncation with no invented winner.

See [the architecture and API boundaries](docs/architecture.md) for phases, equivalent actions, batch failure semantics and versioning.

## Verify and measure

The tests exercise admission, printed attack facts, setup information order, bonus choices, first-turn restrictions, attachment/retreat limits, card conservation, private-world observation isolation, all three terminal reasons, replay tampering, interleaved batches and logless equivalence. The developed-game fixture takes the sixth prize with opposing Pokémon still on the bench.

The default benchmark runs five interleaved repetitions of training and replay-recording modes. Both use complete games with attacks delayed until turn 50 to exercise developed boards and prize sequences. It includes reset, shuffle, policies, masked observations, legal action enumeration and validation. It excludes startup, imports, disk output, replay verification and neural inference. `--short-games` selects the early-attack workload; do not compare the two as if they were the same task.

Each run counts actions, turns, outcomes, errors, truncations and a consumed checksum. Raw results go to `runs/benchmark.json`. [The measurement receipt](docs/benchmark.md) records hardware, exact scope, spread and CPU-profile evidence. These numbers cannot estimate Standard-game or neural-training throughput.

The evaluation runner swaps greedy and legal-random seats on the same seeds. It reports wins, losses, terminal reasons and a paired-seed bootstrap interval. It is a baseline contract check, not a competitive-strength result. It cannot calibrate Live Elo.

The new `eval:suite` runner adds frozen policy versions, exact deck hashes, held-out regression matchups, a weighted opponent pool, fresh policy instances, frozen information-safe inputs and per-cell paired uncertainty. Its tactical action scorer is informed by direct TCG prior art. The initial results are mixed; it is not generally stronger than greedy. See [oracle and evaluation design](docs/oracle-and-evaluation.md).

`node scripts/ladder-records.mjs examples/ladder-records.example.jsonl` demonstrates local record validation. The example is synthetic and counts as zero actual matches. User-entered or exported records stay in ignored `runs/`; summaries retain actual rating metric, observed peaks, season, policy/deck/patch provenance, and observed versus inferred opponent identities. No live adapter runs.

## Connect the existing work

This is the October 18 learning-agent repository, continued with its existing history. [LMLab](https://github.com/haidmoham/lmlab) owns mathematical derivations, learner implementations and interpretation. Link a notebook or commit for each experiment; neither repository depends on the other at runtime.

[Indigo Circuit](https://github.com/haidmoham/indigo-circuit) already ingests tournament decks and computes matchup/card aggregates. Its future export boundary is `deck-corpus-v1`. The implemented strict importer consumes exact set/number/count records and rejects unsupported printings. It does not yet export a Standard corpus or normalize arbitrary set aliases. No private data or previous private engine code is bundled.

[The reuse register](docs/reuse-and-research.md) records inspected assets, Twinleaf/RyuuPlay/CABT alternatives, license gaps, CK49's video, original VGC developer reports and transferable methods. The kernel was selected for tractable correctness scope, not from a claimed speed comparison with other engines.

[Data and baseline research](docs/training-data-and-baselines.md) distinguishes tournament/deck priors from decision trajectories. The frozen native gauntlet uses two exact decks with equal fixture weights because no dated Indigo standings export was available. Its observed metagame coverage stays null. Bounded turn search, information-set rollouts and small-model training remain later gates.

## Stay involved in the technical work

Before each experiment, write a prediction and the observation that would change it. Afterward, explain a failure replay before changing the policy. Assistance can automate batching, logging, tests and plots without supplying the learner's argument.

The next bounded steps are:

1. Complete the dated Standard legality denominator, including reviewed reprints, release differences and restrictions.
2. Extend the seeded local worker's decision and observation audits to every operation family, public Lost Zone, authorized reveals and cumulative history. Retain the public rules engine as an independent comparator.
3. Reconcile its card implementations against the ledger, and verify card effects and interactions before admission. Preserve unknowns rather than accepting plausible behavior.
4. Evaluate a stronger information-set baseline on verified Standard matchups, with frozen opponent pools and deck provenance. Derive learning objectives and interpret results in LMLab. Keep negative results and truncations.

The long-term ambition is at least 2000 competitive Elo in a named TCG Live season. Official sources distinguish Live's progressive and competitive ratings. Offline league Elo has its own opponents and anchor and is a separate metric. No training run, Live rating or ladder result exists here.

## Offline boundary and licensing

This release never logs in to, automates or connects to TCG Live. Future integration requires review of applicable platform rules and a bounded session plan. No credentials, paid compute, large GPU jobs or competition asset downloads are required.

Original code and tutorial are MIT-licensed. Pokémon and card names belong to their owners; this license does not grant Pokémon artwork or data rights. The coverage ledger contains factual printing metadata with its source notice. The repository contains no card artwork, full card texts or private datasets and is not affiliated with Pokémon.
