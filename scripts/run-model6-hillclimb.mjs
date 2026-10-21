import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeAtomicJson } from './model7-atomic-json.mjs';
import { boundedMeanInterval, compareHillclimbPanels, pairedScores } from '../src/model6-hillclimb-analysis.mjs';

const [campaignFile] = process.argv.slice(2);
if (!campaignFile || process.argv.length !== 3) throw Error('usage: run-model6-hillclimb <private-campaign.json>');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const campaign = read(campaignFile), root = path.dirname(path.resolve(campaignFile));
const statusFile = path.join(root, 'status.json');
if (fs.existsSync(statusFile)) throw Error('campaign already armed; inspect evidence before recovery');
const state = { schema: 'model6-hillclimb-status/1', phase: 'checking-capacity', pid: process.pid,
  armedAtUtc: new Date().toISOString(), gamesStartedAtUtc: null, completedPanels: [], promotion: false };
const saveStatus = () => writeAtomicJson(statusFile, { ...state, at: new Date().toISOString() });
const verify = () => {
  for (const [file, digest] of Object.entries(campaign.sourcePins)) if (hash(file) !== digest) throw Error('campaign source changed');
  for (const panel of campaign.panels) if (hash(panel.manifest) !== panel.sha256
    || hash(panel.spareLaneManifest) !== panel.spareLaneSha256) throw Error('campaign manifest changed');
  if (hash(path.join(root, 'protocol.json')) !== campaign.protocolSha256) throw Error('campaign protocol changed');
};
verify(); saveStatus();
const capacityReleased = () => {
  const prerequisite = read(path.join(campaign.prerequisite, 'status.json'));
  if (prerequisite.phase === 'failed') throw Error('Model7 confirmation needs recovery; capacity not released');
  const preserved = path.join(campaign.prerequisite, 'preservation.json');
  if (prerequisite.phase !== 'completed' || !fs.existsSync(preserved)) return false;
  const receipt = read(path.join(campaign.prerequisite, 'confirmation/receipt.json'));
  if (receipt.state !== 'completed' || receipt.plannedPairs !== 512 || receipt.blocks.length !== 512
    || receipt.blocks.some(block => block.outcomes.length !== 2)) throw Error('Model7 confirmation is not fully complete');
  if (!fs.existsSync(path.join(campaign.prerequisite, 'public-result.json'))) throw Error('Model7 final verification missing');
  state.prerequisite = { preservationSha256: hash(preserved), finalReceiptSha256: hash(path.join(campaign.prerequisite, 'confirmation/receipt.json')) };
  return true;
};
try {
  if (!capacityReleased()) {
    const capacity = read(campaign.capacityReceipt);
    if (!campaign.allowSpareLane || capacity.cpuPercentMean >= 70 || capacity.cpuPercentMaximum >= 85
      || capacity.freeMemoryGiB < 4 || Date.now() - Date.parse(capacity.at) > 1800000)
      throw Error('fresh measured headroom required before using one spare lane');
    state.capacity = capacity;
  }
  verify(); state.phase = 'running'; state.gamesStartedAtUtc = new Date().toISOString(); saveStatus();
  const campaignStarted = Date.now(), receipts = {};
  for (const panel of campaign.panels) {
    verify();
    if ((Date.now() - campaignStarted) / 1000 > campaign.maximumCampaignSeconds) throw Error('campaign wall budget exhausted');
    const fullCapacity = capacityReleased();
    const manifest = fullCapacity ? panel.manifest : panel.spareLaneManifest;
    state.activePanel = panel.id; state.workers = fullCapacity ? 6 : 1; state.activeManifest = manifest; saveStatus();
    const log = fs.openSync(path.join(root, `${panel.id}.log`), 'a');
    const child = spawn(process.execPath, [path.join(root, 'runtime/scripts/run-native-ladder.mjs'), manifest, panel.output],
      { stdio: ['ignore', log, log], windowsHide: true });
    state.runnerPid = child.pid; saveStatus();
    const heartbeat = setInterval(saveStatus, 15000);
    const remainingMilliseconds = campaign.maximumCampaignSeconds * 1000 - (Date.now() - campaignStarted);
    const deadline = setTimeout(() => child.kill('SIGTERM'), Math.max(1, remainingMilliseconds));
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearInterval(heartbeat); clearTimeout(deadline); fs.closeSync(log);
    if (code !== 0) throw Error(`panel ${panel.id} stopped with exit ${code}; preserve evidence before recovery`);
    const receipt = read(path.join(panel.output, 'receipt.json'));
    if (receipt.state !== 'completed') throw Error(`panel ${panel.id} incomplete`);
    receipts[panel.id] = receipt; state.completedPanels.push({ id: panel.id, receiptSha256: hash(path.join(panel.output, 'receipt.json')) });
    if (panel.id.startsWith('anchor-')) {
      const blocks = Object.entries(receipts).filter(([key]) => key.startsWith('anchor-')).flatMap(([, value]) => value.blocks);
      const combined = { state: 'completed', plannedPairs: blocks.length, blocks };
      const values = [...pairedScores(combined, 'first-baseline-singleton-ranker').values()].map(score => score - .5);
      const index = campaign.anchorScreen.cumulativeIndependentPairs.indexOf(values.length);
      if (index < 0) { saveStatus(); continue; }
      const interval = boundedMeanInterval(values, values.map(() => 1), campaign.anchorScreen.lookAlphas[index]);
      const futile = interval.interval[1] < .10;
      const anchorComplete = index === campaign.anchorScreen.cumulativeIndependentPairs.length - 1;
      writeAtomicJson(path.join(root, `${panel.id}-analysis.json`), { ...interval, alpha: campaign.anchorScreen.lookAlphas[index], futile });
      if (futile || anchorComplete && interval.interval[0] <= 0) {
        state.phase = 'completed-anchor-screen'; state.runnerPid = null;
        writeAtomicJson(path.join(root, 'result.json'), { schema: 'model6-hillclimb-result/1', endpoint: 'anchor-screen',
          ...interval, alpha: campaign.anchorScreen.lookAlphas[index], promotion: false, eligibleForFreshConfirmation: false,
          completedAtUtc: new Date().toISOString(), protocolSha256: campaign.protocolSha256,
          conclusion: futile ? 'Predeclared futility: interval excludes the target +0.10 anchor advantage. Smaller gains and specialist value remain unresolved.'
            : 'Fixed anchor screen did not establish a positive advantage. No expansion, promotion or no-effect claim.' });
        saveStatus(); process.exit(0);
      }
      if (anchorComplete) receipts.anchor = combined;
    }
    saveStatus();
  }
  const result = compareHillclimbPanels(receipts);
  writeAtomicJson(path.join(root, 'result.json'), { ...result, completedAtUtc: new Date().toISOString(), protocolSha256: campaign.protocolSha256 });
  state.phase = 'completed'; state.runnerPid = null; saveStatus();
} catch (error) { state.phase = 'failed'; state.error = error.message; saveStatus(); process.exitCode = 2; }
