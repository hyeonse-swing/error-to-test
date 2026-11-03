import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { jsonText, writeBundle } from '../src/artifacts.ts';
import { compareBundles, renderComparison } from '../src/comparison.ts';
import { hash } from '../src/validation.ts';

const manual = (...errors: Record<string, unknown>[]) => JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, release = 'r1', extra: Record<string, unknown> = {}) => ({ id, message, release, project: 'demo', environment: 'test', runtime: 'browser', type: 'javascript', page: '/items', ...extra });
async function fixture(run: (base: string, current: string) => Promise<void>, baseline: ReturnType<typeof analyzeErrors>, now: ReturnType<typeof analyzeErrors>) {
  const root = await mkdtemp(join(tmpdir(), 'comparison-'));
  const base = join(root, 'baseline'), current = join(root, 'current');
  try { await writeBundle(base, baseline); await writeBundle(current, now); await run(base, current); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('compares all groups across releases, buckets, and selected TC thresholds deterministically', async () => {
  const before = analyzeErrors(manual(item('a1', 'Shared'), item('a2', 'Shared'), item('a3', 'Gone')), { minCount: 3 });
  const after = analyzeErrors(manual(item('b1', 'Shared', 'r2'), item('b2', 'New', 'r2'), item('b3', 'New', 'r3')), { top: 1, minCount: 3 });
  assert.equal(before.candidates.length, 0);
  assert.equal(after.candidates.length, 0);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.deepEqual(result.counts, { 'only-current': 1, both: 1, 'only-baseline': 1 });
    assert.deepEqual(result.issues.map(i => [i.status, i.message, i.delta]), [['only-current', 'New', 2], ['both', 'Shared', -1], ['only-baseline', 'Gone', -1]]);
    assert.equal(result.baseline.groupCount, 2);
    assert.equal(result.current.groupCount, 3);
    assert.equal(result.current.recordCount, 3);
    assert.deepEqual(result.issues[0]!.current!.releases, ['r2', 'r3']);
    assert.equal(result.issues[0]!.current!.groupIds.length, 2);
    assert.equal(result.issues[1]!.baseline!.count, 2);
    assert.equal(result.issues[1]!.current!.count, 1);
    assert.match(result.warnings.join(' '), /analyze --release/);
    assert.match(renderComparison(result), /Only current: 1 · Both: 1 · Only baseline: 1/);
    const again = await compareBundles(base, current);
    assert.deepEqual(again, result);
    assert.equal((await readFile(join(base, 'analysis.json'), 'utf8')).includes('Shared'), true);
  }, before, after);
});

test('keeps distinct fingerprint dimensions and permits empty filtered groups', async () => {
  const variants = [
    item('1', 'failure', 'r1'),
    item('2', 'failure', 'r1', { project: 'other' }),
    item('3', 'failure', 'r1', { environment: 'stage' }),
    item('4', 'failure', 'r1', { runtime: 'webview-ios' }),
    item('5', 'failure', 'r1', { type: 'promise' }),
    item('6', 'failure', 'r1', { page: '/other' }),
    item('7', 'failure', 'r1', { stack: '    at one (/app.js:1:1)' }),
    item('8', 'failure', 'r1', { type: 'http' }),
  ];
  const before = analyzeErrors(manual(...variants));
  assert.equal(before.groups.length, 8);
  const filtered = analyzeErrors(manual(...variants), { project: 'none' });
  assert.equal(filtered.groups.length, 0);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.counts['only-baseline'], 8);
    assert.equal(result.current.recordCount, 0);
    assert.equal(result.current.coverage.filtered, 8);
    assert.equal(result.issues.length, 8);
  }, before, filtered);
});

test('rejects incompatible frequencies, unsupported fingerprints, and stale bundles', async () => {
  const before = analyzeErrors(manual(item('a', 'failure')));
  const after = analyzeErrors(JSON.stringify({ schemaVersion: 1, events: [{ schemaVersion: 1, eventId: 'b', project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1', occurredAt: '2026-10-01T00:00:00Z', viewId: 'v', sequence: 1, elapsedMs: 1, type: 'javascript', message: 'failure', page: '/items', runtime: 'browser' }] }));
  await fixture(async (base, current) => {
    await assert.rejects(compareBundles(base, current), /matching count frequency/);
  }, before, after);
  await fixture(async (base, current) => {
    const path = join(current, 'analysis.json');
    await writeFile(path, `${await readFile(path, 'utf8')} `);
    await assert.rejects(compareBundles(base, current), /STALE_BUNDLE/);
  }, before, before);
  await fixture(async (base, current) => {
    const path = join(base, 'analysis.json');
    await writeFile(path, `${await readFile(path, 'utf8')} `);
    await assert.rejects(compareBundles(base, current), /STALE_BUNDLE/);
  }, before, before);
  await fixture(async (base, current) => {
    const path = join(current, 'analysis.json');
    const analysis = JSON.parse(await readFile(path, 'utf8'));
    analysis.groups[0].fingerprintVersion = 2;
    const content = jsonText(analysis);
    const provenancePath = join(current, 'provenance.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    provenance.analysisSha256 = hash(content);
    await writeFile(path, content);
    await writeFile(provenancePath, jsonText(provenance));
    await assert.rejects(compareBundles(base, current), /fingerprintVersion/);
  }, before, before);
});

test('warns on partial exports and period mismatch, and fences/redacts report text', async () => {
  const browser = (partial: boolean) => JSON.stringify({ schemaVersion: 1, partial, events: [{ schemaVersion: 1, eventId: 'a', project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1', occurredAt: '2026-10-01T00:00:00Z', viewId: 'v', sequence: 1, elapsedMs: 1, type: 'javascript', message: 'failure', page: '/items', runtime: 'browser' }] });
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.match(result.warnings.join(' '), /partial/);
    assert.match(result.warnings.join(' '), /period filters differ/);
    result.issues[0]!.message = '```\n## fake\ntoken=secret123';
    const md = renderComparison(result);
    assert.match(md, /````text\nProject:/);
    assert.ok(!md.includes('secret123'));
    const unsafe = structuredClone(result);
    unsafe.issues[0]!.id = 'comparison-good\n## spoof';
    assert.throws(() => renderComparison(unsafe), /invalid id/);
    const badStatus = structuredClone(result);
    badStatus.issues[0]!.status = 'resolved' as never;
    assert.throws(() => renderComparison(badStatus), /invalid id or status/);
    const badCount = structuredClone(result);
    badCount.counts.both = NaN;
    assert.throws(() => renderComparison(badCount), /integer/);
  }, analyzeErrors(browser(true)), analyzeErrors(browser(false), { from: '2026-09-01T00:00:00Z' }));
});

test('accepts expanded normalized text and keeps HTTP status signatures distinct', async () => {
  const expanded = 'pin=1 '.repeat(1100);
  const longAnalysis = analyzeErrors(manual(item('long', expanded)));
  assert.ok(longAnalysis.groups[0]!.message.length > 8192);
  assert.ok(longAnalysis.groups[0]!.signature.length > 8192);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.counts.both, 1);
    assert.ok(!renderComparison(result).includes('pin=1'));
  }, longAnalysis, longAnalysis);

  const event = (eventId: string, status: number) => ({ schemaVersion: 1, eventId, project: 'demo', environment: 'test', release: 'r1', sdkVersion: '1',
    occurredAt: '2026-10-01T00:00:00Z', viewId: eventId, sequence: 1, elapsedMs: 1,
    type: 'http', message: 'request failed', page: '/items', runtime: 'browser', network: { method: 'GET', url: 'https://example.com/api', status, durationMs: 1 } });
  const captured = analyzeErrors(JSON.stringify({ schemaVersion: 1, events: [event('one', 404), event('two', 500)] }));
  assert.equal(captured.groups.length, 2);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.counts.both, 2);
    assert.notEqual(result.issues[0]!.id, result.issues[1]!.id);
  }, captured, captured);
});


test('ordering is independent of input order and manual source kinds may differ with warning', async () => {
  const a = item('a', 'Alpha');
  const z = item('z', 'Zulu');
  const baseline = analyzeErrors(manual(a, z));
  const reversed = analyzeErrors(manual(z, a));
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.deepEqual(result.issues.map(issue => issue.id), result.issues.map(issue => issue.id).sort());
    assert.deepEqual(result.issues.map(issue => issue.delta), [0, 0]);
  }, baseline, reversed);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.match(result.warnings.join(' '), /Source kinds differ/);
    assert.equal(result.baseline.coverage.frequency, result.current.coverage.frequency);
  }, analyzeErrors('Error: manual text'), analyzeErrors(manual(item('manual', 'Error: manual text'))));
});

test('retains valid doubled-slash app path in JSON and Markdown', async () => {
  const analysis = analyzeErrors(manual(item('slash', 'failure', 'r1', { page: '/foo//bar' })));
  assert.equal(analysis.groups[0]!.pagePath, '/foo//bar');
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.issues[0]!.pagePath, '/foo//bar');
    const markdown = renderComparison(result);
    assert.match(markdown, /Page: \/foo\/\/bar\n/);
    assert.ok(!markdown.includes('https://bar'));
  }, analysis, analysis);
});

test('matches raw normalized signature while safely displaying a re-redacted value', async () => {
  const first = analyzeErrors(manual(item('token', `Error: token=`)));
  assert.equal(first.groups[0]!.signature, ' | Error: token= | ');
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.counts.both, 1);
    assert.equal(result.issues[0]!.delta, 0);
    assert.match(result.issues[0]!.signature, /token=\[redacted\]/);
    assert.match(renderComparison(result), /Signature: .*token=\[redacted\]/);
  }, first, first);

  const two = analyzeErrors(manual(item('plain', `Error: token=`), item('placeholder', 'Error: token=[redacted]')));
  assert.equal(two.groups.length, 2);
  await fixture(async (base, current) => {
    const result = await compareBundles(base, current);
    assert.equal(result.counts.both, 2);
    assert.notEqual(result.issues[0]!.id, result.issues[1]!.id);
    assert.equal(new Set(result.issues.map(issue => issue.id)).size, 2);
  }, two, two);
});
