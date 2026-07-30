# Manual Demo Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make demo artifact generation optional from any manually selected
branch while keeping publication release-only.

**Architecture:** Split the current `demo` job into an artifact-producing job
and a release-only `deploy-demo` job. A `workflow_dispatch` boolean selects
manual generation; only a successful `main` push can tag or deploy.

**Tech Stack:** GitHub Actions, repository script wrappers, actionlint, zizmor

## Global Constraints

- Manual branch runs never push `gh-pages` or deploy GitHub Pages.
- Successful release pushes to `main` always generate and deploy the demo.
- Pull requests never run demo generation or deployment.
- Every workflow shell command uses `./scripts/`.

---

### Task 1: Split generation from deployment

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `docs/superpowers/specs/2026-07-30-manual-demo-workflow-design.md`

**Interfaces:**

- Consumes: `workflow_dispatch.inputs.run_demo`
- Produces: `release-demo` artifact from `demo`
- Produces: release-only `deploy-demo` consuming `release-demo`

- [x] **Step 1: Add the manual input and release guard**

Define `workflow_dispatch.inputs.run_demo` as a boolean with default `false`.
Restrict `tag` to `push` events on `refs/heads/main`.

- [x] **Step 2: Make `demo` generation-only**

Keep `needs: [tag]`, but use `always()` so the job runs when `tag` succeeds or
when a manual dispatch sets `run_demo`. Give it read-only contents permission,
run `./scripts/demo.sh all`, and upload `build/demo` as `release-demo`.

- [x] **Step 3: Add release-only deployment**

Create `deploy-demo` with `needs: [tag, demo]`, the `github-pages` environment,
the existing serialized concurrency lane, and write/OIDC permissions. Download
`release-demo`, run `./scripts/demo.sh current`, then publish `gh-pages` and
deploy `build/demo/pages`.

- [x] **Step 4: Validate and document**

Run:

```bash
./scripts/format.sh
./scripts/dev.sh actionlint .github/workflows/ci.yml
./scripts/dev.sh zizmor .github/workflows/ci.yml
```

Expected: all commands exit 0. Mark the design implemented and record that
manual runs upload artifacts without deploying.

- [x] **Step 5: Commit and push**

```bash
git add .github/workflows/ci.yml \
  docs/superpowers/specs/2026-07-30-manual-demo-workflow-design.md \
  docs/superpowers/plans/2026-07-30-manual-demo-workflow.md
git commit -m "ci: allow manual demo artifact runs"
git push
```
