import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

// Static source inspection only: never attach, invoke client code, or read runtime dumps.
const [research, indigo, output, ...extra] = process.argv.slice(2);
if (!research || !indigo || !output || extra.length) throw new Error('usage: source-audit research-root indigo-root output.json');
const specifications = [
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/NetworkMatchController.cs',
    'internal-match-events', ['ConfigureMatchScopedClientEventSystem', 'BeginSendingClientEventsTo', 'receivePlayerSelection', 'receiveMatchOperationResult']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/ClientMatchMainThreadEventSystem.cs',
    'internal-main-thread-router', ['SendEventsTo', 'DispatchPlayerSelectionEvent', 'DispatchOperationResultEvent']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/IBattleLogStateProvider.cs',
    'internal-presentation-events', ['RootEntryModels', 'OnRootEntryAdded', 'OnEntryChanged']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/BattleLogExporter.cs',
    'user-triggered-clipboard-export', ['ExportBattleLog', 'GUIUtility.systemCopyBuffer', 'OnExport']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/UnityInputManagerAdapter.cs',
    'unity-device-input', ['IsLeftClickBegin', 'wasPressedThisFrame']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/TPCI.Rainier.Features.DeckManager/HUBDeckSelectController.cs',
    'normal-test-deck-ui-path', ['public void Settings_TestDeck()', 'OfflineMatchInitiator.SwitchOfflineAndPlay', 'StartOfflineMatch(BattleBoardType.TestDeck)']],
  ['research', 'tcg-live-rea-2026-10-11/decompiled/TPCI.RainierClient/OfflineMatchInitiator.cs',
    'provided-offline-ai-launch', ['SwitchOfflineAndPlay', 'ValidateDeckIgnoreUnowned', 'GameplayType.Offline', 'SetAISettings']],
  ['research', 'tcg-live-full-reconstruction-2026-10-11/tools/network-runtime-reader.js',
    'excluded-credential-reader', ['rpc.exports', 'AccessToken', '_tokenHolder']],
  ['research', 'tcg-live-full-reconstruction-2026-10-11/tools/network-runtime-query.py',
    'excluded-process-instrumentation', ['frida.attach', 'create_script', 'script.load']],
  ['indigo', 'apps/live-engine/MatchWorker.cs',
    'separate-offline-authority', ['GameplayType.Offline', 'new MatchOperation']],
  ['indigo', 'apps/live-engine/MatchWorker.Projection.cs',
    'reusable-actor-projection', ['Project(string seat)', 'CreatePrivatizedMatchBoardForPlayer', 'AddActions']],
  ['indigo', 'apps/live-server/src/engine-bridge/transport.ts',
    'private-worker-stdio', ['spawn', 'stdio']],
];
const sources = [];
for (const [root, file, role, symbols] of specifications) {
  const contents = await readFile(join(resolve(root === 'research' ? research : indigo), file), 'utf8');
  const lines = contents.split(/\r?\n/);
  const evidence = symbols.map(symbol => {
    const line = lines.findIndex(value => value.includes(symbol)) + 1;
    if (!line) throw new Error(`source-contract-changed:${file}:${symbol}`);
    return { symbol, line };
  });
  sources.push({ root, file, role, sha256: createHash('sha256').update(contents).digest('hex'), evidence });
}
const result = { schema: 'official-client-static-source-audit/1', kind: 'static-source-only', sources,
  runtime: { attached: false, clientMethodsInvoked: false, processMemoryRead: false, credentialsRead: false,
    firstStructuredMatchObservation: null, externalPlayerVisibleEndpointProven: false },
  conclusion: 'Internal event interfaces and the offline actor projection are identified. No inspected source establishes an external player-visible match feed from the running official process.' };
await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ sources: sources.length, runtimeAttached: false, structuredMatchObserved: false })}\n`);
