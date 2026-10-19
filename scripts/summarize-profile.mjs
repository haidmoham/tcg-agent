import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const files = readdirSync('runs').filter(file => file.endsWith('.cpuprofile')).sort();
if (files.length === 0) throw new Error('run npm run profile first');
const profile = JSON.parse(readFileSync(`runs/${files.at(-1)}`, 'utf8'));
const byNode = new Map(), groups = new Map();
for (let index = 0; index < profile.samples.length; index++) byNode.set(profile.samples[index], (byNode.get(profile.samples[index]) ?? 0) + (profile.timeDeltas[index] ?? 0));
const totalMicros = [...byNode.values()].reduce((a, b) => a + b, 0);
for (const node of profile.nodes) {
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.split('/').at(-1), line = lineNumber + 1;
  const key = JSON.stringify([file, functionName, line]);
  const value = groups.get(key) ?? { file, functionName, line, selfMicros: 0 };
  value.selfMicros += byNode.get(node.id) ?? 0; groups.set(key, value);
}
const report = {
  source: 'separate Node V8 CPU sampling run; never use profiled timings as benchmark throughput',
  totalSampledMicros: totalMicros,
  top: [...groups.values()].sort((a, b) => b.selfMicros - a.selfMicros).slice(0, 15).map(row => ({ ...row, fraction: row.selfMicros / totalMicros })),
};
writeFileSync('runs/profile-summary.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
