# Phase 1 — Workbench UI Fundamentals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The workbench half of Phase 1 (`docs/implementation-roadmap.md`): panel lifecycle (create/close/split/maximize/focus), seam resizing, drag rearrangement, drag-signal-to-plot, a virtualized search-first signal tree with favorites, and keyboard-equivalent commands behind a ⌘K palette.

**Architecture:** Workspace state lives in one `WorkspaceModel` that mutates a generated `Session` object (panels + a new `layout` of fractional rows/cells + `favorites`) — Phase 3 session persistence then serializes what already exists. Session schema bumps to v2 with the migration ladder's first real rung. Views are thin DOM components (`PanelView`, `WorkspaceView`, `SignalTreeView`, `CommandPalette`) driven by an orchestrating `AppShell`; every pointer action routes through a `CommandRegistry` that also feeds the keyboard map and palette, keeping the "keyboard path for every pointer action" invariant checkable. Pure logic (layout math, tree building, virtualization, fuzzy match, key dispatch) is extracted into `app/` modules and unit-tested; DOM code is covered by Playwright.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess` — never use `!` assertions, check indexes explicitly), zero runtime deps, Vitest, Playwright (desktop + mobile-review projects), CSS design tokens (`frontend/src/styles/tokens.css`), HTML5 drag-and-drop, pointer events for seams.

## Global Constraints

- Use `./scripts/` wrappers for everything (`./scripts/test.sh frontend`, `./scripts/ci.sh all`, `./scripts/dev.sh pnpm codegen`, …).
- Design authority: `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/` — Final Spec F2 controls chrome; `README.md` there summarizes the rules. Non-negotiables applied here: chrome is fully achromatic (active states = `--surface-4` + `--fg-1`); **amber is interaction-only** (focus inset, drop targets — never chrome state, never the favorites star); every number/path in JetBrains Mono with `tabular-nums`; light theme stays a pure token swap (touch only `var(--…)` tokens, no per-component light styles); no naked plots.
- Binding invariants (AGENTS.md / ADRs): two-host `DataPlane` — never branch on host identity (capability ports only); versioned session schema changes go through `protocol/schema/scope-session.json` + codegen + a migration rung (ADR 0005); generated files are never hand-edited.
- ESLint/tsc are strict; the mobile breakpoint (`max-width: 820px`) hides the signal tree — e2e tree/drag tests must skip the `mobile-review` project.
- Commit messages: lowercase imperative, no prefix. Stage only the files each task names.

## Decisions embedded in this plan (flagged for maintainer review)

1. **`layout` and `favorites` enter the session schema now (v2)** even though autosave is Phase 3 — the workspace model mutates a `Session` directly, so Phase 3 serialization becomes trivial, and the ADR 0005 migration ladder gets its first real rung while stakes are low.
2. **Drag-signal-to-plot and drop-creates-panel are included** (they are how panels get content); _plot-canvas_ gestures (zoom/pan/cursor/datatips) remain Phase 2 per the roadmap.
3. **Tree live values stay `—`** until the synced cursor lands (Phase 2); the value column and its layout are in place.
4. **Legend chip click toggles series visibility**; series _removal_ arrives with the legend inspector (Phase 2). Panel titles are not yet editable (Phase 2 "editable labels").
5. **The dead "Demo Data" toolbar button is removed** — demo data loads automatically on the baked plane; a real demo story for the native shell is future work.
6. **Favorites star active color is `--fg-1`** (achromatic), not amber — amber is reserved for interaction per the design system.
7. Default boot: if the plane reports signals and the session has no panels, one panel is created plotting the first two signals (keeps the walking-skeleton demo and e2e meaningful); with no signals the workspace shows the spec's F6·1 empty state.
8. **`S` (stats) is not bound yet** — the stats strip is Phase 2; binding a key to nothing would break the "keyboard path" invariant's honesty.

## Sequencing

1 → 2 → 5 → 6 → 7 strictly; 3 and 4 are pure-logic tasks that can run any time after 1 (5 consumes them). Task 6 consumes the `IngestPort` interface from the data-plane plan (`2026-07-24-07`, Task 7); everything else is independent of that plan. If this plan lands first, Task 6's `plane.ingest` references will not compile — land plans in either order but rebase Task 6 after data-plane Task 7.

---

### Task 1: Session schema v2 — layout and favorites, with the first migration rung

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Modify: `core/scope-core/src/session.rs`
- Generated (via codegen): `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`

**Interfaces:**

- Produces: `SESSION_SCHEMA_VERSION = 2`; `LayoutCell { panel_id: string, width: f64 }`, `LayoutRow { height: f64, panels: LayoutCell[] }`; `Session` gains `layout: LayoutRow[]` and `favorites: string[]`. Fractions are 0..1 shares of the workspace (row heights sum to 1; cell widths sum to 1 per row). Rust `migrate` gains the 1→2 rung: v1 sessions get a single equal-width row of their panels and empty favorites.

- [ ] **Step 1: Replace `protocol/schema/scope-session.json` with:**

```json
{
  "schema_version": 2,
  "types": {
    "Theme": {
      "kind": "enum",
      "variants": ["dark", "light"],
      "default": "dark"
    },
    "TimeMode": {
      "kind": "enum",
      "variants": ["fixed", "follow"],
      "default": "fixed"
    },
    "PanelMode": {
      "kind": "enum",
      "variants": ["time", "xy", "fft", "histogram"]
    },
    "AxisStyle": { "kind": "enum", "variants": ["gutter", "inline"] },
    "DashStyle": { "kind": "enum", "variants": ["solid", "dash", "dot"] },
    "LinkedTime": {
      "kind": "object",
      "fields": {
        "t0": "f64",
        "t1": "f64",
        "linked": "bool",
        "paused": "bool",
        "cursorT": "f64?",
        "mode": "TimeMode"
      }
    },
    "SeriesState": {
      "kind": "object",
      "fields": {
        "path": "string",
        "color_slot": "u8",
        "dash": "DashStyle",
        "width": "f32",
        "visible": "bool"
      }
    },
    "Annotation": {
      "kind": "object",
      "fields": {
        "id": "string",
        "series_path": "string",
        "time": "f64",
        "value": "f64",
        "label": "string"
      }
    },
    "PanelState": {
      "kind": "object",
      "fields": {
        "id": "string",
        "title": "string",
        "mode": "PanelMode",
        "axis_style": "AxisStyle",
        "x_signal": "string?",
        "color_signal": "string?",
        "series": "SeriesState[]",
        "y_range": "f64[2]?",
        "annotations": "Annotation[]",
        "show_stats": "bool"
      }
    },
    "LayoutCell": {
      "kind": "object",
      "fields": {
        "panel_id": "string",
        "width": "f64"
      }
    },
    "LayoutRow": {
      "kind": "object",
      "fields": {
        "height": "f64",
        "panels": "LayoutCell[]"
      }
    },
    "Session": {
      "kind": "object",
      "fields": {
        "app": "string",
        "schema_version": "u32",
        "theme": "Theme",
        "linked_time": "LinkedTime",
        "focused_panel_id": "string?",
        "panels": "PanelState[]",
        "layout": "LayoutRow[]",
        "favorites": "string[]"
      }
    }
  }
}
```

- [ ] **Step 2: Regenerate**

Run: `./scripts/dev.sh pnpm codegen`
Expected: both generated session files gain `LayoutCell`/`LayoutRow`, the new `Session` fields, and version 2.

- [ ] **Step 3: Update `core/scope-core/src/session.rs`**

Add the new fields to `Session::default()`:

```rust
            focused_panel_id: None,
            panels: Vec::new(),
            layout: Vec::new(),
            favorites: Vec::new(),
```

Replace the `migrate` function with:

```rust
/// Migration ladder (ADR 0005): each arm upgrades `value` one schema
/// version and falls through to the next; the current version deserializes
/// directly. To add v(N+1): bump `schema_version` in
/// `protocol/schema/scope-session.json`, regenerate, then add an arm here
/// that rewrites a vN `value` into vN+1 shape and recurses.
fn migrate(version: u32, mut value: serde_json::Value) -> Result<Session, SessionError> {
    match version {
        1 => {
            let panel_ids: Vec<String> = value
                .get("panels")
                .and_then(serde_json::Value::as_array)
                .map(|panels| {
                    panels
                        .iter()
                        .filter_map(|panel| {
                            panel
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned)
                        })
                        .collect()
                })
                .unwrap_or_default();
            #[allow(clippy::cast_precision_loss)]
            let width = 1.0 / panel_ids.len().max(1) as f64;
            let layout = if panel_ids.is_empty() {
                serde_json::json!([])
            } else {
                let cells: Vec<serde_json::Value> = panel_ids
                    .iter()
                    .map(|id| serde_json::json!({ "panel_id": id, "width": width }))
                    .collect();
                serde_json::json!([{ "height": 1.0, "panels": cells }])
            };
            value["layout"] = layout;
            value["favorites"] = serde_json::json!([]);
            value["schema_version"] = serde_json::json!(2);
            migrate(2, value)
        }
        SESSION_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(SessionError::UnsupportedVersion(version)),
    }
}
```

- [ ] **Step 4: Add the migration test** to the `session.rs` tests module:

```rust
    #[test]
    fn v1_sessions_migrate_to_v2() {
        let json = r#"{
            "app": "signalscope",
            "schema_version": 1,
            "theme": "dark",
            "linked_time": {"t0":0.0,"t1":1.0,"linked":true,"paused":false,"cursorT":null,"mode":"fixed"},
            "focused_panel_id": "panel-a",
            "panels": [{"id":"panel-a","title":"A","mode":"time","axis_style":"gutter","x_signal":null,"color_signal":null,"series":[],"y_range":null,"annotations":[],"show_stats":false}]
        }"#;
        let session = from_json(json).unwrap();
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.layout.len(), 1);
        assert_eq!(session.layout[0].panels[0].panel_id, "panel-a");
        assert!((session.layout[0].panels[0].width - 1.0).abs() < f64::EPSILON);
        assert!(session.favorites.is_empty());
    }
```

- [ ] **Step 5: Verify, then commit**

First stage the schema and regenerated files — `codegen:check` diffs the worktree against the git index, so unstaged generated changes read as failures:

```bash
git add protocol/schema/scope-session.json core/scope-core/src/session/generated.rs frontend/src/generated/session.ts
```

Run: `./scripts/test.sh quick` — Expected: PASS (round-trip test still passes because it spreads `..Session::default()`; the new migration test passes; frontend codegen check is clean).

```bash
git add protocol/schema/scope-session.json core/scope-core/src/session.rs core/scope-core/src/session/generated.rs frontend/src/generated/session.ts
git commit -m "version the session schema with layout and favorites"
```

---

### Task 2: WorkspaceModel — panels, layout math, favorites

**Files:**

- Create: `frontend/src/app/workspace.ts`
- Test: `frontend/src/app/workspace.test.ts`
- Modify: `frontend/src/app/linked-time.ts`
- Test: `frontend/src/app/linked-time.test.ts` (one added test)

**Interfaces:**

- Produces (consumed by Tasks 5–6):

```ts
emptySession(): Session
class WorkspaceModel {
  constructor(session?: Session)
  snapshot(): Readonly<Session>
  panels(): readonly PanelState[]
  layout(): readonly LayoutRow[]
  favorites(): readonly string[]
  focusedPanelId(): string | null
  maximizedPanelId(): string | null          // runtime-only, not serialized
  panel(id: string): PanelState | undefined
  locate(id: string): { rowIndex: number; cellIndex: number } | null
  addPanelRow(): PanelState                  // new full-width bottom row
  splitPanel(id: string): PanelState | null  // ⊞ — new panel right of target
  closePanel(id: string): void
  focusPanel(id: string): void
  toggleMaximize(id: string): void
  setMode(id: string, mode: PanelMode): void
  addSeries(panelId: string, path: string): boolean  // false on duplicate/unknown panel
  toggleSeriesVisible(panelId: string, path: string): void
  resizeRows(seamIndex: number, delta: number): void          // delta = fraction of workspace height
  resizeColumns(rowIndex: number, seamIndex: number, delta: number): void
  movePanel(id: string, targetRowIndex: number, targetCellIndex: number): void
  toggleFavorite(path: string): void
}
```

Invariants: row heights sum to 1, cell widths sum to 1 per row, every fraction ≥ 0.1 after seam resizes; `color_slot` = lowest unused slot 1–8 per panel.

- [ ] **Step 1: Write the failing tests** — `frontend/src/app/workspace.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { WorkspaceModel, emptySession } from "./workspace";

function heights(model: WorkspaceModel): number[] {
  return model.layout().map((row) => row.height);
}

function widths(model: WorkspaceModel, rowIndex: number): number[] {
  return model.layout()[rowIndex]?.panels.map((cell) => cell.width) ?? [];
}

describe("WorkspaceModel", () => {
  it("adds panel rows with rebalanced heights", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    expect(model.panels().map((panel) => panel.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(heights(model)).toEqual([0.5, 0.5]);
    expect(model.focusedPanelId()).toBe(second.id);
  });

  it("splits a panel into equal halves of its cell", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.splitPanel(first.id);
    expect(widths(model, 0)).toEqual([0.5, 0.5]);
  });

  it("closing the last panel of a row removes the row and renormalizes", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    model.closePanel(second.id);
    expect(heights(model)).toEqual([1]);
    expect(model.focusedPanelId()).toBe(first.id);
    expect(model.panels()).toHaveLength(1);
  });

  it("closing a panel in a shared row gives its width to the survivors", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.splitPanel(first.id);
    if (second === null) throw new Error("split failed");
    model.closePanel(first.id);
    expect(widths(model, 0)).toEqual([1]);
  });

  it("assigns the lowest unused color slot per panel", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    expect(model.addSeries(panel.id, "a/one")).toBe(true);
    expect(model.addSeries(panel.id, "a/two")).toBe(true);
    expect(model.addSeries(panel.id, "a/one")).toBe(false);
    const slots = model
      .panel(panel.id)
      ?.series.map((series) => series.color_slot);
    expect(slots).toEqual([1, 2]);
  });

  it("toggles series visibility", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.addSeries(panel.id, "a/one");
    model.toggleSeriesVisible(panel.id, "a/one");
    expect(model.panel(panel.id)?.series[0]?.visible).toBe(false);
  });

  it("clamps seam resizes at a 10% minimum fraction", () => {
    const model = new WorkspaceModel();
    model.addPanelRow();
    model.addPanelRow();
    model.resizeRows(0, 0.9);
    expect(heights(model)[1]).toBeCloseTo(0.1);
    expect(heights(model)[0]).toBeCloseTo(0.9);
  });

  it("moves a panel into another row", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    const second = model.addPanelRow();
    model.movePanel(second.id, 0, 0);
    expect(heights(model)).toEqual([1]);
    expect(widths(model, 0)).toHaveLength(2);
    expect(model.layout()[0]?.panels[0]?.panel_id).toBe(second.id);
  });

  it("moves a panel to a new bottom row when the target row does not exist", () => {
    const model = new WorkspaceModel();
    const first = model.addPanelRow();
    model.splitPanel(first.id);
    model.movePanel(first.id, 5, 0);
    expect(model.layout()).toHaveLength(2);
    expect(model.layout()[1]?.panels[0]?.panel_id).toBe(first.id);
  });

  it("maximize is a runtime toggle and clears on close", () => {
    const model = new WorkspaceModel();
    const panel = model.addPanelRow();
    model.toggleMaximize(panel.id);
    expect(model.maximizedPanelId()).toBe(panel.id);
    model.closePanel(panel.id);
    expect(model.maximizedPanelId()).toBeNull();
  });

  it("toggles favorites", () => {
    const model = new WorkspaceModel();
    model.toggleFavorite("a/one");
    model.toggleFavorite("a/two");
    model.toggleFavorite("a/one");
    expect([...model.favorites()]).toEqual(["a/two"]);
  });

  it("never reuses an id already present in a loaded session", () => {
    const session = emptySession();
    session.panels.push({
      id: "panel-1",
      title: "Panel 1",
      mode: "time",
      axis_style: "gutter",
      x_signal: null,
      color_signal: null,
      series: [],
      y_range: null,
      annotations: [],
      show_stats: false,
    });
    session.layout.push({
      height: 1,
      panels: [{ panel_id: "panel-1", width: 1 }],
    });
    const model = new WorkspaceModel(session);
    const fresh = model.addPanelRow();
    expect(fresh.id).not.toBe("panel-1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./scripts/dev.sh pnpm --filter @signalscope/frontend test`
Expected: FAIL — `./workspace` does not exist.

- [ ] **Step 3: Write `frontend/src/app/workspace.ts`:**

```ts
import type {
  LayoutRow,
  PanelMode,
  PanelState,
  Session,
} from "../generated/session";
import { SESSION_SCHEMA_VERSION } from "../generated/session";

const MIN_FRACTION = 0.1;
const MAX_COLOR_SLOTS = 8;

export function emptySession(): Session {
  return {
    app: "signalscope",
    schema_version: SESSION_SCHEMA_VERSION,
    theme: "dark",
    linked_time: {
      t0: 0,
      t1: 60,
      linked: true,
      paused: false,
      cursorT: null,
      mode: "fixed",
    },
    focused_panel_id: null,
    panels: [],
    layout: [],
    favorites: [],
  };
}

export class WorkspaceModel {
  private readonly session: Session;
  private maximized: string | null = null;
  private nextPanelNumber: number;

  constructor(session: Session = emptySession()) {
    this.session = session;
    this.nextPanelNumber = session.panels.length + 1;
  }

  snapshot(): Readonly<Session> {
    return this.session;
  }

  panels(): readonly PanelState[] {
    return this.session.panels;
  }

  layout(): readonly LayoutRow[] {
    return this.session.layout;
  }

  favorites(): readonly string[] {
    return this.session.favorites;
  }

  focusedPanelId(): string | null {
    return this.session.focused_panel_id;
  }

  maximizedPanelId(): string | null {
    return this.maximized;
  }

  panel(id: string): PanelState | undefined {
    return this.session.panels.find((panel) => panel.id === id);
  }

  locate(id: string): { rowIndex: number; cellIndex: number } | null {
    for (const [rowIndex, row] of this.session.layout.entries()) {
      const cellIndex = row.panels.findIndex((cell) => cell.panel_id === id);
      if (cellIndex !== -1) return { rowIndex, cellIndex };
    }
    return null;
  }

  addPanelRow(): PanelState {
    const panel = this.createPanel();
    this.appendRow(panel.id);
    this.session.focused_panel_id = panel.id;
    return panel;
  }

  splitPanel(id: string): PanelState | null {
    const location = this.locate(id);
    if (location === null) return null;
    const row = this.session.layout[location.rowIndex];
    const cell = row?.panels[location.cellIndex];
    if (row === undefined || cell === undefined) return null;
    const panel = this.createPanel();
    const width = cell.width / 2;
    cell.width = width;
    row.panels.splice(location.cellIndex + 1, 0, { panel_id: panel.id, width });
    this.session.focused_panel_id = panel.id;
    return panel;
  }

  closePanel(id: string): void {
    const location = this.locate(id);
    if (location === null) return;
    this.detachCell(location);
    this.session.panels = this.session.panels.filter(
      (panel) => panel.id !== id,
    );
    if (this.maximized === id) this.maximized = null;
    if (this.session.focused_panel_id === id) {
      this.session.focused_panel_id = this.session.panels[0]?.id ?? null;
    }
  }

  focusPanel(id: string): void {
    if (this.panel(id) !== undefined) this.session.focused_panel_id = id;
  }

  toggleMaximize(id: string): void {
    if (this.maximized === id) {
      this.maximized = null;
    } else if (this.panel(id) !== undefined) {
      this.maximized = id;
    }
  }

  setMode(id: string, mode: PanelMode): void {
    const panel = this.panel(id);
    if (panel !== undefined) panel.mode = mode;
  }

  addSeries(panelId: string, path: string): boolean {
    const panel = this.panel(panelId);
    if (
      panel === undefined ||
      panel.series.some((series) => series.path === path)
    ) {
      return false;
    }
    const used = new Set(panel.series.map((series) => series.color_slot));
    let slot = 1;
    while (used.has(slot) && slot < MAX_COLOR_SLOTS) slot += 1;
    if (used.has(slot)) slot = (panel.series.length % MAX_COLOR_SLOTS) + 1;
    panel.series.push({
      path,
      color_slot: slot,
      dash: "solid",
      width: 1.5,
      visible: true,
    });
    return true;
  }

  toggleSeriesVisible(panelId: string, path: string): void {
    const series = this.panel(panelId)?.series.find(
      (entry) => entry.path === path,
    );
    if (series !== undefined) series.visible = !series.visible;
  }

  resizeRows(seamIndex: number, delta: number): void {
    const above = this.session.layout[seamIndex];
    const below = this.session.layout[seamIndex + 1];
    if (above === undefined || below === undefined) return;
    const shift = clampShift(above.height, below.height, delta);
    above.height += shift;
    below.height -= shift;
  }

  resizeColumns(rowIndex: number, seamIndex: number, delta: number): void {
    const row = this.session.layout[rowIndex];
    const left = row?.panels[seamIndex];
    const right = row?.panels[seamIndex + 1];
    if (left === undefined || right === undefined) return;
    const shift = clampShift(left.width, right.width, delta);
    left.width += shift;
    right.width -= shift;
  }

  movePanel(id: string, targetRowIndex: number, targetCellIndex: number): void {
    const location = this.locate(id);
    if (location === null) return;
    const removedRow = this.detachCell(location);
    let rowIndex = targetRowIndex;
    if (removedRow && location.rowIndex < rowIndex) rowIndex -= 1;
    const row = this.session.layout[rowIndex];
    if (row === undefined) {
      this.appendRow(id);
    } else {
      const share = 1 / (row.panels.length + 1);
      for (const cell of row.panels) cell.width *= 1 - share;
      row.panels.splice(Math.min(targetCellIndex, row.panels.length), 0, {
        panel_id: id,
        width: share,
      });
    }
    this.session.focused_panel_id = id;
  }

  toggleFavorite(path: string): void {
    const index = this.session.favorites.indexOf(path);
    if (index === -1) {
      this.session.favorites.push(path);
    } else {
      this.session.favorites.splice(index, 1);
    }
  }

  /** Removes a cell; returns true when its row was removed too. */
  private detachCell(location: {
    rowIndex: number;
    cellIndex: number;
  }): boolean {
    const row = this.session.layout[location.rowIndex];
    if (row === undefined) return false;
    row.panels.splice(location.cellIndex, 1);
    if (row.panels.length === 0) {
      this.session.layout.splice(location.rowIndex, 1);
      normalize(
        this.session.layout,
        (item) => item.height,
        (item, v) => (item.height = v),
      );
      return true;
    }
    normalize(
      row.panels,
      (item) => item.width,
      (item, v) => (item.width = v),
    );
    return false;
  }

  private appendRow(panelId: string): void {
    const previous = this.session.layout.length;
    for (const row of this.session.layout)
      row.height *= previous / (previous + 1);
    this.session.layout.push({
      height: previous === 0 ? 1 : 1 / (previous + 1),
      panels: [{ panel_id: panelId, width: 1 }],
    });
  }

  private createPanel(): PanelState {
    let id = `panel-${this.nextPanelNumber}`;
    while (this.panel(id) !== undefined) {
      this.nextPanelNumber += 1;
      id = `panel-${this.nextPanelNumber}`;
    }
    const panel: PanelState = {
      id,
      title: `Panel ${this.nextPanelNumber}`,
      mode: "time",
      axis_style: "gutter",
      x_signal: null,
      color_signal: null,
      series: [],
      y_range: null,
      annotations: [],
      show_stats: false,
    };
    this.nextPanelNumber += 1;
    this.session.panels.push(panel);
    return panel;
  }
}

function clampShift(first: number, second: number, delta: number): number {
  return Math.min(Math.max(delta, MIN_FRACTION - first), second - MIN_FRACTION);
}

function normalize<T>(
  items: T[],
  get: (item: T) => number,
  set: (item: T, value: number) => void,
): void {
  const total = items.reduce((sum, item) => sum + get(item), 0);
  if (total <= 0) return;
  for (const item of items) set(item, get(item) / total);
}
```

- [ ] **Step 4: Add `setWindow` to `frontend/src/app/linked-time.ts`** — inside `LinkedTimeModel`:

```ts
  setWindow(t0: number, t1: number): void {
    const next = { ...this.state, t0, t1 };
    this.validateWindow(next);
    this.state = next;
  }
```

And append to `frontend/src/app/linked-time.test.ts`:

```ts
it("setWindow validates and applies the new window", () => {
  const model = new LinkedTimeModel();
  model.setWindow(5, 15);
  expect(model.snapshot().t0).toBe(5);
  expect(model.snapshot().t1).toBe(15);
  expect(() => model.setWindow(3, 3)).toThrow();
});
```

(Match the surrounding test file's describe/it structure and imports.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `./scripts/dev.sh pnpm --filter @signalscope/frontend test`
Expected: PASS — all workspace tests plus the linked-time addition.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts frontend/src/app/linked-time.ts frontend/src/app/linked-time.test.ts
git commit -m "model the panel workspace"
```

---

### Task 3: Tree model — grouping, filtering, virtualization, fuzzy match

**Files:**

- Create: `frontend/src/app/tree-model.ts`, `frontend/src/app/fuzzy.ts`
- Test: `frontend/src/app/tree-model.test.ts`, `frontend/src/app/fuzzy.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 5–6):

```ts
// tree-model.ts
interface TreeLeaf { kind: "leaf"; path: string; label: string; depth: number }
interface TreeGroup { kind: "group"; path: string; label: string; depth: number; expanded: boolean }
type TreeRow = TreeLeaf | TreeGroup
buildTreeRows(paths: readonly string[], collapsed: ReadonlySet<string>, filter: string): TreeRow[]
// A non-empty filter returns a flat, sorted list of matching leaves (search-first per the spec).
interface VirtualSlice { start: number; end: number; topPadding: number; totalHeight: number }
virtualSlice(rowCount: number, scrollTop: number, viewportHeight: number, rowHeight: number, overscan?: number): VirtualSlice
// fuzzy.ts
fuzzyScore(query: string, text: string): number | null  // null = no subsequence match
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/tree-model.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildTreeRows, virtualSlice } from "./tree-model";

const PATHS = [
  "rocket/velocity_body/x",
  "rocket/velocity_body/y",
  "rocket/attitude/roll",
  "gnc/pos_east",
];

describe("buildTreeRows", () => {
  it("groups by path segment with one group row per prefix", () => {
    const rows = buildTreeRows(PATHS, new Set(), "");
    expect(rows.map((row) => `${row.kind}:${row.path}`)).toEqual([
      "group:gnc",
      "leaf:gnc/pos_east",
      "group:rocket",
      "group:rocket/attitude",
      "leaf:rocket/attitude/roll",
      "group:rocket/velocity_body",
      "leaf:rocket/velocity_body/x",
      "leaf:rocket/velocity_body/y",
    ]);
    expect(rows[0]?.depth).toBe(0);
    expect(
      rows.find((row) => row.path === "rocket/velocity_body/x")?.depth,
    ).toBe(2);
  });

  it("hides everything under a collapsed group", () => {
    const rows = buildTreeRows(PATHS, new Set(["rocket"]), "");
    expect(rows.map((row) => row.path)).toEqual([
      "gnc",
      "gnc/pos_east",
      "rocket",
    ]);
    const rocket = rows.find((row) => row.path === "rocket");
    expect(rocket?.kind === "group" && rocket.expanded).toBe(false);
  });

  it("a filter returns flat matching leaves", () => {
    const rows = buildTreeRows(PATHS, new Set(["rocket"]), "body/y");
    expect(rows).toEqual([
      {
        kind: "leaf",
        path: "rocket/velocity_body/y",
        label: "rocket/velocity_body/y",
        depth: 0,
      },
    ]);
  });
});

describe("virtualSlice", () => {
  it("windows a 10k-row list to the viewport plus overscan", () => {
    const slice = virtualSlice(10_000, 2_200, 400, 22, 10);
    expect(slice.start).toBe(90);
    expect(slice.end).toBe(129);
    expect(slice.topPadding).toBe(90 * 22);
    expect(slice.totalHeight).toBe(220_000);
  });

  it("clamps at both ends", () => {
    expect(virtualSlice(5, 0, 400, 22).start).toBe(0);
    expect(virtualSlice(5, 0, 400, 22).end).toBe(5);
  });
});
```

`frontend/src/app/fuzzy.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("npr", "new panel row")).not.toBeNull();
    expect(fuzzyScore("xyz", "new panel row")).toBeNull();
  });

  it("prefers prefix and consecutive matches", () => {
    const prefix = fuzzyScore("new", "new panel row");
    const scattered = fuzzyScore("new", "n e w idget");
    if (prefix === null || scattered === null)
      throw new Error("expected matches");
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("empty query matches everything neutrally", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `./scripts/dev.sh pnpm --filter @signalscope/frontend test` — Expected: FAIL (modules missing).

- [ ] **Step 3: Write `frontend/src/app/tree-model.ts`:**

```ts
export interface TreeLeaf {
  kind: "leaf";
  path: string;
  label: string;
  depth: number;
}

export interface TreeGroup {
  kind: "group";
  path: string;
  label: string;
  depth: number;
  expanded: boolean;
}

export type TreeRow = TreeLeaf | TreeGroup;

export function buildTreeRows(
  paths: readonly string[],
  collapsed: ReadonlySet<string>,
  filter: string,
): TreeRow[] {
  const query = filter.trim().toLowerCase();
  if (query !== "") {
    return [...paths]
      .filter((path) => path.toLowerCase().includes(query))
      .sort()
      .map((path) => ({ kind: "leaf", path, label: path, depth: 0 }));
  }
  const rows: TreeRow[] = [];
  const emitted = new Set<string>();
  for (const path of [...paths].sort()) {
    const segments = path.split("/");
    let prefix = "";
    let hidden = false;
    for (let depth = 0; depth < segments.length - 1; depth += 1) {
      const segment = segments[depth] ?? "";
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      if (!hidden && !emitted.has(prefix)) {
        rows.push({
          kind: "group",
          path: prefix,
          label: segment,
          depth,
          expanded: !collapsed.has(prefix),
        });
        emitted.add(prefix);
      }
      if (collapsed.has(prefix)) hidden = true;
    }
    if (!hidden) {
      rows.push({
        kind: "leaf",
        path,
        label: segments[segments.length - 1] ?? path,
        depth: segments.length - 1,
      });
    }
  }
  return rows;
}

export interface VirtualSlice {
  start: number;
  end: number;
  topPadding: number;
  totalHeight: number;
}

export function virtualSlice(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 10,
): VirtualSlice {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const end = Math.min(rowCount, start + visible);
  return {
    start,
    end,
    topPadding: start * rowHeight,
    totalHeight: rowCount * rowHeight,
  };
}
```

- [ ] **Step 4: Write `frontend/src/app/fuzzy.ts`:**

```ts
/** Subsequence match score; higher is better, null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (needle === "") return 0;
  let score = 0;
  let index = 0;
  let run = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, index);
    if (found === -1) return null;
    run = found === index ? run + 1 : 1;
    score += run + (found === 0 ? 2 : 0);
    index = found + 1;
  }
  return score - (haystack.length - needle.length) * 0.01;
}
```

- [ ] **Step 5: Verify the expected virtualSlice numbers by hand before trusting the test**: `floor(2200/22)=100`, minus overscan 10 → start 90; visible `ceil(400/22)=19` + 20 → 39; end `min(10000, 129)=129`. Run: `./scripts/dev.sh pnpm --filter @signalscope/frontend test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/tree-model.ts frontend/src/app/tree-model.test.ts frontend/src/app/fuzzy.ts frontend/src/app/fuzzy.test.ts
git commit -m "add tree grouping, virtualization, and fuzzy matching"
```

---

### Task 4: Command registry and key dispatch

**Files:**

- Create: `frontend/src/app/commands.ts`
- Test: `frontend/src/app/commands.test.ts`

**Interfaces:**

- Produces (consumed by Tasks 5–6):

```ts
interface Command {
  id: string;
  title: string;
  keys?: string;
  enabled?: () => boolean;
  run: () => void;
}
class CommandRegistry {
  register(command: Command): void;
  list(): Command[]; // enabled commands only
  run(id: string): boolean;
  handleKey(event: KeyboardEvent): boolean; // matches "o", "/", "?", "mod+k", …
}
```

Key syntax: lowercase `event.key`, with `mod+` prefix when Ctrl or Meta is held. Alt combos never match.

- [ ] **Step 1: Write the failing test** — `frontend/src/app/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CommandRegistry, type Command } from "./commands";

// A plain object, not `new KeyboardEvent(...)` — these unit tests run in
// Vitest's node environment, which has no DOM event constructors.
function key(
  k: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey">
  > = {},
): KeyboardEvent {
  return {
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

function command(overrides: Partial<Command> & { id: string }): Command {
  return { title: overrides.id, run: () => undefined, ...overrides };
}

describe("CommandRegistry", () => {
  it("runs commands by id and reports unknown ids", () => {
    const registry = new CommandRegistry();
    let ran = 0;
    registry.register(command({ id: "a", run: () => (ran += 1) }));
    expect(registry.run("a")).toBe(true);
    expect(registry.run("missing")).toBe(false);
    expect(ran).toBe(1);
  });

  it("dispatches plain keys and mod combos, skipping disabled commands", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    registry.register(
      command({ id: "open", keys: "o", run: () => ran.push("open") }),
    );
    registry.register(
      command({ id: "palette", keys: "mod+k", run: () => ran.push("palette") }),
    );
    registry.register(
      command({
        id: "off",
        keys: "x",
        enabled: () => false,
        run: () => ran.push("off"),
      }),
    );
    expect(registry.handleKey(key("o"))).toBe(true);
    expect(registry.handleKey(key("k", { ctrlKey: true }))).toBe(true);
    expect(registry.handleKey(key("k", { metaKey: true }))).toBe(true);
    expect(registry.handleKey(key("x"))).toBe(false);
    expect(registry.handleKey(key("o", { altKey: true }))).toBe(false);
    expect(ran).toEqual(["open", "palette", "palette"]);
  });

  it("list() hides disabled commands", () => {
    const registry = new CommandRegistry();
    registry.register(command({ id: "on" }));
    registry.register(command({ id: "off", enabled: () => false }));
    expect(registry.list().map((c) => c.id)).toEqual(["on"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (module missing).

- [ ] **Step 3: Write `frontend/src/app/commands.ts`:**

```ts
export interface Command {
  id: string;
  title: string;
  keys?: string;
  enabled?: () => boolean;
  run: () => void;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): void {
    this.commands.set(command.id, command);
  }

  list(): Command[] {
    return [...this.commands.values()].filter(
      (command) => command.enabled?.() ?? true,
    );
  }

  run(id: string): boolean {
    const command = this.commands.get(id);
    if (command === undefined || !(command.enabled?.() ?? true)) return false;
    command.run();
    return true;
  }

  handleKey(event: KeyboardEvent): boolean {
    const combo = comboFor(event);
    if (combo === null) return false;
    for (const command of this.commands.values()) {
      if (command.keys === combo && (command.enabled?.() ?? true)) {
        command.run();
        return true;
      }
    }
    return false;
  }
}

function comboFor(event: KeyboardEvent): string | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) return `mod+${key}`;
  return key;
}
```

- [ ] **Step 4: Run to verify pass** — `./scripts/dev.sh pnpm --filter @signalscope/frontend test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/commands.ts frontend/src/app/commands.test.ts
git commit -m "add a command registry with keyboard dispatch"
```

---

### Task 5: Multi-panel workspace — views, app shell, styles

The single DOM-integration task: panel/workspace/tree/palette components, the renderer's label + color-slot options, the `AppShell` rewrite, and CSS. Pure logic was tested in Tasks 2–4; this task is verified by typecheck + lint + a manual web run, then locked in by Task 7's e2e suite.

**Files:**

- Create: `frontend/src/ui/dom.ts`, `frontend/src/ui/panel.ts`, `frontend/src/ui/workspace-view.ts`, `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/command-palette.ts`
- Modify: `frontend/src/render/canvas-renderer.ts`, `frontend/src/ui/app-shell.ts` (rewrite), `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: `WorkspaceModel` (Task 2), `buildTreeRows`/`virtualSlice` (Task 3), `fuzzyScore` (Task 3), `CommandRegistry` (Task 4), `DataPlane.listSignals/queryTiles`.
- Produces: `CanvasRenderer.render(response, xRange, options: RenderOptions)` where `RenderOptions = { xLabel: string; yLabel: string; colorSlots: readonly number[] }`; `PanelView`, `WorkspaceView`, `SignalTreeView`, `CommandPalette` as specified below; drag payload MIME types `SIGNAL_DRAG_TYPE` / `PANEL_DRAG_TYPE`.

- [ ] **Step 1: Create `frontend/src/ui/dom.ts`:**

```ts
export function required<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing application element: ${selector}`);
  }
  return element;
}
```

- [ ] **Step 2: Renderer options** — in `frontend/src/render/canvas-renderer.ts`:

Add after the `Palette` interface:

```ts
export interface RenderOptions {
  xLabel: string;
  yLabel: string;
  colorSlots: readonly number[];
}
```

Change `render` to accept and use them:

```ts
  render(response: TileResponse, xRange: Range, options: RenderOptions): number {
```

…pass `options` through to `drawAxes(context, plot, xRange, yRange, colors, options)`, and replace the series loop with:

```ts
response.series.forEach((series, index) => {
  const slot = options.colorSlots[index] ?? index + 1;
  this.drawSeries(
    context,
    plot,
    series,
    xRange,
    yRange,
    colors.series[(slot - 1) % colors.series.length] ?? colors.fg2,
  );
});
```

`drawAxes` gains a final `options: RenderOptions` parameter, and its two hardcoded label calls become:

```ts
context.fillText(
  options.xLabel,
  plot.x + plot.width / 2,
  plot.y + plot.height + 27,
);
```

and (inside the save/rotate block) `context.fillText(options.yLabel, 0, 0);`.

- [ ] **Step 3: Create `frontend/src/ui/panel.ts`:**

```ts
import type { TileResponse } from "../generated/protocol";
import type { PanelMode, PanelState } from "../generated/session";
import { CanvasRenderer, type RenderOptions } from "../render/canvas-renderer";
import { required } from "./dom";

export const SIGNAL_DRAG_TYPE = "application/x-signalscope-signal";
export const PANEL_DRAG_TYPE = "application/x-signalscope-panel";

const MODES: readonly { mode: PanelMode; label: string }[] = [
  { mode: "time", label: "T" },
  { mode: "xy", label: "XY" },
  { mode: "fft", label: "FFT" },
  { mode: "histogram", label: "H" },
];

const MODE_NAMES: Record<PanelMode, string> = {
  time: "Time",
  xy: "XY",
  fft: "FFT",
  histogram: "Histogram",
};

export interface PanelCallbacks {
  onFocus(id: string): void;
  onClose(id: string): void;
  onSplit(id: string): void;
  onMaximize(id: string): void;
  onSelectMode(id: string, mode: PanelMode): void;
  onDropSignal(id: string, path: string): void;
  onToggleSeries(id: string, path: string): void;
  onResized(id: string): void;
}

export function hasDragType(event: DragEvent, type: string): boolean {
  return event.dataTransfer?.types.includes(type) ?? false;
}

export class PanelView {
  readonly element: HTMLElement;
  private readonly renderer: CanvasRenderer;
  private readonly canvas: HTMLCanvasElement;

  constructor(
    private readonly id: string,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.element = document.createElement("article");
    this.element.className = "panel";
    this.element.dataset.panelId = id;
    this.element.innerHTML = panelMarkup();
    this.canvas = required<HTMLCanvasElement>(this.element, ".plot-canvas");
    this.renderer = new CanvasRenderer(this.canvas);
    this.bind();
    new ResizeObserver(() => {
      this.callbacks.onResized(this.id);
    }).observe(this.canvas);
  }

  private bind(): void {
    this.element.addEventListener("pointerdown", () => {
      this.callbacks.onFocus(this.id);
    });
    required(this.element, ".panel-close").addEventListener("click", () => {
      this.callbacks.onClose(this.id);
    });
    required(this.element, ".panel-split").addEventListener("click", () => {
      this.callbacks.onSplit(this.id);
    });
    required(this.element, ".panel-maximize").addEventListener("click", () => {
      this.callbacks.onMaximize(this.id);
    });
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".mode-pill",
    )) {
      button.addEventListener("click", () => {
        this.callbacks.onSelectMode(this.id, button.dataset.mode as PanelMode);
      });
    }
    const header = required<HTMLElement>(this.element, ".panel-header");
    header.draggable = true;
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(PANEL_DRAG_TYPE, this.id);
    });
    this.element.addEventListener("dragover", (event) => {
      if (hasDragType(event, SIGNAL_DRAG_TYPE)) {
        event.preventDefault();
        this.element.classList.add("drop-target");
      }
    });
    this.element.addEventListener("dragleave", () => {
      this.element.classList.remove("drop-target");
    });
    this.element.addEventListener("drop", (event) => {
      this.element.classList.remove("drop-target");
      const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
      if (path !== undefined && path !== "") {
        event.preventDefault();
        event.stopPropagation();
        this.callbacks.onDropSignal(this.id, path);
      }
    });
  }

  update(state: PanelState, focused: boolean, maximized: boolean): void {
    this.element.classList.toggle("focused", focused);
    this.element.classList.toggle("maximized", maximized);
    this.element.setAttribute("aria-label", `${state.title} panel`);
    required(this.element, ".panel-title").textContent = state.title;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>(
      ".mode-pill",
    )) {
      button.classList.toggle("active", button.dataset.mode === state.mode);
    }
    this.updateLegend(state);
    const empty = required<HTMLElement>(this.element, ".panel-empty");
    if (state.mode !== "time") {
      empty.hidden = false;
      empty.textContent = `${MODE_NAMES[state.mode]} mode is not implemented yet.`;
    } else if (state.series.length === 0) {
      empty.hidden = false;
      empty.textContent = "Empty panel — drag a signal here.";
    } else {
      empty.hidden = true;
    }
  }

  renderTiles(
    state: PanelState,
    tiles: TileResponse | null,
    window: { t0: number; t1: number },
  ): number {
    if (tiles === null || state.mode !== "time" || state.series.length === 0) {
      return 0;
    }
    const bySeries = new Map(
      state.series.map((series) => [series.path, series]),
    );
    const shown = tiles.series.filter(
      (tile) => bySeries.get(tile.signal_path)?.visible ?? true,
    );
    const response = { request_id: tiles.request_id, series: shown };
    const options: RenderOptions = {
      xLabel: "time (s)",
      yLabel: yLabel(response.series.map((tile) => tile.unit)),
      colorSlots: shown.map(
        (tile) => bySeries.get(tile.signal_path)?.color_slot ?? 1,
      ),
    };
    return this.renderer.render(
      response,
      { min: window.t0, max: window.t1 },
      options,
    );
  }

  invalidateTheme(): void {
    this.renderer.invalidateTheme();
  }

  private updateLegend(state: PanelState): void {
    const legend = required(this.element, ".panel-legend");
    legend.replaceChildren(
      ...state.series.map((series) => {
        const chip = document.createElement("button");
        chip.className = `legend-chip ${series.visible ? "" : "muted"}`;
        chip.title = `${series.path} — click to toggle visibility`;
        const line = document.createElement("span");
        line.className = "legend-line";
        line.style.background = `var(--series-${((series.color_slot - 1) % 8) + 1})`;
        const name = document.createElement("span");
        name.className = "legend-name";
        name.textContent = series.path.split("/").slice(-2).join("/");
        chip.append(line, name);
        chip.addEventListener("click", () => {
          this.callbacks.onToggleSeries(this.id, series.path);
        });
        return chip;
      }),
    );
  }
}

function yLabel(units: readonly (string | null)[]): string {
  const distinct = new Set(
    units.filter((unit): unit is string => unit !== null),
  );
  const [only] = distinct;
  return distinct.size === 1 && only !== undefined
    ? `value (${only})`
    : "value";
}

function panelMarkup(): string {
  return `<header class="panel-header">
      <span class="drag-handle" aria-hidden="true">⠿</span>
      <span class="panel-title"></span>
      <span class="mode-pills" aria-label="Panel mode">${MODES.map(
        ({ mode, label }) =>
          `<button class="mode-pill" data-mode="${mode}">${label}</button>`,
      ).join("")}</span>
      <span class="panel-legend"></span>
      <span class="panel-actions">
        <button class="panel-action panel-split" title="Split panel">⊞</button>
        <button class="panel-action panel-maximize" title="Maximize panel">⤢</button>
        <button class="panel-action panel-close" title="Close panel">✕</button>
      </span>
    </header>
    <div class="plot-wrap">
      <canvas class="plot-canvas" aria-label="Time-series plot"></canvas>
      <div class="panel-empty" hidden></div>
    </div>`;
}
```

- [ ] **Step 4: Create `frontend/src/ui/workspace-view.ts`:**

```ts
import type { TileResponse } from "../generated/protocol";
import type { WorkspaceModel } from "../app/workspace";
import {
  PANEL_DRAG_TYPE,
  PanelView,
  SIGNAL_DRAG_TYPE,
  hasDragType,
  type PanelCallbacks,
} from "./panel";

export interface WorkspaceCallbacks extends PanelCallbacks {
  onLayoutChanged(): void;
  onDropSignalNewPanel(path: string): void;
  onMovePanel(
    id: string,
    targetRowIndex: number,
    targetCellIndex: number,
  ): void;
}

export class WorkspaceView {
  private readonly views = new Map<string, PanelView>();

  constructor(
    private readonly root: HTMLElement,
    private readonly model: WorkspaceModel,
    private readonly callbacks: WorkspaceCallbacks,
  ) {
    this.bindWorkspaceDrop();
  }

  /** Rebuilds the panel grid DOM from the model's layout. */
  sync(hasSignals: boolean): void {
    const alive = new Set(this.model.panels().map((panel) => panel.id));
    for (const [id, view] of this.views) {
      if (!alive.has(id)) {
        view.element.remove();
        this.views.delete(id);
      }
    }
    this.root.replaceChildren();
    if (this.model.panels().length === 0) {
      this.root.appendChild(emptyState(hasSignals));
      return;
    }
    const maximized = this.model.maximizedPanelId();
    if (maximized !== null) {
      const rowElement = document.createElement("div");
      rowElement.className = "workspace-row";
      rowElement.style.flex = "1 1 0";
      rowElement.appendChild(this.view(maximized).element);
      this.root.appendChild(rowElement);
      this.refreshPanelStates();
      return;
    }
    this.model.layout().forEach((row, rowIndex) => {
      if (rowIndex > 0) this.root.appendChild(this.rowSeam(rowIndex - 1));
      const rowElement = document.createElement("div");
      rowElement.className = "workspace-row";
      rowElement.style.flex = `${row.height} 1 0`;
      row.panels.forEach((cell, cellIndex) => {
        if (cellIndex > 0) {
          rowElement.appendChild(this.columnSeam(rowIndex, cellIndex - 1));
        }
        const view = this.view(cell.panel_id);
        view.element.style.flex = `${cell.width} 1 0`;
        rowElement.appendChild(view.element);
      });
      this.root.appendChild(rowElement);
    });
    this.refreshPanelStates();
  }

  /** Updates focus/mode/legend classes without rebuilding the DOM. */
  refreshPanelStates(): void {
    const focused = this.model.focusedPanelId();
    const maximized = this.model.maximizedPanelId();
    for (const panel of this.model.panels()) {
      this.views
        .get(panel.id)
        ?.update(panel, panel.id === focused, panel.id === maximized);
    }
  }

  renderTiles(
    tilesByPanel: ReadonlyMap<string, TileResponse>,
    window: { t0: number; t1: number },
  ): number {
    const maximized = this.model.maximizedPanelId();
    let total = 0;
    for (const panel of this.model.panels()) {
      if (maximized !== null && panel.id !== maximized) continue;
      total +=
        this.views
          .get(panel.id)
          ?.renderTiles(panel, tilesByPanel.get(panel.id) ?? null, window) ?? 0;
    }
    return total;
  }

  invalidateTheme(): void {
    for (const view of this.views.values()) view.invalidateTheme();
  }

  private view(id: string): PanelView {
    let view = this.views.get(id);
    if (view === undefined) {
      view = new PanelView(id, this.callbacks);
      this.bindPanelRearrange(view.element, id);
      this.views.set(id, view);
    }
    return view;
  }

  private bindPanelRearrange(element: HTMLElement, id: string): void {
    element.addEventListener("dragover", (event) => {
      if (hasDragType(event, PANEL_DRAG_TYPE)) event.preventDefault();
    });
    element.addEventListener("drop", (event) => {
      const dragged = event.dataTransfer?.getData(PANEL_DRAG_TYPE);
      if (dragged === undefined || dragged === "" || dragged === id) return;
      event.preventDefault();
      event.stopPropagation();
      const location = this.model.locate(id);
      if (location !== null) {
        this.callbacks.onMovePanel(
          dragged,
          location.rowIndex,
          location.cellIndex,
        );
      }
    });
  }

  private bindWorkspaceDrop(): void {
    this.root.addEventListener("dragover", (event) => {
      if (hasDragType(event, SIGNAL_DRAG_TYPE)) {
        event.preventDefault();
        this.root.classList.add("drop-target");
      }
    });
    this.root.addEventListener("dragleave", () => {
      this.root.classList.remove("drop-target");
    });
    this.root.addEventListener("drop", (event) => {
      this.root.classList.remove("drop-target");
      const target = event.target;
      const onBackground =
        target === this.root ||
        (target instanceof HTMLElement &&
          target.classList.contains("workspace-empty"));
      if (!onBackground) return;
      const path = event.dataTransfer?.getData(SIGNAL_DRAG_TYPE);
      if (path !== undefined && path !== "") {
        event.preventDefault();
        this.callbacks.onDropSignalNewPanel(path);
      }
    });
  }

  private rowSeam(seamIndex: number): HTMLElement {
    return this.seam("seam seam-row", (_dx, dy) => {
      const height = this.root.clientHeight;
      if (height > 0) this.model.resizeRows(seamIndex, dy / height);
    });
  }

  private columnSeam(rowIndex: number, seamIndex: number): HTMLElement {
    return this.seam("seam seam-col", (dx, _dy, seamElement) => {
      const width = seamElement.parentElement?.clientWidth ?? 0;
      if (width > 0) this.model.resizeColumns(rowIndex, seamIndex, dx / width);
    });
  }

  private seam(
    className: string,
    apply: (dx: number, dy: number, seamElement: HTMLElement) => void,
  ): HTMLElement {
    const seamElement = document.createElement("div");
    seamElement.className = className;
    seamElement.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      seamElement.setPointerCapture(event.pointerId);
      let last = { x: event.clientX, y: event.clientY };
      const move = (moveEvent: PointerEvent): void => {
        apply(
          moveEvent.clientX - last.x,
          moveEvent.clientY - last.y,
          seamElement,
        );
        last = { x: moveEvent.clientX, y: moveEvent.clientY };
        this.applySizes();
      };
      const up = (): void => {
        seamElement.removeEventListener("pointermove", move);
        seamElement.removeEventListener("pointerup", up);
        this.callbacks.onLayoutChanged();
      };
      seamElement.addEventListener("pointermove", move);
      seamElement.addEventListener("pointerup", up);
    });
    return seamElement;
  }

  /** Cheap mid-drag restyle: updates flex fractions without rebuilding. */
  private applySizes(): void {
    const rows = this.root.querySelectorAll<HTMLElement>(".workspace-row");
    this.model.layout().forEach((row, rowIndex) => {
      const rowElement = rows[rowIndex];
      if (rowElement === undefined) return;
      rowElement.style.flex = `${row.height} 1 0`;
      for (const cell of row.panels) {
        const view = this.views.get(cell.panel_id);
        if (view !== undefined) view.element.style.flex = `${cell.width} 1 0`;
      }
    });
  }
}

function emptyState(hasSignals: boolean): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "workspace-empty";
  const headline = document.createElement("div");
  headline.className = "empty-headline";
  const hint = document.createElement("div");
  hint.className = "empty-hint";
  if (hasSignals) {
    headline.textContent = "No panels open.";
    hint.textContent = "New panel row (N) · drag a signal here · ⌘K commands";
  } else {
    headline.textContent = "No data loaded.";
    hint.textContent = "Open Files (O) · ⌘K commands";
  }
  empty.append(headline, hint);
  return empty;
}
```

- [ ] **Step 5: Create `frontend/src/ui/signal-tree.ts`:**

```ts
import { buildTreeRows, virtualSlice, type TreeRow } from "../app/tree-model";
import { SIGNAL_DRAG_TYPE } from "./panel";

const ROW_HEIGHT = 22;

export interface SignalTreeCallbacks {
  onPlotSignal(path: string): void;
  onToggleFavorite(path: string): void;
}

export class SignalTreeView {
  private paths: string[] = [];
  private favorites: readonly string[] = [];
  private readonly collapsed = new Set<string>();
  private filter = "";
  private rows: TreeRow[] = [];

  constructor(
    private readonly listElement: HTMLElement,
    private readonly favoritesElement: HTMLElement,
    private readonly callbacks: SignalTreeCallbacks,
  ) {
    listElement.addEventListener("scroll", () => {
      this.renderRows();
    });
  }

  setSignals(paths: readonly string[]): void {
    this.paths = [...paths];
    this.refresh();
  }

  setFavorites(favorites: readonly string[]): void {
    this.favorites = favorites;
    this.renderFavorites();
    this.renderRows();
  }

  setFilter(filter: string): void {
    this.filter = filter;
    this.refresh();
  }

  private refresh(): void {
    this.rows = buildTreeRows(this.paths, this.collapsed, this.filter);
    this.renderRows();
    this.renderFavorites();
  }

  private renderRows(): void {
    if (this.rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent =
        this.paths.length === 0 ? "No signals loaded." : "No matching signals.";
      this.listElement.replaceChildren(empty);
      return;
    }
    const slice = virtualSlice(
      this.rows.length,
      this.listElement.scrollTop,
      this.listElement.clientHeight > 0 ? this.listElement.clientHeight : 400,
      ROW_HEIGHT,
    );
    const spacer = document.createElement("div");
    spacer.className = "tree-spacer";
    spacer.style.height = `${slice.totalHeight}px`;
    const windowElement = document.createElement("div");
    windowElement.className = "tree-window";
    windowElement.style.transform = `translateY(${slice.topPadding}px)`;
    for (const row of this.rows.slice(slice.start, slice.end)) {
      windowElement.appendChild(this.rowElement(row));
    }
    spacer.appendChild(windowElement);
    this.listElement.replaceChildren(spacer);
  }

  private rowElement(row: TreeRow): HTMLElement {
    if (row.kind === "group") {
      const button = document.createElement("button");
      button.className = "tree-row tree-group";
      button.style.paddingLeft = `${8 + row.depth * 12}px`;
      button.dataset.groupPath = row.path;
      button.textContent = `${row.expanded ? "▾" : "▸"} ${row.label}`;
      button.addEventListener("click", () => {
        if (this.collapsed.has(row.path)) {
          this.collapsed.delete(row.path);
        } else {
          this.collapsed.add(row.path);
        }
        this.refresh();
      });
      return button;
    }
    return this.leafElement(row.path, row.label, row.depth);
  }

  private leafElement(path: string, label: string, depth: number): HTMLElement {
    const rowElement = document.createElement("div");
    rowElement.className = "tree-row tree-leaf";
    rowElement.style.paddingLeft = `${8 + depth * 12}px`;
    rowElement.dataset.signalPath = path;
    rowElement.draggable = true;
    rowElement.tabIndex = 0;
    rowElement.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(SIGNAL_DRAG_TYPE, path);
    });
    rowElement.addEventListener("dblclick", () => {
      this.callbacks.onPlotSignal(path);
    });
    rowElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.callbacks.onPlotSignal(path);
    });
    const star = document.createElement("button");
    star.className = `tree-star ${this.favorites.includes(path) ? "active" : ""}`;
    star.textContent = "★";
    star.title = "Toggle favorite";
    star.addEventListener("click", (event) => {
      event.stopPropagation();
      this.callbacks.onToggleFavorite(path);
    });
    const name = document.createElement("span");
    name.className = "signal-path";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "signal-value";
    value.textContent = "—";
    rowElement.append(star, name, value);
    return rowElement;
  }

  private renderFavorites(): void {
    if (this.favorites.length === 0) {
      const none = document.createElement("div");
      none.className = "tree-empty";
      none.textContent = "—";
      this.favoritesElement.replaceChildren(none);
      return;
    }
    this.favoritesElement.replaceChildren(
      ...this.favorites.map((path) => this.leafElement(path, path, 0)),
    );
  }
}
```

- [ ] **Step 6: Create `frontend/src/ui/command-palette.ts`:**

```ts
import { fuzzyScore } from "../app/fuzzy";
import { required } from "./dom";

export interface PaletteEntry {
  title: string;
  hint: string;
  run: () => void;
}

export class CommandPalette {
  private readonly element: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private entries: PaletteEntry[] = [];
  private matches: PaletteEntry[] = [];
  private selected = 0;

  constructor(
    root: HTMLElement,
    private readonly provider: () => PaletteEntry[],
  ) {
    this.element = document.createElement("div");
    this.element.className = "palette-overlay";
    this.element.hidden = true;
    this.element.innerHTML = `<div class="palette">
        <input class="palette-input" placeholder="commands, signals…" spellcheck="false" aria-label="Command palette" />
        <div class="palette-list"></div>
      </div>`;
    root.appendChild(this.element);
    this.input = required<HTMLInputElement>(this.element, ".palette-input");
    this.list = required<HTMLElement>(this.element, ".palette-list");
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
    this.input.addEventListener("input", () => {
      this.filter();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.selected = Math.min(this.selected + 1, this.matches.length - 1);
        this.renderList();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.selected = Math.max(this.selected - 1, 0);
        this.renderList();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.runSelected();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
  }

  open(): void {
    this.entries = this.provider();
    this.element.hidden = false;
    this.input.value = "";
    this.filter();
    this.input.focus();
  }

  close(): void {
    this.element.hidden = true;
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  private filter(): void {
    const query = this.input.value;
    this.matches = this.entries
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.title) }))
      .filter(
        (item): item is { entry: PaletteEntry; score: number } =>
          item.score !== null,
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, 12)
      .map((item) => item.entry);
    this.selected = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.matches.map((entry, index) => {
        const row = document.createElement("button");
        row.className = `palette-row ${index === this.selected ? "selected" : ""}`;
        const title = document.createElement("span");
        title.textContent = entry.title;
        const hint = document.createElement("span");
        hint.className = "palette-hint";
        hint.textContent = entry.hint;
        row.append(title, hint);
        row.addEventListener("click", () => {
          this.close();
          entry.run();
        });
        return row;
      }),
    );
  }

  private runSelected(): void {
    const entry = this.matches[this.selected];
    if (entry !== undefined) {
      this.close();
      entry.run();
    }
  }
}
```

- [ ] **Step 7: Rewrite `frontend/src/ui/app-shell.ts`:**

```ts
import { type SignalSummary, type TileResponse } from "../generated/protocol";
import { CommandRegistry } from "../app/commands";
import type { DataPlane } from "../app/data-plane";
import { LinkedTimeModel } from "../app/linked-time";
import { WorkspaceModel } from "../app/workspace";
import { CommandPalette, type PaletteEntry } from "./command-palette";
import { required } from "./dom";
import { SignalTreeView } from "./signal-tree";
import { WorkspaceView } from "./workspace-view";

export class AppShell {
  private readonly time = new LinkedTimeModel();
  private readonly workspace = new WorkspaceModel();
  private readonly commands = new CommandRegistry();
  private signals: SignalSummary[] = [];
  private signalsByPath = new Map<string, SignalSummary>();
  private workspaceView: WorkspaceView | null = null;
  private tree: SignalTreeView | null = null;
  private palette: CommandPalette | null = null;
  private tilesByPanel = new Map<string, TileResponse>();

  constructor(
    private readonly root: HTMLElement,
    private readonly plane: DataPlane,
  ) {}

  async mount(): Promise<void> {
    this.root.innerHTML = shellMarkup();
    this.workspaceView = new WorkspaceView(
      required(this.root, ".workspace"),
      this.workspace,
      {
        onFocus: (id) => {
          if (this.workspace.focusedPanelId() !== id) {
            this.workspace.focusPanel(id);
            this.workspaceView?.refreshPanelStates();
          }
        },
        onClose: (id) => {
          this.workspace.closePanel(id);
          this.afterLayoutChange();
        },
        onSplit: (id) => {
          this.workspace.splitPanel(id);
          this.afterLayoutChange();
        },
        onMaximize: (id) => {
          this.workspace.toggleMaximize(id);
          this.afterLayoutChange();
        },
        onSelectMode: (id, mode) => {
          this.workspace.setMode(id, mode);
          this.workspaceView?.refreshPanelStates();
          void this.refreshTiles();
        },
        onDropSignal: (id, path) => {
          this.plotSignal(path, id);
        },
        onToggleSeries: (id, path) => {
          this.workspace.toggleSeriesVisible(id, path);
          this.workspaceView?.refreshPanelStates();
          this.renderTiles();
        },
        onResized: () => {
          this.renderTiles();
        },
        onLayoutChanged: () => {
          void this.refreshTiles();
        },
        onDropSignalNewPanel: (path) => {
          const panel = this.workspace.addPanelRow();
          this.plotSignal(path, panel.id);
        },
        onMovePanel: (id, rowIndex, cellIndex) => {
          this.workspace.movePanel(id, rowIndex, cellIndex);
          this.afterLayoutChange();
        },
      },
    );
    this.tree = new SignalTreeView(
      required(this.root, ".tree-scroll"),
      required(this.root, ".tree-favorites"),
      {
        onPlotSignal: (path) => {
          this.plotSignal(path);
        },
        onToggleFavorite: (path) => {
          this.workspace.toggleFavorite(path);
          this.tree?.setFavorites(this.workspace.favorites());
        },
      },
    );
    this.palette = new CommandPalette(this.root, () => this.paletteEntries());
    this.registerCommands();
    this.bindControls();
    await this.reloadSignals();
    if (this.signals.length > 0 && this.workspace.panels().length === 0) {
      const panel = this.workspace.addPanelRow();
      for (const summary of this.signals.slice(0, 2)) {
        this.workspace.addSeries(panel.id, summary.path);
      }
      this.fitWindowToPlotted();
    }
    this.afterLayoutChange();
  }

  private registerCommands(): void {
    this.commands.register({
      id: "new-panel-row",
      title: "New panel row",
      keys: "n",
      run: () => {
        this.workspace.addPanelRow();
        this.afterLayoutChange();
      },
    });
    this.commands.register({
      id: "close-panel",
      title: "Close focused panel",
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const id = this.workspace.focusedPanelId();
        if (id !== null) {
          this.workspace.closePanel(id);
          this.afterLayoutChange();
        }
      },
    });
    this.commands.register({
      id: "maximize-panel",
      title: "Maximize focused panel",
      enabled: () => this.workspace.focusedPanelId() !== null,
      run: () => {
        const id = this.workspace.focusedPanelId();
        if (id !== null) {
          this.workspace.toggleMaximize(id);
          this.afterLayoutChange();
        }
      },
    });
    this.commands.register({
      id: "focus-filter",
      title: "Filter signals",
      keys: "/",
      run: () => {
        required<HTMLInputElement>(this.root, ".signal-search").focus();
      },
    });
    this.commands.register({
      id: "toggle-linked",
      title: "Toggle linked time",
      keys: "l",
      run: () => {
        this.toggleLinked();
      },
    });
    this.commands.register({
      id: "toggle-theme",
      title: "Toggle theme",
      keys: "t",
      run: () => {
        this.toggleTheme();
      },
    });
    this.commands.register({
      id: "toggle-formula",
      title: "Toggle formula bar",
      keys: "e",
      run: () => {
        required(this.root, ".workbench").classList.toggle("formula-collapsed");
      },
    });
    this.commands.register({
      id: "command-palette",
      title: "Command palette",
      keys: "mod+k",
      run: () => {
        this.palette?.open();
      },
    });
    this.commands.register({
      id: "help",
      title: "Keyboard help",
      keys: "?",
      run: () => {
        this.palette?.open();
      },
    });
  }

  private paletteEntries(): PaletteEntry[] {
    const commands = this.commands.list().map((command) => ({
      title: command.title,
      hint: command.keys === undefined ? "" : keyHint(command.keys),
      run: () => {
        this.commands.run(command.id);
      },
    }));
    const signals = this.signals.map((summary) => ({
      title: `plot ${summary.path}`,
      hint: "signal",
      run: () => {
        this.plotSignal(summary.path);
      },
    }));
    return [...commands, ...signals];
  }

  private bindControls(): void {
    required(this.root, ".theme-toggle").addEventListener("click", () => {
      this.toggleTheme();
    });
    required(this.root, ".linked-toggle").addEventListener("click", () => {
      this.toggleLinked();
    });
    required(this.root, ".new-panel").addEventListener("click", () => {
      this.commands.run("new-panel-row");
    });
    required<HTMLInputElement>(this.root, ".signal-search").addEventListener(
      "input",
      (event) => {
        this.tree?.setFilter((event.target as HTMLInputElement).value);
      },
    );
    window.addEventListener("keydown", (event) => {
      if (this.palette?.isOpen() === true) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (this.commands.handleKey(event)) event.preventDefault();
    });
  }

  private plotSignal(path: string, panelId?: string): void {
    let target = panelId ?? this.workspace.focusedPanelId();
    if (target === null || target === undefined) {
      target = this.workspace.addPanelRow().id;
    }
    if (this.workspace.addSeries(target, path)) {
      this.workspace.focusPanel(target);
      this.fitWindowToPlotted();
      this.afterLayoutChange();
    }
  }

  private fitWindowToPlotted(): void {
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const panel of this.workspace.panels()) {
      for (const series of panel.series) {
        const summary = this.signalsByPath.get(series.path);
        if (summary !== undefined) {
          t0 = Math.min(t0, summary.t_min);
          t1 = Math.max(t1, summary.t_max);
        }
      }
    }
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      this.time.setWindow(t0, t1 > t0 ? t1 : t0 + 1);
      const state = this.time.snapshot();
      required(this.root, ".window-readout").textContent =
        `t: ${state.t0.toFixed(3)} → ${state.t1.toFixed(3)} s`;
    }
  }

  private afterLayoutChange(): void {
    this.workspaceView?.sync(this.signals.length > 0);
    void this.refreshTiles();
  }

  private async reloadSignals(): Promise<void> {
    this.signals = await this.plane.listSignals();
    this.signalsByPath = new Map(
      this.signals.map((summary) => [summary.path, summary]),
    );
    this.tree?.setSignals(this.signals.map((summary) => summary.path));
    this.tree?.setFavorites(this.workspace.favorites());
    this.updateStatus();
  }

  private async refreshTiles(): Promise<void> {
    const state = this.time.snapshot();
    const width = Math.max(
      1,
      Math.round(required(this.root, ".workspace").clientWidth),
    );
    const next = new Map<string, TileResponse>();
    await Promise.all(
      this.workspace.panels().map(async (panel) => {
        if (panel.mode !== "time") return;
        const ids = panel.series
          .map((series) => this.signalsByPath.get(series.path)?.signal_id)
          .filter((id): id is string => id !== undefined);
        if (ids.length === 0) return;
        try {
          next.set(
            panel.id,
            await this.plane.queryTiles({
              request_id: crypto.randomUUID(),
              signal_ids: ids,
              window: { t0: state.t0, t1: state.t1 },
              pixel_width: width,
            }),
          );
        } catch (error: unknown) {
          this.reportError(error);
        }
      }),
    );
    this.tilesByPanel = next;
    this.renderTiles();
  }

  private renderTiles(): void {
    const state = this.time.snapshot();
    const elapsed =
      this.workspaceView?.renderTiles(this.tilesByPanel, {
        t0: state.t0,
        t1: state.t1,
      }) ?? 0;
    required(this.root, ".render-ms").textContent = `${elapsed.toFixed(1)} ms`;
  }

  private updateStatus(): void {
    const pointCount = this.signals.reduce(
      (total, signal) => total + Number(signal.point_count),
      0,
    );
    required(this.root, ".signal-count").textContent =
      `${this.signals.length.toLocaleString()} signals`;
    required(this.root, ".point-count").textContent =
      `${pointCount.toLocaleString()} pts`;
    const rows = required(this.root, ".source-rows");
    const row = document.createElement("div");
    row.className = "source-row";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const name = document.createElement("span");
    name.textContent = this.plane.sourceLabel;
    const points = document.createElement("span");
    points.className = "source-points";
    points.textContent = `${pointCount.toLocaleString()} pts`;
    row.append(dot, name, points);
    rows.replaceChildren(row);
  }

  private toggleLinked(): void {
    const linked = !this.time.snapshot().linked;
    this.time.setLinked(linked);
    required(this.root, ".linked-toggle").classList.toggle("active", linked);
  }

  private toggleTheme(): void {
    const documentRoot = document.documentElement;
    documentRoot.dataset.theme =
      documentRoot.dataset.theme === "light" ? "dark" : "light";
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    required(this.root, ".render-ms").textContent = `error: ${message}`;
    console.error(error);
  }
}

function keyHint(keys: string): string {
  return keys === "mod+k" ? "⌘K" : keys.toUpperCase();
}

function shellMarkup(): string {
  return `<main class="workbench">
    <nav class="menu-bar" aria-label="Application menu">
      <span class="brand">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 11 4 5l3 8 3-10 2 6 2-2" fill="none" stroke="var(--amber-7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        SIGNALSCOPE
      </span>
      ${["File", "Edit", "View", "Panel", "Signals", "Export", "Help"]
        .map((item) => `<button class="menu-item">${item}</button>`)
        .join("")}
      <span class="command-hint">commands <kbd>⌘K</kbd></span>
    </nav>

    <div class="tool-bar">
      <button class="tool-button open-files" hidden>Open Files</button>
      <button class="tool-button new-panel">+ Panel</button>
      <span class="tool-divider"></span>
      <button class="tool-button active linked-toggle">⇄ Linked t</button>
      <button class="tool-button theme-toggle" title="Toggle theme (T)">◐</button>
      <span class="tool-spacer"></span>
      <span class="window-label">window</span>
      <span class="window-readout">t: 0.000 → 60.000 s</span>
      <button class="tool-button follow-slot" disabled>⏸ FOLLOW</button>
    </div>

    <aside class="signal-tree" aria-label="Signals">
      <div class="search-wrap">
        <label>/ <input class="signal-search" placeholder="filter signals…" spellcheck="false" /></label>
      </div>
      <div class="tree-heading">★ FAVORITES</div>
      <div class="tree-favorites"></div>
      <div class="tree-heading">SIGNALS</div>
      <div class="tree-scroll"></div>
      <div class="source-footer">
        <div class="ingest-progress" hidden></div>
        <div class="source-rows"></div>
      </div>
    </aside>

    <section class="workspace" aria-label="Panel workspace"></section>

    <form class="formula-bar">
      <span class="formula-mark">ƒx</span>
      <input class="formula-input" aria-label="Derived signal formula" placeholder='derived/name = Math.hypot($("signal/x"), $("signal/y"))' spellcheck="false" />
    </form>

    <footer class="status-bar">
      <span><span class="status-dot"></span> <span class="signal-count">0 signals</span></span>
      <span class="point-count status-value">0 pts</span>
      <span>render <span class="render-ms status-value">— ms</span></span>
      <span>cursor <span class="status-value">t = —</span></span>
      <span class="gesture-hint">drag signal → panel · N = new row · / = filter · ⌘K = commands</span>
      <span class="status-command">⌘K</span>
    </footer>
  </main>`;
}
```

Notes: the toolbar loses the dead "Demo Data" and stub "Σ Stats"/"ƒx Derived"/"Layout" buttons (decision 5; stats and derived return with their features); "Open Files" ships `hidden` and is revealed by Task 6.

- [ ] **Step 8: Style the new chrome** — in `frontend/src/styles/app.css`:

Replace the `.workspace { … }` rule with:

```css
.workspace {
  grid-area: main;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: 1px;
  background: var(--surface-void);
}
```

Replace the `.panel { … }` rule with:

```css
.panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  flex-direction: column;
  background: var(--surface-0);
  border: 1px solid var(--border);
}

.panel.focused {
  box-shadow: inset 0 0 0 1px var(--focus-ring);
}

.panel.drop-target {
  box-shadow: inset 0 0 0 1px var(--amber-7);
}
```

Delete these now-unused rules: `.tree-list`, `.signal-row`, `.signal-row:hover, .signal-row.selected`, `.series-mark`, `.empty-panel`.

Append at the end of the file (before the `@media` block):

```css
.workspace-row {
  display: flex;
  min-width: 0;
  min-height: 0;
}

.seam {
  flex: 0 0 5px;
  transition: background var(--dur-quick) var(--ease-out);
}

.seam-row {
  cursor: row-resize;
}

.seam-col {
  cursor: col-resize;
}

.seam:hover {
  background: var(--surface-3);
}

.panel-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-3);
  font: 10.5px var(--font-mono);
}

.workspace-empty {
  display: grid;
  flex: 1;
  place-content: center;
  gap: 6px;
  color: var(--fg-3);
  text-align: center;
}

.empty-headline {
  font-size: 12px;
}

.empty-hint {
  font: 10px var(--font-mono);
  color: var(--fg-4);
}

.workspace.drop-target {
  outline: 1px solid var(--amber-7);
  outline-offset: -2px;
}

.tree-favorites {
  padding: 0 6px;
}

.tree-scroll {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

.tree-spacer {
  position: relative;
}

.tree-window {
  position: absolute;
  right: 0;
  left: 0;
}

.tree-row {
  display: flex;
  width: 100%;
  height: 22px;
  align-items: center;
  gap: 5px;
  border-radius: 2px;
  color: var(--fg-2);
  font-size: 11px;
  text-align: left;
}

.tree-row:hover {
  background: var(--surface-3);
  color: var(--fg-1);
}

.tree-group {
  color: var(--fg-3);
  font-family: var(--font-mono);
}

.tree-star {
  flex: none;
  padding: 0 2px;
  color: var(--fg-4);
  font-size: 10px;
}

.tree-star.active {
  color: var(--fg-1);
}

.tree-empty {
  padding: 4px 8px;
  color: var(--fg-4);
  font-size: 10.5px;
}

.legend-chip.muted .legend-name {
  opacity: 0.5;
  text-decoration: line-through;
}

.legend-chip.muted .legend-line {
  opacity: 0.35;
}

.ingest-progress {
  padding-bottom: 5px;
  color: var(--fg-2);
  font: 10px var(--font-mono);
}

.palette-overlay {
  position: fixed;
  z-index: 10;
  display: grid;
  place-items: start center;
  padding-top: 12vh;
  background: var(--surface-overlay);
  inset: 0;
}

.palette {
  width: min(560px, 90vw);
  border: 1px solid var(--border-strong);
  background: var(--surface-1);
  box-shadow: 0 8px 30px rgb(0 0 0 / 35%);
}

.palette-input {
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--fg-1);
  font: 13px var(--font-mono);
  outline: 0;
}

.palette-row {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  color: var(--fg-2);
  font-size: 11.5px;
  text-align: left;
}

.palette-row.selected,
.palette-row:hover {
  background: var(--surface-4);
  color: var(--fg-1);
}

.palette-hint {
  color: var(--fg-4);
  font: 10px var(--font-mono);
}

.workbench.formula-collapsed {
  grid-template-rows: 28px 34px minmax(0, 1fr) 0 24px;
}

.workbench.formula-collapsed .formula-bar {
  display: none;
}
```

(Everything is tokens — the light theme keeps working by swap alone. The one literal `rgb(0 0 0 / 35%)` shadow follows the existing dark-shadow convention; if `treefmt`/stylelint objects, drop the `box-shadow` line.)

- [ ] **Step 9: Verify**

Run: `./scripts/test.sh frontend`
Expected: PASS (lint, typecheck, unit tests, snapshot build + artifact checks — the snapshot budget check should still pass; the new UI adds a few kB of JS).

Then run `./scripts/run.sh web` and check by hand at `http://127.0.0.1:4173`: demo boots with one panel plotting two series; `N` adds a row; ⊞ splits; ⤢ maximizes; ✕ closes; clicking a panel moves the amber focus inset; dragging a tree leaf onto a panel adds a legend chip; dragging onto empty workspace background creates a panel; dragging a panel header onto another panel moves it; seams resize; `/` focuses the filter; `⌘K`/`Ctrl+K` opens the palette; `T` swaps theme with no chrome color leaks. **Playwright e2e is temporarily red** (old selectors) — Task 7 fixes it; do not run `./scripts/ci.sh all` yet.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/ui frontend/src/render/canvas-renderer.ts frontend/src/styles/app.css
git commit -m "render a multi-panel workspace with tree, seams, and palette"
```

---

### Task 6: Ingest wiring — Open Files, progress, sources footer

Depends on the data-plane plan (`2026-07-24-07`) Task 7 (`IngestPort`, `runIngest`, `listSources`).

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`

**Interfaces:**

- Consumes: `plane.ingest: IngestPort | null`, `plane.listSources()`, `runIngest(port, path, onProgress)`.
- Produces: an `open-files` command (`O`), visible toolbar button when the port exists, per-source footer rows, and a live progress line during ingest.

- [ ] **Step 1: Wire the command and button**

In `app-shell.ts` add the import:

```ts
import { runIngest } from "../app/ingest";
```

In `registerCommands()`, add first:

```ts
this.commands.register({
  id: "open-files",
  title: "Open files…",
  keys: "o",
  enabled: () => this.plane.ingest !== null,
  run: () => {
    void this.openFiles();
  },
});
```

In `bindControls()`, add:

```ts
const openButton = required<HTMLButtonElement>(this.root, ".open-files");
openButton.hidden = this.plane.ingest === null;
openButton.addEventListener("click", () => {
  this.commands.run("open-files");
});
```

- [ ] **Step 2: Add the ingest flow method** to `AppShell`:

```ts
  private async openFiles(): Promise<void> {
    const port = this.plane.ingest;
    if (port === null) return;
    const progress = required<HTMLElement>(this.root, ".ingest-progress");
    try {
      const paths = await port.pickSources();
      for (const path of paths) {
        const name = path.split(/[\\/]/).at(-1) ?? path;
        progress.hidden = false;
        await runIngest(port, path, (status) => {
          const percent =
            status.fraction > 0 ? `${Math.round(status.fraction * 100)}%` : "…";
          progress.textContent = `${name} · ${status.stage} ${percent}`;
        });
      }
      await this.reloadSignals();
      this.afterLayoutChange();
    } catch (error: unknown) {
      this.reportError(error);
    } finally {
      progress.hidden = true;
    }
  }
```

- [ ] **Step 3: Real source rows** — replace the `.source-rows` block in `updateStatus()` (everything from `const rows = required(...)` to `rows.replaceChildren(row);`) with a call `void this.updateSources();` and add:

```ts
  private async updateSources(): Promise<void> {
    const sources = await this.plane.listSources();
    const rows = required(this.root, ".source-rows");
    rows.replaceChildren(
      ...sources.map((source) => {
        const row = document.createElement("div");
        row.className = "source-row";
        const dot = document.createElement("span");
        dot.className = "status-dot";
        const name = document.createElement("span");
        name.className = "signal-path";
        name.textContent = source.path.split(/[\\/]/).at(-1) ?? source.path;
        name.title = source.path;
        const points = document.createElement("span");
        points.className = "source-points";
        points.textContent = `${Number(source.point_count).toLocaleString()} pts`;
        row.append(dot, name, points);
        return row;
      }),
    );
  }
```

- [ ] **Step 4: Verify**

Run: `./scripts/test.sh frontend` — Expected: PASS.
Manual (needs the data-plane plan merged): `./scripts/run.sh`, press `O`, pick a CSV — progress line cycles decode → pyramid → cache, tree fills, a source row appears with a point count; reopen the app and the same file loads near-instantly from its sidecar. In the browser (`./scripts/run.sh web`), the Open Files button is absent and the palette hides the command (capability port is null).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/app-shell.ts
git commit -m "wire ingest through the open files command"
```

---

### Task 7: End-to-end coverage and the full gate

**Files:**

- Rewrite: `frontend/tests/e2e/app.spec.ts`
- Create: `frontend/tests/e2e/workbench.spec.ts`

- [ ] **Step 1: Rewrite `frontend/tests/e2e/app.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";

test("shared presentation plane renders the demo workspace", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("SIGNALSCOPE")).toBeVisible();
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
  await expect(page.locator(".legend-chip")).toHaveCount(2);
  await expect(page.locator(".plot-canvas").first()).toBeVisible();
  await expect(page.locator(".render-ms")).not.toHaveText("— ms");
  await expect(page.locator(".open-files")).toBeHidden();
});

test("theme is a pure token swap", async ({ page }) => {
  await page.goto("/");
  await page.getByTitle("Toggle theme (T)").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Panel 1 panel")).toBeVisible();
});
```

- [ ] **Step 2: Create `frontend/tests/e2e/workbench.spec.ts`:**

```ts
import { expect, test } from "@playwright/test";

test("panel lifecycle has keyboard and pointer paths", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".panel-empty").last()).toBeVisible();
  await expect(page.locator(".panel").last()).toHaveClass(/focused/);

  await page.locator(".panel").last().locator(".panel-split").click();
  await expect(page.locator(".panel")).toHaveCount(3);

  await page.locator(".panel").last().locator(".panel-close").click();
  await page.locator(".panel").last().locator(".panel-close").click();
  await expect(page.locator(".panel")).toHaveCount(1);
});

test("command palette reaches every command", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.locator(".palette-input").fill("new panel");
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toHaveCount(2);
  await expect(page.locator(".palette-overlay")).toBeHidden();
});

test("tree filters, favorites, and drag-to-plot", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the signal tree is hidden on the mobile breakpoint");
  await page.goto("/");

  await page.keyboard.press("/");
  await expect(page.locator(".signal-search")).toBeFocused();
  await page.locator(".signal-search").fill("body/y");
  await expect(page.locator(".tree-scroll .tree-leaf")).toHaveCount(1);
  await page.locator(".signal-search").fill("");
  await expect(page.locator(".tree-scroll .tree-leaf")).toHaveCount(2);

  await page.locator(".tree-scroll .tree-star").first().click();
  await expect(page.locator(".tree-favorites .tree-leaf")).toHaveCount(1);

  await page.keyboard.press("n");
  const leaf = page.locator(".tree-scroll .tree-leaf").first();
  const target = page.locator(".panel").last();
  await leaf.dragTo(target);
  await expect(target.locator(".legend-chip")).toHaveCount(1);
});

test("seam drag resizes panel rows", async ({ page, isMobile }) => {
  test.skip(isMobile, "seam drags are desktop pointer interactions");
  await page.goto("/");
  await page.keyboard.press("n");

  const first = page.locator(".panel").first();
  const before = (await first.boundingBox())?.height ?? 0;
  const seam = page.locator(".seam-row").first();
  const box = await seam.boundingBox();
  if (box === null) throw new Error("seam not found");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, {
    steps: 5,
  });
  await page.mouse.up();
  const after = (await first.boundingBox())?.height ?? 0;
  expect(after).toBeGreaterThan(before + 40);
});
```

- [ ] **Step 3: Run the e2e suite**

Run: `./scripts/test.sh e2e`
Expected: PASS on both projects (`desktop`, `mobile-review`); the two desktop-only tests report as skipped on mobile. If `dragTo` fails to trigger the HTML5 drop in your Playwright version, replace it with a manual sequence: `leaf.hover()`, `page.mouse.down()`, two `page.mouse.move(...)` steps onto the target's center, `page.mouse.up()` — and if that still fails, drive the drop via `page.dispatchEvent` with a `DataTransfer` constructed in the page.

- [ ] **Step 4: The full gate**

Run: `./scripts/ci.sh all`
Expected: PASS — format, rust, frontend, e2e.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e/app.spec.ts frontend/tests/e2e/workbench.spec.ts
git commit -m "cover the workbench fundamentals end to end"
```

---

### Final handoff checklist

- [ ] `./scripts/ci.sh all` green.
- [ ] Manual pass of the Step-9 checklist from Task 5 in both themes.
- [ ] PR description lists the decision log at the top of this plan for maintainer review, and notes that Task 6 requires the data-plane plan's Task 7.
