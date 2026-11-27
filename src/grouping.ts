import { isDeepStrictEqual } from 'node:util';
import type { ErrorObservation, IssueGroup } from './types.ts';
import { compareTimestamps, hash } from './validation.ts';
import { pagePath } from './redact.ts';

const NATIVE_FRAME = /^(?:at .+ \((?:native|<anonymous>)\)|.*@\[native code\])$/;

function preferredFrame(frames: string[], sourceLocation?: string): string {
  const first = frames[0] ?? '';
  if (!NATIVE_FRAME.test(first)) return first;
  // Built-in functions can lead the stack in V8 and WebKit. Their shared
  // frame would hide distinct application call sites from CI comparisons.
  return frames.slice(1).find(frame => !NATIVE_FRAME.test(frame) &&
    !frame.includes('<anonymous>') && /:\d+(?::\d+)?\)?$/.test(frame)) ?? sourceLocation ?? first;
}

function sourceFrame(stack: string | undefined, message: string, sdkMessageAtLimit = false, sourceLocation?: string): string {
  if (!stack) return '';
  let lines = stack.split(/\r?\n/);
  const messageLines = message.split(/\r?\n/);
  // V8 places the complete error message before the frames. A subsequent
  // message line can itself start with "at" and must not be treated as a frame.
  const firstLine = lines[0] ?? '';
  const firstMessageLine = messageLines[0]!;
  const headingIsComplete = firstLine === firstMessageLine || firstLine.endsWith(`: ${firstMessageLine}`);
  if (message && (headingIsComplete || firstLine.includes(`: ${firstMessageLine}`))) {
    if (!sdkMessageAtLimit && headingIsComplete &&
      messageLines.slice(1).every((line, index) => lines[index + 1] === line)) {
      lines = lines.slice(messageLines.length);
    } else {
      // SDK message and stack limits differ. A clipped header can continue
      // with indented prose; only use a V8 frame with a recognizable location.
      return preferredFrame(lines.slice(1).filter(line =>
        /^\s+at\s+.+(?::\d+:\d+\)?|\((?:native|<anonymous>)\))\s*$/.test(line)).map(line => line.trim()), sourceLocation);
    }
  }
  lines = lines.map((line) => line.trim()).filter(Boolean);
  const frames = lines.filter((line) => line !== message && (
    /^at\s+\S/.test(line)
    || /^[^@:]*@(?:.+:\d+|\[native code\])$/.test(line)
    || /^(?:[a-z][\w+.-]*:\/\/|\.{0,2}\/|[A-Za-z]:[\\/]|[^\s:]+\.\w+)\S*:\d+$/.test(line)
  ));
  return preferredFrame(frames, sourceLocation);
}

function signature(item: ErrorObservation): string {
  const network = item.network;
  const sdkMessageAtLimit = item.source === 'browser-error' && item.message.length === 1024;
  const site = network
    ? `${network.method.toUpperCase()} ${pagePath(network.url)} ${network.status ?? ''}`
    : item.type === 'resource' && item.resourcePath
      ? item.resourcePath
      : sourceFrame(item.stack, item.message, sdkMessageAtLimit,
        item.source === 'browser-error' && item.type === 'javascript' ? item.sourceLocation : undefined) ||
        sourceFrame(item.componentStack, item.message) ||
        (item.source === 'browser-error' && item.type === 'javascript' ? item.sourceLocation ?? '' : '');
  const parts = [item.name ?? '', item.message, site];
  const legacy = parts.join(' | ');
  if (isDeepStrictEqual(legacy.split(' | '), parts)) return legacy;
  // Three fixed separators distinguish this from the two-separator legacy
  // format. Length-prefixed fields preserve arbitrary pipes and whitespace.
  return `fields | v1 | 3 | ${parts.map((part) => `${part.length}:${part}`).join('')}`;
}

function sharedContext(observations: ErrorObservation[]): NonNullable<IssueGroup['context']> {
  const conflicts: string[] = [];
  const common = <K extends 'expected' | 'expectedSource' | 'reproduction' | 'preconditions' | 'steps'>(
    field: K,
  ): ErrorObservation[K] | undefined => {
    const first = observations[0]![field];
    if (observations.every((item) => isDeepStrictEqual(item[field], first))) return first;
    conflicts.push(`Conflicting ${field} across reports.`);
    return undefined;
  };
  const expected = common('expected');
  const expectedSource = common('expectedSource');
  const reproduction = common('reproduction');
  const preconditions = common('preconditions');
  const steps = common('steps');
  const questions = [...new Set(observations.flatMap((item) => item.questions))].sort();
  return {
    ...(expected === undefined ? {} : { expected }),
    ...(expectedSource === undefined ? {} : { expectedSource }),
    ...(reproduction === undefined ? {} : { reproduction }),
    ...(preconditions === undefined ? {} : { preconditions }),
    ...(steps === undefined ? {} : { steps }),
    questions, conflicts,
  };
}

export function groupObservations(observations: ErrorObservation[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const item of observations) {
    const path = pagePath(item.page);
    const sig = signature(item);
    const key = JSON.stringify([item.project, item.environment, item.release, item.runtime, item.type, path, sig]);
    const id = `group-${hash(key).slice(0, 16)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        id, fingerprintVersion: 1, project: item.project, environment: item.environment,
        release: item.release, runtime: item.runtime, type: item.type, pagePath: path,
        signature: sig, message: item.message, count: 0, viewCount: 0, eventIds: [], evidence: [],
      };
      groups.set(key, group);
    }
    group.count++;
    group.eventIds.push(item.id);
    group.evidence.push(item);
    if (item.occurredAt && (!group.lastOccurredAt || compareTimestamps(item.occurredAt, group.lastOccurredAt) > 0)) group.lastOccurredAt = item.occurredAt;
  }
  for (const group of groups.values()) {
    group.eventIds.sort();
    group.viewCount = new Set(group.evidence.map((item) => item.viewId).filter((id): id is string => !!id)).size;
    group.context = sharedContext(group.evidence);
    group.evidence.sort((a, b) => compareTimestamps(b.occurredAt, a.occurredAt) || a.id.localeCompare(b.id));
    group.evidence = group.evidence.slice(0, 5);
  }
  return [...groups.values()].sort((a, b) => b.viewCount - a.viewCount || b.count - a.count ||
    compareTimestamps(b.lastOccurredAt, a.lastOccurredAt) || a.id.localeCompare(b.id));
}
