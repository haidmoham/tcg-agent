# Restricted-profile CPU measurement

Measured on October 19, 2026. These are absolute throughput measurements for `basic-duel-v1`, not a speedup over another simulator or a claim about Standard-game training.

## Reproduce the work

```sh
npm test
npm run bench -- --games 1000 --repeats 5
npm run profile
node scripts/summarize-profile.mjs
npm run eval -- 100
```

The desktop reported an AMD Ryzen 7 5800X with 16 logical CPUs, Windows `10.0.26300` x64 and Node `v24.18.0`. One JavaScript game worker runs synchronously. There are no neural inference calls, worker pools or GPU jobs. Runtime garbage collection can use helper threads.

Whole-desktop utilization was unavailable through the restricted process view. No claim of an idle host is made. The raw process CPU times and wall times are in the receipt. Run-to-run variation includes JIT, scheduling and garbage collection noise.

## Workload and timed region

Each repeat runs seeds 1 through 1000 on the same 60-card mirror decks, four Machop, four Rattata and 52 Fighting Energy. Both policies develop the board and delay attacks until turn 50, then use `greedy-v1`. This is a declared stress workload, not intelligent play. A separate `--short-games` workload permits immediate attacks.

The timed loop creates each environment and consumes the entire episode. It includes shuffle and mulligans, setup decisions, masked observations, legal action generation and validation, baseline policy execution, turns and terminal results. Replay mode also accumulates public events and accepted actions. A 50-game warmup precedes the run. Mode order alternates each repetition.

Process startup, module imports, file output, replay re-execution and neural inference are outside the timed region. No outcomes or observations are loaded from a cache. Every mode/repeat consumes 116,881 actions and 69,483 turns. Terminal counts are 586 six-prize wins and 414 no-Pokémon wins. The consumed checksum is `2195943` in every run. Errors and truncations are zero. Deck-out has its own passing rule fixture but does not occur in this workload.

## Results

| Mode | Median games/second | Minimum | Maximum | Repeats |
|---|---:|---:|---:|---:|
| Training, no event/action recording | 3,446 | 2,849 | 3,481 | 5 |
| Replay recording enabled | 3,105 | 2,817 | 3,209 | 5 |

Each row covers 5,000 completed games. Training mode's median is about 403,000 decisions per second. The two ranges overlap; do not infer a reliable logging speedup from these short runs. The artifact preserves exact timings and process CPU consumption.

[Raw unprofiled runs](benchmark-2026-10-19.json) contain the configuration and every result. The independently repeated CPU sampling run writes `runs/profile-benchmark.json`, so it cannot overwrite that measurement. No profiled throughput is used above.

## What limits this loop

[The V8 sample summary](profile-2026-10-19.json) maps the hot path to source. About 15.6% of sampled self time is in revision-stamped action-object creation at `environment.mjs:81`. `uniqueHand` plus its callback accounts for about 15.4%, and the main legal-action method for about 8.6%. The scripted policy accounts for about 10.9%, with more time in its runner and delayed-attack wrapper. Garbage collection accounts for about 5.5%.

The profile supports a CPU/allocation-bound decision loop: repeatedly constructing and validating action lists, scanning hands, and selecting scripted actions. There is no disk or network work in the loop. It also shows that policy/harness work is a material share, so these numbers must not be described as isolated rules-transition throughput. A future optimization should compare the same full loop and retain exact action/turn/outcome counts.

At roughly 403,000 decisions per second, one average decision takes about 2.5 microseconds in the measured loop. That is physically plausible for this tiny registry and simple arrays, but says nothing about Trainer chains, abilities, search branching or neural inference. Full Standard will have a different cost and correctness burden.

## Baseline evaluation

[The evaluation receipt](evaluation-2026-10-19.json) runs 100 matched seeds, swapping greedy and legal-random seats for 200 games. Greedy wins 172 and loses 28, with no errors or truncations. All games end by no Pokémon in play. Mean pair score is 0.86; the 1,000-resample paired-seed bootstrap interval is 0.815 to 0.900.

This checks that the policy interface supports distinguishable baselines. The interval covers seed-pair variation only. It excludes uncertainty from deck choice, card coverage, opponent selection and metagame shift. No learned agent or competitive rating follows from this result.
