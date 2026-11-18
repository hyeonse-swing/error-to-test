import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors, linkFlowQaReport, readEventTrace, renderEventTrace, writeBundle } from '../src/index.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const event = (eventId: string, project: string, message: string, sequence: number) => ({
  schemaVersion: 1, eventId, project, environment: 'stage', release: 'r1', sdkVersion: '0.2.14',
  occurredAt: '2026-11-18T00:00:00Z', viewId: `view-${project}`, sequence, elapsedMs: 1,
  type: 'manual', message, page: '/checkout', runtime: 'browser',
});
const input = JSON.stringify({ schemaVersion: 1, partial: true, events: [
  event('shared', 'alpha', 'Checkout failed', 1),
  event('other', 'alpha', 'Checkout failed', 2),
  event('shared', 'beta', 'Search failed', 1),
] });

test('one SDK ID traces every project, selected TC, latest target outcome, and partial-source absence', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-trace-'));
  try {
    const preliminary = analyzeErrors(input);
    const alpha = preliminary.groups.find(group => group.project === 'alpha')!;
    const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'Checkout fixture', scenarios: [{
      id: 'checkout', title: 'Checkout recovers', match: { groupId: alpha.id },
      requirement: 'Checkout succeeds after retry', expectedSource: 'Fixture requirement',
      preconditions: [], setupConfirmed: true, questions: [], steps: [
        { type: 'open', path: '/checkout' },
        { type: 'click', locator: { by: 'role', value: 'button', name: 'Retry' } },
        { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true },
      ],
    }] });
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analyzeErrors(input, { top: 1, profile }), { reviewed: true });
    const before = await readEventTrace(directory, 'shared');
    assert.equal(before.found, true);
    assert.equal(before.source.partial, true);
    assert.deepEqual(before.matches.map(match => match.project), ['alpha', 'beta']);
    assert.equal(before.matches[0]?.status, 'review-ready');
    assert.equal(before.matches[0]?.cases[0]?.state, 'draft');
    assert.equal(before.matches[0]?.cases[0]?.status, 'not-run');
    assert.equal(before.matches[1]?.status, 'unselected');
    assert.deepEqual(before.matches[1]?.cases, []);
    assert.ok(!JSON.stringify(before).includes('Checkout failed'));
    assert.ok(!JSON.stringify(before).includes('Search failed'));
    assert.throws(() => renderEventTrace({ ...before, matches: [{ ...before.matches[0]!, groupId: 'group-bad\n# injected' }] }), /Invalid trace.match.groupId/);
    assert.ok(!renderEventTrace({ ...before, eventId: 'token=private-secret' }).includes('private-secret'));

    const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
    const caseId = provenance.mappings[0].caseId;
    const report = (url: string, status: 'passed' | 'failed', date: string) => ({
      schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
      target: { name: 'Fixture', kind: 'web', url }, startedAt: date, finishedAt: date,
      status, cases: [{ id: caseId, status }],
    });
    const firstFile = await linkFlowQaReport(directory, report('https://one.example.test', 'passed', '2026-11-18T01:00:00Z'));
    const first = JSON.parse(await readFile(firstFile, 'utf8'));
    await linkFlowQaReport(directory, report('https://two.example.test', 'failed', '2026-11-18T02:00:00Z'));
    const global = await readEventTrace(directory, 'shared');
    assert.equal(global.matches[0]?.cases[0]?.status, 'failed');
    assert.match(global.warnings.join(' '), /target fingerprints/);
    const scoped = await readEventTrace(directory, 'shared', { targetFingerprint: first.targetFingerprint });
    assert.equal(scoped.matches[0]?.cases[0]?.status, 'passed');
    assert.equal(scoped.matches[1]?.cases.length, 0);
    assert.equal(scoped.runCount, 1);
    assert.equal(scoped.availableTargets.length, 2);
    assert.match(renderEventTrace(scoped), /No selected TC in this bundle/);

    const json = run(['trace', directory, '--event-id', 'shared', '--target-fingerprint', first.targetFingerprint, '--format', 'json']);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), scoped);
    const missing = run(['trace', directory, '--event-id', 'absent', '--format', 'json']);
    assert.equal(missing.status, 2, missing.stderr);
    const unknown = JSON.parse(missing.stdout);
    assert.equal(unknown.found, false);
    assert.deepEqual(unknown.matches, []);
    assert.match(unknown.warnings.join(' '), /saved analysis input/);
    assert.match(unknown.warnings.join(' '), /marked partial/);
    assert.ok(!JSON.stringify(unknown).includes('Checkout failed'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('trace rejects invalid options, redacted IDs, and a stale bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-trace-invalid-'));
  try {
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analyzeErrors(input, { top: 1 }));
    for (const args of [[], [directory], [directory, '--event-id', 'shared', '--format', 'auto'],
      [directory, '--event-id', 'shared', '--out', join(temp, 'trace.json')]]) {
      const result = run(['trace', ...args]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
    }
    await assert.rejects(readEventTrace(directory, 'token=private-secret'), /cannot be safely displayed/);
    await assert.rejects(readEventTrace(directory, 'shared', { targetFingerprint: 'f'.repeat(64) }), /No linked runs match/);
    await writeFile(join(directory, 'analysis.json'), '{}\n');
    await assert.rejects(readEventTrace(directory, 'shared'), /STALE_BUNDLE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('empty suites and already redacted saved IDs remain traceable without inventing outcomes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-trace-empty-'));
  try {
    const empty = join(temp, 'empty');
    await writeBundle(empty, analyzeErrors(input, { minCount: 3 }));
    const trace = await readEventTrace(empty, 'shared');
    assert.equal(trace.found, true);
    assert.equal(trace.runCount, 0);
    assert.equal(trace.source.suiteSha256, undefined);
    assert.ok(trace.matches.every(match => match.status === 'unselected' && match.cases.length === 0));

    const sanitized = join(temp, 'sanitized');
    const secrets = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
      { id: 'sk-abcdefghijklmnopqrst', project: 'alpha', message: 'Repeated error' },
      { id: 'sk-zyxwvutsrqponmlkjihg', project: 'beta', message: 'Repeated error' },
    ] });
    await writeBundle(sanitized, analyzeErrors(secrets));
    const redacted = await readEventTrace(sanitized, '[redacted-token]');
    assert.equal(redacted.found, true);
    assert.equal(redacted.matches.length, 2);
    assert.ok(redacted.matches.every(match => match.suppliedRecords === 1));
    assert.match(redacted.warnings.join(' '), /multiple original IDs may share/);
    assert.ok(!JSON.stringify(redacted).includes('abcdefghijklmnopqrst'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
