import { access, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { NativeModelClient } from '../integrations/local-worker/learning-model.mjs';
import { SupervisedBridge } from '../integrations/official-client/supervisor.mjs';
import { auditAgentPult, verifyModel2 } from '../integrations/official-client/compatibility.mjs';
import { ordinaryFixture, reportedLobbyFixture } from '../integrations/official-client/fixtures.mjs';

const args = process.argv.slice(2);
const allowed = new Set(['--interactive', '--model-config', '--model-receipt', '--printing-joins']);
const options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!allowed.has(key) || key in options) throw new Error('unsupported-or-duplicate-option');
  options[key] = key === '--interactive' ? true : args[++i];
  if (!options[key]) throw new Error('option-value-required');
}
if (Boolean(options['--model-config']) !== Boolean(options['--model-receipt'])) throw new Error('model-config-and-receipt-required-together');
const emit = value => stdout.write(`${JSON.stringify(value)}\n`);
let model = { decide: async ({ view }) => ({ actionId: view.actions[0].id }) };
let nativeModel;
let modelEvidence = { kind: 'deterministic-fixture-selector', checkpointUsed: false };
try {
  if (options['--model-config']) {
    const verified = await verifyModel2(options['--model-config'], options['--model-receipt']);
    try { await access(verified.config.executable); } catch { throw new Error('model-executable-unavailable'); }
    const runs = resolve(dirname(fileURLToPath(import.meta.url)), '../runs');
    const localCheckpoint = relative(runs, verified.config.checkpoint);
    if (localCheckpoint.startsWith('..') || resolve(runs, localCheckpoint) !== resolve(verified.config.checkpoint)) throw new Error('model-checkpoint-must-be-in-this-checkouts-ignored-runs');
    nativeModel = new NativeModelClient(verified.config);
    const runtime = await nativeModel.verify();
    model = nativeModel;
    modelEvidence = { ...verified.evidence, checkpointUsed: true, runtime: { device: runtime.device, torch: runtime.torch } };
  }
  const joins = options['--printing-joins'] ? JSON.parse(await readFile(options['--printing-joins'])).joins : [];
  const compatibility = auditAgentPult(joins);
  emit({ mode: 'dry-run-only', authoredState: true, liveCapture: false, liveInput: false, model: modelEvidence,
    deck: compatibility.deck, deckSize: compatibility.total,
    joinEvidenceSupplied: Boolean(options['--printing-joins']),
    joinedExactPrintings: options['--printing-joins'] ? compatibility.cards.filter(card => card.pinnedPrintingJoin).length : null,
    missingExactPrintings: options['--printing-joins'] ? compatibility.cards.filter(card => !card.pinnedPrintingJoin).map(card => card.printing) : null,
    clientReadiness: compatibility.reasons });
  let replayTime = 10000;
  const now = options['--interactive'] ? Date.now : () => replayTime;
  let captureSequence = 0;
  const observation = () => ({ ...ordinaryFixture(now()), id: `authored-capture-${++captureSequence}` });
  const bridge = new SupervisedBridge({ window: observation().window, now });
  emit({ status: bridge.status, reportedLobby: reportedLobbyFixture(now()).unknowns, lobbyProposal: 'blocked' });
  if (options['--interactive']) {
    const terminal = createInterface({ input: stdin, output: stdout });
    let proposed;
    emit({ controls: ['arm', 'propose', 'step', 'pause', 'kill', 'quit'], notice: 'All targets are synthetic. No client input is sent.' });
    try {
      for (;;) {
        const command = (await terminal.question('bridge> ')).trim();
        try {
          if (command === 'quit') break;
          if (command === 'arm') bridge.arm();
          else if (command === 'propose') { proposed = await bridge.propose(observation(), model); emit(proposed); }
          else if (command === 'step') emit(bridge.step(proposed?.id, observation()));
          else if (command === 'pause') bridge.pause();
          else if (command === 'kill') bridge.kill();
          else throw new Error('unknown-control');
          emit({ status: bridge.status });
        } catch (error) { emit({ blocked: error.message, status: bridge.status }); }
      }
    } finally { bridge.kill(); terminal.close(); }
  } else {
    bridge.arm();
    const proposal = await bridge.propose(observation(), model);
    emit({ proposed: proposal });
    replayTime++;
    emit({ stepped: bridge.step(proposal.id, observation()) });
    bridge.kill();
    emit({ status: bridge.status, clientActionsSent: 0 });
  }
} finally { if (nativeModel) await nativeModel.shutdown(); }
