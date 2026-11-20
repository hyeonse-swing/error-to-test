import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeErrors, analyzeWithBaseline, reselectBundle, writeBundle } from '../src/index.ts';
import { readVerifiedBundle } from '../src/artifacts.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, extras: Record<string, unknown> = {}) => ({
  id, message, project: 'return-qa', environment: 'test', release: 'r1', runtime: 'browser',
  type: 'manual', page: '/returns', ...extras,
});
const profile = (groupId: string) => JSON.stringify({
  schemaVersion: 'error-to-test/profile-1', name: 'Reinspection', scenarios: [{
    id: 'reinspect', title: 'Review the selected failure', match: { groupId },
    requirement: 'The return can be inspected.', expectedSource: 'Return scenario',
    preconditions: ['Use prepared data.'], setupConfirmed: true, questions: [],
    steps: [{ type: 'open', path: '/returns' }, { type: 'act', instruction: 'Inspect the selected return.' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Return details' }, visible: true }],
  }],
});

test('reselects only a saved top-excluded group after original logs are removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-reselect-cli-'));
  try {
    const input = manual(item('a1', 'Frequent'), item('a2', 'Frequent'), item('b1', 'Later failure'));
    const originalFile = join(root, 'errors.json');
    await writeFile(originalFile, input);
    const sourceAnalysis = analyzeErrors(input, { top: 1 });
    const selectedId = sourceAnalysis.candidates[0]!.groupId;
    const skipped = sourceAnalysis.groups.find(group => group.id !== selectedId)!;
    const source = join(root, 'source');
    await writeBundle(source, sourceAnalysis, { reviewed: true });
    await mkdir(join(source, 'results'));
    await writeFile(join(source, 'results', 'existing-note.txt'), 'old linked results stay with the source');
    const oldAnalysis = await readFile(join(source, 'analysis.json'), 'utf8');
    const oldProvenance = await readFile(join(source, 'provenance.json'), 'utf8');
    await rm(originalFile);

    const profileFile = join(root, 'profile.json');
    const profileText = profile(skipped.id);
    await writeFile(profileFile, profileText);
    const out = join(root, 'new-bundle');
    const result = run(['reselect', source, '--group', skipped.id, '--profile', profileFile, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Review acknowledgment: pending/);
    const newAnalysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.deepEqual(newAnalysis.groups, sourceAnalysis.groups);
    assert.deepEqual(newAnalysis.coverage, sourceAnalysis.coverage);
    assert.equal(newAnalysis.source.sha256, sourceAnalysis.source.sha256);
    assert.deepEqual(newAnalysis.candidates.map((candidate: { groupId: string }) => candidate.groupId), [skipped.id]);
    assert.equal(newAnalysis.candidates[0].state, 'draft');
    assert.deepEqual(newAnalysis.reselection, {
      sourceAnalysisSha256: JSON.parse(oldProvenance).analysisSha256,
      sourceSuiteSha256: JSON.parse(oldProvenance).suiteSha256,
      previouslySelectedGroupIds: [selectedId], selectedGroupIds: [skipped.id],
    });
    const snapshot = await readVerifiedBundle(out, { profile: profileText });
    assert.equal(snapshot.verification.reviewed, false);
    assert.deepEqual(snapshot.provenance.mappings.map((entry: { groupId: string }) => entry.groupId), [skipped.id]);
    await assert.rejects(reselectBundle(out, [selectedId], profileText), /original ranked analysis bundle/);
    const refinedFromReselection = join(root, 'refined-reselection');
    assert.equal(run(['refine', out, '--profile', profileFile, '--out', refinedFromReselection]).status, 0);
    await assert.rejects(reselectBundle(refinedFromReselection, [selectedId], profileText), /original ranked analysis bundle/);
    const refinedFromOriginal = join(root, 'refined-original');
    assert.equal(run(['refine', source, '--profile', profileFile, '--out', refinedFromOriginal]).status, 0);
    const fromRefined = await reselectBundle(refinedFromOriginal, [skipped.id], profileText);
    assert.deepEqual(fromRefined.candidates.map(candidate => candidate.groupId), [skipped.id]);
    assert.equal(run(['readiness', out, '--format', 'json']).status, 2);
    assert.equal(run(['verify', out, '--profile', profileFile]).status, 0);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /Saved group reselection/);
    await assert.rejects(stat(join(out, 'results')), { code: 'ENOENT' });
    assert.equal(await readFile(join(source, 'analysis.json'), 'utf8'), oldAnalysis);
    assert.equal(await readFile(join(source, 'provenance.json'), 'utf8'), oldProvenance);
    assert.equal(await readFile(join(source, 'results', 'existing-note.txt'), 'utf8'), 'old linked results stay with the source');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reselects a min-count-excluded group in saved rank order and keeps full context questions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-reselect-context-'));
  try {
    const sourceAnalysis = analyzeErrors(manual(item('a1', 'Frequent'), item('a2', 'Frequent'),
      item('b1', 'Rare', { questions: ['Confirm setup before running.'] }), item('c1', 'Another rare failure')), { minCount: 2 });
    const rare = sourceAnalysis.groups.find(group => group.message === 'Rare')!;
    const source = join(root, 'source');
    await writeBundle(source, sourceAnalysis);
    const selected = await reselectBundle(source, [rare.id], profile(rare.id));
    assert.deepEqual(selected.candidates.map(candidate => candidate.groupId), [rare.id]);
    assert.ok(selected.candidates[0]!.questions.includes('Confirm setup before running.'));
    const excluded = sourceAnalysis.groups.filter(group => group.id !== sourceAnalysis.candidates[0]!.groupId);
    const inSavedOrder = await reselectBundle(source, excluded.map(group => group.id).reverse(), profile(rare.id));
    assert.deepEqual(inSavedOrder.candidates.map(candidate => candidate.groupId), excluded.map(group => group.id));
    const out = join(root, 'new');
    await writeBundle(out, selected);
    assert.equal((await readVerifiedBundle(out)).verification.reviewed, false);
    const none = analyzeErrors(manual(item('single', 'Only observed failure')), { minCount: 2 });
    assert.equal(none.candidates.length, 0);
    const noneSource = join(root, 'no-candidates');
    await writeBundle(noneSource, none);
    const only = await reselectBundle(noneSource, [none.groups[0]!.id], profile(none.groups[0]!.id));
    assert.deepEqual(only.reselection?.previouslySelectedGroupIds, []);
    assert.deepEqual(only.candidates.map(candidate => candidate.groupId), [none.groups[0]!.id]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects baseline, explicit filters, missing context and unobserved or already selected IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-reselect-scope-'));
  try {
    const input = manual(item('a1', 'Frequent'), item('a2', 'Frequent'), item('b1', 'Rare'));
    const analysis = analyzeErrors(input, { top: 1 });
    const chosen = analysis.candidates[0]!.groupId;
    const rare = analysis.groups.find(group => group.id !== chosen)!.id;
    const source = join(root, 'source');
    await writeBundle(source, analysis);
    await assert.rejects(reselectBundle(source, [chosen], profile(chosen)), /excluded from the source/);
    await assert.rejects(reselectBundle(source, ['group-0000000000000000'], profile(rare)), /not observed/);
    await assert.rejects(reselectBundle(source, [rare, rare], profile(rare)), /distinct observed group IDs/);
    await assert.rejects(reselectBundle(source, [], profile(rare)), /distinct observed group IDs/);

    const filtered = join(root, 'filtered');
    await writeBundle(filtered, analyzeErrors(input, { groupIds: [chosen] }));
    await assert.rejects(reselectBundle(filtered, [rare], profile(rare)), /baseline or explicit group selection/);

    const base = join(root, 'base');
    await writeBundle(base, analyzeErrors(manual(item('known', 'Rare'))));
    const baseline = join(root, 'baseline');
    await writeBundle(baseline, await analyzeWithBaseline(input, base));
    await assert.rejects(reselectBundle(baseline, [rare], profile(rare)), /baseline or explicit group selection/);
    const noCurrent = join(root, 'no-current');
    await writeBundle(noCurrent, await analyzeWithBaseline(manual(item('known', 'Rare')), base));
    await assert.rejects(reselectBundle(noCurrent, [rare], profile(rare)), /baseline or explicit group selection/);

    const old = analyzeErrors(input, { top: 1 });
    delete old.groups.find(group => group.id === rare)!.context;
    const oldBundle = join(root, 'old');
    await writeBundle(oldBundle, old);
    await assert.rejects(reselectBundle(oldBundle, [rare], profile(rare)), /Reanalyze the original input/);

    const stale = join(root, 'stale');
    await writeBundle(stale, analysis);
    await writeFile(join(stale, 'report.md'), 'tampered');
    await assert.rejects(reselectBundle(stale, [rare], profile(rare)), /STALE_BUNDLE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI rejects unsafe outputs and options before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-reselect-path-'));
  try {
    const analysis = analyzeErrors(manual(item('a1', 'Frequent'), item('a2', 'Frequent'),
      item('b1', 'Rare')), { top: 1 });
    const source = join(root, 'source');
    await writeBundle(source, analysis);
    const rare = analysis.groups.find(group => group.id !== analysis.candidates[0]!.groupId)!.id;
    const profileFile = join(root, 'profile.json');
    await writeFile(profileFile, profile(rare));
    const out = join(root, 'new');
    for (const args of [
      ['reselect', source, '--profile', profileFile, '--out', out],
      ['reselect', source, '--group', rare, '--out', out],
      ['reselect', source, '--group', rare, '--profile', profileFile, '--out', out, '--reviewed'],
      ['reselect', source, '--group', rare, '--profile', profileFile, '--out', out, '--top', '2'],
      ['reselect', source, '--group', rare, '--profile', profileFile, '--out', out, '--input', 'missing'],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, result.stderr);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const alias = join(root, 'alias');
    await symlink(source, alias, 'dir');
    for (const target of [source, join(source, 'nested'), join(alias, 'nested'),
      join(dirname(source), basename(source).toUpperCase(), 'nested')]) {
      const result = run(['reselect', source, '--group', rare, '--profile', profileFile, '--out', target]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /outside the source bundle/);
    }
    const existing = join(root, 'existing');
    await writeBundle(existing, analysis);
    const previous = await readFile(join(existing, 'analysis.json'), 'utf8');
    assert.equal(run(['reselect', source, '--group', rare, '--profile', profileFile, '--out', existing]).status, 1);
    assert.equal(await readFile(join(existing, 'analysis.json'), 'utf8'), previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});
