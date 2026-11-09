import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { jsonText, writeBundle } from '../src/artifacts.ts';
import { readReadiness, renderReadiness } from '../src/readiness.ts';
import { hash } from '../src/validation.ts';

const complete = { id: 'complete', message: 'Checkout failed', page: '/checkout', runtime: 'browser', reproduction: ['Submit form'],
  expected: 'Success appears', expectedSource: 'Reporter',
  steps: [{ type: 'open', path: '/checkout' }, { type: 'act', instruction: 'Submit form' },
    { type: 'assertVisible', locator: { by: 'text', value: 'Success' }, visible: true }] };
const missing = { id: 'missing', message: 'Search failed' };
const input = (errors: object[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });

async function bundle(temp: string, errors: object[], reviewed = false, options: { top?: number; minCount?: number } = {}) {
  const directory = join(temp, `bundle-${Math.random().toString(36).slice(2)}`);
  await writeBundle(directory, analyzeErrors(input(errors), options), { reviewed });
  return directory;
}

async function rewrite(directory: string, file: string, mutate: (value: any) => void) {
  const target = join(directory, file);
  const value = JSON.parse(await readFile(target, 'utf8'));
  mutate(value);
  await writeFile(target, jsonText(value));
  return hash(jsonText(value));
}

test('actual generated bundles distinguish review, missing context, ready, mixed, and empty selection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-'));
  try {
    const pending = await readReadiness(await bundle(temp, [complete]));
    assert.equal(pending.status, 'blocked');
    assert.equal(pending.counts.draft, 1);
    assert.equal(pending.counts.blocked, 1);
    assert.match(pending.cases[0]!.blockers.join(' '), /Review this draft case/);

    const ready = await readReadiness(await bundle(temp, [complete], true));
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.counts, { groups: 1, selected: 1, draft: 1, needsContext: 0, ready: 1, blocked: 0 });
    assert.deepEqual(ready.cases[0]!.blockers, []);
    assert.match(ready.warnings.join(' '), /No browser execution/);
    assert.match(renderReadiness(ready), /Status: ready/);

    const blocked = await readReadiness(await bundle(temp, [missing], true));
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.cases[0]!.state, 'needs-context');
    assert.ok(blocked.cases[0]!.blockers.length > 0);

    const mixed = await readReadiness(await bundle(temp, [complete, missing], true));
    assert.equal(mixed.status, 'blocked');
    assert.deepEqual([mixed.counts.selected, mixed.counts.ready, mixed.counts.blocked], [2, 1, 1]);

    const top = await readReadiness(await bundle(temp, [complete, missing], true, { top: 1 }));
    assert.equal(top.counts.groups, 2);
    assert.equal(top.counts.selected, 1);
    const empty = await readReadiness(await bundle(temp, [complete, missing], true, { minCount: 2 }));
    assert.equal(empty.status, 'empty');
    assert.equal(empty.suiteSha256, undefined);
    assert.equal(empty.counts.groups, 2);
    assert.equal(empty.counts.selected, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('stale suite and coherent malformed suite cases and candidate states are rejected', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-invalid-'));
  try {
    const directory = await bundle(temp, [complete], true);
    const suiteFile = 'cases/error-to-test.json';
    const originalSuite = await readFile(join(directory, suiteFile), 'utf8');
    const originalProvenance = await readFile(join(directory, 'provenance.json'), 'utf8');
    await rewrite(directory, suiteFile, value => { value.cases[0].questions = ['New unresolved question']; });
    await assert.rejects(readReadiness(directory), /STALE_BUNDLE/);
    await writeFile(join(directory, suiteFile), originalSuite);

    for (const mutate of [
      (value: any) => { value.cases[0].id = 'TC_unknown'; },
      (value: any) => { value.cases[0].questions = 'not an array'; },
      (value: any) => { value.cases[0].questions = [42]; },
      (value: any) => { value.cases.push(value.cases[0]); },
    ]) {
      const digest = await rewrite(directory, suiteFile, mutate);
      await rewrite(directory, 'provenance.json', value => { value.suiteSha256 = digest; });
      await assert.rejects(readReadiness(directory));
      await writeFile(join(directory, suiteFile), originalSuite);
      await writeFile(join(directory, 'provenance.json'), originalProvenance);
    }

    const digest = await rewrite(directory, 'analysis.json', value => { value.candidates[0].state = 'approved'; });
    await rewrite(directory, 'provenance.json', value => { value.analysisSha256 = digest; });
    await assert.rejects(readReadiness(directory), /invalid state/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('verified suite questions remain blockers even when analysis has no questions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-suite-'));
  try {
    const directory = await bundle(temp, [complete], true);
    const digest = await rewrite(directory, 'cases/error-to-test.json', value => {
      value.cases[0].questions = ['Execution steps contain sensitive data; provide reviewed, safe steps before running.'];
    });
    await rewrite(directory, 'provenance.json', value => { value.suiteSha256 = digest; });
    const summary = await readReadiness(directory);
    assert.equal(summary.status, 'blocked');
    assert.equal(summary.cases[0]!.state, 'draft');
    assert.match(summary.cases[0]!.blockers.join(' '), /sensitive data/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('rendering fences and redacts untrusted summary strings', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-readiness-safe-'));
  try {
    const summary = await readReadiness(await bundle(temp, [complete], true));
    summary.cases[0]!.title = '```\n## injected token=secret123';
    summary.cases[0]!.blockers.push('```\n## injected password=secret456');
    summary.warnings.push('```\n## injected api_key=secret789');
    const markdown = renderReadiness(summary);
    assert.match(markdown, /````text\n```\n## injected token=\[redacted\]\n````/);
    for (const secret of ['secret123', 'secret456', 'secret789']) assert.ok(!markdown.includes(secret));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
