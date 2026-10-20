# AgentPult supervised bridge

This integration adds an offline dry-run boundary, private Windows capture, a read-only observation service, and a scoped background runtime adapter for the official Pokémon TCG Live client. The [pilot receipt](official-client-ai-pilot.json) records one built-in AI game with 12 Model2 action intents and 8 attributed helper intents. The user stopped the game; no win, loss, autonomous completion or strength result is assigned. Controller and adapter processes exited with kill markers set. No further client game is authorized. See [the sample](official-client-sample.md) for the final runtime scope.

The readiness observations below describe the earlier capture and dry-run stages. Their unknowns and blocked window-message route are historical evidence, superseded for the experimental runtime route by the pilot receipt. Full prompt coverage and reliable autonomous completion remain unverified.

## Evidence and readiness

The initial supported automation inventory returned Chrome tabs and no native apps. Its native APIs remain disabled, and this runtime exposes no `node_repl` tool for `@oai/sky`. After the user explicitly requested a local capture implementation, a separate read-only Windows adapter resolved the pixel-capture gap. [Capture instructions and verification](official-client-capture.md) describe the tested route. It uses the normal Windows `PrintWindow` API, sends no input, and requires no security setting changes or installation. Current native pixels were inspected directly. A standard accessibility probe returned no visible controls. The new [thin observation service](official-client-observation.md) continuously captures and recognizes the Home lobby. Its separate navigation adapter remains paused because background input has not produced a verified transition. See the source-bound runtime audit for the exact internal interfaces and the missing process connection.

The parent reports that the signed-in test account has AgentPult active, 60 of 60 cards, Standard, from its earlier inspected screenshot. `reportedLobbyFixture` retains that report as a fixture. The new direct window capture separately confirms Home, Ranked selected, AgentPult selected, and no current match. Its pixels and full receipts remain private under ignored `.cache`. A lobby has no ordinary policy action; it cannot be mapped into a playing state by inventing board values. No screenshot or private client asset is published.

The exact historical deck manifest is [agent-pult.json](../integrations/official-client/agent-pult.json). The parent supplied the verified readable export. The [Limitless page](https://labs.limitlesstcg.com/0071/player/0103/decklist) independently identifies Andrew Hedrick, first place, 14-2-0. The supplied [official results page](https://www.pokemon.com/uk/news/2026-pokemon-world-championships-event-results) returned an iframe shell to this task's text extractor. Exact currently loaded printings and current Standard legality remain separate unverified gates.

The [compatibility report](official-client-compatibility.json) compares exact printing IDs with the pinned local bundle's existing joins. A join is source availability evidence, not an executed effect or prompt conformance test. Fifteen of 24 distinct printings join; nine do not. Missing exact joins do not establish missing mechanics. The [reprint audit](official-client-reprints.json) compares all static fields of captured official programs, excluding only printing source ID, logic source ID, release date, and action GUID. Eight of the nine gaps have identical captured mechanics to pinned printings, including all three basic Energy cards. Thus 23 of 24 card types have exact or equivalent static mechanics in the frozen profile. The one distinct version, JTG-120 Dunsparce, is now admitted and tested in a [separate offline extension](official-client-dunsparce.md), bringing local static mechanics availability to 24 of 24. That extension does not change the frozen package or certify full-deck gameplay. The exact historical deck manifest remains unchanged.

The explicit equivalence map is ASC-158 to TWM-128, ASC-159 to TWM-129, ASC-160 to TWM-130, ASC-99 to TWM-95, ASC-184 to TEF-144, MEE-2 to MEE-10, MEE-7 to MEE-15, and MEE-5 to MEE-13. [Dreepy](https://limitlesstcg.com/cards/ASC/158), [Drakloak](https://limitlesstcg.com/cards/ASC/159), [Dragapult ex](https://limitlesstcg.com/cards/ASC/160), [Munkidori](https://limitlesstcg.com/cards/ASC/99), and [Buddy-Buddy Poffin](https://limitlesstcg.com/cards/ASC/184) pages corroborate their reprint groups and H regulation marks. [JTG-120](https://limitlesstcg.com/cards/JTG/120) describes a distinct 70 HP Dunsparce with Trading Places and Ram, with an I mark. No card version is silently substituted. Every exact-deck gameplay and official UI mapping remains unverified. The offline fixture deliberately sets synthetic compatibility flags and is labeled authored throughout.

## Architecture and data

The existing `PolicyView` owns the frozen player whitelist, visible card aliases, and current revision offer aliases. `NativeModelClient.decide({view})` consumes its ordinary action view through the existing 32 state and 27 candidate feature contract. The selected candidate resolves back to one current raw action before its corresponding UI target is proposed. Native engine offers cannot establish legality in the official client.

`VisibleObservation` uses schema `official-client-observation/1`. It records capture time, source, window identity and focus, deck display name, screen, unknown fields, compatibility checks, a player policy view, and current action-to-control mappings. A future supported UI adapter must populate it from visible evidence. It must never inspect opponent hidden hands, deck order, face-down prizes, credentials, process memory, or privileged simulator state. The thin service implements a conservative Home-lobby observation only. It leaves the playing policy view, exact loaded printings, and gameplay mappings unknown.

The caller is `arm()`, `await propose(observation, model)`, inspect the returned proposal, and `step(proposal.id, freshObservation)`. `pause()` invalidates pending work. `kill()` terminates the session permanently. The class owns a single state machine with disarmed, armed, proposed, awaiting-transition, paused, and killed states. It now requires explicit background visibility (`visible: true`, `focused: false`), matching the user's invariant. Production foreground/global input routes have been removed; the input pause marker is independent of read-only observation.

The supervisor rejects stale observations, changed windows or focus, unknown fields required for play, missing compatibility, unsupported prompts, foreign candidate IDs, missing control mappings, and changed state before step. It bounds action rates and transition waits. A dry-run step returns `execution: not-sent`. It consumes its proposal and waits for an expected synthetic transition. It does not accept a client-input callback. Captures, account data, hand identities, raw model replies, and error contents are excluded from audit events.

Model2 remains a tiny ordinary-action behavioral clone. Its checkpoint SHA-256 is `144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b`. `verifyModel2` verifies that hash and the receipt's 1,953 parameter, 32 state, and 27 candidate contract before starting inference. Setup and prompt helpers from the native two-deck profile are not certified for official-client use. Unknown prompts stop this bridge.

## Run the offline slice

From this checkout, run the deterministic fixture replay.

```powershell
node scripts/official-client-dry-run.mjs
node --test tests/official-client-bridge.test.mjs
```

The original private config named a missing interpreter. An installed Python 3.12 interpreter with torch 2.12.0+cpu successfully ran this checkpoint. The native Python helper requires weights under this checkout's ignored `runs` directory. Supply an existing interpreter and a byte-identical local checkpoint; model weights and machine-specific configurations are not distributed.

Run the verified local CPU config with the original UI receipt.

```powershell
node scripts/official-client-dry-run.mjs --model-config .cache/model2-cpu-config.json --model-receipt runs/model2/ui-receipt.json
```

To reproduce that local configuration in a new checkout, copy the original frozen checkpoint into its ignored `runs` directory. Verify its SHA-256 against `model2Sha256`. Create an ignored JSON config with an existing absolute Python executable path, the local absolute checkpoint path, `seed: 1729`, and `device: "cpu"`. No packages were installed for this pass. The CPU runtime differs from the training receipt's CUDA runtime. This verifies the inference contract and target mapping on one authored one-candidate state, not model strength or numerical equivalence across runtimes.

Add `--interactive` for the offline terminal controls. `arm`, `propose`, `step`, `pause`, `kill`, and `quit` operate only on authored fixtures. A proposal displays its action kind, target label, and expected transition before `step`. There is no live mode flag. Rebuild the reprint evidence with `node scripts/official-client-reprints.mjs <local-research-root>`. Rebuild the printing report with the explicit local `printing-joins.json` path, `docs/official-client-reprints.json`, and `docs/official-client-dunsparce-verification.json` passed to `node scripts/official-client-compatibility.mjs`.

## Historical cohort plan and current stop

The read-only lobby capture and visible-background observation service tests are complete. The client was verified on Display 2, and actual foreground was subsequently confirmed. The user now requires the client to remain merely visible while they work elsewhere. Observation supports that mode. The separate window-message input probe did not produce the expected Decks screen; its uncertain outcome remains pending, with no automatic retry or global-input fallback. See the [current background-control evidence](official-client-background-verification.json). The screenshot confirms the selected display name, not the exact 60 printings or legality. Map only visible fields and retain unknowns.

The earlier plan allowed up to three built-in AI games after technical gates. The later user stop superseded continuation of that plan. The experimental adapter entered one game and then stopped; another game or resumption requires a new user request. Public matchmaking remains outside the adapter scope.

The retained plan used 15-minute games and a 60-second progress guard. Preserve every attempt's duration, actions, outcome, termination reason, helper decisions and interventions. Official seeds remain unknown. The interrupted pilot with adapter repairs does not meet a clean acceptance gate and cannot support a universal win guarantee.

For a separately authorized runtime session, the private UI config must supply `corpusPath` for the hash-verified local corpus. Frida must already be importable in the configured Python, or `fridaRoot` must identify an existing installation. The probe accepts the same path through `--frida-root`. No package, corpus, client or credentials are downloaded by these scripts.

The throughput checkpoint kept capture discovery first, split the manifest and supervisor into disjoint files, serialized shared observation schema changes, and used one implementation owner for the state machine. Capture now works. The remaining prerequisites are a verified input route consistent with visible-background operation, exact loaded-deck verification, playing-state observation, and complete action/prompt coverage. See the [current observation and navigation evidence](official-client-observation.md).
