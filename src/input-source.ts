import { createHash } from 'node:crypto';
import type { InputFileFingerprint } from './types.ts';

const MAX_FILES = 50;
const MAX_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function descriptor(inputs: readonly InputFileFingerprint[]): string {
  return JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs });
}

/** Internal source fingerprint used by the parser and bundle verifier. */
export function inputSource(content: string | readonly string[]): { sha256: string; inputs?: InputFileFingerprint[] } {
  if (typeof content !== 'string' && !Array.isArray(content)) throw new Error('Input must be a string or an array of strings.');
  const files = typeof content === 'string' ? [content] : content;
  if (files.length < 1 || files.length > MAX_FILES) throw new Error('Input must contain 1 to 50 files.');
  let totalBytes = 0;
  const inputs = files.map((file): InputFileFingerprint => {
    if (typeof file !== 'string') throw new Error('Every input file must be a string.');
    const byteLength = Buffer.byteLength(file, 'utf8');
    totalBytes += byteLength;
    if (totalBytes > MAX_BYTES) throw new Error('Input exceeds 10 MiB.');
    return { sha256: hash(file), byteLength };
  });
  return inputs.length === 1 ? { sha256: inputs[0]!.sha256 } : { sha256: hash(descriptor(inputs)), inputs };
}

/** Validate persisted source metadata without reading or retaining original input. */
export function validateInputSource(value: unknown): void {
  const invalid = (): never => { throw new Error('STALE_BUNDLE: Invalid input source fingerprint.'); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>;
  if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)) invalid();
  if (source.inputs === undefined) return;
  const rawInputs = source.inputs;
  if (!Array.isArray(rawInputs)) throw new Error('STALE_BUNDLE: Invalid input source fingerprint.');
  if (rawInputs.length < 2 || rawInputs.length > MAX_FILES) invalid();
  let totalBytes = 0;
  const inputs = rawInputs.map((value: unknown): InputFileFingerprint => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
    const file = value as Record<string, unknown>;
    if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) ||
      typeof file.byteLength !== 'number' || !Number.isInteger(file.byteLength) ||
      file.byteLength < 0 || file.byteLength > MAX_BYTES) invalid();
    totalBytes += file.byteLength as number;
    if (totalBytes > MAX_BYTES) invalid();
    return { sha256: file.sha256 as string, byteLength: file.byteLength as number };
  });
  if (hash(descriptor(inputs)) !== source.sha256) invalid();
}
