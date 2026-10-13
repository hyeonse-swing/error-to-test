import { createHash } from 'node:crypto';
import type { ErrorObservation, EventType, ParsedInput, Runtime, WebStep } from './types.ts';
import { record, text, optionalText, strings, timestamp, parseWebSteps, hash } from './validation.ts';
import { redactText, safeUrl } from './redact.ts';

export interface ParseInputOptions {
  format?: 'auto' | 'json' | 'text';
  project?: string;
  environment?: string;
  release?: string;
  page?: string;
  type?: EventType;
  runtime?: Runtime;
  from?: string;
  to?: string;
}

const TYPES = new Set<EventType>(['javascript', 'promise', 'react', 'console', 'http', 'network', 'manual']);
const RUNTIMES = new Set<Runtime>(['browser', 'webview-ios', 'webview-android', 'unknown']);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const LOGGER_PREFIX = /^\[(?:ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|vite|timestamp|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2})\][ \t]+\S/i;

function eventType(value: unknown, label: string): EventType {
  if (typeof value !== 'string' || !TYPES.has(value as EventType)) throw new Error(`${label} must be a valid event type`);
  return value as EventType;
}

function runtime(value: unknown, label: string): Runtime {
  if (typeof value !== 'string' || !RUNTIMES.has(value as Runtime)) throw new Error(`${label} must be a valid runtime`);
  return value as Runtime;
}

function number(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a nonnegative ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] {
  return value === undefined ? [] : strings(value, label).map(redactText);
}

function safeSteps(value: unknown, label: string): { steps: WebStep[]; redacted: boolean } {
  const steps = value === undefined ? [] : parseWebSteps(value, label);
  // The step parser establishes the shape before any user text is sanitized.
  const sanitized = steps.map((step) => {
    const clean = (input: string) => redactText(input);
    switch (step.type) {
      case 'open': return { ...step, path: safeUrl(step.path) };
      case 'act': case 'assertAgent': return { ...step, instruction: clean(step.instruction) };
      case 'click': case 'assertVisible': return { ...step, locator: { ...step.locator, value: clean(step.locator.value), ...('name' in step.locator && step.locator.name ? { name: clean(step.locator.name) } : {}) } };
      case 'fill': return { ...step, locator: { ...step.locator, value: clean(step.locator.value), ...('name' in step.locator && step.locator.name ? { name: clean(step.locator.name) } : {}) }, value: clean(step.value) };
      case 'assertText': return { ...step, locator: { ...step.locator, value: clean(step.locator.value), ...('name' in step.locator && step.locator.name ? { name: clean(step.locator.name) } : {}) }, expected: clean(step.expected) };
      case 'assertUrl': return { ...step, expected: safeUrl(step.expected) };
    }
  });
  const credentialFill = steps.some((step) => step.type === 'fill' &&
    /password|passwd|secret|token|api[_-]?key|authorization|cookie|session/i.test(
      `${step.locator.value} ${'name' in step.locator ? step.locator.name ?? '' : ''}`));
  // A changed action or assertion would no longer express the author's intent.
  // Keep the report, but require the missing safe step to be supplied explicitly.
  return !credentialFill && JSON.stringify(steps) === JSON.stringify(sanitized)
    ? { steps, redacted: false }
    : { steps: [], redacted: true };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

function browserEvent(value: unknown, index: number): ErrorObservation {
  const label = `events[${index}]`;
  const item = record(value, label);
  if (item.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  const id = text(item.eventId, `${label}.eventId`);
  const project = text(item.project, `${label}.project`);
  const environment = text(item.environment, `${label}.environment`);
  const release = text(item.release, `${label}.release`);
  text(item.sdkVersion, `${label}.sdkVersion`);
  const occurredAt = timestamp(item.occurredAt, `${label}.occurredAt`);
  if (item.receivedAt !== undefined) timestamp(item.receivedAt, `${label}.receivedAt`);
  const viewId = text(item.viewId, `${label}.viewId`);
  number(item.sequence, `${label}.sequence`, true);
  number(item.elapsedMs, `${label}.elapsedMs`);
  const type = eventType(item.type, `${label}.type`);
  const message = text(item.message, `${label}.message`);
  const name = optionalText(item.name, `${label}.name`);
  const stack = optionalText(item.stack, `${label}.stack`);
  const componentStack = optionalText(item.componentStack, `${label}.componentStack`);
  const page = text(item.page, `${label}.page`);
  const eventRuntime = runtime(item.runtime, `${label}.runtime`);
  optionalText(item.browser, `${label}.browser`);
  if (item.context !== undefined) {
    const context = record(item.context, `${label}.context`);
    for (const [key, val] of Object.entries(context)) {
      if (val !== null && typeof val !== 'string' && typeof val !== 'boolean' && (typeof val !== 'number' || !Number.isFinite(val))) {
        throw new Error(`${label}.context.${key} must be scalar`);
      }
    }
  }
  let network: ErrorObservation['network'];
  if (item.network !== undefined) {
    const net = record(item.network, `${label}.network`);
    const method = text(net.method, `${label}.network.method`);
    const url = text(net.url, `${label}.network.url`);
    const durationMs = number(net.durationMs, `${label}.network.durationMs`);
    let status: number | undefined;
    if (net.status !== undefined) {
      status = number(net.status, `${label}.network.status`, true);
      if (status < 100 || status > 599) throw new Error(`${label}.network.status must be 100..599`);
    }
    network = { method: redactText(method).toUpperCase(), url: safeUrl(url), durationMs, ...(status === undefined ? {} : { status }) };
  }
  return {
    id: redactText(id), source: 'browser-error', project: redactText(project), environment: redactText(environment),
    release: redactText(release), type, message: redactText(message), runtime: eventRuntime,
    ...(name === undefined ? {} : { name: redactText(name) }),
    ...(stack === undefined ? {} : { stack: redactText(stack) }),
    ...(componentStack === undefined ? {} : { componentStack: redactText(componentStack) }),
    page: safeUrl(page), occurredAt, viewId: redactText(viewId),
    ...(network === undefined ? {} : { network }),
    reproduction: [], preconditions: [], questions: [], steps: [],
  };
}

function manualError(value: unknown, index: number, defaults: ParseInputOptions): ErrorObservation {
  const label = `errors[${index}]`;
  const item = record(value, label);
  const message = text(item.message, `${label}.message`);
  const id = optionalText(item.id, `${label}.id`) ?? `manual-${hash(canonical(item)).slice(0, 24)}`;
  const type = item.type === undefined ? defaults.type ?? 'manual' : eventType(item.type, `${label}.type`);
  const project = optionalText(item.project, `${label}.project`) ?? defaults.project ?? 'unknown';
  const environment = optionalText(item.environment, `${label}.environment`) ?? defaults.environment ?? 'unknown';
  const release = optionalText(item.release, `${label}.release`) ?? defaults.release ?? 'unknown';
  const page = optionalText(item.page, `${label}.page`) ?? defaults.page;
  const name = optionalText(item.name, `${label}.name`);
  const stack = optionalText(item.stack, `${label}.stack`);
  const componentStack = optionalText(item.componentStack, `${label}.componentStack`);
  const eventRuntime = item.runtime === undefined ? (defaults.runtime === undefined ? 'unknown' : runtime(defaults.runtime, 'runtime')) : runtime(item.runtime, `${label}.runtime`);
  const occurredAt = item.occurredAt === undefined ? undefined : timestamp(item.occurredAt, `${label}.occurredAt`);
  const reproduction = optionalStringArray(item.reproduction, `${label}.reproduction`);
  const preconditions = optionalStringArray(item.preconditions, `${label}.preconditions`);
  const questions = optionalStringArray(item.questions, `${label}.questions`);
  const expected = optionalText(item.expected, `${label}.expected`);
  const expectedSource = optionalText(item.expectedSource, `${label}.expectedSource`);
  const alteredExpected = (expected !== undefined && redactText(expected) !== expected) ||
    (expectedSource !== undefined && redactText(expectedSource) !== expectedSource);
  const stepResult = safeSteps(item.steps, `${label}.steps`);
  if (stepResult.redacted) questions.push('Provide safe reproduction steps without credentials or personal data.');
  if (alteredExpected) questions.push('Provide safe expected behavior and its source without credentials or personal data.');
  return {
    id: redactText(id), source: 'manual', project: redactText(project), environment: redactText(environment),
    release: redactText(release), type, message: redactText(message), runtime: eventRuntime,
    ...(page === undefined ? {} : { page: safeUrl(page) }),
    ...(name === undefined ? {} : { name: redactText(name) }),
    ...(stack === undefined ? {} : { stack: redactText(stack) }),
    ...(componentStack === undefined ? {} : { componentStack: redactText(componentStack) }),
    ...(occurredAt === undefined ? {} : { occurredAt }), reproduction, preconditions, questions,
    ...(!alteredExpected && expected !== undefined ? { expected } : {}),
    ...(!alteredExpected && expectedSource !== undefined ? { expectedSource } : {}), steps: stepResult.steps,
  };
}

export function parseInput(content: string, options: ParseInputOptions = {}): ParsedInput {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('Input exceeds 10 MiB');
  if (!content.trim()) throw new Error('Input is empty');
  const from = options.from === undefined ? undefined : timestamp(options.from, 'from');
  const to = options.to === undefined ? undefined : timestamp(options.to, 'to');
  if (from && to && from > to) throw new Error('from must not exceed to');
  const format = options.format ?? 'auto';
  if (!['auto', 'json', 'text'].includes(format)) throw new Error('Invalid input format');
  const trimmed = content.trimStart();
  const isJson = format === 'json' || (format === 'auto' && /^[\[{]/.test(trimmed) && !LOGGER_PREFIX.test(trimmed));
  let observations: ErrorObservation[];
  let kind: ParsedInput['coverage']['kind'];
  let partial = false;
  let raw: unknown[];
  if (isJson) {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error('Malformed JSON input'); }
    if (Array.isArray(parsed)) {
      kind = 'browser-error-json';
      raw = parsed;
    } else {
      const top = record(parsed, 'input');
      if (top.schemaVersion === 1) {
        kind = 'browser-error-json';
        if (top.partial !== undefined && typeof top.partial !== 'boolean') throw new Error('partial must be boolean');
        partial = top.partial === true;
        if (!Array.isArray(top.events)) throw new Error('events must be an array');
        raw = top.events;
      } else if (top.schemaVersion === 'error-to-test/manual-1') {
        kind = 'manual-json';
        if (!Array.isArray(top.errors)) throw new Error('errors must be an array');
        raw = top.errors;
      } else throw new Error('Unsupported input schemaVersion');
    }
    if (raw.length === 0) throw new Error('Input has no records');
    if (raw.length > MAX_RECORDS) throw new Error('Input exceeds 10000 records');
    observations = raw.map((item, index) => kind === 'browser-error-json' ? browserEvent(item, index) : manualError(item, index, options));
  } else {
    kind = 'manual-text';
    const lines = content.trim().split(/\r?\n/);
    const message = lines.shift()!.trim();
    if (!message) throw new Error('Error message is empty');
    observations = [manualError({ message, ...(lines.length ? { stack: lines.join('\n') } : {}) }, 0, options)];
    raw = [content];
  }
  const inputCount = raw.length;
  const seen = new Map<string, string>();
  const unique: ErrorObservation[] = [];
  let duplicates = 0;
  for (let index = 0; index < observations.length; index++) {
    const item = observations[index]!;
    const key = `${item.project}\u0000${item.id}`;
    const source = canonical(raw[index]);
    const previous = seen.get(key);
    if (previous !== undefined) {
      if (previous !== source) throw new Error(`Conflicting duplicate ID: ${item.id}`);
      duplicates++;
    } else { seen.set(key, source); unique.push(item); }
  }
  const warnings: string[] = [];
  if (partial) warnings.push('Source export is partial; observed counts may be incomplete.');
  if (duplicates) warnings.push(`${duplicates} duplicate record(s) removed.`);
  if (from || to) warnings.push('Date filtering applies only to reports with observed timestamps.');
  let filtered = 0;
  const selected = unique.filter((item) => {
    const matches = (!options.project || item.project === options.project) &&
      (!options.environment || item.environment === options.environment) &&
      (!options.release || item.release === options.release) &&
      (!options.page || item.page === safeUrl(options.page)) &&
      (!options.type || item.type === options.type) &&
      (!from || !!item.occurredAt && item.occurredAt >= from) &&
      (!to || !!item.occurredAt && item.occurredAt <= to);
    if (!matches) filtered++;
    return matches;
  }).sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  if (filtered) warnings.push(`${filtered} record(s) excluded by filters.`);
  if ((from || to) && unique.some((item) => !item.occurredAt)) warnings.push('Undated manual reports were excluded by date filters.');
  return {
    observations: selected,
    coverage: { kind, frequency: kind === 'browser-error-json' ? 'captured-events' : 'submitted-reports',
      partial, inputCount, duplicates, filtered, retention: 'unknown',
      ...(from || to ? { period: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}) },
    sha256: createHash('sha256').update(content).digest('hex'), warnings,
  };
}
