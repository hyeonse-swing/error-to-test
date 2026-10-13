import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'hyeonse-swing/error-to-test';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/i;

export function validateReleaseInput(env, manifestVersion) {
  const version = env.ERROR_TO_TEST_RELEASE_VERSION;
  if (!VERSION.test(version ?? '') || version !== manifestVersion) {
    throw new Error('Release version must be a plain X.Y.Z matching package.json');
  }
  const releaseSha = env.ERROR_TO_TEST_RELEASE_SHA ?? env.GITHUB_SHA;
  if (!SHA.test(releaseSha ?? '') || /^0{40}$/.test(releaseSha)) throw new Error('Release SHA must be a commit SHA');
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('GitHub release requires a push to main in the release repository');
  }
  if (env.ERROR_TO_TEST_RELEASE_CANDIDATE !== 'true') throw new Error('The npm release gate must approve this version');
  if (!env.GH_TOKEN) throw new Error('GH_TOKEN is required');
  return { repository: REPOSITORY, version, tag: `v${version}`, sha: releaseSha.toLowerCase() };
}

function compareVersions(a, b) {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) throw new Error('GitHub latest tag is not a stable vX.Y.Z version');
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(left[i]) - BigInt(right[i]);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
  }
  return 0;
}

export function latestDecision(version, latestTag) {
  if (latestTag === null) return { latest: true, reason: 'no existing latest release' };
  if (typeof latestTag !== 'string' || !latestTag.startsWith('v') || !VERSION.test(latestTag.slice(1))) {
    return { latest: false, reason: 'existing latest tag is not a stable vX.Y.Z' };
  }
  return compareVersions(version, latestTag.slice(1)) > 0
    ? { latest: true, reason: 'newer than the current latest release' }
    : { latest: false, reason: 'current latest release is the same or newer' };
}

function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error(`GitHub CLI could not run: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function callGh(run, args, label, optional = false) {
  const result = run(args);
  if (result.status === 0) return result.stdout;
  if (optional && /\bHTTP 404\b/.test(result.stderr)) return null;
  const token = process.env.GH_TOKEN;
  const detail = token ? result.stderr.replaceAll(token, '[redacted]') : result.stderr;
  throw new Error(`${label} failed (exit ${result.status}): ${detail.trim() || 'no details'}`);
}

function apiJson(run, path, label, optional = false) {
  const output = callGh(run, ['api', '-X', 'GET', path], label, optional);
  if (output === null) return null;
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
    return value;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function tagCommit(run, repository, tag, reference) {
  if (reference.ref !== `refs/tags/${tag}`) throw new Error('GitHub returned a different tag reference');
  let object = reference.object;
  const seen = new Set();
  for (let depth = 0; depth < 5; depth++) {
    if (!object || !SHA.test(object.sha ?? '')) throw new Error('GitHub tag has an invalid object SHA');
    if (object.type === 'commit') return object.sha.toLowerCase();
    if (object.type !== 'tag' || seen.has(object.sha)) throw new Error('GitHub tag cannot be resolved to a commit');
    seen.add(object.sha);
    const annotated = apiJson(run, `repos/${repository}/git/tags/${object.sha}`, 'Read annotated tag');
    object = annotated.object;
  }
  throw new Error('GitHub tag chain is too deep');
}

export function ensureGitHubRelease(input, run = runGh) {
  const { repository, version, tag, sha } = input;
  const tagPath = `repos/${repository}/git/ref/tags/${tag}`;
  const releasePath = `repos/${repository}/releases/tags/${tag}`;
  let reference = apiJson(run, tagPath, 'Read GitHub tag', true);
  const release = apiJson(run, releasePath, 'Read GitHub release', true);

  if (reference && tagCommit(run, repository, tag, reference) !== sha) {
    throw new Error(`${tag} already points to a different commit; refusing to rewrite it`);
  }
  if (release) {
    if (!reference) throw new Error(`${tag} has a release but no matching tag`);
    if (release.tag_name !== tag || release.draft === true || release.prerelease === true ||
        (SHA.test(release.target_commitish ?? '') && release.target_commitish.toLowerCase() !== sha)) {
      throw new Error(`${tag} has release metadata that does not match this stable commit`);
    }
    return { status: 'existing', tag, latest: null, url: release.html_url };
  }

  const latestRelease = apiJson(run, `repos/${repository}/releases/latest`, 'Read latest GitHub release', true);
  const decision = latestDecision(version, latestRelease ? latestRelease.tag_name : null);
  if (!reference) {
    callGh(run, ['api', '-X', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`], 'Create GitHub tag');
    reference = apiJson(run, tagPath, 'Confirm GitHub tag');
    if (tagCommit(run, repository, tag, reference) !== sha) {
      throw new Error(`${tag} was created at a different commit`);
    }
  }

  const notes = `- npm: [@ihyeon/error-to-test@${version}](https://www.npmjs.com/package/@ihyeon/error-to-test/v/${version})\n- Source: [${sha}](https://github.com/${repository}/tree/${sha})`;
  const url = callGh(run, [
    'release', 'create', tag, '--repo', repository, '--target', sha, '--verify-tag',
    '--title', tag, '--notes', notes, '--generate-notes', `--latest=${decision.latest}`,
  ], 'Create GitHub release').trim();
  return { status: 'created', tag, latest: decision.latest, reason: decision.reason, url };
}

async function main() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const input = validateReleaseInput(process.env, manifest.version);
  const result = ensureGitHubRelease(input);
  console.log(`${result.tag}: ${result.status} GitHub release${result.latest === null ? '' : `; latest=${result.latest} (${result.reason})`}`);
  if (result.url) console.log(result.url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
