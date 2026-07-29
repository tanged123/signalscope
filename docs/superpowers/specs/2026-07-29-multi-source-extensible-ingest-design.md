# Multi-Source Scale and Extensible Ingest Design

**Status:** Draft (brainstorm)

**Date:** 2026-07-29

## Goal

Grow the Rust data backend along two axes without breaking the
architecture invariants:

- **A — many sources.** Go from one file per workspace to hundreds or
  thousands (Monte Carlo sweeps, batch test campaigns) with usable
  ingest, memory, naming, and ensemble-plotting semantics.
- **B — extensible formats.** Let developers add decoders cheaply and
  let non-developer users describe arbitrary container layouts
  (`.mat`, `.h5`, and similar) without writing Rust.

Everything here stays behind the existing seams: `Decoder` and
transactional registration (`core/scope-core/src/ingest/mod.rs`), the
store boundary that already anticipates mmap-backed columns
(`core/scope-core/src/store.rs`), the versioned protocol, and the
two-host `DataPlane`. Parsing happens only in the native host; the
frontend and snapshots never see source formats or plugins.

## Where the current design tops out

- Dispatch is a hard-coded two-variant enum (`sniff_format`); adding a
  format means editing `scope-core` and every picker-filter list.
- One job ingests one file; the store mutex is held for the whole job
  (ADR 0009 consequence), so tile queries stall during ingest.
- Signal identity is a flat path prefixed with the normalized file
  stem. Two Monte Carlo runs named `run.csv` in different directories
  collide with `DuplicateSignal`; a thousand runs of the same vehicle
  produce a thousand unrelated tree roots.
- Columns are owned `Arc<[f64]>` in RAM. A 1,000-run sweep at 16
  signals × 200k points is ~50 GB of columns — far past in-memory.
- There is no cross-source concept: no run grouping, no ensemble
  envelope, nothing the roadmap's deferred "Monte Carlo envelope
  ergonomics" can attach to.

## Part A — hundreds to thousands of sources

### Identity and naming

Split signal identity into `(source_id, local_path)` and make the
display path derived, not primary. A source's tree prefix becomes a
per-source attribute (default: file stem, deduplicated with a short
parent-directory or ordinal suffix) instead of a baked-in component of
the unique key. `DuplicateSignal` then only guards genuine collisions
inside one source. Sessions and the protocol keep addressing signals
by `signal_id`; serialized source paths gain the prefix so reopened
sessions resolve identically.

### Batch ingest jobs

Extend ADR 0009's job model rather than replacing it:

- `IngestBatchRequest { paths: string[] }` (the shell expands
  directory picks and globs) registers one job with per-file
  sub-statuses: overall fraction, per-file `state/stage/error`.
- Decode and pyramid-build run on a bounded worker pool (default:
  physical cores) off the store lock. Each finished file commits under
  a short write lock via the existing per-file transaction.
- Failure policy is per-file: a sweep must not abort at run 517.
  Failed files are reported in the batch summary; the succeeded runs
  stay registered. The single-file path keeps today's atomicity.

This also retires the ADR 0009 "mutex held for a job's duration"
consequence: queries proceed between per-file commits.

### Source sets and ensemble queries

Introduce a first-class `SourceSet`: an ordered group of sources whose
signals share a schema fingerprint (the set of `local_path`s, order
ignored). Batch ingest auto-proposes a set when most members match;
users can group/ungroup explicitly. Sets are store-level objects with
protocol summaries and session persistence.

On top of sets, add ensemble tiles:

- `EnsembleTileRequest { set_id, member_filter, local_path, window,
pixel_width }` returns per-bin cross-run statistics: min/max
  envelope, mean, and ±σ derived from the existing per-bin `sum` and
  `sum_sq` (ADR 0014). Bins align by time window, never by sample
  index, so runs with different rates or lengths compose without
  resampling raw data.
- The tree shows one logical signal per `local_path` with an N-run
  badge; selection offers single run, all runs (spaghetti, bounded),
  or ensemble band. Exact quantile bands need per-bin value merges
  across runs and are deferred (see open questions).

### Out-of-core columns

Adopt the mmap plan the store boundary reserved: ingest spills decoded
columns to per-source files in the existing sidecar cache directory,
and `Signal` columns become mmap-backed slices. Pyramids (already
persisted as sidecars) stay resident — they are ~1/512 of raw — while
raw columns page in only for level-0 tiles, window-sample requests,
and expression evaluation, with LRU eviction of mapped regions. Peak
ingest RSS becomes bounded by the worker pool, not the sweep size.
This is the "revisit with the out-of-core store" line of ADR 0009 and
a prerequisite for real thousand-run sweeps.

## Part B — extensible formats

Three tiers, each with a different author in mind.

### Tier 0 — decoder registry (developers)

Replace the `SourceFormat` enum with a registry of format providers:
`{ id, label, extensions, sniff(&[u8]) -> confidence, decoder() }`.
`SUPPORTED_FORMATS`, picker filters, and dispatch all derive from the
registry; content sniffing keeps precedence over extensions. Built-ins
register csv and mcap; Parquet (roadmap Phase 5) becomes a registry
entry instead of another enum edit.

### Tier 1 — declarative container recipes (non-developers)

Most "arbitrary `.mat`/`.h5` structures" are ordinary containers with
project-specific layout. Ship generic container readers (HDF5, MAT —
v7.3 is HDF5, older versions via a MAT reader; Parquet/Arrow) plus a
small TOML **recipe** that maps container contents to signals:

- dataset selectors (glob over container paths),
- the time source per selection: a shared time dataset, a sibling
  column, or synthesized `index × dt`,
- naming and unit rules.

Recipes resolve from a sidecar file next to the data
(`foo.h5.scope.toml`), then a user recipe directory referenced from
global preferences (ADR 0023). When no recipe matches, an import
wizard introspects the container, asks the user to tag time datasets,
and saves the answers as a recipe for next time. A recipe is data, not
code: safe to share, diff, and check into a project.

### Tier 2 — sandboxed parser plugins (power users)

For genuinely custom formats, define one plugin boundary with two
candidate transports:

- **Subprocess protocol.** The host spawns a user-registered
  executable (any language, including Python with h5py/scipy) that
  streams column batches over stdout — Arrow IPC or a framed NDJSON
  fallback — plus progress and error frames. Cheap to author, trivial
  to debug, weak isolation (OS process only).
- **WASM component.** A wasmtime/WIT interface with the same logical
  API: host feeds byte ranges, plugin emits column batches. Strong
  sandbox (no filesystem, no network), portable distribution, harder
  authoring toolchain.

Recommendation: specify the logical API once (open → stream batches →
finish), ship the subprocess transport first for reach, and add the
WASM transport when plugin sharing/distribution matters. Either way
the host treats plugin output as untrusted: it validates or sorts time
columns exactly like CSV ingest, enforces registration limits, escapes
names as data, and wraps everything in the per-file transaction so a
buggy parser cannot corrupt the store. Plugins are native-host-only
and never enter the frontend or snapshots.

## Protocol and session impact

- Protocol: additive where possible, one version bump — batch ingest
  request/status shapes, `SourceSetSummary`, ensemble tile
  request/response, and a registry-derived formats listing for
  pickers.
- Session schema: version bump adding source prefixes, source-set
  membership, and the recipe/plugin identity used per source so
  reopening re-resolves through the same path. Unknown-version rules
  are unchanged: fail clearly, never partially restore.

## Phasing

1. **P1 — registry + batch ingest.** Decoder registry, batch jobs
   with per-file status and off-lock decode, prefix-based naming.
   Unblocks "load a directory of CSVs" immediately.
2. **P2 — source sets + ensemble tiles.** Grouping, ensemble
   protocol, band rendering. Delivers Monte Carlo ergonomics.
3. **P3 — out-of-core columns.** Mmap-backed store behind the
   existing boundary; benchmark against Phase 5 targets.
4. **P4 — container readers + recipes.** HDF5/MAT readers, recipe
   format, import wizard.
5. **P5 — parser plugins.** Logical plugin API, subprocess transport,
   WASM evaluation.

Each phase carries its own ADR (registry/batch semantics, source-set
and ensemble semantics, out-of-core store, recipe format, plugin
boundary), tests per the repository expectations (per-file
transactionality, ensemble bin math, recipe resolution, hostile
plugin output), and the usual protocol/session codegen and migration
coverage.

## Open questions

- Ensemble quantiles: exact per-bin merges are O(runs × bins) per
  query — precompute per-set quantile pyramids, or ship min/max/σ
  bands only and defer quantiles?
- Set membership for ragged sweeps: how much schema mismatch (missing
  or extra signals per run) still groups, and what does the tree show
  for partial members?
- Recipe expressiveness ceiling: selectors + time rules only, or
  light transforms (scale/offset, enum decode) before it stops being
  "data, not code"?
- Subprocess plugin trust: registration UX and warnings for running
  user-supplied executables, and whether plugin declarations belong
  in preferences or per-project files.
- Cross-run time alignment for sweeps whose runs use different epochs
  (wall-clock vs. mission time): normalize at ingest via recipe rule,
  or per-set alignment metadata?
