# Error to Test

Turn captured browser errors **or a pasted error report** into grouped issues, reviewable regression test candidates, and Flow QA suites. Runs locally without a model, browser SDK, or external service connection.

[![npm](https://img.shields.io/npm/v/@ihyeon/error-to-test)](https://www.npmjs.com/package/@ihyeon/error-to-test) [![CI](https://github.com/hyeonse-swing/error-to-test/actions/workflows/ci.yml/badge.svg)](https://github.com/hyeonse-swing/error-to-test/actions/workflows/ci.yml)

[한국어](README.ko.md)

## Install

```sh
npm install -g @ihyeon/error-to-test
error-to-test --version
error-to-test analyze --error "TypeError: item is undefined" --page /items --out ./new-result
```

For the JavaScript API, install `npm install @ihyeon/error-to-test`. See [release and verification notes](docs/releases.md) for automatic publishing and the integration proof boundary.

## Run locally

Requires Node.js 24.22.1 or newer within Node 24, or Node.js 26.12.1 or newer, with the [October 2026 security updates](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases). From this directory, if you use nvm:

```sh
nvm install
nvm use
```

Then run:

```sh
npm ci
npm run check
node bin/error-to-test.mjs --help
npm run demo
```

Install or upgrade Node.js separately; `npm install` does not upgrade the runtime. npm normally warns about an unsupported `engines` version unless `engine-strict` is enabled.

Each demo run saves its results in a new `.error-to-test/run-*` directory and prints the report path.

Every output directory must be new. The command never overwrites an existing analysis.

## Submit an error without an SDK

```sh
node bin/error-to-test.mjs analyze --error "TypeError: item is undefined" --page /items --runtime browser --reproduce "Click View item" --expected "Show the empty state" --expected-source "Reporter" --out .error-to-test/pasted
node bin/error-to-test.mjs analyze --input examples/error.txt --page /items --runtime browser --out .error-to-test/text
node bin/error-to-test.mjs analyze --input examples/manual.json --profile examples/profile.json --out .error-to-test/manual
cat examples/error.txt | node bin/error-to-test.mjs analyze --input - --out .error-to-test/stdin
```

One text input is one report: its first line is the message and the remaining lines are its stack. Common `[ERROR]`, `[vite]`, and timestamp prefixes work in automatic mode. Use `--format text` for other text formats. Malformed JSON is rejected rather than silently reinterpreted as an error report.

Manual JSON uses `schemaVersion: "error-to-test/manual-1"` and an `errors` array. Each report requires `message`; optional fields include `id`, `type`, `project`, `environment`, `release`, `runtime`, `page`, `name`, `stack`, `componentStack`, `occurredAt`, `reproduction`, `preconditions`, `expected`, `expectedSource`, `questions`, and explicit web `steps`. Unknown runtime, time, action, or expectation stays unknown. No occurrence date or user session is invented.

Textual expected behavior alone does not establish a runnable assertion. Supply confirmed scenarios in a profile, or explicit manual steps and an expectation source. Missing information remains a question on the TC.

## Analyze collected errors

Accepts Browser Error Log v1 `{schemaVersion: 1, partial?: boolean, events: [...]}` exports or arrays of full v1 events. Files are limited to 10 MiB and 10,000 records. Identity duplicates are removed; conflicting payloads with the same project/event ID are rejected. `--from`/`--to` require timezone-qualified ISO timestamps. Undated manual reports are excluded when a date filter is requested.

Grouping is deterministic and separates project, environment, release, runtime, page path, error message/name, and source location or HTTP method/path/status. Similar messages do not establish the same root cause. Counts mean **captured events** or **submitted reports**, not actual occurrence rates or affected users. Collection retention is unknown; imported `partial` status is preserved. TC selection defaults to the first 100 ranked groups; all groups remain in the analysis. More than 100 generated cases must be narrowed with `--top` or a smaller profile.

## Confirm the intended behavior

See [examples/profile.json](examples/profile.json). Profiles use `schemaVersion: "error-to-test/profile-1"`, a name, and up to 100 scenarios. Each scenario has a unique ID, title, at least one match predicate, a requirement, its `expectedSource`, and explicit steps. Set `setupConfirmed: true` only after confirming how preconditions are established. Preconditions are descriptions; this package does not prepare accounts or data.

Supported web steps match Flow QA: `open`, `click`, `fill`, `act`, `assertVisible`, `assertText`, `assertUrl`, and `assertAgent`. Several matching rules produce several traceable candidates. Conflicts/questions in any original report are checked before representative evidence is sampled and stay blocked even when a profile matches.

## Review and use Flow QA

Generated files (Flow QA source is limited to 128 KB; suite JSON to 512 KiB):

- `analysis.json`: coverage, ranked groups, safe representative evidence, full-source context checks, and TC candidates.
- `report.md`: human-readable analysis, unique error and React component stacks from representative evidence, reported reproduction, preconditions, proposed test steps, and missing context.
- `flows/error-to-test.md`: observed facts, requirements, steps, and questions.
- `cases/error-to-test.json`: Flow QA `suite-1` (omitted when no records match).
- `provenance.json`: source/profile/analysis/report/flow/suite hashes and event → group → case mappings.

Default suites have a review question on every case. Read the artifacts, confirm the profile/steps, then repeat analysis to **another output directory** with `--reviewed`. This acknowledges review; missing context still blocks execution. No analysis command runs the browser.

```sh
node bin/error-to-test.mjs verify .error-to-test/example --input examples/errors.json --profile examples/profile.json
node bin/error-to-test.mjs analyze --input examples/errors.json --profile examples/profile.json --reviewed --out .error-to-test/reviewed
cd .error-to-test/reviewed
flow-qa validate cases/error-to-test.json
flow-qa generate cases/error-to-test.json
flow-qa init
flow-qa ui
```

Flow QA is installed/configured separately. Its UI can read this `flows/` + `cases/` layout. Select the intended test target, review the cases in Flow QA, and execute there or with its CLI. Source changes invalidate existing bundles/suites; regenerate after review. `verify` checks artifact consistency, and checks original input/profile bytes only when supplied. It is not a signature or proof that a testcase fixes the reported cause. A passing functional assertion does not automatically close an error issue.

## JavaScript API

```js
import { analyzeErrors, exportFlowQa, writeBundle } from '@ihyeon/error-to-test';

const analysis = analyzeErrors('TypeError: item is undefined', { page: '/items', runtime: 'browser' });
const { suite, flow, provenance } = exportFlowQa(analysis);
await writeBundle('./new-result', analysis);
```

Analysis is deterministic and has no runtime dependencies. Optional model-assisted drafting, collecting new interaction breadcrumbs, direct collector APIs, and a dedicated web input screen are later extensions. Browser/WebView logs can be analyzed; native or WebView execution is not established by a log and remains blocked until the correct context is supplied.

After a Flow QA run, associate its normalized report with the exact exported suite:

```sh
node bin/error-to-test.mjs link-run .error-to-test/reviewed --report /path/to/qa-report.json
```

The run's suite hash and every case ID must match. Safe case results are stored under `results/<runId>.json`, linked to their source groups/events. Unknown, missing, or duplicate cases are rejected; existing results are never overwritten. A raw e2e report is not accepted. Failed, blocked, and passed results remain distinct; no issue is automatically marked fixed.

## Data handling and checks

Known credential assignments, bearer/recognized token formats, email addresses, and URL userinfo/query/fragment are removed before artifacts. Sensitive execution steps are omitted and block the case rather than silently changing its assertion. This is best-effort redaction, not a guarantee of complete anonymization; remove private application data before submitting it. Use files/stdin for private reports to avoid shell history. Logs are source data, not instructions. No external URL from a log becomes an execution target automatically.

```sh
npm run check
npm run check:package
FLOW_QA_SOURCE=/path/to/flow-qa BROWSER_ERROR_SOURCE=/path/to/browser-error-log npm run smoke:flowqa
```

The optional integration smoke uses the actual Browser Error Log SDK and Flow QA/e2e in a controlled local Chromium demo: collect errors, generate TCs, observe failures before repair and passes after repair, preserve an unresolved case, and check stale-source rejection. It requires their local source/dependencies and an installed Chromium browser. It does not access production, login, or call a model.
