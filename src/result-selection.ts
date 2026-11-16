import { createHash } from 'node:crypto';
import { redactText } from './redact.ts';
import { record, text } from './validation.ts';

/** Flow QA reports use caseIds; linked results record an explicit selected-run scope. */
export interface LinkedSelection {
  mode: 'selected';
  totalCases: number;
  selectedCaseIds: string[];
}

/** Keep a reported label without persisting any URL that may carry sensitive path data. */
export function safeReportedTargetName(value: unknown, label: string): string {
  const name = text(value, label);
  return redactText(name.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|(?<!:)\/\/[^\s<>"']+/gi, '[redacted-url]'));
}

const fingerprintPattern = /^[0-9a-f]{64}$/;

export function validatedTargetFingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !fingerprintPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint (64 hex characters).`);
  }
  return value;
}

/** Match Flow QA targetFingerprint's canonical identity and key order exactly. */
export function reportedTargetIdentity(value: unknown, status: string): { targetName: string; targetFingerprint?: string } {
  const target = record(value, 'report.target');
  const kind = target.kind;
  const keys = kind === 'mobile' ? ['name', 'kind', 'platform', 'bundleId', 'device'] : ['name', 'kind', 'url'];
  if ((kind !== undefined && kind !== 'web' && kind !== 'mobile')
    || Object.keys(target).some(key => !keys.includes(key))) {
    throw new Error('report.target has an unsupported shape or kind.');
  }
  let targetName = text(target.name, 'report.target.name');
  let identity: { kind: 'web'; url: string } | { kind: 'mobile'; platform: string; bundleId: string; device: string };
  if (kind === 'mobile') {
    if (target.platform !== 'ios' && target.platform !== 'android') throw new Error('report.target.platform must be ios or android.');
    const bundleId = text(target.bundleId, 'report.target.bundleId');
    if (target.device === '') {
      if (status !== 'blocked' && status !== 'interrupted') throw new Error('report.target.device may be empty only for a blocked or interrupted mobile fallback report.');
      targetName = targetName.replaceAll(bundleId, '[redacted-target]');
      return { targetName: safeReportedTargetName(targetName, 'report.target.name') };
    }
    identity = {
      kind: 'mobile', platform: target.platform,
      bundleId,
      device: text(target.device, 'report.target.device'),
    };
    for (const value of [identity.bundleId, identity.device]) targetName = targetName.replaceAll(value, '[redacted-target]');
  } else {
    if (target.url === '') {
      if (kind !== undefined || (status !== 'error' && status !== 'interrupted')) {
        throw new Error('report.target.url may be empty only for an error or interrupted web fallback report.');
      }
      return { targetName: safeReportedTargetName(targetName, 'report.target.name') };
    }
    const url = text(target.url, 'report.target.url');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported protocol');
    } catch { throw new Error('report.target.url must be an HTTP or HTTPS URL.'); }
    identity = { kind: 'web', url };
    targetName = targetName.replaceAll(url, '[redacted-url]');
  }
  targetName = safeReportedTargetName(targetName, 'report.target.name');
  return { targetName, targetFingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex') };
}

export function validateResultSelection(
  value: unknown,
  present: boolean,
  caseIds: readonly string[],
  expectedIds: ReadonlySet<string>,
  source: 'Flow QA report' | 'Linked result',
): LinkedSelection | undefined {
  if (!present) {
    if (caseIds.length !== expectedIds.size) throw new Error(source === 'Flow QA report'
      ? 'The report does not account for every exported case.'
      : 'Linked result has an incomplete case list.');
    return undefined;
  }
  const linked = source === 'Linked result';
  const idKey = linked ? 'selectedCaseIds' : 'caseIds';
  const keys = linked ? ['mode', 'totalCases', idKey] : ['totalCases', idKey];
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${source} has an invalid selection declaration.`);
  }
  const declaration = value as Record<string, unknown>;
  if (linked && declaration.mode !== 'selected') throw new Error('Linked result has an invalid selection mode.');
  if (!Number.isSafeInteger(declaration.totalCases) || declaration.totalCases !== expectedIds.size
    || caseIds.length === 0 || caseIds.length >= expectedIds.size) {
    throw new Error(`${source} selection totalCases does not match the exported suite or is not a proper subset.`);
  }
  const selectedCaseIds = declaration[idKey];
  if (!Array.isArray(selectedCaseIds) || selectedCaseIds.length !== caseIds.length
    || selectedCaseIds.some(id => typeof id !== 'string' || !expectedIds.has(id))
    || new Set(selectedCaseIds).size !== selectedCaseIds.length
    || !caseIds.every(id => selectedCaseIds.includes(id))) {
    throw new Error(`${source} selected case IDs do not match the reported cases and exported suite.`);
  }
  return { mode: 'selected', totalCases: expectedIds.size, selectedCaseIds: [...selectedCaseIds] };
}
