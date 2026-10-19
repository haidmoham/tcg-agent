# tcg-agent

A public, CPU-first Pokémon TCG simulation and learning project. The first runnable milestone is a fast, headless **restricted rules profile**, with complete seeded games, legal choices, player-safe observations and replay. There is no trained or competitive agent yet.

Open **[the visual tutorial](tutorial.html)** in a browser. It explains what transfers from VGC bots, where existing analytics fit, and which technical decisions remain the learner's work.

## Run on the desktop

Use Node.js 22 or newer. The measured Windows machine uses Node 24.18.0. There are no package dependencies or install steps.

```sh
npm test
npm run demo
node scripts/demo.mjs --replay runs/demo-replay.json
npm run bench -- --games 1000 --repeats 5
npm run eval -- 100
npm run tutorial
```

On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. The demo saves a replay and reports its terminal result. The tutorial preview binds only `127.0.0.1:3849`; stop it with Ctrl+C. The HTML also works directly from disk without the server.

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

## Connect the existing work

This is the October 18 learning-agent repository, continued with its existing history. [LMLab](https://github.com/haidmoham/lmlab) owns mathematical derivations, learner implementations and interpretation. Link a notebook or commit for each experiment; neither repository depends on the other at runtime.

[Indigo Circuit](https://github.com/haidmoham/indigo-circuit) already ingests tournament decks and computes matchup/card aggregates. Its future export boundary is `deck-corpus-v1`. The implemented strict importer consumes exact set/number/count records and rejects unsupported printings. It does not yet export a Standard corpus or normalize arbitrary set aliases. No private data or previous private engine code is bundled.

[The reuse register](docs/reuse-and-research.md) records inspected assets, Twinleaf/RyuuPlay/CABT alternatives, license gaps, CK49's video, original VGC developer reports and transferable methods. The kernel was selected for tractable correctness scope, not from a claimed speed comparison with other engines.

## Stay involved in the technical work

Before each experiment, write a prediction and the observation that would change it. Afterward, explain a failure replay before changing the policy. Assistance can automate batching, logging, tests and plots without supplying the learner's argument.

The next bounded steps are:

1. Differentially compare admitted mechanics against a trusted rules reference, then add a third card with a different Energy requirement.
2. Freeze an observation encoder, a stronger scripted baseline and disjoint training/evaluation seed ranges. Audit each feature for hidden-information leakage.
3. Derive the first small learning update in LMLab, predict a controlled result, then connect it through this decision interface.
4. Add a past-policy league, held-out decks and an Indigo-derived weighted opponent gauntlet as card coverage becomes adequate. Keep negative results and truncations.

The long-term ambition is at least 2000 competitive Elo in a named TCG Live season. Official sources distinguish Live's progressive and competitive ratings. Offline league Elo has its own opponents and anchor and is a separate metric. No training run, Live rating or ladder result exists here.

## Offline boundary and licensing

This release never logs in to, automates or connects to TCG Live. Official Pokémon terms restrict unauthorized service automation; future technical feasibility is not permission. No credentials, paid compute, large GPU jobs or competition asset downloads are required.

Original code and tutorial are MIT-licensed. Pokémon and card names belong to their owners; this license does not grant Pokémon artwork or data rights. The repository contains no card artwork or bulk card collection and is not affiliated with Pokémon.
