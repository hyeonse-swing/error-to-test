import { createHash } from 'node:crypto';
import type { Locator, WebStep } from './types.ts';

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 8192) throw new Error(`${label} must be ${required ? 'a non-empty' : 'a'} string of at most 8192 characters.`);
  return value;
}
export function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}
export function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array of at most 100 strings.`);
  return value.map((item, index) => text(item, `${label}[${index}]`));
}
export function timestamp(value: unknown, label: string): string {
  const input = text(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (!match) throw new Error(`${label} must be an ISO timestamp with a timezone.`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[10] ?? 0), offsetMinute = Number(match[11] ?? 0);
  if (month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59 || offsetHour > 23 || offsetMinute > 59) throw new Error(`${label} is not a valid timestamp.`);
  const parsed = Date.parse(input);
  const offset = match[8] === 'Z' ? 0 : (match[9] === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  const local = new Date(parsed + offset * 60000);
  if (!Number.isFinite(parsed) || local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) throw new Error(`${label} is not a valid timestamp.`);
  return new Date(parsed).toISOString();
}

const roles = new Set(['button', 'link', 'textbox', 'heading', 'checkbox', 'radio', 'combobox', 'option', 'status', 'alert', 'dialog', 'tab', 'row', 'cell', 'list', 'listitem', 'navigation', 'searchbox', 'switch']);
function exactKeys(raw: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(raw).some(key => !keys.includes(key))) throw new Error(`${label} contains unsupported fields.`);
}
function locator(value: unknown, label: string): Locator {
  const raw = record(value, label);
  if (raw.by === 'role') {
    exactKeys(raw, ['by', 'value', 'name'], label);
    const role = text(raw.value, `${label}.value`);
    if (!roles.has(role)) throw new Error(`${label}.value is not a supported role.`);
    const name = optionalText(raw.name, `${label}.name`);
    return { by: 'role', value: role, ...(name !== undefined ? { name } : {}) };
  }
  if (raw.by !== 'text' && raw.by !== 'label' && raw.by !== 'testId') throw new Error(`${label}.by is not supported.`);
  exactKeys(raw, ['by', 'value'], label);
  return { by: raw.by, value: text(raw.value, `${label}.value`) };
}
export function parseWebSteps(value: unknown, label: string): WebStep[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array of at most 100 steps.`);
  return value.map((item, index): WebStep => {
    const key = `${label}[${index}]`, raw = record(item, key);
    switch (raw.type) {
      case 'open': {
        exactKeys(raw, ['type', 'path'], key);
        const path = text(raw.path, `${key}.path`);
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\p{Cc}\p{Cf}]/u.test(path)) throw new Error(`${key}.path must be an app-relative path.`);
        return { type: 'open', path };
      }
      case 'act': case 'assertAgent':
        exactKeys(raw, ['type', 'instruction'], key);
        return { type: raw.type, instruction: text(raw.instruction, `${key}.instruction`) };
      case 'click':
        exactKeys(raw, ['type', 'locator'], key);
        return { type: 'click', locator: locator(raw.locator, `${key}.locator`) };
      case 'fill':
        exactKeys(raw, ['type', 'locator', 'value'], key);
        return { type: 'fill', locator: locator(raw.locator, `${key}.locator`), value: text(raw.value, `${key}.value`, false) };
      case 'assertVisible':
        exactKeys(raw, ['type', 'locator', 'visible'], key);
        if (raw.visible !== undefined && typeof raw.visible !== 'boolean') throw new Error(`${key}.visible must be a boolean.`);
        return { type: 'assertVisible', locator: locator(raw.locator, `${key}.locator`), visible: raw.visible !== false };
      case 'assertText':
        exactKeys(raw, ['type', 'locator', 'expected', 'match'], key);
        if (raw.match !== undefined && raw.match !== 'equals' && raw.match !== 'contains') throw new Error(`${key}.match must be equals or contains.`);
        return { type: 'assertText', locator: locator(raw.locator, `${key}.locator`), expected: text(raw.expected, `${key}.expected`), match: raw.match ?? 'equals' };
      case 'assertUrl':
        exactKeys(raw, ['type', 'expected'], key);
        return { type: 'assertUrl', expected: text(raw.expected, `${key}.expected`) };
      default: throw new Error(`${key}.type is not a supported web step.`);
    }
  });
}
