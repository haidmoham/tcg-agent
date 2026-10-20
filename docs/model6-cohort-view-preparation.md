# Model6 cohort viewing preparation

The provisional 2026-10-20 cohort candidate is prepared without client access.
Its checkpoint is
`05f9084948222138ce34e8bfaf4aeab36b680bf44f268dbb4f048449670148c6`,
architecture `model6-energy-residual/2`, with seven total optimizer updates.
The handoff's `updates=2` describes the current cohort stage, not total PPO
updates. Both values remain distinct in the manifest and decision attribution.
The trusted handoff reports 22 applied cohort games / 1,181 transitions across
all six decks. This is exposure metadata, not a strength selection result.

The existing bridge pinned control update 4 and hard-coded its policy labels.
`loadModel6Bridge` now also accepts a complete version-2 verified handoff
manifest, while retaining the original pilot guard. All 16 inference dependency
files are required and checked; the Python source guard independently checks
its 12 checkpoint-bound source hashes. Candidate labels, update count and
architecture checks follow the manifest rather than retaining the old pilot's
name. Model3/4/5 behavior is unchanged.

`prepare-model6-handoff.mjs` verifies the supplied handoff, CPU configs, complete
runtime source pins, checkpoint, selection checkpoint and catalog. It copies the
authored inference sources and private catalog into a new ignored snapshot,
checking for changes during copying. It does not edit the active trainer root,
processes or checkpoint. Original checkpoint/config/manifest files are retained.
Output uses exclusive creation: it cannot replace an existing candidate manifest
or kill marker.

Preparation in a **fresh checkout** from this source is:

```text
node scripts/prepare-model6-handoff.mjs <verified-final-handoff.json> <prior-private-input-manifest.json>
node scripts/official-client-model6-ready.mjs
```

The second command loads the trusted ordinary/selection checkpoints on CPU,
checks service/source/catalog/contract guards, optimizer count and architecture,
then closes both workers. It imports no client/controller code, requests no
inference, and writes a private readiness receipt. A new final checkout keeps
the provisional manifest and snapshot intact when the 21:30 UTC final freeze is
available. The future handoff must provide the same complete verified fields,
including total `optimizerUpdates`, `actorArchitecture`, source hashes, CPU config
paths and checkpoint/selection hashes. Missing fields fail closed.

## Observed readiness

The provisional checkpoint and pinned selection checkpoint
`2b245d6c1d3f91f9cb5d3b6c36663dca717f586581175e7d22588e24f20e6a3d`
loaded successfully on CPU with all guards passing. The catalog has 117 card and
240 action vocabulary entries, digest
`65398de4f776573bdb2b9d50e9441d27be5fe109b05d5122be961fb20c245f04`.
All earlier vocabulary mappings retain their IDs. The feature contract remains
`native-energy-entity-decision/1`, digest
`3c86e7c8c595e485d9bfdd6e7137a5413d89e947cda300ee0ec42fd57b70640a`.
There were no inference requests, unit-test suites, simulations, client attaches,
inputs, focus operations or games in this preparation.

The manifest is disarmed and both kill markers remain set. No client identity
config was created and no scheduled client action was installed. The opt-in
rules helper stays disabled; previous unknown masks are preserved. Native-to-Live
parity remains partial, including unresolved conditional modifiers and history.

## Actual handoff requirements

There is no remaining loader/schema blocker for this provisional artifact.
The final 21:30 UTC freeze still needs preparation/CPU verification against its
exact new checkpoint and runtime. Before a separately authorized 22:00 UTC
viewing, refresh the real process/window identity and visible account/AgentPult60
evidence, select the exact disarmed manifest, then explicitly arm the owned
single AI run. These preparation files grant no game, ranked or input permission.
Do not enable the unverified rules bindings merely to fill missing inputs.

## Source publication

Integrated from authored source commit
`61736b8d8d0594df68a894f83bdba83342c4b8b2`, applying only its new delta over
main's prior sanitized client integrations. Existing frozen Model5/Model6 source
snapshots and byte pins remain intact. Publication reviewed the source and the
retained private readiness receipt; it did not repeat CPU loading, run tests or
builds, start experiments, access the client or change active training.
Checkpoint weights, handoffs/configs containing local paths, catalogs, raw
receipts, game records, databases, datamine and runtime binaries stay private.
