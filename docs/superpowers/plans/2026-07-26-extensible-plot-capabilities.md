# Extensible Plot Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cursors, retained domain-aware annotations, deltas, and native statistics work across time, XY, FFT, and histogram panels through one exhaustive prepared-plot capability interface.

**Architecture:** Each render path prepares a pure `PreparedPlot` from the exact bounded data it draws. `PanelView` delegates cursor hit-testing, annotation pin/resolve, delta descriptions, statistics, and interaction policy to that object; the shell and overlay render generic results without mode branches. Session schema v6 gives annotations an explicit domain and generic anchor, migrating v5 timestamp annotations losslessly.

**Tech Stack:** TypeScript (strict, Canvas 2D, Vitest, Playwright), JSON schema code generation, Rust/Serde session migrations.

## Global Constraints

- Use repository scripts for setup, formatting, tests, builds, and code generation.
- Do not add runtime dependencies.
- Keep `protocol/schema/scope-session.json` authoritative; never hand-edit generated Rust or TypeScript.
- Preserve the one-presentation-plane invariant and avoid host-identity branches.
- Keep transformed inspection bounded by existing tile/sample query caps.
- Preserve unrelated screenshots and audit files as unstaged user work.
- Use TDD: add each behavior test and observe its expected failure before production changes.

---

### Task 1: Session v6 domain-aware annotations

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Regenerate: `core/scope-core/src/session/generated.rs`
- Regenerate: `frontend/src/generated/session.ts`
- Modify: `core/scope-core/src/session.rs`
- Modify: `frontend/src/app/workspace.test.ts`
- Modify: existing TypeScript fixtures containing annotations

**Interfaces:**

- Produces `AnnotationDomain = "time" | "frequency" | "distribution"`.
- Produces `Annotation { id, series_path, domain, anchor, pinned_value, label }`.
- Migrates v5 `{time,value}` to v6 `{domain:"time",anchor:time,pinned_value:value}`.

- [ ] **Step 1: Write the failing migration and workspace tests**

Add a Rust test that deserializes a v5 session containing one annotation and
asserts the literal v6 fields. Update the workspace behavior test to add one
time annotation and one frequency annotation, switch modes, and assert both
remain in the panel array.

- [ ] **Step 2: Run the narrow tests and verify RED**

Run `./scripts/test.sh core` and `./scripts/test.sh frontend`. Expected:
compilation/test failure because `AnnotationDomain`, `domain`, `anchor`, and
`pinned_value` do not exist.

- [ ] **Step 3: Bump and regenerate the schema**

Set schema version to 6, define `AnnotationDomain`, replace `time/value` with
`domain/anchor/pinned_value`, and run the repository code-generation path via
`./scripts/test.sh frontend`.

- [ ] **Step 4: Implement migration and update constructors**

Add migration arm 5 that rewrites every annotation in every panel before
recursing to version 6. Update real constructors and fixtures to use the new
fields; do not add compatibility aliases in production TypeScript.

- [ ] **Step 5: Verify GREEN**

Run `./scripts/test.sh core` and `./scripts/test.sh frontend`. Expected: all
session, workspace, generated-output, and frontend tests pass.

- [ ] **Step 6: Commit**

Stage only schema, generated outputs, migration, and directly affected tests.
Commit `feat(session): persist annotation domains`.

---

### Task 2: Pure prepared-plot capability contract

**Files:**

- Create: `frontend/src/app/plot-capabilities.ts`
- Create: `frontend/src/app/plot-capabilities.test.ts`
- Modify: `frontend/src/app/panel-mode.ts`

**Interfaces:**

- Produces `PlotInteractionPolicy`.
- Produces `PlotCursor`, `AnnotationAnchor`, `ResolvedAnnotation`,
  `PlotStatGroup`, `PlotDelta`, and `PreparedPlot`.
- Produces exhaustive factories for time, XY, FFT, and histogram data.

The central contract is:

```ts
export interface PreparedPlot {
  readonly mode: PanelMode;
  readonly domain: AnnotationDomain;
  readonly frame: PlotFrame;
  readonly interaction: PlotInteractionPolicy;
  cursorAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): PlotCursor | null;
  annotationAt(
    layout: PlotLayout,
    point: PlotPoint,
    radius: number,
  ): AnnotationAnchor | null;
  resolveAnnotation(annotation: Annotation): ResolvedAnnotation | null;
  stats(): readonly PlotStatGroup[];
  delta(resolved: readonly ResolvedAnnotation[]): PlotDelta | null;
}
```

- [ ] **Step 1: Write failing table-driven capability tests**

Use literal time bins, XY samples, FFT arrays, and histogram bins. Assert:

- time cursor/annotation domain is `time` and policy links time;
- XY pins timestamp anchors but resolves plot-space X/Y;
- FFT pins frequency and resolves current dB after its spectrum changes;
- histogram pins source value and resolves the current containing bin;
- unresolved annotations return `null` without mutation;
- each mode returns the approved native stats labels and literal values;
- each mode returns the approved delta labels;
- all policies state x-axis, cursor-link, pan/zoom, fit, and window-note behavior.

- [ ] **Step 2: Run the test and verify RED**

Run `./scripts/test.sh frontend`. Expected: module/type import failure because
the prepared capability contract does not exist.

- [ ] **Step 3: Implement numeric and hit-testing primitives**

Implement finite-value summaries, nearest transformed-series point lookup,
bin lookup, reading construction, annotation domain filtering, and delta
formatting as pure functions. Expected values must be derived from input
arrays, never DOM or canvas state.

- [ ] **Step 4: Implement all four prepared plot factories**

Each factory closes over the exact bounded arrays supplied by its render path.
The `Record<PanelMode, ...>` registry must be exhaustive. Remove annotation
and stats booleans from `MODE_TRAITS`; retain only compatibility re-exports
needed until Task 3 completes.

- [ ] **Step 5: Verify GREEN**

Run `./scripts/test.sh frontend`. Expected: all capability and existing
frontend tests pass.

- [ ] **Step 6: Commit**

Commit `feat(plots): add prepared capability adapters`.

---

### Task 3: Delegate panel inspection and statistics

**Files:**

- Modify: `frontend/src/ui/panel.ts`
- Modify: `frontend/src/ui/workspace-view.ts`
- Modify: `frontend/src/ui/app-shell.ts`
- Modify: `frontend/src/render/overlay-renderer.ts`
- Modify: `frontend/src/render/overlay-renderer.test.ts`
- Modify: `frontend/tests/e2e/modes.spec.ts`

**Interfaces:**

- Consumes `PreparedPlot` and its generic output types.
- `PanelView` retains `preparedPlot: PreparedPlot | null`.
- `PanelCallbacks.onPinAnnotation` consumes `AnnotationAnchor`.
- `OverlayState` consumes resolved annotations and an optional resolved delta,
  not raw domain-specific session coordinates.

- [ ] **Step 1: Write failing overlay and Playwright behavior tests**

Assert that the overlay draws two supplied resolved plot-space annotations,
uses their generic labels, connects their coordinates, and draws a supplied
domain-native delta label without reading `time` or `value` from the session
annotation.

Add desktop Playwright tests that pin FFT/histogram annotations, retain them
across mode switches, show domain-native deltas, and expose each mode's native
stats labels.

- [ ] **Step 2: Run frontend and e2e tests and verify RED**

Run `./scripts/test.sh frontend` and `./scripts/test.sh e2e`. Expected:
`OverlayState` lacks resolved annotation/delta inputs and the new derived-mode
interaction assertions fail.

- [ ] **Step 3: Make the overlay domain-agnostic**

Replace raw annotation coordinate inference with resolved points, labels,
colors, and `PlotDelta`. Keep marker numbering, amber delta styling, and
clipping behavior unchanged.

- [ ] **Step 4: Prepare capabilities in every panel render path**

After time, XY, FFT, or histogram data is prepared, construct the matching
`PreparedPlot`. Replace `PanelView` branches for cursor hits, pin/remove,
annotation resolution, stats, delta, global cursor behavior, and interaction
policy with calls to that object.

- [ ] **Step 5: Make shell/chrome output generic**

Move `PanelCursor` out of `panel.ts`. Render cursor headers/rows and statistics
groups from generic readings. Build persisted annotations from
`AnnotationAnchor`. Filter annotation list rows by the prepared plot domain,
show resolved values when available, and show `unavailable` otherwise.

- [ ] **Step 6: Remove obsolete branches**

Delete `annotations`/`stats` mode gates, `annotationSpace`, time-only overlay
delta inference, duplicate FFT/histogram cursor caches, and mode-specific
statistics rendering that the prepared plot replaces.

- [ ] **Step 7: Verify GREEN**

Run `./scripts/test.sh frontend`. Expected: 0 lint/type/unit/build failures.

- [ ] **Step 8: Commit**

Commit `refactor(plots): delegate standard capabilities`.

---

### Task 4: Complete end-to-end capability coverage

**Files:**

- Modify: `frontend/tests/e2e/modes.spec.ts`
- Modify: `frontend/tests/e2e/interactions.spec.ts` if shared helpers belong there

**Interfaces:**

- Exercises the real presentation plane and demo data.

- [ ] **Step 1: Extend Playwright coverage with remaining failing cases**

Retain Task 3's pin/retain/delta/stats coverage and add cases that:

- change the linked visible time window and verify derived annotations
  re-resolve rather than disappear from session state;
- verify time/XY cursors link and FFT/histogram cursors stay local;
- edit and remove derived annotations through the real annotation list;
- click away and assert tooltips close.

- [ ] **Step 2: Run e2e and verify RED**

Run `./scripts/test.sh e2e`. Expected: at least the newly added re-resolution
or annotation-list integration assertion fails for its missing connection.

- [ ] **Step 3: Fix only integration gaps exposed by Playwright**

Adjust event radii, list copy, toolbar state, and rerender scheduling without
adding new product behavior.

- [ ] **Step 4: Verify GREEN**

Run `./scripts/test.sh e2e`. Expected: all desktop tests pass and configured
mobile-review skips remain intentional.

- [ ] **Step 5: Commit**

Commit `test(plots): cover native capabilities across modes`.

---

### Task 5: Architecture documentation and full verification

**Files:**

- Modify: `docs/adr/0005-session-schema-versioning.md`
- Modify: `docs/adr/0017-spectrum-semantics.md`
- Modify: `docs/adr/0018-histogram-semantics.md`
- Modify: `docs/adr/README.md` only if its summary requires a schema-version note

**Interfaces:**

- Documents schema v6, retained annotation domains, prepared capability
  adapters, and domain-native stats.

- [ ] **Step 1: Amend the accepted ADRs**

Document the v5-to-v6 mapping, dynamic resolution behavior, unavailable
annotation behavior, FFT/histogram delta semantics, and stats definitions.

- [ ] **Step 2: Run formatting**

Run `./scripts/ci.sh format`. If it reports files changed, inspect them and
rerun until it exits 0.

- [ ] **Step 3: Run the full quality gate**

Run `./scripts/ci.sh all`. Expected: Rust checks/tests, TypeScript
lint/typecheck/unit tests, generated diff, web/snapshot build, artifact checks,
and Playwright all exit 0.

- [ ] **Step 4: Review staging**

Run `git diff --check`, inspect staged and unstaged diffs separately, and
confirm screenshots/audit HTML remain unstaged.

- [ ] **Step 5: Commit**

Commit remaining documentation or integration changes with
`docs(plots): record domain-native capabilities`.
