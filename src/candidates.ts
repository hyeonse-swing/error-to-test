import type { AppProfile, IssueGroup, ScenarioRule, TestCandidate, WebStep } from './types.ts';
import { hash, optionalText, parseWebSteps, record, strings, text } from './validation.ts';
import { pagePath, redactText, safeUrl } from './redact.ts';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const eventTypes = new Set(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const runtimes = new Set(['browser', 'webview-ios', 'webview-android', 'unknown']);

function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!idPattern.test(result)) throw new Error(`${label} must be a Flow QA-compatible ID.`);
  return result;
}

function path(value: string, label: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('?') || value.includes('#')) throw new Error(`${label} must be an app-relative path without query or fragment.`);
  return value;
}

function profileText(value: unknown, label: string): string {
  const result = text(value, label);
  if (redactText(result) !== result) throw new Error(`${label} contains sensitive data; remove it before using this profile.`);
  return result;
}

function profileStrings(value: unknown, label: string): string[] {
  return strings(value, label).map((item, index) => profileText(item, `${label}[${index}]`));
}

function stepsContainSensitiveData(steps: WebStep[]): boolean {
  const credentialFill = steps.some((step) => step.type === 'fill' &&
    /password|passwd|secret|token|api[_-]?key|authorization|cookie|session/i.test(
      `${step.locator.value} ${'name' in step.locator ? step.locator.name ?? '' : ''}`));
  if (credentialFill) return true;
  const sanitized = steps.map((step) => {
    switch (step.type) {
      case 'open': return { ...step, path: safeUrl(step.path) };
      case 'assertUrl': return { ...step, expected: safeUrl(step.expected) };
      default: return JSON.parse(JSON.stringify(step, (_key, value: unknown) => typeof value === 'string' ? redactText(value) : value)) as WebStep;
    }
  });
  return JSON.stringify(steps) !== JSON.stringify(sanitized);
}

export function parseProfile(raw: unknown): AppProfile {
  const input = record(raw, 'profile');
  if (input.schemaVersion !== 'error-to-test/profile-1') throw new Error('Unsupported profile schemaVersion.');
  if (!Array.isArray(input.scenarios) || input.scenarios.length > 100) throw new Error('profile.scenarios must be an array of at most 100 scenarios.');
  const scenarios = input.scenarios.map((rawRule, index): ScenarioRule => {
    const label = `profile.scenarios[${index}]`;
    const rule = record(rawRule, label);
    const match = record(rule.match, `${label}.match`);
    const fields = ['type', 'messageIncludes', 'pagePath', 'networkPath', 'environment', 'release', 'runtime'] as const;
    if (!fields.some((field) => match[field] !== undefined)) throw new Error(`${label}.match needs at least one predicate.`);
    const type = optionalText(match.type, `${label}.match.type`);
    const runtime = optionalText(match.runtime, `${label}.match.runtime`);
    if (type && !eventTypes.has(type)) throw new Error(`${label}.match.type is invalid.`);
    if (runtime && !runtimes.has(runtime)) throw new Error(`${label}.match.runtime is invalid.`);
    const page = match.pagePath === undefined ? undefined : profileText(match.pagePath, `${label}.match.pagePath`);
    const network = match.networkPath === undefined ? undefined : profileText(match.networkPath, `${label}.match.networkPath`);
    if (page) path(page, `${label}.match.pagePath`);
    if (network) path(network, `${label}.match.networkPath`);
    return {
      id: identifier(rule.id, `${label}.id`),
      title: profileText(rule.title, `${label}.title`),
      match: {
        ...(type ? { type: type as ScenarioRule['match']['type'] } : {}),
        ...(match.messageIncludes !== undefined ? { messageIncludes: profileText(match.messageIncludes, `${label}.match.messageIncludes`) } : {}),
        ...(page ? { pagePath: page } : {}),
        ...(network ? { networkPath: network } : {}),
        ...(match.environment !== undefined ? { environment: profileText(match.environment, `${label}.match.environment`) } : {}),
        ...(match.release !== undefined ? { release: profileText(match.release, `${label}.match.release`) } : {}),
        ...(runtime ? { runtime: runtime as ScenarioRule['match']['runtime'] } : {}),
      },
      requirement: profileText(rule.requirement, `${label}.requirement`),
      expectedSource: profileText(rule.expectedSource, `${label}.expectedSource`),
      preconditions: profileStrings(rule.preconditions, `${label}.preconditions`),
      setupConfirmed: rule.setupConfirmed === undefined ? false : confirmed(rule.setupConfirmed, `${label}.setupConfirmed`),
      questions: profileStrings(rule.questions, `${label}.questions`),
      steps: parseWebSteps(rule.steps, `${label}.steps`),
    };
  });
  if (new Set(scenarios.map((rule) => rule.id)).size !== scenarios.length) throw new Error('Profile scenario IDs must be unique.');
  return { schemaVersion: 'error-to-test/profile-1', name: profileText(input.name, 'profile.name'), scenarios };
}

function confirmed(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function matches(rule: ScenarioRule, group: IssueGroup): boolean {
  const match = rule.match;
  return (!match.type || match.type === group.type)
    && (!match.messageIncludes || group.message.includes(match.messageIncludes))
    && (!match.pagePath || match.pagePath === group.pagePath)
    && (!match.environment || match.environment === group.environment)
    && (!match.release || match.release === group.release)
    && (!match.runtime || match.runtime === group.runtime)
    && (!match.networkPath || group.evidence.some((event) => event.network && pagePath(event.network.url) === match.networkPath));
}

function common<T>(items: T[]): T | undefined {
  if (!items.length) return undefined;
  const first = items[0];
  return items.every((item) => JSON.stringify(item) === JSON.stringify(first)) ? first : undefined;
}

function hasAssertion(steps: WebStep[]): boolean {
  return steps.some((step) => step.type.startsWith('assert'));
}

function hasAction(steps: WebStep[]): boolean {
  return steps.some((step) => step.type === 'act' || step.type === 'click' || step.type === 'fill');
}

function questionsForSteps(steps: WebStep[], directNavigation: boolean): string[] {
  const questions: string[] = [];
  if (steps[0]?.type !== 'open' || !steps[0].path) questions.push('Which explicit app path should this web case open first?');
  if (!hasAction(steps) && !directNavigation) questions.push('What user action reproduced the issue? Supply explicit steps, or document a confirmed direct-navigation scenario.');
  if (!hasAssertion(steps)) questions.push('What observable assertion confirms the expected behavior?');
  return questions;
}

function safeFacts(group: IssueGroup): string[] {
  const facts = [`${group.count} captured event(s); ${group.viewCount} view(s).`, `Observed ${group.type} error: ${redactText(group.message)}`, `Runtime: ${group.runtime}; environment: ${redactText(group.environment)}; release: ${redactText(group.release)}.`];
  if (group.pagePath) facts.push(`Observed page path: ${redactText(group.pagePath)}`);
  for (const event of group.evidence) {
    if (event.network) facts.push(`Observed network response: ${event.network.method} ${safeUrl(event.network.url)}${event.network.status === undefined ? '' : ` (${event.network.status})`}.`);
    if (event.source === 'manual' && event.expected) facts.push(`Reporter-provided expected behavior: ${redactText(event.expected)}${event.expectedSource ? ` (source: ${redactText(event.expectedSource)})` : ' (source missing)'}.`);
  }
  if (group.context?.expected) facts.push(`Reporter-provided expected behavior: ${redactText(group.context.expected)}${group.context.expectedSource ? ` (source: ${redactText(group.context.expectedSource)})` : ' (source missing)'}.`);
  return [...new Set(facts)];
}

function createOne(group: IssueGroup, rule?: ScenarioRule): TestCandidate {
  const evidence = group.evidence;
  const context = group.context;
  const questions = [...(rule?.questions ?? []), ...(context?.questions ?? evidence.flatMap((event) => event.questions)), ...(context?.conflicts ?? [])];
  const manualSteps = !rule ? (context ? context.steps : common(evidence.map((event) => event.steps))) : undefined;
  const submittedSteps = rule?.steps ?? manualSteps ?? [];
  const steps = stepsContainSensitiveData(submittedSteps) ? [] : submittedSteps;
  const manualExpected = !rule ? (context
    ? context.expected && context.expectedSource ? { text: context.expected, source: context.expectedSource } : undefined
    : common(evidence.map((event) => event.expected && event.expectedSource ? { text: event.expected, source: event.expectedSource } : undefined))) : undefined;
  const expected = rule ? { text: rule.requirement, source: rule.expectedSource } : manualExpected;
  const preconditions = rule?.preconditions ?? (context ? context.preconditions : common(evidence.map((event) => event.preconditions))) ?? [];
  const reproduction = context ? context.reproduction ?? [] : [...new Set(evidence.flatMap((event) => event.reproduction))];
  if (!rule && !context && !common(evidence.map((event) => event.reproduction)) && reproduction.length) questions.push('Which reported reproduction sequence applies to this group?');
  if (!rule && !manualSteps) questions.push('Which explicit reproduction steps apply to all events in this group?');
  if (steps.length !== submittedSteps.length) questions.push('Execution steps contained sensitive data. Provide safe, reviewed steps before running.');
  if (!expected) questions.push('What is the expected behavior, and which requirement or reporter establishes it?');
  if (!rule && preconditions.length) questions.push('Have the reported setup and preconditions been confirmed?');
  if (preconditions.some((condition) => redactText(condition) !== condition)) questions.push('Reported preconditions contained sensitive data. Provide safe setup instructions.');
  if (rule && !rule.setupConfirmed) questions.push('Has the scenario setup and its preconditions been confirmed?');
  if (group.runtime !== 'browser') questions.push(`Which actual test engine and context cover the ${group.runtime} runtime?`);
  if (!rule && expected && !hasAssertion(steps)) questions.push('The reported expected behavior needs an explicit observable assertion.');
  questions.push(...questionsForSteps(steps, Boolean(rule?.setupConfirmed && preconditions.length)));
  const id = `TC_${hash(`${group.id}:${rule?.id ?? 'manual'}`).slice(0, 16)}`;
  return {
    id, groupId: group.id, title: rule?.title ?? `Investigate ${group.type} error`,
    state: questions.length ? 'needs-context' : 'draft',
    facts: safeFacts(group), hypotheses: [], reproduction: reproduction.map(redactText),
    preconditions: preconditions.filter((condition) => redactText(condition) === condition),
    ...(expected ? { expected: { text: redactText(expected.text), source: redactText(expected.source) } } : {}),
    questions: [...new Set(questions.map(redactText))], steps,
    eventIds: [...new Set(group.eventIds)], ...(rule ? { ruleId: rule.id } : {}),
  };
}

export function createCandidates(groups: IssueGroup[], profile?: AppProfile): TestCandidate[] {
  return groups.flatMap((group) => {
    const rules = (profile?.scenarios ?? []).filter((rule) => matches(rule, group)).sort((a, b) => a.id.localeCompare(b.id));
    return rules.length ? rules.map((rule) => createOne(group, rule)) : [createOne(group)];
  });
}
