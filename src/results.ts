import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonText, readBoundedFile, verifyBundle } from './artifacts.ts';
import { record, text, timestamp } from './validation.ts';
import { redactText } from './redact.ts';

const runStatuses = new Set(['passed', 'failed', 'blocked', 'error', 'interrupted']);
const caseStatuses = new Set(['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error']);

/** Associate a normalized Flow QA report with the exact exported immutable suite. */
export async function linkFlowQaReport(directory: string, rawReport: unknown): Promise<string> {
  const root = resolve(directory);
  const verified = await verifyBundle(root);
  if (!verified.suite) throw new Error('This bundle has no suite to associate with a run.');
  const provenance = record(JSON.parse(await readBoundedFile(resolve(root, 'provenance.json'))), 'provenance');
  const report = record(rawReport, 'report');
  if (report.schemaVersion !== 'flow-qa/report-1') throw new Error('Use a normalized Flow QA report-1, not an e2e raw report.');
  const runId = text(report.runId, 'report.runId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid Flow QA run ID.');
  if (report.suiteHash !== provenance.suiteSha256) throw new Error('The run used a different suite. Its result cannot be linked to these candidates.');
  const status = text(report.status, 'report.status');
  if (!runStatuses.has(status)) throw new Error('Invalid Flow QA run status.');
  if (!Array.isArray(report.cases) || report.cases.length > 100 || !Array.isArray(provenance.mappings)) throw new Error('Invalid Flow QA case list.');
  const mappings = provenance.mappings.map((item, index) => record(item, `mappings[${index}]`));
  const expected = new Map(mappings.map(item => [item.caseId, item]));
  const seen = new Set<string>();
  const cases = report.cases.map((item, index) => {
    const original = record(item, `report.cases[${index}]`), id = text(original.id, 'case.id');
    const mapping = expected.get(id);
    if (!mapping || seen.has(id)) throw new Error('The report contains unknown or duplicate case IDs.');
    seen.add(id);
    const caseStatus = text(original.status, 'case.status');
    if (!caseStatuses.has(caseStatus)) throw new Error('Invalid Flow QA case status.');
    return { ...mapping, status: caseStatus, ...(original.reason === undefined ? {} : { reason: redactText(text(original.reason, 'case.reason')) }) };
  });
  if (seen.size !== expected.size) throw new Error('The report does not account for every exported case.');
  if (status === 'passed' && cases.some(item => item.status === 'failed' || item.status === 'error')) throw new Error('The report status contradicts its case results.');
  const startedAt = timestamp(report.startedAt, 'report.startedAt'), finishedAt = timestamp(report.finishedAt, 'report.finishedAt');
  if (finishedAt < startedAt) throw new Error('The run finished before its start timestamp.');
  const output = {
    schemaVersion: 'error-to-test/results-1', runId,
    inputSha256: provenance.inputSha256, suiteSha256: provenance.suiteSha256,
    startedAt, finishedAt,
    status, cases,
    note: 'These results cover the specified assertions. No source issue was automatically closed.',
  };
  const resultsRoot = resolve(root, 'results');
  try { await mkdir(resultsRoot, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await lstat(resultsRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Results must be stored in a real directory inside this bundle.');
  }
  const file = resolve(resultsRoot, `${runId}.json`);
  await writeFile(file, jsonText(output), { flag: 'wx', mode: 0o600 });
  return file;
}
