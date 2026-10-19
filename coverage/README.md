# Full Standard coverage remains the target

This inventory prevents a runnable subset, a catalog entry, or an upstream card class from being reported as full Standard support. The current reference kernel has **zero verified current Standard printings**. Its historical three-card research profile remains separate.

The checked-in manifest enumerates **4,996 source printings in 29 current-era set directories**, including **3,234 literal H/I/J mark candidates**. These are source counts, not a count of the complete legal Standard card pool. Alternate collector numbers remain distinct printings. No art, card effects, flavor text, decklists or private data are copied.

## Read the result

```powershell
node scripts/coverage-audit.mjs
node scripts/coverage-audit.mjs coverage/standard-2026-10-19.json --require-full
node --test tests/coverage.test.mjs
```

The audit returns counts and blockers. `--require-full` exits 2 while coverage is incomplete. Invalid manifests exit 1. A successful ordinary audit only means the inventory is internally consistent. It does not certify a simulator.

`auditCoverage(manifest, { profileId, asOf })` validates the versioned boundary. `assertDeckCovered(manifest, printingIds, options)` rejects any printing without verified legality and executable mechanics. It does not replace 60-card deck construction validation. IDs have the form `sv05:11` or `me01:1`. Numeric leading zeroes normalize; promo prefixes remain significant. Name matches never establish equivalence.

The JSON Schema describes the serialized shape. The executable auditor additionally enforces canonical identity, duplicate detection, evidence requirements, exact profile date and cross-row mechanic dependencies. The schema is not an executed rules engine. Source reviews older than seven days or later than the requested date are rejected. Each profile supports its exact as-of date; this conservative freshness policy forces explicit review when the environment changes.

## Reproduce the source inventory

The source is [TCGdex cards-database at cbddf7e](https://github.com/tcgdex/cards-database/tree/cbddf7e54033b1b58e44af1049c88832e55b94d0), under its [MIT license](TCGdex-LICENSE). This snapshot is a factual projection of its `data/Scarlet & Violet` and `data/Mega Evolution` trees. It includes set identifiers, source release dates, collector numbers, source blob IDs, literal marks and categorical source fields.

```powershell
git clone --filter=blob:none --no-checkout https://github.com/tcgdex/cards-database.git .cache/tcgdex
git -C .cache/tcgdex sparse-checkout set --cone "data/Scarlet & Violet" "data/Mega Evolution" meta
git -C .cache/tcgdex checkout cbddf7e54033b1b58e44af1049c88832e55b94d0
node scripts/coverage-snapshot.mjs .cache/tcgdex
```

The extractor runs no third-party TypeScript. It reads source literals from a clean pinned checkout. Spread/inherited card metadata is conservatively left unknown. Letter case normalizes, while nonletter or absent marks become null. Every row retains its exact source blob for adjudication. `sets[].releaseDate` is a catalog field, not a verified Live or tournament admission date.

Two designs were considered. Treating `legal.standard` as automatic admission is short but conflates data availability, product legality and implemented mechanics. An explicit exact-printing ledger keeps those decisions separate. The latter makes unsupported or unreviewed cards fail before an experiment can silently score them as losses or simulate incorrect rules.

## Verified format facts as of October 19, 2026

- The official [March 19 Live letter](https://community.pokemon.com/en-us/discussion/23170/letter-to-the-community-march-19-2026) says Live rotated G on March 26, 2026, leaving H/I/J marks. The [rotation announcement](https://www.pokemon.com/uk/news/2026-pokemon-tcg-standard-format-rotation-announcement) dates physical competitive rotation to April 10, 2026. It also identifies future marks as eligible and gives Rare Candy as an older-printing example. Exact reprint equivalence and applicable errata still need review. Name equality alone is insufficient.
- The official [product legality update](https://community.pokemon.com/en-us/discussion/22216/pokemon-tcg-product-legality-update) anchors tournament admission to specified physical product releases. Ascended Heroes was adjusted to March 6, 2026. The [Live ruleset support letter](https://community.pokemon.com/en-us/discussion/22242/product-legality-and-competitive-ruleset-support-in-pokemon-tcg-live) explicitly says ranked Live and current physical tournaments can differ. Maintain separate profiles.
- The current official [banned list](https://www.pokemon.com/us/play-pokemon/about/pokemon-tcg-banned-card-list) was indexed as having no Standard bans when reviewed. Temporary client restrictions, exact releases and the full reprint pool were not independently enumerated. Do not interpret an empty permanent ban list as complete admission evidence.
- Official [1.43.0 patch notes](https://community.pokemon.com/en-us/discussion/26277/version-1-43-0-patch-notes) schedule the update for October 6, 2026. They describe fixes to Basic Energy searches, zero-target choices, promotion selection and setup ability timing. These are useful regression cases. A client bug is not a rules oracle.
- Official [rating guidance](https://community.pokemon.com/en-us/discussion/19258/letter-to-the-community-july-10-2025) distinguishes progressive Elo below Master from competitive Elo in Master, with monthly competitive resets. Record metric name and season with every observed rating. Offline ratings have no established conversion to Live Elo.
- The official [terms](https://www.pokemon.com/us/legal/terms-of-use) restrict unauthorized third-party software that modifies or automates service operation. This work uses offline simulations and manually supplied records only.

Some pokemon.com pages returned iframe-only bodies to automated retrieval. Their specific indexed statements were cross-checked against readable official community announcements. This is not a claim that every paragraph or current erratum was retrieved. No account or live client was used.

## Catalog fields are evidence, not semantics

Pinned [TCGdex legality metadata](https://github.com/tcgdex/cards-database/blob/cbddf7e54033b1b58e44af1049c88832e55b94d0/meta/legals.ts) lists H/I/J and no Standard exclusions. Its [legality helper](https://github.com/tcgdex/cards-database/blob/cbddf7e54033b1b58e44af1049c88832e55b94d0/server/compiler/utils/util.ts) does not establish dated release availability or reprint text equivalence.

One concrete data issue is `me05:84`. [Its source](https://github.com/tcgdex/cards-database/blob/cbddf7e54033b1b58e44af1049c88832e55b94d0/data/Mega%20Evolution/Pitch%20Black/084.ts) labels Voltaic Lightning Energy `energyType: Normal`. The official 1.43 patch fixes this card being selectable in Basic Lightning Energy searches. Therefore `sourceEnergyType` is retained only as a catalog fact. It must not choose a Basic Energy handler or waive mechanics review.

## Remaining coverage inventory

The exact 4,996 listed rows await legality and mechanics review for this backend. The 24 entries in `mechanics.json` list concrete unresolved rule families, including typed Energy payment, Trainers, evolution, trigger ordering, multi-prize rules, conditions, searches, locks, hidden knowledge and simultaneous terminal outcomes. Some core rules work in the historical profile; that does not verify their interaction with the Standard card pool.

The total Standard denominator remains **unknown**. Missing scope includes older equivalent printings, relevant promos and Basic Energy outside selected eras, independent product availability and temporary restrictions, card-specific errata, explicit mechanic requirements, and executable conformance evidence. Unmarked rows include intentionally separate products and Basic Energy; they are not automatically illegal. H/I/J rows are not automatically executable.

`twinleaf-comparison.json` joins the pinned public upstream class inventory by reviewed set-code aliases and exact collector numbers. Of the 3,234 mark candidates, 1,885 have a literal script match and 1,349 do not. A missing match can mean missing scripts, inherited metadata, a different upstream identifier, or unresolved catalog inheritance. It does not prove an upstream card is absent. Every match remains unverified. The ambiguous `30C` abbreviation is excluded because two catalog sets share it.

```powershell
node scripts/coverage-compare.mjs
```

Next, select conformance fixtures from official rule interactions and known patch regressions. Promote a card only when its exact legality, complete mechanic requirements, information-safe prompts and correctness tests agree. Full Standard requires completing the ledger and independently validating its denominator.
