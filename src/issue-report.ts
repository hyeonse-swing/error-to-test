import { literal, readVerifiedBundle } from './artifacts.ts';
import { record, timestamp } from './validation.ts';

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const groupIdPattern = /^group-[0-9a-f]{16}$/;
const candidateIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const kinds = new Set(['browser-error-json', 'manual-json', 'manual-text', 'browser-error-jsonl', 'manual-jsonl']);

function invalid(detail: string): never {
  throw new Error(`Invalid issue report snapshot: ${detail}.`);
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) invalid(label);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10000) invalid(label);
  return value;
}

function sourceCoverage(value: unknown): string[] {
  const coverage = record(value, 'analysis.coverage');
  if (!kinds.has(coverage.kind as string) ||
    coverage.frequency !== (coverage.kind === 'browser-error-json' || coverage.kind === 'browser-error-jsonl' ? 'captured-events' : 'submitted-reports') ||
    typeof coverage.partial !== 'boolean' || coverage.retention !== 'unknown') invalid('source coverage');
  const inputCount = count(coverage.inputCount, 'coverage.inputCount');
  const duplicates = count(coverage.duplicates, 'coverage.duplicates');
  const filtered = count(coverage.filtered, 'coverage.filtered');
  if (duplicates + filtered > inputCount) invalid('source coverage counts');
  const lines = [
    `Kind: ${coverage.kind}`,
    `Frequency: ${coverage.frequency}`,
    `Partial export: ${coverage.partial ? 'yes' : 'no'}`,
    'Retention coverage: unknown',
    `Input records: ${inputCount}`,
    `Duplicate records: ${duplicates}`,
    `Filtered records: ${filtered}`,
  ];
  if (coverage.period !== undefined) {
    const period = record(coverage.period, 'coverage.period');
    if (Object.keys(period).some(key => key !== 'from' && key !== 'to') ||
      (period.from === undefined && period.to === undefined)) invalid('coverage.period');
    const from = period.from === undefined ? undefined : timestamp(period.from, 'coverage.period.from');
    const to = period.to === undefined ? undefined : timestamp(period.to, 'coverage.period.to');
    if (from !== undefined && to !== undefined && from > to) invalid('coverage.period order');
    if (from !== undefined) lines.push(`Period from: ${period.from}`);
    if (to !== undefined) lines.push(`Period to: ${period.to}`);
  }
  return lines;
}

function savedGroupDetail(report: string, expectedIds: string[], requestedId: string): string {
  const headers: { id: string; start: number }[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (let start = 0; start < report.length;) {
    const newline = report.indexOf('\n', start);
    const end = newline < 0 ? report.length : newline;
    const raw = report.slice(start, end);
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closer && closer[1]![0] === fence.marker && closer[1]!.length >= fence.length) fence = undefined;
    } else {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener && !(opener[1]![0] === '`' && opener[2]!.includes('`'))) {
        fence = { marker: opener[1]![0]!, length: opener[1]!.length };
      } else {
        const header = /^## (group-[0-9a-f]{16})$/.exec(line);
        if (header) headers.push({ id: header[1]!, start });
        else if (/^ {0,3}#{1,6}[ \t]*group-/i.test(line) || (headers.length > 0 && /^##(?:[ \t]|$)/.test(line))) {
          invalid('saved report group header layout');
        }
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  if (fence) invalid('saved report has an unclosed code fence');
  if (headers.length !== expectedIds.length || headers.some((header, index) => header.id !== expectedIds[index])) {
    invalid('saved report group header layout');
  }
  const index = headers.findIndex(header => header.id === requestedId);
  if (index < 0) invalid('requested group was not found');
  return report.slice(headers[index]!.start, headers[index + 1]?.start ?? report.length).replace(/[\r\n]+$/, '');
}

/** Return one saved group section with provenance and whole-bundle coverage context. */
export async function readIssueReport(directory: string, groupId: string): Promise<string> {
  if (typeof groupId !== 'string' || !groupIdPattern.test(groupId)) invalid('requested group ID');
  const { analysis, provenance, report, verification } = await readVerifiedBundle(directory);
  const inputSha256 = sha(provenance.inputSha256, 'provenance.inputSha256');
  const analysisSha256 = sha(provenance.analysisSha256, 'provenance.analysisSha256');
  const reportSha256 = sha(provenance.reportSha256, 'provenance.reportSha256');
  const profileSha256 = provenance.profileSha256 === undefined ? undefined : sha(provenance.profileSha256, 'provenance.profileSha256');
  const suiteSha256 = provenance.suiteSha256 === undefined ? undefined : sha(provenance.suiteSha256, 'provenance.suiteSha256');

  if (!Array.isArray(analysis.groups) || analysis.groups.length > 10000) invalid('analysis.groups');
  const ids: string[] = [];
  const known = new Set<string>();
  for (const [index, value] of analysis.groups.entries()) {
    const id = record(value, `analysis.groups[${index}]`).id;
    if (typeof id !== 'string' || !groupIdPattern.test(id) || known.has(id)) invalid('analysis group IDs');
    known.add(id);
    ids.push(id);
  }
  if (!known.has(groupId)) invalid('requested group was not found');
  if (!Array.isArray(analysis.candidates) || analysis.candidates.length > 100) invalid('analysis.candidates');
  const candidateIds = new Set<string>();
  let selected = 0;
  for (const [index, value] of analysis.candidates.entries()) {
    const candidate = record(value, `analysis.candidates[${index}]`);
    if (typeof candidate.id !== 'string' || !candidateIdPattern.test(candidate.id) || candidateIds.has(candidate.id) ||
      typeof candidate.groupId !== 'string' || !groupIdPattern.test(candidate.groupId) || !known.has(candidate.groupId)) invalid('candidate IDs or group references');
    candidateIds.add(candidate.id);
    if (candidate.groupId === groupId) selected++;
  }
  if (!Array.isArray(analysis.warnings) || analysis.warnings.some(warning => typeof warning !== 'string')) invalid('analysis.warnings');
  const coverage = sourceCoverage(analysis.coverage);
  const detail = savedGroupDetail(report, ids, groupId);
  const lines = [
    '# Error to Test issue report', '',
    `Group ID: ${groupId}`,
    `Included groups: 1 of ${ids.length}`,
    `Selected TC candidates: ${selected}`,
    `Review acknowledgement: ${verification.reviewed ? 'yes' : 'no'}`,
    `Source input SHA-256: ${inputSha256}`,
    `Source analysis SHA-256: ${analysisSha256}`,
    `Source report SHA-256: ${reportSha256}`,
    ...(profileSha256 === undefined ? [] : [`Source profile SHA-256: ${profileSha256}`]),
    ...(suiteSha256 === undefined ? [] : [`Source suite SHA-256: ${suiteSha256}`]),
    '', '## Source coverage (whole original bundle)', '',
    ...coverage, '',
    'Counts describe supplied records, not error rates, affected-user counts, or complete collection.',
    'Original raw input bytes were not independently rechecked for this excerpt.',
    'Saved candidate questions are reproduced; use readiness for actual exported blockers.',
    'This excerpt does not establish execution, approval, or issue resolution.', '',
  ];
  if (selected === 0) lines.push('No selected TC candidates for this group.', '');
  if (analysis.warnings.length) lines.push('## Original analysis warnings', '', literal(analysis.warnings.join('\n')), '');
  lines.push(detail, '');
  const output = lines.join('\n');
  if (Buffer.byteLength(output) > MAX_REPORT_BYTES) throw new Error('The issue report exceeds 64 MiB. Narrow the source bundle.');
  return output;
}
