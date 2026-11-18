# Event ID lookup follow-up — 2026-11-18

## Observed gap

The Browser Error Log SDK returns the ID of an accepted manual event. Error to Test 0.4.2 retains that ID in every observed group's `analysis.json` entry and in selected-case provenance. Its CLI reports groups, readiness, and linked runs separately. A user starting with the SDK ID must search the bundle manually to find its group, case, and latest outcome.

## Chosen behavior

Add a read-only `trace` lookup for one event ID in a verified saved bundle. Return all matching groups because the input deduplicates an ID within a project, while different projects may use the same ID. Include the observed group's selection/review state, selected candidate IDs and blockers, and latest linked case outcome using the existing optional target fingerprint. A selected case absent from the latest run remains `not-run`. An unknown ID is absent only from the saved analysis input; a partial export and unknown collection retention prevent a global absence claim. Trace output omits error messages and stack traces.

Reuse bundle verification, coverage, readiness, and run-summary contracts. Preserve the existing formats and versioned schemas, with a new `error-to-test/trace-1` report. The package's main-push release workflow automatically creates the next patch when source changes. Local checks and a fresh package consumer will verify lookup and command behavior before publication.
