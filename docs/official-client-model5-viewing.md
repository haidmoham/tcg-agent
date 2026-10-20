# Frozen Model5 viewing handoff

The existing bounded Live controller accepts `--model5` for ordinary decisions and supported visible-card selection rankings. The Model3/Model4 paths retain their original loaders, checkpoints, projections and selection behavior. The decision journal and bounded terminal battle-log capture from `92c7689` are included by ancestry.

## Frozen artifact and local readiness

The corrected pre-RL BC artifact is pinned to checkpoint SHA256 `e439671126e727344fb92fc2d304a967f85fe56d5ac1a4aaa9b0f12b8c9d9607`, authored source revision `8ea9642aca92632bbdf30b040cb260c53a40a272`, and contract SHA256 `3c602ee4e28bc020763d5e375d818c634ba6867662522a5d410116661481f921`. The catalog SHA256 is `c901fed24e13e6e01edbe3c3fbadc57e0f8e0855f24d7a37e43ad6ad0fe6ef4e`.

Necessary checkpoint loading confirmed the native `EntityModelClient` accepts the trusted artifact on CPU: `native-entity-decision/2`, 114,641 parameters, 40 card vocabulary entries and 85 action entries. Its contract has 67 global, 99 entity and 78 candidate dimensions, with maximum 160 entities and 512 legal candidates. The native encoder/runtime own sentinel handling, explicit source/actor/target/parent/origin indices and padding masks. No candidates or entities are truncated. No model inference, tests or simulation/client games were run for this handoff.

Static catalog inspection covers all 60 cards in the public `AgentPult` manifest through the frozen catalog's printing aliases. This establishes vocabulary coverage only; the current client deck, legality, mechanics parity and observed runtime source mapping have not been checked in this task. Exact loaded-deck mechanics verification remains in the existing controller before any future Test Deck launch.

Private `.cache/official-client-model5.json` contains the actual CPU config, source snapshot location, complete source hashes and helper/corpus/deck file hashes. The preparation script obtains only seven authored loader/projection/runtime files from the frozen Git revision into an ignored immutable snapshot, so subsequent trainer edits do not change this loader. It does not copy any datamine corpus, catalog, checkpoint or captured asset into Git. The trainer checkout and checkpoint remain unchanged.

From this worktree, the safe checkpoint-readiness command is:

```powershell
node scripts/official-client-model5-ready.mjs
```

It pings loader metadata, writes `.cache/model5-readiness.json`, closes the model process and has no client import or input route. This command has completed successfully. It is not a performance or gameplay test.

For reconstruction on another local checkout, provide private paths rather than editing source:

```powershell
node scripts/prepare-model5-live.mjs <trainer-root> <frozen-bc-json> <frozen-cpu-config> <private-input-files-json>
```

For reproduction from public main, use `bundled` instead of `<trainer-root>`. The seven authored dependencies from the exact frozen revision are included under `integrations/official-client/model5-frozen-source/`, with byte hashes in its manifest. This option copies those reviewed files into the same fresh ignored snapshot and does not read an active trainer checkout. The private freeze/config/input JSON, checkpoint, catalog, helper, corpus and deck bundle remain required. This frozen viewing snapshot does not publish or replace the trainer's active Model5/Model6 pipeline.

The private input JSON has exactly `frozenHelper`, `cardCorpus` and `deckBundle` paths. Preparation validates the artifact/config/catalog and existing helper hash, creates a fresh authored-source snapshot, writes the manifest once, and sets owned input/runtime kill markers. A prior failed partial snapshot can remain ignored; it is never reused. Re-running against an existing manifest does not overwrite it.

## Actor-visible adaptation

Model5 imports the frozen native projector and encoder from that source snapshot. Its separate Live enrichment retains definition/owner identities for visible cards, correct source-to-target pairs for reparent choices, destination zones and ordinary actor bindings. The adapter uses the already captured SDK `totalEnergy` presentation string and the datamined `MatchUtils.GetEnergySymbol` mapping for typed energy. Composite/unrecognized energy text leaves types unknown. SDK condition names are normalized to the native representation. No raw MatchBoard or opponent hand/deck/prize identity is read.

The datamined `BoardPos` enum identifies active, bench and stadium destination values already carried in offered command IDs. Per-entity source cards come from the existing visible targeting UI; reparent groups retain their visible `sourceCard`. Each projected choice carries both that source and the destination identity, preserving the encoder's binding indices. Card rules come from the pinned local corpus/catalog, not reconstructed image text.

Model5's own `supportsCardSelection` and `rankedPromptAnswers` implement supported unordered cards/Pokemon/select prompts, including minimum hand-cost cardinality. The controller filters duplicate physical selections and retains the complete ranking, selected IDs and resolved client payload in its journal. It never substitutes a teacher answer for a failed supported model choice. The existing runtime performs its final selection validation before submission; a mismatch stops the controller without trying another answer automatically.

Existing setup, recognized text, opaque prize, empty search and damage allocation helpers remain explicitly attributed and pinned to SHA256 `40acf530ca787caaf446f515173b1ed0fd9cd6353e8313f44ac015d705d288b1`. They are not reported as Model5 network decisions. Ordinary model errors or unsupported selections stop without strategic helper overrides. Navigation and acknowledgement remain driver events.

## Compatibility limits

| Domain | Prepared behavior / remaining gap |
| --- | --- |
| Own hand, public boards, attachments, discards, stadium, visible counters | Current rendered-UI observations retained per entity; no live frame was captured in this preparation |
| Card identity/action facts | Frozen catalog and mechanics mapping reused; opponent unknown vocabulary ID zero remains explicit; current loaded printing joins unverified |
| Energy and conditions | Datamine-backed presentation conversion prepared; no live comparison performed; composite energy types remain unknown |
| Ordinary source/actor/target and placement destinations | Explicit bindings retained where offered; UI retreat remains a retreat intent followed by a promotion selection, while native offers can bind a retreat target atomically |
| Reparent source/target pairs | Visible source plus target retained in each choice; native projector preserves both indices |
| Prompt origin | Last returned ordinary dispatch retained across its prompt chain, cleared on turn change; labeled unverified dispatch history, not proof of semantic execution. Direct native selection-origin extraction is unavailable in this Live path |
| Energy/supporter/retreat usage, ability usage | Unknown masks; no inference from an attempted action or missing candidate |
| Entered/evolved this turn | Unknown; the native simulator exposes these flags but this UI adapter has no admitted presentation getter |
| Item lock, expiry, previous opponent-turn KOs, knockout draw eligibility | Explicit unknown masks for both seats; no privileged metadata reads or inferred false values |
| Complex selection constraints / ordered prompts / amounts | Native ranked policy only within its supported domain; final client legality can still differ; existing attributed helpers cover their recorded domain |
| Battle-log/final reason | Included source; normal result UI hook and terminal export timing remain live-unverified |

Native-to-Live feature parity is **unknown**. Loader/contract compatibility and static vocabulary coverage are established; whole-game representation/action parity is not. The viewing run must be described as Model5 under partial Live observations, rather than an equivalent native evaluation. Trainer weak-opponent/Model2/3/4 panels and the decision about starting Model6 remain independent.

## Deferred viewing command

No client process was discovered or attached, no identity config was copied from the old session, no focus/cursor/input was used and no existing match was changed. This worktree's manifest has `clientInputEnabled:false`; input/runtime kill markers remain set. The prepared command therefore stops before client attachment until the handoff is explicitly armed.

After the parent completes the viewing handoff, refresh the private client process/window config for the visible background window, preserve the account and `AgentPult` deck, set the manifest's `clientInputEnabled:true` and remove only this worktree's owned preparation stop markers. Keep human stop markers. Then the single supervised built-in-AI command is:

```powershell
node scripts/official-client-model3-game.mjs --model5 --one-built-in-ai --arm --step
```

At preparation time this command had **not** been run; the later authorized diagnostic is recorded below. Model5 rejects an existing match instead of conceding it and rejects resume without restored origin history. It retains the driver's background-window, identity, stale-state, one-action, rate and timeout bounds. The user can supervise the visible client while working elsewhere; foreground/global input is still prohibited. No public matchmaking or Model6 training is part of this source preparation.

## One authorized diagnostic viewing game, 2026-10-20

After the user explicitly requested viewing and confirmed the current account/deck, the command above ran once using controller source `c5bdbaccbb7f4821341630862e1275013337ee4e` and the same frozen checkpoint. The runtime verified the loaded AgentPult sixty against the pinned mechanics profile and observed a provided-AI/offline match. No existing match was left or replaced.

The client reported a natural Model5 win after 719.095 seconds to the terminal event (719.51 including cleanup), on observed turn 24. This is one diagnostic game against the provided AI, not qualification or a strength estimate. The observed final reason remains unknown: the UI result-presentation observer had not retained a reason when terminal capture ended. Do not infer the win condition from the last retained prize/deck counters.

| Retained evidence | Count/result |
| --- | --- |
| Ordinary Model5 decisions | 46 |
| Model5 visible-card selection decisions | 21 |
| Existing attributed helper decisions | 8 |
| Proposals / dispatches / returned execution results / subsequent-observation links | 75 each |
| Rejected actions / failed requests / controller repairs | 0 / 0 / 0 |
| Attack decisions / Jet Headbutt chosen | 9 / 9 |
| Ordinary decisions offering Phantom Dive / Phantom Dive chosen | 0 / 0 |
| Jet Headbutt decisions with Phantom Dive offered for the same actor | 0 |
| Exportable battle log | One complete snapshot, 398 lines; raw text private |
| Focus activation / shared-cursor input / public matchmaking calls | 0 / 0 / 0 |

The active Dragapult had one visible Psychic Energy (`MEE-13` after catalog normalization), typed energy count one and no attached Fire Energy in **all nine** Jet Headbutt decision records (turns 8, 10, 12, 14, 16, 18, 20, 22 and 24). Thus this trace does not show the network choosing Jet Headbutt over a legally offered Phantom Dive. The journal also retains the five model-chosen energy attachment payloads and their distinct physical targets; two Fire attachments targeted Drakloak, and the later Psychic attachment on turn 18 targeted a benched Dragapult. No attachment or attack was strategically overridden by the driver.

The owned controller and adapter exited normally. Both input/runtime stop markers are set, the private manifest is disarmed again, and the checkpoint hash remains unchanged. The official client was left open. There was no second game, training, model weight update or publication of private logs/assets. Retained raw observations, complete offered/selected payloads, linked decision journal, export and attack review remain in the ignored local game folder referenced by `.cache/model5-live-latest.json`; its local identifier is omitted from this public report. All recorded training eligibility remains false pending semantic execution verification and dataset admission.

The preparation-only statements above describe the earlier handoff. This later authorized game establishes a functioning ordinary/selection viewing path for the observed cases; native-to-Live feature parity and unobserved fields remain unknown.
