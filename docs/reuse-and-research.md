# Reuse and research register

Inspected on October 19, 2026. Source claims below are not reproduced competitive results.

## Existing work has separate owners

This repository reuses the October 18 `tcg-agent` project at `e2ae973d21073e456a1a516ca028bf1e7d0e7e3d`. Its complete advertised history contained two commits and two unique files, a learning-plan README and `.gitignore`. No simulator, private dataset, artwork or credential was present. The original author metadata remains in Git history. No history was replaced or force-pushed.

[LMLab](https://github.com/haidmoham/lmlab) owns probability, optimization, mathematical derivations and learner-written experimental interpretation. This repository owns game integration, policies, runners and evaluation. Connect experiments with notebook or commit links. Neither project imports the other at runtime.

[Indigo Circuit](https://github.com/haidmoham/indigo-circuit) provides useful existing analytics rather than battle rules:

| Inspected source | Reusable contribution | Boundary here |
|---|---|---|
| [`ingest/load.py`](https://github.com/haidmoham/indigo-circuit/blob/main/ingest/load.py), blob `29f6a832a55e5d384b8cd9b232e030bb25d1ea90` | Limitless event standings, pairings and deck rows with set, number and count | Export authorized deck records as `deck-corpus-v1`; no scraping or database access from the simulator |
| [`ingest/labs.py`](https://github.com/haidmoham/indigo-circuit/blob/main/ingest/labs.py) | Major-event discovery and deck ingestion | Future curated evaluation corpus with event dates and provenance |
| [`stg_decklists.sql`](https://github.com/haidmoham/indigo-circuit/blob/main/transform/models/staging/stg_decklists.sql), blob `492219294f56bed768b646175f687a051d72ce7c` | Staged card category, name, set, number and count | Resolve exact printings explicitly; name matching alone cannot confer mechanics support |
| [`transform/models/marts/`](https://github.com/haidmoham/indigo-circuit/tree/main/transform/models/marts) | Archetype, matchup and card inclusion aggregates | Future weighted opponent pool and held-out slices |
| [`dashboard/ev.py`](https://github.com/haidmoham/indigo-circuit/blob/main/dashboard/ev.py), blob `f34c13c8f2bbac1ef088fbe201951983b0deead7` | Empirical-Bayes matchup priors and card association estimates | Candidate-deck hypotheses; observed associations do not establish causal card improvements |
| [`ingest/glicko.py`](https://github.com/haidmoham/indigo-circuit/blob/main/ingest/glicko.py) | Historical player-rating work | Evaluation design reference, not a substitute for calibrated offline policy ratings |

The upstream set codes are not automatically this registry's set IDs. The only implemented import boundary expects explicit `base1` printings and rejects every unmapped card. There is no implemented Standard corpus exporter or universal card normalizer yet.

Earlier private simulator and competition projects were inspected as prior art. Their source, modifications, datasets, native binaries and credentials are not included. The retained simulator demonstrated reducers, prompts and an authored terminal fixture, but not broad deterministic Standard conformance. The archived competition scaffold supplied a useful legal-option policy contract, not working simulator source. Public publication of this project does not change those repositories' visibility.

## Candidate engines

| Source | License evidence | Observed interfaces and gaps | Decision |
|---|---|---|---|
| [RyuuPlay](https://github.com/keeshii/ryuu-play) and [Twinleaf](https://github.com/twinleafgg/twinleafgg) | [RyuuPlay MIT license](https://raw.githubusercontent.com/keeshii/ryuu-play/master/LICENSE); retained upstream attribution separately inspected | Rules reducers, card classes, prompts, bots and serializers. Audit exact source revision, RNG calls, prompt continuations, observer projection and legal choices before adoption. A list of playable cards does not enumerate all targets and optional choices. | Strong broader-coverage investigation. No upstream implementation copied into this milestone. |
| [CABT official API](https://matsuoinstitute.github.io/cabt/) | [Kaggle repository Apache-2.0](https://github.com/Kaggle/kaggle-environments/blob/master/LICENSE) does not alone settle every native binary or competition asset | Native Windows/Linux simulator; legal options, masked observations, logs, battle stepping and search transitions. Inspected [Python native wrapper](https://github.com/Kaggle/kaggle-environments/blob/master/kaggle_environments/envs/cabt/cg/sim.py) uses a global Battle holder and exposes no obvious seed argument. Verify per-instance RNG, parallel isolation, card scope and redistribution rights. | Future adapter if rights and reproducibility are established. No install or competition asset download attempted. |
| [TCG ONE contribution repository](https://github.com/axpendix/tcgone-engine-contrib) | Apache-2.0 for contribution source | Maintainer README says the engine is closed and unavailable for local execution by non-staff. | Cannot satisfy an independently runnable public engine. |
| This project's closed kernel | MIT for original code; Pokémon rights remain separate | Complete games, seeded reset, observer-safe choices, public events, replay and synchronous batch stepping for exactly three card IDs. | Selected initial correctness and throughput milestone. No full Standard claim. |

For any broader engine, record a commit and dependency lock before running comparisons. A live link is research provenance, not a reproducible dependency pin. Optional engines run only through explicitly selected, pinned integrations.

## Rules and card evidence

The [official 2023 rulebook](https://assets.pokemon.com/assets/cms2/pdf/trading-card-game/rulebook/par_rulebook_en.pdf) is the core-rule baseline. Setup starts on printed page 8; additional mulligan detail is on page 18. A future release must review later official changes before updating this declared rules profile.

The [Pokémon TCG data project's Base Set record](https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/base1.json) corroborates the three printings' names and numerical mechanics. Only the necessary factual fields were manually transcribed. No artwork, flavor text, scraped collection or bulk dataset is bundled. The source's data licensing does not become MIT because this project's code is MIT. Pokémon and card names remain their respective owners' property.

Machop has 50 HP, Low Kick for one Fighting Energy and 20 damage, Psychic weakness and retreat one. Rattata has 30 HP, Bite for one Colorless Energy and 20 damage, Fighting weakness, Psychic resistance minus 30 and retreat zero. Basic Fighting Energy pays both admitted attack costs. These historical printings are not Standard cards.

## What transfers from VGC

The user supplied CK49's [Bots are Better than Pros at Pokemon. Now What?](https://www.youtube.com/watch?v=VSAeOI0CLx0), published October 15, 2026. The description links social accounts, not engine code or papers. The inspected auto-generated transcript supports these bounded lessons:

- Around 4:50 to 6:15, stripped simulation and mechanics validation make large training volumes feasible.
- Around 12:20 to 16:08, learned value estimates evaluate successor states. Simultaneous VGC actions motivate joint-action payoff search.
- At 13:32, CK49 explicitly distinguishes sequential card games.
- Around 26:28 to 27:47, team candidates face a weighted opponent gauntlet. Incorrect metagame weights optimize an incorrect objective.

The original developer reports provide stronger implementation detail:

- [Nessie123's author](https://www.smogon.com/forums/threads/nessie123-an-ots-vgc-bot-that-topped-the-reg-m-c-bo3-ladder.3789213/) reports topping the open-team-sheet VGC best-of-three ladder. Its training reveals almost all information, while the ladder hidden-information wrapper is described as crude. Double-oracle action discovery, chance branches and learned values transfer as research ideas, not a ready-made TCG algorithm.
- [MikuMiku37's author](https://www.smogon.com/forums/threads/mikumiku37-a-self-play-vgc-bot-reached-1-on-the-vgc-reg-m-c-ladder.3789199/) reports a best-of-one #1 result and describes PPO against a past-policy league and search over sampled worlds. Its engine and weights are withheld. Its claimed speed and training volume are author measurements, not this project's benchmarks.
- [VGC-Bench](https://github.com/cameronangliss/VGC-Bench) is actual [MIT-licensed code](https://github.com/cameronangliss/VGC-Bench/blob/main/LICENSE) for VGC learning and evaluation. Its [paper](https://arxiv.org/abs/2506.10326) shows that held-out-team generalization remains hard even when a fixed-team agent performs well.
- [Metamon](https://github.com/UT-Austin-RPL/metamon) and [Foul Play](https://github.com/pmariglia/foul-play) are useful singles references. Their results are not VGC results.

TCG needs decision-level actions within variable-length turns, stochastic draws, private hands and prizes, and deck identity semantics. Policies and value/search procedures must condition on the information available to that player. Sampling hidden worlds from a belief is different from revealing the true hidden world. A perfect-information critic also needs a deliberate training design, not accidental leaked features.

## The live goal remains separate

Official [1.21.0 patch notes](https://community.pokemon.com/en-us/discussion/14755/version-1-21-0-patch-notes) introduced visible Arceus Elo. Later [July 2025 development-team guidance](https://community.pokemon.com/en-us/discussion/19258/letter-to-the-community-july-10-2025) distinguishes progressive Nest–Ultra Elo and competitive Master League Elo, retaining monthly competitive resets. Define the eventual goal as competitive Elo at least 2000 in a named Live season. No current percentile or tier cutoff is claimed here. A separate offline league's Elo cannot predict the same numeric Live rating.

The official [Pokémon terms](https://www.pokemon.com/uk/legal/terms-of-use), last updated June 15, 2023 when inspected, cover TCG Live. Section 5 restricts unauthorized service automation, reverse engineering and bypassing security. This repository has no Live adapter. Future integration must respect applicable platform rules and the intended session's constraints.

## Structured-data and search follow-up

[Data and baseline research](training-data-and-baselines.md) records inspected Limitless/RK9/Labs relationships, export/API structure, TCGdex facts, trajectory examples and direct search prior art. Tournament appearances support priors; they do not label decisions. No large licensed expert-human decision corpus was verified. The existing Circuit files provide event seeds and format windows, with no dated standings aggregate to justify current metagame weights. Reproducible native trajectories are the immediate experimental source. No sustained training or bulk scrape runs here.
