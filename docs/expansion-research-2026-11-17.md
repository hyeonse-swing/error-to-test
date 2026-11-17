# Expansion research — observed error group coverage

Date: 2026-11-17. Scope: `@ihyeon/error-to-test` after v0.3.0. This is a design decision for a local change, not a claim about production use.

## Evidence

- `src/analysis.ts` retains every observed error group but selects candidates only after optional baseline, explicit group, minimum count, and top-N filters. `report.md` lists all groups, yet the exported suite contains only selected candidates.
- `src/readiness.ts` verifies the bundle and reports readiness for selected cases. It includes the total group count, but cannot identify which groups have no selected TC or how many observed groups remain outside the suite. A `ready` result can therefore be read without noticing a deliberately narrow selection. The README documents that selection limits exist, but a machine-readable audit of the actual saved scope is absent.
- `gh issue list -R hyeonse-swing/error-to-test --state open` returned no open issues on 2026-11-17. This need comes from the current source and usage path rather than an issue request.
- The [ISTQB Foundation syllabus, §1.4.4](https://www.istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf) describes traceability between test basis, cases, results, and defects as useful for evaluating coverage. Here, observed error groups are only a local source set; they do not represent all defects or all user flows.

## Decision

Add a read-only `coverage` command and `readCoverage` API for a verified saved bundle. It will list every observed group by stable ID with its supplied-record count and source frequency (`captured-events` or `submitted-reports`), selected candidate IDs, and one of `unselected`, `blocked`, or `review-ready`. Counts will state how many *observed groups* fall in each category. A group with multiple candidates is `review-ready` only when every selected case passes the existing readiness check; `review-ready` does not imply that a browser ran. The report will include source hashes and collection warnings, and expose no raw error message or target URL. This leaves existing `readiness` output and exit semantics unchanged.

The report cannot reconstruct a precise filter reason from old bundles because `top` and `minCount` values are not saved as structured fields. It will name unselected groups and direct users to the original analysis/selection options rather than guess a reason. No percentage will be labelled test coverage or user coverage.

## Acceptance checks

1. A reviewed bundle with selected and unselected groups accounts for every observed group, and a group with mixed candidate blockers stays `blocked`.
2. An empty suite reports all observed groups as `unselected`; no group is called `review-ready` just because review was acknowledged.
3. Mutated artifacts, mismatched mappings, and malformed group metadata fail before a coverage report is returned. The command is read-only and preserves existing output files.
4. API and CLI JSON/Markdown results agree; package build and installed CLI smoke pass. Existing analyze, readiness, and results behavior stays unchanged.
