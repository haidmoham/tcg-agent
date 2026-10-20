"""One bounded, unevaluated energy-context correction from the frozen Model3 actor."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from learning.card_action_torch import CONTRACT, CONTRACT_SHA256
from learning.masked_ppo import PPOTrainer
from learning.train_card_action import train
import torch


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def run(recipe_path):
    recipe = json.loads(Path(recipe_path).read_text(encoding="utf-8-sig"))
    model_root = Path(recipe["modelRoot"])
    os.environ["PTCG_AGENT_MODEL_ROOT"] = str(model_root)
    model_group = model_root / recipe["modelGroup"]
    model_group.mkdir()
    control = ROOT / "runs" / "model4-energy-control"
    control.mkdir(parents=True)
    os.environ["TEMP"] = os.environ["TMP"] = str(control)
    original = Path(recipe["model3Ppo"])
    selection = Path(recipe["model3Selection"])
    frozen = {str(path): digest(path) for path in (original, selection)}
    trainer = PPOTrainer.load(original, "cpu")
    actor = control / "model3-actor.pt"
    torch.save({"schema": CONTRACT["schema"], "featureContract": CONTRACT,
        "contractSha256": CONTRACT_SHA256, "state_dict": trainer.model.actor.state_dict(),
        "printingAliases": trainer.printing_aliases, "sourcePpoSha256": frozen[str(original)]}, actor)
    fixed_selection = control / "model3-selection.pt"
    shutil.copyfile(selection, fixed_selection)
    del trainer
    base_config = {"executable": sys.executable, "device": "cpu", "seed": 41701,
        "printingAliases": recipe["printingAliases"]}
    save(control / "actor-config.json", {**base_config, "checkpoint": str(actor)})
    save(control / "selection-config.json", {**base_config, "checkpoint": str(fixed_selection)})
    plan = {"schema": "native-card-action-rollout-plan/1", "mode": "dagger", "workers": 4,
        "opponentPolicy": "teacher", "teacherMix": 0.25, "maximumGameSeconds": 360,
        "maximumWallSeconds": 1200, "maximumGameCommands": 500,
        "modelConfig": str(control / "actor-config.json"),
        "selectionConfig": str(control / "selection-config.json"),
        "tasks": [{"id": f"seed-{97001 + index}", "seed": 97001 + index,
            "split": "train" if index < 8 else "validation",
            "seatOrder": [0, 1] if index % 2 == 0 else [1, 0],
            "policySeat": "human" if index % 2 == 0 else "opponent"} for index in range(12)]}
    save(control / "plan.json", plan)
    save(control / "launch.json", {"startedUtc": datetime.now(timezone.utc).isoformat(),
        "recipe": recipe, "frozenInputs": frozen, "plan": plan,
        "hypothesis": "Teacher correction in learner energy-availability contexts may improve Fire/Psychic assembly.",
        "performanceStatus": "unevaluated", "evaluationGames": 0, "testsRun": 0})
    print(json.dumps({"event": "training-collection-started", "tasks": 12}), flush=True)
    subprocess.run(["node", "scripts/card-action-rollout.mjs", recipe["nativeConfig"],
        "model4-energy-dagger", str(control / "plan.json")], cwd=ROOT, check=True)
    receipt = train(ROOT / "runs" / "model4-energy-dagger", model_group / "energy-repair",
        device="cuda", seed=41701, updates=300, max_seconds=60, initial_checkpoint=actor,
        patience=4, energy_contexts_only=True, learning_rate=0.0001)
    for path, expected in frozen.items():
        if digest(path) != expected:
            raise ValueError("frozen Model3 input changed")
    save(model_group / "experiment-receipt.json", {"schema": "model4-energy-experiment/1",
        "completedUtc": datetime.now(timezone.utc).isoformat(), "frozenInputs": frozen,
        "training": receipt, "selectionCheckpoint": str(selection),
        "performanceStatus": "unevaluated", "evaluationGames": 0, "testsRun": 0,
        "interpretation": "Training teacher agreement is not playing strength; no Model4 comparison authorized."})
    print(json.dumps({"event": "training-complete", "checkpoint": receipt["checkpoint"],
        "sha256": receipt["checkpointSha256"], "bestUpdate": receipt["bestUpdate"],
        "retainedInitialCheckpoint": receipt["retainedInitialCheckpoint"]}), flush=True)


if __name__ == "__main__":
    run(sys.argv[1])
