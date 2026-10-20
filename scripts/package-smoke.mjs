import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

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
  const consumer = `import assert from 'node:assert/strict';\nimport { analyzeErrors, exportFlowQa } from '@ihyeon/error-to-test';\nconst analysis=analyzeErrors('TypeError: missing item');\nassert.equal(analysis.candidates.length,1);\nassert.ok(exportFlowQa(analysis).suite.cases[0].questions.length);\n`;
  await writeFile(join(temp, 'consumer.mjs'), consumer);
  execFileSync(process.execPath, ['consumer.mjs'], { cwd: temp, stdio: 'pipe' });
  const bin = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), ['--help'], { cwd: temp, encoding: 'utf8' });
  assert.match(bin, /--error/);
  const installedManifest = JSON.parse(await readFile(join(temp, 'node_modules/@ihyeon/error-to-test/package.json'), 'utf8'));
  for (const option of ['--version', '-v']) {
    const output = execFileSync(join(temp, 'node_modules/.bin/error-to-test'), [option], { cwd: temp, encoding: 'utf8' });
    assert.equal(output, `${installedManifest.version}\n`);
  }
  console.log('Packed package, independent import, and installed CLI: PASS (offline; no runtime dependencies).');
} finally { await rm(temp, { recursive: true, force: true }); }
