# Bundled Series Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ensemble band/spaghetti/single plot pipeline with plain per-source member series plus per-panel source highlights, per `docs/superpowers/specs/2026-07-31-bundled-series-highlights-design.md`.

**Architecture:** Bundles become a tree-only concept: plotting a bundle adds ordinary `SeriesState` entries in one workspace mutation. The entire ensemble pipeline (core module, protocol tiles, shell command, band renderer, tri-state select) is deleted. New session state is a single `highlighted_sources` array on `PanelState` (session v14, with a migration that expands saved band panels into member series). XY mode resolves its X signal per source so bundle members never pair against another run's X values. Snapshot bundle rows are re-sourced from the baked session instead of baked ensembles (protocol v11 removes ensemble types).

**Tech Stack:** Rust 2024 (`scope-core`, `scope-protocol`, Tauri shell), TypeScript/canvas frontend, JSON-schema codegen, Vitest, Playwright.

## Global Constraints

- Every command goes through `./scripts/*`: `./scripts/test.sh [quick|core|shell|unit|frontend|e2e|full] [filter]`, `./scripts/format.sh`, `./scripts/codegen.sh`, `./scripts/version.sh`. Never run `cargo`/`pnpm` directly.
- `protocol/schema/*.json` is the single schema source. Never hand-edit `protocol/src/generated.rs`, `core/scope-core/src/session/generated.rs`, or `frontend/src/generated/*.ts` — change the schema, then run `./scripts/codegen.sh`.
- The codegen hard-errors on any `u64` form other than `u64`/`u64[]`; the new `HighlightedSourceState` uses only `string` fields, so this never triggers. Do not introduce nullable/optional u64 anywhere.
- **UI restraint (binding, from the spec):** no new panel modes, toolbars, dropdowns, per-row selects, preferences, or persisted UI state beyond `highlighted_sources`. Bundle interactions are exactly: expand/collapse, plot (drag/double-click/Enter), and highlight toggle from legend chip or series inspector. A bundle-plotted panel must behave identically to a hand-assembled panel with the same series.
- Display paths are untrusted: always `textContent`, never HTML injection.
- Session changes: breaking changes need a version bump plus a migration rung (ADR 0005). Unknown future versions fail clearly.
- Every task ends with `./scripts/format.sh`, the affected suite, and a commit. Stage only the files the task touched.
- Do not commit new fixture data files; tests construct fixtures inline.

## File Structure

| File                                     | Responsibility after this plan                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `frontend/src/app/tree-model.ts`         | Expandable bundle rows + member children + hierarchical leaves                             |
| `frontend/src/ui/signal-tree.ts`         | Bundle row rendering, expansion state, bundle drag payload                                 |
| `frontend/src/app/workspace.ts`          | `addSeriesBatch`, `toggleHighlight`, highlight cleanup in `removeSeries`                   |
| `frontend/src/ui/app-shell.ts`           | `plotBundle` (replaces `plotSet`), per-source X resolution, highlight wiring               |
| `frontend/src/ui/panel.ts`               | Bundle drop target, highlight dimming, legend highlight mark, inspector action             |
| `frontend/src/render/canvas-renderer.ts` | `dimmed` per-series flags (band code deleted)                                              |
| `frontend/src/app/data-plane.ts`         | `BakedPlane.listSets` derived from baked session (ensemble ports deleted)                  |
| `core/scope-core/src/session.rs`         | v13→14 migration rung expanding band panels                                                |
| `protocol/schema/scope-protocol.json`    | v11, no ensemble types                                                                     |
| `protocol/schema/scope-session.json`     | v14, `highlighted_sources`, no `ensemble`                                                  |
| Deleted                                  | `core/scope-core/src/ensemble.rs`, band renderer, `query_ensemble_tiles`, tri-state select |

---

### Task 1: `Workspace.addSeriesBatch`

**Files:**

- Modify: `frontend/src/app/workspace.ts` (next to `addSeries`, currently line 416)
- Test: `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Consumes: existing `addSeries(panelId: string, path: string): boolean` (slot allocation: smallest unused `color_slot` starting at 1).
- Produces: `addSeriesBatch(panelId: string, paths: readonly string[]): boolean` — adds every path not already present, one method call so callers get one history entry; returns true if anything was added. Task 2's `plotBundle` calls this.

- [ ] **Step 1: Write the failing test** (append to `workspace.test.ts`, following its existing setup pattern for creating a workspace and panel):

```ts
it("addSeriesBatch adds all new paths in one call and skips duplicates", () => {
  const workspace = new WorkspaceModel(); // match the construction used by neighboring tests
  const panel = workspace.addPanelRow();
  workspace.addSeries(panel.id, "run_01/alt");
  const added = workspace.addSeriesBatch(panel.id, [
    "run_01/alt",
    "run_02/alt",
    "run_03/alt",
  ]);
  expect(added).toBe(true);
  const series = workspace.panel(panel.id)?.series ?? [];
  expect(series.map((entry) => entry.path)).toEqual([
    "run_01/alt",
    "run_02/alt",
    "run_03/alt",
  ]);
  expect(new Set(series.map((entry) => entry.color_slot)).size).toBe(3);
  expect(workspace.addSeriesBatch(panel.id, ["run_02/alt"])).toBe(false);
});
```

- [ ] **Step 2: Run it, verify it fails** — `./scripts/test.sh unit workspace` — expect FAIL: `addSeriesBatch is not a function`.

- [ ] **Step 3: Implement** in `workspace.ts` directly below `addSeries`:

```ts
addSeriesBatch(panelId: string, paths: readonly string[]): boolean {
  let added = false;
  for (const path of paths) {
    if (this.addSeries(panelId, path)) added = true;
  }
  return added;
}
```

- [ ] **Step 4: Run** `./scripts/test.sh unit workspace` — expect PASS.
- [ ] **Step 5: Commit** — `git add frontend/src/app/workspace.ts frontend/src/app/workspace.test.ts && git commit -m "feat(workspace): add one-mutation series batch"`

---

### Task 2: Plot bundles as member series; delete the band/spaghetti/single UI and ensemble render path

This is a deletion-plus-rewire task. The generated ensemble _types_ still exist until Task 5; this task removes every frontend _use_ of them.

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`, `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/panel.ts`, `frontend/src/ui/workspace-view.ts`, `frontend/src/render/canvas-renderer.ts`, `frontend/src/app/data-plane.ts`
- Test: `frontend/src/ui/panel.test.ts`, `frontend/src/render/canvas-renderer.test.ts`, `frontend/src/app/data-plane.test.ts`

**Interfaces:**

- Consumes: `addSeriesBatch` from Task 1.
- Produces: `SignalTreeCallbacks.onPlotBundle(localPath: string, memberPaths: readonly string[]): void` (replaces `onPlotSet`); `AppShell.plotBundle(memberPaths: readonly string[], panelId?: string): void`; `PanelView.renderData(state, tiles, samples, window)` (no ensemble parameter); `WorkspaceView.renderData(tiles, samples, windowFor, missingFor)` (no ensembles map). Tasks 8 and 11 build on these.

- [ ] **Step 1: Delete, in this order (symbol names are authoritative; line numbers are current locations):**
  - `app-shell.ts`: the `ensemblesByPanel` field (:109), the `plotSet` method (:1122-1159), the ensemble branch at the top of `refreshTiles` (:1868-1893) and `nextEnsembles` (:1861-1864, :1944), the `ensemblesByPanel` argument passed to `workspaceView.renderData` (:1988), the `panel.ensemble = null` line in `plotSignal` (:1114), the `spaghettiSeries` import (:74), and every `EnsembleTileResponse` import.
  - `panel.ts`: `PanelSeriesKind` and `spaghettiSeries` (:64-70), `lastEnsemble` (:153-156), the `ensemble` parameter and branch in `renderData` (:464-479 — the body becomes `renderForMode` unconditionally), `renderBand` (:491-518), the `lastEnsemble` argument in `setEmphasis`'s replay (:1420).
  - `workspace-view.ts`: the ensembles map parameter and pass-through (:4, :113-134).
  - `canvas-renderer.ts`: `EnsembleRenderOptions` (:73-80), `drawEnsembleBand` (:82-137), `withAlpha` (:139-143, orphaned), `renderEnsemble` (:310-331).
  - `data-plane.ts`: `queryEnsembleTiles` on the `DataPlane` port (:136-138), `TauriPlane.queryEnsembleTiles` (:405-416), `BakedPlane.queryEnsembleTiles` (:571-607). Leave `BakedPlane.listSets` alone — Task 3 rewrites it.
  - Delete the ensemble test blocks that referenced these: `panel.test.ts:5-17`, `canvas-renderer.test.ts` band cases (the file's ensemble describe block), `data-plane.test.ts:174-260` ensemble cases.

- [ ] **Step 2: Rewire bundle plotting.** In `signal-tree.ts`: replace `onPlotSet` in `SignalTreeCallbacks` (:8-12) with `onPlotBundle(localPath: string, memberPaths: readonly string[]): void`; delete the mode `<select>` (:213-232) keeping the run-count badge; change the dblclick/Enter handlers (:177, :186) to `this.callbacks.onPlotBundle?.(path, memberPaths)`. In `app-shell.ts`, replace the `onPlotSet` wiring (:331-333) with:

```ts
onPlotBundle: (localPath, memberPaths) => {
  this.plotBundle(memberPaths);
},
```

and add, where `plotSet` used to be:

```ts
private plotBundle(memberPaths: readonly string[], panelId?: string): void {
  let target = panelId ?? this.workspace.focusedPanelId();
  if (target === null) target = this.workspace.addPanelRow().id;
  if (this.workspace.addSeriesBatch(target, memberPaths)) {
    this.workspace.focusPanel(target);
    this.fitWindowToPlotted();
    this.afterLayoutChange();
  }
}
```

(`localPath` is unused here until Task 11 wires highlights; keep the callback parameter — the tree needs it for drag payloads in Task 8.)

- [ ] **Step 3: Verify no stragglers.** Run: `grep -rn "spaghetti\|PanelSeriesKind\|renderBand\|ensemblesByPanel\|queryEnsembleTiles\|renderEnsemble\|drawEnsembleBand" frontend/src` — expect zero hits. (`panel.ensemble`/`EnsembleSeriesState` in `workspace.ts`, `baked-session.ts`, and generated files remain until Tasks 3 and 6.)
- [ ] **Step 4: Run** `./scripts/test.sh frontend` — expect PASS (lint, typecheck, codegen check, unit, snapshot artifact).
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): plot bundles as ordinary member series, drop the band pipeline"`

---

### Task 3: Re-source `BakedPlane.listSets` from the baked session

**Files:**

- Modify: `frontend/src/app/data-plane.ts:508-545`, `frontend/src/app/baked-session.ts:133-157`
- Test: `frontend/src/app/data-plane.test.ts`

**Interfaces:**

- Consumes: `parseBakedSession(json).source_sets` (`SourceSetState[]`: `key`, `label`, `generation`, `time_domain`, `members: {source_key, missing, scale, offset}[]`), `this.payload.signals[].summary` (`SignalSummary`: `source_key`, `local_path`, `path`).
- Produces: `BakedPlane.listSets(): Promise<SetSummary[]>` with the same shape as the live plane, derived without baked ensembles. Bundle rows in snapshots depend on this.

- [ ] **Step 1: Write the failing test.** In `data-plane.test.ts`, build a `BakedPlane` (follow the file's existing baked payload fixture helper) whose payload has signals from two sources (`source_key` `"k1"`/`"k2"`, prefixes `run_01`/`run_02`, both with `local_path: "alt"`, and `"k1"` alone with `local_path: "solo"`) and a baked session whose `source_sets` is one set with members `k1`, `k2`. The payload's `ensembles` array is empty. Assert:

```ts
const sets = await plane.listSets();
expect(sets).toHaveLength(1);
expect(sets[0]?.set_key).toBe("set-key-1");
expect(sets[0]?.member_count).toBe(2);
expect(sets[0]?.local_paths).toEqual(["alt"]); // shared by ≥2 members; "solo" excluded
expect(sets[0]?.members.map((m) => m.source_key)).toEqual(["k1", "k2"]);
```

- [ ] **Step 2: Run** `./scripts/test.sh unit data-plane` — expect FAIL (current implementation returns `[]` when no ensembles are baked).
- [ ] **Step 3: Implement.** Replace `listSets` (:508-545) with:

```ts
listSets(): Promise<SetSummary[]> {
  const saved = parseBakedSession(this.bakedSessionJson).source_sets;
  return Promise.resolve(
    saved.map((set, index) => {
      const memberKeys = new Set(set.members.map((member) => member.source_key));
      const localsBySource = new Map<string, Set<string>>();
      for (const signal of this.payload.signals) {
        if (!memberKeys.has(signal.summary.source_key)) continue;
        const locals =
          localsBySource.get(signal.summary.source_key) ?? new Set<string>();
        locals.add(signal.summary.local_path);
        localsBySource.set(signal.summary.source_key, locals);
      }
      const counts = new Map<string, number>();
      for (const locals of localsBySource.values()) {
        for (const local of locals) {
          counts.set(local, (counts.get(local) ?? 0) + 1);
        }
      }
      return {
        set_id: String(index + 1),
        set_key: set.key,
        label: set.label,
        generation: set.generation,
        member_count: set.members.length,
        members: set.members,
        time_domain: set.time_domain,
        local_paths: [...counts]
          .filter(([, count]) => count >= 2)
          .map(([local]) => local)
          .sort((left, right) => left.localeCompare(right)),
        aligned: true,
      };
    }),
  );
}
```

- [ ] **Step 4:** In `baked-session.ts`, delete the `isEnsemble` validator (:133-141) and change the panel check at :157 from `isNullable(value.ensemble, isEnsemble)` to validate nothing about `ensemble` (drop the clause entirely; `highlighted_sources` validation is added in Task 6).
- [ ] **Step 5: Run** `./scripts/test.sh unit data-plane && ./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "fix(snapshot): derive set metadata from the baked session"`

---

### Task 4: Delete the ensemble core module, snapshot planning, benchmark, and shell command

**Files:**

- Delete: `core/scope-core/src/ensemble.rs`
- Modify: `core/scope-core/src/lib.rs:11`, `core/scope-core/src/snapshot.rs`, `core/scope-core/src/benchmarks.rs`, `core/scope-core/src/restore.rs:222`, `shell/src-tauri/src/lib.rs`, `core/scope-core/src/bin/scope-bake.rs` (compile fallout only)

**Interfaces:**

- Consumes: nothing new.
- Produces: `SnapshotPlan` without an `ensembles` field; `scope-core` without `pub mod ensemble`. Task 5 removes the wire types these used.

- [ ] **Step 1: Delete** `core/scope-core/src/ensemble.rs` and the `pub mod ensemble;` line in `lib.rs`.
- [ ] **Step 2:** In `snapshot.rs`, delete `plan_ensembles` (:303-395), `ensemble_window` (:397-423), `ensemble_bin` (:425-436), the `ensembles` field on `SnapshotPlan` (:52), `SnapshotError::Ensemble` (:73-74), the call sites (:253-254, :299), the ensemble byte accounting (:551-557), the `ensemble_panel` test helper (:677-691), and the four ensemble tests (:1154-1277). In `benchmarks.rs`, delete the ensemble benchmark (:86-138) and its fixture (:140-185). In `restore.rs`, delete the `ensemble: None` initializer (:222) — it stops compiling anyway after Task 6; here just remove the line if the struct still requires it, otherwise leave for Task 6.
- [ ] **Step 3:** In `shell/src-tauri/src/lib.rs`, delete the `materialized_sets` field on `DataState` (:52), the `query_ensemble_tiles` command (:817-906), and its entry in the command registration list (:1632). Fix any remaining compile fallout in `scope-bake.rs` and the shell export command (they consume `SnapshotPlan`; drop their ensemble handling).
- [ ] **Step 4: Verify** — `grep -rn "ensemble\|Ensemble" core/scope-core/src shell/src-tauri/src --include=*.rs | grep -v generated` — remaining hits must be only `session.rs` (golden fixture, fixed in Task 6). Then run `./scripts/test.sh core && ./scripts/test.sh shell` — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "refactor(core): delete the ensemble query and baking pipeline"`

---

### Task 5: Protocol v11 — remove ensemble wire types

**Files:**

- Modify: `protocol/schema/scope-protocol.json`, `protocol/src/lib.rs:9-24`
- Regenerate: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts` (via `./scripts/codegen.sh` only)

**Interfaces:**

- Produces: protocol v11 with no `EnsembleBin`, `EnsembleTileRequest`, `EnsembleTileResponse`, `BakedEnsemble`; `SnapshotManifest` = `{session_json, signals}`.

- [ ] **Step 1:** In `scope-protocol.json`: set `"protocol_version": 11` (line 2); delete the `EnsembleBin` (:11-22), `EnsembleTileRequest` (:23-33), `EnsembleTileResponse` (:34-43), and `BakedEnsemble` (:427-437) type definitions; delete `"ensembles": "BakedEnsemble[]"` from `SnapshotManifest` (:443).
- [ ] **Step 2: Run** `./scripts/codegen.sh`.
- [ ] **Step 3:** `protocol/src/lib.rs`'s only test (:9-24) exercised the ensemble request; replace it with an equivalent round-trip over an ordinary tile request so the crate keeps a serde smoke test:

```rust
#[test]
fn tile_request_round_trips() {
    let request = TileRequest {
        request_id: "r1".into(),
        signal_ids: vec![7],
        window: TimeWindow { t0: 0.0, t1: 1.0 },
        pixel_width: 640,
    };
    let json = serde_json::to_string(&request).expect("serializes");
    let back: TileRequest = serde_json::from_str(&json).expect("deserializes");
    assert_eq!(back.signal_ids, vec![7]);
}
```

(Adjust field names to match `protocol/src/generated.rs` exactly — read the regenerated `TileRequest` before writing the test.)

- [ ] **Step 4: Fix fallout.** Run `grep -rn "ensembles" frontend shell core protocol --include=*.ts --include=*.rs --include=*.mjs | grep -v node_modules | grep -v generated` and remove every remaining consumer of the manifest field (the baked payload construction in the shell export path and `frontend/scripts/build-snapshot.mjs` if it stubs the field; `BakedPlane`'s payload type comes from codegen and needs no edit).
- [ ] **Step 5: Run** `./scripts/test.sh quick && ./scripts/test.sh shell` — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol)!: v11 removes ensemble tiles and baking"`

---

### Task 6: Session v14 — `highlighted_sources`, drop `ensemble`, migrate band panels

**Files:**

- Modify: `protocol/schema/scope-session.json`, `core/scope-core/src/session.rs`, `protocol/testdata/session-conformance.json`, `frontend/src/app/baked-session.ts`, `frontend/src/app/workspace.ts` (panel construction site that sets `ensemble: null`), `core/scope-core/src/restore.rs` (if not already clean from Task 4)
- Regenerate: session generated Rust/TS via `./scripts/codegen.sh`
- Test: `core/scope-core/src/session.rs` (inline), `frontend/src/app/session-conformance.test.ts` (existing, updated fixture)

**Interfaces:**

- Produces: `PanelState.highlighted_sources: HighlightedSourceState[]` (required), `HighlightedSourceState { local_path: string, path: string }`; no `PanelState.ensemble`, no `EnsembleSeriesState`. Tasks 9–11 consume `highlighted_sources`.

- [ ] **Step 1:** In `scope-session.json`: set `"schema_version": 14`; delete `EnsembleSeriesState` (:61-68); in `PanelState` delete `"ensemble": "EnsembleSeriesState?"` and add `"highlighted_sources": "HighlightedSourceState[]"`; add:

```json
"HighlightedSourceState": {
  "kind": "object",
  "fields": {
    "local_path": "string",
    "path": "string"
  }
}
```

- [ ] **Step 2: Run** `./scripts/codegen.sh`.
- [ ] **Step 3: Write the failing migration test** in `session.rs`'s test module (a pure-JSON fixture; note the v13 golden fixture at :454-458 that sets `ensemble: Some(...)` must move into this test's JSON, since the struct field no longer exists):

```rust
#[test]
fn v13_band_panels_expand_to_member_series() {
    let json = serde_json::json!({
        "app": "signalscope", "schema_version": 13,
        "theme": "dark",
        "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
        "active_tab_id": "tab-1",
        "tabs": [{
            "id": "tab-1", "title": "Tab", "cursor_mode": "none",
            "focused_panel_id": null, "maximized_panel_id": null,
            "layout": [],
            "panels": [{
                "id": "p1", "title": "Band", "mode": "time", "axis_style": "gutter",
                "x_signal": null, "color_signal": null, "color_by_time": false,
                "series": [{"path": "run_01/alt", "color_slot": 1, "dash": "solid", "width": 1.4, "visible": true}],
                "ensemble": {"set_key": "set-1", "local_path": "alt", "member_filter": []},
                "y_range": null, "x_range": null, "x_label": null, "y_label": null,
                "c_label": null, "time_window": null, "annotations": [], "show_stats": false
            }]
        }],
        "favorites": [], "derived": [],
        "sources": [
            {"key": "k1", "path": "/data/run_01.csv", "prefix": "run_01", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false},
            {"key": "k2", "path": "/data/run_02.csv", "prefix": "run_02", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false},
            {"key": "k3", "path": "/data/run_03.csv", "prefix": "run_03", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false}
        ],
        "source_sets": [{
            "key": "set-1", "label": "Runs", "generation": 1,
            "time_domain": {"unit": "seconds", "origin": "relative", "alignment_origin": 0.0},
            "members": [
                {"source_key": "k1", "missing": [], "scale": 1.0, "offset": 0.0},
                {"source_key": "k2", "missing": [], "scale": 1.0, "offset": 0.0},
                {"source_key": "k3", "missing": ["alt"], "scale": 1.0, "offset": 0.0}
            ]
        }]
    });
    let session = from_json(&json.to_string()).expect("v13 migrates");
    let panel = &session.tabs[0].panels[0];
    // run_01/alt already present (not duplicated); run_02/alt added; run_03 skipped (missing "alt").
    let paths: Vec<&str> = panel.series.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(paths, vec!["run_01/alt", "run_02/alt"]);
    assert_eq!(panel.series[1].color_slot, 2); // smallest free slot after 1
    assert!(panel.highlighted_sources.is_empty());
}
```

Also add a companion test: a panel with `"ensemble"` whose `set_key` matches nothing migrates to just its explicit series and an empty `highlighted_sources` (no panic, no expansion).

- [ ] **Step 4: Run** `./scripts/test.sh core session` — expect FAIL (v13 currently unsupported / struct mismatch).
- [ ] **Step 5: Implement the rung.** In `migrate` (session.rs:111): the pass-through arm `3 | 4 | 7 | 12` stays; add:

```rust
13 => {
    migrate_v13_ensembles(&mut value);
    value["schema_version"] = serde_json::json!(14);
    migrate(14, value)
}
```

and the transform (pure JSON, no filesystem — mirror `addSeries` slot allocation: smallest unused slot starting at 1):

```rust
fn migrate_v13_ensembles(value: &mut serde_json::Value) {
    let prefixes: std::collections::BTreeMap<String, String> = value
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .filter_map(|source| {
                    Some((
                        source.get("key")?.as_str()?.to_owned(),
                        source.get("prefix")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let sets = value
        .get("source_sets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    for_each_panel(value, |panel| {
        let ensemble = panel
            .as_object_mut()
            .and_then(|object| object.remove("ensemble"))
            .unwrap_or(serde_json::Value::Null);
        if let Some(object) = panel.as_object_mut() {
            object.insert("highlighted_sources".into(), serde_json::json!([]));
        }
        let Some(ensemble) = ensemble.as_object() else {
            return;
        };
        let (Some(set_key), Some(local_path)) = (
            ensemble.get("set_key").and_then(serde_json::Value::as_str),
            ensemble.get("local_path").and_then(serde_json::Value::as_str),
        ) else {
            return;
        };
        let member_filter: Vec<&str> = ensemble
            .get("member_filter")
            .and_then(serde_json::Value::as_array)
            .map(|keys| keys.iter().filter_map(serde_json::Value::as_str).collect())
            .unwrap_or_default();
        let Some(set) = sets.iter().find(|set| {
            set.get("key").and_then(serde_json::Value::as_str) == Some(set_key)
        }) else {
            return;
        };
        let mut member_paths: Vec<String> = set
            .get("members")
            .and_then(serde_json::Value::as_array)
            .map(|members| {
                members
                    .iter()
                    .filter_map(|member| {
                        let source_key = member.get("source_key")?.as_str()?;
                        if !member_filter.is_empty() && !member_filter.contains(&source_key) {
                            return None;
                        }
                        let missing = member.get("missing")?.as_array()?;
                        if missing.iter().filter_map(serde_json::Value::as_str).any(|path| path == local_path) {
                            return None;
                        }
                        let prefix = prefixes.get(source_key)?;
                        Some(format!("{prefix}/{local_path}"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        member_paths.sort();
        let Some(series) = panel.get_mut("series").and_then(serde_json::Value::as_array_mut) else {
            return;
        };
        let existing: std::collections::BTreeSet<String> = series
            .iter()
            .filter_map(|entry| entry.get("path").and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .collect();
        let mut used: std::collections::BTreeSet<u64> = series
            .iter()
            .filter_map(|entry| entry.get("color_slot").and_then(serde_json::Value::as_u64))
            .collect();
        for path in member_paths {
            if existing.contains(&path) {
                continue;
            }
            let mut slot = 1;
            while used.contains(&slot) {
                slot += 1;
            }
            used.insert(slot);
            series.push(serde_json::json!({
                "path": path,
                "color_slot": slot,
                "dash": "solid",
                "width": 1.4,
                "visible": true
            }));
        }
    });
}
```

(Check `for_each_panel`'s exact closure signature at session.rs:319 before writing; adjust `panel` access to match.)

- [ ] **Step 6: Fix fallout.** Update the golden fixture at session.rs:454-458 (delete the `ensemble: Some(...)` struct construction — the struct field is gone; if the fixture needs ensemble coverage it now lives in the Step 3 JSON test). Delete `ensemble: None` initializers in `restore.rs` and `frontend/src/app/workspace.ts:644` and add `highlighted_sources: []` / `highlighted_sources: Vec::new()` where panels are constructed. Update `protocol/testdata/session-conformance.json` to v14: every panel gains `"highlighted_sources": []` and loses `"ensemble"`. In `baked-session.ts`, validate the new field where the `ensemble` clause was removed in Task 3: `isArrayOf(value.highlighted_sources, isHighlightedSource)` with `isHighlightedSource` checking `local_path` and `path` are strings (follow the file's existing validator style).
- [ ] **Step 7: Run** `./scripts/test.sh quick && ./scripts/test.sh shell` — expect PASS (includes the session conformance tests on both sides).
- [ ] **Step 8: Commit** — `git commit -m "feat(session)!: v14 highlighted sources, band panels expand on migration"`

---

### Task 7: Tree model — expandable bundles with member children

**Files:**

- Modify: `frontend/src/app/tree-model.ts`
- Test: `frontend/src/app/tree-model.test.ts`

**Interfaces:**

- Produces:

```ts
interface TreeBundle {
  kind: "bundle";
  path: string;          // the local path
  label: string;
  depth: 0;
  runCount: number;
  memberPaths: string[]; // sorted full paths
  expanded: boolean;
}
export type TreeRow = TreeLeaf | TreeGroup | TreeBundle;
// TreeLeaf loses runCount/memberPaths (the old flat-bundle fields).
buildTreeRows(paths, collapsed, filter,
  options?: { setPrefixes: readonly string[]; expandedBundles: ReadonlySet<string> }): TreeRow[]
```

Member children are `TreeLeaf` rows with `depth: 1`, `path` = full path, `label` = the source prefix. Task 8 renders these.

- [ ] **Step 1: Write the failing tests** (replace the existing flat-bundle tests in `tree-model.test.ts`):

```ts
const paths = ["run_01/alt", "run_02/alt", "run_01/solo", "misc/other"];
const opts = {
  setPrefixes: ["run_01", "run_02"],
  expandedBundles: new Set<string>(),
};

it("collapsed bundles show one row with a count; non-bundled paths keep the tree", () => {
  const rows = buildTreeRows(paths, new Set(), "", opts);
  const bundle = rows.find((row) => row.kind === "bundle");
  expect(bundle).toMatchObject({ path: "alt", runCount: 2, expanded: false });
  // run_01/solo has one member; misc/other has no set prefix — both fall through
  // to the ordinary hierarchical rows.
  expect(
    rows.some((row) => row.kind === "leaf" && row.path === "run_01/solo"),
  ).toBe(true);
  expect(
    rows.some((row) => row.kind === "leaf" && row.path === "misc/other"),
  ).toBe(true);
});

it("expanded bundles list members labeled by source prefix", () => {
  const rows = buildTreeRows(paths, new Set(), "", {
    ...opts,
    expandedBundles: new Set(["alt"]),
  });
  const children = rows.filter((row) => row.kind === "leaf" && row.depth === 1);
  expect(children.map((row) => [row.path, row.label])).toEqual([
    ["run_01/alt", "run_01"],
    ["run_02/alt", "run_02"],
  ]);
});

it("search matches bundle paths and member labels", () => {
  const byBundle = buildTreeRows(paths, new Set(), "alt", opts);
  expect(byBundle.some((row) => row.kind === "bundle")).toBe(true);
  const byMember = buildTreeRows(paths, new Set(), "run_02", {
    ...opts,
    expandedBundles: new Set(["alt"]),
  });
  const children = byMember.filter(
    (row) => row.kind === "leaf" && row.depth === 1,
  );
  expect(children.map((row) => row.path)).toEqual(["run_02/alt"]);
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit tree-model` — expect FAIL.
- [ ] **Step 3: Implement.** Replace the `options !== undefined` branch of `buildTreeRows` (:27-50) with:

```ts
if (options !== undefined && options.setPrefixes.length > 0) {
  const grouped = new Map<string, string[]>();
  const rest: string[] = [];
  for (const path of paths) {
    const prefix = options.setPrefixes.find((item) =>
      path.startsWith(`${item}/`),
    );
    if (prefix === undefined) {
      rest.push(path);
      continue;
    }
    const localPath = path.slice(prefix.length + 1);
    const members = grouped.get(localPath) ?? [];
    members.push(path);
    grouped.set(localPath, members);
  }
  const rows: TreeRow[] = [];
  for (const [localPath, memberPaths] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (memberPaths.length < 2) {
      rest.push(...memberPaths);
      continue;
    }
    const bundleMatches =
      query === "" || localPath.toLowerCase().includes(query);
    const matchingMembers = bundleMatches
      ? memberPaths
      : memberPaths.filter((path) => path.toLowerCase().includes(query));
    if (!bundleMatches && matchingMembers.length === 0) continue;
    const sorted = [...memberPaths].sort();
    const expanded = options.expandedBundles.has(localPath);
    rows.push({
      kind: "bundle",
      path: localPath,
      label: localPath,
      depth: 0,
      runCount: sorted.length,
      memberPaths: sorted,
      expanded,
    });
    if (expanded) {
      for (const member of [...matchingMembers].sort()) {
        rows.push({
          kind: "leaf",
          path: member,
          label: member.slice(0, member.length - localPath.length - 1),
          depth: 1,
        });
      }
    }
  }
  return [...rows, ...buildTreeRows(rest.sort(), collapsed, filter)];
}
```

- [ ] **Step 4: Run** `./scripts/test.sh unit tree-model` — expect PASS. Fix any type fallout in `signal-tree.ts` minimally (Task 8 finishes it): the old `runCount`/`memberPaths` leaf fields are gone.
- [ ] **Step 5: Run** `./scripts/test.sh frontend`, then commit — `git commit -m "feat(tree): expandable bundle rows with member children"`

---

### Task 8: Tree view — bundle rows, expansion, drag payloads; panel accepts bundle drops

**Files:**

- Modify: `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/panel.ts` (drop handling, :335-356; `SIGNAL_DRAG_TYPE` is at :60), `frontend/src/ui/app-shell.ts` (callback wiring), `frontend/src/styles/app.css` (bundle row caret/badge styling reusing existing tree tokens)
- Test: `frontend/src/ui/panel.test.ts` (drag-payload constants), tree behavior is covered by Task 7's model tests plus e2e in Task 13

**Interfaces:**

- Produces: `export const BUNDLE_DRAG_TYPE = "application/x-signalscope-bundle"` (in `panel.ts` next to `SIGNAL_DRAG_TYPE`); drag payload is `JSON.stringify({ local_path: string, member_paths: string[] })`; `PanelCallbacks.onDropBundle(id: string, memberPaths: string[]): void`.

- [ ] **Step 1:** In `signal-tree.ts`, render `kind === "bundle"` rows in `rowElement`: a div styled like `tree-leaf` with a leading caret button (`▸`/`▾`) that toggles a new `private readonly expandedBundles = new Set<string>()` (add/delete `row.path`, then `this.refresh()`), the local-path label, and the existing `tree-run-count` badge. Pass `expandedBundles` through `refresh()` into `buildTreeRows`'s options. The row: `draggable = true`; on `dragstart`, `event.dataTransfer?.setData(BUNDLE_DRAG_TYPE, JSON.stringify({ local_path: row.path, member_paths: row.memberPaths }))`; on dblclick/Enter, `this.callbacks.onPlotBundle?.(row.path, row.memberPaths)`. All text via `textContent`. Member rows are plain leaves (Task 7 already labels them); the favorites star keeps working on them (leaf `path` is the full path).
- [ ] **Step 2:** In `panel.ts`, extend the panel drop target (:335-356): `dragover` accepts `SIGNAL_DRAG_TYPE` **or** `BUNDLE_DRAG_TYPE`; in `drop`, first check `dragData(event, BUNDLE_DRAG_TYPE)` — if present, parse inside `try/catch`, validate `member_paths` is an array of strings, and call `this.callbacks.onDropBundle(this.id, payload.member_paths)`; a malformed payload is ignored. Bundle drops never hit the X-axis strip path (`asX` applies to single signals only).
- [ ] **Step 3:** In `app-shell.ts`, wire `onDropBundle: (id, memberPaths) => { this.plotBundle(memberPaths, id); }` in the panel callbacks object (next to `onDropSignal`, :189).
- [ ] **Step 4: Write the guard test** in `panel.test.ts`:

```ts
it("bundle drag type is distinct from the signal drag type", () => {
  expect(BUNDLE_DRAG_TYPE).not.toBe(SIGNAL_DRAG_TYPE);
  expect(BUNDLE_DRAG_TYPE.startsWith("application/x-signalscope")).toBe(true);
});
```

- [ ] **Step 5: Run** `./scripts/test.sh frontend` — expect PASS. Commit — `git commit -m "feat(tree): draggable bundles with distinct drop payloads"`

---

### Task 9: Workspace highlight mutations

**Files:**

- Modify: `frontend/src/app/workspace.ts` (`removeSeries` is at :535)
- Test: `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Produces: `toggleHighlight(panelId: string, path: string, localPath: string): void` — sets `{local_path: localPath, path}` as the panel's single highlight for that local path; toggling the already-highlighted path clears it; ignores paths not in `panel.series`. `removeSeries` clears highlight entries whose `path` matches. Tasks 10–11 consume `panel.highlighted_sources`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("keeps at most one highlight per local path and toggles off", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.addSeriesBatch(panel.id, [
    "run_01/alt",
    "run_02/alt",
    "run_01/gyro",
  ]);
  workspace.toggleHighlight(panel.id, "run_01/alt", "alt");
  workspace.toggleHighlight(panel.id, "run_01/gyro", "gyro");
  workspace.toggleHighlight(panel.id, "run_02/alt", "alt"); // replaces run_01/alt
  expect(workspace.panel(panel.id)?.highlighted_sources).toEqual([
    { local_path: "gyro", path: "run_01/gyro" },
    { local_path: "alt", path: "run_02/alt" },
  ]);
  workspace.toggleHighlight(panel.id, "run_02/alt", "alt"); // toggles off
  expect(workspace.panel(panel.id)?.highlighted_sources).toEqual([
    { local_path: "gyro", path: "run_01/gyro" },
  ]);
  workspace.toggleHighlight(panel.id, "not/plotted", "alt"); // ignored
  expect(workspace.panel(panel.id)?.highlighted_sources).toHaveLength(1);
});

it("removing a series clears its highlight", () => {
  const workspace = new WorkspaceModel();
  const panel = workspace.addPanelRow();
  workspace.addSeriesBatch(panel.id, ["run_01/alt", "run_02/alt"]);
  workspace.toggleHighlight(panel.id, "run_01/alt", "alt");
  workspace.removeSeries(panel.id, "run_01/alt");
  expect(workspace.panel(panel.id)?.highlighted_sources).toEqual([]);
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit workspace` — expect FAIL.
- [ ] **Step 3: Implement** next to the other series mutations:

```ts
toggleHighlight(panelId: string, path: string, localPath: string): void {
  const panel = this.panel(panelId);
  if (panel === undefined) return;
  if (!panel.series.some((series) => series.path === path)) return;
  const current = panel.highlighted_sources.find(
    (entry) => entry.local_path === localPath,
  );
  panel.highlighted_sources = panel.highlighted_sources.filter(
    (entry) => entry.local_path !== localPath,
  );
  if (current === undefined || current.path !== path) {
    panel.highlighted_sources.push({ local_path: localPath, path });
  }
}
```

and inside `removeSeries` (after the series is removed): `panel.highlighted_sources = panel.highlighted_sources.filter((entry) => entry.path !== path);`

- [ ] **Step 4: Run** `./scripts/test.sh unit workspace` — expect PASS. Commit — `git commit -m "feat(workspace): per-bundle highlight mutations"`

---

### Task 10: Renderer — per-series dim flags

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts` (`render` at :274-308; the dim decision is the last two arguments to `drawSeries` at :301-304)
- Test: `frontend/src/render/canvas-renderer.test.ts`

**Interfaces:**

- Produces: `RenderOptions.dimmed?: readonly boolean[]` — series `i` draws dimmed when `dimmed[i]` is true; `emphasisIndex` (hover) keeps its existing behavior and takes precedence when set. Task 11 supplies the array.

- [ ] **Step 1: Write the failing test** (follow the file's existing pattern of rendering into a stub context and asserting on recorded draw calls — read the surviving tests first; they already assert on per-series alpha/width):

```ts
it("dims exactly the flagged series and hover emphasis overrides dim flags", () => {
  // three series; dimmed = [true, false, true]
  // assert series 0 and 2 draw dimmed, series 1 normal;
  // then render again with emphasisIndex: 2 and the same dimmed array —
  // assert series 2 draws emphasized and 0, 1 draw dimmed (hover wins).
});
```

Write the real assertions against whatever observable the existing renderer tests use (they instantiate `CanvasRenderer` against a recorded 2D context; mirror the surviving `render` test's structure exactly).

- [ ] **Step 2: Run** `./scripts/test.sh unit canvas-renderer` — expect FAIL.
- [ ] **Step 3: Implement.** In `render`, replace the dim expression:

```ts
const hoverActive = options.emphasisIndex !== undefined;
// per series index:
const dim = hoverActive
  ? options.emphasisIndex !== index
  : (options.dimmed?.[index] ?? false);
```

and pass `dim` as `drawSeries`'s final argument; the `+0.4` width bonus stays tied to `emphasisIndex === index`.

- [ ] **Step 4: Run** `./scripts/test.sh unit canvas-renderer` — expect PASS. Commit — `git commit -m "feat(render): per-series dim flags for source highlights"`

---

### Task 11: Highlight UI — legend mark, inspector action, dim wiring

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`updateLegend`/`legendChip` at :1326-1410, `openInspector` at :1426, time-mode render options at :574-578), `frontend/src/ui/app-shell.ts` (panel callback wiring near :189), `frontend/src/styles/app.css`
- Test: `frontend/src/ui/panel.test.ts`

**Interfaces:**

- Consumes: `toggleHighlight` (Task 9), `RenderOptions.dimmed` (Task 10), `panel.highlighted_sources` (Task 6).
- Produces: `PanelCallbacks.onToggleHighlight(id: string, path: string): void` and `PanelCallbacks.localPathFor(path: string): string | null`. Task 12 adds `sourceKeyFor` beside `localPathFor`.

- [ ] **Step 1:** Add both callbacks to the `PanelCallbacks` interface in `panel.ts`. In `app-shell.ts`, wire them where the other panel callbacks live:

```ts
localPathFor: (path) => this.signalsByPath.get(path)?.local_path ?? null,
onToggleHighlight: (id, path) => {
  const local = this.signalsByPath.get(path)?.local_path;
  if (local === undefined) return;
  this.workspace.toggleHighlight(id, path, local);
  this.commitHistory();
  this.renderTiles();
},
```

(Match the exact history/commit idiom of the neighboring callbacks — e.g. `onToggleSeries` — before writing; use the same one.)

- [ ] **Step 2: Dimming.** In the time-mode render path (where `emphasisIndex` is computed from `emphasizePath`, :574-578), compute and pass the dim array:

```ts
const highlightByLocal = new Map(
  state.highlighted_sources.map((entry) => [entry.local_path, entry.path]),
);
const dimmed = shown.map((tile) => {
  const local = this.callbacks.localPathFor(tile.signal_path);
  if (local === null) return false;
  const active = highlightByLocal.get(local);
  return active !== undefined && active !== tile.signal_path;
});
```

Pass `dimmed` in the options object alongside the existing `emphasisIndex` (hover precedence is already handled inside the renderer by Task 10). Apply the same `dimmed` computation to the XY/FFT/histogram vertex path if the renderer's `renderPaths`-style entry point gains the option cheaply; if it does not already thread per-series dim flags, restrict dimming to time mode in this task and note it in the commit message — do not redesign the vertex renderer.

- [ ] **Step 3: Legend mark + inspector action.** In `legendChip`, add `chip.classList.toggle("highlighted", state.highlighted_sources.some((entry) => entry.path === series.path))` — `updateLegend` already receives `state`; pass it through to `legendChip`. In `openInspector`, add one action button labeled `Highlight` / `Clear highlight` (based on whether the series path is currently highlighted) that calls `this.callbacks.onToggleHighlight(this.id, path)` and closes the inspector — follow the inspector's existing action-button structure exactly. Hide the action when `this.callbacks.localPathFor(path)` is null (non-source series can't be highlighted). In `app.css`, style `.legend-chip.highlighted .legend-line` with a visible ring using existing tokens (e.g. `box-shadow: 0 0 0 1px var(--fg-1)`); follow the file's token discipline — no raw colors.
- [ ] **Step 4: Write the failing test** in `panel.test.ts`: construct a `PanelView` per the file's existing harness, give its state two series sharing local path `alt` (via a `localPathFor` stub) and `highlighted_sources = [{local_path: "alt", path: "run_01/alt"}]`, call the legend update, and assert the `run_01/alt` chip has class `highlighted` and the `run_02/alt` chip does not.
- [ ] **Step 5: Run** `./scripts/test.sh frontend` — expect PASS. Commit — `git commit -m "feat(ui): per-bundle member highlights in legend and inspector"`

---

### Task 12: XY per-source X resolution

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`panelSignalIds` at :1953-1970), `frontend/src/ui/panel.ts` (`renderXy` at :586-610, `PanelCallbacks`)
- Test: `frontend/src/ui/panel.test.ts` or `frontend/src/app/` — wherever `renderXy` pairing is already exercised; extend that harness

**Interfaces:**

- Consumes: `localPathFor` (Task 11).
- Produces: `PanelCallbacks.sourceKeyFor(path: string): string | null` (app-shell: `this.signalsByPath.get(path)?.source_key ?? null`). XY pairing rule: each Y series pairs against the sample series from **its own source** whose local path equals `x_signal`'s local path, falling back to `x_signal`'s own series.

- [ ] **Step 1: Write the failing test.** In the existing XY render test harness, provide a `SampleResponse` containing four series — `run_01/t_alt`, `run_01/alt`, `run_02/t_alt`, `run_02/alt` — a panel state with `x_signal: "run_01/t_alt"` and Y series `run_01/alt`, `run_02/alt`, and stub callbacks: `sourceKeyFor` maps the `run_01/*` paths to `"k1"` and `run_02/*` to `"k2"`; `localPathFor` strips the prefix. Assert the produced `xyTraces` pair `run_02/alt` against `run_02/t_alt` values, not `run_01/t_alt` (give the two X series distinguishable values and assert on the paired trace coordinates). Add a fallback case: a Y series whose source lacks `t_alt` pairs against `run_01/t_alt`.
- [ ] **Step 2: Run** the targeted unit filter — expect FAIL.
- [ ] **Step 3: Implement in `renderXy`.** After `xSeries` is resolved (:596-597), add:

```ts
const xLocal = this.callbacks.localPathFor(state.x_signal);
const resolveX = (yPath: string): typeof xSeries => {
  if (xLocal === null) return xSeries;
  const sourceKey = this.callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries;
  return (
    samples.series.find(
      (candidate) =>
        this.callbacks.sourceKeyFor(candidate.signal_path) === sourceKey &&
        this.callbacks.localPathFor(candidate.signal_path) === xLocal,
    ) ?? xSeries
  );
};
```

and change the pairing at :608 to `trace: pairSamples(resolveX(series.path) ?? xSeries, ySeries)`.

- [ ] **Step 4: Implement in `panelSignalIds`** so the resolved X signals are actually fetched — replace the XY branch:

```ts
if (panel.mode === "xy") {
  if (panel.x_signal !== null) {
    paths.unshift(panel.x_signal);
    const xLocal = this.signalsByPath.get(panel.x_signal)?.local_path;
    if (xLocal !== undefined) {
      for (const series of panel.series) {
        const sourceKey = this.signalsByPath.get(series.path)?.source_key;
        if (sourceKey === undefined) continue;
        const resolved = this.signals.find(
          (candidate) =>
            candidate.source_key === sourceKey &&
            candidate.local_path === xLocal,
        );
        if (resolved !== undefined) paths.push(resolved.path);
      }
    }
  }
  if (panel.color_signal !== null) paths.push(panel.color_signal);
}
```

(`this.signals` is the `SignalSummary[]` the shell already holds; the `new Set(paths)` dedup below the branch already handles repeats.)

- [ ] **Step 5: Run** `./scripts/test.sh frontend` — expect PASS. Commit — `git commit -m "fix(xy): pair bundle members against their own source's x signal"`

---

### Task 13: End-to-end flow, docs, grep gates, version bump

**Files:**

- Modify: `frontend/tests/e2e/workbench.spec.ts` (read it and its `fixtures.ts` first; follow its ingest/panel helpers), `docs/adr/0028-ensemble-run-mean-envelope.md`, `docs/adr/README.md`, `README.md`, `docs/implementation-roadmap.md`

**Interfaces:** none new.

- [ ] **Step 1: E2E.** Extend `workbench.spec.ts` (or add a sibling spec using its fixtures) with the bundle flow: ingest two CSV sources that form a set (reuse the spec's existing multi-file ingest helper — the Monte Carlo generator script exists but e2e fixtures should follow whatever the suite already ingests); assert the tree shows a bundle row with a `2 runs` badge; expand it and assert two member rows; double-click the bundle and assert the focused panel's legend has two chips; open a legend chip's inspector, trigger the highlight action, and assert the chip gains the `highlighted` class; switch the panel to XY via the mode pill and back to T, asserting no error toast and that both traces remain. Selector conventions: tree rows carry `dataset.signalPath`; legend chips are `.legend-chip`.
- [ ] **Step 2: Docs.** Prepend to ADR 0028 a status line: `Status: superseded by docs/superpowers/specs/2026-07-31-bundled-series-highlights-design.md — ensemble tiles and the band renderer were removed; bundles plot as per-source member series with highlights.` Update the ADR index in `docs/adr/README.md` accordingly. Remove the band workflow references at `README.md:45` and `docs/implementation-roadmap.md:40,45` (describe bundle plotting + highlights instead, one line each).
- [ ] **Step 3: Grep gates** (all must return zero):

```bash
grep -rn "spaghetti\|PanelSeriesKind" frontend core shell protocol --include=*.ts --include=*.rs
grep -rn "ensemble" frontend/src shell/src-tauri/src --include=*.ts --include=*.rs
grep -rn "ensemble" core/scope-core/src --include=*.rs | grep -v "session.rs"
grep -rn "Ensemble" protocol/schema
```

(`session.rs` hits must be only `migrate_v13_ensembles` and its tests.)

- [ ] **Step 4: Gate + version.** Run `./scripts/format.sh`, then `./scripts/test.sh full`. Then `./scripts/version.sh bump major && ./scripts/version.sh check` (protocol v11 and session v14 are breaking).
- [ ] **Step 5: Commit** — `git commit -m "feat(ui)!: bundled series highlights replace ensemble bands"`

---

## Addendum A (2026-07-31): bundle-vs-bundle XY

Tasks 1–13 are implemented (commits `9192419`…`bb3c586`). This addendum is
the only outstanding work. It implements the spec's "Bundle-vs-bundle XY"
section: putting "temperature" on X while a bundle is on Y must mean each
source's temperature against that source's Y — and two sources must never
be cross-paired. No schema change; `x_signal` stays a single full path.

### Task 14: Bundle X drops, strict per-source pairing, local-path X chip

**Files:**

- Modify: `frontend/src/ui/panel.ts` (dragover at :326-339, drop at :344-374, X chip at :410-417, `resolveX` at :595-618)
- Test: the XY pairing tests Task 12 added (find them: `grep -rn "resolveX\|pairs bundle members" frontend/src --include=*.test.ts`) plus the panel drop tests

**Interfaces:**

- Consumes: `PanelCallbacks.onSetXSignal(id, path)`, `localPathFor`, `sourceKeyFor` — all existing.
- Produces: no new interfaces. Behavior changes only.

- [ ] **Step 1: Write the failing tests** in the file that holds Task 12's XY pairing test, following its harness (stub `sourceKeyFor` mapping `run_01/*`→`"k1"`, `run_02/*`→`"k2"`; `localPathFor` strips the prefix; derived paths return null from both):

```ts
it("omits the trace when a source lacks the X local path instead of cross-pairing", () => {
  // samples: run_01/temp, run_01/alt, run_02/alt (run_02 has NO temp)
  // state: x_signal = "run_01/temp", series = [run_01/alt, run_02/alt]
  // expect exactly ONE xy trace (run_01/alt); run_02/alt is omitted, and
  // no trace contains run_01/temp values paired with run_02/alt values.
});

it("derived Y pairs against x_signal directly", () => {
  // samples: run_01/temp, derived/score; x_signal = "run_01/temp",
  // series = [derived/score] — expect one trace paired against run_01/temp.
});

it("x chip shows the local path when visible series span multiple sources", () => {
  // state: x_signal = "run_01/temp", visible series from k1 and k2 —
  // expect the .x-chip text to be "temp" and its title to contain "run_01/temp".
  // With series from k1 only, expect the current signalLabel text.
});
```

Fill in real assertions using the harness's existing accessors (the Task 12 tests already assert on `xyTraces` pairing; the chip test queries `.x-chip` on the panel element).

- [ ] **Step 2: Run** the targeted unit filter — expect FAIL (today the first case falls back to `run_01/temp` and the chip always shows the full label).
- [ ] **Step 3: Strict pairing.** In `renderXy` (panel.ts:595-618), make `resolveX` return `undefined` instead of falling back when a _sourced_ Y has no same-source X, and skip those traces:

```ts
const xLocal = this.callbacks.localPathFor(state.x_signal);
const resolveX = (yPath: string): typeof xSeries | undefined => {
  if (xLocal === null) return xSeries; // derived/unknown X: shared X
  const sourceKey = this.callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return xSeries; // derived Y: shared X
  return samples.series.find(
    (candidate) =>
      this.callbacks.sourceKeyFor(candidate.signal_path) === sourceKey &&
      this.callbacks.localPathFor(candidate.signal_path) === xLocal,
  ); // undefined ⇒ never cross-pair two sources
};
```

and in the series loop:

```ts
const resolved = resolveX(series.path);
if (resolved === undefined) continue;
// ...
trace: pairSamples(resolved, ySeries),
```

- [ ] **Step 4: Bundle drops on the X strip.** In the `dragover` handler (:335-338), drop the bundle exclusion so the strip highlights for bundles too:

```ts
this.element.classList.toggle("drop-x", this.overStrip(event));
```

In the `drop` handler, compute `const asX = this.overStrip(event);` **before** the bundle branch, and inside the validated bundle branch route strip drops to the X signal (sorted-first member, matching the spec):

```ts
const first = [...payload.member_paths].sort()[0];
if (asX && first !== undefined) {
  this.callbacks.onSetXSignal(this.id, first);
} else {
  this.callbacks.onDropBundle(this.id, payload.member_paths);
}
```

- [ ] **Step 5: X chip label.** In the header update (:410-417), show the local path when pairing is per-source across sources:

```ts
const xLocal = this.callbacks.localPathFor(state.x_signal);
const sources = new Set(
  state.series
    .filter((series) => series.visible)
    .map((series) => this.callbacks.sourceKeyFor(series.path))
    .filter((key): key is string => key !== null),
);
const chipLabel =
  xLocal !== null && sources.size > 1 ? xLocal : signalLabel(state.x_signal);
```

Use `chipLabel` for the chip text node; keep the full `state.x_signal` in the `title`. Text via `textContent`/`createTextNode` only.

- [ ] **Step 6: Run** `./scripts/test.sh frontend` — expect PASS (Task 12's old fallback test asserted cross-pair fallback for a _sourced_ Y; update that expectation to the omit rule — the derived fallback cases stay).
- [ ] **Step 7: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, then `./scripts/version.sh bump minor && ./scripts/version.sh check` (behavioral change, no schema break).
- [ ] **Step 8: Commit** — `git commit -m "feat(xy): bundle-vs-bundle pairing with strict per-source resolution"`

---

## Addendum B (2026-07-31): bundle drops everywhere, per-source color, robust drop routing

Tasks 1–14 are implemented. This addendum implements the spec's "Per-source
color channel" and "Drop routing (binding)" sections plus the axis-label
rule added to "Bundle-vs-bundle XY". Observed defects it fixes:

- a. Bundles can't be dropped on the workspace background / empty state to
  create a new panel (only `SIGNAL_DRAG_TYPE` is accepted,
  `workspace-view.ts` `bindWorkspaceDrop`).
- b. The XY bottom axis label shows the stored sorted-first member path
  (`axisName(state.x_signal, …)`) instead of the local path when pairing
  is per-source.
- c. The color chip only accepts `SIGNAL_DRAG_TYPE`, so bundle drags fall
  through to the panel body and get added as series; color values are also
  lerped from one shared series across all traces (cross-source coloring).

### Task 15: Bundle drops on every target; exclusive channel routing

**Files:**

- Modify: `frontend/src/ui/panel.ts` (bundle payload helper near `bundleXSignal` at :175; color chip handlers at :339-360; panel body handlers at :372-421), `frontend/src/ui/workspace-view.ts` (`bindWorkspaceDrop` at :247-271, `WorkspaceViewCallbacks`), `frontend/src/ui/app-shell.ts` (callback wiring near `onDropSignalNewPanel` at :312)
- Test: `frontend/src/ui/panel.test.ts` (payload helper), plus the existing drop-routing tests if any (`grep -rn "onDropBundle\|onSetXSignal" frontend/src --include=*.test.ts`)

**Interfaces:**

- Produces: `export function parseBundlePayload(data: string): { member_paths: string[] } | null` in `panel.ts` (replaces the inline parse; `bundleXSignal` stays); `WorkspaceViewCallbacks.onDropBundleNewPanel(memberPaths: readonly string[]): void`.
- Consumes: `AppShell.plotBundle(memberPaths, panelId?)`, `onSetColorSignal(id, path)` — existing.

- [ ] **Step 1: Write the failing tests:**

```ts
it("parseBundlePayload accepts only string-array member payloads", () => {
  expect(
    parseBundlePayload(
      JSON.stringify({ local_path: "alt", member_paths: ["a/alt", "b/alt"] }),
    ),
  ).toEqual({ member_paths: ["a/alt", "b/alt"] });
  expect(parseBundlePayload("not json")).toBeNull();
  expect(parseBundlePayload(JSON.stringify({ member_paths: [1] }))).toBeNull();
  expect(parseBundlePayload(JSON.stringify({}))).toBeNull();
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit panel` — expect FAIL (`parseBundlePayload` not exported).
- [ ] **Step 3: Extract the helper** in `panel.ts` (module level, next to `bundleXSignal`):

```ts
export function parseBundlePayload(
  data: string,
): { member_paths: string[] } | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "member_paths" in payload &&
      Array.isArray(payload.member_paths) &&
      payload.member_paths.every((path) => typeof path === "string")
    ) {
      return { member_paths: payload.member_paths };
    }
  } catch {
    // Malformed external drag payloads are not bundles.
  }
  return null;
}
```

Rewrite the panel-body drop handler's bundle branch (:391-415) to use it.

- [ ] **Step 4: Color chip accepts bundles, exclusively.** Extend the `cChip` handlers (:343-360): `dragover` accepts `SIGNAL_DRAG_TYPE` **or** `BUNDLE_DRAG_TYPE` (keep `preventDefault` + `stopPropagation` in both `dragover` and `drop` for both types — this is what stops the panel body underneath from claiming the drag). In `drop`, check the bundle payload first:

```ts
const bundle = dragData(event, BUNDLE_DRAG_TYPE);
if (bundle !== null) {
  const payload = parseBundlePayload(bundle);
  const first =
    payload === null ? undefined : [...payload.member_paths].sort()[0];
  cChip.classList.remove("drop-target");
  if (first === undefined) return;
  event.preventDefault();
  event.stopPropagation();
  this.callbacks.onSetColorSignal(this.id, first);
  return;
}
// existing SIGNAL_DRAG_TYPE path unchanged
```

Apply the same exclusive-routing treatment to the X chip if it is a drop target; if only the strip is, the strip's existing handling from Task 14 already routes exclusively (verify: a bundle dropped `overStrip` must set X and never also add series).

- [ ] **Step 5: Workspace background accepts bundles.** In `bindWorkspaceDrop` (workspace-view.ts:247-271): `dragover` also accepts `BUNDLE_DRAG_TYPE` over the background; in `drop`, check `dragData(event, BUNDLE_DRAG_TYPE)` first, parse with `parseBundlePayload` (import from `./panel`), and call `this.callbacks.onDropBundleNewPanel(payload.member_paths)`. Add the callback to `WorkspaceViewCallbacks` (:17). In `app-shell.ts`, wire it next to `onDropSignalNewPanel` (:312):

```ts
onDropBundleNewPanel: (memberPaths) => {
  this.plotBundle(memberPaths, this.workspace.addPanelRow().id);
},
```

(Check `onDropSignalNewPanel`'s body first and mirror its focus/history idiom exactly — if it calls a helper that also fits the window, use the same helper.)

- [ ] **Step 6: Run** `./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(ui): route bundle drops to every signal drop target"`

---

### Task 16: Per-source color resolution and local-path axis labels

**Files:**

- Modify: `frontend/src/ui/panel.ts` (`renderXy` — color resolution around the `colorFor` closure; X axis label at :746; color label at :766; chip label logic from Task 14), `frontend/src/ui/app-shell.ts` (`panelSignalIds` — request resolved color paths like resolved X paths)
- Test: the XY pairing test file from Tasks 12/14

**Interfaces:**

- Consumes: `localPathFor` / `sourceKeyFor` callbacks, Task 14's `resolveX` pattern.
- Produces: no new interfaces; behavior and labels only.

- [ ] **Step 1: Write the failing tests** (same harness as Task 14; stub `sourceKeyFor`/`localPathFor` as before):

```ts
it("colors each trace from its own source's color signal", () => {
  // samples: run_01/temp, run_01/alt, run_02/temp, run_02/alt
  // state: color_signal = "run_01/temp", series = [run_01/alt, run_02/alt]
  // give run_01/temp and run_02/temp distinguishable values;
  // assert run_02/alt's colorValues derive from run_02/temp, not run_01/temp.
});

it("a trace whose source lacks the color local path renders uncolored", () => {
  // run_02 has no temp: assert run_02/alt's colorValues are null while
  // run_01/alt's are populated; no cross-source color pairing.
});

it("x axis and color labels use the local path when series span sources", () => {
  // x_signal = "run_01/t", color_signal = "run_01/temp", series from k1+k2:
  // assert the prepared plot's xLabel is axisName("t", unit) and the color
  // label is "temp"; with a user-set x_label, the override wins.
});
```

Fill in the real assertions against the harness's prepared-plot accessor (Task 14's tests already inspect `xyTraces`; the label test inspects the `prepareXyPlot` input or the rendered label, whichever the harness exposes).

- [ ] **Step 2: Run** the targeted filter — expect FAIL.
- [ ] **Step 3: Implement color resolution** in `renderXy`, mirroring `resolveX`:

```ts
const cLocal =
  state.color_signal === null
    ? null
    : this.callbacks.localPathFor(state.color_signal);
const resolveColor = (
  yPath: string,
): SampleResponse["series"][number] | null => {
  if (colorSeries === null || colorSeries === "time") return null; // handled by caller
  if (cLocal === null) return colorSeries; // shared color
  const sourceKey = this.callbacks.sourceKeyFor(yPath);
  if (sourceKey === null) return colorSeries; // derived Y: shared
  return (
    samples.series.find(
      (candidate) =>
        this.callbacks.sourceKeyFor(candidate.signal_path) === sourceKey &&
        this.callbacks.localPathFor(candidate.signal_path) === cLocal,
    ) ?? null // uncolored, never cross-paired
  );
};
```

Change `colorFor` so the `"time"` case is unchanged, and the signal case lerps against `resolveColor(trace.path)`, returning `null` when it resolves to `null` (the existing `colorColumns[index] ?? null` plumbing already tolerates per-trace nulls — verify `hasColor` still computes over non-null columns only).

- [ ] **Step 4: Labels.** Compute the multi-source condition once (Task 14 already computes the visible-source set for the chip; reuse it): when `xLocal !== null && sources.size > 1`, the X axis label becomes `state.x_label ?? axisName(xLocal, xSeries.unit)` (:746) and the color label becomes `state.c_label ?? axisName(cLocal, colorSeries.unit)` under the same condition with `cLocal` (:766). Apply the same local-path rule to the color chip's text (mirror the X chip change from Task 14; tooltip keeps the full path).
- [ ] **Step 5: Query union.** In `panelSignalIds` (app-shell.ts), extend the XY branch to also push each series' resolved color path (same-source signal whose local path equals `color_signal`'s local path), exactly parallel to the resolved-X loop.
- [ ] **Step 6: Run** `./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 7: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, then `./scripts/version.sh bump minor && ./scripts/version.sh check`.
- [ ] **Step 8: Commit** — `git commit -m "feat(xy): per-source color channel and local-path axis labels"`

---

## Addendum C (2026-07-31): folder ingest and loading progress

Implements `docs/superpowers/specs/2026-07-31-folder-ingest-design.md`.
Tasks 1–16 are implemented. Key context: `ingest_batch` already expands
directories recursively (`shell/src-tauri/src/lib.rs:226`, `expand_source`
at :547); what's missing is the folder picker, a scan-preview step with an
optional-recursion toggle, and byte-weighted progress.

### Task 17: Protocol v12 — scan types and byte-weighted batch status

**Files:**

- Modify: `protocol/schema/scope-protocol.json`, `core/scope-core/src/ingest/batch.rs` (`BatchStatus` build at :160-181; job/work-item creation — read `submit`), `shell/src-tauri/src/lib.rs` (`expand_source` :547, `supported_path` :572, new `scan_sources` + `pick_source_folder` commands, registration list :1524 area)
- Regenerate: via `./scripts/codegen.sh`
- Test: `core/scope-core/src/ingest/batch.rs` inline tests; shell inline tests (an `expand_sources` test already exists at lib.rs:1640 — follow its tempdir pattern)

**Interfaces:**

- Produces (schema): `ScanSourcesRequest { path: string, recursive: bool }`; `ScanSourcesResponse { files: string[], total_bytes: u64, format_counts: FormatCount[] }`; `FormatCount { label: string, count: u32 }`; `BatchStatus` gains `current_paths: string[]`; `"protocol_version": 12`.
- Produces (commands): `scan_sources(request) -> Envelope<ScanSourcesResponse>`; `pick_source_folder() -> Option<String>` (mirror the existing file-picker dialog command at :188-206, using the dialog plugin's folder picker).
- Task 18 consumes both commands; Task 19 consumes `fraction` + `current_paths`.

- [ ] **Step 1: Schema.** Add the three types, add `"current_paths": "string[]"` to `BatchStatus`, set `"protocol_version": 12`. Run `./scripts/codegen.sh`. (`u64` stays plain — strings on the TS side per the existing convention.)
- [ ] **Step 2: Write failing core tests** in `batch.rs`'s test module (follow its existing job-fixture helpers):

```rust
#[test]
fn fraction_is_byte_weighted() {
    // two files: 1_000_000 bytes and 1_000 bytes (write real temp files via
    // the module's existing fixture helper); after only the small file
    // settles, status().fraction < 0.01, not 0.5; after both, 1.0.
}

#[test]
fn current_paths_lists_running_files_and_empties_when_terminal() {
    // while a file is in FileState::Running, status().current_paths contains
    // its path (≤ 3 entries); after the job reaches a terminal state it is [].
}
```

- [ ] **Step 3: Implement.** At job creation, stat each path: `weight = fs::metadata(path).map(|m| m.len()).unwrap_or(1).max(1)`; store per work item. In the status build (:171), replace the settled/total file-count fraction with `settled_weight as f64 / total_weight as f64` (total 0 ⇒ 1.0, as today), and collect `current_paths` from running items (first 3, deterministic order). Run `./scripts/test.sh core batch` — expect PASS.
- [ ] **Step 4: Shell scan command.** Add a `recursive: bool` parameter to the directory walk (skip the `expand_source(&path, …)` recursion into subdirectories when false — top-level files only) without changing `ingest_batch`'s always-recursive call. Then:

```rust
#[tauri::command]
fn scan_sources(request: ScanSourcesRequest) -> Result<Envelope<ScanSourcesResponse>, String> {
    // walk request.path with request.recursive; for each supported file,
    // accumulate fs::metadata(...).len() (skip unreadable entries) and a
    // per-SUPPORTED_FORMATS-label count; sort files; return the envelope.
}
```

Write it fully (the walk is ~30 lines; reuse `supported_path` and match the error style of the neighboring commands), register both new commands, and add shell tests beside the existing `expand_sources` test: nested tempdir with supported + unsupported files, recursive vs. not, counts and byte totals, empty dir.

- [ ] **Step 5: Run** `./scripts/test.sh core batch && ./scripts/test.sh shell && ./scripts/test.sh frontend` (codegen check) — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(protocol): v12 folder scans and byte-weighted batch progress"`

---

### Task 18: Open Folder flow with scan-preview dialog

**Files:**

- Create: `frontend/src/ui/folder-scan-dialog.ts` (follow `export-dialog.ts`'s structure: markup string, open/close, Escape handling, focus)
- Modify: `frontend/src/app/data-plane.ts` (`IngestPort` at :46-56 and the Tauri implementations at :167-206), `frontend/src/ui/app-shell.ts` (palette entry beside `open-files` at :442; `openFolder()` beside `openFiles()` at :1147), `frontend/src/styles/app.css` (dialog styles from existing dialog tokens)
- Test: `frontend/src/ui/folder-scan-dialog.test.ts`

**Interfaces:**

- Consumes: `scan_sources` / `pick_source_folder` from Task 17; existing `runBatchIngest(port, paths, onProgress)` and the `.ingest-progress` wiring inside `openFiles`.
- Produces: `IngestPort.pickSourceFolder(): Promise<string | null>`; `IngestPort.scanSources(path: string, recursive: boolean): Promise<ScanSourcesResponse>`; `FolderScanDialog.open(folder: string, scan: (recursive: boolean) => Promise<ScanSourcesResponse>, onLoad: (files: string[]) => void): void`.

- [ ] **Step 1: Write the failing dialog tests** (jsdom, mirroring how other UI tests mount components):

```ts
it("shows counts, size, and format breakdown, and re-scans on toggle", async () => {
  const scans: boolean[] = [];
  const scan = async (recursive: boolean) => {
    scans.push(recursive);
    return recursive
      ? {
          files: ["a.csv", "sub/b.csv"],
          total_bytes: "2048",
          format_counts: [
            { label: "Delimited text (CSV, TSV, TXT, DAT)", count: 2 },
          ],
        }
      : {
          files: ["a.csv"],
          total_bytes: "1024",
          format_counts: [
            { label: "Delimited text (CSV, TSV, TXT, DAT)", count: 1 },
          ],
        };
  };
  // open(folder, scan, onLoad); await the initial (recursive) scan;
  // assert "2 loadable files" appears and scans === [true];
  // uncheck the checkbox; assert scans === [true, false] and "1 loadable file";
  // click Load; assert onLoad received ["a.csv"] and the dialog closed.
});

it("disables Load when the scan finds nothing", async () => {
  // scan resolves { files: [], total_bytes: "0", format_counts: [] };
  // assert "No loadable files found." and the Load button is disabled.
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit folder-scan` — expect FAIL (module missing).
- [ ] **Step 3: Implement the dialog.** All text via `textContent`; the folder path is untrusted display data. Body per the spec: title = folder basename (title attribute = full path); `N loadable files · <size>` using an existing byte-formatting helper if one exists (`grep -rn "formatBytes\|toFixed(1)} MB" frontend/src` first — reuse, don't duplicate); per-format counts joined with `" · "`; checkbox labeled `Include subfolders`, checked by default, re-invoking `scan` on change with a stale-response guard (ignore out-of-order resolutions); `Load` disabled while a scan is in flight or when zero files.
- [ ] **Step 4: Port + shell wiring.** Add the two `IngestPort` methods and their Tauri implementations (mirror `pickSources`/`listFormats` envelope handling at :167-206). Then in `app-shell.ts` add the palette entry `open-folder` ("Open folder…") beside `open-files` and:

```ts
private async openFolder(): Promise<void> {
  const port = this.plane.ingest;
  if (port === null) return;
  const folder = await port.pickSourceFolder();
  if (folder === null) return;
  this.folderScanDialog.open(
    folder,
    (recursive) => port.scanSources(folder, recursive),
    (files) => {
      if (files.length > 0) void this.ingestPaths(files);
    },
  );
}
```

where `ingestPaths(paths: string[])` is `openFiles`'s existing body from the point after `pickSources()` returned, factored out so both flows share the progress rendering, error handling, and post-batch reload (refactor `openFiles` to call it; do not duplicate the flow).

- [ ] **Step 5: Run** `./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(ingest): open folders with a scan preview and optional recursion"`

---

### Task 19: Progress bar with byte-weighted percent and current file

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (`renderBatchProgress` at :2426-2457), `frontend/src/styles/app.css`
- Test: extract `renderBatchProgress` into a testable unit only if a test file for app-shell helpers already exists — otherwise assert via the existing ingest tests in `frontend/src/app/ingest.test.ts` if they render progress, else add a small DOM test file for the function (export it for testing)

**Interfaces:**

- Consumes: `BatchStatus.fraction` (now byte-weighted) and `BatchStatus.current_paths` from Task 17. No new interfaces.

- [ ] **Step 1: Write the failing test:** render a running status `{ state: "running", fraction: 0.37, total: "12", done: "4", failed: "1", current_paths: ["/data/run_07.csv"], recent_failures: [] }` into a container and assert: a `.ingest-bar-fill` element has `style.width === "37%"`, the text includes `37%`, `4/12`, and `run_07.csv` (basename only), and a Cancel button is present; render a `done` status and assert no bar/cancel remain.
- [ ] **Step 2: Run** the targeted unit filter — expect FAIL.
- [ ] **Step 3: Implement.** Extend `renderBatchProgress`: prepend a bar (`div.ingest-bar` containing `div.ingest-bar-fill` with `style.width = `${Math.round(status.fraction \* 100)}%``) and a percent + `done/total`summary; when`current_paths`is non-empty and the state is`running`, show `basename(current_paths[0])`(append` +N`when more are running) with the full path as`title`. Keep the failure list and Cancel exactly as they are. Style `.ingest-bar`/`.ingest-bar-fill`in`app.css` with existing tokens (height from an existing spacing token, fill color from an existing accent token; no raw colors, no animation beyond width).
- [ ] **Step 4: Run** `./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 5: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, then `./scripts/version.sh bump minor && ./scripts/version.sh check`. Manual check per the spec: `./scripts/run.sh`, open a nested folder with and without recursion, cancel mid-load.
- [ ] **Step 6: Commit** — `git commit -m "feat(ingest): byte-weighted progress bar with current file"`

---

## Addendum D (2026-07-31): tree at hundreds of sources, bundle favorites

Implements the spec's "Scale rules (hundreds of sources)" and "Bundle
favorites" sections. Tasks 1–19 are implemented. Defects this fixes:
bundles merge across sets (`tree-model.ts` flattens all `setPrefixes`);
bundle rows are a flat depth-0 list with full local-path labels (no
segment hierarchy); the sources footer renders one static DOM row per
source; bundles cannot be favorited.

### Task 20: Tree model — per-set bundles with segment hierarchy

**Files:**

- Modify: `frontend/src/app/tree-model.ts` (the `options` branch of `buildTreeRows`, :38-91; `TreeBundle`, :16-24)
- Test: `frontend/src/app/tree-model.test.ts`

**Interfaces:**

- Produces:

```ts
export interface TreeBundle {
  kind: "bundle";
  path: string;      // local path
  setKey: string;
  bundleKey: string; // `${setKey}//${localPath}` — expansion/star keying
  label: string;     // final segment (full local path while searching)
  depth: number;
  runCount: number;
  memberPaths: string[];
  expanded: boolean;
}
buildTreeRows(paths, collapsed, filter, options?: {
  sets: readonly { key: string; label: string; prefixes: readonly string[] }[];
  expandedBundles: ReadonlySet<string>; // bundleKey entries
}): TreeRow[]
```

Set headers and local-path groups are ordinary `TreeGroup` rows with
namespaced collapse keys (`set:<key>` and `<setKey>//<groupPath>`), so the
view's existing group rendering and collapse toggling work untouched.
Task 21 consumes `bundleKey` and the new `sets` option.

- [ ] **Step 1: Write the failing tests** (replace the flat-bundle expectations; keep the search and single-set cases):

```ts
const sets = [
  { key: "sA", label: "Campaign A", prefixes: ["a1", "a2"] },
  { key: "sB", label: "Campaign B", prefixes: ["b1", "b2"] },
];
const none = new Set<string>();

it("keys bundles per set and adds headers only when several sets have bundles", () => {
  const rows = buildTreeRows(
    ["a1/temp", "a2/temp", "b1/temp", "b2/temp"],
    none,
    "",
    { sets, expandedBundles: none },
  );
  const headers = rows.filter(
    (row) => row.kind === "group" && row.path.startsWith("set:"),
  );
  expect(headers.map((row) => row.label)).toEqual(["Campaign A", "Campaign B"]);
  const bundles = rows.filter((row) => row.kind === "bundle");
  expect(bundles.map((row) => [row.setKey, row.runCount])).toEqual([
    ["sA", 2],
    ["sB", 2],
  ]);
  // single set: no header, bundle at depth 0 — today's shape exactly
  const single = buildTreeRows(["a1/temp", "a2/temp"], none, "", {
    sets: [sets[0]],
    expandedBundles: none,
  });
  expect(single.filter((row) => row.kind === "group")).toHaveLength(0);
  expect(single[0]).toMatchObject({ kind: "bundle", depth: 0 });
});

it("nested local paths produce collapsible group rows", () => {
  const paths = [
    "a1/imu/accel/x",
    "a2/imu/accel/x",
    "a1/imu/accel/y",
    "a2/imu/accel/y",
  ];
  const rows = buildTreeRows(paths, none, "", {
    sets: [sets[0]],
    expandedBundles: none,
  });
  expect(rows.map((row) => [row.kind, row.label, row.depth])).toEqual([
    ["group", "imu", 0],
    ["group", "accel", 1],
    ["bundle", "x", 2],
    ["bundle", "y", 2],
  ]);
  const collapsed = buildTreeRows(paths, new Set(["sA//imu"]), "", {
    sets: [sets[0]],
    expandedBundles: none,
  });
  expect(collapsed).toHaveLength(1); // just the collapsed "imu" group row
});

it("bundle group keys never collide with source-prefix groups", () => {
  // a non-bundled source literally named "imu" keeps its own group row and
  // collapse state even when "sA//imu" is collapsed.
  const rows = buildTreeRows(
    ["a1/imu/accel/x", "a2/imu/accel/x", "imu/standalone"],
    new Set(["sA//imu"]),
    "",
    { sets: [sets[0]], expandedBundles: none },
  );
  expect(
    rows.some((row) => row.kind === "leaf" && row.path === "imu/standalone"),
  ).toBe(true);
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit tree-model` — expect FAIL.
- [ ] **Step 3: Implement.** Replace the options branch:
  1. Build `prefixToSet` (first set to claim a prefix wins). Partition `paths` into per-set `Map<localPath, string[]>` plus `rest` (unclaimed paths and single-member local paths go to `rest`).
  2. Collect `setsWithBundles` in input order; `multi = setsWithBundles.length > 1`.
  3. Per set: when `multi`, emit a `TreeGroup` `{ path: "set:" + set.key, label: set.label, depth: 0, expanded: !collapsed.has(...) }` and skip the set's rows when collapsed; `base = multi ? 1 : 0`.
  4. **No query:** walk the set's bundle local paths sorted, emitting segment `TreeGroup` rows exactly like the plain-tree walk at :98-128 but with collapse keys `${set.key}//${groupPath}` and depths offset by `base`; the bundle row sits at the final segment (`label` = last segment, `depth = base + segments - 1`, `bundleKey = ${set.key}//${localPath}`); expanded bundles emit member leaves one level deeper, labeled by source prefix as today.
  5. **With a query:** keep today's flat-per-bundle behavior (full local path as `label`, member filtering unchanged) under the set header.
  6. Append `buildTreeRows(rest.sort(), collapsed, filter)` as today.
- [ ] **Step 4: Run** `./scripts/test.sh unit tree-model` — expect PASS. Fix type fallout in `signal-tree.ts` minimally (Task 21 finishes it).
- [ ] **Step 5: Run** `./scripts/test.sh frontend`, commit — `git commit -m "feat(tree): per-set bundles with segment hierarchy"`

---

### Task 21: Tree view — set-aware wiring and bundle expansion keys

**Files:**

- Modify: `frontend/src/ui/signal-tree.ts` (`setSetPrefixes` :68-71 becomes `setSets`; bundle row rendering; `expandedBundles` keying), `frontend/src/ui/app-shell.ts` (the `setSetPrefixes` call site at :1839-1847)
- Test: covered by Task 20's model tests plus one view test for the toggle keying if a view test harness exists (`grep -rn "SignalTreeView" frontend/src --include=*.test.ts`)

**Interfaces:**

- Produces: `SignalTreeView.setSets(sets: readonly { key: string; label: string; prefixes: readonly string[] }[]): void` (replaces `setSetPrefixes`).
- Consumes: `TreeBundle.bundleKey` from Task 20.

- [ ] **Step 1:** Replace `setSetPrefixes` with `setSets`; store and pass through to `buildTreeRows` as the `sets` option. Key `expandedBundles` by `row.bundleKey` (the caret toggle adds/deletes `bundleKey`, not the local path).
- [ ] **Step 2:** In `app-shell.ts`, build per-set prefixes where the flat list is built today (:1839-1847): for each of `this.sets`, collect member `source_key`s, map them through `this.signals` to prefixes exactly as the current code does, and pass `{ key: set.set_key, label: set.label, prefixes }`. Sets with no loaded signals contribute nothing.
- [ ] **Step 3: Run** `./scripts/test.sh frontend` — expect PASS. Commit — `git commit -m "feat(tree): set-aware bundle rendering"`

---

### Task 22: Session v15 — bundle favorites

**Files:**

- Modify: `protocol/schema/scope-session.json` (v15, `Session.favorite_bundles`), `core/scope-core/src/session.rs` (rung + test), `protocol/testdata/session-conformance.json`, `frontend/src/app/baked-session.ts` (validator), `frontend/src/app/workspace.ts` (mutations), `frontend/src/ui/signal-tree.ts` (bundle star + favorites-bar chips), `frontend/src/ui/app-shell.ts` (wiring)
- Regenerate: `./scripts/codegen.sh`
- Test: `core/scope-core/src/session.rs`, `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Produces: `Session.favorite_bundles: string[]` (bundle local paths); `Workspace.favoriteBundles(): readonly string[]`; `Workspace.toggleFavoriteBundle(localPath: string): void`; `SignalTreeView.setFavoriteBundles(list: readonly string[]): void`; `SignalTreeCallbacks.onToggleFavoriteBundle(localPath: string): void`.

- [ ] **Step 1: Schema + rung.** Add `"favorite_bundles": "string[]"` to `Session`, bump to 15, run `./scripts/codegen.sh`. In `session.rs`, add the arm (a required field needs a real rung — do **not** fold 14 into the `3 | 4 | 7 | 12` pass-through group):

```rust
14 => {
    value["favorite_bundles"] = serde_json::json!([]);
    value["schema_version"] = serde_json::json!(15);
    migrate(15, value)
}
```

with a test asserting a v14 session migrates with an empty `favorite_bundles` and that the existing v13 fixture still chains through cleanly. Update the conformance fixture to v15 and the `baked-session.ts` validator (string array, same style as `favorites`).

- [ ] **Step 2: Workspace mutations (failing test first):**

```ts
it("toggles bundle favorites by local path", () => {
  const workspace = new WorkspaceModel();
  workspace.toggleFavoriteBundle("imu/accel/x");
  expect(workspace.favoriteBundles()).toEqual(["imu/accel/x"]);
  workspace.toggleFavoriteBundle("imu/accel/x");
  expect(workspace.favoriteBundles()).toEqual([]);
});
```

Implement exactly like the existing leaf `toggleFavorite`/`favorites` pair.

- [ ] **Step 3: Tree UI.** Bundle rows gain the same star button as leaves (`active` when the local path is in the favorite-bundles list; click → `onToggleFavoriteBundle(row.path)`, stopPropagation as the leaf star does). In `renderFavorites`, render bundle chips before leaf rows: label = local path, badge = current member count, activation and dragstart behave exactly like the bundle tree row (same `BUNDLE_DRAG_TYPE` payload); membership is the union across current sets — compute a `Map<localPath, string[]>` during `refresh()` from the same partition the model uses and store it for the favorites bar. Zero members ⇒ chip gets the existing `muted` class, no handlers.
- [ ] **Step 4: Wire app-shell:** pass `workspace.favoriteBundles()` into the tree wherever `setFavorites` is called; `onToggleFavoriteBundle` mirrors the leaf `onToggleFavorite` wiring (:336-341) including `commitHistory()`.
- [ ] **Step 5: Run** `./scripts/test.sh quick` — expect PASS (core rung + frontend suites). Commit — `git commit -m "feat(session)!: v15 bundle favorites"`

---

### Task 23: Sources footer — summary line with virtualized expansion

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (source rows render at :2280-2291, markup at :2511), `frontend/src/styles/app.css`
- Test: a DOM test for the render helper (export it like `renderBatchProgress` if Task 19 established that pattern; otherwise add alongside)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test:** with 3 sources, the footer renders 3 rows and no toggle (today's behavior); with 20 sources, it renders one summary line `20 sources · <total> pts` plus a collapsed-by-default toggle; expanding renders a virtualized window (assert the DOM row count is bounded by the viewport math from `virtualSlice`, not 20... use a row count large enough to exceed the overscan window, e.g. 200).
- [ ] **Step 2: Run** the targeted filter — expect FAIL.
- [ ] **Step 3: Implement.** Threshold 8 (spec): at or under it, render exactly today's rows. Above it, render the summary line (total points = sum of `Number(source.point_count)`, locale-formatted) and a chevron toggle (reuse the tree-group `▸`/`▾` affordance and existing tokens); the expanded list reuses `virtualSlice` with the tree's `--tree-row-height` token and a scroll container class in `app.css`.
- [ ] **Step 4: Run** `./scripts/test.sh frontend` — expect PASS.
- [ ] **Step 5: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, then `./scripts/version.sh bump major && ./scripts/version.sh check` (session v15 is breaking). Manual: `./scripts/run.sh`, load `examples/monte_carlo`, star the `command` bundle, reload, confirm the chip resolves and plots.
- [ ] **Step 6: Commit** — `git commit -m "feat(tree): scale to hundreds of sources with bundle favorites"`

---

## Addendum E (2026-07-31): derived bundles and the partial-bundle rule

Implements the spec's "Derived bundles" and "Partial-bundle rule"
sections. Tasks 1–23 are implemented. Background: expressions already use
quoted signal references (`hypot('imu/vx','imu/vy')`, `expr.rs` tokenizer
`Token::Signal`), `restore.rs` already rewrites references by token span,
and the shell already tracks derived bookkeeping (`derived_references`,
`derived_spills` in `DataState`). A derived bundle is therefore: resolve
quoted refs that name bundle local paths, intersect eligible sources,
span-rewrite per member, and run the existing single-signal evaluation N
times, registering each output under its member source with local path
`derived/<name>`.

### Task 24: Core — bundle reference resolution and per-member expansion; session v16

**Files:**

- Create: `core/scope-core/src/derived_bundle.rs` (+ `pub mod` in `lib.rs`)
- Modify: `protocol/schema/scope-session.json` (v16), `core/scope-core/src/session.rs` (rung + test), `protocol/testdata/session-conformance.json`, `frontend/src/app/baked-session.ts` (validator)
- Regenerate: `./scripts/codegen.sh`
- Test: inline in `derived_bundle.rs`, `session.rs`

**Interfaces:**

- Consumes: `expr`'s public reference-listing and span-rewrite helpers — the same ones `restore.rs:91-132` uses; read them first and reuse, do not re-tokenize by hand. Set membership and per-source local paths come from the same inputs `sets.rs`/the registry already expose (read how `shell` builds `SetSummary.local_paths`).
- Produces:

```rust
pub struct MemberExpansion {
    pub source_key: SourceKey,
    pub prefix: String,
    pub expr: String, // bundle refs rewritten to this source's full paths
}
pub struct SkippedMember {
    pub prefix: String,
    pub missing: Vec<String>, // bundle local paths this source lacks
}
pub struct BundleExpansion {
    pub members: Vec<MemberExpansion>,
    pub skipped: Vec<SkippedMember>,
    pub bundle_refs: Vec<String>, // resolved bundle local paths, for bookkeeping
}
/// Errors when `expr` is invalid, references nothing, or no source has
/// every bundle-referenced local path. An expression with zero bundle
/// refs returns an error variant the caller uses to fall back to the
/// ordinary single-signal path.
pub fn expand(
    expr: &str,
    full_paths: &BTreeSet<String>,
    locals_by_source: &BTreeMap<SourceKey, (String, BTreeSet<String>)>, // key -> (prefix, local paths)
) -> Result<BundleExpansion, DerivedBundleError>
```

- [ ] **Step 1: Write the failing tests** in `derived_bundle.rs` — resolution precedence (a quoted ref matching a full path is NOT a bundle ref), intersection with skip reporting (3 sources, one missing a referenced local → 2 members + 1 skipped with the missing path named), mixed full-path + bundle refs (full-path ref appears verbatim in every rewritten member expr), deterministic member order (sorted by prefix), zero-bundle-refs error, zero-eligible-sources error.
- [ ] **Step 2: Run** `./scripts/test.sh core derived_bundle` — expect FAIL, then implement `expand` per the interface: list quoted refs with `expr`'s helper; classify each (full path → leave; else bundle local if any source has it; else `UnknownIdentifier` bubbles from the existing engine later); intersect; span-rewrite per member (`prefix + "/" + local`). Run again — expect PASS.
- [ ] **Step 3: Session v16.** Add `DerivedBundleState { "name": "string", "expr": "string" }` and required `"derived_bundles": "DerivedBundleState[]"` to `Session`; bump to 16; `./scripts/codegen.sh`; rung (own arm, not the pass-through group):

```rust
15 => {
    value["derived_bundles"] = serde_json::json!([]);
    value["schema_version"] = serde_json::json!(16);
    migrate(16, value)
}
```

with a v15→16 test and the v13 fixture still chaining; update the conformance fixture and the `baked-session.ts` validator.

- [ ] **Step 4: Run** `./scripts/test.sh quick` — expect PASS. Commit — `git commit -m "feat(core): derived bundle expansion with session v16"`

---

### Task 25: Protocol v13 — shell commands and dynamic re-expansion

**Files:**

- Modify: `protocol/schema/scope-protocol.json` (v13), `shell/src-tauri/src/lib.rs` (new commands beside `create_derived`; re-expansion hooks where batch completion and restore already reload signals)
- Regenerate: `./scripts/codegen.sh`
- Test: shell inline tests (follow the existing `create_derived` test's fixture pattern)

**Interfaces:**

- Produces (schema, v13): `CreateDerivedBundleRequest { name: string, expr: string }`; `SkippedMemberSummary { prefix: string, missing: string[] }`; `DerivedBundleResponse { local_path: string, created: SignalSummary[], skipped: SkippedMemberSummary[] }`; `RemoveDerivedBundleRequest { name: string }`.
- Produces (commands): `create_derived_bundle`, `remove_derived_bundle`.
- Consumes: `derived_bundle::expand` (Task 24) and the existing single-derived evaluation/registration path inside `create_derived` — factor its body so both commands share evaluation, spill, and charge bookkeeping; register each member under its **member source's** `SourceId` with local path `derived/<name>` (read how `create_derived` registers under `derived_source` and generalize the source parameter).

- [ ] **Step 1:** Schema changes + codegen.
- [ ] **Step 2: Failing shell test:** two CSV sources sharing `temp` and `alt`, one source with only `temp`; `create_derived_bundle { name: "score", expr: "'temp' .* 2" }` → 3 created (all have `temp`); with `expr: "'temp' + 'alt'"` → 2 created, 1 skipped naming `alt`; members are queryable via ordinary tiles; `remove_derived_bundle` removes every member and the definition; a second `create_derived_bundle` with the same name errors.
- [ ] **Step 3: Implement** the two commands. Store the definition in `DataState` next to the session-persisted `derived_bundles` (the session save path must include it — read where `derived` signals are folded into the saved session and mirror it). Registration per member is transactional per source: a member whose evaluation fails (e.g. length mismatch inside one source) becomes a `skipped` entry with the error text as `missing`-style detail — the partial-bundle rule, not a command failure.
- [ ] **Step 4: Re-expansion.** Where the shell reloads signals after a terminal batch and after restore reconciliation, re-run every stored definition: create members for newly eligible sources, leave existing members untouched (idempotent — skip sources that already have `derived/<name>`). Removing a source already removes its signals; verify with a test that a re-expansion after removal does not resurrect anything.
- [ ] **Step 5: Run** `./scripts/test.sh shell && ./scripts/test.sh frontend` (codegen check) — expect PASS. Commit — `git commit -m "feat(protocol): v13 derived bundles"`

---

### Task 26: Frontend — formula bar bundles, tree rows, workspace state

**Files:**

- Modify: `frontend/src/app/data-plane.ts` (`DerivedPort` :59 gains the two calls), `frontend/src/app/formula-completion.ts` (bundle locals in completions), `frontend/src/ui/formula-bar.ts` + `frontend/src/ui/signal-tree.ts` (bundle drag inserts quoted local path), `frontend/src/ui/app-shell.ts` (`createDerived` :1750 routes to the bundle port when the response is a bundle; skip-report toast via the existing error/status surface), `frontend/src/app/workspace.ts` (`addDerivedBundle`/`removeDerivedBundle` mirroring `addDerived`)
- Test: `frontend/src/app/formula-completion.test.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Produces: `DerivedPort.createBundle(name: string, expr: string): Promise<DerivedBundleResponse>`; `DerivedPort.removeBundle(name: string): Promise<void>`; `Workspace.addDerivedBundle(name: string, expr: string)` / `.removeDerivedBundle(name)` / `.derivedBundles()`.
- Consumes: Task 25's commands; `quoteSignalPath` / `insertSignalReference` (`formula.ts:60-65`).

- [ ] **Step 1 (failing tests):** completions offer bundle local paths labeled with run counts when the input prefix matches (`formula-completion.test.ts`, mirroring the existing signal-completion cases); workspace add/remove/round-trip for `derived_bundles`.
- [ ] **Step 2:** Implement completions (the completion source already receives signal paths from `app-shell:1830`; extend it to also receive `{ localPath, runCount }` bundle entries built from the same membership map Task 22 added to the tree view). Dragging a bundle row into the formula input inserts `quoteSignalPath(localPath)` via the same handler leaves use.
- [ ] **Step 3:** Route creation: `createDerived` first calls the ordinary `create` and falls back to `createBundle` **only** on the shell's zero-bundle-refs/bundle-refs-present signal — simplest is to try `createBundle` when any quoted ref in the expression matches a known bundle local path (the frontend has the membership map; keep the decision in one small function with a unit test). On success: `workspace.addDerivedBundle`, reload signals (members arrive as ordinary signals; the tree bundles them automatically), and surface `skipped` as a non-blocking notice: `created for 6 of 8 runs — run_03 missing 'response'`.
- [ ] **Step 4:** Tree: a bundle row whose local path starts with `derived/` shows the existing ƒx mark and a remove control that calls `removeDerivedBundle` (definition + members); member rows show ƒx but no remove. Reuse the existing derived-leaf affordances (`signal-tree.ts:234-252` pattern).
- [ ] **Step 5: Run** `./scripts/test.sh frontend` — expect PASS. Commit — `git commit -m "feat(ui): derived bundles from the formula bar"`

---

### Task 27: Partial-bundle audit tests

**Files:**

- Create: `frontend/src/app/partial-bundle.test.ts` (one fixture, every operation)
- Modify: none (this task only adds tests; any failure it finds is fixed where it lives, with the fix noted in the commit)

**Interfaces:** none new.

- [ ] **Step 1:** Build one shared fixture: sets with sources `run_01..run_03`, local paths `temp` (3 runs), `alt` (2 runs — `run_03` lacks it). Assert, against the real modules (not mocks) wherever a unit seam exists:
  - plotting the `alt` bundle adds exactly 2 series;
  - XY with `x_signal` resolving to `alt` omits `run_03`'s trace (Task 14 rule);
  - color resolving to `alt` leaves `run_03`'s trace uncolored (Task 16 rule);
  - a highlight entry whose `path` is no longer in the panel is ignored;
  - a favorite bundle for a local path with zero members renders muted;
  - `derived_bundle::expand`-backed creation over `'temp' + 'alt'` skips `run_03` (already covered in Rust — here assert the frontend notice formatting).
- [ ] **Step 2:** Run `./scripts/test.sh frontend`; fix anything the audit exposes at its source.
- [ ] **Step 3: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, `./scripts/version.sh bump major && ./scripts/version.sh check` (session v16 + protocol v13). Manual: `./scripts/run.sh`, load `examples/monte_carlo`, create `score = 'command' - 'response'`, confirm a ƒx bundle appears and plots per-source; remove it; reload the session.
- [ ] **Step 4: Commit** — `git commit -m "feat!: derived bundles with the partial-bundle rule"`

---

## Addendum F (2026-07-31): reserved `derived/` prefix in the tree

Implements the spec's "Derived rows and reserved prefixes" section.
Tasks 1–27 are implemented. Observed defect: the segment hierarchy from
Task 20 treats `derived/` as an ordinary segment, so derived bundles nest
under a collapsible `derived` group sandwiched among flat bundle rows,
and the plain tree emits a second, unrelated `derived` group for
unsourced derived leaves.

### Task 28: Flatten derived rows; single-segment derived bundle names

**Files:**

- Modify: `frontend/src/app/tree-model.ts` (both the bundle-hierarchy walk from Task 20 and the plain-tree walk at the group-emission step), the derived-bundle name validation (wherever Task 25's `create_derived_bundle` validates `name` — shell side — plus the frontend creation path from Task 26)
- Test: `frontend/src/app/tree-model.test.ts`; the shell `create_derived_bundle` tests

**Interfaces:** none new. Behavior:

- In the bundle segment hierarchy: a local path starting with `"derived/"` emits **no group rows**; the bundle row sits at the section's base depth with `label` = the path minus the `"derived/"` prefix, and sorts among sibling bundles by that label.
- In the plain tree: a path starting with `"derived/"` skips group emission and renders as a top-level leaf labeled past the prefix (the ƒx mark rendering in `signal-tree.ts` keys off the full path and is unchanged).
- `create_derived_bundle` rejects names containing `/` with a clear error; the frontend surfaces it verbatim.

- [ ] **Step 1: Write the failing tests:**

```ts
it("derived bundles render top-level, labeled by name, sorted among bundles", () => {
  // paths: run_01/command, run_02/command, run_01/derived/temp,
  // run_02/derived/temp, run_01/response, run_02/response (one set)
  // expect rows in order: command, response, temp — all kind "bundle",
  // all depth 0, and NO group row with label "derived" anywhere.
});

it("unsourced derived leaves are ungrouped", () => {
  // paths: ["derived/score"] with no sets — expect exactly one leaf,
  // depth 0, label "score"; no "derived" group row.
});
```

(Adjust the first test's expected label for `temp` to `"temp"` — the label is the local path minus `"derived/"`.)

- [ ] **Step 2: Run** `./scripts/test.sh unit tree-model` — expect FAIL (today both cases emit a `derived` group).
- [ ] **Step 3: Implement** the two rendering rules in `tree-model.ts`. Keep the change at the segmentation step (treat the whole `derived/<name>` as a single leaf/bundle segment when it starts with the reserved prefix) rather than special-casing row emission in two places. Update any Task 20 tests that asserted the old nesting.
- [ ] **Step 4: Name validation.** In the shell command, reject `name.contains('/')` with `"derived bundle names are a single segment"` (test it); mirror the check in the frontend creation function from Task 26 so the error surfaces before a round trip.
- [ ] **Step 5: Run** `./scripts/test.sh quick && ./scripts/test.sh shell` — expect PASS.
- [ ] **Step 6: Gate + version.** `./scripts/format.sh`, `./scripts/test.sh full`, `./scripts/version.sh bump patch && ./scripts/version.sh check` (rendering + validation only, no schema change). Manual: `./scripts/run.sh`, recreate the screenshot scenario — `command`, `response`, `temp ƒx`, `temperature` as four flat rows.
- [ ] **Step 7: Commit** — `git commit -m "fix(tree): flatten derived rows under a reserved prefix"`

---

## Deferred (explicitly out of scope for this plan)

- Dimming in XY/FFT/histogram vertex rendering if the vertex path doesn't already thread per-series flags (Task 11 notes the restriction; a follow-up can extend it).
- The infra defect list from the 2026-07-31 audit (resident-budget leak on reset, admission reconcile deadlock, global page budget, `Column::as_slice` paging bypass, registry clone under the store lock, `RestoreGate` wedging, stale single-flight entries, `SetKey` collision). File as issues; none block this plan.
- Set-scoped derived signals and any bundle statistics overlays (mean/min/max lines) — new design work if ever wanted.

## Self-Review

**Spec coverage.** Decision + deletions → Tasks 2, 4, 5 (UI, core/shell, protocol). UI restraint → Global Constraints + Task 2 (select deleted, nothing added). Tree behavior → Tasks 7, 8 (expandable rows, drag payloads, one-mutation plot via Task 1). Panel state/highlights → Tasks 6, 9, 10, 11. Per-source XY resolution → Task 12. Snapshots/listSets → Task 3, manifest change in Task 5. Schema and migration → Task 6. Validation section → each task's tests plus Task 13 (e2e, grep gates).

**Ordering.** Frontend uses of ensemble types are removed (Tasks 2–3) before the generated types disappear (Tasks 5–6), so every task leaves the tree compiling. Task 6 depends on Task 4 having removed the Rust consumers of `PanelState.ensemble` outside `session.rs`.

**Known judgment calls for the executor.** Exact line numbers drift as tasks land — symbol names are authoritative. Where a step says "follow the existing pattern," read the named neighbor first; do not invent new harnesses, tokens, or helpers.
