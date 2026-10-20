# Frozen authored Model5 viewing dependencies

This directory preserves the seven authored files consumed by the completed Model5 Live viewing loader at trainer revision `8ea9642aca92632bbdf30b040cb260c53a40a272`. `manifest.json` pins their original bytes. They are isolated here so the existing main model interfaces and the active trainer remain unchanged. This is a historical viewing dependency, not the current Model5/Model6 training pipeline.

Use `scripts/prepare-model5-live.mjs bundled <frozen-bc-json> <frozen-cpu-config> <private-input-files-json>` from the repository root. Preparation checks the frozen revision, checkpoint/contract metadata and every bundled file hash, then copies the files to a fresh ignored snapshot. It does not load a model or attach to a client. This public integration reviewed that option statically only; it did not execute preparation or readiness.

Weights, the generated card catalog, extracted corpus, deck bundle, helper and explicit local runtime/configuration remain private prerequisites described in `docs/official-client-model5-viewing.md`. The Python modules require the user's existing Torch environment; no packages are installed by this source snapshot. The recorded environment's checkpoint-loading advisory remains documented in the project; source inclusion does not remedy it.
