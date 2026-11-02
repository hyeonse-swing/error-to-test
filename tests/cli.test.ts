import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

test('init-profile guides manual and browser bundles through explicit review gates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-profile-template-'));
  try {
    const browserExample = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const inputs = [
      { name: 'manual', content: JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: 'Detail panel failed', page: '/items', runtime: 'browser' }] }) },
      { name: 'browser', content: JSON.stringify({ ...browserExample, events: [browserExample.events[0]] }) },
    ];
    for (const { name, content } of inputs) {
      const input = join(temp, `${name}.json`);
      const initial = join(temp, `${name}-initial`);
      const profileFile = join(temp, name, 'profile.json');
      await writeFile(input, content);
      assert.equal(run(['analyze', '--input', input, '--out', initial]).status, 0);
      const init = run(['init-profile', initial, '--out', profileFile]);
      assert.equal(init.status, 0, init.stderr);
      assert.match(init.stdout, /Fill requirement, expectedSource, preconditions, and steps/);
      assert.match(init.stdout, /original input and --profile/);
      const profile = JSON.parse(await readFile(profileFile, 'utf8'));
      assert.equal(profile.scenarios.length, 1);
      const scenario = profile.scenarios[0];
      const original = JSON.parse(await readFile(join(initial, 'analysis.json'), 'utf8'));
      assert.deepEqual(scenario.match, { groupId: original.candidates[0].groupId });
      assert.equal(scenario.requirement, '');
      assert.equal(scenario.expectedSource, '');
      assert.equal(scenario.setupConfirmed, false);
      assert.ok(scenario.questions.length > 0);
      assert.deepEqual(scenario.steps, [{ type: 'open', path: '/items' }]);
      const incomplete = join(temp, `${name}-incomplete`);
      const incompleteRun = run(['analyze', '--input', input, '--profile', profileFile, '--out', incomplete]);
      assert.equal(incompleteRun.status, 1);
      await assert.rejects(stat(incomplete), { code: 'ENOENT' });
      scenario.requirement = 'The item unavailable status appears after opening the item.';
      scenario.expectedSource = 'Reviewed product requirement';
      scenario.preconditions = ['Signed in to the demo application'];
      scenario.setupConfirmed = true;
      scenario.questions = [];
      scenario.steps.push({ type: 'click', locator: { by: 'role', value: 'button', name: 'View item' } });
      scenario.steps.push({ type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'Item unavailable', match: 'equals' });
      await writeFile(profileFile, JSON.stringify(profile));
      const draft = join(temp, `${name}-draft`);
      const draftRun = run(['analyze', '--input', input, '--profile', profileFile, '--out', draft]);
      assert.equal(draftRun.status, 0, draftRun.stderr);
      assert.equal(JSON.parse(await readFile(join(draft, 'analysis.json'), 'utf8')).candidates[0].state, 'draft');
      const blocked = JSON.parse(await readFile(join(draft, 'cases/error-to-test.json'), 'utf8'));
      assert.match(blocked.cases[0].questions.join(' '), /Review this draft/);
      assert.equal(run(['verify', draft, '--input', input, '--profile', profileFile]).status, 0);
      const reviewed = join(temp, `${name}-reviewed`);
      assert.equal(run(['analyze', '--input', input, '--profile', profileFile, '--reviewed', '--out', reviewed]).status, 0);
      const runnable = JSON.parse(await readFile(join(reviewed, 'cases/error-to-test.json'), 'utf8'));
      assert.deepEqual(runnable.cases[0].questions, []);
      assert.equal(run(['verify', reviewed, '--input', input, '--profile', profileFile]).status, 0);
      const before = await readFile(profileFile, 'utf8');
      const regenerate = run(['init-profile', initial, '--out', profileFile]);
      assert.equal(regenerate.status, 1);
      assert.match(regenerate.stderr, /already exists/);
      assert.equal(await readFile(profileFile, 'utf8'), before);
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('init-profile refuses stale, empty, and invalid requests before writing a file', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-init-invalid-'));
  try {
    const source = join(temp, 'source.json');
    await writeFile(source, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: 'Failure', page: '/items' }] }));
    const bundle = join(temp, 'bundle');
    assert.equal(run(['analyze', '--input', source, '--out', bundle]).status, 0);
    const target = join(temp, 'generated', 'profile.json');
    assert.equal(run(['init-profile', bundle, '--out', temp]).status, 1);
    const existing = join(temp, 'existing.json');
    await writeFile(existing, 'keep me');
    const link = join(temp, 'profile-link.json');
    await symlink(existing, link);
    assert.equal(run(['init-profile', bundle, '--out', link]).status, 1);
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    for (const args of [
      ['init-profile', bundle], ['init-profile', bundle, '--out', target, 'extra'],
      ['init-profile', bundle, '--out', target, '--input', source],
      ['init-profile', bundle, '--out', target, '--reviewed'],
      ['init-profile', bundle, '--out', target, '--min-count', '2'],
      ['init-profile', bundle, '--out', target, '--report', source],
    ]) {
      assert.equal(run(args).status, 1, args.join(' '));
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    const filtered = join(temp, 'filtered');
    assert.equal(run(['analyze', '--input', source, '--min-count', '2', '--out', filtered]).status, 0);
    assert.equal(run(['init-profile', filtered, '--out', target]).status, 1);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    const report = join(bundle, 'report.md');
    const originalReport = await readFile(report, 'utf8');
    await writeFile(report, 'tampered report');
    const stale = run(['init-profile', bundle, '--out', target]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(report, originalReport);
    const analysisFile = join(bundle, 'analysis.json');
    await writeFile(analysisFile, '{}');
    const staleAnalysis = run(['init-profile', bundle, '--out', target]);
    assert.equal(staleAnalysis.status, 1);
    assert.match(staleAnalysis.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
