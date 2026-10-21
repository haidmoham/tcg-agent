"""Preserve every training-state field while pinning a qualified source amendment."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import torch
from learning import alphazero as az
from learning import alphazero_runtime as runtime
from learning import model6_torch as features


def equal(left, right):
    if isinstance(left, torch.Tensor):
        return isinstance(right, torch.Tensor) and torch.equal(left, right)
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equal(value, right[key]) for key, value in left.items())
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('checkpoint'); parser.add_argument('output')
    parser.add_argument('--catalog', required=True); parser.add_argument('--probe-records', required=True)
    parser.add_argument('--protocol-sha256', required=True)
    parser.add_argument('--allow-trained', action='store_true')
    args = parser.parse_args()
    parent_sha = runtime.sha256(args.checkpoint)
    saved = torch.load(features.private_checkpoint(args.checkpoint), map_location='cpu', weights_only=True)
    if not args.allow_trained and (saved['updateCount'] != 0 or saved['optimizer']['state']):
        raise ValueError('this recovery reseal is restricted to the unchanged pre-fit initialization')
    trainer = az.AlphaZeroTrainer.load(args.checkpoint, features.catalog_metadata(args.catalog), 'cpu')
    probe = [az.feature_record(row) if row.get('schema') == az.RECORD_SCHEMA else row
             for row in runtime.records(args.probe_records)[:64]]
    before = trainer.score(probe)
    trainer.metadata = {**trainer.metadata, 'sourceHashes': runtime.source_hashes(),
                        'metadataResealParentSha256': parent_sha,
                        'engineeringRecoveryProtocolSha256': args.protocol_sha256}
    payload = trainer.payload()
    unchanged = {key: equal(saved[key], payload[key]) for key in saved if key != 'metadata'}
    if not all(unchanged.values()):
        raise ValueError('source reseal changed training state')
    output = runtime.fresh_output(args.output)
    with output.open('xb') as stream:
        torch.save(payload, stream)
    loaded = torch.load(output, map_location='cpu', weights_only=True)
    if any(not equal(saved[key], loaded[key]) for key in unchanged):
        raise ValueError('source reseal reload changed training state')
    reloaded = az.AlphaZeroTrainer.load(output, trainer.catalog, 'cpu')
    if reloaded.score(probe) != before or runtime.sha256(args.checkpoint) != parent_sha:
        raise ValueError('source reseal changed outputs or original checkpoint')
    receipt = {**trainer.metadata, 'schema': 'native-alphazero-receipt/1',
               'checkpoint': str(output), 'checkpointSha256': runtime.sha256(output),
               'metadataOnlyReseal': True, 'unchangedTrainingStateFields': unchanged,
               'reloadPolicyValueExact': True, 'updateCount': trainer.update_count, 'fits': 0,
               'probeRecordsSha256': runtime.sha256(args.probe_records),
               'config': trainer.config}
    with output.with_suffix('.receipt.json').open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(receipt, indent=2, allow_nan=False) + '\n')
    print(json.dumps(receipt, allow_nan=False))


if __name__ == '__main__':
    main()
