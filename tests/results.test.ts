import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { analyzeErrors, writeBundle, linkFlowQaReport, readRunSummary } from '../src/index.ts';
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
    for (const status of ['failed', 'flaky', 'blocked', 'skipped', 'error']) {
      const invalid = { ...raw, runId: randomUUID(), status: 'passed', cases: [{ id: provenance.mappings[0].caseId, status }] };
      await assert.rejects(linkFlowQaReport(out, invalid), /contradicts/);
      await assert.rejects(stat(join(out, 'results', `${invalid.runId}.json`)), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(join(out, 'results')), [`${raw.runId}.json`]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('linking refuses a result too large for later summary reads', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-large-result-'));
  try {
    const out = join(temp, 'bundle');
    const analysis = analyzeErrors('Error: observed');
    analysis.candidates = Array.from({ length: 100 }, (_, index) => ({ ...analysis.candidates[0]!, id: `TC_${index}` }));
    await writeBundle(out, analysis);
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const runId = randomUUID();
    const oversized = {
      schemaVersion: 'flow-qa/report-1', runId, suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'blocked',
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'blocked', reason: '가'.repeat(8192) })),
    };
    await assert.rejects(linkFlowQaReport(out, oversized), /exceeds 2 MiB/);
    await assert.rejects(stat(join(out, 'results', `${runId}.json`)), { code: 'ENOENT' });
    assert.equal((await readRunSummary(out)).runCount, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('concurrent links publish one complete result without replacing it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-concurrent-link-'));
  try {
    const out = join(temp, 'bundle');
    await writeBundle(out, analyzeErrors('Error: observed'));
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const runId = randomUUID();
    const base = {
      schemaVersion: 'flow-qa/report-1', runId, suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z',
      cases: [{ id: provenance.mappings[0].caseId, status: 'passed' }],
    };
    const outcomes = await Promise.allSettled([
      linkFlowQaReport(out, { ...base, status: 'passed' }),
      linkFlowQaReport(out, { ...base, status: 'failed', cases: [{ id: base.cases[0]!.id, status: 'failed' }] }),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    const result = await readRunSummary(out);
    assert.equal(result.runCount, 1);
    assert.equal(result.counts.passed + result.counts.failed, 1);
    assert.deepEqual(await readdir(join(out, 'results')), [`${runId}.json`]);
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
    const cases = [first, third].map(id => ({ id, status: 'passed', reason: 'At https://example.test/private?token=url-secret' }));
    const report = {
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'passed', cases,
      target: { name: 'Stage token=name-secret https://example.test/name-private?token=name-url-secret prod_https://example.test/private/customer-123?token=secret', url: 'https://example.test/private?token=url-secret' },
      selection: { caseIds: [first, third], totalCases: 3 },
    };
    const path = await linkFlowQaReport(out, report);
    const linked = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(linked.targetName, 'Stage token=[redacted] [redacted-url] prod_[redacted-url]');
    assert.equal(linked.targetFingerprint, createHash('sha256').update(JSON.stringify({
      kind: 'web', url: report.target.url,
    })).digest('hex'));
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

test('target identities match Flow QA canonical mobile fields and reject unsupported target shapes before writing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-target-results-'));
  try {
    const out = join(temp, 'bundle');
    await writeBundle(out, analyzeErrors('Error: observed'));
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    const base = {
      schemaVersion: 'flow-qa/report-1', suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'passed',
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'passed', reason: 'Ran on private-device-123 for com.secret.customer' })),
    };
    const mobile = { name: 'Stage private-device-123 com.secret.customer', kind: 'mobile', platform: 'ios', bundleId: 'com.secret.customer', device: 'private-device-123' };
    const file = await linkFlowQaReport(out, { ...base, runId: randomUUID(), target: mobile });
    const content = await readFile(file, 'utf8');
    const result = JSON.parse(content);
    assert.equal(result.targetFingerprint, createHash('sha256').update(JSON.stringify({
      kind: 'mobile', platform: mobile.platform, bundleId: mobile.bundleId, device: mobile.device,
    })).digest('hex'));
    assert.equal(result.targetName, 'Stage [redacted-target] [redacted-target]');
    assert.ok(!content.includes('com.secret.customer'));
    assert.ok(!content.includes('private-device-123'));
    const invalid = [
      null, { name: 'Stage', kind: 'desktop', url: 'https://example.test' },
      { name: 'Stage', kind: 'web' }, { name: 'Stage', url: 'javascript:alert(1)' },
      { name: 'Stage', url: 'https://example.test', device: 'unexpected' },
      { name: 'Stage', kind: 'mobile', platform: 'windows', bundleId: 'com.example', device: 'phone' },
      { name: 'Stage', kind: 'mobile', platform: 'ios', bundleId: 'com.example' },
      { kind: 'mobile', platform: 'ios', bundleId: 'com.example', device: 'phone' },
    ];
    for (const target of invalid) {
      await assert.rejects(linkFlowQaReport(out, { ...base, runId: randomUUID(), target }), /report\.target/);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('Flow QA early failure target placeholders link as unscoped only for their fallback statuses', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-target-fallback-'));
  try {
    const out = join(temp, 'bundle');
    await writeBundle(out, analyzeErrors('Error: observed'));
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    // These target shapes come from Flow QA engine's initial target and missing-device branch;
    // failureReport enumerates every case with the fallback run status.
    const web = { name: 'Stage https://private.example/path?token=secret', url: '' };
    const mobile = { name: 'Stage com.private.app', kind: 'mobile', platform: 'ios', bundleId: 'com.private.app', device: '' };
    const fallbackReport = (target: object, status: string) => ({
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteId: 'suite', suiteHash: provenance.suiteSha256,
      target, startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status,
      cases: provenance.mappings.map((item: { caseId: string }) => ({
        id: item.caseId, title: 'Observed error', status: status === 'blocked' ? 'blocked' : 'error',
        expected: [], attempts: [], reason: target === mobile ? 'Could not start com.private.app' : 'Early configuration failure',
      })),
      errors: status === 'blocked' ? [] : ['Could not start'],
    });
    for (const [target, status, expectedName] of [
      [web, 'error', 'Stage [redacted-url]'],
      [web, 'interrupted', 'Stage [redacted-url]'],
      [mobile, 'blocked', 'Stage [redacted-target]'],
      [mobile, 'interrupted', 'Stage [redacted-target]'],
    ] as const) {
      const file = await linkFlowQaReport(out, fallbackReport(target, status));
      const content = await readFile(file, 'utf8');
      const linked = JSON.parse(content);
      assert.equal(linked.targetName, expectedName);
      assert.ok(!Object.hasOwn(linked, 'targetFingerprint'));
      assert.ok(!content.includes('private.example'));
      assert.ok(!content.includes('com.private.app'));
    }
    const summary = await readRunSummary(out);
    assert.equal(summary.runCount, 4);
    assert.equal(summary.unscopedRunCount, 4);
    assert.deepEqual(summary.targets, []);
    assert.match(summary.warnings.join('\n'), /4 linked run\(s\) have no target fingerprint/);
    for (const [target, status] of [
      [mobile, 'error'], [mobile, 'passed'], [web, 'blocked'], [web, 'passed'],
      [{ ...web, kind: 'web' }, 'error'], [{ ...web, url: ' ' }, 'error'],
      [{ ...mobile, bundleId: '' }, 'blocked'], [{ ...mobile, device: undefined }, 'blocked'],
    ] as const) {
      await assert.rejects(linkFlowQaReport(out, fallbackReport(target, status)), /report\.target/);
    }
    assert.equal((await readRunSummary(out)).runCount, 4);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
