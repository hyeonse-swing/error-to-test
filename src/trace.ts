import { literal, readVerifiedBundle } from './artifacts.ts';
import { summarizeCoverage, type CoverageSummary } from './coverage.ts';
import { summarizeReadiness, type ReadinessSummary } from './readiness.ts';
import { redactText } from './redact.ts';
import { summarizeRunSummary, type ReadRunSummaryOptions, type RunSummary } from './run-summary.ts';
import { validatedTargetFingerprint } from './result-selection.ts';
import { record, text } from './validation.ts';
import type { SourceCoverage } from './types.ts';

type TraceCase = {
  caseId: string;
  candidateId: string;
  state: ReadinessSummary['cases'][number]['state'];
  blockers: string[];
  status: RunSummary['groups'][number]['cases'][number]['status'];
  reason?: string;
};

export interface EventTrace {
  schemaVersion: 'error-to-test/trace-1';
  eventId: string;
  found: boolean;
  source: {
    inputSha256: string;
    analysisSha256: string;
    suiteSha256?: string;
    kind: SourceCoverage['kind'];
    frequency: SourceCoverage['frequency'];
    partial: boolean;
    retention: 'unknown';
  };
  runCount: number;
  selectedTargetFingerprint?: string;
  latestRun?: RunSummary['latestRun'];
  availableTargets: RunSummary['targets'];
  matches: {
    groupId: string;
    project: string;
    environment: string;
    release: string;
    suppliedRecords: number;
    status: CoverageSummary['groups'][number]['status'];
    reasons: CoverageSummary['groups'][number]['reasons'];
    nextAction: string;
    cases: TraceCase[];
  }[];
  warnings: string[];
}

const shaPattern = /^[0-9a-f]{64}$/;
const groupPattern = /^group-[0-9a-f]{16}$/;
const casePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const runPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const caseStatuses = new Set(['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error', 'not-run']);

function checked(value: unknown, pattern: RegExp, label: string): string {
  const result = text(value, label);
  if (!pattern.test(result)) throw new Error(`Invalid ${label}.`);
  return result;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

/** Find an event in one verified saved analysis and its latest linked run. */
export async function readEventTrace(directory: string, eventId: string, options: ReadRunSummaryOptions = {}): Promise<EventTrace> {
  const requested = text(eventId, 'eventId');
  if (redactText(requested) !== requested) throw new Error('eventId contains data that cannot be safely displayed.');

  const snapshot = await readVerifiedBundle(directory);
  const readiness = summarizeReadiness(snapshot);
  const coverage = summarizeCoverage(snapshot, readiness);
  const runs = await summarizeRunSummary(directory, snapshot, options);

  const sourceCoverage = record(snapshot.analysis.coverage, 'analysis.coverage');
  const kind = sourceCoverage.kind;
  if (kind !== 'browser-error-json' && kind !== 'browser-error-jsonl' && kind !== 'manual-json'
    && kind !== 'manual-jsonl' && kind !== 'manual-text') throw new Error('STALE_BUNDLE: Source kind is invalid.');
  if (sourceCoverage.partial !== true && sourceCoverage.partial !== false) throw new Error('STALE_BUNDLE: Source partial flag is invalid.');
  if (sourceCoverage.retention !== 'unknown') throw new Error('STALE_BUNDLE: Source retention value is invalid.');

  const coveredGroups = new Map(coverage.groups.map(group => [group.groupId, group]));
  const readyCases = new Map(readiness.cases.map(item => [item.caseId, item]));
  const runGroups = new Map(runs.groups.map(group => [group.groupId, group]));
  if (!Array.isArray(snapshot.analysis.groups) || snapshot.analysis.groups.length !== coveredGroups.size) {
    throw new Error('STALE_BUNDLE: Observed groups changed while tracing this event.');
  }
  const matches: EventTrace['matches'] = [];
  snapshot.analysis.groups.forEach((raw, index) => {
    const group = record(raw, `analysis.groups[${index}]`);
    const groupId = text(group.id, `analysis.groups[${index}].id`);
    const ids = group.eventIds;
    if (!Array.isArray(ids) || ids.length !== group.count || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 8192)) {
      throw new Error('STALE_BUNDLE: Observed event IDs are invalid.');
    }
    if (!ids.includes(requested)) return;
    const covered = coveredGroups.get(groupId);
    const runGroup = runGroups.get(groupId);
    if (!covered || !runGroup) throw new Error('STALE_BUNDLE: The event group is missing from coverage or results.');
    const cases = runGroup.cases.map(item => {
      const ready = readyCases.get(item.caseId);
      if (!ready || ready.groupId !== groupId || ready.candidateId !== item.candidateId
        || !item.eventIds.includes(requested)) throw new Error('STALE_BUNDLE: The event case mapping is inconsistent.');
      return { caseId: item.caseId, candidateId: item.candidateId, state: ready.state,
        blockers: ready.blockers, status: item.status,
        ...(item.reason === undefined ? {} : { reason: item.reason }) };
    });
    if (covered.caseIds.length !== cases.length || covered.caseIds.some(id => !cases.some(item => item.caseId === id))) {
      throw new Error('STALE_BUNDLE: The event case selection is inconsistent.');
    }
    const nextAction = covered.status === 'review-ready' && cases.some(item => item.status !== 'not-run')
      ? 'Review the latest linked case outcome and its target scope before deciding whether to rerun.'
      : covered.nextAction;
    matches.push({ groupId, project: redactText(text(group.project, `analysis.groups[${index}].project`)),
      environment: redactText(text(group.environment, `analysis.groups[${index}].environment`)),
      release: redactText(text(group.release, `analysis.groups[${index}].release`)),
      suppliedRecords: covered.suppliedRecords, status: covered.status, reasons: covered.reasons,
      nextAction, cases });
  });

  const warnings = [...new Set([
    ...coverage.warnings, ...runs.warnings,
    ...(matches.length ? [] : ['This event ID was not found in the saved analysis input. This does not establish that it never occurred or was never collected.']),
    ...(sourceCoverage.partial ? ['The source export was marked partial; other collected events may be outside this saved input.'] : []),
    ...(requested.includes('[redacted') ? ['The saved event ID contains redacted data; multiple original IDs may share this displayed value.'] : []),
    ...(matches.length > 1 ? ['The same event ID appears in multiple observed groups; use project and group ID to distinguish them.'] : []),
  ])];
  return {
    schemaVersion: 'error-to-test/trace-1', eventId: requested, found: matches.length > 0,
    source: { inputSha256: coverage.inputSha256, analysisSha256: coverage.analysisSha256,
      ...(coverage.suiteSha256 === undefined ? {} : { suiteSha256: coverage.suiteSha256 }),
      kind, frequency: coverage.frequency, partial: sourceCoverage.partial, retention: 'unknown' },
    runCount: runs.runCount,
    ...(runs.selectedTargetFingerprint === undefined ? {} : { selectedTargetFingerprint: runs.selectedTargetFingerprint }),
    ...(runs.latestRun === undefined ? {} : { latestRun: runs.latestRun }),
    availableTargets: runs.targets, matches, warnings,
  };
}

export function renderEventTrace(trace: EventTrace): string {
  if (trace.schemaVersion !== 'error-to-test/trace-1' || typeof trace.found !== 'boolean'
    || trace.found !== Boolean(trace.matches.length)) throw new Error('Invalid event trace.');
  if (!['browser-error-json', 'browser-error-jsonl', 'manual-json', 'manual-jsonl', 'manual-text'].includes(trace.source.kind)
    || !['captured-events', 'submitted-reports'].includes(trace.source.frequency)
    || typeof trace.source.partial !== 'boolean' || trace.source.retention !== 'unknown') throw new Error('Invalid trace source.');
  if (trace.latestRun && !['passed', 'failed', 'blocked', 'error', 'interrupted'].includes(trace.latestRun.status)) {
    throw new Error('Invalid trace run status.');
  }
  const lines = ['# Event trace', '', 'Event ID:', '', literal(text(trace.eventId, 'trace.eventId')),
    `Found in saved input: ${trace.found ? 'yes' : 'no'}`,
    `Input SHA-256: ${checked(trace.source.inputSha256, shaPattern, 'trace.source.inputSha256')}`,
    `Analysis SHA-256: ${checked(trace.source.analysisSha256, shaPattern, 'trace.source.analysisSha256')}`,
    `Source: ${trace.source.kind} / ${trace.source.frequency}`,
    `Partial export: ${trace.source.partial ? 'yes' : 'no'}`,
    `Retention coverage: ${trace.source.retention}`,
    `Linked runs in scope: ${count(trace.runCount, 'trace.runCount')}`,
    ...(trace.selectedTargetFingerprint ? [`Selected target fingerprint: ${validatedTargetFingerprint(trace.selectedTargetFingerprint, 'trace.selectedTargetFingerprint')}`] : []),
    ...(trace.latestRun ? [`Latest linked run: ${checked(trace.latestRun.runId, runPattern, 'trace.latestRun.runId')} (${trace.latestRun.status})`] : []),
    '', '## Matching groups', ''];
  if (!trace.matches.length) lines.push('No matching group in this saved input.', '');
  for (const match of trace.matches) {
    if (!['unselected', 'blocked', 'review-ready'].includes(match.status)) throw new Error('Invalid trace group status.');
    lines.push(`### ${checked(match.groupId, groupPattern, 'trace.match.groupId')}`, '', 'Project / environment / release:', '', literal(`${match.project} / ${match.environment} / ${match.release}`),
      `Supplied records: ${count(match.suppliedRecords, 'trace.match.suppliedRecords')}`, `Candidate status: ${match.status}`,
      'Reasons:', '', literal(match.reasons.join(', ') || 'none'), '', 'Next action:', '', literal(match.nextAction), '', 'Cases:', '');
    if (!match.cases.length) lines.push('No selected TC in this bundle.', '');
    for (const item of match.cases) {
      if ((item.state !== 'draft' && item.state !== 'needs-context') || !caseStatuses.has(item.status)) throw new Error('Invalid trace case.');
      lines.push(`- ${checked(item.caseId, casePattern, 'trace.case.caseId')} / ${checked(item.candidateId, casePattern, 'trace.case.candidateId')}: ${item.state}, ${item.status}`);
      if (item.blockers.length) lines.push('  Blockers:', '', literal(item.blockers.join('\n')), '');
      if (item.reason) lines.push('  Latest outcome reason:', '', literal(item.reason), '');
    }
    lines.push('');
  }
  lines.push('## Available targets', '');
  if (!trace.availableTargets.length) lines.push('No fingerprinted targets were found.', '');
  else for (const target of trace.availableTargets) lines.push(`- ${validatedTargetFingerprint(target.fingerprint, 'trace.target.fingerprint')}: ${count(target.runCount, 'trace.target.runCount')} linked run(s)`);
  lines.push('', '## Warnings and limits', '', literal(trace.warnings.join('\n') || 'None'), '');
  return `${lines.join('\n')}\n`;
}
