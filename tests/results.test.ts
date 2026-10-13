import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeErrors, writeBundle, linkFlowQaReport } from '../src/index.ts';

test('run linkage binds exact suite/cases, redacts reasons, preserves old results and never closes issues', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-results-'));
  try {
    const out = join(temp, 'bundle');
    await writeBundle(out, analyzeErrors('Error: missing expected behavior'));
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const raw = {
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'blocked',
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'blocked', reason: 'Unknown behavior; token=private-secret' })),
    };
    const file = await linkFlowQaReport(out, raw);
    const result = await readFile(file, 'utf8');
    assert.ok(!result.includes('private-secret'));
    assert.match(result, /No source issue was automatically closed/);
    await assert.rejects(linkFlowQaReport(out, raw), /EEXIST/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), suiteHash: 'f'.repeat(64) }), /different suite/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), cases: [] }), /every exported case/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), cases: [{ id: 'other', status: 'passed' }] }), /unknown/);
    await assert.rejects(linkFlowQaReport(out, { ...raw, runId: randomUUID(), status: 'passed', cases: [{ id: provenance.mappings[0].caseId, status: 'failed' }] }), /contradicts/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
