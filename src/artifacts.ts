import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { dirname, resolve } from 'node:path';
import { exportFlowQa } from './exports/flow-qa.ts';
import { hash, record, text } from './validation.ts';
import { redactText } from './redact.ts';
import { inputSource, validateInputSource } from './input-source.ts';
import type { Analysis } from './types.ts';

export function jsonText(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
// Use only after callers have sanitized each untrusted field for its context.
export function fencedText(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}
export function literal(value: string): string { return fencedText(redactText(value)); }
export function renderReport(analysis: Analysis): string {
  const draftCandidates = analysis.candidates.filter(candidate => candidate.state === 'draft').length;
  const needsContextCandidates = analysis.candidates.filter(candidate => candidate.state === 'needs-context').length;
  const lines = ['# Error to Test analysis', '',
    `Groups: ${analysis.groups.length} · TC candidates: ${analysis.candidates.length}`,
    `Draft TC candidates: ${draftCandidates} · Need context: ${needsContextCandidates}`,
    `Input: ${analysis.coverage.kind} · Count meaning: ${analysis.coverage.frequency}`,
    `Partial export: ${analysis.coverage.partial ? 'yes' : 'no'} · Retention coverage: unknown`,
    `Duplicate records: ${analysis.coverage.duplicates} · Filtered records: ${analysis.coverage.filtered}`, '',
    'Counts describe the supplied records. They are not error rates, affected-user counts, or proof of complete collection.',
    'Drafts require review. A passing TC proves only its assertions; it does not automatically close the source issue.', ''];
  if (analysis.source.inputs) lines.push('## Input files', '', literal([
    `Files: ${analysis.source.inputs.length} · Order: the supplied --input order`,
    'The source SHA-256 commits to the ordered file hashes and byte lengths. Verify with every original file in the same order.',
    ...analysis.source.inputs.map((input, index) => `${index + 1}. SHA-256: ${input.sha256} · Bytes: ${input.byteLength}`),
  ].join('\n')), '');
  if (analysis.groupFilter) lines.push('## Explicit group selection', '', literal([
    `Requested group IDs: ${analysis.groupFilter.groupIds.join(', ')}`,
    'TCs are selected from these exact current groups, intersected with any baseline selection, before min-count and top. Input ID order does not change ranking.',
    'All observed groups remain in this analysis. Unselected groups are outside the TC scope.',
  ].join('\n')), '');
  if (analysis.selection) lines.push('## Baseline candidate selection', '', literal([
    'Mode: only-current (signatures absent from the supplied baseline)',
    `Baseline input SHA-256: ${analysis.selection.baseline.inputSha256}`,
    `Baseline analysis SHA-256: ${analysis.selection.baseline.analysisSha256}`,
    `Baseline: ${analysis.selection.baseline.coverage.kind} / ${analysis.selection.baseline.coverage.frequency} · partial ${analysis.selection.baseline.coverage.partial ? 'yes' : 'no'} · retention unknown`,
    `Only-current groups before min-count/top: ${analysis.selection.onlyCurrentGroupCount}`,
    `Groups excluded as already observed: ${analysis.selection.excludedGroupCount}`,
    'All current groups remain below. Absence from this baseline does not establish when an error was introduced.',
  ].join('\n')), '');
  if (analysis.warnings.length) lines.push('## Coverage and selection notes', '', literal(analysis.warnings.join('\n')), '');
  if (!analysis.groups.length) lines.push('No matching errors were found. No suite was generated.', '');
  for (const group of analysis.groups) {
    lines.push(`## ${group.id}`, '',
      `Records: ${group.count} · Observed page views: ${group.viewCount} · Last observed: ${group.lastOccurredAt ?? 'unknown'}`, '',
      literal(`${group.project} / ${group.environment} / ${group.release} / ${group.runtime}\n${group.type} ${group.pagePath}\n${group.message}`), '');
    const stacks: string[] = [];
    const seenStacks = new Set<string>();
    const seenComponentStacks = new Set<string>();
    for (const evidence of group.evidence) {
      if (evidence.stack?.trim() && !seenStacks.has(evidence.stack)) {
        seenStacks.add(evidence.stack);
        stacks.push('Error stack:', literal(evidence.stack), '');
      }
      if (evidence.componentStack?.trim() && !seenComponentStacks.has(evidence.componentStack)) {
        seenComponentStacks.add(evidence.componentStack);
        stacks.push('React component stack:', literal(evidence.componentStack), '');
      }
    }
    if (stacks.length) lines.push('Observed stack traces (representative evidence):', '', ...stacks);
    for (const candidate of analysis.candidates.filter(item => item.groupId === group.id)) {
      lines.push(`### ${candidate.id} · ${candidate.state}`, '', literal(candidate.title), '', 'Observed facts:', literal(candidate.facts.join('\n')),
        '', 'Reported reproduction:', literal(candidate.reproduction.join('\n') || 'Not supplied'),
        '', 'Preconditions:', literal(candidate.preconditions.join('\n') || 'Not supplied'),
        '', 'Proposed test steps:', literal(candidate.steps.length ? JSON.stringify(candidate.steps, null, 2) : 'Not supplied'),
        '', 'Expected behavior:', literal(candidate.expected ? `${candidate.expected.text}\nSource: ${candidate.expected.source}` : 'Unresolved'),
        '', 'Questions:', literal(candidate.questions.join('\n') || 'No context questions. Review is still required before execution.'), '');
    }
  }
  return `${lines.join('\n')}\n`;
}
export async function writeBundle(directory: string, analysis: Analysis, options: { reviewed?: boolean } = {}): Promise<string[]> {
  const exported = exportFlowQa(analysis, options);
  const report = renderReport(analysis);
  exported.provenance.reportSha256 = hash(report);
  const files: Record<string, string> = {
    'analysis.json': jsonText(analysis), 'report.md': report,
    'flows/error-to-test.md': exported.flow, 'provenance.json': jsonText(exported.provenance),
    ...(exported.suite ? { 'cases/error-to-test.json': jsonText(exported.suite) } : {}),
  };
  if (Buffer.byteLength(files['analysis.json']!) > 64 * 1024 * 1024 || Buffer.byteLength(report) > 64 * 1024 * 1024) throw new Error('The analysis artifacts exceed 64 MiB. Narrow the input or selected scenario details.');
  const root = resolve(directory);
  await mkdir(dirname(root), { recursive: true });
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The output directory already exists. Choose a new --out path.');
    throw error;
  }
  // Exclusive files preserve any concurrent or user-supplied edits. A failed write leaves
  // an inspectable partial bundle, never an apparently verified complete result.
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(resolve(root, name)), { recursive: true });
    await writeFile(resolve(root, name), content, { flag: 'wx', mode: 0o600 });
  }
  return Object.keys(files).map(name => resolve(root, name));
}
export async function readBoundedFile(path: string, maxBytes = 10 * 1024 * 1024): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error('Input must be a regular file within the size limit.');
  const content = await readFile(path);
  if (content.length > maxBytes) throw new Error('Input exceeded the size limit while reading.');
  if (!isUtf8(content)) throw new Error('Input must be valid UTF-8.');
  return content.toString('utf8');
}
export async function readVerifiedBundle(directory: string, options: { input?: string | readonly string[]; profile?: string } = {}): Promise<{
  analysis: Record<string, unknown>;
  provenance: Record<string, unknown>;
  suite?: Record<string, unknown>;
  verification: { suite: boolean; reviewed: boolean; sourceChecked: boolean };
}> {
  const root = resolve(directory);
  const parse = (content: string, label: string): Record<string, unknown> => {
    try { return record(JSON.parse(content), label); } catch { throw new Error(`${label} is not a valid JSON object.`); }
  };
  const provenance = parse(await readBoundedFile(resolve(root, 'provenance.json')), 'provenance');
  if (provenance.schemaVersion !== 'error-to-test/provenance-1' || typeof provenance.reviewed !== 'boolean') throw new Error('Unsupported provenance contract.');
  const report = await readBoundedFile(resolve(root, 'report.md'), 64 * 1024 * 1024);
  if (hash(report) !== provenance.reportSha256) throw new Error('STALE_BUNDLE: The review report changed since export.');
  const analysisText = await readBoundedFile(resolve(root, 'analysis.json'), 64 * 1024 * 1024);
  if (hash(analysisText) !== provenance.analysisSha256) throw new Error('STALE_BUNDLE: The analysis changed since export.');
  const analysis = parse(analysisText, 'analysis');
  if (analysis.schemaVersion !== 'error-to-test/analysis-1') throw new Error('Unsupported analysis contract.');
  const source = record(analysis.source, 'analysis.source');
  if (source.inputs !== undefined) {
    try { validateInputSource(source); }
    catch { throw new Error('STALE_BUNDLE: The ordered input manifest is invalid or does not match the source hash.'); }
  }
  const flow = await readBoundedFile(resolve(root, 'flows/error-to-test.md'), 8 * 1024 * 1024);
  if (hash(flow) !== provenance.flowSha256 || source.sha256 !== provenance.inputSha256 || source.profileSha256 !== provenance.profileSha256) throw new Error('STALE_BUNDLE: Analysis, flow, and provenance no longer match.');
  if (!Array.isArray(analysis.candidates)) throw new Error('Analysis candidates are missing.');
  const mappings = analysis.candidates.map((raw, index) => {
    const candidate = record(raw, `candidates[${index}]`);
    return { caseId: candidate.id, candidateId: candidate.id, groupId: candidate.groupId, eventIds: candidate.eventIds };
  });
  if (JSON.stringify(mappings) !== JSON.stringify(provenance.mappings)) throw new Error('STALE_BUNDLE: Case provenance mappings no longer match the analysis.');
  let suiteExists = false;
  let verifiedSuite: Record<string, unknown> | undefined;
  if (provenance.suiteSha256 !== undefined) {
    const content = await readBoundedFile(resolve(root, 'cases/error-to-test.json'), 8 * 1024 * 1024);
    if (hash(content) !== provenance.suiteSha256) throw new Error('STALE_BUNDLE: The exported suite changed. Regenerate the bundle after review.');
    const suite = parse(content, 'suite'), suiteSource = record(suite.source, 'suite.source');
    if (suite.schemaVersion !== 'flow-qa/suite-1' || suiteSource.file !== 'flows/error-to-test.md' || suiteSource.sha256 !== provenance.flowSha256) throw new Error('STALE_BUNDLE: Suite source no longer matches the flow.');
    suiteExists = true;
    verifiedSuite = suite;
  }
  if (options.input !== undefined) {
    const provided = inputSource(options.input);
    const stored = source.inputs as Analysis['source']['inputs'];
    const sameFiles = provided.inputs === undefined ? stored === undefined : stored !== undefined &&
      provided.inputs.length === stored.length && provided.inputs.every((input, index) =>
        input.sha256 === stored[index]!.sha256 && input.byteLength === stored[index]!.byteLength);
    if (!sameFiles || provided.sha256 !== text(provenance.inputSha256, 'provenance.inputSha256')) throw new Error('STALE_BUNDLE: Input changed since analysis. Supply every original file in the same order.');
  }
  if (options.profile !== undefined && hash(options.profile) !== provenance.profileSha256) throw new Error('STALE_BUNDLE: Profile changed since analysis.');
  return { analysis, provenance, ...(verifiedSuite === undefined ? {} : { suite: verifiedSuite }), verification: { suite: suiteExists, reviewed: provenance.reviewed, sourceChecked: options.input !== undefined } };
}
export async function verifyBundle(directory: string, options: { input?: string | readonly string[]; profile?: string } = {}): Promise<{ suite: boolean; reviewed: boolean; sourceChecked: boolean }> {
  return (await readVerifiedBundle(directory, options)).verification;
}
