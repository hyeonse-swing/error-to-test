import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact public consumer versions: update deliberately when auditing a new pair.
const versions = { browserErrorLog: '0.2.10', flowQa: '0.8.8' };
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output/ecosystem');
const temp = await mkdtemp(join(tmpdir(), 'error-to-test-ecosystem-'));
const consumer = join(temp, 'consumer');
const evidence = { versions, checks: [], source: 'real local SDK capture and Chromium; no model calls' };
let fixed = false;
let ui;
let server;
const captured = [];

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
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><title>Ecosystem fixture</title><button>Check</button><div role="status">Ready</div>
        <script type="module">
          import {init} from '/sdk.js';
          const client=init({project:'ecosystem',environment:'test',release:'fixture',endpoint:location.origin+'/events',captureResourceErrors:true});
          document.querySelector('button').onclick=async()=>{
            if(location.pathname==='/resource'){
              const img=new Image();
              await new Promise(resolve=>{img.onerror=()=>setTimeout(resolve,0);img.src='/missing.png';document.body.append(img);});
            }else{client.captureException(new Error('Controlled JavaScript failure'),{type:'javascript'});}
            await client.flush();
            document.querySelector('[role=status]').textContent=${JSON.stringify(fixed ? 'Recovered' : 'Broken')};
          };
        </script>`);
    } catch { response.writeHead(500); response.end('Fixture failed'); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const targetURL = `http://127.0.0.1:${server.address().port}`;
  const profiles = ['javascript', 'resource'].map(type => ({
    id: `check-${type}`, title: `Check ${type}`, match: { type },
    requirement: 'The controlled fixture displays its recovered state', expectedSource: 'Controlled fixture contract',
    preconditions: [], setupConfirmed: true, questions: [], steps: [
      { type: 'open', path: `/${type}` }, { type: 'click', locator: { by: 'role', value: 'button', name: 'Check' } },
      { type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'Recovered', match: 'equals' },
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
  async function run(directory, expectedStatus, caseId) {
    const runsRoot = join(directory, '.flowqa/runs');
    const before = await readdir(runsRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    await command(flow, ['run', 'cases/error-to-test.json', '--workspace', directory, '--target', 'fixture', ...(caseId ? ['--case', caseId] : [])], { allowed: expectedStatus === 'passed' ? [0] : [1] });
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
  const input = join(temp, 'captured.json');
  await writeFile(input, JSON.stringify({ schemaVersion: 1, partial: true, events: captured }));
  evidence.checks.push('published SDK captures JavaScript and resource failures in Chromium');
  const pending = join(temp, 'pending');
  await analyze(input, pending, false);
  assert.equal((await run(pending, 'blocked')).cases.filter(item => item.status === 'blocked').length, 2);
  const reviewed = join(temp, 'reviewed');
  const suite = await analyze(input, reviewed);
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
