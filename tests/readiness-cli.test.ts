import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const input = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'one', message: 'Error: missing item', page: '/items', runtime: 'browser' },
  { id: 'two', message: 'Error: missing selection', page: '/other', runtime: 'browser' },
] });
const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'Readiness demo', scenarios: [{
  id: 'item', title: 'Missing item shows fallback', match: { pagePath: '/items' },
  requirement: 'A missing item displays the fallback', expectedSource: 'Demo requirement', setupConfirmed: true,
  preconditions: ['Demo data is prepared'], questions: [], steps: [
    { type: 'open', path: '/items' }, { type: 'act', instruction: 'Open the missing item' },
    { type: 'assertVisible', locator: { by: 'text', value: 'Item unavailable' }, visible: true },
  ],
}] });

test('readiness reports blocked, reviewed ready, mixed, and empty selected snapshots with stable exit codes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-cli-'));
  try {
    for (const [name, options, reviewed, expected, selected, ready] of [
      ['missing', {}, true, 'blocked', 2, 0],
      ['review', { profile, top: 1 }, false, 'blocked', 1, 0],
      ['ready', { profile, top: 1 }, true, 'ready', 1, 1],
      ['mixed', { profile }, true, 'blocked', 2, 1],
      ['empty', { minCount: 2 }, true, 'empty', 0, 0],
    ] as const) {
      // Both groups tie; select /items explicitly rather than depend on ranked hash ordering.
      const content = name === 'ready' || name === 'review'
        ? JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [JSON.parse(input).errors[0]] }) : input;
      const bundle = join(temp, name);
      await writeBundle(bundle, analyzeErrors(content, options), { reviewed });
      const before = await readFile(join(bundle, 'provenance.json'), 'utf8');
      const result = run(['readiness', bundle, '--format', 'json']);
      assert.equal(result.status, expected === 'ready' ? 0 : 2, result.stderr);
      assert.equal(result.stderr, '');
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.schemaVersion, 'error-to-test/readiness-1');
      assert.equal(summary.status, expected);
      assert.equal(summary.reviewed, reviewed);
      assert.equal(summary.counts.selected, selected);
      assert.equal(summary.counts.ready, ready);
      assert.equal(summary.counts.blocked, selected - ready);
      assert.equal(summary.cases.length, selected);
      assert.equal(await readFile(join(bundle, 'provenance.json'), 'utf8'), before);
      assert.equal(run(['verify', bundle]).status, 0);
      if (name === 'missing') {
        const text = run(['readiness', bundle]);
        assert.equal(text.status, 2, text.stderr);
        assert.match(text.stdout, /readiness/i);
        assert.match(text.stdout, /blocked/);
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('readiness rejects irrelevant options, missing bundles, and stale bundles without a report', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-invalid-'));
  try {
    const bundle = join(temp, 'bundle');
    await writeBundle(bundle, analyzeErrors(input));
    for (const args of [[], [bundle, 'extra'], [bundle, '--format', 'auto'], [bundle, '--format', ''],
      [bundle, '--out', join(temp, 'report.json')], [bundle, '--reviewed'], [bundle, '--max-new', '0'],
      [bundle, '--input', 'missing.json'], [join(temp, 'missing')], [' ']]) {
      const result = run(['readiness', ...args]);
      assert.equal(result.status, 1, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.equal(result.stdout, '');
    }
    await writeFile(join(bundle, 'report.md'), 'tampered');
    const stale = run(['readiness', bundle, '--format', 'json']);
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, '');
    assert.match(stale.stderr, /STALE_BUNDLE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('readiness accepts a valid exported group with more than one thousand accumulated questions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-questions-'));
  try {
    const content = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: Array.from({ length: 1001 }, (_, index) => ({
      id: `event-${index}`, message: 'Error: missing item', page: '/items', runtime: 'browser', questions: [`q${index}`],
    })) });
    const bundle = join(temp, 'bundle');
    await writeBundle(bundle, analyzeErrors(content), { reviewed: true });
    const result = run(['readiness', bundle, '--format', 'json']);
    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.counts.selected, 1);
    assert.ok(summary.cases[0].blockers.length > 1000);
    assert.ok(summary.cases[0].blockers.includes('q1000'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('readiness treats a closed stdout as an output error instead of a readiness result', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-pipe-'));
  try {
    const bundle = join(temp, 'bundle');
    await writeBundle(bundle, analyzeErrors(input));
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [cli, 'readiness', bundle, '--format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.destroy();
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', rejectRun);
      child.on('close', code => resolveRun({ code, stderr }));
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Error to Test:/);
    assert.doesNotMatch(result.stderr, /Unhandled|unhandled|Readiness (ready|blocked)/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
