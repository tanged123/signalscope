# Manual Demo Workflow Design

**Status:** Implemented by the [manual demo workflow plan](../plans/2026-07-30-manual-demo-workflow.md)

**Date:** 2026-07-30

## Goal

Allow a maintainer to generate and inspect demo artifacts from any branch
without publishing them, while continuing to generate and deploy the live demo
automatically for releases from `main`.

## Workflow

Add a boolean `run_demo` input to `workflow_dispatch`.

Split the current release demo job into two jobs:

- `demo` bakes, records, encodes, validates, and uploads `release-demo`. It runs
  after a successful release tag or when a manual workflow dispatch selects
  `run_demo` on any branch.
- `deploy-demo` downloads `release-demo`, pushes the orphan `gh-pages` branch,
  and deploys the Pages artifact. It runs only after both `tag` and `demo`
  succeed for a push to `main`.

Restrict `tag` to pushes to `main`. A manual dispatch on `main` must not create
a release tag.

## Safety

Manual branch runs receive read-only repository permissions and do not use the
`github-pages` environment. Only `deploy-demo` receives `contents: write`,
`pages: write`, and `id-token: write`.

The deployment job keeps the serialized Pages concurrency lane and verifies
that its checkout is still the current `origin/main` before either publishing
path runs.

Manual runs upload `release-demo` for inspection. They do not enter the
`github-pages` environment, push `gh-pages`, or deploy the live site.

## Validation

- Workflow lint and security audit pass.
- A manual-dispatch expression selects `demo` without selecting `tag` or
  `deploy-demo`.
- A `main` push preserves the release sequence:
  `tag` → `demo` → `deploy-demo`.
- Pull requests do not run any demo job.
