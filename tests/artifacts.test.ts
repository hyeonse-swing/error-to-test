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
