# Strength measurements across saved PPO updates

This panel evaluates all four already preserved outcome-PPO snapshots. It performs no fitting and selects no checkpoint. Its shared seed pairs are development material; final confirmation stays separate. The checkpoints were fixed before these outcomes. `protocol.json` records their exact hashes, cumulative training games and cumulative optimizer steps.

Use the frozen `tcg-agent-native/1.0.0` preparation from `docs/first-baseline-foundation.md`. Copy `protocol.json` to a private manifest, add `environmentConfig` naming its private `first-baseline.json`, and add each snapshot's local `checkpoint` path alongside `checkpointName`. The existing paths and model weights must match the recorded hashes.

```text
node scripts/evaluate-training-snapshots.mjs <private-manifest.json> <fresh-private-output>
```

`strength-curve.json` is rewritten after each completed paired block, including the snapshot identity, training exposure, outcomes, paired interval, routes, failures and elapsed wall time. A `running` point is incomplete. Eight paired seeds per snapshot are deliberately a small development panel. Intervals are per snapshot and no multiplicity-adjusted improvement claim is made. The same seeds across snapshots support controlled comparisons, but the four points must not be pooled as 64 independent games against one candidate.

The reference uses exact first-baseline weights; the candidate changes only the ordinary/singleton checkpoint. Both use the frozen selector, helper, encoder, legality checks, native scenario and complete-game public history. Each game/seat gets a fresh `AgentBundle`. Model services are read-only, two lanes run games in parallel, and the frozen runtime is checked between blocks. No running training checkpoint is opened for writing. Only immutable completed snapshots may be named in a manifest.

For future training, invoke this existing entry point on completed snapshots at predeclared checkpoints. Development-arena results can reveal gross collapse or suggest where to investigate. They do not prove that a new PPO recipe improves play; final paired confirmation and appropriate additional opponents are still needed. Evaluate all predeclared snapshots, retain negative results and report arena overhead beside collection/fitting time.
