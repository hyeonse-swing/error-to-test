import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeErrors } from '../src/analysis.ts';
import { createCandidates, parseProfile } from '../src/candidates.ts';
import { createProfileTemplate } from '../src/profile-template.ts';
import type { Analysis } from '../src/types.ts';

const event = (id: string, message: string, page = '/items') => ({
  schemaVersion: 1, eventId: id, project: 'demo', environment: 'stage', release: 'r1', sdkVersion: '0.1.5',
  occurredAt: '2026-10-13T01:00:00Z', viewId: id, sequence: 1, elapsedMs: 100,
  type: 'javascript', message, page, runtime: 'browser',
});
const input = (...events: ReturnType<typeof event>[]) => JSON.stringify({ schemaVersion: 1, events });
const baseline = () => analyzeErrors(input(event('a', 'A failed'), event('b', 'B failed')));

test('template follows selected candidates and ranked groups, deduplicating multiple candidates per group', () => {
  const analysis = analyzeErrors(input(event('a1', 'A failed'), event('a2', 'A failed'), event('b', 'B failed')), { minCount: 2, top: 1 });
  const before = structuredClone(analysis);
  analysis.candidates.push({ ...analysis.candidates[0]!, id: 'another-candidate' });
  const template = createProfileTemplate(analysis);
  assert.equal(template.name, 'Error to Test review');
  assert.equal(template.schemaVersion, 'error-to-test/profile-1');
  assert.deepEqual(template.scenarios.map((scenario) => scenario.match.groupId), [analysis.candidates[0]?.groupId]);
  assert.equal(template.scenarios[0]?.id, `review-${analysis.candidates[0]?.groupId}`);
  assert.deepEqual(analysis.candidates.slice(0, 1), before.candidates);
  assert.deepEqual(createProfileTemplate(analysis), template);
  assert.deepEqual(template.scenarios[0]?.steps, [{ type: 'open', path: '/items' }]);
  assert.equal(template.scenarios[0]?.requirement, '');
  assert.equal(template.scenarios[0]?.expectedSource, '');
  assert.deepEqual(template.scenarios[0]?.preconditions, []);
  assert.equal(template.scenarios[0]?.setupConfirmed, false);
  assert.throws(() => parseProfile(template), /requirement.*non-empty/);
});

test('more than 100 retained groups are allowed when only one is selected', () => {
  const events = Array.from({ length: 101 }, (_, index) => event(`event-${index}`, `Failure ${index}`));
  const analysis = analyzeErrors(input(...events), { top: 1 });
  assert.equal(analysis.groups.length, 101);
  assert.equal(analysis.candidates.length, 1);
  const template = createProfileTemplate(analysis);
  assert.deepEqual(template.scenarios.map((scenario) => scenario.match.groupId), [analysis.candidates[0]?.groupId]);
});

test('template does not mutate input and omits unsafe or missing paths', () => {
  const analysis = baseline();
  const original = structuredClone(analysis);
  for (const path of ['', '//outside.example/path', 'https://outside.example/path', '/bad\npath', '/bad\\path', '/items/[redacted-token]']) {
    const changed = structuredClone(analysis);
    changed.groups[0]!.pagePath = path;
    changed.groups[0]!.evidence[0]!.page = undefined;
    assert.deepEqual(createProfileTemplate(changed).scenarios[0]?.steps, [], path);
  }
  const withQuery = structuredClone(analysis);
  withQuery.groups[0]!.pagePath = '/items?access_token=private123#details';
  assert.deepEqual(createProfileTemplate(withQuery).scenarios[0]?.steps, [{ type: 'open', path: '/items' }]);
  assert.deepEqual(analysis, original);
});

test('template redacts observed message and path without copying execution context', () => {
  const analysis = baseline();
  const group = analysis.groups[0]!;
  group.message = `access_token=private123 ${'x'.repeat(300)}`;
  group.pagePath = '/items/access_token=private123?session_id=private456';
  group.evidence[0]!.page = '/items/access_token=private123';
  group.context = { expected: 'Invented expectation', expectedSource: 'reporter', steps: [{ type: 'act', instruction: 'Click buy' }], questions: [], conflicts: [] };
  const rule = createProfileTemplate({ ...analysis, candidates: [analysis.candidates[0]!] }).scenarios[0]!;
  assert.ok(rule.title.length <= 200);
  assert.doesNotMatch(JSON.stringify(rule), /private123|private456|Invented expectation|Click buy/);
  assert.deepEqual(rule.steps, []);
  assert.deepEqual(rule.questions, ['Confirm the expected behavior, setup, reproduction steps, and assertion, then remove this question.']);
});

test('empty, malformed, missing, duplicate, and oversized selections reject', () => {
  const analysis = baseline();
  assert.throws(() => createProfileTemplate({ ...analysis, candidates: [] }), /selected candidates/);
  assert.throws(() => createProfileTemplate({ ...analysis, candidates: [{ ...analysis.candidates[0]!, groupId: 'missing' }] }), /missing group ID/);
  assert.throws(() => createProfileTemplate({ ...analysis, candidates: [{ ...analysis.candidates[0]!, groupId: 'bad/id' }] }), /compatible ID/);
  assert.throws(() => createProfileTemplate({ ...analysis, groups: [analysis.groups[0]!, analysis.groups[0]!] }), /duplicated/);
  const groups = Array.from({ length: 101 }, (_, index) => ({ ...analysis.groups[0]!, id: `group-${index}` }));
  const candidates = groups.map((group, index) => ({ ...analysis.candidates[0]!, id: `candidate-${index}`, groupId: group.id }));
  assert.throws(() => createProfileTemplate({ ...analysis, groups, candidates }), /at most 100/);
  assert.throws(() => createProfileTemplate({ ...analysis, groups: Array.from({ length: 10001 }, () => analysis.groups[0]!) }), /at most 10000/);
  assert.throws(() => createProfileTemplate(null as unknown as Analysis), /must be an object/);
});

test('explicitly reviewed template can draft only after its blocking gates are satisfied', () => {
  const analysis = baseline();
  const rule = createProfileTemplate({ ...analysis, candidates: [analysis.candidates[0]!] }).scenarios[0]!;
  const group = analysis.groups.find((item) => item.id === rule.match.groupId)!;
  const complete = {
    ...rule, requirement: 'Success appears', expectedSource: 'approved spec',
    preconditions: ['Signed in'], setupConfirmed: true, questions: [],
    steps: [...rule.steps, { type: 'act', instruction: 'Submit the form' }, { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true }],
  };
  const make = (scenario: typeof complete, selectedGroup = group) => createCandidates([selectedGroup], parseProfile({
    schemaVersion: 'error-to-test/profile-1', name: 'Review', scenarios: [scenario],
  }))[0]!;
  assert.equal(make({ ...complete, setupConfirmed: false }).state, 'needs-context');
  assert.equal(make({ ...complete, questions: ['Check expected behavior'] }).state, 'needs-context');
  assert.equal(make({ ...complete, steps: rule.steps }).state, 'needs-context');
  assert.equal(make(complete, { ...group, runtime: 'webview-ios' }).state, 'needs-context');
  assert.equal(make(complete, { ...group, context: { questions: [], conflicts: ['Expected behavior differs'] } }).state, 'needs-context');
  assert.equal(make(complete).state, 'draft');
});
