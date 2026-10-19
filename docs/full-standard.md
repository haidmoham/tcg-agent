# Full current Standard is the next vertical slice

The completion target is an independently runnable headless engine that accepts every legal card in a dated Standard profile, resolves every decision, preserves player information boundaries, and produces reproducible games with test evidence. Neither the historical kernel nor a handful of deck fixtures satisfies that target.

## Current executable increment

The public Twinleaf source is pinned at `d89efe580127a05aff8b0456fd2ad587edbbee2d`. Its Store executes seven modern printed-card conformance assertions in the optional integration. It supplies a large existing card/rules corpus without copying private modifications or rewriting thousands of rules here. The integration is a privileged transition diagnostic. Full Standard admission remains blocked.

The alternate `gemelom/ptcg-engine` pin `92c3cc4fe85a26f102d7bb6b3e8be7678512d2e5` has a cleaner seeded environment shape, but only 104 card modules and five fixture decks at inspection. PTCG-Bench's five-deck evaluation does not expand that into full Standard. Twinleaf has broader source coverage but requires a more substantial decision, RNG and observation adapter. These findings favor extending a reusable public rules boundary rather than the three-card reducer.

Later local inspection changes the primary extension choice. Indigo Live already has an original private headless worker around locally retained card/game programs, strict loading, seat projections, opaque decisions and command receipts. The [new optional process probe](../integrations/local-worker/README.md) reuses that boundary and completed one natural modern-deck game with 82 accepted commands. Prefer this local path over implementing replacement effects. Keep the public Twinleaf integration as an independent comparator. The private broader corpus is data/program evidence, not a current legality or interaction certificate; no recovered programs are published here.

The [seeded native follow-up](native-runtime.md) completes a 123-command natural game and exact per-frame semantic replay in a fresh process, including both actor DTOs and every emitted native seed. Ten hidden-world probes and settled Use audits provide bounded evidence. Semantic replay excludes only a documented native cache field and normalizes runtime identities. Full legal-decision and observation coverage remain incomplete, including Lost Zone/reveals/history and some allocation prompts. This closes a reproducibility increment without closing full Standard admission.

## The remaining inventory is explicit

The [coverage ledger](../coverage/README.md) records exact source printings, source blobs, regulation marks, legality decisions, mechanics requirements, implementation evidence and review status. The reference-kernel backend verifies zero Standard printings. The source catalog contains 4,996 printings in the inspected current-era trees, including 3,234 H/I/J candidates. The full legal denominator is unknown until reprints, promos, basic Energy, releases and restrictions are independently reconciled.

The [Twinleaf source inventory](../integrations/twinleaf/source-inventory.json) lists 14,764 exported class declarations, including 14,152 with literal set/number metadata. Helpers, aliases, alternate printings, inheritance and registration gaps prevent treating those as unique implemented cards. All are unverified source-presence evidence. Catalog and backend IDs require reviewed set aliases and collector numbers, not name matching.

The ledger's 24 mechanics families retain unsupported or unreviewed status for Standard interactions. A passing authored fixture can establish a narrow behavior, but cannot mark an entire mechanic/card family verified without its evidence and interaction contract.

## Sequence the gates

1. **Dated legality.** Separate ranked Live and physical Standard profiles. Resolve current marks, exact availability, reprint equivalence, errata, permanent bans and temporary client restrictions. Cross-check a complete printing denominator. Catalog `legal.standard` alone is insufficient.
2. **Transition oracle.** Inject per-game randomness into every coin, shuffle and helper. Remove forced-heads/no-shuffle simulator defaults from evaluation. Record chance events and preserve pending continuation semantics across replay. Presentation waits must not require a renderer.
3. **Decision algebra.** Enumerate all legal card uses, targets, attacks, retreat payments, search/discard selections, optional effects and resolution prompts. Preserve variable-length decisions. Unknown prompts throw; they must not become a guessed action or a silent loss.
4. **Observation/history projection.** Supply detached card/action IDs and authorized history. Audit private logs, prompts, labels and object references. Swapping hidden allocations behind the same information set must not change the policy input or its action distribution.
5. **Card/mechanics admission.** Match each legal printing to verified semantics. Review inherited scripts and text updates. Add independent fixtures and interaction tests for abilities, effects, locks, Stadiums, special Energy, multi-prize rules, trigger ordering, conditions, simultaneous outcomes and new mechanics. All remaining rows stay visible and fail closed.
6. **Whole-game conformance.** Complete natural games for diverse held-out Standard matchups, with conservation/invariant checks, bounded resolution and exact replay. Maintain disagreement cases against other implementations and resolve them using official rules/rulings, since software can contain bugs.
7. **Performance and policy.** Benchmark these actual Standard workloads with complete outcomes, error/truncation accounting, hardware and logging/inference modes. Only then can the Basic profile's throughput stop being the sole measured workload.

## Scientific boundary

A rules oracle is not an optimal imperfect-information player. The [policy/evaluation design](oracle-and-evaluation.md) distinguishes authoritative transitions, information-set policies and privileged diagnostic targets. The current tactical scorer and opponent-pool suite are executable reference-profile infrastructure. They do not claim Standard strength.

The desktop remains the computational base. This increment uses bounded CPU tests and short measurements. Sustained training is a separate execution decision. Future operational plans default to supervision, one match at a time, normal readiness checks, bounded sessions and explicit stop conditions. No live session is started by this milestone.
