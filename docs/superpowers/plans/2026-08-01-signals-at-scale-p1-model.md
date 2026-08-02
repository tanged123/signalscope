# Signals at Scale P1 — Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-series panel state with selector-ready bindings over a channel×source catalog, delete the bundle/`SourceSet` machinery entirely, and relocate time alignment to per-source records — session schema v17, UI-equivalent behavior.

**Architecture:** Backend keeps only sources and signals; "series" (channel×source) becomes a frontend-derived cell computed by a pure catalog + resolution pipeline. Panels serialize `bindings` + `overrides` + `focus` instead of series lists. One schema change (v16→v17) defines the complete target shape for phases P2–P5.

**Tech Stack:** Rust (scope-core, Tauri shell), JSON-schema codegen (`pnpm codegen`), TypeScript frontend, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-01-signals-at-scale-design.md` — read it first.

## Global Constraints

- Use `./scripts/` wrappers only: `./scripts/test.sh core|unit|frontend [filter]`, `./scripts/format.sh`, `./scripts/codegen.sh`, `./scripts/ci.sh all`.
- Never hand-edit generated files: `core/scope-core/src/session/generated.rs`, `protocol/src/generated.rs`, `frontend/src/generated/*.ts`. Edit the JSON schemas and run `./scripts/codegen.sh`.
- Codegen constraint: `u64?` is a hard error. No nullable u64 anywhere; all new ids are strings.
- The reserved source key for derived signals is the literal string `"derived"` (`DERIVED_SOURCE_KEY`). Real source keys are UUID strings and can never collide with it.
- Run `./scripts/format.sh` before staging every commit. Conventional commit subjects. Stage only intentional files — never `git add -A`.
- After every task: the affected test suite passes. After the final task: `./scripts/ci.sh all`.
- Deletion is part of the deliverable. When a task says delete, delete — do not comment out, deprecate, or keep fallbacks.
- Annotations keep their `series_path` path strings in v17 (bounded scope; they migrate untouched).

---

### Task 1: Session schema v17 + codegen + migration

**Files:**

- Modify: `protocol/schema/scope-session.json`
- Modify: `core/scope-core/src/session.rs` (Default impl, migration arm, tests)
- Modify: `protocol/testdata/session-conformance.json`
- Generated (via `./scripts/codegen.sh`): `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`

**Interfaces:**

- Produces (used by every later task): TS/Rust types `SeriesRef {source_key, channel}`, `Binding {kind, selector?, refs?, set_id?}`, `SeriesOverride`, `FocusEntry`, `NamedSet`, `ChannelMapEntry`, new `PanelState`, new `SourceRecord` (with `time_domain`, `scale`, `offset`), new `Session` (with `named_sets`, `channel_map`; without `favorites`, `favorite_bundles`, `source_sets`). `SESSION_SCHEMA_VERSION = 17`.

Note: this task breaks compilation of `shell/src-tauri` and the frontend until Tasks 2–4 land. `./scripts/test.sh core` must pass at the end of this task; run the full gates only from Task 4 on.

- [ ] **Step 1: Rewrite the schema.** In `protocol/schema/scope-session.json`: set `"schema_version": 17`. Delete types `SeriesState`, `HighlightedSourceState`, `SetMemberState`, `SourceSetState`. Keep `TimeUnitState`, `OriginKindState`, `TimeDomainState`. Add:

```json
"SeriesRef": {
  "kind": "object",
  "fields": { "source_key": "string", "channel": "string" }
},
"BindingKind": { "kind": "enum", "variants": ["query", "pick", "set"] },
"Binding": {
  "kind": "object",
  "fields": {
    "kind": "BindingKind",
    "selector": "string?",
    "refs": "SeriesRef[]",
    "set_id": "string?"
  }
},
"SeriesOverride": {
  "kind": "object",
  "fields": {
    "target_ref": "SeriesRef?",
    "target_selector": "string?",
    "color_slot": "u8?",
    "dash": "DashStyle?",
    "width": "f32?",
    "opacity": "f32?",
    "visible": "bool?"
  }
},
"FocusKind": { "kind": "enum", "variants": ["series", "source", "channel"] },
"FocusEntry": {
  "kind": "object",
  "fields": {
    "kind": "FocusKind",
    "ref": "SeriesRef?",
    "source_key": "string?",
    "channel": "string?"
  }
},
"GhostMode": { "kind": "enum", "variants": ["ghost", "all"], "default": "all" },
"StyleDimension": {
  "kind": "enum",
  "variants": ["focus", "source", "channel", "set", "attr"],
  "default": "source"
},
"SplitDimension": {
  "kind": "enum",
  "variants": ["none", "source", "channel"],
  "default": "none"
},
"ColorAxis": { "kind": "enum", "variants": ["none", "time", "signal"], "default": "none" },
"NamedSetKind": { "kind": "enum", "variants": ["query", "pick"] },
"NamedSet": {
  "kind": "object",
  "fields": {
    "id": "string",
    "name": "string",
    "kind": "NamedSetKind",
    "selector": "string?",
    "refs": "SeriesRef[]"
  }
},
"ChannelAlias": {
  "kind": "object",
  "fields": { "source_key": "string", "name": "string" }
},
"ChannelMapEntry": {
  "kind": "object",
  "fields": { "canonical": "string", "aliases": "ChannelAlias[]" }
}
```

Replace `PanelState` fields `x_signal`, `color_signal`, `color_by_time`, `series`, `highlighted_sources` with:

```json
"x_ref": "SeriesRef?",
"color_axis": "ColorAxis",
"color_ref": "SeriesRef?",
"bindings": "Binding[]",
"color_by": "StyleDimension",
"overrides": "SeriesOverride[]",
"focus": "FocusEntry[]",
"ghost_mode": "GhostMode",
"split_by": "SplitDimension"
```

(all other `PanelState` fields unchanged). In `SourceRecord` add `"time_domain": "TimeDomainState", "scale": "f64", "offset": "f64"`. In `Session` delete `favorites`, `favorite_bundles`, `source_sets`; add `"named_sets": "NamedSet[]", "channel_map": "ChannelMapEntry[]"`.

- [ ] **Step 2: Regenerate.** Run: `./scripts/codegen.sh`. Expected: `generated.rs` and `session.ts` change; no errors.

- [ ] **Step 3: Fix `core` compilation.** In `core/scope-core/src/session.rs` update `Session::default()`: replace `favorites`/`favorite_bundles`/`source_sets` initializers with `named_sets: Vec::new(), channel_map: Vec::new()`. `cargo` compile errors are the checklist — fix only within scope-core; do NOT touch shell yet.

- [ ] **Step 4: Write failing migration tests** in the `#[cfg(test)]` module of `session.rs`:

```rust
fn v16_fixture() -> serde_json::Value {
    serde_json::json!({
        "app": "signalscope", "schema_version": 16, "theme": "dark",
        "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
        "active_tab_id": "workspace-1",
        "tabs": [{
            "id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
            "focused_panel_id": null, "maximized_panel_id": null,
            "layout": [{"height": 1.0, "panels": [{"panel_id": "panel-1", "width": 1.0}]}],
            "panels": [{
                "id": "panel-1", "title": "Panel 1", "mode": "time", "axis_style": "gutter",
                "x_signal": "run/temp", "color_signal": null, "color_by_time": true,
                "series": [
                    {"path": "run/pressure", "color_slot": 2, "dash": "dash", "width": 2.0, "visible": false},
                    {"path": "derived/err", "color_slot": 1, "dash": "solid", "width": 1.4, "visible": true},
                    {"path": "orphan/x", "color_slot": 3, "dash": "solid", "width": 1.4, "visible": true}
                ],
                "highlighted_sources": [{"local_path": "pressure", "path": "run/pressure"}],
                "y_range": null, "x_range": null, "x_label": null, "y_label": null, "c_label": null,
                "time_window": null, "annotations": [], "show_stats": false
            }]
        }],
        "favorites": ["run/temp"], "favorite_bundles": ["imu/accel/x"],
        "derived": [], "derived_bundles": [],
        "sources": [{"key": "11111111-1111-1111-1111-111111111111", "path": "/data/run.csv",
                     "prefix": "run", "provider_id": null, "decode_provenance": null, "reconcile_legacy": false}],
        "source_sets": [{
            "key": "22222222-2222-2222-2222-222222222222", "label": "Set 1", "generation": 3,
            "time_domain": {"unit": "milliseconds", "origin": "relative", "alignment_origin": 0.0},
            "members": [{"source_key": "11111111-1111-1111-1111-111111111111",
                         "missing": [], "scale": 0.001, "offset": 0.5}]
        }]
    })
}

#[test]
fn v16_series_become_a_pick_binding_with_overrides() {
    let session = from_json(&v16_fixture().to_string()).unwrap();
    let panel = &session.tabs[0].panels[0];
    assert_eq!(panel.bindings.len(), 1);
    let binding = &panel.bindings[0];
    assert!(matches!(binding.kind, BindingKind::Pick));
    // orphan/x has no matching source prefix and no derived/ prefix: dropped.
    assert_eq!(binding.refs.len(), 2);
    assert_eq!(binding.refs[0].source_key, "11111111-1111-1111-1111-111111111111");
    assert_eq!(binding.refs[0].channel, "pressure");
    assert_eq!(binding.refs[1].source_key, "derived");
    assert_eq!(binding.refs[1].channel, "err");
    let first = &panel.overrides[0];
    assert_eq!(first.target_ref.as_ref().unwrap().channel, "pressure");
    assert_eq!(first.color_slot, Some(2));
    assert_eq!(first.dash, Some(DashStyle::Dash));
    assert_eq!(first.visible, Some(false));
}

#[test]
fn v16_axes_highlights_and_favorites_migrate() {
    let session = from_json(&v16_fixture().to_string()).unwrap();
    let panel = &session.tabs[0].panels[0];
    assert_eq!(panel.x_ref.as_ref().unwrap().channel, "temp");
    assert!(matches!(panel.color_axis, ColorAxis::Time));
    assert!(panel.color_ref.is_none());
    assert_eq!(panel.focus.len(), 1);
    assert!(matches!(panel.focus[0].kind, FocusKind::Series));
    assert_eq!(panel.focus[0].r#ref.as_ref().unwrap().channel, "pressure");
    assert_eq!(session.named_sets.len(), 2);
    assert!(matches!(session.named_sets[0].kind, NamedSetKind::Pick));
    assert_eq!(session.named_sets[0].name, "run/temp");
    assert!(matches!(session.named_sets[1].kind, NamedSetKind::Query));
    assert_eq!(session.named_sets[1].selector.as_deref(), Some("imu/accel/x"));
}

#[test]
fn v16_set_member_alignment_lands_on_the_source_record() {
    let session = from_json(&v16_fixture().to_string()).unwrap();
    let source = &session.sources[0];
    assert!((source.scale - 0.001).abs() < f64::EPSILON);
    assert!((source.offset - 0.5).abs() < f64::EPSILON);
    assert!(matches!(source.time_domain.unit, TimeUnitState::Milliseconds));
}
```

(Adjust field access for the generated names — `ref` is a Rust keyword, codegen will emit `r#ref` or a rename; check `generated.rs` after Step 2 and use what it emits.)

- [ ] **Step 5: Run to verify failure.** `./scripts/test.sh core session` — expected: FAIL (v16 hits `UnsupportedVersion` / missing arm).

- [ ] **Step 6: Implement the migration arm.** In `migrate()` add before the terminal arm:

```rust
16 => {
    migrate_v16_bindings(&mut value);
    value["schema_version"] = serde_json::json!(17);
    migrate(17, value)
}
```

and implement:

```rust
const DERIVED_SOURCE_KEY: &str = "derived";

/// Longest-prefix match of a flat path against source prefixes; derived
/// paths map to the reserved derived source key.
fn path_to_ref(path: &str, prefixes: &[(String, String)]) -> Option<serde_json::Value> {
    if let Some(rest) = path.strip_prefix("derived/") {
        return Some(serde_json::json!({ "source_key": DERIVED_SOURCE_KEY, "channel": rest }));
    }
    prefixes
        .iter()
        .filter(|(prefix, _)| {
            path.len() > prefix.len() + 1 && path.starts_with(prefix.as_str())
                && path.as_bytes()[prefix.len()] == b'/'
        })
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(prefix, key)| {
            serde_json::json!({ "source_key": key, "channel": &path[prefix.len() + 1..] })
        })
}

fn migrate_v16_bindings(value: &mut serde_json::Value) {
    let prefixes: Vec<(String, String)> = value
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .map(|sources| {
            sources
                .iter()
                .filter_map(|source| {
                    Some((
                        source.get("prefix")?.as_str()?.to_owned(),
                        source.get("key")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    for_each_panel(value, |panel| {
        let series = panel.remove("series").unwrap_or(serde_json::json!([]));
        let mut refs = Vec::new();
        let mut overrides = Vec::new();
        for entry in series.as_array().into_iter().flatten() {
            let Some(path) = entry.get("path").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let Some(target) = path_to_ref(path, &prefixes) else { continue };
            refs.push(target.clone());
            overrides.push(serde_json::json!({
                "target_ref": target,
                "target_selector": null,
                "color_slot": entry.get("color_slot").cloned().unwrap_or(serde_json::json!(1)),
                "dash": entry.get("dash").cloned().unwrap_or(serde_json::json!("solid")),
                "width": entry.get("width").cloned().unwrap_or(serde_json::json!(1.4)),
                "opacity": null,
                "visible": entry.get("visible").cloned().unwrap_or(serde_json::json!(true)),
            }));
        }
        panel.insert(
            "bindings".into(),
            serde_json::json!([{ "kind": "pick", "selector": null, "refs": refs, "set_id": null }]),
        );
        panel.insert("overrides".into(), serde_json::Value::Array(overrides));

        let highlighted = panel
            .remove("highlighted_sources")
            .unwrap_or(serde_json::json!([]));
        let focus: Vec<serde_json::Value> = highlighted
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("path").and_then(serde_json::Value::as_str))
            .filter_map(|path| path_to_ref(path, &prefixes))
            .map(|target| {
                serde_json::json!({ "kind": "series", "ref": target, "source_key": null, "channel": null })
            })
            .collect();
        panel.insert("focus".into(), serde_json::Value::Array(focus));

        let x_ref = panel
            .remove("x_signal")
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|path| path_to_ref(&path, &prefixes))
            .unwrap_or(serde_json::Value::Null);
        panel.insert("x_ref".into(), x_ref);
        let by_time = panel.remove("color_by_time").and_then(|value| value.as_bool()) == Some(true);
        let color_ref = panel
            .remove("color_signal")
            .and_then(|value| value.as_str().map(str::to_owned))
            .and_then(|path| path_to_ref(&path, &prefixes))
            .unwrap_or(serde_json::Value::Null);
        let axis = if by_time { "time" } else if color_ref.is_null() { "none" } else { "signal" };
        panel.insert("color_axis".into(), serde_json::json!(axis));
        panel.insert("color_ref".into(), color_ref);
        panel.insert("color_by".into(), serde_json::json!("source"));
        panel.insert("ghost_mode".into(), serde_json::json!("all"));
        panel.insert("split_by".into(), serde_json::json!("none"));
    });

    let object = value.as_object_mut().expect("session object");
    let mut named_sets = Vec::new();
    for path in take_string_array(object, "favorites") {
        if let Some(target) = path_to_ref(&path, &prefixes) {
            named_sets.push(serde_json::json!({
                "id": format!("set-fav-{}", named_sets.len() + 1),
                "name": path, "kind": "pick", "selector": null, "refs": [target],
            }));
        }
    }
    for local in take_string_array(object, "favorite_bundles") {
        named_sets.push(serde_json::json!({
            "id": format!("set-fav-{}", named_sets.len() + 1),
            "name": local, "kind": "query", "selector": local, "refs": [],
        }));
    }
    object.insert("named_sets".into(), serde_json::Value::Array(named_sets));
    object.insert("channel_map".into(), serde_json::json!([]));

    let sets = object.remove("source_sets").unwrap_or(serde_json::json!([]));
    let mut alignment = std::collections::BTreeMap::new();
    for set in sets.as_array().into_iter().flatten() {
        let domain = set.get("time_domain").cloned().unwrap_or(serde_json::Value::Null);
        for member in set.get("members").and_then(serde_json::Value::as_array).into_iter().flatten() {
            if let Some(key) = member.get("source_key").and_then(serde_json::Value::as_str) {
                alignment.insert(
                    key.to_owned(),
                    (
                        domain.clone(),
                        member.get("scale").cloned().unwrap_or(serde_json::json!(1.0)),
                        member.get("offset").cloned().unwrap_or(serde_json::json!(0.0)),
                    ),
                );
            }
        }
    }
    if let Some(sources) = object.get_mut("sources").and_then(serde_json::Value::as_array_mut) {
        for source in sources {
            let key = source.get("key").and_then(serde_json::Value::as_str).unwrap_or("").to_owned();
            let (domain, scale, offset) = alignment.remove(&key).unwrap_or((
                serde_json::Value::Null,
                serde_json::json!(1.0),
                serde_json::json!(0.0),
            ));
            let domain = if domain.is_null() {
                serde_json::json!({ "unit": "seconds", "origin": "relative", "alignment_origin": 0.0 })
            } else {
                domain
            };
            source["time_domain"] = domain;
            source["scale"] = scale;
            source["offset"] = offset;
        }
    }
}

fn take_string_array(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Vec<String> {
    object
        .remove(key)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::to_owned))
        .collect()
}
```

Also update the existing older-version tests that assert on removed fields (e.g. anything asserting `session.favorites` or `session.source_sets` post-migration) to assert the v17 equivalents (`named_sets`, source alignment fields), and delete the `SourceSetState` round-trip tests (lines ~638–748) — that type no longer exists.

- [ ] **Step 7: Run to verify pass.** `./scripts/test.sh core session` — expected: PASS.

- [ ] **Step 8: Update the conformance fixture.** Rewrite `protocol/testdata/session-conformance.json` as a v17 document: `"schema_version": 17`; replace `favorites`/`favorite_bundles` with equivalent `named_sets`; replace panel `series`/`highlighted_sources`/`x_signal`/`color_signal`/`color_by_time` with `bindings`/`overrides`/`focus`/`x_ref`/`color_axis`/`color_ref`/`color_by`/`ghost_mode`/`split_by`; delete `source_sets`; add `time_domain`/`scale`/`offset` to each source. Keep the same signals/story so the frontend conformance test stays meaningful. (The frontend test itself is fixed in Task 4.)

- [ ] **Step 9: Commit.**

```bash
git add protocol/schema/scope-session.json core/scope-core/src/session.rs \
  core/scope-core/src/session/generated.rs frontend/src/generated/session.ts \
  protocol/testdata/session-conformance.json
git commit -m "feat(session)!: schema v17 — bindings, overrides, focus, named sets; retire series lists and source sets"
```

---

### Task 2: Core alignment relocation + delete sets.rs

**Files:**

- Create: `core/scope-core/src/alignment.rs`
- Modify: `core/scope-core/src/sources.rs`, `core/scope-core/src/lib.rs` (module list), `core/scope-core/src/ingest/mod.rs`, `core/scope-core/src/restore.rs`
- Delete: `core/scope-core/src/sets.rs`

**Interfaces:**

- Produces: `alignment::{TimeUnit, OriginKind, TimeDomain, AffineTransform, AlignmentError}` (moved verbatim from `sets.rs`, minus set-shaped errors); `SourceRecord` gains `pub time_domain: TimeDomain, pub transform: AffineTransform` with methods `SourceRegistry::set_time_domain(key, domain)`, `SourceRegistry::set_transform(key, transform)`.
- Consumes: nothing new; Task 1's session types.

- [ ] **Step 1: Create `alignment.rs`.** Move from `sets.rs` unchanged: `AffineTransform` (+ `normalizing`, `apply`), `TimeUnit` (+ `to_seconds_scale`), `OriginKind`, `TimeDomain` (+ `Default`), and the `default_transform` helper (make it `pub(crate) fn default_transform(domain: TimeDomain) -> Option<AffineTransform>`). Move the two alignment-math tests (`supported_units_normalize_to_seconds_by_default`, and adapt `relative_origins_align_with_the_default_transform` to assert `default_transform` directly). Define a per-source error:

```rust
#[derive(Clone, Copy, Debug, thiserror::Error, Eq, PartialEq)]
pub enum AlignmentError {
    #[error("source uses an unsupported time unit")]
    UnsupportedUnit,
    #[error("absolute or event-aligned time requires an explicit offset")]
    OffsetRequired,
}
```

- [ ] **Step 2: Extend `SourceRecord`.** In `sources.rs` add fields `pub time_domain: alignment::TimeDomain, pub transform: alignment::AffineTransform` (identity default `{scale: 1.0, offset: 0.0}` at admission). Add registry methods:

```rust
pub fn set_time_domain(&mut self, key: SourceKey, domain: alignment::TimeDomain) {
    if let Some(record) = self.by_key.get_mut(&key) {
        record.time_domain = domain;
        record.transform = alignment::default_transform(domain)
            .unwrap_or(alignment::AffineTransform { scale: 1.0, offset: 0.0 });
    }
}

pub fn set_transform(&mut self, key: SourceKey, transform: alignment::AffineTransform) {
    if let Some(record) = self.by_key.get_mut(&key) {
        record.transform = transform;
    }
}
```

Note `SourceRecord` derives `Serialize/Deserialize` — give the new fields `#[serde(default)]` with a default fn so existing serialized registries (if any) still parse. Add a test: admitting a source yields identity transform and `TimeDomain::default()`; `set_time_domain` with milliseconds yields a normalizing transform.

- [ ] **Step 3: Excise sets from ingest.** In `ingest/mod.rs` around line 247, delete the `propose_sets` call and everything that consumed its result (follow the compiler). Newly ingested sources get default time domain per Step 2 — no grouping step remains.

- [ ] **Step 4: Delete `sets.rs`.** Remove the file, remove `pub mod sets;` from `lib.rs`, add `pub mod alignment;`. Fix `restore.rs`: wherever it rebuilt or reconciled `source_sets`, it now restores `time_domain`/`scale`/`offset` from the session's `SourceRecord`s onto the registry (`set_time_domain` + `set_transform`). Follow compile errors; the shell (`shell/src-tauri`) stays broken until Task 3.

- [ ] **Step 5: Run.** `./scripts/test.sh core` — expected: PASS (scope-core only).

- [ ] **Step 6: Commit.** `git commit -m "refactor(core)!: relocate time alignment to SourceRecord; delete SourceSet"` (stage the five files above).

---

### Task 3: Protocol set removal + shell rewiring

**Files:**

- Modify: `protocol/schema/scope-protocol.json`, `shell/src-tauri/src/lib.rs`, `core/scope-core/src/snapshot.rs`
- Generated: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`

**Interfaces:**

- Produces: protocol without `SetSummary`, `SetMemberSummary`, `SetTimeUnit`, `SetOriginKind`, `SetTimeDomainSummary`, `CreateSetRequest`, `UpdateSetMembersRequest`, `SetTimeAlignmentRequest`; `ExportSelection` = `{source_keys: string[]}` only; new `SourceAlignmentRequest {source_key, unit: SetTimeUnit-equivalent enum, origin, scale, offset}` — name the enums `SourceTimeUnit`/`SourceOriginKind` (rename of the old Set\* enums, kept if other types use them). New Tauri command `set_source_alignment` replacing `create_set`/`update_set_members`/`set_time_alignment`/`list_sets`.

- [ ] **Step 1: Edit the protocol schema.** Delete the set types and requests listed above. Rename `SetTimeUnit`→`SourceTimeUnit`, `SetOriginKind`→`SourceOriginKind`, `SetTimeDomainSummary`→`SourceTimeDomainSummary` (they describe per-source time now). Remove `"set_keys"` from `ExportSelection`. Add:

```json
"SourceAlignmentRequest": {
  "kind": "object",
  "fields": {
    "source_key": "string",
    "time_domain": "SourceTimeDomainSummary",
    "scale": "f64",
    "offset": "f64"
  }
}
```

Add `"time_domain": "SourceTimeDomainSummary", "scale": "f64", "offset": "f64"` to `SourceSummary` so the frontend can display alignment per source. Run `./scripts/codegen.sh`.

- [ ] **Step 2: Rewire the shell.** In `shell/src-tauri/src/lib.rs`: delete `set_summary()` (line ~681), the four set commands (`list_sets` ~773, `create_set` ~785, `update_set_members` ~805, `set_time_alignment` ~834) and their registrations in the `invoke_handler` list; delete the session-restore loop over `session.source_sets` (~449) and the save-side rebuild (~2349) — restore/save now flow alignment through `SourceRegistry` per Task 2 and the session `SourceRecord` fields from Task 1. Add:

```rust
#[tauri::command]
fn set_source_alignment(
    state: State<'_, Arc<Mutex<DataState>>>,
    request: SourceAlignmentRequest,
) -> Result<Envelope<()>, String> {
    // Parse the key, map SourceTimeDomainSummary -> alignment::TimeDomain,
    // then registry.set_time_domain(key, domain) followed by
    // registry.set_transform(key, AffineTransform { scale, offset }).
    // Mirror the lock/Envelope pattern of the neighboring commands exactly.
}
```

(Write the body by copying the state-locking and envelope conventions from `remove_source` or the deleted `set_time_alignment` — same shape, per-source instead of per-set.)

- [ ] **Step 3: Fix `snapshot.rs`.** Remove `set_keys` from every `ExportSelection` construction (lines ~178, ~922) and from `plan_selected`'s set-expansion logic — selection is by `source_keys` only. Delete the "exact set generation" error path if it exists.

- [ ] **Step 4: Run.** `./scripts/test.sh core && cargo check -p signalscope` (via `./scripts/test.sh shell` if it compiles the shell) — expected: whole Rust workspace compiles, tests pass.

- [ ] **Step 5: Commit.** `git commit -m "refactor(protocol)!: per-source alignment replaces set commands; export selects sources"`

---

### Task 4: Frontend compile alignment

**Files:**

- Modify: `frontend/src/app/data-plane.ts`, `frontend/src/app/data-plane.test.ts`, `frontend/src/app/history.ts`, `frontend/src/app/baked-session.ts`, `frontend/src/app/session-conformance.test.ts`, `frontend/src/app/partial-bundle.test.ts` (delete), `frontend/src/ui/export-dialog.ts`, `frontend/src/ui/app-shell.ts` (compile-only edits)

**Interfaces:**

- Produces: `DataPlane` without `listSets`/`create`/`updateMembers`/set-alignment; with `setSourceAlignment(request: SourceAlignmentRequest): Promise<void>`. `history.ts` snapshots `named_sets`/`channel_map` instead of `favorites`/`favorite_bundles`/`source_sets`. `baked-session.ts` validates the v17 shape.

This task makes `pnpm`-level type-checking pass again. UI behavior is still wrong in places (tree, panels) — that is Tasks 5–9. Gate on `./scripts/test.sh unit` for the files touched here plus compile success; leave failing UI tests documented in the commit body if they depend on later tasks (prefer adjusting them in their own tasks).

- [ ] **Step 1:** `data-plane.ts`: delete the `SetSummary` import, the set-related interface methods (lines ~74–81, ~141) and both plane implementations of them (Tauri ~259–282, ~421–422; Baked ~523–524). Add `setSourceAlignment` on the interface, Tauri impl invoking `set_source_alignment`, Baked impl throwing `new Error("snapshots are read-only")` (match the existing read-only pattern in `BakedPlane`). Fix the baked empty-session literal (~723) for v17 fields.
- [ ] **Step 2:** `history.ts`: replace `source_sets`/`favorites`/`favorite_bundles` in the undo snapshot shape with `named_sets` and `channel_map` (same `structuredClone` pattern).
- [ ] **Step 3:** `baked-session.ts`: delete `isSourceSet` and the `source_sets` check (~229); add validators `isSeriesRef`, `isBinding`, `isNamedSet`, `isChannelMapEntry`, and validate the new panel fields (`bindings`, `overrides`, `focus` arrays; enums as strings). Follow the file's existing validator style exactly.
- [ ] **Step 4:** `session-conformance.test.ts`: update expectations to the v17 fixture from Task 1 Step 8.
- [ ] **Step 5:** Delete `frontend/src/app/partial-bundle.test.ts` (tests set-membership behavior that no longer exists).
- [ ] **Step 6:** `export-dialog.ts` + `app-shell.ts` export path: the export selection UI lists sources (from `session.sources` / `SourceSummary`), not sets. Replace the set list (`app-shell.ts` ~1499) with sources and drop `set_keys` (~1606) — selection payload is `{source_keys}`.
- [ ] **Step 7:** Chase remaining type errors from the v16→v17 type change (`pnpm -C frontend exec tsc --noEmit` or `./scripts/test.sh unit` compile step). Where `app-shell.ts`/`panel.ts` logic reads `panel.series` and cannot yet be correctly rewired, make the minimal mechanical substitution and mark with `// P1-TASK8:` — Task 8 removes every such marker.
- [ ] **Step 8: Run.** `./scripts/test.sh unit data-plane history baked-session session-conformance` — expected: PASS.
- [ ] **Step 9: Commit.** `git commit -m "refactor(frontend): v17 session types across data plane, history, validation, export"`

---

### Task 5: Catalog module

**Files:**

- Create: `frontend/src/app/catalog.ts`
- Test: `frontend/src/app/catalog.test.ts`

**Interfaces:**

- Consumes: generated `SignalSummary`, `SeriesRef`.
- Produces (used by Tasks 6–9):

```ts
export const DERIVED_SOURCE_KEY = "derived";
export interface CatalogSeries {
  sourceKey: string; // DERIVED_SOURCE_KEY for derived signals
  channel: string; // local path (canonical once the channel map lands, P5)
  path: string; // display path, e.g. "run/temp" or "derived/err"
  summary: SignalSummary;
}
export interface CatalogChannel {
  name: string;
  sourceKeys: readonly string[];
  unit: string | null;
}
export class Catalog {
  static build(signals: readonly SignalSummary[]): Catalog;
  static empty(): Catalog;
  channels(): readonly CatalogChannel[]; // sorted by name
  allSeries(): readonly CatalogSeries[];
  get(ref: SeriesRef): CatalogSeries | undefined;
  refFromPath(path: string): SeriesRef | undefined;
  refKey(ref: SeriesRef): string; // `${source_key} ${channel}`
}
```

- [ ] **Step 1: Write failing tests** (`catalog.test.ts`). Build summaries helper mirroring `SignalSummary` (`signal_id`/`source_id` as strings per u64 rule — copy exact field list from `frontend/src/generated/protocol.ts`). Cover: (a) two sources × two shared channels yields 2 channels each with 2 sourceKeys and 4 series; (b) a `derived/err` signal maps to `{sourceKey: "derived", channel: "err"}`; (c) `get()` round-trips every ref from `allSeries()`; (d) `refFromPath("run_01/temp")` returns the right ref and `get(refFromPath(p)).path === p`; (e) channels are sorted; (f) unit comes from the summary, null when absent.
- [ ] **Step 2: Run to verify failure.** `./scripts/test.sh unit catalog` — FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
import type { SignalSummary } from "../generated/protocol";
import type { SeriesRef } from "../generated/session";

export const DERIVED_SOURCE_KEY = "derived";

export interface CatalogSeries {
  sourceKey: string;
  channel: string;
  path: string;
  summary: SignalSummary;
}

export interface CatalogChannel {
  name: string;
  sourceKeys: readonly string[];
  unit: string | null;
}

function refKeyOf(sourceKey: string, channel: string): string {
  return `${sourceKey} ${channel}`;
}

export class Catalog {
  private constructor(
    private readonly byRef: Map<string, CatalogSeries>,
    private readonly byPath: Map<string, CatalogSeries>,
    private readonly channelList: CatalogChannel[],
  ) {}

  static empty(): Catalog {
    return new Catalog(new Map(), new Map(), []);
  }

  static build(signals: readonly SignalSummary[]): Catalog {
    const byRef = new Map<string, CatalogSeries>();
    const byPath = new Map<string, CatalogSeries>();
    const channels = new Map<
      string,
      { sourceKeys: string[]; unit: string | null }
    >();
    for (const summary of signals) {
      const derived = summary.path.startsWith("derived/");
      const sourceKey = derived ? DERIVED_SOURCE_KEY : summary.source_key;
      const channel = derived ? summary.path.slice(8) : summary.local_path;
      const series: CatalogSeries = {
        sourceKey,
        channel,
        path: summary.path,
        summary,
      };
      byRef.set(refKeyOf(sourceKey, channel), series);
      byPath.set(summary.path, series);
      const entry = channels.get(channel) ?? {
        sourceKeys: [],
        unit: summary.unit ?? null,
      };
      entry.sourceKeys.push(sourceKey);
      channels.set(channel, entry);
    }
    const channelList = [...channels.entries()]
      .map(([name, entry]) => ({
        name,
        sourceKeys: entry.sourceKeys,
        unit: entry.unit,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return new Catalog(byRef, byPath, channelList);
  }

  channels(): readonly CatalogChannel[] {
    return this.channelList;
  }

  allSeries(): readonly CatalogSeries[] {
    return [...this.byRef.values()];
  }

  get(ref: SeriesRef): CatalogSeries | undefined {
    return this.byRef.get(refKeyOf(ref.source_key, ref.channel));
  }

  refFromPath(path: string): SeriesRef | undefined {
    const series = this.byPath.get(path);
    return series === undefined
      ? undefined
      : { source_key: series.sourceKey, channel: series.channel };
  }

  refKey(ref: SeriesRef): string {
    return refKeyOf(ref.source_key, ref.channel);
  }
}
```

- [ ] **Step 4: Run.** `./scripts/test.sh unit catalog` — PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(frontend): channel-by-source catalog"`

---

### Task 6: Resolution module

**Files:**

- Create: `frontend/src/app/resolution.ts`
- Test: `frontend/src/app/resolution.test.ts`

**Interfaces:**

- Consumes: `Catalog`, generated `PanelState`, `NamedSet`, `SeriesOverride`, `FocusEntry`, `DashStyle`.
- Produces (Tasks 7–9 depend on these exact names):

```ts
export interface ResolvedSeries {
  ref: SeriesRef;
  path: string;
  colorSlot: number; // 1-based palette slot
  dash: DashStyle;
  width: number;
  opacity: number; // 1 unless overridden
  visible: boolean;
  focused: boolean; // true when panel.focus is empty (nothing dimmed) or entry matches
}
export function resolvePanel(
  catalog: Catalog,
  panel: PanelState,
  namedSets: readonly NamedSet[],
): ResolvedSeries[];
export function overrideFor(
  panel: PanelState,
  ref: SeriesRef,
): SeriesOverride | undefined;
```

Semantics (P1): `pick` bindings resolve refs in stored order, skipping refs absent from the catalog; `set` bindings dereference `named_sets` (pick → refs; query → exact channel-name match across all sources — full glob grammar is P2); `query` bindings likewise exact-match the channel name. Duplicates dedupe on first occurrence. Base style: `colorSlot` = first free slot scanning 1..7 among slots already taken (by overrides first, then assignment order), `dash: "solid"`, `width: 1.4`, `visible: true`. Overrides with `target_ref` matching apply their non-null fields (`target_selector` is ignored until P2). `focused` = panel.focus empty ? true : entry matches (series ref equal | source_key equal | channel equal).

- [ ] **Step 1: Write failing tests.** Cover: pick order + dedupe + missing-ref skip; set deref (pick and query kinds); exact-channel query binding pulls the channel from every source; override application (color_slot, dash, width, visible, opacity); slot assignment skips slots claimed by overrides (two series, override pins slot 2 on the second → first gets slot 1, not 2 — mirror `WorkspaceModel.addSeries`'s first-free behavior); focus matching for all three kinds; empty focus → all `focused: true`.
- [ ] **Step 2: Run.** `./scripts/test.sh unit resolution` — FAIL.
- [ ] **Step 3: Implement** `resolvePanel` exactly per the semantics block above (~90 lines; no speculative selector parsing — exact string channel match only, one `// selector grammar lands in P2` comment).
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(frontend): panel binding resolution pipeline"`

---

### Task 7: WorkspaceModel rewrite

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Consumes: Task 5/6 types.
- Produces (Task 8/9 call these — exact signatures):

```ts
addSeriesRef(panelId: string, ref: SeriesRef): boolean;      // appends to the panel's pick binding (creates it), assigns first-free color_slot override
addSeriesRefs(panelId: string, refs: readonly SeriesRef[]): boolean;
removeSeriesRef(panelId: string, ref: SeriesRef): void;      // removes from picks, drops its overrides/focus/annotations
setSeriesOverride(panelId: string, ref: SeriesRef, style: {color_slot: number; dash: DashStyle; width: number}): void;
toggleSeriesVisible(panelId: string, ref: SeriesRef): void;  // flips override.visible
toggleFocus(panelId: string, entry: FocusEntry): void;       // replaces toggleHighlight
setXRef(panelId: string, ref: SeriesRef | null): void;       // same swap semantics as old setXSignal
setColorRef(panelId: string, ref: SeriesRef | null): void;
setColorByTime(panelId: string): void;                        // color_axis = "time"
namedSets(): readonly NamedSet[];
addNamedSet(set: NamedSet): void;
removeNamedSet(id: string): void;
setSourceAlignment(key: string, domain: TimeDomainState, scale: number, offset: number): void;
removeSignalRef(ref: SeriesRef): void;                        // replaces removeSignal(path)
```

Removed (delete, no deprecation): `setSourceSets`, `favorites`, `favoriteBundles`, `toggleFavorite`, `toggleFavoriteBundle`, `toggleHighlight`, `addSeries`, `addSeriesBatch`, `setSeriesStyle`, `removeSeries`, `setXSignal`, `setColorSignal`, `promoteSeriesToX` (re-add as `promoteSeriesToX` over the first resolved ref — takes `catalog` param or first pick ref; keep behavior: first pick ref becomes x).

- [ ] **Step 1: Rewrite `workspace.test.ts` for the new APIs first** — port every existing behavioral assertion to refs (`{source_key: "s1", channel: "temp"}` style), delete favorite/highlight tests, add: `addSeriesRef` slot assignment matches first-free semantics; `toggleFocus` add/remove round-trip; `removeSignalRef` scrubs picks, overrides, focus, x_ref, color_ref, annotations (annotations match via the catalog-free stored `series_path` — pass the display path in as a parameter: `removeSignalRef(ref, path)`); named-set add/remove; `emptySession()` is valid v17.
- [ ] **Step 2: Run.** `./scripts/test.sh unit workspace` — FAIL.
- [ ] **Step 3: Implement.** `emptySession()`/`createPanel()` emit the v17 shape (`bindings: []`, `overrides: []`, `focus: []`, `color_by: "source"`, `ghost_mode: "all"`, `split_by: "none"`, `color_axis: "none"`, `x_ref: null`, `color_ref: null`; session: `named_sets: []`, `channel_map: []`). Ref equality helper: `sameRef(a, b) = a.source_key === b.source_key && a.channel === b.channel`. `addSeriesRef` finds-or-creates the single `kind: "pick"` binding, refuses duplicates, and pushes an override `{target_ref: ref, color_slot: firstFree, dash: "solid", width: 1.4, opacity: null, visible: true, target_selector: null}` where `firstFree` scans existing overrides' `color_slot`s from 1 (preserves today's behavior exactly).
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit.** `git commit -m "refactor(frontend)!: WorkspaceModel speaks bindings, overrides, focus, named sets"`

---

### Task 8: Panel pipeline rewiring

**Files:**

- Modify: `frontend/src/ui/app-shell.ts`, `frontend/src/ui/panel.ts`, `frontend/src/ui/panel.test.ts`, `frontend/src/ui/app-shell.test.ts`

**Interfaces:**

- Consumes: `Catalog.build` on every `reloadSignals()`; `resolvePanel` everywhere `panel.series` was read; WorkspaceModel Task 7 APIs.

This is the largest rewiring task. Method: `grep -n "P1-TASK8\|\.series\b\|highlighted_sources\|panelSignalIds" frontend/src/ui/app-shell.ts frontend/src/ui/panel.ts` and burn the list down to zero.

- [ ] **Step 1:** `app-shell.ts`: hold `private catalog = Catalog.empty()`, rebuilt in `reloadSignals()` from the fetched `SignalSummary[]` (this replaces the `prefixesBySource` string arithmetic — delete it). Replace `panelSignalIds` (~963) with a resolution-based lookup: `resolvePanel(...)` refs → `catalog.get(ref).summary.signal_id`; unresolved refs are simply absent from the catalog (no silent-drop special case remains). Delete the `sets`/`SetSummary` state (~100, ~131) and its `listSets()` population.
- [ ] **Step 2:** `panel.ts`: every read of `panel.series` becomes `resolvePanel(catalog, panel, model.namedSets())` (pass catalog + sets in via the existing panel-view constructor/callback plumbing — follow how `PanelView` already receives session data). Legend chips render from `ResolvedSeries` (same chip UI as today — matrix legend is P3). Inspector (openInspector ~1574) writes through `setSeriesOverride`/`toggleSeriesVisible`; its highlight action calls `toggleFocus(panelId, {kind: "series", ref, ...})`; renderer dimming: a series with `focused: false` renders via the existing `dimmed[]` path (exact same visual as old highlight).
- [ ] **Step 3:** Drag-drop of a tree signal row now carries `{source_key, channel}` JSON (adjust `SIGNAL_DRAG_TYPE` payload in `signal-tree.ts` producer and `panel.ts` consumer together; keep the MIME constant name).
- [ ] **Step 4:** Update `panel.test.ts` / `app-shell.test.ts` assertions to the ref-based calls; keep every behavioral scenario (add series, restyle, hide, highlight→focus, x-axis swap).
- [ ] **Step 5: Run.** `./scripts/test.sh unit` — PASS, and `grep -rn "P1-TASK8" frontend/src` returns nothing.
- [ ] **Step 6: Commit.** `git commit -m "refactor(ui): panels render resolved bindings; focus replaces highlight"`

---

### Task 9: Tree rewiring — channels replace bundles, sets replace favorites

**Files:**

- Modify: `frontend/src/app/tree-model.ts`, `frontend/src/app/tree-model.test.ts`, `frontend/src/ui/signal-tree.ts`, `frontend/src/ui/signal-tree.test.ts`, `frontend/src/ui/app-shell.ts` (dock wiring + palette entries)

**Interfaces:**

- Consumes: `Catalog`, `WorkspaceModel.namedSets()`.
- Produces: `buildTreeRows(catalog, collapsed, filter)` returning rows where a multi-source channel renders one `TreeChannel {name, sourceKeys, expanded?}` row ("temp — 9 srcs", caret expands per-source leaf rows), single-source signals render as leaves; `TreeBundle` type deleted.

- [ ] **Step 1: Rewrite `tree-model.test.ts`:** channel grouping (2 sources sharing `temp` → one channel row, count 2; expansion yields per-source rows); filter still substring for P1 (the selector grammar replaces it in P2 — keep the existing filter code path, one comment); `virtualSlice` untouched; no bundle/set-summary inputs anywhere.
- [ ] **Step 2:** Implement `tree-model.ts` over `Catalog.channels()`; delete the `sets`/`expandedBundles` options, `TreeBundle`, and `collectBundleMembers`.
- [ ] **Step 3:** `signal-tree.ts`: delete `BUNDLE_DRAG_TYPE` and bundle drop/star handlers. Channel-row drag carries all member refs (Task 8's payload, an array). Replace `renderFavorites()` with `renderSets(namedSets)` — read-only rows (name + count/selector text) in the same dock slot; clicking a pick set's row adds its refs to the focused panel (reuse the favorites-click affordance); no editing UI (P2).
- [ ] **Step 4:** `app-shell.ts`: dock heading FAVORITES → SETS; palette entries for favorite toggling become no-ops removed from the registry (delete the commands, keep ids out of the registry — do not leave planned stubs); `bundleCompletionEntries` (~110–120) deleted, ⌘P signal entries come from `catalog.allSeries()` paths.
- [ ] **Step 5: Run.** `./scripts/test.sh unit` then `./scripts/test.sh frontend` — PASS. Playwright specs referencing favorites/bundles (`workbench.spec.ts`) updated in place to the SETS list and channel rows.
- [ ] **Step 6: Commit.** `git commit -m "refactor(ui)!: catalog channel rows and read-only sets replace bundles and favorites"`

---

### Task 10: Alignment UI + export dialog sweep

**Files:**

- Modify: `frontend/src/ui/app-shell.ts` (source rows/footer), `frontend/src/ui/export-dialog.ts`, e2e specs touching alignment/export

- [ ] **Step 1:** Wherever the source footer/rows exposed set alignment (find via `grep -n "align" frontend/src/ui/*.ts`), rewire to `dataPlane.setSourceAlignment` + `model.setSourceAlignment` per source. If the old UI was set-scoped (one dialog for a set), it becomes source-scoped with identical fields (unit, origin, scale, offset).
- [ ] **Step 2:** Export dialog: verify Task 4 Step 6 left source-only selection consistent (labels say sources; estimates request `{source_keys}`).
- [ ] **Step 3: Run.** `./scripts/test.sh unit && ./scripts/test.sh e2e` — PASS (update `snapshot-roundtrip.spec.ts` and `settings-and-undo.spec.ts` expectations where they assert v16 shapes).
- [ ] **Step 4: Commit.** `git commit -m "refactor(ui): per-source time alignment; export selects sources"`

---

### Task 11: Final gate — deletions verified, CI, version bump

**Files:**

- Modify: `docs/implementation-roadmap.md` (one short paragraph: P1 of the signals-at-scale spec landed), version manifests via script.

- [ ] **Step 1: Grep gates** — all must return only migration code (`session.rs` v16 arm), ADR/docs history, and this plan/spec:

```bash
grep --recursive --ignore-case --line-number "bundle" --include="*.ts" --include="*.rs" frontend/src core protocol shell | grep --invert-match derived_bundle
grep --recursive --ignore-case --line-number "source_set\|SetSummary\|favorite" --include="*.ts" --include="*.rs" frontend/src core protocol shell
grep -rn "highlighted_sources\|SeriesState\|prefixesBySource" frontend/src core
```

(`derived_bundles` intentionally survives P1 — it already has channel×source semantics; its rename is out of scope.) Investigate and delete any other hit.

- [ ] **Step 2: Round-trip acceptance.** Add (if not present from Task 4) a unit test: build a session with a query binding, a pick binding, named sets of both kinds, overrides, focus entries, channel_map entry, and source alignment → `JSON.parse(JSON.stringify(session))` deep-equals through `baked-session` validation; and a Rust test: v17 `save_to_path`/`load_from_path` round-trip equality.
- [ ] **Step 3: Full gate.** Run: `./scripts/ci.sh all` — expected: PASS, including the codegen diff check.
- [ ] **Step 4: Version bump.** `./scripts/version.sh bump major && ./scripts/version.sh check` — commit the manifest changes.
- [ ] **Step 5: Commit.** `git commit -m "chore(release): major bump — session schema v17"` then report: changed files, commands run, anything left open.

---

## Self-review notes (already applied)

- Spec coverage: catalog ✓ (T5), bindings/resolution ✓ (T6), v17-complete-schema ✓ (T1), migration ✓ (T1), alignment relocation ✓ (T2), sets/protocol deletion ✓ (T3), bundle UI deletion ✓ (T9), favorites→sets ✓ (T1/T9), highlight→focus ✓ (T1/T8), UI-equivalent gate ✓ (T8–T10), grep gate + round-trip + `ci.sh all` + major bump ✓ (T11). Selector grammar, rules UI, matrix legend, ghosts, table, channel-map UI, facets: P2–P5 by design, not gaps.
- Known judgment calls the executor must NOT revisit: reserved `"derived"` source key; orphan series paths drop during migration (matches current `panelSignalIds` behavior); `derived_bundles` survives P1; annotations keep path strings; P1 query matching is exact channel name only.
