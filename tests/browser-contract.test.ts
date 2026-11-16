import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInput } from '../src/input.ts';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { createCandidates, parseProfile } from '../src/candidates.ts';
import { compareAnalyses, renderComparison } from '../src/comparison.ts';
import { refineBundle } from '../src/refinement.ts';

const event = {
  schemaVersion: 1, eventId: 'resource-1', project: 'demo', environment: 'test', release: 'r1', sdkVersion: '0.2.9',
  occurredAt: '2026-11-16T00:00:00Z', viewId: 'view-1', sequence: 1, elapsedMs: 1,
  type: 'resource', name: 'ResourceLoadError', message: 'Failed to load img resource',
  page: '/items', runtime: 'browser', context: { resourceTag: 'img', resourceUrl: 'https://example.com/img.png' },
};

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
