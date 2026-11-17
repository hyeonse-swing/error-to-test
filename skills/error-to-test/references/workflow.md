# CLI and artifact workflow

Commands below use the installed `error-to-test` binary from the installed `@ihyeon/error-to-test` package (these commands require 0.4.0 or later). Check its version and `--help` before applying a copied skill. Use a fresh path for every `--out` directory/file; outputs are not overwritten. This reference stays in the copied skill folder.

## Inputs and first analysis

- Browser Error Log v1 export: `{ "schemaVersion": 1, "events": [...] }` (optional `partial`) or full v1 event array. Resource failures are separate from HTTP failures; status `0` is not an HTTP code.
- Manual JSON: `{ "schemaVersion": "error-to-test/manual-1", "errors": [{ "message": "..." }] }`. Optional fields include `page`, `runtime`, `reproduction`, `expected`, `expectedSource`, `preconditions`, and explicit web `steps`. A textual expectation alone is not a runnable assertion.
- Plain text: one report per file; first line is the message, remaining lines are stack. Use `--format text` when automatic detection is unsuitable.
- JSONL: one full v1 event or manual report object per line; specify `--format jsonl`. Do not mix input kinds. Repeat `--input` for multiple files of one kind, preserving order for later verification.

```sh
error-to-test analyze --input errors.json --out ./initial-analysis
error-to-test analyze --input errors.jsonl --format jsonl --min-count 3 --top 10 --out ./initial-jsonl
error-to-test verify ./initial-analysis --input errors.json
error-to-test readiness ./initial-analysis
error-to-test coverage ./initial-analysis
```

`--min-count` and `--top` narrow candidate selection, while unselected groups remain in the analysis. `readiness` exits 2 for blocked or empty selection, 0 for reviewed candidates without recorded blockers, and 1 for invalid input. `coverage` reports `unselected`, `blocked`, or `review-ready` for all observed groups; its valid report exits 0 even with blocked groups. Neither command executes a test. `verify` checks bundle consistency; original bytes are checked only when `--input` is supplied. The package accepts up to 50 files, 10 MiB combined and 10,000 raw records.

## Confirm candidates and review

```sh
error-to-test init-profile ./initial-analysis --out ./review-profile.json
# Edit from confirmed requirements and observed context.
error-to-test analyze --input errors.json --profile ./review-profile.json --out ./profile-analysis
error-to-test readiness ./profile-analysis
# After reviewing the complete profile and exported cases:
error-to-test analyze --input errors.json --profile ./review-profile.json --reviewed --out ./reviewed-analysis
error-to-test verify ./reviewed-analysis --input errors.json --profile ./review-profile.json
error-to-test readiness ./reviewed-analysis
error-to-test coverage ./reviewed-analysis
```

The template is `error-to-test/profile-1` and intentionally incomplete. Each scenario needs a confirmed `requirement`, `expectedSource`, setup, explicit actions and observable assertion in [supported steps](web-steps.md). Confirm setup before setting `setupConfirmed: true`; remove questions only when answered. Reuse the original input, metadata, filters and order. When original logs are unavailable, `error-to-test refine ./initial-analysis --profile ./review-profile.json --out ./refined-analysis` regenerates from the verified saved selected groups, but cannot expand selection or recheck original input bytes. Review acknowledgement resets unless `--reviewed` is supplied after new review. If selected groups changed, reanalyze originals. Unknown context remains blocked even after review acknowledgement.

## Flow QA handoff and results

Handoff includes `report.md`, `analysis.json`, `provenance.json`, and, when selected candidates exist, `flows/error-to-test.md` and `cases/error-to-test.json`. Verify source/profile bytes if available. Record input kind, filters, partial flag, unknown retention, selected versus all observed groups, unresolved questions, review status, and exact target the operator chose. The bundle itself does not run a browser or select a target. Flow QA resolves the suite's source-flow path against its workspace: validate with the analysis directory as `--workspace`, or copy both `flows/` and `cases/` together without changing their bytes.

After Flow QA runs the exported suite on that chosen target and writes a normalized `flow-qa/report-1` report:

```sh
error-to-test link-run ./reviewed-analysis --report ./flow-qa-report.json
error-to-test results ./reviewed-analysis --format json
error-to-test results ./reviewed-analysis --target-fingerprint <64-lowercase-hex-fingerprint> --fail-on failed --fail-on error --fail-on not-run
```

Get a target fingerprint from the unfiltered `results --format json` target inventory before using the filter. Never infer a target from a log URL. Linking requires the exported suite hash and declared case IDs to match. The latest linked run supplies outcomes; selected runs leave other cases `not-run`. Results can be `passed`, `failed`, `flaky`, `blocked`, `skipped`, `error`, or `not-run`. A `--fail-on` gate exits 2 on matching cases or empty selection, 1 for invalid data, 0 otherwise. A passing gate proves only that the specified policy was met for the reported run; it does not prove source issue resolution.
