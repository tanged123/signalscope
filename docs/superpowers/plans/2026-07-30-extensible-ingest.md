# Extensible Ingest Implementation Plan (Part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let developers add decoders cheaply and let non-developer users
describe arbitrary container layouts (`.mat`, `.h5`, Parquet) without writing
Rust, without ever letting untrusted data name executable code.

**Architecture:** Three tiers. Tier 0 replaces the hard-coded `SourceFormat`
enum with a registry of format providers whose selection is deterministic and
independent of registration order, and which fails closed on input nothing
claims. Tier 1 adds generic container readers plus a declarative TOML **recipe**
that maps container contents to signals, resolved from a data-directory sidecar
or a user recipe directory, recorded in the session by id and content digest.
Tier 2 (sandboxed parser plugins) is a spec-writing deliverable here, not an
implementation.

**Tech Stack:** Rust 2024 (`scope-core`), `toml`, `hdf5-metno`, `parquet`/`arrow`,
system `libhdf5` via the Nix flake, JSON-schema codegen for
protocol/session/preferences, TypeScript frontend for the import wizard.

## Global Constraints

- **Part A (`2026-07-30-multi-source-scale.md`) is complete.** Its seams exist
  today: `Decoder::decode(&self, &Path, &mut DecodeContext) -> Result<DecodedSource, IngestError>`
  (`ingest/mod.rs`), `ingest::provenance::{ProviderInfo, provenance_digest}`,
  `ingest::provider_for(SourceFormat)` (`ingest/mod.rs:72` — the lookup Task 2
  replaces), `sources::SourceRecord` (`provider_id`, `decode_provenance`,
  `set_provenance`), the batch executor (`ingest/batch.rs`), `list_formats`
  serving `FormatDescriptor { id, label, extensions }` (`id` is currently the
  first extension; registry descriptors supply stable provider ids), and
  `./scripts/test.sh core|shell|unit <filter>`.
- **Drag-and-drop and direct open landed 2026-08-02**
  (`2026-08-02-dragdrop-and-direct-open.md`, ADR 0032). Window drops and
  `Open folder…` both expand through the shell's `scan_sources`, whose
  `supported_path`/`format_label` accept check is extension-based today and
  must move to the registry (Task 2), and
  `frontend/src/app/drop.ts::unsupportedDropMessage` already names formats
  from `list_formats`, so the drop path picks up new formats with no frontend
  change (Task 3).
- Every command goes through `./scripts/*`.
- `protocol/schema/*.json` is the single schema source; never hand-edit generated
  Rust or TypeScript; keep `pnpm codegen:check` green.
- Parsing happens **only** in the native host. No format, recipe, container, or
  plugin concept ever reaches the frontend renderer or a snapshot.
- **A recipe is data, and that is enforced, not asserted.** A recipe selects
  datasets, timebases, names, and units. It can never name an executable,
  plugin, decoder binary, shell command, or filesystem path outside its own
  container, because sidecar recipes arrive with untrusted data directories.
- Untrusted names (dataset paths, recipe-supplied signal names, container
  attributes) are data: normalized through `naming::normalize_segment`, inserted
  with `textContent`, never concatenated into HTML.
- Time columns must be finite and monotonically nondecreasing; recipe-driven
  ingest validates them exactly like CSV ingest.
- Provider selection is deterministic: explicit priority first, stable provider
  id as the tie-break, never registration order.
- Changing a provider, its cache-ABI, or a recipe's content digest must
  invalidate cached columns.
- New dependencies pass `cargo deny check` (allow list: Apache-2.0,
  Apache-2.0 WITH LLVM-exception, BSD-3-Clause, MIT, MPL-2.0, Unicode-3.0, Zlib)
  and `cargo machete`. System libraries are added to `flake.nix` **and**
  `scripts/setup-appimage.sh`, never assumed present.
- Each phase ends with `./scripts/format.sh`, the affected suite, and
  `./scripts/version.sh bump <major|minor|patch>` + `./scripts/version.sh check`.

---

## File Structure

**New in `core/scope-core/src/`:**

| File                          | Responsibility                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| `ingest/registry.rs`          | `FormatProvider`, `ProviderRegistry`, deterministic sniff-and-select.      |
| `ingest/container/mod.rs`     | `ContainerReader` trait, `DatasetPath`, `DatasetKind`, introspection tree. |
| `ingest/container/hdf5.rs`    | HDF5 (and MATLAB v7.3) reader.                                             |
| `ingest/container/parquet.rs` | Parquet/Arrow reader.                                                      |
| `ingest/recipe/mod.rs`        | Recipe model, validation, content digest.                                  |
| `ingest/recipe/resolve.rs`    | Sidecar → user-directory resolution order.                                 |
| `ingest/recipe/decode.rs`     | Recipe-driven `Decoder` over any `ContainerReader`.                        |

**Modified:** `ingest/mod.rs` (registry dispatch replaces `sniff_format`),
`ingest/{csv,mcap}.rs` (become providers), `ingest/provenance.rs`
(`provider_for` → registry lookup), `cache.rs`, `preferences.rs`, `session.rs`,
`shell/src-tauri/src/lib.rs`, `protocol/schema/*.json`,
`frontend/src/app/drop.test.ts`,
`frontend/src/ui/{app-shell,import-wizard}.ts`, `flake.nix`,
`scripts/setup-appimage.sh`, `docs/adr/*`.

---

## Phase B1 — decoder registry (spec Tier 0)

Phase gate: formats register at runtime, dispatch is deterministic, binary
garbage no longer parses as CSV, and a source records which provider decoded it.

### Task 1: Format provider registry

**Files:**

- Create: `core/scope-core/src/ingest/registry.rs`
- Modify: `core/scope-core/src/ingest/mod.rs`

**Interfaces:**

- Consumes: `Decoder`, `DecodeContext`, `DecodedSource`, `provenance::ProviderInfo`.
- Produces: `registry::{FormatProvider, ProviderRegistry, Confidence, ProviderId,
SelectionError}`;
  `FormatProvider { id: &'static str or String, label, extensions, priority: i32,
cache_abi: u32, sniff(&[u8]) -> Confidence, decoder() -> Box<dyn Decoder> }`;
  `ProviderRegistry::{builtin(), register(provider), select(path) -> Result<&dyn Registered, SelectionError>,
descriptors()}`; `PROBE_BYTES: usize = 8 * 1024`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn probe_provider(id: &'static str, priority: i32, confidence: Confidence) -> FormatProvider {
        FormatProvider::new(id, "Test", &["tst"], priority, 1, move |_| confidence, || Box::new(NullDecoder))
    }

    #[test]
    fn selection_ignores_registration_order() {
        let high = probe_provider("zeta", 10, Confidence::Likely);
        let low = probe_provider("alpha", 1, Confidence::Likely);

        let mut forward = ProviderRegistry::empty();
        forward.register(high.clone());
        forward.register(low.clone());
        let mut backward = ProviderRegistry::empty();
        backward.register(low);
        backward.register(high);

        assert_eq!(forward.select_bytes(b"anything").unwrap().id(), "zeta");
        assert_eq!(backward.select_bytes(b"anything").unwrap().id(), "zeta");
    }

    #[test]
    fn equal_priority_and_confidence_break_ties_on_provider_id() {
        let mut registry = ProviderRegistry::empty();
        registry.register(probe_provider("beta", 5, Confidence::Likely));
        registry.register(probe_provider("alpha", 5, Confidence::Likely));
        assert_eq!(registry.select_bytes(b"x").unwrap().id(), "alpha");
    }

    #[test]
    fn certain_beats_priority_and_zero_confidence_never_claims() {
        let mut registry = ProviderRegistry::empty();
        registry.register(probe_provider("low-priority", 0, Confidence::Certain));
        registry.register(probe_provider("high-priority", 99, Confidence::Likely));
        assert_eq!(registry.select_bytes(b"x").unwrap().id(), "low-priority");

        let mut empty_claim = ProviderRegistry::empty();
        empty_claim.register(probe_provider("nobody", 99, Confidence::No));
        assert!(matches!(empty_claim.select_bytes(b"x"), Err(SelectionError::Unsupported { .. })));
    }

    #[test]
    fn the_probe_window_is_fixed_regardless_of_file_size() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(0_usize));
        let recorder = std::sync::Arc::clone(&seen);
        let mut registry = ProviderRegistry::empty();
        registry.register(FormatProvider::new("probe", "P", &["p"], 0, 1,
            move |bytes| { *recorder.lock().unwrap() = bytes.len(); Confidence::Likely },
            || Box::new(NullDecoder)));

        let file = write_bytes(&vec![b'x'; PROBE_BYTES * 4]);
        registry.select(file.path()).unwrap();
        assert_eq!(*seen.lock().unwrap(), PROBE_BYTES);
    }

    #[test]
    fn an_unsupported_input_names_the_known_formats() {
        let registry = ProviderRegistry::empty();
        let error = registry.select_bytes(b"\x00\x01\x02").unwrap_err();
        assert!(matches!(error, SelectionError::Unsupported { .. }));
        assert!(error.to_string().contains("known formats"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core registry::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the registry**

```rust
//! Runtime format registration. The justification is recipes and plugins, not
//! the (small) edit cost of a built-in: nothing could register a format at
//! runtime before.

/// How strongly a provider claims a probe window.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Confidence {
    /// The provider does not handle this input.
    No,
    /// Plausible: content is consistent with the format (a text gate, an
    /// extension hint) but not proven.
    Likely,
    /// Proven by magic bytes or an equivalent unambiguous signal.
    Certain,
}

/// Fixed probe window handed to every `sniff`. Deterministic and bounded, so
/// selection never depends on file size.
pub const PROBE_BYTES: usize = 8 * 1024;
```

`select` reads at most `PROBE_BYTES`, calls every provider's `sniff`, discards
`Confidence::No`, and takes the maximum of the tuple
`(confidence, priority, Reverse(id))` — confidence first, then explicit
priority, then the stable provider id ascending. Zero candidates produce
`SelectionError::Unsupported { path, known: Vec<String> }` whose `Display` lists
the known formats. `descriptors()` yields `(id, label, extensions, priority)`
for `SUPPORTED_FORMATS`, the file picker, and the protocol listing.

`ProviderRegistry::builtin()` registers the CSV and MCAP providers (Task 2) and
is what the shell constructs at startup; `register` is what recipes (Task 10)
and future plugins call.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core registry::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest
git commit -m "feat(ingest): add a runtime format provider registry"
```

---

### Task 2: Built-in providers and fail-closed dispatch

**Files:**

- Modify: `core/scope-core/src/ingest/{mod,csv,mcap}.rs`,
  `core/scope-core/src/ingest/provenance.rs`, `core/scope-core/src/cache.rs`

**Interfaces:**

- Produces: `csv::provider() -> FormatProvider`, `mcap::provider() -> FormatProvider`;
  `ingest::dispatch(registry, path, context) -> Result<(ProviderInfo, DecodedSource), IngestError>`;
  `IngestError::UnsupportedFormat(String)`. Removes `SourceFormat`,
  `sniff_format`, and the static `SUPPORTED_FORMATS` table (now
  `registry.descriptors()`).

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn mcap_magic_is_certain_and_wins_over_the_text_gate() {
        let registry = ProviderRegistry::builtin();
        let mut bytes = b"\x89MCAP0\r\n".to_vec();
        bytes.extend_from_slice(b"time,value\n0,1\n");
        assert_eq!(registry.select_bytes(&bytes).unwrap().id(), "mcap");
    }

    #[test]
    fn short_text_files_still_load_as_csv() {
        let registry = ProviderRegistry::builtin();
        assert_eq!(registry.select_bytes(b"a,b\n1,2\n").unwrap().id(), "csv");
        assert_eq!(registry.select_bytes(b"t\tv\n0\t1\n").unwrap().id(), "csv");
        assert_eq!(registry.select_bytes(b"# note\ntime,value\n0,1\n").unwrap().id(), "csv");
    }

    #[test]
    fn binary_garbage_fails_closed_instead_of_parsing_as_csv() {
        let registry = ProviderRegistry::builtin();
        let error = registry.select_bytes(&[0_u8, 1, 2, 3, 0xFF, 0xFE, 0x00, 0x7F]).unwrap_err();
        assert!(matches!(error, SelectionError::Unsupported { .. }));
        assert!(error.to_string().contains("csv"));
        assert!(error.to_string().contains("mcap"));
    }

    #[test]
    fn utf8_text_with_no_delimiter_is_still_claimed_by_csv() {
        // A single-column log is text; CSV rejects it later with TooFewColumns,
        // which is a decode error, not a dispatch fallthrough.
        let registry = ProviderRegistry::builtin();
        assert_eq!(registry.select_bytes("temperature\n21.5\n".as_bytes()).unwrap().id(), "csv");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core registry::builtin`
Expected: FAIL — `builtin` not found.

- [ ] **Step 3: Implement the providers and the text gate**

```rust
/// CSV claims anything that passes a text-plausibility gate: valid UTF-8 in the
/// probe window (allowing a truncated trailing sequence), no NUL bytes, and at
/// most `MAX_CONTROL_RATIO` of bytes outside tab/newline/carriage-return and
/// printable ASCII+UTF-8. Deliberate behavior change from the previous
/// test-locked total dispatch, where binary garbage parsed as CSV.
fn text_confidence(probe: &[u8]) -> Confidence { … }
```

MCAP's `sniff` returns `Certain` on the 8-byte magic, otherwise `No`. CSV
returns `Likely` when the gate passes, otherwise `No`; its priority is the
lowest of the built-ins so any future container provider wins on a tie.
`ingest::provider_for` is replaced by
`ProviderInfo { id: registered.id().to_owned(), cache_abi: registered.cache_abi() }`
— **the digest inputs and therefore existing cache entries are unchanged for
`csv` and `mcap`.** Change `ProviderInfo::id` from `&'static str` to `String`
in the same commit so runtime-registered providers fit.

Update `ingest::dispatch`, `cache::ingest_or_load`, `scope-bake`, and the shell
to thread an `&ProviderRegistry`. In the shell that includes the
`supported_path`/`format_label` accept check behind `scan_sources` — the path
both `Open folder…` and window drag-drop expand through — which must derive
from `registry.descriptors()` in this commit, since `SUPPORTED_FORMATS` is
deleted here. Delete the now-wrong
`dispatch_treats_short_files_as_csv` test and replace it with the four above.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core` then `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "feat(ingest): dispatch through providers and fail closed on unknown input"
```

---

### Task 3: Registry-derived formats in the picker and protocol

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`
- Test: `frontend/src/app/drop.test.ts`

**Interfaces:**

- Consumes: `FormatDescriptor` (shipped; `list_formats` serves it today from
  `SUPPORTED_FORMATS` with the first extension standing in for `id`),
  `registry.descriptors()`, `drop.ts::unsupportedDropMessage` (shipped).
- Produces: `format_descriptors(&ProviderRegistry) -> Vec<FormatDescriptor>`
  with stable provider ids; `list_formats` and `pick_sources`' filters serve
  from it, so the picker, folder open, and window drag-drop agree with
  dispatch.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn the_picker_filters_come_from_the_registry_not_a_static_table() {
        let mut registry = ProviderRegistry::builtin();
        registry.register(FormatProvider::new("hdf5", "HDF5 containers", &["h5", "hdf5"], 5, 1,
                                              |_| Confidence::No, || Box::new(NullDecoder)));
        let descriptors = format_descriptors(&registry);

        assert!(descriptors.iter().any(|entry| entry.id == "hdf5"));
        let extensions: Vec<_> = descriptors.iter().flat_map(|entry| entry.extensions.clone()).collect();
        assert!(extensions.contains(&"h5".to_owned()));
        assert!(extensions.contains(&"csv".to_owned()));
    }
```

```ts
it("names newly registered formats in the unsupported-drop message", async () => {
  const port = scanningPort({}); // extend the existing drop.test.ts fake so
  // listFormats returns a registered container format alongside the built-ins:
  // [{ id: "csv", label: "Delimited text", extensions: ["csv", "tsv"] },
  //  { id: "hdf5", label: "HDF5 containers", extensions: ["h5", "hdf5"] }]
  const message = await unsupportedDropMessage(port);
  expect(message).toContain(".h5");
  expect(message).toContain(".csv");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh shell format_descriptors` and `./scripts/test.sh unit drop`
Expected: Rust FAIL — `format_descriptors` not found. The drop-message test
passes immediately — `unsupportedDropMessage` already renders whatever
`list_formats` returns; the test pins that seam so a registry regression
surfaces in the frontend suite.

- [ ] **Step 3: Implement it**

`format_descriptors` maps `registry.descriptors()` to `FormatDescriptor`,
with real provider ids replacing today's first-extension stand-in.
`list_formats` and `pick_sources`' filters (combined filter first, then one
per format) serve from it. No frontend change: `unsupportedDropMessage`
already names formats from `list_formats`, and the native accept check behind
`scan_sources` moved to the registry in Task 2, so the picker, folder open,
and drops stay in agreement.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh shell` and `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shell/src-tauri/src/lib.rs frontend/src
git commit -m "feat(shell): derive picker filters and format listing from the registry"
```

---

### Task 4: Reopen reproduces the recorded provider

**Files:**

- Modify: `core/scope-core/src/cache.rs`, `core/scope-core/src/restore.rs`,
  `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `SourceRecord.{provider_id, decode_provenance}`.
- Produces: `ingest::dispatch_with_provider(registry, provider_id, path, context)`;
  `IngestError::ProviderUnavailable { provider_id }`;
  `restore::LegacyNaming` gains an unknown-provider arm that reports rather than
  guesses.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn reopen_uses_the_recorded_provider_and_never_sniffs_another() {
        let mut registry = ProviderRegistry::builtin();
        registry.register(always_claiming_provider("greedy", 100));
        let record = record_with_provider("csv");

        let (info, _) = dispatch_with_provider(&registry, record.provider_id.as_deref().unwrap(),
                                               &record.path, &mut context()).unwrap();
        assert_eq!(info.id, "csv", "the greedy provider must not win on reopen");
    }

    #[test]
    fn a_missing_provider_reports_instead_of_falling_back() {
        let registry = ProviderRegistry::builtin();
        let error = dispatch_with_provider(&registry, "acme-lab-format", &path(), &mut context()).unwrap_err();
        assert!(matches!(error, IngestError::ProviderUnavailable { .. }));
        assert!(error.to_string().contains("acme-lab-format"));
    }

    #[test]
    fn a_provider_change_invalidates_the_cache_for_that_source() {
        let first = ingest_with_provider("csv");
        let second = ingest_with_provider("csv-v2");
        assert_ne!(first.provenance, second.provenance);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core dispatch_with_provider`
Expected: FAIL — function not found.

- [ ] **Step 3: Implement it**

Restore paths call `dispatch_with_provider` whenever the record carries a
`provider_id`; only a brand-new import sniffs. A missing provider surfaces the
source as unavailable with its `reconcile_legacy` marker intact, so a later
retry or relocation can finish the conversion (Part A Task 16 already handles
the unresolved case).

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core` and `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src shell/src-tauri/src/lib.rs
git commit -m "feat(ingest): reopen sources with their recorded provider"
```

---

### Task 5: Phase B1 ADR and version bump

**Files:**

- Create: `docs/adr/0033-format-provider-registry.md` (0030–0032 are taken:
  source-local channel identity, remove-source-alignment, drag-drop event
  forwarding)
- Modify: `docs/adr/README.md`, `docs/adr/0009-ingest-jobs-and-progress.md`
  (dispatch note), `docs/implementation-roadmap.md`

- [ ] **Step 1: Write ADR 0033**

Record: the registry replaces the enum; the fixed probe window; the
`(confidence, priority, id)` selection order and why order-independence matters
once recipes register at runtime; the CSV text-plausibility gate and the
deliberate behavior change from total dispatch to fail-closed; per-provider
cache-ABI versions; and that reopen reproduces the recorded provider or reports
it unavailable.

- [ ] **Step 2: Run the gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS.

- [ ] **Step 3: Bump and commit**

```bash
./scripts/version.sh bump minor   # new capability, no schema break
./scripts/version.sh check
git add docs Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the format provider registry decision"
```

---

## Phase B2 — container readers and recipes (spec Tier 1, P4)

Phase gate: an `.h5` or `.mat` file with a project layout loads from a TOML
recipe, or through a wizard that writes one, and the session records exactly
which recipe produced which signals.

### Task 6: Container reader boundary

**Files:**

- Create: `core/scope-core/src/ingest/container/mod.rs`
- Modify: `core/scope-core/src/ingest/mod.rs`

**Interfaces:**

- Produces: `container::{ContainerReader, DatasetEntry, DatasetKind, ContainerError}`;
  `ContainerReader::{open(&Path) -> Result<Self, ContainerError>, datasets() ->
&[DatasetEntry], read_f64(&DatasetPath) -> Result<Vec<f64>, ContainerError>,
attribute(&DatasetPath, name) -> Option<String>}`;
  `DatasetEntry { path: String, kind: DatasetKind, len: usize, shape: Vec<usize> }`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// An in-memory reader keeps the recipe layer testable without any
    /// container library.
    #[derive(Default)]
    pub(crate) struct FakeContainer {
        entries: Vec<DatasetEntry>,
        columns: std::collections::BTreeMap<String, Vec<f64>>,
    }

    #[test]
    fn numeric_datasets_are_listed_with_their_shape_and_length() {
        let container = fake_container(&[("run/time", vec![0.0, 1.0, 2.0]), ("run/ax", vec![1.0, 2.0, 3.0])]);
        let entries = container.datasets();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "run/ax", "listing is sorted and stable");
        assert_eq!(entries[0].kind, DatasetKind::Numeric);
        assert_eq!(entries[0].len, 3);
    }

    #[test]
    fn reading_an_absent_dataset_is_an_error_not_an_empty_column() {
        let container = fake_container(&[("run/time", vec![0.0])]);
        assert!(matches!(container.read_f64("run/missing"), Err(ContainerError::NoSuchDataset(_))));
    }

    #[test]
    fn non_numeric_datasets_are_listed_but_refuse_f64_reads() {
        let container = fake_container_with_text("run/label");
        assert_eq!(container.datasets()[0].kind, DatasetKind::Text);
        assert!(matches!(container.read_f64("run/label"), Err(ContainerError::NotNumeric(_))));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core container::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the boundary**

The trait is object-safe (`Box<dyn ContainerReader>`) so the recipe decoder is
written once against it. `DatasetKind::{Numeric, Text, Compound, Unsupported}`.
`datasets()` returns a stable, sorted listing; multidimensional numeric datasets
report their full `shape` and `read_f64` flattens in row-major order (documented,
so a recipe selecting a 2-D dataset gets a defined column). `FakeContainer` lives
in `#[cfg(test)]` and is reused by Tasks 9–11.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core container::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest
git commit -m "feat(ingest): define the container reader boundary"
```

---

### Task 7: HDF5 and MATLAB v7.3 reader

**Files:**

- Create: `core/scope-core/src/ingest/container/hdf5.rs`
- Modify: `Cargo.toml`, `core/scope-core/Cargo.toml`, `flake.nix`,
  `scripts/setup-appimage.sh`, `deny.toml` (only if a new license appears)

**Interfaces:**

- Produces: `container::hdf5::{Hdf5Container, is_hdf5_magic}`;
  provider descriptors for `h5`/`hdf5`/`mat`.

- [ ] **Step 1: Add the system and crate dependencies**

`flake.nix` dev-shell `packages`: `pkgs.hdf5`, `pkgs.pkg-config`; export
`HDF5_DIR="${pkgs.hdf5}"` in `shellHook`. `scripts/setup-appimage.sh`: add
`libhdf5-dev`. Root `Cargo.toml`: `hdf5-metno = "0.10"` (the maintained fork;
the original `hdf5` crate is unmaintained and `cargo deny`'s
`unmaintained = "workspace"` rejects it). `core/scope-core/Cargo.toml`:
`hdf5-metno = { workspace = true, optional = false }`.

Run: `./scripts/ci.sh quality`
Expected: `cargo deny check` PASS. If a new license appears, add it to
`deny.toml` in this commit with a one-line comment naming the crate.

- [ ] **Step 2: Write the failing test**

```rust
    #[test]
    fn a_nested_group_layout_lists_leaf_datasets_by_full_path() {
        let file = write_hdf5(&[("/run/time", &[0.0, 1.0, 2.0]), ("/run/imu/ax", &[1.0, 2.0, 3.0])]);
        let container = Hdf5Container::open(file.path()).unwrap();
        let paths: Vec<_> = container.datasets().iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, ["run/imu/ax", "run/time"]);
        assert_eq!(container.read_f64("run/imu/ax").unwrap(), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn integer_and_float_datasets_both_read_as_f64() {
        let file = write_hdf5_mixed(); // i32 counts, f32 volts
        let container = Hdf5Container::open(file.path()).unwrap();
        assert_eq!(container.read_f64("counts").unwrap(), vec![1.0, 2.0, 3.0]);
        assert!((container.read_f64("volts").unwrap()[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn a_matlab_v7_3_file_opens_as_hdf5() {
        let container = Hdf5Container::open(fixture("matlab_v73.mat")).unwrap();
        assert!(container.datasets().iter().any(|entry| entry.path.ends_with("signal")));
    }

    #[test]
    fn units_come_from_the_conventional_attribute() {
        let file = write_hdf5_with_units("volts", "V");
        let container = Hdf5Container::open(file.path()).unwrap();
        assert_eq!(container.attribute("volts", "units").as_deref(), Some("V"));
    }

    #[test]
    fn a_truncated_container_is_an_error_not_a_panic() {
        assert!(Hdf5Container::open(truncated_hdf5().path()).is_err());
    }
```

- [ ] **Step 3: Run it to verify it fails**

Run: `./scripts/test.sh core hdf5`
Expected: FAIL — `Hdf5Container` not found.

- [ ] **Step 4: Implement it**

Walk groups depth-first into a sorted leaf listing; map every integer and float
dataset to `DatasetKind::Numeric`; read through `hdf5_metno::Dataset::read_raw`
and convert to `f64`. `attribute` checks `units`, then `unit`, then `Units`.
`is_hdf5_magic` matches `\x89HDF\r\n\x1a\n` and backs the provider's `Certain`
confidence. MATLAB v7.3 **is** HDF5, so the same reader serves `.mat` files
that carry the magic; older MAT versions are deferred (see "Deferred").

- [ ] **Step 5: Run the tests**

Run: `./scripts/test.sh core hdf5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core flake.nix flake.lock scripts/setup-appimage.sh deny.toml
git commit -m "feat(ingest): read HDF5 and MATLAB v7.3 containers"
```

---

### Task 8: Parquet/Arrow reader

**Files:**

- Create: `core/scope-core/src/ingest/container/parquet.rs`
- Modify: `Cargo.toml`, `core/scope-core/Cargo.toml`, `deny.toml`

**Interfaces:**

- Produces: `container::parquet::{ParquetContainer, is_parquet_magic}`; a
  provider descriptor for `parquet`/`pq`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn columns_are_listed_by_name_and_read_as_f64() {
        let file = write_parquet(&[("time", &[0.0, 1.0]), ("ax", &[2.0, 3.0])]);
        let container = ParquetContainer::open(file.path()).unwrap();
        assert_eq!(container.datasets().iter().map(|e| e.path.clone()).collect::<Vec<_>>(), ["ax", "time"]);
        assert_eq!(container.read_f64("time").unwrap(), vec![0.0, 1.0]);
    }

    #[test]
    fn nulls_read_as_nan_so_they_surface_as_pyramid_gaps() {
        let container = ParquetContainer::open(write_parquet_with_nulls().path()).unwrap();
        assert!(container.read_f64("ax").unwrap()[1].is_nan());
    }

    #[test]
    fn non_numeric_columns_are_listed_but_not_readable_as_f64() {
        let container = ParquetContainer::open(write_parquet_with_strings().path()).unwrap();
        assert!(matches!(container.read_f64("label"), Err(ContainerError::NotNumeric(_))));
    }

    #[test]
    fn the_magic_is_recognized_at_both_ends_of_the_file() {
        assert!(is_parquet_magic(b"PAR1\x00\x00"));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core parquet`
Expected: FAIL — `ParquetContainer` not found.

- [ ] **Step 3: Implement it**

Add `parquet = { version = "56", default-features = false, features = ["arrow", "snap", "zstd"] }`
and `arrow-array`/`arrow-schema` as needed; run `./scripts/ci.sh quality` and
record any `multiple-versions` warnings (they warn, not deny). Read row groups
through `ParquetRecordBatchReader`, cast each numeric column to `Float64Array`
(nulls → NaN), and concatenate. Reject non-numeric columns from `read_f64` while
still listing them so the wizard can show them.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core parquet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core deny.toml
git commit -m "feat(ingest): read Parquet containers"
```

---

### Task 9: Recipe model, validation, and digest

**Files:**

- Create: `core/scope-core/src/ingest/recipe/mod.rs`
- Modify: `Cargo.toml`, `core/scope-core/Cargo.toml`

**Interfaces:**

- Produces: `recipe::{Recipe, Selection, TimeSource, NameRule, RecipeError,
parse_recipe, content_digest}`;
  `Recipe { id: String, container: ContainerKind, selections: Vec<Selection> }`;
  `Selection { datasets: String (glob), time: TimeSource, name: NameRule,
unit: Option<String>, unit_attribute: Option<String> }`;
  `TimeSource::{Dataset { path }, Sibling { name }, Index { dt, t0 }}`.

- [ ] **Step 1: Write the failing test**

```rust
    const SAMPLE: &str = r#"
id = "flight-h5"
container = "hdf5"

[[selection]]
datasets = "run/*/telemetry/*"
name = "strip:run/"
unit_attribute = "units"

[selection.time]
kind = "dataset"
path = "run/time"

[[selection]]
datasets = "sweep/**"
name = "keep"
unit = "m/s"

[selection.time]
kind = "index"
dt = 0.01
t0 = 0.0
"#;

    #[test]
    fn a_recipe_parses_selections_time_sources_and_naming() {
        let recipe = parse_recipe(SAMPLE).unwrap();
        assert_eq!(recipe.id, "flight-h5");
        assert_eq!(recipe.selections.len(), 2);
        assert!(matches!(&recipe.selections[0].time, TimeSource::Dataset { path } if path == "run/time"));
        assert!(matches!(recipe.selections[1].time, TimeSource::Index { dt, .. } if (dt - 0.01).abs() < 1e-12));
        assert_eq!(recipe.selections[0].unit_attribute.as_deref(), Some("units"));
    }

    #[test]
    fn a_recipe_can_never_name_executable_code() {
        for hostile in [
            r#"id="x"
container="hdf5"
command = "rm -rf /""#,
            r#"id="x"
container="hdf5"
plugin = "./evil.so""#,
            r#"id="x"
container="hdf5"
decoder = "/usr/bin/python""#,
            r#"id="x"
container="native""#,
        ] {
            let error = parse_recipe(hostile).unwrap_err();
            assert!(matches!(error, RecipeError::UnknownField(_) | RecipeError::UnknownContainer(_)),
                    "hostile recipe accepted: {hostile}");
        }
    }

    #[test]
    fn selectors_cannot_escape_the_container() {
        let recipe = r#"id="x"
container="hdf5"

[[selection]]
datasets = "../../etc/passwd"
name = "keep"

[selection.time]
kind = "index"
dt = 1.0
t0 = 0.0"#;
        assert!(matches!(parse_recipe(recipe), Err(RecipeError::InvalidSelector(_))));
    }

    #[test]
    fn the_digest_is_content_addressed_and_whitespace_sensitive_only_where_it_matters() {
        let recipe = parse_recipe(SAMPLE).unwrap();
        assert_eq!(content_digest(&recipe), content_digest(&parse_recipe(SAMPLE).unwrap()));
        let mut changed = recipe.clone();
        changed.selections[0].unit = Some("V".into());
        assert_ne!(content_digest(&recipe), content_digest(&changed));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core recipe::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Add `toml = "0.9"` (with `serde`). Deserialize with
`#[serde(deny_unknown_fields)]` on **every** struct — that single attribute is
what turns "a recipe is data" from a claim into an enforced property, because
any `command`/`plugin`/`decoder` key is a hard parse error. `container` is a
closed enum (`hdf5`, `mat`, `parquet`); anything else is
`RecipeError::UnknownContainer`. Selector validation rejects `..`, absolute
paths, and NUL bytes. `content_digest` hashes the **normalized parsed model**
(not the raw text) with SHA-256 through the same length-prefixed encoding
`provenance_digest` uses, so reformatting a recipe does not invalidate caches
but any semantic change does.

`NameRule::{Keep, Strip(String), Replace { from, to }, Template(String)}` where
`Template` interpolates only `{dataset}`, `{leaf}`, and `{index}` — no arbitrary
expansion. Every produced name passes through `naming::normalize_segment`.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core recipe::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core/src/ingest/recipe
git commit -m "feat(ingest): parse and validate declarative container recipes"
```

---

### Task 10: Recipe-driven decoding

**Files:**

- Create: `core/scope-core/src/ingest/recipe/decode.rs`

**Interfaces:**

- Consumes: `ContainerReader`, `Recipe`, `DecodeContext`.
- Produces: `recipe::decode::{RecipeDecoder, decode_with}`;
  `RecipeDecoder` implements `Decoder`; `recipe::provider(recipe, digest) -> FormatProvider`
  so a resolved recipe registers as a runtime provider.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_shared_time_dataset_serves_every_selected_signal() {
        let container = fake_container(&[
            ("run/time", vec![0.0, 1.0, 2.0]),
            ("run/telemetry/ax", vec![1.0, 2.0, 3.0]),
            ("run/telemetry/ay", vec![4.0, 5.0, 6.0]),
        ]);
        let decoded = decode_with(&container, &parse_recipe(SHARED_TIME).unwrap(), &mut context()).unwrap();

        assert_eq!(decoded.row_count, 3);
        assert_eq!(decoded.signals.len(), 2);
        assert_eq!(decoded.signals[0].local_path, "telemetry/ax");
        assert!(std::sync::Arc::ptr_eq(&decoded.signals[0].time, &decoded.signals[1].time),
                "one time column, shared");
    }

    #[test]
    fn a_synthesized_index_timebase_uses_dt_and_t0() {
        let container = fake_container(&[("sweep/v", vec![9.0, 8.0])]);
        let decoded = decode_with(&container, &parse_recipe(INDEX_TIME).unwrap(), &mut context()).unwrap();
        assert_eq!(decoded.signals[0].time.as_ref(), &[5.0, 5.01]);
    }

    #[test]
    fn a_sibling_time_column_is_resolved_per_group() {
        let container = fake_container(&[
            ("a/t", vec![0.0, 1.0]), ("a/v", vec![1.0, 2.0]),
            ("b/t", vec![0.0, 2.0]), ("b/v", vec![3.0, 4.0]),
        ]);
        let decoded = decode_with(&container, &parse_recipe(SIBLING_TIME).unwrap(), &mut context()).unwrap();
        assert_eq!(decoded.signals.len(), 2);
        assert_eq!(decoded.signals[1].time.as_ref(), &[0.0, 2.0]);
    }

    #[test]
    fn an_unsorted_or_non_finite_time_dataset_is_rejected_like_csv() {
        let container = fake_container(&[("run/time", vec![1.0, 0.0]), ("run/telemetry/ax", vec![1.0, 2.0])]);
        let decoded = decode_with(&container, &parse_recipe(SHARED_TIME).unwrap(), &mut context()).unwrap();
        assert_eq!(decoded.signals[0].time.as_ref(), &[0.0, 1.0], "sorted, with values permuted");
        assert_eq!(decoded.signals[0].values.as_ref(), &[2.0, 1.0]);

        let bad = fake_container(&[("run/time", vec![f64::NAN, 1.0]), ("run/telemetry/ax", vec![1.0, 2.0])]);
        assert!(decode_with(&bad, &parse_recipe(SHARED_TIME).unwrap(), &mut context()).is_err());
    }

    #[test]
    fn a_length_mismatch_between_time_and_values_is_an_error() {
        let container = fake_container(&[("run/time", vec![0.0, 1.0]), ("run/telemetry/ax", vec![1.0])]);
        assert!(matches!(
            decode_with(&container, &parse_recipe(SHARED_TIME).unwrap(), &mut context()),
            Err(IngestError::Recipe(RecipeError::LengthMismatch { .. }))
        ));
    }

    #[test]
    fn hostile_dataset_names_are_normalized_and_never_collide_silently() {
        let container = fake_container(&[("run/time", vec![0.0]), ("run/telemetry/A B", vec![1.0]),
                                         ("run/telemetry/a_b", vec![2.0])]);
        let error = decode_with(&container, &parse_recipe(SHARED_TIME).unwrap(), &mut context()).unwrap_err();
        assert!(matches!(error, IngestError::Recipe(RecipeError::DuplicateName(_))));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core recipe::decode`
Expected: FAIL — `decode_with` not found.

- [ ] **Step 3: Implement it**

Match each selection's glob against the sorted dataset listing (`*` matches one
segment, `**` matches many; no regex, no backtracking blowup). Resolve the time
source once per distinct timebase and share the `Arc<[f64]>`, so a container with
one time dataset costs 8 bytes per sample, not 16. Sort by time with the existing
`sort_permutation`, apply it to every value column, and reject non-finite time
exactly like CSV. Names normalize through `naming::normalize_segment`; a
post-normalization collision is `RecipeError::DuplicateName`, never a silent
overwrite. `context.check()` runs per dataset so a recipe decode cancels at a
batch boundary. Units come from `unit` or, when `unit_attribute` is set, from the
container attribute.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core recipe::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/ingest/recipe
git commit -m "feat(ingest): decode containers through recipes"
```

---

### Task 11: Recipe resolution order

**Files:**

- Create: `core/scope-core/src/ingest/recipe/resolve.rs`
- Modify: `protocol/schema/scope-preferences.json`, `core/scope-core/src/preferences.rs`

**Interfaces:**

- Produces: `recipe::resolve::{resolve_for, ResolvedRecipe, ResolveError}`;
  `resolve_for(source: &Path, preferences) -> Result<Option<ResolvedRecipe>, ResolveError>`;
  `ResolvedRecipe { recipe, digest, origin: RecipeOrigin }`;
  `RecipeOrigin::{Sidecar(PathBuf), UserDirectory(PathBuf)}`; preferences schema
  3 with `recipe_directory: string?`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn a_sidecar_recipe_beside_the_data_wins() {
        let dir = tempfile::tempdir().unwrap();
        let source = write_file(&dir, "foo.h5");
        write_file_with(&dir, "foo.h5.scope.toml", SIDECAR_RECIPE);
        let user = user_directory_with("flight-h5", USER_RECIPE);

        let resolved = resolve_for(&source, &prefs(&user)).unwrap().unwrap();
        assert!(matches!(resolved.origin, RecipeOrigin::Sidecar(_)));
        assert_eq!(resolved.recipe.id, "sidecar-h5");
    }

    #[test]
    fn the_user_directory_is_the_fallback_and_matches_on_container_and_shape() {
        let dir = tempfile::tempdir().unwrap();
        let source = write_file(&dir, "foo.h5");
        let user = user_directory_with("flight-h5", USER_RECIPE);
        let resolved = resolve_for(&source, &prefs(&user)).unwrap().unwrap();
        assert!(matches!(resolved.origin, RecipeOrigin::UserDirectory(_)));
    }

    #[test]
    fn no_matching_recipe_is_none_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_for(&write_file(&dir, "foo.h5"), &prefs_without_directory()).unwrap().is_none());
    }

    #[test]
    fn a_malformed_sidecar_recipe_fails_loudly_instead_of_falling_through() {
        let dir = tempfile::tempdir().unwrap();
        let source = write_file(&dir, "foo.h5");
        write_file_with(&dir, "foo.h5.scope.toml", "id = ");
        assert!(matches!(resolve_for(&source, &prefs_without_directory()), Err(ResolveError::Parse { .. })));
    }

    #[test]
    fn a_recipe_directory_outside_the_configured_root_is_ignored() {
        let resolved = resolve_for(&source(), &prefs_with_directory("/nonexistent/recipes")).unwrap();
        assert!(resolved.is_none());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core resolve::`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Bump the preferences schema to 3, add `recipe_directory`, and run
`./scripts/codegen.sh`. Resolution order: `<source>.scope.toml` beside the data,
then every `*.toml` in the configured recipe directory (sorted by file name,
first match on container kind wins). A malformed recipe at either location is a
hard error — silently ingesting a different schema is exactly the failure this
tier exists to prevent. The recipe directory is read-only input; nothing in it
is executed, and a resolved recipe registers as a runtime `FormatProvider` with
id `recipe:{recipe.id}` and `cache_abi` derived from the content digest.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core recipe::` and `./scripts/test.sh frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core/scope-core frontend/src/generated
git commit -m "feat(ingest): resolve recipes from data sidecars and the user directory"
```

---

### Task 12: Session records recipe identity

**Files:**

- Modify: `protocol/schema/scope-session.json`, `core/scope-core/src/session.rs`,
  `core/scope-core/src/restore.rs`, `shell/src-tauri/src/lib.rs`
- Regenerate: session outputs; update the conformance fixture

**Interfaces:**

- Produces: `SourceRecord` gains `recipe_id: string?` and `recipe_digest: string?`;
  a session migration rung adding both as `null`;
  `restore::RecipeStatus::{Matched, Changed, Missing}` reported per source.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn the_previous_version_gains_null_recipe_fields() {
        let session = from_json(&previous_version_json()).expect("migrates");
        assert!(session.sources.iter().all(|record| record.recipe_id.is_none()));
        assert!(session.sources.iter().all(|record| record.recipe_digest.is_none()));
    }

    #[test]
    fn a_changed_recipe_fails_restore_with_a_reconfirm_action() {
        let record = record_with_recipe("flight-h5", "aaaa");
        let status = recipe_status(&record, Some(&resolved_with_digest("flight-h5", "bbbb")));
        assert_eq!(status, RecipeStatus::Changed);
        assert!(restore_source(&record).unwrap_err().to_string().contains("reconfirm"));
    }

    #[test]
    fn a_missing_recipe_fails_restore_with_a_relink_action() {
        let record = record_with_recipe("flight-h5", "aaaa");
        assert_eq!(recipe_status(&record, None), RecipeStatus::Missing);
        assert!(restore_source(&record).unwrap_err().to_string().contains("relink"));
    }

    #[test]
    fn the_recipe_digest_is_part_of_the_cache_key() {
        assert_ne!(
            provenance_for_recipe("flight-h5", "aaaa"),
            provenance_for_recipe("flight-h5", "bbbb")
        );
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core session::` and `./scripts/test.sh core recipe_status`
Expected: FAIL — no field `recipe_id`.

- [ ] **Step 3: Implement it**

Bump the session schema, add the two optional fields, `./scripts/codegen.sh`,
add the additive rung, and regenerate the conformance fixture. Restore compares
the recorded digest against the resolved recipe: `Matched` proceeds, `Changed`
and `Missing` both fail that source with an actionable message and leave its
references intact for a later retry (reusing Part A's unresolved-source path).
The recipe digest joins `provenance_digest`'s `options` slice, so a recipe edit
invalidates cached columns.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core` and `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol core/scope-core shell frontend/src
git commit -m "feat(session): record the recipe id and digest per source"
```

---

### Task 13: Import wizard

**Files:**

- Modify: `protocol/schema/scope-protocol.json`, `shell/src-tauri/src/lib.rs`
- Create: `frontend/src/ui/import-wizard.ts`, `frontend/src/ui/import-wizard.test.ts`
- Modify: `frontend/src/ui/app-shell.ts`, `frontend/src/styles/app.css`

**Interfaces:**

- Produces: `IntrospectRequest { path }` →
  `ContainerOutline { container: string, datasets: DatasetOutline[] }`,
  `DatasetOutline { path, kind, len: u64, shape: u32[], sample_preview: f64[] }`;
  `SaveRecipeRequest { path, recipe_toml, destination: RecipeDestination }` →
  `SaveRecipeResponse { recipe_id, digest, saved_to }`;
  `RecipeDestination::{Sidecar, UserDirectory}`;
  `ImportWizard.mount(plane, path)`.

- [ ] **Step 1: Write the failing test**

```ts
it("proposes the largest monotonic numeric dataset as the timebase", () => {
  const wizard = ImportWizard.fromOutline({
    container: "hdf5",
    datasets: [
      {
        path: "run/ax",
        kind: "numeric",
        len: "300",
        shape: [300],
        sample_preview: [1, 2, 3],
      },
      {
        path: "run/time",
        kind: "numeric",
        len: "300",
        shape: [300],
        sample_preview: [0, 0.1, 0.2],
      },
      {
        path: "run/label",
        kind: "text",
        len: "300",
        shape: [300],
        sample_preview: [],
      },
    ],
  });
  expect(wizard.proposedTime()).toBe("run/time");
  expect(wizard.selectableSignals()).toEqual(["run/ax"]);
});

it("emits a recipe that round-trips through the native parser", async () => {
  const wizard = ImportWizard.fromOutline(outline);
  wizard.setTime("run/time");
  wizard.setNameRule({ kind: "strip", prefix: "run/" });
  const toml = wizard.toToml();
  expect(toml).toContain('kind = "dataset"');
  expect(toml).not.toMatch(/command|plugin|decoder/);
  await expect(
    plane.ingest.saveRecipe("/data/foo.h5", toml, "sidecar"),
  ).resolves.toMatchObject({
    recipe_id: expect.any(String),
  });
});

it("renders untrusted dataset names as text", () => {
  const wizard = ImportWizard.fromOutline(
    outlineWith("<img src=x onerror=alert(1)>"),
  );
  const row = wizard.render().querySelector(".wizard-dataset");
  expect(row?.innerHTML).not.toContain("<img");
  expect(row?.textContent).toContain("<img src=x onerror=alert(1)>");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh unit import-wizard`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

`introspect_container` opens the file through the matching `ContainerReader` and
returns the outline with a short preview per dataset (first 8 values). The wizard
proposes a timebase (longest numeric dataset whose preview is finite and
nondecreasing, `time`/`t`/`timestamp` names preferred), lets the user confirm or
pick another, choose a naming rule and unit source, and saves the result. Saving
writes through `save_recipe`, which **parses and validates the TOML natively
before writing** — the wizard never persists a recipe the parser would reject.
All dataset text uses `textContent`. The wizard opens automatically when a
recognized HDF5 or Parquet batch file fails through the explicit
recipe-required error path. `SelectionError::Unsupported` remains the
unsupported-format path for inputs no provider recognizes.

The picked, folder-scanned, and window-dropped files all funnel through the
same batch path, so every arrival route gets the same trigger.

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh frontend` and `./scripts/test.sh shell`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add protocol shell/src-tauri/src/lib.rs frontend/src
git commit -m "feat(frontend): add the container import wizard"
```

---

### Task 14: Phase B2 ADR, preferences amendment, and version bump

**Files:**

- Create: `docs/adr/0034-declarative-container-recipes.md`
- Modify: `docs/adr/README.md`, `docs/adr/0023-global-preferences-file.md`
  (recipe-directory amendment), `docs/implementation-roadmap.md`, `README.md`
  (supported formats)

- [ ] **Step 1: Write ADR 0034**

Record: recipes are data, enforced by `deny_unknown_fields` plus a closed
container enum and selector validation; sidecar-then-user-directory resolution;
the content digest in both the session and the cache key; the fail-closed
behavior on a changed or missing recipe; that recipes register as runtime
providers with `recipe:{id}`; and that containers, recipes, and readers never
reach the frontend or a snapshot.

- [ ] **Step 2: Run the gate**

```bash
./scripts/format.sh
./scripts/ci.sh all
```

Expected: PASS, including `cargo deny check` with the new container crates and
the AppImage build path with `libhdf5`.

- [ ] **Step 3: Bump and commit**

```bash
./scripts/version.sh bump minor   # additive session/preferences fields, new formats
./scripts/version.sh check
git add docs README.md Cargo.toml Cargo.lock package.json frontend/package.json shell/src-tauri
git commit -m "docs: record the declarative container recipe decision"
```

---

## Phase B3 — parser plugins (spec Tier 2, P5)

The spec defers plugins to their own spec. This phase writes that spec; it
contains no implementation.

### Task 15: Write the parser-plugin spec

**Files:**

- Create: `docs/superpowers/specs/2026-07-30-sandboxed-parser-plugins.md`

**Interfaces:**

- Consumes: `Decoder`, `DecodedSource`, `ProviderRegistry`, `commit`,
  `admission::MemoryBudget` — the plugin host must reuse them, not parallel them.

- [ ] **Step 1: Draft the spec against the two fixed constraints**

The spec must fix, not re-litigate:

1. **The sandbox story is honest.** A subprocess parser runs with the user's full
   privileges — filesystem, network, everything — which is no isolation. If
   subprocess plugins ship at all, they are an explicitly-trusted developer mode
   gated on per-executable registration in preferences, **never** discovered from
   a data directory. The sandboxed path is WASM (wasmtime/WIT: no filesystem, no
   network), and the sandbox includes host-enforced resource limits, not just
   capability denial: fuel/deadline budgets, a memory cap, maximum batch and
   total output sizes, with the host terminating and rolling back any module that
   exceeds them or stops responding to cancellation.
2. **One transport and one encoding ship first**, not a matrix.

- [ ] **Step 2: Specify the logical API and host validation**

`open → stream column batches → finish`, with the host validating everything:
time columns sorted and validated exactly like CSV ingest, registration limits
(max signals, max name length, max total samples), names treated as data and
normalized, and the per-file transaction around registration. Plugins are
native-host-only and never enter the frontend or snapshots. Plugin module digests
join `provenance_digest`'s options so a rebuilt plugin invalidates its cache.

- [ ] **Step 3: Specify the test obligations**

Hostile plugin output: unsorted time, non-finite time, mismatched column lengths,
duplicate names, names with control characters or 1 MiB of text, a module that
never returns, a module that allocates without bound, a module that ignores
cancellation, and a module that emits more samples than it declared. Each must
fail the file and leave the store unchanged.

- [ ] **Step 4: Review against the accepted ADRs**

Confirm the draft preserves ADR 0002 layer boundaries (the plugin host lives in
`ingest`, nothing depends on the shell), ADR 0009 as amended by ADR 0026
(off-lock decode, host-side commit), and ADR 0033 (registry selection, cache-ABI
per provider). Note any conflict explicitly in the spec rather than resolving it
silently.

- [ ] **Step 5: Format and commit**

```bash
./scripts/format.sh
git add docs/superpowers/specs/2026-07-30-sandboxed-parser-plugins.md
git commit -m "docs: specify sandboxed parser plugins"
```

---

## Implementation notes

The shipped implementation corrected four details in this plan:

- Parquet provider detection claims leading `PAR1` magic; it does not require
  the footer in the bounded probe window.
- The shared-timebase test asserts `Arc::ptr_eq`; an intermediate version used
  `same_values`, which only compared contents.
- HDF5 and Parquet providers claim certain format magic, so the wizard is
  triggered by the explicit recipe-required failure rather than an unreachable
  `SelectionError::Unsupported` branch.
- Windows static HDF5 builds require CMake in addition to the Git Bash build
  environment.

## Deferred (explicitly out of scope for this plan)

- **MATLAB ≤ v7.2 files.** v7.3 is HDF5 and Task 7 covers it. Older versions need
  a separate MAT container reader; the available crates need a `cargo deny`
  maintenance and license review before adoption, which is its own task. Until
  then an old `.mat` file fails closed with the unsupported-format error naming
  the known formats — the correct behavior, not a silent misparse.
- **Recipe-driven live sources.** Recipes describe files; live decoders are a
  separate seam on `Decoder`.
- **Plugin implementation.** Task 15 produces the spec; implementation follows
  that spec's own plan.

---

## Self-Review

**Spec coverage.** Tier 0 decoder registry → Tasks 1–5 (registry, deterministic
selection, text gate and fail-closed dispatch, registry-derived picker and
formats listing, provider recorded and reproduced on reopen). Tier 1 recipes →
Tasks 6–14 (container boundary, HDF5/MAT v7.3, Parquet, recipe model and
enforced data-only validation, recipe-driven decoding with all three time
sources, resolution order, session recipe identity and cache keying, import
wizard, preferences amendment and ADR). Tier 2 → Task 15 writes the dedicated
spec with both constraints fixed. The spec's "P4: another preferences schema bump
(recipe directory) and a session bump recording the recipe id and content digest
used per source" is Tasks 11 and 12.

**Dependencies on Part A (complete; verified in-tree 2026-08-03).**
`Decoder`/`DecodeContext`/`DecodedSource` (A5),
`provenance_digest` and `ProviderInfo` (A7), `SourceRecord` provider fields (A4,
A14), `FormatDescriptor` (A12), and the filtered test wrappers (A1). Task 2 is
the only task that changes a Part A signature (`ProviderInfo::id` becomes
`String`), and it does so in one commit with no change to digest inputs for
`csv` or `mcap`, so existing cache entries stay valid.

**Interface consistency.** `FormatProvider`/`ProviderRegistry`/`Confidence`,
`ContainerReader`/`DatasetEntry`/`DatasetKind`, `Recipe`/`Selection`/`TimeSource`/
`NameRule`, `ResolvedRecipe`/`RecipeOrigin`, and `RecipeStatus` are each defined
in exactly one task and referenced by name thereafter. Every recipe-produced name
passes `naming::normalize_segment`; every wire `u64` (`len`, counts) is a string
in TypeScript.
