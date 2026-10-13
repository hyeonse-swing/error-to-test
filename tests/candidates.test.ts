import assert from 'node:assert/strict';
import test from 'node:test';
import { createCandidates, parseProfile } from '../src/candidates.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';
import type { ErrorObservation, IssueGroup } from '../src/types.ts';

const action = { type: 'act', instruction: 'Submit the form.' } as const;
const assertion = { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true } as const;
const steps = [{ type: 'open', path: '/checkout' } as const, action, assertion];
const observation: ErrorObservation = {
  id: 'event-1', source: 'manual', project: 'shop', environment: 'stage', release: 'r1',
  type: 'manual', message: 'Checkout failed', runtime: 'browser', page: '/checkout',
  reproduction: ['Submit the checkout form'], preconditions: [], questions: [],
  expected: 'A success message appears', expectedSource: 'reporter', steps,
};
const group: IssueGroup = {
  id: 'group-1', fingerprintVersion: 1, project: 'shop', environment: 'stage', release: 'r1', runtime: 'browser',
  type: 'manual', pagePath: '/checkout', signature: 'checkout-failed', message: 'Checkout failed', count: 1,
  viewCount: 1, eventIds: ['event-1'], evidence: [observation],
};

test('manual evidence becomes draft only with shared steps, sourced expectation, and assertion', () => {
  const [candidate] = createCandidates([group]);
  assert.equal(candidate?.state, 'draft');
  assert.deepEqual(candidate?.steps, steps);
  assert.deepEqual(candidate?.expected, { text: 'A success message appears', source: 'reporter' });

  const missing = createCandidates([{ ...group, evidence: [{ ...observation, steps: [], expectedSource: undefined }] }])[0];
  assert.equal(missing?.state, 'needs-context');
  assert.match(missing!.questions.join(' '), /expected behavior|reproduction steps|assertion/i);
});

test('profile requires a match predicate and produces one stable candidate per matching rule', () => {
  assert.throws(() => parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{ id: 'a', title: 'A', match: {}, requirement: 'success', expectedSource: 'spec', steps }] }), /predicate/);
  const profile = parseProfile({
    schemaVersion: 'error-to-test/profile-1', name: 'shop',
    scenarios: [
      { id: 'b', title: 'Second', match: { pagePath: '/checkout' }, requirement: 'Second expectation', expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'], steps },
      { id: 'a', title: 'First', match: { type: 'manual' }, requirement: 'First expectation', expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'], steps },
    ],
  });
  const candidates = createCandidates([group], profile);
  assert.deepEqual(candidates.map((candidate) => candidate.ruleId), ['a', 'b']);
  assert.notEqual(candidates[0]?.id, candidates[1]?.id);
  assert.ok(candidates.every((candidate) => candidate.state === 'draft'));
});

test('webview evidence stays blocked and missing path is never invented', () => {
  const [candidate] = createCandidates([{ ...group, runtime: 'webview-ios', pagePath: '', evidence: [{ ...observation, runtime: 'webview-ios', steps: [action, assertion] }] }]);
  assert.equal(candidate?.state, 'needs-context');
  assert.ok(candidate?.questions.some((question) => question.includes('actual test engine')));
  assert.ok(candidate?.questions.some((question) => question.includes('explicit app path')));
  assert.equal(candidate?.steps.some((step) => step.type === 'open'), false);
});

test('sensitive execution steps never enter candidate artifacts', () => {
  const secretSteps = [{ type: 'open', path: '/checkout' } as const, { type: 'fill', locator: { by: 'label', value: 'Token' }, value: 'access_token=private123' } as const, assertion];
  const [manual] = createCandidates([{ ...group, evidence: [{ ...observation, steps: secretSteps }] }]);
  assert.equal(manual?.state, 'needs-context');
  assert.deepEqual(manual?.steps, []);
  assert.doesNotMatch(JSON.stringify(manual), /private123/);
  assert.match(manual!.questions.join(' '), /sensitive data/i);

  const profile = parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{ id: 's1', title: 'Checkout', match: { type: 'manual' }, requirement: 'Success', expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'], steps: secretSteps }] });
  const [profileCandidate] = createCandidates([group], profile);
  assert.deepEqual(profileCandidate?.steps, []);
  assert.doesNotMatch(JSON.stringify(profileCandidate), /private123/);
});

test('profile metadata containing sensitive data is rejected before export', () => {
  const base = { id: 's1', title: 'Checkout', match: { type: 'manual' }, requirement: 'Success', expectedSource: 'spec', steps };
  assert.throws(() => parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{ ...base, title: 'access_token=private123' }] }), /sensitive data/);
  assert.throws(() => parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{ ...base, preconditions: ['password=private123'] }] }), /sensitive data/);
});

test('credential-target fills are blocked even when their value has no secret-shaped prefix', () => {
  const privateValue = 'my-private-password';
  const profile = parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{
    id: 'password-case', title: 'Checkout', match: { type: 'manual' }, requirement: 'Success', expectedSource: 'spec',
    setupConfirmed: true, preconditions: ['signed in'],
    steps: [{ type: 'open', path: '/checkout' }, { type: 'fill', locator: { by: 'label', value: 'Password' }, value: privateValue }, assertion],
  }] });
  const candidates = createCandidates([group], profile);
  assert.equal(candidates[0]?.state, 'needs-context');
  assert.deepEqual(candidates[0]?.steps, []);
  const exported = exportFlowQa({
    schemaVersion: 'error-to-test/analysis-1', source: { sha256: 'a'.repeat(64) },
    coverage: { kind: 'manual-json', frequency: 'submitted-reports', partial: false, inputCount: 1, duplicates: 0, filtered: 0, retention: 'unknown' },
    groups: [], candidates, warnings: [],
  }, { reviewed: true });
  assert.doesNotMatch(JSON.stringify({ candidates, exported }), /my-private-password/);
  assert.ok(exported.suite?.cases[0]?.questions.some((question) => question.includes('sensitive data')));
});

test('profile refuses more than 100 scenarios', () => {
  const base = { id: 's0', title: 'Checkout', match: { type: 'manual' }, requirement: 'Success', expectedSource: 'spec', steps };
  assert.throws(() => parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: Array.from({ length: 101 }, (_, index) => ({ ...base, id: `s${index}` })) }), /at most 100/);
});

test('full-source context blocks sampled consensus when an older report conflicts', () => {
  const sampled = { ...group, context: {
    expected: undefined, expectedSource: undefined, reproduction: undefined, preconditions: undefined, steps: undefined,
    questions: ['Older report asks about setup'], conflicts: ['Expected behavior differs across reports'],
  } };
  const [manual] = createCandidates([sampled]);
  assert.equal(manual?.state, 'needs-context');
  assert.equal(manual?.expected, undefined);
  assert.deepEqual(manual?.steps, []);
  assert.deepEqual(manual?.reproduction, []);
  assert.ok(manual?.questions.includes('Expected behavior differs across reports'));
  assert.ok(manual?.questions.includes('Older report asks about setup'));

  const profile = parseProfile({ schemaVersion: 'error-to-test/profile-1', name: 'shop', scenarios: [{ id: 's1', title: 'Checkout', match: { type: 'manual' }, requirement: 'Success', expectedSource: 'spec', setupConfirmed: true, preconditions: ['signed in'], steps }] });
  const [matched] = createCandidates([sampled], profile);
  assert.equal(matched?.state, 'needs-context');
  assert.ok(matched?.questions.includes('Expected behavior differs across reports'));
  assert.ok(matched?.questions.includes('Older report asks about setup'));
});
