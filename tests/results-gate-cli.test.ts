import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { linkFlowQaReport } from '../src/results.ts';
import { readRunSummary, renderRunSummary, type LinkedCaseStatus, type LinkedRunStatus } from '../src/run-summary.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const allowed = ['failed', 'flaky', 'blocked', 'skipped', 'error', 'not-run'] as const;
function run(args: string[]) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000 }); }
async function bundleAt(temp: string, count: number): Promise<{ bundle: string; provenance: { suiteSha256: string; mappings: { caseId: string }[] } }> {
  const bundle = join(temp, `bundle-${randomUUID()}`);
  const analysis = analyzeErrors('Error: observed');
  if (count === 0) analysis.candidates = [];
  else analysis.candidates = Array.from({ length: count }, (_, index) => ({ ...analysis.candidates[0]!, id: `TC_${index}` }));
  await writeBundle(bundle, analysis);
  const provenance = JSON.parse(await readFile(join(bundle, 'provenance.json'), 'utf8'));
  return { bundle, provenance };
}
async function link(bundle: string, provenance: { suiteSha256: string; mappings: { caseId: string }[] }, statuses: LinkedCaseStatus[], status: LinkedRunStatus, day = 13): Promise<string> {
  return linkFlowQaReport(bundle, {
    schemaVersion: 'flow-qa/report-1', runId: randomUUID(), suiteHash: provenance.suiteSha256,
    startedAt: `2026-10-${day}T00:00:00Z`, finishedAt: `2026-10-${day}T00:01:00Z`, status,
    cases: provenance.mappings.map((mapping, index) => ({ id: mapping.caseId, status: statuses[index] })),
  });
}

test('results gate uses latest case counts, canonical deduplicated statuses, and leaves the full summary intact', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-gate-'));
  try {
    const { bundle, provenance } = await bundleAt(temp, 7);
    await link(bundle, provenance, ['passed', 'failed', 'flaky', 'blocked', 'skipped', 'error', 'passed'], 'failed');
    const original = run(['results', bundle, '--format', 'json']);
    assert.equal(original.status, 0, original.stderr);
    assert.equal(original.stderr, '');
    for (const status of allowed.slice(0, 5)) {
      const result = run(['results', bundle, '--format', 'json', '--fail-on', status]);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, original.stdout);
      assert.equal(result.stderr, `Results gate failed: 1 cases match --fail-on (${status}=1).\n`);
    }
    const none = run(['results', bundle, '--format', 'json', '--fail-on', 'not-run']);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(none.stdout, original.stdout);
    assert.equal(none.stderr, 'Results gate passed: 0 cases match --fail-on (not-run=0).\n');
    const repeated = run(['results', bundle, '--fail-on', 'error', '--fail-on', 'failed', '--fail-on', 'error', '--fail-on', 'not-run']);
    assert.equal(repeated.status, 2, repeated.stderr);
    assert.equal(repeated.stdout, renderRunSummary(await readRunSummary(bundle)));
    assert.equal(repeated.stderr, 'Results gate failed: 2 cases match --fail-on (failed=1, error=1, not-run=0).\n');
    await link(bundle, provenance, Array(7).fill('passed'), 'passed', 14);
    const latest = run(['results', bundle, '--fail-on', 'failed']);
    assert.equal(latest.status, 0, latest.stderr);
    assert.equal(latest.stderr, 'Results gate passed: 0 cases match --fail-on (failed=0).\n');
    assert.match(latest.stdout, /Run ID:/);
    assert.equal(JSON.parse(run(['results', bundle, '--format', 'json']).stdout).runCount, 2);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('not-run and empty selection fail, while interrupted run status does not count as a case error', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-gate-empty-'));
  try {
    const { bundle, provenance } = await bundleAt(temp, 1);
    const notRun = run(['results', bundle, '--fail-on', 'not-run']);
    assert.equal(notRun.status, 2, notRun.stderr);
    assert.equal(notRun.stderr, 'Results gate failed: 1 cases match --fail-on (not-run=1).\n');
    await link(bundle, provenance, ['passed'], 'interrupted');
    const interrupted = run(['results', bundle, '--format', 'json', '--fail-on', 'error']);
    assert.equal(interrupted.status, 0, interrupted.stderr);
    assert.equal(JSON.parse(interrupted.stdout).latestRun.status, 'interrupted');
    assert.equal(interrupted.stderr, 'Results gate passed: 0 cases match --fail-on (error=0).\n');
    const empty = await bundleAt(temp, 0);
    const noCases = run(['results', empty.bundle, '--fail-on', 'failed']);
    assert.equal(noCases.status, 2, noCases.stderr);
    assert.equal(noCases.stderr, 'Results gate failed: no selected cases.\n');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('saved full reports retain file protections; operational and invalid requests have no gate outcome', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-gate-files-'));
  try {
    const { bundle, provenance } = await bundleAt(temp, 1);
    const linked = await link(bundle, provenance, ['failed'], 'failed');
    const summary = await readRunSummary(bundle);
    for (const format of ['json', 'text'] as const) {
      const out = join(temp, `${format}.summary`);
      const result = run(['results', bundle, '--format', format, '--out', out, '--fail-on', 'failed']);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, `Results summary written: ${out}\n`);
      assert.equal(result.stderr, 'Results gate failed: 1 cases match --fail-on (failed=1).\n');
      assert.equal(await readFile(out, 'utf8'), format === 'json' ? `${JSON.stringify(summary, null, 2)}\n` : renderRunSummary(summary));
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      const existing = run(['results', bundle, '--out', out, '--fail-on', 'failed']);
      assert.equal(existing.status, 1);
      assert.equal(existing.stdout, '');
      assert.doesNotMatch(existing.stderr, /Results gate (failed|passed):/);
    }
    const alias = join(temp, 'results-alias');
    await symlink(join(bundle, 'results'), alias, 'dir');
    for (const out of [join(bundle, 'results', 'summary.json'), join(bundle, 'RESULTS', 'summary.json'), join(alias, 'summary.json')]) {
      const rejected = run(['results', bundle, '--out', out, '--fail-on', 'failed']);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, '');
      assert.doesNotMatch(rejected.stderr, /Results gate (failed|passed):/);
    }
    const oldResult = linked;
    const original = await readFile(oldResult, 'utf8');
    await writeFile(oldResult, '{}');
    const invalidLinked = run(['results', bundle, '--fail-on', 'failed']);
    assert.equal(invalidLinked.status, 1);
    assert.equal(invalidLinked.stdout, '');
    assert.doesNotMatch(invalidLinked.stderr, /Results gate (failed|passed):/);
    await writeFile(oldResult, original);
    await writeFile(join(bundle, 'report.md'), 'stale');
    const stale = run(['results', bundle, '--fail-on', 'failed']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE_BUNDLE/);
    assert.doesNotMatch(stale.stderr, /Results gate (failed|passed):/);
    const invalidBeforeRead = run(['results', bundle, '--fail-on', 'secret-token=private']);
    assert.equal(invalidBeforeRead.status, 1);
    assert.doesNotMatch(invalidBeforeRead.stderr, /STALE_BUNDLE|secret-token=private|Results gate (failed|passed):/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('invalid statuses and other commands reject --fail-on before work and do not echo raw values', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-gate-invalid-'));
  try {
    const { bundle } = await bundleAt(temp, 1);
    for (const value of ['passed', 'interrupted', 'FAILED', ' failed', 'failed ', 'csv', 'secret-token=private']) {
      const result = run(['results', bundle, '--fail-on', value, '--out', join(temp, 'must-not-exist')]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /secret-token=private|Results gate (failed|passed):/);
    }
    const many = run(['results', bundle, ...Array.from({ length: 120 }, () => ['--fail-on', 'failed']).flat()]);
    assert.equal(many.status, 0, many.stderr);
    assert.equal(many.stderr, 'Results gate passed: 0 cases match --fail-on (failed=0).\n');
    for (const args of [['analyze', '--error', 'observed'], ['verify', bundle], ['readiness', bundle], ['compare', bundle, bundle], ['link-run', bundle], ['refine', bundle], ['init-profile', bundle]]) {
      const result = run([...args, '--fail-on', 'failed']);
      assert.equal(result.status, 1, args.join(' '));
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /Results gate (failed|passed):/);
    }
    assert.match(run(['--help']).stdout, /--fail-on STATUS/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('closed stdout reports an operational error without a gate outcome, including after saving', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-gate-epipe-'));
  try {
    const { bundle } = await bundleAt(temp, 1);
    async function closed(args: string[]): Promise<{ status: number | null; stderr: string }> {
      return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdout.destroy();
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', rejectRun);
        child.on('close', status => resolveRun({ status, stderr }));
      });
    }
    const stdout = await closed(['results', bundle, '--fail-on', 'not-run']);
    assert.equal(stdout.status, 1, stdout.stderr);
    assert.doesNotMatch(stdout.stderr, /Results gate (failed|passed):|at .+\(.*:\d+:\d+\)/);
    const out = join(temp, 'saved.json');
    const saved = await closed(['results', bundle, '--format', 'json', '--out', out, '--fail-on', 'not-run']);
    assert.equal(saved.status, 1, saved.stderr);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).counts['not-run'], 1);
    assert.doesNotMatch(saved.stderr, /Results gate (failed|passed):|at .+\(.*:\d+:\d+\)/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
