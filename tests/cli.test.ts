import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
function run(args: string[], input?: string) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, timeout: 15000 }); }
test('options require a command; bare invocation and help remain available', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-command-'));
  try {
    for (const [name, options] of [
      ['error', ['--error', 'TypeError: missing item']],
      ['input', ['--input', join(temp, 'missing.json')]],
      ['reviewed', ['--reviewed']],
    ] as const) {
      const out = join(temp, name);
      const result = run([...options, '--out', out]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /A command is required/);
      assert.equal(result.stdout, '');
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    for (const args of [[], ['--help'], ['-h']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /error-to-test analyze/);
      assert.equal(result.stderr, '');
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('global version aliases print the package version without a command', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  for (const option of ['--version', '-v']) {
    const result = run([option]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
    assert.equal(result.stderr, '');
  }
});
test('standalone error input produces a traceable blocked TC without SDK or model', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-'));
  try {
    const out = join(temp, 'direct');
    const result = run(['analyze', '--error', 'TypeError: item is undefined', '--page', '/items', '--runtime', 'browser', '--reproduce', 'Click View item', '--expected', 'The empty state appears', '--expected-source', 'Reporter', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.coverage.frequency, 'submitted-reports');
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0].state, 'needs-context');
    assert.equal(analysis.candidates[0].expected.text, 'The empty state appears');
    assert.equal(analysis.groups[0].lastOccurredAt, undefined);
    assert.equal(run(['verify', out]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('plain text file and piped input share the manual input path', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-text-'));
  try {
    const text = '[ERROR] Could not render the detail panel\n    at render (/app.js:3:2)';
    const file = join(temp, 'error.txt');
    await writeFile(file, text);
    for (const [name, args, input] of [
      ['file', ['--input', file, '--format', 'text'], undefined],
      ['stdin', ['--input', '-', '--format', 'text'], text],
    ] as const) {
      const out = join(temp, name);
      const result = run(['analyze', ...args, '--out', out], input);
      assert.equal(result.status, 0, result.stderr);
      const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
      assert.equal(analysis.coverage.kind, 'manual-text');
      assert.equal(analysis.candidates.length, 1);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('invalid and ambiguous CLI input fails with no output and redacted errors', () => {
  assert.equal(run(['analyze', '--error', 'x', '--input', 'x']).status, 1);
  assert.equal(run(['analyze', '--error', 'x', '--top', '0']).status, 1);
  assert.equal(run(['analyze', '--input', '-', '--format', 'json'], '{broken').status, 1);
  assert.equal(run(['analyze', '--error', 'x', '--unknown-flag']).status, 1);
  assert.equal(run(['--help']).status, 0);
});

test('min-count produces a verifiable bundle without a suite when no group qualifies', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-min-count-'));
  try {
    const out = join(temp, 'filtered');
    const result = run(['analyze', '--error', 'Error: observed failure', '--min-count', '2', '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.groups.length, 1);
    assert.equal(analysis.candidates.length, 0);
    assert.match(await readFile(join(out, 'report.md'), 'utf8'), /at least 2 supplied records per group/);
    await assert.rejects(stat(join(out, 'cases/error-to-test.json')), { code: 'ENOENT' });
    const verified = run(['verify', out]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Suite: none/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('CLI min-count validates through analysis before creating output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-min-count-invalid-'));
  try {
    for (const value of ['0', '-1', '10001', '1.5', 'NaN', 'Infinity']) {
      const out = join(temp, value);
      const result = run(['analyze', '--error', 'Error: observed failure', `--min-count=${value}`, '--out', out]);
      assert.equal(result.status, 1, `${value}: ${result.stderr}`);
      assert.match(result.stderr, /minCount must be an integer between 1 and 10000/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const valid = run(['analyze', '--error', 'Error: observed failure', '--min-count', '10000', '--out', join(temp, 'valid')]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(run(['--help']).stdout, /after dedup\/date filtering/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
