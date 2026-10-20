# Play a saved checkpoint locally

The checkpoint table lets a human play the pinned native two-deck profile against a saved ordinary-action scorer. It adapts Indigo Live's physical-card board and bench rails, loads its existing board CSS, and serves cached Indigo card faces and Twinleaf's card back from local paths. No artwork, recovered programs or native binaries belong in this repository.

The first saved opponent is `native-learning-training-v1`, SHA-256 `1c405966d9539aca89fdf49413663f327859ece6c74c96b12e4453490062fe43`. It has 1,953 parameters and learns legal-candidate supervised imitation of the frozen heuristic. Its receipt records 125 training labels, ten updates, and 40% agreement on 60 held-out decisions. These are pipeline checks, not competitive strength. Model 1 trained on Dragapult ex. The default human deck is N's Zoroark ex, leaving Dragapult ex to the model. Swapping decks is allowed by the native profile and puts the model outside its training deck.

The human chooses their own setup, ordinary actions, targets and prompts. The checkpoint chooses the opponent's ordinary actions. The frozen helper handles the opponent's setup and prompts. The optional **Use helper for my next choice** button advances one human choice and records that assistance. Preview and submission both use native selection validation. The table supports ordered choices, groups, authorized reveals and damage allocations. Additive damage counts omit unused targets; final-counter allocations retain zero states.

## Launch

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

```powershell
node scripts/play-checkpoint.mjs runs/play-local.json 3852
```

Open the printed `http://127.0.0.1:3852/` URL on this computer. The server binds only `127.0.0.1`, checks the Host header, and rejects foreign-origin mutations. This URL is not reachable from a phone. Stop the server with Ctrl+C. A new game closes the previous worker and model process. Closing a browser tab does not stop the server; reopening resumes its current game.

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
