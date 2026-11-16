import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { linkFlowQaReport } from '../src/results.ts';
import { readRunSummary, renderRunSummary, type LinkedCaseStatus } from '../src/run-summary.ts';

const input = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'a1', message: 'A failure' }, { id: 'a2', message: 'A failure' }, { id: 'b1', message: 'B failure' },
] });

async function makeBundle(temp: string, twoCases = false): Promise<{ out: string; provenance: any }> {
  const out = join(temp, 'bundle');
  const analysis = analyzeErrors(input, { top: 1 });
  if (twoCases) analysis.candidates = [analysis.candidates[0]!, { ...analysis.candidates[0]!, id: 'TC_second' }];
  await writeBundle(out, analysis);
  return { out, provenance: JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8')) };
}

function report(provenance: any, statuses: LinkedCaseStatus[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
    startedAt: '2026-10-13T00:00:00Z', finishedAt: '2026-10-13T00:01:00Z', status: 'blocked',
    cases: provenance.mappings.map((mapping: { caseId: string }, index: number) => ({ id: mapping.caseId, status: statuses[index] })),
    ...overrides,
  };
}

test('all ranked groups remain visible; no run and no suite are successful zero-result summaries', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-empty-'));
  try {
    const { out } = await makeBundle(temp);
    const summary = await readRunSummary(out);
    assert.equal(summary.runCount, 0);
    assert.equal(summary.latestRun, undefined);
    assert.equal(summary.counts['not-run'], 1);
    assert.equal(summary.groups.length, 2);
    assert.deepEqual(summary.groups.map(group => group.cases.length), [1, 0]);
    assert.match(renderRunSummary(summary), /No selected cases for this group/);
    assert.match(renderRunSummary(summary), /not proof that any source issue is resolved/);

    const noSuite = join(temp, 'no-suite');
    await writeBundle(noSuite, analyzeErrors(input, { minCount: 3 }));
    const zero = await readRunSummary(noSuite);
    assert.equal(zero.suiteSha256, undefined);
    assert.equal(zero.runCount, 0);
    assert.deepEqual(Object.values(zero.counts), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(zero.groups.map(group => group.cases.length), [0, 0]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('latest complete run determines every case; timestamps beat insertion and mtime, and ties use start then run ID', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-latest-'));
  try {
    const { out, provenance } = await makeBundle(temp, true);
    const newer = report(provenance, ['failed', 'passed'], {
      runId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', startedAt: '2026-10-13T10:00:00+09:00', finishedAt: '2026-10-13T10:01:00+09:00', status: 'failed',
    });
    const newerPath = await linkFlowQaReport(out, newer);
    const older = report(provenance, ['passed', 'blocked'], {
      runId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB', startedAt: '2026-10-13T00:00:00Z', finishedAt: '2026-10-13T00:01:00Z', status: 'blocked',
    });
    const olderPath = await linkFlowQaReport(out, older);
    await utimes(newerPath, new Date('2020-01-01'), new Date('2020-01-01'));
    await utimes(olderPath, new Date('2030-01-01'), new Date('2030-01-01'));
    let summary = await readRunSummary(out);
    assert.equal(summary.runCount, 2);
    assert.deepEqual(summary.latestRun, { runId: newer.runId, status: 'failed', startedAt: '2026-10-13T01:00:00.000Z', finishedAt: '2026-10-13T01:01:00.000Z' });
    assert.deepEqual(summary.groups[0]!.cases.map(item => item.status), ['failed', 'passed']);
    assert.equal(summary.counts.blocked, 0);
    assert.match(summary.warnings.join('\n'), /review is pending/i);
    assert.match(summary.warnings.join('\n'), /need context/i);

    const tiedEarlierStart = report(provenance, ['flaky', 'skipped'], {
      runId: 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC', startedAt: '2026-10-13T00:30:00Z', finishedAt: '2026-10-13T01:01:00Z',
    });
    await linkFlowQaReport(out, tiedEarlierStart);
    summary = await readRunSummary(out);
    assert.equal(summary.latestRun?.runId, newer.runId);
    const tiedLaterId = report(provenance, ['flaky', 'skipped'], {
      runId: 'DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD', startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z',
    });
    await linkFlowQaReport(out, tiedLaterId);
    summary = await readRunSummary(out);
    assert.equal(summary.runCount, 4);
    assert.equal(summary.latestRun?.runId, tiedLaterId.runId);
    assert.deepEqual(summary.groups[0]!.cases.map(item => item.status), ['flaky', 'skipped']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('latest selected run does not inherit earlier full results, and a later full run clears partial scope', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-selected-'));
  try {
    const { out, provenance } = await makeBundle(temp, true);
    const [first, second] = provenance.mappings.map((item: { caseId: string }) => item.caseId);
    await linkFlowQaReport(out, report(provenance, ['passed', 'passed'], {
      status: 'passed', finishedAt: '2026-10-13T00:01:00Z',
    }));
    const selected = report(provenance, [], {
      status: 'passed', startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:01:00Z',
      cases: [{ id: first, status: 'passed' }], selection: { caseIds: [first], totalCases: 2 },
      target: { name: 'Stage', url: 'https://example.test/private?token=secret' },
    });
    await linkFlowQaReport(out, selected);
    let summary = await readRunSummary(out);
    assert.equal(summary.runCount, 2);
    assert.equal(summary.latestRun?.targetName, 'Stage');
    assert.deepEqual(summary.latestRun?.selection, { mode: 'selected', totalCases: 2, selectedCaseIds: [first] });
    assert.deepEqual(summary.groups[0]!.cases.map(item => [item.caseId, item.status]), [[first, 'passed'], [second, 'not-run']]);
    assert.equal(summary.counts['not-run'], 1);
    assert.match(summary.warnings.join('\n'), /Latest linked run selected 1 of 2 exported cases/);
    assert.match(renderRunSummary(summary), /Selected cases: 1 of 2 exported cases/);

    await linkFlowQaReport(out, report(provenance, ['failed', 'passed'], {
      status: 'failed', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T00:01:00Z',
    }));
    summary = await readRunSummary(out);
    assert.equal(summary.runCount, 3);
    assert.equal(summary.latestRun?.selection, undefined);
    assert.deepEqual(summary.groups[0]!.cases.map(item => item.status), ['failed', 'passed']);
    assert.equal(summary.counts['not-run'], 0);
    assert.doesNotMatch(summary.warnings.join('\n'), /Latest linked run selected/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('target scopes distinguish reused names, exclude legacy runs, and validate every nonselected file', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-targets-'));
  try {
    const { out, provenance } = await makeBundle(temp, true);
    const [first, second] = provenance.mappings.map((item: { caseId: string }) => item.caseId);
    const targetA = { name: 'Stage', url: 'https://example.test/private-a?token=secret-a' };
    const targetB = { name: 'Stage', kind: 'web', url: 'https://example.test/private-b?token=secret-b' };
    const aFull = await linkFlowQaReport(out, report(provenance, ['passed', 'passed'], {
      target: targetA, status: 'passed', finishedAt: '2026-10-13T00:01:00Z',
    }));
    const aFingerprint = JSON.parse(await readFile(aFull, 'utf8')).targetFingerprint as string;
    await linkFlowQaReport(out, report(provenance, [], {
      target: targetA, status: 'passed', startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:01:00Z',
      cases: [{ id: first, status: 'passed' }], selection: { caseIds: [first], totalCases: 2 },
    }));
    const bFull = await linkFlowQaReport(out, report(provenance, ['passed', 'passed'], {
      target: targetB, status: 'passed', startedAt: '2026-10-15T00:00:00Z', finishedAt: '2026-10-15T00:01:00Z',
    }));
    const bOriginal = await readFile(bFull, 'utf8');
    const bFingerprint = JSON.parse(bOriginal).targetFingerprint as string;
    await linkFlowQaReport(out, report(provenance, ['blocked', 'blocked'], {
      startedAt: '2026-10-16T00:00:00Z', finishedAt: '2026-10-16T00:01:00Z',
    }));
    const nameOnly = await linkFlowQaReport(out, report(provenance, ['failed', 'passed'], {
      target: targetA, status: 'failed', startedAt: '2026-10-17T00:00:00Z', finishedAt: '2026-10-17T00:01:00Z',
    }));
    const oldFormat = JSON.parse(await readFile(nameOnly, 'utf8'));
    delete oldFormat.targetFingerprint;
    await writeFile(nameOnly, JSON.stringify(oldFormat));

    const global = await readRunSummary(out);
    assert.equal(global.runCount, 5);
    assert.equal(global.unscopedRunCount, 2);
    assert.equal(global.latestRun?.targetName, 'Stage');
    assert.equal(global.latestRun?.targetFingerprint, undefined);
    assert.equal(global.targets.length, 2);
    assert.deepEqual(global.targets.find(target => target.fingerprint === aFingerprint), { fingerprint: aFingerprint, names: ['Stage'], runCount: 2 });
    assert.deepEqual(global.targets.find(target => target.fingerprint === bFingerprint), { fingerprint: bFingerprint, names: ['Stage'], runCount: 1 });
    assert.match(global.warnings.join('\n'), /contains 2 target fingerprints/);
    assert.match(global.warnings.join('\n'), /2 linked run\(s\) have no target fingerprint/);

    const a = await readRunSummary(out, { targetFingerprint: aFingerprint });
    assert.equal(a.selectedTargetFingerprint, aFingerprint);
    assert.equal(a.runCount, 2);
    assert.equal(a.excludedRunCount, 3);
    assert.equal(a.unscopedRunCount, 2);
    assert.deepEqual(a.groups[0]!.cases.map(item => [item.caseId, item.status]), [[first, 'passed'], [second, 'not-run']]);
    assert.equal(a.counts['not-run'], 1);
    assert.equal(a.latestRun?.targetFingerprint, aFingerprint);
    assert.match(a.warnings.join('\n'), /excludes 3 linked run\(s\), including 2 unscoped/);
    const b = await readRunSummary(out, { targetFingerprint: bFingerprint });
    assert.equal(b.runCount, 1);
    assert.deepEqual(b.groups[0]!.cases.map(item => item.status), ['passed', 'passed']);
    assert.equal(b.counts['not-run'], 0);
    for (const output of [JSON.stringify(a), renderRunSummary(a), JSON.stringify(global), renderRunSummary(global)]) {
      for (const secret of ['private-a', 'private-b', 'secret-a', 'secret-b']) assert.ok(!output.includes(secret));
    }
    assert.match(renderRunSummary(global), /Available targets/);
    assert.match(renderRunSummary(a), /Selected target fingerprint/);

    await assert.rejects(readRunSummary(out, { targetFingerprint: 'F'.repeat(64) }), /lowercase SHA-256 fingerprint/);
    await assert.rejects(readRunSummary(out, { targetFingerprint: 'f'.repeat(64) }), /No linked runs match/);
    await assert.rejects(readRunSummary(out, { targetFingerpint: aFingerprint } as any), /support only targetFingerprint/);
    const tampered = JSON.parse(bOriginal);
    tampered.targetFingerprint = 'A'.repeat(64);
    await writeFile(bFull, JSON.stringify(tampered));
    await assert.rejects(readRunSummary(out, { targetFingerprint: aFingerprint }), /lowercase SHA-256 fingerprint/);
    await writeFile(bFull, bOriginal);
    assert.equal((await readRunSummary(out, { targetFingerprint: aFingerprint })).runCount, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('selected linked result scope is validated against the full provenance even when another run is newer', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-selected-tamper-'));
  try {
    const { out, provenance } = await makeBundle(temp, true);
    const [first, second] = provenance.mappings.map((item: { caseId: string }) => item.caseId);
    const partialPath = await linkFlowQaReport(out, report(provenance, [], {
      cases: [{ id: first, status: 'passed' }], selection: { caseIds: [first], totalCases: 2 },
    }));
    await linkFlowQaReport(out, report(provenance, ['passed', 'passed'], {
      status: 'passed', startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:01:00Z',
    }));
    const original = JSON.parse(await readFile(partialPath, 'utf8'));
    const variants: [string, (value: any) => void, RegExp][] = [
      ['undeclared subset', value => { delete value.selection; }, /incomplete case list/],
      ['wrong mode', value => { value.selection.mode = 'full'; }, /selection mode/],
      ['extra field', value => { value.selection.other = true; }, /selection declaration/],
      ['wrong total', value => { value.selection.totalCases = 3; }, /totalCases/],
      ['zero total', value => { value.selection.totalCases = 0; }, /totalCases/],
      ['wrong case ID', value => { value.selection.selectedCaseIds = [second]; }, /selected case IDs/],
      ['duplicate case IDs', value => { value.selection.selectedCaseIds = [first, first]; }, /selected case IDs/],
      ['unknown case ID', value => { value.selection.selectedCaseIds = ['TC_unknown']; }, /selected case IDs/],
      ['added case', value => { value.cases.push({ ...provenance.mappings[1], status: 'passed' }); }, /totalCases/],
    ];
    for (const [label, mutate, error] of variants) {
      const changed = structuredClone(original);
      mutate(changed);
      await writeFile(partialPath, JSON.stringify(changed));
      await assert.rejects(readRunSummary(out), error, label);
    }
    await writeFile(partialPath, JSON.stringify(original));
    assert.equal((await readRunSummary(out)).runCount, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('all six reported case statuses are retained without inventing a resolved state', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-statuses-'));
  try {
    const out = join(temp, 'bundle');
    const analysis = analyzeErrors('Error: observed');
    analysis.candidates = ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error'].map((_, index) => ({ ...analysis.candidates[0]!, id: `TC_${index}` }));
    await writeBundle(out, analysis);
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    await linkFlowQaReport(out, report(provenance, ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error'], { status: 'failed' }));
    const summary = await readRunSummary(out);
    assert.deepEqual(summary.counts, { passed: 1, failed: 1, flaky: 1, blocked: 1, skipped: 1, error: 1, 'not-run': 0 });
    assert.equal(summary.groups[0]!.cases.length, 6);
    assert.ok(!Object.hasOwn(summary, 'resolved'));
    assert.ok(!Object.hasOwn(summary, 'issueClosed'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('every linked file is validated, including old results when a valid newer result exists', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-invalid-'));
  try {
    const { out, provenance } = await makeBundle(temp);
    const oldPath = await linkFlowQaReport(out, report(provenance, ['blocked'], { finishedAt: '2026-10-13T00:01:00Z' }));
    await linkFlowQaReport(out, report(provenance, ['passed'], { startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:01:00Z', status: 'passed' }));
    const original = JSON.parse(await readFile(oldPath, 'utf8'));
    const variants: [string, (value: any) => void, RegExp][] = [
      ['schema', value => { value.schemaVersion = 'other'; }, /unsupported schema/],
      ['input hash', value => { value.inputSha256 = 'f'.repeat(64); }, /verified input and suite/],
      ['suite hash', value => { value.suiteSha256 = 'f'.repeat(64); }, /verified input and suite/],
      ['filename/run ID', value => { value.runId = randomUUID(); }, /filename/],
      ['case count', value => { value.cases = []; }, /incomplete case list/],
      ['case mapping', value => { value.cases[0].groupId = 'wrong'; }, /mapping/],
      ['unknown case', value => { value.cases[0].caseId = 'TC_unknown'; }, /unknown or duplicate/],
      ['run status', value => { value.status = 'resolved'; }, /invalid run status/],
      ['case status', value => { value.cases[0].status = 'resolved'; }, /invalid case status/],
      ['time order', value => { value.finishedAt = '2026-10-12T00:00:00Z'; }, /before it started/],
      ['invalid time', value => { value.finishedAt = 'not-a-time'; }, /timestamp/],
      ['contradictory pass', value => { value.status = 'passed'; value.cases[0].status = 'failed'; }, /contradicts/],
    ];
    for (const [label, mutate, error] of variants) {
      const changed = structuredClone(original);
      mutate(changed);
      await writeFile(oldPath, JSON.stringify(changed));
      await assert.rejects(readRunSummary(out), error, label);
    }
    await writeFile(oldPath, JSON.stringify(original));
    assert.equal((await readRunSummary(out)).runCount, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('result discovery rejects malformed JSON names, symlinks, oversized files and symlink directories', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-files-'));
  try {
    const { out } = await makeBundle(temp);
    const results = join(out, 'results');
    await symlink(temp, results);
    await assert.rejects(readRunSummary(out), /real directory/);
    await rm(results);
    await mkdir(results);
    await writeFile(join(results, 'README.txt'), 'incidental');
    assert.equal((await readRunSummary(out)).runCount, 0);
    const badName = join(results, 'bad.json');
    await writeFile(badName, '{}');
    await assert.rejects(readRunSummary(out), /Invalid linked result filename/);
    await rm(badName);
    const linked = join(results, `${randomUUID()}.json`);
    await symlink(join(results, 'README.txt'), linked);
    await assert.rejects(readRunSummary(out), /regular file/);
    await rm(linked);
    await writeFile(linked, 'x'.repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(readRunSummary(out), /exceeds 2 MiB/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('read and direct render redact untrusted text and keep backticks inside fences; stale source fails', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-safe-'));
  try {
    const { out, provenance } = await makeBundle(temp);
    const raw = report(provenance, ['blocked']);
    raw.cases[0]!.reason = '```\n## injected token=secret123';
    await linkFlowQaReport(out, raw);
    const summary = await readRunSummary(out);
    summary.groups[0]!.message = '```\n## injected token=secret456';
    summary.groups[0]!.cases[0]!.reason = '```\n## injected token=secret789';
    const markdown = renderRunSummary(summary);
    assert.match(markdown, /````text\n```\n## injected token=\[redacted\]\n````/);
    for (const secret of ['secret123', 'secret456', 'secret789']) assert.ok(!markdown.includes(secret));
    assert.throws(() => renderRunSummary({ ...summary, groups: [{ ...summary.groups[0]!, groupId: 'bad\n## heading' }] }), /compatible ID/);
    await writeFile(join(out, 'report.md'), 'changed');
    await assert.rejects(readRunSummary(out), /STALE_BUNDLE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
