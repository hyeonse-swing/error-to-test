import type { Analysis, AppProfile, IssueGroup, ScenarioRule, WebStep } from './types.ts';
import { pagePath, redactText, safeUrl } from './redact.ts';
import { parseWebSteps, record } from './validation.ts';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const question = 'Confirm the expected behavior, setup, reproduction steps, and assertion, then remove this question.';

function selectedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error(`${label} must be a Flow QA-compatible ID.`);
  return value;
}

function observedPath(group: IssueGroup): WebStep[] {
  const sources = [group.pagePath, ...(Array.isArray(group.evidence) ? group.evidence.map((event) => event?.page) : [])];
  for (const source of sources) {
    if (typeof source !== 'string' || !source.startsWith('/') || source.startsWith('//') || /[\p{Cc}\p{Cf}\\]/u.test(source)) continue;
    const originalPath = source.split(/[?#]/, 1)[0] ?? '';
    if (/\[redacted[^\]]*\]/i.test(originalPath) || redactText(originalPath) !== originalPath) continue;
    const sanitized = safeUrl(source);
    const path = pagePath(sanitized);
    if (!path.startsWith('/') || path.startsWith('//') || /[\p{Cc}\p{Cf}\\]/u.test(path) || path.includes('?') || path.includes('#') || path.length > 8192) continue;
    try {
      return parseWebSteps([{ type: 'open', path }], 'template.steps');
    } catch {
      // The observation is optional; an invalid path must not invent a navigation target.
    }
  }
  return [];
}

function reviewTitle(message: unknown): string {
  const safe = typeof message === 'string' ? redactText(message).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : '';
  const short = [...safe].slice(0, 190).join('').trim();
  return `Review ${short || 'observed error'}`;
}

export function createProfileTemplate(analysis: Analysis): AppProfile {
  const input = record(analysis, 'analysis');
  if (!Array.isArray(input.groups) || input.groups.length > 10000) throw new Error('analysis.groups must be an array of at most 10000 groups.');
  if (!Array.isArray(input.candidates) || !input.candidates.length) throw new Error('analysis.candidates must contain selected candidates.');

  const selected = new Set<string>();
  for (const [index, raw] of input.candidates.entries()) {
    selected.add(selectedId(record(raw, `analysis.candidates[${index}]`).groupId, `analysis.candidates[${index}].groupId`));
  }
  if (selected.size > 100) throw new Error('Template supports at most 100 selected groups and scenarios.');

  const seen = new Set<string>();
  const scenarios: ScenarioRule[] = [];
  for (const [index, raw] of input.groups.entries()) {
    const group = record(raw, `analysis.groups[${index}]`);
    const id = selectedId(group.id, `analysis.groups[${index}].id`);
    if (!selected.has(id)) continue;
    if (seen.has(id)) throw new Error(`Selected group ID is duplicated: ${id}.`);
    seen.add(id);
    if (`review-${id}`.length > 80) throw new Error(`Selected group ID is too long for a profile scenario: ${id}.`);
    scenarios.push({
      id: `review-${id}`,
      title: reviewTitle(group.message),
      match: { groupId: id },
      requirement: '',
      expectedSource: '',
      preconditions: [],
      setupConfirmed: false,
      questions: [question],
      steps: observedPath(group as unknown as IssueGroup),
    });
  }
  if (seen.size !== selected.size) throw new Error('Selected candidate references a missing group ID.');
  return { schemaVersion: 'error-to-test/profile-1', name: 'Error to Test review', scenarios };
}
