# Multi-Source Scale Implementation Plan (Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the native data plane from one file per workspace to hundreds or
thousands of sources with durable identity, batched off-lock ingest, ensemble
(run-mean envelope) queries, and an out-of-core store.

**Architecture:** Durable `SourceKey` (UUID) and process-local `SourceId` are
separated; a signal's storage identity becomes `(SourceId, local_path)` and its
display path becomes `prefix/local_path`. `Decoder::decode` stops touching the
store and returns owned columns, so decode and pyramid build run off the store
mutex and only a short commit holds the write lock. One batch job ingests many
files with per-file failure policy, memory-weighted admission, and
cancellation. Source sets add across-run ensemble tiles. Storage then shrinks
(compact bins, elide the finest levels) before paging bins and columns out of
core.

**Tech Stack:** Rust 2024 (`scope-core`, `scope-protocol`, Tauri shell),
TypeScript/canvas frontend, JSON-schema codegen for protocol/session/preferences,
`uuid`, `sha2`, `crc32fast`, std threads (no async runtime in core).

## Global Constraints

- Every command goes through `./scripts/*`; add or extend a wrapper rather than
  running ad-hoc `cargo`/`pnpm` (AGENTS.md "Command and workflow policy").
- `protocol/schema/*.json` is the single schema source. Never hand-edit
  `protocol/src/generated.rs`, `core/scope-core/src/session/generated.rs`,
  `core/scope-core/src/preferences/generated.rs`, or
  `frontend/src/generated/*.ts`; run `./scripts/codegen.sh` and keep
  `pnpm codegen:check` green.
- Wire `u64` uses the schema's string representation at the TypeScript boundary.
- `unsafe_code = "forbid"` at the workspace root. **No `mmap`.** Paging uses
  positioned reads (`FileExt::read_at` / `seek_read`) behind one cross-platform
  helper; the sidecar layout stays mmap-shaped so a future exemption is a local
  change (deviation from the spec's wording, recorded in ADR 0029).
- Session and protocol changes: additive fields need defaults, breaking changes
  need a version plus a migration rung, unknown future versions fail clearly and
  never partially restore (ADR 0005).
- Signal registration stays transactional per file; a failed decode leaves no
  source or partial signals visible.
- Time columns must be finite and monotonically nondecreasing before insertion.
- Pyramid invariants (ADR 0003/0014): parents preserve first, last, finite
  min/max, sums, counts, and the OR of child gap bits.
- Display paths are lowercase snake_case, never contain parent-directory text,
  and are treated as untrusted data in the frontend (`textContent`, never HTML).
- New dependencies must pass `cargo deny check` (allow list: Apache-2.0,
  Apache-2.0 WITH LLVM-exception, BSD-3-Clause, MIT, MPL-2.0, Unicode-3.0, Zlib)
  and `cargo machete`.
- Every phase ends with `./scripts/format.sh`, the affected suite, and
  `./scripts/version.sh bump <major|minor|patch>` + `./scripts/version.sh check`.
- Part B (`2026-07-30-extensible-ingest.md`) consumes this plan's
  `ProviderInfo`/`provenance_digest` seam. Execute this plan first.

---

## File Structure

**New in `core/scope-core/src/`:**

| File                   | Responsibility                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `naming.rs`            | Segment normalization, prefix allocation, deterministic legacy keys. No deps on store/ingest/session. |
| `sources.rs`           | `SourceRecord`, `SourceRegistry`: key minting, path aliasing, idempotent admission.                   |
| `restore.rs`           | Application service: re-ingest → alias map → atomic session reconciliation.                           |
| `sets.rs`              | `SourceSet`, schema fingerprint, membership, time domain, affine alignment.                           |
| `ensemble.rs`          | Across-run run-mean envelope query over aligned members.                                              |
| `bins.rs`              | Struct-of-arrays storage bins and wire conversion.                                                    |
| `columns.rs`           | Owned-or-paged column abstraction plus timebase identity.                                             |
| `paging.rs`            | Leased page cache with LRU eviction over sidecar byte ranges.                                         |
| `ingest/decoded.rs`    | `DecodedSource`, `DecodedSignal`, host-side `commit`.                                                 |
| `ingest/provenance.rs` | `ProviderInfo`, source fingerprint, decode-provenance digest.                                         |
| `ingest/admission.rs`  | Memory-weighted admission tickets and budgets.                                                        |
| `ingest/batch.rs`      | Batch job state machine, executor, `CommitSink`.                                                      |

**Modified:** `store.rs` (identity split, dual index), `ingest/{mod,csv,mcap}.rs`,
`cache.rs`, `pyramid.rs`, `expr.rs`, `session.rs`, `snapshot.rs`,
`preferences.rs`, `bin/scope-bake.rs`, `shell/src-tauri/src/lib.rs`,
`protocol/schema/{scope-protocol,scope-session,scope-preferences}.json`,
`frontend/src/app/{data-plane,ingest,workspace,history,baked-session}.ts`,
`frontend/src/ui/{app-shell,signal-tree,panel,export-dialog}.ts`,
`frontend/src/render/canvas-renderer.ts`, `scripts/test.sh`, `docs/adr/*`.

---

## Phase 0 — tooling

### Task 1: Filtered test wrappers

TDD needs a wrapper that runs one Rust test. `./scripts/test.sh core` runs the
whole workspace today; every later task depends on the filtered form.

**Files:**

- Modify: `scripts/test.sh`
- Modify: `AGENTS.md:63` (canonical command list)

**Interfaces:**

- Produces: `./scripts/test.sh core [filter…]`, `./scripts/test.sh shell [filter…]`,
  `./scripts/test.sh unit [filter…]` (frontend vitest). Every later task's
  test-run steps use these.

- [ ] **Step 1: Extend the script**

```bash
test_core() {
  cargo test --workspace --exclude signalscope-shell -- "$@"
}

test_shell() {
  cargo test -p signalscope-shell -- "$@"
}

test_unit() {
  pnpm --filter @signalscope/frontend test -- "$@"
}
```

In the `case`, replace the `core)` arm and add two arms:

```bash
core)
  shift || true
  test_core "$@"
  ;;
shell)
  shift || true
  test_shell "$@"
  ;;
unit)
  shift || true
  test_unit "$@"
  ;;
```

`full` and `quick` keep calling `test_core` with no arguments. Add the three
modes to `show_help` and to the `AGENTS.md` command list.

- [ ] **Step 2: Verify the filter reaches the harness**

Run: `./scripts/test.sh core registers_source_and_signal`
Expected: PASS, `running 1 test`.

- [ ] **Step 3: Verify the policy gate still passes**

Run: `./scripts/ci.sh quality`
Expected: PASS (shellcheck + `ci-policy.test.sh`).

- [ ] **Step 4: Commit**

```bash
git add scripts/test.sh AGENTS.md
git commit -m "chore: forward test filters through the test wrapper"
```

---

## Phase A1 — durable identity and batch ingest (spec P1)

Phase gate: parallel directory loads survive individual bad files, sources have
durable keys and stable prefixes, and restoring a legacy session rewrites its
signal references exactly once.

### Task 2: Naming and deterministic keys

**Files:**

- Create: `core/scope-core/src/naming.rs`
- Modify: `core/scope-core/src/lib.rs`, `core/scope-core/src/ingest/mod.rs`
  (remove `normalize_segment`, re-export from `naming`), `Cargo.toml`,
  `core/scope-core/Cargo.toml`

**Interfaces:**

- Produces: `naming::{normalize_segment, default_prefix, allocate_prefix,
legacy_source_key, LEGACY_NAMESPACE}`. `sources` (Task 4), `session` (Task 14),
  and both decoders consume them.

- [ ] **Step 1: Add the uuid dependency**

Root `Cargo.toml` `[workspace.dependencies]`: `uuid = { version = "1", features = ["v4", "v5", "serde"] }`.
`core/scope-core/Cargo.toml` `[dependencies]`: `uuid.workspace = true`.

- [ ] **Step 2: Write the failing test**

Create `core/scope-core/src/naming.rs` with only this test module plus
`use std::{collections::BTreeSet, path::Path};`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_never_carry_parent_directory_text() {
        assert_eq!(default_prefix(Path::new("/runs/2026/Flight Test.csv")), "flight_test");
        assert_eq!(default_prefix(Path::new("/runs/.hidden")), "hidden");
        assert_eq!(default_prefix(Path::new("/runs/")), "runs");
    }

    #[test]
    fn collisions_widen_a_key_digest_instead_of_counting() {
        let key = legacy_source_key("/a/run.csv");
        let mut taken = BTreeSet::new();
        let first = allocate_prefix(&taken, Path::new("/a/run.csv"), key).unwrap();
        assert_eq!(first, "run");
        taken.insert(first);
        let second = allocate_prefix(&taken, Path::new("/b/run.csv"), key).unwrap();
        assert_eq!(second, format!("run_{}", &key.simple().to_string()[..4]));
        // Order-independent: the same key in a fuller set still derives from the digest.
        taken.insert(second.clone());
        assert!(allocate_prefix(&taken, Path::new("/c/run.csv"), key).unwrap().starts_with("run_"));
    }

    #[test]
    fn legacy_keys_are_stable_across_machines() {
        assert_eq!(legacy_source_key("/data/run.csv"), legacy_source_key("/data/run.csv"));
        assert_ne!(legacy_source_key("/data/run.csv"), legacy_source_key("/data/run2.csv"));
        assert_eq!(
            legacy_source_key("/data/run.csv").to_string(),
            uuid::Uuid::new_v5(&LEGACY_NAMESPACE, b"/data/run.csv").to_string()
        );
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test.sh core naming::`
Expected: FAIL — `cannot find function default_prefix in this scope`.

- [ ] **Step 4: Implement the module**

```rust
//! Display-name rules shared by ingest, the source registry, and session
//! migration. Depends on nothing else in the crate so the pure session
//! migration ladder can use it without depending on ingest.

use std::{collections::BTreeSet, path::Path};

use uuid::Uuid;

/// Namespace for deterministic keys minted by the v10→v11 session migration.
/// Never change it: the same legacy session must migrate to the same keys on
/// every machine, forever.
pub const LEGACY_NAMESPACE: Uuid = Uuid::from_u128(0x6a1f_2d47_9c53_4f21_8b0e_1d7c_3a95_04ef);

/// Lowercases a path segment and folds spaces/dots to underscores.
#[must_use]
pub fn normalize_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .replace([' ', '.'], "_")
        .to_lowercase()
}

/// The prefix a source prefers: its normalized file stem, never any
/// parent-directory text. Display paths reach sessions and snapshots, where
/// filesystem context would defeat export path redaction (ADR 0024).
#[must_use]
pub fn default_prefix(path: &Path) -> String {
    let stem = path
        .file_stem()
        .or_else(|| path.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("source");
    let normalized = normalize_segment(stem.trim_start_matches('.'));
    if normalized.is_empty() {
        "source".to_owned()
    } else {
        normalized
    }
}

/// [`default_prefix`], disambiguated by a short digest of `key` when taken.
/// The digest widens instead of counting so a prefix never depends on the
/// order sources were admitted in.
#[must_use]
pub fn allocate_prefix(taken: &BTreeSet<String>, path: &Path, key: Uuid) -> Option<String> {
    let base = default_prefix(path);
    if !taken.contains(&base) {
        return Some(base);
    }
    let digest = key.simple().to_string();
    [4_usize, 8, 16, 32].into_iter().find_map(|width| {
        let candidate = format!("{base}_{}", &digest[..width]);
        (!taken.contains(&candidate)).then_some(candidate)
    })
}

/// The deterministic key a pre-v11 `source_paths` entry migrates to.
#[must_use]
pub fn legacy_source_key(path: &str) -> Uuid {
    Uuid::new_v5(&LEGACY_NAMESPACE, path.as_bytes())
}
```

Add `pub mod naming;` to `lib.rs`. In `ingest/mod.rs` delete
`normalize_segment` and add `use crate::naming::normalize_segment;`; `csv.rs`
and `mcap.rs` keep importing it through `super::`.

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core/Cargo.toml core/scope-core/src/naming.rs \
        core/scope-core/src/lib.rs core/scope-core/src/ingest/mod.rs
git commit -m "feat(core): add naming rules and deterministic legacy source keys"
```

---

### Task 3: Split durable, storage, and display identity in the store

**Files:**

- Modify: `core/scope-core/src/store.rs`
- Modify: `core/scope-core/src/ingest/{csv,mcap}.rs`, `core/scope-core/src/cache.rs`,
  `shell/src-tauri/src/lib.rs` (call sites)

**Interfaces:**

- Consumes: `naming::normalize_segment`.
- Produces: `store::SourceKey(pub Uuid)`; `Source { id, key, path, prefix,
point_count }`; `Signal { id, source_id, local_path, path, unit, … }`;
  `SignalStore::register_source(path, key, prefix) -> Result<SourceId, StoreError>`;
  `insert_signal(source_id, local_path, unit, time, values)`;
  `StoreError::{DuplicateSignal { source_id, local_path }, DisplayPathCollision(String),
DuplicatePrefix(String)}`; `signals_of(source_id)`.

- [ ] **Step 1: Write the failing test**

Append to `store.rs`'s test module:

```rust
    fn key(byte: u8) -> SourceKey {
        SourceKey(uuid::Uuid::from_bytes([byte; 16]))
    }

    #[test]
    fn identical_local_paths_coexist_under_distinct_prefixes() {
        let mut store = SignalStore::new();
        let left = store.register_source("/a/run.csv", key(1), "run_a").unwrap();
        let right = store.register_source("/b/run.csv", key(2), "run_b").unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        store.insert_signal(left, "imu/ax", None, Arc::clone(&time), vec![1.0, 2.0]).unwrap();
        store.insert_signal(right, "imu/ax", None, Arc::clone(&time), vec![3.0, 4.0]).unwrap();

        assert_eq!(store.signal_by_path("run_a/imu/ax").unwrap().values(), &[1.0, 2.0]);
        assert_eq!(store.signal_by_path("run_b/imu/ax").unwrap().values(), &[3.0, 4.0]);
        assert_eq!(store.signal_by_path("run_b/imu/ax").unwrap().local_path, "imu/ax");
    }

    #[test]
    fn duplicates_inside_one_source_and_prefix_reuse_are_rejected() {
        let mut store = SignalStore::new();
        let source = store.register_source("/a/run.csv", key(1), "run").unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0]);
        store.insert_signal(source, "imu/ax", None, Arc::clone(&time), vec![1.0]).unwrap();

        assert!(matches!(
            store.insert_signal(source, "imu/ax", None, Arc::clone(&time), vec![2.0]),
            Err(StoreError::DuplicateSignal { .. })
        ));
        assert!(matches!(
            store.register_source("/b/run.csv", key(2), "run"),
            Err(StoreError::DuplicatePrefix(_))
        ));
    }

    #[test]
    fn rollback_clears_both_indexes() {
        let mut store = SignalStore::new();
        let result: Result<(), &str> = store.transaction(|store| {
            let source = store.register_source("/a/run.csv", key(1), "run").unwrap();
            store
                .insert_signal(source, "imu/ax", None, Arc::from(vec![0.0]), vec![1.0])
                .unwrap();
            Err("decode failed")
        });
        assert!(result.is_err());
        assert!(store.signal_by_path("run/imu/ax").is_none());
        assert!(store.register_source("/b/run.csv", key(2), "run").is_ok());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core store::`
Expected: FAIL — `register_source` takes one argument.

- [ ] **Step 3: Implement the identity split**

```rust
/// Durable, workspace-scoped identity for a source. Survives restart; every
/// persisted reference to a source uses it.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct SourceKey(pub uuid::Uuid);

pub struct Source {
    pub id: SourceId,
    pub key: SourceKey,
    pub path: PathBuf,
    pub prefix: String,
    pub point_count: usize,
}

pub struct Signal {
    pub id: SignalId,
    pub source_id: SourceId,
    /// Identity inside its source, assigned by the decoder.
    pub local_path: String,
    /// `prefix/local_path`; the durable, user-visible name.
    pub path: String,
    pub unit: Option<String>,
    time: Arc<[f64]>,
    values: Arc<[f64]>,
}
```

`SignalStore` gains `prefixes: BTreeMap<String, SourceId>` and
`by_storage: BTreeMap<(SourceId, String), SignalId>` beside the existing
`signal_paths` display index.

```rust
    /// # Errors
    ///
    /// Returns [`StoreError::DuplicatePrefix`] when `prefix` is already taken;
    /// prefixes are allocated before decode so display paths cannot collide.
    pub fn register_source(
        &mut self,
        path: impl AsRef<Path>,
        key: SourceKey,
        prefix: impl Into<String>,
    ) -> Result<SourceId, StoreError> {
        let prefix = prefix.into();
        if self.prefixes.contains_key(&prefix) {
            return Err(StoreError::DuplicatePrefix(prefix));
        }
        let id = SourceId(self.next_source_id);
        self.next_source_id += 1;
        self.prefixes.insert(prefix.clone(), id);
        self.sources.insert(id, Source { id, key, path: path.as_ref().to_owned(), prefix, point_count: 0 });
        Ok(id)
    }

    pub fn insert_signal(
        &mut self,
        source_id: SourceId,
        local_path: impl Into<String>,
        unit: Option<String>,
        time: Arc<[f64]>,
        values: impl Into<Arc<[f64]>>,
    ) -> Result<SignalId, StoreError> {
        let source = self.sources.get_mut(&source_id).ok_or(StoreError::UnknownSource(source_id))?;
        let local_path = local_path.into();
        let storage = (source_id, local_path.clone());
        if self.by_storage.contains_key(&storage) {
            return Err(StoreError::DuplicateSignal { source_id, local_path });
        }
        let path = format!("{}/{local_path}", source.prefix);
        if self.signal_paths.contains_key(&path) {
            return Err(StoreError::DisplayPathCollision(path));
        }
        let values: Arc<[f64]> = values.into();
        let id = SignalId(self.next_signal_id);
        let point_count = values.len();
        let signal = Signal::new(id, source_id, local_path, path.clone(), unit, time, values)?;
        self.next_signal_id += 1;
        self.signals.insert(id, signal);
        self.signal_paths.insert(path, id);
        self.by_storage.insert(storage, id);
        source.point_count += point_count;
        Ok(id)
    }

    pub fn signals_of(&self, source_id: SourceId) -> impl Iterator<Item = &Signal> {
        self.signals.values().filter(move |signal| signal.source_id == source_id)
    }
```

`transaction` additionally runs
`self.by_storage.retain(|_, id| id.0 < signal_watermark);` and
`self.prefixes.retain(|_, id| id.0 < source_watermark);`. `remove_signal` also
removes the `by_storage` entry. `Signal::new` takes `local_path` and `path`.

Call-site updates: `csv.rs`/`mcap.rs` pass the bare local path (drop the
`base/` and topic prefixing — Task 5 moves registration out anyway, so make the
minimal edit: `store.register_source(path, SourceKey(Uuid::new_v4()), naming::default_prefix(path))?`);
`cache.rs::try_load` does the same; the shell's derived source registers as
`register_source(DERIVED_PREFIX, SourceKey(Uuid::new_v4()), "derived")` and
inserts `local_path` = the path with the `derived/` prefix stripped.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core` then `./scripts/test.sh shell`
Expected: PASS. Fixture expectations that hard-coded `demo_flight/...` still
hold because the prefix is the normalized stem.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "feat(core): separate durable, storage, and display signal identity"
```

---

### Task 4: Source registry with idempotent admission

**Files:**

- Create: `core/scope-core/src/sources.rs`
- Modify: `core/scope-core/src/lib.rs`

**Interfaces:**

- Consumes: `naming::{allocate_prefix, legacy_source_key}`, `store::SourceKey`.
- Produces: `sources::{SourceRecord, SourceRegistry, Admission}`;
  `SourceRegistry::admit(&mut self, &Path) -> Result<Admission, SourceError>`;
  `Admission::{Existing(SourceKey), New(SourceRecord)}`;
  `SourceRecord { key, path, prefix, provider_id: Option<String>,
decode_provenance: Option<String>, reconcile_legacy: bool }`. Tasks 11, 14,
  16 consume it.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeating_a_path_is_idempotent_but_new_files_get_new_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.csv");
        std::fs::write(&path, "time,v\n0,1\n").unwrap();
        let twin = dir.path().join("twin.csv");
        std::fs::write(&twin, "time,v\n0,1\n").unwrap();

        let mut registry = SourceRegistry::new();
        let Admission::New(record) = registry.admit(&path).unwrap() else {
            panic!("first admission is new");
        };
        assert_eq!(record.prefix, "run");
        assert!(record.provider_id.is_none());

        assert_eq!(registry.admit(&path).unwrap(), Admission::Existing(record.key));
        // Identical bytes are still a distinct source.
        let Admission::New(other) = registry.admit(&twin).unwrap() else {
            panic!("a different path is a different source");
        };
        assert_ne!(other.key, record.key);
    }

    #[test]
    fn same_stem_in_two_directories_gets_distinct_stable_prefixes() {
        let dir = tempfile::tempdir().unwrap();
        let (left, right) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&right).unwrap();
        for parent in [&left, &right] {
            std::fs::write(parent.join("run.csv"), "time,v\n0,1\n").unwrap();
        }

        let mut registry = SourceRegistry::new();
        let Admission::New(first) = registry.admit(&left.join("run.csv")).unwrap() else { panic!() };
        let Admission::New(second) = registry.admit(&right.join("run.csv")).unwrap() else { panic!() };
        assert_eq!(first.prefix, "run");
        assert!(second.prefix.starts_with("run_"));
        assert!(!second.prefix.contains('b'), "prefixes never carry directory text");

        // Growth does not rewrite an existing prefix.
        assert_eq!(registry.record(first.key).unwrap().prefix, "run");
    }

    #[test]
    fn relocation_keeps_the_key_and_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("run.csv");
        let new = dir.path().join("moved.csv");
        std::fs::write(&old, "time,v\n0,1\n").unwrap();
        std::fs::write(&new, "time,v\n0,1\n").unwrap();
        let mut registry = SourceRegistry::new();
        let Admission::New(record) = registry.admit(&old).unwrap() else { panic!() };

        registry.relocate(record.key, &new).unwrap();
        assert_eq!(registry.record(record.key).unwrap().path, new.canonicalize().unwrap());
        assert_eq!(registry.record(record.key).unwrap().prefix, "run");
        assert_eq!(registry.admit(&new).unwrap(), Admission::Existing(record.key));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core sources::`
Expected: FAIL — `SourceRegistry` not found.

- [ ] **Step 3: Implement the registry**

```rust
//! Workspace-scoped source identity: which paths are loaded, under which
//! durable key, and with which display prefix.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{naming, store::SourceKey};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub key: SourceKey,
    pub path: PathBuf,
    pub prefix: String,
    /// `None` only while a migrated source has not been re-ingested yet.
    pub provider_id: Option<String>,
    pub decode_provenance: Option<String>,
    pub reconcile_legacy: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Admission {
    Existing(SourceKey),
    New(SourceKeyed),
}

#[derive(Debug, Error)]
pub enum SourceError {
    #[error("source path cannot be canonicalized: {0}")]
    Io(#[from] std::io::Error),
    #[error("no free display prefix for {0}")]
    PrefixExhausted(String),
    #[error("unknown source key")]
    UnknownKey,
}

#[derive(Debug, Default)]
pub struct SourceRegistry {
    by_key: BTreeMap<SourceKey, SourceRecord>,
    by_path: BTreeMap<PathBuf, SourceKey>,
    prefixes: BTreeSet<String>,
}
```

`Admission::New` carries the whole `SourceRecord` (make the enum
`New(SourceRecord)`; drop the `SourceKeyed` placeholder above and derive
`Clone, Debug, PartialEq, Eq` — `SourceRecord` is not `Copy`).

```rust
impl SourceRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Canonicalizes `path` to detect aliases on this machine, then either
    /// reports the existing source or mints a key and prefix for a new one.
    ///
    /// # Errors
    ///
    /// Returns [`SourceError::Io`] when `path` cannot be canonicalized and
    /// [`SourceError::PrefixExhausted`] when no free prefix exists.
    pub fn admit(&mut self, path: &Path) -> Result<Admission, SourceError> {
        let canonical = path.canonicalize()?;
        if let Some(key) = self.by_path.get(&canonical) {
            return Ok(Admission::Existing(*key));
        }
        let key = SourceKey(Uuid::new_v4());
        let prefix = naming::allocate_prefix(&self.prefixes, &canonical, key.0)
            .ok_or_else(|| SourceError::PrefixExhausted(canonical.display().to_string()))?;
        let record = SourceRecord {
            key,
            path: canonical.clone(),
            prefix: prefix.clone(),
            provider_id: None,
            decode_provenance: None,
            reconcile_legacy: false,
        };
        self.prefixes.insert(prefix);
        self.by_path.insert(canonical, key);
        self.by_key.insert(key, record.clone());
        Ok(Admission::New(record))
    }

    /// Re-inserts a record restored from a session, keeping its key and prefix.
    ///
    /// # Errors
    ///
    /// Returns [`SourceError::PrefixExhausted`] when the prefix is already used
    /// by a different key.
    pub fn restore(&mut self, record: SourceRecord) -> Result<(), SourceError> {
        if self.prefixes.contains(&record.prefix)
            && self.by_key.get(&record.key).map(|existing| &existing.prefix) != Some(&record.prefix)
        {
            return Err(SourceError::PrefixExhausted(record.prefix));
        }
        self.prefixes.insert(record.prefix.clone());
        self.by_path.insert(record.path.clone(), record.key);
        self.by_key.insert(record.key, record);
        Ok(())
    }

    /// Points an existing key at a new path, keeping key and prefix.
    ///
    /// # Errors
    ///
    /// Returns [`SourceError::UnknownKey`] or [`SourceError::Io`].
    pub fn relocate(&mut self, key: SourceKey, path: &Path) -> Result<(), SourceError> {
        let canonical = path.canonicalize()?;
        let record = self.by_key.get_mut(&key).ok_or(SourceError::UnknownKey)?;
        self.by_path.remove(&record.path);
        record.path = canonical.clone();
        self.by_path.insert(canonical, key);
        Ok(())
    }

    #[must_use]
    pub fn record(&self, key: SourceKey) -> Option<&SourceRecord> {
        self.by_key.get(&key)
    }

    pub fn set_provenance(&mut self, key: SourceKey, provider_id: String, digest: String) {
        if let Some(record) = self.by_key.get_mut(&key) {
            record.provider_id = Some(provider_id);
            record.decode_provenance = Some(digest);
            record.reconcile_legacy = false;
        }
    }

    pub fn records(&self) -> impl Iterator<Item = &SourceRecord> {
        self.by_key.values()
    }
}
```

Add `pub mod sources;` to `lib.rs`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core sources::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/sources.rs core/scope-core/src/lib.rs
git commit -m "feat(core): add the workspace source registry"
```

---

### Task 5: Decoders return columns; the host commits

**Files:**

- Create: `core/scope-core/src/ingest/decoded.rs`
- Modify: `core/scope-core/src/ingest/{mod,csv,mcap}.rs`, `core/scope-core/src/cache.rs`,
  `core/scope-core/src/bin/scope-bake.rs`, `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `store::{SignalStore, SourceId, SourceKey}`, `sources::SourceRecord`.
- Produces: `ingest::{DecodedSource, DecodedSignal, DecodeContext, CancelToken,
commit}`; `Decoder::decode(&self, &Path, &mut DecodeContext) -> Result<DecodedSource, IngestError>`;
  `IngestError::Cancelled`. Tasks 6, 8, 11 consume them.

- [ ] **Step 1: Write the failing test**

New `core/scope-core/src/ingest/decoded.rs` test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SourceKey;

    fn decoded() -> DecodedSource {
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        DecodedSource {
            row_count: 2,
            signals: vec![
                DecodedSignal { local_path: "imu/ax".into(), unit: None, time: Arc::clone(&time), values: Arc::from(vec![1.0, 2.0]) },
                DecodedSignal { local_path: "imu/ay".into(), unit: Some("m/s2".into()), time, values: Arc::from(vec![3.0, 4.0]) },
            ],
        }
    }

    #[test]
    fn commit_registers_under_the_pre_assigned_key_and_prefix() {
        let mut store = SignalStore::new();
        let key = SourceKey(uuid::Uuid::from_bytes([7; 16]));
        let summary = commit(&mut store, key, "run", Path::new("/a/run.csv"), decoded()).unwrap();

        assert_eq!(summary.row_count, 2);
        assert_eq!(summary.signals.len(), 2);
        assert_eq!(store.signal_by_path("run/imu/ay").unwrap().unit.as_deref(), Some("m/s2"));
        assert_eq!(store.sources().next().unwrap().key, key);
    }

    #[test]
    fn a_failed_commit_leaves_no_source_or_partial_signals() {
        let mut store = SignalStore::new();
        let key = SourceKey(uuid::Uuid::from_bytes([7; 16]));
        let mut broken = decoded();
        broken.signals[1].local_path = "imu/ax".into();

        assert!(commit(&mut store, key, "run", Path::new("/a/run.csv"), broken).is_err());
        assert_eq!(store.sources().count(), 0);
        assert_eq!(store.signals().count(), 0);
    }

    #[test]
    fn a_cancelled_context_stops_at_the_next_check() {
        let cancel = CancelToken::default();
        let mut progress = |_: f64| {};
        let mut context = DecodeContext { progress: &mut progress, cancel: &cancel };
        assert!(context.check().is_ok());
        cancel.cancel();
        assert!(matches!(context.check(), Err(IngestError::Cancelled)));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core ingest::decoded`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement decoded columns, the cancel token, and commit**

```rust
//! Decoded-but-uncommitted source columns and the host-side commit step.
//!
//! Decoding never touches the store: batch ingest needs a value it can move
//! off the store lock (amends ADR 0009).

use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use super::{IngestError, IngestSummary};
use crate::store::{SignalStore, SourceKey};

#[derive(Clone, Debug)]
pub struct DecodedSignal {
    pub local_path: String,
    pub unit: Option<String>,
    pub time: Arc<[f64]>,
    pub values: Arc<[f64]>,
}

#[derive(Clone, Debug, Default)]
pub struct DecodedSource {
    pub row_count: usize,
    pub signals: Vec<DecodedSignal>,
}

impl DecodedSource {
    /// Bytes of column memory this decode holds; the admission budget charges
    /// the actual figure once decode finishes.
    #[must_use]
    pub fn column_bytes(&self) -> usize {
        self.signals
            .iter()
            .map(|signal| (signal.time.len() + signal.values.len()) * size_of::<f64>())
            .sum()
    }
}

/// Cooperative cancellation shared by a batch job and its decoders.
#[derive(Debug, Default)]
pub struct CancelToken(AtomicBool);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Progress and cancellation handed to a decoder. Decoders call
/// [`DecodeContext::check`] at their batch boundaries.
pub struct DecodeContext<'a> {
    pub progress: &'a mut dyn FnMut(f64),
    pub cancel: &'a CancelToken,
}

impl DecodeContext<'_> {
    /// # Errors
    ///
    /// Returns [`IngestError::Cancelled`] once the job has been cancelled.
    pub fn check(&self) -> Result<(), IngestError> {
        if self.cancel.is_cancelled() {
            return Err(IngestError::Cancelled);
        }
        Ok(())
    }

    pub fn report(&mut self, fraction: f64) {
        (self.progress)(fraction.clamp(0.0, 1.0));
    }
}

/// Registers `decoded` under a pre-assigned key and prefix, atomically.
///
/// # Errors
///
/// Returns [`IngestError::Store`] when registration conflicts; the store is
/// unchanged in that case.
pub fn commit(
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    path: &Path,
    decoded: DecodedSource,
) -> Result<IngestSummary, IngestError> {
    store.transaction(|store| {
        let source_id = store.register_source(path, key, prefix)?;
        let mut signals = Vec::with_capacity(decoded.signals.len());
        for signal in decoded.signals {
            signals.push(store.insert_signal(
                source_id,
                signal.local_path,
                signal.unit,
                signal.time,
                signal.values,
            )?);
        }
        Ok(IngestSummary { source_id, row_count: decoded.row_count, signals })
    })
}
```

Add `IngestError::Cancelled` (`#[error("ingest was cancelled")]`) and
`mod decoded; pub use decoded::*;` in `ingest/mod.rs`. Change the trait:

```rust
pub trait Decoder {
    /// Decodes `path` into owned columns without touching any store.
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read or decoded, and
    /// [`IngestError::Cancelled`] when the job is cancelled mid-decode.
    fn decode(&self, path: &Path, context: &mut DecodeContext<'_>) -> Result<DecodedSource, IngestError>;
}
```

Delete `Decoder::ingest` (atomicity now lives in `commit`). Rewrite
`ingest_path` as:

```rust
pub fn ingest_path(
    path: impl AsRef<Path>,
    store: &mut SignalStore,
    key: SourceKey,
    prefix: &str,
    context: &mut DecodeContext<'_>,
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    let decoded = match sniff_format(path)? {
        SourceFormat::Csv => CsvDecoder.decode(path, context)?,
        SourceFormat::Mcap => McapDecoder.decode(path, context)?,
    };
    commit(store, key, prefix, path, decoded)
}
```

`csv.rs` returns `DecodedSource` with bare header names as `local_path` (no
`base/` prefix); `mcap.rs` returns `topic/field` as `local_path`. `cache.rs`
threads a `DecodeContext` through and passes the key/prefix from its caller;
`scope-bake.rs` mints `SourceKey(Uuid::new_v4())` plus
`naming::default_prefix` per `--data` file. Update the two ingest tests that
asserted store side effects during decode.

- [ ] **Step 4: Run everything**

Run: `./scripts/test.sh core` then `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "feat(core): decode into owned columns and commit host-side"
```

---

### Task 6: Streaming CSV decode

**Files:**

- Modify: `core/scope-core/src/ingest/csv.rs`

**Interfaces:**

- Consumes: `DecodeContext`, `DecodedSource`.
- Produces: `CsvDecoder::decode_reader<R: BufRead>(reader, context) -> Result<DecodedSource, IngestError>`
  (used by Part B's recipe decoders and by tests).

- [ ] **Step 1: Write the failing test**

```rust
    /// A reader that logs each `read` so the test can prove decoding is
    /// interleaved with reading rather than slurping the file first.
    struct LoggingReader<'a> {
        inner: std::io::Cursor<Vec<u8>>,
        log: std::rc::Rc<std::cell::RefCell<Vec<&'a str>>>,
    }

    impl std::io::Read for LoggingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buffer)?;
            if read > 0 {
                self.log.borrow_mut().push("read");
            }
            Ok(read)
        }
    }

    #[test]
    fn decoding_is_interleaved_with_reading() {
        let mut bytes = b"time,value\n".to_vec();
        for row in 0..40_000 {
            bytes.extend_from_slice(format!("{row},{}\n", row * 2).as_bytes());
        }
        let log = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let reader = std::io::BufReader::with_capacity(
            8 * 1024,
            LoggingReader { inner: std::io::Cursor::new(bytes), log: std::rc::Rc::clone(&log) },
        );
        let cancel = CancelToken::default();
        let sink = std::rc::Rc::clone(&log);
        let mut progress = move |_: f64| sink.borrow_mut().push("progress");
        let mut context = DecodeContext { progress: &mut progress, cancel: &cancel };

        let decoded = CsvDecoder.decode_reader(reader, &mut context).unwrap();
        assert_eq!(decoded.row_count, 40_000);
        let entries = log.borrow();
        let first_progress = entries.iter().position(|entry| *entry == "progress").unwrap();
        let last_read = entries.iter().rposition(|entry| *entry == "read").unwrap();
        assert!(first_progress < last_read, "progress must fire before the last read");
    }

    #[test]
    fn cancellation_stops_a_long_decode() {
        let mut bytes = b"time,value\n".to_vec();
        for row in 0..40_000 {
            bytes.extend_from_slice(format!("{row},{row}\n").as_bytes());
        }
        let cancel = CancelToken::default();
        let mut progress = |_: f64| cancel.cancel();
        let mut context = DecodeContext { progress: &mut progress, cancel: &cancel };
        let error = CsvDecoder
            .decode_reader(std::io::BufReader::new(std::io::Cursor::new(bytes)), &mut context)
            .unwrap_err();
        assert!(matches!(error, IngestError::Cancelled));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core ingest::csv`
Expected: FAIL — `decode_reader` not found.

- [ ] **Step 3: Implement streaming decode**

Replace `filter_comment_lines` + `Cursor<Vec<u8>>` with a single pass:

```rust
impl CsvDecoder {
    /// Decodes from any reader, one record at a time. The only whole-file
    /// allocations are the value columns themselves.
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read or decoded.
    pub fn decode_reader<R: BufRead>(
        &self,
        mut reader: R,
        context: &mut DecodeContext<'_>,
    ) -> Result<DecodedSource, IngestError> {
        let probe = probe_first_data_line(&mut reader)?;
        let delimiter = detect_delimiter(&probe.line);
        let has_headers = detect_header(&probe.line, delimiter);
        let headers = if has_headers {
            split_probe(&probe.line, delimiter).into_iter().map(str::to_owned).collect::<Vec<_>>()
        } else {
            (1..=split_probe(&probe.line, delimiter).len()).map(|index| format!("col{index}")).collect()
        };
        if headers.len() < 2 {
            return Err(IngestError::TooFewColumns);
        }

        let mut csv_reader = ::csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .has_headers(false)
            .flexible(true)
            .comment(None)
            .trim(::csv::Trim::All)
            .from_reader(CommentFilter::new(probe.rest(has_headers), reader));

        let mut columns = vec![Vec::<f64>::new(); headers.len()];
        let mut record = ::csv::StringRecord::new();
        let mut rows = 0_usize;
        while csv_reader.read_record(&mut record)? {
            rows += 1;
            if rows % 4096 == 0 {
                context.check()?;
                context.report(fraction_of(&csv_reader, probe.total));
            }
            if record.len() < 2 {
                continue;
            }
            for (index, column) in columns.iter_mut().enumerate() {
                column.push(parse_cell(record.get(index)));
            }
        }
        context.check()?;
        context.report(1.0);
        finish(headers, columns)
    }
}
```

- `CommentFilter<R>` is a small `Read` adapter that drops blank lines and lines
  starting with `#`, `%`, or `;` while streaming, prefixed by the bytes the probe
  already consumed (`probe.rest(has_headers)` replays the probe line when it was
  data, not a header).
- `probe_first_data_line` reads only the first non-comment line and records the
  file length (`total`) when the reader is a file; otherwise `None` and progress
  reports only `0.0`/`1.0`.
- `finish` performs the existing time-column selection, computes **one** sort
  permutation, and applies it in place per column
  (`apply_permutation_in_place(&order, column)` using a scratch `Vec<f64>` reused
  across columns) instead of cloning each column.
- `decode` becomes
  `self.decode_reader(BufReader::new(File::open(path)?), context)`, with `total`
  taken from `File::metadata()`.

`apply_permutation` in `ingest/mod.rs` gains an in-place sibling:

```rust
pub(crate) fn apply_permutation_in_place(order: &[usize], column: &mut Vec<f64>, scratch: &mut Vec<f64>) {
    scratch.clear();
    scratch.extend(order.iter().map(|&index| column[index]));
    std::mem::swap(column, scratch);
}
```

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core ingest::`
Expected: PASS, including the existing comment/delimiter/time-sort tests.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest
git commit -m "feat(ingest): stream CSV decode and honor cancellation"
```

---

### Task 7: Decode provenance digest

**Files:**

- Create: `core/scope-core/src/ingest/provenance.rs`
- Modify: `core/scope-core/src/ingest/mod.rs`, `Cargo.toml`, `core/scope-core/Cargo.toml`

**Interfaces:**

- Produces: `ingest::provenance::{ProviderInfo, Fingerprint, fingerprint,
provenance_digest, CACHE_ABI_CSV, CACHE_ABI_MCAP, provider_for}`.
  `provenance_digest(&ProviderInfo, &Fingerprint, &[(&str, &str)]) -> String`
  (hex sha256). **Part B replaces `provider_for` with a registry lookup and
  changes nothing else.**

- [ ] **Step 1: Add the sha2 dependency**

Root `Cargo.toml`: `sha2 = "0.10"`; `core/scope-core/Cargo.toml`: `sha2.workspace = true`.

- [ ] **Step 2: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> ProviderInfo {
        ProviderInfo { id: "csv", cache_abi: CACHE_ABI_CSV }
    }

    #[test]
    fn the_digest_changes_with_every_input_that_changes_the_columns() {
        let base = Fingerprint { source_len: 10, mtime_ns: 20, head_crc: 30 };
        let digest = provenance_digest(&info(), &base, &[]);
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, provenance_digest(&info(), &base, &[]));

        let other_abi = ProviderInfo { id: "csv", cache_abi: CACHE_ABI_CSV + 1 };
        assert_ne!(digest, provenance_digest(&other_abi, &base, &[]));
        assert_ne!(digest, provenance_digest(&ProviderInfo { id: "mcap", cache_abi: CACHE_ABI_CSV }, &base, &[]));
        assert_ne!(digest, provenance_digest(&info(), &Fingerprint { source_len: 11, ..base }, &[]));
        assert_ne!(digest, provenance_digest(&info(), &base, &[("recipe", "abc")]));
    }

    #[test]
    fn option_encoding_cannot_be_confused_by_separators() {
        let base = Fingerprint { source_len: 1, mtime_ns: 1, head_crc: 1 };
        assert_ne!(
            provenance_digest(&info(), &base, &[("a", "b:c")]),
            provenance_digest(&info(), &base, &[("a:b", "c")])
        );
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test.sh core provenance`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement it**

```rust
//! What a decode depended on, hashed. A changed decoder, recipe, or option
//! must never reuse cached columns.

use std::{fs::File, io::Read, path::Path, time::UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Bump when a provider's decoded output changes for identical input.
pub const CACHE_ABI_CSV: u32 = 1;
pub const CACHE_ABI_MCAP: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub cache_abi: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fingerprint {
    pub source_len: u64,
    pub mtime_ns: u64,
    pub head_crc: u32,
}

const FINGERPRINT_HEAD_LEN: usize = 64 * 1024;

/// # Errors
///
/// Returns the underlying IO error when `source` cannot be read.
pub fn fingerprint(source: &Path) -> std::io::Result<Fingerprint> {
    let metadata = std::fs::metadata(source)?;
    let mtime_ns = metadata.modified()?.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX)
    });
    let mut head = Vec::with_capacity(FINGERPRINT_HEAD_LEN);
    File::open(source)?.take(FINGERPRINT_HEAD_LEN as u64).read_to_end(&mut head)?;
    Ok(Fingerprint { source_len: metadata.len(), mtime_ns, head_crc: crc32fast::hash(&head) })
}

/// Hex SHA-256 over every input that can change decoded columns. `options`
/// carries provider-specific entries (recipe digest, timebase choices); each
/// field is length-prefixed so no separator confusion is possible.
#[must_use]
pub fn provenance_digest(
    provider: &ProviderInfo,
    fingerprint: &Fingerprint,
    options: &[(&str, &str)],
) -> String {
    let mut hasher = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    field(b"scope-provenance-1");
    field(provider.id.as_bytes());
    field(&provider.cache_abi.to_le_bytes());
    field(&fingerprint.source_len.to_le_bytes());
    field(&fingerprint.mtime_ns.to_le_bytes());
    field(&fingerprint.head_crc.to_le_bytes());
    for (name, value) in options {
        field(name.as_bytes());
        field(value.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}
```

Add `provider_for(format: SourceFormat) -> ProviderInfo` in `ingest/mod.rs`
mapping `Csv → { id: "csv", cache_abi: CACHE_ABI_CSV }` and
`Mcap → { id: "mcap", cache_abi: CACHE_ABI_MCAP }`, and make `sniff_format`
`pub(crate)`.

`field` closure borrows `hasher` mutably while `hasher.finalize()` is called
after — restructure as a helper `fn field(hasher: &mut Sha256, bytes: &[u8])`
to satisfy the borrow checker.

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh core provenance`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core
git commit -m "feat(ingest): hash decode provenance for cache keying"
```

---

### Task 8: Key the sidecar cache by provenance

**Files:**

- Modify: `core/scope-core/src/cache.rs`

**Interfaces:**

- Consumes: `provenance::{ProviderInfo, fingerprint, provenance_digest}`,
  `ingest::{DecodedSource, DecodeContext, commit}`, `sources::SourceRecord`.
- Produces: `cache::ingest_or_load(source, store, key, prefix, context) ->
Result<IngestOutcome, CacheError>` where `IngestOutcome` gains
  `provider_id: String` and `provenance: String`; `CACHE_VERSION = 3`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_changed_cache_abi_invalidates_the_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let mut store = SignalStore::new();
        let outcome = load(&source, &mut store).expect("first ingest");
        assert_eq!(outcome.provider_id, "csv");
        assert_eq!(outcome.provenance.len(), 64);

        // Rewrite the stored provenance to simulate a decoder change.
        let path = sidecar_path(&source);
        let bytes = std::fs::read(&path).unwrap();
        let poisoned = String::from_utf8_lossy(&bytes).replace(&outcome.provenance, &"0".repeat(64));
        std::fs::write(&path, poisoned.as_bytes()).unwrap();

        let mut fresh = SignalStore::new();
        let reloaded = load(&source, &mut fresh).expect("second ingest");
        assert_eq!(reloaded.provenance, outcome.provenance, "a miss rebuilds and rewrites");
    }
```

with a `load` helper that mints a key and prefix and calls `ingest_or_load`.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core cache::`
Expected: FAIL — `ingest_or_load` arity, `IngestOutcome::provider_id` missing.

- [ ] **Step 3: Implement it**

- `CACHE_VERSION` → `3`; the 20-byte fingerprint block in the header is replaced
  by a 32-byte raw SHA-256 provenance digest; `HEADER_LEN` becomes `52`.
- `parse` compares the stored digest against the digest recomputed from the
  provider and the current file fingerprint; any mismatch is a miss.
- `try_load` registers through `commit` using the caller's key/prefix and stores
  `local_path` (not the display path) in `CacheSignal`, so a relocated or
  re-prefixed source reuses its sidecar.
- `ingest_or_load` gains `key: SourceKey, prefix: &str` and threads
  `DecodeContext`; it returns the provider id and digest so the caller can record
  them on the `SourceRecord`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core cache::`
Expected: PASS, including the existing corrupt/truncated/version misses.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/cache.rs
git commit -m "feat(cache): key sidecars by decode provenance"
```

---

### Task 9: Memory-weighted admission

**Files:**

- Create: `core/scope-core/src/ingest/admission.rs`
- Modify: `core/scope-core/src/ingest/mod.rs`

**Interfaces:**

- Produces: `admission::{MemoryBudget, BudgetConfig, Ticket, BudgetError,
estimate_working_bytes}`; `MemoryBudget::acquire_working(bytes) ->
Result<Ticket, BudgetError>` (blocks until free or fails when the request
  exceeds the whole allowance); `Ticket::reconcile(actual)`;
  `Ticket::transfer_to_resident() -> Result<ResidentCharge, BudgetError>`;
  `ResidentCharge` releases on drop (unload).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn budget() -> MemoryBudget {
        MemoryBudget::new(BudgetConfig { working_bytes: 1_000, resident_bytes: 1_500 })
    }

    #[test]
    fn a_request_larger_than_the_whole_allowance_fails_instead_of_deadlocking() {
        assert!(matches!(budget().acquire_working(2_000), Err(BudgetError::TooLarge { .. })));
    }

    #[test]
    fn reconciling_upward_beyond_the_allowance_fails_before_commit() {
        let budget = budget();
        let mut ticket = budget.acquire_working(400).unwrap();
        assert!(ticket.reconcile(900).is_ok());
        assert!(matches!(ticket.reconcile(2_000), Err(BudgetError::TooLarge { .. })));
    }

    #[test]
    fn committing_moves_the_charge_from_working_to_resident_until_unload() {
        let budget = budget();
        let ticket = budget.acquire_working(600).unwrap();
        assert_eq!(budget.working_used(), 600);
        let charge = ticket.transfer_to_resident().unwrap();
        assert_eq!(budget.working_used(), 0);
        assert_eq!(budget.resident_used(), 600);
        drop(charge);
        assert_eq!(budget.resident_used(), 0);
    }

    #[test]
    fn a_second_file_waits_for_the_first_to_release() {
        let budget = std::sync::Arc::new(budget());
        let held = budget.acquire_working(800).unwrap();
        let waiter = std::thread::spawn({
            let budget = std::sync::Arc::clone(&budget);
            move || budget.acquire_working(800).map(|ticket| ticket.bytes())
        });
        std::thread::yield_now();
        drop(held);
        assert_eq!(waiter.join().unwrap().unwrap(), 800);
    }

    #[test]
    fn estimates_cover_the_file_columns_sort_copy_and_bins() {
        // 1 MiB file, 4 columns: bytes + one sort copy + ~15 bytes of bin per sample.
        assert!(estimate_working_bytes(1_048_576, 4) > 1_048_576 * 2);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core admission`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`MemoryBudget` wraps `Mutex<Usage> + Condvar`. `Usage { working, resident }`.
`acquire_working` returns `BudgetError::TooLarge { requested, allowance }` when
`bytes > config.working_bytes`, otherwise waits on the condvar until
`working + bytes <= working_bytes`. `Ticket` holds `Arc<MemoryBudget>` and its
charge; `Drop` subtracts and notifies. `reconcile` adjusts the charge, waiting
for headroom on growth and failing when the new size exceeds the allowance.
`transfer_to_resident` fails with `BudgetError::ResidentFull` when the resident
allowance cannot take the charge — the batch reports a resource-budget error for
that file **before** commit.

`estimate_working_bytes(file_len: u64, column_count: usize) -> usize` =
`file_len` (decode buffer + parsed columns, conservative) + one sort copy
(`file_len`) + `BIN_BYTES_PER_SAMPLE (=16)` × estimated samples, where samples
are estimated as `file_len / (column_count.max(1) * AVERAGE_CELL_BYTES (=8))`.

Defaults derive from available memory with conservative caps:
`BudgetConfig::from_available(total_bytes)` → working = `min(total/8, 4 GiB)`,
resident = `min(total/2, 32 GiB)`; users lower them through preferences in
Task 33.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core admission`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest
git commit -m "feat(ingest): add memory-weighted admission budgets"
```

---

### Task 10: Batch job state machine

**Files:**

- Create: `core/scope-core/src/ingest/batch.rs` (state only; Task 11 adds the executor)

**Interfaces:**

- Produces: `batch::{JobId, BatchState, BatchStatus, FileState, FileFailure,
BatchProgress}`; `BatchProgress::new(paths)`, `::started(index)`,
  `::succeeded(index)`, `::failed(index, error)`, `::cancel()`, `::status()`,
  `::detail(offset, limit)`, `::is_terminal()`. Task 11 and the shell consume it.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn paths(count: usize) -> Vec<std::path::PathBuf> {
        (0..count).map(|index| std::path::PathBuf::from(format!("/run{index}.csv"))).collect()
    }

    #[test]
    fn mixed_outcomes_end_partial_and_keep_committed_files() {
        let progress = BatchProgress::new(paths(3));
        progress.succeeded(0);
        progress.failed(1, "unsupported".into());
        progress.succeeded(2);

        let status = progress.status();
        assert_eq!(status.state, BatchState::Partial);
        assert_eq!((status.done, status.failed), (2, 1));
        assert!((status.fraction - 1.0).abs() < f64::EPSILON);
        assert_eq!(status.recent_failures.len(), 1);
        assert_eq!(status.recent_failures[0].path, std::path::PathBuf::from("/run1.csv"));
    }

    #[test]
    fn every_file_failing_is_failed_and_none_is_done() {
        let progress = BatchProgress::new(paths(2));
        progress.failed(0, "a".into());
        progress.failed(1, "b".into());
        assert_eq!(progress.status().state, BatchState::Failed);

        let clean = BatchProgress::new(paths(2));
        clean.succeeded(0);
        clean.succeeded(1);
        assert_eq!(clean.status().state, BatchState::Done);
    }

    #[test]
    fn cancelling_is_terminal_once_in_flight_files_settle() {
        let progress = BatchProgress::new(paths(3));
        progress.succeeded(0);
        progress.cancel();
        assert_eq!(progress.status().state, BatchState::Running, "one file is still in flight");
        progress.cancelled(1);
        progress.cancelled(2);
        assert_eq!(progress.status().state, BatchState::Cancelled);
        assert_eq!(progress.status().done, 1, "committed files stay registered");
    }

    #[test]
    fn status_is_aggregate_and_detail_is_paged() {
        let progress = BatchProgress::new(paths(1_000));
        for index in 0..1_000 {
            progress.failed(index, format!("error {index}"));
        }
        let status = progress.status();
        assert!(status.recent_failures.len() <= RECENT_FAILURE_LIMIT);
        let detail = progress.detail(990, 20);
        assert_eq!(detail.entries.len(), 10);
        assert_eq!(detail.total, 1_000);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core batch::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the state machine**

`BatchProgress` wraps `Mutex<Inner>`; `Inner { entries: Vec<FileEntry>,
cancelled: bool }`, `FileEntry { path, state: FileState, error: Option<String> }`,
`FileState::{Pending, Running, Done, Failed, Cancelled}`. `status()` derives:

- `Running` while any entry is `Pending`/`Running`;
- otherwise `Cancelled` if `cancelled` and any entry is `Cancelled`;
- otherwise `Failed` when every entry failed, `Done` when every entry succeeded,
  `Partial` when both occur.

`fraction` = settled entries / total. `recent_failures` keeps the last
`RECENT_FAILURE_LIMIT = 16` failures — never a thousand-entry array in a poll.
`detail(offset, limit)` clamps and returns `BatchDetail { entries, total }`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core batch::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/batch.rs core/scope-core/src/ingest/mod.rs
git commit -m "feat(ingest): add the batch job state machine"
```

---

### Task 11: Batch executor with off-lock decode

**Files:**

- Modify: `core/scope-core/src/ingest/batch.rs`

**Interfaces:**

- Consumes: `SourceRegistry`, `MemoryBudget`, `cache::ingest_or_load`,
  `CancelToken`, `BatchProgress`.
- Produces: `batch::{CommitSink, BatchOptions, BatchJobs}`;
  `BatchJobs::submit(paths, sink) -> JobId`; `::status(JobId)`,
  `::detail(JobId, offset, limit)`, `::cancel(JobId)`, `::release(JobId)`,
  `::sweep_terminal(now)`. The shell (Task 13) implements `CommitSink`.

- [ ] **Step 1: Write the failing test**

```rust
    #[derive(Default)]
    struct RecordingSink {
        store: std::sync::Mutex<SignalStore>,
        max_concurrent_commits: std::sync::atomic::AtomicUsize,
        in_commit: std::sync::atomic::AtomicUsize,
    }

    impl CommitSink for RecordingSink {
        fn commit(&self, record: &SourceRecord, decoded: DecodedSource) -> Result<IngestSummary, IngestError> {
            let depth = self.in_commit.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_concurrent_commits.fetch_max(depth, Ordering::SeqCst);
            let mut store = self.store.lock().expect("store lock");
            let result = commit(&mut store, record.key, &record.prefix, &record.path, decoded);
            self.in_commit.fetch_sub(1, Ordering::SeqCst);
            result
        }
    }

    #[test]
    fn one_bad_file_does_not_abort_the_batch() {
        let dir = tempfile::tempdir().unwrap();
        let good: Vec<_> = (0..8).map(|index| write_csv(&dir, index)).collect();
        let bad = dir.path().join("bad.csv");
        std::fs::write(&bad, "").unwrap();
        let mut paths = good.clone();
        paths.insert(4, bad);

        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        let job = jobs.submit(paths, std::sync::Arc::clone(&sink) as std::sync::Arc<dyn CommitSink>);
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.state, BatchState::Partial);
        assert_eq!((status.done, status.failed), (8, 1));
        assert_eq!(sink.store.lock().unwrap().sources().count(), 8);
    }

    #[test]
    fn duplicate_paths_in_one_batch_join_a_single_flight() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_csv(&dir, 0);
        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions::for_tests());
        let job = jobs.submit(vec![path.clone(), path.clone(), path], std::sync::Arc::clone(&sink) as _);
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.done, 3, "every requested path reports done");
        assert_eq!(sink.store.lock().unwrap().sources().count(), 1, "committed once");
    }

    #[test]
    fn cancelling_stops_admissions_and_keeps_committed_files() {
        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..64).map(|index| write_csv(&dir, index)).collect();
        let sink = std::sync::Arc::new(RecordingSink::default());
        let jobs = BatchJobs::new(BatchOptions { worker_count: 1, ..BatchOptions::for_tests() });
        let job = jobs.submit(paths, std::sync::Arc::clone(&sink) as _);
        jobs.cancel(job);
        let status = jobs.wait_for_tests(job);

        assert_eq!(status.state, BatchState::Cancelled);
        assert!(status.done < 64);
        assert_eq!(sink.store.lock().unwrap().sources().count(), status.done as usize);
    }

    #[test]
    fn terminal_jobs_expire_and_can_be_released_early() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = BatchJobs::new(BatchOptions { terminal_ttl: Duration::from_secs(0), ..BatchOptions::for_tests() });
        let job = jobs.submit(vec![write_csv(&dir, 0)], std::sync::Arc::new(RecordingSink::default()) as _);
        jobs.wait_for_tests(job);
        jobs.sweep_terminal(Instant::now());
        assert!(jobs.status(job).is_none());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core batch::`
Expected: FAIL — `BatchJobs` not found.

- [ ] **Step 3: Implement the executor**

```rust
/// Where decoded columns land. Implemented by the host so `scope-core` never
/// holds the shell's combined store/pyramid state.
pub trait CommitSink: Send + Sync {
    /// # Errors
    ///
    /// Returns [`IngestError`] when registration fails; the store must be
    /// unchanged in that case.
    fn commit(&self, record: &SourceRecord, decoded: DecodedSource) -> Result<IngestSummary, IngestError>;
}

pub struct BatchOptions {
    pub worker_count: usize,
    pub budget: Arc<MemoryBudget>,
    pub terminal_ttl: Duration,
}
```

`BatchJobs` owns `Mutex<BTreeMap<JobId, Job>>` where
`Job { progress: Arc<BatchProgress>, cancel: Arc<CancelToken>, registry: Arc<Mutex<SourceRegistry>>,
finished_at: Option<Instant>, handles: Vec<JoinHandle<()>> }`, plus a shared
`Mutex<BTreeMap<PathBuf, Arc<SingleFlight>>>` for cross-batch deduplication.

`submit` pre-assigns identity for every path **before** any worker starts
(`registry.admit`), so prefixes are stable and known up front. Work items are
`(index, PathBuf, Admission)` in an `Arc<Mutex<VecDeque<_>>>`. `worker_count`
threads run:

1. `if cancel.is_cancelled() { progress.cancelled(index); continue; }`
2. Join the single flight for the canonical path; the follower waits and then
   reports the leader's outcome for its own index (no second commit).
3. `let ticket = budget.acquire_working(estimate_working_bytes(len, columns))?`
   — a `BudgetError` fails just this file.
4. `cache::ingest_or_load(...)` with a `DecodeContext` bound to the job's cancel
   token — decode and pyramid build happen with **no** store lock held.
5. `ticket.reconcile(decoded.column_bytes() + pyramid_bytes)?`
6. `let charge = ticket.transfer_to_resident()?` then `sink.commit(...)` — the
   only step that takes the store lock, and only for one file.
7. `registry.set_provenance(key, provider_id, digest)`; `progress.succeeded(index)`
   (or `failed` with the error string; `IngestError::Cancelled` maps to
   `progress.cancelled(index)`).

Queue capacity is `min(worker_count, paths.len())` so nothing large sits in a
channel. `wait_for_tests(job)` joins the handles and returns the final status
(`#[cfg(test)]` plus `pub(crate)` for the shell's own tests — expose it as
`join(job)` and use it in production for `scope-bake`).

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core batch::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/batch.rs
git commit -m "feat(ingest): run batch jobs with off-lock decode and per-file failure"
```

---

### Task 12: Protocol v9 — batch shapes and identity fields

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Regenerate: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`
- Modify: `frontend/src/app/{data-plane,baked-session}.ts`, `core/scope-core/src/snapshot.rs`

**Interfaces:**

- Produces: `IngestBatchRequest { paths: string[] }`, `BatchJob { job_id: u64 }`,
  `BatchState` enum `["running","done","partial","failed","cancelled"]`,
  `BatchFailure { path, error }`,
  `BatchStatus { state, fraction, total: u64, done: u64, failed: u64, recent_failures: BatchFailure[] }`,
  `BatchDetailRequest { job_id, offset: u32, limit: u32 }`,
  `BatchFileStatus { path, state: FileState, error: string? }`,
  `BatchDetail { entries: BatchFileStatus[], total: u64 }`,
  `FormatDescriptor { id, label, extensions: string[] }`;
  `SignalSummary` += `source_id: u64`, `source_key: string`, `local_path: string`;
  `SourceSummary` += `source_key: string`, `prefix: string`. Removes
  `IngestRequest`, `IngestResponse`, `IngestJob`, `IngestState`, `IngestStatus`.

- [ ] **Step 1: Write the failing test**

`frontend/src/app/data-plane.test.ts`:

```ts
it("keeps wire u64 identity fields as strings", async () => {
  const plane = new TauriPlane(fakeInvoke);
  const [signal] = await plane.listSignals();
  expect(typeof signal.signal_id).toBe("string");
  expect(typeof signal.source_id).toBe("string");
  expect(signal.source_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(signal.path).toBe(`${signal.local_path ? "" : ""}${signal.path}`);
});

it("starts a batch and reports aggregate progress", async () => {
  const plane = new TauriPlane(fakeInvoke);
  const jobId = await plane.ingest.startBatch(["/a.csv", "/b.csv"]);
  const status = await plane.ingest.batchStatus(jobId);
  expect(status.total).toBe("2");
  expect(status.recent_failures).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit data-plane`
Expected: FAIL — `startBatch` is not a function.

- [ ] **Step 3: Edit the schema and regenerate**

Set `"protocol_version": 9`, add the types above, delete the four removed ones.
Then:

```bash
./scripts/codegen.sh
```

Update `TauriPlane.ingest` to `{ pickSources, startBatch, batchStatus,
batchDetail, cancelBatch, releaseBatch, listFormats }`, update `BakedPlane`'s
`listSignals`/`listSources` and `createDemoManifest` to fill the new required
fields (`source_id: "0"`, `source_key: "00000000-0000-0000-0000-000000000000"`,
`local_path` = the path after the first segment, `prefix` = first segment), and
extend `baked-session.ts`'s validation accordingly. `snapshot.rs`'s
`signal_summary` construction gains the three fields.

- [ ] **Step 4: Run the checks**

Run: `./scripts/test.sh unit data-plane` then `./scripts/test.sh frontend`
Expected: PASS, `pnpm codegen:check` clean.

- [ ] **Step 5: Commit**

```bash
git add protocol frontend/src core/scope-core/src/snapshot.rs
git commit -m "feat(protocol): v9 batch ingest jobs and durable identity fields"
```

---

### Task 13: Shell batch commands

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `batch::{BatchJobs, CommitSink, BatchOptions}`, `SourceRegistry`.
- Produces: Tauri commands `ingest_batch`, `batch_status`, `batch_detail`,
  `cancel_batch`, `release_batch`, `list_formats`; `DataState` gains
  `registry: SourceRegistry`; `ShellCommitSink` implements `CommitSink` by
  committing into `Mutex<DataState>` and inserting pyramids.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn the_commit_sink_registers_signals_and_their_pyramids_together() {
        let state = Arc::new(Mutex::new(DataState::default()));
        let sink = ShellCommitSink { state: Arc::clone(&state) };
        let record = SourceRecord {
            key: SourceKey(uuid::Uuid::from_bytes([3; 16])),
            path: PathBuf::from("/a/run.csv"),
            prefix: "run".into(),
            provider_id: None,
            decode_provenance: None,
            reconcile_legacy: false,
        };
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0, 2.0, 3.0]);
        let decoded = DecodedSource {
            row_count: 4,
            signals: vec![DecodedSignal {
                local_path: "imu/ax".into(),
                unit: None,
                time,
                values: Arc::from(vec![1.0, 2.0, 3.0, 4.0]),
            }],
        };

        let summary = sink.commit(&record, decoded).expect("commit");
        let data = state.lock().unwrap();
        assert_eq!(data.store.signal_by_path("run/imu/ax").unwrap().len(), 4);
        assert!(data.pyramids.contains_key(&summary.signals[0]));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh shell commit_sink`
Expected: FAIL — `ShellCommitSink` not found.

- [ ] **Step 3: Implement the commands**

`DataState` gains `registry: SourceRegistry`. `ShellCommitSink { state:
Arc<Mutex<DataState>> }` locks once, calls `ingest::commit`, then builds and
inserts pyramids for the new signals inside the same lock (pyramid _build_ for
the cache path already happened off-lock inside `cache::ingest_or_load`; the
sink stores what it was handed — extend `CommitSink::commit` to take
`pyramids: Vec<(String, Pyramid)>` keyed by `local_path` so no rebuild happens
under the lock).

```rust
#[tauri::command]
fn ingest_batch(
    request: Envelope<IngestBatchRequest>,
    app: AppHandle,
    jobs: State<'_, BatchJobs>,
) -> Result<Envelope<BatchJob>, String> { … }
```

`batch_status` returns the aggregate `BatchStatus`; `batch_detail` pages;
`cancel_batch`/`release_batch` call through; `list_formats` maps
`SUPPORTED_FORMATS` into `FormatDescriptor`s (Part B repoints this at the
registry). Delete `ingest_source`, `ingest_status`, `run_ingest_job`,
`last_progress`, `ingest_with_cache`, and the `IngestJobs` state. `pick_sources`
keeps using `SUPPORTED_FORMATS` and additionally allows picking directories,
expanding them to their supported files in the shell (the spec puts glob and
directory expansion in the shell, not core).

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src-tauri/src/lib.rs
git commit -m "feat(shell): expose batch ingest, cancellation, and format listing"
```

---

### Task 14: Session v11 — durable source records

**Files:**

- Modify: `protocol/schema/scope-session.json`, `core/scope-core/src/session.rs`
- Regenerate: `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`
- Modify: `protocol/testdata/session-conformance.json`, `frontend/src/app/{workspace,history,baked-session}.ts`

**Interfaces:**

- Consumes: `naming::{legacy_source_key, allocate_prefix}`.
- Produces: session schema 11 with
  `SourceRecord { key: string, path: string, prefix: string, provider_id: string?,
decode_provenance: string?, reconcile_legacy: bool }` and
  `Session.sources: SourceRecord[]` replacing `source_paths`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn v10_source_paths_migrate_to_deterministic_keyed_records() {
        let json = serde_json::json!({
            "app": "signalscope", "schema_version": 10, "theme": "dark",
            "linked_time": {"t0": 0.0, "t1": 1.0, "linked": true, "paused": false, "cursorT": null, "mode": "fixed"},
            "active_tab_id": "workspace-1", "favorites": [], "derived": [],
            "source_paths": ["/data/run.csv", "/other/run.csv"],
            "tabs": [{"id": "workspace-1", "title": "Workspace 1", "cursor_mode": "none",
                      "focused_panel_id": null, "maximized_panel_id": null, "layout": [], "panels": []}]
        }).to_string();

        let session = from_json(&json).expect("v10 migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert_eq!(session.sources.len(), 2);
        assert_eq!(session.sources[0].key, crate::naming::legacy_source_key("/data/run.csv").to_string());
        assert_eq!(session.sources[0].prefix, "run");
        assert!(session.sources[1].prefix.starts_with("run_"));
        assert!(session.sources.iter().all(|record| record.reconcile_legacy));
        assert!(session.sources.iter().all(|record| record.provider_id.is_none()));

        // Deterministic across machines and repeat runs.
        assert_eq!(from_json(&json).unwrap().sources, session.sources);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core session::`
Expected: FAIL — `Session` has no field `sources`.

- [ ] **Step 3: Bump the schema, regenerate, add the rung**

Schema: `"schema_version": 11`, add `SourceRecord`, replace `source_paths` with
`"sources": "SourceRecord[]"`. Run `./scripts/codegen.sh`. Then:

```rust
        10 => {
            let paths = value
                .get("source_paths")
                .and_then(serde_json::Value::as_array)
                .map(|entries| entries.iter().filter_map(|entry| entry.as_str().map(str::to_owned)).collect())
                .unwrap_or_else(Vec::new);
            let mut taken = std::collections::BTreeSet::new();
            let mut records = Vec::with_capacity(paths.len());
            for path in paths {
                let key = crate::naming::legacy_source_key(&path);
                let prefix = crate::naming::allocate_prefix(&taken, std::path::Path::new(&path), key)
                    .unwrap_or_else(|| key.simple().to_string());
                taken.insert(prefix.clone());
                records.push(serde_json::json!({
                    "key": key.to_string(),
                    "path": path,
                    "prefix": prefix,
                    "provider_id": null,
                    "decode_provenance": null,
                    "reconcile_legacy": true
                }));
            }
            if let Some(object) = value.as_object_mut() {
                object.remove("source_paths");
                object.insert("sources".into(), serde_json::Value::Array(records));
            }
            value["schema_version"] = serde_json::json!(11);
            migrate(11, value)
        }
```

Update `Session::default()`, the conformance fixture
(`REGENERATE_FIXTURES=1 ./scripts/test.sh core session_conformance`), the
frontend `WorkspaceModel` (`sources()`, `addSource(record)`,
`removeSource(key)`), `history.ts`, and `baked-session.ts`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core session::` then `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core/scope-core/src/session.rs core/scope-core/src/session frontend/src
git commit -m "feat(session): v11 durable source records with deterministic legacy keys"
```

---

### Task 15: Reference rewriting in expressions

**Files:**

- Modify: `core/scope-core/src/expr.rs`

**Interfaces:**

- Produces: `expr::rename_references(src: &str, map: &BTreeMap<String, String>)
-> Result<String, ExprError>`. Task 16 consumes it.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn renaming_rewrites_only_signal_literals() {
        let map = BTreeMap::from([
            ("imu/ax".to_owned(), "run_a/imu/ax".to_owned()),
            ("imu/ay".to_owned(), "run_a/imu/ay".to_owned()),
        ]);
        let renamed = rename_references("hypot('imu/ax', 'imu/ay') + 2 * 'imu/az'", &map).unwrap();
        assert_eq!(renamed, "hypot('run_a/imu/ax', 'run_a/imu/ay') + 2 * 'imu/az'");
        assert_eq!(references(&parse(&renamed).unwrap()).len(), 3);
    }

    #[test]
    fn renaming_never_touches_lookalike_text() {
        // A function name or number that merely contains the old path text is untouched.
        let map = BTreeMap::from([("a".to_owned(), "run/a".to_owned())]);
        assert_eq!(rename_references("abs('a') + 1", &map).unwrap(), "abs('run/a') + 1");
    }

    #[test]
    fn quotes_inside_a_name_survive_a_round_trip() {
        let map = BTreeMap::from([("it's".to_owned(), "run/it's".to_owned())]);
        let renamed = rename_references("'it''s'", &map).unwrap();
        assert_eq!(references(&parse(&renamed).unwrap()), vec!["run/it's".to_owned()]);
    }

    #[test]
    fn an_unparseable_expression_is_rejected_rather_than_half_rewritten() {
        assert!(rename_references("'a' +", &BTreeMap::new()).is_err());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core expr::`
Expected: FAIL — `rename_references` not found.

- [ ] **Step 3: Implement it**

```rust
/// Rewrites signal literals through `map`, using the lexer's spans rather than
/// text substitution: only `Token::Signal` spans are replaced, so identifiers,
/// numbers, and lookalike text are untouched.
///
/// # Errors
///
/// Returns [`ExprError`] when `src` does not tokenize or parse; the caller
/// gets all-or-nothing rewriting.
pub fn rename_references(src: &str, map: &BTreeMap<String, String>) -> Result<String, ExprError> {
    parse(src)?;
    let tokens = tokenize(src)?;
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0;
    for spanned in &tokens {
        let Token::Signal(name) = &spanned.token else { continue };
        let Some(replacement) = map.get(name) else { continue };
        out.push_str(&src[cursor..spanned.start]);
        out.push('\'');
        out.push_str(&replacement.replace('\'', "''"));
        out.push('\'');
        cursor = spanned.end;
    }
    out.push_str(&src[cursor..]);
    Ok(out)
}
```

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core expr::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/expr.rs
git commit -m "feat(expr): rewrite signal references from lexer spans"
```

---

### Task 16: Restore reconciliation service

**Files:**

- Create: `core/scope-core/src/restore.rs`
- Modify: `core/scope-core/src/lib.rs`

**Interfaces:**

- Consumes: `session::Session`, `sources::SourceRecord`, `expr::rename_references`.
- Produces: `restore::{legacy_aliases, reconcile, ReconcileOutcome,
AliasConflict, LegacyNaming}`;
  `legacy_aliases(provider_id, record, local_paths) -> BTreeMap<String, String>`;
  `reconcile(&mut Session, &BTreeMap<String, String>, &BTreeSet<SourceKey>) -> Result<ReconcileOutcome, ReconcileError>`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn session_with(path: &str, expr: &str) -> Session {
        let mut session = Session::default();
        session.favorites = vec![path.to_owned()];
        session.derived = vec![DerivedSignal { path: "derived/speed".into(), expr: expr.into() }];
        session.tabs[0].panels.push(PanelState {
            id: "panel-a".into(), title: "A".into(), mode: PanelMode::Time,
            axis_style: AxisStyle::Gutter, x_signal: Some(path.to_owned()),
            color_signal: Some(path.to_owned()), color_by_time: false,
            series: vec![SeriesState { path: path.to_owned(), color_slot: 1, dash: DashStyle::Solid, width: 1.0, visible: true }],
            y_range: None, x_range: None, x_label: None, y_label: None, c_label: None, time_window: None,
            annotations: vec![Annotation { id: "ann".into(), series_path: path.to_owned(),
                domain: AnnotationDomain::Time, anchor: 0.0, pinned_value: 0.0, label: "x".into() }],
            show_stats: false,
        });
        session
    }

    #[test]
    fn mcap_bare_paths_are_rewritten_everywhere_at_once() {
        let mut session = session_with("vehicle/imu/ax", "'vehicle/imu/ax' * 2");
        let aliases = BTreeMap::from([("vehicle/imu/ax".to_owned(), "run_a/vehicle/imu/ax".to_owned())]);

        let outcome = reconcile(&mut session, &aliases, &BTreeSet::new()).unwrap();
        assert_eq!(outcome.rewritten, 5);
        let panel = &session.tabs[0].panels[0];
        assert_eq!(panel.series[0].path, "run_a/vehicle/imu/ax");
        assert_eq!(panel.x_signal.as_deref(), Some("run_a/vehicle/imu/ax"));
        assert_eq!(panel.color_signal.as_deref(), Some("run_a/vehicle/imu/ax"));
        assert_eq!(panel.annotations[0].series_path, "run_a/vehicle/imu/ax");
        assert_eq!(session.favorites, ["run_a/vehicle/imu/ax"]);
        assert_eq!(session.derived[0].expr, "'run_a/vehicle/imu/ax' * 2");
    }

    #[test]
    fn an_alias_claimed_by_two_sources_rewrites_nothing_and_is_reported() {
        let mut left = BTreeMap::new();
        let mut conflicts = AliasBuilder::default();
        conflicts.add(SourceKey(uuid::Uuid::from_bytes([1; 16])), "imu/ax".into(), "run_a/imu/ax".into());
        conflicts.add(SourceKey(uuid::Uuid::from_bytes([2; 16])), "imu/ax".into(), "run_b/imu/ax".into());
        let built = conflicts.build();
        left.extend(built.aliases.clone());

        assert!(built.aliases.is_empty());
        assert_eq!(built.conflicts.len(), 1);
        assert_eq!(built.conflicts[0].legacy_path, "imu/ax");

        let mut session = session_with("imu/ax", "'imu/ax'");
        let outcome = reconcile(&mut session, &left, &BTreeSet::new()).unwrap();
        assert_eq!(outcome.rewritten, 0);
        assert_eq!(session.favorites, ["imu/ax"], "references stay legacy until resolved");
    }

    #[test]
    fn an_unparseable_derived_expression_aborts_the_whole_rewrite() {
        let mut session = session_with("imu/ax", "'imu/ax' +");
        let before = session.clone();
        let aliases = BTreeMap::from([("imu/ax".to_owned(), "run/imu/ax".to_owned())]);
        assert!(reconcile(&mut session, &aliases, &BTreeSet::new()).is_err());
        assert_eq!(session, before, "no partial rewrite");
    }

    #[test]
    fn a_missing_source_keeps_its_marker_for_a_later_retry() {
        let mut session = session_with("imu/ax", "'imu/ax'");
        session.sources.push(record_json("imu-key", true));
        let missing = BTreeSet::from([SourceKey(uuid::Uuid::from_bytes([9; 16]))]);
        let outcome = reconcile(&mut session, &BTreeMap::new(), &missing).unwrap();
        assert_eq!(outcome.unresolved.len(), 1);
        assert!(session.sources[0].reconcile_legacy);
    }

    #[test]
    fn csv_legacy_names_prepend_the_normalized_stem() {
        let record = SourceRecord { /* path /data/Flight Test.csv, prefix run_a */ };
        let aliases = legacy_aliases("csv", &record, &["imu/ax".to_owned()]);
        assert_eq!(aliases["flight_test/imu/ax"], "run_a/imu/ax");

        let mcap = legacy_aliases("mcap", &record, &["vehicle/imu/ax".to_owned()]);
        assert_eq!(mcap["vehicle/imu/ax"], "run_a/vehicle/imu/ax");
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core restore::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

```rust
//! Application service that finishes a legacy restore: re-ingest determines
//! each provider's old naming rule, and this module rewrites every durable
//! reference exactly once. Amends the restore-order consequence of ADR 0022.
//!
//! `session`, `store`, `ingest`, and `expr` do not depend on this module.
```

- `LegacyNaming` maps a provider id to its pre-v11 display rule:
  `"csv" => format!("{stem}/{local}")` using `naming::default_prefix(&record.path)`;
  `"mcap" => local.to_owned()`. An unknown provider yields no aliases (nothing
  is rewritten, and the record keeps its marker).
- `AliasBuilder` accumulates `legacy -> (key, new)` and, on `build()`, drops
  every legacy path claimed by more than one key into
  `conflicts: Vec<AliasConflict { legacy_path, claimants: Vec<SourceKey> }>`.
- `reconcile` clones the session, rewrites `favorites`, every panel's
  `series[].path`, `x_signal`, `color_signal`, `annotations[].series_path`, and
  each `derived[].expr` through `expr::rename_references`. Any error aborts
  before the clone is swapped in — the caller sees an unchanged session. On
  success it clears `reconcile_legacy` for every key that produced aliases,
  leaves it set for `missing`, and returns
  `ReconcileOutcome { rewritten, conflicts, unresolved }`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core restore::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/restore.rs core/scope-core/src/lib.rs
git commit -m "feat(core): reconcile legacy signal references after restore"
```

---

### Task 17: Shell restore stage and autosave pause

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`, `protocol/schema/scope-protocol.json`
- Regenerate: protocol outputs

**Interfaces:**

- Produces: commands `restore_sources` (submits a batch for a session's
  `sources`, returns a `BatchJob`) and `restore_reconcile`
  (`RestoreReconcileRequest { session_json, job_id }` →
  `RestoreReconcileResponse { session_json, rewritten: u64, conflicts: AliasConflictSummary[], unresolved: string[] }`);
  `save_session` rejects autosave writes while a restore is in flight with the
  exact message `"restore in progress"`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn autosave_is_refused_until_the_restore_stage_settles() {
        let gate = RestoreGate::default();
        gate.begin();
        assert!(gate.autosave_allowed().is_err());
        gate.settle();
        assert!(gate.autosave_allowed().is_ok());
    }

    #[test]
    fn a_named_save_is_never_blocked_by_a_restore() {
        let gate = RestoreGate::default();
        gate.begin();
        assert!(gate.named_save_allowed().is_ok());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh shell restore_gate`
Expected: FAIL — `RestoreGate` not found.

- [ ] **Step 3: Implement it**

`RestoreGate(AtomicUsize)` counts in-flight restores; `autosave_allowed`
returns `Err("restore in progress")` while non-zero. `save_session` consults it
only when `request.path.is_none()`. `restore_sources` sets the gate, restores
each `SourceRecord` into the registry (`registry.restore`), and submits one
batch. `restore_reconcile` waits for the job, builds the alias map from each
committed source's `provider_id` and `local_path`s, calls `restore::reconcile`,
clears the gate, and returns the rewritten session JSON plus conflicts. A
failure path always clears the gate (`scopeguard`-style `Drop` wrapper, not a
manual `else` branch).

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh shell` and `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol shell/src-tauri/src/lib.rs frontend/src/generated
git commit -m "feat(shell): restore sources as one batch and pause autosave until reconciled"
```

---

### Task 18: Frontend batch ingest

**Files:**

- Modify: `frontend/src/app/ingest.ts`, `frontend/src/app/ingest.test.ts`,
  `frontend/src/ui/app-shell.ts`, `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: `IngestPort.{startBatch, batchStatus, batchDetail, cancelBatch, releaseBatch}`.
- Produces: `runBatchIngest(port, paths, onProgress, pollIntervalMs) -> Promise<BatchStatus>`.

- [ ] **Step 1: Write the failing test**

```ts
it("resolves on a partial batch and surfaces the failures", async () => {
  const port = fakePort([
    {
      state: "running",
      fraction: 0.5,
      total: "2",
      done: "1",
      failed: "0",
      recent_failures: [],
    },
    {
      state: "partial",
      fraction: 1,
      total: "2",
      done: "1",
      failed: "1",
      recent_failures: [{ path: "/b.csv", error: "unsupported" }],
    },
  ]);
  const seen: string[] = [];
  const status = await runBatchIngest(
    port,
    ["/a.csv", "/b.csv"],
    (s) => seen.push(s.state),
    0,
  );
  expect(status.state).toBe("partial");
  expect(status.recent_failures[0].error).toBe("unsupported");
  expect(seen).toEqual(["running", "partial"]);
});

it("does not throw when every file fails", async () => {
  const port = fakePort([
    {
      state: "failed",
      fraction: 1,
      total: "1",
      done: "0",
      failed: "1",
      recent_failures: [{ path: "/a.csv", error: "boom" }],
    },
  ]);
  await expect(
    runBatchIngest(port, ["/a.csv"], () => undefined, 0),
  ).resolves.toMatchObject({ state: "failed" });
});

it("releases the job once a terminal status is observed", async () => {
  const port = fakePort([
    {
      state: "done",
      fraction: 1,
      total: "1",
      done: "1",
      failed: "0",
      recent_failures: [],
    },
  ]);
  await runBatchIngest(port, ["/a.csv"], () => undefined, 0);
  expect(port.released).toEqual(["1"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit ingest`
Expected: FAIL — `runBatchIngest` is not exported.

- [ ] **Step 3: Implement it**

`runBatchIngest` starts one batch, polls `batchStatus` every 150 ms, reports
each status, and resolves on any terminal state (`done`/`partial`/`failed`/
`cancelled`) after calling `releaseBatch`. It never throws on file failures —
per-file failure is data, not an exception. `openFiles` in `app-shell.ts` calls
it once for all picked paths, shows `"{done}/{total} loaded · {failed} failed"`
plus a Cancel button wired to `cancelBatch`, lists up to
`recent_failures.length` entries with `textContent`, and calls
`reloadSignals()` once at the end.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh unit ingest` then `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): load whole batches with per-file failure reporting"
```

---

### Task 19: Frontend session sources and restore

**Files:**

- Modify: `frontend/src/app/workspace.ts`, `frontend/src/ui/app-shell.ts`,
  `frontend/src/app/workspace.test.ts`

**Interfaces:**

- Consumes: `SessionPort`, `restore_sources`/`restore_reconcile` through a new
  `RestorePort` on `DataPlane`.
- Produces: `WorkspaceModel.{sources, addSource, removeSource}`;
  `AppShell.loadSession` uses one batch plus reconciliation.

- [ ] **Step 1: Write the failing test**

```ts
it("restores every source in one batch and adopts the reconciled session", async () => {
  const plane = fakePlaneWithLegacySession();
  const shell = await AppShell.mount(plane);
  await shell.loadSession("/tmp/legacy.signalscope");

  expect(plane.ingest.batchCalls).toHaveLength(1);
  expect(plane.ingest.batchCalls[0]).toEqual([
    "/data/run.csv",
    "/data/run2.csv",
  ]);
  expect(shell.workspace.favorites()).toEqual(["run/imu/ax"]);
  expect(plane.session.autosaves).toEqual(
    [],
    "autosave stays paused during restore",
  );
});

it("keeps legacy references and reports a conflict when an alias is ambiguous", async () => {
  const plane = fakePlaneWithConflict();
  const shell = await AppShell.mount(plane);
  await shell.loadSession("/tmp/legacy.signalscope");
  expect(shell.lastNotice()).toContain("imu/ax");
  expect(shell.workspace.favorites()).toEqual(["imu/ax"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit workspace`
Expected: FAIL — `sources()` not found / `restore` port missing.

- [ ] **Step 3: Implement it**

`loadSession` replaces the per-file loop with: `restore_sources` → poll →
`restore_reconcile` → `workspace.replace(reconciledSession)` → `reloadSignals()`
→ replay derived definitions → resume autosave. Conflicts render in the status
strip as `"{legacy_path} is claimed by {n} sources — relink to finish
restoring"`. `addSourcePath` becomes `addSource(record)`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): restore sessions through one batch and reconcile references"
```

---

### Task 20: Phase A1 ADRs, docs, and version bump

**Files:**

- Create: `docs/adr/0026-batch-ingest-and-off-lock-decode.md`,
  `docs/adr/0027-durable-source-identity-and-restore-reconciliation.md`
- Modify: `docs/adr/README.md`, `docs/adr/0009-ingest-jobs-and-progress.md`
  (Status: "Accepted; amended by ADR 0026"), `docs/adr/0022-durable-session-persistence.md`
  (Status: "Accepted; restore ordering superseded by ADR 0027"),
  `docs/implementation-roadmap.md`

- [ ] **Step 1: Write ADR 0026**

Record: the `Decoder` trait returns `DecodedSource`; registration is a host-side
commit; the "store mutex held for a job's duration" consequence of ADR 0009 is
retired; per-file failure policy; the job state machine
`running → done | partial | failed | cancelled`; bounded queues and
memory-weighted admission; aggregate-only status with paged detail; CSV is
streaming, MCAP stays whole-file until P3.

- [ ] **Step 2: Write ADR 0027**

Record: `SourceKey` vs `SourceId`; `(SourceId, local_path)` storage identity;
`prefix/local_path` display identity with no parent-directory text; the pure
v10→v11 migration with deterministic UUIDv5 keys; the second asynchronous
reconciliation stage in `scope-core::restore`; autosave pause; ambiguous-alias
refusal; and that `session`/`store`/`ingest` do not depend on `restore`.

- [ ] **Step 3: Update the index, roadmap, and formatting**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS.

- [ ] **Step 4: Bump the version**

```bash
./scripts/version.sh bump major   # breaking session and protocol schemas
./scripts/version.sh check
```

- [ ] **Step 5: Commit**

```bash
git add docs Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record batch ingest and durable source identity decisions"
```

---

## Phase A2 — source sets and ensemble tiles (spec P2)

Phase gate: tens of aligned runs render as a run-mean band, filtered selections
bake exactly into snapshots, and unaligned sets refuse to answer.

### Task 21: Source sets with partial members

**Files:**

- Create: `core/scope-core/src/sets.rs`
- Modify: `core/scope-core/src/lib.rs`

**Interfaces:**

- Produces: `sets::{SetKey, SetId, SourceSet, SetMember, SchemaFingerprint,
propose_sets}`; `SourceSet::{members, generation, bump_generation,
add_member, remove_member, missing_for}`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_run_with_a_dead_sensor_is_a_partial_member_not_a_separate_set() {
        let full = vec!["imu/ax".to_owned(), "imu/ay".to_owned(), "imu/az".to_owned()];
        let partial = vec!["imu/ax".to_owned(), "imu/az".to_owned()];
        let proposed = propose_sets(&[(key(1), full.clone()), (key(2), partial), (key(3), full)]);

        assert_eq!(proposed.len(), 1);
        let set = &proposed[0];
        assert_eq!(set.members.len(), 3);
        assert_eq!(set.fingerprint.local_paths.len(), 3, "the union defines the schema");
        assert_eq!(set.missing_for(key(2)), &BTreeSet::from(["imu/ay".to_owned()]));
        assert!(set.missing_for(key(1)).is_empty());
    }

    #[test]
    fn disjoint_schemas_propose_separate_sets() {
        let proposed = propose_sets(&[
            (key(1), vec!["imu/ax".to_owned()]),
            (key(2), vec!["gps/lat".to_owned()]),
        ]);
        assert_eq!(proposed.len(), 2);
    }

    #[test]
    fn membership_and_alignment_changes_bump_the_generation() {
        let mut set = propose_sets(&[(key(1), vec!["a".to_owned()]), (key(2), vec!["a".to_owned()])])
            .pop()
            .unwrap();
        let first = set.generation;
        set.remove_member(key(2));
        assert_eq!(set.generation, first + 1);
        set.set_transform(key(1), AffineTransform { scale: 1.0, offset: 5.0 });
        assert_eq!(set.generation, first + 2);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core sets::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`SchemaFingerprint { local_paths: BTreeSet<String> }` with a `digest()` used for
grouping. `propose_sets` groups candidates whose local-path sets overlap by at
least `MIN_SCHEMA_OVERLAP = 0.8` (Jaccard) into one set whose fingerprint is the
union; each member records `missing = union \ own`. Every mutation
(`add_member`, `remove_member`, `set_transform`, `set_time_domain`) bumps
`generation: u64`. Sets carry `key: SetKey(Uuid)` and a process-local
`id: SetId(u64)` assigned by the owning registry.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core sets::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/sets.rs core/scope-core/src/lib.rs
git commit -m "feat(core): group sources into sets with partial members"
```

---

### Task 22: Time domains and affine alignment

**Files:**

- Modify: `core/scope-core/src/sets.rs`

**Interfaces:**

- Produces: `sets::{TimeDomain, TimeUnit, OriginKind, AffineTransform,
AlignmentError}`; `SourceSet::alignment() -> Result<(), AlignmentError>`;
  `AffineTransform::apply(t) -> f64`; `TimeUnit::to_seconds_scale()`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn supported_units_normalize_to_seconds_by_default() {
        assert!((TimeUnit::Milliseconds.to_seconds_scale() - 1e-3).abs() < f64::EPSILON);
        assert!((TimeUnit::Nanoseconds.to_seconds_scale() - 1e-9).abs() < f64::EPSILON);
        let transform = AffineTransform::normalizing(TimeUnit::Milliseconds);
        assert!((transform.apply(2_000.0) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn absolute_epochs_require_an_explicit_offset() {
        let mut set = two_member_set(OriginKind::AbsoluteEpoch);
        assert!(matches!(set.alignment(), Err(AlignmentError::OffsetRequired { .. })));
        set.set_transform(key(1), AffineTransform { scale: 1.0, offset: -1_700_000_000.0 });
        assert!(matches!(set.alignment(), Err(AlignmentError::OffsetRequired { .. })));
        set.set_transform(key(2), AffineTransform { scale: 1.0, offset: -1_700_000_060.0 });
        assert!(set.alignment().is_ok());
    }

    #[test]
    fn relative_origins_align_with_the_default_transform() {
        assert!(two_member_set(OriginKind::Relative).alignment().is_ok());
    }

    #[test]
    fn synthetic_index_and_physical_time_cannot_mix() {
        let mut set = two_member_set(OriginKind::Relative);
        set.set_member_origin(key(2), OriginKind::SyntheticIndex);
        assert!(matches!(set.alignment(), Err(AlignmentError::MixedOrigins)));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core sets::`
Expected: FAIL — `TimeUnit` not found.

- [ ] **Step 3: Implement it**

```rust
pub struct TimeDomain {
    pub unit: TimeUnit,
    pub origin: OriginKind,
    /// Shared alignment origin in seconds; every member's aligned time is
    /// measured from here.
    pub alignment_origin: f64,
}

pub struct AffineTransform {
    pub scale: f64,
    pub offset: f64,
}
```

`alignment()` returns `AlignmentError::MixedOrigins` when members disagree on
`SyntheticIndex` vs physical time, `AlignmentError::OffsetRequired { key }` when
an `AbsoluteEpoch` or event-aligned member has no explicit offset, and
`AlignmentError::UnsupportedUnit` for units without a scale. `Relative` members
default to `AffineTransform { scale: unit.to_seconds_scale(), offset: 0.0 }`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core sets::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/sets.rs
git commit -m "feat(core): require explicit time alignment before ensembles"
```

---

### Task 23: Run-mean envelope math

**Files:**

- Create: `core/scope-core/src/ensemble.rs`
- Modify: `core/scope-core/src/lib.rs`

**Interfaces:**

- Consumes: `pyramid::Pyramid`, `sets::{SourceSet, AffineTransform}`.
- Produces: `ensemble::{EnsembleCell, ensemble_cells, EnsembleError}`;
  `ensemble_cells(members: &[MemberBins], grid: &Grid) -> Vec<EnsembleCell>`
  where `EnsembleCell { t0, t1, min_run_mean, max_run_mean, mean_of_run_means,
sigma, run_count }`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn runs_are_weighted_equally_regardless_of_sample_count() {
        // Run A: 100 samples at 1.0 in the cell. Run B: 1 sample at 3.0.
        let cells = ensemble_cells(&[dense_member(1.0, 100), dense_member(3.0, 1)], &grid(0.0, 1.0, 1));
        let cell = &cells[0];
        assert!((cell.mean_of_run_means - 2.0).abs() < 1e-12, "not sample-weighted");
        assert!((cell.min_run_mean - 1.0).abs() < 1e-12);
        assert!((cell.max_run_mean - 3.0).abs() < 1e-12);
        assert_eq!(cell.run_count, 2);
        assert!((cell.sigma - 1.0).abs() < 1e-12, "population sigma over run means");
    }

    #[test]
    fn the_band_is_run_scatter_not_within_bin_variance() {
        // Both runs oscillate hard inside the cell but share the same mean.
        let cells = ensemble_cells(&[oscillating_member(0.0, 10.0), oscillating_member(0.0, 10.0)], &grid(0.0, 1.0, 1));
        assert!(cells[0].sigma.abs() < 1e-12);
        assert!((cells[0].max_run_mean - cells[0].min_run_mean).abs() < 1e-12);
    }

    #[test]
    fn a_dropout_thins_the_band_instead_of_gapping_it() {
        let cells = ensemble_cells(&[full_member(), member_missing_middle()], &grid(0.0, 3.0, 3));
        assert_eq!(cells.iter().map(|cell| cell.run_count).collect::<Vec<_>>(), vec![2, 1, 2]);
        assert!(cells.iter().all(|cell| cell.run_count > 0));
    }

    #[test]
    fn known_distributions_reproduce_their_statistics_at_every_grid_width() {
        // Ten runs offset by 0..9; the run-mean spread is exact at any width.
        let members: Vec<_> = (0..10).map(|index| constant_member(f64::from(index))).collect();
        for pixels in [1_u32, 4, 16, 64] {
            let cells = ensemble_cells(&members, &grid(0.0, 10.0, pixels));
            for cell in &cells {
                assert!((cell.mean_of_run_means - 4.5).abs() < 1e-9);
                assert!((cell.sigma - 2.872_281_323_269_014).abs() < 1e-9);
                assert_eq!(cell.run_count, 10);
            }
        }
    }

    #[test]
    fn partially_overlapping_member_bins_apportion_by_time_overlap() {
        // One member bin spanning [0,2) with sum 4 contributes half to [0,1).
        let cells = ensemble_cells(&[wide_bin_member(0.0, 2.0, 4.0, 2)], &grid(0.0, 1.0, 1));
        assert!((cells[0].mean_of_run_means - 2.0).abs() < 1e-12);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core ensemble::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Two-stage, documented as the estimand:

```rust
//! Across-run ensemble statistics. For each grid cell the query first reduces
//! each contributing run to one overlap-weighted mean, then aggregates those
//! run means with equal run weight. Pooling `sum`/`sum_sq` across runs would
//! conflate within-bin temporal variance with run scatter and would weight
//! runs by sample count; neither is the estimand.
//!
//! Apportioning a member bin's sum and count by time overlap is an explicit
//! approximation, exact only under uniform in-bin sample spacing.
```

`run_mean(member, cell)` = `Σ overlap_fraction × bin.sum` /
`Σ overlap_fraction × bin.finite_count`, skipping bins with no finite samples;
a run with no finite contribution does not count toward `run_count`.
`EnsembleCell` then takes min/max/mean/population σ over the run means.
`ensemble_cells` returns one cell per grid slot, always with `run_count`
attached so the renderer thins rather than gaps.

Add a guard that makes non-mergeability explicit:

```rust
    /// Ensemble cells discard run identity, so a coarser cell can never be
    /// derived by merging finer ones. Debug builds assert callers do not try.
    #[cfg(debug_assertions)]
    pub fn assert_not_merged(cells: &[EnsembleCell]) { … }
```

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core ensemble::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ensemble.rs core/scope-core/src/lib.rs
git commit -m "feat(core): compute across-run run-mean envelopes"
```

---

### Task 24: Bounded query-time ensemble merge

**Files:**

- Modify: `core/scope-core/src/ensemble.rs`

**Interfaces:**

- Produces: `ensemble::query(set, store, pyramids, window, pixel_width,
member_filter: Option<&BTreeSet<SourceKey>>, limits) -> Result<EnsembleTile, EnsembleError>`;
  `EnsembleError::{AlignmentRequired, TooManyMembers { requested, limit }, MissingSignal}`;
  `Limits { max_members: usize }` default 64.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn an_unaligned_set_fails_closed() {
        assert!(matches!(
            query(&unaligned_set(), &store(), &pyramids(), (0.0, 1.0), 100, None, Limits::default()),
            Err(EnsembleError::AlignmentRequired)
        ));
    }

    #[test]
    fn requests_above_the_member_limit_fail_with_an_actionable_error() {
        let error = query(&set_with(200), &store(), &pyramids(), (0.0, 1.0), 100, None,
                          Limits { max_members: 64 }).unwrap_err();
        assert!(matches!(error, EnsembleError::TooManyMembers { requested: 200, limit: 64 }));
    }

    #[test]
    fn a_filter_restricts_contributing_runs_and_is_reported_back() {
        let filter = BTreeSet::from([key(1), key(2)]);
        let tile = query(&aligned_set(4), &store(), &pyramids(), (0.0, 1.0), 8, Some(&filter), Limits::default()).unwrap();
        assert!(tile.cells.iter().all(|cell| cell.run_count <= 2));
        assert_eq!(tile.member_keys, vec![key(1), key(2)]);
        assert_eq!(tile.generation, aligned_set(4).generation);
    }

    #[test]
    fn cells_are_bounded_by_pixel_width() {
        let tile = query(&aligned_set(4), &store(), &pyramids(), (0.0, 1_000.0), 200, None, Limits::default()).unwrap();
        assert!(tile.cells.len() <= 402);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core ensemble::query`
Expected: FAIL — `query` not found.

- [ ] **Step 3: Implement it**

`query` validates alignment first, resolves the member list (filtered or full),
enforces `max_members`, builds a shared aligned grid of `2 × pixel_width` cells
across the requested window, pulls each member's `Pyramid::level_window` at the
level whose density matches the grid, applies each member's `AffineTransform`
to bin edges, and calls `ensemble_cells`. `EnsembleTile { cells, generation,
set_key, member_keys, level }`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core ensemble::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ensemble.rs
git commit -m "feat(core): bound query-time ensemble merges by member count"
```

---

### Task 25: Protocol v10 — ensemble tiles

**Files:**

- Modify: `protocol/schema/scope-protocol.json`, `shell/src-tauri/src/lib.rs`,
  `frontend/src/app/data-plane.ts`
- Regenerate: protocol outputs

**Interfaces:**

- Produces: `EnsembleBin { t0, t1, min_run_mean: f64?, max_run_mean: f64?,
mean_of_run_means: f64?, sigma: f64?, run_count: u32 }`;
  `EnsembleTileRequest { request_id, set_id: u64, local_path, window, pixel_width,
member_filter: string[] }`;
  `EnsembleTileResponse { request_id, set_key, generation: u64, level: u32,
member_keys: string[], bins: EnsembleBin[] }`;
  `SetSummary { set_id: u64, set_key: string, label, generation: u64,
member_count: u32, local_paths: string[], aligned: bool }`;
  `DataPlane.queryEnsembleTiles`, `DataPlane.listSets`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn ensemble_requests_use_process_local_set_ids_and_durable_member_keys() {
        let request: EnsembleTileRequest = serde_json::from_str(
            r#"{"request_id":"r","set_id":"7","local_path":"imu/ax",
                "window":{"t0":0.0,"t1":1.0},"pixel_width":100,
                "member_filter":["3f2504e0-4f89-11d3-9a0c-0305e82c3301"]}"#,
        )
        .unwrap();
        assert_eq!(request.set_id, 7);
        assert_eq!(request.member_filter.len(), 1);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core EnsembleTileRequest`
Expected: FAIL — type not found.

- [ ] **Step 3: Add the types, regenerate, wire the command**

`"protocol_version": 10`; add the types above; `./scripts/codegen.sh`. Shell
commands `list_sets`, `query_ensemble_tiles`, `create_set`, `update_set_members`,
`set_time_alignment`. An absent filter is `[]` on the wire and `None` in core.

- [ ] **Step 4: Run the checks**

Run: `./scripts/test.sh core` and `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol shell frontend/src
git commit -m "feat(protocol): v10 ensemble tiles and set summaries"
```

---

### Task 26: Session v12 — durable set membership

**Files:**

- Modify: `protocol/schema/scope-session.json`, `core/scope-core/src/session.rs`
- Regenerate: session outputs; update the conformance fixture

**Interfaces:**

- Produces: `SourceSetState { key, label, generation: u64, time_domain: TimeDomainState,
members: SetMemberState[] }`, `SetMemberState { source_key, missing: string[],
scale: f64, offset: f64 }`, `TimeDomainState { unit, origin, alignment_origin: f64 }`,
  `Session.source_sets: SourceSetState[]`; migration rung `11 => 12` adding `[]`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn v11_sessions_gain_an_empty_set_list_and_round_trip_membership() {
        let session = from_json(&v11_session_json()).expect("v11 migrates");
        assert_eq!(session.schema_version, SESSION_SCHEMA_VERSION);
        assert!(session.source_sets.is_empty());

        let with_sets = Session { source_sets: vec![sample_set_state()], ..session };
        let restored = from_json(&serde_json::to_string(&with_sets).unwrap()).unwrap();
        assert_eq!(restored.source_sets, with_sets.source_sets);
        assert_eq!(restored.source_sets[0].members[0].missing, vec!["imu/ay".to_owned()]);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core session::`
Expected: FAIL — no field `source_sets`.

- [ ] **Step 3: Implement it**

Bump to 12, add the types, `./scripts/codegen.sh`, add the additive rung
(`11 => { value["source_sets"] = json!([]); … }`), regenerate the fixture, and
update `history.ts`/`baked-session.ts`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core session::` and `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core/scope-core/src/session.rs core/scope-core/src/session frontend/src
git commit -m "feat(session): v12 persists set membership and time alignment"
```

---

### Task 27: Exact ensemble baking and per-set export selection

**Files:**

- Modify: `core/scope-core/src/snapshot.rs`, `protocol/schema/scope-protocol.json`,
  `shell/src-tauri/src/lib.rs`, `frontend/src/ui/export-dialog.ts`,
  `frontend/src/app/data-plane.ts` (`BakedPlane.queryEnsembleTiles`)

**Interfaces:**

- Produces: `BakedEnsemble { set_key, generation, local_path, member_keys,
levels: EnsembleBin[][] }`; `SnapshotManifest.ensembles: BakedEnsemble[]`;
  `ExportSelection { source_keys: string[], set_keys: string[] }` on
  `ExportEstimateRequest`/`ExportWriteRequest`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn baking_captures_the_exact_generation_and_filtered_membership() {
        let manifest = bake_with_ensemble_panel(/* filter: keys 1 and 3 of 5 */);
        let baked = &manifest.ensembles[0];
        assert_eq!(baked.member_keys.len(), 2, "the filter is baked, never widened");
        assert_eq!(baked.generation, 4);
        assert!(baked.levels.iter().all(|level| level.iter().all(|bin| bin.run_count <= 2)));
    }

    #[test]
    fn export_selection_bounds_all_range_exports() {
        let plan = plan_with_selection(/* 16_000 signals, 1 set selected */);
        assert!(plan.series_total < 16_000);
    }

    #[test]
    fn the_estimate_plans_each_range_and_fidelity_once_over_the_selection() {
        let counter = PlanCounter::default();
        estimate_for_with_counter(&counter, /* 8 range x fidelity combinations */);
        assert_eq!(counter.signals_planned(), 8 * SELECTED_SIGNALS);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core snapshot::`
Expected: FAIL — `ensembles` not found.

- [ ] **Step 3: Implement it**

`plan` gains a `selection: &ExportSelection` argument and filters signals by
source key before any per-signal level planning (fixing the replan-everything
cost). For each panel that plots a set band, `bake` records the panel's exact
`(set_key, generation, member_keys, local_path)` and stores the levels produced
by `ensemble::query` at the panel's window and fidelity, so `BakedPlane` never
recomputes and never widens a filter. `BakedPlane.queryEnsembleTiles` serves
those levels by `(set_key, generation, local_path)` and throws a clear error
when a panel asks for a combination that was not baked.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core snapshot::` then `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/snapshot.rs protocol shell frontend/src
git commit -m "feat(export): bake exact ensemble membership and bound export selection"
```

---

### Task 28: Frontend bands, badges, and selection modes

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts`, `frontend/src/ui/signal-tree.ts`,
  `frontend/src/app/tree-model.ts`, `frontend/src/ui/panel.ts`,
  `frontend/src/styles/app.css`

**Interfaces:**

- Consumes: `EnsembleTileResponse`, `SetSummary`.
- Produces: `drawEnsembleBand(context, cells, scales, tokens)`; tree rows with
  `runCount`; panel series kind `"single" | "spaghetti" | "band"`.

- [ ] **Step 1: Write the failing test**

```ts
it("thins the band where fewer runs contribute instead of breaking it", () => {
  const context = new FakeContext();
  drawEnsembleBand(
    context,
    [cell(2, 0, 1), cell(1, 1, 2), cell(2, 2, 3)],
    scales,
    tokens,
  );
  expect(context.paths.filter((p) => p.kind === "fill")).toHaveLength(1);
  expect(context.alphaAt(1)).toBeLessThan(context.alphaAt(0));
});

it("shows one logical row per local path with an N-run badge", () => {
  const rows = buildTreeRows(["run_a/imu/ax", "run_b/imu/ax"], new Set(), "", {
    setPrefixes: ["run_a", "run_b"],
  });
  const leaf = rows.find((row) => row.kind === "leaf");
  expect(leaf?.label).toBe("imu/ax");
  expect(leaf?.runCount).toBe(2);
});

it("keeps spaghetti mode inside the series budget", () => {
  expect(spaghettiSeries(setWith(200)).length).toBeLessThanOrEqual(
    MAX_SERIES_PER_PANEL,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit ensemble`
Expected: FAIL — `drawEnsembleBand` is not exported.

- [ ] **Step 3: Implement it**

The band draws one filled region between `min_run_mean` and `max_run_mean` with
the mean stroked on top, alpha scaled by `run_count / member_count` so dropouts
thin rather than gap it. Colors come from the `--series-N` palette; amber stays
interaction-only. Tree rows collapse per `local_path` across a set with a
badge; selecting offers single run, spaghetti (capped at the panel series
budget, ADR 0012), or band.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): render run-mean bands and set-aware tree rows"
```

---

### Task 29: Phase A2 ADR and version bump

**Files:**

- Create: `docs/adr/0028-ensemble-run-mean-envelope.md`
- Modify: `docs/adr/README.md`, `docs/implementation-roadmap.md`

- [ ] **Step 1: Write ADR 0028**

Record the estimand (run-mean envelope, equal run weight), why pooled
`sum`/`sum_sq` is wrong, that the band legitimately changes with grid width, the
overlap-apportionment approximation, non-mergeability of ensemble aggregates,
the member limit for query-time merges, fail-closed alignment, dropout thinning,
and that snapshots bake the exact generation and membership.

- [ ] **Step 2: Run the full gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS.

- [ ] **Step 3: Bump the version**

```bash
./scripts/version.sh bump major   # session v12 + protocol v10
./scripts/version.sh check
```

- [ ] **Step 4: Commit**

```bash
git add docs Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the ensemble run-mean envelope decision"
```

---

## Phase A3 — storage: compaction, then paging (spec P3)

Phase gate: resident bin footprint drops roughly an order of magnitude before
any paging lands, then bins and columns page out of core with leases.

### Task 30: Compact storage bins

**Files:**

- Create: `core/scope-core/src/bins.rs`
- Modify: `core/scope-core/src/pyramid.rs`, `core/scope-core/src/cache.rs`,
  `core/scope-core/src/snapshot.rs`, `core/scope-core/src/lib.rs`

**Interfaces:**

- Produces: `bins::{BinLevel, BinRef}`; `BinLevel` is struct-of-arrays
  (`t0: Vec<f64>`, `t1: Vec<f64>`, `first/last/min/max: Vec<f64>` with NaN
  sentinels, `flags: Vec<u8>`, `sum/sum_sq: Vec<f64>`,
  `sample_count/finite_count: Vec<u32>`); `BinLevel::to_wire(index) -> EnvelopeBin`;
  `BinLevel::bytes_per_bin() -> usize`. `Pyramid::merged` becomes `Vec<BinLevel>`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_storage_bin_costs_far_less_than_the_wire_bin() {
        assert!(BinLevel::bytes_per_bin() <= 80);
        assert!(size_of::<EnvelopeBin>() >= 112, "the wire type is the expensive one");
    }

    #[test]
    fn nan_sentinels_and_flags_round_trip_optional_extrema() {
        let mut level = BinLevel::with_capacity(2);
        level.push(&EnvelopeBin { t0: 0.0, t1: 1.0, first: None, last: None, min: None, max: None,
                                  sum: 0.0, sum_sq: 0.0, finite_count: 0, sample_count: 2, has_gap: true });
        level.push(&EnvelopeBin { t0: 1.0, t1: 2.0, first: Some(1.0), last: Some(f64::MAX), min: Some(-0.0),
                                  max: Some(1.0), sum: 1.0, sum_sq: 1.0, finite_count: 2, sample_count: 2, has_gap: false });
        assert_eq!(level.to_wire(0).min, None);
        assert!(level.to_wire(0).has_gap);
        assert_eq!(level.to_wire(1).last, Some(f64::MAX));
        assert_eq!(level.to_wire(1).min, Some(-0.0));
    }

    #[test]
    fn conformance_queries_are_byte_identical_after_the_layout_change() {
        // The existing pyramid conformance fixture must pass unchanged.
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core bins::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`BinLevel` stores optional extrema as NaN sentinels plus one flags byte
(`FIRST_SET | LAST_SET | MIN_SET | MAX_SET | HAS_GAP`), counts as `u32`
(saturating on overflow, documented), and converts to `EnvelopeBin` only at the
query boundary. `Pyramid` holds `Vec<BinLevel>`; `merged_levels()` returns
`&[BinLevel]`; `level`/`level_window` still return `Vec<EnvelopeBin>` so the
protocol and snapshot paths are untouched. The pyramid conformance fixture must
pass **without regeneration** — that is the correctness gate.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core`
Expected: PASS, `conformance_fixture_matches_rust_query` green without
`REGENERATE_FIXTURES`.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src
git commit -m "perf(core): store envelope bins as compact struct-of-arrays"
```

---

### Task 31: Elide the finest stored levels

**Files:**

- Modify: `core/scope-core/src/pyramid.rs`, `core/scope-core/src/cache.rs`

**Interfaces:**

- Produces: `pyramid::FINEST_STORED_LEVEL: usize = 3`;
  `Pyramid::synthesize_level(index, range) -> BinLevel` for levels below it;
  `Pyramid::stored_bin_count()`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn levels_below_the_cutoff_are_synthesized_not_stored() {
        let time: Vec<f64> = (0..100_000).map(f64::from).collect();
        let pyramid = Pyramid::from_samples(&time, &time);
        assert!(pyramid.stored_bin_count() < time.len() / 3, "≈4x fewer stored bins");
        assert_eq!(pyramid.level_count(), 18);
    }

    #[test]
    fn synthesized_levels_match_what_storing_them_would_have_produced() {
        let time: Vec<f64> = (0..4_096).map(f64::from).collect();
        let values: Vec<f64> = time.iter().map(|t| (t * 0.7).sin()).collect();
        let pyramid = Pyramid::from_samples(&time, &values);
        let reference = Pyramid::from_samples_storing_every_level(&time, &values);
        for index in 0..pyramid.level_count() {
            assert_eq!(pyramid.level(index), reference.level(index));
        }
    }

    #[test]
    fn queries_selecting_an_elided_level_stay_viewport_bounded() {
        let time: Vec<f64> = (0..1_000_000).map(f64::from).collect();
        let pyramid = Pyramid::from_samples(&time, &time);
        let query = pyramid.query(0.0, 4_000.0, 800);
        assert!(query.level <= FINEST_STORED_LEVEL as u32);
        assert!(query.bins.len() <= 1_602, "ADR 0003 density bound holds");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core pyramid::`
Expected: FAIL — `stored_bin_count` not found.

- [ ] **Step 3: Implement it**

`from_columns` builds levels 1..=`FINEST_STORED_LEVEL - 1` transiently and keeps
only level `FINEST_STORED_LEVEL` upward. `level_window` synthesizes an elided
level directly from the raw columns over the requested range (the same bounded
walk the existing level-0 path uses), so cost stays proportional to the window,
not the signal. `from_samples_storing_every_level` is a `#[cfg(test)]`
reference builder. Validate the cutoff against ADR 0003's density invariant
before committing to `3`; if the synthesized cost measures worse than the
storage saving, record the measured cutoff in the ADR (Task 38) rather than
silently changing the constant.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core pyramid::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/pyramid.rs core/scope-core/src/cache.rs
git commit -m "perf(pyramid): stop storing the finest levels"
```

---

### Task 32: Sidecar v4 with a shared time section

**Files:**

- Modify: `core/scope-core/src/cache.rs`

**Interfaces:**

- Produces: `CACHE_VERSION = 4`; a per-source time section referenced by every
  signal that shares it (`CacheSignal.time_section: u32`); levels stored as
  fixed-width struct-of-arrays sections, each 8-byte aligned and independently
  CRC'd so a byte range can be read without decoding its neighbors.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn one_shared_time_column_is_written_once_per_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir); // 3 signals sharing one time column
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);

        let bytes = std::fs::read(sidecar_path(&source)).unwrap();
        let directory = read_directory(&bytes);
        let sections: std::collections::BTreeSet<_> =
            directory.signals.iter().map(|signal| signal.time_section).collect();
        assert_eq!(sections.len(), 1);
        assert!(bytes.len() < single_time_column_bytes(&store) * 2);
    }

    #[test]
    fn level_sections_are_aligned_and_independently_readable() {
        let directory = read_directory(&std::fs::read(sidecar_path(&source())).unwrap());
        for signal in &directory.signals {
            for section in &signal.levels {
                assert_eq!(section.offset % 8, 0);
                assert!(section.len % BinLevel::bytes_per_bin() as u64 == 0);
            }
        }
    }

    #[test]
    fn a_v3_sidecar_is_a_miss_not_an_error() {
        write_v3_sidecar(&source());
        assert!(try_load(&source(), &mut SignalStore::new(), key(), "run", &mut |_| {}).unwrap().is_none());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core cache::`
Expected: FAIL — `time_section` not found.

- [ ] **Step 3: Implement it**

Header keeps magic + version + the 32-byte provenance digest + directory length.
The directory gains `time_sections: Vec<CacheSection>` and each `CacheSignal`
references one by index. Level sections store `BinLevel`'s arrays back to back
in a fixed field order with a per-section record count, so a future paged reader
can compute a byte range for any bin index arithmetically.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core cache::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/cache.rs
git commit -m "feat(cache): sidecar v4 with shared time sections and paged-ready levels"
```

---

### Task 33: App-owned cache root and budget preferences

**Files:**

- Modify: `protocol/schema/scope-preferences.json`, `core/scope-core/src/preferences.rs`,
  `core/scope-core/src/cache.rs`, `shell/src-tauri/src/lib.rs`,
  `frontend/src/app/preferences.ts`
- Create: `docs/adr/0023-global-preferences-file.md` amendment section

**Interfaces:**

- Produces: preferences schema 2 with `cache_root: string?`,
  `cache_max_bytes: u64`, `ingest_working_bytes: u64?`, `ingest_resident_bytes: u64?`;
  `cache::CacheRoot::{beside_source, app_owned}`;
  `cache::resolve_root(source, preferences) -> CacheRoot`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_read_only_source_directory_falls_back_to_the_app_cache_root() {
        let (data, cache) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = write_source(&data);
        make_read_only(data.path());

        let root = resolve_root(&source, &preferences_with_root(cache.path()));
        assert_eq!(root.directory(), cache.path());
        let written = write_sidecar_at(&root, &source).expect("the fallback root is writable");
        assert!(written.starts_with(cache.path()));
    }

    #[test]
    fn a_sidecar_write_failure_is_fatal_once_the_store_depends_on_it() {
        let root = CacheRoot::app_owned(std::path::Path::new("/definitely/not/writable"));
        assert!(matches!(write_sidecar_at(&root, &source()), Err(CacheError::Io(_))));
    }

    #[test]
    fn cache_entries_are_named_by_provenance_digest() {
        let root = CacheRoot::app_owned(cache_dir());
        let path = root.entry_path("a".repeat(64).as_str());
        assert!(path.file_name().unwrap().to_string_lossy().starts_with(&"a".repeat(16)));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core cache::root`
Expected: FAIL — `resolve_root` not found.

- [ ] **Step 3: Implement it**

Bump the preferences schema to 2, `./scripts/codegen.sh`, and add the fields.
`resolve_root` probes the source directory for writability once per directory
(cached) and falls back to `cache_root` (default: the app data directory's
`cache/` subdirectory). App-owned entries are named by provenance digest, not by
source path, so a relocated source still hits. Once paging lands (Task 35) a
write failure is fatal, so `IngestOutcome::sidecar_error` is replaced by a hard
error for app-owned roots and kept non-fatal only for the beside-source root.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core` and `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core/scope-core shell frontend/src docs/adr/0023-global-preferences-file.md
git commit -m "feat(cache): add a guaranteed-writable app-owned cache root"
```

---

### Task 34: Owned-or-paged columns and timebase identity

**Files:**

- Create: `core/scope-core/src/columns.rs`
- Modify: `core/scope-core/src/store.rs`, `core/scope-core/src/pyramid.rs`,
  `core/scope-core/src/expr.rs`, `core/scope-core/src/cache.rs`

**Interfaces:**

- Produces: `columns::{Column, TimebaseId}`;
  `Column::{owned(Arc<[f64]>), paged(handle), as_slice() -> ColumnGuard, len}`;
  `Signal::{time() -> ColumnGuard, values() -> ColumnGuard, timebase_id() -> TimebaseId}`.
  `expr::evaluate` compares `TimebaseId` instead of `Arc::ptr_eq`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn signals_from_one_source_share_a_timebase_id_without_pointer_identity() {
        let mut store = SignalStore::new();
        let source = store.register_source("/a/run.csv", key(1), "run").unwrap();
        let time: Arc<[f64]> = Arc::from(vec![0.0, 1.0]);
        store.insert_signal(source, "a", None, Column::owned(Arc::clone(&time)), vec![1.0, 2.0]).unwrap();
        // A paged copy of the same timebase must still compare equal.
        store.insert_signal(source, "b", None, Column::paged(paged_handle(&time)), vec![3.0, 4.0]).unwrap();

        let (a, b) = (store.signal_by_path("run/a").unwrap(), store.signal_by_path("run/b").unwrap());
        assert_eq!(a.timebase_id(), b.timebase_id());
    }

    #[test]
    fn the_shared_timebase_fast_path_still_avoids_resampling() {
        let store = store_with_shared_timebase();
        let evaluated = evaluate(&parse("'run/a' + 'run/b'").unwrap(), &store).unwrap();
        assert_eq!(evaluated.values, vec![4.0, 6.0]);
        assert_eq!(resample_calls(), 0);
    }

    #[test]
    fn the_pyramid_builder_drops_its_column_handles_after_building() {
        let signal = signal_with(1_024);
        let pyramid = Pyramid::from_signal(&signal);
        assert_eq!(pyramid.retained_column_bytes(), 0);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core columns::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`Column` is an enum over `Owned(Arc<[f64]>)` and `Paged(PageHandle)`;
`as_slice()` returns a `ColumnGuard` that either borrows the `Arc` or holds a
lease on a paged range (Task 35 supplies the lease). `TimebaseId(u64)` is
assigned per distinct time column at commit time and stored on `Signal`, so the
expression evaluator's fast path no longer depends on `Arc::ptr_eq` — the one
change that makes paged columns possible. `Pyramid` stops holding column `Arc`s
after building; it keeps a `SignalId` and asks the store for columns when it
must synthesize an elided level.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src
git commit -m "refactor(core): abstract columns and identify timebases explicitly"
```

---

### Task 35: Leased page cache for fine bin levels

**Files:**

- Create: `core/scope-core/src/paging.rs`
- Modify: `core/scope-core/src/{pyramid,cache,columns}.rs`

**Interfaces:**

- Produces: `paging::{PageCache, PageHandle, Lease, PageError}`;
  `PageCache::{new(root, capacity_bytes), read(handle, range) -> Result<Lease, PageError>,
evict_unleased(), leased_bytes(), resident_bytes()}`. Positioned reads only —
  no `mmap`, no `unsafe`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn eviction_never_touches_a_leased_range() {
        let cache = PageCache::new(root(), 2 * PAGE_BYTES);
        let held = cache.read(handle_a(), 0..PAGE_BYTES).unwrap();
        cache.read(handle_b(), 0..PAGE_BYTES).unwrap();
        cache.read(handle_c(), 0..PAGE_BYTES).unwrap(); // forces eviction

        assert_eq!(held.bytes().len(), PAGE_BYTES);
        assert!(cache.leased_bytes() >= PAGE_BYTES);
        assert!(cache.resident_bytes() <= 3 * PAGE_BYTES);
    }

    #[test]
    fn a_cache_full_of_leases_fails_a_new_read_instead_of_evicting_live_data() {
        let cache = PageCache::new(root(), PAGE_BYTES);
        let _held = cache.read(handle_a(), 0..PAGE_BYTES).unwrap();
        assert!(matches!(cache.read(handle_b(), 0..PAGE_BYTES), Err(PageError::CapacityHeld { .. })));
    }

    #[test]
    fn deleting_an_entry_waits_for_its_leases_on_every_platform() {
        let cache = PageCache::new(root(), 4 * PAGE_BYTES);
        let held = cache.read(handle_a(), 0..PAGE_BYTES).unwrap();
        assert!(matches!(cache.delete(handle_a()), Err(PageError::CapacityHeld { .. })));
        drop(held);
        assert!(cache.delete(handle_a()).is_ok());
        assert!(!handle_a().path().exists());
    }

    #[test]
    fn a_truncated_sidecar_is_a_clean_error_not_a_crash() {
        truncate(handle_a().path(), PAGE_BYTES / 2);
        assert!(matches!(PageCache::new(root(), PAGE_BYTES).read(handle_a(), 0..PAGE_BYTES),
                         Err(PageError::ShortRead { .. })));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core paging::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

```rust
//! Byte-range page cache over sidecar files.
//!
//! Positioned reads, not `mmap`: the workspace forbids `unsafe`, a truncated
//! file must be a clean error rather than SIGBUS, and Windows cannot delete a
//! mapped file. The sidecar layout stays mmap-shaped so swapping the backend
//! later is local to this module (ADR 0029).

#[cfg(unix)]
fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buffer, offset)
}

#[cfg(windows)]
fn read_exact_at(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<()> { … }
```

Entries are keyed by `(PageHandle, range)`, ref-counted by outstanding `Lease`s,
and evicted LRU only when unleased. Leased bytes count against the capacity, so
a new ingest fails admission rather than evicting data in use. Fine pyramid
levels (above the elision cutoff but below a resident threshold) load through
the cache; coarse levels stay resident.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core paging::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/paging.rs core/scope-core/src
git commit -m "feat(core): page fine bin levels through a leased LRU cache"
```

---

### Task 36: Spill derived columns to the cache root

**Files:**

- Modify: `core/scope-core/src/columns.rs`, `core/scope-core/src/cache.rs`,
  `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `cache::spill_columns(root, timebase_id, time, values) -> Result<PageHandle, CacheError>`;
  derived signals register `Column::paged(...)` when their resident charge would
  exceed the budget.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_derived_signal_without_a_backing_file_spills_and_still_evaluates() {
        let mut data = data_with_signal("input/x");
        data.budget = tiny_resident_budget();
        let summary = data.create_derived_signal(DerivedRequest { path: "derived/a".into(), expr: "'run/input/x' * 2".into() }).unwrap();

        assert!(data.store.signal(SignalId(summary.signal_id)).unwrap().is_paged());
        assert_eq!(data.store.signal_by_path("derived/a").unwrap().values().as_slice(), &[2.0, 4.0]);
    }

    #[test]
    fn removing_a_derived_signal_deletes_its_spill_file() {
        let mut data = spilled_derived();
        let path = data.spill_path("derived/a");
        data.remove_derived_signal("derived/a").unwrap();
        assert!(!path.exists());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh shell derived`
Expected: FAIL — `is_paged` not found.

- [ ] **Step 3: Implement it**

Spill files live under the app-owned cache root in a `derived/` subdirectory
keyed by a digest of `(expression, timebase_id)`; they are deleted when the
derived signal is removed or replaced, and swept on startup for keys no session
references. Set-scoped derived signals stay out of scope and are named in the
deferred list below.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh shell` and `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "feat(core): spill derived columns to the app-owned cache root"
```

---

### Task 37: Materialized full-set ensemble levels

**Files:**

- Modify: `core/scope-core/src/ensemble.rs`, `core/scope-core/src/cache.rs`

**Interfaces:**

- Produces: `ensemble::{materialize(set, store, pyramids, root) -> Result<MaterializedSet, EnsembleError>,
MaterializedSet::{generation, level_window}}`; `query` uses a materialization
  only when `member_filter` is absent **and** the generation matches exactly.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn every_level_is_built_independently_from_aligned_per_run_data() {
        let materialized = materialize(&aligned_set(8), &store(), &pyramids(), root()).unwrap();
        for level in 1..materialized.level_count() {
            let derived_by_merging = merge_children(&materialized.level(level - 1));
            assert_ne!(derived_by_merging, materialized.level(level),
                       "merging children discards run identity and must not be used");
            assert_eq!(materialized.level(level), reference_level_from_runs(level));
        }
    }

    #[test]
    fn a_membership_change_invalidates_the_materialization() {
        let mut set = aligned_set(8);
        let materialized = materialize(&set, &store(), &pyramids(), root()).unwrap();
        set.remove_member(key(3));
        assert!(matches!(query_using(&materialized, &set), Err(EnsembleError::StaleGeneration { .. })));
    }

    #[test]
    fn a_filtered_request_never_uses_the_full_set_materialization() {
        let filter = BTreeSet::from([key(1)]);
        let tile = query(&aligned_set(8), &store(), &pyramids(), (0.0, 1.0), 64, Some(&filter), Limits::default()).unwrap();
        assert_eq!(tile.source, TileSource::QueryTimeMerge);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core ensemble::materialize`
Expected: FAIL — `materialize` not found.

- [ ] **Step 3: Implement it**

Each level is built independently from the aligned per-run data on that level's
grid; nothing is derived by merging ensemble children. The result is stored under
the cache root keyed by `(set_key, generation, cache-abi)` and loaded through the
page cache. `query` consults it only for unfiltered requests whose generation
matches; anything else takes the bounded query-time path.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core ensemble::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src
git commit -m "feat(core): materialize full-set ensemble levels per generation"
```

---

### Task 38: Phase A3 benchmarks, ADR, and version bump

**Files:**

- Create: `docs/adr/0029-out-of-core-storage.md`
- Modify: `docs/adr/README.md`, `docs/adr/0003-min-max-tile-pyramid.md`
  (Status note), `docs/adr/0023-global-preferences-file.md`,
  `docs/implementation-roadmap.md`, `scripts/test.sh` (a `bench` mode)

- [ ] **Step 1: Add the benchmark harness**

`./scripts/test.sh bench` runs `cargo test --release -p scope-core --
--ignored bench_` over three `#[ignore]`d benchmarks: resident bytes per raw
sample after compaction and elision, batch ingest throughput for 1,000 synthetic
runs, and ensemble query latency at 64 and 1,000 members. Each prints one line
and asserts the Phase 5 target as a floor, so a regression fails rather than
merely reporting.

- [ ] **Step 2: Record the measurements**

Run: `./scripts/test.sh bench`
Expected: bins ≤ 20 bytes per raw sample (from ~120), and the measured level
cutoff. Paste the numbers into ADR 0029.

- [ ] **Step 3: Write ADR 0029**

Record: compaction before paging; the storage-vs-wire bin split; the finest-level
elision cutoff with its measured justification; the shared time section and
sidecar v4; the app-owned cache root as an ADR 0023 amendment; leases and the
"never evict live data, fail admission instead" rule; **positioned reads instead
of `mmap`, and why** (workspace `unsafe_code = "forbid"`, SIGBUS on truncation,
Windows deletion); and that ensemble materializations are per-generation and
non-mergeable.

- [ ] **Step 4: Run the full gate and bump**

```bash
./scripts/format.sh
./scripts/ci.sh all
./scripts/version.sh bump minor   # no wire change; sidecar and preferences versioned internally
./scripts/version.sh check
```

- [ ] **Step 5: Commit**

```bash
git add docs scripts Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the out-of-core storage decision and benchmarks"
```

---

## Deferred (explicitly out of scope for this plan)

- **Set-scoped derived signals** (apply an expression per member, then band the
  result). Needs expression-language semantics of its own; the spec defers it to
  a separate design.
- **MCAP streaming decode.** Stays whole-file per ADR 0009; paging makes it
  survivable, and a streaming MCAP reader is its own task.
- **Quantile ensemble levels**, the resample-grid anchoring choice, the
  auto-group fingerprint threshold, bin paging granularity, and the export
  budget policy for sets — the spec's five open questions. Tasks 21, 24, 35, and
  27 pick working defaults (`MIN_SCHEMA_OVERLAP = 0.8`, `max_members = 64`,
  per-level byte-range pages, per-set selection with no hard source cap); revisit
  each with the Task 38 benchmarks.

---

## Self-Review

**Spec coverage.** Identity and naming → Tasks 2–4, 14. Batch ingest jobs →
Tasks 5–13, 18–19. Source sets and ensemble queries → Tasks 21–28. Snapshots and
export → Task 27. Out-of-core storage → Tasks 30–37. Protocol and session impact
→ Tasks 12, 14, 25, 26, 33. Phasing and per-phase ADRs → Tasks 20, 29, 38. The
spec's Part B (format extensibility) is the companion plan, and Tier 2 plugins
are a spec-writing task there.

**Deviations from the spec, stated deliberately.** (1) Paging uses positioned
reads rather than `mmap` because the workspace forbids `unsafe`; the sidecar
layout stays mmap-shaped and ADR 0029 records the trade. (2) `IngestResponse` is
dropped from job status rather than aggregated — the frontend reloads signals
once per terminal batch, which is what scales to a thousand files.

**Interface consistency.** `SourceKey`/`SourceId`/`SetKey`/`SetId`,
`DecodedSource`/`DecodedSignal`, `commit`, `CommitSink`, `BatchProgress`,
`ProviderInfo`/`provenance_digest`, `TimebaseId`, `BinLevel`, `PageCache` are
each defined in exactly one task and referenced by name thereafter. Wire `u64`
fields (`source_id`, `set_id`, `generation`, counts) are strings in TypeScript
throughout.
