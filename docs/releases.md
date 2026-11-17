# Releases and verification

Package: `@ihyeon/error-to-test` · Repository: [hyeonse-swing/error-to-test](https://github.com/hyeonse-swing/error-to-test) · Workflow: `.github/workflows/ci.yml`.

## 0.4.0 — observed error group coverage

`coverage` and the `readCoverage(directory)` API account for every group observed in a verified saved input, including groups excluded from TC selection by a baseline, explicit group filter, minimum count, or top-N limit. The read-only `error-to-test/coverage-1` report separates `unselected`, `blocked`, and `review-ready` groups, preserves source hashes and source-frequency meaning, and gives reason codes and next actions without copying raw error messages or question text. Only an explicit `--group` exclusion can be named precisely from old saved metadata; other unselected groups remain `not-selected-in-saved-bundle`. A group with multiple selected candidates is review-ready only if every case has no recorded blocker and review was acknowledged. Review readiness is not browser execution, a passing assertion, or production coverage. Existing `readiness` and results contracts and exit codes are unchanged.

The fresh installed-package ecosystem check pins Browser Error Log 0.2.12 and Flow QA 0.9.0; `BROWSER_ERROR_LOG_RELEASE_VERSION=X.Y.Z` allows a deliberate exact SDK compatibility check against a later patch. It checks that a manual SDK call returns the same event ID that the local fixture receives, then verifies coverage of pending, reviewed, and top-one selected snapshots. The SDK return ID is evidence of queue admission only; collector receipt is checked separately in this fixture. The check continues to use a local Chromium fixture and no model or customer service.

Local checks on 2026-11-17: the final 0.4.0 candidate passed `npm run check` (type checking, build, 206 tests) and fresh installed-package `npm run check:package`. The installed-package ecosystem candidate passed 10 checks using the public SDK 0.2.12 and the Flow QA 0.9.0 tarball whose integrity matches the public release. Remote release and fully public consumer results are verified separately.

## 0.3.0 — target-scoped linked results

Linked Flow QA results now retain an optional SHA-256 `targetFingerprint` calculated from Flow QA's exact canonical web or mobile target identity. Target names are sanitized labels; two targets can use the same name. Raw target fields are scrubbed from linked names and reasons. A fingerprint is a stable, guessable identifier rather than anonymization. The linker validates the target kind and required fields before writing. Flow QA's early error/interrupted report with an empty web URL, and blocked/interrupted mobile report with an empty device, remain linkable with a sanitized name but no invented fingerprint; other incomplete target/status combinations are rejected.

`results --target-fingerprint SHA256` and `readRunSummary(directory, { targetFingerprint })` select one target's latest run and case counts, including `--fail-on` decisions. Unfiltered results still use the latest run across all targets. Summaries list fingerprinted targets, their sanitized names and run counts, and the number of unscoped runs; scoped summaries also report excluded runs. Legacy full and partial files, targetless reports, and early fallback reports without a fingerprint remain readable but cannot join a target scope. Unknown fingerprints fail rather than producing a passing gate. Every linked file is validated before scope selection, including older and nonselected files. New additive fields keep the `error-to-test/results-1` and `error-to-test/run-summary-1` schema labels; older readers reject new linked files that contain the fingerprint.

The ecosystem smoke also exercises same-name distinct target URLs and a real Flow QA unresolved-target error. To include the standalone SQLite collector, set `BROWSER_ERROR_LOG_MICRO_DIRECTORY` to a built or extracted micro-server directory containing `server.mjs` and `export.mjs`; the smoke stores captured SDK events, stops the collector, verifies a read-only export, and analyzes that export through the installed CLI.

Local checks on 2026-11-16: `npm run check` passed type checking, build, and 203 tests; `npm run check:package` passed the isolated package consumer smoke.

## 0.2.8

Restores compatibility with Browser Error Log resource events across input, CLI, profiles, comparisons and refinement, and with Flow QA selected-run reports. Valid v1 network status values (0..599) are preserved; values below 100 are described as unavailable HTTP status rather than a response.

Selected reports must declare the exact reported case set and the original suite size. Linked results preserve that selection; latest-run summaries leave omitted cases `not-run` even after a previous full pass. Optional sanitized target names survive linking, without target URLs or device identifiers. Existing full results remain readable. New selection/target fields require this reader or newer, because earlier readers reject unknown fields.

The new package ecosystem smoke captures real SDK errors in Chromium, exercises review and execution boundaries through installed CLIs, links whole and selected runs, checks the `not-run` gate, and verifies installed UI/design-system assets. It also audits the fresh consumer for known high/critical runtime advisories. Release preparation now depends on this check in CI.

Local release-candidate checks on 2026-11-16: 199 tests, type checking, build, isolated package installation and the controlled browser flow. Registry publication and GitHub Actions are separate evidence; their final status is available on the matching release/workflow.

## 0.2.0

JSONL inputs add explicit `--format jsonl`, line-numbered validation, and browser/manual record kinds while preserving original bytes, multi-file provenance, comparison/baseline selection, and review gates. Existing 0.1.x bundles and formats remain supported. Integrations with exhaustive `SourceCoverage.kind` handling should include `browser-error-jsonl` and `manual-jsonl`.

This minor release sets both package manifests to `0.2.0` before verification. The workflow publishes that exact source commit without creating an additional patch bump.

## Automatic publication

Pull requests and main pushes verify the package on Ubuntu and macOS. An additional Ubuntu job installs the current tarball with pinned Browser Error Log 0.2.12 and Flow QA 0.9.0, then checks the complete capture/analyze/run/link loop in Chromium. Both jobs must pass before a main push prepares an immutable release source:

- The first publication uses the manifest version (`0.1.0`). A new npm package needs one authenticated bootstrap publication before its Trusted Publisher can be configured.
- Changes to `src/`, `bin/`, `examples/`, `LICENSE`, `package.json`, `package-lock.json`, or `tsconfig.json` automatically increase patch when the manifest still matches npm latest. The workflow commits the version change as `github-actions[bot]` and publishes that exact commit in the same run.
- Documentation/test-only pushes skip publication. They still run verification.
- To request a minor/major release, increase package and lock versions together (for example `npm version minor --no-git-tag-version`) and push to main. Stable `X.Y.Z` versions only.
- Failed publication can be retried on the original workflow run. An already prepared direct bot patch is reused. Existing versions must match the selected source SHA; they are never overwritten or silently accepted from another source.
- Main workflows are serialized without cancellation. If main advances to an unrelated commit during preparation, the old run stops instead of moving the branch backwards.

Publishing uses npm Trusted Publishing (GitHub Actions OIDC) for `hyeonse-swing/error-to-test`, workflow `ci.yml`, with direct-publish permission. No long-lived npm secret is stored in GitHub. The publisher checks registry version/source SHA, downloads and verifies SHA-512 tarball bytes, and installs the registry package into a fresh consumer for import/CLI checks. Only then does the workflow create or confirm `v<version>` and a GitHub Release pointing at the same source commit.

## Local checks

```sh
npm ci
npm run check
npm run check:package
npm run smoke:ecosystem
```

To test real error capture and browser execution, supply local checked-out SDK/Flow QA sources and an installed Chromium browser:

```sh
FLOW_QA_SOURCE=/path/to/flow-qa BROWSER_ERROR_SOURCE=/path/to/browser-error-log npm run smoke:flowqa
```

The browser integration was verified on 2026-10-13 with a controlled local application and no model calls or external account:

| Check | Observed result |
| --- | --- |
| Real SDK events to grouped TC candidates | 3 groups, 2 actionable drafts, 1 unresolved case |
| Review gate | All 3 unreviewed cases blocked |
| Before repair | 2 regression cases failed; unresolved case blocked |
| After repair | Both regression cases passed; unresolved case stayed blocked |
| Flow QA UI library | Generated suite discovered and loaded |
| Report linkage | Before/after reports linked to the exact suite and source groups |
| Changed source | Stale flow and bundle rejected |

An unresolved case means the overall QA run can remain `blocked` even when the two runnable cases pass. This historical source integration check requires sibling repositories. The newer `smoke:ecosystem` check runs in CI using public packages and a local fixture; neither check fetches company repositories or application data. Live service authentication, native devices, and production behavior are outside this proof.
