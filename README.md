# tcg-agent

A learning project for building and evaluating an agent in an offline Pokémon TCG simulator. The eventual goal is a neural agent; the first milestone is proving that a simulator exposes a correct, testable decision interface.

**Status:** planning scaffold only. No simulator adapter, training run, or playing-strength result exists yet. Simulator selection is open.

## Connected to LMLab

[LMLab](https://github.com/haidmoham/lmlab) is the companion learning lab.

- **LMLab owns:** general math, probability, optimization, and machine-learning experiments, including the learner's derivations and explanations.
- **This project owns:** game-specific simulator integration, observations and action adapters, baselines, training experiments, and evaluation.
- Connect experiments with links to the relevant LMLab notebook or commit; link back from that learning note when appropriate. Do not duplicate notebooks or make either repository a runtime dependency of the other by default.

For each experiment, the learner writes their prediction before the run and their interpretation afterward. Assistance can help with infrastructure and checks without replacing the learner's derivations, hypotheses, or conclusions.

## Boundaries

- Offline simulation first. No Pokémon TCG Live client automation, account play, credential handling, or matchmaking integration.
- Review simulator and data licenses before using or redistributing them. A competition-only license is not permission for an independent project.
- No paid infrastructure or large training jobs in the initial scope.
- Do not bundle copyrighted card art or scraped card collections. Record provenance and permitted uses for any future assets or data.
- Do not equate success in a restricted simulator or matchup with general competitive strength.

Pokémon's [terms of use](https://www.pokemon.com/uk/legal/terms-of-use) are relevant to the live-client boundary. This project is independent and is not affiliated with or endorsed by Pokémon.

## First experiment: simulator feasibility

**Question:** Can a candidate simulator support reproducible, rules-correct episodes with only the information a player is allowed to observe?

Start with two fixed decks and a CPU-only baseline. [Twinleaf](https://github.com/twinleafgg/twinleafgg) is a candidate to investigate, not a selected dependency. Its [game state delivery code](https://github.com/twinleafgg/twinleafgg/blob/main/ptcg-server/src/game/core/game.ts) can pass raw state to non-socket clients, including bot clients. The first adapter test must prove that opponent private hand contents, deck order, prize identities, and private logs/prompts cannot leak into policy inputs. Pin and recheck the exact revision when implementation starts.

Before implementing an adapter:

1. Record the candidate's source URL, exact revision, license, supported rules/card coverage, and gaps. Prefer a narrow, documented matchup over claiming full-game coverage.
2. Define the player-visible observation. Keep opponent private hand/prize contents and hidden deck order out of policy inputs and training features. Privileged debugging state must remain separate.
3. Enumerate every legal choice, including multi-stage prompts, targets, optional decisions, and passing where supported. A list of playable cards alone is insufficient.
4. Verify reset/seeding, action application, terminal results, and deterministic replay. Compare rule fixtures with expected outcomes before running learning experiments.
5. Run a legal-random baseline on a small, fixed scenario suite. Log simulator errors, illegal choices, unresolved prompts, truncations, and terminal outcomes separately.

**Go/no-go:** proceed only when the selected scope has license clarity, complete action handling, observation-isolation checks, and replayable episodes. Document unsupported cases; a timeout is a truncation, not an invented win or loss.

## Learning sequence after feasibility

1. Establish legal-random and simple scripted baselines with frozen versions.
2. Choose one modest learned policy experiment only after the observation/action interface passes checks. Explain the objective and derive the update in LMLab before wiring it into this project.
3. Evaluate on held-out seeds and scenarios, report the number of games, wins/losses/draws/truncations, uncertainty, and compute used. Separate training opponents and evaluation opponents; account for turn-order effects.
4. Inspect failures and change one factor at a time. Preserve negative results and avoid tuning on the final evaluation set.

## Experiment record

Use this short record for the first real experiment; create a results file only when there is something to record.

- Question and learner's prediction:
- LMLab derivation/reference link:
- Simulator revision, rules scope, and license:
- Observation/action contract and checks:
- Baseline, seeds, split, and run budget:
- Commands, dependency versions, and project commit:
- Measured results and uncertainty:
- Learner's interpretation and next question:

There are no dependencies to install or training commands to run at this stage. Add code and directories only when the feasibility experiment needs them.
