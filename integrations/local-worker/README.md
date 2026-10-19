# Reuse an existing private headless worker

The primary local extension path is now the existing Indigo Live worker and card-program work. The public Twinleaf integration remains an independent conformance comparator. This avoids reimplementing recovered card effects in the historical kernel.

`probe.mjs` is original process/transport code. It connects directly to an explicitly supplied local worker over newline-delimited JSON. It does not start a web service or client. One worker owns one offline match and its pending operation. A trusted local candidate generator receives one seat view at a time; the worker validates choices and owns transitions. Both-seat frames remain inside the privileged diagnostic runner.

## Local inputs remain local

The worker, dependencies, captured programs, decks and strategy module are private external inputs. None are bundled, downloaded or reconstructed by this command. Their availability does not establish redistribution rights. Keep all paths and configuration in ignored `runs/` and all generated build/tooling files in ignored `.cache/`. Do not copy raw inputs into this public repository.

The supplied bundle must contain exactly eight named, hashed files. The probe verifies the manifest, every input, executable, worker and matching adjacent runtime dependencies before execution. An optional strategy module also requires an exact hash. These are integrity checks on locally selected inputs, not third-party provenance or security certification.

Create a local JSON configuration with this shape, using real absolute paths and SHA-256 values. Placeholders below deliberately fail validation.

```json
{
  "schema": "local-worker-probe-v1",
  "executable": "C:/local/runtime/dotnet.exe",
  "executableSha256": "<64 hexadecimal characters>",
  "worker": "C:/local/build/Indigo.Live.Engine.dll",
  "workerSha256": "<64 hexadecimal characters>",
  "bundleRoot": "C:/local/private-bundle",
  "manifestSha256": "<64 hexadecimal characters>",
  "policyModule": "C:/local/build/policy.mjs",
  "policySha256": "<64 hexadecimal characters>",
  "maxCommands": 1000,
  "maxSeconds": 90
}
```

```sh
node integrations/local-worker/probe.mjs runs/local-worker-config.json
node --test tests/local-worker.test.mjs
```

Omit the optional policy fields to verify create, repeated seat reads and abort only. The default command budget is zero. Configured limits cannot exceed 2,000 accepted commands or 180 seconds. Replies have size and time limits, requests are serialized, stderr is drained privately, and a missing mutation reply ends the owned process with an uncertain outcome. No automatic mutation retry occurs. The existing Indigo service has a separate receipt/retry lifecycle; this probe does not replace it.

The CLI prints only a compact receipt on success and a generic failure message otherwise. It does not print raw views, native errors, cards, logs or configuration paths. Local debugging can invoke the exported functions and retain errors privately. A command-budget stop aborts the offline match and reports `completedNaturally: false`; it is not a loss.

## Executed evidence and limits

On October 19, the existing original worker built against its private pinned local inputs with .NET 8.0.425, zero warnings and zero errors. One natural shuffled modern-deck game then completed through this probe with 82 accepted commands, 30 previews and zero rejected commands, reaching revision 82 in about 25.6 seconds. This was ordinary native setup and resolution, without injected hands, boards, Energy, prizes or winner. The existing local strategy supplied both seats. The compact hash-bound receipt stays in ignored local runs.

This is one execution receipt, not a throughput benchmark, deterministic replay proof, exhaustive action enumeration test, observation-security certification or competitive evaluation. Native randomness was not seeded by the probe. The two-deck input is dated and intentionally bounded. No actual ladder rating follows from it.

Eight synthetic tests separately check transport correlation, serialization, malformed replies, uncertain timeouts and changed-input rejection. They are not counted as real card gameplay. The original Indigo implementation and its prior natural-game evidence remain separate from this new execution.

## Seeded adapter follow-up

The [seeded native runtime](../../docs/native-runtime.md) now adds an isolated original hook build, per-game seed injection, chance transcripts, semantic replay, frozen player DTOs, bounded decision-domain enumeration, native Use/hidden-world probes and renderer-free batch measurement. The seed-1729 record completed 123 commands, 44 previews and 63 native seed requests. A fresh-process replay matched all 124 frames with additional seat reads. Ten hidden-world probes preserved player DTOs, including eight opposing-hand/deck exchanges. These follow-up results supersede the unseeded probe's replay limit; they do not expand its two-deck coverage claim.

`scripts/native.mjs` provides `record`, `replay`, `verify`, `benchmark` and `gauntlet` commands. Exact local configuration and programs are still required. The [runtime document](../../docs/native-runtime.md) gives commands, the semantic cache exclusion and an explicit remaining-gate table.

The [copy optimization experiment](../../docs/native-copy-optimization.md) adds optional `projectionCopyMode: "projection-snapshot-v1"` for newly prepared workers. It caches only immutable serialized authority during one seat projection and still creates a fresh read graph for every validation. Without that field, mode remains `native`. New journal headers pin the explicit mode; runners reject a worker that does not honor it. Keep the old config and worker for exact replay of older pinned journals. The separate comparison tool permits a reviewed worker/mode change while preserving every expected frame, actor, seed and command.

## Retained adapter contract

Retain the canonical pending operation. Disposable copies serve reads and previews; replacing authority with a serialized board can lose continuations or RNG state. Preserve strict polymorphic loading, independently projected seat views, opaque choices and group-local physical-card uniqueness. A successful native preview alone does not establish every selection invariant.

Before this path enters learning, complete legal decision enumeration, independently audit all zones/history, and certify whole-game and card-interaction coverage for a dated legality profile. The new actor DTO removes account-shaped dummy fields. Public Lost Zone, pending/revealed cards and cumulative history remain incomplete. Some allocation domains explicitly refuse admission. Reconcile the broader existing program corpus locally rather than publishing it. The public coverage ledger must continue to reject full Standard admission until evidence closes those gates.
