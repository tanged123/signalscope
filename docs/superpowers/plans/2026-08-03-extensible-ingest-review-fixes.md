# Extensible Ingest Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the security, correctness, and platform findings from the
review of extensible ingest B1–B3 (commits `4725ac1..1d3917e`) so the branch
can merge.

**Architecture:** The recipe layer is already disciplined — closed enums,
validated selectors, length-framed digests. The container readers underneath
are not: they trust file-declared depth, size, and links. Most of this plan
pushes limits into `ContainerReader`'s implementations so one seam protects
every caller (batch decode, the import wizard, and introspection), rather
than patching each call site.

**Tech Stack:** Rust 2024 (`scope-core`, `shell/src-tauri`), `hdf5-metno`,
`parquet`/`arrow`, versioned JSON protocol schema with codegen, TypeScript
frontend, vitest (jsdom).

**Provenance:** Findings from two independent reviews of `4725ac1..1d3917e`.
Every Critical/Important finding maps to a task below; the mapping is in
Self-Review. Exploit reproductions cited here were demonstrated by the
security review, not assumed.

## Global Constraints

- Every command goes through `./scripts/*` (`test.sh`, `codegen.sh`,
  `format.sh`, `ci.sh`, `version.sh`).
- `protocol/schema/*.json` is the single schema source; never hand-edit
  generated Rust or TypeScript; keep `pnpm codegen:check` green.
- Untrusted names (dataset paths, recipe names, container attributes) stay
  data: normalized through `naming::normalize_segment`, inserted with
  `textContent`. `normalize_segment` does **not** strip markup — the DOM
  discipline is the only XSS barrier, so never introduce `innerHTML` on a
  container-derived string.
- Parsing happens only in the native host. No container, recipe, or provider
  concept reaches a snapshot.
- Cache invalidation stays keyed on provider id + `cache_abi` + recipe digest;
  digest inputs for `csv` and `mcap` must remain unchanged so existing caches
  stay valid.
- New dependencies pass `cargo deny check` and `cargo machete`. System
  libraries go in `flake.nix`, `scripts/setup-appimage.sh`, **and** the
  Windows build path.
- **Do not claim a GUI or platform build was tested if it was not**
  (`AGENTS.md`). Task 8 in particular cannot be verified locally; say so.

---

## File Structure

| File                                              | Change | Responsibility                                           |
| ------------------------------------------------- | ------ | -------------------------------------------------------- |
| `core/scope-core/src/ingest/recipe/mod.rs`        | Modify | Deny unknown fields at every nesting level.              |
| `core/scope-core/src/ingest/container/mod.rs`     | Modify | Shared limit constants and their error arm.              |
| `core/scope-core/src/ingest/container/hdf5.rs`    | Modify | Bounded walk, link filtering, declared-size ceiling.     |
| `core/scope-core/src/ingest/container/parquet.rs` | Modify | Declared-size ceiling, magic fix.                        |
| `core/scope-core/src/ingest/mod.rs`               | Modify | `IngestError::RecipeRequired`.                           |
| `core/scope-core/src/ingest/batch.rs`             | Modify | Call `restore::recipe_status` instead of reimplementing. |
| `core/scope-core/src/restore.rs`                  | Modify | Single recipe-status implementation, now exercised.      |
| `core/scope-core/src/ingest/recipe/decode.rs`     | Modify | Reject empty names; `row_count` across all signals.      |
| `core/scope-core/src/ingest/recipe/resolve.rs`    | Modify | No symlink sidecars; error without source excerpt.       |
| `shell/src-tauri/src/lib.rs`                      | Modify | Symlink-proof recipe write; hoisted descriptors.         |
| `protocol/schema/scope-protocol.json`             | Modify | `BatchFailure.recipe_required`, version 17.              |
| `frontend/src/ui/import-wizard.ts`                | Modify | Timebase evidence, dismissal, escaping.                  |
| `frontend/src/ui/app-shell.ts`                    | Modify | Isolated wizard mount, registry-derived format hint.     |
| `scripts/build-windows.sh` / `Cargo.toml`         | Modify | HDF5 on Windows.                                         |
| `docs/adr/003{3,4}-*.md`                          | Modify | Correct the claims the review falsified.                 |

---

## Phase F1 — Security hardening

Phase gate: no hostile container or recipe can abort the process, read outside
its container, or write outside its destination.

### Task 1: Deny unknown fields at every recipe nesting level

**Files:**

- Modify: `core/scope-core/src/ingest/recipe/mod.rs:37-43`

**Interfaces:**

- Produces: no signature change. `TimeSource`'s three variants reject unknown
  fields, making ADR 0034's "every recipe struct denies unknown fields" true.

Finding: `#[serde(deny_unknown_fields)]` is on `Recipe` (`:19`) and
`Selection` (`:28`) but not on `TimeSource` (`:37`), and serde does not
inherit it. `command`/`plugin`/`decoder` keys parse cleanly one level below
where `a_recipe_can_never_name_executable_code` (`:273`) probes. Because they
never enter the model they do not change `content_digest`, so a sidecar
displaying `command = "rm -rf /"` reports as unchanged.

- [ ] **Step 1: Write the failing test**

Replace the flat hostile-key test's body in `recipe/mod.rs`'s test module with
a path-driven one so future nesting is covered by construction:

```rust
    #[test]
    fn a_recipe_can_never_name_executable_code_at_any_nesting_level() {
        const HOSTILE_KEYS: [&str; 4] = ["command", "plugin", "decoder", "exec"];
        // (label, recipe template with {hostile} substituted at one level)
        const SITES: [(&str, &str); 5] = [
            ("top level", "id=\"x\"\ncontainer=\"hdf5\"\n{hostile}\n"),
            (
                "selection",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n{hostile}\n[selection.time]\nkind=\"index\"\ndt=1.0\nt0=0.0\n",
            ),
            (
                "index time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"index\"\ndt=1.0\nt0=0.0\n{hostile}\n",
            ),
            (
                "dataset time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"dataset\"\npath=\"t\"\n{hostile}\n",
            ),
            (
                "sibling time",
                "id=\"x\"\ncontainer=\"hdf5\"\n[[selection]]\ndatasets=\"a\"\nname=\"keep\"\n[selection.time]\nkind=\"sibling\"\nname=\"t\"\n{hostile}\n",
            ),
        ];

        for (label, template) in SITES {
            for key in HOSTILE_KEYS {
                let hostile = format!("{key} = \"/usr/bin/python\"");
                let recipe = template.replace("{hostile}", &hostile);
                let error = parse_recipe(&recipe)
                    .err()
                    .unwrap_or_else(|| panic!("hostile key `{key}` accepted at {label}"));
                assert!(
                    matches!(error, RecipeError::UnknownField(_)),
                    "hostile key `{key}` at {label} produced {error:?}, not UnknownField"
                );
            }
        }
    }

    #[test]
    fn an_unknown_container_is_still_rejected() {
        let recipe = "id=\"x\"\ncontainer=\"native\"\n";
        assert!(matches!(
            parse_recipe(recipe),
            Err(RecipeError::UnknownContainer(_))
        ));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core recipe::tests::a_recipe_can_never_name`
Expected: FAIL — "hostile key `command` accepted at index time".

- [ ] **Step 3: Implement it**

Serde does not accept `deny_unknown_fields` on an internally-tagged enum's
variants directly. Give each variant a named struct that carries the
attribute:

```rust
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TimeSource {
    Dataset(DatasetTime),
    Sibling(SiblingTime),
    Index(IndexTime),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetTime {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SiblingTime {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexTime {
    pub dt: f64,
    pub t0: f64,
}
```

Update every `TimeSource::Dataset { path }` construction and match arm — they
live in `recipe/mod.rs` (validation, digest), `recipe/decode.rs` (time
resolution), and both test modules. If keeping struct-variant syntax is
preferred, verify by test that the attribute actually takes effect on
variants in the serde version in `Cargo.lock`; the test above is the arbiter,
not the syntax.

`content_digest` must still hash the same fields in the same order — confirm
`the_digest_is_content_addressed...` still passes unchanged, which proves
existing recipe caches stay valid.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core recipe::` then `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/recipe
git commit -m "fix(ingest): deny unknown recipe fields at every nesting level"
```

---

### Task 2: Bound the HDF5 group walk

**Files:**

- Modify: `core/scope-core/src/ingest/container/mod.rs`,
  `core/scope-core/src/ingest/container/hdf5.rs:147-186`

**Interfaces:**

- Produces: `container::{MAX_GROUP_DEPTH, MAX_DATASET_ENTRIES}`;
  `collect_datasets` returns `ContainerError::Unsupported` on exceeding
  either, and skips non-hard links. Task 3 reuses the same error arm.

Findings, both demonstrated: a 3,480-byte file whose group hard-links to an
ancestor overflows the stack and **aborts the process** (SIGABRT — not
catchable, so transactional ingest cannot contain it; 12,000 nested groups
does the same without a cycle). Separately, an HDF5 **external link** names an
arbitrary filesystem path, so `data.h5` plus a `datasets = "**"` sidecar pulls
`/home/victim/proprietary/flight.h5` into the session, cache, and any later
export. Both fire on the automatic path, since dropping a directory triggers
`introspect_container`.

- [ ] **Step 1: Write the failing test**

In `hdf5.rs`'s test module:

```rust
    #[test]
    fn a_cyclic_group_link_is_an_error_not_a_stack_overflow() {
        let file = hdf5_metno::File::create(temporary_path("cycle.h5")).unwrap();
        let outer = file.create_group("a").unwrap();
        let inner = outer.create_group("b").unwrap();
        inner.link_hard("/a", "loop").unwrap();
        drop(file);

        let error = Hdf5Container::open(&temporary_path("cycle.h5")).unwrap_err();
        assert!(matches!(error, ContainerError::Unsupported(_)));
    }

    #[test]
    fn a_deeply_nested_container_is_rejected_at_the_depth_limit() {
        let path = temporary_path("deep.h5");
        let file = hdf5_metno::File::create(&path).unwrap();
        let mut group = file.create_group("g0").unwrap();
        for level in 1..(MAX_GROUP_DEPTH + 8) {
            group = group.create_group(&format!("g{level}")).unwrap();
        }
        drop(file);

        assert!(matches!(
            Hdf5Container::open(&path).unwrap_err(),
            ContainerError::Unsupported(_)
        ));
    }

    #[test]
    fn an_external_link_never_reads_outside_the_container() {
        let secret = temporary_path("secret.h5");
        write_hdf5_at(&secret, &[("private", &[1.0, 2.0, 3.0])]);
        let path = temporary_path("host.h5");
        let file = hdf5_metno::File::create(&path).unwrap();
        file.link_external(&secret.display().to_string(), "/", "elsewhere")
            .unwrap();
        drop(file);

        let container = Hdf5Container::open(&path).unwrap();
        assert!(
            container.datasets().is_empty(),
            "external link contents must not be listed: {:?}",
            container.datasets()
        );
    }
```

Add `write_hdf5_at(path, columns)` and `temporary_path(name)` helpers beside
the existing `write_hdf5` if it does not already take a path. Verify the
`link_hard`/`link_external` method names against `hdf5-metno` 0.10 — if they
differ, the assertions stay and only construction changes.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core hdf5`
Expected: FAIL — the cycle test aborts the test process with
"fatal runtime error: stack overflow"; the external-link test lists
`elsewhere/private`.

- [ ] **Step 3: Implement it**

In `container/mod.rs`:

```rust
/// Maximum group nesting walked during listing. HDF5 links can point at an
/// ancestor, so an unbounded walk on an untrusted file overflows the stack —
/// which aborts rather than unwinds, so it must be prevented, not caught.
pub const MAX_GROUP_DEPTH: usize = 64;

/// Maximum datasets listed from one container. Bounds both the outline sent
/// to the wizard and the work the recipe matcher does per selection.
pub const MAX_DATASET_ENTRIES: usize = 50_000;
```

In `hdf5.rs`, thread a depth argument and filter link types. `member_names`
does not report link type, so iterate with `iter_visit_default`, which hands
each entry a `LinkInfo`:

```rust
fn collect_datasets(
    group: &Group,
    prefix: &str,
    depth: usize,
    entries: &mut Vec<DatasetEntry>,
) -> Result<(), ContainerError> {
    if depth > MAX_GROUP_DEPTH {
        return Err(ContainerError::Unsupported(format!(
            "container nests deeper than {MAX_GROUP_DEPTH} groups"
        )));
    }
    // Hard links only: soft links can dangle or loop, and external links name
    // a path outside this file entirely.
    let members = group
        .iter_visit_default(Vec::new(), |_, name, info, acc: &mut Vec<String>| {
            if info.link_type == hdf5_metno::LinkType::Hard {
                acc.push(name.to_owned());
            }
            true
        })
        .map_err(backend_error)?;

    for name in members {
        if entries.len() >= MAX_DATASET_ENTRIES {
            return Err(ContainerError::Unsupported(format!(
                "container lists more than {MAX_DATASET_ENTRIES} datasets"
            )));
        }
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if let Ok(dataset) = group.dataset(&name) {
            // ... unchanged classification and push ...
        } else if let Ok(child) = group.group(&name) {
            collect_datasets(&child, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}
```

Call it as `collect_datasets(&file, "", 0, &mut entries)?` at `hdf5.rs:61`.

The depth cap is what makes cycles safe: a cycle simply hits the limit. Do not
substitute token-based cycle detection for it — `LocationToken` implements
`Eq` but not `Hash`, so a visited-set costs a linear scan and still leaves
deep-but-acyclic files unbounded.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core hdf5` then `./scripts/test.sh core container::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/container
git commit -m "fix(ingest): bound the HDF5 walk and refuse external links"
```

---

### Task 3: Refuse datasets whose declared size exceeds a ceiling

**Files:**

- Modify: `core/scope-core/src/ingest/container/mod.rs`,
  `core/scope-core/src/ingest/container/hdf5.rs:73-88`,
  `core/scope-core/src/ingest/container/parquet.rs:62-66`, `:150-162`

**Interfaces:**

- Consumes: `ContainerError::Unsupported` (Task 2).
- Produces: `container::MAX_DATASET_BYTES`; both readers reject before
  allocating.

Finding, demonstrated: a 2,080-byte HDF5 file declaring 10^12 elements makes
`read_f64` ask the allocator for **8 TB**. Admission control sizes its ticket
from the file's length on disk (`batch.rs:572-577` →
`admission::estimate_working_bytes`), which is a fine proxy for CSV and
meaningless for a container. Allocation failure calls `handle_alloc_error`,
which aborts. Parquet has the same shape from `num_rows` in the thrift footer
— and even an honest run-length-encoded Parquet column gives ~1000:1
amplification.

- [ ] **Step 1: Write the failing test**

In `container/mod.rs`'s test module, against the fake reader-independent
constant, plus a real one in `hdf5.rs`:

```rust
    // container/mod.rs
    #[test]
    fn the_dataset_ceiling_is_below_a_plausible_working_budget() {
        assert!(MAX_DATASET_BYTES <= 2 * 1024 * 1024 * 1024);
    }
```

```rust
    // hdf5.rs
    #[test]
    fn a_dataset_declaring_more_than_the_ceiling_is_refused_before_allocating() {
        // A tiny file can declare an enormous dataspace; the declared length,
        // not the file length, is what read_f64 would allocate.
        let path = temporary_path("huge.h5");
        let file = hdf5_metno::File::create(&path).unwrap();
        file.new_dataset::<f64>()
            .shape([MAX_DATASET_BYTES / 8 + 1024])
            .create("huge")
            .unwrap();
        drop(file);

        let container = Hdf5Container::open(&path).unwrap();
        assert!(matches!(
            container.read_f64("huge"),
            Err(ContainerError::Unsupported(_))
        ));
    }
```

```rust
    // parquet.rs
    #[test]
    fn a_column_longer_than_the_ceiling_is_refused() {
        let entry = DatasetEntry {
            path: "ax".into(),
            kind: DatasetKind::Numeric,
            len: MAX_DATASET_BYTES / 8 + 1,
            shape: vec![MAX_DATASET_BYTES / 8 + 1],
        };
        assert!(matches!(
            check_declared_size(&entry),
            Err(ContainerError::Unsupported(_))
        ));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core container::` and `./scripts/test.sh core hdf5`
Expected: FAIL — `MAX_DATASET_BYTES` / `check_declared_size` not found. Do
**not** run the 8 TB case without the guard in place.

- [ ] **Step 3: Implement it**

In `container/mod.rs`:

```rust
/// Largest column a container reader will materialize, in bytes. Declared
/// dataset lengths come from the file being read, so they are attacker
/// controlled: a 2 KB file can claim 10^12 elements. Allocation failure
/// aborts the process, so the claim is checked before any allocation.
pub const MAX_DATASET_BYTES: usize = 1024 * 1024 * 1024;

/// # Errors
///
/// Returns [`ContainerError::Unsupported`] when the entry's declared length
/// would exceed [`MAX_DATASET_BYTES`].
pub fn check_declared_size(entry: &DatasetEntry) -> Result<(), ContainerError> {
    let declared = entry.len.saturating_mul(std::mem::size_of::<f64>());
    if declared > MAX_DATASET_BYTES {
        return Err(ContainerError::Unsupported(format!(
            "dataset {} declares {declared} bytes, above the {MAX_DATASET_BYTES} byte ceiling",
            entry.path
        )));
    }
    Ok(())
}
```

Call `check_declared_size(entry)?` in `Hdf5Container::read_f64` after the
`NotNumeric` check and before `read_raw`, and in `ParquetContainer::read_f64`
before `read_projected_column`. In `ParquetContainer::open`, apply the same
check to `row_count` so a falsified footer is rejected at open rather than at
first read. Leave `read_preview_f64` alone — it is already bounded by `limit`.

This is a fixed ceiling, deliberately not the live `MemoryBudget`: threading
the batch worker's ticket into `ContainerReader` is a larger refactor, and the
ceiling is what stops the abort. Record the follow-up in Deferred.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core container::`, `./scripts/test.sh core hdf5`,
`./scripts/test.sh core parquet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/container
git commit -m "fix(ingest): refuse containers declaring oversized datasets"
```

---

### Task 4: A recipe write that cannot follow a planted symlink

**Files:**

- Modify: `shell/src-tauri/src/lib.rs:391-435`

**Interfaces:**

- Produces: `save_recipe` writes through `OpenOptions::create_new`; sidecar
  destinations require an existing regular source file.

Finding, demonstrated: `fs::write` on `destination.with_extension("toml.tmp")`
opens with `O_TRUNC` and no `O_NOFOLLOW`, and the temporary name is fully
predictable from the data file's name — inside the untrusted dropped
directory. Planting `data.h5.scope.toml.tmp` as a symlink to any file the user
can write causes "Save sidecar" to truncate that file. Content is constrained
to valid recipe TOML, so this destroys rather than injects, but it destroys
arbitrarily. The sidecar branch additionally `create_dir_all`s the parent of a
frontend-supplied path.

- [ ] **Step 1: Write the failing test**

In `shell/src-tauri/src/lib.rs`'s test module (Unix-only; the attack needs
symlinks):

```rust
    #[cfg(unix)]
    #[test]
    fn a_planted_temporary_symlink_cannot_redirect_a_recipe_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("data.h5");
        std::fs::write(&source, b"\x89HDF\r\n\x1a\n").unwrap();
        let victim = directory.path().join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        std::os::unix::fs::symlink(&victim, directory.path().join("data.h5.scope.toml.tmp"))
            .unwrap();

        let written = write_recipe_file(
            &directory.path().join("data.h5.scope.toml"),
            SAMPLE_RECIPE_TOML,
        );

        assert!(written.is_ok(), "a planted symlink must not block the write");
        assert_eq!(
            std::fs::read_to_string(&victim).unwrap(),
            "precious",
            "the victim file must be untouched"
        );
    }

    #[test]
    fn a_sidecar_destination_requires_an_existing_regular_source_file() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("nope.h5");
        assert!(sidecar_destination(&missing).is_err());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh shell recipe`
Expected: FAIL — `write_recipe_file` / `sidecar_destination` not found.

- [ ] **Step 3: Implement it**

Extract two helpers and call them from `save_recipe`:

```rust
/// Writes `contents` to `destination` through a uniquely named temporary in
/// the same directory. `create_new` fails on an existing path — including a
/// symlink, dangling or not — so a pre-planted temporary cannot redirect the
/// write outside the destination directory.
fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;

    static NEXT_RECIPE_ID: AtomicU64 = AtomicU64::new(0);
    let suffix = NEXT_RECIPE_ID.fetch_add(1, Ordering::Relaxed);
    let temporary = destination.with_extension(format!("toml.{}.tmp", suffix));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| error.to_string());
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

/// The sidecar path beside an existing source file. The source must already
/// exist as a regular file: the destination is frontend-supplied, and this is
/// what keeps the write inside a directory the user actually opened.
fn sidecar_destination(source: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("recipe source is not an existing file".to_owned());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "source path has no file name".to_owned())?;
    Ok(source.with_file_name(format!(
        "{}.scope.toml",
        file_name.to_string_lossy()
    )))
}
```

In `save_recipe`: use `sidecar_destination` for the sidecar branch and delete
the unconditional `create_dir_all(parent)` at `:425` — the sidecar's parent
necessarily exists once the source does, and the user-directory branch already
creates its own directory at `:421`. Replace the write/rename pair at
`:427-429` with `write_recipe_file`. Keep the native `parse_recipe` validation
at `:396` ahead of everything; it is the half of this that already worked.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src-tauri/src/lib.rs
git commit -m "fix(shell): write recipes through a symlink-proof temporary"
```

---

## Phase F2 — Correctness and coverage

Phase gate: dispatch no longer produces false positives, restore
reconciliation has one implementation and real tests, and the wizard cannot
strand a successful batch.

### Task 5: Parquet magic false positive

**Files:**

- Modify: `core/scope-core/src/ingest/container/parquet.rs:18-20`, `:251-256`

**Interfaces:**

- Produces: `is_parquet_magic` matches only a leading `PAR1`.

Finding: the probe window is the first 8 KiB, so a Parquet **footer** magic is
never inside it for any file larger than that. What `ends_with` actually does
is claim, at `Confidence::Certain`, any file whose bytes at offset 8188..8192
happen to be `PAR1` — and `Certain` outranks every other provider, so such a
file is routed to Parquet and fails there instead of reaching its real
decoder. Real Parquet files always begin with `PAR1`, so the leading check is
necessary and sufficient. The existing test encodes the wrong model; it came
verbatim from the plan, which had the same confusion.

- [ ] **Step 1: Write the failing test**

Replace `the_magic_is_recognized_at_both_ends_of_the_file` with:

```rust
    #[test]
    fn only_a_leading_magic_claims_a_probe_window() {
        assert!(is_parquet_magic(b"PAR1\x00\x00"));
        assert!(
            !is_parquet_magic(b"\x00\x00PAR1"),
            "a trailing match inside the probe window is not a Parquet header"
        );
    }

    #[test]
    fn a_file_whose_probe_window_ends_in_the_magic_is_not_claimed() {
        let mut probe = vec![b'x'; crate::ingest::registry::PROBE_BYTES - 4];
        probe.extend_from_slice(b"PAR1");
        let registry = crate::ingest::registry::ProviderRegistry::builtin();
        let selected = registry.select_bytes(&probe);
        assert!(
            selected.is_err() || selected.unwrap().id() != "parquet",
            "parquet must not claim a file merely because the probe ends in PAR1"
        );
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core parquet`
Expected: FAIL — both assertions.

- [ ] **Step 3: Implement it**

```rust
/// Parquet files begin with `PAR1`. The trailing footer magic is out of reach
/// of a fixed-size probe window for any file larger than the window, so a
/// trailing match inside the probe is a coincidence, not a header.
pub fn is_parquet_magic(probe: &[u8]) -> bool {
    probe.starts_with(PARQUET_MAGIC)
}
```

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core parquet` then `./scripts/test.sh core registry::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/container/parquet.rs
git commit -m "fix(ingest): claim Parquet only on a leading magic"
```

---

### Task 6: One recipe-status implementation, with the tests the plan asked for

**Files:**

- Modify: `core/scope-core/src/restore.rs:19-72`,
  `core/scope-core/src/ingest/batch.rs:586-630`

**Interfaces:**

- Consumes: `restore::{RecipeStatus, recipe_status}`.
- Produces: `batch::prepare_and_commit` calls `recipe_status` rather than
  reimplementing the comparison; `RecipeRestoreError`'s messages stay the
  user-facing text ("reconfirm", "relink").

Finding: `restore.rs:19-72` defines the whole `RecipeStatus` surface the
original plan's Task 12 specified — and nothing calls it. The live logic is
reimplemented inline in `batch.rs` with bare strings, and the two disagree:
`recipe_status` classifies `(None, None, Some(resolved))` as `Changed`, while
`batch.rs` treats it as a normal first import (the batch behavior is the
correct one — a source with no recorded recipe that now resolves one is a
first import, not a mismatch). None of Task 12's four tests exist, so the
reconfirm/relink behavior ADR 0034 documents is verified nowhere.

- [ ] **Step 1: Write the failing test**

In `restore.rs`'s test module:

```rust
    #[test]
    fn a_source_with_no_recorded_recipe_that_now_resolves_one_is_a_first_import() {
        let record = record_without_recipe();
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "aaaa"))),
            RecipeStatus::Matched
        );
    }

    #[test]
    fn a_changed_digest_or_id_requires_reconfirmation() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "bbbb"))),
            RecipeStatus::Changed
        );
        assert_eq!(
            recipe_status(&record, Some(&resolved("other-h5", "aaaa"))),
            RecipeStatus::Changed
        );
        assert!(
            restore_source(&record, Some(&resolved("flight-h5", "bbbb")))
                .unwrap_err()
                .to_string()
                .contains("reconfirm")
        );
    }

    #[test]
    fn a_missing_recipe_requires_a_relink() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(recipe_status(&record, None), RecipeStatus::Missing);
        assert!(
            restore_source(&record, None)
                .unwrap_err()
                .to_string()
                .contains("relink")
        );
    }

    #[test]
    fn a_matching_recipe_restores_cleanly() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(
            recipe_status(&record, Some(&resolved("flight-h5", "aaaa"))),
            RecipeStatus::Matched
        );
        assert!(restore_source(&record, Some(&resolved("flight-h5", "aaaa"))).is_ok());
    }
```

Plus the two obligations that belong to their own modules — in `session.rs`'s
tests:

```rust
    #[test]
    fn the_previous_version_gains_null_recipe_fields() {
        let session = from_json(&previous_version_json()).expect("migrates");
        assert!(session.sources.iter().all(|record| record.recipe_id.is_none()));
        assert!(session.sources.iter().all(|record| record.recipe_digest.is_none()));
    }
```

and in `cache.rs`'s (or wherever `provenance_digest` is exercised):

```rust
    #[test]
    fn the_recipe_digest_is_part_of_the_cache_key() {
        assert_ne!(
            provenance_for_recipe("flight-h5", "aaaa"),
            provenance_for_recipe("flight-h5", "bbbb")
        );
    }
```

Write `record_with_recipe`, `record_without_recipe`, `resolved`, and
`provenance_for_recipe` as local helpers; `ResolvedRecipe` needs a parsed
`Recipe`, so build one with `parse_recipe` on a two-line sample.

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core recipe_status` and `./scripts/test.sh core restore::`
Expected: FAIL — `a_source_with_no_recorded_recipe...` fails against the
current `Changed` classification; the helpers do not exist.

- [ ] **Step 3: Implement it**

Fix the disagreement in `recipe_status` so the batch behavior is the one
encoded:

```rust
        (None, None, _) => RecipeStatus::Matched,
```

replacing the `(None, None, None)` arm, so a first import with a
newly-resolved recipe is `Matched` regardless.

Then replace the inline comparison in `batch.rs:586-630` with a call:

```rust
                Ok(Some(resolved)) => {
                    match crate::restore::recipe_status(record, Some(&resolved)) {
                        crate::restore::RecipeStatus::Matched => {}
                        status => {
                            return Err(ProcessError::Failed(
                                crate::restore::restore_source(record, Some(&resolved))
                                    .expect_err("non-matched status always errors")
                                    .to_string(),
                            ));
                        }
                    }
                    provider_id = Some(format!("recipe:{}", resolved.recipe.id));
                    // ... unchanged registration ...
                }
                Ok(None) if record.recipe_id.is_some() || record.recipe_digest.is_some() => {
                    return Err(ProcessError::Failed(
                        crate::restore::restore_source(record, None)
                            .expect_err("a missing recipe always errors")
                            .to_string(),
                    ));
                }
```

`batch.rs` reads `crate::session::SourceRecord` while `recipe_status` takes
the same type, so no conversion is needed — confirm the import path and adjust
the binding if the batch worker holds `sources::SourceRecord` instead.
`RecipeRestoreError`'s `Display` text must keep the words "reconfirm" and
"relink", since both the tests and the user-facing message depend on them.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core restore::`, `./scripts/test.sh core session::`,
then `./scripts/test.sh core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src
git commit -m "fix(restore): use one recipe-status implementation and test it"
```

---

### Task 7: The wizard cannot strand a batch, guess a timebase, or trap the user

**Files:**

- Modify: `protocol/schema/scope-protocol.json`,
  `core/scope-core/src/ingest/mod.rs`,
  `core/scope-core/src/ingest/container/{hdf5,parquet}.rs`,
  `shell/src-tauri/src/lib.rs`, `frontend/src/ui/app-shell.ts:1735-1745`,
  `frontend/src/ui/import-wizard.ts`
- Regenerate: `./scripts/codegen.sh`

**Interfaces:**

- Produces: `IngestError::RecipeRequired { container: String }`;
  `BatchFailure` gains `recipe_required: bool` (protocol 16 → 17);
  `ImportWizard.close()`; `ImportWizard.mount` failures are contained.

Three findings that share one seam. (a) `monotonicPreview([])` is vacuously
true and `read_preview_f64` returns empty for any `shape.len() != 1`, so the
largest multidimensional dataset outranks a genuine time column unless one is
literally named `time`/`t`/`timestamp`. (b) The mount trigger matches error
**text**, so an unrelated unsupported file reaches `ImportWizard.mount`, whose
`introspect_container` throws "unsupported container magic"; the throw jumps
past `reloadSignals()`, so dropping twenty good CSVs plus one unknown binary
ingests the CSVs and never displays them, while reporting a misleading
message. (c) The wizard appends to `document.body` with no close button, no
Escape handler, and no removal path — once mounted it stays until reload.

- [ ] **Step 1: Write the failing test**

Frontend, in `import-wizard.test.ts`:

```ts
it("never proposes a dataset with no preview evidence as the timebase", () => {
  const wizard = ImportWizard.fromOutline({
    container: "hdf5",
    datasets: [
      // A large 2-D dataset: read_preview_f64 returns [] for shape.len() != 1.
      {
        path: "run/image",
        kind: "numeric",
        len: "1000000",
        shape: [1000, 1000],
        sample_preview: [],
      },
      {
        path: "run/elapsed",
        kind: "numeric",
        len: "300",
        shape: [300],
        sample_preview: [0, 0.1, 0.2],
      },
    ],
  });
  expect(wizard.proposedTime()).toBe("run/elapsed");
});

it("closes on Escape and removes itself from the document", () => {
  const wizard = ImportWizard.fromOutline(outline);
  document.body.append(wizard.render());
  expect(document.querySelector(".import-wizard")).not.toBeNull();

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

  expect(document.querySelector(".import-wizard")).toBeNull();
});
```

Frontend, in `app-shell.test.ts`, extending the drop probes from the
drag-and-drop work:

```ts
it("still reloads signals when the wizard fails to mount", async () => {
  const probe = dropProbe(scanIngest(["/runs/a.csv"]));
  probe.reloadSignals = vi.fn(async () => undefined);
  probe.plane = {
    ingest: {
      ...scanIngest(["/runs/a.csv"]),
      introspect: () =>
        Promise.reject(new Error("unsupported container magic")),
    },
  };

  await probe.ingestPathsReal(["/runs"], {
    recent_failures: [
      {
        path: "/runs/mystery.bin",
        error: "unsupported format",
        recipe_required: false,
      },
    ],
  });

  expect(probe.reloadSignals).toHaveBeenCalled();
});

it("opens the wizard only for a failure flagged recipe_required", async () => {
  // recipe_required false → no introspection attempt at all
});
```

Rust, in `hdf5.rs`:

```rust
    #[test]
    fn an_hdf5_file_without_a_recipe_reports_that_a_recipe_is_required() {
        let error = Hdf5Decoder.decode(&fixture_path(), &mut context()).unwrap_err();
        assert!(matches!(error, IngestError::RecipeRequired { .. }));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit import-wizard`, `./scripts/test.sh unit app-shell`,
`./scripts/test.sh core hdf5`
Expected: FAIL — `proposedTime` returns `run/image`; no Escape handling;
`RecipeRequired` not found.

- [ ] **Step 3: Implement it**

Schema (`scope-protocol.json`): bump `protocol_version` 16 → 17 and add to
`BatchFailure`:

```json
        "recipe_required": "bool"
```

Run `./scripts/codegen.sh`.

Core: add `IngestError::RecipeRequired { container: String }` with a message
naming the container, and return it from `Hdf5Decoder::decode` and
`ParquetDecoder::decode` in place of today's `UnsupportedFormat` string.
Populate `BatchFailure.recipe_required` from
`matches!(error, IngestError::RecipeRequired { .. })` where the batch worker
builds failures.

`app-shell.ts`: gate on the flag and contain the failure.

```ts
const needsRecipe = status.recent_failures.find(
  (failure) => failure.recipe_required,
);
if (needsRecipe !== undefined && typeof port.introspect === "function") {
  try {
    await ImportWizard.mount(this.plane, needsRecipe.path);
  } catch (error: unknown) {
    this.reportError(error);
  }
}
keepProgress = status.recent_failures.length > 0;
await this.reloadSignals();
this.afterLayoutChange();
```

`import-wizard.ts`: require preview evidence, and give the wizard a lifecycle.

```ts
function monotonicPreview(values: readonly number[]): boolean {
  // An empty preview is not evidence of monotonicity: read_preview_f64
  // returns nothing for multidimensional datasets.
  if (values.length === 0) return false;
  return values.every(
    (value, index) =>
      Number.isFinite(value) &&
      (index === 0 || value >= (values[index - 1] ?? value)),
  );
}
```

Add to the class: a `close()` that removes the rendered element and detaches
its listeners, an Escape handler registered in `render()`, a close button in
the wizard's action row, and a `close()` call after a successful save. Follow
`SourceOpenDialog`'s deleted pattern for focus restoration: capture
`document.activeElement` on mount and restore it on close.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core`, `./scripts/test.sh shell`,
`./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core shell frontend/src
git commit -m "fix(ui): flag recipe-required failures and give the wizard a lifecycle"
```

---

## Phase F3 — Platform and polish

Phase gate: the Windows job builds, the minor findings are closed, and the
docs no longer claim more than the code does.

### Task 8: HDF5 on the Windows build

**Files:**

- Modify: `core/scope-core/Cargo.toml` (or `Cargo.toml` workspace deps),
  `scripts/build-windows.sh`, `deny.toml` if a license appears
- Modify: `README.md` (build prerequisites)

**Interfaces:**

- Produces: a Windows build that compiles `hdf5-metno` without a
  system HDF5 installation.

Finding: `.github/workflows/ci.yml:178-197` runs `./scripts/ci.sh windows` on
`windows-latest`, and nothing on that path provides HDF5.
`hdf5-metno-sys`'s build script panics with "Unable to locate HDF5 root
directory and/or headers." The job is gated `if: github.event_name != 'pull_request'`,
so it never runs on a PR — the first red build lands on **main**, and the NSIS
artifact step (`if-no-files-found: error`) fails with it. `flake.nix:29-100`
and `scripts/setup-appimage.sh:32` provision HDF5 for the other two targets;
Windows was missed. This is a defect in the original plan, whose constraint
named only those two files.

Recommended fix: build HDF5 from source on Windows only, via the crate's
`static` feature (`hdf5-metno` 0.10 exposes `static = ["hdf5-sys/static"]`,
which vendors the sources and builds them with CMake — available on
`windows-latest`). This keeps Linux and the Nix dev shell on the system
library and avoids shipping a DLL beside the installer.

- [ ] **Step 1: Add the target-specific feature**

In the workspace `Cargo.toml`, keep the base dependency as-is and add a
Windows-only override in `core/scope-core/Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
hdf5-metno = { workspace = true, features = ["static"] }
```

Cargo unions features per target, so Linux and macOS builds are unchanged.

- [ ] **Step 2: Document the prerequisite**

`scripts/build-windows.sh` already checks for `cargo`, `node`, and `npm`
(`:16`). Extend that loop to include `cmake`, so a missing CMake fails with
the script's own clear message rather than deep inside a build script. Add a
line to `README.md`'s build prerequisites naming CMake for Windows builds and
`libhdf5-dev` / the Nix shell for Linux.

- [ ] **Step 3: Verify what can be verified locally**

Run: `./scripts/ci.sh quality`
Expected: PASS — `cargo deny check` must stay green. If vendoring HDF5 sources
surfaces a new license, add it to `deny.toml` with a comment naming the crate,
and note that HDF5's own license is BSD-3-Clause-style; confirm rather than
assume.

**This task cannot be fully verified on Linux.** Do not claim the Windows
build passes. State in the commit message that the change is unverified on
Windows and needs a `main`-branch or manual `workflow_dispatch` run.

- [ ] **Step 4: Get real Windows verification before merging**

Either run the `windows` job manually against the branch, or temporarily
remove its `if: github.event_name != 'pull_request'` guard on a scratch PR to
prove it builds. Merging without one of these repeats the failure this task
exists to prevent.

Consider, separately from this plan, dropping that `if:` guard permanently —
it is why the breakage was invisible in the first place.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core/Cargo.toml scripts/build-windows.sh README.md deny.toml
git commit -m "build(windows): build HDF5 from source on the Windows target"
```

---

### Task 9: Minor findings

**Files:**

- Modify: `core/scope-core/src/ingest/recipe/decode.rs:144-165`, `:246-251`,
  `core/scope-core/src/ingest/recipe/resolve.rs:33-38`, `:56`,
  `core/scope-core/src/ingest/container/hdf5.rs`,
  `core/scope-core/src/ingest/mod.rs:246`,
  `shell/src-tauri/src/lib.rs:327`, `:391`, `:724`,
  `frontend/src/ui/app-shell.ts:3194`,
  `frontend/src/ui/import-wizard.ts:293-302`

Each item below is independent; commit them together.

- [ ] **Step 1: Reject empty normalized names**

`decode.rs:246-251`'s `signal_name` filters out empty normalized segments, so
a dataset path that normalizes away entirely yields an empty local path, which
is inserted into `names` without complaint. Return
`RecipeError::InvalidSelector` (or a new `EmptyName` arm) instead. Test: a
dataset named `"///"` errors rather than producing a nameless signal.

- [ ] **Step 2: Compute `row_count` across all signals**

`decode.rs:165` takes `signals[0].values.len()`, so with per-group sibling
timebases of differing lengths it reports only the first group's count — and a
zero-length dataset later in the list escapes the `NoDataRows` check. Use the
maximum, and check every signal for emptiness. Test: two sibling groups of
lengths 2 and 5 report 5.

- [ ] **Step 3: Do not follow symlinked sidecars, and stop echoing their contents**

`resolve.rs:56` uses `is_file()`, which follows symlinks; `ResolveError::Parse`
(`:33-38`) interpolates the toml error, which quotes the offending source
line — so a symlink to `~/.ssh/id_ed25519` prints a private key line into the
batch failure list. Use `symlink_metadata()` and require
`file_type().is_file()`, and truncate the toml error to its message without
the source excerpt. Test: a symlinked sidecar resolves to `None`; a malformed
sidecar's error contains neither the file's contents nor a `|` excerpt marker.

- [ ] **Step 4: Bound recipe and outline sizes**

Add a maximum recipe file size (256 KiB) and selection count (1,024) in
`parse_recipe`, and a maximum id length (128) in `validate`. A 200,000-selection
recipe currently parses in 2.8 s and a 200,000-character id becomes a provider
id and a filename. Also cap `unit` and attribute strings at a sane length in
`decode.rs` — a 4 MB HDF5 attribute currently flows unmodified into
`DecodedSignal.unit`. Test each limit at its boundary.

- [ ] **Step 5: Reuse one container handle for introspection**

`shell/src-tauri/src/lib.rs:350-361` calls `read_preview_f64` per dataset, and
`Hdf5Container::read_preview_f64` reopens the file each time — 20,000 datasets
cost 3.28 s and 20,000 reopens. With `MAX_DATASET_ENTRIES` from Task 2 the
worst case is bounded, but the reopen-per-read remains. Document why the
handle is not cached (the `hdf5` handle is not `Send + Sync`, which
`ContainerReader` requires) in a comment on `Hdf5Container::path` so the next
reader does not mistake it for an oversight.

- [ ] **Step 6: Run introspection and recipe saving off the command thread**

`shell/src-tauri/src/lib.rs:327` and `:391` run synchronously on the command
thread, unlike `pick_sources`. Wrap both in `tauri::async_runtime::spawn_blocking`
as the surrounding commands do.

- [ ] **Step 7: Hoist the descriptor list out of the scan loop**

`shell/src-tauri/src/lib.rs:724`'s `format_label` calls `registry.descriptors()`
per path, and `descriptors()` sorts and allocates each call — O(files) sorts
during a folder scan. Compute the list once per scan and pass it in.

- [ ] **Step 8: Derive the empty-state format hint from the registry**

`frontend/src/ui/app-shell.ts:3194` hardcodes `"CSV · MCAP"`, which now
under-reports. Build it from the cached `listFormats()` response.

- [ ] **Step 9: Escape control characters in generated TOML**

`import-wizard.ts:293-302`'s `quoteToml` escapes `\`, `"`, and `\n` but not
other control characters, which are illegal in TOML basic strings — a dataset
path containing a tab produces invalid TOML that fails opaquely in
`save_recipe`. Escape the full C0 range. Test: a name containing `\t` and
`` round-trips through `parse_recipe`.

- [ ] **Step 10: Fix the two tests that verify nothing**

`decode.rs:392-396` asserts `same_values`, which falls back to element-wise
comparison (`columns.rs:115`), so the shared-timebase memory guarantee is
unprotected. Assert `std::sync::Arc::ptr_eq` on the two time columns directly.
`hdf5.rs:221-231`'s `a_matlab_v7_3_file_opens_as_hdf5` writes a plain HDF5
file, so MATLAB support — advertised in `README.md` and ADR 0034 — is
untested. Either commit a small real `.mat` fixture and assert against its
`#refs#`/`MATLAB_class` structure, or delete the test and remove the MATLAB
claim from the README and ADR until a fixture exists. Do not leave the claim
standing on a test that does not test it.

- [ ] **Step 11: Resolve the two stale test names**

`ingest/mod.rs:246`'s `dispatch_treats_short_files_as_csv` was slated for
deletion in the original plan's Task 2; it still passes, so either delete it
or rename it to describe what it now asserts.
`resolve.rs:226-234`'s `a_recipe_directory_outside_the_configured_root_is_ignored`
tests a nonexistent path, not containment — rename it to
`a_missing_recipe_directory_resolves_to_none`.

- [ ] **Step 12: Run the tests and commit**

Run: `./scripts/test.sh core`, `./scripts/test.sh shell`,
`./scripts/test.sh frontend`
Expected: PASS.

```bash
git add core shell frontend/src
git commit -m "fix(ingest): close the minor review findings"
```

---

### Task 10: Docs, gate, and version

**Files:**

- Modify: `docs/adr/0033-format-provider-registry.md`,
  `docs/adr/0034-declarative-container-recipes.md`,
  `docs/superpowers/plans/2026-07-30-extensible-ingest.md`,
  `docs/implementation-roadmap.md`

- [ ] **Step 1: Correct the ADRs**

ADR 0034 claims every recipe struct denies unknown fields — true only after
Task 1; keep the claim and note the enforcement is pinned by a
nesting-exhaustive test. Add to ADR 0034: container limits are part of the
trust boundary (depth, entry count, declared size, hard-links-only), and
recipes cannot reach outside a container **because the reader refuses external
links**, not because the selector validator alone prevents it. Add to ADR 0033
that Parquet claims only a leading magic and why. If Task 9 Step 10 removed
the MATLAB claim, amend ADR 0034 and `README.md` to match.

- [ ] **Step 2: Record the deviations in the source plan**

Append a short "Implementation notes" section to
`docs/superpowers/plans/2026-07-30-extensible-ingest.md` recording the four
places its own text was wrong: the Parquet `ends_with` magic model, the
`Arc::ptr_eq` assertion weakened to `same_values`, the `SelectionError::Unsupported`
wizard trigger that became unreachable once hdf5/parquet providers claimed
`Certain`, and the missing Windows constraint. A plan that misled once will
mislead again if the record is only in a review transcript.

- [ ] **Step 3: Run the full gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS, including `pnpm codegen:check`, `cargo deny check`,
`cargo machete`, and `check:deps`.

- [ ] **Step 4: Bump and commit**

```bash
./scripts/version.sh bump minor   # additive protocol field (BatchFailure)
./scripts/version.sh check
git add docs Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the ingest review fixes"
```

**Open decision, do not resolve silently:** `AGENTS.md` says schema and
protocol changes take a **major** bump, while the shipped B1–B3 work took
`0.17.1 → 0.19.0` (two minors) under the original plan's explicit override,
and Task 7 adds another additive protocol field. Confirm with the maintainer
whether additive schema changes stay minor; if they should be major, this
task's bump and the two already-shipped ones need correcting together. Flag
the answer in `AGENTS.md` so the next plan does not re-litigate it.

---

## Deferred (explicitly out of scope)

- **Threading `MemoryBudget` into `ContainerReader`.** Task 3 installs a fixed
  ceiling, which is what stops the abort. Deriving the allowance from the
  batch worker's live ticket is the correct long-term design and a larger
  refactor of the trait's signature.
- **Bounding recipe decode's selections × datasets product.** Measured at
  30 s for 20,000 × 20,000. It is cancellable at `decode.rs:119` and Task 9
  Step 4 caps selections, so the product is now bounded; a proper match budget
  belongs with the `MemoryBudget` work.
- **Token-based HDF5 cycle detection.** The depth cap makes cycles safe;
  precise detection would only improve the error message, and
  `LocationToken` is not `Hash`.
- **Removing the `if: github.event_name != 'pull_request'` guard on the
  Windows job.** Noted in Task 8; it is a CI-policy change worth its own
  decision.

---

## Self-Review

**Finding coverage.** Windows build → Task 8. HDF5 unbounded recursion → Task 2. Container allocation from declared size → Task 3. HDF5 external links →
Task 2. `save_recipe` symlink write → Task 4. `TimeSource` unknown fields →
Task 1. Dead/duplicated recipe-status plus Task 12's four missing tests → Task 6. Parquet magic false positive → Task 5. Wizard timebase, mount failure, and
dismissal → Task 7. Symlinked sidecar and error disclosure, unbounded recipe
and attribute sizes, introspection cost, decode quadratic, `row_count`, empty
names, `quoteToml`, descriptor hoisting, `spawn_blocking`, hardcoded format
hint, the two vacuous tests, the two stale test names → Task 9. ADR and plan
corrections, version decision → Task 10. The two performance items the review
raised that are not fixed here are in Deferred with reasons.

**Placeholder scan.** Every step has concrete code or an exact command. The
one genuinely open question — the major-vs-minor version policy — is stated as
a decision requiring the maintainer, not as a TBD to be guessed.

**Type consistency.** `MAX_GROUP_DEPTH`/`MAX_DATASET_ENTRIES` (Task 2) and
`MAX_DATASET_BYTES`/`check_declared_size` (Task 3) are defined once in
`container/mod.rs` and referenced by those names afterward.
`ContainerError::Unsupported` is the single error arm for all four limits.
`IngestError::RecipeRequired { container: String }` (Task 7) is produced by
both container decoders and consumed as `BatchFailure.recipe_required: bool`.
`restore::{RecipeStatus, recipe_status, restore_source}` (Task 6) keep their
shipped signatures; only the `(None, None, _)` arm changes.
`write_recipe_file`/`sidecar_destination` (Task 4) are new shell-local
helpers used by `save_recipe` only.

**Ordering.** Tasks 1–5 are independent and can run in any order or in
parallel. Task 6 is independent. Task 7 depends on nothing but touches the
protocol, so run it before Task 10's version bump. Task 9 Step 5 references
`MAX_DATASET_ENTRIES` from Task 2. Task 10 must run last.
