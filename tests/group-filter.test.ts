import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors, analyzeWithBaseline } from '../src/analysis.ts';
import { verifyBundle, writeBundle } from '../src/artifacts.ts';
import { hash } from '../src/validation.ts';

const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, release = 'r1', extra: Record<string, unknown> = {}) =>
  ({ id, message, release, project: 'demo', environment: 'test', runtime: 'browser', type: 'javascript', page: '/items', ...extra });
const repeated = (message: string, count: number, release = 'r1') =>
  Array.from({ length: count }, (_, index) => item(`${message}-${release}-${index}`, message, release));
const idFor = (groups: ReturnType<typeof analyzeErrors>['groups'], message: string) => groups.find(group => group.message === message)!.id;

test('explicit IDs select before top, retain ranked order and all source groups, and canonicalize metadata', () => {
  const input = manual(...repeated('Frequent', 4), ...repeated('Middle', 3), item('rare', 'Rare'));
  const original = analyzeErrors(input);
  const rare = idFor(original.groups, 'Rare');
  const middle = idFor(original.groups, 'Middle');
  const ids = [rare, middle, rare];
  const selected = analyzeErrors(input, { groupIds: ids, top: 1 });
  assert.deepEqual(ids, [rare, middle, rare]);
  assert.deepEqual(selected.groupFilter, { groupIds: [middle, rare].sort() });
  assert.deepEqual(selected.candidates.map(candidate => candidate.groupId), [middle]);
  assert.deepEqual(selected.groups, original.groups);
  assert.deepEqual(selected.source, original.source);
  assert.deepEqual(selected.coverage, original.coverage);
  assert.equal(selected.source.sha256, hash(input));
  assert.deepEqual(analyzeErrors(input, { groupIds: [middle, rare], top: 1 }), selected);
  assert.match(selected.warnings.join('\n'), /Explicit group TC selection: 2 requested groups; 2 intersect/);
  assert.equal(Object.hasOwn(original, 'groupFilter'), false);
  assert.deepEqual(analyzeErrors(input, {}), original);
  assert.deepEqual(analyzeErrors(input, { groupIds: [rare], top: 1 }).candidates.map(candidate => candidate.groupId), [rare]);
});

test('group selection applies to deduplicated and date-filtered counts before minCount', () => {
  const recent = item('recent', 'Same', 'r1', { occurredAt: '2026-10-10T00:00:00Z' });
  const old = item('old', 'Same', 'r1', { occurredAt: '2026-09-01T00:00:00Z' });
  const input = manual(recent, recent, old);
  const options = { from: '2026-10-01T00:00:00Z' };
  const id = analyzeErrors(input, options).groups[0]!.id;
  const result = analyzeErrors(input, { ...options, groupIds: [id], minCount: 2 });
  assert.equal(result.coverage.duplicates, 1);
  assert.equal(result.coverage.filtered, 1);
  assert.equal(result.groups[0]!.count, 1);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.groupFilter, { groupIds: [id] });
});

test('rejects malformed, absent, filtered-out and other-release IDs without echoing input', () => {
  const input = manual(item('present', 'Present'));
  const id = analyzeErrors(input).groups[0]!.id;
  const invalid: unknown[] = [null, [], {}, 'x', [''], ['group-ABCDEF0123456789'], ['group-0000000000000000 '],
    ['group-0000000000000000', 2], Array.from({ length: 101 }, () => id)];
  for (const groupIds of invalid) {
    assert.throws(() => analyzeErrors(input, { groupIds: groupIds as string[] }), error => {
      assert.match((error as Error).message, /groupIds must contain 1 to 100 valid group IDs/);
      assert.doesNotMatch((error as Error).message, /ABCDEF|0000000000000000/);
      return true;
    });
  }
  const unknown = 'group-0000000000000000';
  assert.notEqual(unknown, id);
  assert.throws(() => analyzeErrors(input, { groupIds: [unknown] }), /requested group ID was not found/);
  const oldRelease = idFor(analyzeErrors(manual(item('old', 'Present', 'r0'))).groups, 'Present');
  assert.notEqual(oldRelease, id);
  assert.throws(() => analyzeErrors(input, { groupIds: [oldRelease] }), /requested group ID was not found/);
  assert.throws(() => analyzeErrors(input, { groupIds: [id], project: 'other' }), /requested group ID was not found/);
});

test('baseline selection intersects explicit IDs while preserving baseline counts and valid empty outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-filter-baseline-'));
  try {
    const baseline = join(root, 'baseline');
    await writeBundle(baseline, analyzeErrors(manual(item('old', 'Shared'))));
    const input = manual(...repeated('Shared', 4, 'r2'), ...repeated('New', 2, 'r2'));
    const plain = await analyzeWithBaseline(input, baseline);
    const shared = idFor(plain.groups, 'Shared');
    const newer = idFor(plain.groups, 'New');
    const selected = await analyzeWithBaseline(input, baseline, { groupIds: [shared, newer], top: 1 });
    assert.deepEqual(selected.selection, plain.selection);
    assert.deepEqual(selected.candidates.map(candidate => candidate.groupId), [newer]);
    assert.deepEqual(selected.groups, plain.groups);
    const empty = await analyzeWithBaseline(input, baseline, { groupIds: [shared] });
    assert.deepEqual(empty.selection, plain.selection);
    assert.deepEqual(empty.candidates, []);
    assert.match(empty.warnings.join('\n'), /1 requested groups; 0 intersect/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected groups retain every matching profile scenario and existing review gates', () => {
  const input = manual(item('one', 'One'), item('two', 'Two'));
  const id = idFor(analyzeErrors(input).groups, 'One');
  const scenario = (ruleId: string, setupConfirmed: boolean) => ({
    id: ruleId, title: ruleId, match: { groupId: id }, requirement: 'Success appears', expectedSource: 'spec',
    setupConfirmed, preconditions: ['signed in'], questions: [],
    steps: [{ type: 'open', path: '/items' }, { type: 'assertVisible', locator: { by: 'text', value: 'Success' }, visible: true }],
  });
  const profile = { schemaVersion: 'error-to-test/profile-1', name: 'demo',
    scenarios: [scenario('ready', true), scenario('needs-review', false)] };
  const all = analyzeErrors(input, { profile });
  const selected = analyzeErrors(input, { profile, groupIds: [id] });
  assert.deepEqual(selected.candidates, all.candidates.filter(candidate => candidate.groupId === id));
  assert.deepEqual(selected.candidates.map(candidate => [candidate.ruleId, candidate.state]),
    [['needs-review', 'needs-context'], ['ready', 'draft']]);
  assert.equal(selected.source.profileSha256, all.source.profileSha256);
  assert.deepEqual(selected.groups, all.groups);
});

test('bundle verifies group metadata and detects analysis tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'group-filter-bundle-'));
  try {
    const input = manual(item('one', 'One'));
    const id = analyzeErrors(input).groups[0]!.id;
    const output = join(root, 'bundle');
    await writeBundle(output, analyzeErrors(input, { groupIds: [id] }));
    assert.deepEqual(await verifyBundle(output, { input }), { suite: true, reviewed: false, sourceChecked: true });
    const path = join(output, 'analysis.json');
    const analysis = JSON.parse(await readFile(path, 'utf8'));
    analysis.groupFilter.groupIds = ['group-0000000000000000'];
    await writeFile(path, JSON.stringify(analysis));
    await assert.rejects(verifyBundle(output, { input }), /STALE_BUNDLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
