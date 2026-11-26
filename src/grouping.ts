import { isDeepStrictEqual } from 'node:util';
import type { ErrorObservation, IssueGroup } from './types.ts';
import { compareTimestamps, hash } from './validation.ts';
import { pagePath } from './redact.ts';

function sourceFrame(stack: string | undefined, message: string): string {
  if (!stack) return '';
  const lines = stack.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const frame = lines.find((line) => line !== message && (
    /^at\s+\S/.test(line)
    || /^[^@:]*@(?:.+:\d+|\[native code\])$/.test(line)
    || /^(?:[a-z][\w+.-]*:\/\/|\.{0,2}\/|[A-Za-z]:[\\/]|[^\s:]+\.\w+)\S*:\d+$/.test(line)
  ));
  return frame ?? '';
}

function signature(item: ErrorObservation): string {
  const network = item.network;
  const site = network
    ? `${network.method.toUpperCase()} ${pagePath(network.url)} ${network.status ?? ''}`
    : sourceFrame(item.stack, item.message) || sourceFrame(item.componentStack, item.message);
  return [item.name ?? '', item.message, site].join(' | ');
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
