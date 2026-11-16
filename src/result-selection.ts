import { redactText } from './redact.ts';
import { text } from './validation.ts';

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
