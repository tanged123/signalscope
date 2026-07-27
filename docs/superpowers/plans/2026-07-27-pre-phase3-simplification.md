# Pre-Phase-3 Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the verified dead code, latent bugs, and state-model divergences that would tax Phase 3 (expressions, session migrations, autosave) and Phase 4 (export, parity), in ~14 small tasks.

**Architecture:** No new layers. Every change is a deletion, a merge, or a move of state into the schema-backed `Session` object, which becomes the single source of truth ahead of Phase 3 autosave. One session-schema bump (v8 → v9) covers both new fields.

**Tech Stack:** Rust (scope-core), TypeScript (frontend), bash (scripts), JSON schema codegen (`protocol/scripts/generate-types.mjs`).

## Global Constraints

- Every build/test/format command goes through `./scripts/` wrappers — never raw `cargo`, `pnpm`, or `npx` (AGENTS.md command policy).
- Run `./scripts/format.sh` before staging each commit; treefmt is the only formatter and it also formats Markdown.
- Generated files (`protocol/src/generated.rs`, `core/scope-core/src/session/generated.rs`, `frontend/src/generated/protocol.ts`, `frontend/src/generated/session.ts`) are regenerated only via `./scripts/codegen.sh` — never hand-edited.
- Stage named files only; never `git add -A`. Conventional commit subjects plus the why.
- Delete dead code outright — no commenting out, no deprecation shims.
- The branch's final change is the synchronized version bump (Task 14, `minor`).
- If a "delete X" step causes a typecheck/build error because X turns out to have a reader, STOP that deletion, keep X, and note it in the handoff — do not force it.

Work on a new branch cut from `phase2_post_cleanup`:

```bash
git checkout -b pre-phase3-simplification
```

---

### Task 1: Untrack the stray screenshot and ignore root captures

**Files:**

- Delete (from index only): `Screenshot 2026-07-26 185157.png`
- Modify: `.gitignore`

A WSL screenshot was accidentally committed at repo root in `d949e44`. `.gitignore` covers PNGs in every build directory but not the root, which is where screenshots land.

- [ ] **Step 1: Untrack the file (keep it on disk)**

```bash
git rm --cached "Screenshot 2026-07-26 185157.png"
```

- [ ] **Step 2: Ignore future root screenshots**

Append to `.gitignore`:

```text
/Screenshot*.png
```

- [ ] **Step 3: Verify**

```bash
git status --short
```

Expected: the screenshot shows as a staged deletion; the on-disk file is NOT listed as untracked (ignored).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore(repo): untrack stray screenshot and ignore root captures"
```

---

### Task 2: Make codegen fail loudly on unhandled u64 forms

**Files:**

- Modify: `protocol/scripts/generate-types.mjs:181-203` (`emitObject`)

The generator matches `u64` by exact string equality (`type === "u64"`, `type === "u64[]"`), but `convertType` handles the `?` wrapper generically. A `u64?` field would emit Rust `Option<u64>` serialized as a JSON number while TypeScript gets `string | null` — silent wire drift. Phase 3's `derived_from` field is the likely first victim.

- [ ] **Step 1: Reproduce the bug (red)**

Temporarily add `"derived_test": "u64?"` to the `LinkedTime` fields in `protocol/schema/scope-session.json`, then:

```bash
./scripts/codegen.sh
grep -n "derived_test" core/scope-core/src/session/generated.rs frontend/src/generated/session.ts
```

Expected today: Rust shows `pub derived_test: Option<u64>` with **no** `#[serde(with = ...)]` attribute, while TypeScript shows `derived_test: string | null` — the mismatch.

- [ ] **Step 2: Add the guard**

In `emitObject`, immediately after `const rustField = snakeCase(field);` (line ~186), insert:

```js
if (type.includes("u64") && type !== "u64" && type !== "u64[]") {
  throw new Error(
    `${name}.${field}: unsupported u64 form "${type}" — only "u64" and "u64[]" carry the string serde attributes`,
  );
}
```

- [ ] **Step 3: Verify the guard fires (still red input)**

```bash
./scripts/codegen.sh
```

Expected: non-zero exit with the `unsupported u64 form "u64?"` message.

- [ ] **Step 4: Revert the schema probe and regenerate (green)**

```bash
git checkout -- protocol/schema/scope-session.json
./scripts/codegen.sh
git diff --exit-code -- protocol/src/generated.rs core/scope-core/src/session/generated.rs frontend/src/generated/protocol.ts frontend/src/generated/session.ts
```

Expected: exit 0, no diff.

- [ ] **Step 5: Commit**

```bash
git add protocol/scripts/generate-types.mjs
git commit -m "build(codegen): reject u64 forms the serde attributes do not cover"
```

---

### Task 3: Delete dead Rust items

**Files:**

- Modify: `core/scope-core/src/pyramid.rs:8`
- Modify: `core/scope-core/src/ingest/mod.rs` (IngestSummary), `core/scope-core/src/ingest/csv.rs:124`, `core/scope-core/src/ingest/mcap.rs:132`, `core/scope-core/src/cache.rs:286`
- Modify: `core/scope-core/src/compute.rs:70-91` and its test at `:171`

All verified reader-free. **Do NOT delete `Signal::is_empty` (store.rs:80)** even though it has no callers — clippy's `len_without_is_empty` requires it beside `pub fn len`.

- [ ] **Step 1: Delete `TILE_BINS`**

Remove `pub const TILE_BINS: usize = 256;` from `pyramid.rs:8` (plus any doc comment directly above it). It is a vestige of the original fixed-256-bin tile design; `query` returns variable-length slices, and the constant would mislead Phase 4 tile-selection work.

- [ ] **Step 2: Delete `IngestSummary.source_path`**

In `ingest/mod.rs` remove the `pub source_path: PathBuf,` field from `IngestSummary`. Remove `PathBuf` from the `use std::{... path::{Path, PathBuf}}` import (keep `Path`). Then remove the `source_path: ...` initializer from the three construction sites the compiler flags: `ingest/csv.rs:124`, `ingest/mcap.rs:132`, `cache.rs:286`.

- [ ] **Step 3: Delete `compute::lerp_at`**

Remove the whole function including its doc comment (`compute.rs:70-91` — from `/// Linearly interpolates a value at `query`.` through the closing brace). In the test `transforms_match_prototype_semantics`, delete the single line:

```rust
assert_eq!(lerp_at(&time, &values, 0.5), 1.0);
```

The live TypeScript twin (`lerpSample` in `frontend/src/app/xy.ts`) is untouched.

- [ ] **Step 4: Verify**

```bash
./scripts/ci.sh rust
```

Expected: clippy (`-D warnings`) and all workspace tests pass.

- [ ] **Step 5: Commit**

```bash
./scripts/format.sh
git add core/scope-core/src/pyramid.rs core/scope-core/src/ingest/mod.rs core/scope-core/src/ingest/csv.rs core/scope-core/src/ingest/mcap.rs core/scope-core/src/cache.rs core/scope-core/src/compute.rs
git commit -m "refactor(core): delete dead pyramid, ingest, and compute items"
```

---

### Task 4: Delete dead TypeScript and CSS surface

**Files:**

- Modify: `frontend/src/app/plot-capabilities.ts`
- Modify: `frontend/src/app/commands.ts`, `frontend/src/app/commands.test.ts`
- Modify: `frontend/src/app/plot-hit.ts`, `frontend/src/app/plot-hit.test.ts`
- Modify: `frontend/src/ui/signal-tree.ts:116`, `frontend/src/ui/workspace-tabs.ts:20`
- Modify: `frontend/src/styles/app.css`, `frontend/src/styles/tokens.css`

All verified reader-free by repo-wide grep. The typechecker is the safety net: after each deletion `pnpm` typecheck (via the frontend suite) must stay green; if it flags a reader, keep that member (see Global Constraints).

- [ ] **Step 1: Prune `plot-capabilities.ts`**
  - Delete the `PlotFrame` interface (lines 26-28) and the `readonly frame: PlotFrame;` member of `PreparedPlot` (line 102).
  - Delete the `readonly mode: PanelMode;` member of `PreparedPlot` (line 100). Keep `readonly domain` — it is live (`panel.ts` and the tests read `plot.domain`).
  - In each of the four factory return objects, delete the `mode:` and `frame:` properties (time `:213-215`, xy `:305-307`, fft `:451-453`, histogram `:572-574`). If `PanelMode` becomes an unused import, remove it.
  - In `PlotCursor`, delete the `domain` and `interval` members. Change the `cursor()` helper (line 662) to `cursor(x, heading, rows, link)` — drop the `domain` first parameter and the trailing `interval` parameter and their uses in the returned object. Update the four call sites: time `cursor("time", x, ...)` → `cursor(x, ...)`; xy `cursor("time", hit.time, ...)` → `cursor(hit.time, ...)`; fft `cursor("frequency", x, ...)` → `cursor(x, ...)`; histogram — drop both `"distribution"` and the final `[low, high]` argument.
  - In `PlotStatGroup`, delete `key` and `colorIndex`. Change `statsGroup(key, label, colorIndex, items)` (line 812) to `statsGroup(label, items)` and update every call site: time `:261` → `statsGroup(series.path, [...])`; xy `:389` → `statsGroup(\`x · ${input.x.path}\`, statItems(xStats))`, `:396`→`statsGroup(\`y · ${series.path}\`, statItems(...))`, `:409`→`statsGroup(\`c · ${input.color.path}\`, [...])`; fft `:516`→`statsGroup(series.path, [...])`; histogram `:640`→`statsGroup(series.path, [...])`.

- [ ] **Step 2: Delete `CommandRegistry.list()`**

Remove the `list()` method from `commands.ts` (lines 23-28). In `commands.test.ts`: delete the whole `it("list() hides disabled commands", ...)` block, and in `it("lists planned commands for menus but never runs them", ...)` delete only the line `expect(registry.list()).toEqual([]);` (the `listAll` and `run` assertions stay).

- [ ] **Step 3: Delete `nearestAnnotation`**

Remove the function from `plot-hit.ts` (lines 49-69, including its doc comment). In `plot-hit.test.ts` remove `nearestAnnotation` from the import and delete the `test("nearestAnnotation uses the tighter marker radius", ...)` block. If the test file's `annotations` fixture is now unused, delete it too.

- [ ] **Step 4: Delete write-only dataset attributes and CSS**
  - `signal-tree.ts:116`: delete `button.dataset.groupPath = row.path;`
  - `workspace-tabs.ts:20`: delete `item.dataset.tabId = tab.id;`
  - `app.css:608-611`: delete the `.legend-menu { color: var(--fg-4); }` rule (the real class is `.legend-overflow-menu`; a bare `.legend-menu` element is never created).
  - `tokens.css:70-71`: first run `grep -rn 'dur-normal\|dur-slow' frontend/src frontend/tests` — expect hits only in `tokens.css` itself. Then delete `--dur-normal: 140ms;` and `--dur-slow: 240ms;` (keep `--dur-quick`, which is used).

- [ ] **Step 5: Verify**

```bash
./scripts/test.sh frontend
```

Expected: lint, typecheck, codegen check, and vitest all pass.

- [ ] **Step 6: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/plot-capabilities.ts frontend/src/app/commands.ts frontend/src/app/commands.test.ts frontend/src/app/plot-hit.ts frontend/src/app/plot-hit.test.ts frontend/src/ui/signal-tree.ts frontend/src/ui/workspace-tabs.ts frontend/src/styles/app.css frontend/src/styles/tokens.css
git commit -m "refactor(frontend): delete dead capability, registry, and style surface"
```

---

### Task 5: Collapse the no-op session migration rungs

**Files:**

- Modify: `core/scope-core/src/session.rs:136-160` (arms 3, 4, 7) and `:202-209` (`default_panel_fields`)

Arms 3, 4, and 7 only insert explicit `null` for fields the generator already marks `#[serde(default)] Option<…>` — absent and explicit-null deserialize identically (verified empirically). Arm 6 (`cursor_mode`) **is** load-bearing (required enum) and stays. The existing v-tests stay as regression locks on the serde behavior.

- [ ] **Step 1: Replace the three arms**

Delete the `3 => {...}`, `4 => {...}`, and `7 => {...}` arms and insert one combined arm (position after arm `2`; keep arms `5` and `6` unchanged):

```rust
3 | 4 | 7 => {
    // Purely additive optional panel fields; #[serde(default)] restores
    // absent fields, so no rewrite is needed.
    let next = version + 1;
    value["schema_version"] = serde_json::json!(next);
    migrate(next, value)
}
```

- [ ] **Step 2: Delete `default_panel_fields`**

Remove the function and its doc comment (`:202-209`). `for_each_panel` stays (arm 5 uses it, and Task 10 adds a new user).

- [ ] **Step 3: Extend the ladder doc comment**

In the doc comment above `migrate` (line ~70), append one sentence:

```text
Additive optional fields need no rung; only new required fields do.
```

- [ ] **Step 4: Verify**

```bash
./scripts/test.sh core
```

Expected: all session tests pass, including `v1_sessions_migrate_to_current` and `v7_panels_gain_a_default_color_axis_label`.

- [ ] **Step 5: Commit**

```bash
./scripts/format.sh
git add core/scope-core/src/session.rs
git commit -m "refactor(session): collapse no-op migration rungs"
```

---

### Task 6: Drop the duplicated frontend typecheck

**Files:**

- Modify: `scripts/lib.sh:22-27`

`frontend_checks()` runs `pnpm typecheck` (`tsc --noEmit`); `artifact_checks()` then runs `build.sh web` whose `pnpm build` starts with the same `tsc --noEmit`. Every gate that calls `frontend_checks` also calls `artifact_checks` (`ci.sh all`, `ci.sh frontend`, `test.sh quick|frontend|full`), so the typecheck runs twice on every gate path.

- [ ] **Step 1: Remove the duplicate**

Change `frontend_checks()` to:

```bash
# Type checking runs once inside artifact_checks' build (tsc --noEmit &&
# vite build); every gate that runs frontend_checks also runs artifact_checks.
frontend_checks() {
  pnpm lint
  pnpm codegen:check
  pnpm test
}
```

Keep the `typecheck` script in `frontend/package.json` for editor/manual use.

- [ ] **Step 2: Verify**

```bash
./scripts/test.sh frontend
```

Expected: passes; `tsc` output appears once (during the build), not twice.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib.sh
git commit -m "build(ci): drop the duplicated frontend typecheck"
```

---

### Task 7: Make the CI results gate fail closed

**Files:**

- Modify: `scripts/check-ci-results.sh`
- Modify: `.github/workflows/ci.yml` (the `ci-ok` job's env block, lines ~120-128)
- Modify: `scripts/ci-policy.test.sh:19-34`

The job list is hardcoded in three places, and drift fails open: a job added to `needs:` without a matching env var expands to `""`, which matches neither `failure` nor `cancelled`, so the gate passes while no longer gating. This bites exactly when Phases 3-4 add CI jobs.

- [ ] **Step 1: Rewrite the policy test first (red)**

In `ci-policy.test.sh`, replace the `check_ci_results()` helper and its four `expect_status` calls with:

```bash
check_ci_results() {
  env NEEDS_JSON="$1" "$script_dir/check-ci-results.sh"
}

expect_status 0 check_ci_results '{"version":{"result":"success"},"flake":{"result":"success"}}'
expect_status 0 check_ci_results '{"version":{"result":"success"},"flake":{"result":"skipped"}}'
expect_status 1 check_ci_results '{"version":{"result":"success"},"flake":{"result":"failure"}}'
expect_status 1 check_ci_results '{"version":{"result":"cancelled"},"flake":{"result":"success"}}'
expect_status 1 check_ci_results ''
```

The release-tag assertions below them stay unchanged.

- [ ] **Step 2: Run it to verify it fails**

```bash
./scripts/ci-policy.test.sh
```

Expected: FAIL (the old script ignores `NEEDS_JSON` and, given no `*_RESULT` vars, the empty-payload case exits 0 where 1 is expected).

- [ ] **Step 3: Rewrite `check-ci-results.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Fails when any needed job failed or was cancelled. NEEDS_JSON is the
# workflow's `toJSON(needs)`, so newly added needed jobs are covered
# automatically and an empty payload fails closed.
if [ -z "${NEEDS_JSON:-}" ]; then
  echo "NEEDS_JSON is empty; refusing to pass the gate." >&2
  exit 1
fi

if grep -Eq '"result":[[:space:]]*"(failure|cancelled)"' <<<"$NEEDS_JSON"; then
  echo "One or more required CI jobs did not succeed." >&2
  exit 1
fi
```

- [ ] **Step 4: Update the workflow**

In `.github/workflows/ci.yml`, in the `ci-ok` job replace the seven-variable `env:` block on the run step with:

```yaml
- env:
    NEEDS_JSON: ${{ toJSON(needs) }}
  run: ./scripts/check-ci-results.sh
```

The `needs: [version, flake, quality, rust, frontend, e2e, coverage]` list is unchanged and is now the single source of truth.

- [ ] **Step 5: Verify (green)**

```bash
./scripts/ci-policy.test.sh
```

Expected: `CI policy tests passed.` (shellcheck and actionlint run in the final gate, Task 14).

- [ ] **Step 6: Commit**

```bash
git add scripts/check-ci-results.sh scripts/ci-policy.test.sh .github/workflows/ci.yml
git commit -m "build(ci): fail the results gate closed via the needs JSON"
```

---

### Task 8: Define the missing elevation tokens

**Files:**

- Modify: `frontend/src/styles/tokens.css` (after the `--ease-out` line, ~73)
- Modify: `frontend/src/styles/app.css:1321` (`.palette`)

`app.css:233` (`.app-menu`) and `:917` (`.series-inspector`) reference `var(--elev-2)`, which is defined nowhere — both popovers silently render with no shadow. The sanctioned values live in the design handoff (`docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/ds/colors_and_type.css:161-164`). `.palette` is also the only hardcoded color in app.css.

- [ ] **Step 1: Add the two used tokens**

In `tokens.css`, after `--ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);` add (values copied from the handoff; do NOT add the unused `--elev-0`/`--elev-1`):

```css
--elev-2: 0 0 0 1px var(--border-strong), 0 4px 16px rgb(0 0 0 / 50%);
--elev-3: 0 0 0 1px var(--border-strong), 0 8px 32px rgb(0 0 0 / 60%);
```

No light-theme override is needed: the ring color comes from `--border-strong`, which the light block already swaps.

- [ ] **Step 2: Point `.palette` at the token**

In `app.css:1321`, replace `box-shadow: 0 8px 30px rgb(0 0 0 / 35%);` with `box-shadow: var(--elev-3);`.

- [ ] **Step 3: Verify**

```bash
./scripts/test.sh frontend
grep -rn -- "--elev" frontend/src/styles
```

Expected: suite passes; `--elev-2`/`--elev-3` are defined in tokens.css and referenced in app.css, no other `--elev-*` names appear.

- [ ] **Step 4: Commit**

```bash
./scripts/format.sh
git add frontend/src/styles/tokens.css frontend/src/styles/app.css
git commit -m "fix(ui): define the elevation tokens popovers reference"
```

---

### Task 9: Move linked-time state into the session

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Delete: `frontend/src/app/linked-time.ts`, `frontend/src/app/linked-time.test.ts`

**Interfaces:**

- Produces (used by Tasks 10-13 and Phase 3 autosave): `WorkspaceModel.linkedTime(): Readonly<LinkedTime>`, `setLinked(linked: boolean): void`, `setLinkedWindow(t0: number, t1: number): void`, `setCursorT(cursorT: number | null): void`.

`AppShell` holds `LinkedTimeModel` as a separate object that never writes back to `session.linked_time`, so `WorkspaceModel.snapshot()` would always serialize the stale 0-60 default. The model is 51 lines, already typed as the schema's `LinkedTime`, and duplicates the default literal in `emptySession()`. Fold it into `WorkspaceModel`.

- [ ] **Step 1: Write the failing tests**

In `workspace.test.ts`, add (top-level `describe` alongside the existing ones; `WorkspaceModel` is already imported):

```ts
describe("linked time", () => {
  it("serializes linked-time changes into the session", () => {
    const model = new WorkspaceModel();
    model.setLinked(false);
    model.setLinkedWindow(5, 15);
    model.setCursorT(12.5);
    expect(model.snapshot().linked_time).toEqual({
      t0: 5,
      t1: 15,
      linked: false,
      cursorT: 12.5,
      mode: "fixed",
      paused: false,
    });
  });

  it("rejects a non-increasing window", () => {
    const model = new WorkspaceModel();
    expect(() => model.setLinkedWindow(3, 3)).toThrow("finite and increasing");
  });

  it("clears non-finite cursor times", () => {
    const model = new WorkspaceModel();
    model.setCursorT(Number.NaN);
    expect(model.snapshot().linked_time.cursorT).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
./scripts/test.sh frontend
```

Expected: FAIL — `setLinked`/`setLinkedWindow`/`setCursorT` do not exist.

- [ ] **Step 3: Add the methods to `WorkspaceModel`**

In `workspace.ts`, add `LinkedTime` to the type import from `../generated/session`, and add after `setTheme`:

```ts
  linkedTime(): Readonly<LinkedTime> {
    return { ...this.session.linked_time };
  }

  setLinked(linked: boolean): void {
    this.session.linked_time.linked = linked;
  }

  setLinkedWindow(t0: number, t1: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
      throw new Error("Time window must be finite and increasing");
    }
    this.session.linked_time.t0 = t0;
    this.session.linked_time.t1 = t1;
  }

  setCursorT(cursorT: number | null): void {
    this.session.linked_time.cursorT =
      cursorT !== null && Number.isFinite(cursorT) ? cursorT : null;
  }
```

(`emptySession()` already defaults `t1: 60`, matching the old model's default — no behavior change.)

- [ ] **Step 4: Rewire `AppShell`**

In `app-shell.ts`:

- Delete `import { LinkedTimeModel } from "../app/linked-time";` (line 9) and the field `private readonly time = new LinkedTimeModel();` (line 48).
- Replace every `this.time.snapshot()` with `this.workspace.linkedTime()` (lines 860, 989, 1031, 1120, 1288, and 1220's `this.time.snapshot().cursorT` → `this.workspace.linkedTime().cursorT`).
- Line 854: `this.time.setWindow(extent.t0, extent.t1);` → `this.workspace.setLinkedWindow(extent.t0, extent.t1);`
- Lines 1008-1009: `if (this.time.snapshot().linked && panel.mode === "time") { this.time.setWindow(t0, t1);` → `if (this.workspace.linkedTime().linked && panel.mode === "time") { this.workspace.setLinkedWindow(t0, t1);`
- Lines 1119 and 1151: `this.time.setCursor(...)` → `this.workspace.setCursorT(...)`
- Line 1297: `this.time.setLinked(linked);` → `this.workspace.setLinked(linked);`
- Line 858 doc comment: "linked-time model" → "session's linked time".

- [ ] **Step 5: Delete the old module**

First confirm nothing else imports it:

```bash
grep -rn "from \"./linked-time\"\|from \"../app/linked-time\"" frontend/src frontend/tests
```

Expected: no hits outside `app-shell.ts` (already rewired) and `linked-time.test.ts`. Then:

```bash
git rm frontend/src/app/linked-time.ts frontend/src/app/linked-time.test.ts
```

- [ ] **Step 6: Run to verify green**

```bash
./scripts/test.sh frontend
```

- [ ] **Step 7: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/src/ui/app-shell.ts
git commit -m "refactor(app): move linked-time state into the workspace session"
```

---

### Task 10: Session schema v9 — maximized panel and colour-by-time

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Regenerate (via script): `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`
- Modify: `core/scope-core/src/session.rs` (Default impl, new arm 8, test fixtures, one new test)
- Modify: `frontend/src/app/workspace.ts` (`createPanel`, `createWorkspaceTab`), `frontend/src/app/workspace.test.ts` (one fixture), `frontend/tests/e2e/workbench.spec.ts` (one fixture)

**Interfaces:**

- Produces: `WorkspaceTab.maximized_panel_id: string | null` (used by Task 11), `PanelState.color_by_time: boolean` (used by Task 12), migration arm `8` rewriting the `color_signal: "time"` sentinel.

One bump covers both Phase-3 hazards: `maximized` currently lives outside the schema (round-trip silently drops it), and `color_signal` overloads the path namespace with the magic string `"time"` — a derived signal named `time` would collide.

- [ ] **Step 1: Edit the schema**

In `scope-session.json`: set `"schema_version": 9`; in `WorkspaceTab.fields` add `"maximized_panel_id": "string?"` after `"focused_panel_id"`; in `PanelState.fields` add `"color_by_time": "bool"` after `"color_signal"`.

- [ ] **Step 2: Regenerate**

```bash
./scripts/codegen.sh
```

- [ ] **Step 3: Write the failing migration test**

In `session.rs` tests, add:

```rust
    #[test]
    fn v8_time_colour_sentinel_becomes_a_flag() {
        let json = serde_json::json!({
            "app": "signalscope",
            "schema_version": 8,
            "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 60.0, "linked": true,
                            "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1",
            "favorites": [],
            "tabs": [{
                "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                "focused_panel_id": null,
                "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
                "panels": [{
                    "id": "panel-1", "title": "Panel 1", "mode": "xy",
                    "axis_style": "gutter", "x_signal": "demo/x", "color_signal": "time",
                    "series": [], "y_range": null, "x_range": null,
                    "x_label": null, "y_label": null, "c_label": null,
                    "time_window": null, "annotations": [], "show_stats": false
                }]
            }]
        })
        .to_string();
        let session = from_json(&json).expect("v8 session migrates");
        let panel = &session.tabs[0].panels[0];
        assert!(panel.color_by_time);
        assert_eq!(panel.color_signal, None);
        assert_eq!(session.tabs[0].maximized_panel_id, None);
    }
```

- [ ] **Step 4: Run to verify failure**

```bash
./scripts/test.sh core
```

Expected: FAIL — compile errors for the new struct fields plus `UnsupportedVersion(8)`-style failures until the arm and fixtures land.

- [ ] **Step 5: Implement the Rust side**

In `session.rs`:

- `Session::default()`'s `WorkspaceTab` literal: add `maximized_panel_id: None,` after `focused_panel_id: None,`.
- The round-trip test fixture: add `maximized_panel_id: None,` to its `WorkspaceTab` and `color_by_time: false,` to its `PanelState` (after `color_signal: None,`).
- Add the new arm between arm `6` and the `SESSION_SCHEMA_VERSION` arm (the `3 | 4 | 7` arm from Task 5 stays as is — this arm does real work, so it is not folded in):

```rust
        8 => {
            for_each_panel(&mut value, |panel| {
                let by_time = panel.get("color_signal").and_then(serde_json::Value::as_str)
                    == Some("time");
                if by_time {
                    panel.insert("color_signal".into(), serde_json::Value::Null);
                }
                panel.insert("color_by_time".into(), serde_json::json!(by_time));
            });
            value["schema_version"] = serde_json::json!(9);
            migrate(9, value)
        }
```

Note: the existing `v7_panels_gain_a_default_color_axis_label` fixture uses `color_signal: "time"` and now also flows through this arm; it must still pass unchanged.

- [ ] **Step 6: Run core tests to verify green**

```bash
./scripts/test.sh core
```

- [ ] **Step 7: Fix the TypeScript compile surface**

The regenerated `PanelState`/`WorkspaceTab` interfaces gained required fields; update every literal the typechecker flags:

- `workspace.ts` `createPanel()`: add `color_by_time: false,` after `color_signal: null,`.
- `workspace.ts` `createWorkspaceTab()`: add `maximized_panel_id: null,` after `focused_panel_id: null,`.
- `workspace.test.ts` (the `tab.panels.push({...})` fixture in "never reuses an id already present in a loaded session"): add `color_by_time: false,` after `color_signal: null,`.
- `frontend/tests/e2e/workbench.spec.ts` (the `view.update({...})` PanelState fixture, ~line 190): add `color_by_time: false,` after `color_signal: null,`.

- [ ] **Step 8: Run the frontend suite**

```bash
./scripts/test.sh frontend
```

Expected: PASS, including `pnpm codegen:check` (generated outputs committed and in sync).

- [ ] **Step 9: Commit**

```bash
./scripts/format.sh
git add protocol/schema/scope-session.json core/scope-core/src/session/generated.rs frontend/src/generated/session.ts core/scope-core/src/session.rs frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/tests/e2e/workbench.spec.ts
git commit -m "feat(session): persist maximized panel and colour-by-time in schema v9"
```

---

### Task 11: Store the maximized panel in the session tab

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Consumes: `WorkspaceTab.maximized_panel_id` from Task 10.
- Produces: `maximizedPanelId()` unchanged in signature (`string | null`) — `workspace-view.ts` and `app-shell.ts` callers need no edits.

Behavior stays exactly as today: any tab switch or layout change restores the grid. The only difference is that the value now round-trips through `snapshot()`.

- [ ] **Step 1: Write the failing test**

In `workspace.test.ts`:

```ts
it("keeps the maximized panel in the session snapshot", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  model.toggleMaximize(panel.id);
  expect(model.snapshot().tabs[0]?.maximized_panel_id).toBe(panel.id);
  model.toggleMaximize(panel.id);
  expect(model.snapshot().tabs[0]?.maximized_panel_id).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh frontend` → the new test fails (`maximized_panel_id` stays `null`).

- [ ] **Step 3: Port the field**

In `workspace.ts`:

- Delete `private maximized: string | null = null;` (line 35).
- `maximizedPanelId()`: `return this.activeTab().maximized_panel_id;`
- `addTab()`: delete the `this.maximized = null;` line (a fresh tab starts with `maximized_panel_id: null`).
- `selectTab()`: replace `this.maximized = null;` with `this.activeTab().maximized_panel_id = null;` (after `active_tab_id` is assigned — preserves un-maximize-on-switch).
- `closeTab()`: replace `this.maximized = null;` with `this.activeTab().maximized_panel_id = null;` (after the replacement tab is chosen).
- `closePanel()`: replace `if (this.maximized === id) this.maximized = null;` with `if (tab.maximized_panel_id === id) tab.maximized_panel_id = null;` (the local `tab` already exists).
- `toggleMaximize()`: `if (this.activeTab().maximized_panel_id === id) { this.activeTab().maximized_panel_id = null; } else { this.maximizePanel(id); }`
- `maximizePanel()`: replace `this.maximized = id;` with `this.activeTab().maximized_panel_id = id;`
- `restoreGrid()`: `this.activeTab().maximized_panel_id = null;`
- `addPanelRow()`, `splitPanelRight()`, `splitPanelDown()`, `movePanel()`: replace each `this.maximized = null;` with `this.activeTab().maximized_panel_id = null;`

- [ ] **Step 4: Run to verify green** — `./scripts/test.sh frontend` (existing maximize/close/split tests must also pass).

- [ ] **Step 5: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts
git commit -m "refactor(app): store the maximized panel in the session tab"
```

---

### Task 12: Replace the colour-channel "time" sentinel

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/ui/app-shell.ts:715-720`
- Modify: `frontend/src/ui/panel.ts` (c-chip block ~385-399; `renderXy` ~556-561, ~597-602, ~646-658)

**Interfaces:**

- Consumes: `PanelState.color_by_time` from Task 10.
- Produces: `WorkspaceModel.setColorByTime(id: string): void`; `setColorSignal(id, path | null)` now also resets the flag. After this task, `color_signal` only ever holds a real signal path or null.

The magic string survives `panelSignalIds` today only because `signalsByPath.get("time")` happens to fail. The e2e palette flow ("Panel: set color signal (c:)… time") keeps its title, so `modes.spec.ts` is unaffected.

- [ ] **Step 1: Write the failing model test**

In `workspace.test.ts`:

```ts
it("colour-by-time replaces the colour signal", () => {
  const model = new WorkspaceModel();
  const panel = model.addPanelRow();
  model.setColorSignal(panel.id, "demo/speed");
  model.setColorByTime(panel.id);
  expect(model.panel(panel.id)?.color_by_time).toBe(true);
  expect(model.panel(panel.id)?.color_signal).toBeNull();
  model.setColorSignal(panel.id, null);
  expect(model.panel(panel.id)?.color_by_time).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `./scripts/test.sh frontend` → `setColorByTime` does not exist.

- [ ] **Step 3: Implement the model methods**

In `workspace.ts` replace `setColorSignal` with:

```ts
  setColorSignal(id: string, path: string | null): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.color_signal = path;
    panel.color_by_time = false;
  }

  setColorByTime(id: string): void {
    const panel = this.panel(id);
    if (panel === undefined) return;
    panel.color_signal = null;
    panel.color_by_time = true;
  }
```

- [ ] **Step 4: Rewire the palette entry**

In `app-shell.ts:718`, the "… time" entry's `run`: replace `this.workspace.setColorSignal(focused, "time");` with `this.workspace.setColorByTime(focused);`.

- [ ] **Step 5: Rewire `panel.ts`**

- c-chip text and title (~385-399):

```ts
cChip.replaceChildren(
  chipPrefix("c:"),
  document.createTextNode(
    state.color_by_time
      ? "time"
      : state.color_signal === null
        ? "none"
        : signalLabel(state.color_signal),
  ),
);
cChip.title = state.color_by_time
  ? "Colour channel: time — click to clear"
  : state.color_signal === null
    ? `Drop a signal here to assign colour, or use ${formatCombo("mod+shift+p")} → set color signal`
    : `Colour channel: ${state.color_signal} — click to clear`;
```

- `renderXy` colour source (~556-561):

```ts
const colorSeries: "time" | SampleResponse["series"][number] | null =
  state.color_by_time
    ? "time"
    : state.color_signal === null
      ? null
      : (byPath.get(state.color_signal) ?? null);
```

- `prepareXyPlot` colour input (~597-602):

```ts
      color:
        colorSeries === null
          ? null
          : { path: state.color_by_time ? "time" : (state.color_signal ?? "") },
```

- colorbar label (~646-658): replace the `state.color_signal === "time"` branch with the already-narrowed `colorSeries`:

```ts
              label:
                state.c_label ??
                (colorSeries === "time"
                  ? "t (s)"
                  : axisName(state.color_signal ?? "", colorSeries.unit)),
```

(Note this code is inside the `hasColor` spread, where `colorSeries` is non-null. The c-chip clear path — `onSetColorSignal(id, null)` at `panel.ts:286` → `setColorSignal` — now also resets the flag; no edit needed there.)

- [ ] **Step 6: Sweep for leftovers**

```bash
grep -rn '"time"' frontend/src/ui/panel.ts frontend/src/ui/app-shell.ts frontend/src/app/workspace.ts | grep -v 'mode\|panel-switch\|t (s)'
```

Expected: no remaining comparisons of `color_signal` against `"time"`.

- [ ] **Step 7: Run to verify green, including e2e**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
```

Expected: all pass (modes.spec.ts exercises "set color signal … time" and "clear color signal" through the palette).

- [ ] **Step 8: Commit**

```bash
./scripts/format.sh
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/src/ui/app-shell.ts frontend/src/ui/panel.ts
git commit -m "refactor(ui): replace the colour-channel time sentinel with a flag"
```

---

### Task 13: Surface unresolved panel signals instead of dropping them

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`panelSignalIds`, `refreshTiles`, `renderTiles`, new field)
- Modify: `frontend/src/ui/workspace-view.ts` (`renderData`)
- Modify: `frontend/src/ui/panel.ts` (`renderData`)

**Interfaces:**

- Consumes: the existing `.panel-empty` element and `setModeEmpty` in `PanelView`.
- Produces: `panelSignalIds(panel): { ids: string[]; missing: string[] }`; `WorkspaceView.renderData(tiles, samples, windowFor, missingFor)`; `PanelView.renderData(state, tiles, samples, window, missing = [])`.

Today `panelSignalIds` silently drops any path `listSignals()` cannot resolve — a Phase 3 derived signal not yet registered would vanish from its panel with the legend still listing it and nothing saying why. Uses `textContent` via `setModeEmpty`, so untrusted signal names stay escaped.

- [ ] **Step 1: Split resolution from dropping**

Replace `panelSignalIds` in `app-shell.ts` (keep its doc comment):

```ts
  private panelSignalIds(panel: PanelState): {
    ids: string[];
    missing: string[];
  } {
    const paths = panel.series.map((series) => series.path);
    if (panel.mode === "xy") {
      if (panel.x_signal !== null) paths.unshift(panel.x_signal);
      if (panel.color_signal !== null) paths.push(panel.color_signal);
    }
    const ids: string[] = [];
    const missing: string[] = [];
    for (const path of new Set(paths)) {
      const id = this.signalsByPath.get(path)?.signal_id;
      if (id === undefined) missing.push(path);
      else ids.push(id);
    }
    return { ids, missing };
  }
```

- [ ] **Step 2: Track missing paths per panel**

In `AppShell` add the field `private missingByPanel = new Map<string, string[]>();` next to `samplesByPanel`. In `refreshTiles`, add `const nextMissing = new Map<string, string[]>();` beside `nextTiles`/`nextSamples`; change the loop head to:

```ts
const { ids, missing } = this.panelSignalIds(panel);
nextMissing.set(panel.id, missing);
if (ids.length === 0) return;
```

(and use `ids` where `ids` was used before). After the `refreshToken` check, add `this.missingByPanel = nextMissing;` beside the other two assignments.

- [ ] **Step 3: Thread it to the panels**

- `app-shell.ts` `renderTiles`: pass a fourth argument to `renderData`: `(panelId) => this.missingByPanel.get(panelId) ?? []`.
- `workspace-view.ts` `renderData`: add the parameter `missingFor: (panelId: string) => readonly string[]` and pass `missingFor(panel.id)` as the fifth argument to `view.renderData(...)`.
- `panel.ts` `renderData`: add the parameter `missing: readonly string[] = []` and, after `this.drawOverlay(annotations);`, add:

```ts
if (missing.length > 0) {
  this.setModeEmpty(true, `unknown signals: ${missing.join(", ")}`);
}
```

- [ ] **Step 4: Run to verify**

```bash
./scripts/test.sh frontend
./scripts/test.sh e2e
```

Expected: all pass (no existing flow produces missing paths, so no visual change yet — this is Phase 3 diagnostics infrastructure).

- [ ] **Step 5: Commit**

```bash
./scripts/format.sh
git add frontend/src/ui/app-shell.ts frontend/src/ui/workspace-view.ts frontend/src/ui/panel.ts
git commit -m "feat(ui): surface unresolved panel signals instead of dropping them"
```

---

### Task 14: Full gate and version bump

- [ ] **Step 1: Format and run the complete local gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: every stage passes (format, quality incl. shellcheck/actionlint/ci-policy, rust, frontend, e2e, build/artifacts). Commit any formatter output that belongs to this branch's files.

- [ ] **Step 2: Bump the version**

`minor`: schema v9 adds backward-compatible session capabilities (maximized panel, colour-by-time) with a migration; nothing breaks compatibility.

```bash
./scripts/version.sh bump minor
./scripts/version.sh check
```

- [ ] **Step 3: Commit the bump (final change on the branch)**

```bash
git add -u
git commit -m "chore(release): bump minor for session schema v9"
```

Stage only the manifest files the bump touched — review `git status` first.

---

## Explicitly deferred (do not do in this branch)

- Mode-table consolidation into `POLICIES` (`source`, axis-label defaults, the missing `panel-switch-time` command) — behavioral, e2e-only coverage; schedule as its own branch.
- Determinism seams for Phase 4 (`performance.now()` in render signatures, `devicePixelRatio` injection, `crypto.randomUUID()` annotation ids) — do immediately before the first screenshot-matrix work.
- Moving `DataState` + `query_tiles`/`query_samples` from the Tauri shell into `scope-core` — do at the start of Phase 4 export work.
- Theme single-sourcing (dropping the localStorage key) — belongs with Phase 3 autosave; today localStorage is the only cross-launch theme persistence.
- `plot-gestures.ts` over-general `pan`/`zoom`/`fit` policy options; the `afterPanelStateChange`/`afterDataShapeChange` refresh-ladder collapse; e2e fixture consolidation; the `docs/superpowers/plans` index status column.
