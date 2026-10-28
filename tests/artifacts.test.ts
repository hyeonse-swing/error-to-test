import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { renderReport, verifyBundle, writeBundle } from '../src/artifacts.ts';

test('report includes submitted manual reproduction, setup, and proposed steps in a verified bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-report-'));
  try {
    const manual = JSON.parse(await readFile(new URL('../examples/manual.json', import.meta.url), 'utf8'));
    manual.errors[0].preconditions = ['Signed in as a viewer'];
    manual.errors[0].steps = [
      { type: 'open', path: '/items' },
      { type: 'click', locator: { by: 'text', value: 'View item' } },
      { type: 'assertVisible', locator: { by: 'text', value: 'Item unavailable' }, visible: true },
    ];
    const source = JSON.stringify(manual);
    const analysis = analyzeErrors(source);
    const candidate = analysis.candidates[0]!;
    assert.deepEqual(candidate.reproduction, manual.errors[0].reproduction);
    assert.deepEqual(candidate.preconditions, manual.errors[0].preconditions);
    assert.deepEqual(candidate.steps, manual.errors[0].steps);

    const out = join(temp, 'result');
    await writeBundle(out, analysis);
    const report = await readFile(join(out, 'report.md'), 'utf8');
    assert.match(report, /Reported reproduction:\n```text\nOpen the item list\nClick View item when the item is missing\n```/);
    assert.match(report, /Preconditions:\n```text\nSigned in as a viewer\n```/);
    assert.ok(report.includes(`Proposed test steps:\n\`\`\`text\n${JSON.stringify(candidate.steps, null, 2)}\n\`\`\``));
    assert.deepEqual(await verifyBundle(out, { input: source }), { suite: true, reviewed: false, sourceChecked: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('report leaves missing context explicit and safely fences submitted text', () => {
  const analysis = analyzeErrors('Error: an observed failure');
  const empty = renderReport(analysis);
  assert.ok(!empty.includes('Observed stack traces (representative evidence):'));
  analysis.groups[0]!.evidence[0]!.stack = ' \n  ';
  analysis.groups[0]!.evidence[0]!.componentStack = '\t';
  assert.ok(!renderReport(analysis).includes('Observed stack traces (representative evidence):'));
  for (const heading of ['Reported reproduction:', 'Preconditions:', 'Proposed test steps:']) {
    assert.ok(empty.includes(`${heading}\n\`\`\`text\nNot supplied\n\`\`\``));
  }

  const candidate = analysis.candidates[0]!;
  candidate.reproduction = ['Open ```\n## Spoofed heading\npassword=secret123'];
  candidate.preconditions = ['Contact viewer@example.com'];
  candidate.steps = [{ type: 'act', instruction: 'Use token=secret456' }];
  const report = renderReport(analysis);
  assert.match(report, /Reported reproduction:\n````text\nOpen ```\n## Spoofed heading\npassword=\[redacted\]\n````/);
  assert.match(report, /Preconditions:\n```text\nContact \[redacted-email\]\n```/);
  assert.match(report, /Proposed test steps:\n```text\n\[/);
  assert.ok(!report.includes('secret123'));
  assert.ok(!report.includes('secret456'));
  assert.ok(!report.includes('viewer@example.com'));
});

test('report shows distinct sampled stacks once per field and verifies the bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-stacks-'));
  try {
    const first = 'TypeError\n    at render (/app.js:10:2)\n    at ParentA (/a.js:1:1)';
    const second = 'TypeError\n    at render (/app.js:10:2)\n    at ParentB (/b.js:2:2)';
    const react = '    at Widget (/Widget.tsx:4:2)';
    const source = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
      { id: 'one', message: 'TypeError: broken item', type: 'javascript', stack: first, componentStack: react },
      { id: 'two', message: 'TypeError: broken item', type: 'javascript', stack: first, componentStack: react },
      { id: 'three', message: 'TypeError: broken item', type: 'javascript', stack: second, componentStack: react },
    ] });
    const analysis = analyzeErrors(source);
    assert.equal(analysis.groups.length, 1);
    const report = renderReport(analysis);
    assert.equal(report.split('Observed stack traces (representative evidence):').length - 1, 1);
    assert.equal(report.split(first).length - 1, 1);
    assert.equal(report.split(second).length - 1, 1);
    assert.equal(report.split(react).length - 1, 1);
    assert.equal(report.split('Error stack:').length - 1, 2);
    assert.equal(report.split('React component stack:').length - 1, 1);
    assert.ok(report.indexOf('Observed stack traces (representative evidence):') < report.indexOf('### '));
    const out = join(temp, 'result');
    await writeBundle(out, analysis);
    assert.deepEqual(await verifyBundle(out, { input: source }), { suite: true, reviewed: false, sourceChecked: true });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('report summary counts candidate states in fixture, empty, and manual analyses', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-summary-'));
  try {
    const input = await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8');
    const profile = await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8');
    const analysis = analyzeErrors(input, { profile });
    const summary = 'Groups: 3 · TC candidates: 3\nDraft TC candidates: 2 · Need context: 1';
    assert.ok(renderReport(analysis).includes(summary));

    const out = join(temp, 'result');
    await writeBundle(out, analysis);
    const bundleReport = await readFile(join(out, 'report.md'), 'utf8');
    assert.ok(bundleReport.includes(summary));
    assert.deepEqual(await verifyBundle(out, { input, profile }), { suite: true, reviewed: false, sourceChecked: true });

    const empty = analyzeErrors(input, { page: '/not-in-the-fixture' });
    assert.equal(empty.groups.length, 0);
    assert.equal(empty.candidates.length, 0);
    assert.ok(renderReport(empty).includes('Groups: 0 · TC candidates: 0\nDraft TC candidates: 0 · Need context: 0'));

    const manual = analyzeErrors('Error: an observed failure');
    assert.equal(manual.candidates.length, 1);
    assert.equal(manual.candidates[0]!.state, 'needs-context');
    assert.ok(renderReport(manual).includes('Groups: 1 · TC candidates: 1\nDraft TC candidates: 0 · Need context: 1'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('report summary counts matching profile scenarios as candidates, not groups', async () => {
  const input = await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8');
  const profile = JSON.parse(await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8'));
  profile.scenarios[1].match = profile.scenarios[0].match;
  const analysis = analyzeErrors(input, { profile, page: 'http://127.0.0.1:4179/items' });
  assert.equal(analysis.groups.length, 1);
  assert.equal(analysis.candidates.length, 2);
  assert.ok(analysis.candidates.every((candidate) => candidate.state === 'draft'));
  assert.ok(renderReport(analysis).includes('Groups: 1 · TC candidates: 2\nDraft TC candidates: 2 · Need context: 0'));
});

test('report redacts and fences untrusted stack evidence', () => {
  const analysis = analyzeErrors('Error: an observed failure');
  const evidence = analysis.groups[0]!.evidence[0]!;
  evidence.stack = 'Error ```\n token=secret123 viewer@example.com https://user:pass@example.com/private?q=secret';
  evidence.componentStack = '```\n at Widget token=secret456';
  const report = renderReport(analysis);
  assert.match(report, /Error stack:\n````text\nError ```\n token=\[redacted\] \[redacted-email\]/);
  assert.match(report, /React component stack:\n````text\n```\n at Widget token=\[redacted\]/);
  assert.ok(report.includes('https://example.com/private'));
  for (const secret of ['secret123', 'secret456', 'viewer@example.com', 'user:pass', '?q=secret']) {
    assert.ok(!report.includes(secret));
  }
});

test('bundle writes Flow QA layout, verifies source bytes and preserves existing output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-bundle-'));
  try {
    const source = 'TypeError: item is undefined\n    at renderItem (/app.js:10:2)';
    const analysis = analyzeErrors(source, { page: '/items', runtime: 'browser' });
    const out = join(temp, 'result');
    const paths = await writeBundle(out, analysis);
    assert.ok(paths.some(path => path.endsWith('cases/error-to-test.json')));
    assert.deepEqual(await verifyBundle(out, { input: source }), { suite: true, reviewed: false, sourceChecked: true });
    await assert.rejects(writeBundle(out, analysis), /already exists/);
    await assert.rejects(verifyBundle(out, { input: `${source}\nchanged` }), /Input changed/);
    const suite = JSON.parse(await readFile(join(out, 'cases/error-to-test.json'), 'utf8'));
    assert.equal(suite.source.file, 'flows/error-to-test.md');
    assert.ok(suite.cases.every((item: { questions: string[] }) => item.questions.length));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a JSON bundle verifies the original BOM bytes and rejects a stripped source', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-bom-'));
  try {
    const json = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: 'Error: an observed failure' }] });
    const source = `\uFEFF${json}`;
    const out = join(temp, 'result');
    await writeBundle(out, analyzeErrors(source));
    assert.deepEqual(await verifyBundle(out, { input: source }), { suite: true, reviewed: false, sourceChecked: true });
    await assert.rejects(verifyBundle(out, { input: json }), /STALE_BUNDLE: Input changed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a profile BOM bundle verifies the original profile and rejects a stripped profile', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-profile-bom-'));
  try {
    const input = await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8');
    const profile = await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8');
    const bomProfile = `\uFEFF${profile}`;
    const out = join(temp, 'result');
    await writeBundle(out, analyzeErrors(input, { profile: bomProfile }));
    assert.deepEqual(await verifyBundle(out, { input, profile: bomProfile }), { suite: true, reviewed: false, sourceChecked: true });
    await assert.rejects(verifyBundle(out, { input, profile }), /STALE_BUNDLE: Profile changed/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

for (const name of ['analysis.json', 'report.md', 'flows/error-to-test.md', 'cases/error-to-test.json']) {
  test(`verification rejects altered ${name}`, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'error-to-test-stale-'));
    try {
      const out = join(temp, 'result');
      await writeBundle(out, analyzeErrors('Error: an observed failure'));
      await writeFile(join(out, name), 'altered');
      await assert.rejects(verifyBundle(out), /STALE_BUNDLE/);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
}
