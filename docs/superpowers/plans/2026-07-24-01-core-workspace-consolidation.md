# Core Workspace Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the five `core/*` crates into one `scope-core` crate with per-layer modules, move transactional ingest into the store as a seam every decoder gets for free, and remove small Rust-side duplication.

**Architecture:** ADR 0002's layer boundaries survive as module boundaries inside `scope-core` (`store`, `ingest`, `pyramid`, `compute`, `session`); only `scope-protocol` remains a separate crate because it is the shape shared with the frontend. Atomic ingest becomes `SignalStore::transaction` invoked by a provided `Decoder::ingest` method, so no decoder can forget rollback.

**Tech Stack:** Rust 2021 (workspace at repo root), cargo workspace, bash script wrappers in `./scripts/`.

## Global Constraints

- Run all commands through the repo wrappers (`./scripts/test.sh`, `./scripts/ci.sh`); they re-exec inside the Nix dev shell automatically. Never call `cargo`/`pnpm` directly from your own shell.
- Workspace lints are `clippy::all` + `clippy::pedantic` at `warn` and CI runs clippy with `-D warnings` — new code must be pedantic-clean.
- `unsafe_code = "forbid"` (workspace lint).
- Preserve the ADR invariants: layer boundaries (ADR 0002, amended by this plan), transactional ingest, tile-pyramid gap/extrema behavior.
- Commit messages: lowercase imperative, no prefix (match `git log` style, e.g. "consolidate CI workflows and deduplicate script entry points").
- Stage only the files each task names. Do not commit `build/`, `frontend/dist/`, or `shell/src-tauri/gen/`.
- This plan runs FIRST in the plan series — plans 02–04 assume the new module layout.

---

### Task 1: Collapse `core/*` into `core/scope-core`

**Files:**

- Create: `core/scope-core/Cargo.toml`, `core/scope-core/src/lib.rs`
- Move (git mv): `core/scope-store/src/lib.rs` → `core/scope-core/src/store.rs`; `core/scope-ingest/src/lib.rs` → `core/scope-core/src/ingest.rs`; `core/scope-pyramid/src/lib.rs` → `core/scope-core/src/pyramid.rs`; `core/scope-compute/src/lib.rs` → `core/scope-core/src/compute.rs`; `core/scope-session/src/lib.rs` → `core/scope-core/src/session.rs`
- Delete: `core/scope-store/`, `core/scope-ingest/`, `core/scope-pyramid/`, `core/scope-compute/`, `core/scope-session/` (the leftover `Cargo.toml` files and dirs)
- Modify: `Cargo.toml` (root), `shell/src-tauri/Cargo.toml`, `shell/src-tauri/src/lib.rs`, `scripts/version.mjs:8-16`, `docs/adr/0002-layer-boundaries.md`

**Interfaces:**

- Produces: crate `scope-core` with public modules `store`, `ingest`, `pyramid`, `compute`, `session`. All type names unchanged (`scope_core::store::SignalStore`, `scope_core::pyramid::Pyramid`, `scope_core::ingest::ingest_csv_path`, …). Later plans import via these paths.

- [ ] **Step 1: Move the sources**

```bash
mkdir -p core/scope-core/src
git mv core/scope-store/src/lib.rs core/scope-core/src/store.rs
git mv core/scope-ingest/src/lib.rs core/scope-core/src/ingest.rs
git mv core/scope-pyramid/src/lib.rs core/scope-core/src/pyramid.rs
git mv core/scope-compute/src/lib.rs core/scope-core/src/compute.rs
git mv core/scope-session/src/lib.rs core/scope-core/src/session.rs
git rm core/scope-store/Cargo.toml core/scope-ingest/Cargo.toml core/scope-pyramid/Cargo.toml core/scope-compute/Cargo.toml core/scope-session/Cargo.toml
```

- [ ] **Step 2: Write the new crate manifest and root module**

`core/scope-core/Cargo.toml`:

```toml
[package]
name = "scope-core"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
rust-version.workspace = true

[dependencies]
csv.workspace = true
serde.workspace = true
serde_json.workspace = true
thiserror.workspace = true

[dev-dependencies]
tempfile.workspace = true

[lints]
workspace = true
```

Note: `memmap2` is intentionally NOT carried over — it was declared by `scope-store` but used by zero lines of code (Task 5 removes it from the workspace).

`core/scope-core/src/lib.rs`:

```rust
//! SignalScope native data-plane core.
//!
//! ADR 0002's layer boundaries are module boundaries here: `ingest`,
//! `pyramid`, and `compute` may depend on `store`; `session` is an
//! independent schema boundary; nothing depends on the shell.

pub mod compute;
pub mod ingest;
pub mod pyramid;
pub mod session;
pub mod store;
```

- [ ] **Step 3: Fix cross-module imports in the moved files**

In `core/scope-core/src/ingest.rs`, change:

```rust
use scope_store::{SignalId, SignalStore, SourceId, StoreError};
```

to:

```rust
use crate::store::{SignalId, SignalStore, SourceId, StoreError};
```

In `core/scope-core/src/pyramid.rs`, change:

```rust
use scope_store::Signal;
```

to:

```rust
use crate::store::Signal;
```

Each moved file keeps its `//!` doc comment (now documenting the module) and its `#[cfg(test)] mod tests` block unchanged.

- [ ] **Step 4: Update the workspace manifest**

In root `Cargo.toml`, replace the members list:

```toml
members = [
  "core/scope-core",
  "protocol",
  "shell/src-tauri",
]
```

In `[workspace.dependencies]`, delete the five entries `scope-compute`, `scope-ingest`, `scope-pyramid`, `scope-session`, `scope-store` and add:

```toml
scope-core = { path = "core/scope-core" }
```

(Keep `scope-protocol` as is. Leave `memmap2` for Task 5 so that removal is its own reviewable diff.)

- [ ] **Step 5: Update the shell**

`shell/src-tauri/Cargo.toml` `[dependencies]` — replace `scope-ingest.workspace = true`, `scope-pyramid.workspace = true`, `scope-store.workspace = true` with:

```toml
scope-core.workspace = true
```

`shell/src-tauri/src/lib.rs` — replace the three imports:

```rust
use scope_ingest::ingest_csv_path;
use scope_pyramid::Pyramid;
use scope_store::{SignalId, SignalStore};
```

with:

```rust
use scope_core::ingest::ingest_csv_path;
use scope_core::pyramid::Pyramid;
use scope_core::store::{SignalId, SignalStore};
```

- [ ] **Step 6: Update `scripts/version.mjs`**

Replace the hardcoded set at `scripts/version.mjs:8-16` with:

```js
const workspacePackageNames = new Set([
  "scope-core",
  "scope-protocol",
  "signalscope-shell",
]);
```

(Plan 06 later replaces this set with derivation from `Cargo.toml`; if Plan 06 already landed, skip this step — the derived list needs no edit.)

- [ ] **Step 7: Sweep for stale crate references**

```bash
grep -rn "scope-store\|scope-ingest\|scope-pyramid\|scope-session\|scope-compute\|scope_store\|scope_ingest\|scope_pyramid\|scope_session\|scope_compute" \
  --include="*.rs" --include="*.toml" --include="*.mjs" --include="*.sh" --include="*.nix" --include="*.yml" --include="*.md" \
  . | grep -v "docs/superpowers/plans" | grep -v target | grep -v node_modules
```

Expected remaining hits after this task: only `core/scope-core` internal ones (none — module names have no `scope-` prefix), plus prose in `AGENTS.md`, `README.md`, `docs/adr/0002-layer-boundaries.md`, and `docs/implementation-roadmap.md`. Update those prose mentions to the module names (e.g. "`scope-core::store`"). If `flake.nix` or any script matches, update it the same way.

- [ ] **Step 8: Amend ADR 0002**

Append to `docs/adr/0002-layer-boundaries.md`:

```markdown
## Amendment (2026-07-24)

The five core layers live as modules of one `scope-core` crate rather than
five crates. The dependency arrows above are unchanged and are enforced by
module imports and review: `ingest`, `pyramid`, and `compute` may import
`crate::store`; `session` imports no sibling module; no module imports the
shell. `scope-protocol` remains a separate crate because it is the only
shape shared with the frontend. Re-splitting a module into a crate later is
mechanical because the module tree already mirrors the intended crate
boundaries.
```

Also update the Decision paragraph's crate list sentence to read: "The Cargo workspace separates `scope-core` (modules `store`, `ingest`, `pyramid`, `compute`, `session`) and `scope-protocol`, the only shape shared with the frontend." Fix the stale diagram arrow while here: `compute` currently has no dependency on `store`; annotate the `compute ┘` arrow with `(planned)`.

- [ ] **Step 9: Verify the workspace builds and tests pass**

Run: `./scripts/test.sh core`
Expected: `cargo test --workspace --exclude signalscope-shell` compiles `scope-core` + `scope-protocol` and all existing tests pass (store 1, ingest 4, pyramid 3, session 2, compute 1).

Run: `./scripts/ci.sh rust`
Expected: clippy `-D warnings` clean, full test suite (including shell) passes.

- [ ] **Step 10: Commit**

```bash
git add core/ Cargo.toml Cargo.lock shell/src-tauri/Cargo.toml shell/src-tauri/src/lib.rs scripts/version.mjs docs/adr/0002-layer-boundaries.md AGENTS.md README.md docs/implementation-roadmap.md
git commit -m "collapse core crates into scope-core modules"
```

---

### Task 2: Move transactionality into the store

**Files:**

- Modify: `core/scope-core/src/store.rs`, `core/scope-core/src/ingest.rs`

**Interfaces:**

- Produces: `SignalStore::transaction<T, E>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, E>) -> Result<T, E>`; trait `Decoder` with required `fn decode(&self, path: &Path, store: &mut SignalStore) -> Result<IngestSummary, IngestError>` and provided `fn ingest(...)` that wraps `decode` in a transaction. `ingest_csv_path` keeps its exact signature.

- [ ] **Step 1: Write the failing test** (in `store.rs`'s `mod tests`)

```rust
#[test]
fn transaction_rolls_back_insertions_on_error() {
    let mut store = SignalStore::new();
    let keep = store.register_source("keep.csv");
    store
        .insert_signal(keep, "keep/a", None, Arc::from(vec![0.0]), vec![1.0])
        .unwrap();

    let result: Result<(), &str> = store.transaction(|store| {
        let source = store.register_source("rollback.csv");
        store
            .insert_signal(source, "rollback/a", None, Arc::from(vec![0.0]), vec![1.0])
            .unwrap();
        Err("decode failed")
    });

    assert!(result.is_err());
    assert_eq!(store.sources().count(), 1);
    assert_eq!(store.signals().count(), 1);
    assert!(store.signal_by_path("rollback/a").is_none());
    // Watermarks restored: the rolled-back ids are reused.
    assert_eq!(store.register_source("next.csv"), SourceId(2));
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `./scripts/test.sh core`
Expected: FAIL — `no method named 'transaction' found`.

- [ ] **Step 3: Implement `transaction`** (in `impl SignalStore`, after `insert_signal`)

```rust
/// Runs `f` atomically with respect to registrations: when `f` returns
/// `Err`, every source and signal it inserted is removed and the id
/// counters are restored.
///
/// The store's mutating surface is insert-only (`register_source`,
/// `insert_signal`), so rolling back insertions restores the exact prior
/// state. Any future in-place mutation must extend this rollback.
///
/// # Errors
///
/// Returns whatever error `f` returns, after rolling back.
pub fn transaction<T, E>(
    &mut self,
    f: impl FnOnce(&mut Self) -> Result<T, E>,
) -> Result<T, E> {
    let source_watermark = self.next_source_id;
    let signal_watermark = self.next_signal_id;
    let result = f(self);
    if result.is_err() {
        self.sources.retain(|id, _| id.0 < source_watermark);
        self.signals.retain(|id, _| id.0 < signal_watermark);
        self.signal_paths
            .retain(|_, id| id.0 < signal_watermark);
        self.next_source_id = source_watermark;
        self.next_signal_id = signal_watermark;
    }
    result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./scripts/test.sh core`
Expected: PASS (all store tests green).

- [ ] **Step 5: Make every decoder atomic through the trait**

In `core/scope-core/src/ingest.rs`, replace the `Decoder` trait and the `impl Decoder for CsvDecoder` block:

```rust
/// Common boundary for file and future live decoders.
pub trait Decoder {
    /// Decodes `path` and registers its signals in `store`.
    ///
    /// Implementations may leave partial registrations behind on error;
    /// callers get atomicity from [`Decoder::ingest`].
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn decode(&self, path: &Path, store: &mut SignalStore)
        -> Result<IngestSummary, IngestError>;

    /// Decodes `path` atomically: on error the store is unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn ingest(&self, path: &Path, store: &mut SignalStore)
        -> Result<IngestSummary, IngestError> {
        store.transaction(|store| self.decode(path, store))
    }
}
```

```rust
impl Decoder for CsvDecoder {
    fn decode(&self, path: &Path, store: &mut SignalStore)
        -> Result<IngestSummary, IngestError> {
        Self::ingest_unchecked(path, store)
    }
}
```

This deletes the `let snapshot = store.clone(); … *store = snapshot;` block — the whole-store clone per ingest is gone.

- [ ] **Step 6: Run the ingest tests**

Run: `./scripts/test.sh core`
Expected: PASS — in particular `rolls_back_source_and_signals_when_registration_fails` still passes, now through the transaction seam.

- [ ] **Step 7: Commit**

```bash
git add core/scope-core/src/store.rs core/scope-core/src/ingest.rs
git commit -m "enforce transactional ingest at the store boundary"
```

---

### Task 3: Make `SignalStore::default()` correct

**Files:**

- Modify: `core/scope-core/src/store.rs`, `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Produces: `SignalStore::default() == SignalStore::new()` (ids start at 1). `DataState::default()` becomes safe to use directly.

- [ ] **Step 1: Write the failing test** (in `store.rs` tests)

```rust
#[test]
fn default_store_matches_new() {
    let mut store = SignalStore::default();
    assert_eq!(store.register_source("a.csv"), SourceId(1));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core`
Expected: FAIL — the derived `Default` leaves `next_source_id` at 0, so the assertion sees `SourceId(0)`.

- [ ] **Step 3: Hand-implement `Default` and de-recurse `new`**

Change the struct derive from `#[derive(Clone, Debug, Default)]` to `#[derive(Clone, Debug)]` and replace `new`:

```rust
impl SignalStore {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_source_id: 1,
            next_signal_id: 1,
            sources: BTreeMap::new(),
            signals: BTreeMap::new(),
            signal_paths: BTreeMap::new(),
        }
    }
}

impl Default for SignalStore {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 4: Simplify the shell's state init**

In `shell/src-tauri/src/lib.rs` `run()`, replace:

```rust
.manage(Mutex::new(DataState {
    store: SignalStore::new(),
    ..DataState::default()
}))
```

with:

```rust
.manage(Mutex::new(DataState::default()))
```

The `use scope_core::store::{SignalId, SignalStore};` import may now warn for `SignalStore` — drop `SignalStore` from the import if clippy flags it as unused.

- [ ] **Step 5: Run tests, then commit**

Run: `./scripts/ci.sh rust` — Expected: PASS, clippy clean.

```bash
git add core/scope-core/src/store.rs shell/src-tauri/src/lib.rs
git commit -m "make signal store default construction correct"
```

---

### Task 4: Deduplicate `SignalSummary` construction in the shell

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Produces: private `fn signal_summary(signal: &Signal) -> SignalSummary` used by both `ingest_csv` and `list_signals`.

- [ ] **Step 1: Add the helper** (below the `DataState` struct; add `Signal` to the store import)

```rust
use scope_core::store::{Signal, SignalId};
```

```rust
fn signal_summary(signal: &Signal) -> SignalSummary {
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
    }
}
```

- [ ] **Step 2: Use it at both call sites**

In `ingest_csv`, replace the closure body of the `.map(...)` over `filter_map(|id| data.store.signal(*id))` with `.map(signal_summary)`. In `list_signals`, replace the `.map(|signal| SignalSummary { … })` with `.map(signal_summary)`.

- [ ] **Step 3: Run and commit**

Run: `./scripts/ci.sh rust` — Expected: PASS.

```bash
git add shell/src-tauri/src/lib.rs
git commit -m "share signal summary construction in the shell"
```

---

### Task 5: Remove the unused `memmap2` dependency

**Files:**

- Modify: `Cargo.toml` (root), `Cargo.lock`

- [ ] **Step 1: Delete `memmap2 = "0.9"` from `[workspace.dependencies]`** (the per-crate reference already vanished with Task 1's new manifest). Confirm nothing uses it:

```bash
grep -rn "memmap" --include="*.rs" --include="*.toml" . | grep -v target | grep -v docs/
```

Expected: no hits.

- [ ] **Step 2: Refresh the lockfile and verify**

Run: `./scripts/test.sh core` (the wrapper's cargo invocation updates `Cargo.lock`).
Expected: PASS; `git diff Cargo.lock` shows `memmap2` removed.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "drop unused memmap2 dependency"
```

---

### Task 6: Full gate

- [ ] **Step 1: Run the complete local quality gate**

Run: `./scripts/ci.sh all`
Expected: format, rust (clippy + tests), frontend checks, artifact checks, and e2e all pass. The frontend is untouched by this plan, so any frontend failure means an environment problem, not this plan.

- [ ] **Step 2: Confirm the working tree is clean and hand off**

Run: `git status` — Expected: clean. Report the branch ready for review.
