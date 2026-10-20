# Direct Model2 versus Model3 command

The completed eight-game run is recorded in [the result report](model-three-head-to-head-result.md). These commands describe reproduction from explicitly supplied private artifacts; no additional tests, panels or games are authorized by this document. From a checkout containing the integrated trainer and comparison sources, read the retained final training receipt:

```powershell
$final = Get-Content 'C:/local/private-training-output/receipt.json' -Raw | ConvertFrom-Json
node scripts/model3-head-to-head.mjs runs/model3-head-to-head-prepared/prepared.json $final.selectedCheckpoint $final.checkpointSha256 model3-vs-model2-final
```

The command requires the final path and hash explicitly. It never chooses the newest available update. It runs exactly seeds 94301–94304 in both Model3 seats, two lanes, at most 240 seconds/500 commands per game and 1,200 seconds overall. It uses the existing trainer's audited episode API and inference clients through the private prepared config's explicit `sourceRoot`, which can point to this repository checkout; no trainer source is modified. Model3 ordinary actions use deterministic `PpoModelClient.decide()`, card selections use the frozen BC client, and Model2 retains NativeModelClient and its original encoder. Helpers remain attributed separately.

Private preparation is at `runs/model3-head-to-head-prepared/prepared.json`. It contains `sourceRoot`, `nativeConfig`, `nativeConfigSha256`, `modelTwoConfig`, `selectionConfig` and `selectionSha256`. Its isolated bundle copies the existing eight native input files and replaces only `zoroarkDeckRows` with an exact copy of `realDeckRows`, then updates the manifest. Both ordered source arrays hash to `18910f5075b8b115d38081e4b9c4b396e7cbf17006a6fb030ed6bd9d912f69a3`; the bundle manifest hash is `62cf55ac2e6fac5e2a751df1ddec34dd6da55cfeaf50b10def7728315d346d87`. The original profile and bundle are untouched. Private copies of Model2 and BC selection weights retain hashes `144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b` and `6d3a5510e36a17610de6cbd099a3deac5a3efde02181213358b49ecab65afff2`.

The run snapshots all three checkpoints, inference/runner sources, protocol and native/helper configuration. Results go to `runs/model3-vs-model2-final/receipt.json`, with per-case journals and accepted decision/progress traces. Timeouts, command truncations, unknown terminal winners, cancellations, unattempted games and fatal errors remain distinct. Losing journals are retained. Four seed clusters and differing selection helpers limit strength and causal conclusions. No tests or gameplay were executed during preparation; runtime inference/admission is first exercised by the authorized comparisons themselves.
