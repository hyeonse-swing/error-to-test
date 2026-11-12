import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors, analyzeWithBaseline, refineBundle } from '../src/index.ts';
import { jsonText, readVerifiedBundle, verifyBundle, writeBundle } from '../src/artifacts.ts';
import { hash } from '../src/validation.ts';

const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, extra: Record<string, unknown> = {}) => ({
  id, message, project: 'demo', environment: 'test', release: 'r1', runtime: 'browser', type: 'manual', page: '/items', ...extra,
});
const steps = [
  { type: 'open', path: '/items' },
  { type: 'act', instruction: 'Load items.' },
  { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true },
];
const scenario = (id: string, match: Record<string, unknown> = { type: 'manual' }, extra: Record<string, unknown> = {}) => ({
  id, title: 'Review items', match, requirement: 'Items appear.', expectedSource: 'demo spec',
  preconditions: ['Use the local demo.'], setupConfirmed: true, questions: [], steps, ...extra,
});
const profile = (...scenarios: Record<string, unknown>[]) => JSON.stringify({
  schemaVersion: 'error-to-test/profile-1', name: 'review', scenarios,
});

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'error-to-test-refine-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function rewriteAnalysis(directory: string, edit: (analysis: Record<string, any>, provenance: Record<string, any>) => void): Promise<void> {
  const analysisPath = join(directory, 'analysis.json');
  const provenancePath = join(directory, 'provenance.json');
  const analysis = JSON.parse(await readFile(analysisPath, 'utf8'));
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  edit(analysis, provenance);
  const text = jsonText(analysis);
  provenance.analysisSha256 = hash(text);
  await writeFile(analysisPath, text);
  await writeFile(provenancePath, jsonText(provenance));
}

test('refines a reviewed source into a new unreviewed draft and preserves exact input/profile bytes', async () => {
  await inTemp(async root => {
    const input = `\uFEFF${manual(item('one', 'Failure'))}`;
    const oldProfile = `\uFEFF${profile(scenario('old', { type: 'manual' }, { setupConfirmed: false }))}`;
    const source = join(root, 'source');
    await writeBundle(source, analyzeErrors(input, { profile: oldProfile }), { reviewed: true });
    const sourceText = await readFile(join(source, 'analysis.json'), 'utf8');
    const sourceBundle = await readVerifiedBundle(source);
    const nextProfile = `\uFEFF${profile(scenario('new'))}`;
    const refined = await refineBundle(source, nextProfile);
    assert.equal(refined.candidates.length, 1);
    assert.equal(refined.candidates[0]?.state, 'draft');
    assert.equal(refined.candidates[0]?.ruleId, 'new');
    assert.equal(refined.source.sha256, hash(input));
    assert.equal(refined.source.profileSha256, hash(nextProfile));
    assert.notEqual(refined.source.profileSha256, hash(nextProfile.slice(1)));
    assert.deepEqual(refined.refinement, {
      sourceAnalysisSha256: sourceBundle.provenance.analysisSha256,
      sourceSuiteSha256: sourceBundle.provenance.suiteSha256,
      sourceProfileSha256: hash(oldProfile),
      selectedGroupIds: [refined.groups[0]!.id],
    });
    const output = join(root, 'refined');
    await writeBundle(output, refined);
    assert.deepEqual(await verifyBundle(output, { input, profile: nextProfile }), { suite: true, reviewed: false, sourceChecked: true });
    await assert.rejects(verifyBundle(output, { input: input.slice(1), profile: nextProfile }), /Input changed/);
    await assert.rejects(verifyBundle(output, { input, profile: nextProfile.slice(1) }), /Profile changed/);
    assert.equal(await readFile(join(source, 'analysis.json'), 'utf8'), sourceText);
    assert.deepEqual(await verifyBundle(source, { input, profile: oldProfile }), { suite: true, reviewed: true, sourceChecked: true });
    const detached = JSON.stringify(refined);
    await writeFile(join(source, 'analysis.json'), 'changed');
    assert.equal(JSON.stringify(refined), detached);
  });
});

test('retains baseline, explicit group, min-count and top scope while expanding selected rules', async () => {
  await inTemp(async root => {
    const baseline = join(root, 'baseline');
    await writeBundle(baseline, analyzeErrors(manual(item('old', 'Known'))));
    const input = [
      manual(item('k1', 'Known'), item('k2', 'Known'), item('a1', 'New A'), item('a2', 'New A')),
      manual(item('b1', 'New B'), item('b2', 'New B'), item('c1', 'Tiny')),
    ];
    const all = analyzeErrors(input);
    const known = all.groups.find(group => group.message === 'Known')!.id;
    const a = all.groups.find(group => group.message === 'New A')!.id;
    const b = all.groups.find(group => group.message === 'New B')!.id;
    const sourceAnalysis = await analyzeWithBaseline(input, baseline, { groupIds: [known, a, b], minCount: 2, top: 1 });
    assert.equal(sourceAnalysis.candidates.length, 1);
    const source = join(root, 'source');
    await writeBundle(source, sourceAnalysis);
    const newProfile = profile(scenario('first'), scenario('second'));
    const refined = await refineBundle(source, newProfile);
    const chosen = sourceAnalysis.candidates[0]!.groupId;
    assert.deepEqual(refined.candidates.map(candidate => candidate.groupId), [chosen, chosen]);
    assert.deepEqual(refined.candidates.map(candidate => candidate.ruleId), ['first', 'second']);
    assert.deepEqual(refined.refinement?.selectedGroupIds, [chosen]);
    assert.deepEqual(refined.groups, sourceAnalysis.groups);
    assert.deepEqual(refined.coverage, sourceAnalysis.coverage);
    assert.deepEqual(refined.selection, sourceAnalysis.selection);
    assert.deepEqual(refined.groupFilter, sourceAnalysis.groupFilter);
    assert.equal(refined.source.sha256, sourceAnalysis.source.sha256);
    assert.deepEqual(refined.source.inputs, sourceAnalysis.source.inputs);
    assert.equal(Object.hasOwn(refined.refinement!, 'sourceProfileSha256'), false);
    assert.ok(refined.groups.some(group => group.id === known));
    assert.ok(refined.groups.some(group => group.id === chosen));
    assert.notEqual(chosen, known);
    const output = join(root, 'refined');
    await writeBundle(output, refined);
    assert.deepEqual(await verifyBundle(output, { input, profile: newProfile }), { suite: true, reviewed: false, sourceChecked: true });
  });
});

test('selects distinct old candidate groups in retained rank order regardless of candidate order', async () => {
  await inTemp(async root => {
    const input = manual(item('a1', 'Frequent'), item('a2', 'Frequent'), item('b', 'Other'));
    const original = analyzeErrors(input);
    original.candidates.reverse();
    const source = join(root, 'source');
    await writeBundle(source, original);
    const refined = await refineBundle(source, profile(scenario('first'), scenario('second')));
    assert.deepEqual(refined.refinement?.selectedGroupIds, original.groups.map(group => group.id));
    assert.deepEqual(refined.candidates.map(candidate => candidate.groupId),
      original.groups.flatMap(group => [group.id, group.id]));
  });
});

test('keeps full-source questions/conflicts beyond the five sampled events and unknown runtime gate', async () => {
  await inTemp(async root => {
    const clean = Array.from({ length: 5 }, (_, index) => item(`a${index}`, 'Same failure', {
      runtime: 'unknown', expected: 'It works.', expectedSource: 'reporter', steps,
    }));
    const older = item('z', 'Same failure', {
      runtime: 'unknown', expected: 'It fails differently.', expectedSource: 'reporter', steps: [],
      questions: ['Older report asks about setup.'],
    });
    const source = join(root, 'source');
    await writeBundle(source, analyzeErrors(manual(...clean, older)));
    const matched = await refineBundle(source, profile(scenario('matched')));
    assert.equal(matched.groups[0]?.evidence.length, 5);
    assert.ok(matched.groups[0]?.evidence.every(event => event.id !== 'z'));
    assert.equal(matched.candidates[0]?.state, 'needs-context');
    assert.ok(matched.candidates[0]?.questions.includes('Older report asks about setup.'));
    assert.ok(matched.candidates[0]?.questions.some(question => question.includes('Conflicting expected')));
    assert.ok(matched.candidates[0]?.questions.some(question => question.includes('actual test engine')));
    const fallback = await refineBundle(source, profile(scenario('unmatched', { messageIncludes: 'elsewhere' })));
    assert.equal(fallback.candidates[0]?.ruleId, undefined);
    assert.equal(fallback.candidates[0]?.expected, undefined);
    assert.deepEqual(fallback.candidates[0]?.steps, []);
    assert.ok(fallback.candidates[0]?.questions.includes('Older report asks about setup.'));
  });
});

test('rejects missing context and malformed rehashed snapshot fields without mutating the source', async () => {
  await inTemp(async root => {
    const input = manual(item('one', 'Failure'));
    for (const [name, change, expected] of [
      ['missing-context', (a: Record<string, any>) => { delete a.groups[0].context; }, /Reanalyze the original input/],
      ['missing-questions', (a: Record<string, any>) => { delete a.groups[0].context.questions; }, /Reanalyze the original input/],
      ['bad-evidence', (a: Record<string, any>) => { a.groups[0].evidence[0].network = { method: 12, url: '/items' }; }, /network.method/],
      ['missing-group', (a: Record<string, any>) => { a.groups = []; }, /selected candidate group/],
      ['duplicate-group', (a: Record<string, any>) => { a.groups.push(structuredClone(a.groups[0])); }, /groups\[1\].id/],
      ['bad-mapping-event-ids', (a: Record<string, any>, p: Record<string, any>) => {
        a.candidates[0].eventIds = [12]; p.mappings[0].eventIds = [12];
      }, /candidates\[0\].eventIds/],
      ['duplicate-mapping', (a: Record<string, any>, p: Record<string, any>) => {
        a.candidates.push(structuredClone(a.candidates[0])); p.mappings.push(structuredClone(p.mappings[0]));
      }, /candidates\[1\].id/],
    ] as const) {
      const source = join(root, name);
      await writeBundle(source, analyzeErrors(input));
      await rewriteAnalysis(source, change);
      assert.equal((await readVerifiedBundle(source)).verification.suite, true);
      const before = await readFile(join(source, 'analysis.json'), 'utf8');
      await assert.rejects(refineBundle(source, profile(scenario('review'))), expected);
      assert.equal(await readFile(join(source, 'analysis.json'), 'utf8'), before);
    }
  });
});

test('enforces JSON-text profile size, BOM, sensitive IDs, safe steps and case export limits', async () => {
  await inTemp(async root => {
    const source = join(root, 'source');
    await writeBundle(source, analyzeErrors(manual(item('one', 'Failure'), item('two', 'Other failure'))));
    await assert.rejects(refineBundle(source, {} as string), /JSON text/);
    await assert.rejects(refineBundle(source, '\uFEFF\uFEFF' + profile(scenario('rule'))), /not valid JSON/);
    await assert.rejects(refineBundle(source, ' '.repeat(1024 * 1024 + 1)), /1 MiB/);
    await assert.rejects(refineBundle(source, profile(scenario('ghp_abcdefghijklmnop'))), /sensitive scenario IDs/);
    await assert.rejects(refineBundle(source, profile(scenario('rule', { groupId: 'ghp_abcdefghijklmnop' }))), /sensitive scenario IDs/);
    await assert.rejects(refineBundle(source, profile(scenario('rule', { type: 'manual' }, { title: 'token=private123' }))), /sensitive data/);
    const unsafe = await refineBundle(source, profile(scenario('unsafe', { type: 'manual' }, {
      steps: [{ type: 'open', path: '/items' }, { type: 'fill', locator: { by: 'label', value: 'Password' }, value: 'private-value' }],
    })));
    assert.ok(unsafe.candidates.every(candidate => candidate.state === 'needs-context' && candidate.steps.length === 0));
    assert.doesNotMatch(JSON.stringify(unsafe.candidates), /private-value/);
    const tooMany = profile(...Array.from({ length: 100 }, (_, index) => scenario(`rule-${index}`)));
    await assert.rejects(refineBundle(source, tooMany), /at most 100 cases/);
  });
});

test('accepts more than 1000 accumulated context questions and keeps only the latest refinement lineage', async () => {
  await inTemp(async root => {
    const errors = Array.from({ length: 11 }, (_, report) => item(`report-${report}`, 'One failure', {
      questions: Array.from({ length: 100 }, (_, question) => `q${report}-${question}`),
    }));
    const input = manual(...errors);
    const source = join(root, 'source');
    await writeBundle(source, analyzeErrors(input));
    const first = await refineBundle(source, profile(scenario('first')));
    assert.ok(first.candidates[0]!.questions.length > 1000);
    const intermediate = join(root, 'intermediate');
    await writeBundle(intermediate, first);
    const intermediateBundle = await readVerifiedBundle(intermediate);
    const second = await refineBundle(intermediate, profile(scenario('second')));
    assert.ok(second.candidates[0]!.questions.length > 1000);
    assert.equal(second.warnings.filter(warning => warning.startsWith('Refinement:')).length, 1);
    assert.equal(second.refinement?.sourceAnalysisSha256, intermediateBundle.provenance.analysisSha256);
    assert.equal(second.refinement?.sourceProfileSha256, hash(profile(scenario('first'))));
    assert.equal(Object.hasOwn(second.refinement!, 'refinement'), false);
    assert.equal(second.candidates[0]?.ruleId, 'second');
  });
});

test('stale source bundle fails before returning candidates', async () => {
  await inTemp(async root => {
    const source = join(root, 'source');
    await writeBundle(source, analyzeErrors(manual(item('one', 'Failure'))));
    await writeFile(join(source, 'report.md'), 'changed');
    await assert.rejects(refineBundle(source, profile(scenario('review'))), /STALE_BUNDLE/);
  });
});
