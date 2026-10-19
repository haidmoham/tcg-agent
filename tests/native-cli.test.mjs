import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

test('native CLIs refuse an existing run without adding failure artifacts', () => {
  const name = `native-cli-test-${randomUUID()}`;
  const path = join('runs', name);
  mkdirSync(path, { recursive: true });
  const config = join(path, 'fixture-config.json');
  writeFileSync(config, '{}', { flag: 'wx' });
  const before = readdirSync(path);
  for (const args of [['scripts/native.mjs', 'record', config, name], ['scripts/compare-native-copies.mjs', config, config, config, name]]) {
    const reply = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(reply.status, 1);
    assert.deepEqual(readdirSync(path), before);
    assert.equal(reply.stderr.includes('fixture-config'), false);
  }
});
