import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { analyzeErrors, writeBundle, verifyBundle, linkFlowQaReport } from '../src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const flowqa = resolve(process.env.FLOW_QA_SOURCE ?? resolve(root, '../flow-qa'));
const browserError = resolve(process.env.BROWSER_ERROR_SOURCE ?? resolve(root, '../../웹서비스 에러로그'));
const { suiteSchema, configSchema } = await import(pathToFileURL(resolve(flowqa, 'src/schema.ts')).href);
const { runSuite } = await import(pathToFileURL(resolve(flowqa, 'src/engine.ts')).href);
const { verifySuiteSource } = await import(pathToFileURL(resolve(flowqa, 'src/workspace.ts')).href);
const { startUIServer } = await import(pathToFileURL(resolve(flowqa, 'src/ui/server.ts')).href);
const sdk = await readFile(resolve(browserError, 'packages/browser/dist/index.js'));
const profile = await readFile(resolve(root, 'examples/profile.json'), 'utf8');
const seed = await readFile(resolve(root, 'examples/errors.json'), 'utf8');
const output = resolve(root, '.error-to-test', `smoke-${randomUUID()}`);
await mkdir(output, { recursive: true });
let fixed = false;
const captured: unknown[] = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/sdk.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(sdk); return; }
    if (url.pathname === '/api/events' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Oversized demo batch'); }
      const batch = JSON.parse(body);
      captured.push(...batch.events);
      response.setHeader('Content-Type', 'application/json'); response.end('{"accepted":true}'); return;
    }
    if (url.pathname === '/api/items') {
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = url.searchParams.get('retry') === '1' ? 200 : 503;
      response.end(response.statusCode === 200 ? '{"name":"Demo item"}' : '{"error":"unavailable"}'); return;
    }
    const page = url.pathname;
    const controls = page === '/items' ? '<button id="view">View item</button>' : page === '/network'
      ? '<button id="load">Load items</button><button id="retry">Retry</button><div role="alert"></div><div data-testid="item-list"></div>'
      : '<button id="unknown">Trigger unknown error</button>';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><title>Error to Test local demo</title><h1>Controlled demo</h1>${controls}<div role="status">Ready</div><script type="module">
      import { init } from '/sdk.js';
      const fixed=${JSON.stringify(fixed)};
      const client=init({project:'error-to-test-demo',environment:'test',release:'buggy',endpoint:location.origin+'/api/events',flushIntervalMs:1000});
      const status=document.querySelector('[role=status]');
      if(document.querySelector('#view')) document.querySelector('#view').onclick=async()=>{
        if(fixed){status.textContent='Item unavailable';return;}
        try{const item=undefined;status.textContent=item.name;}catch(error){client.captureException(error,{type:'javascript'});await client.flush();}
      };
      async function load(retry){const result=await fetch('/api/items'+(retry?'?retry=1':''));await client.flush();if(!result.ok){document.querySelector('[role=alert]').textContent=fixed?'Service unavailable':'Unhandled request failure';return;}document.querySelector('[data-testid=item-list]').textContent=(await result.json()).name;}
      if(document.querySelector('#load')){document.querySelector('#load').onclick=()=>load(false);document.querySelector('#retry').onclick=()=>load(true);}
      if(document.querySelector('#unknown')) document.querySelector('#unknown').onclick=async()=>{client.captureException(new Error('Missing product policy for this error'));await client.flush();status.textContent='Triggered';};
    </script>`);
  } catch { response.statusCode = 500; response.end('Demo server failed'); }
});
await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => accept()); });
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Demo listener unavailable');
const config = configSchema.parse({ schemaVersion: 'flow-qa/config-1', targets: { demo: { url: `http://127.0.0.1:${address.port}` } }, timeoutMs: 2000, retries: 0 });
const summaries: { kind: string; status: string; runDir: string }[] = [];
let ui: Awaited<ReturnType<typeof startUIServer>> | undefined;
try {
  const discoveryDir = resolve(output, 'discovery');
  await writeBundle(discoveryDir, analyzeErrors(seed, { profile }), { reviewed: true });
  const discovery = suiteSchema.parse(JSON.parse(await readFile(resolve(discoveryDir, 'cases/error-to-test.json'), 'utf8')));
  discovery.requirements.push({ id: 'R_DISCOVERY', text: 'The controlled unknown-error fixture records its diagnostic and displays Triggered.' });
  discovery.cases.push({ id: 'TC_DISCOVERY', title: 'Collect an unknown demo error', requirementIds: ['R_DISCOVERY'], preconditions: [], questions: [], steps: [
    { type: 'open', path: '/unknown' }, { type: 'click', locator: { by: 'role', value: 'button', name: 'Trigger unknown error' } },
    { type: 'assertText', locator: { by: 'role', value: 'status' }, expected: 'Triggered', match: 'equals' },
  ] });
  const discoveryRun = await runSuite({ workspace: discoveryDir, suite: discovery, config, targetName: 'demo' });
  assert.equal(discoveryRun.report.cases.filter((item: { status: string }) => item.status === 'failed').length, 2, JSON.stringify(discoveryRun.report));
  assert.ok(captured.length >= 3, 'Real SDK events must reach the collector');
  const raw = JSON.stringify({ schemaVersion: 1, events: captured });
  await writeFile(resolve(output, 'captured-errors.json'), raw);
  const analysis = analyzeErrors(raw, { profile });
  assert.equal(analysis.groups.length, 3);
  assert.equal(analysis.candidates.filter(item => item.state === 'draft').length, 2);
  const pendingDir = resolve(output, 'pending');
  await writeBundle(pendingDir, analysis);
  const pending = suiteSchema.parse(JSON.parse(await readFile(resolve(pendingDir, 'cases/error-to-test.json'), 'utf8')));
  const pendingRun = await runSuite({ workspace: pendingDir, suite: pending, config, targetName: 'demo' });
  assert.equal(pendingRun.report.status, 'blocked');
  assert.equal(pendingRun.report.cases.filter((item: { status: string }) => item.status === 'blocked').length, 3);
  summaries.push({ kind: 'Unreviewed cases', status: pendingRun.report.status, runDir: pendingRun.runDir });
  const reviewedDir = resolve(output, 'reviewed');
  await writeBundle(reviewedDir, analysis, { reviewed: true });
  await verifyBundle(reviewedDir, { input: raw, profile });
  const suite = suiteSchema.parse(JSON.parse(await readFile(resolve(reviewedDir, 'cases/error-to-test.json'), 'utf8')));
  const before = await runSuite({ workspace: reviewedDir, suite, config, targetName: 'demo' });
  assert.equal(before.report.status, 'failed');
  assert.equal(before.report.cases.filter((item: { status: string }) => item.status === 'failed').length, 2);
  assert.equal(before.report.cases.filter((item: { status: string }) => item.status === 'blocked').length, 1);
  await linkFlowQaReport(reviewedDir, before.report);
  summaries.push({ kind: 'Before repair', status: before.report.status, runDir: before.runDir });
  fixed = true;
  const after = await runSuite({ workspace: reviewedDir, suite, config, targetName: 'demo' });
  assert.equal(after.report.cases.filter((item: { status: string }) => item.status === 'passed').length, 2, JSON.stringify(after.report));
  assert.equal(after.report.cases.filter((item: { status: string }) => item.status === 'blocked').length, 1);
  assert.equal(after.report.cases.some((item: { status: string }) => item.status === 'failed'), false);
  await linkFlowQaReport(reviewedDir, after.report);
  summaries.push({ kind: 'After repair (unknown policy stays blocked)', status: after.report.status, runDir: after.runDir });
  await writeFile(resolve(reviewedDir, 'flowqa.config.json'), JSON.stringify(config));
  ui = await startUIServer({ workspace: reviewedDir, port: 0 });
  const state = await (await fetch(`${ui.url}/api/state`)).json();
  assert.ok(state.suites.some((item: { file: string }) => item.file === 'error-to-test.json'), 'Existing Flow QA UI must discover the generated suite');
  const loaded = await fetch(`${ui.url}/api/suite?file=error-to-test.json`);
  assert.equal(loaded.status, 200);
  await ui.close(); ui = undefined;
  const changedFlow = resolve(reviewedDir, 'flows/error-to-test.md');
  const originalFlow = await readFile(changedFlow, 'utf8');
  await writeFile(changedFlow, `${originalFlow}\nChanged after review.\n`);
  await assert.rejects(verifySuiteSource(suite, reviewedDir), /STALE_SUITE/);
  await assert.rejects(verifyBundle(reviewedDir), /STALE_BUNDLE/);
  await writeFile(changedFlow, originalFlow);
  await verifyBundle(reviewedDir);
  const verification = { browser: 'Chromium', source: 'real local SDK capture', modelCalls: 0, groups: 3, runnableCases: 2, unresolvedCases: 1, uiImport: 'passed', staleSource: 'rejected', resultsLinked: true, runs: summaries };
  await writeFile(resolve(output, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`);
  console.log(`Flow QA + real SDK + Chromium smoke: PASS\n${resolve(output, 'verification.json')}`);
} finally {
  if (ui) await ui.close();
  server.closeIdleConnections();
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}
