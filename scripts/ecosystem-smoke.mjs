import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact public consumer versions: update deliberately when auditing a new pair.
const versions = { browserErrorLog: process.env.BROWSER_ERROR_LOG_RELEASE_VERSION ?? '0.2.18', flowQa: '0.9.9' };
assert.match(versions.browserErrorLog, /^\d+\.\d+\.\d+$/, 'BROWSER_ERROR_LOG_RELEASE_VERSION must be an exact stable version.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output/ecosystem');
const temp = await mkdtemp(join(tmpdir(), 'error-to-test-ecosystem-'));
const consumer = join(temp, 'consumer');
const evidence = { versions, checks: [], source: 'real local SDK capture and Chromium; no model calls' };
let fixed = false;
let ui;
let server;
const captured = [];
const returnedManualIds = [];

async function command(file, args, { cwd = consumer, allowed = [0], timeout = 180_000 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, FLOW_QA_LANG: 'en' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!allowed.includes(code)) reject(new Error(`${file} ${args[0]} exited ${code}\n${stdout}\n${stderr}`));
      else accept({ code, stdout, stderr });
    });
  });
}

async function sqliteExport(events, origin, destination) {
  const directory = resolve(process.env.BROWSER_ERROR_LOG_MICRO_DIRECTORY);
  const data = join(temp, 'micro-data');
  const probe = createServer();
  await new Promise((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
  const port = probe.address().port;
  await new Promise(accept => probe.close(accept));
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MICRO_')));
  const collector = spawn(process.execPath, [join(directory, 'server.mjs')], {
    cwd: consumer, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...cleanEnvironment, MICRO_HOST: '127.0.0.1', MICRO_PORT: String(port), MICRO_STORAGE: 'sqlite',
      MICRO_DATA_DIR: data, MICRO_PROJECTS: 'ecosystem', MICRO_ALLOWED_ORIGINS: origin,
      MICRO_VIEWER_PASSWORD: randomBytes(24).toString('hex') },
  });
  let diagnostics = '';
  collector.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  let spawnError;
  collector.on('error', error => { spawnError = error; });
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (spawnError) throw spawnError;
      if (collector.exitCode !== null) throw new Error(`Micro collector exited: ${diagnostics}`);
      try { ready = (await fetch(endpoint + '/api/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait for local listener. */ }
      if (ready) break;
      await new Promise(accept => setTimeout(accept, 100));
    }
    assert.ok(ready, 'Micro collector did not start');
    const response = await fetch(endpoint + '/api/events', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ schemaVersion: 1, events }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stored, events.length);
  } finally {
    if (collector.exitCode === null && collector.signalCode === null && !spawnError) {
      const stopped = new Promise(accept => collector.once('exit', accept));
      collector.kill('SIGTERM');
      const force = setTimeout(() => collector.kill('SIGKILL'), 12000);
      await stopped; clearTimeout(force);
    }
  }
  const database = join(data, 'events.sqlite');
  const hash = async () => createHash('sha256').update(await readFile(database)).digest('hex');
  const before = await hash();
  await command(process.execPath, [join(directory, 'export.mjs'), data, destination]);
  assert.equal(await hash(), before, 'Export changed the source database');
  const exported = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(exported.partial, true);
  assert.deepEqual(exported.events.map(event => event.eventId).sort(), events.map(event => event.eventId).sort());
  evidence.checks.push('real SDK events persist through standalone SQLite collector and read-only export into verified Error-to-Test bundle');
}

try {
  await mkdir(output, { recursive: true });
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  let packageSpec;
  if (process.env.ERROR_TO_TEST_RELEASE_VERSION) {
    assert.match(process.env.ERROR_TO_TEST_RELEASE_VERSION, /^\d+\.\d+\.\d+$/);
    packageSpec = `@ihyeon/error-to-test@${process.env.ERROR_TO_TEST_RELEASE_VERSION}`;
  } else {
    const packed = JSON.parse((await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root })).stdout);
    packageSpec = join(temp, packed[0].filename);
  }
  const flowSpec = process.env.FLOW_QA_PACKAGE ? resolve(process.env.FLOW_QA_PACKAGE) : `@ihyeon/flow-qa@${versions.flowQa}`;
  await command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', packageSpec,
    `@ihyeon/browser-error-log@${versions.browserErrorLog}`, flowSpec]);
  const manifest = JSON.parse(await readFile(join(consumer, 'node_modules/@ihyeon/error-to-test/package.json'), 'utf8'));
  evidence.versions.errorToTest = manifest.version;
  evidence.versions.flowQa = JSON.parse(await readFile(join(consumer, 'node_modules/@ihyeon/flow-qa/package.json'), 'utf8')).version;
  evidence.packages = { errorToTest: process.env.ERROR_TO_TEST_RELEASE_VERSION ? 'registry' : 'local tarball', flowQa: process.env.FLOW_QA_PACKAGE ? 'local tarball' : 'registry', browserErrorLog: 'registry' };
  await command('npm', ['audit', '--omit=dev', '--audit-level=high']);
  evidence.checks.push('fresh consumer has no known high/critical runtime advisories');
  const ett = join(consumer, 'node_modules/.bin/error-to-test');
  const flow = join(consumer, 'node_modules/.bin/flow-qa');
  await command(flow, ['browser', 'install', ...(process.env.CI ? ['--with-deps'] : [])]);
  const sdk = await readFile(join(consumer, 'node_modules/@ihyeon/browser-error-log/dist/index.js'));
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/sdk.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(sdk); return; }
      if (path === '/missing.png') { response.writeHead(404); response.end(); return; }
      if (path === '/events' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 64 * 1024) throw new Error('Large fixture request'); }
        captured.push(...JSON.parse(body).events);
        response.end('{}'); return;
      }
      if (path === '/capture-id' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 1024) throw new Error('Large fixture request'); }
        returnedManualIds.push(JSON.parse(body).eventId);
        response.end('{}'); return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Ecosystem fixture</title><button>Check</button><div role="status">Ready</div>
        <script type="module">
          import {init} from '/sdk.js';
          const client=init({project:'ecosystem',environment:'test',release:'fixture',endpoint:location.origin+'/events',captureResourceErrors:true});
          document.querySelector('button').onclick=async()=>{
            if(location.pathname==='/resource'){
              const img=new Image();
              await new Promise(resolve=>{img.onerror=()=>setTimeout(resolve,0);img.src='/missing.png';document.body.append(img);});
            }else{
              const eventId=client.captureException(new Error('Controlled JavaScript failure'),{type:'javascript'});
              await fetch('/capture-id',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId})});
            }
            await client.flush();
            document.querySelector('[role=status]').textContent=${JSON.stringify(fixed ? 'Recovered' : 'Broken')};
          };
        </script>`);
    } catch { response.writeHead(500); response.end('Fixture failed'); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const targetURL = `http://127.0.0.1:${server.address().port}`;
  const profiles = ['javascript', 'resource'].map(type => ({
    id: `check-${type}`, title: `Check ${type} `, match: { type },
    requirement: 'The controlled fixture displays its recovered state', expectedSource: 'Controlled fixture contract',
    preconditions: [], setupConfirmed: true, questions: [], steps: [
      { type: 'open', path: `/${type}` }, { type: 'click', locator: { by: 'role', value: 'button', name: ' Check ' } },
      { type: 'assertText', locator: { by: 'role', value: 'status' }, expected: ' Recovered ', match: 'equals' },
    ],
  }));
  const profilePath = join(temp, 'profile.json');
  await writeFile(profilePath, JSON.stringify({ schemaVersion: 'error-to-test/profile-1', name: 'Ecosystem fixture', scenarios: profiles }));
  const seedPath = join(temp, 'seed.json');
  await writeFile(seedPath, JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: profiles.map(({ match }) => ({
    message: `Seed ${match.type}`, type: match.type, page: `/${match.type}`, runtime: 'browser',
  })) }));
  async function analyze(input, directory, reviewed = true, extra = []) {
    await command(ett, ['analyze', '--input', input, '--profile', profilePath, ...(reviewed ? ['--reviewed'] : []), '--out', directory, ...extra]);
    await command(ett, ['verify', directory, '--input', input, '--profile', profilePath]);
    await writeFile(join(directory, 'flowqa.config.json'), JSON.stringify({ schemaVersion: 'flow-qa/config-1',
      targets: { fixture: { url: targetURL } }, timeoutMs: 1500, retries: 0 }));
    return JSON.parse(await readFile(join(directory, 'cases/error-to-test.json'), 'utf8'));
  }
  async function run(directory, expectedStatus, caseId, targetName = 'fixture') {
    const runsRoot = join(directory, '.flowqa/runs');
    const before = await readdir(runsRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    await command(flow, ['run', 'cases/error-to-test.json', '--workspace', directory, '--target', targetName, ...(caseId ? ['--case', caseId] : [])], { allowed: expectedStatus === 'passed' ? [0] : [1] });
    const added = (await readdir(runsRoot)).filter(name => /^[0-9a-f-]{36}$/.test(name) && !before.includes(name));
    assert.equal(added.length, 1);
    const path = join(runsRoot, added[0], 'qa-report.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(report.status, expectedStatus, JSON.stringify(report.errors));
    await command(ett, ['link-run', directory, '--report', path]);
    return report;
  }
  const discovery = join(temp, 'discovery');
  await analyze(seedPath, discovery);
  await run(discovery, 'failed');
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map(event => event.type).sort(), ['javascript', 'resource']);
  assert.equal(returnedManualIds.length, 1);
  assert.equal(typeof returnedManualIds[0], 'string');
  assert.ok(returnedManualIds[0]);
  assert.equal(returnedManualIds[0], captured.find(event => event.type === 'javascript').eventId);
  evidence.checks.push('manual SDK capture returns the same event ID received by the local fixture collector');
  const input = join(temp, 'captured.json');
  if (process.env.BROWSER_ERROR_LOG_MICRO_DIRECTORY) await sqliteExport(captured, targetURL, input);
  else await writeFile(input, JSON.stringify({ schemaVersion: 1, partial: true, events: captured }));
  evidence.checks.push('published SDK captures JavaScript and resource failures in Chromium');
  const pending = join(temp, 'pending');
  await analyze(input, pending, false);
  const pendingCoverage = JSON.parse((await command(ett, ['coverage', pending, '--format', 'json'])).stdout);
  assert.equal(pendingCoverage.frequency, 'captured-events');
  assert.deepEqual(pendingCoverage.counts, { observedGroups: 2, selectedGroups: 2, unselectedGroups: 0, blockedGroups: 2, reviewReadyGroups: 0 });
  assert.ok(pendingCoverage.groups.every(group => group.reasons.includes('review-pending')));
  assert.equal((await run(pending, 'blocked')).cases.filter(item => item.status === 'blocked').length, 2);
  const reviewed = join(temp, 'reviewed');
  const suite = await analyze(input, reviewed);
  const reviewedCoverage = JSON.parse((await command(ett, ['coverage', reviewed, '--format', 'json'])).stdout);
  assert.deepEqual(reviewedCoverage.counts, { observedGroups: 2, selectedGroups: 2, unselectedGroups: 0, blockedGroups: 0, reviewReadyGroups: 2 });
  const topOne = join(temp, 'top-one');
  await analyze(input, topOne, true, ['--top', '1']);
  const topCoverage = JSON.parse((await command(ett, ['coverage', topOne, '--format', 'json'])).stdout);
  assert.deepEqual(topCoverage.counts, { observedGroups: 2, selectedGroups: 1, unselectedGroups: 1, blockedGroups: 0, reviewReadyGroups: 1 });
  assert.equal(topCoverage.groups.filter(group => group.status === 'unselected').length, 1);
  assert.equal(topCoverage.groups.find(group => group.status === 'unselected').reasons[0], 'not-selected-in-saved-bundle');
  evidence.checks.push('installed coverage CLI accounts for pending, reviewed, and top-one unselected observed groups without calling execution success');
  const analysis = JSON.parse(await readFile(join(reviewed, 'analysis.json'), 'utf8'));
  assert.equal(analysis.coverage.partial, true);
  const before = await run(reviewed, 'failed');
  assert.equal(before.cases.filter(item => item.status === 'failed').length, 2);
  fixed = true;
  const after = await run(reviewed, 'passed');
  assert.equal(after.cases.filter(item => item.status === 'passed').length, 2);
  evidence.checks.push('partial export preserved; unreviewed blocked; two failures then two passes after fixture repair');
  const selected = await run(reviewed, 'passed', suite.cases[0].id);
  assert.deepEqual(selected.selection, { caseIds: [suite.cases[0].id], totalCases: 2 });
  const gate = await command(ett, ['results', reviewed, '--format', 'json', '--fail-on', 'not-run'], { allowed: [2] });
  const summary = JSON.parse(gate.stdout);
  assert.equal(summary.latestRun.targetName, 'fixture');
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.counts['not-run'], 1);
  assert.ok(summary.warnings.some(warning => /partial|selected|not-run/i.test(warning)));
  evidence.checks.push('selected run linked with target name; omitted case not-run; not-run gate fails even after prior full pass');
  const originalFingerprint = createHash('sha256').update(JSON.stringify({ kind: 'web', url: targetURL })).digest('hex');
  assert.equal(summary.latestRun.targetFingerprint, originalFingerprint);
  // Reuse the label for a different actual URL: labels must not combine target histories.
  const alternateURL = targetURL + '/alternate';
  await writeFile(join(reviewed, 'flowqa.config.json'), JSON.stringify({ schemaVersion: 'flow-qa/config-1',
    targets: { fixture: { url: alternateURL } }, timeoutMs: 1500, retries: 0 }));
  fixed = false;
  const alternate = await run(reviewed, 'failed');
  const mixed = JSON.parse((await command(ett, ['results', reviewed, '--format', 'json'])).stdout);
  assert.equal(mixed.targets.length, 2);
  assert.equal(mixed.latestRun.runId, alternate.runId);
  assert.equal(mixed.counts.failed, 2);
  assert.ok(mixed.warnings.some(warning => /multiple|mixed|different|target fingerprints/i.test(warning)));
  const scopedGate = await command(ett, ['results', reviewed, '--format', 'json', '--target-fingerprint', originalFingerprint, '--fail-on', 'not-run'], { allowed: [2] });
  const scoped = JSON.parse(scopedGate.stdout);
  assert.equal(scoped.latestRun.runId, selected.runId);
  assert.equal(scoped.selectedTargetFingerprint, originalFingerprint);
  assert.equal(scoped.counts.passed, 1);
  assert.equal(scoped.counts['not-run'], 1);
  assert.equal(scoped.counts.failed, 0);
  assert.equal(scoped.excludedRunCount, 1);
  assert.ok(scoped.targets.every(target => target.names.includes('fixture')));
  const alternateFingerprint = createHash('sha256').update(JSON.stringify({ kind: 'web', url: alternateURL })).digest('hex');
  const failedTarget = JSON.parse((await command(ett, ['results', reviewed, '--format', 'json', '--target-fingerprint', alternateFingerprint, '--fail-on', 'failed'], { allowed: [2] })).stdout);
  assert.equal(failedTarget.counts.failed, 2);
  await command(ett, ['results', reviewed, '--target-fingerprint', '0'.repeat(64)], { allowed: [1] });
  assert.ok(!JSON.stringify(scoped).includes(targetURL), 'Scoped summaries must not persist raw target URLs.');
  for (const name of await readdir(join(reviewed, 'results'))) {
    if (name.endsWith('.json')) assert.ok(!(await readFile(join(reviewed, 'results', name), 'utf8')).includes(targetURL));
  }
  evidence.checks.push('same-name distinct URLs stay isolated by canonical fingerprint; scoped latest and gates exclude other targets; unknown scopes reject');
  const unresolved = await run(reviewed, 'error', undefined, 'not-configured');
  assert.equal(unresolved.target.url, '');
  const withFallback = JSON.parse((await command(ett, ['results', reviewed, '--format', 'json'])).stdout);
  assert.equal(withFallback.unscopedRunCount, 1);
  assert.equal(withFallback.latestRun.runId, unresolved.runId);
  assert.equal(withFallback.latestRun.targetFingerprint, undefined);
  const scopedAfterError = JSON.parse((await command(ett, ['results', reviewed, '--format', 'json', '--target-fingerprint', originalFingerprint])).stdout);
  assert.equal(scopedAfterError.latestRun.runId, selected.runId);
  assert.equal(scopedAfterError.excludedRunCount, 2);
  evidence.checks.push('real Flow QA unresolved-target error report remains linkable and unscoped without changing scoped outcomes');

  fixed = true;

  const jsonl = join(temp, 'captured.jsonl');
  await writeFile(jsonl, captured.slice(0, 2).map(event => JSON.stringify(event)).join('\n'));
  await analyze(jsonl, join(temp, 'jsonl'), true, ['--format', 'jsonl']);
  evidence.checks.push('real SDK JSONL accepted with resource events');
  // Installed UI uses the same generated suite and bundled design-system assets.
  ui = spawn(flow, ['ui', '--workspace', reviewed, '--port', '0'], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  let uiOutput = '';
  ui.stdout.on('data', chunk => { uiOutput += chunk; });
  ui.stderr.on('data', chunk => { uiOutput += chunk; });
  const deadline = Date.now() + 15_000;
  while (!/Flow QA: (http:\/\/127\.0\.0\.1:\d+)/.test(uiOutput) && Date.now() < deadline && ui.exitCode === null) {
    await new Promise(accept => setTimeout(accept, 100));
  }
  const uiURL = uiOutput.match(/Flow QA: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  assert.ok(uiURL, 'Installed UI did not start');
  for (const route of ['/design-system/tokens.css', '/design-system/preferences.js', '/api/suite?file=error-to-test.json']) {
    assert.equal((await fetch(uiURL + route, { signal: AbortSignal.timeout(5000) })).status, 200, route);
  }
  evidence.checks.push('installed Flow QA UI discovers suite and serves bundled design-system assets');
  evidence.result = 'passed';
  console.log(`Ecosystem package smoke: PASS (${evidence.checks.length} checks)`);
} catch (error) {
  evidence.result = 'failed';
  throw error;
} finally {
  if (ui && ui.exitCode === null) {
    const stopped = new Promise(accept => ui.once('exit', accept));
    ui.kill('SIGTERM');
    const force = setTimeout(() => ui.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(force);
  }
  if (server?.listening) {
    server.closeIdleConnections();
    await new Promise(accept => server.close(accept));
  }
  await mkdir(dirname(join(output, 'verification.json')), { recursive: true });
  await writeFile(join(output, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  await rm(temp, { recursive: true, force: true });
}
