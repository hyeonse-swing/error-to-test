import { parseArgs } from 'node:util';
import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { analyzeErrors, analyzeWithBaseline, type AnalyzeOptions } from './analysis.ts';
import { jsonText, readBoundedFile, readVerifiedBundle, verifyBundle, writeBundle } from './artifacts.ts';
import { compareBundles, renderComparison } from './comparison.ts';
import { createProfileTemplate } from './profile-template.ts';
import { redactText } from './redact.ts';
import { linkFlowQaReport } from './results.ts';
import { readRunSummary, renderRunSummary } from './run-summary.ts';
import { readReadiness, renderReadiness } from './readiness.ts';
import { refineBundle } from './refinement.ts';
import type { Analysis, EventType, Runtime } from './types.ts';

const help = `Error to Test — local error analysis and regression TC drafts

  error-to-test analyze --input errors-1.json --input errors-2.json --profile profile.json --out new-directory
  error-to-test analyze --input errors.json --baseline previous-bundle --out new-directory
  error-to-test analyze --input errors.json --group GROUP_ID --group OTHER_GROUP_ID --out selected-directory
  error-to-test analyze --input error.txt --format text --page /items --out new-directory
  error-to-test analyze --input errors.jsonl --format jsonl --out new-directory
  error-to-test analyze --error "TypeError: item is undefined" --page /items --out new-directory
  cat error.txt | error-to-test analyze --input - --format text --out new-directory
  error-to-test verify new-directory [--input errors-1.json --input errors-2.json] [--profile profile.json]
  error-to-test init-profile new-directory --out profile.json
  error-to-test init-profile new-directory --profile existing.json --out extended.json
  error-to-test refine new-directory --profile updated.json --out refined-directory [--reviewed]
  error-to-test link-run new-directory --report path/to/qa-report.json
  error-to-test results new-directory [--format text|json] [--out summary.md]
  error-to-test readiness new-directory [--format text|json]
  error-to-test compare BASELINE CURRENT [--format text|json] [--out comparison.md] [--max-new N]

Options:
  --input FILE           SDK export, manual JSON, JSONL, or plain error text; repeat for same-format files in order (analyze: sole - for stdin)
  --error TEXT           Submit a single error directly; remaining lines are its stack
  --format auto|json|jsonl|text Analyze input format; JSONL requires explicit selection and one record per line; auto rejects malformed JSON-looking input
  --format text|json      Results summary format (default: text Markdown)
  --format text|json      Compare format (default: text Markdown)
  --format text|json      Readiness format (default: text Markdown; exit 0 ready, 2 blocked/empty, 1 on error)
  --profile FILE         Confirmed app scenarios and explicit assertions (analyze/verify); existing profile to extend (init-profile)
  --profile FILE         Replacement profile for the bundle's previously selected groups (refine; required)
  --baseline DIRECTORY   Select only signatures absent from this verified bundle, before --min-count and --top; retain all groups in analysis.json (analyze only)
  --project NAME         Metadata for a manual report
  --environment NAME    Metadata for a manual report
  --release NAME         Metadata for a manual report
  --page PATH            Page reported for a manual error
  --type TYPE            javascript|promise|react|console|http|network|manual
  --runtime RUNTIME      browser|webview-ios|webview-android|unknown (manual input)
  --reproduce TEXT       Reported action (--error only; repeatable)
  --precondition TEXT    Reported setup (--error only; repeatable)
  --expected TEXT        Reported intended result (--error only)
  --expected-source TEXT Expected-result source (--error only)
  --from ISO --to ISO    Filter observed timestamps; undated reports are excluded
  --min-count N          Select groups with at least N records after dedup/date filtering (1..10000)
  --group GROUP_ID       Select TCs only for these exact current group IDs; repeat up to 100 times (analyze only; before --min-count/--top)
  --top N                Generate TCs for the first N eligible ranked groups (1..100; after --min-count)
  --out DIRECTORY        New analyze directory; existing files are never overwritten
  --out DIRECTORY        New refine directory outside the source bundle (required; review defaults to pending)
  --out FILE             New init-profile JSON file; existing files are never overwritten
  --out FILE             New results summary file; existing files are never overwritten
  --out FILE             New comparison file; existing files are never overwritten
  --max-new N            Compare only: allow 0..10000 only-current signatures; exit 0 within limit, 2 over limit, 1 on error
  --reviewed             Acknowledge review; unresolved questions still block cases
  --report FILE          Normalized Flow QA report (link-run only)
  --version, -v          Print the package version

No model call or browser execution occurs. Review report.md and cases/error-to-test.json first.
Use a local file or stdin for private errors; avoid secrets in shell history.
`;

async function stdinText(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('--input - requires piped input.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 10 * 1024 * 1024) throw new Error('Input must be 10 MiB or smaller.');
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks);
  if (!isUtf8(input)) throw new Error('Input must be valid UTF-8.');
  return input.toString('utf8');
}
async function writeGateOutput(content: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const onError = (error: Error) => { process.stdout.off('error', onError); rejectWrite(error); };
    process.stdout.on('error', onError);
    process.stdout.write(content, (error?: Error | null) => {
      if (error) {
        rejectWrite(error);
        // Writable can emit 'error' after invoking the failed write callback.
        setImmediate(() => process.stdout.off('error', onError));
      } else {
        process.stdout.off('error', onError);
        resolveWrite();
      }
    });
  });
}
async function inputContents(paths: string[], allowStdin: boolean): Promise<string | readonly string[]> {
  if (paths.length < 1 || paths.length > 50) throw new Error('Provide between 1 and 50 --input files.');
  if (paths.some(path => !path.trim())) throw new Error('--input requires a nonempty file path.');
  if (paths.includes('-')) {
    if (!allowStdin) throw new Error('verify --input - is not supported. Supply the original file.');
    if (paths.length !== 1) throw new Error('--input - must be the sole input.');
    return stdinText();
  }
  let remaining = 10 * 1024 * 1024;
  const contents: string[] = [];
  for (const path of paths) {
    const content = await readBoundedFile(resolve(path), remaining);
    remaining -= Buffer.byteLength(content);
    contents.push(content);
  }
  return contents.length === 1 ? contents[0]! : contents;
}
async function canonicalOutput(path: string): Promise<string> {
  let existing = path;
  while (true) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  return resolve(await realpath(existing), relative(existing, path));
}

function insideBundleResults(bundleRoot: string, path: string): boolean {
  const rest = relative(bundleRoot, path);
  if (rest === '' || rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) return false;
  return rest.split(sep, 1)[0]?.toLowerCase() === 'results';
}

function insideBundle(bundleRoot: string, path: string): boolean {
  const rest = relative(bundleRoot.toLowerCase(), path.toLowerCase());
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, input: { type: 'string', multiple: true }, error: { type: 'string' }, report: { type: 'string' },
    format: { type: 'string' }, profile: { type: 'string' }, baseline: { type: 'string' }, project: { type: 'string' }, environment: { type: 'string' },
    release: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, runtime: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    top: { type: 'string' }, 'min-count': { type: 'string' }, 'max-new': { type: 'string' }, group: { type: 'string', multiple: true }, out: { type: 'string' }, reviewed: { type: 'boolean' },
    reproduce: { type: 'string', multiple: true }, precondition: { type: 'string', multiple: true },
    expected: { type: 'string' }, 'expected-source': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (positionals.length === 0) {
    if (Object.keys(values).length) throw new Error('A command is required. Use analyze, init-profile, refine, verify, link-run, results, compare, or readiness. See --help.');
    process.stdout.write(help);
    return;
  }
  const command = positionals[0];
  if (command === 'refine') {
    if (positionals.length !== 2 || !positionals[1]?.trim() || !values.profile?.trim() || !values.out?.trim()) throw new Error('refine requires one bundle directory, --profile FILE, and --out DIRECTORY.');
    if (Object.keys(values).some(key => !['profile', 'out', 'reviewed', 'help'].includes(key))) throw new Error('Unsupported option for refine. Use only --profile FILE, --out DIRECTORY, and --reviewed.');
    const bundle = resolve(positionals[1]);
    const out = resolve(values.out);
    if (insideBundle(await realpath(bundle), await canonicalOutput(out))) throw new Error('The refined output must be outside the source bundle. Choose a new --out DIRECTORY path.');
    const analysis = await refineBundle(bundle, await readBoundedFile(resolve(values.profile), 1024 * 1024));
    const files = await writeBundle(out, analysis, { reviewed: values.reviewed });
    const drafts = analysis.candidates.filter(candidate => candidate.state === 'draft').length;
    process.stdout.write(`${analysis.groups.length} error groups retained; ${analysis.candidates.length} refined TC candidates (${drafts} drafts, ${analysis.candidates.length - drafts} need context).\nReview ${resolve(out, 'report.md')}\n${files.length} artifacts written. Review acknowledgment: ${values.reviewed ? 'yes' : 'pending'}. Original input was not rechecked.\n`);
    return;
  }
  if (command === 'init-profile') {
    if (positionals.length !== 2 || !positionals[1] || !values.out) throw new Error('init-profile requires one bundle directory and --out FILE.');
    if (Object.keys(values).some(key => !['out', 'profile', 'help'].includes(key))) throw new Error('Unsupported option for init-profile. Use only --profile FILE and --out FILE.');
    if (values.profile !== undefined && !values.profile.trim()) throw new Error('--profile requires a nonempty file path.');
    const bundle = resolve(positionals[1]);
    const { analysis } = await readVerifiedBundle(bundle);
    if (analysis.schemaVersion !== 'error-to-test/analysis-1' || !Array.isArray(analysis.groups) || !Array.isArray(analysis.candidates)) throw new Error('Unsupported analysis contract.');
    const profile = values.profile === undefined
      ? createProfileTemplate(analysis as unknown as Analysis)
      : createProfileTemplate(analysis as unknown as Analysis, { profile: await readBoundedFile(resolve(values.profile), 1024 * 1024) });
    const content = jsonText(profile);
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('The generated profile exceeds 1 MiB. Narrow the selected groups.');
    const out = resolve(values.out);
    if (insideBundleResults(await realpath(bundle), await canonicalOutput(out))) {
      throw new Error('The profile cannot be written inside the bundle results directory. Choose an outside --out FILE path.');
    }
    await mkdir(dirname(out), { recursive: true });
    try { await writeFile(out, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The output file already exists. Choose a new --out FILE path.');
      throw error;
    }
    process.stdout.write(`Profile template written: ${out}\n${values.profile === undefined ? '' : 'Existing rules were retained; fill and review any new blank scenarios manually. This does not approve the profile.\n'}Fill requirement, expectedSource, preconditions, and steps; confirm setupConfirmed and clear answered questions. Then rerun analyze with the original input and --profile ${out}.\n`);
    return;
  }
  if (command === 'link-run') {
    if (positionals.length !== 2 || !positionals[1] || !values.report) throw new Error('link-run requires a bundle directory and --report.');
    if (Object.keys(values).some(key => key !== 'report' && key !== 'help')) throw new Error('Unsupported option for link-run.');
    let report: unknown;
    try { report = JSON.parse(await readBoundedFile(resolve(values.report), 2 * 1024 * 1024)); }
    catch { throw new Error('The Flow QA report must be a JSON file within 2 MiB.'); }
    const file = await linkFlowQaReport(resolve(positionals[1]), report);
    process.stdout.write(`Run linked: ${file}\nSource issues were not automatically closed.\n`);
    return;
  }
  if (command === 'results') {
    if (positionals.length !== 2 || !positionals[1]) throw new Error('results requires one bundle directory.');
    if (Object.keys(values).some(key => !['format', 'out', 'help'].includes(key))) throw new Error('Unsupported option for results. Use only --format text|json and --out FILE.');
    const format = values.format ?? 'text';
    if (format !== 'text' && format !== 'json') throw new Error('results --format must be text or json.');
    const bundle = resolve(positionals[1]);
    const summary = await readRunSummary(bundle);
    const content = format === 'json' ? jsonText(summary) : renderRunSummary(summary);
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error('The results summary exceeds 64 MiB. Narrow the bundle before requesting output.');
    if (values.out === undefined) {
      process.stdout.write(content);
      return;
    }
    const out = resolve(values.out);
    if (insideBundleResults(await realpath(bundle), await canonicalOutput(out))) {
      throw new Error('The results summary cannot be written inside the bundle results directory. Choose an outside --out FILE path.');
    }
    await mkdir(dirname(out), { recursive: true });
    try { await writeFile(out, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The output file already exists. Choose a new --out FILE path.');
      throw error;
    }
    process.stdout.write(`Results summary written: ${out}\n`);
    return;
  }
  if (command === 'readiness') {
    if (positionals.length !== 2 || !positionals[1]?.trim()) throw new Error('readiness requires one bundle directory.');
    if (Object.keys(values).some(key => !['format', 'help'].includes(key))) throw new Error('Unsupported option for readiness. Use only --format text|json.');
    const format = values.format ?? 'text';
    if (format !== 'text' && format !== 'json') throw new Error('readiness --format must be text or json.');
    const summary = await readReadiness(resolve(positionals[1]));
    const content = format === 'json' ? jsonText(summary) : renderReadiness(summary);
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error('The readiness summary exceeds 64 MiB. Narrow the bundle before requesting output.');
    await writeGateOutput(content);
    if (summary.status !== 'ready') process.exitCode = 2;
    return;
  }
  if (command === 'compare') {
    if (positionals.length !== 3 || !positionals[1] || !positionals[2]) throw new Error('compare requires BASELINE and CURRENT bundle directories.');
    if (Object.keys(values).some(key => !['format', 'out', 'max-new', 'help'].includes(key))) throw new Error('Unsupported option for compare. Use only --format text|json, --out FILE, and --max-new N.');
    const format = values.format ?? 'text';
    if (format !== 'text' && format !== 'json') throw new Error('compare --format must be text or json.');
    const maxNewRaw = values['max-new'];
    if (maxNewRaw !== undefined && (!/^[0-9]+$/.test(maxNewRaw) || Number(maxNewRaw) > 10000)) {
      throw new Error('compare --max-new must be a decimal integer between 0 and 10000.');
    }
    const maxNew = maxNewRaw === undefined ? undefined : Number(maxNewRaw);
    const baseline = resolve(positionals[1]);
    const current = resolve(positionals[2]);
    const comparison = await compareBundles(baseline, current);
    const content = format === 'json' ? jsonText(comparison) : renderComparison(comparison);
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error('The comparison exceeds 64 MiB. Narrow the bundles before requesting output.');
    const finishGate = () => {
      if (maxNew === undefined) return;
      const count = comparison.counts['only-current'];
      const passed = count <= maxNew;
      process.stderr.write(`Comparison gate ${passed ? 'passed' : 'failed'}: ${count} only-current signatures ${passed ? `(maximum ${maxNew}).` : `exceed maximum ${maxNew}.`}\n`);
      if (!passed) process.exitCode = 2;
    };
    if (values.out === undefined) {
      if (maxNew === undefined) process.stdout.write(content);
      else await writeGateOutput(content);
      finishGate();
      return;
    }
    const out = resolve(values.out);
    const canonical = await canonicalOutput(out);
    for (const bundle of [baseline, current]) {
      if (insideBundleResults(await realpath(bundle), canonical)) {
        throw new Error('The comparison cannot be written inside either bundle results directory. Choose an outside --out FILE path.');
      }
    }
    await mkdir(dirname(out), { recursive: true });
    try { await writeFile(out, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The output file already exists. Choose a new --out FILE path.');
      throw error;
    }
    const written = `Comparison written: ${out}\n`;
    if (maxNew === undefined) process.stdout.write(written);
    else await writeGateOutput(written);
    finishGate();
    return;
  }
  if (command === 'verify') {
    if (positionals.length !== 2 || !positionals[1]) throw new Error('verify requires one bundle directory.');
    if (Object.keys(values).some(key => !['input', 'profile', 'help'].includes(key))) throw new Error('Unsupported option for verify.');
    const result = await verifyBundle(resolve(positionals[1]), {
      ...(values.input ? { input: await inputContents(values.input, false) } : {}),
      ...(values.profile ? { profile: await readBoundedFile(resolve(values.profile), 1024 * 1024) } : {}),
    });
    process.stdout.write(`Bundle verified. Suite: ${result.suite ? 'present' : 'none'}; review: ${result.reviewed ? 'acknowledged' : 'pending'}; original input: ${result.sourceChecked ? 'checked' : 'not supplied'}.\n`);
    return;
  }
  if (command !== 'analyze' || positionals.length !== 1) throw new Error('Use analyze, init-profile, refine, verify, link-run, results, compare, or readiness. See --help.');
  if (values.report) throw new Error('--report applies to link-run only.');
  if (values['max-new'] !== undefined) throw new Error('--max-new applies to compare only.');
  if (values.baseline !== undefined && values.baseline.trim() === '') throw new Error('--baseline requires a bundle directory.');
  if ((values.input === undefined) === (values.error === undefined)) throw new Error('Provide exactly one of --input or --error.');
  const format = values.format ?? 'auto';
  if (format !== 'auto' && format !== 'json' && format !== 'jsonl' && format !== 'text') throw new Error('--format must be auto, json, jsonl, or text.');
  const types = ['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual'];
  if (values.type !== undefined && !types.includes(values.type)) throw new Error('--type is not supported.');
  if (values.runtime !== undefined && !['browser', 'webview-ios', 'webview-android', 'unknown'].includes(values.runtime)) throw new Error('--runtime is not supported.');
  let content: string | readonly string[];
  let inputFormat: AnalyzeOptions['format'] = format;
  if (values.error !== undefined) {
    if (values.format !== undefined) throw new Error('--format applies to --input; direct --error is a manual report.');
    const [message, ...stack] = values.error.trim().split(/\r?\n/);
    const error = { message, ...(stack.length ? { stack: stack.join('\n') } : {}),
      ...(values.project ? { project: values.project } : {}), ...(values.environment ? { environment: values.environment } : {}),
      ...(values.release ? { release: values.release } : {}), ...(values.page ? { page: values.page } : {}),
      ...(values.type ? { type: values.type } : {}), reproduction: values.reproduce ?? [], preconditions: values.precondition ?? [],
      ...(values.runtime ? { runtime: values.runtime } : {}),
      ...(values.expected ? { expected: values.expected } : {}), ...(values['expected-source'] ? { expectedSource: values['expected-source'] } : {}),
    };
    content = JSON.stringify({ schemaVersion: 'error-to-test/manual-1', errors: [error] });
    inputFormat = 'json';
  } else {
    if (values.reproduce || values.precondition || values.expected || values['expected-source']) throw new Error('Reported context options require --error. Use manual JSON or a profile for file input.');
    content = await inputContents(values.input!, true);
  }
  const options: AnalyzeOptions = {
    format: inputFormat, ...(values.profile ? { profile: await readBoundedFile(resolve(values.profile), 1024 * 1024) } : {}),
    project: values.project, environment: values.environment, release: values.release, page: values.page, type: values.type as EventType | undefined, runtime: values.runtime as Runtime | undefined,
    from: values.from, to: values.to, ...(values.top !== undefined ? { top: Number(values.top) } : {}),
    ...(values['min-count'] !== undefined ? { minCount: Number(values['min-count']) } : {}),
    ...(values.group !== undefined ? { groupIds: values.group } : {}),
  };
  const baseline = values.baseline === undefined ? undefined : resolve(values.baseline);
  const analysis = baseline === undefined ? analyzeErrors(content, options) : await analyzeWithBaseline(content, baseline, options);
  const out = resolve(values.out ?? `.error-to-test/run-${Date.now()}-${randomUUID().slice(0, 8)}`);
  if (baseline !== undefined && insideBundleResults(await realpath(baseline), await canonicalOutput(out))) {
    throw new Error('The analysis cannot be written inside the baseline bundle results directory. Choose an outside --out DIRECTORY path.');
  }
  const files = await writeBundle(out, analysis, { reviewed: values.reviewed });
  const drafts = analysis.candidates.filter(candidate => candidate.state === 'draft').length;
  process.stdout.write(`${analysis.groups.length} error groups; ${analysis.candidates.length} TC candidates (${drafts} drafts, ${analysis.candidates.length - drafts} need context).\n`);
  if (analysis.selection) process.stdout.write(`${analysis.selection.onlyCurrentGroupCount} only-current groups; ${analysis.selection.excludedGroupCount} baseline-matched groups excluded from TC selection.\n`);
  if (analysis.groupFilter) process.stdout.write(`${analysis.groupFilter.groupIds.length} explicit group IDs requested; min-count, top, and baseline selection still apply.\n`);
  process.stdout.write(`Review ${resolve(out, 'report.md')}\n${files.length} artifacts written. Review acknowledgment: ${values.reviewed ? 'yes' : 'pending'}.\n`);
}
export function reportCliError(error: unknown): void {
  process.stderr.write(`Error to Test: ${redactText(error instanceof Error ? error.message : 'The command failed.')}\n`);
  process.exitCode = 1;
}
