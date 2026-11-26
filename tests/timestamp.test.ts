import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { groupObservations } from '../src/grouping.ts';
import { parseInput } from '../src/input.ts';
import { linkFlowQaReport } from '../src/results.ts';
import { readRunSummary } from '../src/run-summary.ts';
import { compareTimestamps, timestamp } from '../src/validation.ts';

test('time filter keeps only observations within precise inclusive bounds', () => {
  const base = '2026-11-26T12:00:00.';
  const fractions = ['123100', '123400', '123500', '123600', '123900', '124000'];
  const content = JSON.stringify({
    schemaVersion: 'error-to-test/manual-1',
    errors: fractions.map((fraction, index) => ({
      id: `T${index}`, project: 'shop', message: 'Checkout failed', occurredAt: `${base}${fraction}Z`,
    })),
  });
  const result = parseInput(content, { from: `${base}123400Z`, to: `${base}123600Z` });
  assert.deepEqual(result.observations.map(item => item.id), ['T1', 'T2', 'T3']);
  assert.equal(result.coverage.filtered, 3);
  assert.deepEqual(result.coverage.period, {
    from: `${base}123400000Z`, to: `${base}123600000Z`,
  });
  assert.throws(() => parseInput(content, { from: `${base}123600Z`, to: `${base}123400Z` }), /from must not exceed to/);
});

test('timestamp normalization preserves nanoseconds and legacy milliseconds across offsets', () => {
  assert.equal(timestamp('2026-11-26T12:00:00.123456789+09:00', 'sample'),
    '2026-11-26T03:00:00.123456789Z');
  assert.equal(timestamp('2026-11-26T03:00:00.123000000Z', 'sample'),
    '2026-11-26T03:00:00.123Z');
  assert.equal(timestamp('2026-11-26T03:00:00Z', 'sample'),
    '2026-11-26T03:00:00.000Z');
  assert.equal(compareTimestamps('2026-11-26T03:00:00.123Z', '2026-11-26T03:00:00.123400000Z'), -1);
  assert.equal(compareTimestamps('2026-11-26T03:00:00.123456789Z', '2026-11-26T03:00:00.123456788Z'), 1);
  assert.throws(() => timestamp('2026-02-30T03:00:00.123Z', 'sample'), /valid timestamp/);
});

test('group ranking and representative evidence use precise occurrence order', () => {
  const content = JSON.stringify({
    schemaVersion: 'error-to-test/manual-1',
    errors: [
      { id: 'older', project: 'shop', message: 'Shared failure', occurredAt: '2026-11-26T03:00:00.123Z' },
      { id: 'newer', project: 'shop', message: 'Shared failure', occurredAt: '2026-11-26T03:00:00.123400Z' },
      { id: 'third', project: 'shop', message: 'Other failure', occurredAt: '2026-11-26T03:00:00.123200Z' },
    ],
  });
  const groups = groupObservations(parseInput(content).observations);
  assert.equal(groups[0]?.message, 'Shared failure');
  assert.equal(groups[0]?.lastOccurredAt, '2026-11-26T03:00:00.123400000Z');
  assert.deepEqual(groups[0]?.evidence.map(item => item.id), ['newer', 'older']);
});

test('linked runs reject a sub-millisecond reversal and select the truly latest run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'error-to-test-precise-runs-'));
  const bundle = join(directory, 'bundle');
  try {
    await writeBundle(bundle, analyzeErrors('Error: observed'));
    const provenance = JSON.parse(await readFile(join(bundle, 'provenance.json'), 'utf8'));
    const makeReport = (startedAt: string, finishedAt: string) => ({
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      startedAt, finishedAt, status: 'blocked',
      cases: provenance.mappings.map((mapping: { caseId: string }) => ({ id: mapping.caseId, status: 'blocked' })),
    });
    const base = '2026-11-26T12:00:00.';
    await assert.rejects(linkFlowQaReport(bundle, makeReport(`${base}123600Z`, `${base}123400Z`)),
      /finished before its start/);
    const later = makeReport(`${base}123300Z`, `${base}123500Z`);
    await linkFlowQaReport(bundle, later);
    await linkFlowQaReport(bundle, makeReport(`${base}123Z`, `${base}123400Z`));
    const summary = await readRunSummary(bundle);
    assert.equal(summary.latestRun?.runId, later.runId);
    assert.equal(summary.latestRun?.finishedAt, `${base}123500000Z`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
