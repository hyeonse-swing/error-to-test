import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { analyzeErrors } from '../src/analysis.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
