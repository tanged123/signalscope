# Automated Review & Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce AI-generated slop with narrow SignalScope-aware Codex feedback, broad CodeRabbit review, and deterministic quality checks.

**Architecture:** Existing CI remains the required correctness gate. Add one locally reproducible deterministic `quality` job, enable CodeQL as a lightweight baseline, and run Codex as a non-blocking specialist reviewer. Leave CodeRabbit unchanged as the general reviewer.

**Tech Stack:** Bash/Nix, Cargo, pnpm/TypeScript, GitHub Actions, CodeQL, Codecov, CodeRabbit, `openai/codex-action`.

**Status:** Proposed future work. The repository does not provide
`./scripts/ci.sh quality` or a required `quality` workflow job until Task 1 is
implemented.

## Global Constraints

- AI findings are advisory and never determine mergeability.
- Do not add Greptile, Qodo, or SonarQube in this pass.
- Every CI shell command enters through `scripts/`.
- Codex reports at most five concrete findings and does not duplicate deterministic CI or general CodeRabbit feedback.
- Commit each task separately with lowercase imperative messages.

---

### Task 1: Add a deterministic quality job

**Files:**

- Modify: `flake.nix`, `scripts/lib.sh`, `scripts/ci.sh`, `.github/workflows/ci.yml`
- Create: `deny.toml`, `frontend/knip.json`
- Modify: `frontend/package.json`, `pnpm-lock.yaml`

**Planned output (not currently available):** `./scripts/ci.sh quality`, used
identically locally and in GitHub Actions after Task 1 is complete.

- [ ] Add `actionlint`, `cargo-deny`, `cargo-machete`, and `shellcheck` to the Nix dev shell.

- [ ] Add pinned Knip:

```bash
./scripts/dev.sh pnpm --filter @signalscope/frontend add --save-dev --save-exact knip
```

- [ ] Generate `deny.toml` with `./scripts/dev.sh cargo deny init`, then configure:
  - deny vulnerabilities, yanked crates, wildcard dependencies, and unknown sources;
  - warn initially on unmaintained and duplicate crates;
  - allow only licenses already needed by the locked graph;
  - document exceptions per crate—no blanket skips.

- [ ] Create `frontend/knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip/schema.json",
  "entry": [
    "src/main.ts",
    "vite.config.ts",
    "vitest.config.ts",
    "playwright.config.ts",
    "scripts/*.mjs",
    "tests/e2e/*.ts"
  ],
  "project": ["src/**/*.ts", "tests/**/*.ts", "scripts/*.mjs", "*.config.ts"],
  "ignore": ["src/generated/**", "src/node-builtins.d.ts"]
}
```

Add `"check:unused": "knip"` to `frontend/package.json`.

- [ ] Add to `scripts/lib.sh`:

```bash
quality_checks() {
  cargo deny check
  cargo machete
  pnpm --filter @signalscope/frontend check:unused
  shellcheck scripts/*.sh .github/hooks/pre-commit
  actionlint
}
```

Expose this as `./scripts/ci.sh quality` and include it in `./scripts/ci.sh all`.

- [ ] Add a `quality` job to `.github/workflows/ci.yml` using the existing checkout/setup pattern and:

```yaml
- run: ./scripts/ci.sh quality
```

Make it required after the first clean PR run.
Also add `quality` to the release `tag` job's `needs` list.

- [ ] Fix genuine baseline findings; use narrow documented exclusions for confirmed false positives.

- [ ] Verify and commit:

```bash
./scripts/ci.sh format
./scripts/ci.sh quality
./scripts/test.sh quick
git add flake.nix deny.toml frontend/knip.json frontend/package.json pnpm-lock.yaml scripts/lib.sh scripts/ci.sh .github/workflows/ci.yml
git commit -m "add deterministic quality checks"
```

---

### Task 2: Enable CodeQL as a small security baseline

**Files:** No repository file if GitHub default setup is available; otherwise create `.github/workflows/codeql.yml`.

**Produces:** Rust, JavaScript/TypeScript, and GitHub Actions annotations.

- [ ] Enable CodeQL default setup in GitHub repository settings for:

```text
Rust
JavaScript/TypeScript
GitHub Actions
```

- [ ] Use the default query suite. Triage each initial alert individually; do not bulk-dismiss.

- [ ] Leave CodeQL non-required for ten PRs. If stable, require only the deterministic `Code scanning results` check.

- [ ] If advanced setup is required, commit GitHub’s generated workflow after validating it with:

```bash
./scripts/ci.sh quality
git add .github/workflows/codeql.yml
git commit -m "enable codeql analysis"
```

---

### Task 3: Add the narrow advisory Codex reviewer

**Files:**

- Create: `docs/code-review.md`
- Create: `.github/codex/prompts/signalscope-review.md`
- Create: `.github/workflows/codex-review.yml`
- Modify: `AGENTS.md`

**Produces:** One replaceable, advisory `SignalScope Codex review` PR comment.

- [ ] Create `docs/code-review.md` with this review order:
  1. plotting/data correctness;
  2. DataPlane, Rust dependency, and generated-schema invariants;
  3. missing behavioral regression tests;
  4. duplicate representations, dead paths, or unnecessary abstractions;
  5. Final Spec fidelity for UI changes;
  6. security only at ingest, filesystem, snapshot HTML, dependency, or CI trust boundaries.

Exclude formatting, naming, praise, summaries, generic best practices, speculative risks, and anything deterministic CI already reports. Every finding needs an exact location, concrete failure scenario, violated invariant, smallest fix, and regression test. Limit output to five findings.

Reference this document from `AGENTS.md`.

- [ ] Create `.github/codex/prompts/signalscope-review.md`:

```markdown
Review only `git diff HEAD^1 HEAD`.

Read AGENTS.md and docs/code-review.md first. Read relevant accepted ADRs and,
for UI changes, the authoritative design documents listed in AGENTS.md.

Follow docs/code-review.md exactly. Verify findings against surrounding code and
tests. Do not modify files. CodeRabbit owns general review.

Output Markdown headed `## SignalScope Codex review`. Return at most five
findings. If nothing qualifies, say:
`No actionable SignalScope-specific findings.`
```

- [ ] Create `.github/workflows/codex-review.yml` using `openai/codex-action@v1`:
  - trigger on PR open, synchronize, reopen, and ready-for-review;
  - skip forks so `OPENAI_API_KEY` is never exposed;
  - check out `refs/pull/${{ github.event.pull_request.number }}/merge` with full history and no persisted credentials;
  - use the committed prompt, `sandbox: read-only`, and `safety-strategy: drop-sudo`;
  - give Codex only `contents: read`;
  - make the Codex step `continue-on-error: true`;
  - use a separate `actions/github-script` step/job with `pull-requests: write`;
  - update one comment marked `<!-- signalscope-codex-review -->`;
  - never approve, request changes, push commits, or fail because findings exist;
  - never interpolate PR text or commit messages into the prompt.

- [ ] Test with one intentional SignalScope invariant violation and one harmless style issue. Codex should report only the invariant violation, remain advisory, and update rather than duplicate its comment.

- [ ] Verify and commit:

```bash
./scripts/ci.sh format
./scripts/ci.sh quality
git add AGENTS.md docs/code-review.md .github/codex/prompts/signalscope-review.md .github/workflows/codex-review.yml
git commit -m "add signalscope-specific codex review"
```

---

### Task 4: Add informational test-strength feedback

**Files:** Create `codecov.yml`.

- [ ] Add informational patch coverage:

```yaml
coverage:
  status:
    patch:
      default:
        target: 80%
        threshold: 5%
        informational: true
```

- [ ] Verify and commit:

```bash
./scripts/ci.sh format
./scripts/coverage.sh
git add codecov.yml
git commit -m "report patch coverage"
```

- [ ] Mutation testing is deliberately deferred. After ten PRs, decide whether changed `core/scope-core` logic warrants a separate plan for an advisory `cargo-mutants` script/job. Keep it out of `./scripts/ci.sh all`.

---

## Rollout Review

After twenty PRs, compare accepted versus dismissed Codex findings, overlap with CodeRabbit, deterministic failures by tool, and added CI time. Tighten or remove noisy checks. When the same accepted AI finding recurs twice, convert it into a test, lint rule, dependency policy, or explicit repository instruction.

Final local verification:

```bash
./scripts/ci.sh all
```

CodeQL and Codex must also be verified on a pushed PR; do not claim those remote checks were tested locally.
