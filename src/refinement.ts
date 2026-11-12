import { readVerifiedBundle } from './artifacts.ts';
import { createCandidates, parseProfile } from './candidates.ts';
import { validateInputSource } from './input-source.ts';
import { redactText } from './redact.ts';
import type { Analysis, EventType, IssueGroup, Runtime } from './types.ts';
import { hash, parseWebSteps, record } from './validation.ts';

const sha256 = /^[a-f0-9]{64}$/;
const groupId = /^group-[a-f0-9]{16}$/;
const caseId = /^TC_[a-f0-9]{16}$/;
const eventTypes = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const runtimes = new Set<Runtime>(['browser', 'webview-ios', 'webview-android', 'unknown']);
const kinds = new Set(['browser-error-json', 'manual-json', 'manual-text', 'browser-error-jsonl', 'manual-jsonl']);
const refinementNote = 'Refinement: Original input records were not rechecked; group ranking and the existing TC selection were preserved. Candidates were regenerated from the verified snapshot and supplied profile.';

function invalid(label: string): never { throw new Error(`Invalid analysis snapshot: ${label}.`); }

function string(value: unknown, label: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) invalid(label);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) string(value, label, true);
}

function strings(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) invalid(label);
  for (const [index, item] of value.entries()) string(item, `${label}[${index}]`, true);
}

function optionalStrings(value: unknown, label: string): void {
  if (value !== undefined) strings(value, label);
}

function integer(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(label);
}

function steps(value: unknown, label: string, required: boolean): void {
  if (value === undefined && !required) return;
  if (!Array.isArray(value)) invalid(label);
  parseWebSteps(value, label);
}

function coverage(value: unknown, label: string): void {
  const raw = record(value, label);
  if (!kinds.has(raw.kind as string) ||
    raw.frequency !== (raw.kind === 'browser-error-json' || raw.kind === 'browser-error-jsonl' ? 'captured-events' : 'submitted-reports') ||
    typeof raw.partial !== 'boolean' || raw.retention !== 'unknown') invalid(label);
  integer(raw.inputCount, `${label}.inputCount`, 1);
  integer(raw.duplicates, `${label}.duplicates`);
  integer(raw.filtered, `${label}.filtered`);
  if (raw.period !== undefined) {
    const period = record(raw.period, `${label}.period`);
    optionalString(period.from, `${label}.period.from`);
    optionalString(period.to, `${label}.period.to`);
  }
}

function observation(value: unknown, label: string): void {
  const raw = record(value, label);
  for (const field of ['id', 'project', 'environment', 'release', 'message'] as const) string(raw[field], `${label}.${field}`);
  if (raw.source !== 'browser-error' && raw.source !== 'manual') invalid(`${label}.source`);
  if (!eventTypes.has(raw.type as EventType) || !runtimes.has(raw.runtime as Runtime)) invalid(`${label}.type/runtime`);
  for (const field of ['name', 'stack', 'componentStack', 'page', 'occurredAt', 'viewId', 'expected', 'expectedSource'] as const) {
    optionalString(raw[field], `${label}.${field}`);
  }
  for (const field of ['reproduction', 'preconditions', 'questions'] as const) strings(raw[field], `${label}.${field}`);
  steps(raw.steps, `${label}.steps`, true);
  if (raw.network !== undefined) {
    const network = record(raw.network, `${label}.network`);
    string(network.method, `${label}.network.method`);
    string(network.url, `${label}.network.url`);
    if (network.status !== undefined) {
      integer(network.status, `${label}.network.status`, 100);
      if (network.status > 599) invalid(`${label}.network.status`);
    }
    if (network.durationMs !== undefined && (typeof network.durationMs !== 'number' || !Number.isFinite(network.durationMs) || network.durationMs < 0)) {
      invalid(`${label}.network.durationMs`);
    }
  }
}

function context(value: unknown, label: string, required: boolean): void {
  const missing = (): never => { throw new Error('Selected group lacks full source context. Reanalyze the original input before refining.'); };
  if (value === undefined) {
    if (required) missing();
    return;
  }
  try {
    const raw = record(value, label);
    for (const field of ['expected', 'expectedSource'] as const) optionalString(raw[field], `${label}.${field}`);
    for (const field of ['reproduction', 'preconditions'] as const) optionalStrings(raw[field], `${label}.${field}`);
    steps(raw.steps, `${label}.steps`, false);
    strings(raw.questions, `${label}.questions`);
    strings(raw.conflicts, `${label}.conflicts`);
  } catch (error) {
    if (required) missing();
    throw error;
  }
}

function group(value: unknown, label: string, requireContext: boolean): IssueGroup {
  const raw = record(value, label);
  if (typeof raw.id !== 'string' || !groupId.test(raw.id)) invalid(`${label}.id`);
  if (raw.fingerprintVersion !== 1) invalid(`${label}.fingerprintVersion`);
  for (const field of ['project', 'environment', 'release', 'signature', 'message'] as const) string(raw[field], `${label}.${field}`);
  string(raw.pagePath, `${label}.pagePath`, true);
  if (!eventTypes.has(raw.type as EventType) || !runtimes.has(raw.runtime as Runtime)) invalid(`${label}.type/runtime`);
  integer(raw.count, `${label}.count`, 1);
  integer(raw.viewCount, `${label}.viewCount`);
  if (raw.viewCount > raw.count) invalid(`${label}.viewCount`);
  optionalString(raw.lastOccurredAt, `${label}.lastOccurredAt`);
  strings(raw.eventIds, `${label}.eventIds`);
  if (raw.eventIds.length !== raw.count) invalid(`${label}.eventIds`);
  if (!Array.isArray(raw.evidence) || raw.evidence.length < 1 || raw.evidence.length > 5 || raw.evidence.length > raw.count) invalid(`${label}.evidence`);
  for (const [index, item] of raw.evidence.entries()) {
    observation(item, `${label}.evidence[${index}]`);
    if (!raw.eventIds.includes((item as { id: string }).id)) invalid(`${label}.evidence[${index}].id`);
  }
  context(raw.context, `${label}.context`, requireContext);
  return raw as unknown as IssueGroup;
}

function checkedAnalysis(value: unknown, provenance: Record<string, unknown>): { analysis: Analysis; selectedGroups: IssueGroup[] } {
  const raw = record(value, 'analysis');
  if (raw.schemaVersion !== 'error-to-test/analysis-1') invalid('schemaVersion');
  const source = record(raw.source, 'analysis.source');
  validateInputSource(source);
  if (source.profileSha256 !== undefined && (typeof source.profileSha256 !== 'string' || !sha256.test(source.profileSha256))) invalid('source.profileSha256');
  coverage(raw.coverage, 'analysis.coverage');
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.candidates)) invalid('groups/candidates');
  strings(raw.warnings, 'analysis.warnings');
  if (raw.selection !== undefined) {
    const selection = record(raw.selection, 'analysis.selection');
    if (selection.mode !== 'only-current') invalid('selection.mode');
    const baseline = record(selection.baseline, 'analysis.selection.baseline');
    for (const field of ['inputSha256', 'analysisSha256'] as const) {
      if (typeof baseline[field] !== 'string' || !sha256.test(baseline[field])) invalid(`selection.baseline.${field}`);
    }
    coverage(baseline.coverage, 'analysis.selection.baseline.coverage');
    integer(selection.onlyCurrentGroupCount, 'analysis.selection.onlyCurrentGroupCount');
    integer(selection.excludedGroupCount, 'analysis.selection.excludedGroupCount');
  }
  if (raw.groupFilter !== undefined) {
    const filter = record(raw.groupFilter, 'analysis.groupFilter');
    strings(filter.groupIds, 'analysis.groupFilter.groupIds');
    if (filter.groupIds.some(id => !groupId.test(id)) || new Set(filter.groupIds).size !== filter.groupIds.length) invalid('groupFilter.groupIds');
  }

  const selectedIds = new Set<string>();
  const candidateIds = new Set<string>();
  if (!Array.isArray(provenance.mappings) || provenance.mappings.length !== raw.candidates.length) invalid('provenance.mappings');
  for (const [index, value] of raw.candidates.entries()) {
    const candidate = record(value, `analysis.candidates[${index}]`);
    const mapping = record(provenance.mappings[index], `provenance.mappings[${index}]`);
    if (typeof candidate.id !== 'string' || !caseId.test(candidate.id) || candidateIds.has(candidate.id)) invalid(`analysis.candidates[${index}].id`);
    if (typeof candidate.groupId !== 'string' || !groupId.test(candidate.groupId)) invalid(`analysis.candidates[${index}].groupId`);
    strings(candidate.eventIds, `analysis.candidates[${index}].eventIds`);
    if (mapping.caseId !== candidate.id || mapping.candidateId !== candidate.id || mapping.groupId !== candidate.groupId ||
      JSON.stringify(mapping.eventIds) !== JSON.stringify(candidate.eventIds)) invalid(`provenance.mappings[${index}]`);
    candidateIds.add(candidate.id);
    selectedIds.add(candidate.groupId);
  }
  if (!selectedIds.size) throw new Error('Refinement requires at least one selected candidate group.');
  const seenGroups = new Set<string>();
  const selectedGroups: IssueGroup[] = [];
  for (const [index, value] of raw.groups.entries()) {
    const item = group(value, `analysis.groups[${index}]`, selectedIds.has((value as { id?: unknown } | null)?.id as string));
    if (seenGroups.has(item.id)) invalid(`analysis.groups[${index}].id`);
    seenGroups.add(item.id);
    if (selectedIds.has(item.id)) selectedGroups.push(item);
  }
  if (selectedGroups.length !== selectedIds.size) invalid('selected candidate group');
  for (const [index, value] of raw.candidates.entries()) {
    const candidate = value as { groupId: string; eventIds: string[] };
    const selected = selectedGroups.find(item => item.id === candidate.groupId)!;
    if (JSON.stringify(candidate.eventIds) !== JSON.stringify([...new Set(selected.eventIds)])) invalid(`analysis.candidates[${index}].eventIds`);
  }
  return { analysis: raw as unknown as Analysis, selectedGroups };
}

/** Rebuild candidates from a verified analysis snapshot without reading the original input or writing artifacts. */
export async function refineBundle(directory: string, profile: string): Promise<Analysis> {
  if (typeof profile !== 'string') throw new Error('The profile must be JSON text.');
  if (Buffer.byteLength(profile, 'utf8') > 1024 * 1024) throw new Error('The profile must be 1 MiB or smaller.');
  let parsed: unknown;
  try { parsed = JSON.parse(profile.replace(/^\uFEFF/, '')); }
  catch { throw new Error('The profile is not valid JSON.'); }
  const appProfile = parseProfile(parsed);
  if (appProfile.scenarios.some(rule => redactText(rule.id) !== rule.id ||
    (rule.match.groupId !== undefined && redactText(rule.match.groupId) !== rule.match.groupId))) {
    throw new Error('The profile contains sensitive scenario IDs; remove them before refining.');
  }
  const verified = await readVerifiedBundle(directory);
  const { analysis, selectedGroups } = checkedAnalysis(verified.analysis, verified.provenance);
  const candidates = createCandidates(selectedGroups, appProfile);
  if (candidates.length > 100) throw new Error(`Flow QA supports at most 100 cases; received ${candidates.length}. Narrow the selected scenario rules.`);
  const sourceAnalysisSha256 = verified.provenance.analysisSha256;
  if (typeof sourceAnalysisSha256 !== 'string' || !sha256.test(sourceAnalysisSha256)) invalid('provenance.analysisSha256');
  const sourceSuiteSha256 = verified.provenance.suiteSha256;
  if (sourceSuiteSha256 !== undefined && (typeof sourceSuiteSha256 !== 'string' || !sha256.test(sourceSuiteSha256))) invalid('provenance.suiteSha256');
  const sourceProfileSha256 = verified.provenance.profileSha256;
  if (sourceProfileSha256 !== undefined && (typeof sourceProfileSha256 !== 'string' || !sha256.test(sourceProfileSha256))) invalid('provenance.profileSha256');
  return {
    ...analysis,
    source: { ...analysis.source, profileSha256: hash(profile) },
    candidates,
    warnings: [...analysis.warnings.filter(note => !note.startsWith('Refinement:')), refinementNote],
    refinement: { sourceAnalysisSha256, ...(sourceSuiteSha256 === undefined ? {} : { sourceSuiteSha256 }),
      ...(sourceProfileSha256 === undefined ? {} : { sourceProfileSha256 }), selectedGroupIds: selectedGroups.map(item => item.id) },
  };
}
