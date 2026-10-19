# A closed rules profile before a broader engine

The first milestone asks whether complete games can expose every decision without leaking hidden information. It does not ask whether a policy can beat competitive players.

## The caller controls decisions

```js
import { Environment, stepBatch, replay } from './src/environment.mjs';
import { greedyPolicy } from './src/policies.mjs';

const env = new Environment({ seed: 42 });
while (!env.terminated) {
  const observation = env.observe(env.currentPlayer);
  env.step(greedyPolicy(observation));
}
const verified = replay(env.replayRecord());
```

`observe(player)` returns a new, player-relative value. The environment retains private hands, deck order, prizes, RNG and authoritative state in JavaScript private fields. Policy inputs contain no environment object.

An action is a discriminated object with a revision and a phase-specific choice. `step` accepts exactly an offered action. Invalid, extra-field and stale actions throw before changing state. Structurally identical copies of a printing are equivalent. The action list uses one representative hand index per identical card, while keeping distinct targets, bench slots and face-down prize choices.

`stepBatch(envs, actions)` steps independent environments synchronously on one thread. It supports interleaved learning batches without a process-global RNG. It is not a parallel worker pool or an atomic transaction. Validate a batch before submitting it if all-or-nothing behavior is needed.

## State follows decisions

```text
choose first player
  → draw opening hands and resolve forced mulligans
  → each player selects Active, then optional bench
  → deal six prizes; choose optional mulligan bonus draws
  → optional bench of bonus-drawn Basics; reveal boards
  → turn draw → attach/bench/retreat decisions → attack or pass
      attack KO → prize choice → terminal or promotion → next turn
      failed turn draw → terminal loss
```

The opening choice precedes hand information. Both players observe the declared first player. Opening boards remain hidden until setup completes. Both mulliganing in the same round cancels that round's bonus. In this profile every failed opening hand consists of seven identical Fighting Energy, so the mulligan count fully describes each required reveal. The extra setup bench stage admits only bonus-drawn Basics.

Setup choices run in a fixed seat order. This is an implementation order for simultaneous face-down setup, and observation masking prevents the later seat from seeing the earlier board. A turn can contain several decisions. An attack or pass ends it; attaching or benching does not.

## Compare two whole designs

| Choice | What it owns | Advantage | Unresolved cost |
|---|---|---|---|
| Public Twinleaf/RyuuPlay adapter | Existing reducers and cards plus a new observer/action/seed adapter | Much broader card semantics and existing rule implementations | Audit every prompt, global RNG, mutation and observation channel; private Indigo modifications cannot be redistributed as public work by assumption |
| Closed reference kernel | Small card registry, phase machine, seeded transition function and player observations | No dependencies, complete admitted choices, executable end-to-end correctness scope | Only two historical Basic Pokémon and one Basic Energy; every broader mechanic needs explicit implementation and tests |

Choose the second for the initial executable milestone. This is a scope and auditability decision. No timing comparison establishes that it is faster than Twinleaf or CABT. Keep the environment contract small enough for a later adapter to implement it without forcing policies to understand another engine's objects.

## Module ownership

`src/cards.mjs` owns the exact admitted printings and deck boundary. Card facts do not run arbitrary scripts. `src/environment.mjs` owns game state, legal choices, masked observations and events. `src/rng.mjs` owns a per-game 32-bit counter and integer mixing function for shuffling. `src/policies.mjs` contains replaceable CPU baselines. Scripts own experiments and file output, never game rules.

The rules profile pins modern core setup and turn rules to the cited 2023 rulebook and applies the historical printings' simple attacks. It is a custom research format, not an assertion of current Unlimited or Standard tournament legality.

## Replay and information boundaries

`replayRecord()` is privileged offline debugging data. It contains both original decks and the seed, so it reveals hidden information. Never pass it, the seed, an environment reference or an event-derived hidden feature to a policy. `publicEvents()` contains only public events. Draws, bonus draws and prizes record counts, not card identities.

`replay(record)` verifies the full recorded action/event/outcome sequence by resetting and applying actions again. This is replay from the start, not a mid-game checkpoint API. Records pin engine `0.1.0`, profile and schema. Reject unknown versions. Later rule changes must change the engine or profile version and preserve old fixtures.

`record: false` suppresses action and event accumulation for training. It does not change legal choices, observations, results or RNG. Paired tests compare both modes. There are no timers, random UUIDs, network calls, renderer state or wall-clock decisions in game transitions.

The PRNG is reproducible, not cryptographic. It mixes each counter value before sampling so consecutive small seed numbers do not dictate the same opening coin result. Use disjoint seed ranges for training and evaluation. This generator and this tiny deck distribution are research controls, not guarantees of representative Pokémon play.

## Next changes need evidence

First add a real public engine differential harness or a third admitted card with a distinct energy type. Before adding Trainers or abilities, design all prompts and information disclosures. Before training, freeze the baseline, observations, held-out seeds, reward and error accounting. The learner supplies a hypothesis and an interpretation; automation supplies the runs.
