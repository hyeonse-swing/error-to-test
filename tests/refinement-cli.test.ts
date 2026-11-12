import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const input = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'first', message: 'Item failed', runtime: 'browser', page: '/items' },
  { id: 'other', message: 'Other failure', runtime: 'browser', page: '/other' },
] });
const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'Refinement demo', scenarios: [{
  id: 'item', title: 'Missing item shows fallback', match: { pagePath: '/items' },
  requirement: 'A missing item displays the fallback', expectedSource: 'Demo requirement', setupConfirmed: true,
  preconditions: ['Demo data is prepared'], questions: [], steps: [
    { type: 'open', path: '/items' }, { type: 'act', instruction: 'Open the missing item' },
    { type: 'assertVisible', locator: { by: 'text', value: 'Item unavailable' }, visible: true },
  ],
}] });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

test('refine CLI regenerates selected cases without original logs and resets review acknowledgement', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-refine-cli-'));
  try {
    const oldInput = join(temp, 'original.json');
    await writeFile(oldInput, input);
    const selectedId = analyzeErrors(input).groups.find(group => group.pagePath === '/items')!.id;
    const old = analyzeErrors(input, { groupIds: [selectedId] });
    const source = join(temp, 'source');
    await writeBundle(source, old, { reviewed: true });
    await rm(oldInput);
    const previousProvenance = await readFile(join(source, 'provenance.json'), 'utf8');
    const previousAnalysis = await readFile(join(source, 'analysis.json'), 'utf8');
    const profileFile = join(temp, 'updated.json');
    const profileText = `\uFEFF${profile}`;
    await writeFile(profileFile, profileText);
    const out = join(temp, 'refined');
    const result = run(['refine', source, '--profile', profileFile, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Review acknowledgment: pending/);
    assert.match(result.stdout, /Original input was not rechecked/);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.deepEqual(analysis.groups, old.groups);
    assert.deepEqual(analysis.coverage, old.coverage);
    assert.deepEqual(analysis.groupFilter, old.groupFilter);
    assert.equal(analysis.source.sha256, old.source.sha256);
    assert.equal(analysis.source.profileSha256, hash(profileText));
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0].groupId, selectedId);
    assert.equal(analysis.candidates[0].state, 'draft');
    assert.equal(analysis.refinement.sourceAnalysisSha256, JSON.parse(previousProvenance).analysisSha256);
    assert.equal(analysis.refinement.sourceSuiteSha256, JSON.parse(previousProvenance).suiteSha256);
    assert.deepEqual(analysis.refinement.selectedGroupIds, [selectedId]);
    const readiness = run(['readiness', out, '--format', 'json']);
    assert.equal(readiness.status, 2, readiness.stderr);
    assert.equal(JSON.parse(readiness.stdout).reviewed, false);
    assert.equal(JSON.parse(readiness.stdout).counts.draft, 1);
    assert.equal(run(['verify', out, '--profile', profileFile]).status, 0);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /Profile refinement/);
    await assert.rejects(stat(join(out, 'results')), { code: 'ENOENT' });
    const acknowledged = join(temp, 'acknowledged');
    const approved = run(['refine', source, '--profile', profileFile, '--reviewed', '--out', acknowledged]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(run(['readiness', acknowledged, '--format', 'json']).status, 0);
    assert.equal(await readFile(join(source, 'provenance.json'), 'utf8'), previousProvenance);
    assert.equal(await readFile(join(source, 'analysis.json'), 'utf8'), previousAnalysis);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('refine acknowledgement never clears original context questions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-refine-context-cli-'));
  try {
    const content = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{
      id: 'question', message: 'Item failed', page: '/items', runtime: 'browser', questions: ['Confirm the failure condition'],
    }] });
    const source = join(temp, 'source');
    await writeBundle(source, analyzeErrors(content), { reviewed: true });
    const file = join(temp, 'profile.json');
    await writeFile(file, profile);
    const out = join(temp, 'refined');
    const refined = run(['refine', source, '--profile', file, '--reviewed', '--out', out]);
    assert.equal(refined.status, 0, refined.stderr);
    const summary = run(['readiness', out, '--format', 'json']);
    assert.equal(summary.status, 2, summary.stderr);
    assert.equal(JSON.parse(summary.stdout).reviewed, true);
    assert.ok(JSON.parse(summary.stdout).cases[0].blockers.includes('Confirm the failure condition'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('refine rejects unsafe output paths, irrelevant options, bad profiles, and stale sources before writing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-refine-invalid-cli-'));
  try {
    const source = join(temp, 'source');
    await writeBundle(source, analyzeErrors(input));
    const file = join(temp, 'profile.json');
    await writeFile(file, profile);
    const out = join(temp, 'new');
    for (const args of [[], [source], [source, '--profile', file], [source, '--out', out],
      [source, '--profile', '', '--out', out], [source, '--profile', file, '--out', ' '],
      [source, '--profile', file, '--out', out, '--input', 'absent'],
      [source, '--profile', file, '--out', out, '--group', analyzeErrors(input).groups[0]!.id],
      [source, '--profile', file, '--out', out, '--top', '1'], [source, '--profile', file, '--out', out, '--format', 'json']]) {
      const result = run(['refine', ...args]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const alias = join(temp, 'alias');
    await symlink(source, alias, 'dir');
    for (const target of [source, join(source, 'nested'), join(source, 'results', 'nested'), join(alias, 'nested'),
      join(dirname(source), basename(source).toUpperCase(), 'nested')]) {
      const rejected = run(['refine', source, '--profile', file, '--out', target]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /outside the source bundle/);
    }
    const existing = join(temp, 'existing');
    await writeBundle(existing, analyzeErrors(input));
    const before = await readFile(join(existing, 'analysis.json'), 'utf8');
    assert.equal(run(['refine', source, '--profile', file, '--out', existing]).status, 1);
    assert.equal(await readFile(join(existing, 'analysis.json'), 'utf8'), before);
    for (const invalid of ['{invalid', `\uFEFF\uFEFF${profile}`, `${profile}${' '.repeat(1024 * 1024)}`]) {
      await writeFile(file, invalid);
      assert.equal(run(['refine', source, '--profile', file, '--out', out]).status, 1);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    await writeFile(file, profile);
    await writeFile(join(source, 'report.md'), 'tampered');
    const stale = run(['refine', source, '--profile', file, '--out', out]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(out), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
