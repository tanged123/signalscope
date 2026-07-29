# Multi-Source Scale and Extensible Ingest Design

**Status:** Draft (brainstorm; revised 2026-07-29 after adversarial
review corrected the memory arithmetic, session addressing, MCAP
naming, ensemble statistics, and seam claims of the first draft)

**Date:** 2026-07-29

## Goal

Grow the Rust data backend along two axes:

- **A — many sources.** Go from one file per workspace to hundreds or
  thousands (Monte Carlo sweeps, batch test campaigns) with usable
  ingest, memory, naming, and ensemble-plotting semantics.
- **B — extensible formats.** Let developers add decoders cheaply and
  let non-developer users describe arbitrary container layouts
  (`.mat`, `.h5`, and similar) without writing Rust.

This is deliberately a pull-forward of the roadmap's v2 "Monte Carlo
envelope ergonomics" item, planned before the Phase 5 benchmarks
exist. It preserves the architecture invariants — transactional
registration, versioned protocol and session schemas, the two-host
`DataPlane`, pyramid semantics — but it does **not** fit behind the
current code seams unchanged: it amends the `Decoder` trait, the
store's column representation, the sidecar format, and both schemas.
Each phase below names its breakage. Parsing happens only in the
native host; the frontend and snapshots never see source formats or
plugins.

## Where the current design tops out

- Dispatch is a hard-coded two-variant enum (`sniff_format`). The
  edit cost of adding a built-in format is small (one decoder, one
  `SUPPORTED_FORMATS` entry, one match arm); the real limit is that
  nothing can register a format at runtime, which recipes and
  plugins require.
- One job ingests one file, the store mutex is held for the whole job
  (ADR 0009 consequence), and `Decoder::decode` registers signals
  into the store mid-decode — there is no decoded-but-uncommitted
  value to move off the lock. Neither decoder streams: CSV slurps the
  file and copies every column once more when sorting; MCAP reads the
  whole file (ADR 0009).
- Naming is format-inconsistent and is the durable API. CSV prefixes
  the normalized file stem; MCAP registers bare `topic/field` paths,
  so two recordings of the same vehicle collide with
  `DuplicateSignal` immediately, whatever the filenames. Sessions
  address series, annotations, favorites, and derived expressions by
  these display paths — renaming is a breaking session change, not a
  cosmetic one.
- Memory: raw columns cost 16 bytes per sample (8 when a file shares
  one time column), but resident pyramids cost more — roughly one
  `EnvelopeBin` per raw sample at ~120 bytes in RAM. A 1,000-run
  sweep at 16 signals × 200k points is ~27 GB of columns and
  ~380 GB of bins. Bins, not columns, are the scaling wall.
- The multi-file open loop aborts the whole batch on the first
  failure, and session restore re-ingests `source_paths` one file at
  a time with 150 ms status polling — minutes of pure poll latency at
  a thousand sources, on every launch via autosave.
- There is no cross-source concept: no run grouping, no ensemble
  envelope.

## Part A — hundreds to thousands of sources

### Identity and naming

Split identity into `(source_id, local_path)` with the display path
composed as `prefix/local_path`. The prefix is a per-source attribute
assigned **deterministically**: canonical source paths are sorted
before assignment, so re-ingesting the same inputs always yields the
same prefixes regardless of worker commit order (sessions and
snapshot determinism both depend on display-path stability).
`DuplicateSignal` then guards only genuine collisions inside one
source.

This changes every MCAP path (bare today) and is therefore a breaking
session-schema change with a real migration, not a prefix cosmetic.
Because loading a session already re-ingests `source_paths`
(ADR 0022), the migration can run at restore time: each re-ingested
source knows both its legacy path form (per-format) and its new one,
producing an old→new map that rewrites series, annotations,
favorites, and the path literals inside derived expressions (via the
expression parser, not string substitution). `SignalSummary` gains
`source_id` and `local_path` so the tree can group by run — the one
protocol change the identity model depends on.

### Batch ingest jobs

Amends ADR 0009 (explicitly — the "mutex held for a job's duration"
consequence is retired):

- The `Decoder` trait changes: `decode` returns decoded columns
  (`DecodedSource { signals }`) without touching the store, and
  registration becomes a host-side commit step. The cache-hit load
  path already has exactly this shape and becomes the only shape.
- `IngestBatchRequest { paths }` (the shell expands directory picks
  and globs) registers one job. Decode and pyramid-build run on a
  bounded worker pool off the store lock; each finished file commits
  under a short write lock via the per-file transaction, with its
  pre-assigned prefix.
- Failure policy is per-file: a sweep must not abort at run 517.
  Failed files land in the batch summary; succeeded runs stay
  registered. Single-file ingest keeps today's atomicity.
- Batch status is incremental — aggregate fraction, done/failed
  counts, and recent failures — never a thousand-entry array
  serialized into a 150 ms poll. Per-file detail is a follow-up
  request.
- Session restore switches to the same batch path, fixing the
  sequential re-ingest on launch.
- Peak RSS is bounded by workers × (file bytes + columns + one sort
  copy) until decoders stream. Making the CSV decoder genuinely
  streaming belongs to this phase; MCAP stays whole-file (ADR 0009)
  until the out-of-core work.

### Source sets and ensemble queries

A `SourceSet` groups sources whose signals share a schema
fingerprint, with tolerance real sweeps need: ingest silently drops
all-NaN columns today, so a run with a dead sensor must remain a
partial member (fingerprint on the union of `local_path`s with a
per-member missing set), and the per-file time-column heuristic can
put identical runs on different timebases (named column vs. monotonic
fallback vs. synthetic index). Sets record each member's timebase
choice and refuse ensemble statistics across mixed timebases; recipes
(Part B) can pin the time column for a sweep. Batch ingest
auto-proposes sets; users group/ungroup explicitly.

The ensemble statistic is **across-run** spread. Pooling the bins'
`sum`/`sum_sq` across runs is wrong twice: it conflates within-bin
temporal variance with run scatter (the band would fatten as you zoom
out), and it weights runs by sample count. Instead, each display bin
aggregates **per-run bin means** with equal run weight: min/max
envelope across runs, mean of run means, σ across run means. Because
member pyramids are sample-index-aligned, their bins only partially
overlap a display bin; overlap-weighted apportionment of the sums is
an explicit approximation (exact only under uniform in-bin sample
spacing). Two execution strategies:

- **Query-time merge** — O(members × bins-per-px) per query. Honest
  for tens of runs; not viewport-bounded at thousands, so it ships
  behind a member-count limit.
- **Set-level ensemble pyramid** — at grouping time, resample member
  bins onto a shared per-level time grid spanning the set and store
  aggregate levels like an ordinary signal's pyramid. Queries become
  viewport-bounded again. This adds bins, so full-scale use depends
  on the out-of-core phase.

Gap semantics: one member's dropout does not gap the band; display
bins carry a contributing-run count and the renderer thins the band
instead. Protocol: `EnsembleTileRequest { set_id, local_path, window,
pixel_width, member_filter }` with `set_id` as a string-represented
`u64` at the TypeScript boundary; response bins include `run_count`.
The tree shows one logical signal per `local_path` with an N-run
badge; selection offers single run, spaghetti (bounded by the series
budget), or band.

Snapshots and export must be answered, not skipped: `queryTiles` is
core `DataPlane`, so either ensemble levels bake into the manifest
(preferred — exported ensemble panels keep rendering) or ensembles
become a nullable capability port and exports lose them. "All loaded"
export at 16,000 signals cannot fit any artifact budget; export gains
per-set/per-source selection, and the estimate path stops replanning
every signal for all range×fidelity combinations on a dialog open.

### Out-of-core storage — bins and columns

Paging columns alone strands ~90% of the footprint, so this phase
addresses both, and it is a cross-cutting `scope-core` refactor, not
a swap behind the current API (`Arc<[f64]>` cannot wrap a mapped
region):

- Columns move to an owned-or-mapped abstraction inside `Signal`.
  Touches `insert_signal`, the pyramid builder (which currently
  stores column `Arc`s for its lifetime and must drop them after
  build), the expression evaluator's `Arc::ptr_eq` shared-timebase
  fast path (replaced by an explicit timebase id), and the cache
  loader.
- Bins split by level: coarse levels stay resident (they are small);
  fine levels map from sidecars on demand with LRU eviction. The
  sidecar format changes to be mmap-friendly and to store a shared
  per-source time section instead of duplicating the time column per
  signal.
- Sidecars live beside the source today, which fails for the normal
  Monte Carlo case of a read-only or network-mounted results
  directory, and write failure is currently non-fatal — impossible
  once the store depends on the files. A cache root (an ADR 0023
  amendment with a preferences schema bump) becomes the fallback and
  the spill target during ingest.
- Derived signals have no backing file; their columns spill to the
  cache root. Set-scoped derived signals — apply an expression per
  member, band the result, which is the actual Monte Carlo ask —
  need expression-language semantics of their own and are deferred to
  a separate design.

## Part B — extensible formats

Three tiers, each with a different author in mind.

### Tier 0 — decoder registry (developers)

Replace the `SourceFormat` enum with a registry of format providers:
`{ id, label, extensions, sniff(&[u8]) -> confidence, decoder() }`.
Dispatch, `SUPPORTED_FORMATS`, and the shell's picker filters derive
from it. Sniffing reads a fixed probe window, highest confidence
wins, ties resolve by registration order, and zero confidence falls
back to CSV-like — preserving today's test-locked total dispatch.
The registry's justification is runtime registration for recipes and
plugins, not the (small) edit cost of built-ins.

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
preferences (the same ADR 0023 amendment as the cache root). When no
recipe matches, an import wizard introspects the container, asks the
user to tag time datasets, and saves the answers as a recipe. A
recipe is data, not code — and that claim is enforced: a recipe
selects datasets, timebases, names, and units, and can never name an
executable, plugin, or decoder binary, because sidecar recipes arrive
with untrusted data directories.

### Tier 2 — sandboxed parser plugins (deferred to its own spec)

For genuinely custom formats beyond what recipes cover, define one
logical plugin API (open → stream column batches → finish) with the
host validating everything: time columns sorted/validated exactly
like CSV ingest, registration limits, names treated as data, the
per-file transaction around registration. The transport decision is
deferred to a dedicated spec with two constraints fixed now. First,
the sandbox story must be honest: a subprocess parser runs with the
user's full privileges — filesystem, network, everything — which is
no isolation at all, so subprocess plugins, if offered, are an
explicitly-trusted developer mode gated on per-executable
registration in preferences, never discovered from data directories.
The sandboxed path is WASM (wasmtime/WIT: no filesystem, no
network). Second, one transport and one encoding ship first, not a
matrix. Plugins are native-host-only and never enter the frontend or
snapshots.

## Protocol and session impact

One version bump per shipping phase, per ADRs 0004/0005 — five phases
cannot share one bump:

- P1: protocol bump (batch job shapes, `source_id`/`local_path` on
  `SignalSummary`, registry-derived formats listing) and a
  **breaking** session bump (display-path rewrite migration above).
- P2: protocol bump (set summaries, ensemble tiles), session bump
  (set membership), snapshot manifest addition for ensemble levels.
- P3: sidecar format version; no wire change expected.
- P4: preferences schema bump (cache root, recipe directory) with
  ADR 0023 amendment; session records the recipe identity used per
  source.
- P5: per the plugin spec.

Unknown-version rules are unchanged: fail clearly, never partially
restore.

## Phasing

1. **P1 — registry + batch ingest + naming.** Decoder trait change,
   registry, batch jobs with off-lock decode and per-file failure
   policy, deterministic prefixes, session path migration, batch
   session restore, streaming CSV decode. The user-visible win is
   parallel directory loads that survive individual bad files.
2. **P2 — source sets + ensemble tiles at bounded scale.** Grouping
   with partial members and timebase checks, query-time ensemble
   merge behind a member limit (tens of runs), band rendering, the
   snapshot/export answer.
3. **P3 — out-of-core bins and columns.** Unlocks thousand-run
   sweeps and the precomputed ensemble pyramid; benchmarked against
   the Phase 5 targets.
4. **P4 — container readers + recipes.** HDF5/MAT readers, recipe
   format, import wizard, preferences amendment.
5. **P5 — parser plugins.** Dedicated spec, then implementation.

P2 at full Monte Carlo scale explicitly depends on P3; the phases
stay in this order because bounded-scale ensembles already pay for
themselves and de-risk the statistics and protocol before the store
refactor lands. Each phase carries its own ADR and tests: per-file
transactionality under concurrent commits, deterministic naming,
migration fidelity including expression rewrites, ensemble math
against known distributions (including the zoom-invariance of the
band), ragged-set membership, recipe resolution, and hostile plugin
output.

## Open questions

- Ensemble bands beyond min/max/mean/σ: are per-set quantile
  pyramids worth their build cost, or is σ plus the envelope enough
  for v1?
- The shared resample grid for the set-level pyramid: per-level fixed
  bin width from the union span, or anchored to the largest member?
- How much fingerprint mismatch still auto-groups, and what the tree
  shows for partial members.
- Path-migration fidelity limits: expressions that build paths
  dynamically cannot be rewritten — is that acceptable breakage?
- Bin paging granularity and eviction policy (per level, per signal,
  per byte range) against the ADR 0003 render invariants.
- Export budget policy for sets: per-set fidelity caps vs. refusing
  "all" above a source count.
- Cross-run epoch alignment (wall-clock vs. mission time): normalize
  at ingest via recipe rule, or per-set alignment metadata?
