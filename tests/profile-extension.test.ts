import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeErrors } from '../src/analysis.ts';
import { createCandidates, parseProfile } from '../src/candidates.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';
import { createProfileTemplate } from '../src/index.ts';
import type { Analysis, AppProfile, ScenarioRule, WebStep } from '../src/types.ts';

const steps: WebStep[] = [
  { type: 'open', path: '/items' },
  { type: 'act', instruction: 'Submit the form' },
  { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true },
];

function rule(id: string, match: ScenarioRule['match'], changes: Partial<ScenarioRule> = {}): ScenarioRule {
  return {
    id, title: `Reviewed ${id}`, match, requirement: 'Success appears', expectedSource: 'Approved specification',
    preconditions: ['Signed in'], setupConfirmed: true, questions: [], steps, ...changes,
  };
}

function profile(...scenarios: ScenarioRule[]): AppProfile {
  return { schemaVersion: 'error-to-test/profile-1', name: 'Saved team profile', scenarios };
}

function analysis(): Analysis {
  const events = ['A failed', 'B failed', 'C failed'].map((message, index) => ({
    schemaVersion: 1, eventId: `event-${index}`, project: 'demo', environment: 'stage', release: 'r1', sdkVersion: '0.1.5',
    occurredAt: `2026-10-13T01:00:0${index}Z`, viewId: `view-${index}`, sequence: 1, elapsedMs: 100,
    type: 'javascript', message, page: '/items', runtime: 'browser',
  }));
  return analyzeErrors(JSON.stringify({ schemaVersion: 1, events }));
}

function oneSelected(source: Analysis, message: string): Analysis {
  const group = source.groups.find((item) => item.message === message)!;
  return { ...source, candidates: [source.candidates.find((item) => item.groupId === group.id)!] };
}

test('existing rules retain parsed values and order without mutating inputs; covered pending rules stay blocked', () => {
  const source = oneSelected(analysis(), 'A failed');
  const group = source.groups.find((item) => item.message === 'A failed')!;
  const existing = profile(
    rule('unrelated', { groupId: 'other' }),
    rule('pending', { groupId: group.id }, { setupConfirmed: false, questions: ['Confirm setup'] }),
  );
  const sourceBefore = structuredClone(source);
  const existingBefore = structuredClone(existing);
  const extended = createProfileTemplate(source, { profile: existing });
  assert.deepEqual(extended, parseProfile(existing));
  assert.notStrictEqual(extended, existing);
  assert.notStrictEqual(extended.scenarios[1], existing.scenarios[1]);
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(existing, existingBefore);
  const [candidate] = createCandidates([group], parseProfile(extended));
  assert.equal(candidate?.ruleId, 'pending');
  assert.equal(candidate?.state, 'needs-context');
  const exported = exportFlowQa({ ...source, candidates: [candidate!] }, { reviewed: true });
  assert.ok(exported.suite?.cases[0]?.questions.includes('Confirm setup'));
});

test('coverage uses every AND predicate and multiple matching rules add no duplicate template', () => {
  const source = analysis();
  const a = source.groups.find((item) => item.message === 'A failed')!;
  const b = source.groups.find((item) => item.message === 'B failed')!;
  const c = source.groups.find((item) => item.message === 'C failed')!;
  a.evidence[0]!.network = { method: 'GET', url: 'https://example.com/api/a', status: 500 };
  b.release = 'r2';
  c.evidence[0]!.network = { method: 'GET', url: 'https://example.com/api/c', status: 500 };
  const existing = profile(
    rule('and-rule', { type: 'javascript', environment: 'stage', release: 'r1', runtime: 'browser', networkPath: '/api/a' }),
    rule('also-a', { messageIncludes: 'A failed', pagePath: '/items', release: 'r1' }),
  );
  const matched = createCandidates([a, b, c], parseProfile(existing));
  assert.deepEqual(matched.filter((item) => item.groupId === a.id).map((item) => item.ruleId), ['also-a', 'and-rule']);
  assert.ok(matched.filter((item) => item.groupId !== a.id).every((item) => item.ruleId === undefined));
  const extended = createProfileTemplate(source, { profile: existing });
  assert.deepEqual(extended.scenarios.slice(0, 2), parseProfile(existing).scenarios);
  assert.deepEqual(extended.scenarios.slice(2).map((item) => item.match),
    source.groups.filter((item) => item.id === b.id || item.id === c.id).map((item) => ({ groupId: item.id })));
});

test('exact group ID with a different release does not cover; another actual rule can cover it', () => {
  const source = oneSelected(analysis(), 'A failed');
  const group = source.groups.find((item) => item.message === 'A failed')!;
  const stale = rule('stale-release', { groupId: group.id, release: 'r0' });
  assert.equal(createCandidates([group], parseProfile(profile(stale)))[0]?.ruleId, undefined);
  const uncovered = createProfileTemplate(source, { profile: profile(stale) });
  assert.equal(uncovered.scenarios.length, 2);
  assert.deepEqual(uncovered.scenarios[1]?.match, { groupId: group.id });
  const covered = createProfileTemplate(source, { profile: profile(stale, rule('current-release', { release: 'r1', type: 'javascript' })) });
  assert.deepEqual(covered, parseProfile(profile(stale, rule('current-release', { release: 'r1', type: 'javascript' }))));
});

test('new ID collisions use deterministic suffixes without renaming unrelated rules', () => {
  const source = oneSelected(analysis(), 'A failed');
  const group = source.groups.find((item) => item.message === 'A failed')!;
  group.id = 'a'.repeat(73);
  source.candidates[0]!.groupId = group.id;
  const base = `review-${group.id}`;
  const existing = profile(rule(base, { groupId: 'other' }), rule(`${base.slice(0, 78)}-2`, { groupId: 'another' }));
  const first = createProfileTemplate(source, { profile: existing });
  const second = createProfileTemplate(source, { profile: existing });
  assert.deepEqual(first, second);
  assert.deepEqual(first.scenarios.slice(0, 2).map((item) => item.id), existing.scenarios.map((item) => item.id));
  assert.equal(first.scenarios[2]?.id, `${base.slice(0, 78)}-3`);
  assert.equal(first.scenarios[2]?.id.length, 80);
});

test('new scenarios carry only safe observed navigation and remain blocked until manually completed', () => {
  const source = oneSelected(analysis(), 'B failed');
  const group = source.groups.find((item) => item.message === 'B failed')!;
  group.context = { expected: 'Copied expectation', expectedSource: 'reporter', steps, questions: [], conflicts: [] };
  const extended = createProfileTemplate(source, { profile: profile(rule('unrelated', { groupId: 'other' })) });
  const blank = extended.scenarios[1]!;
  assert.deepEqual(blank.match, { groupId: group.id });
  assert.equal(blank.requirement, '');
  assert.equal(blank.expectedSource, '');
  assert.equal(blank.setupConfirmed, false);
  assert.deepEqual(blank.preconditions, []);
  assert.deepEqual(blank.questions, ['Confirm the expected behavior, setup, reproduction steps, and assertion, then remove this question.']);
  assert.deepEqual(blank.steps, [{ type: 'open', path: '/items' }]);
  assert.throws(() => parseProfile(extended), /requirement.*non-empty/);
  const completed = parseProfile({ ...extended, scenarios: [extended.scenarios[0], {
    ...blank, requirement: 'Approved success', expectedSource: 'Approved specification', setupConfirmed: true,
    preconditions: ['Signed in'], questions: [], steps,
  }] });
  const [candidate] = createCandidates([group], completed);
  assert.equal(candidate?.state, 'draft');
  assert.deepEqual(exportFlowQa({ ...source, candidates: [candidate!] }, { reviewed: true }).suite?.cases[0]?.questions, []);
});

test('invalid JSON, oversized input, sensitive metadata, IDs and steps refuse extension without echoing values', () => {
  const source = oneSelected(analysis(), 'A failed');
  const valid = profile(rule('safe', { type: 'javascript' }));
  assert.deepEqual(createProfileTemplate(source, { profile: `\uFEFF${JSON.stringify(valid)}` }), parseProfile(valid));
  assert.throws(() => createProfileTemplate(source, { profile: `\uFEFF\uFEFF${JSON.stringify(valid)}` }), /not valid JSON/);
  assert.throws(() => createProfileTemplate(source, { profile: '{private123' }), (error: unknown) => {
    assert.doesNotMatch(String(error), /private123/);
    return /not valid JSON/.test(String(error));
  });
  assert.throws(() => createProfileTemplate(source, { profile: `${JSON.stringify(valid)}${' '.repeat(1024 * 1024)}` }), /1 MiB/);
  assert.throws(() => createProfileTemplate(source, { profile: { ...valid, padding: 'x'.repeat(1024 * 1024) } }), /1 MiB/);
  const cycle: Record<string, unknown> = { ...valid };
  cycle.self = cycle;
  for (const invalid of [cycle, { ...valid, extra: undefined }, { ...valid, extra: Number.NaN }, { ...valid, extra: 1n }, { ...valid, extra: new Date() }]) {
    assert.throws(() => createProfileTemplate(source, { profile: invalid }), /only JSON values/);
  }
  assert.throws(() => createProfileTemplate(source, { profile: profile(rule('unsafe', { type: 'javascript' }, { title: 'access_token=private123' })) }), /sensitive data/);
  const credentialId = ['ghp', 'abcdefghijklmnop'].join('_');
  for (const unsafe of [
    profile(rule(credentialId, { type: 'javascript' }, { title: 'Reviewed scenario' })),
    profile(rule('safe', { groupId: credentialId })),
  ]) {
    assert.doesNotThrow(() => parseProfile(unsafe));
    assert.throws(() => createProfileTemplate(source, { profile: unsafe }), (error: unknown) => {
      assert.doesNotMatch(String(error), /abcdefghijklmnop/);
      return /sensitive scenario IDs/.test(String(error));
    });
  }
  for (const unsafeSteps of [
    [{ type: 'open', path: '/items' }, { type: 'fill', locator: { by: 'label', value: 'Password' }, value: 'private123' }],
    [{ type: 'open', path: '/items?access_token=private123' }],
  ]) {
    assert.throws(() => createProfileTemplate(source, { profile: profile(rule('unsafe', { type: 'javascript' }, { steps: unsafeSteps as WebStep[] })) }), (error: unknown) => {
      assert.doesNotMatch(String(error), /private123/);
      return /sensitive execution steps/.test(String(error));
    });
  }
});

test('combined scenario count and pretty serialized output are bounded; default mode stays legacy', () => {
  const source = oneSelected(analysis(), 'A failed');
  const group = source.groups.find((item) => item.message === 'A failed')!;
  const legacy = createProfileTemplate(source);
  assert.deepEqual(createProfileTemplate(source, {}), legacy);
  assert.equal(legacy.scenarios[0]?.id, `review-${group.id}`);
  const hundred = profile(...Array.from({ length: 100 }, (_, index) => rule(`old-${index}`, { groupId: `other-${index}` })));
  assert.throws(() => createProfileTemplate(source, { profile: hundred }), /at most 100 scenarios/);
  hundred.scenarios[0] = rule('covered', { groupId: group.id });
  assert.equal(createProfileTemplate(source, { profile: hundred }).scenarios.length, 100);
  const longSteps: WebStep[] = Array.from({ length: 100 }, () => ({ type: 'act', instruction: 'x' }));
  const large = profile(...Array.from({ length: 100 }, (_, index) => rule(`large-${index}`, { type: 'javascript' }, {
    title: 'x'.repeat(5_000), steps: longSteps,
  })));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 1024 * 1024);
  assert.ok(Buffer.byteLength(`${JSON.stringify(large, null, 2)}\n`) > 1024 * 1024);
  assert.throws(() => createProfileTemplate(source, { profile: large }), /generated profile exceeds 1 MiB/);
});
