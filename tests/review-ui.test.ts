import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeErrors } from '../src/analysis.ts';
import { readVerifiedBundle, writeBundle } from '../src/artifacts.ts';
import { openReview } from '../src/review-session.ts';
import { startReview } from '../src/review-server.ts';
import { readReadiness } from '../src/readiness.ts';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'error-review-'));
  const sample = JSON.parse(await readFile(new URL('../examples/errors.json', import.meta.url), 'utf8'));
  sample.events = sample.events.filter((event: {type: string}) => event.type !== 'manual');
  const input = JSON.stringify(sample);
  const profile = await readFile(new URL('../examples/profile.json', import.meta.url), 'utf8');
  const source = join(base, 'original');
  await writeBundle(source, analyzeErrors(input, { profile }));
  return { base, input, source, profile, output: join(base, 'session') };
}

test('local review keeps original evidence, verifies previews and gates workspace creation on the reviewed result', async t => {
  const opts = await fixture(); t.after(() => rm(opts.base, {recursive: true, force: true}));
  const original = await readVerifiedBundle(opts.source);
  const app = await openReview(opts);
  const state = app.state();
  assert.equal(state.sourceChecked, true);
  const profile = state.profile!;
  assert.equal(profile.scenarios.length, 2);
  const pendingAnswer = structuredClone(profile);
  pendingAnswer.scenarios[0]!.requirement = '';
  const saved = await app.execute('draft', {profile: pendingAnswer});
  const draft = await readFile(join(opts.output, saved.file!), 'utf8');
  const restored = await openReview({...opts, output: join(opts.base, 'second'), draft});
  assert.equal(restored.state().profile?.scenarios[0]?.requirement, '');
  await assert.rejects(openReview({...opts, output: join(opts.base, 'wrong'), draft: draft.replace(/"fingerprint": "[0-9a-f]+"/, '"fingerprint": "other"')}), /does not match/);
  const preview = await app.execute('preview', {profile});
  await assert.rejects(app.execute('generate', {profile, profileHash: 'old'}), /Preview/);
  const generated = await app.execute('generate', {profile, profileHash: preview.profileHash});
  assert.equal(generated.readiness?.reviewed, false);
  await assert.rejects(app.execute('prepare', {folder: generated.folder}), /reviewed/);
  await assert.rejects(app.execute('acknowledge', {folder: generated.folder}), /Explicit review/);
  const savedPath = join(opts.output, generated.file!);
  const baselineProfile = await readFile(savedPath, 'utf8');
  await writeFile(savedPath, baselineProfile + '\n');
  await assert.rejects(app.execute('acknowledge', {folder: generated.folder, confirmed:true}), /Profile changed/);
  await writeFile(savedPath, baselineProfile);
  const acknowledged = await app.execute('acknowledge', {folder: generated.folder, confirmed:true});
  assert.equal(acknowledged.readiness?.status, 'ready');
  const result = await app.execute('prepare', {folder: acknowledged.folder});
  await writeFile(savedPath, baselineProfile + '\n');
  await assert.rejects(app.execute('prepare', {folder: acknowledged.folder}), /Profile changed/);
  await writeFile(savedPath, baselineProfile);
  const reviewed = join(opts.output, acknowledged.folder!);
  assert.deepEqual(acknowledged.readiness, await readReadiness(reviewed));
  const canonical = await readVerifiedBundle(reviewed, {input: opts.input, profile: await readFile(join(opts.output,generated.file!), 'utf8')});
  assert.equal(await readFile(join(opts.output,result.folder!,'cases/error-to-test.json'),'utf8'), canonical.suiteText);
  assert.deepEqual(await readVerifiedBundle(opts.source), original);
  await writeFile(join(opts.source, 'report.md'), 'edited');
  await assert.rejects(app.execute('draft', {profile}), /STALE_BUNDLE/);
});

test('review preserves questions even after acknowledgment and rejects changed rule scope or sensitive steps', async t => {
  const opts = await fixture(); t.after(() => rm(opts.base, {recursive: true, force: true}));
  const app = await openReview(opts);
  const profile = app.state().profile!;
  const altered = structuredClone(profile);
  altered.scenarios[0]!.match = {release: 'other'};
  await assert.rejects(app.execute('draft', {profile: altered}), /scope/);
  const unsafe = structuredClone(profile);
  unsafe.scenarios[0]!.steps = [{type:'fill', locator:{by:'label',value:'password'},value:'synthetic credential'}];
  await assert.rejects(app.execute('draft', {profile: unsafe}), /sensitive/);
  profile.scenarios[0]!.questions = ['Which empty state should appear?'];
  const preview = await app.execute('preview', {profile});
  const generated = await app.execute('generate', {profile,profileHash: preview.profileHash});
  const ack = await app.execute('acknowledge', {folder: generated.folder, confirmed:true});
  assert.equal(ack.readiness?.status, 'blocked');
  await assert.rejects(app.execute('prepare', {folder: ack.folder}), /not ready/);
  await assert.rejects(openReview({...opts, input:'changed'}), /Input changed/);
  const withoutProfile = await openReview({...opts, profile:undefined, output:join(opts.base,'view-only')});
  assert.match(withoutProfile.state().editBlocker, /original --profile/);
});

test('review only writes via same-origin JSON requests on its loopback server', async t => {
  const opts = await fixture(); t.after(() => rm(opts.base, {recursive:true,force:true}));
  const {origin, server} = await startReview(opts);
  t.after(() => new Promise<void>(done => {server.closeAllConnections(); server.close(() => done());}));
  const response = await fetch(origin + '/api/session');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const state = await response.json();
  assert.equal((await fetch(origin + '/api/session', {headers:{origin:'https://example.test'}})).status,403);
  assert.equal((await fetch(origin + '/api/draft', {method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(origin + '/api/draft', {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({profile:state.profile})})).status,200);
});
