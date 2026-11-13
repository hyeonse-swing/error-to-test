import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors } from '../src/analysis.ts';
import { writeBundle } from '../src/artifacts.ts';
import { readIssueReport } from '../src/issue-report.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const target = 'Target failure\n```text\n## group-0123456789abcdef\n```\nafter fake heading token=synthetic-private';
const input = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'first', message: target, page: '/items', stack: 'at target (/app.js:12:4)' },
  { id: 'second', message: target, page: '/items', stack: 'at target (/app.js:12:4)' },
  { id: 'other', message: 'Non-target unique failure', page: '/other', stack: 'at unrelated (/other.js:2:3)' },
] });

test('issue CLI exports one saved group with API parity, traceable hashes, and no other group details', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-cli-'));
  try {
    const analysis = analyzeErrors(input, { top: 1 });
    const [selected, unselected] = analysis.groups;
    const source = join(temp, 'source');
    await writeBundle(source, analysis);
    const originalReport = await readFile(join(source, 'report.md'), 'utf8');
    const originalProvenance = await readFile(join(source, 'provenance.json'), 'utf8');
    const report = run(['issue', source, '--group', selected!.id]);
    assert.equal(report.status, 0, report.stderr);
    assert.equal(report.stderr, '');
    assert.equal(report.stdout, await readIssueReport(source, selected!.id));
    assert.match(report.stdout, /Target failure/);
    assert.match(report.stdout, /after fake heading/);
    assert.match(report.stdout, /at target/);
    assert.doesNotMatch(report.stdout, /synthetic-private|Non-target unique failure|at unrelated/);
    const provenance = JSON.parse(originalProvenance);
    for (const value of [provenance.inputSha256, provenance.analysisSha256, provenance.reportSha256, selected!.id]) assert.ok(report.stdout.includes(value));
    const out = join(temp, 'issue.md');
    const saved = run(['issue', source, '--group', selected!.id, '--out', out]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(await readFile(out, 'utf8'), report.stdout);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    const rejected = run(['issue', source, '--group', unselected!.id, '--out', out]);
    assert.equal(rejected.status, 1);
    assert.equal(await readFile(out, 'utf8'), report.stdout);
    const other = run(['issue', source, '--group', unselected!.id]);
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /Non-target unique failure/);
    assert.match(other.stdout, /No selected TC candidates for this group/);
    assert.doesNotMatch(other.stdout, /Target failure|at target/);
    assert.equal(await readFile(join(source, 'report.md'), 'utf8'), originalReport);
    assert.equal(await readFile(join(source, 'provenance.json'), 'utf8'), originalProvenance);
    assert.equal(run(['verify', source]).status, 0);
    assert.equal(run(['results', source, '--format', 'json']).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('issue CLI rejects bad arguments and unsafe output paths before writing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-invalid-cli-'));
  try {
    const source = join(temp, 'source');
    const analysis = analyzeErrors(input);
    const id = analysis.groups[0]!.id;
    await writeBundle(source, analysis);
    const out = join(temp, 'issue.md');
    for (const args of [[], [source], [source, 'extra', '--group', id], [source, '--group', ''],
      [source, '--group', id, '--group', id], [source, '--group', 'private-invalid-value'],
      [source, '--group', 'group-0000000000000000'], [source, '--group', id, '--format', 'json'],
      [source, '--group', id, '--reviewed'], [source, '--group', id, '--fail-on', 'failed'],
      [source, '--group', id, '--input', 'missing'], [source, '--group', id, '--out', ' ']]) {
      const result = run(['issue', ...args, ...(args.includes('--out') ? [] : ['--out', out])]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.doesNotMatch(result.stderr, /private-invalid-value/);
      await assert.rejects(stat(out), { code: 'ENOENT' });
    }
    const alias = join(temp, 'alias');
    await symlink(source, alias, 'dir');
    for (const file of [join(source, 'new.md'), join(source, 'results', 'new.md'), join(alias, 'new.md'),
      join(dirname(source), basename(source).toUpperCase(), 'new.md')]) {
      const rejected = run(['issue', source, '--group', id, '--out', file]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /outside the source bundle/);
    }
    await writeFile(join(source, 'report.md'), 'changed');
    const stale = run(['issue', source, '--group', id, '--out', out]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /STALE_BUNDLE/);
    await assert.rejects(stat(out), { code: 'ENOENT' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('issue output pipe errors exit cleanly and keep a saved report intact', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-issue-pipe-cli-'));
  try {
    const analysis = analyzeErrors(input);
    const id = analysis.groups[0]!.id;
    const source = join(temp, 'source');
    await writeBundle(source, analysis);
    const out = join(temp, 'issue.md');
    for (const extra of [[], ['--out', out]]) {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [cli, 'issue', source, '--group', id, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.destroy();
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', rejectRun);
        child.on('close', code => resolveRun({ code, stderr }));
      });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /Error to Test:/);
      assert.doesNotMatch(result.stderr, /Unhandled|unhandled/);
    }
    assert.equal(await readFile(out, 'utf8'), await readIssueReport(source, id));
    assert.equal(run(['verify', source]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
