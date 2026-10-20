# Shadow play against recorded expert decisions

`scripts/shadow-play.mjs` evaluates one checkpoint or trusted local policy against both recorded players. Each JSONL row is an independent pre-action position from the human trace. A model prediction never advances the benchmark state. The next row restores the recorded human position by construction. This does not reconstruct an exact simulator trajectory or run a counterfactual match.

The [official EUIC final](https://www.youtube.com/watch?v=E1mkPbOgsPY) and [matched official decks](https://www.pokemon.com/us/play-pokemon/internationals/2024/europe/tcg-masters) are the pilot sources. The [source manifest](../benchmark/euic2024-finals-source-v1.json) records local Chrome playback, five inspected first-game frames, readable deck sections, and the annotation blocker. There are **zero real decision labels**. Complete actor hands, decision boundaries and legal alternatives were not certified. Five sampled frames are not five labeled decisions, so real decision coverage has an unknown denominator. The conditional ten-window pilot stopped at this information gate.

## Run the synthetic example

Use Node.js 22 or newer. No install, native worker, Python, GPU, video download or training command is needed.

```sh
node scripts/shadow-play.mjs validate examples/shadow-decisions.synthetic.jsonl
node scripts/shadow-play.mjs evaluate examples/shadow-decisions.synthetic.jsonl --adapter examples/shadow-policy.mjs --top-k 2 --output runs/shadow-synthetic.json
node --test tests/shadow-play.test.mjs
```

The example contains two constructed decisions, one for each seat. Its first-candidate policy has no trained weights. Its agreement score only verifies the evaluator. Reports retain separate synthetic and stream counts. Do not compare a synthetic score with expert play. Reports can be saved only to a new file directly inside ignored `runs/`. Existing reports are never overwritten.

## Record contract

The version is `shadow-decision/1`. The [JSON Schema](../benchmark/shadow-decision-v1.schema.json) describes each row. `validateDataset` in [shadow-play.mjs](../src/shadow-play.mjs) also enforces temporal, split, identity, mask and scoring invariants. `parseJsonl` validates the entire file and reports line and field errors.

| Field | Meaning |
| --- | --- |
| `source` | Video URL and ID, pre-action and action-end milliseconds, actual frame verification and evidence. Chapter markers alone are insufficient. |
| `players`, `actorSeat`, `gameId` | Stable identities for both seats, current actor or null, and the recorded game. |
| `observation.facts` | Whitelisted public or actor-known facts, known-at times and annotation evidence. Values are scalars or scalar arrays. Card details can use ordered string descriptors that the chosen projector explicitly understands. |
| `observation.actorHand` | Complete actor hand identities or an explicitly masked unknown hand. An unknown hand is not an empty hand. Repeated card IDs represent multiple copies. |
| `observation.publicState`, `masks` | Completeness evidence and field-specific unknown reasons. Missing information blocks inference. |
| `candidates` | Stable action IDs, structured actions, independent legality evidence and a completeness declaration. An observed list of plays is not an exhaustive legal offer. |
| `human` | Exact, ambiguous or unknown action label, confidence and verification. Ambiguity is epistemic, not a claim that all listed moves are optimal. |
| `review` | Independent reviewer, explanation and action-specific mistake points. Absent reviews assign no points. |
| `future` | Later reveals and outcome labels. These never enter policy requests. |
| `rules`, `decks` | Dated profile evidence, official deck sources and exact printing identity sets for both seats. They are provenance, not simulator admission by themselves. |

Use null fact values with a corresponding mask for unknown fields. Arrays contain only known values; a null member is rejected. Incomplete hands contain no guessed identities. Public prize counts are allowed; prize identities, deck orders and opponent hand identities have no approved fact keys. Observation facts and actor hands must have `knownAtMs <= preActionMs`. Future reveals must be later. Known values cannot also be masked.

Annotations and adapter code are trusted local inputs. Structural validation cannot prove that a human transcriber used only actor information or that a free-text public descriptor tells the truth. Review the source at the pre-action cut. Do not use spectator opponent-hand or prize overlays, commentary that reveals hidden cards, later searches, future reveals or match outcomes to fill earlier inputs. Record actor-authorized knowledge only when it was available by that cut. Exclude ambiguous hidden information rather than infer it from later success.

All rows are `benchmarkOnly: true`; only `validation` and `test` splits are admitted. Assign whole matches or whole events to a split. Adjacent frames from one match cannot cross splits. If any row declares an event split, the entire event remains in that split. Stable match/player identities and strictly increasing per-game times prevent duplicate windows. Training exports do not exist in this evaluator.

Pass `--training-manifest FILE` to check declared training IDs before inference:

```json
{"schema":"shadow-training-manifest/1","eventIds":["training-event-a"],"matchIds":["training-match-a"]}
```

Any event or match overlap fails. Without that manifest the report explicitly says `overlapChecked: false`. Disjoint declared IDs do not prove unknown checkpoint training history. Keep the entire benchmark event out of data collection, tuning and training. The shadow schema differs from the native numeric training schema, and the native record parser rejects it. Deliberately stripping provenance or relabeling data could defeat these boundaries and is outside the validator's guarantees.

## Policy adapter

Provide an ES module with a default adapter or named `adapter` export:

```js
export default {
  schema: 'shadow-policy/1',
  observationSchema: 'shadow-observation/1',
  policyId: 'my-policy/1',
  checkpointId: 'sha256-of-frozen-checkpoint',
  supportedProfiles: ['reviewed-rules-profile'],
  supportedCards: ['exact-set:printing'],
  async create({ checkpoint }) {
    return {
      async decide(input) { return { actionId: 'offer-id' }; },
      async close() {},
    };
  },
};
```

The evaluator creates a fresh policy for every eligible window and awaits its close method. Both players use the same adapter and checkpoint argument. This prevents accidentally retaining recurrent state across private seat views when the adapter honors the factory contract. Local adapters must bound their own inference and shutdown and must avoid global mutable policy state. This is not a sandbox for hostile plugins.

The deeply frozen input contains only `schema`, `actorSeat`, `observation` and `candidates`. Fact evidence, timestamps, source URLs, player names, human actions, future labels, reviews and legality notes never enter that input. Candidates contain only ID and action. Known-illegal diagnostic candidates are withheld. An adapter may return `{abstain: "reason"}` or `{actionId, ranking: [ids]}`. Rankings must start with the selected action, contain unique candidate IDs and remain in ranked order. A single argmax does not supply a top-k ranking.

The CLI records dataset, adapter, evaluator and optional checkpoint hashes plus the Node version. It checks that adapter metadata, adapter source and checkpoint bytes remain unchanged before emitting a report. The checkpoint path is explicit through `--checkpoint FILE`. The adapter declares supported profiles and printings. No model, executable, deck or checkpoint is silently borrowed from another checkout. Imported adapter dependencies and undisclosed training history remain the adapter owner's responsibility.

## Reuse the native checkpoint contract

[shadow-policy.mjs](../integrations/local-worker/shadow-policy.mjs) exposes `nativeShadowPolicy`. It reuses `NativeModelClient.verify()`, `decide({view})` and awaited `shutdown()`. It forces CPU inference, validates the existing 32-state/27-candidate `native-ordinary-features/1` encoding, and preserves candidate identities and order. It returns only the existing argmax, so top-k greater than one remains unscored unless the offer has one candidate.

Create a private adapter module inside ignored `runs/` that calls this helper with `executable`, `checkpointId`, `supportedProfiles`, `supportedCards`, and an audited `project(input)` function. The projector must construct a complete actor-safe native `PolicyView` from the supplied stream facts. This task does **not** provide or certify that projector for the finals decks. It must not fill missing values with plausible defaults or read hidden state. If its encoding or offers fail, the evaluator records an action error separately from illegality.

The native Python service permits checkpoint paths only inside the checkout's own ignored `runs/`. To reuse an external saved checkpoint, copy it read-only into this checkout's `runs/`, verify its hash, and pass that copy explicitly. Keep the original training checkout untouched. The current native helper supports only ordinary `playing` decisions on the actor's turn without prompts. Setup, searches and other prompts need a separately audited adapter or abstention.

The reference `basic-duel-v1` kernel admits only Machop `base1-52`, Rattata `base1-61` and Fighting Energy `base1-97`. The native checkpoint was trained on a private two-deck profile. The public Twinleaf integration has bounded conformance evidence. None of these establishes support for the 2024 Charizard ex and Giratina VSTAR finals decks. The official page specifies regulation mark F or higher for that event; a current Standard profile cannot replace that dated rules provenance.

## Reading the report

Every metric contains its own denominator. Groups by player and game preserve zero-covered players. Unknown actors have their own group. `coverage` is eligible windows divided by recorded windows. `attempted`, `answered`, `abstained` and reason counts show later policy failures separately. Missing hands, masked states, unverified frames, incomplete alternatives, incomplete deck identities and unsupported profiles or printings abstain before inference.

| Metric | Included evidence |
| --- | --- |
| `exactAgreement` | Known-legal prediction and one known-legal human label verified at confidence at least 0.9. Disagreement is imitation disagreement only. |
| `topKAgreement` | The same exact-label gate plus an explicitly returned ranking long enough for `min(k, offer count)`. An argmax supports k=1. |
| `ambiguousAgreement` | Membership in a verified ambiguous label set of known-legal actions. It never increments exact disagreement. |
| `illegalRate` | Selected candidates independently marked legal or illegal. Unknown legality is excluded. |
| `actionErrorRate` | Malformed or unresolved outputs, adapter failures and shutdown failures divided by attempted windows. An action absent from an incomplete list is not proof of illegality. |
| `unknownLegality` | Selected actions whose legality is unresolved. They receive no agreement, illegal or mistake points. |
| `reviewedMistakes` | Sum, count and mean only for chosen known-legal actions with independent action-specific scores. Unreviewed alternatives have no automatic regret. No reviews yields null points and mean. |

There is no combined "points against" total. An expert move need not be uniquely optimal. Independent review must explain a demonstrated mistake in a particular alternative before assigning it points. Match wins and later outcomes are not automatic regret labels.

## Design and verification choices

The Model the Domain principle shaped the separate observation, human, legality and review fields. They cannot silently substitute for each other. Independent records were selected over replay sessions because native snapshot restoration and 2024 deck admission are not established. A future replay producer can emit the same validated rows after those gates pass.

The implementation checkpoint split work into one evaluator owner and separate schema, fixtures, docs and boundary tests. Shared writes were limited to disjoint files in this isolated clone. Verification exercises the actual CLI and pure evaluator with both seats, ambiguity, missing hands, all-masked states, unsupported cards, schema mismatch, split leakage, future labels, illegal versus unresolved outputs and independent mistake scores. No native batch, model training or competitive-strength experiment is part of this result.
