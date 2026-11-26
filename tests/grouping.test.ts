import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeErrors } from '../src/analysis.ts';
import { compareAnalyses } from '../src/comparison.ts';
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

test('error headings containing frame-like text do not hide the actual browser source location', () => {
  const headings = [
    'Error: Validation failed at checkout',
    'Error: support@example.com:404:2',
    'Error: retry after status:123',
  ];
  const framePairs = [
    ['    at handle (/cart.js:1:58)', '    at handle (/billing.js:1:60)'],
    ['handle@https://example.com/cart.js:1:58', 'handle@https://example.com/billing.js:1:60'],
    ['global code@https://example.com/cart.js:1:58', 'global code@https://example.com/billing.js:1:60'],
  ];
  for (const heading of headings) for (const [first, second] of framePairs) {
    const source = (id: string, frame: string) => ({ ...base, id, message: heading, stack: `${heading}\n${frame}` });
    const groups = groupObservations([source('cart', first), source('billing', second)]);
    assert.equal(groups.length, 2, `${heading} with ${first}`);
    assert.match(groups[0]!.signature, /(?:cart|billing)\.js:1:/);
  }
});

test('headerless stack frames retain their source signatures and empty stacks have no source', () => {
  const stacks = ['at handle (/cart.js:1:58)', 'handle@https://example.com/cart.js:1:58', '@https://example.com/cart.js:1:58',
    'handle@https://example.test/@shop/cart.js:1:9', 'https://example.test/app.js:1:2', 'map@[native code]'];
  for (const stack of stacks) {
    const [group] = groupObservations([{ ...base, stack }]);
    assert.equal(group?.signature, ` | ${base.message} | ${stack}`);
  }
  assert.equal(groupObservations([{ ...base, stack: 'Error: retry after status:123' }])[0]?.signature,
    ` | ${base.message} | `);
});

test('component-only React stacks retain their first component when the error has no source frame', () => {
  for (const stack of [undefined, 'Error: ' + base.message]) {
    const groups = groupObservations(['Cart', 'Billing'].map(id => ({
      ...base, id, stack, componentStack: `\n    at ${id}\n    at App (<anonymous>)`,
    })));
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.signature.endsWith('at ' + group.eventIds[0])));
  }
});

test('source changes behind a repeated error heading count as new signatures in comparisons', () => {
  const report = (id: string, release: string, source: string) => JSON.stringify({
    schemaVersion: 'error-to-test/manual-1',
    errors: [{ id, release, project: 'shop', environment: 'test', page: '/checkout',
      message: 'Validation failed at checkout', stack: `Error: Validation failed at checkout\n    at handle (${source}:1:2)` }],
  });
  const baseline = analyzeErrors(report('before', 'r1', '/cart.js'));
  const current = analyzeErrors(report('after', 'r2', '/billing.js'));
  assert.deepEqual(compareAnalyses(baseline, current).counts,
    { 'only-current': 1, both: 0, 'only-baseline': 1 });
});
