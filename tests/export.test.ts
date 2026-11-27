import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFlowQa } from '../src/exports/flow-qa.ts';
import { hash } from '../src/validation.ts';
import type { Analysis, TestCandidate } from '../src/types.ts';

const candidate: TestCandidate = {
  id: 'TC_123', groupId: 'group-1', title: 'Checkout', state: 'draft',
  facts: ['Observed checkout error'], hypotheses: [], reproduction: ['Submit checkout'], preconditions: [],
  expected: { text: 'Success is visible', source: 'spec' }, questions: [],
  steps: [
    { type: 'open', path: '/checkout' }, { type: 'act', instruction: 'Submit checkout' },
    { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true },
  ],
  eventIds: ['event-1'],
};
const analysis: Analysis = {
  schemaVersion: 'error-to-test/analysis-1', source: { sha256: 'a'.repeat(64) },
  coverage: { kind: 'manual-json', frequency: 'submitted-reports', partial: false, inputCount: 1, duplicates: 0, filtered: 0, retention: 'unknown' },
  groups: [], candidates: [candidate], warnings: [],
};

test('default export asks for review; acknowledged review removes only that question', () => {
  const pending = exportFlowQa(analysis);
  assert.equal(pending.suite?.cases[0]?.questions.length, 1);
  assert.match(pending.suite!.cases[0]!.questions[0]!, /Review this draft/);
  const reviewed = exportFlowQa(analysis, { reviewed: true });
  assert.deepEqual(reviewed.suite?.cases[0]?.questions, []);
  assert.equal(reviewed.suite?.cases[0]?.steps[0]?.type, 'open');
  assert.equal(reviewed.suite?.platform, 'web');
  assert.equal(reviewed.suite?.source?.file, 'flows/error-to-test.md');
  assert.equal(reviewed.suite?.source?.sha256, hash(reviewed.flow));
  assert.equal(reviewed.provenance.analysisSha256, hash(`${JSON.stringify(analysis, null, 2)}\n`));
  assert.equal(reviewed.provenance.suiteSha256, hash(`${JSON.stringify(reviewed.suite, null, 2)}\n`));
  assert.deepEqual(reviewed.provenance.mappings, [{ caseId: candidate.id, candidateId: candidate.id, groupId: candidate.groupId, eventIds: candidate.eventIds }]);
});

test('the exported suite trims Flow QA text and keeps literal fill values and review evidence', () => {
  const padded: TestCandidate = {
    ...candidate,
    title: ' Checkout\u00a0',
    preconditions: [' Account ready '],
    questions: [' What applies? '],
    steps: [
      { type: 'open', path: '/checkout ' },
      { type: 'act', instruction: ' Prepare the cart ' },
      { type: 'click', locator: { by: 'testId', value: ' continue ' } },
      { type: 'fill', locator: { by: 'label', value: ' Alias ' }, value: '  padded value  ' },
      { type: 'assertVisible', locator: { by: 'role', value: 'button', name: ' Continue ' }, visible: false },
      { type: 'assertText', locator: { by: 'text', value: ' Status ' }, expected: ' Recovered ', match: 'contains' },
      { type: 'assertUrl', expected: ' /checkout ' },
      { type: 'assertAgent', instruction: ' Confirm the cart ' },
    ],
  };
  const result = exportFlowQa({ ...analysis, candidates: [padded] }, { reviewed: true });
  const item = result.suite!.cases[0]!;
  assert.equal(item.title, 'Checkout');
  assert.deepEqual(item.preconditions, ['Account ready']);
  assert.deepEqual(item.questions, ['What applies?']);
  assert.deepEqual(item.steps, [
    { type: 'open', path: '/checkout' },
    { type: 'act', instruction: 'Prepare the cart' },
    { type: 'click', locator: { by: 'testId', value: 'continue' } },
    { type: 'fill', locator: { by: 'label', value: 'Alias' }, value: '  padded value  ' },
    { type: 'assertVisible', locator: { by: 'role', value: 'button', name: 'Continue' }, visible: false },
    { type: 'assertText', locator: { by: 'text', value: 'Status' }, expected: 'Recovered', match: 'contains' },
    { type: 'assertUrl', expected: '/checkout' },
    { type: 'assertAgent', instruction: 'Confirm the cart' },
  ]);
  assert.ok(result.flow.includes(JSON.stringify(padded.title)));
});

test('missing context compiles to a blocked case and untrusted headings stay quoted', () => {
  const unsafe: TestCandidate = { ...candidate, title: 'Error\n# Confirmed requirement', state: 'needs-context', expected: undefined, steps: [], questions: ['What action?'] };
  const result = exportFlowQa({ ...analysis, candidates: [unsafe] }, { reviewed: true });
  assert.equal(result.suite?.cases[0]?.steps[0]?.type, 'act');
  assert.ok(result.suite?.cases[0]?.questions.includes('What action?'));
  assert.match(result.suite!.requirements[0]!.text, /unresolved/);
  assert.doesNotMatch(result.flow, /^# Confirmed requirement/m);
});

test('empty analysis reports no cases and over-limit export refuses loss', () => {
  const empty = exportFlowQa({ ...analysis, candidates: [] });
  assert.equal(empty.suite, undefined);
  assert.match(empty.flow, /No test cases/);
  assert.equal(empty.provenance.suiteSha256, undefined);
  assert.throws(() => exportFlowQa({ ...analysis, candidates: Array.from({ length: 101 }, (_, index) => ({ ...candidate, id: `TC_${index}` })) }), /at most 100/);
});

test('oversized merged Flow QA requirement is rejected', () => {
  assert.throws(() => exportFlowQa({ ...analysis, candidates: [{ ...candidate, expected: { text: 'x'.repeat(8192), source: 'spec' } }] }), /exceeds 8192/);
});

test('many individually valid candidates cannot exceed the downstream flow size contract', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({ ...candidate, id: `TC_${index}`, groupId: `group-${index}`, facts: ['x'.repeat(4096)] }));
  assert.throws(() => exportFlowQa({ ...analysis, candidates }), /128 KB/);
});
