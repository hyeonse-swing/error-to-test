import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeErrors } from '../src/analysis.ts';
import { verifyBundle, writeBundle } from '../src/artifacts.ts';

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
