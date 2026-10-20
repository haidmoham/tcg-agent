export function promptAnswer(prompt, selection, amounts) {
  if (prompt.kind !== 'allocation') return { promptId: prompt.id, choiceIds: [...selection] };
  const entries = prompt.choices.map(choice => ({ choiceId: choice.id,
    count: amounts.get(choice.id) ?? choice.initialAmount ?? choice.minAmount ?? 0 }));
  return { promptId: prompt.id, choiceIds: [],
    amounts: prompt.allocationMode === 'final' ? entries : entries.filter(entry => entry.count > 0) };
}
