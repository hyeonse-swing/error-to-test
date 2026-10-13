# Releases and verification

Package: `@ihyeon/error-to-test` · Repository: [hyeonse-swing/error-to-test](https://github.com/hyeonse-swing/error-to-test) · Workflow: `.github/workflows/ci.yml`.

## Automatic publication

Pull requests and main pushes verify the package on Ubuntu and macOS. A verified main push then prepares an immutable release source:

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

An unresolved case means the overall QA run can remain `blocked` even when the two runnable cases pass. This integration check is separate from standalone CI and requires the sibling packages; CI does not fetch company repositories or application data. Live service authentication, native devices, and production behavior are outside this proof.
