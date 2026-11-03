import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { literal, readVerifiedBundle } from './artifacts.ts';
import { redactText } from './redact.ts';
import { record, text, timestamp } from './validation.ts';

export type LinkedRunStatus = 'passed' | 'failed' | 'blocked' | 'error' | 'interrupted';
export type LinkedCaseStatus = 'passed' | 'failed' | 'flaky' | 'blocked' | 'skipped' | 'error';
type DisplayCaseStatus = LinkedCaseStatus | 'not-run';

export interface RunSummary {
  schemaVersion: 'error-to-test/run-summary-1';
  inputSha256: string;
  suiteSha256?: string;
  runCount: number;
  latestRun?: { runId: string; status: LinkedRunStatus; startedAt: string; finishedAt: string };
  counts: Record<DisplayCaseStatus, number>;
  groups: { groupId: string; message: string; cases: { caseId: string; candidateId: string; eventIds: string[]; status: DisplayCaseStatus; reason?: string }[] }[];
  warnings: string[];
}

const runStatuses = new Set<LinkedRunStatus>(['passed', 'failed', 'blocked', 'error', 'interrupted']);
const caseStatuses = new Set<LinkedCaseStatus>(['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error']);
const countStatuses: DisplayCaseStatus[] = ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error', 'not-run'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const maxEntries = 1000;
const maxResultBytes = 2 * 1024 * 1024;
const maxTotalBytes = 64 * 1024 * 1024;

type Mapping = { caseId: string; candidateId: string; groupId: string; eventIds: string[] };
type LinkedCase = Mapping & { status: LinkedCaseStatus; reason?: string };
type LinkedRun = NonNullable<RunSummary['latestRun']> & { cases: LinkedCase[] };

function safeId(value: unknown, label: string): string {
  const id = text(value, label);
  if (!safeIdPattern.test(id)) throw new Error(`${label} must be a Flow QA-compatible ID.`);
  return id;
}

function sha256(value: unknown, label: string): string {
  const sha = text(value, label);
  if (!shaPattern.test(sha)) throw new Error(`${label} must be a SHA-256 digest.`);
  return sha;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} has missing or unsupported fields.`);
  }
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function readResultFile(path: string, name: string): Promise<{ content: string; bytes: number }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Linked result ${name} must be a regular file, not a link or directory.`);
  if (before.size > maxResultBytes) throw new Error(`Linked result ${name} exceeds 2 MiB.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`Linked result ${name} changed while opening.`);
    if (opened.size > maxResultBytes) throw new Error(`Linked result ${name} exceeds 2 MiB.`);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxResultBytes + 1 - bytes), null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxResultBytes) throw new Error(`Linked result ${name} exceeds 2 MiB.`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (!after.isFile() || !sameFile(opened, after) || after.size !== bytes || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Linked result ${name} changed while reading.`);
    }
    return { content: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
  } finally {
    await handle.close();
  }
}

function parseResult(content: string, name: string, inputSha256: string, suiteSha256: string | undefined, expected: Map<string, Mapping>): LinkedRun {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(content), `Linked result ${name}`); }
  catch { throw new Error(`Linked result ${name} is not a valid JSON object.`); }
  exactKeys(raw, ['schemaVersion', 'runId', 'inputSha256', 'suiteSha256', 'startedAt', 'finishedAt', 'status', 'cases', 'note'], [], `Linked result ${name}`);
  if (raw.schemaVersion !== 'error-to-test/results-1') throw new Error(`Linked result ${name} uses an unsupported schema.`);
  const runId = text(raw.runId, `${name}.runId`);
  if (!uuidPattern.test(runId) || `${runId}.json` !== name) throw new Error(`Linked result ${name} run ID does not match its filename.`);
  if (raw.inputSha256 !== inputSha256 || raw.suiteSha256 !== suiteSha256 || suiteSha256 === undefined) {
    throw new Error(`Linked result ${name} does not match the verified input and suite.`);
  }
  const status = text(raw.status, `${name}.status`);
  if (!runStatuses.has(status as LinkedRunStatus)) throw new Error(`Linked result ${name} has an invalid run status.`);
  const startedAt = timestamp(raw.startedAt, `${name}.startedAt`);
  const finishedAt = timestamp(raw.finishedAt, `${name}.finishedAt`);
  if (finishedAt < startedAt) throw new Error(`Linked result ${name} finished before it started.`);
  text(raw.note, `${name}.note`);
  if (!Array.isArray(raw.cases) || raw.cases.length !== expected.size) throw new Error(`Linked result ${name} has an incomplete case list.`);
  const seen = new Set<string>();
  const cases = raw.cases.map((item, index): LinkedCase => {
    const label = `${name}.cases[${index}]`;
    const entry = record(item, label);
    exactKeys(entry, ['caseId', 'candidateId', 'groupId', 'eventIds', 'status'], ['reason'], label);
    const caseId = safeId(entry.caseId, `${label}.caseId`);
    const mapping = expected.get(caseId);
    if (!mapping || seen.has(caseId)) throw new Error(`Linked result ${name} has an unknown or duplicate case ID.`);
    seen.add(caseId);
    if (entry.candidateId !== mapping.candidateId || entry.groupId !== mapping.groupId || JSON.stringify(entry.eventIds) !== JSON.stringify(mapping.eventIds)) {
      throw new Error(`Linked result ${name} has a case mapping that differs from verified provenance.`);
    }
    const caseStatus = text(entry.status, `${label}.status`);
    if (!caseStatuses.has(caseStatus as LinkedCaseStatus)) throw new Error(`Linked result ${name} has an invalid case status.`);
    const reason = entry.reason === undefined ? undefined : redactText(text(entry.reason, `${label}.reason`));
    return { ...mapping, eventIds: mapping.eventIds.map(redactText), status: caseStatus as LinkedCaseStatus, ...(reason === undefined ? {} : { reason }) };
  });
  if (seen.size !== expected.size) throw new Error(`Linked result ${name} does not account for every exported case.`);
  if (status === 'passed' && cases.some(item => item.status === 'failed' || item.status === 'error')) {
    throw new Error(`Linked result ${name} contradicts its case results.`);
  }
  return { runId, status: status as LinkedRunStatus, startedAt, finishedAt, cases };
}

function later(a: LinkedRun, b: LinkedRun): boolean {
  if (a.finishedAt !== b.finishedAt) return a.finishedAt > b.finishedAt;
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return a.runId > b.runId;
}

function nonnegativeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value as number;
}

export async function readRunSummary(directory: string): Promise<RunSummary> {
  const root = resolve(directory);
  const { analysis, provenance, verification } = await readVerifiedBundle(root);
  const inputSha256 = sha256(provenance.inputSha256, 'provenance.inputSha256');
  const suiteSha256 = provenance.suiteSha256 === undefined ? undefined : sha256(provenance.suiteSha256, 'provenance.suiteSha256');
  if (Boolean(suiteSha256) !== verification.suite) throw new Error('STALE_BUNDLE: Suite provenance is inconsistent.');
  if (!Array.isArray(analysis.groups) || !Array.isArray(provenance.mappings) || provenance.mappings.length > 100) {
    throw new Error('STALE_BUNDLE: Analysis groups or case mappings are invalid.');
  }
  const groups = analysis.groups.map((item, index) => {
    const group = record(item, `analysis.groups[${index}]`);
    return { groupId: safeId(group.id, `analysis.groups[${index}].id`), message: redactText(text(group.message, `analysis.groups[${index}].message`)), cases: [] as RunSummary['groups'][number]['cases'] };
  });
  const groupById = new Map(groups.map(group => [group.groupId, group]));
  if (groupById.size !== groups.length) throw new Error('STALE_BUNDLE: Analysis group IDs are duplicated.');
  const mappings = provenance.mappings.map((item, index): Mapping => {
    const mapping = record(item, `provenance.mappings[${index}]`);
    const caseId = safeId(mapping.caseId, `provenance.mappings[${index}].caseId`);
    const candidateId = safeId(mapping.candidateId, `provenance.mappings[${index}].candidateId`);
    const groupId = safeId(mapping.groupId, `provenance.mappings[${index}].groupId`);
    if (!groupById.has(groupId)) throw new Error('STALE_BUNDLE: A selected case refers to a missing group.');
    return { caseId, candidateId, groupId, eventIds: stringList(mapping.eventIds, `provenance.mappings[${index}].eventIds`) };
  });
  if ((!verification.suite && mappings.length) || (verification.suite && !mappings.length)) throw new Error('STALE_BUNDLE: Suite and case mappings disagree.');
  const expected = new Map(mappings.map(mapping => [mapping.caseId, mapping]));
  if (expected.size !== mappings.length) throw new Error('STALE_BUNDLE: Case IDs are duplicated.');

  const resultsRoot = join(root, 'results');
  let resultsInfo;
  try { resultsInfo = await lstat(resultsRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let runCount = 0;
  let latest: LinkedRun | undefined;
  if (resultsInfo) {
    if (!resultsInfo.isDirectory() || resultsInfo.isSymbolicLink()) throw new Error('Results must be a real directory inside this bundle.');
    const names: string[] = [];
    const seenNames = new Set<string>();
    let entries = 0;
    for await (const entry of await opendir(resultsRoot)) {
      if (++entries > maxEntries) throw new Error('Results directory exceeds 1000 entries.');
      if (!/\.json$/i.test(entry.name)) continue;
      const name = entry.name;
      const id = name.slice(0, -5);
      if (!uuidPattern.test(id) || !name.endsWith('.json')) throw new Error(`Invalid linked result filename: ${name}.`);
      if (seenNames.has(id.toLowerCase())) throw new Error(`Duplicate linked result UUID: ${id}.`);
      seenNames.add(id.toLowerCase());
      names.push(name);
    }
    let totalBytes = 0;
    for (const name of names) {
      const { content, bytes } = await readResultFile(join(resultsRoot, name), name);
      totalBytes += bytes;
      if (totalBytes > maxTotalBytes) throw new Error('Linked results exceed 64 MiB in total.');
      const run = parseResult(content, name, inputSha256, suiteSha256, expected);
      runCount++;
      if (!latest || later(run, latest)) latest = run;
    }
    const after = await lstat(resultsRoot);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(resultsInfo, after)) throw new Error('Results directory changed while reading.');
  }

  const latestCases = new Map(latest?.cases.map(item => [item.caseId, item]) ?? []);
  const counts = Object.fromEntries(countStatuses.map(status => [status, 0])) as RunSummary['counts'];
  for (const mapping of mappings) {
    const runCase = latestCases.get(mapping.caseId);
    const status = runCase?.status ?? 'not-run';
    counts[status]++;
    groupById.get(mapping.groupId)!.cases.push({
      caseId: mapping.caseId, candidateId: mapping.candidateId, eventIds: mapping.eventIds.map(redactText), status,
      ...(runCase?.reason === undefined ? {} : { reason: runCase.reason }),
    });
  }
  const warnings = ['Counts are the latest reported case outcomes, not proof that any source issue is resolved.'];
  if (analysis.warnings !== undefined) warnings.push(...stringList(analysis.warnings, 'analysis.warnings').map(redactText));
  if (runCount) {
    if (!verification.reviewed) warnings.push('Bundle review is pending. Reported results do not authorize execution.');
    if (!Array.isArray(analysis.candidates)) throw new Error('STALE_BUNDLE: Analysis candidates are missing.');
    if (analysis.candidates.some((item, index) => {
      const candidate = record(item, `analysis.candidates[${index}]`);
      if (candidate.state !== 'draft' && candidate.state !== 'needs-context') throw new Error('STALE_BUNDLE: A selected candidate has an invalid state.');
      return candidate.state === 'needs-context';
    })) warnings.push('One or more selected cases still need context; reported outcomes do not settle the missing information.');
  }
  return {
    schemaVersion: 'error-to-test/run-summary-1', inputSha256,
    ...(suiteSha256 === undefined ? {} : { suiteSha256 }), runCount,
    ...(latest === undefined ? {} : { latestRun: { runId: latest.runId, status: latest.status, startedAt: latest.startedAt, finishedAt: latest.finishedAt } }),
    counts, groups, warnings,
  };
}

export function renderRunSummary(summary: RunSummary): string {
  const lines = ['# Linked run summary', '', `Input SHA-256: ${sha256(summary.inputSha256, 'summary.inputSha256')}`];
  if (summary.suiteSha256 !== undefined) lines.push(`Suite SHA-256: ${sha256(summary.suiteSha256, 'summary.suiteSha256')}`);
  lines.push(`Linked runs: ${nonnegativeCount(summary.runCount, 'summary.runCount')}`, '');
  if (summary.latestRun) {
    const run = summary.latestRun;
    if (!uuidPattern.test(run.runId) || !runStatuses.has(run.status)) throw new Error('Invalid latest run in summary.');
    lines.push('## Latest linked run', '', `Run ID: ${run.runId}`, `Reported status: ${run.status}`,
      `Started: ${timestamp(run.startedAt, 'summary.latestRun.startedAt')}`, `Finished: ${timestamp(run.finishedAt, 'summary.latestRun.finishedAt')}`, '');
  } else lines.push('No linked runs were found. All selected cases are not-run.', '');
  lines.push('## Latest reported case counts', '');
  for (const status of countStatuses) lines.push(`- ${status}: ${nonnegativeCount(summary.counts[status], `summary.counts.${status}`)}`);
  lines.push('', '## Warnings', '');
  lines.push(literal(summary.warnings.join('\n') || 'None'), '');
  if (!summary.groups.length) lines.push('No source groups were found.', '');
  for (const group of summary.groups) {
    const groupId = safeId(group.groupId, 'summary.groupId');
    lines.push(`## ${groupId}`, '', 'Observed message:', '', literal(group.message), '');
    if (!group.cases.length) lines.push('No selected cases for this group.', '');
    for (const item of group.cases) {
      const caseId = safeId(item.caseId, 'summary.caseId');
      const candidateId = safeId(item.candidateId, 'summary.candidateId');
      if (!countStatuses.includes(item.status)) throw new Error('Invalid case status in summary.');
      lines.push(`### ${caseId}`, '', `Candidate ID: ${candidateId}`, `Reported status: ${item.status}`, '');
      if (item.reason !== undefined) lines.push('Reported reason:', '', literal(item.reason), '');
    }
  }
  return `${lines.join('\n')}\n`;
}
