import type { Analysis, IssueGroup } from './types.ts';

export function reselectionChoices(analysis: Analysis): {
  available: IssueGroup[];
  missingContext: IssueGroup[];
  restriction?: 'selection' | 'reselection';
} {
  if (analysis.selection || analysis.groupFilter) {
    return { available: [], missingContext: [], restriction: 'selection' };
  }
  if (analysis.reselection) {
    return { available: [], missingContext: [], restriction: 'reselection' };
  }
  const selected = new Set(analysis.candidates.map(candidate => candidate.groupId));
  const excluded = analysis.groups.filter(group => !selected.has(group.id));
  const available: IssueGroup[] = [];
  const missingContext: IssueGroup[] = [];
  for (const group of excluded) {
    if (group.context === undefined) missingContext.push(group);
    else available.push(group);
  }
  return { available, missingContext };
}
