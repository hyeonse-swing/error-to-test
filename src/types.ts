export type EventType = 'javascript' | 'promise' | 'react' | 'console' | 'http' | 'network' | 'manual';
export type Runtime = 'browser' | 'webview-ios' | 'webview-android' | 'unknown';
export type Locator = { by: 'role'; value: string; name?: string } | { by: 'text' | 'label' | 'testId'; value: string };
export type WebStep =
  | { type: 'open'; path: string }
  | { type: 'act'; instruction: string }
  | { type: 'click'; locator: Locator }
  | { type: 'fill'; locator: Locator; value: string }
  | { type: 'assertVisible'; locator: Locator; visible: boolean }
  | { type: 'assertText'; locator: Locator; expected: string; match: 'equals' | 'contains' }
  | { type: 'assertUrl'; expected: string }
  | { type: 'assertAgent'; instruction: string };

export interface ErrorObservation {
  id: string;
  source: 'browser-error' | 'manual';
  project: string;
  environment: string;
  release: string;
  type: EventType;
  message: string;
  runtime: Runtime;
  name?: string;
  stack?: string;
  componentStack?: string;
  page?: string;
  occurredAt?: string;
  viewId?: string;
  network?: { method: string; url: string; status?: number; durationMs?: number };
  reproduction: string[];
  preconditions: string[];
  questions: string[];
  expected?: string;
  expectedSource?: string;
  steps: WebStep[];
}

export interface SourceCoverage {
  kind: 'browser-error-json' | 'manual-json' | 'manual-text';
  frequency: 'captured-events' | 'submitted-reports';
  partial: boolean;
  inputCount: number;
  duplicates: number;
  filtered: number;
  retention: 'unknown';
  period?: { from?: string; to?: string };
}
export interface ParsedInput {
  observations: ErrorObservation[];
  coverage: SourceCoverage;
  sha256: string;
  warnings: string[];
}
export interface IssueGroup {
  id: string;
  fingerprintVersion: 1;
  project: string;
  environment: string;
  release: string;
  runtime: Runtime;
  type: EventType;
  pagePath: string;
  signature: string;
  message: string;
  count: number;
  viewCount: number;
  lastOccurredAt?: string;
  eventIds: string[];
  evidence: ErrorObservation[];
  context?: {
    expected?: string;
    expectedSource?: string;
    reproduction?: string[];
    preconditions?: string[];
    steps?: WebStep[];
    questions: string[];
    conflicts: string[];
  };
}
export interface ScenarioRule {
  id: string;
  title: string;
  match: { type?: EventType; messageIncludes?: string; pagePath?: string; networkPath?: string; environment?: string; release?: string; runtime?: Runtime };
  requirement: string;
  expectedSource: string;
  preconditions: string[];
  setupConfirmed: boolean;
  questions: string[];
  steps: WebStep[];
}
export interface AppProfile {
  schemaVersion: 'error-to-test/profile-1';
  name: string;
  scenarios: ScenarioRule[];
}
export interface TestCandidate {
  id: string;
  groupId: string;
  title: string;
  state: 'needs-context' | 'draft';
  facts: string[];
  hypotheses: string[];
  reproduction: string[];
  preconditions: string[];
  expected?: { text: string; source: string };
  questions: string[];
  steps: WebStep[];
  eventIds: string[];
  ruleId?: string;
}
export interface Analysis {
  schemaVersion: 'error-to-test/analysis-1';
  source: { sha256: string; profileSha256?: string };
  coverage: SourceCoverage;
  groups: IssueGroup[];
  candidates: TestCandidate[];
  warnings: string[];
}
export interface FlowQaSuite {
  schemaVersion: 'flow-qa/suite-1';
  platform: 'web';
  id: string;
  title: string;
  source?: { file: string; sha256: string };
  requirements: { id: string; text: string }[];
  cases: { id: string; title: string; requirementIds: string[]; preconditions: string[]; questions: string[]; steps: WebStep[] }[];
}
export interface FlowQaExport {
  flow: string;
  suite?: FlowQaSuite;
  provenance: {
    schemaVersion: 'error-to-test/provenance-1';
    inputSha256: string;
    analysisSha256: string;
    reportSha256?: string;
    profileSha256?: string;
    flowSha256: string;
    suiteSha256?: string;
    reviewed: boolean;
    mappings: { caseId: string; candidateId: string; groupId: string; eventIds: string[] }[];
  };
}
