import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
