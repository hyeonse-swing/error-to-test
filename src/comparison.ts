import { fencedText, literal, readVerifiedBundle } from './artifacts.ts';
import { pagePath, redactText } from './redact.ts';
import { hash, record, timestamp } from './validation.ts';
import type { EventType, Runtime, SourceCoverage } from './types.ts';

export type ComparisonStatus = 'only-current' | 'both' | 'only-baseline';
export interface ComparisonSide { inputSha256: string; groupCount: number; recordCount: number; coverage: SourceCoverage }
export interface ComparisonOccurrence { count: number; groupIds: string[]; releases: string[] }
export interface ComparisonIssue {
  id: string; status: ComparisonStatus; project: string; environment: string; runtime: Runtime;
  type: EventType; pagePath: string; signature: string; message: string;
  baseline?: ComparisonOccurrence; current?: ComparisonOccurrence; delta: number;
}
export interface AnalysisComparison {
  schemaVersion: 'error-to-test/comparison-1'; baseline: ComparisonSide; current: ComparisonSide;
  counts: Record<ComparisonStatus, number>; issues: ComparisonIssue[]; warnings: string[];
}

const statuses: ComparisonStatus[] = ['only-current', 'both', 'only-baseline'];
const runtimes: Runtime[] = ['browser', 'webview-ios', 'webview-android', 'unknown'];
const types: EventType[] = ['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual'];
const kinds: SourceCoverage['kind'][] = ['browser-error-json', 'manual-json', 'manual-text'];
const normalizedMax = 128 * 1024;
const hex64 = /^[0-9a-f]{64}$/;
const groupId = /^group-[0-9a-f]{16}$/;
const comparisonId = /^comparison-[0-9a-f]{64}$/;
function integer(value: unknown, label: string, max = 10000, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  return value as number;
}
function bounded(value: unknown, label: string, max = normalizedMax, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label} must be a ${required ? 'non-empty ' : ''}string of at most ${max} characters.`);
  return value;
}
function coverage(value: unknown, label: string): SourceCoverage {
  const raw = record(value, label);
  if (!kinds.includes(raw.kind as SourceCoverage['kind'])) throw new Error(`${label}.kind is unsupported.`);
  const kind = raw.kind as SourceCoverage['kind'];
  const frequency = kind === 'browser-error-json' ? 'captured-events' : 'submitted-reports';
  if (raw.frequency !== frequency) throw new Error(`${label}.frequency is incompatible with kind.`);
  if (typeof raw.partial !== 'boolean' || raw.retention !== 'unknown') throw new Error(`${label} has unsupported partial or retention data.`);
  const inputCount = integer(raw.inputCount, `${label}.inputCount`);
  const duplicates = integer(raw.duplicates, `${label}.duplicates`);
  const filtered = integer(raw.filtered, `${label}.filtered`);
  let period: SourceCoverage['period'];
  if (raw.period !== undefined) {
    const p = record(raw.period, `${label}.period`);
    const from = p.from === undefined ? undefined : timestamp(p.from, `${label}.period.from`);
    const to = p.to === undefined ? undefined : timestamp(p.to, `${label}.period.to`);
    if (from && to && from > to) throw new Error(`${label}.period.from exceeds to.`);
    if (!from && !to) throw new Error(`${label}.period must contain a bound.`);
    period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return { kind, frequency, partial: raw.partial, inputCount, duplicates, filtered, retention: 'unknown', ...(period ? { period } : {}) };
}
interface ValidGroup { id: string; project: string; environment: string; release: string; runtime: Runtime; type: EventType; pagePath: string; signature: string; message: string; count: number }
function parseSnapshot(value: unknown, label: string): { side: ComparisonSide; groups: ValidGroup[]; warnings: string[] } {
  const raw = record(value, label), source = record(raw.source, `${label}.source`);
  if (raw.schemaVersion !== 'error-to-test/analysis-1' || typeof source.sha256 !== 'string' || !hex64.test(source.sha256)) throw new Error(`${label} has an unsupported source contract.`);
  const cov = coverage(raw.coverage, `${label}.coverage`);
  if (!Array.isArray(raw.groups) || raw.groups.length > 10000) throw new Error(`${label}.groups must contain at most 10000 groups.`);
  const seen = new Set<string>();
  const groups = raw.groups.map((item, index): ValidGroup => {
    const name = `${label}.groups[${index}]`, g = record(item, name);
    if (g.fingerprintVersion !== 1) throw new Error(`${name} has unsupported fingerprintVersion.`);
    if (typeof g.id !== 'string' || !groupId.test(g.id) || seen.has(g.id)) throw new Error(`${name}.id is invalid or duplicated.`);
    seen.add(g.id);
    if (!runtimes.includes(g.runtime as Runtime) || !types.includes(g.type as EventType)) throw new Error(`${name} has unsupported runtime or type.`);
    return {
      id: g.id, project: bounded(g.project, `${name}.project`), environment: bounded(g.environment, `${name}.environment`),
      release: bounded(g.release, `${name}.release`), runtime: g.runtime as Runtime, type: g.type as EventType,
      pagePath: bounded(g.pagePath, `${name}.pagePath`, normalizedMax, false),
      signature: bounded(g.signature, `${name}.signature`, normalizedMax, false),
      message: bounded(g.message, `${name}.message`), count: integer(g.count, `${name}.count`, 10000, 1),
    };
  });
  const recordCount = groups.reduce((sum, g) => sum + g.count, 0);
  if (recordCount + cov.duplicates + cov.filtered !== cov.inputCount) throw new Error(`${label} group counts do not match source coverage.`);
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 100) throw new Error(`${label}.warnings must contain at most 100 strings.`);
  const warnings = raw.warnings.map((warning, index) => redactText(bounded(warning, `${label}.warnings[${index}]`, normalizedMax, false)));
  return { side: { inputSha256: source.sha256 as string, groupCount: groups.length, recordCount, coverage: cov }, groups, warnings };
}
function key(g: Pick<ValidGroup, 'project' | 'environment' | 'runtime' | 'type' | 'pagePath' | 'signature'>): string { return JSON.stringify([g.project, g.environment, g.runtime, g.type, g.pagePath, g.signature]); }
interface Aggregate { group: ValidGroup; count: number; ids: Set<string>; releases: Set<string> }
function aggregate(groups: ValidGroup[]): Map<string, Aggregate> {
  const map = new Map<string, Aggregate>();
  for (const g of groups) {
    const k = key(g), found = map.get(k);
    if (found) { found.count += g.count; found.ids.add(g.id); found.releases.add(g.release); }
    else map.set(k, { group: g, count: g.count, ids: new Set([g.id]), releases: new Set([g.release]) });
  }
  return map;
}
const sorted = (items: Iterable<string>): string[] => [...items].sort();
function occurrence(a: Aggregate): ComparisonOccurrence { return { count: a.count, groupIds: sorted(a.ids), releases: sorted(a.releases).map(redactText) }; }
export async function compareBundles(baselineDirectory: string, currentDirectory: string): Promise<AnalysisComparison> {
  const baseline = (await readVerifiedBundle(baselineDirectory)).analysis;
  const current = (await readVerifiedBundle(currentDirectory)).analysis;
  return compareAnalyses(baseline, current);
}

// Shared by verified bundle comparison and baseline-aware candidate selection.
// Identity is computed from the stored normalized fields before display redaction.
export function compareAnalyses(baselineAnalysis: unknown, currentAnalysis: unknown): AnalysisComparison {
  const baseline = parseSnapshot(baselineAnalysis, 'Baseline');
  const current = parseSnapshot(currentAnalysis, 'Current');
  if (baseline.side.coverage.frequency !== current.side.coverage.frequency) throw new Error('Comparison requires matching count frequency; captured events and submitted reports cannot share a delta.');
  const before = aggregate(baseline.groups), after = aggregate(current.groups);
  const counts: Record<ComparisonStatus, number> = { 'only-current': 0, both: 0, 'only-baseline': 0 };
  const issues = sorted(new Set([...before.keys(), ...after.keys()])).map((k) => {
    const b = before.get(k), c = after.get(k), group = (c ?? b)!.group;
    const status: ComparisonStatus = b && c ? 'both' : c ? 'only-current' : 'only-baseline';
    counts[status]++;
    const issue: ComparisonIssue = { id: `comparison-${hash(k)}`, status, project: redactText(group.project), environment: redactText(group.environment),
      runtime: group.runtime, type: group.type, pagePath: pagePath(group.pagePath), signature: redactText(group.signature),
      message: redactText(group.message), ...(b ? { baseline: occurrence(b) } : {}), ...(c ? { current: occurrence(c) } : {}),
      delta: (c?.count ?? 0) - (b?.count ?? 0) };
    return { rawKey: k, issue };
  }).sort((a, b) => statuses.indexOf(a.issue.status) - statuses.indexOf(b.issue.status) || (a.rawKey < b.rawKey ? -1 : a.rawKey > b.rawKey ? 1 : 0)).map(entry => entry.issue);
  const warnings = [
    'Counts describe supplied, deduplicated, filtered records only. Absence is not resolution; no error rates or affected-user counts can be inferred. Retention coverage is unknown.',
    'All analysis groups are compared, including groups excluded from TC candidate selection.',
    'Release is excluded from identity. Multiple supplied releases are aggregated; use analyze --release before each bundle for a single-release comparison.',
    ...baseline.warnings.map(w => `Baseline: ${w}`), ...current.warnings.map(w => `Current: ${w}`),
  ];
  if (baseline.side.coverage.partial || current.side.coverage.partial) warnings.push('At least one source export is partial; observed counts may be incomplete.');
  if (baseline.side.coverage.kind !== current.side.coverage.kind) warnings.push('Source kinds differ; counts may reflect different reporting practices.');
  if (JSON.stringify(baseline.side.coverage.period) !== JSON.stringify(current.side.coverage.period)) warnings.push('Source period filters differ or are missing.');
  const contexts = (groups: ValidGroup[]) => sorted(new Set(groups.map(g => JSON.stringify([g.project, g.environment, g.runtime, g.type, g.pagePath]))));
  if (JSON.stringify(contexts(baseline.groups)) !== JSON.stringify(contexts(current.groups))) warnings.push('Observed project/environment/runtime/type/page contexts differ between supplied snapshots.');
  return { schemaVersion: 'error-to-test/comparison-1', baseline: baseline.side, current: current.side, counts, issues, warnings };
}

function renderSide(value: unknown, label: string): string {
  const side = record(value, label), sha = side.inputSha256;
  if (typeof sha !== 'string' || !hex64.test(sha)) throw new Error(`${label}.inputSha256 is invalid.`);
  const cov = coverage(side.coverage, `${label}.coverage`);
  const groupCount = integer(side.groupCount, `${label}.groupCount`), recordCount = integer(side.recordCount, `${label}.recordCount`);
  if (recordCount + cov.duplicates + cov.filtered !== cov.inputCount) throw new Error(`${label} counts do not match coverage.`);
  return `${label}: ${sha} · ${cov.kind} / ${cov.frequency} · ${groupCount} groups / ${recordCount} records · partial ${cov.partial ? 'yes' : 'no'} · period ${cov.period ? `${cov.period.from ?? 'unbounded'} to ${cov.period.to ?? 'unbounded'}` : 'unspecified'} · retention unknown`;
}
function renderOccurrence(value: unknown, label: string): string[] {
  const raw = record(value, label), count = integer(raw.count, `${label}.count`, 10000, 1);
  if (!Array.isArray(raw.groupIds) || raw.groupIds.length > 10000 || !raw.groupIds.every(id => typeof id === 'string' && groupId.test(id))) throw new Error(`${label}.groupIds is invalid.`);
  if (!Array.isArray(raw.releases) || raw.releases.length > 10000) throw new Error(`${label}.releases is invalid.`);
  const releases = raw.releases.map((release, i) => bounded(release, `${label}.releases[${i}]`));
  return [`${label}: ${count} records`, '', fencedText(`Releases: ${releases.map(redactText).join(', ')}\nGroup IDs: ${sorted(raw.groupIds as string[]).join(', ')}`), ''];
}
export function renderComparison(comparison: AnalysisComparison): string {
  const raw = record(comparison, 'comparison');
  if (raw.schemaVersion !== 'error-to-test/comparison-1') throw new Error('Unsupported comparison contract.');
  const counts = record(raw.counts, 'comparison.counts');
  for (const status of statuses) integer(counts[status], `comparison.counts.${status}`);
  if (!Array.isArray(raw.issues) || raw.issues.length > 20000) throw new Error('comparison.issues is invalid.');
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 300) throw new Error('comparison.warnings is invalid.');
  const lines = ['# Error to Test comparison', '', renderSide(raw.baseline, 'Baseline'), renderSide(raw.current, 'Current'), '',
    `Only current: ${counts['only-current']} · Both: ${counts.both} · Only baseline: ${counts['only-baseline']}`, '',
    'Counts refer to supplied records. Absence does not establish resolution or an error rate.', ''];
  if (raw.warnings.length) lines.push('## Coverage notes', '', literal(raw.warnings.map((w, i) => bounded(w, `comparison.warnings[${i}]`, normalizedMax, false)).join('\n')), '');
  const observed: Record<ComparisonStatus, number> = { 'only-current': 0, both: 0, 'only-baseline': 0 };
  for (const [index, value] of raw.issues.entries()) {
    const name = `comparison.issues[${index}]`, issue = record(value, name);
    if (typeof issue.id !== 'string' || !comparisonId.test(issue.id) || !statuses.includes(issue.status as ComparisonStatus)) throw new Error(`${name} has invalid id or status.`);
    if (!runtimes.includes(issue.runtime as Runtime) || !types.includes(issue.type as EventType)) throw new Error(`${name} has invalid runtime or type.`);
    const status = issue.status as ComparisonStatus;
    const before = issue.baseline === undefined ? 0 : integer(record(issue.baseline, `${name}.baseline`).count, `${name}.baseline.count`, 10000, 1);
    const after = issue.current === undefined ? 0 : integer(record(issue.current, `${name}.current`).count, `${name}.current.count`, 10000, 1);
    if ((status === 'both' && (!before || !after)) || (status === 'only-current' && (before || !after)) || (status === 'only-baseline' && (!before || after)) || integer(issue.delta, `${name}.delta`, 10000, -10000) !== after - before) throw new Error(`${name} has inconsistent status or delta.`);
    observed[status]++;
    const fields = [redactText(bounded(issue.project, `${name}.project`)), redactText(bounded(issue.environment, `${name}.environment`)), issue.runtime, issue.type,
      pagePath(bounded(issue.pagePath, `${name}.pagePath`, normalizedMax, false)), redactText(bounded(issue.signature, `${name}.signature`, normalizedMax, false)), redactText(bounded(issue.message, `${name}.message`))];
    lines.push(`## ${issue.id} · ${status}`, '', `Baseline: ${before} · Current: ${after} · Delta: ${after - before >= 0 ? '+' : ''}${after - before}`, '',
      fencedText(`Project: ${fields[0]}\nEnvironment: ${fields[1]}\nRuntime: ${fields[2]}\nType: ${fields[3]}\nPage: ${fields[4]}\nMessage: ${fields[6]}\nSignature: ${fields[5]}`), '');
    if (issue.baseline !== undefined) lines.push(...renderOccurrence(issue.baseline, 'Baseline'));
    if (issue.current !== undefined) lines.push(...renderOccurrence(issue.current, 'Current'));
  }
  if (statuses.some(status => observed[status] !== counts[status])) throw new Error('Comparison bucket counts do not match issues.');
  return `${lines.join('\n')}\n`;
}
