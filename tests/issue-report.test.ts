import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors, analyzeWithBaseline, readIssueReport } from '../src/index.ts';
import { jsonText, readVerifiedBundle, writeBundle } from '../src/artifacts.ts';
import { hash } from '../src/validation.ts';

const manual = (...errors: Record<string, unknown>[]) =>
  JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors });
const item = (id: string, message: string, extra: Record<string, unknown> = {}) => ({
  id, message, project: 'demo', environment: 'test', release: 'r1', runtime: 'browser', type: 'javascript',
  page: '/items', occurredAt: '2026-10-10T00:00:00Z', ...extra,
});

async function rehashReport(directory: string, report: string): Promise<void> {
  const provenancePath = join(directory, 'provenance.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  provenance.reportSha256 = hash(report);
  await writeFile(join(directory, 'report.md'), report);
  await writeFile(provenancePath, jsonText(provenance));
}

test('returns the exact saved group detail with whole-bundle coverage and leaves source files unchanged', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-report-'));
  try {
    const first = item('first', 'Error: first-only', { stack: 'FIRST_STACK', reproduction: ['Open items'],
      expected: 'Items appear', expectedSource: 'Product requirement',
      steps: [{ type: 'open', path: '/items' }, { type: 'assertVisible', locator: { by: 'text', value: 'Items' }, visible: true }] });
    const second = item('second', 'Error: second-only', { stack: 'SECOND_STACK' });
    const source = manual(first, first, second, item('filtered', 'Error: filtered-only', { environment: 'prod' }));
    const profile = JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'demo', scenarios: [] });
    const analysis = analyzeErrors(source, { environment: 'test', from: '2026-10-01T00:00:00Z', profile });
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis, { reviewed: true });
    const files = ['analysis.json', 'report.md', 'provenance.json', 'flows/error-to-test.md', 'cases/error-to-test.json'];
    const before = await Promise.all(files.map(file => readFile(join(directory, file))));
    const target = analysis.groups[0]!;
    const other = analysis.groups[1]!;
    const output = await readIssueReport(directory, target.id);
    const saved = before[1]!.toString('utf8');
    const start = saved.indexOf(`## ${target.id}\n`);
    const end = saved.indexOf(`## ${other.id}\n`, start + 1);
    const expectedDetail = saved.slice(start, end).replace(/[\r\n]+$/, '');
    assert.equal(output.slice(output.indexOf(`## ${target.id}\n`)).replace(/[\r\n]+$/, ''), expectedDetail);
    assert.match(output, /^# Error to Test issue report\n/);
    assert.match(output, new RegExp(`Group ID: ${target.id}`));
    assert.match(output, /Included groups: 1 of 2/);
    assert.match(output, /Selected TC candidates: 1/);
    assert.match(output, /Review acknowledgement: yes/);
    assert.match(output, /Source input SHA-256: [0-9a-f]{64}/);
    assert.match(output, /Source analysis SHA-256: [0-9a-f]{64}/);
    assert.match(output, /Source report SHA-256: [0-9a-f]{64}/);
    assert.match(output, /Source profile SHA-256: [0-9a-f]{64}/);
    assert.match(output, /Source suite SHA-256: [0-9a-f]{64}/);
    assert.match(output, /## Source coverage \(whole original bundle\)/);
    assert.match(output, /Input records: 4\nDuplicate records: 1\nFiltered records: 1/);
    assert.match(output, /Period from: 2026-10-01T00:00:00.000Z/);
    assert.match(output, /Partial export: no\nRetention coverage: unknown/);
    assert.match(output, /not error rates, affected-user counts, or complete collection/);
    assert.match(output, /Original raw input bytes were not independently rechecked/);
    assert.match(output, /use readiness for actual exported blockers/);
    assert.match(output, /does not establish execution, approval, or issue resolution/);
    assert.match(output, /Observed facts:|Observed stack traces/);
    assert.match(output, /Questions:/);
    assert.ok(!output.includes(other.message));
    assert.ok(!output.includes(other.evidence[0]?.stack ?? 'SECOND_STACK'));
    assert.ok(!output.includes('## Profile refinement'));
    assert.ok(!output.includes('## Explicit group selection'));
    const after = await Promise.all(files.map(file => readFile(join(directory, file))));
    assert.deepEqual(after, before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('unselected groups remain exportable without selecting or generating candidates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-unselected-'));
  try {
    const errors = [item('one', 'Error: one-only'), item('two', 'Error: two-only')];
    const source = manual(...errors);
    const all = analyzeErrors(source);
    const target = all.groups[1]!;
    const other = all.groups[0]!;
    const selected = [
      analyzeErrors(source, { top: 1 }),
      analyzeErrors(source, { minCount: 2 }),
      analyzeErrors(source, { groupIds: [other.id] }),
    ];
    const baseline = join(temp, 'baseline');
    await writeBundle(baseline, analyzeErrors(manual(errors.find(error => error.message === other.message)!)));
    selected.push(await analyzeWithBaseline(source, baseline));
    for (const [index, analysis] of selected.entries()) {
      const requested = index === 3 ? other : target;
      const directory = join(temp, `bundle-${index}`);
      await writeBundle(directory, analysis);
      const output = await readIssueReport(directory, requested.id);
      assert.match(output, /Included groups: 1 of 2/);
      assert.match(output, /Selected TC candidates: 0/);
      assert.match(output, /No selected TC candidates for this group\./);
      assert.ok(output.includes(requested.message));
      assert.ok(!output.includes((index === 3 ? target : other).message));
      assert.ok(!output.includes('### TC_'));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('rejects zero-group, unknown, and malformed IDs without echoing the request', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-ids-'));
  try {
    const empty = join(temp, 'empty');
    await writeBundle(empty, analyzeErrors(manual(item('one', 'Error: one')), { environment: 'other' }));
    const known = join(temp, 'known');
    await writeBundle(known, analyzeErrors(manual(item('one', 'Error: one'))));
    for (const [directory, requested] of [
      [empty, 'group-0000000000000000'], [known, 'group-0000000000000000'],
      [known, 'group-0000000000000000\ntoken=secret123'], [known, 'GROUP-0000000000000000'],
    ]) {
      await assert.rejects(readIssueReport(directory!, requested!), error => {
        assert.doesNotMatch((error as Error).message, /0000000000000000|secret123/);
        return true;
      });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('recognizes dynamic backtick and tilde fences, and copies redacted saved detail without splitting on injected headers', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-fences-'));
  try {
    const injected = 'Error: visible-only\n```\n## group-0000000000000000\n````\n~~~\npassword=secret123';
    const analysis = analyzeErrors(manual(item('injected', injected), item('other', 'Error: other-only')));
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis);
    const injectedGroup = analysis.groups.find(group => group.message.includes('visible-only'))!;
    const output = await readIssueReport(directory, injectedGroup.id);
    assert.match(output, /`````text\ndemo \/ test \/ r1 \/ browser\njavascript \/items\nError: visible-only\n```\n## group-0000000000000000\n````/);
    assert.ok(!output.includes('secret123'));
    assert.match(output, /password=\[redacted\]/);
    assert.match(output, /Questions:/);

    const first = analysis.groups[0]!;
    const second = analysis.groups[1]!;
    const original = await readFile(join(directory, 'report.md'), 'utf8');
    const changed = original.replace(`## ${second.id}\n`, `~~~text\n## group-0000000000000000\n~~~~\n## ${second.id}\n`);
    assert.notEqual(changed, original);
    await rehashReport(directory, changed);
    const excerpt = await readIssueReport(directory, first.id);
    assert.ok(excerpt.includes('~~~text\n## group-0000000000000000\n~~~~'));
    assert.ok(!excerpt.includes(second.message));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('rejects stale source artifacts and rehashed malformed or unclosed report layouts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-layout-'));
  try {
    const analysis = analyzeErrors(manual(item('one', 'Error: one-only'), item('two', 'Error: two-only')));
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis);
    const target = analysis.groups[0]!.id;
    const original = await readFile(join(directory, 'report.md'), 'utf8');
    await writeFile(join(directory, 'report.md'), `${original}tampered`);
    await assert.rejects(readIssueReport(directory, target), /STALE_BUNDLE/);
    for (const changed of [
      original.replace(`## ${target}\n`, `### ${target}\n`),
      original.replace(`## ${target}\n`, `## group-0000000000000000\n## ${target}\n`),
      `${original}\n~~~text\n## group-0000000000000000\n`,
    ]) {
      await rehashReport(directory, changed);
      await assert.rejects(readIssueReport(directory, target), /group header layout|unclosed code fence/);
    }
    await rehashReport(directory, original);
    const snapshot = await readVerifiedBundle(directory);
    assert.equal(snapshot.report, original);
    await writeFile(join(directory, 'report.md'), 'replaced after snapshot');
    assert.equal(snapshot.report, original);
    await assert.rejects(readIssueReport(directory, target), /STALE_BUNDLE/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('preserves more than one thousand original warnings without treating them as group headings', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-warnings-'));
  try {
    const analysis = analyzeErrors(manual(item('one', 'Error: one-only')));
    analysis.warnings.push(...Array.from({ length: 1001 }, (_, index) => `Warning ${index}: \`\`\`\n## group-0000000000000000 token=secret123`));
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis);
    const output = await readIssueReport(directory, analysis.groups[0]!.id);
    assert.match(output, /Warning 1000:/);
    assert.ok(!output.includes('secret123'));
    assert.match(output, /## Original analysis warnings/);
    assert.match(output, /## group-0000000000000000 token=\[redacted\]/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('accepts a verified bundle with an existing Flow QA compatible custom candidate ID', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-case-id-'));
  try {
    const analysis = analyzeErrors(manual(item('one', 'Error: one-only')));
    analysis.candidates[0]!.id = 'TC_second';
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis);
    const output = await readIssueReport(directory, analysis.groups[0]!.id);
    assert.match(output, /Selected TC candidates: 1/);
    assert.match(output, /### TC_second/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('labels a partial browser export as coverage of the whole original bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-partial-'));
  try {
    const source = await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8');
    const analysis = analyzeErrors(source, { top: 1 });
    const unselected = analysis.groups.find(group => !analysis.candidates.some(candidate => candidate.groupId === group.id))!;
    const directory = join(temp, 'bundle');
    await writeBundle(directory, analysis);
    const output = await readIssueReport(directory, unselected.id);
    assert.match(output, /## Source coverage \(whole original bundle\)/);
    assert.match(output, /Kind: browser-error-json\nFrequency: captured-events\nPartial export: yes\nRetention coverage: unknown\nInput records: 4/);
    assert.match(output, /Selected TC candidates: 0/);
    assert.match(output, /Source export is partial; observed counts may be incomplete/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
