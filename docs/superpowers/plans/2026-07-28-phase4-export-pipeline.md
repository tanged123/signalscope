# Phase 4 Export Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship HTML snapshot export (versioned manifest = baked session + pyramid levels injected into the template), the size-budget export dialog with PNG and visible-CSV exports, a minimal headless bake CLI, and a CI round-trip proof.

**Architecture:** A new `scope-core::snapshot` module owns `plan`/`estimated_bytes`/`bake`/`inject` over `(store, pyramids, session)`. Two thin consumers: Tauri commands (`export_estimate`, `export_write`, `save_export_file`) and a `scope-bake` bin. The manifest joins the existing protocol schema as `SnapshotManifest { session_json, signals }`; `BakedPlane` learns to boot the baked session. Spec: `docs/superpowers/specs/2026-07-28-phase4-export-pipeline-design.md`.

**Tech Stack:** Rust (scope-core, Tauri v2), TypeScript (vanilla DOM, vitest, Playwright), JSON-schema codegen via `protocol/scripts/generate-types.mjs`.

## Global Constraints

- Run everything through `./scripts/` wrappers (AGENTS.md): tests `./scripts/test.sh [quick|core|frontend|e2e|full]`, codegen `./scripts/codegen.sh`, format `./scripts/format.sh`, CI parity `./scripts/ci.sh`.
- All commands run from the worktree root `/home/tanged/sources/signalscope/.claude/worktrees/phase4`. Do not `cd` to the original repo.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`); end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The decimation ceiling is **2,048 bins per baked level per signal**. The template size gate (`frontend/scripts/check-snapshot.mjs`, 750 kB) is **unchanged**.
- `u64` schema fields serialize as **strings** in TS (`signal_id: string`); only `u64` and `u64[]` forms are allowed by codegen — never `u64[][]`.
- The Tauri command arg key is always `request`, sealed in an `Envelope`; command names are snake_case.
- New TS exports must be reachable from `frontend/src/main.ts` or `knip` fails the lint gate.
- vitest runs in Node (no jsdom): unit-test pure logic; DOM behavior is covered by Playwright e2e or thin untested glue.
- Preserve determinism: store iteration is `BTreeMap`-ordered; bake output must be byte-stable for identical inputs.

---

### Task 1: Snapshot and export types in the protocol schema

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Regenerate: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts` (via `./scripts/codegen.sh`)
- Modify: `frontend/src/app/data-plane.ts` (BakedManifest → generated types)
- Test: existing suites (`frontend/src/app/data-plane.test.ts`, cargo tests) must stay green

**Interfaces:**

- Consumes: existing `Envelope`, `EnvelopeBin`, `SignalSummary` schema types.
- Produces (used by every later task): Rust `scope_protocol::{SnapshotManifest, BakedSignal, ExportScope, ExportEstimate, ExportEstimateRequest, ExportWriteRequest, ExportFileKind, SaveExportFileRequest}` and the same names in `frontend/src/generated/protocol.ts`. `SnapshotManifest { session_json: String, signals: Vec<BakedSignal> }`, `BakedSignal { summary: SignalSummary, levels: Vec<Vec<EnvelopeBin>> }`, `ExportScope = visible | all`, `ExportEstimate { visible_bytes: u64, all_bytes: u64 }`.

- [ ] **Step 1: Add the types and bump the protocol version**

In `protocol/schema/scope-protocol.json`: change `"protocol_version": 5` to `6`, and add to `"types"` (after `LoadedSession`):

```json
"ExportScope": {
  "kind": "enum",
  "variants": ["visible", "all"]
},
"ExportEstimateRequest": {
  "kind": "object",
  "fields": {
    "session_json": "string"
  }
},
"ExportEstimate": {
  "kind": "object",
  "fields": {
    "visible_bytes": "u64",
    "all_bytes": "u64"
  }
},
"ExportWriteRequest": {
  "kind": "object",
  "fields": {
    "session_json": "string",
    "scope": "ExportScope"
  }
},
"ExportFileKind": {
  "kind": "enum",
  "variants": ["png", "csv"]
},
"SaveExportFileRequest": {
  "kind": "object",
  "fields": {
    "file_name": "string",
    "kind": "ExportFileKind",
    "data_base64": "string"
  }
},
"BakedSignal": {
  "kind": "object",
  "fields": {
    "summary": "SignalSummary",
    "levels": "EnvelopeBin[][]"
  }
},
"SnapshotManifest": {
  "kind": "object",
  "fields": {
    "session_json": "string",
    "signals": "BakedSignal[]"
  }
}
```

- [ ] **Step 2: Regenerate**

Run: `./scripts/codegen.sh`
Expected: `protocol/src/generated.rs` gains the structs (`levels: Vec<Vec<EnvelopeBin>>`), `frontend/src/generated/protocol.ts` gains the interfaces and `PROTOCOL_VERSION = 6`.

- [ ] **Step 3: Graduate `BakedManifest` in `data-plane.ts`**

Replace the local types (`frontend/src/app/data-plane.ts:53-58`):

```ts
interface BakedSignal {
  summary: SignalSummary;
  levels: EnvelopeBin[][];
}

type BakedManifest = Envelope<{ signals: BakedSignal[] }>;
```

with imports from generated code:

```ts
import type { SnapshotManifest } from "../generated/protocol";

type BakedManifest = Envelope<SnapshotManifest>;
```

(Add `SnapshotManifest` to the existing `import type` list rather than a new import if one exists.) In `createDemoManifest()` (`data-plane.ts:301-359`), the sealed object gains the new field: `return seal({ session_json: "", signals: ... })`. An empty `session_json` means "no baked session — demo boot" (Task 7 relies on this).

- [ ] **Step 4: Run the full test suite**

Run: `./scripts/test.sh quick`
Expected: PASS. Watch for two ripples: (a) any TS references to the old `BakedSignal` local type; (b) the protocol version bump invalidating pyramid sidecar caches or fixtures — if a cargo test fails on a version constant, read the failure and update the fixture via its documented `REGENERATE_FIXTURES=1` path only if the failure is version-text-only (bin values must not change).

- [ ] **Step 5: Commit**

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs frontend/src/generated/protocol.ts frontend/src/app/data-plane.ts
git commit -m "feat(protocol): add snapshot manifest and export types (v6)"
```

---

### Task 2: `scope-core::snapshot` — `plan()`

**Files:**

- Create: `core/scope-core/src/snapshot.rs`
- Modify: `core/scope-core/src/lib.rs` (add `pub mod snapshot;` to the module list)
- Test: inline `#[cfg(test)] mod tests` in `snapshot.rs`

**Interfaces:**

- Consumes: `crate::session::{Session, PanelState, PanelMode, LinkedTime, WorkspaceTab}` (generated; check exact enum variant casing in `core/scope-core/src/session/generated.rs` — codegen PascalCases variants: `PanelMode::Time`, `PanelMode::Xy`, …), `crate::store::{Signal, SignalId, SignalStore}`, `crate::pyramid::Pyramid`, `scope_protocol::ExportScope`.
- Produces (Tasks 3, 4, 6 use these exact names):

```rust
pub const MAX_BINS_PER_BAKED_LEVEL: usize = 2048;

pub struct SignalPlan {
    pub signal_id: SignalId,
    /// Logical index of the finest level to bake; 0 bakes raw samples.
    pub finest_level: usize,
    /// Clip window; `None` bakes the full range ("all" scope).
    pub window: Option<(f64, f64)>,
}

pub struct ExportPlan {
    pub signals: Vec<SignalPlan>,
}

pub fn plan(
    session: &Session,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    scope: ExportScope,
) -> ExportPlan
```

- [ ] **Step 1: Write the failing tests**

Create `core/scope-core/src/snapshot.rs` with only the test module and a `todo!()`-free skeleton that does not yet compile the logic — better: write tests first against the signatures above. Test helpers build a store + pyramids + session by hand:

```rust
#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::session::{PanelMode, PanelState, Session, SeriesState};
    use crate::store::SignalStore;

    fn store_with(signals: &[(&str, usize)]) -> (SignalStore, BTreeMap<SignalId, Pyramid>) {
        let mut store = SignalStore::new();
        let source = store.register_source("test.csv");
        let mut pyramids = BTreeMap::new();
        for (path, count) in signals {
            let time: Vec<f64> = (0..*count).map(|i| i as f64).collect();
            let values: Vec<f64> = time.iter().map(|t| t * 0.5).collect();
            let id = store
                .insert_signal(source, (*path).to_owned(), None, time.into(), values)
                .expect("insert");
            let signal = store.signal(id).expect("signal");
            pyramids.insert(id, Pyramid::from_signal(signal));
        }
        (store, pyramids)
    }

    fn time_panel(paths: &[&str]) -> PanelState {
        let mut panel = default_panel();          // build from Session::default()'s
        panel.mode = PanelMode::Time;             // panel or construct field-by-field;
        panel.series = paths                      // copy the exact PanelState fields
            .iter()                               // from session/generated.rs
            .map(|path| series(path))
            .collect();
        panel
    }

    #[test]
    fn all_scope_bakes_every_signal_full_range_from_level_zero() {
        let (store, pyramids) = store_with(&[("a", 10), ("b", 10_000)]);
        let session = Session::default();
        let plan = plan(&session, &store, &pyramids, ExportScope::All);
        assert_eq!(plan.signals.len(), 2);
        assert!(plan.signals.iter().all(|s| s.finest_level == 0));
        assert!(plan.signals.iter().all(|s| s.window.is_none()));
    }

    #[test]
    fn visible_scope_excludes_signals_on_no_panel() { /* session with one panel plotting "a"; assert only a's id planned */ }

    #[test]
    fn visible_scope_decimates_dense_time_signals() {
        // 100_000-point signal on a time panel over the full window:
        // finest_level must be the first logical level with <= 2048 bins
        // in-window, and > 0.
    }

    #[test]
    fn honesty_rule_bakes_raw_when_sparse() {
        // 500-point signal on a time panel: finest_level == 0.
    }

    #[test]
    fn sample_mode_panels_force_level_zero() {
        // 100_000-point signal on an fft panel: finest_level == 0 despite density.
    }

    #[test]
    fn xy_panels_pull_x_and_color_signals() {
        // xy panel with series ["y"], x_signal "x", color_signal "c":
        // all three ids planned; a time panel with x_signal set plans only its series.
    }

    #[test]
    fn window_is_the_union_of_panel_windows() {
        // linked_time (0,10); one unlinked panel with time_window [20,30]:
        // every SignalPlan.window == Some((0.0, 30.0)).
    }
}
```

Flesh each `/* */` body into real assertions while writing (they are one-liners over `plan(...)`). Where the skeleton says "copy the exact PanelState fields", open `core/scope-core/src/session/generated.rs` and construct the struct fully — every field, no `..Default::default()` (generated structs have no `Default`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p scope-core snapshot` (via `./scripts/dev.sh` shell if outside nix; plain cargo works inside).
Expected: FAIL — `plan` not found / module missing.

- [ ] **Step 3: Implement `plan()`**

```rust
//! Snapshot export planning, baking, and template injection (ADR 0024).

use std::collections::{BTreeMap, BTreeSet};

use crate::pyramid::Pyramid;
use crate::session::{LinkedTime, PanelMode, PanelState, Session};
use crate::store::{Signal, SignalId, SignalStore};
use scope_protocol::{EnvelopeBin, ExportScope};

pub const MAX_BINS_PER_BAKED_LEVEL: usize = 2048;

/// Mirrors `AppShell.effectiveWindow` (app-shell.ts): linked time applies
/// only to linked time-mode panels; otherwise the panel's own window, then
/// the linked window as fallback.
fn effective_window(panel: &PanelState, linked: &LinkedTime) -> (f64, f64) {
    if linked.linked && panel.mode == PanelMode::Time {
        return (linked.t0, linked.t1);
    }
    match panel.time_window {
        Some([t0, t1]) => (t0, t1),
        None => (linked.t0, linked.t1),
    }
}

/// Mirrors `AppShell.panelSignalIds`: series paths, plus the XY x/colour
/// signals for XY panels only.
fn panel_signal_paths(panel: &PanelState) -> Vec<&str> {
    let mut paths: Vec<&str> = panel.series.iter().map(|s| s.path.as_str()).collect();
    if panel.mode == PanelMode::Xy {
        if let Some(x) = panel.x_signal.as_deref() {
            paths.insert(0, x);
        }
        if let Some(color) = panel.color_signal.as_deref() {
            paths.push(color);
        }
    }
    paths
}

fn count_in_window(bins: &[EnvelopeBin], t0: f64, t1: f64) -> usize {
    let start = bins.partition_point(|bin| bin.t1 < t0);
    let end = bins.partition_point(|bin| bin.t0 <= t1);
    end.saturating_sub(start)
}

fn raw_count_in_window(signal: &Signal, t0: f64, t1: f64) -> usize {
    let time = signal.time();
    let start = time.partition_point(|t| *t < t0);
    let end = time.partition_point(|t| *t <= t1);
    end.saturating_sub(start)
}

/// First logical level with at most `MAX_BINS_PER_BAKED_LEVEL` bins inside
/// the window; the honesty rule bakes raw data when it is already sparse.
fn finest_level(signal: &Signal, pyramid: &Pyramid, t0: f64, t1: f64) -> usize {
    if raw_count_in_window(signal, t0, t1) <= MAX_BINS_PER_BAKED_LEVEL {
        return 0;
    }
    for (index, level) in pyramid.merged_levels().iter().enumerate() {
        if count_in_window(level, t0, t1) <= MAX_BINS_PER_BAKED_LEVEL {
            return index + 1;
        }
    }
    pyramid.level_count().saturating_sub(1)
}

pub fn plan(
    session: &Session,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    scope: ExportScope,
) -> ExportPlan {
    if scope == ExportScope::All {
        return ExportPlan {
            signals: store
                .signals()
                .map(|signal| SignalPlan {
                    signal_id: signal.id,
                    finest_level: 0,
                    window: None,
                })
                .collect(),
        };
    }

    let mut window: Option<(f64, f64)> = None;
    let mut wanted: BTreeSet<SignalId> = BTreeSet::new();
    let mut needs_raw: BTreeSet<SignalId> = BTreeSet::new();
    for tab in &session.tabs {
        for panel in &tab.panels {
            let (t0, t1) = effective_window(panel, &session.linked_time);
            window = Some(match window {
                Some((w0, w1)) => (w0.min(t0), w1.max(t1)),
                None => (t0, t1),
            });
            for path in panel_signal_paths(panel) {
                if let Some(signal) = store.signal_by_path(path) {
                    wanted.insert(signal.id);
                    if panel.mode != PanelMode::Time {
                        needs_raw.insert(signal.id);
                    }
                }
            }
        }
    }
    let Some((t0, t1)) = window else {
        return ExportPlan { signals: Vec::new() };
    };

    ExportPlan {
        signals: wanted
            .into_iter()
            .filter_map(|id| {
                let signal = store.signal(id)?;
                let pyramid = pyramids.get(&id)?;
                let finest = if needs_raw.contains(&id) {
                    0
                } else {
                    finest_level(signal, pyramid, t0, t1)
                };
                Some(SignalPlan {
                    signal_id: id,
                    finest_level: finest,
                    window: Some((t0, t1)),
                })
            })
            .collect(),
    }
}
```

Plus the `SignalPlan`/`ExportPlan` structs from the Interfaces block. Register the module: in `core/scope-core/src/lib.rs`, add `pub mod snapshot;` alphabetically among the existing `pub mod` lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p scope-core snapshot`
Expected: PASS (all 7 tests). Then `cargo clippy -p scope-core --all-targets -- -D warnings` — fix any lint (the codebase is `-D warnings`).

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/snapshot.rs core/scope-core/src/lib.rs
git commit -m "feat(core): snapshot export planning with budget rule"
```

---

### Task 3: `scope-core::snapshot` — `bake()` and `inject()`

**Files:**

- Modify: `core/scope-core/src/snapshot.rs`
- Test: same inline test module

**Interfaces:**

- Consumes: Task 2's `ExportPlan`, `scope_protocol::{SnapshotManifest, BakedSignal, SignalSummary, Envelope}`.
- Produces (Tasks 5 and 6 call these exact signatures):

```rust
#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    #[error("template is missing the #signalscope-baked-data slot")]
    MissingSlot,
    #[error("manifest serialization failed: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub fn bake(
    plan: &ExportPlan,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    session: &Session,
) -> Result<SnapshotManifest, SnapshotError>

pub fn inject(template: &str, manifest: &SnapshotManifest) -> Result<String, SnapshotError>
```

(Check `core/scope-core/Cargo.toml` — `thiserror` and `serde_json` are already workspace deps used by session.rs; if `thiserror` is not in scope-core's deps, mirror how `SessionError` in session.rs declares its error enum instead.)

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn bake_clears_source_paths_and_orders_signals_by_id() {
    let (store, pyramids) = store_with(&[("b", 100), ("a", 100)]);
    let mut session = Session::default();
    session.source_paths = vec!["/home/user/secret.csv".to_owned()];
    let plan = plan(&session, &store, &pyramids, ExportScope::All);
    let manifest = bake(&plan, &store, &pyramids, &session).expect("bake");
    assert!(!manifest.session_json.contains("secret.csv"));
    let ids: Vec<u64> = manifest.signals.iter().map(|s| s.summary.signal_id).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted);
}

#[test]
fn baked_levels_are_positional_from_the_finest_planned_level() {
    // Signal of 100_000 points, plan with finest_level = L > 0 (visible scope):
    // manifest.signals[0].levels.len() == pyramid.level_count() - L, and
    // levels[0] equals pyramid.level(L) clipped to the window.
}

#[test]
fn clipping_retains_one_neighbor_bin_each_side() {
    // 1000-point signal, window (100.0, 200.0), finest_level 0:
    // first baked bin t0 <= 100.0 with exactly one bin before the window,
    // matching Pyramid::query's edge retention.
}

#[test]
fn bake_serializes_deterministically() {
    // bake twice; serde_json::to_string of both manifests is byte-identical.
}

#[test]
fn inject_replaces_the_slot_atomically() {
    let template = "<html><script id=\"signalscope-baked-data\" type=\"application/json\">\n      null\n    </script></html>";
    let manifest = SnapshotManifest { session_json: "{}".to_owned(), signals: Vec::new() };
    let html = inject(template, &manifest).expect("inject");
    assert!(!html.contains(">null<") && !html.contains("null\n"));
    assert!(html.contains("\"session_json\""));
    assert!(html.starts_with("<html><script id=\"signalscope-baked-data\""));
    assert!(html.ends_with("</script></html>"));
}

#[test]
fn inject_escapes_closing_script_sequences() {
    // Session whose tab title is "</script><script>alert(1)</script>":
    // baked JSON in the output must contain no literal "</script" except
    // the slot's own closing tag; the payload form is "<\\/script".
}

#[test]
fn inject_without_slot_errors() {
    assert!(matches!(inject("<html></html>", &empty_manifest()), Err(SnapshotError::MissingSlot)));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p scope-core snapshot`
Expected: FAIL — `bake`/`inject` not found.

- [ ] **Step 3: Implement**

```rust
fn clip(bins: Vec<EnvelopeBin>, window: Option<(f64, f64)>) -> Vec<EnvelopeBin> {
    let Some((t0, t1)) = window else { return bins };
    if bins.iter().all(|bin| bin.t1 < t0 || bin.t0 > t1) {
        return Vec::new();
    }
    let start = bins.partition_point(|bin| bin.t1 < t0).saturating_sub(1);
    let end = bins
        .partition_point(|bin| bin.t0 <= t1)
        .saturating_add(1)
        .min(bins.len());
    bins[start..end].to_vec()
}

fn signal_summary(signal: &Signal) -> SignalSummary {
    let (t_min, t_max) = signal.time_bounds();
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min,
        t_max,
    }
}

pub fn bake(
    plan: &ExportPlan,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
    session: &Session,
) -> Result<SnapshotManifest, SnapshotError> {
    let mut baked_session = session.clone();
    baked_session.source_paths.clear();

    let mut signals = Vec::new();
    for entry in &plan.signals {
        let Some(signal) = store.signal(entry.signal_id) else { continue };
        let Some(pyramid) = pyramids.get(&entry.signal_id) else { continue };
        let levels = (entry.finest_level..pyramid.level_count())
            .filter_map(|index| pyramid.level(index))
            .map(|bins| clip(bins, entry.window))
            .collect();
        signals.push(BakedSignal {
            summary: signal_summary(signal),
            levels,
        });
    }
    signals.sort_by_key(|signal| signal.summary.signal_id);

    Ok(SnapshotManifest {
        session_json: serde_json::to_string(&baked_session)?,
        signals,
    })
}

const SLOT_MARKER: &str = "id=\"signalscope-baked-data\"";

/// ADR 0007: atomic replacement of the baked-data slot, escaping any
/// closing-script sequence inside the JSON payload.
pub fn inject(template: &str, manifest: &SnapshotManifest) -> Result<String, SnapshotError> {
    let sealed = scope_protocol::Envelope::new(manifest.clone());
    let json = serde_json::to_string(&sealed)?.replace("</script", "<\\/script");

    let marker = template.find(SLOT_MARKER).ok_or(SnapshotError::MissingSlot)?;
    let open_end = template[marker..]
        .find('>')
        .map(|offset| marker + offset + 1)
        .ok_or(SnapshotError::MissingSlot)?;
    let close = template[open_end..]
        .find("</script")
        .map(|offset| open_end + offset)
        .ok_or(SnapshotError::MissingSlot)?;

    let mut html = String::with_capacity(template.len() + json.len());
    html.push_str(&template[..open_end]);
    html.push_str(&json);
    html.push_str(&template[close..]);
    Ok(html)
}
```

`Envelope::new` requires `Clone` on the payload — generated structs derive `Clone`. Check `Envelope` derives `Serialize` for any `T: Serialize` (it does; `save_session` relies on it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p scope-core snapshot && cargo clippy -p scope-core --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/snapshot.rs
git commit -m "feat(core): snapshot bake and template injection"
```

---

### Task 4: `scope-core::snapshot` — `estimated_bytes()`

**Files:**

- Modify: `core/scope-core/src/snapshot.rs`

**Interfaces:**

- Produces (Task 6 calls this):

```rust
/// Rough serialized size of the data half of a bake, from level metadata
/// only — no serialization. The dialog labels the result with "~".
pub fn estimated_bytes(
    plan: &ExportPlan,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
) -> u64
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn estimate_counts_planned_bins_without_serializing() {
    // "all" plan over store_with(&[("a", 1000)]): expected bins =
    // sum over logical levels of level(i).len() (1000 + 500 + ... + 1);
    // assert estimated_bytes == expected_bins * BYTES_PER_BIN.
}

#[test]
fn estimate_shrinks_with_visible_scope() {
    // dense signal, small visible window: visible estimate < all estimate.
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p scope-core snapshot`
Expected: FAIL — `estimated_bytes` not found.

- [ ] **Step 3: Implement**

```rust
/// Measured against serde_json output of a typical EnvelopeBin (~11 numeric
/// fields with string-serialized u64s); precision is not a goal.
const BYTES_PER_BIN: u64 = 200;

pub fn estimated_bytes(
    plan: &ExportPlan,
    store: &SignalStore,
    pyramids: &BTreeMap<SignalId, Pyramid>,
) -> u64 {
    let mut bins: u64 = 0;
    for entry in &plan.signals {
        let Some(signal) = store.signal(entry.signal_id) else { continue };
        let Some(pyramid) = pyramids.get(&entry.signal_id) else { continue };
        for index in entry.finest_level..pyramid.level_count() {
            let count = match (index, entry.window) {
                (0, None) => signal.len(),
                (0, Some((t0, t1))) => raw_count_in_window(signal, t0, t1),
                (_, None) => pyramid.merged_levels()[index - 1].len(),
                (_, Some((t0, t1))) => {
                    count_in_window(&pyramid.merged_levels()[index - 1], t0, t1)
                }
            };
            bins += count as u64;
        }
    }
    bins * BYTES_PER_BIN
}
```

- [ ] **Step 4: Run tests, then commit**

Run: `cargo test -p scope-core snapshot && cargo clippy -p scope-core --all-targets -- -D warnings`
Expected: PASS.

```bash
git add core/scope-core/src/snapshot.rs
git commit -m "feat(core): snapshot size estimation from level metadata"
```

---

### Task 5: `scope-bake` CLI and `./scripts/export.sh`

**Files:**

- Create: `core/scope-core/src/bin/scope-bake.rs`
- Create: `scripts/export.sh` (chmod +x)
- Modify: `AGENTS.md` (add `export.sh` to the canonical script list, ~lines 60-80)

**Interfaces:**

- Consumes: `scope_core::{ingest::ingest_path, pyramid::Pyramid, session, snapshot, store::SignalStore}`.
- Produces: `./scripts/export.sh --data <file>... [--workspace <file>] [--template <path>] --out <path>` — always all-loaded scope (spec). Default template: `frontend/dist/snapshot-template.html`. Task 10's round trip calls this wrapper.

- [ ] **Step 1: Write the CLI**

`core/scope-core/src/bin/scope-bake.rs` — std-only arg parsing, no new dependencies:

```rust
//! Minimal internal snapshot baker: data files in, snapshot HTML out.
//! Always bakes all-loaded scope; visible-window baking is in-app only.
//! No stability promise — ./scripts/export.sh is the supported entry point.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use scope_core::{ingest, pyramid::Pyramid, session, snapshot, store::SignalStore};
use scope_protocol::ExportScope;

struct Args {
    data: Vec<PathBuf>,
    workspace: Option<PathBuf>,
    template: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut data = Vec::new();
    let mut workspace = None;
    let mut template = None;
    let mut out = None;
    let mut iter = std::env::args().skip(1);
    while let Some(flag) = iter.next() {
        let mut value = |name: &str| iter.next().ok_or(format!("{name} needs a value"));
        match flag.as_str() {
            "--data" => data.push(PathBuf::from(value("--data")?)),
            "--workspace" => workspace = Some(PathBuf::from(value("--workspace")?)),
            "--template" => template = Some(PathBuf::from(value("--template")?)),
            "--out" => out = Some(PathBuf::from(value("--out")?)),
            other => return Err(format!("unknown flag: {other}")),
        }
    }
    if data.is_empty() {
        return Err("at least one --data file is required".to_owned());
    }
    Ok(Args {
        data,
        workspace,
        template: template
            .unwrap_or_else(|| PathBuf::from("frontend/dist/snapshot-template.html")),
        out: out.ok_or("--out is required")?,
    })
}

fn run(args: &Args) -> Result<(), String> {
    let mut store = SignalStore::new();
    let mut pyramids = BTreeMap::new();
    for path in &args.data {
        let summary = ingest::ingest_path(path, &mut store, &mut |_| ())
            .map_err(|error| format!("ingest {}: {error}", path.display()))?;
        for id in summary.signals {
            let signal = store.signal(id).ok_or("ingested signal vanished")?;
            pyramids.insert(id, Pyramid::from_signal(signal));
        }
    }
    let session = match &args.workspace {
        Some(path) => session::load_from_path(path)
            .map_err(|error| format!("workspace {}: {error}", path.display()))?,
        None => session::Session::default(),
    };
    let template = std::fs::read_to_string(&args.template).map_err(|error| {
        format!(
            "template {}: {error}; run ./scripts/build.sh web first",
            args.template.display()
        )
    })?;
    let plan = snapshot::plan(&session, &store, &pyramids, ExportScope::All);
    let manifest = snapshot::bake(&plan, &store, &pyramids, &session)
        .map_err(|error| error.to_string())?;
    let html = snapshot::inject(&template, &manifest).map_err(|error| error.to_string())?;
    if let Some(parent) = args.out.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&args.out, html).map_err(|error| error.to_string())?;
    Ok(())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("scope-bake: {message}");
            eprintln!("usage: scope-bake --data <file>... [--workspace <file>] [--template <path>] --out <path>");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("scope-bake: {message}");
            ExitCode::FAILURE
        }
    }
}
```

Note: `ingest_path` + `Pyramid::from_signal` deliberately avoids `cache::ingest_or_load`, which would write `.sspyr` sidecars beside fixture files.

- [ ] **Step 2: Write the wrapper**

`scripts/export.sh`, following the `run.sh` template:

```bash
#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_dev_shell "$@"

show_help() {
  cat <<'EOF'
Usage: ./scripts/export.sh --data <file>... [--workspace <file>] --out <path>

Bakes a self-contained HTML snapshot from data files (all-loaded scope).
Builds the frontend snapshot template first, then runs the scope-bake CLI.
EOF
}

case "${1:-}" in
-h | --help | help | "")
  show_help
  exit 0
  ;;
esac

"$signalscope_scripts_dir/build.sh" web
cargo run --quiet -p scope-core --bin scope-bake -- "$@"
```

Run `chmod +x scripts/export.sh`.

- [ ] **Step 3: Verify end-to-end by hand**

Run: `./scripts/export.sh --data examples/demo_flight.csv --out build/export/demo.html`
Then: `node -e "const s=require('fs').readFileSync('build/export/demo.html','utf8'); const i=s.indexOf('signalscope-baked-data'); console.log(s.slice(i, i+200)); console.log('bytes', s.length);"`
Expected: the slot contains `{"protocol_version":6,"payload":{"session_json":...` — not `null`; total bytes well above the 750 kB template (data added).
Also: `shellcheck scripts/export.sh` — clean (the quality gate runs it).

- [ ] **Step 4: Update AGENTS.md**

Add one line to the canonical scripts list, matching its formatting: `./scripts/export.sh` — bake a self-contained HTML snapshot from data files (internal CLI behind the Phase 4 export pipeline).

- [ ] **Step 5: Run gates and commit**

Run: `./scripts/test.sh core && shellcheck scripts/*.sh`
Expected: PASS.

```bash
git add core/scope-core/src/bin/scope-bake.rs scripts/export.sh AGENTS.md
git commit -m "feat(cli): scope-bake snapshot CLI behind scripts/export.sh"
```

---

### Task 6: Tauri commands — `export_estimate`, `export_write`, `save_export_file`

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`
- Modify: `shell/src-tauri/tauri.conf.json` (bundle resources)
- Modify: `shell/src-tauri/Cargo.toml` (add `base64 = "0.22"`)
- Test: inline tests in `lib.rs` for the pure helpers

**Interfaces:**

- Consumes: Task 1's protocol types, Tasks 2-4's `snapshot::{plan, bake, inject, estimated_bytes}`.
- Produces (Task 7's `TauriPlane` invokes these): commands `export_estimate` (`Envelope<ExportEstimateRequest>` → `Envelope<ExportEstimate>`), `export_write` (`Envelope<ExportWriteRequest>` → `Envelope<Option<String>>`, `None` = user cancelled), `save_export_file` (`Envelope<SaveExportFileRequest>` → `Envelope<Option<String>>`).

- [ ] **Step 1: Bundle the template as a resource**

In `shell/src-tauri/tauri.conf.json`, add to `"bundle"`:

```json
"resources": {
  "../../frontend/dist/snapshot-template.html": "snapshot-template.html"
}
```

(`beforeBuildCommand` already runs `pnpm build`, which emits the template — ordering holds for packaged builds. `beforeDevCommand` runs `pnpm dev`, which does not, hence the dev fallback below.)

- [ ] **Step 2: Write failing unit tests for the helpers**

Add to the `tests` module in `lib.rs`:

```rust
#[test]
fn export_html_paths_gain_the_extension() {
    assert_eq!(
        normalized_export_save_path(PathBuf::from("/tmp/snap"), "html"),
        PathBuf::from("/tmp/snap.html")
    );
    assert_eq!(
        normalized_export_save_path(PathBuf::from("/tmp/snap.html"), "html"),
        PathBuf::from("/tmp/snap.html")
    );
}

#[test]
fn estimate_covers_both_scopes_from_state() {
    let (data, _) = data_with_signal("input/x");
    let session = session::Session::default();
    let estimate = estimate_for(&data, &session, "{}", 1000);
    assert!(estimate.all_bytes > estimate.visible_bytes);
    assert!(estimate.visible_bytes >= 1000); // template floor
}
```

Run: `cargo test -p signalscope-shell`
Expected: FAIL — helpers not defined.

- [ ] **Step 3: Implement**

Add imports (`scope_core::snapshot`, `scope_protocol::{ExportEstimate, ExportEstimateRequest, ExportFileKind, ExportScope, ExportWriteRequest, SaveExportFileRequest, SnapshotManifest}` — trim to what compiles), `use base64::Engine;`, and:

```rust
fn normalized_export_save_path(mut path: PathBuf, extension: &str) -> PathBuf {
    if path.extension().is_none_or(std::ffi::OsStr::is_empty) {
        path.set_extension(extension);
    }
    path
}

/// Bundled template in packaged builds; the freshly built frontend
/// artifact in dev, where `cargo tauri dev` skips the snapshot build.
fn template_path(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri::path::BaseDirectory;
    if let Ok(path) = app
        .path()
        .resolve("snapshot-template.html", BaseDirectory::Resource)
    {
        if path.exists() {
            return Ok(path);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../frontend/dist/snapshot-template.html");
    if dev.exists() {
        return Ok(dev);
    }
    Err("snapshot template is missing; run ./scripts/build.sh web".to_owned())
}

fn estimate_for(
    data: &DataState,
    session: &session::Session,
    session_json: &str,
    template_bytes: u64,
) -> ExportEstimate {
    let base = template_bytes + session_json.len() as u64;
    let visible = snapshot::plan(session, &data.store, &data.pyramids, ExportScope::Visible);
    let all = snapshot::plan(session, &data.store, &data.pyramids, ExportScope::All);
    ExportEstimate {
        visible_bytes: base + snapshot::estimated_bytes(&visible, &data.store, &data.pyramids),
        all_bytes: base + snapshot::estimated_bytes(&all, &data.store, &data.pyramids),
    }
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn export_estimate(
    request: Envelope<ExportEstimateRequest>,
    app: AppHandle,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<ExportEstimate>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let session = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let template_bytes = std::fs::metadata(template_path(&app)?)
        .map_err(|error| error.to_string())?
        .len();
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(estimate_for(
        &data,
        &session,
        &request.session_json,
        template_bytes,
    )))
}

#[tauri::command]
async fn export_write(
    request: Envelope<ExportWriteRequest>,
    app: AppHandle,
) -> Result<Envelope<Option<String>>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("HTML snapshot", &["html"])
            .set_file_name("snapshot.html")
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(Envelope::new(None));
    };
    let path = normalized_export_save_path(path, "html");

    let template = std::fs::read_to_string(template_path(&app)?)
        .map_err(|error| error.to_string())?;
    let session = session::from_json(&request.session_json).map_err(|error| error.to_string())?;
    let html = {
        let state = app.state::<Mutex<DataState>>();
        let data = state.lock().map_err(|error| error.to_string())?;
        let plan = snapshot::plan(&session, &data.store, &data.pyramids, request.scope);
        let manifest = snapshot::bake(&plan, &data.store, &data.pyramids, &session)
            .map_err(|error| error.to_string())?;
        snapshot::inject(&template, &manifest).map_err(|error| error.to_string())?
    };
    let staged = path.with_extension("html.tmp");
    std::fs::write(&staged, html).map_err(|error| error.to_string())?;
    std::fs::rename(&staged, &path).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(path.display().to_string())))
}

#[tauri::command]
async fn save_export_file(
    request: Envelope<SaveExportFileRequest>,
    app: AppHandle,
) -> Result<Envelope<Option<String>>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let (label, extension) = match request.kind {
        ExportFileKind::Png => ("PNG image", "png"),
        ExportFileKind::Csv => ("CSV", "csv"),
    };
    let file_name = request.file_name.clone();
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter(label, &[extension])
            .set_file_name(&file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else {
        return Ok(Envelope::new(None));
    };
    let path = normalized_export_save_path(path, extension);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&request.data_base64)
        .map_err(|error| error.to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(path.display().to_string())))
}
```

Register all three in `tauri::generate_handler![...]` (after `pick_session_path`). Add to `shell/src-tauri/Cargo.toml` dependencies: `base64 = "0.22"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p signalscope-shell && cargo clippy --workspace --all-targets -- -D warnings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src-tauri/src/lib.rs shell/src-tauri/tauri.conf.json shell/src-tauri/Cargo.toml Cargo.lock
git commit -m "feat(shell): export estimate/write and file-save commands"
```

---

### Task 7: Frontend export port and baked-session boot

**Files:**

- Modify: `frontend/src/app/data-plane.ts` (ExportPort, `exporter`, `bakedSessionJson`)
- Create: `frontend/src/app/baked-session.ts`
- Modify: `frontend/src/ui/app-shell.ts` (`restoreSession`)
- Test: `frontend/src/app/data-plane.test.ts`, `frontend/src/app/baked-session.test.ts`

**Interfaces:**

- Consumes: Task 1's generated types; Task 6's command names.
- Produces (Tasks 8-9 use these):

```ts
export interface ExportPort {
  estimate(sessionJson: string): Promise<ExportEstimate>;
  writeHtml(sessionJson: string, scope: ExportScope): Promise<string | null>;
  saveFile(
    fileName: string,
    kind: ExportFileKind,
    dataBase64: string,
  ): Promise<string | null>;
}
// DataPlane gains:
//   readonly exporter: ExportPort | null;
//   readonly bakedSessionJson?: string;   // BakedPlane only; "" = demo
// baked-session.ts:
export function parseBakedSession(sessionJson: string): Session; // throws on mismatch
```

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/baked-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { SESSION_SCHEMA_VERSION } from "../generated/session";
import { emptySession } from "./workspace";
import { parseBakedSession } from "./baked-session";

describe("parseBakedSession", () => {
  it("accepts a current-version session", () => {
    const json = JSON.stringify(emptySession());
    expect(parseBakedSession(json).schema_version).toBe(SESSION_SCHEMA_VERSION);
  });

  it("rejects a foreign app", () => {
    const json = JSON.stringify({ ...emptySession(), app: "other" });
    expect(() => parseBakedSession(json)).toThrow(/app/);
  });

  it("rejects a schema version mismatch", () => {
    const json = JSON.stringify({ ...emptySession(), schema_version: 1 });
    expect(() => parseBakedSession(json)).toThrow(/schema/);
  });
});
```

Extend `frontend/src/app/data-plane.test.ts` following its existing TauriPlane invoke-recording pattern:

```ts
it("routes export calls through the export commands", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const plane = new TauriPlane((command, args) => {
    calls.push({ command, ...(args === undefined ? {} : { args }) });
    if (command === "export_estimate") {
      return Promise.resolve(
        seal({ visible_bytes: "10", all_bytes: "20" }) as never,
      );
    }
    return Promise.resolve(seal("/tmp/out.html") as never);
  });
  const estimate = await plane.exporter?.estimate("{}");
  expect(estimate?.all_bytes).toBe("20");
  await plane.exporter?.writeHtml("{}", "visible");
  expect(calls.map((call) => call.command)).toEqual([
    "export_estimate",
    "export_write",
  ]);
});

it("exposes the baked session json and a null exporter", () => {
  const manifest = seal({ session_json: '{"app":"signalscope"}', signals: [] });
  const plane = new BakedPlane(manifest);
  expect(plane.bakedSessionJson).toBe('{"app":"signalscope"}');
  expect(plane.exporter).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && pnpm test` (or `./scripts/test.sh frontend` for the full gate)
Expected: FAIL — `baked-session` module missing, `exporter` undefined.

- [ ] **Step 3: Implement**

`frontend/src/app/baked-session.ts`:

```ts
import { SESSION_SCHEMA_VERSION, type Session } from "../generated/session";

/**
 * Validates a snapshot's baked session. A snapshot's code and session ship
 * together, so the version matches by construction; this check is defensive
 * against hand-edited artifacts.
 */
export function parseBakedSession(sessionJson: string): Session {
  const parsed = JSON.parse(sessionJson) as {
    app?: unknown;
    schema_version?: unknown;
  };
  if (parsed.app !== "signalscope") {
    throw new Error(
      `snapshot session has unexpected app: ${String(parsed.app)}`,
    );
  }
  if (parsed.schema_version !== SESSION_SCHEMA_VERSION) {
    throw new Error(
      `snapshot session schema ${String(parsed.schema_version)} does not match this build (${SESSION_SCHEMA_VERSION})`,
    );
  }
  return parsed as Session;
}
```

`data-plane.ts`: add `ExportPort` to the port interfaces, `readonly exporter: ExportPort | null;` to `DataPlane`, and `readonly bakedSessionJson?: string;` (optional — only `BakedPlane` has it). `TauriPlane` constructor gains:

```ts
this.exporter = {
  estimate: async (sessionJson: string) =>
    open(
      await this.invoke<Envelope<ExportEstimate>>("export_estimate", {
        request: seal<ExportEstimateRequest>({ session_json: sessionJson }),
      }),
    ),
  writeHtml: async (sessionJson: string, scope: ExportScope) =>
    open(
      await this.invoke<Envelope<string | null>>("export_write", {
        request: seal<ExportWriteRequest>({ session_json: sessionJson, scope }),
      }),
    ),
  saveFile: async (
    fileName: string,
    kind: ExportFileKind,
    dataBase64: string,
  ) =>
    open(
      await this.invoke<Envelope<string | null>>("save_export_file", {
        request: seal<SaveExportFileRequest>({
          file_name: fileName,
          kind,
          data_base64: dataBase64,
        }),
      }),
    ),
};
```

`BakedPlane`: `readonly exporter = null;` and `readonly bakedSessionJson: string;` set in the constructor from `this.payload.session_json`.

`app-shell.ts` — replace `restoreSession` (`:943-946`):

```ts
/** Restores the baked snapshot session or the autosaved session. */
private async restoreSession(): Promise<void> {
  const baked = this.plane.bakedSessionJson;
  if (baked !== undefined && baked !== "") {
    try {
      this.workspace.replace(parseBakedSession(baked));
    } catch (error: unknown) {
      this.reportError(error);
    }
    return;
  }
  await this.loadSession(null);
}
```

(Theme is applied right after by the existing `restoreTheme()` in `mount()`; the auto-panel bootstrap at `:279` self-suppresses because the baked session has panels.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh frontend`
Expected: PASS, including lint/knip (all new exports are imported).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/data-plane.ts frontend/src/app/baked-session.ts frontend/src/app/data-plane.test.ts frontend/src/app/baked-session.test.ts frontend/src/ui/app-shell.ts
git commit -m "feat(frontend): export port and baked-session snapshot boot"
```

---

### Task 8: CSV and PNG generators

**Files:**

- Create: `frontend/src/app/csv-export.ts`
- Create: `frontend/src/app/png-export.ts`
- Modify: `frontend/src/ui/panel.ts` (canvas accessor), `frontend/src/ui/workspace-view.ts` (pass-through)
- Test: `frontend/src/app/csv-export.test.ts`

**Interfaces:**

- Consumes: `SampleSeries` (generated), `lerpSample` from `frontend/src/app/xy.ts` (verify its exact signature there before use).
- Produces (Task 9 calls these):

```ts
// csv-export.ts
export const CSV_SAMPLE_CAP = 65_536; // rows are decimated by stride beyond this
export function buildCsv(series: SampleSeries[], window: { t0: number; t1: number }): string;
// png-export.ts
export function composePanelPng(title: string, plot: HTMLCanvasElement, overlay: HTMLCanvasElement, colors: { background: string; text: string }): HTMLCanvasElement;
export function toBase64(bytes: Uint8Array): string;
// panel.ts
canvases(): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement };
// workspace-view.ts
panelCanvases(id: string): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement } | null;
```

- [ ] **Step 1: Write the failing CSV tests**

`frontend/src/app/csv-export.test.ts` (pure — vitest runs it in Node):

```ts
import { describe, expect, it } from "vitest";

import type { SampleSeries } from "../generated/protocol";
import { buildCsv } from "./csv-export";

function series(path: string, time: number[], values: number[]): SampleSeries {
  return {
    signal_id: "1",
    signal_path: path,
    unit: null,
    time,
    values,
    stride: 1,
  };
}

describe("buildCsv", () => {
  it("uses the first series as the timebase and lerps the rest", () => {
    const base = series("a", [0, 1, 2], [10, 11, 12]);
    const other = series("b", [0, 2], [0, 4]);
    const csv = buildCsv([base, other], { t0: 0, t1: 2 });
    expect(csv.split("\n")[0]).toBe('time,"a","b"');
    expect(csv.split("\n")[2]).toBe("1,11,2"); // b lerped to t=1 → 2
  });

  it("clips rows to the visible window", () => {
    const base = series("a", [0, 1, 2, 3], [0, 1, 2, 3]);
    const csv = buildCsv([base], { t0: 1, t1: 2 });
    expect(csv.trim().split("\n")).toHaveLength(3); // header + 2 rows
  });

  it("escapes quotes in signal paths", () => {
    const base = series('weird"path', [0], [1]);
    expect(buildCsv([base], { t0: 0, t1: 0 }).split("\n")[0]).toBe(
      'time,"weird""path"',
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && pnpm test csv-export`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`csv-export.ts` (prototype semantics: first series — or the XY x-signal, which `panelSignalIds` already puts first — is the timebase; others are lerp-interpolated onto it):

```ts
import type { SampleSeries } from "../generated/protocol";
import { lerpSample } from "./xy";

/** Row cap for the visible-CSV export; sample requests decimate by stride beyond it. */
export const CSV_SAMPLE_CAP = 65_536;

function quote(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}

export function buildCsv(
  series: SampleSeries[],
  window: { t0: number; t1: number },
): string {
  const [base, ...rest] = series;
  if (base === undefined) return "time\n";
  const lines = [
    ["time", ...series.map((s) => quote(s.signal_path))].join(","),
  ];
  for (let index = 0; index < base.time.length; index += 1) {
    const t = base.time[index];
    if (t === undefined || t < window.t0 || t > window.t1) continue;
    const row = [t, base.values[index] ?? NaN];
    for (const other of rest) {
      row.push(lerpSample(other.time, other.values, t));
    }
    lines.push(row.join(","));
  }
  return `${lines.join("\n")}\n`;
}
```

(If `lerpSample`'s real signature differs — check `frontend/src/app/xy.ts` — adapt the call, not the semantics.)

`png-export.ts` (prototype semantics: title header + plot + overlay compositing; canvases are already DPR-sized backing stores):

```ts
/** Prototype-compatible focused-panel PNG: 28 px title header + plot + overlay. */
export function composePanelPng(
  title: string,
  plot: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  colors: { background: string; text: string },
): HTMLCanvasElement {
  const dpr = globalThis.devicePixelRatio || 1;
  const header = Math.round(28 * dpr);
  const out = document.createElement("canvas");
  out.width = plot.width;
  out.height = header + plot.height;
  const context = out.getContext("2d");
  if (context === null) throw new Error("2d context unavailable");
  context.fillStyle = colors.background;
  context.fillRect(0, 0, out.width, out.height);
  context.fillStyle = colors.text;
  context.font = `${Math.round(12 * dpr)}px system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.fillText(title, Math.round(10 * dpr), header / 2);
  context.drawImage(plot, 0, header);
  context.drawImage(overlay, 0, header);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
```

`panel.ts` — add to `PanelView` (next to the other public accessors):

```ts
/** Plot and overlay canvases, for the focused-panel PNG export. */
canvases(): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement } {
  return { plot: this.canvas, overlay: this.overlay };
}
```

`workspace-view.ts` — next to `panelWidth`/`panelRect`:

```ts
panelCanvases(
  id: string,
): { plot: HTMLCanvasElement; overlay: HTMLCanvasElement } | null {
  return this.views.get(id)?.canvases() ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh frontend`
Expected: CSV tests PASS. knip will flag `png-export`/`panelCanvases` as unused until Task 9 — if it does, either implement Task 9 before pushing or add the dialog import in the same PR; locally, note the failure and continue (Task 9 resolves it). If knip blocks the commit hook, commit both tasks together at Task 9's commit step instead.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/csv-export.ts frontend/src/app/csv-export.test.ts frontend/src/app/png-export.ts frontend/src/ui/panel.ts frontend/src/ui/workspace-view.ts
git commit -m "feat(frontend): visible-CSV and panel-PNG generators"
```

---

### Task 9: Export dialog and commands

**Files:**

- Create: `frontend/src/ui/export-dialog.ts`
- Modify: `frontend/src/ui/app-shell.ts` (commands, dialog wiring, export actions)
- Modify: `frontend/src/styles/app.css` (dialog styles)
- Modify: `frontend/src/ui/app-menu.ts` (only if disabled-command rendering needs it — see Step 4)
- Modify: `frontend/tests/e2e/app.spec.ts` (menu expectations)

**Interfaces:**

- Consumes: Task 7's `ExportPort`, Task 8's `buildCsv`/`composePanelPng`/`toBase64`/`panelCanvases`, the F6·2 mock (`SignalScope Final Spec.dc.html` around line 722) for visual layout.
- Produces: commands `export-html`, `export-png`, `export-csv` (section `file`, group `export`); `ExportDialog` class with `open(format: "html" | "png" | "csv")`, `close()`, `isOpen()`.

- [ ] **Step 1: Build the dialog**

`frontend/src/ui/export-dialog.ts`, modeled on `CommandPalette`'s overlay (`command-palette.ts:26-77`): an `.export-overlay` (hidden by default, click-outside and Escape close it) containing `.export-dialog` with:

```ts
export type ExportFormat = "html" | "png" | "csv";

export interface ExportDelegate {
  /** Null when the plane has no exporter (snapshot host) — row disabled. */
  estimateHtml(): Promise<{ visibleBytes: number; allBytes: number } | null>;
  /** Exact bytes, or null when no panel is focused — row disabled. */
  pngBytes(): Promise<number | null>;
  csvBytes(): number | null;
  runExport(format: ExportFormat, scope: "visible" | "all"): Promise<void>;
}

export class ExportDialog { ... }
```

Markup inside the dialog (mirror F6·2's rows; classes are new, styling in Step 2):

```html
<div class="export-dialog" role="dialog" aria-label="Export">
  <header class="export-title">Export</header>
  <label class="export-row" data-format="html">
    <input type="radio" name="export-format" value="html" />
    <span class="export-label">Standalone HTML snapshot</span>
    <span class="export-size" data-size="html">…</span>
  </label>
  <label class="export-row" data-format="png"> … PNG — focused panel … </label>
  <label class="export-row" data-format="csv"> … CSV — visible region … </label>
  <div class="export-scope">
    <span class="export-scope-title">EMBED DATA</span>
    <div class="export-scope-toggle" role="radiogroup">
      <button
        class="export-scope-option"
        data-scope="visible"
        aria-pressed="true"
      >
        visible window · <span data-size="visible">…</span>
      </button>
      <button class="export-scope-option" data-scope="all" aria-pressed="false">
        all loaded · <span data-size="all">…</span>
      </button>
    </div>
    <p class="export-caption">
      decimated to ≤2k pts/series · annotations + zoom state included
    </p>
  </div>
  <footer class="export-actions">
    <button class="export-cancel">Cancel</button>
    <button class="export-confirm">Export</button>
  </footer>
</div>
```

Behavior: `open(format)` preselects the radio, kicks off `estimateHtml()`/`pngBytes()`/`csvBytes()` and fills the size spans as results land (`formatBytes` helper: `4.8 MB` / `96 kB` style, one decimal above 1 MB); a null estimate disables that row (`.disabled`, radio `disabled`, size span shows `workbench only` for html, `no focused panel` for png/csv). The scope toggle applies to the HTML row only and is dimmed unless HTML is selected. Confirm calls `delegate.runExport(selected, scope)` then `close()`; errors from `runExport` surface via the shell's `reportError` (delegate throws, dialog re-enables). Escape/Cancel/click-outside close; the shell's global key handler must skip while open (mirror the palette guard at `app-shell.ts:828`: add `if (this.exportDialog?.isOpen() === true) return;`).

- [ ] **Step 2: Style it**

In `frontend/src/styles/app.css`, after the palette block: `.export-overlay` copies `.palette-overlay` (fixed, `inset: 0`, `background: var(--surface-overlay)`, `place-items: center` — centered, not top-aligned); `.export-dialog` copies `.palette` (`width: min(420px, 90vw)`, `border: 1px solid var(--border-strong)`, `background: var(--surface-1)`, `box-shadow: var(--elev-3)`, padding 16px, grid gap 8px). Rows are `display: flex; gap: 8px; align-items: center;` with `.export-size { margin-left: auto; color: var(--text-muted); font-variant-numeric: tabular-nums; }`. Use only existing design tokens — no new colors (Final Spec F6·2 controls visuals; reuse `.planned`-style dimming for disabled rows).

- [ ] **Step 3: Register the commands**

In `registerCommands()` (`app-shell.ts`), delete the `["export", "Export ▸ HTML · PNG · CSV", "file", "export"]` row from the planned table and add real commands next to the workspace file commands:

```ts
this.commands.register({
  id: "export-html",
  title: "Export ▸ HTML Snapshot…",
  section: "file",
  group: "export",
  enabled: () => this.plane.exporter !== null,
  run: () => this.openExportDialog("html"),
});
this.commands.register({
  id: "export-png",
  title: "Export ▸ PNG…",
  section: "file",
  group: "export",
  enabled: () =>
    this.plane.exporter !== null && this.workspace.focusedPanelId() !== null,
  run: () => this.openExportDialog("png"),
});
this.commands.register({
  id: "export-csv",
  title: "Export ▸ Visible CSV…",
  section: "file",
  group: "export",
  enabled: () =>
    this.plane.exporter !== null && this.workspace.focusedPanelId() !== null,
  run: () => this.openExportDialog("csv"),
});
```

`openExportDialog(format)` lazily constructs `ExportDialog` with a delegate implemented on the shell:

- `estimateHtml()`: `this.plane.exporter === null ? null : ` convert `await exporter.estimate(JSON.stringify(this.workspace.snapshot()))` (u64 strings → `Number(...)`).
- `csvBytes()`: build the CSV now via `buildVisibleCsv()` (below) and return `new TextEncoder().encode(csv).length`, caching the string for `runExport`; null when no focused panel.
- `pngBytes()`: compose the PNG blob now (below), cache the bytes, return length; null when unavailable.
- `runExport("html", scope)`: `await exporter.writeHtml(JSON.stringify(this.workspace.snapshot()), scope)`; a returned path shows via `this.showModeHelp(`exported ${path}`)`, null (cancelled) is silent.
- `runExport("png"|"csv")`: `await exporter.saveFile(fileName, kind, toBase64(bytes))` with `fileName` from the focused panel title (`${panel.title}.png` / `.csv`, fall back to `panel.id`).

Shell helpers to add:

```ts
private async buildVisiblePng(): Promise<Uint8Array | null> {
  const panelId = this.workspace.focusedPanelId();
  if (panelId === null) return null;
  const panel = this.workspace.panel(panelId);
  const canvases = this.workspaceView?.panelCanvases(panelId) ?? null;
  if (panel === undefined || canvases === null) return null;
  const styles = getComputedStyle(document.documentElement);
  const composed = composePanelPng(panel.title, canvases.plot, canvases.overlay, {
    background: styles.getPropertyValue("--surface-1").trim(),
    text: styles.getPropertyValue("--text-primary").trim(),
  });
  const blob = await new Promise<Blob | null>((resolve) =>
    composed.toBlob(resolve, "image/png"),
  );
  return blob === null ? null : new Uint8Array(await blob.arrayBuffer());
}

private async buildVisibleCsv(): Promise<string | null> {
  const panelId = this.workspace.focusedPanelId();
  if (panelId === null) return null;
  const panel = this.workspace.panel(panelId);
  if (panel === undefined) return null;
  const { ids } = this.panelSignalIds(panel);
  if (ids.length === 0) return null;
  const window = this.effectiveWindow(panel);
  const response = await this.plane.querySamples({
    request_id: crypto.randomUUID(),
    signal_ids: ids,
    window,
    max_points: CSV_SAMPLE_CAP,
  });
  // querySamples returns series in payload order; re-order to match ids
  // (first id — the timebase — first) before building.
  const byId = new Map(response.series.map((s) => [s.signal_id, s]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((s): s is SampleSeries => s !== undefined);
  return buildCsv(ordered, window);
}
```

Check the CSS token names (`--surface-1`, `--text-primary`) against `frontend/src/styles/app.css` and use the real ones.

- [ ] **Step 4: Check menu rendering of disabled commands**

Read `frontend/src/ui/app-menu.ts:100-130`. If items with `enabled?.() === false` already render dimmed/aria-disabled (like `planned`), no change. If not, extend the item renderer so a command whose `enabled()` returns false gets `aria-disabled="true"` and the `planned`-style dimming with tooltip `"unavailable in this context"` — mirroring `unavailableReason` in `app-shell.ts:1671-1679`.

- [ ] **Step 5: Update e2e expectations and run everything**

`frontend/tests/e2e/app.spec.ts` asserts the menu's planned markings (~line 53): the old `Export ▸ HTML · PNG · CSV` planned entry is gone; assert instead that the three new items exist under File and are disabled in the browser host (the e2e browser has no exporter — this is the spec's "inside a snapshot, export commands stay disabled" behavior). Follow the spec file's existing selector style.

Run: `./scripts/test.sh frontend && ./scripts/test.sh e2e`
Expected: PASS.

Manual check (optional but recommended): `./scripts/run.sh native`, ingest `examples/demo_flight.csv`, open the dialog via `File ▸ Export`, verify estimates render and an HTML export opens in a browser.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/ui/export-dialog.ts frontend/src/ui/app-shell.ts frontend/src/ui/app-menu.ts frontend/src/styles/app.css frontend/tests/e2e/app.spec.ts
git commit -m "feat(frontend): export dialog with size budget and three formats"
```

---

### Task 10: CI round trip

**Files:**

- Create: `frontend/tests/e2e/fixtures/roundtrip.csv`
- Create: `frontend/tests/e2e/fixtures/roundtrip.signalscope`
- Create: `frontend/tests/e2e/snapshot-roundtrip.spec.ts`
- Modify: `scripts/lib.sh` (bake helper), `scripts/test.sh` (e2e stage), `scripts/ci.sh` (check_e2e)

**Interfaces:**

- Consumes: `./scripts/export.sh` (Task 5), the baked-session boot (Task 7).
- Produces: `build/export/roundtrip.html` generated before every e2e run; the done-bar spec.

- [ ] **Step 1: Create the fixtures**

`roundtrip.csv` — small, deterministic, binary-exact values:

```csv
time,alpha,beta
0.0,0.0,8.0
0.5,1.0,7.5
1.0,2.0,7.0
1.5,3.0,6.5
2.0,4.0,6.0
2.5,5.0,5.5
3.0,6.0,5.0
3.5,7.0,4.5
4.0,8.0,4.0
4.5,7.0,3.5
5.0,6.0,3.0
5.5,5.0,2.5
6.0,4.0,2.0
6.5,3.0,1.5
7.0,2.0,1.0
7.5,1.0,0.5
```

`roundtrip.signalscope` — copy `protocol/testdata/session-conformance.json` as the structural template (it is a complete, valid v10 session) and edit: `theme: "light"`, one tab titled `"Roundtrip"`, one time-mode panel titled `"Alpha & Beta"` with series `alpha` and `beta` (check whether ingested paths get a source prefix by inspecting an `examples/demo_flight.csv` ingest — mirror whatever `scope-bake` actually produces; verify with the node one-liner from Task 5 Step 3), `linked_time` `{ t0: 0, t1: 7.5, linked: true, ... }`, one annotation with label `"peak"` anchored at t=4, `show_stats: true`, `source_paths: []`.

- [ ] **Step 2: Wire generation into the wrappers**

`scripts/lib.sh` — add next to the check groups:

```bash
bake_roundtrip_artifact() {
  "$signalscope_scripts_dir/export.sh" \
    --data frontend/tests/e2e/fixtures/roundtrip.csv \
    --workspace frontend/tests/e2e/fixtures/roundtrip.signalscope \
    --out build/export/roundtrip.html
}
```

In `scripts/test.sh`, the e2e stage becomes `bake_roundtrip_artifact` then `pnpm e2e` (and the same inside `full`). In `scripts/ci.sh`, `check_e2e` gains `bake_roundtrip_artifact` before `pnpm e2e`.

- [ ] **Step 3: Write the round-trip spec**

`frontend/tests/e2e/snapshot-roundtrip.spec.ts`:

```ts
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

const artifact = resolve(__dirname, "../../../build/export/roundtrip.html");

test.describe("exported snapshot round trip", () => {
  test("restores session state and data by value", async ({ page }) => {
    await page.goto(`file://${artifact}`);
    // Session half: theme, tab, panel, series, annotation.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    // Use the selector style of workbench.spec.ts for the assertions below.
    await expect(page.locator(".panel")).toHaveCount(1);
    // panel title "Alpha & Beta"; legend lists alpha and beta;
    // workspace tab shows "Roundtrip"; annotation "peak" present;
    // window readout reflects t0=0 t1=7.5.
    // Data half, by value: the stats strip over the full window shows
    // alpha max 8 and beta min 0.5 (exact values from roundtrip.csv).
  });

  test("stays under the export size ceiling", () => {
    expect(statSync(artifact).size).toBeLessThan(2_000_000);
  });
});
```

Fill the commented assertions with real selectors copied from `workbench.spec.ts` / `app.spec.ts` (tab strip, legend, stats strip, annotation chip). Every assertion is by value — no screenshots (chunk B owns pixels). If the file is missing the spec must fail loudly, not skip.

- [ ] **Step 4: Run the full gate**

Run: `./scripts/test.sh e2e`
Expected: the bake runs, then all e2e specs PASS including the two new tests. Then `./scripts/ci.sh all` for the pre-handoff gate.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e/fixtures/roundtrip.csv frontend/tests/e2e/fixtures/roundtrip.signalscope frontend/tests/e2e/snapshot-roundtrip.spec.ts scripts/lib.sh scripts/test.sh scripts/ci.sh
git commit -m "test(e2e): snapshot export round trip with size ceiling"
```

---

### Task 11: ADR and docs

**Files:**

- Create: `docs/adr/0024-snapshot-manifest-and-export-budget.md`
- Modify: `docs/adr/README.md` (index line, if the README lists ADRs — check)

**Interfaces:** none — documentation of decisions already implemented.

- [ ] **Step 1: Write the ADR**

Follow the two-section house style (see `docs/adr/0007-snapshot-injection.md`: `## Decision`, `## Consequences`, ~25 lines). Content to record:

- The manifest lives in the protocol schema as `SnapshotManifest { session_json, signals }`; the envelope's protocol version is the manifest version. The session crosses as an opaque JSON string because the schemas are isolated codegen units and `Session` lives in scope-core (protocol cannot depend on core).
- `levels` is positional: index 0 is the finest baked level; decimation drops the finest logical levels; `BakedPlane` treats the finest baked level as raw samples (ADR 0015).
- The budget rule: bake levels down to the first with ≤ 2,048 in-window bins; level 0 is forced for signals on non-time panels and for already-sparse windows; visible scope uses one export window (the union of panel effective windows) and only panel-referenced signals.
- `source_paths` is cleared at bake time (inert in a snapshot; local paths leak usernames).
- One bake module (`scope-core::snapshot`), two consumers (Tauri commands, `scope-bake` CLI behind `./scripts/export.sh`).

- [ ] **Step 2: Verify docs consistency and run the full gate**

Check `docs/adr/README.md` for an index pattern; add ADR 0024 if listed. Run: `./scripts/ci.sh all`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0024-snapshot-manifest-and-export-budget.md docs/adr/README.md
git commit -m "docs: ADR 0024 snapshot manifest and export budget"
```

---

## Plan self-review notes (already applied)

- Spec coverage: manifest schema (T1), plan/budget (T2, T4), bake/inject with escaping (T3), CLI + wrapper (T5), Tauri commands + template resource (T6), snapshot boot + null exporter (T7), PNG/CSV semantics (T8), dialog + commands + disabled-in-snapshot (T9), round trip + size ceiling (T10), ADR (T11). The spec's "write failures keep the dialog open for retry" is in T9 Step 1 (delegate throws, dialog re-enables). `check-snapshot.mjs` is intentionally untouched.
- Known adaptation points are marked inline (generated enum casing in T2, `lerpSample` signature in T8, CSS token names and menu disabled-rendering in T9, ingested path prefixes in T10). Executors must resolve them by reading the named file, not by guessing.
- Type consistency: `ExportPort.writeHtml/saveFile/estimate` (T7) match the dialog delegate usage (T9); `snapshot::{plan, bake, inject, estimated_bytes}` signatures are identical in T2-T6; `panelCanvases` (T8) matches T9's call.
