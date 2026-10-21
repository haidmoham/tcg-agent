# Fresh PPO checkpoint confirmation

This versioned protocol supersedes the exploratory panel as a strength decision. It fixes 512 fresh independent seed pairs / 1,024 games to assess a 10 percentage point score improvement in the frozen scenario. The power calculation, interval, nomination rule, seeds, limits and failure treatment are in `protocol.json`. Development games never enter confirmation.

After `ppo-strength-curve-001` completes, prepare the private manifest and run:

```text
node scripts/prepare-strength-confirmation.mjs <completed-curve-directory> repro/ppo-checkpoint-confirmation-001/protocol.json <fresh-private-manifest.json>
node scripts/run-native-ladder.mjs <private-manifest.json> <fresh-private-output>
node scripts/export-strength-confirmation.mjs <completed-private-output> repro/ppo-checkpoint-confirmation-001/protocol.json <public-result.json>
```

Run a separate non-strength capacity check before allocating six CPU lanes. Preserve the private manifest, full journals, source hashes, model identities, operational failures and actual cost. An incomplete run has no fixed-endpoint conclusion. The exporter verifies complete paired evidence and produces a publication-safe result. Import its raw native receipt with `scripts/report-native-ladder.mjs`; keep weights, raw journals and private inputs outside public source. No command promotes a checkpoint.
