import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { jsonText, readBoundedFile, readVerifiedBundle, writeBundle, writeNewDirectory } from './artifacts.ts';
import { createProfileTemplate } from './profile-template.ts';
import { matchesScenarioRule, parseProfile, stepsContainSensitiveData } from './candidates.ts';
import { refineBundle } from './refinement.ts';
import { summarizeReadiness } from './readiness.ts';
import { redactText } from './redact.ts';
import { hash, record } from './validation.ts';
import type { Analysis, AppProfile } from './types.ts';

type Snapshot = Awaited<ReturnType<typeof readVerifiedBundle>>;
export interface ReviewOptions {
  source: string;
  output: string;
  input?: string | readonly string[];
  profile?: string;
  draft?: string;
}
const sizeLimit = 1024 * 1024;

export async function writePreparedWorkspace(out: string, snapshot: Snapshot) {
  if (summarizeReadiness(snapshot).status !== 'ready' || !snapshot.suiteText) throw new Error('The reviewed bundle is not ready.');
  await writeNewDirectory(out, {
    'flows/error-to-test.md': snapshot.flowText,
    'cases/error-to-test.json': snapshot.suiteText,
    '.gitignore': '.flowqa/\n.env\n.env.*\n',
    'flowqa.config.json': jsonText({ schemaVersion: 'flow-qa/config-1', targets: {} }),
  });
}

// An incomplete rule may be saved as a draft. Final generation always runs refine's full validation.
function readEditedProfile(raw: unknown, initial: AppProfile, draft: boolean): AppProfile {
  const value = record(raw, 'profile');
  if (Buffer.byteLength(jsonText(value)) > sizeLimit || !Array.isArray(value.scenarios) || value.scenarios.length !== initial.scenarios.length) {
    throw new Error('Keep the original rules and their order within the 1 MiB limit.');
  }
  const blanks: string[][] = [];
  const filled = value.scenarios.map((rawRule, index) => {
    const rule = record(rawRule, 'scenario');
    const original = initial.scenarios[index]!;
    if (rule.id !== original.id || JSON.stringify(rule.match) !== JSON.stringify(original.match)) throw new Error('The review cannot change rule identities, order, or scope.');
    const fields = draft ? ['title', 'requirement', 'expectedSource'].filter(key => rule[key] === '') : [];
    blanks.push(fields);
    return { ...rule, ...Object.fromEntries(fields.map(key => [key, 'Incomplete draft'])) };
  });
  const profile = parseProfile({ ...value, scenarios: filled });
  for (const [index, rule] of profile.scenarios.entries()) {
    if (stepsContainSensitiveData(rule.steps) || redactText(rule.id) !== rule.id) throw new Error('Remove sensitive values from the review.');
    for (const field of blanks[index]!) rule[field as 'title' | 'requirement' | 'expectedSource'] = '';
  }
  return profile;
}

export async function openReview(options: ReviewOptions) {
  const original = await readVerifiedBundle(options.source, { input: options.input });
  const readiness = summarizeReadiness(original);
  const analysis = original.analysis as unknown as Analysis;
  const fingerprint = hash(jsonText([original.provenance.analysisSha256, original.provenance.suiteSha256 ?? null, original.provenance.reportSha256, original.provenance.flowSha256, original.verification.reviewed]));
  if (options.profile && original.provenance.profileSha256 && hash(options.profile) !== original.provenance.profileSha256) throw new Error('Supply the original matching --profile to preserve its rules.');
  const editBlocker = !analysis.candidates.length ? 'No candidates selected. Reanalyze the input to select candidates.'
    : original.provenance.profileSha256 && !options.profile ? 'Reopen with the original --profile to preserve existing rules.'
    : analysis.groups.some(group => !group.context && analysis.candidates.some(candidate => candidate.groupId === group.id)) ? 'Reanalyze the original input to restore missing group context.' : '';
  const template = editBlocker ? null : createProfileTemplate(analysis, { profile: options.profile });
  let initial = template;
  if (options.draft) {
    const draft = record(JSON.parse(options.draft), 'draft');
    if (!template || draft.schemaVersion !== 'error-to-test/review-draft-1' || draft.fingerprint !== fingerprint) throw new Error('Draft does not match this verified bundle.');
    initial = readEditedProfile(draft.profile, template, true);
  }
  // Reserve a new private directory once. The browser can only choose fixed operations inside it.
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output, { mode: 0o700 });
  const root = await realpath(options.output);
  let pending: { folder: string; file: string; analysis: Analysis; fingerprint: string } | undefined;
  let approved: { folder: string; file: string; fingerprint: string } | undefined;
  function state() {
    return { readiness, sourceChecked: original.verification.sourceChecked, groups: analysis.groups, candidates: analysis.candidates,
      coverage: analysis.coverage, profile: initial, editBlocker,
      rules: (template?.scenarios ?? []).map(rule => ({ id: rule.id, groupIds: analysis.groups.filter(group => matchesScenarioRule(rule, group)).map(group => group.id) })) };
  }
  async function execute(action: string, payload: unknown) {
    if (!template) throw new Error(editBlocker);
    const body = record(payload, 'review action');
    const checked = await readVerifiedBundle(options.source, { input: options.input });
    if (jsonText(checked.provenance) !== jsonText(original.provenance)) throw new Error('The source bundle changed. Reopen the review.');
    if (action === 'draft' || action === 'generate' || action === 'preview') {
      const profile = readEditedProfile(body.profile, template, action === 'draft');
      const text = jsonText(profile);
      if (action === 'draft') {
        const name = 'draft-' + randomUUID() + '.json';
        await writeFile(join(root, name), jsonText({ schemaVersion: 'error-to-test/review-draft-1', fingerprint, profile }), { flag: 'wx', mode: 0o600 });
        return { file: name };
      }
      const refined = await refineBundle(options.source, text);
      if (!refined.refinement || refined.refinement.sourceAnalysisSha256 !== original.provenance.analysisSha256 || refined.refinement.sourceSuiteSha256 !== original.provenance.suiteSha256) throw new Error('The source changed during refinement.');
      const changes = profile.scenarios.flatMap((rule, i) => JSON.stringify(rule) === JSON.stringify(template.scenarios[i]) ? [] : [rule.id]);
      const profileHash = hash(text);
      if (action === 'preview') return { profileHash, changes, candidates: refined.candidates };
      if (body.profileHash !== profileHash) throw new Error('Preview these edits before generating a bundle.');
      const id = randomUUID();
      const file = 'profile-' + id + '.json';
      await writeFile(join(root, file), text, { flag: 'wx', mode: 0o600 });
      const folder = 'pending-' + id;
      await writeBundle(join(root, folder), refined);
      const snapshot = await readVerifiedBundle(join(root, folder), { input: options.input, profile: text });
      pending = { folder, file, analysis: refined, fingerprint: hash(jsonText(snapshot.provenance)) };
      approved = undefined;
      return { folder, file, readiness: summarizeReadiness(snapshot), report: snapshot.report, suite: snapshot.suite, sourceChecked: snapshot.verification.sourceChecked };
    }
    if (action === 'acknowledge') {
      if (body.confirmed !== true) throw new Error('Explicit review confirmation is required.');
      if (!pending || body.folder !== pending.folder) throw new Error('Open the generated report and suite before confirming review.');
      const profile = await readBoundedFile(join(root, pending.file), sizeLimit);
      const current = await readVerifiedBundle(join(root, pending.folder), { input: options.input, profile });
      if (hash(jsonText(current.provenance)) !== pending.fingerprint) throw new Error('The generated bundle changed. Regenerate and review again.');
      const folder = 'reviewed-' + randomUUID();
      await writeBundle(join(root, folder), pending.analysis, { reviewed: true });
      const snapshot = await readVerifiedBundle(join(root, folder), { input: options.input, profile });
      approved = { folder, file: pending.file, fingerprint: hash(jsonText(snapshot.provenance)) };
      pending = undefined;
      return { folder, readiness: summarizeReadiness(snapshot), sourceChecked: snapshot.verification.sourceChecked };
    }
    if (action === 'prepare') {
      if (!approved || body.folder !== approved.folder) throw new Error('Choose the reviewed bundle first.');
      const profile = await readBoundedFile(join(root, approved.file), sizeLimit);
      const snapshot = await readVerifiedBundle(join(root, approved.folder), { input: options.input, profile });
      if (hash(jsonText(snapshot.provenance)) !== approved.fingerprint) throw new Error('The reviewed bundle changed.');
      const folder = 'workspace-' + randomUUID();
      await writePreparedWorkspace(join(root, folder), snapshot);
      return { folder, readiness: summarizeReadiness(snapshot), sourceChecked: snapshot.verification.sourceChecked };
    }
    throw new Error('Unknown review action.');
  }
  return { state, execute };
}
