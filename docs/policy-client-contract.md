# Pokemon policy and client driving

The game policy chooses Pokemon actions. The client driver handles the application. A change to window position, focus, animation speed, menu layout, or input transport must not require changing or retraining the checkpoint.

## Caller and ownership

```js
const projector = new PolicyView();
const view = projector.project(playerVisibleGameState);
const choice = await checkpoint.decide({ view });
const action = semanticPokemonAction(view, choice, { kind: 'model', id: 'model2' });
const command = resolvePokemonAction(action, view, projector);
```

`PolicyView` already owns visible-card aliases, legal-offer aliases and the strict player whitelist. `NativeModelClient.decide({view})` already owns the checkpoint's existing 32-state/27-candidate feature encoding. Reuse both. `semanticPokemonAction` freezes a revision-bound semantic action containing the exact selected actor candidate and policy attribution. `resolvePokemonAction` rejects stale or changed candidates and round-trips that identity to the current adapter's raw action ID. It has no UI parameters and cannot choose another candidate when resolution fails.

The existing official-client supervisor calls this contract after model inference, then resolves a separate private mapping to produce its dry-run UI intent. Targets and expected UI transitions stay outside `semanticAction`. The policy sees only `{view}`. The model does not receive the supervisor observation, raw action IDs, window identity, capture times, screen names, control labels or mappings. Native simulation and local UI may continue using their existing `PolicyView.resolve` boundary; the shared semantic envelope is an adapter-side assertion and requires no checkpoint change. Existing frozen comparisons remain unchanged.

The observation adapter creates a player-visible game projection and explicit uncertainty. It must prove official-client legal candidates from visible evidence; native simulator offers cannot supply missing official-client authority. A lobby is not a playing observation. Its `policyView` remains null, and no model decision is requested.

The driver owns client/window identification, display coordinates, capture freshness, visible control mappings, menus, navigation, animations, retries and state synchronization. It executes the already chosen semantic action or reports a driver failure. It does not choose an alternative target, discard, attack, prize or prompt answer to make a UI sequence easier. If an action requires several selections, every strategic selection must already come from the policy or an explicit helper. Unknown or unsupported prompts stop execution.

Helpers have `{kind: 'helper', id, reason}` attribution. They are game policies, not driver fallbacks. The shared semantic envelope admits ordinary actions only. The experimental runtime pilot uses separately attributed setup/text/entity helpers and native selection validation; this does not certify complete prompt coverage or extend the ordinary envelope. No helper may manufacture an official-client prompt answer from a separate native simulator state.

`ActionExecutionLedger` records recommendations separately from verified game decisions. A recommendation is not a training example. Driver failure, cancellation, dry-run completion and authored fixture transitions never become model decisions, losses or rewards. Only an explicitly verified real game transition can produce an eligible model decision; helper decisions are counted separately and retain their reason. Audit entries record attribution and a semantic hash, without raw cards, UI errors or account data. The [pilot receipt](official-client-ai-pilot.json) distinguishes 12 model intents, 10 per-session verified transitions, and 2 unverified intents. No live-client examples were exported for training.

## Alternatives and constraints

| Design | Representation and ownership | Cost |
|---|---|---|
| Let the model emit clicks or UI scripts | Policy learns screen layout, focus, transport and timing | Couples learning to one client; driver errors contaminate policy outcomes; rejected |
| Reuse `PolicyView` and add a semantic action assertion before driver mapping | Policy owns strategic choice; adapter owns legal authority; driver owns execution | Keeps checkpoint and existing native comparisons fixed; requires explicit mappings and prompt admission; chosen |
| Replace all environments with a new universal game-state schema | A new facade duplicates existing aliases, candidates and feature contracts | Broad migration and drift without solving the current control route; rejected |

The semantic action is deliberately narrow and uses current candidate identity. It does not infer card legality or erase uncertainties. State timestamps and freshness belong to the coordinator, outside the policy's view. Driver retries, when permitted after definite non-execution, reuse the same semantic action and never request a new strategic choice merely because a transport failed. Uncertain sends stay pending and cannot be retried automatically.

## Verification and current limits

The following window-message experiments are historical. The separate scoped runtime route later entered the [user-stopped AI pilot](official-client-ai-pilot.json). No further game is authorized, and both kill markers remain set.

Contract checks exercise exact candidate/adapter round trips, changed targets at the same revision, stale revisions, illegal choices, explicit helper attribution, model-input isolation, impossible driver mappings, and driver-failure accounting. The supervisor's existing tests cover stale observations and transitions separately. Its dry-run fixture is authored and cannot count as a real game action.

The actual client is on Display 2, whose horizontal range is negative. `ClientToScreen` already handles that position. A fresh capture eventually confirmed actual client foreground, resolving the earlier observation question. A later global-input Decks proposal correctly stopped when focus changed before input. The user's requested visible-background route was tested independently: normal `PostMessageW` mouse messages worked on an owned fixture window without moving the cursor or focus. The official window accepted the three queued messages but remained on Home across three new captures. That is an unverified execution, not successful navigation. Its pending receipt is preserved, no automatic retry is allowed, and no global-input fallback is used. Background observation works; background official-client input is not ready.

Windows documents that [PostMessage queues a message rather than waiting for processing](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew), and [mouse-button messages carry client-relative coordinates](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-lbuttondown). Queue success alone cannot certify that this Unity client handles those messages as gameplay input. No client hook, process-memory read, integrity-policy change, driver installation or security bypass was used.
