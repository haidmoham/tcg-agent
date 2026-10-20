# Shared visible Energy facts

`VisibleEnergyRules.cs` computes the existing `model6-energy/1` facts without
choosing actions. It accepts bounded, player-visible supply, printed costs,
observed effective cost alternatives, retreat cost and bound Basic Energy
attachment choices. It calls the recovered engine's actual
`MatchUtils.EnergyValueContained` for payment and missing units. No second
matching algorithm, simulator board reconstruction, hypothetical hand, model,
account, client input or strategy policy is involved.

The same C# class can be included in a future native worker. The supplied hot
JSONL service and `VisibleEnergyClient` also let Live and native Node callers use
the exact same configured engine assembly. `nativeEnergyInput` adapts existing
actor-visible native facts; `visibleEnergyInput` adapts the existing Live actor
projection plus public UI cost records. Neither adapter enumerates opponent
hands, decks or prizes. Bindings remain physical source/target IDs until the
existing PolicyView aliases and validates them.

## Computed facts and unknowns

* Typed supply is admitted only for simple rendered symbols and completely
  observed, mechanically verified Basic Energy attachments. Special/composite
  supply stays unknown in the Live adapter.
* Complete printed attacks come from the pinned local corpus for that visible
  definition, without truncation or replacement by only the usable attacks.
* Opt-in `CardInfo.allPossibleUsable`/`GetPrimaryEnergyCost`/`GetAttackEnergyCost`
  capture provides the SDK's visible cost-display values for those bound attacks.
  Conditional costs and any displayed `ModifyAttackCost` effect remain unknown.
  A displayed effective cost differing from its verified printed cost also
  remains unknown in this bounded admission. Displayed Energy-value modifiers
  block Basic Energy counterfactual admission.
  The SDK appends rainbow substitution text, so cost modifiers are not admitted
  as though their display representation equaled native alternatives.
* Payment and missing units are computed by the actual engine function when
  complete costs and supply are known. Printed costs never silently become
  effective costs. UI retreat cost and known supply allow retreat payment.
* Offered Basic Energy attachments/reparent choices produce bound target facts
  with one unit added, or zero for an already-attached source. This matches the
  native v1 current-cost-snapshot counterfactual convention. It does not simulate
  future triggers, status changes or legality. Hypothetical attack legality is
  always unknown. Source ownership, Basic Energy mechanics and targets must be
  visible; unsupported sources stay unknown.
* Full attack legality comes only from the existing offered candidate boundary.
  Absence of an offer is not treated as observed illegality. Turn usage,
  effect expiry and previous-turn KO history remain unknown unless a separate
  observation/history contract establishes them. Weights should choose strategy
  using these facts, not recreate deterministic payment arithmetic.

## Preparation and opt-in use

Use the already installed .NET 8 toolchain; no package dependency or network
source is needed. Build into ignored `.cache`, supplying the private runtime:

```text
dotnet build integrations/local-worker/visible-energy-source/VisibleEnergyRules.csproj --configuration Release --artifacts-path .cache/visible-energy-build --output .cache/visible-energy-bin -p:LiveRuntimeRoot=<private-managed-DLL-directory>
```

The private `visibleEnergyRules` config contains absolute `executable` (.NET),
`service` (built DLL), `serviceSha256`, `rulesSha256` (copied MatchLogic.dll), and
`runtimeAssembly` (the actual installed client's MatchLogic.dll) paths/digests.
Live mode requires the installed and service rules DLLs to match byte for byte.
The service independently checks its loaded assembly hash; ping exposes payment
method IL hashes for provenance. Source, service, rules and feature attribution
are pinned in the game journal. Do not commit this config, DLLs or raw inputs.

The existing Model6 controller enables the helper only when this config is
explicitly present. It captures costs using `--visible-energy-facts`, derives
facts after constructing complete ordinary/prompt candidates, and then calls
the unchanged Model6 PolicyView and encoder. Model3/4/5 paths reject this option.
With no config, the frozen viewing path and its honest masks remain unchanged.
Helpers close during controller cleanup. This branch has not attached to the
client or started a game; the SDK getter binding still needs read-only
observation validation before a future authorized game.

Future native integration can call the same service after actor projection, or
include the C# class directly. Pin that helper/config in a new campaign's freeze
and decision records. Do not edit the active trainer runtime, campaign or its
frozen source hashes. Existing Model6 weights and feature dimensions are unchanged.

## Retained-record evidence and parity limit

Both service builds compiled without warnings or errors. Normal derivation of
one retained actor-visible native record reproduced all five creature facts and
three Basic Energy attachment counterfactuals exactly, using either training or
installed-client rules DLLs. No unit-test suite, new simulation, model load or
client game was run for this slice.

The training DLL SHA256 is
`01e936b0ed9d886e7d3f9b8405653be81ba2371a0f33b5638fe134c8fc7154f5`;
the installed-client DLL is
`d391c4b7f92987085ee18d9f757b475258f0530c75c2ebc483bd59f1dc8c6cbb`.
Whole-file and raw payment-method IL hashes differ. The retained record
establishes agreement for that input, not general binary or semantic parity.
Use one explicitly pinned service DLL for both future callers when exact shared
payment execution is required. Broader effect/cost parity and the new Live
capture binding remain unestablished. Unknown masks are preserved rather than
filled by assumptions.
