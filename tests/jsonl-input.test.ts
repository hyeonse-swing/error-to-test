import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseInput } from '../src/input.ts';
import { analyzeErrors } from '../src/analysis.ts';
import { exportFlowQa } from '../src/exports/flow-qa.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const event = (eventId: string, message = 'Request failed', occurredAt = '2026-11-01T00:00:00Z') => ({
  schemaVersion: 1, eventId, project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1',
  occurredAt, viewId: `view-${eventId}`, sequence: 1, elapsedMs: 1, type: 'javascript',
  message, stack: 'Error: Request failed\n    at run (/app.js:3:4)', page: '/items', runtime: 'browser',
});
const manual = (id: string, message = 'Request failed') => ({
  id, message, project: 'demo', environment: 'test', release: 'r1', runtime: 'browser', page: '/items',
});
const lines = (...records: Record<string, unknown>[]) => records.map(record => JSON.stringify(record)).join('\n');

function failureMessage(source: string | readonly string[]): string {
  let message: string | undefined;
  try { parseInput(source, { format: 'jsonl' }); }
  catch (error) { message = (error as Error).message; }
  assert.ok(message, 'input should fail');
  return message;
}

test('browser JSONL accepts CRLF, JSON whitespace lines, and escaped stack newlines', () => {
  const a = event('a');
  const b = event('b');
  const source = ` \t\r\n${JSON.stringify(a)}\r\n\r\n${JSON.stringify(b)}\r\n`;
  const parsed = parseInput(source, { format: 'jsonl' });
  const existing = parseInput(JSON.stringify([a, b]));
  assert.deepEqual(parsed.observations, existing.observations);
  assert.equal(parsed.observations[0]?.stack, a.stack);
  assert.deepEqual(parsed.coverage, { ...existing.coverage, kind: 'browser-error-jsonl', partial: false });
  assert.equal(parsed.coverage.frequency, 'captured-events');
  assert.equal(parsed.warnings.filter(warning => warning.includes('no export coverage metadata')).length, 1);
  assert.equal(parsed.warnings.some(warning => warning.includes('Source export is partial')), false);
});

test('manual JSONL uses existing defaults and normalization, without export partial coverage', () => {
  const a = { message: 'Authorization: Bearer secret user@example.com', stack: 'Error\n at run (/app.js:1)' };
  const b = { id: 'b', message: 'Other failure', page: 'https://u:p@example.com/items?token=secret' };
  const source = `${JSON.stringify(a)}\n \t\r\n${JSON.stringify(b)}`;
  const defaults = { format: 'jsonl' as const, project: 'demo', environment: 'test', release: 'r1' };
  const parsed = parseInput(source, defaults);
  const existing = parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [a, b] }),
    { project: 'demo', environment: 'test', release: 'r1' });
  assert.deepEqual(parsed.observations, existing.observations);
  assert.equal(parsed.coverage.kind, 'manual-jsonl');
  assert.equal(parsed.coverage.frequency, 'submitted-reports');
  assert.equal(parsed.coverage.partial, false);
  assert.doesNotMatch(JSON.stringify(parsed.observations), /secret|user@example.com|u:p@/);
});

test('single and multiple JSONL files retain original BOM bytes, boundaries, and hashes', () => {
  const first = `\uFEFF${JSON.stringify(event('a'))}\n`;
  const second = `\uFEFF${JSON.stringify(event('b'))}\r\n`;
  assert.deepEqual(parseInput([first], { format: 'jsonl' }), parseInput(first, { format: 'jsonl' }));
  assert.equal(parseInput(first, { format: 'jsonl' }).sha256, sha256(first));
  const combined = parseInput([first, second], { format: 'jsonl' });
  const inputs = [first, second].map(source => ({ sha256: sha256(source), byteLength: Buffer.byteLength(source) }));
  assert.deepEqual(combined.inputs, inputs);
  assert.equal(combined.sha256, sha256(JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs })));
  assert.deepEqual(combined.observations.map(observation => observation.id), ['a', 'b']);
  assert.notEqual(combined.sha256, parseInput([second, first], { format: 'jsonl' }).sha256);
});

test('raw JSONL records combine before deduplication, filtering, ranking, minCount, and top', () => {
  const a = event('a', 'A failed');
  const b = event('b', 'B failed');
  const sources = [lines(a, b), lines(a, event('c', 'A failed'), event('d', 'B failed'),
    event('e', 'B failed'), event('old', 'Old failed', '2026-01-01T00:00:00Z'))];
  const parsed = parseInput(sources, { format: 'jsonl', from: '2026-10-01T00:00:00Z' });
  assert.deepEqual([parsed.coverage.inputCount, parsed.coverage.duplicates, parsed.coverage.filtered], [7, 1, 1]);
  assert.equal(parsed.observations.length, 5);
  const analysis = analyzeErrors(sources, { format: 'jsonl', from: '2026-10-01T00:00:00Z', minCount: 2, top: 1 });
  assert.deepEqual(analysis.groups.map(group => [group.message, group.count]), [['B failed', 3], ['A failed', 2]]);
  assert.equal(analysis.candidates.length, 1);
  assert.equal(analysis.candidates[0]?.groupId, analysis.groups[0]?.id);
});

test('JSONL raw ID conflicts reject before filters without exposing record values', () => {
  const first = event('same', 'token=alpha');
  const second = event('same', 'token=beta');
  assert.equal(parseInput(JSON.stringify([first])).observations[0]?.message,
    parseInput(JSON.stringify([second])).observations[0]?.message);
  const source = [JSON.stringify(first), ` \t\n${JSON.stringify(second)}`];
  let message: string | undefined;
  try { parseInput(source, { format: 'jsonl', project: 'excluded' }); }
  catch (error) { message = (error as Error).message; }
  assert.match(message ?? '', /JSONL input file 2, line 2: Conflicting duplicate ID/);
  assert.doesNotMatch(message ?? '', /alpha|beta|same/);
});

test('JSONL rejects mixed kinds, unknown schema versions, export envelopes, and non-object records', () => {
  const a = JSON.stringify(event('a'));
  const b = JSON.stringify(manual('b'));
  assert.match(failureMessage(`${a}\n${b}`), /file 1, line 2: Mixed browser and manual/);
  assert.match(failureMessage(`${b}\n${a}`), /file 1, line 2: Mixed browser and manual/);
  assert.match(failureMessage(JSON.stringify({ ...event('a'), schemaVersion: 2 })), /file 1, line 1: Unsupported schemaVersion/);
  assert.match(failureMessage(JSON.stringify({ ...manual('a'), schemaVersion: null })), /file 1, line 1: Unsupported schemaVersion/);
  for (const record of [
    { schemaVersion: 1, events: [event('a')] },
    { errors: [manual('a')] },
    { message: 'Failure', partial: false },
    { ...event('a'), partial: false },
  ]) assert.match(failureMessage(JSON.stringify(record)), /file 1, line 1: Export envelopes and coverage metadata/);
  for (const record of [null, 1, true, 'secret-value', [event('a')]]) {
    const diagnostic = failureMessage(JSON.stringify(record));
    assert.match(diagnostic, /file 1, line 1: Record must be a JSON object/);
    assert.doesNotMatch(diagnostic, /secret-value/);
  }
  assert.match(failureMessage([a, ` \t\n${b}`]), /^JSONL input file 2, line 2: Input files must have the same source kind\.$/);
  assert.throws(() => parseInput([a, JSON.stringify({ schemaVersion: 1, events: [event('b')] })], { format: 'jsonl' }), /file 2, line 1: Export envelopes/);
});

test('JSONL syntax and validation errors report file and physical line without parser or source text', () => {
  const valid = JSON.stringify(event('a'));
  const syntax = failureMessage([valid, ` \t\r\n${valid}\r\n{not-json secret-syntax`]);
  assert.match(syntax, /^JSONL input file 2, line 3: Malformed JSON record\.$/);
  assert.doesNotMatch(syntax, /secret-syntax|Unexpected|position/);
  const shape = failureMessage([valid, `\n${JSON.stringify({ ...event('b'), sdkVersion: undefined,
    context: { 'secret-field-name': {} } })}`]);
  assert.match(shape, /^JSONL input file 2, line 2: Invalid browser record\.$/);
  assert.doesNotMatch(shape, /secret-field-name|sdkVersion|events\[/);
  const invalidManual = failureMessage(`\n${JSON.stringify({ message: [], project: 'secret-project' })}`);
  assert.match(invalidManual, /^JSONL input file 1, line 2: Invalid manual record\.$/);
  assert.doesNotMatch(invalidManual, /secret-project|message|errors\[/);
});

test('only the first file-leading BOM is ignored; pretty JSON and non-JSON whitespace fail', () => {
  const record = JSON.stringify(manual('a'));
  assert.match(failureMessage(`\uFEFF\uFEFF${record}`), /file 1, line 1: Malformed JSON record/);
  assert.match(failureMessage(`${record}\n\uFEFF${record}`), /file 1, line 2: Malformed JSON record/);
  assert.match(failureMessage(`\n\uFEFF${record}`), /file 1, line 2: Malformed JSON record/);
  assert.match(failureMessage(` \uFEFF\n${record}`), /file 1, line 1: Malformed JSON record/);
  assert.match(failureMessage(`\f\n${record}`), /file 1, line 1: Malformed JSON record/);
  assert.match(failureMessage(JSON.stringify(manual('a'), null, 2)), /file 1, line 1: Malformed JSON record/);
  assert.match(failureMessage(' \t\r\n\r\n'), /Input has no records/);
});

test('JSONL enforces the global raw-record limit even for duplicates', () => {
  const same = JSON.stringify(manual('same'));
  const half = Array(5000).fill(same).join('\n');
  const within = parseInput([half, half], { format: 'jsonl' });
  assert.deepEqual([within.coverage.inputCount, within.coverage.duplicates], [10000, 9999]);
  assert.throws(() => parseInput([half, `${half}\n${same}`], { format: 'jsonl' }), /Input exceeds 10000 records/);
});

test('auto and JSON formats do not detect JSONL; profile and review gates remain effective', () => {
  const source = lines(manual('a'), manual('b'));
  assert.throws(() => parseInput(source), /Malformed JSON input/);
  assert.throws(() => parseInput(source, { format: 'json' }), /Malformed JSON input/);
  const bare = analyzeErrors(source, { format: 'jsonl' });
  assert.equal(bare.candidates[0]?.state, 'needs-context');
  const profile = { schemaVersion: 'error-to-test/profile-1', name: 'demo', scenarios: [{
    id: 'failure', title: 'Request failure', match: { messageIncludes: 'Request failed' },
    requirement: 'Items are shown', expectedSource: 'spec', setupConfirmed: true,
    preconditions: ['signed in'], questions: [],
    steps: [{ type: 'open', path: '/items' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Items' }, visible: true }],
  }] };
  const analyzed = analyzeErrors(source, { format: 'jsonl', profile });
  assert.equal(analyzed.candidates[0]?.state, 'draft');
  assert.ok(exportFlowQa(analyzed).suite?.cases[0]?.questions.some(question => /Review this draft case/.test(question)));
  assert.deepEqual(exportFlowQa(analyzed, { reviewed: true }).suite?.cases[0]?.questions, []);
});
