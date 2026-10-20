# Frozen Model3 and Model4 qualification

Neither model reached five uninterrupted consecutive built-in AI wins. The [sanitized receipt](official-client-frozen-qualification.json) preserves every start, outcome, attribution and timing definition. Raw observations, decisions and receipts remain in ignored private cache folders.

| Candidate | Actual completed outcomes | Qualification result |
| --- | --- | --- |
| Model3 PPO update 39 | One loss, then one win; both diagnostic or driver-interrupted | Not qualified. Two earlier stalled starts were also retained and left through ordinary concession. Four total starts; none discarded from the record. |
| Model4 BC actor | Win in 10m41s, then loss in 19m09s | Failed at its first loss. Best streak 1/5; zero driver rejections or interruptions in either game. No third game started. |

The extra Model3 start after its diagnostic loss followed the then-current instruction to begin a clean qualification after diagnostics. A later instruction stopped further Model3 starts. Its last owned game was safely resolved as a win after admitting Phantom Dive's damage prompt; that interrupted win was excluded from qualification.

Model3's last win selected five evolutions and four Phantom Dives. Model4 selected five evolutions/four Phantom Dives in game 1 and seven evolutions/two Phantom Dives in game 2. These are model intents. Card selection uses the frozen BC selection model; setup/text prompts and the frozen native teacher's blind-prize, empty-search and damage-allocation responses remain explicitly attributed helpers.

Model4's loss ended on turn 37 with an empty own deck and one prize remaining, while the AI had three cards in deck and four prizes remaining. Its final active Munkidori had no Energy; its last decisions offered neither attack nor retreat. Recon Directive and End Turn continued until the terminal frame. This is consistent with deck-out, but the exact exported end-reason text was not captured. No manual target, Energy, attack or retreat override rescued the policy.

Model4's measured inference wall time was 0.133s and 0.352s; driver RPC wall time was 17.522s and 39.138s. Whole-game elapsed time additionally includes AI actions, animations and bounded waiting. Model3's elapsed times include repair pauses and are not comparable as clean play-time measurements.

The bridge admits the same 224-state/191-candidate contract with `PpoModelClient` for Model3 and `CardActionModelClient` for Model4. Both use the exact AgentPult 60-card mechanics and explicit printing equivalences. Final hashes confirmed both actors and their shared selection checkpoint unchanged. No training or test suites ran during these attempts.

All games used the normal Test Deck path. Client focus and the shared cursor were preserved, opponent hidden information was excluded, and raw assets were not published. The owned controller/adapter processes exited and input/runtime stop markers remain set. This is a practical gate result for the observed model/helper/bridge combination, not a strength estimate or complete prompt-coverage claim.

## Public source integration

The source and receipt were integrated from bridge commit `e73fbc8a5b3d7baa92c26a2f04a611a04a2ade39`. Receipt game numbers preserve chronological order while omitting local identifiers. Driver/helper hashes describe the source used during qualification. Publication replaces personal paths with explicit ignored configuration and uses the already integrated model-loader modules; it also synchronizes the adapter's admitted-action metadata. These publication changes were reviewed statically only: zero tests, model workloads, games or client actions ran during integration.

Any future authorized run requires the existing private inputs. In ignored `.cache/official-client-frozen-config.json`, provide string paths for `model3Config`, `model4Config`, `selectionConfig`, `frozenHelper`, `cardCorpus` and `deckBundle`. Paths resolve from the checkout root. Model configs retain their existing model-client schema and must refer to the pinned checkpoints; the helper must match the receipt's hash. The shared selection checkpoint is frozen for both candidates. The existing ignored `.cache/client-ui-config.json` supplies the explicitly selected Python runtime and client identity. Neither configuration nor its private inputs belong in Git. This documentation does not authorize another game or training run.
