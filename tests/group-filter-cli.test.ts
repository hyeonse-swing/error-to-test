import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors } from '../src/analysis.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const source = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'a1', message: 'Frequent error', page: '/first' },
  { id: 'a2', message: 'Frequent error', page: '/first' },
  { id: 'b', message: 'Less frequent error', page: '/second' },
] });

test('group CLI selection preserves the complete input and selects below the top-ranked group', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-groups-cli-'));
  try {
    const input = join(temp, 'errors.json');
    await writeFile(input, source);
    const original = analyzeErrors(source);
    const [higher, lower] = original.groups;
    const out = join(temp, 'selected');
    const result = run(['analyze', '--input', input, '--group', lower!.id, '--group', lower!.id, '--top', '1', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.deepEqual(analysis.groups, original.groups);
    assert.deepEqual(analysis.source, original.source);
    assert.deepEqual(analysis.coverage, original.coverage);
    assert.deepEqual(analysis.groupFilter, { groupIds: [lower!.id] });
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0].groupId, lower!.id);
    assert.match(result.stdout, /1 explicit group IDs requested/);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /Explicit group selection/);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), new RegExp(lower!.id));
    assert.equal(run(['verify', out, '--input', input]).status, 0);
    const template = join(temp, 'profile.json');
    assert.equal(run(['init-profile', out, '--out', template]).status, 0);
    const profile = JSON.parse(await readFile(template, 'utf8'));
    assert.deepEqual(profile.scenarios.map((item: any) => item.match.groupId), [lower!.id]);
    const summary = run(['readiness', out, '--format', 'json']);
    assert.equal(summary.status, 2, summary.stderr);
    assert.deepEqual([JSON.parse(summary.stdout).counts.groups, JSON.parse(summary.stdout).counts.selected], [2, 1]);
    const ranked = join(temp, 'ranked');
    assert.equal(run(['analyze', '--input', input, '--group', lower!.id, '--group', higher!.id, '--top', '1', '--out', ranked]).status, 0);
    const rankedAnalysis = JSON.parse(await readFile(join(ranked, 'analysis.json'), 'utf8'));
    assert.equal(rankedAnalysis.candidates[0].groupId, higher!.id);
    assert.deepEqual(rankedAnalysis.groupFilter.groupIds, [higher!.id, lower!.id].sort());
    const empty = join(temp, 'empty');
    assert.equal(run(['analyze', '--input', input, '--group', lower!.id, '--min-count', '2', '--out', empty]).status, 0);
    assert.equal(JSON.parse(await readFile(join(empty, 'analysis.json'), 'utf8')).candidates.length, 0);
    assert.equal(run(['verify', empty, '--input', input]).status, 0);
    assert.equal(JSON.parse(run(['readiness', empty, '--format', 'json']).stdout).status, 'empty');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('group CLI selection combines with baseline while comparison retains all groups', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-groups-baseline-'));
  try {
    const input = join(temp, 'current.json');
    const before = join(temp, 'before.json');
    await writeFile(input, source);
    await writeFile(before, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [JSON.parse(source).errors[0]] }));
    const baseline = join(temp, 'baseline');
    assert.equal(run(['analyze', '--input', before, '--out', baseline]).status, 0);
    const [known, fresh] = analyzeErrors(source).groups;
    for (const group of [known!, fresh!]) {
      const out = join(temp, group.id);
      const result = run(['analyze', '--input', input, '--baseline', baseline, '--group', group.id, '--out', out]);
      assert.equal(result.status, 0, result.stderr);
      const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
      assert.equal(analysis.groups.length, 2);
      assert.equal(analysis.candidates.length, group.id === known!.id ? 0 : 1);
      assert.deepEqual([analysis.selection.onlyCurrentGroupCount, analysis.selection.excludedGroupCount], [1, 1]);
      const comparison = run(['compare', baseline, out, '--format', 'json']);
      assert.equal(comparison.status, 0, comparison.stderr);
      assert.deepEqual(JSON.parse(comparison.stdout).counts, { 'only-current': 1, both: 1, 'only-baseline': 0 });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('invalid, stale, and unsupported group options fail without creating a bundle or echoing supplied values', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-groups-invalid-'));
  try {
    const input = join(temp, 'errors.json');
    await writeFile(input, source);
    const id = analyzeErrors(source).groups[0]!.id;
    for (const [index, groupArgs] of [
      ['--group', ''], ['--group', 'group-0000000000000000'], ['--group', 'GROUP-0123456789ABCDEF'],
      ['--group', 'sensitive-user-provided-value'], Array.from({ length: 101 }, () => ['--group', id]).flat(),
    ].entries()) {
      const out = join(temp, `invalid-${index}`);
      const result = run(['analyze', '--input', input, ...groupArgs, '--out', out]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /sensitive-user-provided-value/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const out = join(temp, 'date-excluded');
    const filtered = run(['analyze', '--input', input, '--group', id, '--from', '2026-01-01T00:00:00Z', '--out', out]);
    assert.equal(filtered.status, 1, filtered.stderr);
    await assert.rejects(stat(out), { code: 'ENOENT' });
    const bundle = join(temp, 'bundle');
    assert.equal(run(['analyze', '--input', input, '--out', bundle]).status, 0);
    for (const args of [
      ['verify', bundle], ['readiness', bundle], ['results', bundle], ['compare', bundle, bundle],
      ['init-profile', bundle, '--out', join(temp, 'profile.json')], ['link-run', bundle, '--report', input],
    ]) {
      const result = run([...args, '--group', id]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
