# Frozen Model6 viewing source

This is the authored dependency closure retained for the control PPO update-4
viewing described in `docs/official-client-model6.md`. The manifest preserves
all sixteen source byte hashes, including twelve checkpoint runtime pins.
Files required by that source guard are retained even when used only by
training entry points. This directory is an immutable historical snapshot,
not the active trainer or a new campaign.

Pass this directory to `scripts/prepare-model6-live.mjs` as its source snapshot.
Preparation copies it into ignored `.cache`; private checkpoint/update receipt,
CPU selection configuration, catalog and prior input manifest remain external.
No model load, training, build or client game was run for publication.

Do not edit these pinned files to incorporate future training changes. Use a new
snapshot with its own proven source/checkpoint pairing when needed.
