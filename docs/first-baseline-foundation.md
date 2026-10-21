# First-baseline foundation

`first-baseline` is the unchanged former Model6 update23 reference. Its ordinary actor/critic checkpoint is `c175603c04df29723998efcd02dc7dc18ae9c1c2ad9953fae520adf0e7c515d9`; its separate selector is `2b245d6c1d3f91f9cb5d3b6c36663dca717f586581175e7d22588e24f20e6a3d`. The catalog is `65398de4f776573bdb2b9d50e9441d27be5fe109b05d5122be961fb20c245f04`. These identify the reference independently of filenames. The 27–37 human-BC candidate and the 22–42 outcome-PPO candidate remain historical results; neither becomes this reference.

The environment release is **`tcg-agent-native/1.0.0`**, frozen by [the source lock](../environment/first-baseline-v1.lock.json) and the Git commit containing it. The lock records authored source, native wrapper/binary/helper identities, feature dependencies and the retained platform. A prepared private config additionally pins every copied prerequisite, the model files, executable files and scenario. The preparation preserves raw bytes required by the checkpoint loader. No weights, raw observations, extracted catalogs, native libraries or game assets belong in Git.

## Use the existing system

```js
// Import these from the prepared private runtime, not an arbitrary checkout.
import { openFirstBaseline } from './agents/first-baseline.mjs';
import { runNativeGame } from './environment/native-game.mjs';

const service = await openFirstBaseline(preparedConfig);
try {
  const game = await runNativeGame(nativeConfig, {
    seed: 1729, seatOrder: [0, 1],
    agents: { human: service.newGame(), opponent: otherAgent },
    maxCommands: 1000, maxSeconds: 240,
    onDecision({ seat, view, decision, source, encoded, sample }) {
      // Called only after native acceptance. Any private records stay local.
    },
  });
  console.log(game.summary, game.routes);
} finally {
  await service.shutdown();
}
```

A service owns the two persistent model processes. `newGame()` owns one seat's fresh history; make a new instance for each seat and every game. Deterministic inference does not couple seats through sampling state. `runNativeGame` supports the existing episode seed, seat order, process-session reuse, cancellation, audit cadence and operational budgets. `onObservation` supplies each seat's safe projected view. `onFrame` is a privileged diagnostic callback containing both raw seat projections; keep it out of policies and learning features. The returned journal is privileged replay/debug evidence. A reusable worker session remains caller-owned, following the existing native runner contract.

The native adapter currently projects a second time for the agent lifecycle. This modest cost keeps the exact archived runner bytes usable and independently checks actor IDs against its projections. It is an explicit preservation tradeoff; no performance gain is claimed.

## Contracts and ownership

| Boundary | Owner and contract |
|---|---|
| Authoritative state, rules, RNG, offered ordinary actions | Existing native worker and `model6-training-episode.mjs` |
| Player-visible information, stable semantic IDs, public Energy facts and unknown masks | Existing `model6-policy-view.mjs`, built on `policy-view.mjs` |
| Encoding | Existing `model6-features.mjs` and its exact contract/catalog; internal Model6 schema names remain compatible |
| Agent | `observe(view)`, `propose(view, {validate})`, `accepted(view, decision)`, with identity in `pins` |
| Per-game history | `AgentBundle`; observe every visible revision, including out of turn; record actions only after acceptance |
| Ordinary and mandatory single-card prompts | Reference ordinary PPO actor, deterministic; singleton candidates are all checked by the current native validator |
| Other supported card prompts | Separate frozen selector and archived ranked-answer generator; joint answers still need native validation |
| Setup, prizes, allocations and other helper routes | Existing pinned native helper, separately counted; no invented model probabilities |
| Execution and cleanup | Existing native runner resolves semantic IDs, previews prompt answers, checks acceptance/revision, audits privacy/RNG, and reaps owned workers |
| Experiment choice, objective, sampling and evaluation | Experiment caller; no training framework or strength threshold is introduced by this layer |
| Client interaction | Separate client driver contract; the foundation has no client input path |

`propose` returns `{source, decisions, encoded?, sample?}`. Decisions may be a lazy iterable; `null` means use the attributed environment helper. The environment advances through candidates until native acceptance, then calls `accepted` once. A failure remains an execution/policy failure; this adapter assigns no outcome reward or win. Existing evaluation controllers retain their own declared treatment of failures and truncations.

`complete-game` history starts at revision 0 and visits all revisions. `observed-only` remains available on AgentBundle for partial recorded/client views, retaining unknown usage. Those modes are different observation contracts and must be attributed in an experiment. There are no new turn, damage, evolution, card-state or Energy exclusions. Existing unsupported mechanics and operational bounds remain explicit in the underlying runner; the freeze is not a claim of complete Standard support.

## Reproduce the environment

Supply existing, legally obtained private prerequisites as absolute paths:

```json
{
  "outputRoot": "E:/ptcg-local/first-baseline-v1",
  "nativeConfig": "E:/ptcg-local/native-config.json",
  "ordinary": {
    "executable": "E:/ptcg-local/venv/Scripts/python.exe",
    "checkpoint": "E:/ptcg-local/reference-update23.pt",
    "catalogPath": "E:/ptcg-local/catalog.json"
  },
  "selection": { "checkpoint": "E:/ptcg-local/selection.pt" }
}
```

```powershell
npm run foundation:prepare -- E:/ptcg-local/inputs.json
npm run foundation:verify -- E:/ptcg-local/first-baseline-v1/first-baseline.json
```

Preparation copies files into a fresh private directory outside the checkout. It starts no service, game or optimizer. Verification checks all hashes, opens both frozen CPU services, checks their handshakes and shuts them down. It does not play by default. A changed or incomplete source snapshot fails before service startup. Never edit a prepared version in place; prepare another directory and give changed environment behavior a new version.

The frozen source reuses the 29 runtime pins from [the completed outcome reproduction](../repro/model7-outcome-001/README.md), including its two exact authored overrides. It adds the small agent/lifecycle boundary and its entry points. Historical archives and model loader schemas retain their original names and hashes. The human table now displays `first-baseline`; `model6-pinned` remains an accepted legacy request ID so existing tools can still submit a game request. Historical journals, attribution and reproduction receipts are unchanged.

The default retained scenario is the exact mirrored Hammerpult recipe. Decks, seeds and seat order are experiment inputs rather than an environment admission whitelist. Preparation records the supplied bundle's recipes; native pins and all private files remain identified. A new native binary, helper or projection changes environment identity; a different deck/seed panel changes scenario identity. Record both when comparing players. The native source/build command and external prerequisite boundary are documented in the outcome reproduction guide. A rebuilt binary must retain its actual digest and cannot impersonate the historical binary.

The [exact installed Python package inventory](../environment/requirements-first-baseline.txt) accompanies this source version; an existing retained virtual environment avoids reinstalling dependencies. To reconstruct one, use CPython 3.12.10 and install that requirements file explicitly, then record the actual executable/native hashes and rerun preservation checks. Preparation never installs packages.

The retained platform was Windows x64, Node 24.18.0, Python 3.12.10, PyTorch 2.5.1+cu121 and .NET SDK 8.0.425, with CPU inference. A source lock cannot make different PyTorch/native builds bit identical. Preserve actual platform and binary hashes for a reproduction; retain the existing larger-drive private archive.

## Preservation verification

The optional verifier replays a supplied historical trace panel:

```powershell
npm run foundation:verify -- E:/ptcg-local/first-baseline-v1/first-baseline.json E:/ptcg-local/retained-traces.json E:/ptcg-local/fresh-preservation-receipt.json
```

The private audit input may contain `humanJournals` (paths to the retained append-only event journals) and `recordedGames`, each game with `seed`, `seatOrder`, `baselineSeat`, `decisionsPath`, `progressPath` and `outcomePath` from the completed comparator. The reference makes its ordinary/singleton/ranking choices through the new boundary; the other seat follows its retained decisions. Every accepted command, both player projection hashes, terminal hash, winner and native seed count must equal the retained run. These seeds are consumed evidence and must not be reused as fresh confirmation data. Any mismatch stops verification rather than relaxing gameplay eligibility.

[The preservation receipt](first-baseline-preservation.json) records exact parity for both retained game roles: 414 accepted commands, 416 frames (both player projections), 145 ordinary reference choices, 34 singleton choices, 24 ranked selections, 16 helper choices, matching terminal/RNG results and 26 privacy checks. All 145 retained human offer contexts also match. The public suite passed 213 tests with three explicit optional skips. Replay equivalence supports this refactor; it does not establish broader strategic strength, client parity or ranked readiness.

## Architectural decision

Two structurally different choices were considered: replace the simulator/collectors with a generic research environment, or make the existing native lifecycle and AgentBundle the stable boundary. The latter is implemented. It preserves legal-action semantics, hidden-information discipline, Energy facts, helper attribution and complete-game evaluation already present. Future experiments can replace one agent component without rebuilding simulation or silently changing its opponent. The cost is retaining historical module/schema names and the private prerequisite boundary; renaming those internals would break byte-pinned compatibility without improving player behavior.

The foundation does not schedule or authorize experiments. The separate research task owns its approved autonomous loop and compute choices; it can use this frozen version or explicitly identify an alternate runtime. The parallel task-9 Energy successor evaluator and its completed receipts remain separate and untouched.
