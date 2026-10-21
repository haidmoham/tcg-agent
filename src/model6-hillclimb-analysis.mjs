export function boundedMeanInterval(values, rangeWidths, alpha) {
  if (!values.length || values.length !== rangeWidths.length || !(alpha > 0 && alpha < 1)
    || values.some(value => !Number.isFinite(value) || Math.abs(value) > 1)
    || rangeWidths.some(width => !Number.isFinite(width) || width <= 0)) throw Error('complete independent blocks required');
  const estimate = values.reduce((sum, value) => sum + value, 0) / values.length;
  const radius = Math.sqrt(Math.log(2 / alpha) * rangeWidths.reduce((sum, width) => sum + width ** 2, 0)
    / (2 * values.length ** 2));
  return { estimate, radius, interval: [Math.max(-1, estimate - radius), Math.min(1, estimate + radius)], independentBlocks: values.length };
}

export function pairedScores(receipt, entrant) {
  if (receipt.state !== 'completed' || receipt.blocks.length !== receipt.plannedPairs) throw Error('fixed endpoint not complete');
  const scores = new Map(receipt.blocks.map(block => {
    if (!block.fixedEndpoint || block.outcomes.length !== 2 || ![block.a, block.b].includes(entrant)
      || new Set(block.outcomes.map(outcome => outcome.aSeat)).size !== 2
      || block.outcomes.some(outcome => !['human', 'opponent'].includes(outcome.aSeat)
        || ![0, .5, 1].includes(outcome.score) || outcome.status === 'shared-invalid'))
      throw Error('invalid paired evidence');
    const score = block.outcomes.reduce((sum, outcome) => sum + (block.a === entrant ? outcome.score : 1 - outcome.score), 0) / 2;
    return [block.seed, score];
  }));
  if (scores.size !== receipt.blocks.length) throw Error('duplicate seed blocks are not independent evidence');
  return scores;
}

export function compareHillclimbPanels(receipts, alpha = .0125, anchorFinalAlpha = .01) {
  const candidate = 'first-baseline-singleton-ranker';
  const anchor = [...pairedScores(receipts.anchor, candidate).values()].map(score => score - .5);
  const difference = (challenger, control) => {
    const candidateScores = pairedScores(challenger, candidate), incumbentScores = pairedScores(control, 'first-baseline');
    if (candidateScores.size !== incumbentScores.size || [...candidateScores.keys()].some(seed => !incumbentScores.has(seed)))
      throw Error('shared opponent seed blocks differ');
    return [...candidateScores].map(([seed, score]) => score - incumbentScores.get(seed));
  };
  const teacher = difference(receipts.candidateTeacher, receipts.incumbentTeacher);
  const archived = difference(receipts.candidateArchived, receipts.incumbentArchived);
  if (anchor.length !== 800 || teacher.length !== 400 || archived.length !== 400) throw Error('predeclared sample not met');
  const all = [...anchor, ...teacher, ...archived];
  const endpoints = {
    mixture: boundedMeanInterval(all, [...anchor.map(() => 1), ...teacher.map(() => 2), ...archived.map(() => 2)], alpha),
    anchor: boundedMeanInterval(anchor, anchor.map(() => 1), anchorFinalAlpha),
    teacher: boundedMeanInterval(teacher, teacher.map(() => 2), alpha),
    archived: boundedMeanInterval(archived, archived.map(() => 2), alpha),
  };
  return { schema: 'model6-hillclimb-result/1', endpoints, alpha, endpointAlphas: { mixture: alpha, anchor: anchorFinalAlpha, teacher: alpha, archived: alpha }, promotion: false,
    eligibleForFreshConfirmation: endpoints.mixture.interval[0] > 0 && endpoints.anchor.interval[0] > 0,
    supportedSpecialists: ['teacher', 'archived'].filter(key => endpoints[key].interval[0] > 0),
    conclusion: 'Fixed development endpoint; champion promotion requires independent fresh confirmation.' };
}
