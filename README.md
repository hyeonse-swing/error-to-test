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

Use `--min-count N` (1..10,000; default 1) to generate TCs only for groups with at least N supplied records after deduplication and date filtering. `--top` then limits the remaining ranked groups. Groups below the threshold remain in `analysis.json` and `report.md`; the report explains any exclusions. If no groups qualify, no suite is generated.

```sh
error-to-test analyze --input errors.json --min-count 3 --top 10 --out ./recurring-errors
```

### Analyze several log files together

Repeat `--input` to combine exports before deduplication, filters, ranking, and TC selection:

```sh
error-to-test analyze --input morning.json --input afternoon.json --min-count 3 --top 10 --out ./combined
error-to-test verify ./combined --input morning.json --input afternoon.json
```

Supply up to 50 files with a combined limit of 10 MiB and 10,000 raw records, including duplicates. Files must have the same input kind: SDK JSON exports/arrays together, manual JSON files together, text reports together, or JSONL files of the same record kind together. Each text file is one report. `--format` and metadata/filter options apply to every file. Standard input (`--input -`) must be the only input to `analyze`; `verify` requires original files.

Files and standard input must be valid UTF-8. Malformed encoding is rejected before hashing, so distinct invalid bytes cannot silently become the same replacement character.

Duplicate project/record IDs are resolved across all files before filtering. Identical records count once; conflicting raw records are rejected even if redaction would make them look alike or filters would exclude them. The partial-export flag is true if any source is partial. Counts describe supplied records, not a global occurrence rate.

For multiple files, `analysis.source.inputs` records each original SHA-256 and UTF-8 byte length in the supplied order. Filenames and raw contents are not stored. `source.sha256` is the SHA-256 of `JSON.stringify({ schemaVersion: 'error-to-test/inputs-1', inputs })`, with each descriptor ordered as `{ sha256, byteLength }`. The analysis hash protects the manifest, and the report lists it. Verification requires every original file in the same order, including its BOM and whitespace. A single input retains its original byte hash and existing output contract.

The API accepts ordered content arrays: `analyzeErrors([firstContent, secondContent], options)`, `parseInput([firstContent, secondContent], options)`, and `await analyzeWithBaseline([firstContent, secondContent], baselineDirectory, options)`. Verify with `await verifyBundle(directory, { input: [firstContent, secondContent] })`. A one-element array is equivalent to its single string. Profile refinement and baseline selection work with the same ordered inputs and existing review gates.

### Read JSONL logs

Use explicit `--format jsonl` for one error object per line:

```sh
error-to-test analyze --input errors.jsonl --format jsonl --out ./jsonl-analysis
error-to-test analyze --input morning.jsonl --input afternoon.jsonl --format jsonl --min-count 3 --out ./combined-jsonl
cat errors.jsonl | error-to-test analyze --input - --format jsonl --out ./piped-jsonl
error-to-test verify ./jsonl-analysis --input errors.jsonl
```

Each record is either a full Browser Error Log v1 event with `schemaVersion: 1`, or a plain manual error object with a required `message` and no `schemaVersion`. For manual reports:

```jsonl
{"id":"first","message":"TypeError: item is undefined","page":"/items","runtime":"browser"}
{"id":"second","message":"TypeError: item is undefined","page":"/items","runtime":"browser"}
```

See [examples/manual.jsonl](examples/manual.jsonl) for a complete sample: `node bin/error-to-test.mjs analyze --input examples/manual.jsonl --format jsonl --min-count 2` selects one recurring group and retains both groups for review. No expectation or runnable assertion is invented.

LF and CRLF, blank lines, escaped newlines in strings, and one leading file BOM are supported. Each nonblank physical line must contain one complete JSON object. Arrays, export envelopes (`events`/`errors`), record-level `partial` metadata, unknown schema versions, and mixed browser/manual records are rejected. Syntax and record errors identify the 1-based input file and physical line without echoing the record. `auto`, `json`, and `text` retain their existing behavior; JSONL is never auto-detected.

Coverage records `browser-error-jsonl` / `captured-events` or `manual-jsonl` / `submitted-reports`. JSONL carries no export coverage metadata: `partial: false` means no partial flag was supplied, and a warning keeps collection completeness and retention unknown. JSONL does not establish complete collection. The same combined byte/file/record limits, raw-record deduplication, filters, original-byte hashes, review gates, and profile rules apply. Empty lines are not records; malformed lines are never silently skipped.

Use `analyzeErrors(content, { format: 'jsonl' })` or ordered content arrays in the API. Comparison and `--baseline` can read JSON and JSONL bundles of matching count frequency, preserving the kind-difference warning. Captured events and submitted reports still cannot be compared. Existing 0.1.x bundles remain readable; JSONL bundles require 0.2.0 or newer.

### Compare two analyses

Compare verified snapshots, including snapshots from different releases:

```sh
error-to-test analyze --input before-errors.json --release r1 --out ./before
error-to-test analyze --input current-errors.json --release r2 --out ./current
error-to-test compare ./before ./current
error-to-test compare ./before ./current --format json --out ./comparison.json
```

Each signature is classified as `only-current`, `both`, or `only-baseline`, with supplied record counts on both sides and their difference. Matching keeps project, environment, runtime, error type, page path, and the complete fingerprint-v1 signature; only release is excluded. Changes to messages or source locations remain separate signatures. This comparison does not infer a common root cause from similar text.

All source groups participate, including groups excluded from TC generation by `--top` or `--min-count`. Multiple release groups with the same comparison key are aggregated on each side, with their original group IDs and release labels preserved. Use `analyze --release` first when you want one release per side. View counts are not summed or compared.

`only-baseline` means absent from the supplied current snapshot, not fixed. Counts are supplied records, not error rates or affected users. Each side's coverage, filters, partial-export flag, unknown retention, and analysis warnings remain visible. Different collection windows or scopes can explain differences; comparisons between captured-event counts and submitted-report counts are rejected. Manual JSON and text both count submitted reports and can be compared, with a format-difference warning.

Both bundles must pass consistency verification. The command reads their verified snapshots without editing artifacts, TC states, review gates, or linked results. Markdown is the default; `--format json` returns `error-to-test/comparison-1`. `--out` requires a new file outside either bundle's `results` directory. The API equivalents are `await compareBundles(baselineDirectory, currentDirectory)` and `renderComparison(comparison)`.

### Limit newly observed signatures in CI

Set `--max-new N` to fail a CI step when the supplied current analysis has more than N `only-current` signatures:

```sh
error-to-test compare ./before ./current --max-new 0
error-to-test compare ./before ./current --max-new 2 --format json --out ./comparison.json
```

The limit accepts decimal integers from 0 to 10,000. It counts distinct comparison signatures across all retained groups, including groups excluded from TC generation. Release groups sharing the same comparison key count once. Record counts and count increases do not affect this limit.

| Exit code | Result |
| --- | --- |
| `0` | Comparison succeeded and the limit was met, or no limit was requested |
| `1` | Invalid options, incompatible/stale inputs, or an output error |
| `2` | Comparison succeeded and the `only-current` count exceeded the limit |

On limit failure the full report is still printed or saved, so CI can retain it for review. A numeric pass/fail summary goes to stderr; JSON stdout remains the unchanged `error-to-test/comparison-1` object. Output errors take precedence and preserve existing files. Without `--max-new`, existing comparison behavior is unchanged. The option is available only on `compare`.

Choose snapshots with the intended project, environment, period, and collection scope. Partial-export and coverage warnings remain in the report. This limit describes signatures absent from the supplied baseline; it does not establish when an error was introduced, execute TCs, or change their review state. API callers can apply their own threshold to `comparison.counts['only-current']`.

### Generate TCs for signatures absent from a baseline

Pass a verified analysis bundle to `analyze --baseline` to focus TC generation on current signatures that were not observed in that baseline:

```sh
error-to-test analyze --input before-errors.json --out ./before
error-to-test analyze --input current-errors.json --baseline ./before --min-count 3 --top 10 --out ./new-signature-tcs
error-to-test init-profile ./new-signature-tcs --out ./new-signature-profile.json
# Fill the profile with confirmed requirements, setup, actions, and assertions.
error-to-test analyze --input current-errors.json --baseline ./before --min-count 3 --top 10 --profile ./new-signature-profile.json --out ./reviewed-new-signatures
```

The filter uses the same exact identity as `compare`, excluding release only. Every baseline group participates, even one excluded from its TC selection. Current groups absent from the baseline are selected first, then `--min-count` and `--top` apply in the existing ranked order. Counts remain per current group; different releases are not pooled to meet `--min-count`. All current groups and source coverage remain in the analysis and report. No matching candidates means a valid bundle without a suite.

The analysis records `selection.mode: "only-current"`, the baseline input and verified analysis SHA-256 hashes, baseline coverage, and group selection counts. These are covered by the new bundle's analysis hash. The baseline is read once without modification; later baseline edits do not alter this saved selection. Reuse the same baseline and filters when refining the profile. Existing context questions and the review gate still apply; `--reviewed` only acknowledges review.

“Absent from baseline” does not establish that an error was newly introduced or is a confirmed regression. Partial exports, different periods, and reporting practices can explain absence; comparison coverage warnings are retained. Captured-event and submitted-report sources cannot be mixed. Output must be a new directory outside the baseline's `results` directory.

The async API is `await analyzeWithBaseline(content, baselineDirectory, { minCount: 3, top: 10, profile })`. It verifies the baseline bundle itself and accepts the same analysis options as `analyzeErrors`.

### Generate TCs for specific error groups

Use `--group` to focus on exact group IDs from an initial `report.md` or `analysis.json`:

```sh
error-to-test analyze --input errors.json --out ./all-errors
# Replace these example IDs with actual IDs from ./all-errors/report.md.
error-to-test analyze --input errors.json --group group-0123456789abcdef --group group-fedcba9876543210 --out ./selected-tcs
error-to-test init-profile ./selected-tcs --out ./selected-profile.json
```

Repeat `--group` up to 100 times. Each ID must have the exact `group-` plus 16 lowercase hexadecimal digits format and exist in the current input after source/date filters. Duplicate IDs are counted once. Unknown IDs fail before a bundle is written, so an ID from a different release, changed input, or excluded period cannot silently generate an empty suite. Reuse the same input files, order, manual metadata, and date filters used to obtain the IDs.

Requested groups are intersected with any `--baseline` selection, then `--min-count` and `--top` apply in the original ranked order. Argument order does not change priority. A known group can still be excluded by these conditions; zero selected cases creates a valid bundle without a suite, and `readiness` reports `empty` with exit `2`. A selected group may produce several profile-based TCs as before.

The complete observed groups, input hashes, and source coverage remain in the new bundle. `analysis.groupFilter.groupIds` stores the sorted, deduplicated requested IDs, covered by the analysis hash, and the report records the scope. Comparison and baseline counts continue to use all observed groups. Missing-context and review questions still block execution. Omitting `--group` keeps the existing selection behavior; other commands reject this analyze-only option.

The API accepts `analyzeErrors(content, { groupIds: [groupId], top: 10 })` and the same option in `analyzeWithBaseline()`. `groupIds` must be a nonempty array of at most 100 entries; it is not mutated.

## Confirm the intended behavior

See [examples/profile.json](examples/profile.json). Profiles use `schemaVersion: "error-to-test/profile-1"`, a name, and up to 100 scenarios. Each scenario has a unique ID, title, at least one match predicate, a requirement, its `expectedSource`, and explicit steps. Set `setupConfirmed: true` only after confirming how preconditions are established. Preconditions are descriptions; this package does not prepare accounts or data.

Supported web steps match Flow QA: `open`, `click`, `fill`, `act`, `assertVisible`, `assertText`, `assertUrl`, and `assertAgent`. Several matching rules produce several traceable candidates. Conflicts/questions in any original report are checked before representative evidence is sampled and stay blocked even when a profile matches.

### Start a profile from an analysis

Generate an editable profile from a verified analysis bundle instead of writing its structure and match rules by hand:

```sh
error-to-test analyze --input errors.json --min-count 3 --out ./initial-analysis
error-to-test init-profile ./initial-analysis --out ./review-profile.json
# Edit review-profile.json using report.md and your confirmed app requirements.
error-to-test analyze --input errors.json --min-count 3 --profile ./review-profile.json --out ./review-analysis
```

The template contains one scenario per selected error group, even when several candidates refer to that group. Each scenario uses an exact `match.groupId`, so a different source location, release, or other grouping boundary cannot receive the scenario just because its message and page look similar. Reuse the original input and the same analysis filters/manual metadata. New or changed groups require their own review.

For each scenario, fill `requirement` and `expectedSource`, establish `preconditions`, and supply explicit reproduction actions and an observable assertion in `steps`. Only a safe observed page path is prefilled as an `open` step. No actions or expected outcomes are inferred. Set `setupConfirmed: true` after checking setup, and remove the template question after answering it. The initial empty requirement/source deliberately fail profile validation; setup, runtime, source conflicts, missing steps, and remaining questions still block incomplete cases. A complete draft still needs the usual `--reviewed` acknowledgement before execution.

`init-profile` requires a new output file, refuses stale bundles and empty candidate selections, and never overwrites an existing file. The original analysis artifacts remain unchanged. The API equivalent is `createProfileTemplate(analysis)`; its result is an incomplete `error-to-test/profile-1` object for editing, not an execution-ready profile.

### Extend an existing profile

Keep existing scenario rules and add review templates for selected groups that they do not cover:

```sh
error-to-test analyze --input current-errors.jsonl --format jsonl --out ./current-analysis
error-to-test init-profile ./current-analysis --profile ./existing-profile.json --out ./expanded-profile.json
# Fill only the new blank requirements, sources, setup, actions, and assertions.
error-to-test analyze --input current-errors.jsonl --format jsonl --profile ./expanded-profile.json --out ./expanded-analysis
```

The existing profile must pass normal profile validation: its requirements and expectation sources must already be filled. Profile name, scenario order, IDs, match conditions, steps, expectations, setup flags, and questions are retained as validated profile values. Unknown fields and file formatting are not preserved. Existing questions and unconfirmed setup still block cases.

Coverage uses exactly the same matching rules as TC generation, with all supplied predicates combined. An existing broad rule can cover several selected groups within its original conditions. An exact `match.groupId` from another release remains exact; its steps and expectation are not copied to a new group. Only uncovered selected groups receive new blank templates in ranked order. New scenario IDs gain deterministic numeric suffixes on collision; existing IDs stay unchanged. If all selected groups are covered, the result contains only the existing rules.

New templates retain blank expectation fields, `setupConfirmed: false`, and the review question. Fill them explicitly before reanalysis, using the original inputs, metadata, filters, and optional baseline. The usual review gate applies. Existing scenarios are never automatically deleted; the combined profile must stay within 100 scenarios and 1 MiB. Sensitive existing metadata or execution steps are rejected before writing. Output must be a new file outside the bundle's `results` directory, for both basic and extended templates.

The API is `createProfileTemplate(analysis, { profile: existingProfile })`; `profile` accepts an object containing only JSON values or a JSON string, including one leading BOM, within 1 MiB. Omit undefined optional properties from object inputs. The function does not mutate either input. Without `profile`, it produces the original blank template.

### Apply a new profile without the original logs

`refine` regenerates TC candidates from a verified saved bundle and a replacement profile. It is useful after editing a generated profile when the original log files are no longer available:

```sh
error-to-test init-profile ./initial-analysis --out ./review-profile.json
# Fill confirmed requirements, setup, actions, and assertions in review-profile.json.
error-to-test refine ./initial-analysis --profile ./review-profile.json --out ./refined
error-to-test readiness ./refined
# After reviewing the replacement profile and cases, write another new bundle:
error-to-test refine ./initial-analysis --profile ./review-profile.json --reviewed --out ./refined-reviewed
```

Only groups represented by the source bundle's selected candidates are regenerated, in their saved order. Broad profile rules cannot add previously excluded groups; several matching rules can create several cases for a selected group. All observed groups, source fingerprints, coverage, and baseline/group selection metadata are preserved. To change the selected groups, original metadata, filters, or ranking, run `analyze` again with the original input.

The replacement profile is parsed as a complete profile, not merged with the old one. Its exact bytes, including one optional leading BOM, determine the new profile hash; the 1 MiB profile limit applies. The source is read once as a verified snapshot. `analysis.refinement` records the immediate source analysis/suite/profile hashes and previously selected group IDs; repeated refinement replaces this lineage entry rather than embedding history.

Saved full-group context questions and conflicts remain blockers even when they came from records outside the five representative samples. Bundles without complete saved group context, empty selections, changed artifacts, invalid profiles, or unsupported data are rejected. Reanalyze original logs to upgrade older bundles missing that context. No source defect is marked resolved and no browser is executed.

The output must be a new directory outside the entire source bundle, including path aliases; source artifacts and linked results remain untouched. Linked runs are not copied. Review acknowledgement defaults to pending even if the old bundle was reviewed. `--reviewed` only acknowledges the new review and does not clear missing context.

Original input bytes are not rechecked by `refine`; retained fingerprints describe the supplied saved analysis. If originals are available, use `verify ./refined --input ... --profile ./review-profile.json` to check them separately. The command requires `--profile` and `--out`; analyze-only filters and selection options are not accepted.

```js
import { readFile } from 'node:fs/promises';
import { refineBundle, writeBundle } from '@ihyeon/error-to-test';

const profileText = await readFile('./review-profile.json', 'utf8');
const analysis = await refineBundle('./initial-analysis', profileText);
await writeBundle('./refined', analysis); // Review remains pending by default.
```

`refineBundle(directory, profileText)` accepts JSON text and returns a new `Analysis`. It does not write files, approve cases, or change process exit codes. Use a separate new output directory when writing the result.

## Review and use Flow QA

Generated files (Flow QA source is limited to 128 KB; suite JSON to 512 KiB):

- `analysis.json`: coverage, ranked groups, safe representative evidence, full-source context checks, and TC candidates.
- `report.md`: human-readable analysis with draft and needs-context TC totals, unique error and React component stacks from representative evidence, reported reproduction, preconditions, proposed test steps, and missing context.
- `flows/error-to-test.md`: observed facts, requirements, steps, and questions.
- `cases/error-to-test.json`: Flow QA `suite-1` (omitted when no TC candidates are selected).
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

### Check recorded execution blockers

`readiness` verifies an existing bundle and summarizes the selected TCs before execution. It shows draft/needs-context counts, review acknowledgement, and each case's outstanding questions, including blockers recorded in the exported Flow QA suite.

```sh
error-to-test readiness ./analysis
error-to-test readiness ./analysis --format json
```

| Exit code | Meaning |
| --- | --- |
| `0` | At least one selected case; every case is a reviewed draft with no recorded blockers |
| `1` | Invalid options, invalid or changed bundle, or output error |
| `2` | Some selected cases are blocked, or no cases were selected |

The full Markdown/JSON report is written to stdout before returning `0` or `2`. JSON uses `error-to-test/readiness-1`, with `status` (`ready`, `blocked`, or `empty`), `reviewed`, candidate counts, per-case `blockers`, and input/analysis/suite hashes. An empty selection is never a successful readiness check. `--reviewed` is an analyze option; it cannot approve an existing bundle through `readiness`.

This checks recorded blockers in the verified snapshot. It does not execute a browser, test credentials or setup, read linked run results, or establish source collection completeness. Groups excluded by `--top`, `--min-count`, or baseline selection are outside the selected-case counts. Drafts still need review; acknowledging review does not clear missing context. Original input/profile bytes are not rechecked by this command; use `verify --input ... --profile ...` for that. The command accepts only a bundle directory and optional `--format text|json`, writes no files, and preserves all artifacts.

```js
import { readReadiness, renderReadiness } from '@ihyeon/error-to-test';

const summary = await readReadiness('./analysis');
console.log(renderReadiness(summary));
// API calls return a summary; only the CLI assigns readiness exit codes.
```

## JavaScript API

```js
import { analyzeErrors, exportFlowQa, writeBundle } from '@ihyeon/error-to-test';

const analysis = analyzeErrors('TypeError: item is undefined', { page: '/items', runtime: 'browser' });
const { suite, flow, provenance } = exportFlowQa(analysis);
await writeBundle('./new-result', analysis);
```

Analysis is deterministic and has no runtime dependencies. Optional model-assisted drafting, collecting new interaction breadcrumbs, direct collector APIs, and a dedicated web input screen are later extensions. Browser/WebView logs can be analyzed; native or WebView execution is not established by a log and remains blocked until the correct context is supplied.

The API supports the same selection with `analyzeErrors(content, { minCount: 3, top: 10 })`.

After a Flow QA run, associate its normalized report with the exact exported suite:

```sh
node bin/error-to-test.mjs link-run .error-to-test/reviewed --report /path/to/qa-report.json
```

The run's suite hash and every case ID must match. Safe case results are stored under `results/<runId>.json`, linked to their source groups/events. Unknown, missing, or duplicate cases are rejected; existing results are never overwritten. A raw e2e report is not accepted. Failed, blocked, and passed results remain distinct; no issue is automatically marked fixed.

### Summarize linked runs

Read the latest linked run's case outcomes by original error group:

```sh
error-to-test results .error-to-test/reviewed
error-to-test results .error-to-test/reviewed --out ./run-summary.md
error-to-test results .error-to-test/reviewed --format json --out ./run-summary.json
```

The summary includes the linked run count, latest run ID/status/timestamps, case totals, and each group's cases and reported reasons. `passed`, `failed`, `flaky`, `blocked`, `skipped`, and `error` remain separate. Without any linked runs, selected cases are `not-run`; groups excluded from TC selection are shown without selected cases. An empty selection does not become a passing result.

Latest means the greatest reported `finishedAt`, then `startedAt`, then lexical run ID for ties. One whole run supplies all displayed case outcomes; earlier successes are never combined with newer runs to manufacture an all-passing result. When runs are linked, pending review and missing candidate context remain visible. These are supplied report outcomes, not review approval, independent execution proof, or evidence that the source issue is resolved.

The bundle and every linked JSON result are checked before output: schema, source/suite hashes, exact case/group/event mappings, statuses, and timestamps must agree. Invalid older runs also fail the request. The reader accepts up to 1,000 directory entries, 2 MiB per result file, and 64 MiB total result bytes. Non-JSON incidental files are ignored; malformed JSON filenames, symlinks, non-regular result files, and limit violations are rejected. `--out` requires a new file outside the bundle's `results` directory and never overwrites existing content. Analysis artifacts and linked results remain unchanged.

The API provides the same data and Markdown renderer:

```js
import { readRunSummary, renderRunSummary } from '@ihyeon/error-to-test';

const summary = await readRunSummary('./analysis');
console.log(summary.counts);
console.log(renderRunSummary(summary));
```

### Fail CI on selected case outcomes

Use repeatable `--fail-on` with `results` to apply a policy to the latest linked run's case counts:

```sh
error-to-test results ./analysis --fail-on failed --fail-on error
error-to-test results ./analysis --fail-on failed --fail-on error --fail-on not-run --format json --out ./ci-results.json
```

Choose exact values from `failed`, `flaky`, `blocked`, `skipped`, `error`, and `not-run`. Duplicates are counted once; option order does not change the policy or summary. Comma-separated values, `passed`, and run-level statuses such as `interrupted` are rejected before reading the bundle.

| Exit code | Meaning with `--fail-on` |
| --- | --- |
| `0` | At least one selected case, and none have a chosen outcome |
| `1` | Invalid options, invalid or changed bundle/result, or output error |
| `2` | A chosen outcome exists, or no cases were selected |

The full existing Markdown/JSON report is output or saved before returning `0` or `2`. A numeric gate summary goes to stderr; JSON stdout remains `error-to-test/run-summary-1` without gate fields. Output errors take precedence and produce exit `1` without a gate outcome; existing output files and bundle results are preserved.

Only the case outcomes from the one latest linked run are evaluated. Historical failures are not combined with newer results, and the overall run status is not a separate gate condition. Without a linked run, selected cases are `not-run`: include `--fail-on not-run` if unexecuted cases should fail. A status you did not choose does not fail the gate, but an empty selection always does. Use `readiness` separately to check recorded context/review blockers before execution. Passing this policy does not approve cases, prove a browser ran, or resolve source errors.

Omitting `--fail-on` preserves the existing results behavior and exit codes. The option is results-only; APIs and saved summary schemas are unchanged. API callers can apply their own policy to the `counts` returned by `await readRunSummary(directory)`.

## Data handling and checks

Known credential assignments, bearer/recognized token formats, email addresses, and URL userinfo/query/fragment are removed before artifacts. Sensitive execution steps are omitted and block the case rather than silently changing its assertion. This is best-effort redaction, not a guarantee of complete anonymization; remove private application data before submitting it. Use files/stdin for private reports to avoid shell history. Logs are source data, not instructions. No external URL from a log becomes an execution target automatically.

```sh
npm run check
npm run check:package
FLOW_QA_SOURCE=/path/to/flow-qa BROWSER_ERROR_SOURCE=/path/to/browser-error-log npm run smoke:flowqa
```

The optional integration smoke uses the actual Browser Error Log SDK and Flow QA/e2e in a controlled local Chromium demo: collect errors, generate TCs, observe failures before repair and passes after repair, preserve an unresolved case, and check stale-source rejection. It requires their local source/dependencies and an installed Chromium browser. It does not access production, login, or call a model.
