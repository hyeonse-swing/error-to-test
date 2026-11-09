import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve('.');
const temp = await mkdtemp(join(tmpdir(), 'error-to-test-consumer-'));
const npmEnvironment = { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: 'true' };
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--cache', join(temp, 'cache'), '--pack-destination', temp], { cwd: root, encoding: 'utf8', env: npmEnvironment }));
  assert.ok(packed[0].files.every(file => !file.path.startsWith('node_modules/') && !file.path.startsWith('.error-to-test/')));
  assert.ok(packed[0].files.some(file => file.path === 'dist/index.js'));
  assert.deepEqual(packed[0].files.filter(file => file.path.startsWith('bin/')).map(file => file.path), ['bin/error-to-test.mjs']);
  assert.ok(packed[0].files.some(file => file.path === 'docs/releases.md'));
  await writeFile(join(temp, 'package.json'), '{"type":"module","private":true}\n');
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temp, 'cache'), join(temp, packed[0].filename)], { cwd: temp, stdio: 'pipe', env: npmEnvironment });
  const consumer = `import assert from 'node:assert/strict';\nimport { analyzeErrors, createProfileTemplate, exportFlowQa } from '@ihyeon/error-to-test';\nconst analysis=analyzeErrors('TypeError: missing item');\nassert.equal(analysis.candidates.length,1);\nassert.ok(exportFlowQa(analysis).suite.cases[0].questions.length);\nconst profile=createProfileTemplate(analysis);\nassert.equal(profile.scenarios[0].match.groupId,analysis.groups[0].id);\nassert.equal(profile.scenarios[0].requirement,'');\nassert.equal(profile.scenarios[0].setupConfirmed,false);\n`;
  await writeFile(join(temp, 'consumer.mjs'), consumer);
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: temp, stdio: 'pipe' });
  const bin = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), ['--help'], { cwd: temp, encoding: 'utf8' });
  assert.match(bin, /--error/);
  const installedManifest = JSON.parse(await readFile(join(temp, 'node_modules/@ihyeon/error-to-test/package.json'), 'utf8'));
  for (const option of ['--version', '-v']) {
    const output = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), [option], { cwd: temp, encoding: 'utf8' });
    assert.equal(output, `${installedManifest.version}\n`);
  }
  const installedRoot = join(temp, 'node_modules/@ihyeon/error-to-test');
  const runCli = args => execFileSync(join(temp, 'node_modules/.bin/error-to-test'), args, { cwd: temp, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
  const errorFile = join(temp, 'observed-error.txt');
  const initial = join(temp, 'initial');
  const profileFile = join(temp, 'review-profile.json');
  const reviewed = join(temp, 'with-profile');
  await writeFile(errorFile, 'TypeError: missing item\n    at render (/app.js:10:2)');
  runCli(['analyze', '--input', errorFile, '--page', '/items', '--runtime', 'browser', '--out', initial]);
  runCli(['init-profile', initial, '--out', profileFile]);
  const profile = JSON.parse(await readFile(profileFile, 'utf8'));
  assert.equal(profile.scenarios.length, 1);
  assert.equal(profile.scenarios[0].expectedSource, '');
  assert.deepEqual(profile.scenarios[0].steps, [{ type: 'open', path: '/items' }]);
  Object.assign(profile.scenarios[0], {
    requirement: 'The empty state appears', expectedSource: 'Demo requirement', setupConfirmed: true, questions: [],
    steps: [{ type: 'open', path: '/items' }, { type: 'act', instruction: 'Open the missing item' },
      { type: 'assertVisible', locator: { by: 'role', value: 'status' }, visible: true }],
  });
  await writeFile(profileFile, JSON.stringify(profile));
  runCli(['analyze', '--input', errorFile, '--page', '/items', '--runtime', 'browser', '--profile', profileFile, '--out', reviewed]);
  const refined = JSON.parse(await readFile(join(reviewed, 'analysis.json'), 'utf8'));
  assert.equal(refined.candidates[0].state, 'draft');
  const refinedSuite = JSON.parse(await readFile(join(reviewed, 'cases/error-to-test.json'), 'utf8'));
  assert.ok(refinedSuite.cases[0].questions.some(question => question.includes('Review this draft')));
  assert.match(runCli(['verify', reviewed, '--input', errorFile, '--profile', profileFile]), /Suite: present; review: pending; original input: checked/);
  const extensionInput = join(temp, 'additional-errors.jsonl');
  const extensionBundle = join(temp, 'additional-analysis');
  const expandedFile = join(temp, 'expanded-profile.json');
  await writeFile(extensionInput, [
    { id: 'known', message: 'TypeError: missing item', stack: '    at render (/app.js:10:2)' },
    { id: 'new', message: 'ReferenceError: selection is not defined', stack: '    at select (/app.js:20:2)' },
  ].map(error => JSON.stringify(error)).join('\n'));
  runCli(['analyze', '--input', extensionInput, '--format', 'jsonl', '--page', '/items', '--runtime', 'browser', '--out', extensionBundle]);
  runCli(['init-profile', extensionBundle, '--profile', profileFile, '--out', expandedFile]);
  const expanded = JSON.parse(await readFile(expandedFile, 'utf8'));
  assert.equal(expanded.name, profile.name);
  assert.equal(expanded.scenarios.length, 2);
  assert.deepEqual(expanded.scenarios[0], profile.scenarios[0]);
  assert.equal(expanded.scenarios[1].requirement, '');
  assert.equal(expanded.scenarios[1].expectedSource, '');
  assert.equal(expanded.scenarios[1].setupConfirmed, false);
  assert.ok(expanded.scenarios[1].questions.length);
  await writeFile(join(temp, 'profile-extension-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nimport {createProfileTemplate} from '@ihyeon/error-to-test';\nconst analysis=JSON.parse(await readFile(process.argv[2],'utf8'));\nconst profile=await readFile(process.argv[3],'utf8');\nconst expected=JSON.parse(await readFile(process.argv[4],'utf8'));\nassert.deepEqual(createProfileTemplate(analysis,{profile}),expected);\nassert.deepEqual(createProfileTemplate(analysis,{profile:JSON.parse(profile)}),expected);\n`);
  execFileSync(process.execPath, ['profile-extension-consumer.mjs', join(extensionBundle, 'analysis.json'), profileFile, expandedFile], { cwd: temp, stdio: 'pipe' });
  Object.assign(expanded.scenarios[1], {
    requirement: 'Selection is shown', expectedSource: 'Reviewed demo requirement', setupConfirmed: true, questions: [],
    preconditions: ['Demo data is ready'], steps: [{ type: 'open', path: '/items' },
      { type: 'assertVisible', locator: { by: 'text', value: 'Selection' }, visible: true }],
  });
  await writeFile(expandedFile, JSON.stringify(expanded));
  const extendedAnalysis = join(temp, 'extended-analysis');
  runCli(['analyze', '--input', extensionInput, '--format', 'jsonl', '--page', '/items', '--runtime', 'browser', '--profile', expandedFile, '--out', extendedAnalysis]);
  const extended = JSON.parse(await readFile(join(extendedAnalysis, 'analysis.json'), 'utf8'));
  assert.equal(extended.candidates.length, 2);
  assert.ok(extended.candidates.every(candidate => candidate.state === 'draft'));
  assert.equal(extended.candidates.find(candidate => candidate.ruleId === profile.scenarios[0].id).id, refined.candidates[0].id);
  assert.ok(JSON.parse(await readFile(join(extendedAnalysis, 'cases/error-to-test.json'), 'utf8')).cases.every(test => test.questions.some(question => question.includes('Review this draft'))));
  const readinessCli = args => spawnSync(join(temp, 'node_modules/.bin/error-to-test'), ['readiness', ...args], { cwd: temp, encoding: 'utf8', timeout: 30_000 });
  const pendingReadiness = readinessCli([extendedAnalysis, '--format', 'json']);
  assert.equal(pendingReadiness.status, 2, pendingReadiness.stderr);
  assert.equal(pendingReadiness.stderr, '');
  const pendingSummary = JSON.parse(pendingReadiness.stdout);
  assert.equal(pendingSummary.schemaVersion, 'error-to-test/readiness-1');
  assert.equal(pendingSummary.status, 'blocked');
  assert.equal(pendingSummary.counts.draft, 2);
  assert.equal(pendingSummary.counts.ready, 0);
  assert.ok(pendingSummary.cases.every(test => test.blockers.length));
  const executionReady = join(temp, 'execution-ready');
  runCli(['analyze', '--input', extensionInput, '--format', 'jsonl', '--page', '/items', '--runtime', 'browser', '--profile', expandedFile, '--reviewed', '--out', executionReady]);
  const readyReadiness = readinessCli([executionReady, '--format', 'json']);
  assert.equal(readyReadiness.status, 0, readyReadiness.stderr);
  const readySummary = JSON.parse(readyReadiness.stdout);
  assert.equal(readySummary.status, 'ready');
  assert.equal(readySummary.counts.ready, 2);
  assert.ok(readySummary.cases.every(test => test.blockers.length === 0));
  const noCandidates = join(temp, 'no-candidates');
  runCli(['analyze', '--input', extensionInput, '--format', 'jsonl', '--min-count', '2', '--out', noCandidates]);
  const emptyReadiness = readinessCli([noCandidates, '--format', 'json']);
  assert.equal(emptyReadiness.status, 2, emptyReadiness.stderr);
  assert.equal(JSON.parse(emptyReadiness.stdout).status, 'empty');
  const invalidReadiness = readinessCli([executionReady, '--out', join(temp, 'unsupported.json')]);
  assert.equal(invalidReadiness.status, 1);
  assert.equal(invalidReadiness.stdout, '');
  await writeFile(join(temp, 'readiness-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readReadiness,renderReadiness} from '@ihyeon/error-to-test';\nconst summary=await readReadiness(process.argv[2]);\nassert.equal(summary.status,'ready');\nassert.equal(summary.counts.ready,2);\nassert.match(renderReadiness(summary),/readiness/i);\n`);
  execFileSync(process.execPath, ['readiness-consumer.mjs', executionReady], { cwd: temp, stdio: 'pipe' });
  assert.equal(await readFile(profileFile, 'utf8'), JSON.stringify(profile));
  assert.match(runCli(['verify', extendedAnalysis, '--input', extensionInput, '--profile', expandedFile]), /original input: checked/);
  const noRuns = JSON.parse(runCli(['results', reviewed, '--format', 'json']));
  assert.equal(noRuns.runCount, 0);
  assert.equal(noRuns.counts['not-run'], 1);
  const runProvenance = JSON.parse(await readFile(join(reviewed, 'provenance.json'), 'utf8'));
  let latestRunId;
  for (const [status, finishedAt] of [['failed', '2026-11-03T01:01:00Z'], ['blocked', '2026-11-03T01:02:00Z']]) {
    const runId = randomUUID();
    const reportFile = join(temp, `${runId}.json`);
    await writeFile(reportFile, JSON.stringify({
      schemaVersion: 'flow-qa/report-1', runId, suiteHash: runProvenance.suiteSha256,
      startedAt: '2026-11-03T01:00:00Z', finishedAt, status,
      cases: runProvenance.mappings.map(mapping => ({ id: mapping.caseId, status, reason: 'Reported outcome; token=demo-private' })),
    }));
    runCli(['link-run', reviewed, '--report', reportFile]);
    latestRunId = runId;
  }
  const summaryFile = join(temp, 'run-summary.json');
  runCli(['results', reviewed, '--format', 'json', '--out', summaryFile]);
  const summaryText = await readFile(summaryFile, 'utf8');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.schemaVersion, 'error-to-test/run-summary-1');
  assert.equal(summary.runCount, 2);
  assert.equal(summary.latestRun.runId, latestRunId);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.counts.failed, 0);
  assert.ok(!summaryText.includes('demo-private'));
  await writeFile(join(temp, 'summary-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readRunSummary,renderRunSummary} from '@ihyeon/error-to-test';\nconst summary=await readRunSummary(process.argv[2]);\nassert.equal(summary.runCount,2);\nassert.equal(summary.counts.blocked,1);\nassert.ok(renderRunSummary(summary).includes(summary.latestRun.runId));\n`);
  execFileSync(process.execPath, ['summary-consumer.mjs', reviewed], { cwd: temp, stdio: 'pipe' });
  assert.match(runCli(['verify', reviewed, '--input', errorFile, '--profile', profileFile]), /original input: checked/);
  const comparisonSources = [];
  const comparisonBundles = [];
  for (const [side, release, sharedCount, uniqueMessage] of [
    ['baseline', 'r1', 2, 'Only in baseline'], ['current', 'r2', 3, 'Only in current'],
  ]) {
    const inputFile = join(temp, `${side}-errors.json`);
    const bundle = join(temp, `${side}-analysis`);
    const messages = [...Array(sharedCount).fill('Shared observed failure'), uniqueMessage];
    await writeFile(inputFile, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: messages.map((message, index) => ({
      id: `${side}-${index}`, project: 'demo', environment: 'test', release, type: 'javascript', runtime: 'browser',
      page: '/items', message, stack: 'at render (/app.js:1:1)',
    })) }));
    runCli(['analyze', '--input', inputFile, '--min-count', '3', '--top', '1', '--out', bundle]);
    comparisonSources.push(inputFile);
    comparisonBundles.push(bundle);
  }
  const comparison = JSON.parse(runCli(['compare', ...comparisonBundles, '--format', 'json']));
  assert.equal(comparison.schemaVersion, 'error-to-test/comparison-1');
  assert.deepEqual(comparison.counts, { 'only-current': 1, both: 1, 'only-baseline': 1 });
  assert.equal(comparison.baseline.recordCount, 3);
  assert.equal(comparison.current.recordCount, 4);
  assert.equal(comparison.issues.find(issue => issue.status === 'both').delta, 1);
  await writeFile(join(temp, 'comparison-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {compareBundles,renderComparison} from '@ihyeon/error-to-test';\nconst comparison=await compareBundles(process.argv[2],process.argv[3]);\nassert.equal(comparison.counts.both,1);\nassert.equal(comparison.issues.find(issue=>issue.status==='both').delta,1);\nassert.ok(renderComparison(comparison).includes('only-current'));\n`);
  execFileSync(process.execPath, ['comparison-consumer.mjs', ...comparisonBundles], { cwd: temp, stdio: 'pipe' });
  const runGate = args => spawnSync(join(temp, 'node_modules/.bin/error-to-test'), ['compare', ...comparisonBundles, ...args], { cwd: temp, encoding: 'utf8', timeout: 30_000 });
  const failedGate = runGate(['--max-new', '0', '--format', 'json']);
  assert.equal(failedGate.status, 2, failedGate.stderr);
  assert.deepEqual(JSON.parse(failedGate.stdout), comparison);
  assert.equal(failedGate.stderr, 'Comparison gate failed: 1 only-current signatures exceed maximum 0.\n');
  const passedGate = runGate(['--max-new', '1', '--format', 'json']);
  assert.equal(passedGate.status, 0, passedGate.stderr);
  assert.deepEqual(JSON.parse(passedGate.stdout), comparison);
  assert.equal(passedGate.stderr, 'Comparison gate passed: 1 only-current signatures (maximum 1).\n');
  const gateFile = join(temp, 'failed-comparison.md');
  const savedGate = runGate(['--max-new', '0', '--out', gateFile]);
  assert.equal(savedGate.status, 2, savedGate.stderr);
  const gateMarkdown = await readFile(gateFile, 'utf8');
  assert.equal(gateMarkdown, runCli(['compare', ...comparisonBundles]));
  assert.equal((await stat(gateFile)).mode & 0o777, 0o600);
  const existingGateOutput = runGate(['--max-new', '0', '--out', gateFile]);
  assert.equal(existingGateOutput.status, 1);
  assert.equal(existingGateOutput.stdout, '');
  assert.ok(!existingGateOutput.stderr.includes('Comparison gate'));
  assert.equal(await readFile(gateFile, 'utf8'), gateMarkdown);
  const focused = join(temp, 'baseline-focused');
  runCli(['analyze', '--input', comparisonSources[1], '--baseline', comparisonBundles[0], '--top', '1', '--out', focused]);
  const focusedAnalysis = JSON.parse(await readFile(join(focused, 'analysis.json'), 'utf8'));
  const baselineProvenance = JSON.parse(await readFile(join(comparisonBundles[0], 'provenance.json'), 'utf8'));
  assert.equal(focusedAnalysis.groups.length, 2);
  assert.equal(focusedAnalysis.candidates.length, 1);
  assert.equal(focusedAnalysis.candidates[0].groupId, focusedAnalysis.groups.find(group => group.message === 'Only in current').id);
  assert.equal(focusedAnalysis.selection.mode, 'only-current');
  assert.equal(focusedAnalysis.selection.baseline.analysisSha256, baselineProvenance.analysisSha256);
  assert.equal(focusedAnalysis.selection.onlyCurrentGroupCount, 1);
  assert.equal(focusedAnalysis.selection.excludedGroupCount, 1);
  assert.match(await readFile(join(focused, 'report.md'), 'utf8'), /Baseline candidate selection/);
  assert.match(runCli(['verify', focused, '--input', comparisonSources[1]]), /original input: checked/);
  await writeFile(join(temp, 'baseline-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nimport {analyzeWithBaseline} from '@ihyeon/error-to-test';\nconst analysis=await analyzeWithBaseline(await readFile(process.argv[2],'utf8'),process.argv[3],{top:1});\nassert.deepEqual(analysis,JSON.parse(await readFile(process.argv[4],'utf8')));\n`);
  execFileSync(process.execPath, ['baseline-consumer.mjs', comparisonSources[1], comparisonBundles[0], join(focused, 'analysis.json')], { cwd: temp, stdio: 'pipe' });
  const unchanged = join(temp, 'baseline-unchanged');
  runCli(['analyze', '--input', comparisonSources[0], '--baseline', comparisonBundles[0], '--out', unchanged]);
  assert.equal(JSON.parse(await readFile(join(unchanged, 'analysis.json'), 'utf8')).candidates.length, 0);
  assert.match(runCli(['verify', unchanged]), /Suite: none/);
  const combined = join(temp, 'combined-inputs');
  const combinedInputs = [comparisonSources[0], comparisonSources[1], comparisonSources[0]];
  const inputArgs = combinedInputs.flatMap(input => ['--input', input]);
  runCli(['analyze', ...inputArgs, '--min-count', '3', '--top', '1', '--out', combined]);
  const combinedAnalysis = JSON.parse(await readFile(join(combined, 'analysis.json'), 'utf8'));
  assert.equal(combinedAnalysis.source.inputs.length, 3);
  assert.equal(combinedAnalysis.coverage.inputCount, 10);
  assert.equal(combinedAnalysis.coverage.duplicates, 3);
  assert.equal(combinedAnalysis.groups.length, 4);
  assert.equal(combinedAnalysis.candidates.length, 1);
  assert.match(runCli(['verify', combined, ...inputArgs]), /original input: checked/);
  assert.throws(() => runCli(['verify', combined, '--input', comparisonSources[0], '--input', comparisonSources[1]]));
  await writeFile(join(temp, 'multi-input-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nimport {analyzeErrors,analyzeWithBaseline,verifyBundle,parseInput} from '@ihyeon/error-to-test';\nconst [bundle,...paths]=process.argv.slice(2);\nconst contents=await Promise.all(paths.map(path=>readFile(path,'utf8')));\nconst analysis=analyzeErrors(contents,{minCount:3,top:1});\nassert.deepEqual(analysis,JSON.parse(await readFile(bundle+'/analysis.json','utf8')));\nassert.equal(parseInput(contents).coverage.duplicates,3);\nassert.equal((await verifyBundle(bundle,{input:contents})).sourceChecked,true);\nassert.equal((await analyzeWithBaseline(contents,bundle)).candidates.length,0);\nassert.deepEqual(analyzeErrors([contents[0]]),analyzeErrors(contents[0]));\n`);
  execFileSync(process.execPath, ['multi-input-consumer.mjs', combined, ...combinedInputs], { cwd: temp, stdio: 'pipe' });
  const jsonlInput = join(temp, 'current-errors.jsonl');
  const jsonlBundle = join(temp, 'jsonl-focused');
  const jsonlErrors = JSON.parse(await readFile(comparisonSources[1], 'utf8')).errors;
  await writeFile(jsonlInput, '\uFEFF\r\n' + jsonlErrors.map(error => JSON.stringify(error)).join('\r\n') + '\r\n');
  runCli(['analyze', '--input', jsonlInput, '--format', 'jsonl', '--baseline', comparisonBundles[0], '--top', '1', '--out', jsonlBundle]);
  const jsonlAnalysis = JSON.parse(await readFile(join(jsonlBundle, 'analysis.json'), 'utf8'));
  assert.equal(jsonlAnalysis.coverage.kind, 'manual-jsonl');
  assert.equal(jsonlAnalysis.coverage.frequency, 'submitted-reports');
  assert.equal(jsonlAnalysis.coverage.inputCount, 4);
  assert.equal(jsonlAnalysis.selection.excludedGroupCount, 1);
  assert.equal(jsonlAnalysis.candidates.length, 1);
  assert.equal(jsonlAnalysis.candidates[0].groupId, focusedAnalysis.candidates[0].groupId);
  assert.match(runCli(['verify', jsonlBundle, '--input', jsonlInput]), /original input: checked/);
  assert.deepEqual(JSON.parse(runCli(['compare', comparisonBundles[0], jsonlBundle, '--format', 'json'])).counts, comparison.counts);
  await writeFile(join(temp, 'jsonl-consumer.mjs'), `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nimport {analyzeWithBaseline} from '@ihyeon/error-to-test';\nconst analysis=await analyzeWithBaseline(await readFile(process.argv[2],'utf8'),process.argv[3],{format:'jsonl',top:1});\nassert.deepEqual(analysis,JSON.parse(await readFile(process.argv[4],'utf8')));\n`);
  execFileSync(process.execPath, ['jsonl-consumer.mjs', jsonlInput, comparisonBundles[0], join(jsonlBundle, 'analysis.json')], { cwd: temp, stdio: 'pipe' });
  const jsonlExample = join(temp, 'jsonl-example');
  runCli(['analyze', '--input', join(installedRoot, 'examples/manual.jsonl'), '--format', 'jsonl', '--min-count', '2', '--out', jsonlExample]);
  const exampleAnalysis = JSON.parse(await readFile(join(jsonlExample, 'analysis.json'), 'utf8'));
  assert.equal(exampleAnalysis.groups.length, 2);
  assert.equal(exampleAnalysis.candidates.length, 1);
  assert.equal(exampleAnalysis.candidates[0].state, 'needs-context');
  for (let index = 0; index < comparisonBundles.length; index++) {
    assert.match(runCli(['verify', comparisonBundles[index], '--input', comparisonSources[index]]), /original input: checked/);
  }
  const reports = [];
  for (let run = 0; run < 2; run++) {
    const output = execFileSync('npm', ['run', 'demo', '--prefix', installedRoot], { cwd: temp, encoding: 'utf8', env: npmEnvironment, timeout: 30_000 });
    const report = output.match(/^Review (.+)$/m)?.[1];
    assert.ok(report, 'The demo must print its report path.');
    reports.push({ path: report, content: await readFile(report, 'utf8') });
    const verified = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), ['verify', dirname(report), '--input', join(installedRoot, 'examples/errors.json'), '--profile', join(installedRoot, 'examples/profile.json')], { cwd: temp, encoding: 'utf8', timeout: 30_000 });
    assert.match(verified, /Suite: present; review: pending; original input: checked/);
  }
  assert.notEqual(reports[0].path, reports[1].path);
  assert.equal(await readFile(reports[0].path, 'utf8'), reports[0].content);
  console.log('Packed package, independent import, installed CLI readiness/profile extension/results/comparison with CI limits/baseline/multi-input/JSONL workflows, and repeatable demo: PASS (offline; no runtime dependencies).');
} finally { await rm(temp, { recursive: true, force: true }); }
