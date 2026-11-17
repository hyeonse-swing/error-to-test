import { literal, readVerifiedBundle } from './artifacts.ts';
import { summarizeReadiness } from './readiness.ts';
import type { ReadinessSummary } from './readiness.ts';
import { record } from './validation.ts';

export type GroupCoverageStatus = 'unselected' | 'blocked' | 'review-ready';
export type GroupCoverageReason = 'outside-explicit-group-filter' | 'not-selected-in-saved-bundle' | 'review-pending' | 'needs-context' | 'recorded-blockers';

export interface CoverageSummary {
  schemaVersion: 'error-to-test/coverage-1';
  inputSha256: string;
  analysisSha256: string;
  suiteSha256?: string;
  reviewed: boolean;
  frequency: 'captured-events' | 'submitted-reports';
  counts: { observedGroups: number; selectedGroups: number; unselectedGroups: number; blockedGroups: number; reviewReadyGroups: number };
  groups: { groupId: string; suppliedRecords: number; status: GroupCoverageStatus; caseIds: string[]; reasons: GroupCoverageReason[]; nextAction: string }[];
  warnings: string[];
}

const groupIdPattern = /^group-[0-9a-f]{16}$/;
const caseIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const shaPattern = /^[0-9a-f]{64}$/;

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

function groupId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !groupIdPattern.test(value)) throw new Error(`${label} must be a saved group ID.`);
  return value;
}

function suppliedRecords(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new Error(`${label} must be a positive supplied-record count within the input limit.`);
  }
  return value;
}

function caseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !caseIdPattern.test(value)) throw new Error(`${label} must be a Flow QA-compatible ID.`);
  return value;
}

function groupCases(readiness: ReadinessSummary): Map<string, ReadinessSummary['cases']> {
  const cases = new Map<string, ReadinessSummary['cases']>();
  for (const item of readiness.cases) {
    const list = cases.get(item.groupId) ?? [];
    list.push(item);
    cases.set(item.groupId, list);
  }
  return cases;
}

/** Account for every observed group in one verified, immutable analysis snapshot. */
export async function readCoverage(directory: string): Promise<CoverageSummary> {
  const snapshot = await readVerifiedBundle(directory);
  const readiness = summarizeReadiness(snapshot);
  const frequency = record(snapshot.analysis.coverage, 'analysis.coverage').frequency;
  if (frequency !== 'captured-events' && frequency !== 'submitted-reports') throw new Error('STALE_BUNDLE: Source frequency is invalid.');
  const cases = groupCases(readiness);
  const requested = snapshot.analysis.groupFilter && typeof snapshot.analysis.groupFilter === 'object'
    ? (snapshot.analysis.groupFilter as { groupIds?: unknown }).groupIds : undefined;
  if (requested !== undefined && (!Array.isArray(requested) || requested.some(value => typeof value !== 'string' || !groupIdPattern.test(value)))) {
    throw new Error('STALE_BUNDLE: Explicit group filter is invalid.');
  }
  const groups = (snapshot.analysis.groups as Record<string, unknown>[]).map((raw, index) => {
    const id = groupId(raw.id, `analysis.groups[${index}].id`);
    const selected = cases.get(id) ?? [];
    const status: GroupCoverageStatus = selected.length === 0 ? 'unselected'
      : selected.every(item => item.state === 'draft' && item.blockers.length === 0 && readiness.reviewed)
        ? 'review-ready' : 'blocked';
    const reasons: GroupCoverageReason[] = status === 'unselected'
      ? [Array.isArray(requested) && !requested.includes(id) ? 'outside-explicit-group-filter' : 'not-selected-in-saved-bundle']
      : status === 'review-ready' ? [] : [
        ...(!readiness.reviewed ? ['review-pending' as const] : []),
        ...(selected.some(item => item.state === 'needs-context') ? ['needs-context' as const] : []),
        ...(selected.some(item => item.blockers.length > 0) ? ['recorded-blockers' as const] : []),
      ];
    const nextAction = status === 'unselected'
      ? `Review baseline, --group, --min-count and --top selection; reanalyze the original input with --group ${id} if this observed group needs a TC.`
      : status === 'blocked'
        ? 'Run readiness on this bundle; confirm the requirement and setup, resolve recorded case questions in the profile, then regenerate and review the bundle.'
        : 'Run the exported suite in Flow QA and link its normalized report to assess execution outcomes.';
    return { groupId: id, suppliedRecords: suppliedRecords(raw.count, `analysis.groups[${index}].count`),
      status, caseIds: selected.map(item => caseId(item.caseId, 'readiness.caseId')), reasons, nextAction };
  });
  const selectedGroups = groups.filter(group => group.status !== 'unselected').length;
  const blockedGroups = groups.filter(group => group.status === 'blocked').length;
  const reviewReadyGroups = groups.filter(group => group.status === 'review-ready').length;
  return {
    schemaVersion: 'error-to-test/coverage-1',
    inputSha256: sha(readiness.inputSha256, 'readiness.inputSha256'),
    analysisSha256: sha(readiness.analysisSha256, 'readiness.analysisSha256'),
    ...(readiness.suiteSha256 ? { suiteSha256: sha(readiness.suiteSha256, 'readiness.suiteSha256') } : {}),
    reviewed: readiness.reviewed,
    frequency,
    counts: { observedGroups: groups.length, selectedGroups, unselectedGroups: groups.length - selectedGroups,
      blockedGroups, reviewReadyGroups },
    groups,
    warnings: [...readiness.warnings,
      'This report counts only groups observed in the saved input. Unselected groups have no TC in this bundle; inspect the original selection filters before reanalyzing.',
      'Review-ready is a recorded candidate state, not browser execution, a passing test, resolved error, or complete source collection.'],
  };
}

export function renderCoverage(summary: CoverageSummary): string {
  if (summary.schemaVersion !== 'error-to-test/coverage-1' || typeof summary.reviewed !== 'boolean') throw new Error('Invalid coverage summary.');
  if (summary.frequency !== 'captured-events' && summary.frequency !== 'submitted-reports') throw new Error('Invalid source frequency.');
  const { counts } = summary;
  const positive = (value: unknown, label: string) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error(`Invalid ${label}.`);
    return value;
  };
  const observed = positive(counts.observedGroups, 'observedGroups');
  const selected = positive(counts.selectedGroups, 'selectedGroups');
  const unselected = positive(counts.unselectedGroups, 'unselectedGroups');
  const blocked = positive(counts.blockedGroups, 'blockedGroups');
  const ready = positive(counts.reviewReadyGroups, 'reviewReadyGroups');
  if (summary.groups.length !== observed || selected + unselected !== observed || blocked + ready !== selected) {
    throw new Error('Invalid coverage counts.');
  }
  const lines = ['# Error to Test observed group coverage', '',
    `Input SHA-256: ${sha(summary.inputSha256, 'summary.inputSha256')}`,
    `Analysis SHA-256: ${sha(summary.analysisSha256, 'summary.analysisSha256')}`,
    ...(summary.suiteSha256 ? [`Suite SHA-256: ${sha(summary.suiteSha256, 'summary.suiteSha256')}`] : []),
    `Supplied record meaning: ${summary.frequency}`,
    `Review acknowledged: ${summary.reviewed ? 'yes' : 'no'}`, '',
    '## Observed group counts', '',
    `- Observed: ${observed}`, `- Selected: ${selected}`, `- Unselected: ${unselected}`,
    `- Blocked: ${blocked}`, `- Review-ready: ${ready}`, '', '## Groups', ''];
  if (!summary.groups.length) lines.push('No observed groups.', '');
  const seen = new Set<string>();
  for (const item of summary.groups) {
    const id = groupId(item.groupId, 'summary.groupId');
    if (seen.has(id) || !['unselected', 'blocked', 'review-ready'].includes(item.status)) throw new Error('Invalid coverage group.');
    seen.add(id);
    if (!Array.isArray(item.caseIds) || item.caseIds.some(value => typeof value !== 'string' || !caseIdPattern.test(value))) throw new Error('Invalid coverage case IDs.');
    if (!Array.isArray(item.reasons) || item.reasons.some(reason => !['outside-explicit-group-filter', 'not-selected-in-saved-bundle', 'review-pending', 'needs-context', 'recorded-blockers'].includes(reason))) {
      throw new Error('Invalid coverage reasons.');
    }
    lines.push(`### ${id}`, '', `Status: ${item.status}`,
      `Supplied records: ${suppliedRecords(item.suppliedRecords, 'summary.suppliedRecords')}`,
      `Cases: ${item.caseIds.length ? item.caseIds.join(', ') : 'none'}`,
      `Reasons: ${item.reasons.length ? item.reasons.join(', ') : 'none'}`,
      'Next action:', '', literal(item.nextAction), '');
  }
  lines.push('', '## Warnings and limits', '', literal(summary.warnings.join('\n') || 'None'), '');
  return `${lines.join('\n')}\n`;
}
