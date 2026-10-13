import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../src/input.ts';
import { pagePath, redactText, safeUrl } from '../src/redact.ts';

const event = {
  schemaVersion: 1, eventId: 'e1', project: 'shop', environment: 'prod', release: 'r1',
  sdkVersion: '0.1.5', occurredAt: '2026-10-13T12:00:00+09:00', viewId: 'v1',
  sequence: 1, elapsedMs: 42, type: 'http', message: 'GET failed with 500',
  page: 'https://alice:secret@example.com/cart?token=abc#frag', runtime: 'browser',
  network: { method: 'GET', url: 'https://example.com/api/order?id=123&token=abc', status: 500, durationMs: 10 },
};

test('browser export validates protocol and preserves only sanitized observations', () => {
  const parsed = parseInput(JSON.stringify({ schemaVersion: 1, partial: true, events: [event, event] }));
  assert.equal(parsed.coverage.inputCount, 2);
  assert.equal(parsed.coverage.duplicates, 1);
  assert.equal(parsed.coverage.partial, true);
  assert.equal(parsed.observations.length, 1);
  assert.equal(parsed.observations[0]?.page, 'https://example.com/cart');
  assert.equal(parsed.observations[0]?.network?.url, 'https://example.com/api/order');
  assert.equal(parsed.observations[0]?.occurredAt, '2026-10-13T03:00:00.000Z');
  assert.equal('sequence' in parsed.observations[0]!, false);
});

test('invalid protocol fields and conflicting duplicate IDs reject', () => {
  assert.throws(() => parseInput(JSON.stringify([ { ...event, sequence: '1' } ])), /sequence/);
  assert.throws(() => parseInput(JSON.stringify([ { ...event, network: { method: 'GET', url: '/x' } } ])), /durationMs/);
  assert.throws(() => parseInput(JSON.stringify([event, { ...event, message: 'different' }])), /Conflicting duplicate/);
  assert.throws(() => parseInput('{invalid'), /Malformed JSON/);
  assert.throws(() => parseInput('[]'), /no records/);
});

test('manual text is one undated report and date filters exclude it', () => {
  const parsed = parseInput('TypeError: boom\n at run (/src/run.ts:42)', { project: 'shop' });
  assert.equal(parsed.coverage.kind, 'manual-text');
  assert.equal(parsed.coverage.inputCount, 1);
  assert.equal(parsed.observations[0]?.message, 'TypeError: boom');
  assert.equal(parsed.observations[0]?.stack, ' at run (/src/run.ts:42)');
  assert.equal(parsed.observations[0]?.occurredAt, undefined);
  const filtered = parseInput('boom', { from: '2026-10-13T00:00:00Z' });
  assert.equal(filtered.observations.length, 0);
  assert.equal(filtered.coverage.filtered, 1);
  assert.match(filtered.warnings.join(' '), /Undated/);
});

test('bounded logger prefixes parse as text while malformed arrays still reject', () => {
  for (const line of ['[vite] TypeError: request failed', '[ERROR] Cannot read property', '[2026-10-13 12:34:56] Request failed']) {
    const parsed = parseInput(`${line}\n at run (/src/run.ts:4)`);
    assert.equal(parsed.coverage.kind, 'manual-text');
    assert.equal(parsed.observations[0]?.message, line);
  }
  assert.throws(() => parseInput('[{"schemaVersion":'), /Malformed JSON/);
  assert.throws(() => parseInput('[unknown] trailing'), /Malformed JSON/);
  assert.throws(() => parseInput('[vite] TypeError', { format: 'json' }), /Malformed JSON/);
});

test('manual duplicates, required fields, and redaction', () => {
  const report = { message: 'Authorization: Bearer abc user@example.com', page: 'https://u:p@example.com/a?secret=123', reproduction: ['password=abc'] };
  const parsed = parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [report, report] }));
  assert.equal(parsed.coverage.duplicates, 1);
  assert.equal(parsed.observations[0]?.message, 'Authorization=[redacted] [redacted-email]');
  assert.equal(parsed.observations[0]?.page, 'https://example.com/a');
  assert.equal(parsed.observations[0]?.reproduction[0], 'password=[redacted]');
  assert.throws(() => parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{}] })), /message/);
});

test('URL and text helpers remove credentials and location secrets', () => {
  assert.equal(safeUrl('https://u:p@example.com/a?x=1#h'), 'https://example.com/a');
  assert.equal(pagePath('https://example.com/a?x=1'), '/a');
  assert.equal(safeUrl('//alice:password123@127.0.0.1/private?token=abc'), 'https://127.0.0.1/private');
  assert.equal(pagePath('//alice:password123@127.0.0.1/private?token=abc'), '/private');
  assert.equal(redactText('failed at //alice:password123@127.0.0.1/private?token=abc'), 'failed at https://127.0.0.1/private');
  assert.equal(redactText('see https://u:p@example.com/a?token=x and api_key=xyz'), 'see https://example.com/a and api_key=[redacted]');
  assert.equal(redactText('token=abc'), 'token=[redacted]');
  assert.equal(redactText('{"password":"hunter2","apiKey":"key-value","Authorization":"Bearer abc"}'),
    '{"password":"[redacted]","apiKey":"[redacted]","Authorization":"[redacted]"}');
  assert.equal(redactText('{"token":123456,"otp":123456,"pin":2468,"passcode":false,"status":500}'),
    '{"token":"[redacted]","otp":"[redacted]","pin":"[redacted]","passcode":"[redacted]","status":500}');
  const fakeGitHubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');
  assert.equal(safeUrl(`https://example.com/${fakeGitHubToken}?token=abc`),
    'https://example.com/[redacted-token]');
  const fakeTokens = ['xoxb' + '-12345678901234567890', 'npm' + '_abcdefghijklmnopqrstuvwxyz1234567890', 'sk' + '-abcdefghijklmnopqrstuvwxyz1234567890'].join(' ');
  assert.equal(redactText(fakeTokens),
    '[redacted-token] [redacted-token] [redacted-token]');
  const delimiter = '-'.repeat(5);
  assert.equal(redactText(`${delimiter}BEGIN PRIVATE KEY${delimiter}\nprivate-data\n${delimiter}END PRIVATE KEY${delimiter}`), '[redacted-private-key]');
});

test('protocol-relative credentials are absent from page, message, stack and network artifacts', () => {
  const secretUrl = '//alice:password123@127.0.0.1/private?token=abc';
  const parsed = parseInput(JSON.stringify([{ ...event, page: secretUrl,
    message: `Failed ${secretUrl}`, stack: `Error at ${secretUrl}`,
    network: { ...event.network, url: secretUrl },
  }]));
  assert.equal(parsed.observations[0]?.page, 'https://127.0.0.1/private');
  assert.equal(parsed.observations[0]?.network?.url, 'https://127.0.0.1/private');
  assert.doesNotMatch(JSON.stringify(parsed.observations), /alice|password123|token=abc/);
});

test('nested JSON diagnostic secrets never appear in observations', () => {
  const diagnostic = '{"error":{"password":"hunter2","token":123456,"otp":2468,"status":500,"url":"https://u:p@example.com/a?key=secret"}}';
  const parsed = parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: diagnostic, stack: diagnostic }] }));
  assert.doesNotMatch(JSON.stringify(parsed.observations), /hunter2|123456|2468|u:p@|key=secret/);
  assert.match(parsed.observations[0]?.message ?? '', /"password":"\[redacted\]"/);
  assert.match(parsed.observations[0]?.message ?? '', /"status":500/);
});

test('credential-bearing executable steps are discarded and flagged for review', () => {
  const parsed = parseInput(JSON.stringify({
    schemaVersion: 'error-to-test/manual-1', errors: [{
      message: 'Login fails',
      steps: [{ type: 'fill', locator: { by: 'label', value: 'Password' }, value: 'password=secret123' },
        { type: 'assertText', locator: { by: 'text', value: 'token=abc' }, expected: 'Welcome', match: 'equals' }],
    }],
  }));
  assert.deepEqual(parsed.observations[0]?.steps, []);
  assert.match(parsed.observations[0]?.questions.join(' '), /safe reproduction steps/);
  assert.doesNotMatch(JSON.stringify(parsed.observations), /secret123|token=abc/);
  const bare = parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{
    message: 'Login fails', steps: [{ type: 'fill', locator: { by: 'label', value: 'Password' }, value: 'my-private-password' }],
  }] }));
  assert.deepEqual(bare.observations[0]?.steps, []);
  assert.doesNotMatch(JSON.stringify(bare.observations), /my-private-password/);
});

test('redacted expected behavior or source cannot authorize a runnable expectation', () => {
  const parsed = parseInput(JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{
    message: 'Email display failed', expected: 'Email alice@example.com is shown', expectedSource: 'Reporter',
    steps: [{ type: 'open', path: '/account' }, { type: 'assertVisible', locator: { by: 'text', value: 'Profile' }, visible: true }],
  }, {
    message: 'Account display failed', expected: 'Profile is shown', expectedSource: 'https://u:p@example.com/spec?token=abc',
  }] }));
  for (const observation of parsed.observations) {
    assert.equal(observation.expected, undefined);
    assert.equal(observation.expectedSource, undefined);
    assert.match(observation.questions.join(' '), /safe expected behavior/);
  }
  assert.doesNotMatch(JSON.stringify(parsed.observations), /alice@example.com|u:p@|token=abc/);
});
