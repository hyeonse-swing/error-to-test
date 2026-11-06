import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseInput } from '../src/input.ts';
import { inputSource, validateInputSource } from '../src/input-source.ts';
import { analyzeErrors, analyzeWithBaseline } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const event = (eventId: string, message = 'Shared failure', occurredAt = '2026-11-01T00:00:00Z') => ({
  schemaVersion: 1, eventId, project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1',
  occurredAt, viewId: `view-${eventId}`, sequence: 1, elapsedMs: 1, type: 'javascript', message,
  page: '/items', runtime: 'browser',
});
const browser = (events: ReturnType<typeof event>[], partial = false) => JSON.stringify({ schemaVersion: 1, partial, events });
const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });

test('a one-element input array is exactly equivalent to a string for every source kind', () => {
  for (const source of [browser([event('a')]), manual({ id: 'a', message: 'Failure' }), 'Error: failure\n at run (/x:1)']) {
    assert.deepEqual(parseInput([source]), parseInput(source));
    assert.deepEqual(analyzeErrors([source]), analyzeErrors(source));
    assert.equal(inputSource([source]).sha256, sha256(source));
    assert.equal(inputSource([source]).inputs, undefined);
  }
});

test('browser wrappers and arrays combine before dedup, filters, ranking, minCount, and top', () => {
  const a = event('a', 'A failed');
  const b = event('b', 'B failed');
  const inputs = [browser([a, b], true), JSON.stringify([a, event('c', 'A failed'),
    event('d', 'B failed'), event('e', 'B failed'), event('old', 'Old failed', '2026-01-01T00:00:00Z')])];
  const parsed = parseInput(inputs, { from: '2026-10-01T00:00:00Z' });
  assert.equal(parsed.coverage.kind, 'browser-error-json');
  assert.equal(parsed.coverage.frequency, 'captured-events');
  assert.equal(parsed.coverage.partial, true);
  assert.deepEqual([parsed.coverage.inputCount, parsed.coverage.duplicates, parsed.coverage.filtered], [7, 1, 1]);
  assert.equal(parsed.observations.length, 5);
  assert.equal(parsed.warnings.filter(warning => warning.includes('Date filtering')).length, 1);
  assert.equal(parsed.warnings.filter(warning => warning.includes('input files')).length, 1);
  const analysis = analyzeErrors(inputs, { from: '2026-10-01T00:00:00Z', minCount: 2, top: 1 });
  assert.deepEqual(analysis.groups.map(group => [group.message, group.count]), [['B failed', 3], ['A failed', 2]]);
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0]?.groupId, analysis.groups[0]?.id);
  assert.deepEqual(analysis.source.inputs, parsed.inputs);
});

test('cross-file raw conflicts reject before filters even when redaction would make observations equal', () => {
  const first = event('same', 'token=alpha');
  const second = event('same', 'token=beta');
  assert.equal(parseInput(browser([first])).observations[0]?.message,
    parseInput(browser([second])).observations[0]?.message);
  assert.throws(() => parseInput([browser([first]), browser([second])], { project: 'excluded' }), /Conflicting duplicate ID/);
  assert.throws(() => parseInput([manual({ id: 'same', project: 'demo', message: 'token=alpha' }),
    manual({ id: 'same', project: 'demo', message: 'token=beta' })], { project: 'excluded' }), /Conflicting duplicate ID/);
});

test('same frequency does not allow mixed kinds', () => {
  assert.throws(() => parseInput([manual({ message: 'Failure' }), 'Failure']), /same source kind/);
  assert.throws(() => parseInput([browser([event('a')]), manual({ message: 'Failure' })]), /same source kind/);
  assert.throws(() => parseInput(['Failure', browser([event('a')])]), /same source kind/);
});

test('text files are distinct reports and logical duplicate reports ignore surrounding whitespace', () => {
  const parsed = parseInput(['  Error: failure\n at run (/x:1)  ', 'Error: failure\n at run (/x:1)', 'Error: other']);
  assert.equal(parsed.coverage.kind, 'manual-text');
  assert.equal(parsed.coverage.frequency, 'submitted-reports');
  assert.deepEqual([parsed.coverage.inputCount, parsed.coverage.duplicates, parsed.coverage.filtered], [3, 1, 0]);
  assert.equal(parsed.observations.length, 2);
  assert.equal(analyzeErrors(['Error: failure', 'Error: other']).groups.length, 2);
});

test('file fingerprints preserve original BOM bytes, order, and document boundaries', () => {
  const first = `\uFEFF${browser([event('a')])}`;
  const second = JSON.stringify([event('b')]);
  const result = inputSource([first, second]);
  const inputs = [{ sha256: sha256(first), byteLength: Buffer.byteLength(first) },
    { sha256: sha256(second), byteLength: Buffer.byteLength(second) }];
  const descriptor = JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs });
  assert.deepEqual(result, { sha256: sha256(descriptor), inputs });
  assert.deepEqual(parseInput([first, second]).inputs, inputs);
  assert.equal(analyzeErrors([first, second]).source.sha256, sha256(descriptor));
  assert.notEqual(inputSource([second, first]).sha256, result.sha256);
  assert.notEqual(inputSource(['ab', 'c']).sha256, inputSource(['a', 'bc']).sha256);
  assert.doesNotThrow(() => validateInputSource({ ...result, profileSha256: 'f'.repeat(64) }));
  assert.throws(() => validateInputSource({ ...result, inputs: [{ ...inputs[0], byteLength: inputs[0]!.byteLength - 1 }, inputs[1]] }), /STALE_BUNDLE/);
  assert.throws(() => validateInputSource({ sha256: result.sha256, inputs: [inputs[0]] }), /STALE_BUNDLE/);
});

test('limits apply to total original bytes, raw records, and number of files', () => {
  assert.throws(() => parseInput([]), /1 to 50 files/);
  assert.throws(() => parseInput(Array(51).fill('Failure')), /1 to 50 files/);
  assert.throws(() => parseInput(['Failure', 1] as unknown as string[]), /must be a string/);
  assert.throws(() => parseInput(['Failure', '  ']), /Input is empty/);
  assert.equal(parseInput(Array(50).fill('Failure')).coverage.inputCount, 50);
  const one = manual(...Array(5000).fill({ message: 'Same' }));
  const two = manual(...Array(5001).fill({ message: 'Same' }));
  assert.throws(() => parseInput([one, two]), /10000 records/);
  assert.equal(parseInput([one, manual(...Array(5000).fill({ message: 'Same' }))]).coverage.inputCount, 10000);
  const base = manual({ message: 'First' });
  const other = manual({ message: 'Second' });
  const half = 5 * 1024 * 1024;
  const paddedBase = base + ' '.repeat(half - Buffer.byteLength(base));
  const paddedOther = other + ' '.repeat(half - Buffer.byteLength(other));
  assert.equal(parseInput([paddedBase, paddedOther]).coverage.inputCount, 2);
  assert.throws(() => parseInput([paddedBase, `${paddedOther} `]), /10 MiB/);
});

test('baseline selection, profile hashes, and review gates work with file arrays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-multi-'));
  const baselineDirectory = join(root, 'baseline');
  const old = (id: string) => ({ id, message: 'Old failure', project: 'demo', environment: 'test', release: 'r1', runtime: 'browser' });
  const next = (id: string) => ({ id, message: 'New failure', project: 'demo', environment: 'test', release: 'r2', runtime: 'browser' });
  const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'demo', scenarios: [{
    id: 'new-rule', title: 'New failure', match: { messageIncludes: 'New failure' }, requirement: 'Success appears',
    expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'], questions: [],
    steps: [{ type: 'open', path: '/items' }, { type: 'assertVisible', locator: { by: 'text', value: 'Success' }, visible: true }],
  }] });
  try {
    await writeBundle(baselineDirectory, analyzeErrors([manual(old('old-1')), manual(old('old-2'))]));
    const sources = [manual(old('old-3'), next('new-1')), manual(next('new-2'))];
    const analysis = await analyzeWithBaseline(sources, baselineDirectory, { profile, minCount: 2 });
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.selection?.onlyCurrentGroupCount, 1);
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0]?.ruleId, 'new-rule');
    assert.equal(analysis.candidates[0]?.state, 'draft');
    assert.equal(analysis.source.profileSha256, sha256(profile));
    assert.deepEqual(analysis.source.inputs, inputSource(sources).inputs);
    assert.ok(exportFlowQa(analysis).suite?.cases[0]?.questions.some(question => /Review this draft case/.test(question)));
    assert.deepEqual(exportFlowQa(analysis, { reviewed: true }).suite?.cases[0]?.questions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
