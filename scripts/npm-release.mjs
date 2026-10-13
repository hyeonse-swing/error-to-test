import { execFileSync } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@ihyeon/error-to-test';
const REGISTRY = 'https://registry.npmjs.org/@ihyeon%2ferror-to-test';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/i;
const releaseSha = () => process.env.ERROR_TO_TEST_RELEASE_SHA ?? process.env.GITHUB_SHA;

function validCommitSha(value) {
  return typeof value === 'string' && SHA.test(value) && !/^0{40}$/.test(value);
}

function parts(version) {
  const match = VERSION.exec(version ?? '');
  if (!match) throw new Error(`Release version must be plain X.Y.Z: ${version}`);
  return match.slice(1).map(BigInt);
}

function greater(current, previous) {
  const a = parts(current);
  const b = parts(previous);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function validateManifest(pkg, lock) {
  if (pkg.name !== NAME || lock.name !== NAME || lock.packages?.['']?.name !== NAME) {
    throw new Error(`Release package name must be ${NAME} in package.json and package-lock.json`);
  }
  parts(pkg.version);
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions must match');
  }
  return pkg.version;
}

export function releaseDecision(version, previous, published, latest) {
  if (previous !== null) {
    parts(previous);
    if (version === previous) return { shouldPublish: false, reason: 'unchanged' };
    if (!greater(version, previous)) throw new Error(`Version ${version} must increase from ${previous}`);
  }
  if (published) return { shouldPublish: false, reason: 'already published' };
  if (latest !== null && !greater(version, latest)) throw new Error(`Version ${version} must exceed npm latest ${latest}`);
  return { shouldPublish: true, reason: 'new version' };
}

export function changedRuntimeFiles(paths) {
  return paths.filter(path => /^(src\/|bin\/|examples\/|LICENSE$|package\.json$|package-lock\.json$|tsconfig\.json$)/.test(path));
}

export function prepareDecision(version, latest, changedPaths) {
  parts(version);
  if (latest !== null) {
    parts(latest);
    if (greater(latest, version)) throw new Error(`Version ${version} is behind npm latest ${latest}`);
    if (version === latest) {
      const runtime = changedRuntimeFiles(changedPaths);
      return runtime.length ? { action: 'patch', runtime } : { action: 'skip', runtime };
    }
  }
  return { action: 'release', runtime: [] };
}

export function nextPatch(version) {
  const [major, minor, patch] = parts(version);
  return `${major}.${minor}.${patch + 1n}`;
}

export function isPreparedCommit(sourceVersion, candidateVersion, changedPaths, parentSha, sourceSha, author) {
  return parentSha === sourceSha && candidateVersion === nextPatch(sourceVersion) &&
    changedPaths.length === 2 && changedPaths.includes('package.json') && changedPaths.includes('package-lock.json') &&
    author === 'github-actions[bot]';
}

export function canResumePublishedSource(metadata, sourceSha) {
  return validCommitSha(sourceSha) && validCommitSha(metadata?.gitHead) &&
    metadata.gitHead.toLowerCase() === sourceSha.toLowerCase();
}

export function confirmPublishedSource(metadata, githubSha) {
  if (!validCommitSha(githubSha)) throw new Error('GITHUB_SHA must be a valid nonzero commit SHA');
  if (!validCommitSha(metadata?.gitHead)) throw new Error('npm registry metadata is missing a valid gitHead');
  if (metadata.gitHead.toLowerCase() !== githubSha.toLowerCase()) {
    throw new Error('npm registry gitHead does not match GITHUB_SHA');
  }
}

export function registryConfirmed(version, published, latest, requireLatest) {
  return published === version && (!requireLatest || latest === version);
}

export function registryConfirmedForCommit(version, metadata, latest, requireLatest, githubSha) {
  if (!registryConfirmed(version, metadata?.version, latest, requireLatest)) return false;
  confirmPublishedSource(metadata, githubSha);
  return true;
}

export async function registryMetadata(suffix, allow404 = false, request = fetch) {
  const response = await request(`${REGISTRY}/${encodeURIComponent(suffix)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry ${suffix}: HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata || metadata.name !== NAME || typeof metadata.version !== 'string' || (suffix !== 'latest' && metadata.version !== suffix)) {
    throw new Error(`npm registry ${suffix}: invalid package metadata`);
  }
  return metadata;
}

export async function registryVersion(suffix, allow404 = false, request = fetch) {
  const metadata = await registryMetadata(suffix, allow404, request);
  return metadata?.version ?? null;
}

export function verifyTarballIntegrity(bytes, integrity) {
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error('npm registry metadata is missing SHA-512 tarball integrity');
  }
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== integrity) throw new Error('Downloaded npm tarball integrity does not match registry metadata');
}

async function smokePublishedPackage(version, githubSha) {
  const metadata = await registryMetadata(version);
  confirmPublishedSource(metadata, githubSha);
  if (typeof metadata.dist?.tarball !== 'string' || !metadata.dist.tarball.startsWith('https://registry.npmjs.org/')) {
    throw new Error('npm registry metadata has no trusted tarball URL');
  }
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`npm tarball download: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyTarballIntegrity(bytes, metadata.dist.integrity);
  const temp = await mkdtemp(join(tmpdir(), 'error-to-test-release-'));
  try {
    await writeFile(join(temp, 'package.json'), '{"type":"module","private":true}\n');
    const npmEnv = { ...process.env, npm_config_cache: join(temp, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${NAME}@${version}`], { cwd: temp, env: npmEnv, stdio: 'pipe', timeout: 120_000 });
    await writeFile(join(temp, 'consumer.mjs'), `import { analyzeErrors, exportFlowQa } from '${NAME}';\nconst result = analyzeErrors('TypeError: missing item');\nif (result.candidates.length !== 1 || !exportFlowQa(result).suite.cases[0]?.questions.length) throw new Error('Published import failed');\n`);
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: temp, stdio: 'pipe', timeout: 30_000 });
    const help = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), ['--help'], { cwd: temp, encoding: 'utf8', timeout: 30_000 });
    if (!help.includes('--error')) throw new Error('Published CLI help is missing --error');
    console.log(`${NAME}@${version}: tarball SHA-512, fresh consumer import, and CLI confirmed`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function main() {
  const mode = process.argv[2];
  if (!['prepare', 'gate', 'verify', 'smoke'].includes(mode)) throw new Error('Usage: npm-release.mjs prepare|gate|verify|smoke');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const version = validateManifest(pkg, lock);
  if (mode === 'smoke') return smokePublishedPackage(version, releaseSha());
  if (mode === 'prepare') {
    const sourceSha = process.env.GITHUB_SHA;
    if (!validCommitSha(sourceSha) || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'hyeonse-swing/error-to-test') {
      throw new Error('Release preparation requires the exact main push in the release repository');
    }
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (head !== sourceSha || !validCommitSha(remote)) throw new Error('Release checkout or remote main has an invalid SHA');
    if (remote !== sourceSha) {
      execFileSync('git', ['fetch', 'origin', 'main'], { stdio: 'pipe', timeout: 60_000 });
      const parent = execFileSync('git', ['rev-parse', `${remote}^`], { encoding: 'utf8' }).trim();
      const author = execFileSync('git', ['show', '-s', '--format=%an', remote], { encoding: 'utf8' }).trim();
      const paths = execFileSync('git', ['diff', '--name-only', `${sourceSha}..${remote}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const preparedPkg = JSON.parse(execFileSync('git', ['show', `${remote}:package.json`], { encoding: 'utf8' }));
      const preparedLock = JSON.parse(execFileSync('git', ['show', `${remote}:package-lock.json`], { encoding: 'utf8' }));
      const preparedVersion = validateManifest(preparedPkg, preparedLock);
      if (!isPreparedCommit(version, preparedVersion, paths, parent, sourceSha, author)) {
        throw new Error('main advanced to a different commit; release preparation must stop');
      }
      await appendFile(process.env.GITHUB_OUTPUT, `release_sha=${remote}\nrelease_candidate=true\n`);
      console.log(`${version}: existing prepared patch ${preparedVersion}; release SHA ${remote}`);
      return;
    }
    const [latest, published] = await Promise.all([registryVersion('latest', true), registryMetadata(version, true)]);
    if (canResumePublishedSource(published, sourceSha)) {
      await appendFile(process.env.GITHUB_OUTPUT, `release_sha=${sourceSha}\nrelease_candidate=true\n`);
      console.log(`${version}: already published from this source; resume release confirmation`);
      return;
    }
    let changed = [];
    if (latest === version) {
      if (!published || !validCommitSha(published.gitHead)) throw new Error('npm latest is missing an exact version with valid gitHead');
      const baseline = published.gitHead;
      try { execFileSync('git', ['merge-base', '--is-ancestor', baseline, sourceSha], { stdio: 'pipe' }); }
      catch { throw new Error('Published gitHead is not an ancestor of GITHUB_SHA'); }
      changed = execFileSync('git', ['diff', '--name-only', `${baseline}..${sourceSha}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    }
    const decision = prepareDecision(version, latest, changed);
    let releaseSha = sourceSha;
    if (decision.action === 'patch') {
      execFileSync('npm', ['version', 'patch', '--no-git-tag-version', '--ignore-scripts'], { stdio: 'pipe' });
      const updatedPkg = JSON.parse(await readFile('package.json', 'utf8'));
      const updatedLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
      const updatedVersion = validateManifest(updatedPkg, updatedLock);
      if (!greater(updatedVersion, version)) throw new Error('Automatic patch did not increase the version');
      execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
      execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
      execFileSync('git', ['add', '--', 'package.json', 'package-lock.json']);
      execFileSync('git', ['commit', '-m', `chore(release): v${updatedVersion}`], { stdio: 'pipe' });
      releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { stdio: 'pipe', timeout: 60_000 });
    }
    await appendFile(process.env.GITHUB_OUTPUT, `release_sha=${releaseSha}\nrelease_candidate=${decision.action !== 'skip'}\n`);
    console.log(`${version}: ${decision.action}; release SHA ${releaseSha}`);
    return;
  }
  if (mode === 'gate') {
    const publishingSha = releaseSha();
    if (!validCommitSha(publishingSha) || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== publishingSha) {
      throw new Error('Release checkout must match the selected release SHA');
    }
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const before = event.before;
    if (!SHA.test(before ?? '')) throw new Error('A valid push before SHA is required');
    const initialPush = /^0{40}$/.test(before);
    const previousPackage = initialPush ? null : JSON.parse(execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8' }));
    if (previousPackage && previousPackage.name !== NAME) throw new Error('Previous package name does not match');
    const [published, latest] = await Promise.all([
      registryMetadata(version, true),
      registryVersion('latest', true),
    ]);
    if (previousPackage?.version === version) {
      if (!published) {
        if (latest !== null && !greater(version, latest)) throw new Error(`Unpublished ${version} must exceed npm latest ${latest}`);
        if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
        await appendFile(process.env.GITHUB_OUTPUT, `should_publish=true\nrelease_candidate=true\nversion=${version}\n`);
        console.log(`${version}: first publication of this version`);
        return;
      }
      if (canResumePublishedSource(published, publishingSha)) {
        if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
        await appendFile(process.env.GITHUB_OUTPUT, `should_publish=false\nrelease_candidate=true\nversion=${version}\n`);
        console.log(`${version}: resume confirmed publication`);
        return;
      }
      if (!validCommitSha(published.gitHead)) throw new Error('npm registry metadata is missing a valid gitHead');
      const baseline = published.gitHead;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', baseline, publishingSha], { stdio: 'pipe' });
      } catch { throw new Error('Published gitHead is not an ancestor of release SHA'); }
      const changed = execFileSync('git', ['diff', '--name-only', `${baseline}..${publishingSha}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      const runtime = changedRuntimeFiles(changed);
      if (runtime.length) throw new Error(`Runtime files changed without a version increase: ${runtime.join(', ')}`);
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
      await appendFile(process.env.GITHUB_OUTPUT, `should_publish=false\nrelease_candidate=false\nversion=${version}\n`);
      console.log(`${version}: unchanged, no runtime files changed`);
      return;
    }
    const decision = releaseDecision(version, previousPackage?.version ?? null, published !== null, latest);
    if (published) confirmPublishedSource(published, publishingSha);
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    await appendFile(process.env.GITHUB_OUTPUT, `should_publish=${decision.shouldPublish}\nrelease_candidate=true\nversion=${version}\n`);
    console.log(`${version}: ${decision.reason}`);
    return;
  }
  const requireLatest = process.env.ERROR_TO_TEST_REQUIRE_LATEST !== 'false';
  if (process.env.ERROR_TO_TEST_REQUIRE_LATEST && !['true', 'false'].includes(process.env.ERROR_TO_TEST_REQUIRE_LATEST)) {
    throw new Error('ERROR_TO_TEST_REQUIRE_LATEST must be true or false');
  }
  const githubSha = releaseSha();
  if (!validCommitSha(githubSha)) throw new Error('GITHUB_SHA must be a valid nonzero commit SHA');
  for (let attempt = 1; attempt <= 15; attempt++) {
    let published;
    let latest;
    try {
      [published, latest] = await Promise.all([
        registryMetadata(version),
        requireLatest ? registryVersion('latest') : Promise.resolve(null),
      ]);
    } catch (error) {
      if (attempt === 15) throw error;
      await new Promise(done => setTimeout(done, 20_000));
      continue;
    }
    if (registryConfirmedForCommit(version, published, latest, requireLatest, githubSha)) {
      console.log(`npm registry confirms ${NAME}@${version}${requireLatest ? ' and latest' : ''} at release SHA`);
      return;
    }
    if (attempt < 15) await new Promise(done => setTimeout(done, 20_000));
  }
  throw new Error(`npm registry did not confirm ${NAME}@${version} as latest`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
