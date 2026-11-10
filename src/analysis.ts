import { parseInput, type ParseInputOptions } from './input.ts';
import { groupObservations } from './grouping.ts';
import { createCandidates, parseProfile } from './candidates.ts';
import { readVerifiedBundle } from './artifacts.ts';
import { compareAnalyses } from './comparison.ts';
import { hash } from './validation.ts';
import type { Analysis } from './types.ts';

export interface AnalyzeOptions extends ParseInputOptions {
  profile?: unknown;
  top?: number;
  minCount?: number;
  groupIds?: readonly string[];
}

interface VerifiedBaseline { analysis: unknown; analysisSha256: string }
function analyze(content: string | readonly string[], options: AnalyzeOptions, baseline?: VerifiedBaseline): Analysis {
  const top = options.top ?? 100;
  if (!Number.isInteger(top) || top < 1 || top > 100) throw new Error('top must be an integer between 1 and 100.');
  const minCount = options.minCount ?? 1;
  if (!Number.isInteger(minCount) || minCount < 1 || minCount > 10000) throw new Error('minCount must be an integer between 1 and 10000.');
  const requestedGroupIds = options.groupIds;
  if (requestedGroupIds !== undefined && (!Array.isArray(requestedGroupIds) || requestedGroupIds.length < 1 || requestedGroupIds.length > 100 ||
    !requestedGroupIds.every(id => typeof id === 'string' && /^group-[0-9a-f]{16}$/.test(id)))) {
    throw new Error('groupIds must contain 1 to 100 valid group IDs.');
  }
  const groupIds = requestedGroupIds === undefined ? undefined : [...new Set(requestedGroupIds)].sort();
  let rawProfile = options.profile;
  const profileSource = typeof rawProfile === 'string' ? rawProfile : rawProfile === undefined ? undefined : JSON.stringify(rawProfile);
  if (typeof rawProfile === 'string') {
    if (Buffer.byteLength(rawProfile) > 1024 * 1024) throw new Error('The profile must be 1 MiB or smaller.');
    try { rawProfile = JSON.parse(rawProfile.replace(/^\uFEFF/, '')); } catch { throw new Error('The profile is not valid JSON.'); }
  }
  const profile = rawProfile === undefined ? undefined : parseProfile(rawProfile);
  const input = parseInput(content, options);
  const groups = groupObservations(input.observations);
  if (groupIds && groupIds.some(id => !groups.some(group => group.id === id))) {
    throw new Error('A requested group ID was not found in the filtered input.');
  }
  const source = { sha256: input.sha256, ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(profileSource !== undefined ? { profileSha256: hash(profileSource) } : {}) };
  const warnings = [...input.warnings];
  let selectedGroups = groups;
  let selection: Analysis['selection'];
  if (baseline) {
    const comparison = compareAnalyses(baseline.analysis, {
      schemaVersion: 'error-to-test/analysis-1', source, coverage: input.coverage, groups, warnings: [],
    });
    const onlyCurrentIds = new Set(comparison.issues.filter(issue => issue.status === 'only-current')
      .flatMap(issue => issue.current?.groupIds ?? []));
    selectedGroups = groups.filter(group => onlyCurrentIds.has(group.id));
    selection = {
      mode: 'only-current',
      baseline: { inputSha256: comparison.baseline.inputSha256, analysisSha256: baseline.analysisSha256,
        coverage: comparison.baseline.coverage },
      onlyCurrentGroupCount: selectedGroups.length,
      excludedGroupCount: groups.length - selectedGroups.length,
    };
    warnings.push(`Baseline TC selection: ${selection.onlyCurrentGroupCount} of ${groups.length} current groups have signatures absent from the supplied baseline; ${selection.excludedGroupCount} already observed. Selection precedes minCount and top. Absence from this baseline does not establish introduction, regression, or resolution.`);
    // A prior baseline-aware bundle may already carry comparison notes. Keep the
    // comparison's bounded coverage cautions without recursively echoing history.
    warnings.push(...comparison.warnings.filter(warning => !warning.startsWith('Baseline:') && !warning.startsWith('Current:')));
    if (comparison.baseline.coverage.duplicates || comparison.baseline.coverage.filtered) {
      warnings.push(`Baseline source coverage: ${comparison.baseline.coverage.duplicates} duplicate and ${comparison.baseline.coverage.filtered} filtered supplied records.`);
    }
    if (comparison.baseline.coverage.period) {
      warnings.push('Baseline date filtering applies only to reports with observed timestamps; undated reports may have been excluded.');
    }
    if (comparison.baseline.coverage.kind === 'browser-error-jsonl' || comparison.baseline.coverage.kind === 'manual-jsonl') {
      warnings.push('Baseline JSONL has no export coverage metadata; partial false means unmarked, and collection completeness and retention are unknown.');
    }
  }
  if (groupIds) {
    const requested = new Set(groupIds);
    selectedGroups = selectedGroups.filter(group => requested.has(group.id));
    warnings.push(`Explicit group TC selection: ${groupIds.length} requested groups; ${selectedGroups.length} intersect the current selection before minCount and top. All groups remain in analysis.json.`);
  }
  const eligibleGroups = selectedGroups.filter(group => group.count >= minCount);
  if (eligibleGroups.length < selectedGroups.length) warnings.push(`TC selection requires at least ${minCount} supplied records per group; ${eligibleGroups.length} of ${selectedGroups.length} groups are eligible. All groups remain in analysis.json. These counts are supplied records, not global rates.`);
  if (eligibleGroups.length > top) warnings.push(minCount === 1
    ? `TC selection includes the first ${top} of ${selectedGroups.length} ranked groups. All groups remain in analysis.json.`
    : `TC selection includes the first ${top} of ${eligibleGroups.length} eligible ranked groups. All groups remain in analysis.json.`);
  return {
    schemaVersion: 'error-to-test/analysis-1',
    source,
    coverage: input.coverage,
    groups,
    candidates: createCandidates(eligibleGroups.slice(0, top), profile),
    warnings,
    ...(selection ? { selection } : {}),
    ...(groupIds ? { groupFilter: { groupIds } } : {}),
  };
}

export function analyzeErrors(content: string | readonly string[], options: AnalyzeOptions = {}): Analysis {
  return analyze(content, options);
}

export async function analyzeWithBaseline(content: string | readonly string[], baselineDirectory: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  const baseline = await readVerifiedBundle(baselineDirectory);
  if (typeof baseline.provenance.analysisSha256 !== 'string') throw new Error('STALE_BUNDLE: The baseline analysis hash is missing.');
  return analyze(content, options, { analysis: baseline.analysis, analysisSha256: baseline.provenance.analysisSha256 });
}
