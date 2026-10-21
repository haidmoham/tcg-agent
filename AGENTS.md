# Project execution

Eagerly build through recoverable engineering gaps and blockers in this project. Missing adapters, card implementations, tests, and integrations are implementation work, not default stopping points. Keep progress bounded by concrete milestones and preserve correctness and verification. Ask only when a genuine product decision, required permission, unavailable capability, or safety boundary prevents proceeding. This guidance does not authorize bypassing denials or expanding account, spending, publishing, or live-play scope.

Use the local datamine eagerly. Use it to inform card mechanics, structured observations and bridge mappings. Private extracted assets stay local. Model observations must remain actor-visible and exclude hidden opponent information.

## Documentation and code stewardship

Treat this codebase as a garden under continuous, coherent stewardship. Keep intent and canonical guidance current as relevant work changes. Prune obsolete or contradictory live guidance. Preserve reproducible historical evidence as history, not current instructions.

Make code explain its intent through descriptive variable, function and type names, coherent file names and folder structure, and clear design patterns suited to the domain. Improve touched code without needless abstraction, gratuitous renaming or broad refactors. Keep comments only for useful non-obvious rationale, constraints or invariants that code cannot express.

Avoid discretionary Markdown files and unnecessary comments wherever possible. Prefer a canonical wiki or external documentation for knowledge that code cannot convey. Keep repository guidance and entry points concise, with pointers instead of competing copies. Reconcile relevant guidance in the same change.

Retain required agent instruction files, licenses, reproducibility instructions, immutable experiment/configuration/evidence artifacts and explicitly requested versioned research records. Keep experiment hypotheses, configurations, seeds, source and checkpoint hashes, results and negative findings traceable. Do not bulk-delete documents or rewrite frozen artifacts to match current prose.

The [public project wiki](https://github.com/haidmoham/tcg-agent/wiki) is the canonical home for maintained explanations and user guides. Publish only sanitized project documentation there. Keep concise verified repository pointers, and preserve versioned reproduction instructions and historical evidence in source. Update the relevant wiki page with behavior changes rather than maintaining competing narratives. Private inputs, weights, datamine, raw journals and credentials remain external.

The active reference is first-baseline in the frozen `tcg-agent-native/1.0.0` environment. See `docs/first-baseline-foundation.md` and `docs/first-baseline-preservation.json`. Older ModelN reports retain their historical names and describe completed runs. Follow current task authorization for new simulation research, preserve frozen runtime pins during comparisons, and keep private inputs and weights external.

## Upstream reference system

Treat [Michal1337/pkmn-kaggle](https://github.com/Michal1337/pkmn-kaggle) and the supplied Kaggle environments as upstream references across learning and execution until evidence justifies divergence. Start from their working system and interfaces: observation/encoding, legal selections, simulation collection, training, opponent populations and evaluation gates. Reuse suitable authorized components before inventing parallel machinery. Record the inspected upstream version, inherited invariants and evidence for departures. Verify implementation, access and licensing for actual reuse; distinguish author claims from reproduced results. Preserve actor visibility and training/evaluation parity, profile our own bottlenecks, and qualify source/config/behavior parity before adoption. Keep running comparisons and frozen references unchanged. See the [canonical upstream guidance](https://github.com/haidmoham/tcg-agent/wiki/Training-data-and-baselines#upstream-reference-system).

## Experiment adequacy

Strength or performance conclusions require enough independent evidence to answer the question. Before a run, declare the decision-relevant effect, comparison, independent sampling unit, uncertainty criterion, and sample size/compute budget. Justify adequacy through power or precision planning, or a valid sequential design with declared stopping rules and justified uncertainty. Do not choose a tiny sample merely to finish cheaply or impose an arbitrary universal sample size.

For paired games, count independent seed blocks for uncertainty. Multiple seats, decisions or frames from the same games are not independent replications. Small smoke, parity and debug runs are allowed when explicitly labeled non-strength engineering checks, with no strength or performance conclusion. Never present them as decisive experiments.

If available resources cannot support a useful conclusion, state the limitation, redesign the comparison or report it as inconclusive. Inadequate evidence cannot justify promotion or a claim of no effect. Preserve original protocols and historical receipts; do not change a stopping rule after inspecting results and then claim its original uncertainty guarantee. See the [canonical evaluation guide](https://github.com/haidmoham/tcg-agent/wiki/Information-boundaries-and-evaluation#design-an-experiment-that-can-answer-the-question).

## Game policy and client driving

Keep Pokemon game policy separate from client driving. The model consumes player-visible structured game state and semantic legal actions, and chooses only Pokemon actions. Do not expose coordinates, screenshots, focus, menus, animations, retries, navigation, transport, or driver failures to the model or its learning objective. Reuse the frozen checkpoint through environment adapters without changing it for a particular UI.

The observation adapter preserves uncertainty and excludes hidden opponent information. The client driver owns verified UI mappings, sequences, synchronization, bounds and execution errors. It must never choose strategic targets, discards, attacks or prompt answers. Any heuristic game choice belongs to an explicit, attributed policy/helper layer. Driver failures and unverified executions are excluded from policy decisions, rewards and training examples. See `docs/policy-client-contract.md` for the contract and tests.

The official client must remain visible in the background on the second monitor while the user works elsewhere. Do not activate or foreground it, request Alt-Tab, move the desktop cursor, or use global input. Keep other applications' capture untouched. The user authorized a scoped in-process adapter for visible UI/event observation and provided-AI Test Deck controls. This does not authorize credentials, hidden opponent information, security changes or public play.

The official-client pilot, frozen Model3/Model4 qualification and single Model5/Model6 viewing requests are complete. Their controllers/adapters exited, input/runtime stop markers remain set and viewing manifests are disarmed. Do not resume those runs, start another official-client game or train through that client without a new user request. Existing source, journals and completed requests do not authorize ranked play. Private records, databases, catalogs and weights remain local.

Historical results and limitations remain in `docs/official-client-sample.md`, `docs/official-client-frozen-qualification.md`, `docs/official-client-model5-viewing.md` and `docs/official-client-model6.md`. Preserve the Model6 startup interruption and same-game resume attribution, including `clean_outcome=0`. Viewing wins do not establish qualification or native-to-Live feature parity.

The shared visible Energy helper in `docs/visible-energy-rules.md` is opt-in. Its retained-record evidence covers five creature states and three attachment counterfactuals only; new Live cost getter bindings remain unverified. Preserve unknown masks and the default disabled capture path. Do not modify active trainer source pins to enable it.
