# tcg-agent

A public, CPU-first Pokémon TCG simulation and learning project. **Full current Standard support and competitive strength remain unverified.** The active reference is **first-baseline**, the unchanged former Model6 update23 actor and its pinned selector, in the frozen `tcg-agent-native/1.0.0` environment.

The **[project wiki](https://github.com/haidmoham/tcg-agent/wiki)** is the canonical home for maintained architecture, evaluation, data, coverage and local-play guides. The repository preserves executable contracts and versioned reproduction/evidence. Historical ModelN reports retain their original names.

## Run the public regression kernel

Use Node.js 22 or newer. The reference kernel needs no package dependencies or install step.

```sh
npm test
npm run demo
npm run eval:suite
npm run coverage:report
npm run tutorial
```

On PowerShell, use `npm.cmd` if script execution policy blocks `npm.ps1`. Open [the visual tutorial](tutorial.html) directly or use its loopback preview. The optional Twinleaf comparator has a separate pinned [preparation procedure](integrations/twinleaf/README.md).

The `basic-duel-v1` kernel admits two historical Basic Pokémon and basic Fighting Energy. It is a restricted regression profile. See [environment architecture](https://github.com/haidmoham/tcg-agent/wiki/Environment-architecture) and [Standard support](https://github.com/haidmoham/tcg-agent/wiki/Standard-support-and-remaining-work) before interpreting its results or throughput.

## Reproduce a native experiment

Start with the [first-baseline foundation](docs/first-baseline-foundation.md), [source lock](environment/first-baseline-v1.lock.json) and [preservation receipt](docs/first-baseline-preservation.json). The [released environment](https://github.com/haidmoham/tcg-agent/tree/environment-v1.0.0) retains its exact source version.

The [baseline reproduction guide](docs/baseline-reproducibility.md) and [outcome-PPO reproduction](repro/model7-outcome-001/README.md) retain setup, configuration, hash and verification requirements. Native runs require existing private prerequisites, models and local assets. They are not distributed here. Published [experiment records](repro/) and `docs/` receipts describe completed runs; training completion and imitation agreement alone do not establish stronger play.

For interactive use, follow [Run the local human table](https://github.com/haidmoham/tcg-agent/wiki/Run-the-local-human-table) or [Play a saved checkpoint](https://github.com/haidmoham/tcg-agent/wiki/Play-a-saved-checkpoint). These local interfaces do not authorize official-client or ranked play.

Original code and documentation are [MIT-licensed](LICENSE). Pokémon and card names belong to their owners. This license grants no rights to card artwork, private datasets or extracted programs. Private inputs, model weights, datamine, raw journals, credentials and assets stay outside public source and the wiki.
