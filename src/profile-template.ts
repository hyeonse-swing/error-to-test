import type { Analysis, AppProfile, IssueGroup, ScenarioRule, WebStep } from './types.ts';
import { matchesScenarioRule, parseProfile, stepsContainSensitiveData } from './candidates.ts';
import { pagePath, redactText, safeUrl } from './redact.ts';
import { parseWebSteps, record } from './validation.ts';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const question = 'Confirm the expected behavior, setup, reproduction steps, and assertion, then remove this question.';
const maxProfileBytes = 1024 * 1024;

export interface ProfileTemplateOptions { profile?: unknown }

function assertJsonValue(value: unknown, active: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object') throw new Error('The profile object must contain only JSON values.');
  if (active.has(value)) throw new Error('The profile object must contain only JSON values.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('The profile object must contain only JSON values.');
  }
  active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1) throw new Error('The profile object must contain only JSON values.');
    for (const key of keys) {
      if (Array.isArray(value) && key === 'length') continue;
      if (typeof key !== 'string' || (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new Error('The profile object must contain only JSON values.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('The profile object must contain only JSON values.');
      assertJsonValue(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

function existingProfile(raw: unknown): AppProfile {
  let input: unknown;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > maxProfileBytes) throw new Error('The profile must be 1 MiB or smaller.');
    try { input = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('The profile is not valid JSON.'); }
  } else {
    let serialized: string;
    try {
      assertJsonValue(raw, new WeakSet<object>());
      serialized = JSON.stringify(raw);
    } catch { throw new Error('The profile object must contain only JSON values.'); }
    if (Buffer.byteLength(serialized, 'utf8') > maxProfileBytes) throw new Error('The profile must be 1 MiB or smaller.');
    input = JSON.parse(serialized);
  }
  const parsed = parseProfile(input);
  if (parsed.scenarios.some((scenario) => redactText(scenario.id) !== scenario.id ||
    (scenario.match.groupId !== undefined && redactText(scenario.match.groupId) !== scenario.match.groupId))) {
    throw new Error('The existing profile contains sensitive scenario IDs; remove them before extending it.');
  }
  if (parsed.scenarios.some((scenario) => stepsContainSensitiveData(scenario.steps))) {
    throw new Error('The existing profile contains sensitive execution steps; remove them before extending it.');
  }
  return parsed;
}

function newScenarioId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let number = 2; ; number++) {
    const suffix = `-${number}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

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

export function createProfileTemplate(analysis: Analysis, options: ProfileTemplateOptions = {}): AppProfile {
  const input = record(analysis, 'analysis');
  if (!Array.isArray(input.groups) || input.groups.length > 10000) throw new Error('analysis.groups must be an array of at most 10000 groups.');
  if (!Array.isArray(input.candidates) || !input.candidates.length) throw new Error('analysis.candidates must contain selected candidates.');

  const selected = new Set<string>();
  for (const [index, raw] of input.candidates.entries()) {
    selected.add(selectedId(record(raw, `analysis.candidates[${index}]`).groupId, `analysis.candidates[${index}].groupId`));
  }
  if (selected.size > 100) throw new Error('Template supports at most 100 selected groups and scenarios.');

  const existing = options.profile === undefined ? undefined : existingProfile(options.profile);
  const seen = new Set<string>();
  const scenarios: ScenarioRule[] = existing ? [...existing.scenarios] : [];
  const usedIds = new Set(scenarios.map((scenario) => scenario.id));
  for (const [index, raw] of input.groups.entries()) {
    const group = record(raw, `analysis.groups[${index}]`);
    const id = selectedId(group.id, `analysis.groups[${index}].id`);
    if (!selected.has(id)) continue;
    if (seen.has(id)) throw new Error(`Selected group ID is duplicated: ${id}.`);
    seen.add(id);
    if (existing && existing.scenarios.some((scenario) => matchesScenarioRule(scenario, group as unknown as IssueGroup))) continue;
    if (`review-${id}`.length > 80) throw new Error(`Selected group ID is too long for a profile scenario: ${id}.`);
    if (scenarios.length >= 100) throw new Error('The extended profile supports at most 100 scenarios.');
    const scenarioId = existing ? newScenarioId(`review-${id}`, usedIds) : `review-${id}`;
    usedIds.add(scenarioId);
    scenarios.push({
      id: scenarioId,
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
  const profile: AppProfile = { schemaVersion: 'error-to-test/profile-1', name: existing?.name ?? 'Error to Test review', scenarios };
  if (existing && Buffer.byteLength(`${JSON.stringify(profile, null, 2)}\n`, 'utf8') > maxProfileBytes) {
    throw new Error('The generated profile exceeds 1 MiB. Narrow the selected groups or scenario details.');
  }
  return profile;
}
