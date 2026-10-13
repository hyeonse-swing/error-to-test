import { parseInput, type ParseInputOptions } from './input.ts';
import { groupObservations } from './grouping.ts';
import { createCandidates, parseProfile } from './candidates.ts';
import { hash } from './validation.ts';
import type { Analysis } from './types.ts';

export interface AnalyzeOptions extends ParseInputOptions {
  profile?: unknown;
  top?: number;
}
export function analyzeErrors(content: string, options: AnalyzeOptions = {}): Analysis {
  const top = options.top ?? 100;
  if (!Number.isInteger(top) || top < 1 || top > 100) throw new Error('top must be an integer between 1 and 100.');
  let rawProfile = options.profile;
  const profileSource = typeof rawProfile === 'string' ? rawProfile : rawProfile === undefined ? undefined : JSON.stringify(rawProfile);
  if (typeof rawProfile === 'string') {
    if (Buffer.byteLength(rawProfile) > 1024 * 1024) throw new Error('The profile must be 1 MiB or smaller.');
    try { rawProfile = JSON.parse(rawProfile); } catch { throw new Error('The profile is not valid JSON.'); }
  }
  const profile = rawProfile === undefined ? undefined : parseProfile(rawProfile);
  const input = parseInput(content, options);
  const groups = groupObservations(input.observations);
  const warnings = [...input.warnings];
  if (groups.length > top) warnings.push(`TC selection includes the first ${top} of ${groups.length} ranked groups. All groups remain in analysis.json.`);
  return {
    schemaVersion: 'error-to-test/analysis-1',
    source: { sha256: input.sha256, ...(profileSource !== undefined ? { profileSha256: hash(profileSource) } : {}) },
    coverage: input.coverage,
    groups,
    candidates: createCandidates(groups.slice(0, top), profile),
    warnings,
  };
}
