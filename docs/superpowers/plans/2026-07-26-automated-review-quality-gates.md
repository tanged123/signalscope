# Deterministic Quality Gates

**Status:** Delivered

This document records the CI and dependency-automation design that replaced
the earlier proposed advisory-review plan. Deterministic, locally reproducible
checks are the merge gate; CodeRabbit remains the general AI reviewer.

## Quality gate

`./scripts/ci.sh quality` and the GitHub Actions `quality` job call the same
`quality_checks()` function in `scripts/lib.sh`. The function is the single
source of truth for:

- ShellCheck over repository scripts and the pre-commit hook.
- Actionlint over GitHub Actions workflows and composite actions.
- Typos with generated files, lockfiles, and design-pass HTML excluded.
- Cargo Deny for advisories, yanked crates, wildcard requirements, licenses,
  duplicate-version warnings, and unknown dependency sources.
- Cargo Machete for unused direct Rust dependencies.
- A frontend runtime-dependency assertion protecting self-contained snapshots.
- Knip for unreferenced TypeScript files and exports.
- Zizmor for workflow supply-chain and expression-injection findings.

The Nix development shell pins every tool. `./scripts/ci.sh all` runs formatting
and quality before the existing Rust, frontend, artifact, and Playwright gates.
RustSec data is fetched on the first cold quality run, so that run requires
network access.

Treefmt also formats shell scripts with shfmt. The repository hook installer
uses `git rev-parse --git-path hooks`, so it works in both ordinary checkouts and
linked worktrees.

## Workflow policy

Third-party actions must be hash-pinned. Trusted publishers under `actions/*`,
`cachix/*`, and `codecov/*` may use version refs. Checkout credentials are not
persisted except in the release-tag job, where the credential is required to
push the annotated tag and is narrowly suppressed in Zizmor.

PR expressions used by shell commands are passed through step environment
variables. Codecov upload is skipped when `CODECOV_TOKEN` is unavailable, but
local coverage generation still runs.

`ci-ok` depends on every required PR job and fails if any dependency fails or
is cancelled. It is the stable branch-protection target; release-only native
bundle and AppImage jobs are intentionally outside it.

## Repository invariants

ESLint rejects host-identity branches in frontend code, concrete
`TauriPlane`/`BakedPlane` imports from UI and renderer modules, and interpolated
or concatenated assignments to `innerHTML`. Static trusted markup remains
legal. A separate package check fails if the frontend gains runtime or peer
dependencies.

These checks encode the mechanically enforceable parts of `AGENTS.md`; the
remaining product and architecture rules still require tests and review.

## Dependency and coverage automation

Renovate owns Cargo, npm, GitHub Actions, and Nix updates. Minor and patch
updates are grouped by ecosystem on a weekly schedule, `flake.lock` receives
weekly lock-file maintenance, concurrency is bounded, and Tauri majors require
dependency-dashboard approval.

Codecov reports project and patch status informationally. Patch coverage targets
70% with a 5% threshold; it is deliberately non-blocking while the frontend UI
tree lacks unit coverage.

## Advisory review decision

The proposed Codex reviewer was dropped. Repeated review concerns should become
deterministic checks or behavioral tests where possible, and CodeRabbit already
covers general review. Adding a second overlapping AI reviewer would add noise
without improving the required merge gate.

## Deferred work

The following items remain explicitly deferred:

- `cargo-mutants`.
- `jscpd` duplication detection with a ratchet.
- ESLint `max-lines` for `src/ui/**`.
- Playwright visual regression against the Final Spec.
- `axe` accessibility assertions.
- `lychee --offline` documentation link checking.
- An MSRV job.
- Design-token and Final-Spec CSS lints, pending triage of
  `frontend/src/styles/app.css:331` (`border-radius: 999px`), `:865`
  (`box-shadow`), and `:525`/`:534` (gradients) against the Final Spec.
- A commit-message linter, pending selection of one convention for the
  repository's mixed conventional and imperative history.

CodeQL default setup for Rust, JavaScript/TypeScript, and GitHub Actions remains
an owner-managed repository setting. It should use the default query suite,
start as non-required, and have initial alerts triaged individually.

## Owner activation

The repository owner must install the Renovate GitHub App and merge its
onboarding PR, change `main` branch protection to require `ci-ok` after its
first green run, enable CodeQL default setup, and confirm CodeRabbit remains
installed.
