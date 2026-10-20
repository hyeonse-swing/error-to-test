import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeErrors } from './analysis.ts';
import { readBoundedFile, verifyBundle, writeBundle } from './artifacts.ts';
import { redactText } from './redact.ts';
import { linkFlowQaReport } from './results.ts';
import type { EventType, Runtime } from './types.ts';

const help = `Error to Test — local error analysis and regression TC drafts

  error-to-test analyze --input errors.json --profile profile.json --out new-directory
  error-to-test analyze --input error.txt --format text --page /items --out new-directory
  error-to-test analyze --error "TypeError: item is undefined" --page /items --out new-directory
  cat error.txt | error-to-test analyze --input - --format text --out new-directory
  error-to-test verify new-directory [--input errors.json] [--profile profile.json]
  error-to-test link-run new-directory --report path/to/qa-report.json

Options:
  --input FILE           SDK export, manual JSON, or plain error text (- for stdin)
  --error TEXT           Submit a single error directly; remaining lines are its stack
  --format auto|json|text Auto rejects malformed JSON-looking input
  --profile FILE         Confirmed app scenarios and explicit assertions (optional)
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
  --top N                Generate TCs for the first N ranked groups (1..100)
  --out DIRECTORY        New directory; existing files are never overwritten
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
  return Buffer.concat(chunks).toString('utf8');
}
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, input: { type: 'string' }, error: { type: 'string' }, report: { type: 'string' },
    format: { type: 'string' }, profile: { type: 'string' }, project: { type: 'string' }, environment: { type: 'string' },
    release: { type: 'string' }, page: { type: 'string' }, type: { type: 'string' }, runtime: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    top: { type: 'string' }, out: { type: 'string' }, reviewed: { type: 'boolean' },
    reproduce: { type: 'string', multiple: true }, precondition: { type: 'string', multiple: true },
    expected: { type: 'string' }, 'expected-source': { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return;
  }
  if (positionals.length === 0) { process.stdout.write(help); return; }
  const command = positionals[0];
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
  if (command === 'verify') {
    if (positionals.length !== 2 || !positionals[1]) throw new Error('verify requires one bundle directory.');
    if (Object.keys(values).some(key => !['input', 'profile', 'help'].includes(key))) throw new Error('Unsupported option for verify.');
    const result = await verifyBundle(resolve(positionals[1]), {
      ...(values.input ? { input: await readBoundedFile(resolve(values.input)) } : {}),
      ...(values.profile ? { profile: await readBoundedFile(resolve(values.profile), 1024 * 1024) } : {}),
    });
    process.stdout.write(`Bundle verified. Suite: ${result.suite ? 'present' : 'none'}; review: ${result.reviewed ? 'acknowledged' : 'pending'}; original input: ${result.sourceChecked ? 'checked' : 'not supplied'}.\n`);
    return;
  }
  if (command !== 'analyze' || positionals.length !== 1) throw new Error('Use analyze, verify, or link-run. See --help.');
  if (values.report) throw new Error('--report applies to link-run only.');
  if ((values.input === undefined) === (values.error === undefined)) throw new Error('Provide exactly one of --input or --error.');
  const format = values.format ?? 'auto';
  if (format !== 'auto' && format !== 'json' && format !== 'text') throw new Error('--format must be auto, json, or text.');
  const types = ['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual'];
  if (values.type !== undefined && !types.includes(values.type)) throw new Error('--type is not supported.');
  if (values.runtime !== undefined && !['browser', 'webview-ios', 'webview-android', 'unknown'].includes(values.runtime)) throw new Error('--runtime is not supported.');
  let content: string;
  let inputFormat: 'auto' | 'json' | 'text' = format;
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
    content = values.input === '-' ? await stdinText() : await readBoundedFile(resolve(values.input!));
  }
  const analysis = analyzeErrors(content, {
    format: inputFormat, ...(values.profile ? { profile: await readBoundedFile(resolve(values.profile), 1024 * 1024) } : {}),
    project: values.project, environment: values.environment, release: values.release, page: values.page, type: values.type as EventType | undefined, runtime: values.runtime as Runtime | undefined,
    from: values.from, to: values.to, ...(values.top !== undefined ? { top: Number(values.top) } : {}),
  });
  const out = resolve(values.out ?? `.error-to-test/run-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const files = await writeBundle(out, analysis, { reviewed: values.reviewed });
  const drafts = analysis.candidates.filter(candidate => candidate.state === 'draft').length;
  process.stdout.write(`${analysis.groups.length} error groups; ${analysis.candidates.length} TC candidates (${drafts} drafts, ${analysis.candidates.length - drafts} need context).\n`);
  process.stdout.write(`Review ${resolve(out, 'report.md')}\n${files.length} artifacts written. Review acknowledgment: ${values.reviewed ? 'yes' : 'pending'}.\n`);
}
export function reportCliError(error: unknown): void {
  process.stderr.write(`Error to Test: ${redactText(error instanceof Error ? error.message : 'The command failed.')}\n`);
  process.exitCode = 1;
}
