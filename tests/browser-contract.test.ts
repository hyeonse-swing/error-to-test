import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from '../src/input.ts';
import { analyzeErrors } from '../src/analysis.ts';
import { renderReport, writeBundle } from '../src/artifacts.ts';
import { createCandidates, parseProfile } from '../src/candidates.ts';
import { compareAnalyses, renderComparison } from '../src/comparison.ts';
import { readRunSummary, renderRunSummary } from '../src/run-summary.ts';
import { createProfileTemplate } from '../src/profile-template.ts';
import { refineBundle } from '../src/refinement.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';

const event = {
  schemaVersion: 1, eventId: 'resource-1', project: 'demo', environment: 'test', release: 'r1', sdkVersion: '0.2.9',
  occurredAt: '2026-11-16T00:00:00Z', viewId: 'view-1', sequence: 1, elapsedMs: 1,
  type: 'resource', name: 'ResourceLoadError', message: 'Failed to load img resource',
  page: '/items', runtime: 'browser', context: { resourceTag: 'img', resourceUrl: 'https://example.com/img.png' },
};

test('an SDK error with no message survives reporting, comparison and saved-bundle operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-empty-message-'));
  try {
    const first = { ...event, type: 'javascript', name: 'Error', message: '', stack: 'Error\n    at submit (/cart.js:3:5)' };
    const second = { ...first, eventId: 'literal-label', message: '(no error message)' };
    const analysis = analyzeErrors(JSON.stringify([first, second]));
    assert.equal(analysis.groups.length, 2);
    const blank = analysis.groups.find(group => group.message === '')!;
    assert.deepEqual(blank.eventIds, [first.eventId]);
    assert.equal(blank.evidence[0]?.message, '');
    assert.equal(blank.evidence[0]?.name, 'Error');
    assert.match(renderReport(analysis), /Observed javascript error: \(no error message\)/);
    const comparison = compareAnalyses(analyzeErrors(JSON.stringify([second])), analysis);
    assert.equal(comparison.issues.find(issue => issue.status === 'only-current')?.message, '');
    assert.match(renderComparison(comparison), /Message: \(no error message\)/);

    const bundle = join(root, 'bundle');
    await writeBundle(bundle, analysis);
    const summary = await readRunSummary(bundle);
    assert.equal(summary.groups.find(group => group.groupId === blank.id)?.message, '');
    assert.match(renderRunSummary(summary), /\(no error message\)/);
    const profile = createProfileTemplate(analysis);
    for (const scenario of profile.scenarios) {
      scenario.requirement = 'Show a retry button';
      scenario.expectedSource = 'Checkout specification';
    }
    const refined = await refineBundle(bundle, JSON.stringify(profile));
    assert.equal(refined.groups.find(group => group.id === blank.id)?.evidence[0]?.message, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('BEL v1 resource events work across JSON, JSONL, manual input, profiles, and comparisons', () => {
  const json = JSON.stringify({ schemaVersion: 1, events: [event] });
  const jsonl = JSON.stringify({ ...event, eventId: 'resource-2' });
  const parsed = parseInput(json);
  assert.equal(parsed.observations[0]?.type, 'resource');
  assert.equal(parseInput(jsonl, { format: 'jsonl' }).observations[0]?.type, 'resource');
  assert.equal(parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: 'image failed', type: 'resource' }] })).observations[0]?.type, 'resource');
  const analysis = analyzeErrors(json);
  const rule = {
    id: 'resource-case', title: 'Image loading', match: { type: 'resource' },
    requirement: 'Image loads', expectedSource: 'Reviewed requirement', preconditions: [],
    setupConfirmed: true, questions: [],
    steps: [{ type: 'open', path: '/items' }, { type: 'click', locator: { by: 'role', value: 'button', name: 'Load' } },
      { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true }],
  };
  // Keep review gating: a matching type alone cannot authorize executable steps.
  const profile = parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'Review', scenarios: [{ ...rule, setupConfirmed: false, steps: [] }] });
  assert.equal(createCandidates(analysis.groups, profile)[0]?.state, 'needs-context');
  const reviewed = parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'Review', scenarios: [rule] });
  assert.equal(createCandidates(analysis.groups, reviewed)[0]?.state, 'draft');
  const comparison = compareAnalyses(analysis, analyzeErrors(jsonl, { format: 'jsonl' }));
  assert.equal(comparison.counts.both, 1);
  assert.equal(comparison.issues[0]?.type, 'resource');
  assert.match(renderComparison(comparison), /Type: resource/);
});

test('resource URLs separate real SDK failures in analysis and the CLI comparison gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-resource-compare-'));
  const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
  const resource = (id: string, release: string, url: string) => ({
    ...event, eventId: id, release,
    context: { resourceTag: 'img', resourceUrl: url, unrelated: 'ignored' },
  });
  const input = (item: ReturnType<typeof resource>) => JSON.stringify({ schemaVersion: 1, events: [item] });
  try {
    const first = resource('hero', 'r1', 'https://example.com/hero.png?cache=one');
    const second = resource('receipt', 'r2', 'https://example.com/receipt.png?cache=two');
    const samePath = resource('hero-again', 'r1', 'https://example.com/hero.png?cache=changed');
    const combined = analyzeErrors(JSON.stringify({ schemaVersion: 1, events: [first, second, samePath] }));
    assert.equal(combined.groups.length, 2);
    assert.deepEqual(combined.groups.map(group => group.count).sort(), [1, 2]);
    assert.deepEqual(new Set(combined.groups.map(group => group.signature.split(' | ').at(-1))), new Set(['/hero.png', '/receipt.png']));
    assert.doesNotMatch(JSON.stringify(combined), /cache=|unrelated|ignored/);
    const malformed = parseInput(input(resource('broken', 'r1', 'https://')));
    assert.equal(malformed.observations[0]?.resourcePath, undefined);
    assert.doesNotMatch(JSON.stringify(malformed.observations), /resourceUrl|unrelated|ignored/);

    const baselineInput = join(root, 'baseline.json'), currentInput = join(root, 'current.json');
    const baseline = join(root, 'baseline'), current = join(root, 'current');
    await writeFile(baselineInput, input(first));
    await writeFile(currentInput, input(second));
    assert.equal(run(['analyze', '--input', baselineInput, '--out', baseline]).status, 0);
    assert.equal(run(['analyze', '--input', currentInput, '--out', current]).status, 0);
    const comparison = run(['compare', baseline, current, '--format', 'json', '--max-new', '0']);
    assert.equal(comparison.status, 2, comparison.stderr);
    assert.deepEqual(JSON.parse(comparison.stdout).counts, { 'only-current': 1, both: 0, 'only-baseline': 1 });
    assert.match(await readFile(join(current, 'report.md'), 'utf8'), /receipt\.png/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cache-busting browser stack frames keep source positions without query data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-stack-compare-'));
  const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
  const report = (id: string, release: string, line: number) => JSON.stringify({
    schemaVersion: 'error-to-test/manual-1', errors: [{
      id, project: 'shop', release, page: '/checkout', runtime: 'browser',
      message: 'Checkout failed', stack: `Error: Checkout failed\n    at submit (https://example.com/chunks/(shop)/cart.js?build=42:${line}:17)`,
    }],
  });
  try {
    const first = report('before', 'r1', 2), second = report('after', 'r2', 3);
    const analysis = analyzeErrors(first);
    assert.match(analysis.groups[0]!.signature, /chunks\/\(shop\)\/cart\.js:2:17/);
    assert.doesNotMatch(JSON.stringify(analysis), /build=42/);
    assert.match(analysis.candidates[0]!.facts[0]!, /submitted report/);
    assert.doesNotMatch(analysis.candidates[0]!.facts[0]!, /captured event|view/);
    assert.match(exportFlowQa(analysis).flow, /1 submitted report\(s\)/);

    const baselineInput = join(root, 'baseline.json'), currentInput = join(root, 'current.json');
    const baseline = join(root, 'baseline'), current = join(root, 'current');
    await writeFile(baselineInput, first);
    await writeFile(currentInput, second);
    assert.equal(run(['analyze', '--input', baselineInput, '--out', baseline]).status, 0);
    assert.equal(run(['analyze', '--input', currentInput, '--out', current]).status, 0);
    const comparison = run(['compare', baseline, current, '--format', 'json', '--max-new', '0']);
    assert.equal(comparison.status, 2, comparison.stderr);
    assert.deepEqual(JSON.parse(comparison.stdout).counts, { 'only-current': 1, both: 0, 'only-baseline': 1 });
    assert.match(await readFile(join(current, 'report.md'), 'utf8'), /chunks\/\(shop\)\/cart\.js:3:17/);
    assert.doesNotMatch(await readFile(join(current, 'analysis.json'), 'utf8'), /build=42/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('BEL network statuses include 0 and 599, but invalid codes and unknown types still reject', () => {
  for (const status of [0, 1, 99, 100, 599]) {
    const parsed = parseInput(JSON.stringify([{ ...event, network: { method: 'GET', url: '/image', durationMs: 1, status } }]));
    assert.equal(parsed.observations[0]?.network?.status, status);
  }
  const zeroStatus = analyzeErrors(JSON.stringify([{ ...event, type: 'network', network: { method: 'GET', url: '/image', durationMs: 1, status: 0 } }]));
  assert.ok(zeroStatus.candidates[0]?.facts.some(fact => fact.includes('HTTP status unavailable; recorded value: 0')));
  assert.ok(zeroStatus.candidates[0]?.facts.every(fact => !fact.includes('network response')));
  for (const status of [-1, 600, 1.5, '0']) {
    assert.throws(() => parseInput(JSON.stringify([{ ...event, network: { method: 'GET', url: '/image', durationMs: 1, status } }])), /network.status/);
  }
  assert.throws(() => parseInput(JSON.stringify([{ ...event, type: 'unknown' }])), /valid event type/);
  assert.throws(() => parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'Review', scenarios: [
    { id: 'bad', title: 'Unknown', match: { type: 'unknown' }, requirement: 'x', expectedSource: 'x', preconditions: [], questions: [], steps: [] },
  ] }), /match.type is invalid/);
});

test('resource snapshots with network status zero can be refined from a verified bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-resource-'));
  try {
    const source = join(root, 'source');
    const input = JSON.stringify({ schemaVersion: 1, events: [{ ...event,
      network: { method: 'GET', url: '/image', durationMs: 1, status: 0 } }] });
    await writeBundle(source, analyzeErrors(input));
    const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'Review', scenarios: [{
      id: 'resource-case', title: 'Image loading', match: { type: 'resource' },
      requirement: 'Image loads', expectedSource: 'Reviewed requirement', preconditions: [],
      setupConfirmed: true, questions: [],
      steps: [{ type: 'open', path: '/items' }, { type: 'act', instruction: 'Load image' },
        { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true }],
    }] });
    const refined = await refineBundle(source, profile);
    assert.equal(refined.candidates[0]?.state, 'draft');
    assert.equal(refined.groups[0]?.evidence[0]?.network?.status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI accepts --type resource and advertises it while rejecting unknown types', async () => {
  const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-resource-cli-'));
  try {
    const out = join(root, 'resource');
    const result = run(['analyze', '--error', 'Image failed', '--type', 'resource', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8')).groups[0].type, 'resource');
    assert.match(run(['--help']).stdout, /--type TYPE\s+[^\n]*resource/);
    const invalid = run(['analyze', '--error', 'Image failed', '--type', 'unknown', '--out', join(root, 'unknown')]);
    assert.equal(invalid.status, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
