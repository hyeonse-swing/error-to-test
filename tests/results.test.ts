import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeErrors, writeBundle, linkFlowQaReport } from '../src/index.ts';
import { jsonText } from '../src/artifacts.ts';

test('run linkage binds exact suite/cases, redacts reasons, preserves old results and never closes issues', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-results-'));
  try {
    const out = join(temp, 'bundle');
    await writeBundle(out, analyzeErrors('Error: missing expected behavior'));
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const bundleFiles = ['analysis.json', 'report.md', 'flows/error-to-test.md', 'provenance.json', 'cases/error-to-test.json'];
    const bundleBytes = await Promise.all(bundleFiles.map(name => readFile(join(out, name))));
    const raw = {
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'blocked',
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'blocked', reason: 'Unknown behavior; token=private-secret' })),
    };
    const file = await linkFlowQaReport(out, raw);
    const result = await readFile(file, 'utf8');
    assert.equal(result, jsonText({
      schemaVersion: 'error-to-test/results-1', runId: raw.runId,
      inputSha256: provenance.inputSha256, suiteSha256: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00.000Z', finishedAt: '2026-10-13T01:01:00.000Z',
      status: 'blocked',
      cases: provenance.mappings.map((mapping: object) => ({ ...mapping, status: 'blocked', reason: 'Unknown behavior; token=[redacted]' })),
      note: 'These results cover the specified assertions. No source issue was automatically closed.',
    }));
    for (const [index, name] of bundleFiles.entries()) assert.deepEqual(await readFile(join(out, name)), bundleBytes[index]);
    assert.ok(!result.includes('private-secret'));
    assert.match(result, /No source issue was automatically closed/);
    await assert.rejects(linkFlowQaReport(out, raw), /EEXIST/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), suiteHash: 'f'.repeat(64) }), /different suite/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), cases: [] }), /every exported case/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), cases: [{ id: 'other', status: 'passed' }] }), /unknown/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), status: 'passed', cases: [{ id: provenance.mappings[0].caseId, status: 'failed' }] }), /contradicts/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Flow QA selected reports require an exact proper subset declaration', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-selected-results-'));
  try {
    const out = join(temp, 'bundle');
    const analysis = analyzeErrors('Error: observed');
    analysis.candidates = Array.from({ length: 3 }, (_, index) => ({ ...analysis.candidates[0]!, id: `TC_${index}` }));
    await writeBundle(out, analysis);
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const [first, second, third] = provenance.mappings.map((item: { caseId: string }) => item.caseId);
    const cases = [first, third].map(id => ({ id, status: 'passed' }));
    const report = {
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'passed', cases,
      target: { name: 'Stage token=name-secret https://example.test/name-private?token=name-url-secret prod_https://example.test/private/customer-123?token=secret', url: 'https://example.test/private?token=url-secret' },
      selection: { caseIds: [first, third], totalCases: 3 },
    };
    const path = await linkFlowQaReport(out, report);
    const linked = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(linked.targetName, 'Stage token=[redacted] [redacted-url] prod_[redacted-url]');
    assert.ok(!JSON.stringify(linked).includes('name-secret'));
    assert.ok(!JSON.stringify(linked).includes('name-private'));
    assert.ok(!JSON.stringify(linked).includes('url-secret'));
    assert.ok(!Object.hasOwn(linked, 'target'));
    assert.deepEqual(linked.selection, { mode: 'selected', totalCases: 3, selectedCaseIds: [first, third] });
    assert.deepEqual(linked.cases.map((item: { caseId: string }) => item.caseId), [first, third]);

    const invalid: [string, unknown, RegExp][] = [
      ['undeclared subset', undefined, /every exported case/],
      ['missing selection', null, /invalid selection declaration/],
      ['unknown field', { ...report.selection, mode: 'selected' }, /invalid selection declaration/],
      ['too small total', { caseIds: [first, third], totalCases: 2 }, /totalCases/],
      ['too large total', { caseIds: [first, third], totalCases: 4 }, /totalCases/],
      ['fractional total', { caseIds: [first, third], totalCases: 3.5 }, /totalCases/],
      ['duplicate IDs', { caseIds: [first, first], totalCases: 3 }, /selected case IDs/],
      ['unknown ID', { caseIds: [first, 'TC_unknown'], totalCases: 3 }, /selected case IDs/],
      ['wrong subset', { caseIds: [first, second], totalCases: 3 }, /selected case IDs/],
    ];
    for (const [label, selection, error] of invalid) {
      const altered = { ...report, runId: randomUUID(), ...(label === 'undeclared subset' ? {} : { selection }) };
      if (label === 'undeclared subset') delete (altered as { selection?: unknown }).selection;
      await assert.rejects(linkFlowQaReport(out, altered), error, label);
    }
    await assert.rejects(linkFlowQaReport(out, { ...report, runId: randomUUID(), selection: { caseIds: [], totalCases: 3 } }), /selected case IDs/);
    await assert.rejects(linkFlowQaReport(out, { ...report, runId: randomUUID(),
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'passed' })) }), /totalCases/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
