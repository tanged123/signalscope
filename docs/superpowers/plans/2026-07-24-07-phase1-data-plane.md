# Phase 1 — Data Plane & Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native file dialogs, MCAP ingest, background ingest jobs with progress reporting, and persisted pyramid sidecars — the data-plane half of Phase 1 ("workbench fundamentals" in `docs/implementation-roadmap.md`).

**Architecture:** Ingest becomes format-dispatched (`ingest_path` sniffs magic bytes → `CsvDecoder` / `McapDecoder`) with a decode-progress callback threaded through the `Decoder` trait. The shell runs ingest on a worker thread as a _job_: `ingest_source` returns a job id immediately, the frontend polls `ingest_status` (no Tauri events/channels — the frontend keeps zero runtime dependencies and speaks only request/response `Envelope`s). Pyramids persist as a versioned binary sidecar beside the source (ADR 0003's format, made concrete); a fingerprint-valid sidecar skips decode + build entirely on reopen. The `DataPlane` interface grows a _capability port_ (`ingest: IngestPort | null`) — UI may branch on capability presence, never on host identity.

**Tech Stack:** Rust (edition 2024, clippy all+pedantic at `-D warnings`, `unsafe_code = "forbid"`), `mcap` 0.25, `crc32fast` 1.5, `tauri-plugin-dialog` 2, TypeScript strict frontend with zero runtime deps.

## Global Constraints

- Use `./scripts/` wrappers for every operation; they enter the Nix dev shell themselves (`./scripts/dev.sh <cmd>` for arbitrary commands like `cargo add`-less manifest edits — edit manifests by hand, do not use `cargo add`).
- Binding invariants (AGENTS.md / ADRs — read ADR 0001–0005 and 0007 before starting): two-host `DataPlane`, versioned protocol/session schemas, pyramid gap/extrema invariants, transactional ingest, self-contained no-network snapshots.
- Every public Rust item returning `Result` needs a `# Errors` doc section; reachable panics need `# Panics` (clippy pedantic is enforced with `-D warnings` in CI).
- Never edit `frontend/src/generated/*` or `*/generated.rs` by hand — change `protocol/schema/*.json` and run `./scripts/dev.sh pnpm codegen`.
- Commit messages: lowercase imperative, no prefix. Stage only the files each task names.
- Run `./scripts/ci.sh all` before final handoff.

## Decisions embedded in this plan (flagged for maintainer review)

1. **MCAP v1 scope = `json`-encoded channels only.** Messages are flattened (numeric + bool leaves) into `topic/field/subfield` signals; other encodings (protobuf/CDR) are skipped and reported. Recorded in ADR 0009.
2. **Progress = polled jobs, not Tauri channels/events.** Channel IPC would require `@tauri-apps/api` (or fragile raw-internals code) in a frontend that has zero runtime deps. Polling every 150 ms over the existing envelope protocol is boring and testable. Recorded in ADR 0009 with the upgrade path.
3. **The store mutex is held for the duration of an ingest job.** Tile queries for already-loaded signals block while a new file ingests. Acceptable for Phase 1 (first load is the common case); revisit with out-of-core store work. Recorded in ADR 0009.
4. **MCAP reads the whole file into memory for now.** The store itself is in-memory in Phase 1, so mmap streaming buys nothing yet; the `Decoder` seam hides the change when the mmap-backed store lands. Recorded in ADR 0009.
5. **Sidecar caches raw columns + merged levels** (not just levels), so a cache hit skips CSV/MCAP parse entirely. Write failures (read-only dirs) are non-fatal: log and continue. Cache corruption is a _miss_, never an error.
6. **`protocol_version` bumps 1 → 2**: `SignalSummary` gains `t_min`/`t_max` (the UI needs data extents to fit the time window) and the ingest command surface is replaced. Nothing persisted uses v1.

## Sequencing

Tasks 1→2→3 are ordered; 4→5 are ordered and independent of 2–3 (after Task 1); 6 needs 1–5; 7 needs 6. Runs fully in parallel with the Phase 1 UI plan (`2026-07-24-08-phase1-workbench-ui.md`) except: Task 7 defines the `IngestPort` interface in `frontend/src/app/data-plane.ts` that UI Task 6 consumes — whichever lands second resolves a small rebase.

---

### Task 1: Protocol v2 — ingest jobs and signal time extents

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Modify: `shell/src-tauri/src/lib.rs` (the `signal_summary` helper)
- Modify: `frontend/src/app/data-plane.ts` (demo manifest summaries)
- Generated (via codegen, do not hand-edit): `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`

**Interfaces:**

- Produces: `PROTOCOL_VERSION = 2`; new wire types `IngestJob { job_id: u64 }`, `IngestStage = decode|pyramid|cache`, `IngestState = running|done|failed`, `IngestStatus { state, stage, fraction: f64, response: IngestResponse?, error: string? }`; `SignalSummary` gains `t_min: f64`, `t_max: f64`. In TS, `u64` renders as `string` (existing convention).

- [ ] **Step 1: Replace `protocol/schema/scope-protocol.json` with:**

```json
{
  "protocol_version": 2,
  "types": {
    "TimeWindow": {
      "kind": "object",
      "fields": {
        "t0": "f64",
        "t1": "f64"
      }
    },
    "IngestRequest": {
      "kind": "object",
      "fields": {
        "path": "string"
      }
    },
    "TileRequest": {
      "kind": "object",
      "fields": {
        "request_id": "string",
        "signal_ids": "u64[]",
        "window": "TimeWindow",
        "pixel_width": "u32"
      }
    },
    "EnvelopeBin": {
      "kind": "object",
      "fields": {
        "t0": "f64",
        "t1": "f64",
        "first": "f64?",
        "last": "f64?",
        "min": "f64?",
        "max": "f64?",
        "sample_count": "u64",
        "has_gap": "bool"
      }
    },
    "SignalTile": {
      "kind": "object",
      "fields": {
        "signal_id": "u64",
        "signal_path": "string",
        "unit": "string?",
        "level": "u32",
        "bins": "EnvelopeBin[]"
      }
    },
    "TileResponse": {
      "kind": "object",
      "fields": {
        "request_id": "string",
        "series": "SignalTile[]"
      }
    },
    "SignalSummary": {
      "kind": "object",
      "fields": {
        "signal_id": "u64",
        "path": "string",
        "unit": "string?",
        "point_count": "u64",
        "t_min": "f64",
        "t_max": "f64"
      }
    },
    "SourceSummary": {
      "kind": "object",
      "fields": {
        "source_id": "u64",
        "path": "string",
        "point_count": "u64"
      }
    },
    "IngestResponse": {
      "kind": "object",
      "fields": {
        "source": "SourceSummary",
        "signals": "SignalSummary[]"
      }
    },
    "IngestJob": {
      "kind": "object",
      "fields": {
        "job_id": "u64"
      }
    },
    "IngestStage": {
      "kind": "enum",
      "variants": ["decode", "pyramid", "cache"]
    },
    "IngestState": {
      "kind": "enum",
      "variants": ["running", "done", "failed"]
    },
    "IngestStatus": {
      "kind": "object",
      "fields": {
        "state": "IngestState",
        "stage": "IngestStage",
        "fraction": "f64",
        "response": "IngestResponse?",
        "error": "string?"
      }
    }
  }
}
```

- [ ] **Step 2: Regenerate**

Run: `./scripts/dev.sh pnpm codegen`
Expected: `protocol/src/generated.rs` and `frontend/src/generated/protocol.ts` now carry version 2, the four new types, and `t_min`/`t_max` on `SignalSummary`.

- [ ] **Step 3: Fix the two compile breaks**

In `shell/src-tauri/src/lib.rs`, replace the `signal_summary` function with:

```rust
fn signal_summary(signal: &Signal) -> SignalSummary {
    let time = signal.time();
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min: time.first().copied().unwrap_or(0.0),
        t_max: time.last().copied().unwrap_or(1.0),
    }
}
```

In `frontend/src/app/data-plane.ts` (`createDemoManifest`), replace the two summary literals with:

```ts
const summaries: SignalSummary[] = [
  {
    signal_id: "1",
    path: "rocket/velocity_body/x",
    unit: "m/s",
    point_count: String(pointCount),
    t_min: 0,
    t_max: (pointCount - 1) / 30,
  },
  {
    signal_id: "2",
    path: "rocket/velocity_body/y",
    unit: "m/s",
    point_count: String(pointCount),
    t_min: 0,
    t_max: (pointCount - 1) / 30,
  },
];
```

- [ ] **Step 4: Verify**

First stage the schema and regenerated files — `codegen:check` diffs the worktree against the git index, so unstaged generated changes read as failures:

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs frontend/src/generated/protocol.ts
```

Run: `./scripts/test.sh quick`
Expected: PASS (Rust core tests, frontend lint/typecheck/codegen check/unit tests, snapshot artifact checks).

- [ ] **Step 5: Commit**

```bash
git add protocol/schema/scope-protocol.json protocol/src/generated.rs frontend/src/generated/protocol.ts shell/src-tauri/src/lib.rs frontend/src/app/data-plane.ts
git commit -m "extend the protocol with ingest jobs and signal time extents"
```

---

### Task 2: Split ingest into decoder modules with decode progress and format dispatch

**Files:**

- Move: `core/scope-core/src/ingest.rs` → `core/scope-core/src/ingest/csv.rs`
- Create: `core/scope-core/src/ingest/mod.rs`
- Modify: `shell/src-tauri/src/lib.rs` (one call site)

**Interfaces:**

- Produces: `scope_core::ingest::ingest_path(path, store, progress) -> Result<IngestSummary, IngestError>` — content-sniffed dispatch, atomic via `SignalStore::transaction`. `Decoder::decode`/`Decoder::ingest` gain a `progress: &mut dyn FnMut(f64)` parameter reporting decode fractions in `0.0..=1.0` (formats without byte totals may report only `0.0`/`1.0`). `pub(crate) fn normalize_segment(&str) -> String` shared by decoders. `IngestError` gains `UnsupportedFormat(String)` (replaced by the real MCAP decoder in Task 3).
- Consumers: shell (Task 6), cache tests (Task 5), MCAP decoder (Task 3).

- [ ] **Step 1: Move the file**

```bash
git mv core/scope-core/src/ingest.rs core/scope-core/src/ingest/csv.rs
```

- [ ] **Step 2: Create `core/scope-core/src/ingest/mod.rs`:**

```rust
//! Streaming source decoders and format dispatch.

mod csv;

pub use self::csv::CsvDecoder;

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use crate::store::{SignalId, SignalStore, SourceId, StoreError};
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IngestSummary {
    pub source_id: SourceId,
    pub source_path: PathBuf,
    pub row_count: usize,
    pub signals: Vec<SignalId>,
}

/// Common boundary for file and future live decoders.
pub trait Decoder {
    /// Decodes `path` and registers its signals in `store`, reporting decode
    /// progress as fractions in `0.0..=1.0`. Formats without a byte-accurate
    /// total may report only `0.0` and `1.0`.
    ///
    /// Implementations may leave partial registrations behind on error;
    /// callers get atomicity from [`Decoder::ingest`].
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError>;

    /// Decodes `path` atomically: on error the store is unchanged.
    ///
    /// # Errors
    ///
    /// Returns [`IngestError`] when the source cannot be read, decoded, or
    /// registered.
    fn ingest(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        store.transaction(|store| self.decode(path, store, progress))
    }
}

const MCAP_MAGIC: [u8; 8] = *b"\x89MCAP0\r\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceFormat {
    Csv,
    Mcap,
}

fn sniff_format(path: &Path) -> Result<SourceFormat, IngestError> {
    let mut magic = [0_u8; 8];
    let mut file = File::open(path)?;
    let mut filled = 0;
    while filled < magic.len() {
        let read = file.read(&mut magic[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(if filled == magic.len() && magic == MCAP_MAGIC {
        SourceFormat::Mcap
    } else {
        SourceFormat::Csv
    })
}

/// Ingests a source file atomically, selecting the decoder by content.
///
/// # Errors
///
/// Returns [`IngestError`] when the source cannot be read, decoded, or
/// registered.
pub fn ingest_path(
    path: impl AsRef<Path>,
    store: &mut SignalStore,
    progress: &mut dyn FnMut(f64),
) -> Result<IngestSummary, IngestError> {
    let path = path.as_ref();
    match sniff_format(path)? {
        SourceFormat::Csv => CsvDecoder.ingest(path, store, progress),
        SourceFormat::Mcap => Err(IngestError::UnsupportedFormat("mcap".to_owned())),
    }
}

/// Lowercases a path segment and folds spaces/dots to underscores.
pub(crate) fn normalize_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .replace([' ', '.'], "_")
        .to_lowercase()
}

#[derive(Debug, Error)]
pub enum IngestError {
    #[error("source has fewer than two columns")]
    TooFewColumns,
    #[error("source has no data rows")]
    NoDataRows,
    #[error("unsupported source format: {0}")]
    UnsupportedFormat(String),
    #[error(transparent)]
    Csv(#[from] ::csv::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn dispatch_rejects_mcap_until_a_decoder_exists() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"\x89MCAP0\r\n").unwrap();
        let mut store = SignalStore::new();
        let error = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap_err();
        assert!(matches!(error, IngestError::UnsupportedFormat(_)));
    }

    #[test]
    fn dispatch_treats_short_files_as_csv() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"a,b\n1,2\n").unwrap();
        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();
        assert_eq!(summary.row_count, 1);
    }

    #[test]
    fn csv_decode_reports_monotonic_progress_ending_at_one() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(file, "time,value").unwrap();
        for row in 0..20_000 {
            writeln!(file, "{row},{}", row * 2).unwrap();
        }
        let mut store = SignalStore::new();
        let mut fractions = Vec::new();
        ingest_path(file.path(), &mut store, &mut |fraction| {
            fractions.push(fraction);
        })
        .unwrap();
        assert!(fractions.len() >= 2, "expected intermediate progress");
        assert!(fractions.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!((fractions.last().copied().unwrap() - 1.0).abs() < f64::EPSILON);
        assert!(fractions.iter().all(|f| (0.0..=1.0).contains(f)));
    }
}
```

Note the `::csv::Error` leading `::` — inside this module, bare `csv::` would resolve to the sibling `mod csv`, not the crate.

- [ ] **Step 3: Trim `core/scope-core/src/ingest/csv.rs` to decoder-only**

Delete from `csv.rs` (they now live in `mod.rs`): the `IngestSummary` struct, the `Decoder` trait, the `IngestError` enum, and the `ingest_csv_path` function. Replace the file's header (module doc + `use` block) with:

```rust
//! CSV decoding with delimiter, header, and time-column autodetection.

use std::{
    fs::File,
    io::{BufRead, BufReader, Cursor},
    path::Path,
    sync::Arc,
};

use super::{normalize_segment, Decoder, IngestError, IngestSummary};
use crate::store::SignalStore;
```

Change `ingest_unchecked` to take and use the progress callback — the signature becomes:

```rust
    #[allow(clippy::cast_precision_loss)] // progress fractions tolerate rounding
    fn ingest_unchecked(
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
```

and the record loop becomes:

```rust
        let total = input.len().max(1) as f64;
        let mut columns = vec![Vec::<f64>::new(); headers.len()];
        let mut records_seen = 0_usize;
        for record in reader.records() {
            let record = record?;
            records_seen += 1;
            if records_seen % 4096 == 0 {
                progress((reader.position().byte() as f64 / total).min(1.0));
            }
            if record.len() < 2 {
                continue;
            }
            for (index, column) in columns.iter_mut().enumerate() {
                let value = record
                    .get(index)
                    .map(str::trim)
                    .filter(|cell| !cell.is_empty())
                    .and_then(|cell| cell.parse::<f64>().ok())
                    .unwrap_or(f64::NAN);
                column.push(value);
            }
        }
        progress(1.0);
```

(`total` computed from the filtered `input` buffer; `reader.position().byte()` is the byte offset within that same buffer.) Update the `Decoder` impl to forward the parameter:

```rust
impl Decoder for CsvDecoder {
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        Self::ingest_unchecked(path, store, progress)
    }
}
```

Replace `normalize_signal_path`'s body to reuse the shared helper:

```rust
fn normalize_signal_path(base: &str, header: &str) -> String {
    format!("{base}/{}", normalize_segment(header))
}
```

In the `csv.rs` tests module, add `use crate::ingest::ingest_path;` and change every `ingest_csv_path(file.path(), &mut store)` call to `ingest_path(file.path(), &mut store, &mut |_| {})`. The four existing tests keep their assertions unchanged.

- [ ] **Step 4: Update the shell call site**

In `shell/src-tauri/src/lib.rs`, change the import `ingest::ingest_csv_path` to `ingest::ingest_path`, and inside the `ingest_csv` command replace the `ingest_csv_path(&path, store)` call with:

```rust
        ingest_path(&path, store, &mut |_| {}).map_err(|error| error.to_string())?
```

(This command is replaced wholesale in Task 6; this keeps the tree green.)

- [ ] **Step 5: Verify**

Run: `./scripts/ci.sh rust`
Expected: PASS — clippy clean, all core tests (including the three new dispatch/progress tests) and the shell build green.

- [ ] **Step 6: Commit**

```bash
git add core/scope-core/src/ingest core/scope-core/src/ingest.rs shell/src-tauri/src/lib.rs
git commit -m "split ingest decoders and report decode progress"
```

---

### Task 3: MCAP decoder for json-encoded channels

**Files:**

- Modify: `Cargo.toml` (workspace deps), `core/scope-core/Cargo.toml`
- Create: `core/scope-core/src/ingest/mcap.rs`
- Modify: `core/scope-core/src/ingest/mod.rs`

**Interfaces:**

- Consumes: `Decoder`, `IngestError`, `IngestSummary`, `normalize_segment` from Task 2.
- Produces: `scope_core::ingest::McapDecoder`; `ingest_path` now dispatches MCAP magic to it. `IngestError::UnsupportedFormat` is deleted; `IngestError` gains `Mcap(#[from] mcap::McapError)` and `NoSupportedChannels(String)`. Signal paths: `topic/field/subfield` (lowercased, `/`-joined); timebase is `log_time` nanoseconds as f64 seconds; rows sorted by time; ragged fields backfilled with NaN (rendering as pyramid gaps).

- [ ] **Step 1: Add the dependency**

In the root `Cargo.toml` under `[workspace.dependencies]`, add (keeping the list alphabetized):

```toml
mcap = "0.25"
```

In `core/scope-core/Cargo.toml` under `[dependencies]`:

```toml
mcap.workspace = true
```

- [ ] **Step 2: Create `core/scope-core/src/ingest/mcap.rs`:**

```rust
//! MCAP decoding for channels with json-encoded messages (ADR 0009).

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    sync::Arc,
};

use serde_json::Value;

use super::{normalize_segment, Decoder, IngestError, IngestSummary};
use crate::store::SignalStore;

#[derive(Clone, Copy, Debug, Default)]
pub struct McapDecoder;

#[derive(Default)]
struct TopicColumns {
    time: Vec<f64>,
    columns: BTreeMap<String, Vec<f64>>,
}

impl TopicColumns {
    fn push_row(&mut self, time: f64, fields: &[(String, f64)]) {
        let backfill = self.time.len();
        self.time.push(time);
        for (name, value) in fields {
            let column = self
                .columns
                .entry(name.clone())
                .or_insert_with(|| vec![f64::NAN; backfill]);
            column.push(*value);
        }
        for column in self.columns.values_mut() {
            if column.len() < self.time.len() {
                column.push(f64::NAN);
            }
        }
    }

    fn sorted(mut self) -> Self {
        let mut order: Vec<usize> = (0..self.time.len()).collect();
        order.sort_by(|&left, &right| self.time[left].total_cmp(&self.time[right]));
        if order.iter().enumerate().all(|(position, index)| position == *index) {
            return self;
        }
        self.time = order.iter().map(|&index| self.time[index]).collect();
        for column in self.columns.values_mut() {
            *column = order.iter().map(|&index| column[index]).collect();
        }
        self
    }
}

impl Decoder for McapDecoder {
    #[allow(clippy::cast_precision_loss)] // ns log times survive f64 to sub-µs precision
    fn decode(
        &self,
        path: &Path,
        store: &mut SignalStore,
        progress: &mut dyn FnMut(f64),
    ) -> Result<IngestSummary, IngestError> {
        progress(0.0);
        let data = fs::read(path)?;
        let mut topics: BTreeMap<String, TopicColumns> = BTreeMap::new();
        let mut encodings: BTreeSet<String> = BTreeSet::new();
        let mut fields: Vec<(String, f64)> = Vec::new();
        for message in mcap::MessageStream::new(&data)? {
            let message = message?;
            encodings.insert(message.channel.message_encoding.clone());
            if message.channel.message_encoding != "json" {
                continue;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&message.data) else {
                continue;
            };
            fields.clear();
            flatten_numeric("", &value, &mut fields);
            topics
                .entry(normalize_topic(&message.channel.topic))
                .or_default()
                .push_row(message.log_time as f64 * 1e-9, &fields);
        }

        let source_id = store.register_source(path);
        let mut signals = Vec::new();
        let mut row_count = 0;
        for (topic, columns) in topics {
            let columns = columns.sorted();
            row_count += columns.time.len();
            let time: Arc<[f64]> = columns.time.into();
            for (field, values) in columns.columns {
                if !values.iter().any(|value| value.is_finite()) {
                    continue;
                }
                let name = if field.is_empty() {
                    "value".to_owned()
                } else {
                    field
                };
                signals.push(store.insert_signal(
                    source_id,
                    format!("{topic}/{name}"),
                    None,
                    Arc::clone(&time),
                    values,
                )?);
            }
        }
        if signals.is_empty() {
            let seen = if encodings.is_empty() {
                "none".to_owned()
            } else {
                encodings.into_iter().collect::<Vec<_>>().join(", ")
            };
            return Err(IngestError::NoSupportedChannels(seen));
        }
        progress(1.0);
        Ok(IngestSummary {
            source_id,
            source_path: path.to_owned(),
            row_count,
            signals,
        })
    }
}

fn flatten_numeric(prefix: &str, value: &Value, out: &mut Vec<(String, f64)>) {
    let child = |key: String| {
        if prefix.is_empty() {
            key
        } else {
            format!("{prefix}/{key}")
        }
    };
    match value {
        Value::Number(number) => {
            if let Some(number) = number.as_f64() {
                out.push((prefix.to_owned(), number));
            }
        }
        Value::Bool(flag) => out.push((prefix.to_owned(), f64::from(u8::from(*flag)))),
        Value::Object(map) => {
            for (key, nested) in map {
                flatten_numeric(&child(normalize_segment(key)), nested, out);
            }
        }
        Value::Array(items) => {
            for (index, nested) in items.iter().enumerate() {
                flatten_numeric(&child(index.to_string()), nested, out);
            }
        }
        Value::String(_) | Value::Null => {}
    }
}

fn normalize_topic(topic: &str) -> String {
    let segments: Vec<String> = topic
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(normalize_segment)
        .collect();
    if segments.is_empty() {
        "topic".to_owned()
    } else {
        segments.join("/")
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::ingest::ingest_path;

    fn write_test_mcap(
        channels: &[(&str, &str)],
        messages: &[(usize, u64, &str)],
    ) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut writer = mcap::write::Writer::new(file.as_file()).unwrap();
        let ids: Vec<u16> = channels
            .iter()
            .map(|(topic, encoding)| {
                writer
                    .add_channel(0, topic, encoding, &BTreeMap::new())
                    .unwrap()
            })
            .collect();
        for (sequence, (channel_index, log_time, body)) in messages.iter().enumerate() {
            writer
                .write_to_known_channel(
                    &mcap::records::MessageHeader {
                        channel_id: ids[*channel_index],
                        sequence: u32::try_from(sequence).unwrap(),
                        log_time: *log_time,
                        publish_time: *log_time,
                    },
                    body.as_bytes(),
                )
                .unwrap();
        }
        writer.finish().unwrap();
        file
    }

    #[test]
    fn flattens_sorts_and_backfills_json_channels() {
        let file = write_test_mcap(
            &[("/Vehicle/IMU", "json"), ("/other", "protobuf")],
            &[
                (0, 2_000_000_000, r#"{"accel":{"x":1.5,"y":-2.0},"ok":true}"#),
                (1, 1_000_000_000, "\x00\x01"),
                (0, 1_000_000_000, r#"{"accel":{"x":0.5},"name":"imu"}"#),
                (0, 3_000_000_000, r#"{"accel":{"x":2.5,"y":-3.0},"ok":false}"#),
            ],
        );
        let mut store = SignalStore::new();
        let summary = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap();

        assert_eq!(summary.row_count, 3);
        let x = store.signal_by_path("vehicle/imu/accel/x").unwrap();
        assert_eq!(x.time(), &[1.0, 2.0, 3.0]);
        assert_eq!(x.values(), &[0.5, 1.5, 2.5]);
        let y = store.signal_by_path("vehicle/imu/accel/y").unwrap();
        assert!(y.values()[0].is_nan());
        assert_eq!(y.values()[1], -2.0);
        let ok = store.signal_by_path("vehicle/imu/ok").unwrap();
        assert!(ok.values()[0].is_nan());
        assert_eq!(&ok.values()[1..], &[1.0, 0.0]);
        assert!(store.signal_by_path("vehicle/imu/name").is_none());
    }

    #[test]
    fn rejects_files_with_no_ingestible_channels() {
        let file = write_test_mcap(&[("/other", "protobuf")], &[(0, 1, "\x00")]);
        let mut store = SignalStore::new();
        let error = ingest_path(file.path(), &mut store, &mut |_| {}).unwrap_err();
        assert!(matches!(error, IngestError::NoSupportedChannels(_)));
        assert_eq!(store.sources().count(), 0, "transaction must roll back");
    }
}
```

- [ ] **Step 3: Wire the dispatch in `core/scope-core/src/ingest/mod.rs`**

Add `mod mcap;` under `mod csv;`, add `pub use self::mcap::McapDecoder;` under the `CsvDecoder` re-export, and change the dispatch arm:

```rust
        SourceFormat::Mcap => McapDecoder.ingest(path, store, progress),
```

Delete the `UnsupportedFormat(String)` variant from `IngestError` and add in its place:

```rust
    #[error(transparent)]
    Mcap(#[from] mcap::McapError),
    #[error("no ingestible channels; message encodings present: {0}")]
    NoSupportedChannels(String),
```

Delete the now-obsolete `dispatch_rejects_mcap_until_a_decoder_exists` test from `mod.rs`.

- [ ] **Step 4: Verify**

Run: `./scripts/test.sh core`
Expected: PASS, including the two new MCAP tests. If the `mcap` crate's writer API differs from the test helper above, check `./scripts/dev.sh cargo doc -p mcap --no-deps` — the reader side used by the decoder (`MessageStream`, `Message { channel, log_time, data }`, `Channel { topic, message_encoding }`) is the load-bearing part.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core/Cargo.toml core/scope-core/src/ingest/mod.rs core/scope-core/src/ingest/mcap.rs
git commit -m "decode mcap json channels"
```

---

### Task 4: Pyramid constructors and accessors for the cache

**Files:**

- Modify: `core/scope-core/src/pyramid.rs`
- Modify: `core/scope-core/src/store.rs` (one signature)

**Interfaces:**

- Produces: `Pyramid::from_parts(time: Arc<[f64]>, values: Arc<[f64]>, merged: Vec<Vec<EnvelopeBin>>) -> Pyramid` (asserts column/level shape); `Pyramid::merged_levels(&self) -> &[Vec<EnvelopeBin>]`; `SignalStore::insert_signal` accepts `values: impl Into<Arc<[f64]>>` so cache loads can share one values allocation between store and pyramid.
- Consumers: Task 5 (`cache.rs`).

- [ ] **Step 1: Add to `impl Pyramid` in `core/scope-core/src/pyramid.rs`:**

```rust
    /// Reassembles a pyramid from previously built parts (the sidecar cache).
    ///
    /// # Panics
    ///
    /// Panics when the columns differ in length or the first merged level
    /// does not pair the raw samples. Callers deserializing untrusted bytes
    /// must validate shapes first and treat mismatches as cache misses.
    #[must_use]
    pub fn from_parts(
        time: Arc<[f64]>,
        values: Arc<[f64]>,
        merged: Vec<Vec<EnvelopeBin>>,
    ) -> Self {
        assert_eq!(time.len(), values.len(), "time/value lengths differ");
        assert_eq!(
            merged.first().map_or(0, Vec::len),
            time.len().div_ceil(2),
            "first merged level must pair raw samples"
        );
        Self {
            time,
            values,
            merged,
        }
    }

    /// Stored merged levels; `merged_levels()[0]` is logical level 1.
    #[must_use]
    pub fn merged_levels(&self) -> &[Vec<EnvelopeBin>] {
        &self.merged
    }
```

- [ ] **Step 2: Widen `insert_signal`**

In `core/scope-core/src/store.rs`, change the `insert_signal` signature parameter `values: Vec<f64>` to `values: impl Into<Arc<[f64]>>`, and the body lines that use it to:

```rust
        let values: Arc<[f64]> = values.into();
        let id = SignalId(self.next_signal_id);
        let point_count = values.len();
        let signal = Signal::new(id, source_id, path.clone(), unit, time, values)?;
```

(All existing `Vec<f64>` call sites compile unchanged — `Vec<f64>: Into<Arc<[f64]>>`.)

- [ ] **Step 3: Add a round-trip test to `pyramid.rs` tests:**

```rust
    #[test]
    fn from_parts_reproduces_the_original_queries() {
        let time = (0..1_000).map(f64::from).collect::<Vec<_>>();
        let values = time.iter().map(|value| value.sin()).collect::<Vec<_>>();
        let original = Pyramid::from_samples(&time, &values);
        let rebuilt = Pyramid::from_parts(
            Arc::from(time.clone()),
            Arc::from(values),
            original.merged_levels().to_vec(),
        );
        for &(t0, t1, width) in &[(0.0, 999.0, 100_u32), (10.0, 40.0, 600)] {
            let expected = original.query(t0, t1, width);
            let actual = rebuilt.query(t0, t1, width);
            assert_eq!(expected.level, actual.level);
            assert_eq!(expected.bins, actual.bins);
        }
    }
```

- [ ] **Step 4: Verify, then commit**

Run: `./scripts/test.sh core` — Expected: PASS.

```bash
git add core/scope-core/src/pyramid.rs core/scope-core/src/store.rs
git commit -m "expose pyramid parts for the sidecar cache"
```

---

### Task 5: Persisted pyramid sidecars

**Files:**

- Modify: `Cargo.toml` (workspace deps), `core/scope-core/Cargo.toml`, `core/scope-core/src/lib.rs`
- Create: `core/scope-core/src/cache.rs`
- ADR amendment: `docs/adr/0003-min-max-tile-pyramid.md`

**Interfaces:**

- Consumes: `Pyramid::from_parts` / `merged_levels` (Task 4), `IngestSummary` (Task 2), `SignalStore::transaction`.
- Produces:
  - `scope_core::cache::sidecar_path(source: &Path) -> PathBuf` — `flight.csv` → `flight.csv.sspyr` beside the source.
  - `scope_core::cache::write(source: &Path, row_count: u64, signals: &[(&Signal, &Pyramid)], progress: &mut dyn FnMut(f64)) -> Result<PathBuf, CacheError>` — atomic (temp file + rename).
  - `scope_core::cache::try_load(source: &Path, store: &mut SignalStore, progress: &mut dyn FnMut(f64)) -> Result<Option<LoadedCache>, CacheError>` — `Ok(None)` on ANY structural mismatch (missing, magic, version, fingerprint, checksum, shape); errors only for source-fingerprint IO and store registration conflicts.
  - `LoadedCache { summary: IngestSummary, pyramids: Vec<(SignalId, Pyramid)> }`, `CACHE_VERSION: u32 = 1`.

- [ ] **Step 1: Add the dependency**

Root `Cargo.toml` `[workspace.dependencies]` (alphabetized): `crc32fast = "1.5"`. In `core/scope-core/Cargo.toml` `[dependencies]`: `crc32fast.workspace = true`.

- [ ] **Step 2: Register the module**

In `core/scope-core/src/lib.rs`, add `pub mod cache;` above `pub mod compute;` (keep the list alphabetized).

- [ ] **Step 3: Create `core/scope-core/src/cache.rs`:**

````rust
//! Versioned pyramid sidecar cache (ADR 0003).
//!
//! Layout, all integers little-endian:
//!
//! ```text
//! 0..8    magic  b"\x89SSPYR\r\n"
//! 8..12   cache_version u32
//! 12..20  source byte length u64
//! 20..28  source mtime, ns since epoch, u64
//! 28..32  crc32 of the source's first 64 KiB u32
//! 32..40  directory JSON length u64
//! 40..    directory JSON, then zero padding to an 8-byte boundary
//! ...     payload sections, each 8-byte aligned
//! ```
//!
//! The JSON directory lists per-signal metadata and each payload section's
//! (offset, len, crc32), offsets relative to the payload base. Sections per
//! signal, in order: time column, values column, then one section per merged
//! pyramid level. Levels are arrays of 64-byte bin records; `first`/`last`/
//! `min`/`max` encode `None` as NaN, which is lossless because stored
//! envelope values are always finite by construction.
//!
//! Any structural mismatch is a cache miss (`Ok(None)`), never an error:
//! the caller rebuilds and rewrites.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use scope_protocol::EnvelopeBin;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    ingest::IngestSummary,
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, StoreError},
};

pub const CACHE_VERSION: u32 = 1;
const MAGIC: [u8; 8] = *b"\x89SSPYR\r\n";
const HEADER_LEN: usize = 40;
const BIN_RECORD_LEN: usize = 64;
const FINGERPRINT_HEAD_LEN: usize = 64 * 1024;

/// The sidecar file beside `source`: `<file name>.sspyr`.
#[must_use]
pub fn sidecar_path(source: &Path) -> PathBuf {
    let mut name = source.file_name().unwrap_or_default().to_os_string();
    name.push(".sspyr");
    source.with_file_name(name)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Fingerprint {
    source_len: u64,
    mtime_ns: u64,
    head_crc: u32,
}

fn fingerprint(source: &Path) -> std::io::Result<Fingerprint> {
    let metadata = fs::metadata(source)?;
    let mtime_ns = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let mut head = vec![0_u8; FINGERPRINT_HEAD_LEN];
    let mut file = File::open(source)?;
    let mut filled = 0;
    while filled < head.len() {
        let read = file.read(&mut head[filled..])?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    head.truncate(filled);
    Ok(Fingerprint {
        source_len: metadata.len(),
        mtime_ns,
        head_crc: crc32fast::hash(&head),
    })
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheDirectory {
    row_count: u64,
    signals: Vec<CacheSignal>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheSignal {
    path: String,
    unit: Option<String>,
    point_count: u64,
    sections: Vec<CacheSection>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct CacheSection {
    offset: u64,
    len: u64,
    crc32: u32,
}

#[derive(Debug, Error)]
pub enum CacheError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
}

pub struct LoadedCache {
    pub summary: IngestSummary,
    pub pyramids: Vec<(SignalId, Pyramid)>,
}

/// Writes the sidecar beside `source` atomically (temp file + rename).
///
/// # Errors
///
/// Returns [`CacheError`] when fingerprinting the source or writing the
/// sidecar fails. Callers should treat write failures as non-fatal.
#[allow(clippy::cast_precision_loss)] // progress fractions tolerate rounding
pub fn write(
    source: &Path,
    row_count: u64,
    signals: &[(&Signal, &Pyramid)],
    progress: &mut dyn FnMut(f64),
) -> Result<PathBuf, CacheError> {
    let fingerprint = fingerprint(source)?;
    let mut payload: Vec<u8> = Vec::new();
    let mut directory = CacheDirectory {
        row_count,
        signals: Vec::new(),
    };
    let total = signals.len().max(1);
    for (index, (signal, pyramid)) in signals.iter().enumerate() {
        let mut sections = Vec::new();
        sections.push(append_section(&mut payload, &encode_column(signal.time())));
        sections.push(append_section(&mut payload, &encode_column(signal.values())));
        for level in pyramid.merged_levels() {
            sections.push(append_section(&mut payload, &encode_bins(level)));
        }
        directory.signals.push(CacheSignal {
            path: signal.path.clone(),
            unit: signal.unit.clone(),
            point_count: signal.len() as u64,
            sections,
        });
        progress((index + 1) as f64 / total as f64);
    }

    let directory_json = serde_json::to_vec(&directory)?;
    let mut bytes =
        Vec::with_capacity(HEADER_LEN + directory_json.len() + payload.len() + 8);
    bytes.extend_from_slice(&MAGIC);
    bytes.extend_from_slice(&CACHE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&fingerprint.source_len.to_le_bytes());
    bytes.extend_from_slice(&fingerprint.mtime_ns.to_le_bytes());
    bytes.extend_from_slice(&fingerprint.head_crc.to_le_bytes());
    bytes.extend_from_slice(&(directory_json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&directory_json);
    while bytes.len() % 8 != 0 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&payload);

    let target = sidecar_path(source);
    let temporary = target.with_extension("sspyr.tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, &target)?;
    Ok(target)
}

/// Loads a fingerprint-valid sidecar into `store`; `Ok(None)` is a miss.
///
/// # Errors
///
/// Returns [`CacheError`] when the *source* cannot be fingerprinted or when
/// registration conflicts with signals already in the store. Corrupt or
/// stale sidecar content is a miss, not an error.
pub fn try_load(
    source: &Path,
    store: &mut SignalStore,
    progress: &mut dyn FnMut(f64),
) -> Result<Option<LoadedCache>, CacheError> {
    let path = sidecar_path(source);
    let Ok(bytes) = fs::read(&path) else {
        return Ok(None);
    };
    let expected = fingerprint(source)?;
    let Some((directory, payload)) = parse(&bytes, expected) else {
        return Ok(None);
    };

    let mut decoded = Vec::new();
    let total = directory.signals.len().max(1);
    for (index, entry) in directory.signals.iter().enumerate() {
        let Some(signal) = decode_signal(entry, payload) else {
            return Ok(None);
        };
        decoded.push(signal);
        progress(fraction(index + 1, total));
    }

    let loaded = store.transaction(|store| {
        let source_id = store.register_source(source);
        let mut pyramids = Vec::new();
        let mut signals = Vec::new();
        for entry in decoded {
            let id = store.insert_signal(
                source_id,
                entry.path,
                entry.unit,
                Arc::clone(&entry.time),
                Arc::clone(&entry.values),
            )?;
            pyramids.push((id, Pyramid::from_parts(entry.time, entry.values, entry.merged)));
            signals.push(id);
        }
        Ok::<_, CacheError>(LoadedCache {
            summary: IngestSummary {
                source_id,
                source_path: source.to_owned(),
                row_count: usize::try_from(directory.row_count).unwrap_or(usize::MAX),
                signals,
            },
            pyramids,
        })
    })?;
    Ok(Some(loaded))
}

struct DecodedSignal {
    path: String,
    unit: Option<String>,
    time: Arc<[f64]>,
    values: Arc<[f64]>,
    merged: Vec<Vec<EnvelopeBin>>,
}

fn parse(bytes: &[u8], expected: Fingerprint) -> Option<(CacheDirectory, &[u8])> {
    if bytes.len() < HEADER_LEN || bytes[..8] != MAGIC {
        return None;
    }
    let read_u32 = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
    let read_u64 = |at: usize| Some(u64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?));
    if read_u32(8)? != CACHE_VERSION {
        return None;
    }
    let stored = Fingerprint {
        source_len: read_u64(12)?,
        mtime_ns: read_u64(20)?,
        head_crc: read_u32(28)?,
    };
    if stored != expected {
        return None;
    }
    let directory_len = usize::try_from(read_u64(32)?).ok()?;
    let directory_end = HEADER_LEN.checked_add(directory_len)?;
    let directory: CacheDirectory =
        serde_json::from_slice(bytes.get(HEADER_LEN..directory_end)?).ok()?;
    let payload_base = directory_end.checked_next_multiple_of(8)?;
    Some((directory, bytes.get(payload_base..)?))
}

fn decode_signal(entry: &CacheSignal, payload: &[u8]) -> Option<DecodedSignal> {
    if entry.sections.len() < 2 {
        return None;
    }
    let time = decode_column(section_bytes(payload, entry.sections[0])?)?;
    let values = decode_column(section_bytes(payload, entry.sections[1])?)?;
    let point_count = usize::try_from(entry.point_count).ok()?;
    if time.len() != point_count || values.len() != point_count {
        return None;
    }
    let mut merged = Vec::new();
    let mut expected_len = point_count.div_ceil(2);
    for section in &entry.sections[2..] {
        let level = decode_bins(section_bytes(payload, *section)?)?;
        if level.len() != expected_len {
            return None;
        }
        merged.push(level);
        expected_len = expected_len.div_ceil(2);
    }
    if point_count > 0 && merged.last().is_none_or(|level| level.len() != 1) {
        return None;
    }
    Some(DecodedSignal {
        path: entry.path.clone(),
        unit: entry.unit.clone(),
        time: time.into(),
        values: values.into(),
        merged,
    })
}

fn section_bytes(payload: &[u8], section: CacheSection) -> Option<&[u8]> {
    let start = usize::try_from(section.offset).ok()?;
    let len = usize::try_from(section.len).ok()?;
    let bytes = payload.get(start..start.checked_add(len)?)?;
    (crc32fast::hash(bytes) == section.crc32).then_some(bytes)
}

fn append_section(payload: &mut Vec<u8>, bytes: &[u8]) -> CacheSection {
    while payload.len() % 8 != 0 {
        payload.push(0);
    }
    let section = CacheSection {
        offset: payload.len() as u64,
        len: bytes.len() as u64,
        crc32: crc32fast::hash(bytes),
    };
    payload.extend_from_slice(bytes);
    section
}

fn encode_column(values: &[f64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 8);
    for value in values {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn decode_column(bytes: &[u8]) -> Option<Vec<f64>> {
    if bytes.len() % 8 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(8)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("8-byte chunk")))
            .collect(),
    )
}

fn encode_bins(bins: &[EnvelopeBin]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bins.len() * BIN_RECORD_LEN);
    for bin in bins {
        out.extend_from_slice(&bin.t0.to_le_bytes());
        out.extend_from_slice(&bin.t1.to_le_bytes());
        for value in [bin.first, bin.last, bin.min, bin.max] {
            out.extend_from_slice(&value.unwrap_or(f64::NAN).to_le_bytes());
        }
        out.extend_from_slice(&bin.sample_count.to_le_bytes());
        out.push(u8::from(bin.has_gap));
        out.extend_from_slice(&[0_u8; 7]);
    }
    out
}

fn decode_bins(bytes: &[u8]) -> Option<Vec<EnvelopeBin>> {
    if bytes.len() % BIN_RECORD_LEN != 0 {
        return None;
    }
    let field = |chunk: &[u8], at: usize| {
        f64::from_le_bytes(chunk[at..at + 8].try_into().expect("8-byte field"))
    };
    let optional = |chunk: &[u8], at: usize| {
        let value = field(chunk, at);
        (!value.is_nan()).then_some(value)
    };
    Some(
        bytes
            .chunks_exact(BIN_RECORD_LEN)
            .map(|chunk| EnvelopeBin {
                t0: field(chunk, 0),
                t1: field(chunk, 8),
                first: optional(chunk, 16),
                last: optional(chunk, 24),
                min: optional(chunk, 32),
                max: optional(chunk, 40),
                sample_count: u64::from_le_bytes(chunk[48..56].try_into().expect("8-byte field")),
                has_gap: chunk[56] != 0,
            })
            .collect(),
    )
}

#[allow(clippy::cast_precision_loss)]
fn fraction(done: usize, total: usize) -> f64 {
    done as f64 / total as f64
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;
    use crate::ingest::ingest_path;

    fn csv_source(dir: &tempfile::TempDir) -> PathBuf {
        let path = dir.path().join("flight.csv");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "time,alt,speed").unwrap();
        for row in 0..500 {
            let speed = if row == 42 {
                "bad".to_owned()
            } else {
                format!("{}", 100 - row)
            };
            writeln!(file, "{row},{},{speed}", row * 2).unwrap();
        }
        path
    }

    fn build(source: &Path) -> (SignalStore, IngestSummary, Vec<(SignalId, Pyramid)>) {
        let mut store = SignalStore::new();
        let summary = ingest_path(source, &mut store, &mut |_| {}).unwrap();
        let pyramids: Vec<(SignalId, Pyramid)> = summary
            .signals
            .iter()
            .map(|id| (*id, Pyramid::from_signal(store.signal(*id).unwrap())))
            .collect();
        (store, summary, pyramids)
    }

    fn write_sidecar(
        source: &Path,
        store: &SignalStore,
        summary: &IngestSummary,
        pyramids: &[(SignalId, Pyramid)],
    ) {
        let entries: Vec<(&Signal, &Pyramid)> = pyramids
            .iter()
            .map(|(id, pyramid)| (store.signal(*id).unwrap(), pyramid))
            .collect();
        write(source, summary.row_count as u64, &entries, &mut |_| {}).unwrap();
    }

    #[test]
    fn sidecar_round_trips_store_and_pyramid_queries() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);
        assert!(sidecar_path(&source).exists());

        let mut fresh = SignalStore::new();
        let mut fractions = Vec::new();
        let loaded = try_load(&source, &mut fresh, &mut |f| fractions.push(f))
            .unwrap()
            .expect("cache hit");
        assert_eq!(loaded.summary.row_count, summary.row_count);
        assert_eq!(loaded.pyramids.len(), pyramids.len());
        assert!(!fractions.is_empty());
        for ((_, original), (id, cached)) in pyramids.iter().zip(&loaded.pyramids) {
            let expected = original.query(0.0, 499.0, 100);
            let actual = cached.query(0.0, 499.0, 100);
            assert_eq!(expected.level, actual.level);
            assert_eq!(expected.bins, actual.bins);
            assert_eq!(fresh.signal(*id).unwrap().len(), 500);
        }
        // the NaN cell survives as a gap
        let speed = fresh.signal_by_path("flight/speed").unwrap();
        assert!(speed.values()[42].is_nan());
    }

    #[test]
    fn missing_sidecar_is_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let mut store = SignalStore::new();
        assert!(try_load(&source, &mut store, &mut |_| {}).unwrap().is_none());
    }

    #[test]
    fn changed_source_is_a_miss() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);

        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        writeln!(file, "999,1,1").unwrap();
        drop(file);

        let mut fresh = SignalStore::new();
        assert!(try_load(&source, &mut fresh, &mut |_| {}).unwrap().is_none());
        assert_eq!(fresh.signals().count(), 0);
    }

    #[test]
    fn corrupt_payload_and_truncation_are_misses() {
        let dir = tempfile::tempdir().unwrap();
        let source = csv_source(&dir);
        let (store, summary, pyramids) = build(&source);
        write_sidecar(&source, &store, &summary, &pyramids);
        let path = sidecar_path(&source);
        let original = fs::read(&path).unwrap();

        let mut corrupt = original.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 0xFF;
        fs::write(&path, &corrupt).unwrap();
        let mut fresh = SignalStore::new();
        assert!(try_load(&source, &mut fresh, &mut |_| {}).unwrap().is_none());

        fs::write(&path, &original[..original.len() / 2]).unwrap();
        assert!(try_load(&source, &mut fresh, &mut |_| {}).unwrap().is_none());

        let mut versioned = original;
        versioned[8..12].copy_from_slice(&2_u32.to_le_bytes());
        fs::write(&path, &versioned).unwrap();
        assert!(try_load(&source, &mut fresh, &mut |_| {}).unwrap().is_none());
    }
}
````

Note: `checked_next_multiple_of` and `div_ceil` are stable well below the workspace's `rust-version = 1.85`.

- [ ] **Step 4: Verify**

Run: `./scripts/test.sh core`
Expected: PASS — four new cache tests plus everything prior.

- [ ] **Step 5: Amend ADR 0003**

Append to `docs/adr/0003-min-max-tile-pyramid.md`:

```markdown
## Amendment (2026-07-24, Phase 1)

The sidecar cache v1 ships as `<source file name>.sspyr` beside the source:
a 40-byte header (magic `\x89SSPYR\r\n`, `cache_version`, source fingerprint
= byte length + mtime ns + crc32 of the first 64 KiB), a JSON directory of
per-signal sections, and 8-byte-aligned little-endian payload sections
(time column, values column, then merged levels as 64-byte bin records;
optional envelope fields encode `None` as NaN — sound because stored
envelope values are finite by construction). Every section carries its own
crc32. Raw columns are cached alongside levels so a hit skips decode
entirely. Corrupt or stale sidecars are cache _misses_ that trigger rebuild
and rewrite; write failures (e.g. read-only directories) are non-fatal.
```

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock core/scope-core/Cargo.toml core/scope-core/src/lib.rs core/scope-core/src/cache.rs docs/adr/0003-min-max-tile-pyramid.md
git commit -m "persist pyramid sidecars beside sources"
```

---

### Task 6: Shell — ingest jobs, polling, native dialogs (+ ADR 0009)

**Files:**

- Modify: `shell/src-tauri/Cargo.toml`, `shell/src-tauri/capabilities/default.json`
- Rewrite: `shell/src-tauri/src/lib.rs`
- Create: `docs/adr/0009-ingest-jobs-and-progress.md`

**Interfaces:**

- Consumes: `cache::{try_load, write}`, `ingest_path`, `Pyramid`, protocol v2 types.
- Produces Tauri commands (all payloads wrapped in `Envelope`):
  - `pick_sources() -> Envelope<Vec<String>>` — native multi-file dialog; empty = cancelled.
  - `ingest_source(request: Envelope<IngestRequest>) -> Envelope<IngestJob>` — spawns a worker thread, returns immediately.
  - `ingest_status(request: Envelope<IngestJob>) -> Envelope<IngestStatus>` — poll target.
  - `list_sources() -> Envelope<Vec<SourceSummary>>`.
  - `list_signals`, `query_tiles` — unchanged behavior.
  - The old `ingest_csv` command is deleted.

- [ ] **Step 1: Add the dialog plugin**

`shell/src-tauri/Cargo.toml` `[dependencies]`, after the `tauri` line:

```toml
tauri-plugin-dialog = "2"
```

`shell/src-tauri/capabilities/default.json` — permissions become:

```json
  "permissions": ["core:default", "dialog:default"]
```

- [ ] **Step 2: Replace `shell/src-tauri/src/lib.rs` with:**

```rust
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};

use scope_core::{
    cache,
    ingest::ingest_path,
    pyramid::Pyramid,
    store::{Signal, SignalId, SignalStore, Source},
};
use scope_protocol::{
    Envelope, IngestJob, IngestRequest, IngestResponse, IngestStage, IngestState, IngestStatus,
    SignalSummary, SignalTile, SourceSummary, TileRequest, TileResponse,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DataState {
    store: SignalStore,
    pyramids: BTreeMap<SignalId, Pyramid>,
}

#[derive(Default)]
struct IngestJobs {
    next_job_id: u64,
    jobs: BTreeMap<u64, IngestStatus>,
}

fn running(stage: IngestStage, fraction: f64) -> IngestStatus {
    IngestStatus {
        state: IngestState::Running,
        stage,
        fraction,
        response: None,
        error: None,
    }
}

fn signal_summary(signal: &Signal) -> SignalSummary {
    let time = signal.time();
    SignalSummary {
        signal_id: signal.id.0,
        path: signal.path.clone(),
        unit: signal.unit.clone(),
        point_count: signal.len() as u64,
        t_min: time.first().copied().unwrap_or(0.0),
        t_max: time.last().copied().unwrap_or(1.0),
    }
}

fn source_summary(source: &Source) -> SourceSummary {
    SourceSummary {
        source_id: source.id.0,
        path: source.path.display().to_string(),
        point_count: source.point_count as u64,
    }
}

fn set_job(app: &AppHandle, job_id: u64, status: IngestStatus) {
    if let Ok(mut jobs) = app.state::<Mutex<IngestJobs>>().inner().lock() {
        jobs.jobs.insert(job_id, status);
    }
}

fn run_ingest_job(app: &AppHandle, job_id: u64, path: &Path) {
    let status = match ingest_with_cache(app, job_id, path) {
        Ok(response) => IngestStatus {
            state: IngestState::Done,
            stage: IngestStage::Cache,
            fraction: 1.0,
            response: Some(response),
            error: None,
        },
        Err(error) => IngestStatus {
            state: IngestState::Failed,
            stage: IngestStage::Decode,
            fraction: 0.0,
            response: None,
            error: Some(error),
        },
    };
    set_job(app, job_id, status);
}

#[allow(clippy::cast_precision_loss)] // progress fractions tolerate rounding
fn ingest_with_cache(app: &AppHandle, job_id: u64, path: &Path) -> Result<IngestResponse, String> {
    let state = app.state::<Mutex<DataState>>();
    let mut data = state.lock().map_err(|error| error.to_string())?;
    let DataState { store, pyramids } = &mut *data;

    let mut on_cache = |fraction| set_job(app, job_id, running(IngestStage::Cache, fraction));
    let summary = match cache::try_load(path, store, &mut on_cache)
        .map_err(|error| error.to_string())?
    {
        Some(loaded) => {
            for (id, pyramid) in loaded.pyramids {
                pyramids.insert(id, pyramid);
            }
            loaded.summary
        }
        None => {
            let mut on_decode =
                |fraction| set_job(app, job_id, running(IngestStage::Decode, fraction));
            let summary =
                ingest_path(path, store, &mut on_decode).map_err(|error| error.to_string())?;
            let total = summary.signals.len().max(1);
            for (index, id) in summary.signals.iter().enumerate() {
                let signal = store
                    .signal(*id)
                    .ok_or_else(|| format!("ingested signal {id:?} is missing"))?;
                pyramids.insert(*id, Pyramid::from_signal(signal));
                set_job(
                    app,
                    job_id,
                    running(IngestStage::Pyramid, (index + 1) as f64 / total as f64),
                );
            }
            let entries: Vec<(&Signal, &Pyramid)> = summary
                .signals
                .iter()
                .filter_map(|id| Some((store.signal(*id)?, pyramids.get(id)?)))
                .collect();
            let mut on_write =
                |fraction| set_job(app, job_id, running(IngestStage::Cache, fraction));
            if let Err(error) = cache::write(path, summary.row_count as u64, &entries, &mut on_write)
            {
                eprintln!("pyramid sidecar not written for {}: {error}", path.display());
            }
            summary
        }
    };

    let source = store
        .sources()
        .find(|source| source.id == summary.source_id)
        .ok_or_else(|| "ingested source is missing".to_owned())?;
    let signals = summary
        .signals
        .iter()
        .filter_map(|id| store.signal(*id))
        .map(signal_summary)
        .collect();
    Ok(IngestResponse {
        source: source_summary(source),
        signals,
    })
}

#[tauri::command]
async fn pick_sources(app: AppHandle) -> Result<Envelope<Vec<String>>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Signal sources", &["csv", "tsv", "txt", "dat", "mcap"])
            .blocking_pick_files()
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.display().to_string())
            .collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_source(
    request: Envelope<IngestRequest>,
    app: AppHandle,
    jobs: State<'_, Mutex<IngestJobs>>,
) -> Result<Envelope<IngestJob>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let job_id = {
        let mut jobs = jobs.lock().map_err(|error| error.to_string())?;
        jobs.next_job_id += 1;
        let id = jobs.next_job_id;
        jobs.jobs.insert(id, running(IngestStage::Decode, 0.0));
        id
    };
    let path = PathBuf::from(request.path);
    thread::spawn(move || run_ingest_job(&app, job_id, &path));
    Ok(Envelope::new(IngestJob { job_id }))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_status(
    request: Envelope<IngestJob>,
    jobs: State<'_, Mutex<IngestJobs>>,
) -> Result<Envelope<IngestStatus>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let jobs = jobs.lock().map_err(|error| error.to_string())?;
    let status = jobs
        .jobs
        .get(&request.job_id)
        .ok_or_else(|| format!("unknown ingest job: {}", request.job_id))?;
    Ok(Envelope::new(status.clone()))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_sources(state: State<'_, Mutex<DataState>>) -> Result<Envelope<Vec<SourceSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.sources().map(source_summary).collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn list_signals(
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<Vec<SignalSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.signals().map(signal_summary).collect(),
    ))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn query_tiles(
    request: Envelope<TileRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<TileResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let data = state.lock().map_err(|error| error.to_string())?;
    let mut series = Vec::new();
    for raw_id in request.signal_ids {
        let signal_id = SignalId(raw_id);
        let signal = data
            .store
            .signal(signal_id)
            .ok_or_else(|| format!("unknown signal id: {raw_id}"))?;
        let pyramid = data
            .pyramids
            .get(&signal_id)
            .ok_or_else(|| format!("pyramid is unavailable for signal id: {raw_id}"))?;
        let query = pyramid.query(request.window.t0, request.window.t1, request.pixel_width);
        series.push(SignalTile {
            signal_id: raw_id,
            signal_path: signal.path.clone(),
            unit: signal.unit.clone(),
            level: query.level,
            bins: query.bins,
        });
    }

    Ok(Envelope::new(TileResponse {
        request_id: request.request_id,
        series,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the native `SignalScope` application.
///
/// # Panics
///
/// Panics when Tauri cannot initialize or run the application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(DataState::default()))
        .manage(Mutex::new(IngestJobs::default()))
        .invoke_handler(tauri::generate_handler![
            pick_sources,
            ingest_source,
            ingest_status,
            list_sources,
            list_signals,
            query_tiles
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SignalScope");
}
```

If `app.state::<Mutex<IngestJobs>>().inner().lock()` trips a borrow/deref error on your Tauri patch version, `app.state::<Mutex<IngestJobs>>().lock()` is equivalent — `State` derefs to the inner value.

- [ ] **Step 3: Verify the workspace compiles and clippy is clean**

Run: `./scripts/ci.sh rust`
Expected: PASS (shell compiles against the dialog plugin; no clippy warnings).

- [ ] **Step 4: Manual smoke test**

Run: `./scripts/run.sh` — in the app window nothing calls the new commands yet (frontend wiring is Task 7 + UI plan Task 6); just confirm the workbench still boots and renders the empty native store. Optional deeper check after the UI plan lands.

- [ ] **Step 5: Write `docs/adr/0009-ingest-jobs-and-progress.md`:**

```markdown
# ADR 0009: Ingest jobs, progress reporting, and MCAP scope

- Status: Accepted
- Date: 2026-07-24

## Context

Phase 1 needs native file dialogs, MCAP ingest, and visible progress for
multi-second ingests. The frontend has zero runtime dependencies and talks
to the shell exclusively through versioned request/response envelopes; the
same presentation code must keep working inside snapshots, which have no
shell at all.

## Decision

Ingest runs as a background job. `ingest_source` registers a job and
returns its id immediately; a worker thread decodes, builds pyramids, and
maintains the sidecar cache, publishing `IngestStatus { state, stage,
fraction }` into a job table. The frontend polls `ingest_status` (~150 ms)
until `done` or `failed`. No Tauri events or channels: that would pull
`@tauri-apps/api` (or fragile raw-internals code) into a dependency-free
frontend, and polling composes with the existing envelope discipline. A
push channel can replace the poll loop later without changing job
semantics.

Format dispatch sniffs content (MCAP magic `\x89MCAP0\r\n`; everything else
is CSV-like). MCAP v1 decodes channels whose `message_encoding` is `json`:
numeric and boolean leaves flatten to `topic/field/subfield` signals on the
`log_time` timebase (ns → f64 seconds), rows sorted by time, ragged fields
NaN-backfilled so they surface as pyramid gaps. Other encodings are counted
and reported; a file with no ingestible channels fails with the encodings
it does contain. Decode-stage progress is byte-accurate for CSV and
endpoint-only for MCAP (the message stream has no cheap byte total).

Host-only abilities surface on the frontend `DataPlane` as capability
ports (`ingest: IngestPort | null`); UI may branch on a port's presence,
never on host identity (ADR 0001 amendment).

## Consequences

The store mutex is held for a job's duration, so tile queries block while
a new file ingests — acceptable while first-load dominates; revisit with
the out-of-core store. The MCAP reader currently loads the whole file into
memory, matching the in-memory Phase 1 store; the `Decoder` seam hides the
change when mmap-backed columns land. Live sources later become long-lived
jobs publishing the same status shape.
```

- [ ] **Step 6: Commit**

```bash
git add shell/src-tauri/Cargo.toml Cargo.lock shell/src-tauri/capabilities/default.json shell/src-tauri/src/lib.rs docs/adr/0009-ingest-jobs-and-progress.md
git commit -m "serve ingest as polled jobs with native file dialogs"
```

---

### Task 7: Frontend ingest capability port (+ ADR 0001 amendment)

**Files:**

- Modify: `frontend/src/app/data-plane.ts`
- Create: `frontend/src/app/ingest.ts`
- Test: `frontend/src/app/ingest.test.ts`
- ADR amendment: `docs/adr/0001-product-shape-and-two-host-frontend.md`

**Interfaces:**

- Produces (consumed by UI plan Task 6):

```ts
export interface IngestPort {
  pickSources(): Promise<string[]>;
  start(path: string): Promise<string>; // job id
  status(jobId: string): Promise<IngestStatus>;
}
// on DataPlane:
readonly ingest: IngestPort | null; // null on BakedPlane
listSources(): Promise<SourceSummary[]>;
// helper:
runIngest(port, path, onProgress, pollIntervalMs?): Promise<IngestResponse>
```

- [ ] **Step 1: Extend `frontend/src/app/data-plane.ts`**

Extend the imports from `../generated/protocol` with `IngestJob`, `IngestRequest`, `IngestStatus`, `SourceSummary` (all `type` imports). Replace the `DataPlane` interface and add the port:

```ts
export interface IngestPort {
  pickSources(): Promise<string[]>;
  start(path: string): Promise<string>;
  status(jobId: string): Promise<IngestStatus>;
}

export interface DataPlane {
  readonly sourceLabel: string;
  readonly ingest: IngestPort | null;
  listSignals(): Promise<SignalSummary[]>;
  listSources(): Promise<SourceSummary[]>;
  queryTiles(request: TileRequest): Promise<TileResponse>;
}
```

In `TauriPlane`, add:

```ts
  readonly ingest: IngestPort;

  constructor(private readonly invoke: TauriInternals["invoke"]) {
    this.ingest = {
      pickSources: async () =>
        open(await this.invoke<Envelope<string[]>>("pick_sources")),
      start: async (path: string) =>
        open(
          await this.invoke<Envelope<IngestJob>>("ingest_source", {
            request: seal<IngestRequest>({ path }),
          }),
        ).job_id,
      status: async (jobId: string) =>
        open(
          await this.invoke<Envelope<IngestStatus>>("ingest_status", {
            request: seal<IngestJob>({ job_id: jobId }),
          }),
        ),
    };
  }

  async listSources(): Promise<SourceSummary[]> {
    return open(await this.invoke<Envelope<SourceSummary[]>>("list_sources"));
  }
```

In `BakedPlane`, add:

```ts
  readonly ingest = null;

  listSources(): Promise<SourceSummary[]> {
    const points = this.payload.signals.reduce(
      (total, signal) => total + Number(signal.summary.point_count),
      0,
    );
    return Promise.resolve([
      { source_id: "0", path: this.sourceLabel, point_count: String(points) },
    ]);
  }
```

- [ ] **Step 2: Create `frontend/src/app/ingest.ts`:**

```ts
import type { IngestResponse, IngestStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";

const POLL_INTERVAL_MS = 150;

export async function runIngest(
  port: IngestPort,
  path: string,
  onProgress: (status: IngestStatus) => void,
  pollIntervalMs: number = POLL_INTERVAL_MS,
): Promise<IngestResponse> {
  const jobId = await port.start(path);
  for (;;) {
    const status = await port.status(jobId);
    onProgress(status);
    if (status.state === "done") {
      if (status.response === null) {
        throw new Error("Ingest finished without a response");
      }
      return status.response;
    }
    if (status.state === "failed") {
      throw new Error(status.error ?? "Ingest failed");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}
```

- [ ] **Step 3: Write `frontend/src/app/ingest.test.ts`:**

```ts
import { describe, expect, it } from "vitest";

import type { IngestResponse, IngestStatus } from "../generated/protocol";
import type { IngestPort } from "./data-plane";
import { runIngest } from "./ingest";

const response: IngestResponse = {
  source: { source_id: "1", path: "/tmp/flight.csv", point_count: "10" },
  signals: [],
};

function fakePort(statuses: IngestStatus[]): IngestPort {
  const queue = [...statuses];
  return {
    pickSources: () => Promise.resolve([]),
    start: () => Promise.resolve("7"),
    status: () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("status queue exhausted");
      return Promise.resolve(next);
    },
  };
}

const running = (
  stage: IngestStatus["stage"],
  fraction: number,
): IngestStatus => ({
  state: "running",
  stage,
  fraction,
  response: null,
  error: null,
});

describe("runIngest", () => {
  it("polls until done and reports every status", async () => {
    const seen: IngestStatus[] = [];
    const port = fakePort([
      running("decode", 0.5),
      running("pyramid", 1),
      { state: "done", stage: "cache", fraction: 1, response, error: null },
    ]);
    const result = await runIngest(
      port,
      "/tmp/flight.csv",
      (s) => seen.push(s),
      0,
    );
    expect(result).toEqual(response);
    expect(seen.map((s) => s.stage)).toEqual(["decode", "pyramid", "cache"]);
  });

  it("throws the job error on failure", async () => {
    const port = fakePort([
      {
        state: "failed",
        stage: "decode",
        fraction: 0,
        response: null,
        error: "boom",
      },
    ]);
    await expect(
      runIngest(port, "/tmp/flight.csv", () => undefined, 0),
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 4: Run the frontend suite**

Run: `./scripts/test.sh frontend`
Expected: PASS (lint, typecheck, codegen check, both new tests, snapshot artifact checks — the snapshot still builds because `BakedPlane` satisfies the widened interface).

- [ ] **Step 5: Amend ADR 0001**

Append to `docs/adr/0001-product-shape-and-two-host-frontend.md`:

```markdown
## Amendment (2026-07-24, Phase 1)

Host-only abilities are expressed as capability ports on `DataPlane`
(first: `ingest: IngestPort | null`). UI behavior may branch on a port's
presence — never on host identity — so snapshot builds simply present no
entry points for capabilities their plane lacks.
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/data-plane.ts frontend/src/app/ingest.ts frontend/src/app/ingest.test.ts docs/adr/0001-product-shape-and-two-host-frontend.md
git commit -m "add the frontend ingest capability port"
```

---

### Final gate

- [ ] Run `./scripts/ci.sh all` — Expected: PASS end to end (format, rust, frontend, e2e).
- [ ] Manual: `./scripts/run.sh`, then (once UI plan Task 6 is merged) Open Files → pick a CSV → progress in the source footer → signals appear; re-open the same file after restart → near-instant load from the `.sspyr` sidecar; repeat with an MCAP file containing json channels.
- [ ] Hand off noting the decision log at the top of this plan for maintainer review.
