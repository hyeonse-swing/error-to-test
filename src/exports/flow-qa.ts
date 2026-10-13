import type { Analysis, FlowQaExport, FlowQaSuite, TestCandidate, WebStep } from '../types.ts';
import { hash } from '../validation.ts';
import { redactText } from '../redact.ts';

const reviewQuestion = 'Review this draft case and confirm its requirement, steps, and assertion before execution.';
const blockedStep: WebStep = { type: 'act', instruction: 'Collect the missing reproduction steps; do not execute this blocked case.' };

function safe(value: string): string {
  return redactText(value);
}

function quoted(value: string): string {
  return JSON.stringify(safe(value));
}

function stepNeedsRedaction(step: WebStep): boolean {
  return JSON.stringify(step) !== JSON.stringify(step, (_key, value: unknown) => typeof value === 'string' ? safe(value) : value);
}

function exportCase(candidate: TestCandidate, reviewed: boolean): { requirement: FlowQaSuite['requirements'][number]; test: FlowQaSuite['cases'][number] } {
  const unsafeStep = candidate.steps.some(stepNeedsRedaction);
  const questions = [...candidate.questions.map(safe)];
  if (unsafeStep) questions.push('Execution steps contain sensitive data; provide reviewed, safe steps before running.');
  if (candidate.state !== 'draft' && !questions.length) questions.push('Resolve missing context before running this case.');
  if (!reviewed) questions.push(reviewQuestion);
  const uniqueQuestions = [...new Set(questions)];
  const runnable = candidate.state === 'draft' && !unsafeStep && uniqueQuestions.length === 0;
  const id = candidate.id;
  const requirementId = `R_${hash(`${candidate.groupId}:${candidate.ruleId ?? 'manual'}`).slice(0, 16)}`;
  const requirementText = candidate.expected
    ? `Expected behavior: ${safe(candidate.expected.text)} (source: ${safe(candidate.expected.source)})`
    : 'Expected behavior unresolved: identify the intended outcome and its authoritative source.';
  if (requirementText.length > 8192) throw new Error(`Flow QA requirement for ${id} exceeds 8192 characters.`);
  const test: FlowQaSuite['cases'][number] = {
    id,
    title: safe(candidate.title),
    requirementIds: [requirementId],
    preconditions: candidate.preconditions.map(safe),
    questions: uniqueQuestions,
    steps: runnable ? candidate.steps : unsafeStep || !candidate.steps.length ? [blockedStep] : candidate.steps,
  };
  return { requirement: { id: requirementId, text: requirementText }, test };
}

export function exportFlowQa(analysis: Analysis, options: { reviewed?: boolean } = {}): FlowQaExport {
  if (analysis.candidates.length > 100) throw new Error(`Flow QA supports at most 100 cases; received ${analysis.candidates.length}. Narrow the analysis before export.`);
  const reviewed = options.reviewed === true;
  const exported = analysis.candidates.map((candidate) => exportCase(candidate, reviewed));
  const lines: string[] = [
    '# Error to test review',
    '',
    `Source SHA-256: ${analysis.source.sha256}`,
    `Candidate count: ${analysis.candidates.length}`,
    `Review acknowledged: ${reviewed ? 'yes' : 'no'}`,
    '',
  ];
  if (!exported.length) lines.push('No test cases were generated from this analysis.', '');
  for (const [index, item] of exported.entries()) {
    const candidate = analysis.candidates[index]!;
    lines.push(`## ${index + 1}. ${quoted(candidate.title)}`, '');
    lines.push(`- Case ID: ${item.test.id}`);
    lines.push(`- State: ${candidate.state}`);
    lines.push(`- Group ID: ${quoted(candidate.groupId)}`);
    if (candidate.ruleId) lines.push(`- Scenario rule: ${quoted(candidate.ruleId)}`);
    lines.push(`- Requirement: ${quoted(item.requirement.text)}`);
    lines.push(`- Event IDs: ${candidate.eventIds.map(quoted).join(', ') || 'none'}`);
    lines.push('- Observed facts:');
    for (const fact of candidate.facts) lines.push(`  - ${quoted(fact)}`);
    if (!candidate.facts.length) lines.push('  - none');
    lines.push('- Hypotheses:');
    for (const hypothesis of candidate.hypotheses) lines.push(`  - ${quoted(hypothesis)}`);
    if (!candidate.hypotheses.length) lines.push('  - none');
    lines.push('- Reported reproduction:');
    for (const action of candidate.reproduction) lines.push(`  - ${quoted(action)}`);
    if (!candidate.reproduction.length) lines.push('  - missing');
    lines.push('- Missing information / review questions:');
    for (const question of item.test.questions) lines.push(`  - ${quoted(question)}`);
    if (!item.test.questions.length) lines.push('  - none');
    lines.push('- Flow QA steps:');
    for (const step of item.test.steps) lines.push(`  - ${quoted(JSON.stringify(step))}`);
    lines.push('');
  }
  const flow = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(flow) > 128_000) throw new Error('The generated flow exceeds Flow QA\'s 128 KB source limit. Narrow the selected groups or scenario details.');
  const flowSha256 = hash(flow);
  const result: FlowQaExport = {
    flow,
    provenance: {
      schemaVersion: 'error-to-test/provenance-1',
      inputSha256: analysis.source.sha256,
      analysisSha256: hash(`${JSON.stringify(analysis, null, 2)}\n`),
      ...(analysis.source.profileSha256 ? { profileSha256: analysis.source.profileSha256 } : {}),
      flowSha256,
      reviewed,
      mappings: analysis.candidates.map((candidate) => ({ caseId: candidate.id, candidateId: candidate.id, groupId: candidate.groupId, eventIds: [...candidate.eventIds] })),
    },
  };
  if (exported.length) {
    const suite: FlowQaSuite = {
      schemaVersion: 'flow-qa/suite-1', platform: 'web', id: 'error_to_test', title: 'Error to test candidates',
      source: { file: 'flows/error-to-test.md', sha256: flowSha256 },
      requirements: exported.map((item) => item.requirement),
      cases: exported.map((item) => item.test),
    };
    result.suite = suite;
    const suiteText = `${JSON.stringify(suite, null, 2)}\n`;
    if (Buffer.byteLength(suiteText) > 512 * 1024) throw new Error('The generated suite exceeds Flow QA UI\'s 512 KiB limit. Narrow the selected groups or scenario details.');
    result.provenance.suiteSha256 = hash(suiteText);
  }
  return result;
}
