import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupObservations } from '../src/grouping.ts';
import type { ErrorObservation } from '../src/types.ts';

const base: ErrorObservation = {
  id: 'a', source: 'browser-error', project: 'shop', environment: 'prod', release: 'r1',
  runtime: 'browser', type: 'javascript', message: 'Cannot read item 42',
  stack: 'TypeError\n at render (/src/cart.ts:42:3)', page: 'https://example.com/cart?q=1',
  occurredAt: '2026-10-13T00:00:00.000Z', viewId: 'v1',
  reproduction: [], preconditions: [], questions: [], steps: [],
};

test('groups within release and source site with deterministic evidence', () => {
  const observations: ErrorObservation[] = [
    { ...base, id: 'b', viewId: 'v2', occurredAt: '2026-10-13T01:00:00.000Z' },
    base,
    { ...base, id: 'c', release: 'r2' },
    { ...base, id: 'd', stack: 'TypeError\n at render (/src/other.ts:42:3)' },
    { ...base, id: 'e', message: 'Cannot read item 43' },
  ];
  const groups = groupObservations(observations);
  assert.equal(groups.length, 4);
  assert.equal(groups[0]?.count, 2);
  assert.equal(groups[0]?.viewCount, 2);
  assert.deepEqual(groups[0]?.eventIds, ['a', 'b']);
  assert.deepEqual(groups[0]?.evidence.map((item) => item.id), ['b', 'a']);
  assert.deepEqual(groupObservations([...observations].reverse()), groups);
});

test('HTTP method, path and status separate signatures and view counts require IDs', () => {
  const http: ErrorObservation = { ...base, type: 'http', viewId: undefined, network: { method: 'GET', url: 'https://example.com/api/one?token=x', status: 500 } };
  const groups = groupObservations([http, { ...http, id: 'b', network: { ...http.network!, status: 404 } }, { ...http, id: 'c', network: { ...http.network!, url: 'https://example.com/api/two' } }]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.viewCount === 0));
});

test('context checks all six reports before sampling and keeps oldest-only questions', () => {
  const reports: ErrorObservation[] = Array.from({ length: 6 }, (_, index) => ({
    ...base, source: 'manual', id: `report-${index}`, viewId: undefined,
    occurredAt: `2026-10-13T0${index}:00:00.000Z`,
    expected: index === 0 ? 'Shows an error' : 'Shows the cart',
    expectedSource: 'Product requirement',
    reproduction: ['Open cart'], preconditions: ['Signed in'],
    questions: index === 0 ? ['Was the error shown on mobile?'] : [],
    steps: [{ type: 'open', path: '/cart' }],
  }));
  const [group] = groupObservations(reports);
  assert.equal(group?.count, 6);
  assert.equal(group?.evidence.length, 5);
  assert.ok(!group?.evidence.some((item) => item.id === 'report-0'));
  assert.equal(group?.context?.expected, undefined);
  assert.equal(group?.context?.expectedSource, 'Product requirement');
  assert.deepEqual(group?.context?.reproduction, ['Open cart']);
  assert.deepEqual(group?.context?.questions, ['Was the error shown on mobile?']);
  assert.deepEqual(group?.context?.conflicts, ['Conflicting expected across reports.']);
  assert.deepEqual(groupObservations([...reports].reverse()), [group]);
});

test('missing context conflicts with present context', () => {
  const [group] = groupObservations([base, { ...base, id: 'b', expected: 'Show error', steps: [{ type: 'open', path: '/cart' }] }]);
  assert.equal(group?.context?.expected, undefined);
  assert.equal(group?.context?.steps, undefined);
  assert.deepEqual(group?.context?.conflicts, ['Conflicting expected across reports.', 'Conflicting steps across reports.']);
});
