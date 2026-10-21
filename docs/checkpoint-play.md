# Play a saved checkpoint

Maintained documentation is in the [project wiki](https://github.com/haidmoham/tcg-agent/wiki/Play-a-saved-checkpoint). Update that page when behavior changes.

## Versioned preparation and checkpoint identities

This section preserves the retained checkpoint-table reproduction and verification record. Use the wiki for maintained operating instructions.

The first saved opponent is `native-learning-training-v1`, SHA-256 `1c405966d9539aca89fdf49413663f327859ece6c74c96b12e4453490062fe43`. It has 1,953 parameters and learns legal-candidate supervised imitation of the frozen heuristic. Its receipt records 125 training labels, ten updates, and 40% agreement on 60 held-out decisions. These are pipeline checks, not competitive strength. Its legacy receipt does not itself specify training deck coverage, so the catalog leaves that coverage unknown. The default human deck is N's Zoroark ex, leaving Dragapult ex to the model. Both decks are playable in the native profile.

Model 2 is `native-learning-training-v2 / best update 200`, SHA-256 `144180ba472cfe23e405eb7c47448e5c88e8148ac5440c5d38f37a54d7ad690b`. Its finalized UI receipt records 673 labels from 18 human-seat teacher games, including 302 Dragapult labels and 371 N's Zoroark labels. Its 49.08% agreement on 218 validation decisions was used to select the checkpoint. It is not an untouched final-test result. The frozen receipt marks paired native policy-role evaluation as pending; that evaluation is owned separately. The same 1,953-parameter scorer runs on CPU in the interface.

Use Node 22 or newer and the already-installed Python/PyTorch runtime. No package install is needed. Prepare a private JSON config inside ignored `runs/` with these fields:

```json
{
  "native": { "schema": "local-worker-probe-v1", "...": "existing pinned native worker config" },
  "indigoRoot": "C:/path/to/indigo-live",
  "cardArtRoot": "C:/path/to/existing/card-textures",
  "models": [{
    "id": "model-1",
    "name": "Model 1",
    "version": "native-learning-training-v1",
    "receipt": "C:/path/to/training/receipt.json",
    "model": {
      "executable": "C:/path/to/existing/python.exe",
      "checkpoint": "C:/path/to/this-checkout/runs/model-1/model.pt",
      "device": "cpu",
      "seed": 1729
    }
  }]
}
```

Replace `native` with the entire existing pinned native config, including its hashes. Copy the frozen checkpoint into this checkout's ignored `runs/` directory. The Python loader requires that location. Keep the original training receipt and compare its checkpoint digest. The interface verifies the digest, schema, parameter count and loaded objective before admitting a new game. Add another registry entry only when its saved checkpoint and matching receipt exist. Inference always uses CPU to avoid competing with training.

The retained launch command is `node scripts/play-checkpoint.mjs runs/play-local.json 3852`. The separate two-checkpoint reproduction used `runs/play-both-models.json` on port 3853. Model 2's finalized checkpoint and receipts are copied into ignored `runs/model-2/`; its training originals remain read-only. The catalog uses each receipt's `coverage.trainedOnLabel`, train collection deck/seat counts, `coverage.finalPolicyRoleEvaluation`, and `heldout.kind`. When supplied, `coverage.nativePins` must match the selected native runtime.

## Verification

```powershell
$env:CHECKPOINT_PLAY_CONFIG = 'runs/play-local.json'
npm.cmd test
node scripts/verify-checkpoint-play.mjs runs/play-local.json runs/checkpoint-play-verification.json
```

The verifier loads the real saved checkpoint on CPU, plays one bounded natural game with labeled human helper assistance, checks hidden-world permutations, rejects stale revisions and old-game clicks, verifies repeat requests do not advance twice, and resets the game. The output file must be new. It does not benchmark or train a model. Unit checks also cover presentation filtering, receipt/hash binding, additive/final damage encodings and HTTP boundaries. The optional HTTP check skips when no private config is provided.

The browser receives only the human `PolicyView`, explicitly mapped visible names and labels, a whitelisted terminal outcome, and checkpoint metadata. It never receives both-seat frames, raw authority, native IDs, hidden cards, deck arrays, seeds or checkpoint paths. Commands carry a game token, revision and request UUID. Preview, command, opponent play and reset run through one queue. An uncertain native transport result stops the game and requires a fresh reset instead of retrying a mutation.

The executed [verification receipt](checkpoint-play-verification.json) records a natural 203-revision game with 65 learned opponent decisions, two hidden-world checks, invalid-input preservation, duplicate/stale requests and reset checks. Chrome interaction separately verified setup preview/submission, inspection without losing source selection, an ordinary attack, a six-counter target allocation and face-down prize selection. A second game reached a rendered human win with the remaining human moves handled by labeled assistance. The final suite passed 125 tests and skipped one optional unprepared Twinleaf integration. An earlier repeat encountered a Windows temporary-directory cleanup race in an unchanged native test; the final complete rerun passed.

The inspected local card cache covers 25 of the two decks' 38 distinct printings. The other 13 faces show their visible names and exact printing IDs. This does not reveal hidden cards, and missing artwork does not prevent play. Screenshots stay in ignored `runs/screenshots/`.

The native profile remains private and bounded to these exact two decks. Full Standard support, exhaustive mechanics conformance, competitive strength and physical-phone usability remain unverified. The public Twinleaf engine is an independent comparator and does not replace the native rules authority in this interface.

The [pre-migration document](https://github.com/haidmoham/tcg-agent/blob/b9dc8f7fb2895ef36b34f5a643bca9d70b35fb5d/docs/checkpoint-play.md) preserves the original milestone discussion and inspected evidence. It is historical context, not a second current guide.
