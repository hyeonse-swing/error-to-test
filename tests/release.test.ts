import test from 'node:test';
import assert from 'node:assert/strict';

const npmRelease = await import(new URL('../scripts/npm-release.mjs', import.meta.url).href);
const githubRelease = await import(new URL('../scripts/github-release.mjs', import.meta.url).href);
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const manifest = (version: string) => ({ name: '@ihyeon/error-to-test', version });
const lock = (version: string) => ({ ...manifest(version), packages: { '': manifest(version) } });

test('manifest, first release, rerun, and version order', () => {
  assert.equal(npmRelease.validateManifest(manifest('0.1.0'), lock('0.1.0')), '0.1.0');
  assert.throws(() => npmRelease.validateManifest(manifest('0.1.0'), lock('0.1.1')), /versions must match/);
  assert.throws(() => npmRelease.validateManifest(manifest('0.1.0-beta'), lock('0.1.0-beta')), /plain X.Y.Z/);
  assert.equal(npmRelease.releaseDecision('0.1.0', null, false, null).shouldPublish, true);
  assert.equal(npmRelease.releaseDecision('0.1.1', '0.1.0', false, '0.1.0').shouldPublish, true);
  assert.equal(npmRelease.releaseDecision('0.1.1', '0.1.0', true, '0.1.1').shouldPublish, false);
  assert.throws(() => npmRelease.releaseDecision('0.1.0', '0.1.1', false, null), /must increase/);
  assert.throws(() => npmRelease.releaseDecision('0.1.1', '0.1.0', false, '0.1.2'), /must exceed/);
});

test('registry 404 is distinct from invalid metadata and network failure', async () => {
  const respond = (status: number, body = manifest('0.1.0')) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.equal(await npmRelease.registryMetadata('0.1.0', true, respond(404)), null);
  await assert.rejects(npmRelease.registryMetadata('0.1.0', true, respond(500)), /HTTP 500/);
  await assert.rejects(npmRelease.registryMetadata('0.1.0', true, respond(200, manifest('0.1.1'))), /invalid package metadata/);
  await assert.rejects(npmRelease.registryMetadata('0.1.0', true, async () => { throw new Error('network down'); }), /network down/);
});

test('published version requires exact source SHA and unchanged runtime baseline', () => {
  const metadata = { ...manifest('0.1.0'), gitHead: sha };
  npmRelease.confirmPublishedSource(metadata, sha.toUpperCase());
  assert.throws(() => npmRelease.confirmPublishedSource(metadata, otherSha), /does not match/);
  assert.throws(() => npmRelease.confirmPublishedSource(manifest('0.1.0'), sha), /valid gitHead/);
  assert.deepEqual(npmRelease.changedRuntimeFiles(['README.md', '.github/workflows/ci.yml', 'src/index.ts', 'bin/error-to-test.mjs', 'package.json']), ['src/index.ts', 'bin/error-to-test.mjs', 'package.json']);
});

test('prepare auto patches runtime changes and skips docs or tests only', () => {
  assert.deepEqual(npmRelease.prepareDecision('0.1.0', null, []), { action: 'release', runtime: [] });
  assert.deepEqual(npmRelease.prepareDecision('0.1.1', '0.1.0', ['README.md']), { action: 'release', runtime: [] });
  assert.deepEqual(npmRelease.prepareDecision('0.1.0', '0.1.0', ['README.md', 'tests/release.test.ts']), { action: 'skip', runtime: [] });
  assert.deepEqual(npmRelease.prepareDecision('0.1.0', '0.1.0', ['README.md', 'src/index.ts']), { action: 'patch', runtime: ['src/index.ts'] });
  assert.deepEqual(npmRelease.prepareDecision('0.1.0', '0.1.0', ['LICENSE']), { action: 'patch', runtime: ['LICENSE'] });
  assert.equal(npmRelease.nextPatch('0.1.0'), '0.1.1');
  assert.throws(() => npmRelease.prepareDecision('0.1.0', '0.1.1', ['src/index.ts']), /behind npm latest/);
});

test('retry accepts only the direct bot patch of the original push', () => {
  const paths = ['package.json', 'package-lock.json'];
  assert.equal(npmRelease.isPreparedCommit('0.1.0', '0.1.1', paths, sha, sha, 'github-actions[bot]'), true);
  assert.equal(npmRelease.isPreparedCommit('0.1.0', '0.1.2', paths, sha, sha, 'github-actions[bot]'), false);
  assert.equal(npmRelease.isPreparedCommit('0.1.0', '0.1.1', [...paths, 'src/index.ts'], sha, sha, 'github-actions[bot]'), false);
  assert.equal(npmRelease.isPreparedCommit('0.1.0', '0.1.1', paths, otherSha, sha, 'github-actions[bot]'), false);
  assert.equal(npmRelease.isPreparedCommit('0.1.0', '0.1.1', paths, sha, sha, 'person'), false);
  assert.equal(npmRelease.canResumePublishedSource({ gitHead: sha }, sha), true);
  assert.equal(npmRelease.canResumePublishedSource({ gitHead: otherSha }, sha), false);
  assert.equal(npmRelease.canResumePublishedSource({}, sha), false);
});

test('downloaded tarball must match registry SHA-512', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('published tarball');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  npmRelease.verifyTarballIntegrity(bytes, integrity);
  assert.throws(() => npmRelease.verifyTarballIntegrity(Buffer.from('changed'), integrity), /does not match/);
  assert.throws(() => npmRelease.verifyTarballIntegrity(bytes, undefined), /missing SHA-512/);
});

test('GitHub release input is limited to exact main push', () => {
  const env = { ERROR_TO_TEST_RELEASE_VERSION: '0.1.0', ERROR_TO_TEST_RELEASE_CANDIDATE: 'true', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'hyeonse-swing/error-to-test', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GH_TOKEN: 'test-token' };
  assert.deepEqual(githubRelease.validateReleaseInput(env, '0.1.0'), { repository: env.GITHUB_REPOSITORY, version: '0.1.0', tag: 'v0.1.0', sha });
  assert.deepEqual(githubRelease.validateReleaseInput({ ...env, ERROR_TO_TEST_RELEASE_SHA: otherSha }, '0.1.0').sha, otherSha);
  assert.throws(() => githubRelease.validateReleaseInput({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, '0.1.0'), /push to main/);
  assert.throws(() => githubRelease.validateReleaseInput({ ...env, GITHUB_REPOSITORY: 'other/error-to-test' }, '0.1.0'), /release repository/);
  assert.throws(() => githubRelease.validateReleaseInput({ ...env, ERROR_TO_TEST_RELEASE_CANDIDATE: 'false' }, '0.1.0'), /npm release gate/);
});

test('GitHub release creates exact tag and rejects collisions without mutation', () => {
  const input = { repository: 'hyeonse-swing/error-to-test', version: '0.1.0', tag: 'v0.1.0', sha };
  const missing = { status: 1, stdout: '', stderr: 'HTTP 404' };
  const found = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const calls: string[][] = [];
  let tag: string | null = null;
  const run = (args: string[]) => {
    calls.push(args);
    const path = args[3] ?? '';
    if (path.endsWith('/git/ref/tags/v0.1.0')) return tag ? found({ ref: 'refs/tags/v0.1.0', object: { type: 'commit', sha: tag } }) : missing;
    if (path.endsWith('/releases/tags/v0.1.0') || path.endsWith('/releases/latest')) return missing;
    if (args[2] === 'POST') { tag = sha; return found({}); }
    if (args[0] === 'release') return { status: 0, stdout: 'https://github.com/hyeonse-swing/error-to-test/releases/tag/v0.1.0', stderr: '' };
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };
  assert.equal(githubRelease.ensureGitHubRelease(input, run).status, 'created');
  const create = calls.find(args => args[0] === 'release');
  assert.ok(create?.includes('--verify-tag'));
  assert.ok(create?.includes('--latest=true'));
  assert.match(create?.[create.indexOf('--notes') + 1] ?? '', /@ihyeon\/error-to-test\/v\/0\.1\.0/);
  const collisionCalls: string[][] = [];
  const collisionRun = (args: string[]) => { collisionCalls.push(args); return found({ ref: 'refs/tags/v0.1.0', object: { type: 'commit', sha: otherSha } }); };
  assert.throws(() => githubRelease.ensureGitHubRelease(input, collisionRun), /different commit/);
  assert.equal(collisionCalls.some(args => args[0] === 'release' || args[2] === 'POST'), false);
});
