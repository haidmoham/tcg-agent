# Admit exact JTG-120 Dunsparce offline

JTG-120 is a Basic Colorless Pokémon with 70 HP, Fighting weakness times two, no resistance, one Colorless retreat cost, and no Ability. Trading Places costs one Colorless and switches itself with one of its controller's Benched Pokémon. Ram costs two Colorless and does 20 damage. These details match the [official Journey Together card](https://asia.pokemon-card.com/sg/card-search/detail/17967/).

The frozen package instead contains [TEF-128 Dunsparce](https://asia.pokemon-card.com/sg/card-search/detail/12218/). That card has 60 HP, free retreat, Gnaw for 10, and Dig for 30 with a coin-flip protection effect. It is a different card version. The AgentPult manifest continues to specify JTG-120.

The exact captured JTG-120 program already exists as `sv9_120` in the pinned broader corpus. The retained native runtime already implements its `SwapCards` and `ApplyDamage` nodes. The defect was package admission. The isolated probe registers that exact program as a 39th card and adds its exact printing join in a separate, newly hashed, ignored local package. It does not rewrite the original 38-card package, the exact AgentPult manifest, any model, the UI checkout, or any existing comparison log. No new card-effect implementation is required.

Run the bounded probe with an existing local worker config and the local research root.

```powershell
node scripts/official-client-dunsparce.mjs <local-config.json> <local-research-root>
```

The probe verifies source pins, creates its package under `.cache/dunsparce-jtg120-*`, and runs native setup and ordinary commands on authored 60-card test decks. Each deck contains four exact JTG-120 Dunsparce, four Budew, and 52 basic Fire Energy. These are focused offline fixtures, not the AgentPult deck or official-client games. The script uses current player views, ordinary legal offers, and native previews. It does not read privileged audit authority or inject a board, hand, turn, or winner. Receipts and the separate config stay under ignored `.cache`.

The compact [native test receipt](official-client-dunsparce-verification.json) distinguishes static checks, observed effects, and remaining limits. The no-Bench case is legal: Trading Places does no switching and ends the turn. A test must preserve that behavior rather than add a Bench requirement absent from the native engine. This matches the ordinary attack rule allowing an attack whose effect cannot be completed.

Admission is limited to the separately pinned offline package. Exact AgentPult card availability becomes 24 of 24 at the static mechanics level when combining its 15 exact joins, eight verified reprint equivalences, and this exact Dunsparce extension. That does not certify full-deck interactions, every prompt, current Standard legality, or the official-client input mapping. The supervised bridge remains disarmed for those unresolved gates.
