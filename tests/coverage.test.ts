import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeErrors } from '../src/analysis.ts';
import { jsonText, writeBundle } from '../src/artifacts.ts';
import { readCoverage, renderCoverage } from '../src/coverage.ts';
import { hash } from '../src/validation.ts';

const cli = fileURLToPath(new URL('../bin/dev.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000 });
const input = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [
  { id: 'ready', message: 'Checkout failed', page: '/checkout', runtime: 'browser',
    reproduction: ['Submit'], expected: 'Success appears', expectedSource: 'Fixture requirement',
    steps: [{ type: 'open', path: '/checkout' }, { type: 'act', instruction: 'Submit' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Success' }, visible: true }] },
  { id: 'mixed', message: 'Search failed', page: '/search', runtime: 'browser' },
  { id: 'excluded', message: 'Profile failed', page: '/profile', runtime: 'browser' },
] });

function rule(id: string, groupId: string, setupConfirmed: boolean) {
  return { id, title: `Search case ${id}`, match: { groupId }, requirement: 'Search results appear',
    expectedSource: 'Fixture requirement', preconditions: ['Fixture data exists'], setupConfirmed, questions: [],
    steps: [{ type: 'open', path: '/search' }, { type: 'act', instruction: 'Search' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Result' }, visible: true }] };
}

async function setup(temp: string, reviewed = true) {
  const preliminary = analyzeErrors(input);
  const ids = Object.fromEntries(preliminary.groups.map(group => [group.message, group.id]));
  const profile = { schemaVersion: 'error-to-test/profile-1', name: 'Fixture', scenarios: [
    rule('search-ready', ids['Search failed']!, true), rule('search-unconfirmed', ids['Search failed']!, false),
  ] };
  const analysis = analyzeErrors(input, { groupIds: [ids['Checkout failed']!, ids['Search failed']!], profile });
  const directory = join(temp, `bundle-${Math.random().toString(36).slice(2)}`);
  await writeBundle(directory, analysis, { reviewed });
  return { directory, ids };
}

async function rewrite(directory: string, file: string, mutate: (value: any) => void): Promise<void> {
  const path = join(directory, file);
  const value = JSON.parse(await readFile(path, 'utf8'));
  mutate(value);
  const content = jsonText(value);
  await writeFile(path, content);
  const provenancePath = join(directory, 'provenance.json');
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  provenance.analysisSha256 = hash(content);
  await writeFile(provenancePath, jsonText(provenance));
}

test('coverage accounts for selected, mixed-blocker, and explicitly unselected observed groups', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-coverage-'));
  try {
    const { directory, ids } = await setup(temp);
    const before = await readFile(join(directory, 'provenance.json'), 'utf8');
    const summary = await readCoverage(directory);
    assert.equal(summary.schemaVersion, 'error-to-test/coverage-1');
    assert.equal(summary.frequency, 'submitted-reports');
    assert.deepEqual(summary.counts, { observedGroups: 3, selectedGroups: 2, unselectedGroups: 1, blockedGroups: 1, reviewReadyGroups: 1 });
    assert.equal(summary.groups.find(group => group.groupId === ids['Checkout failed'])!.status, 'review-ready');
    const mixed = summary.groups.find(group => group.groupId === ids['Search failed'])!;
    assert.equal(mixed.status, 'blocked');
    assert.equal(mixed.caseIds.length, 2);
    assert.deepEqual(mixed.reasons, ['needs-context', 'recorded-blockers']);
    const excluded = summary.groups.find(group => group.groupId === ids['Profile failed'])!;
    assert.equal(excluded.status, 'unselected');
    assert.deepEqual(excluded.reasons, ['outside-explicit-group-filter']);
    assert.match(excluded.nextAction, /--group group-/);
    assert.match(renderCoverage(summary), /Review-ready: 1/);
    const json = run(['coverage', directory, '--format', 'json']);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), summary);
    assert.equal(run(['coverage', directory]).status, 0);
    assert.equal(await readFile(join(directory, 'provenance.json'), 'utf8'), before);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('pending review and empty selection never become review-ready', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-coverage-empty-'));
  try {
    const pending = await setup(temp, false);
    const summary = await readCoverage(pending.directory);
    assert.equal(summary.counts.reviewReadyGroups, 0);
    assert.equal(summary.counts.blockedGroups, 2);
    assert.ok(summary.groups.filter(group => group.status === 'blocked').every(group => group.reasons.includes('review-pending')));

    const emptyDirectory = join(temp, 'empty');
    await writeBundle(emptyDirectory, analyzeErrors(input, { minCount: 2 }), { reviewed: true });
    const empty = await readCoverage(emptyDirectory);
    assert.deepEqual(empty.counts, { observedGroups: 3, selectedGroups: 0, unselectedGroups: 3, blockedGroups: 0, reviewReadyGroups: 0 });
    assert.ok(empty.groups.every(group => group.reasons[0] === 'not-selected-in-saved-bundle'));
    assert.equal(run(['coverage', emptyDirectory, '--format', 'json']).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('coverage rejects stale artifacts, malformed metadata, and irrelevant CLI options', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-coverage-invalid-'));
  try {
    const { directory } = await setup(temp);
    for (const args of [[], [directory, 'extra'], [directory, '--format', 'auto'],
      [directory, '--out', join(temp, 'report.json')], [directory, '--reviewed']]) {
      const result = run(['coverage', ...args]);
      assert.equal(result.status, 1, `${JSON.stringify(args)}: ${result.stderr}`);
      assert.equal(result.stdout, '');
    }
    const report = await readFile(join(directory, 'report.md'), 'utf8');
    await writeFile(join(directory, 'report.md'), 'tampered');
    await assert.rejects(readCoverage(directory), /STALE_BUNDLE/);
    await writeFile(join(directory, 'report.md'), report);
    await rewrite(directory, 'analysis.json', value => { value.groups[0].count = -1; });
    await assert.rejects(readCoverage(directory), /supplied-record count/);
    const malformed = run(['coverage', directory, '--format', 'json']);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stdout, '');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
