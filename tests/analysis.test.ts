import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { analyzeErrors } from '../src/analysis.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const event = (eventId: string, message: string, viewId: string, occurredAt = '2026-10-13T01:00:00Z') => ({
  schemaVersion: 1, eventId, project: 'demo', environment: 'test', release: '1', sdkVersion: '0.1.5',
  occurredAt, viewId, sequence: 1, elapsedMs: 100, type: 'javascript', message, page: '/items', runtime: 'browser',
});
const sdkInput = (events: ReturnType<typeof event>[]) => JSON.stringify({ schemaVersion: 1, events });

test('minCount defaults to one and retains every ranked group and source contract', () => {
  const input = sdkInput([event('a', 'A failed', 'view-a'), event('b', 'B failed', 'view-b')]);
  const baseline = analyzeErrors(input);
  assert.deepEqual(analyzeErrors(input, { minCount: 1 }), baseline);
  assert.equal(baseline.groups.length, 2);
  assert.equal(baseline.candidates.length, 2);
  assert.equal(baseline.source.sha256, sha256(input));
});

test('inclusive minCount filters candidates before top without removing groups', () => {
  const input = sdkInput([
    event('a1', 'A failed', 'view-a1'), event('a2', 'A failed', 'view-a2'),
    event('b1', 'B failed', 'view-b'), event('b2', 'B failed', 'view-b'), event('b3', 'B failed', 'view-b'),
    event('c1', 'C failed', 'view-c'), event('c2', 'C failed', 'view-c'), event('c3', 'C failed', 'view-c'),
  ]);
  const analysis = analyzeErrors(input, { minCount: 3, top: 1 });
  assert.equal(analysis.groups.length, 3);
  assert.equal(analysis.groups[0]?.message, 'A failed'); // Higher view count, but below threshold.
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0]?.groupId, analysis.groups.find(group => group.message === 'B failed')?.id);
  assert.match(analysis.warnings.join('\n'), /2 of 3 groups are eligible/);
  assert.match(analysis.warnings.join('\n'), /first 1 of 2 eligible ranked groups/);
  assert.doesNotMatch(analysis.warnings.join('\n'), /first 1 of 3 ranked groups/);
});

test('minCount uses deduplicated and date-filtered group counts', () => {
  const recent = event('recent', 'Same failure', 'view-1');
  const old = event('old', 'Same failure', 'view-2', '2026-09-01T01:00:00Z');
  const analysis = analyzeErrors(sdkInput([recent, recent, old]), { from: '2026-10-01T00:00:00Z', minCount: 2 });
  assert.equal(analysis.coverage.duplicates, 1);
  assert.equal(analysis.coverage.filtered, 1);
  assert.equal(analysis.groups[0]?.count, 1);
  assert.equal(analysis.candidates.length, 0);
});

test('no eligible group exports no suite while retaining full analysis', () => {
  const analysis = analyzeErrors(sdkInput([event('a', 'A failed', 'view-a')]), { minCount: 2 });
  assert.equal(analysis.groups.length, 1);
  assert.equal(analysis.candidates.length, 0);
  assert.equal(exportFlowQa(analysis).suite, undefined);
  assert.match(analysis.warnings.join('\n'), /0 of 1 groups are eligible/);
});

test('minCount rejects values outside integer bounds and accepts 10000', () => {
  for (const minCount of [0, -1, 10001, 1.5, NaN, Infinity]) {
    assert.throws(() => analyzeErrors('Error: failure', { minCount }), /minCount must be an integer between 1 and 10000/);
  }
  assert.doesNotThrow(() => analyzeErrors('Error: failure', { minCount: 10000 }));
});

test('a single profile BOM preserves candidates and hashes the original profile and input', async () => {
  const input = await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8');
  const profile = await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8');
  const bomProfile = `\uFEFF${profile}`;
  const clean = analyzeErrors(input, { profile });
  const withBom = analyzeErrors(input, { profile: bomProfile });

  assert.ok(clean.candidates.some(candidate => candidate.ruleId === 'missing-item' && candidate.state === 'draft'));
  assert.deepEqual(withBom.candidates, clean.candidates);
  assert.deepEqual(analyzeErrors(input, { profile: JSON.parse(profile) }).candidates, clean.candidates);
  assert.equal(withBom.source.sha256, sha256(input));
  assert.equal(withBom.source.sha256, clean.source.sha256);
  assert.equal(withBom.source.profileSha256, sha256(bomProfile));
  assert.notEqual(withBom.source.profileSha256, clean.source.profileSha256);
});

test('a profile BOM does not hide malformed JSON or a second BOM', () => {
  for (const profile of ['\uFEFF{invalid', '\uFEFF\uFEFF{}']) {
    assert.throws(() => analyzeErrors('Error: observed failure', { profile }), /The profile is not valid JSON/);
  }
});

test('profile byte limit counts the three BOM bytes before parsing', () => {
  const base = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'x', scenarios: [] });
  const atLimit = `\uFEFF${base}${' '.repeat(1024 * 1024 - 3 - Buffer.byteLength(base))}`;
  assert.equal(Buffer.byteLength(atLimit), 1024 * 1024);
  assert.doesNotThrow(() => analyzeErrors('Error: observed failure', { profile: atLimit }));
  assert.throws(() => analyzeErrors('Error: observed failure', { profile: `${atLimit} ` }), /The profile must be 1 MiB or smaller/);
});
