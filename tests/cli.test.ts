import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
function run(args: string[], input?: string | Buffer) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, timeout: 15000 }); }
async function runWithClosedStdout(args: string[]): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.destroy();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', status => resolveRun({ status, stderr }));
  });
}
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

test('repeated manual JSON inputs combine before selection and verify their ordered originals', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-multi-cli-'));
  try {
    const first = join(temp, 'first.json');
    const second = join(temp, 'second.json');
    const firstText = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
      { id: 'shared', message: 'Error: repeated', page: '/same' },
      { id: 'other', message: 'Error: other', page: '/other' },
    ] });
    const secondText = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
      { id: 'shared', message: 'Error: repeated', page: '/same' },
      { id: 'third', message: 'Error: repeated', page: '/same' },
    ] });
    await writeFile(first, firstText);
    await writeFile(second, secondText);
    const single = join(temp, 'single');
    assert.equal(run(['analyze', '--input', first, '--out', single]).status, 0);
    const singleAnalysis = JSON.parse(await readFile(join(single, 'analysis.json'), 'utf8'));
    assert.equal(singleAnalysis.source.sha256, createHash('sha256').update(firstText).digest('hex'));
    assert.equal(singleAnalysis.source.inputs, undefined);
    assert.equal(run(['verify', single, '--input', first]).status, 0);
    const out = join(temp, 'multi');
    const analyzed = run(['analyze', '--input', first, '--input', second, '--min-count', '2', '--top', '1', '--out', out]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.coverage.kind, 'manual-json');
    assert.equal(analysis.coverage.inputCount, 4);
    assert.equal(analysis.coverage.duplicates, 1);
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.groups[0].count, 2);
    assert.deepEqual(analysis.source.inputs, [firstText, secondText].map(content => ({
      sha256: createHash('sha256').update(content).digest('hex'), byteLength: Buffer.byteLength(content),
    })));
    assert.equal(JSON.stringify(analysis).includes(first), false);
    assert.equal(JSON.stringify(analysis).includes(second), false);
    const verified = run(['verify', out, '--input', first, '--input', second]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /original input: checked/);
    for (const args of [['--input', second, '--input', first], ['--input', first]]) {
      const result = run(['verify', out, ...args]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /STALE_BUNDLE/);
    }
    await writeFile(second, `${secondText} `);
    const changed = run(['verify', out, '--input', first, '--input', second]);
    assert.equal(changed.status, 1, changed.stderr);
    assert.match(changed.stderr, /STALE_BUNDLE/);
    await rm(second);
    assert.equal(run(['verify', out, '--input', first, '--input', second]).status, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('explicit manual JSONL combines BOM and CRLF files with ordered source fingerprints', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-jsonl-cli-'));
  try {
    const first = join(temp, 'first.jsonl');
    const second = join(temp, 'second.jsonl');
    const shared = { id: 'shared', message: 'Error: repeated', page: '/same' };
    const firstText = `\uFEFF${JSON.stringify(shared)}\r\n\r\n${JSON.stringify({ id: 'other', message: 'Error: other', page: '/other' })}\r\n`;
    const secondText = `${JSON.stringify(shared)}\n${JSON.stringify({ id: 'third', message: 'Error: repeated', page: '/same' })}\n`;
    await writeFile(first, firstText);
    await writeFile(second, secondText);
    const out = join(temp, 'bundle');
    const analyzed = run(['analyze', '--input', first, '--input', second, '--format', 'jsonl', '--min-count', '2', '--top', '1', '--out', out]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const analysis = JSON.parse(await readFile(join(out, 'analysis.json'), 'utf8'));
    assert.equal(analysis.coverage.kind, 'manual-jsonl');
    assert.equal(analysis.coverage.frequency, 'submitted-reports');
    assert.equal(analysis.coverage.inputCount, 4);
    assert.equal(analysis.coverage.duplicates, 1);
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.groups[0].count, 2);
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0].groupId, analysis.groups[0].id);
    const inputs = [firstText, secondText].map(content => ({
      sha256: createHash('sha256').update(content).digest('hex'), byteLength: Buffer.byteLength(content),
    }));
    assert.deepEqual(analysis.source.inputs, inputs);
    assert.equal(analysis.source.sha256, createHash('sha256').update(JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs })).digest('hex'));
    const verified = run(['verify', out, '--input', first, '--input', second]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /original input: checked/);
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8'));
    assert.equal(typeof provenance.analysisSha256, 'string');
    assert.equal(run(['verify', out, '--input', second, '--input', first]).status, 1);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('explicit SDK JSONL from stdin matches file analysis and auto does not detect JSONL', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-jsonl-stdin-'));
  try {
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const content = `${JSON.stringify(example.events[0])}\n${JSON.stringify({ ...example.events[0], eventId: 'second', viewId: 'second' })}\n`;
    const file = join(temp, 'events.jsonl');
    await writeFile(file, content);
    const fileOut = join(temp, 'file');
    const stdinOut = join(temp, 'stdin');
    assert.equal(run(['analyze', '--input', file, '--format', 'jsonl', '--out', fileOut]).status, 0);
    assert.equal(run(['analyze', '--input', '-', '--format', 'jsonl', '--out', stdinOut], content).status, 0);
    const fileAnalysis = JSON.parse(await readFile(join(fileOut, 'analysis.json'), 'utf8'));
    const stdinAnalysis = JSON.parse(await readFile(join(stdinOut, 'analysis.json'), 'utf8'));
    assert.deepEqual(stdinAnalysis, fileAnalysis);
    assert.equal(fileAnalysis.coverage.kind, 'browser-error-jsonl');
    assert.equal(fileAnalysis.coverage.frequency, 'captured-events');
    assert.equal(fileAnalysis.source.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(run(['verify', fileOut, '--input', file]).status, 0);
    const autoOut = join(temp, 'auto');
    const auto = run(['analyze', '--input', file, '--out', autoOut]);
    assert.equal(auto.status, 1, auto.stderr);
    await assert.rejects(stat(autoOut), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('JSONL line errors and unsupported format contexts create no output or leak source text', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-jsonl-invalid-'));
  try {
    const marker = 'private-marker-9341';
    const file = join(temp, 'bad.jsonl');
    for (const [name, content, line] of [
      ['malformed', `{"message":"okay"}\n{${marker}\n`, 2],
      ['invalid-record', `\n{"message":"okay"}\n{"message":42,"secret":"${marker}"}\n`, 3],
    ] as const) {
      await writeFile(file, content);
      const out = join(temp, name);
      const result = run(['analyze', '--input', file, '--format', 'jsonl', '--out', out]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`(?:file|input)\\s*1.*line\\s*${line}|line\\s*${line}.*(?:file|input)\\s*1`, 'i'));
      assert.equal(result.stderr.includes(marker), false);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const direct = run(['analyze', '--error', 'Error: direct', '--format', 'jsonl', '--out', join(temp, 'direct')]);
    assert.equal(direct.status, 1);
    assert.match(direct.stderr, /--format applies to --input/);
    for (const command of ['results', 'compare']) {
      const args = command === 'results' ? ['results', temp] : ['compare', temp, temp];
      const result = run([...args, '--format', 'jsonl']);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--format must be text or json/);
    }
    assert.match(run(['--help']).stdout, /JSONL requires explicit selection/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('repeated input rejects invalid source sets before creating output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-multi-invalid-'));
  try {
    const first = join(temp, 'first.json');
    const second = join(temp, 'second.json');
    await writeFile(first, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ id: 'x', message: 'Error: first' }] }));
    await writeFile(second, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ id: 'x', message: 'Error: changed' }] }));
    const largeA = join(temp, 'large-a.txt');
    const largeB = join(temp, 'large-b.txt');
    await writeFile(largeA, 'a'.repeat(6 * 1024 * 1024));
    await writeFile(largeB, 'b'.repeat(6 * 1024 * 1024));
    const cases: string[][] = [
      ['--input', first, '--input', second],
      ['--error', 'Error: direct', '--input', first, '--input', second],
      ['--input', first, '--input', join(temp, 'sdk.json')],
      ['--input', first, '--input', 'missing-file.json'],
      ['--input', first, '--input', join(temp, 'empty.txt')],
      ['--input', first, '--input', '   '],
      ['--input', first, '--input', '-', '--format', 'json'],
      ['--input', '-', '--input', '-', '--format', 'text'],
      ['--input', largeA, '--input', largeB, '--format', 'text'],
      Array.from({ length: 51 }, () => ['--input', first]).flat(),
    ];
    await writeFile(join(temp, 'sdk.json'), JSON.stringify({ schemaVersion: 1, events: [{
      schemaVersion: 1, eventId: 'e1', project: 'shop', environment: 'prod', release: 'r1', sdkVersion: '0.1.5',
      occurredAt: '2026-10-13T12:00:00Z', viewId: 'v1', sequence: 1, elapsedMs: 42,
      type: 'javascript', message: 'Error: browser', page: '/items', runtime: 'browser',
    }] }));
    await writeFile(join(temp, 'empty.txt'), '');
    for (const [index, args] of cases.entries()) {
      const out = join(temp, `invalid-${index}`);
      const result = run(['analyze', ...args, '--out', out], 'piped text');
      assert.equal(result.status, 1, `${index}: ${result.stderr}`);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const verifyStdin = run(['verify', temp, '--input', '-'], 'piped text');
    assert.equal(verifyStdin.status, 1);
    assert.match(verifyStdin.stderr, /verify --input - is not supported/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('invalid UTF-8 bytes in files and stdin never produce or verify a bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-invalid-utf8-'));
  try {
    const first = join(temp, 'first.txt');
    const second = join(temp, 'second.txt');
    await writeFile(first, 'Error: first');
    await writeFile(second, 'Error: second');
    const bundle = join(temp, 'bundle');
    const analyzed = run(['analyze', '--input', first, '--input', second, '--format', 'text', '--out', bundle]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal(run(['verify', bundle, '--input', first, '--input', second]).status, 0);

    for (const byte of [0x80, 0x81]) {
      const invalid = Buffer.concat([Buffer.from('Error: '), Buffer.from([byte])]);
      await writeFile(second, invalid);
      const out = join(temp, `invalid-${byte}`);
      const fileAnalyze = run(['analyze', '--input', first, '--input', second, '--format', 'text', '--out', out]);
      assert.equal(fileAnalyze.status, 1, fileAnalyze.stderr);
      assert.match(fileAnalyze.stderr, /valid UTF-8/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
      const verified = run(['verify', bundle, '--input', first, '--input', second]);
      assert.equal(verified.status, 1, verified.stderr);
      assert.match(verified.stderr, /valid UTF-8/);
      const stdinOut = join(temp, `stdin-${byte}`);
      const stdinAnalyze = run(['analyze', '--input', '-', '--format', 'text', '--out', stdinOut], invalid);
      assert.equal(stdinAnalyze.status, 1, stdinAnalyze.stderr);
      assert.match(stdinAnalyze.stderr, /valid UTF-8/);
      await assert.rejects(stat(stdinOut), { code: 'ENOENT' });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
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

test('init-profile extends a JSONL profile without changing prior rules or approving new cases', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-profile-extend-'));
  try {
    const input = join(temp, 'events.jsonl');
    const old = { message: 'Error: old panel', page: '/old', release: 'old', runtime: 'browser' };
    const fresh = { message: 'Error: new panel', page: '/new', release: 'new', runtime: 'browser' };
    await writeFile(input, `${JSON.stringify(old)}\n`);
    const firstBundle = join(temp, 'first');
    assert.equal(run(['analyze', '--input', input, '--format', 'jsonl', '--out', firstBundle]).status, 0);
    const existing = join(temp, 'existing.json');
    assert.equal(run(['init-profile', firstBundle, '--out', existing]).status, 0);
    const original = JSON.parse(await readFile(existing, 'utf8'));
    const oldRule = original.scenarios[0];
    oldRule.requirement = 'The old panel explains the error.';
    oldRule.expectedSource = 'Reviewed local contract';
    oldRule.preconditions = ['Local demo is open'];
    oldRule.setupConfirmed = true;
    oldRule.questions = [];
    oldRule.steps.push({ type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'Old panel error', match: 'equals' });
    original.name = 'Existing app profile';
    await writeFile(existing, JSON.stringify(original));
    const existingBytes = await readFile(existing);
    await writeFile(input, `${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`);
    const nextBundle = join(temp, 'next');
    assert.equal(run(['analyze', '--input', input, '--format', 'jsonl', '--out', nextBundle]).status, 0);
    const bundleBytes = await readFile(join(nextBundle, 'analysis.json'));
    const extended = join(temp, 'extended.json');
    const result = run(['init-profile', nextBundle, '--profile', existing, '--out', extended]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Existing rules were retained/);
    assert.match(result.stdout, /review any new blank scenarios manually/);
    const next = JSON.parse(await readFile(extended, 'utf8'));
    const currentAnalysis = JSON.parse(bundleBytes.toString('utf8'));
    assert.equal(next.name, original.name);
    assert.deepEqual(next.scenarios[0], oldRule);
    assert.equal(next.scenarios.length, 2);
    assert.deepEqual(next.scenarios[1].match, { groupId: currentAnalysis.groups.find((group: { pagePath: string }) => group.pagePath === '/new').id });
    assert.equal(next.scenarios[1].requirement, '');
    assert.equal(next.scenarios[1].setupConfirmed, false);
    assert.ok(next.scenarios[1].questions.length > 0);
    assert.deepEqual(await readFile(existing), existingBytes);
    assert.deepEqual(await readFile(join(nextBundle, 'analysis.json')), bundleBytes);
    assert.equal(run(['verify', nextBundle, '--input', input]).status, 0);

    const pending = join(temp, 'pending');
    const pendingRun = run(['analyze', '--input', input, '--format', 'jsonl', '--profile', extended, '--out', pending]);
    assert.equal(pendingRun.status, 1);
    await assert.rejects(stat(pending), { code: 'ENOENT' });
    const newRule = next.scenarios[1];
    newRule.requirement = 'The new panel explains the error.';
    newRule.expectedSource = 'Reviewed local contract';
    newRule.preconditions = ['Local demo is open'];
    newRule.setupConfirmed = true;
    newRule.questions = [];
    newRule.steps.push({ type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'New panel error', match: 'equals' });
    await writeFile(extended, JSON.stringify(next));
    const draft = join(temp, 'draft');
    assert.equal(run(['analyze', '--input', input, '--format', 'jsonl', '--profile', extended, '--out', draft]).status, 0);
    const draftAnalysis = JSON.parse(await readFile(join(draft, 'analysis.json'), 'utf8'));
    assert.ok(draftAnalysis.candidates.every((candidate: { state: string }) => candidate.state === 'draft'), JSON.stringify(draftAnalysis.candidates));
    assert.equal(run(['verify', draft, '--input', input, '--profile', extended]).status, 0);
    const reviewed = join(temp, 'reviewed');
    assert.equal(run(['analyze', '--input', input, '--format', 'jsonl', '--profile', extended, '--reviewed', '--out', reviewed]).status, 0);
    assert.equal(run(['verify', reviewed, '--input', input, '--profile', extended]).status, 0);

    const covered = join(temp, 'covered.json');
    assert.equal(run(['init-profile', firstBundle, '--profile', existing, '--out', covered]).status, 0);
    assert.deepEqual(JSON.parse(await readFile(covered, 'utf8')), original);
    const pendingOld = join(temp, 'pending-old.json');
    const pendingProfile = structuredClone(original);
    pendingProfile.scenarios[0].questions = ['Confirm the old setup'];
    pendingProfile.scenarios[0].setupConfirmed = false;
    await writeFile(pendingOld, JSON.stringify(pendingProfile));
    const pendingExtended = join(temp, 'pending-extended.json');
    assert.equal(run(['init-profile', nextBundle, '--profile', pendingOld, '--out', pendingExtended]).status, 0);
    assert.deepEqual(JSON.parse(await readFile(pendingExtended, 'utf8')).scenarios[0], pendingProfile.scenarios[0]);
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

test('init-profile extension rejects unsafe profiles and outputs before creating files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-extend-invalid-'));
  try {
    const input = join(temp, 'source.json');
    await writeFile(input, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [{ message: 'Error: failure', page: '/items' }] }));
    const bundle = join(temp, 'bundle');
    assert.equal(run(['analyze', '--input', input, '--out', bundle]).status, 0);
    const profile = join(temp, 'existing.json');
    assert.equal(run(['init-profile', bundle, '--out', profile]).status, 0);
    const valid = JSON.parse(await readFile(profile, 'utf8'));
    valid.scenarios[0].requirement = 'The page explains the failure.';
    valid.scenarios[0].expectedSource = 'Reviewed local contract';
    valid.scenarios[0].preconditions = ['Local demo is open'];
    valid.scenarios[0].setupConfirmed = true;
    valid.scenarios[0].questions = [];
    valid.scenarios[0].steps.push({ type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'Failure', match: 'equals' });
    await writeFile(profile, JSON.stringify(valid));
    const profileBytes = await readFile(profile);
    const outside = join(temp, 'new-dir', 'extended.json');
    for (const [name, content] of [
      ['bad-json', '{broken'],
      ['stale-schema', JSON.stringify({ ...valid, schemaVersion: 'error-to-test/profile-0' })],
      ['sensitive-step', JSON.stringify({ ...valid, scenarios: [{ ...valid.scenarios[0], steps: [{ type: 'open', path: '/items?token=secret' }] }] })],
      ['two-bom', `\uFEFF\uFEFF${JSON.stringify(valid)}`],
      ['oversize', ' '.repeat(1024 * 1024 + 1)],
      ['too-many-rules', JSON.stringify({ ...valid, scenarios: Array.from({ length: 101 }, (_, index) => ({ ...valid.scenarios[0], id: `rule-${index}` })) })],
    ] as const) {
      const invalid = join(temp, `${name}.json`);
      await writeFile(invalid, content);
      const result = run(['init-profile', bundle, '--profile', invalid, '--out', outside]);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      await assert.rejects(stat(outside), { code: 'ENOENT' });
    }
    const credentialLikeId = ['ghp', 'abcdefghijklmnop'].join('_');
    for (const [name, scenario] of [
      ['scenario-id', { ...valid.scenarios[0], id: credentialLikeId }],
      ['match-group-id', { ...valid.scenarios[0], match: { groupId: credentialLikeId } }],
    ] as const) {
      const unsafe = join(temp, `${name}.json`);
      const unsafeBytes = Buffer.from(JSON.stringify({ ...valid, scenarios: [scenario] }));
      await writeFile(unsafe, unsafeBytes);
      const result = run(['init-profile', bundle, '--profile', unsafe, '--out', outside]);
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.equal(result.stderr.includes(credentialLikeId), false);
      await assert.rejects(stat(outside), { code: 'ENOENT' });
      assert.deepEqual(await readFile(unsafe), unsafeBytes);
    }
    const empty = run(['init-profile', bundle, '--profile', '  ', '--out', outside]);
    assert.equal(empty.status, 1);
    await assert.rejects(stat(outside), { code: 'ENOENT' });
    const existingResult = run(['init-profile', bundle, '--profile', profile, '--out', profile]);
    assert.equal(existingResult.status, 1);
    assert.match(existingResult.stderr, /already exists/);
    assert.deepEqual(await readFile(profile), profileBytes);
    const alias = join(temp, 'profile-alias.json');
    await symlink(profile, alias);
    assert.equal(run(['init-profile', bundle, '--profile', profile, '--out', alias]).status, 1);
    assert.deepEqual(await readFile(profile), profileBytes);
    for (const out of [join(bundle, 'results', 'profile.json'), join(bundle, 'RESULTS', 'profile.json')]) {
      const result = run(['init-profile', bundle, '--out', out]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /bundle results directory/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const resultsAlias = join(temp, 'results-alias');
    await mkdir(join(bundle, 'results'));
    await symlink(join(bundle, 'results'), resultsAlias);
    const aliasOut = join(resultsAlias, 'extended.json');
    const aliasResult = run(['init-profile', bundle, '--profile', profile, '--out', aliasOut]);
    assert.equal(aliasResult.status, 1, aliasResult.stderr);
    await assert.rejects(stat(aliasOut), { code: 'ENOENT' });
    assert.equal(run(['verify', bundle, '--input', input]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('results reports only the latest linked run and preserves the source bundle', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-summary-'));
  try {
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const input = join(temp, 'events.json');
    const profile = join(temp, 'profile.json');
    const bundle = join(temp, 'bundle');
    await writeFile(input, JSON.stringify({ ...example, events: [example.events[0], example.events[2]] }));
    await writeFile(profile, await readFile(new URL('../examples/profile.json', import.meta.url)));
    const analyzed = run(['analyze', '--input', input, '--profile', profile, '--reviewed', '--out', bundle]);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const provenance = JSON.parse(await readFile(join(bundle, 'provenance.json'), 'utf8'));
    const ids = provenance.mappings.map((item: { caseId: string }) => item.caseId);
    assert.equal(ids.length, 2);
    const originalFiles = ['analysis.json', 'report.md', 'flows/error-to-test.md', 'cases/error-to-test.json', 'provenance.json'];
    const before = await Promise.all(originalFiles.map(file => readFile(join(bundle, file), 'utf8')));
    const empty = run(['results', bundle, '--format', 'json']);
    assert.equal(empty.status, 0, empty.stderr);
    const emptySummary = JSON.parse(empty.stdout);
    assert.equal(emptySummary.schemaVersion, 'error-to-test/run-summary-1');
    assert.equal(emptySummary.runCount, 0);
    assert.equal(emptySummary.counts['not-run'], 2);
    assert.equal(emptySummary.latestRun, undefined);
    assert.deepEqual(emptySummary.groups.flatMap((group: { cases: { status: string }[] }) => group.cases.map(item => item.status)), ['not-run', 'not-run']);
    const link = async (finishedAt: string, status: string, statuses: string[], reasons: (string | undefined)[]) => {
      const report = join(temp, `${randomUUID()}.json`);
      const runId = randomUUID();
      await writeFile(report, JSON.stringify({
        schemaVersion: 'flow-qa/report-1', runId, suiteHash: provenance.suiteSha256,
        startedAt: '2026-10-13T01:00:00Z', finishedAt, status,
        cases: ids.map((id: string, index: number) => ({ id, status: statuses[index], ...(reasons[index] ? { reason: reasons[index] } : {}) })),
      }));
      const linked = run(['link-run', bundle, '--report', report]);
      assert.equal(linked.status, 0, linked.stderr);
      return runId;
    };
    const latest = await link('2026-10-13T01:03:00Z', 'failed', ['failed', 'passed'], ['Failed `assert`\n```\ntoken=private-secret', undefined]);
    await link('2026-10-13T01:02:00Z', 'blocked', ['blocked', 'blocked'], ['Earlier run', 'Earlier run']);
    const summaryResult = run(['results', bundle, '--format', 'json']);
    assert.equal(summaryResult.status, 0, summaryResult.stderr);
    const summary = JSON.parse(summaryResult.stdout);
    assert.equal(summary.runCount, 2);
    assert.equal(summary.latestRun.runId, latest);
    assert.equal(summary.latestRun.status, 'failed');
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.passed, 1);
    assert.equal(summary.counts.blocked, 0);
    const cases = summary.groups.flatMap((group: { cases: { caseId: string; status: string; reason?: string }[] }) => group.cases);
    assert.deepEqual(cases.map((item: { caseId: string; status: string }) => [item.caseId, item.status]), [[ids[0], 'failed'], [ids[1], 'passed']]);
    assert.ok(!summaryResult.stdout.includes('private-secret'));
    const textResult = run(['results', bundle]);
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.match(textResult.stdout, /```/);
    assert.match(textResult.stdout, /Failed/);
    assert.ok(!textResult.stdout.includes('private-secret'));
    const output = join(temp, 'summaries', 'summary.json');
    const written = run(['results', bundle, '--format', 'json', '--out', output]);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, `Results summary written: ${output}\n`);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), summary);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(run(['verify', bundle, '--input', input, '--profile', profile]).status, 0);
    assert.deepEqual(await Promise.all(originalFiles.map(file => readFile(join(bundle, file), 'utf8'))), before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('results rejects invalid requests, stale bundles, tampered results, and existing output targets', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-summary-invalid-'));
  try {
    const bundle = join(temp, 'bundle');
    assert.equal(run(['analyze', '--error', 'Error: observed', '--out', bundle]).status, 0);
    const target = join(temp, 'new', 'summary.json');
    const existing = join(temp, 'existing.json');
    await writeFile(existing, 'keep me');
    const link = join(temp, 'symlink.json');
    await symlink(existing, link);
    for (const args of [
      ['results', bundle, '--format', 'auto'],
      ['results', bundle, '--format', 'xml'],
      ['results', bundle, '--out', target, 'extra'],
      ['results', bundle, '--input', 'x', '--out', target],
      ['results', bundle, '--report', 'x', '--out', target],
      ['results', bundle, '--reviewed', '--out', target],
      ['results', bundle, '--unknown-flag', '--out', target],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stdout, '');
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    for (const out of [existing, link, temp]) {
      const result = run(['results', bundle, '--out', out]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
    }
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    const internal = join(bundle, 'results', 'summary.json');
    const noHistoryOutput = run(['results', bundle, '--out', internal]);
    assert.equal(noHistoryOutput.status, 1);
    assert.equal(noHistoryOutput.stdout, '');
    assert.match(noHistoryOutput.stderr, /bundle results directory/);
    await assert.rejects(stat(join(bundle, 'results')), { code: 'ENOENT' });
    const uppercaseOutput = run(['results', bundle, '--out', join(bundle, 'RESULTS', 'summary.json')]);
    assert.equal(uppercaseOutput.status, 1);
    assert.equal(uppercaseOutput.stdout, '');
    assert.match(uppercaseOutput.stderr, /bundle results directory/);
    await assert.rejects(stat(join(bundle, 'RESULTS')), { code: 'ENOENT' });
    const report = join(bundle, 'report.md');
    const original = await readFile(report, 'utf8');
    await writeFile(report, 'tampered');
    const stale = run(['results', bundle, '--out', target]);
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, '');
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(report, original);
    const provenance = JSON.parse(await readFile(join(bundle, 'provenance.json'), 'utf8'));
    const runId = randomUUID();
    const qaReport = join(temp, 'qa-report.json');
    await writeFile(qaReport, JSON.stringify({ schemaVersion: 'flow-qa/report-1', runId, suiteHash: provenance.suiteSha256,
      startedAt: '2026-10-13T01:00:00Z', finishedAt: '2026-10-13T01:01:00Z', status: 'blocked',
      cases: provenance.mappings.map((item: { caseId: string }) => ({ id: item.caseId, status: 'blocked' })) }));
    assert.equal(run(['link-run', bundle, '--report', qaReport]).status, 0);
    const resultFile = join(bundle, 'results', `${runId}.json`);
    const originalResult = await readFile(resultFile, 'utf8');
    const resultsAlias = join(temp, 'results-alias');
    const bundleAlias = join(temp, 'bundle-alias');
    await symlink(join(bundle, 'results'), resultsAlias, 'dir');
    await symlink(bundle, bundleAlias, 'dir');
    for (const [source, out] of [
      [bundle, internal],
      [bundle, resultFile],
      [bundle, join(resultsAlias, 'new-summary.json')],
      [bundleAlias, join(bundleAlias, 'results', 'via-bundle-alias.json')],
    ]) {
      const rejected = run(['results', source, '--out', out]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /bundle results directory/);
    }
    await assert.rejects(stat(internal), { code: 'ENOENT' });
    await assert.rejects(stat(join(bundle, 'results', 'new-summary.json')), { code: 'ENOENT' });
    assert.equal(await readFile(resultFile, 'utf8'), originalResult);
    const sibling = join(temp, 'sibling-summary.json');
    const siblingResult = run(['results', bundle, '--format', 'json', '--out', sibling]);
    assert.equal(siblingResult.status, 0, siblingResult.stderr);
    assert.equal(JSON.parse(await readFile(sibling, 'utf8')).runCount, 1);
    assert.equal(run(['results', bundle, '--format', 'json']).status, 0);
    assert.equal(run(['verify', bundle]).status, 0);
    await writeFile(join(bundle, 'results', `${runId}.json`), '{}');
    const tampered = run(['results', bundle, '--format', 'json', '--out', target]);
    assert.equal(tampered.status, 1);
    assert.equal(tampered.stdout, '');
    await assert.rejects(stat(target), { code: 'ENOENT' });
    assert.match(run(['--help']).stdout, /results new-directory \[--format text\|json\]/);
    assert.match(run(['nonsense']).stderr, /results/);
    assert.match(run(['--out', target]).stderr, /results/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('compare includes verified groups excluded from TC selection and preserves both bundles', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-compare-'));
  try {
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const event = (id: string, release: string, message: string, page: string) => ({
      ...example.events[0], eventId: id, viewId: `view-${id}`, release, message, page,
    });
    const baselineInput = join(temp, 'baseline.json');
    const currentInput = join(temp, 'current.json');
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    await writeFile(baselineInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [
      event('b1', 'old', 'Shared failure', '/shared'), event('b2', 'old', 'Shared failure', '/shared'),
      event('b3', 'old', 'Shared failure', '/shared'), event('b4', 'old', 'Baseline only', '/baseline'),
    ] }));
    await writeFile(currentInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [
      event('c1', 'new', 'Shared failure', '/shared'), event('c2', 'new', 'Shared failure', '/shared'),
      event('c3', 'new', 'Current only', '/current'),
    ] }));
    for (const [input, out] of [[baselineInput, baseline], [currentInput, current]]) {
      const analyzed = run(['analyze', '--input', input, '--min-count', '2', '--top', '1', '--out', out]);
      assert.equal(analyzed.status, 0, analyzed.stderr);
      assert.equal(run(['verify', out]).status, 0);
    }
    const files = ['analysis.json', 'report.md', 'flows/error-to-test.md', 'cases/error-to-test.json', 'provenance.json'];
    const before = await Promise.all([baseline, current].flatMap(bundle => files.map(file => readFile(join(bundle, file)))));
    const result = run(['compare', baseline, current, '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const comparison = JSON.parse(result.stdout);
    assert.equal(comparison.schemaVersion, 'error-to-test/comparison-1');
    assert.deepEqual(comparison.counts, { 'only-current': 1, both: 1, 'only-baseline': 1 });
    assert.equal(comparison.baseline.groupCount, 2);
    assert.equal(comparison.current.groupCount, 2);
    assert.equal(comparison.baseline.recordCount, 4);
    assert.equal(comparison.current.recordCount, 3);
    const shared = comparison.issues.find((issue: { status: string }) => issue.status === 'both');
    assert.equal(shared.baseline.count, 3);
    assert.equal(shared.current.count, 2);
    assert.equal(shared.delta, -1);
    assert.deepEqual(shared.baseline.releases, ['old']);
    assert.deepEqual(shared.current.releases, ['new']);
    assert.equal(comparison.issues.find((issue: { status: string }) => issue.status === 'only-baseline').delta, -1);
    assert.equal(comparison.issues.find((issue: { status: string }) => issue.status === 'only-current').delta, 1);
    const same = JSON.parse(run(['compare', baseline, baseline, '--format', 'json']).stdout);
    assert.equal(same.counts.both, 2);
    assert.equal(same.counts['only-current'], 0);
    assert.equal(same.counts['only-baseline'], 0);
    assert.ok(same.issues.every((issue: { delta: number }) => issue.delta === 0));
    const markdown = join(temp, 'summaries', 'comparison.md');
    const written = run(['compare', baseline, current, '--out', markdown]);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(written.stdout, `Comparison written: ${markdown}\n`);
    assert.match(await readFile(markdown, 'utf8'), /Shared failure/);
    assert.equal((await stat(markdown)).mode & 0o777, 0o600);
    assert.deepEqual(await Promise.all([baseline, current].flatMap(bundle => files.map(file => readFile(join(bundle, file))))), before);
    assert.equal(run(['verify', baseline]).status, 0);
    assert.equal(run(['verify', current]).status, 0);
    assert.match(run(['--help']).stdout, /compare BASELINE CURRENT \[--format text\|json\]/);
    assert.match(run(['nonsense']).stderr, /compare/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('compare --max-new counts distinct only-current signatures and writes the full comparison before exit 2', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-gate-'));
  try {
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const event = (id: string, release: string, message: string, page: string) => ({
      ...example.events[0], eventId: id, viewId: `view-${id}`, release, message, page,
    });
    const baselineInput = join(temp, 'baseline.json');
    const currentInput = join(temp, 'current.json');
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    await writeFile(baselineInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [
      event('b1', 'old', 'Shared failure', '/shared'),
    ] }));
    await writeFile(currentInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [
      event('c1', 'new', 'Shared failure', '/shared'), event('c2', 'new', 'Shared failure', '/shared'),
      event('c3', 'new', 'Shared failure', '/shared'), event('c4', 'new', 'Shared failure', '/shared'),
      event('c5', 'r1', 'New failure', '/new'), event('c6', 'r1', 'New failure', '/new'),
      event('c7', 'r2', 'New failure', '/new'),
    ] }));
    for (const [input, out] of [[baselineInput, baseline], [currentInput, current]]) {
      const analyzed = run(['analyze', '--input', input, '--min-count', '4', '--top', '1', '--out', out]);
      assert.equal(analyzed.status, 0, analyzed.stderr);
    }
    const bundleFiles = [
      [baseline, ['analysis.json', 'report.md', 'provenance.json']],
      [current, ['analysis.json', 'report.md', 'flows/error-to-test.md', 'cases/error-to-test.json', 'provenance.json']],
    ] as const;
    const before = await Promise.all(bundleFiles.flatMap(([bundle, files]) => files.map(file => readFile(join(bundle, file)))));
    const plain = run(['compare', baseline, current, '--format', 'json']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stderr, '');
    const comparison = JSON.parse(plain.stdout);
    assert.deepEqual(comparison.counts, { 'only-current': 1, both: 1, 'only-baseline': 0 });
    assert.equal(comparison.current.groupCount, 3);
    assert.equal(comparison.current.recordCount, 7);
    const onlyCurrent = comparison.issues.find((issue: { status: string }) => issue.status === 'only-current');
    assert.equal(onlyCurrent.current.count, 3);
    assert.equal(onlyCurrent.current.groupIds.length, 2);
    assert.deepEqual(onlyCurrent.current.releases, ['r1', 'r2']);
    const failed = run(['compare', baseline, current, '--format', 'json', '--max-new', '0']);
    assert.equal(failed.status, 2, failed.stderr);
    assert.equal(failed.stdout, plain.stdout);
    assert.equal(failed.stderr, 'Comparison gate failed: 1 only-current signatures exceed maximum 0.\n');
    const passed = run(['compare', baseline, current, '--format', 'json', '--max-new', '01']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(passed.stdout, plain.stdout);
    assert.equal(passed.stderr, 'Comparison gate passed: 1 only-current signatures (maximum 1).\n');
    const noNew = run(['compare', baseline, baseline, '--format', 'json', '--max-new', '0']);
    assert.equal(noNew.status, 0, noNew.stderr);
    assert.equal(JSON.parse(noNew.stdout).counts['only-current'], 0);
    assert.equal(noNew.stderr, 'Comparison gate passed: 0 only-current signatures (maximum 0).\n');
    const markdown = join(temp, 'comparison.md');
    const plainMarkdown = run(['compare', baseline, current]);
    const written = run(['compare', baseline, current, '--out', markdown, '--max-new', '0']);
    assert.equal(written.status, 2, written.stderr);
    assert.equal(written.stdout, `Comparison written: ${markdown}\n`);
    assert.equal(written.stderr, failed.stderr);
    assert.equal(await readFile(markdown, 'utf8'), plainMarkdown.stdout);
    assert.equal((await stat(markdown)).mode & 0o777, 0o600);
    assert.deepEqual(await Promise.all(bundleFiles.flatMap(([bundle, files]) => files.map(file => readFile(join(bundle, file))))), before);
    assert.equal(run(['verify', baseline]).status, 0);
    assert.equal(run(['verify', current]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('compare --max-new rejects malformed limits before bundle access and keeps output errors at exit 1', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-gate-invalid-'));
  try {
    const missing = join(temp, 'missing');
    const target = join(temp, 'out.md');
    for (const value of ['', ' ', ' 1', '1 ', '-1', '+1', '1.0', '1e2', '0x1', 'NaN', 'Infinity', '10001']) {
      const rejected = run(['compare', missing, missing, `--max-new=${value}`, '--out', target]);
      assert.equal(rejected.status, 1, `${value}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /--max-new must be a decimal integer between 0 and 10000/);
      assert.equal(rejected.stdout, '');
      assert.equal(rejected.stderr.includes('Comparison gate'), false);
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    const acceptedLimit = run(['compare', missing, missing, '--max-new', '10000']);
    assert.equal(acceptedLimit.status, 1);
    assert.doesNotMatch(acceptedLimit.stderr, /--max-new must/);
    for (const args of [
      ['analyze', '--input', missing], ['analyze', '--error', 'Error: x'],
      ['verify', missing], ['results', missing], ['init-profile', missing, '--out', target],
      ['link-run', missing, '--report', missing],
    ]) {
      const rejected = run([...args, '--max-new', '0']);
      assert.equal(rejected.status, 1, `${args[0]}: ${rejected.stderr}`);
      assert.equal(rejected.stdout, '');
      assert.equal(rejected.stderr.includes('Comparison gate'), false);
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    assert.equal(run(['analyze', '--error', 'Error: shared', '--out', baseline]).status, 0);
    assert.equal(run(['analyze', '--error', 'Error: new', '--out', current]).status, 0);
    const existing = join(temp, 'existing.md');
    await writeFile(existing, 'keep me');
    const internal = join(current, 'results', 'comparison.md');
    for (const out of [existing, internal]) {
      const rejected = run(['compare', baseline, current, '--out', out, '--max-new', '0']);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.stdout, '');
      assert.equal(rejected.stderr.includes('Comparison gate'), false);
    }
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    await assert.rejects(stat(internal), { code: 'ENOENT' });
    const report = join(current, 'report.md');
    const original = await readFile(report, 'utf8');
    await writeFile(report, 'tampered');
    const stale = run(['compare', baseline, current, '--out', target, '--max-new', '0']);
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, '');
    assert.match(stale.stderr, /STALE_BUNDLE/);
    assert.equal(stale.stderr.includes('Comparison gate'), false);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(report, original);
    const empty = join(temp, 'empty');
    assert.equal(run(['analyze', '--error', 'Error: filtered', '--min-count', '2', '--out', empty]).status, 0);
    const passed = run(['compare', empty, empty, '--format', 'json', '--max-new', '0']);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(JSON.parse(passed.stdout).counts['only-current'], 0);
    assert.equal(passed.stderr, 'Comparison gate passed: 0 only-current signatures (maximum 0).\n');
    assert.match(run(['--help']).stdout, /--max-new N.*0\.\.10000.*exit 0.*2.*1 on error/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('compare --max-new reports a closed stdout pipe as an error without a gate outcome', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-gate-pipe-'));
  try {
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    assert.equal(run(['analyze', '--error', 'Error: shared', '--out', baseline]).status, 0);
    assert.equal(run(['analyze', '--error', 'Error: new', '--out', current]).status, 0);
    const output = join(temp, 'comparison.md');
    for (const args of [
      ['compare', baseline, current, '--format', 'json', '--max-new', '0'],
      ['compare', baseline, current, '--out', output, '--max-new', '0'],
    ]) {
      const result = await runWithClosedStdout(args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Error to Test:/);
      assert.doesNotMatch(result.stderr, /Comparison gate|Unhandled|node:internal|at [^\n]+:\d+/);
    }
    assert.match(await readFile(output, 'utf8'), /# Error to Test comparison/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('compare rejects invalid, stale, incompatible, and unsafe output requests without writing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-compare-invalid-'));
  try {
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    assert.equal(run(['analyze', '--error', 'Error: shared', '--out', baseline]).status, 0);
    assert.equal(run(['analyze', '--error', 'Error: shared', '--out', current]).status, 0);
    const target = join(temp, 'new', 'compare.json');
    for (const args of [
      ['compare'], ['compare', baseline], ['compare', baseline, current, 'extra'],
      ['compare', baseline, current, '--format', 'auto'],
      ['compare', baseline, current, '--format', 'xml'],
      ['compare', baseline, current, '--input', 'x'],
      ['compare', baseline, current, '--top', '1'],
      ['compare', baseline, current, '--report', 'x'],
      ['compare', baseline, current, '--unknown-flag'],
    ]) {
      const rejected = run([...args, '--out', target]);
      assert.equal(rejected.status, 1, `${args.join(' ')}: ${rejected.stderr}`);
      assert.equal(rejected.stdout, '');
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    const existing = join(temp, 'existing.json');
    await writeFile(existing, 'keep me');
    const link = join(temp, 'existing-link.json');
    await symlink(existing, link);
    for (const out of [existing, link, temp]) {
      const rejected = run(['compare', baseline, current, '--out', out]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.stdout, '');
    }
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    const alias = join(temp, 'baseline-alias');
    await symlink(baseline, alias, 'dir');
    const currentAlias = join(temp, 'current-alias');
    await symlink(current, currentAlias, 'dir');
    for (const out of [
      join(baseline, 'results', 'compare.md'), join(current, 'results', 'compare.md'),
      join(baseline, 'RESULTS', 'compare.md'), join(current, 'RESULTS', 'compare.md'),
      join(alias, 'results', 'compare.md'), join(currentAlias, 'results', 'compare.md'),
    ]) {
      const rejected = run(['compare', baseline, current, '--out', out]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.stdout, '');
      assert.match(rejected.stderr, /bundle results directory/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    await assert.rejects(stat(join(baseline, 'results')), { code: 'ENOENT' });
    await assert.rejects(stat(join(current, 'results')), { code: 'ENOENT' });
    assert.equal(run(['compare', baseline, current, '--format', 'json']).status, 0);
    const report = join(baseline, 'report.md');
    const original = await readFile(report, 'utf8');
    await writeFile(report, 'tampered');
    const stale = run(['compare', baseline, current, '--out', target]);
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout, '');
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(report, original);
    const currentReport = join(current, 'report.md');
    const originalCurrent = await readFile(currentReport, 'utf8');
    await writeFile(currentReport, 'tampered');
    const staleCurrent = run(['compare', baseline, current, '--out', target]);
    assert.equal(staleCurrent.status, 1);
    assert.equal(staleCurrent.stdout, '');
    assert.match(staleCurrent.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(currentReport, originalCurrent);
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const browserInput = join(temp, 'browser.json');
    const browserBundle = join(temp, 'browser');
    await writeFile(browserInput, JSON.stringify({ ...example, events: [example.events[0]] }));
    assert.equal(run(['analyze', '--input', browserInput, '--out', browserBundle]).status, 0);
    const mismatched = run(['compare', baseline, browserBundle, '--out', target]);
    assert.equal(mismatched.status, 1);
    assert.equal(mismatched.stdout, '');
    await assert.rejects(stat(target), { code: 'ENOENT' });
    const sibling = run(['compare', baseline, current, '--format', 'json', '--out', target]);
    assert.equal(sibling.status, 0, sibling.stderr);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).schemaVersion, 'error-to-test/comparison-1');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('analyze --baseline selects new signatures before ranking limits and keeps source bundles intact', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-baseline-'));
  try {
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const event = (id: string, message: string, page: string, release: string) => ({
      ...example.events[0], eventId: id, viewId: `view-${id}`, message, page, release,
    });
    const baselineInput = join(temp, 'baseline.json');
    const currentInput = join(temp, 'current.json');
    const baseline = join(temp, 'baseline');
    const current = join(temp, 'current');
    await writeFile(baselineInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [event('b1', 'Shared failure', '/shared', 'old')] }));
    await writeFile(currentInput, JSON.stringify({ schemaVersion: 1, partial: false, events: [
      event('c1', 'Shared failure', '/shared', 'new'), event('c2', 'Shared failure', '/shared', 'new'),
      event('c3', 'Shared failure', '/shared', 'new'), event('c4', 'New failure', '/new', 'new'),
    ] }));
    assert.equal(run(['analyze', '--input', baselineInput, '--out', baseline]).status, 0);
    const baselineFiles = ['analysis.json', 'report.md', 'flows/error-to-test.md', 'cases/error-to-test.json', 'provenance.json'];
    const before = await Promise.all(baselineFiles.map(file => readFile(join(baseline, file))));
    const selected = run(['analyze', '--input', currentInput, '--baseline', baseline, '--top', '1', '--out', current]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.match(selected.stdout, /1 only-current groups; 1 baseline-matched groups excluded/);
    const analysis = JSON.parse(await readFile(join(current, 'analysis.json'), 'utf8'));
    assert.equal(analysis.groups.length, 2);
    assert.equal(analysis.groups[0].message, 'Shared failure');
    assert.equal(analysis.candidates.length, 1);
    assert.equal(analysis.candidates[0].groupId, analysis.groups.find((group: { message: string }) => group.message === 'New failure').id);
    assert.deepEqual(analysis.selection, {
      mode: 'only-current',
      baseline: { inputSha256: JSON.parse(before[0].toString()).source.sha256,
        analysisSha256: JSON.parse(await readFile(join(baseline, 'provenance.json'), 'utf8')).analysisSha256,
        coverage: JSON.parse(before[0].toString()).coverage },
      onlyCurrentGroupCount: 1,
      excludedGroupCount: 1,
    });
    assert.equal(run(['verify', current, '--input', currentInput]).status, 0);
    assert.deepEqual(await Promise.all(baselineFiles.map(file => readFile(join(baseline, file)))), before);
    assert.equal(run(['verify', baseline]).status, 0);
    assert.equal(run(['results', baseline, '--format', 'json']).status, 0);

    const noNew = join(temp, 'no-new');
    const empty = run(['analyze', '--input', baselineInput, '--baseline', baseline, '--out', noNew]);
    assert.equal(empty.status, 0, empty.stderr);
    const noNewAnalysis = JSON.parse(await readFile(join(noNew, 'analysis.json'), 'utf8'));
    assert.equal(noNewAnalysis.groups.length, 1);
    assert.equal(noNewAnalysis.candidates.length, 0);
    assert.equal(noNewAnalysis.selection.onlyCurrentGroupCount, 0);
    await assert.rejects(stat(join(noNew, 'cases/error-to-test.json')), { code: 'ENOENT' });
    assert.match(run(['verify', noNew]).stdout, /Suite: none/);
    const minCount = join(temp, 'min-count');
    const filtered = run(['analyze', '--input', currentInput, '--baseline', baseline, '--min-count', '2', '--top', '1', '--out', minCount]);
    assert.equal(filtered.status, 0, filtered.stderr);
    const filteredAnalysis = JSON.parse(await readFile(join(minCount, 'analysis.json'), 'utf8'));
    assert.equal(filteredAnalysis.groups.length, 2);
    assert.equal(filteredAnalysis.candidates.length, 0);
    assert.equal(run(['verify', minCount]).status, 0);
    assert.match(run(['--help']).stdout, /--baseline DIRECTORY.*before --min-count and --top/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('analyze --baseline rejects invalid sources and unsafe outputs without writing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-cli-baseline-invalid-'));
  try {
    const baseline = join(temp, 'baseline');
    assert.equal(run(['analyze', '--error', 'Error: shared', '--out', baseline]).status, 0);
    const target = join(temp, 'new-output');
    const baseArgs = ['analyze', '--error', 'Error: current'];
    for (const args of [
      [...baseArgs, '--baseline', join(temp, 'missing')],
      [...baseArgs, '--baseline='],
      ['verify', baseline, '--baseline', baseline],
      ['results', baseline, '--baseline', baseline],
      ['init-profile', baseline, '--baseline', baseline],
      ['compare', baseline, baseline, '--baseline', baseline],
    ]) {
      const rejected = run([...args, '--out', target]);
      assert.equal(rejected.status, 1, `${args.join(' ')}: ${rejected.stderr}`);
      await assert.rejects(stat(target), { code: 'ENOENT' });
    }
    const example = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
    const browserInput = join(temp, 'browser.json');
    await writeFile(browserInput, JSON.stringify({ ...example, events: [example.events[0]] }));
    const frequency = run(['analyze', '--input', browserInput, '--baseline', baseline, '--out', target]);
    assert.equal(frequency.status, 1, frequency.stderr);
    await assert.rejects(stat(target), { code: 'ENOENT' });

    const existing = join(temp, 'existing');
    await writeFile(existing, 'keep');
    const alias = join(temp, 'baseline-alias');
    await symlink(baseline, alias, 'dir');
    for (const out of [
      join(baseline, 'results', 'new'), join(baseline, 'RESULTS', 'new'),
      join(alias, 'results', 'new'), join(alias, 'RESULTS', 'new'), existing,
    ]) {
      const rejected = run([...baseArgs, '--baseline', baseline, '--out', out]);
      assert.equal(rejected.status, 1, `${out}: ${rejected.stderr}`);
      await assert.rejects(stat(join(baseline, 'results')), { code: 'ENOENT' });
    }
    await mkdir(join(baseline, 'results'));
    const resultsAlias = join(temp, 'results-alias');
    await symlink(join(baseline, 'results'), resultsAlias, 'dir');
    for (const out of [join(resultsAlias, 'new'), join(resultsAlias, 'deeper', 'new')]) {
      const rejected = run([...baseArgs, '--baseline', baseline, '--out', out]);
      assert.equal(rejected.status, 1, `${out}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /baseline bundle results directory/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    assert.equal(await readFile(existing, 'utf8'), 'keep');
    const originalReport = await readFile(join(baseline, 'report.md'), 'utf8');
    await writeFile(join(baseline, 'report.md'), 'tampered');
    const stale = run([...baseArgs, '--baseline', baseline, '--out', target]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    await writeFile(join(baseline, 'report.md'), originalReport);
    assert.equal(run(['verify', baseline]).status, 0);
    assert.equal(run(['results', baseline, '--format', 'json']).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
