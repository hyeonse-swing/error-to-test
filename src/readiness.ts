import { literal, readVerifiedBundle } from './artifacts.ts';
import { redactText } from './redact.ts';
import { record, text } from './validation.ts';

export interface ReadinessSummary {
  schemaVersion: 'error-to-test/readiness-1';
  inputSha256: string;
  analysisSha256: string;
  suiteSha256?: string;
  reviewed: boolean;
  status: 'ready' | 'blocked' | 'empty';
  counts: { groups: number; selected: number; draft: number; needsContext: number; ready: number; blocked: number };
  cases: { caseId: string; candidateId: string; groupId: string; state: 'draft' | 'needs-context'; title: string; blockers: string[] }[];
  warnings: string[];
}

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const notes = [
  'Readiness means only that no selected-case blockers are recorded in this snapshot. It does not prove runtime access, credentials, coverage, or execution.',
  'Original input files were not supplied for this check; source content was not independently verified.',
  'No browser execution was performed.',
];

function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!idPattern.test(result)) throw new Error(`${label} must be a Flow QA-compatible ID.`);
  return result;
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!shaPattern.test(result)) throw new Error(`${label} must be a SHA-256 digest.`);
  return result;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a string array.`);
  return value.map((item, index) => redactText(text(item, `${label}[${index}]`)));
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value as number;
}

export async function readReadiness(directory: string): Promise<ReadinessSummary> {
  const { analysis, provenance, suite, verification } = await readVerifiedBundle(directory);
  const inputSha256 = sha(provenance.inputSha256, 'provenance.inputSha256');
  const analysisSha256 = sha(provenance.analysisSha256, 'provenance.analysisSha256');
  const suiteSha256 = provenance.suiteSha256 === undefined ? undefined : sha(provenance.suiteSha256, 'provenance.suiteSha256');
  if (verification.suite !== Boolean(suite) || verification.suite !== Boolean(suiteSha256)) throw new Error('STALE_BUNDLE: Suite provenance is inconsistent.');
  if (!Array.isArray(analysis.groups) || analysis.groups.length > 10000 || !Array.isArray(analysis.candidates) || analysis.candidates.length > 100) {
    throw new Error('STALE_BUNDLE: Analysis groups or selected candidates are invalid.');
  }
  const groups = new Set<string>();
  analysis.groups.forEach((raw, index) => {
    const groupId = id(record(raw, `analysis.groups[${index}]`).id, `analysis.groups[${index}].id`);
    if (groups.has(groupId)) throw new Error('STALE_BUNDLE: Analysis group IDs are duplicated.');
    groups.add(groupId);
  });
  const candidates = new Map<string, { groupId: string; state: 'draft' | 'needs-context'; title: string; questions: string[] }>();
  analysis.candidates.forEach((raw, index) => {
    const candidate = record(raw, `analysis.candidates[${index}]`);
    const candidateId = id(candidate.id, `analysis.candidates[${index}].id`);
    const groupId = id(candidate.groupId, `analysis.candidates[${index}].groupId`);
    if (!groups.has(groupId)) throw new Error('STALE_BUNDLE: A selected candidate refers to a missing group.');
    if (candidates.has(candidateId)) throw new Error('STALE_BUNDLE: Candidate IDs are duplicated.');
    if (candidate.state !== 'draft' && candidate.state !== 'needs-context') throw new Error('STALE_BUNDLE: A selected candidate has an invalid state.');
    candidates.set(candidateId, { groupId, state: candidate.state, title: redactText(text(candidate.title, `analysis.candidates[${index}].title`)), questions: strings(candidate.questions, `analysis.candidates[${index}].questions`) });
  });
  if (Boolean(suite) !== Boolean(candidates.size)) throw new Error('STALE_BUNDLE: Suite presence does not match selected candidates.');
  if (!Array.isArray(provenance.mappings) || provenance.mappings.length !== candidates.size) throw new Error('STALE_BUNDLE: Case mappings are invalid.');
  const mappings = new Map<string, { candidateId: string; groupId: string }>();
  provenance.mappings.forEach((raw, index) => {
    const mapping = record(raw, `provenance.mappings[${index}]`);
    const caseId = id(mapping.caseId, `provenance.mappings[${index}].caseId`);
    const candidateId = id(mapping.candidateId, `provenance.mappings[${index}].candidateId`);
    const groupId = id(mapping.groupId, `provenance.mappings[${index}].groupId`);
    if (mappings.has(caseId) || caseId !== candidateId || candidates.get(candidateId)?.groupId !== groupId) throw new Error('STALE_BUNDLE: Case mappings are inconsistent.');
    mappings.set(caseId, { candidateId, groupId });
  });
  const cases: ReadinessSummary['cases'] = [];
  if (suite) {
    if (!Array.isArray(suite.cases) || suite.cases.length !== candidates.size) throw new Error('STALE_BUNDLE: Suite cases do not match selected candidates.');
    const seen = new Set<string>();
    suite.cases.forEach((raw, index) => {
      const suiteCase = record(raw, `suite.cases[${index}]`);
      const caseId = id(suiteCase.id, `suite.cases[${index}].id`);
      const mapping = mappings.get(caseId);
      if (!mapping || seen.has(caseId)) throw new Error('STALE_BUNDLE: Suite contains an unknown or duplicate case ID.');
      seen.add(caseId);
      const candidate = candidates.get(mapping.candidateId)!;
      const suiteQuestions = strings(suiteCase.questions, `suite.cases[${index}].questions`);
      const blockers = [...new Set([...suiteQuestions, ...candidate.questions])];
      if (candidate.state === 'needs-context' && blockers.length === 0) blockers.push('Resolve missing context before running this case.');
      if (!verification.reviewed && suiteQuestions.length === 0) blockers.push('Bundle review is pending.');
      cases.push({ caseId, candidateId: mapping.candidateId, groupId: mapping.groupId, state: candidate.state, title: candidate.title, blockers: [...new Set(blockers)] });
    });
    if (seen.size !== candidates.size) throw new Error('STALE_BUNDLE: Suite is missing selected cases.');
  }
  const draft = cases.filter(item => item.state === 'draft').length;
  const needsContext = cases.length - draft;
  const ready = cases.filter(item => item.state === 'draft' && verification.reviewed && item.blockers.length === 0).length;
  const blocked = cases.length - ready;
  const warnings = [...strings(analysis.warnings, 'analysis.warnings'), ...notes];
  return {
    schemaVersion: 'error-to-test/readiness-1', inputSha256, analysisSha256,
    ...(suiteSha256 === undefined ? {} : { suiteSha256 }), reviewed: verification.reviewed,
    status: cases.length === 0 ? 'empty' : blocked === 0 ? 'ready' : 'blocked',
    counts: { groups: groups.size, selected: cases.length, draft, needsContext, ready, blocked }, cases, warnings,
  };
}

export function renderReadiness(summary: ReadinessSummary): string {
  if (summary.schemaVersion !== 'error-to-test/readiness-1' || !['ready', 'blocked', 'empty'].includes(summary.status) || typeof summary.reviewed !== 'boolean') throw new Error('Invalid readiness summary.');
  const lines = ['# Error to Test readiness', '', `Status: ${summary.status}`, `Review acknowledged: ${summary.reviewed ? 'yes' : 'no'}`,
    `Input SHA-256: ${sha(summary.inputSha256, 'summary.inputSha256')}`,
    `Analysis SHA-256: ${sha(summary.analysisSha256, 'summary.analysisSha256')}`];
  if (summary.suiteSha256 !== undefined) lines.push(`Suite SHA-256: ${sha(summary.suiteSha256, 'summary.suiteSha256')}`);
  lines.push('', '## Counts', '');
  for (const key of ['groups', 'selected', 'draft', 'needsContext', 'ready', 'blocked'] as const) lines.push(`- ${key}: ${count(summary.counts[key], `summary.counts.${key}`)}`);
  lines.push('', '## Cases', '');
  if (!summary.cases.length) lines.push('No selected cases.', '');
  for (const item of summary.cases) {
    if (item.state !== 'draft' && item.state !== 'needs-context') throw new Error('Invalid readiness case state.');
    lines.push(`### ${id(item.caseId, 'summary.caseId')}`, '', `Candidate ID: ${id(item.candidateId, 'summary.candidateId')}`,
      `Group ID: ${id(item.groupId, 'summary.groupId')}`, `State: ${item.state}`, '', 'Title:', '', literal(text(item.title, 'summary.title')),
      '', 'Recorded blockers:', '', literal(strings(item.blockers, 'summary.blockers').join('\n') || 'None'), '');
  }
  lines.push('## Warnings and limits', '', literal(strings(summary.warnings, 'summary.warnings').join('\n') || 'None'), '');
  return `${lines.join('\n')}\n`;
}
