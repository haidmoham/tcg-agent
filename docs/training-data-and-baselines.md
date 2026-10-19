# Data and baseline research

Decks, results and decisions have different uses. Tournament frequency supplies opponent/deck priors. It does not label the best action in a position. Policy training needs reconstructed player information, legal decisions and authorized trajectories. Reproducible simulator trajectories are the immediate source here; no sustained training has started.

## Structured sources

| Source | Verified structure | Useful boundary and limits |
|---|---|---|
| [Limitless event 581](https://limitlesstcg.com/tournaments/581) | Links [RK9](https://rk9.gg/pairings/LO001-piALjQswPD3x0J) and [Labs standings](https://labs.limitlesstcg.com/0076/standings) | Treat these as views of one event. Deck/result priors, not action trajectories. |
| [Pokedata exporter](https://github.com/JulienGitHub/Standings) | Derives RK9 JSON/CSV with placing, record, resistances, decklist, drop and rounds | GPL code does not license upstream data. Direct exports returned 403 during research; no bypass was attempted. |
| [PlayLimitless API](https://docs.limitlesstcg.com/developer/tournaments.html) | A bounded sample tournament returned 17 decklists and 42 pairing rows | Observed header was 50 requests per five minutes. Respect the current service limit. No bulk ingestion runs here. |
| [TCGdex](https://github.com/tcgdex/cards-database) | MIT catalog facts and a verified [card API sample](https://api.tcgdex.net/v2/en/cards/sv03-125) | The coverage ledger uses a pinned source projection. Catalog metadata does not execute effects or certify dated legality. |
| [PokémonTCG.io](https://docs.pokemontcg.io/getting-started/rate-limits/) | Documentation announces deprecation, no new keys, existing access through March 1, 2027 | Avoid making this a new dependency. |

Canonical event identity should retain RK9 ID, game, division and date where available. Preserve match versus game, best-of-three structure, byes, ties, drops and rematches. A decklist ID can be reused across players/events and is not a participation ID. Keep tournament, participant, deck version, match, card and decision tables distinct. Hold out by event/date/deck/player, with games from one match kept together.

No large licensed expert-human Pokémon TCG decision corpus was verified. A [sample JSONL](https://github.com/1ulce/PTCG_AI_Battle_Client/blob/main/docs/sample-match/raw.jsonl) contains 440 events, 42 state/legal-action pairs and 23 prompt choices, but uses a fixed-strategy Dragapult bot. It is a schema reference, not expert labels. Token fields require redaction and persistent entity identities require a leakage audit. A [human battle-log sample](https://github.com/kagd/pokemon-tcg-battle-replay/blob/master/sampleBattleReplays/battle.txt) shows own draws/hand and masked opposing information, but cannot reconstruct every state and had no verified repository license during research. Neither dataset is imported here.

## Reuse Indigo Circuit's analytical boundary

The inspected local Circuit checkout contains event seeds and format windows, but no observed standings warehouse/export. Its 68 event seeds end May 31, 2026 and its ten format windows end June 12. Those files cannot establish October opponent frequencies.

Circuit's expected-value code counts deck appearances and normalizes a filtered population, including a minimum-appearance threshold. The major meta endpoint truncates archetypes and sprite labels can collapse variants. A reproducible aggregate export therefore needs an explicit event window, canonical event IDs, distinct participation denominator, unknown-deck count, exclusions, precise archetype mapping and snapshot time. Retain original shares before renormalizing an admitted subset.

The initial native gauntlet uses two exact supplied deck builds with designed equal weights. Its observed metagame shares and retained coverage remain null. This is a balanced fixture comparison, not an Indigo-frequency-weighted league. A dated aggregate export can replace those weights without coupling the simulator to the analytics warehouse.

## Baseline progression

The practical sequence is reliable resets/actions/observations/logs, frozen heuristic opponents, a dated deck gauntlet, bounded search, and then a small learned policy with held-out evaluation. Preserve past policies in an opponent pool when training is justified. The existing tactical and native heuristic runs remain baselines, with negative results retained.

[Reinforced Greediness](https://github.com/ronaldosvieira/reinforced-greediness) provides MIT-licensed LOCM current-turn best-first search and a linear hand evaluator. The [competition archive](https://github.com/acatai/Strategy-Card-Game-AI-Competition) and gym-locm are methodological references, not Pokémon rules. A later desktop experiment can compare heuristic play, bounded turn search and sampled rollouts under equal wall-clock budgets.

[ISMCTS](https://eprints.whiterose.ac.uk/id/eprint/75048/1/CowlingPowleyWhitehouse2012.pdf) samples possible worlds from player information/history and addresses strategy fusion. Simulated opponents also need their own information boundaries. [Learned-evaluator work](https://arxiv.org/abs/1808.04794) motivates search-guided teachers; any GPL implementation needs a separate license decision. [ByteRL](https://arxiv.org/html/2303.04096v1) used 24 V100s and 14,400 CPU cores for roughly 72 hours, while its MCTS ablation used true hidden state. That setup is neither a desktop compute budget nor a fair imperfect-information baseline for this project.

The [Nessie developer report](https://www.smogon.com/forums/threads/nessie123-an-ots-vgc-bot-that-topped-the-reg-m-c-bo3-ladder.3789213/) supports compact networks, search labels and opponent diversity as design ideas. Its ranking is author-reported VGC evidence and does not establish TCG performance. No search, distillation or learned self-play policy is implemented in this increment.
