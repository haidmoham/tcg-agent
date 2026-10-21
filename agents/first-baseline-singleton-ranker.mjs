import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function useRankerForMandatorySingletons(agent) {
  const originalRoute = agent.route.bind(agent);
  agent.route = view => {
    const route = originalRoute(view);
    return route === 'singleton' ? 'ranking' : route;
  };
  return agent;
}

export async function openSingletonRankerPlayer({ environmentConfig, checkpoint, checkpointSha256 }) {
  const config = JSON.parse(fs.readFileSync(environmentConfig, 'utf8'));
  if (checkpoint !== config.ordinary.checkpoint || checkpointSha256 !== config.agent.ordinarySha256)
    throw Error('singleton routing treatment requires the exact first-baseline checkpoint');
  const { openFirstBaseline } = await import(pathToFileURL(path.join(config.runtimeRoot, 'agents/first-baseline.mjs')));
  const baseline = await openFirstBaseline(config);
  return {
    verify: async () => baseline.verified,
    newGame: () => useRankerForMandatorySingletons(baseline.newGame()),
    shutdown: () => baseline.shutdown(),
  };
}
