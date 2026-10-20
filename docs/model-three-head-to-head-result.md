# Model3 direct comparison result

Frozen PPO update 039 won four games against frozen Model2; Model2 won one game, and three of the eight attempts hit the 240-second wall limit. All four reserved seeds were attempted in both seat assignments with the same exact AgentPult sixty on both sides. There were no command truncations, rejected-command/privacy/provenance fatal errors, cancellations, replacements or unattempted cases in the completed comparison run. No tests or additional panels were run.

| Seed | Model3 human seat | Model3 opponent seat |
| --- | --- | --- |
| 94301 | Wall timeout | Model3 win |
| 94302 | Model2 win | Model3 win |
| 94303 | Model3 win | Model3 win |
| 94304 | Wall timeout | Wall timeout |

The observed terminal counts favor Model3, but superiority remains **inconclusive**. The 4/5 completed-game fraction is conditional on finishing; it is not an eight-game win-rate estimate. Missing-outcome sensitivity spans 4/8 to 7/8 Model3 wins. Four independent seed clusters give a distribution-free 95% Hoeffding interval of [0,1] after that sensitivity range. Model3 uses frozen learned BC card selection while Model2 uses fixed prompt helpers, so the result compares complete policy packages and cannot isolate improvement caused by PPO experience. No Elo claim follows.

PPO checkpoint SHA-256 is `8a2a98a8dad933cf5a1d273d89ccc3e54c99b5ed686edc4238e7b1dd6188828b`; Model2 remains `144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b`; frozen BC selection remains `6d3a5510e36a17610de6cbd099a3deac5a3efde02181213358b49ecab65afff2`. The [safe result receipt](model-three-head-to-head-result.json) records every case, source/checkpoint hashes, elapsed time and uncertainty.

Private evidence is retained under `runs/model3-vs-model2-final-r1/`: aggregate `receipt.json`, per-case terminal journals and accepted decision/progress traces, including all three timeouts. The losing example is `94302-human/journal.json`. The initial launch at `runs/model3-vs-model2-final/` stopped before any game because the trainer's Model2 loader rejected a checkpoint outside its own runs directory. The actual runtime repair uses the evaluation checkout's Model2 client; its client, encoder and Python source hashes match the original exactly. The startup incident remains preserved and did not replace any game attempt.
