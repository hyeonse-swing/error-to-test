import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors, analyzeWithBaseline } from '../src/index.ts';
import { readVerifiedBundle, renderReport, verifyBundle, writeBundle } from '../src/artifacts.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';
import { hash } from '../src/validation.ts';
import type { Analysis } from '../src/types.ts';

const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, release = 'r1', extra: Record<string, unknown> = {}) =>
  ({ id, message, release, project: 'demo', environment: 'test', runtime: 'browser', type: 'javascript', page: '/items', ...extra });
const repeated = (message: string, count: number, release = 'r1') =>
  Array.from({ length: count }, (_, index) => item(`${message}-${release}-${index}`, message, release));

async function withBaseline(baseline: Analysis, run: (directory: string, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'baseline-analysis-'));
  const directory = join(root, 'baseline');
  try { await writeBundle(directory, baseline); await run(directory, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('selects only current signatures before minCount and top while retaining groups, hashes, and verified report', async () => {
  const baseline = analyzeErrors(manual(...repeated('Shared', 3), item('hidden', 'Hidden')), { top: 1 });
  assert.equal(baseline.groups.length, 2);
  assert.equal(baseline.candidates.length, 1); // Hidden is still present in the baseline snapshot.
  const input = manual(...repeated('Shared', 4, 'r2'), item('hidden-r2', 'Hidden', 'r2'),
    ...repeated('New', 2, 'r2'), item('tiny', 'Tiny', 'r2'));
  await withBaseline(baseline, async (directory, root) => {
    const verified = await readVerifiedBundle(directory);
    const analysis = await analyzeWithBaseline(input, directory, { top: 1, minCount: 2 });
    assert.equal(analysis.groups.length, 4);
    assert.equal(analysis.coverage.inputCount, 8);
    assert.equal(analysis.source.sha256, hash(input));
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0]?.groupId, analysis.groups.find(group => group.message === 'New')?.id);
    assert.deepEqual(analysis.selection, {
      mode: 'only-current',
      baseline: { inputSha256: baseline.source.sha256,
        analysisSha256: verified.provenance.analysisSha256, coverage: baseline.coverage },
      onlyCurrentGroupCount: 2,
      excludedGroupCount: 2,
    });
    assert.match(analysis.warnings.join('\n'), /1 of 2 groups are eligible/);
    assert.match(analysis.warnings.join('\n'), /does not establish introduction, regression, or resolution/);
    assert.equal(Object.hasOwn(analyzeErrors(input), 'selection'), false);

    const report = renderReport(analysis);
    assert.match(report, /Baseline candidate selection/);
    assert.match(report, /Only-current groups before min-count\/top: 2/);
    assert.match(report, /Groups excluded as already observed: 2/);
    const current = join(root, 'current');
    await writeBundle(current, analysis);
    const analysisText = await readFile(join(current, 'analysis.json'), 'utf8');
    const provenance = JSON.parse(await readFile(join(current, 'provenance.json'), 'utf8'));
    assert.equal(provenance.analysisSha256, hash(analysisText));
    assert.equal(JSON.parse(analysisText).selection.baseline.analysisSha256, verified.provenance.analysisSha256);
    assert.deepEqual(await verifyBundle(current, { input }), { suite: true, reviewed: false, sourceChecked: true });
  });
});

test('top ranks eligible only-current groups and does not let an existing frequent group crowd them out', async () => {
  const baseline = analyzeErrors(manual(...repeated('Existing', 5)));
  const input = manual(...repeated('Existing', 7, 'r2'), ...repeated('New A', 2, 'r2'), ...repeated('New B', 2, 'r2'));
  await withBaseline(baseline, async directory => {
    const analysis = await analyzeWithBaseline(input, directory, { top: 1, minCount: 2 });
    assert.equal(analysis.selection?.onlyCurrentGroupCount, 2);
    assert.equal(analysis.selection?.excludedGroupCount, 1);
    assert.equal(analysis.candidates.length, 1);
    assert.ok(['New A', 'New B'].includes(analysis.groups.find(group => group.id === analysis.candidates[0]?.groupId)?.message ?? ''));
    assert.match(analysis.warnings.join('\n'), /first 1 of 2 eligible ranked groups/);
    assert.doesNotMatch(analysis.warnings.join('\n'), /first 1 of 3 ranked groups/);
  });
});

test('selection counts each release group and applies minCount to each release separately', async () => {
  const baseline = analyzeErrors(manual(item('old', 'Old')));
  const input = manual(...repeated('New', 2, 'r2'), item('new-r3', 'New', 'r3'));
  await withBaseline(baseline, async directory => {
    const analysis = await analyzeWithBaseline(input, directory, { minCount: 2 });
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.selection?.onlyCurrentGroupCount, 2);
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.groups.find(group => group.id === analysis.candidates[0]?.groupId)?.release, 'r2');
    assert.match(analysis.warnings.join('\n'), /1 of 2 groups are eligible/);
  });
});

test('comparison identity excludes release but distinguishes project, environment, runtime, page, type, and stack', async () => {
  const stack = '    at base (/app.js:1:1)';
  const baseline = analyzeErrors(manual(item('base', 'Failure', 'r1', { stack })));
  const input = manual(
    item('same', 'Failure', 'r2', { stack }),
    item('project', 'Failure', 'r2', { stack, project: 'other' }),
    item('environment', 'Failure', 'r2', { stack, environment: 'stage' }),
    item('runtime', 'Failure', 'r2', { stack, runtime: 'webview-ios' }),
    item('page', 'Failure', 'r2', { stack, page: '/other' }),
    item('type', 'Failure', 'r2', { stack, type: 'promise' }),
    item('stack', 'Failure', 'r2', { stack: '    at other (/app.js:2:1)' }),
  );
  await withBaseline(baseline, async directory => {
    const analysis = await analyzeWithBaseline(input, directory);
    assert.equal(analysis.groups.length, 7);
    assert.equal(analysis.selection?.onlyCurrentGroupCount, 6);
    assert.equal(analysis.selection?.excludedGroupCount, 1);
    assert.equal(analysis.candidates.length, 6);
    assert.ok(!analysis.candidates.some(candidate => candidate.groupId === analysis.groups.find(group => group.eventIds.includes('same'))?.id));
  });
});

test('zero only-current groups create no suite, and repeated baselines keep warning counts bounded', async () => {
  const input = manual(item('first', 'Same'));
  await withBaseline(analyzeErrors(input), async (directory, root) => {
    let previous = directory;
    let warningCount: number | undefined;
    for (let index = 0; index < 15; index++) {
      const analysis = await analyzeWithBaseline(manual(item(`next-${index}`, 'Same', `r${index + 2}`)), previous);
      assert.equal(analysis.groups.length, 1);
      assert.equal(analysis.selection?.onlyCurrentGroupCount, 0);
      assert.equal(analysis.candidates.length, 0);
      assert.equal(exportFlowQa(analysis).suite, undefined);
      warningCount ??= analysis.warnings.length;
      assert.equal(analysis.warnings.length, warningCount);
      assert.ok(analysis.warnings.length < 100);
      assert.ok(!analysis.warnings.some(warning => warning.startsWith('Baseline:')));
      const next = join(root, `chain-${index}`);
      await writeBundle(next, analysis);
      previous = next;
    }
  });
});

test('preserves source coverage cautions, manual-kind warning, and frequency rejection', async () => {
  const browser = (partial: boolean) => JSON.stringify({ schemaVersion: 1, partial, events: [{
    schemaVersion: 1, eventId: 'event-1', project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1',
    occurredAt: '2026-10-01T00:00:00Z', viewId: 'view-1', sequence: 1, elapsedMs: 1,
    type: 'javascript', message: 'Failure', page: '/items', runtime: 'browser',
  }] });
  await withBaseline(analyzeErrors(browser(true)), async directory => {
    const analysis = await analyzeWithBaseline(browser(false), directory, { project: 'none', from: '2026-09-01T00:00:00Z' });
    assert.equal(analysis.groups.length, 0);
    assert.equal(analysis.coverage.filtered, 1);
    assert.match(analysis.warnings.join(' '), /partial/);
    assert.match(analysis.warnings.join(' '), /period filters differ/);
    assert.match(analysis.warnings.join(' '), /record\(s\) excluded by filters/);
  });
  await withBaseline(analyzeErrors(browser(true), { project: 'none', from: '2026-09-01T00:00:00Z' }), async directory => {
    const analysis = await analyzeWithBaseline(browser(false), directory);
    assert.match(analysis.warnings.join(' '), /Baseline source coverage: 0 duplicate and 1 filtered supplied records/);
    assert.match(analysis.warnings.join(' '), /Baseline date filtering applies only to reports with observed timestamps/);
  });
  await withBaseline(analyzeErrors('Error: manual text'), async directory => {
    const analysis = await analyzeWithBaseline(manual(item('manual', 'Error: manual text')), directory);
    assert.match(analysis.warnings.join(' '), /Source kinds differ/);
    await assert.rejects(analyzeWithBaseline(browser(false), directory), /matching count frequency/);
  });
});

test('rejects tampered baseline and retains normalized slash and incomplete credential assignment identity', async () => {
  const baseline = analyzeErrors(manual(item('slash', 'Failure', 'r1', { page: '/foo//bar' }), item('token', `Error: token=`)));
  await withBaseline(baseline, async directory => {
    const input = manual(item('same-slash', 'Failure', 'r2', { page: '/foo//bar' }),
      item('same-token', `Error: token=`, 'r2'), item('different-token', 'Error: token=[redacted]', 'r2'));
    const analysis = await analyzeWithBaseline(input, directory);
    assert.equal(analysis.groups.find(group => group.eventIds.includes('same-slash'))?.pagePath, '/foo//bar');
    assert.equal(analysis.selection?.onlyCurrentGroupCount, 1);
    assert.equal(analysis.selection?.excludedGroupCount, 2);
    assert.equal(analysis.candidates[0]?.groupId, analysis.groups.find(group => group.eventIds.includes('different-token'))?.id);
    const path = join(directory, 'analysis.json');
    await writeFile(path, `${await readFile(path, 'utf8')} `);
    await assert.rejects(analyzeWithBaseline(input, directory), /STALE_BUNDLE/);
  });
});

test('profile hash and review blocking remain attached to only-current candidates', async () => {
  const baseline = analyzeErrors(manual(item('old', 'Old')));
  const input = manual(item('new', 'New'));
  const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'demo', scenarios: [{
    id: 'new-rule', title: 'New rule', match: { messageIncludes: 'New' }, requirement: 'Success appears',
    expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'],
    steps: [{ type: 'open', path: '/items' }, { type: 'assertVisible', locator: { by: 'text', value: 'Success' }, visible: true }],
  }] });
  await withBaseline(baseline, async directory => {
    const analysis = await analyzeWithBaseline(input, directory, { profile });
    assert.equal(analysis.source.profileSha256, hash(profile));
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0]?.ruleId, 'new-rule');
    assert.equal(analysis.candidates[0]?.state, 'draft');
    const unreviewed = exportFlowQa(analysis);
    assert.ok(unreviewed.suite?.cases[0]?.questions.some(question => /Review this draft case/.test(question)));
    const reviewed = exportFlowQa(analysis, { reviewed: true });
    assert.deepEqual(reviewed.suite?.cases[0]?.questions, []);
    assert.equal(reviewed.provenance.profileSha256, hash(profile));
  });
});
