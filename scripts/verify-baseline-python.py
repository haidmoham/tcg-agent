"""Check the current baseline CPU version lock without installing packages."""
import importlib.metadata as metadata
import json
from pathlib import Path
import platform
import sys


def main():
    root = Path(__file__).resolve().parents[1]
    lock = json.loads((root / 'learning/baseline-cpu-lock.json').read_text(encoding='utf-8'))
    mismatches = []
    for key, actual in [('python', platform.python_version()), ('system', platform.system()),
                        ('machine', platform.machine())]:
        if actual != lock[key]:
            mismatches.append(key)
    for name, version in lock['packages'].items():
        try:
            if metadata.version(name) != version:
                mismatches.append(name)
        except metadata.PackageNotFoundError:
            mismatches.append(name)
    if not mismatches:
        import torch
        if torch.__version__ != lock['torchRuntime'] or torch.version.cuda != lock['cudaRuntime']:
            mismatches.append('torch-runtime')
    print(json.dumps({'schema': 'baseline-python-verification/1', 'matched': not mismatches,
                      'packagesChecked': len(lock['packages']), 'mismatches': mismatches,
                      'historicalCudaEnvironment': False, 'packagesInstalled': 0}))
    return int(bool(mismatches))


if __name__ == '__main__':
    sys.exit(main())
