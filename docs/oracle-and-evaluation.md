# Rules, beliefs and evaluation

Full current Standard support is the target. The three-card kernel remains a regression reference, not a substitute for that target. A few working decks do not prove that every legal card and interaction works.

## Three different meanings of oracle

A **rules-transition oracle** computes the next game state from authoritative state, action and chance. It needs hidden cards to resolve draws and searches. Its correctness is an engineering claim that requires rule fixtures, differential checks and an explicit coverage matrix.

A **playing policy** chooses from the information available to its player. The appropriate object is a distribution over actions conditioned on the player's information history, not on the engine's true hidden state. An optimal strategy for an imperfect-information game is not generally the best move in one fully revealed deal.

A **privileged critic or diagnostic** may inspect full state in an explicitly labeled experiment. Its labels, training features and evaluation path must be separate. Never supply the actual opposing hand, deck order, prizes, world seed or replay to an evaluation actor. Sampling plausible worlds from a public prior is different from accessing the true world.

## Reuse actual TCG prior art

[PTCG-Bench](https://github.com/zjunet/PTCG-Bench/tree/bc2fdde7dfbe70f824e84dca8e65a1a206ade359) is direct TCG prior art. Its [Charizard heuristic](https://github.com/zjunet/PTCG-Bench/blob/bc2fdde7dfbe70f824e84dca8e65a1a206ade359/ptcgbench/agents/charizard_heuristic_agent.py) scores offered actions, prioritizes prize-aware knockouts, develops its deck's engine and uses seeded tie-breaking. The [paper](https://arxiv.org/html/2605.29653v2) evaluates five deck fixtures. This is useful policy/evaluation work, not evidence of complete Standard coverage.

`tactical-basic-v1` is original code informed by that scoring pattern. It is not a port of the Charizard tables. It scores only the current profile's offered actions using visible damage, readiness, bench development, promotion and retreat. Frozen `greedy-v1` and legal-random remain anchors. No upstream policy source was copied.

Do not import PTCG-Bench's evaluation harness unchanged. The inspected revision initializes Weave during module import, constructs some agents without seeds, and exposes lifecycle metadata such as the opponent-deck label. Its base interface also mentions full state. A detached adapter must define the information boundary rather than inheriting every upstream field.

[Information Set Monte Carlo Tree Search](https://eprints.whiterose.ac.uk/id/eprint/75048/1/CowlingPowleyWhitehouse2012.pdf) addresses the strategy-fusion problem in determinization. [RIS-MCTS](https://arxiv.org/abs/1902.06075) shows that simulated opponent decisions can still leak information. Neither algorithm is an automatic optimal-policy oracle.

A later search baseline should reconstruct a belief from authorized deck priors and observed public history, sample possible worlds, and give each simulated actor only its own observations. Key search decisions by information history. Test that changing a true hidden allocation leaves the evaluation policy's action distribution unchanged when its information is unchanged. That belief/search implementation is not present yet.

## The executable policy boundary

`src/policy-boundary.mjs` constructs frozen `policy-input-v1` values from an audited adapter. It whitelists public fields, copies the acting player's hand, removes the opposing hand and raw engine metadata, and passes public-event deltas since that player's previous decision. New policy instances start each game. Game seeds and independent policy RNG seeds stay with the trusted runner, not in the actor's input.

The boundary currently admits only `basic-duel-v1`. A broad engine must provide an audited observation/action projection before entering this runner. A raw object from an upstream engine cannot bypass that gate merely by being called an observation. This is an accidental-disclosure boundary within trusted application code, not a security sandbox for hostile plugins.

## Freeze a comparison before inspecting it

```sh
node scripts/evaluate-suite.mjs experiments/offline-suite-v2.json
```

The suite pins engine/profile versions, deck versions and normalized card-list hashes, policy versions, opponent weights, seat pairing, seed blocks and budgets. Results contain each played deck, policy, outcome and provenance. Each opponent/matchup cell reports a paired-seed bootstrap interval. Errors and truncations invalidate its score rather than becoming losses. The weighted pool score is not a Live rating.

The committed suite reserves three deck-composition fixtures and distinct seed blocks as held-out regression cases. They are historical Basic-only fixtures, not Standard matchup coverage. There is no trained policy. Do not retune the candidate on these results and then continue calling them a held-out estimate. Add a new untouched block for a confirmatory comparison.

The first frozen run completed 240 games without errors or truncations. The tactical candidate scored 19 wins and 21 losses in the mirror against greedy, and 31 wins and 9 losses against legal-random. The opponent-pool weighted score is 0.6625 across all six cells. This is a mixed baseline result, not evidence that tactical scoring improves on greedy generally. Per-cell results and provenance are in `runs/evaluation-suite-v2.json`; the compact committed receipt excludes private user data.

## Record real observations without inventing evidence

The [local ladder-record tool](ladder-records.md) accepts user-entered or already exported observations. It records wins/losses/draws/unknown outcomes, actual rating metric, season, observed peak, patch and policy/deck versions. Unknown opponent decks stay unknown; inferred archetypes remain separate from observed deck lists. Synthetic examples are excluded from real-result summaries. The tool has no client connection.

The [official July 2025 explanation](https://community.pokemon.com/en-us/discussion/19258/letter-to-the-community-july-10-2025) distinguishes progressive Elo and Master competitive Elo. [Later reset guidance](https://community.pokemon.com/en-us/discussion/19809/2026-competitive-season-changes-in-pokemon-trading-card-game-live) also changes rank resets. Record the metric actually observed instead of deriving it from the outcome or mixing rank points with Elo.

The [October 2026 patch notes](https://community.pokemon.com/en-us/discussion/26277/version-1-43-0-patch-notes) include card-mechanics fixes. Compare printed rules, official rulings and implementation traces when they disagree. A bug in Live is not the definition of correct tabletop rules.

## Supervise before unattended experiments

`src/session-plan.mjs` creates plans only. It performs no client interaction. The default is supervised, one match at a time, at most three matches and 15 minutes. It stops on warnings, unexpected states, disconnects, supervisor input or budget exhaustion.

Pacing variation is bounded rate control and UI-readiness allowance. It is not human impersonation, detection evasion or an anti-cheat technique. Plans record a seed and each proposed pause. Realized timings remain null until an actual permitted executor records observations; this milestone fabricates none.

An unattended plan requires explicit review flags for rules coverage, observation isolation, held-out evaluation, reliability, the intended account/session and the bounded run plan. These flags are review records, not independent certification. Scientifically useful unattended work also needs stable error rates and informative comparisons. No sustained training or live sessions run in this milestone.
