"""Verify the archived PPO checkpoint and optimizer without games or updates."""
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import sys

prepared = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
protocol = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8-sig"))
sys.path.insert(0, prepared["runtimeRoot"])
os.environ["PTCG_AGENT_MODEL_ROOT"] = prepared["modelDirectory"]
import torch
from learning import entity_ppo_runtime as runtime

checkpoint = Path(prepared["initialCheckpoint"])
if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != protocol["initialization"]["ordinarySha256"]:
    raise ValueError("Exact first-baseline required")
trainer = runtime.ppo.EntityPPOTrainer.load(checkpoint, runtime.bc.catalog_metadata(prepared["catalog"]), "cpu")
if (trainer.update_count != 23 or not trainer.optimizer.state
        or dataclasses.asdict(trainer.config) != protocol["ppoConfig"]
        or trainer.metadata["sourceHashes"] != runtime.source_hashes()
        or trainer.metadata["frozenSelectionSha256"] != protocol["initialization"]["selectionSha256"]):
    raise ValueError("Inherited optimizer, configuration, selector or source freeze differs")
if not torch.cuda.is_available():
    raise ValueError("Selected local CUDA update device unavailable")
print(json.dumps({"schema": "model7-overnight-preflight/1", "checkpointSha256": runtime.sha256(checkpoint),
                  "updateCount": trainer.update_count, "optimizerStateEntries": len(trainer.optimizer.state),
                  "ppoConfig": dataclasses.asdict(trainer.config), "sourceHashes": runtime.source_hashes(),
                  "python": sys.version, "pytorch": torch.__version__, "cuda": torch.version.cuda,
                  "device": torch.cuda.get_device_name(0), "modelLoads": 1, "games": 0, "fits": 0}))
