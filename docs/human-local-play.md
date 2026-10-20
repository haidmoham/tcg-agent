# Hammerpult human demonstration table

Open **http://127.0.0.1:3860/** on this computer. Choose **Start game**. Select setup and prompt options, then **Submit selection**; optional **Check selection** runs the native rules preview. Choose ordinary moves from the legal-action buttons, optionally filtering by a card. **Inspect** opens readable local card faces, attachments and status. Both public boards, your hand, zone counts, turn, checkpoint identity and inspectable board history remain available. Selected options have a blue outline and numbered text. Results use explicit text; red/green is never the only signal.

The human deck is the existing cohort's exact Hammerpult sixty, SHA-256 of the ordered source array `33353baee4928160844e04c61362341d40260b51cc1a048be1117cd2455ce4a7`. The opponent uses the existing Hydrapple sixty, SHA-256 `85cdd482be60c4787c7088a166d62c7db5e925ab38545fb5ee26e73b3528c9c4`.

The opponent is **Model6 update23, saved 2026-10-20 at 20:53:20 UTC**, from `cohort-v4-preflight/cohort-update-001.pt`, SHA-256 **`c175603c04df29723998efcd02dc7dc18ae9c1c2ad9953fae520adf0e7c515d9`**. The authoritative selection is `task-8/manual-freeze-20261020/selected-human-baseline.json`; its checkpoint and every runtime source hash match this private copy. It never follows newer checkpoints such as update27. The private copy includes the matching runtime source, catalog, native worker and bundle; startup verifies their hashes. The training controller and originals are untouched.

Model6 chooses ordinary moves and supported native-validated singleton card selections. The pinned compatible selection checkpoint (`2b245d6c1d3f91f9cb5d3b6c36663dca717f586581175e7d22588e24f20e6a3d`) ranks other supported card prompts; the frozen helper resolves remaining opponent setup/prompts. These sources are separately attributed. CPU inference uses one game worker and two small persistent model services. The page starts no training.

## Launch and stop

From the repository root, using existing Node 22+ and Python/PyTorch:

```powershell
node scripts/play-human.mjs runs/human-local/config.json 3860
```

No installation, public deployment or desktop package is needed. The server binds only `127.0.0.1`, accepts the exact loopback Host, and rejects foreign-origin commands. Stop a foreground launch with Ctrl+C. Closing a browser tab keeps the current game on the local server; reopening resumes it. **Stop game · retain interruption** ends a game explicitly. Starting a new game retains an unfinished previous game as interrupted. After a server crash the next launch marks unfinished journals interrupted; a torn final append is retained verbatim with an uncertainty warning. Games themselves do not resume across server restarts. Only one server may own a records directory.

The original local session has a prepared private `runs/human-local/config.json`; that configuration is not included in this source checkout. To recreate a new private copy, run:

```text
node scripts/prepare-human-local.mjs <completed-runtime-snapshot> <selected-human-baseline.json> <absolute-local-indigoproject> <absolute-local-card-art-root>
```

Use a fresh checkout without `runs/human-local`; the original adoption receipt is also accepted. The completed snapshot must retain `cohort-campaign-v4-config.json`, `native/pair-manifest.json`, matching authored runtime source, native binaries/bundle, selected checkpoint/reload receipt, selection checkpoint, catalogs and their pins. The local presentation project supplies the existing board styles/assets; card artwork is a separate locally available directory. These external prerequisites and the existing Python/PyTorch/.NET runtimes are required; preparation does not acquire them. Preparation copies only, verifies the completed checkpoint's source and reload proofs, and refuses overwrite. Never commit or publicly redistribute `runs/`, recovered DLLs, datamine, checkpoints or artwork.

## Local records

Human game records are in `runs/human-demonstrations/<game UUID>/`:

- `manifest.json`: game, exact deck/seat/seed, checkpoint, selection, native runtime, source, catalog and encoder contract pins; purpose is later imitation learning.
- `events.jsonl`: append-only, fsynced, sequenced UTC events. Each human offer saves its exact actor-visible raw projection, projected model view, displayed presentation and digest, complete ordered ordinary actions or prompt choices, unknown masks, prompt bounds/groups/order/cancellation context, and the complete Model6 encoded input when supported. Setup or unsupported encoding retains raw data and a reason instead of inventing tensors.
- Every submitted human choice binds that decision UUID and observation digest, records submission time, exact semantic choice, resolved native arguments, native receipt, selected indices and acceptance. Invalid/incomplete/uncertain attempts stay present and ineligible. Composite, ordered, allocation and cancellation commands remain complete semantic records even when the current single-candidate encoder cannot label them.
- Model and helper offers/actions have separate event types and explicit attribution; they are never human labels. Every game ends with its actual terminal result or an explicit interruption. There is no win filtering. Join events by game/decision/submission UUID to inspect a record; resolve episode outcome from `game-ended`.

`imitationLabelEligible` requires an accepted, complete human semantic label. `currentEncoderLabelEligible` separately indicates whether a single candidate in the current encoder can represent it. That flag is not an automatic dataset export or training admission. `behaviorLogProbability` is always unknown (`null`); all records have `eligibleForPpo: false`. Interrupted records are retained, never relabeled as on-policy PPO. No data feeds active training or promotes a model.

## Executed checks and limits

`node scripts/verify-human-play.mjs runs/human-local/config.json runs/human-play-smoke-final.json` runs one bounded synthetic game through the actual HTTP and native paths, with records in a separate `runs/synthetic-human-play/` tree. The first check reached a natural terminal after 80 revisions; the post-fix check completed after 163 revisions: 73 synthetic human-seat commands, 71 Model6 decisions, 19 other attributed opponent decisions. They exercised setup, card/Pokemon selections and face-down prize prompts, raw/encoded journals, native acceptance, duplicate/stale clicks, observation binding, foreign-origin rejection, hidden-world permutations, reset and interruption. They produced **zero human demonstrations**. A separate browser smoke uses `synthetic-smoke` provenance and a separate directory.

The existing native prompt controls handle groups, ordered selections, cancellation and additive/final damage allocations. Not every possible mechanic/prompt has been encountered in the complete-game checks. The exact private deck profile is the scope; full Standard conformance and competitive strength are unverified. Cached equivalent printings are admitted only by the pinned catalog's aliases; missing artwork falls back to visible name and printing ID. Public history provides native actor-visible messages, action messages and inspectable public board snapshots. Repeated Pokemon names are distinguished by Active/Bench location in action and prompt labels. An engine or transport error stops the game and preserves its records; it is never converted into a win/loss or retried as a mutation.

The thin architecture reuses `PlaySession`'s worker/semantic resolver and the existing card board, rather than making a second engine. `HumanSession` owns the browser submit boundary, frozen Model6 inference and episode attribution. `DemonstrationJournal` owns durable raw events. A separate recorder behind the old automated Live dispatch would miss manual semantic choices and is intentionally outside this task.

Source publication integrates authored commit `f13bef584474ee907bc73098b8db8b0c93b97803` with machine-specific setup paths replaced by explicit local directory arguments and the verification summary's private references sanitized. The retained verification predates that setup-only portability adjustment; it was not rerun for publication. Integration ran no tests, games, model loads, builds or training and did not access or change the existing local server. The source contains no synthetic/human raw records, screenshots, private assets or runtime configuration.
