# Multi-Source Scale and Extensible Ingest Design

**Status:** Draft (brainstorm; revised 2026-07-30 after architectural
review resolved durable source identity, session reconciliation,
ensemble materialization, time alignment, cache provenance, export
privacy, and batch resource bounds)

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

Separate durable identity from process-local storage ids:

- `SourceKey` is an opaque UUID assigned when a source first enters a
  workspace and persisted in the session. Set membership and every
  other durable source reference use it.
- `SourceId(u64)` is allocated when that source is registered in the
  current process. It may change after restart and uses the schema's
  string representation at the TypeScript boundary.
- A signal's storage identity is `(SourceId, local_path)`. Its
  durable identity is `(SourceKey, local_path)`, and its display path
  is `prefix/local_path`.

The store keeps separate indexes for storage identity and unique
display path. `DuplicateSignal` guards collisions inside one source;
display-path collisions are rejected as source-prefix allocation
errors rather than producing an ambiguous `signal_by_path`.

Each session persists
`SourceRecord { key, path, prefix, provider_id?,
decode_provenance?, reconcile_legacy }`. Provider and provenance are
nullable only while a migrated source is unavailable.
The default prefix is the normalized file stem plus a short digest of
`SourceKey` when disambiguation is needed, for example `run_a13f`.
It never includes parent-directory text: display paths enter sessions
and snapshots, so filesystem context would defeat export's path
redaction. Prefixes are pre-assigned before workers decode and remain
stable when the workspace grows. A later source-relocation command
updates `path` while retaining the key and prefix.

Batch registration canonicalizes paths only to detect aliases within
the current machine. Repeating a path already present in the
workspace is idempotent; duplicate paths within or across concurrent
batches join one single-flight ingest. A genuinely new source gets a
new `SourceKey` even when its bytes match another source.

This changes every MCAP path (bare today) and is therefore a breaking
session-schema change with a real migration, not a prefix cosmetic.
The pure session migration ladder remains independent of ingest. Its
v10→v11 rung converts each `source_paths` entry to a `SourceRecord`
with a deterministic UUIDv5 derived from a fixed migration namespace
and the stored path string, assigns its prefix, leaves existing signal
references intact, and marks the record as requiring legacy-path
reconciliation. New imports use random UUIDv4 keys.

The native restore service then performs a second, asynchronous
stage. Successful re-ingest determines the provider's legacy naming
rule and produces an old→new alias map. The service atomically
rewrites series, axes, annotations, favorites, and every signal
literal in parsed derived expressions; it never uses string
substitution. A failed or missing source retains its legacy
references and reconciliation marker so a later relocation or retry
can finish the conversion. Autosave is paused until this stage
settles, preventing a partially reconciled restore from replacing the
last good session. An alias claimed by more than one source is
ambiguous: none of its references are rewritten, and restore reports
the conflict for explicit user resolution. This sequencing requires a
P1 ADR that supersedes the restore-order consequence of ADR 0022
without making `scope-core::session` depend on ingest.
The ADR adds a `scope-core::restore` application-service module that
may coordinate session, ingest, store, and expression APIs; those
domain modules do not depend on it, and the Tauri shell only invokes
the service and wires protocol messages.

`SignalSummary` gains `source_id`, `source_key`, and `local_path` so
the tree can group by run and callers can distinguish runtime from
durable identity.

### Batch ingest jobs

Amends ADR 0009 (explicitly — the "mutex held for a job's duration"
consequence is retired):

- The `Decoder` trait changes: `decode` returns decoded columns
  (`DecodedSource { signals }`) without touching the store, and
  registration becomes a host-side commit step. The cache-hit load
  path already has exactly this shape and becomes the only shape.
- `IngestBatchRequest { paths }` (the shell expands directory picks
  and globs) registers one job, deduplicates it against in-flight and
  loaded sources, and pre-assigns every new file's `SourceKey`,
  `SourceId`, and prefix. Decode and pyramid-build run off the store
  lock; each finished file commits under a short write lock via the
  per-file transaction.
- Failure policy is per-file: a sweep must not abort at run 517.
  Failed files land in the batch summary; succeeded runs stay
  registered. Single-file ingest keeps today's atomicity.
- Batch status is incremental — aggregate fraction, done/failed
  counts, and recent failures — never a thousand-entry array
  serialized into a 150 ms poll. Per-file detail is a follow-up
  request.
- The job state machine is `running → done | partial | failed |
cancelled`. Cancellation stops new admissions, asks active decoders
  to stop at their next batch boundary, discards decoded-but-
  uncommitted results, and leaves committed files registered. Jobs
  have an explicit release request and a bounded terminal-status TTL.
- Session restore switches to the same batch path, fixing the
  sequential re-ingest on launch.
- The pipeline has memory-weighted admission and bounded queues
  between decode, pyramid/cache, and commit. A file holds admission
  tokens for its estimated file bytes, columns, one sort copy, and
  pyramid bins while it is in flight, then reconciles the estimate to
  actual allocations before entering the next stage. At commit, the
  columns and pyramids transfer from the working-set allowance to a
  resident-store allowance and remain charged until unload; a file
  that cannot acquire the actual charge fails with a resource-budget
  error before commit. Queue capacity never exceeds the worker count,
  cache writes use unique temporary names, and simultaneous requests
  for one source join its single flight. The default budgets derive
  from available memory with conservative caps; users can lower them.
- Making CSV genuinely streaming belongs to P1; MCAP stays whole-file
  (ADR 0009) until P3. P1 improves safe batch ergonomics but still
  rejects batches whose projected resident store exceeds its budget.
  Thousand-run residency is a P3 capability, not a P1 claim.

### Source sets and ensemble queries

A `SourceSet` groups sources whose signals share a schema
fingerprint, with tolerance real sweeps need: ingest silently drops
all-NaN columns today, so a run with a dead sensor must remain a
partial member (fingerprint on the union of `local_path`s with a
per-member missing set). Batch ingest proposes candidate sets; users
confirm membership. Like sources, sets have a persisted opaque
`SetKey` and a process-local `SetId(u64)`; sessions use the key and
protocol summaries expose both. A persisted set generation changes
whenever membership or alignment changes.

Matching names is not enough for scientifically valid aggregation.
Each set persists a `TimeDomain` with unit, origin semantics, and a
shared alignment origin, plus one affine transform
`aligned_t = scale × source_t + offset` per member. The default scale
normalizes supported units to seconds. Offset is zero only when every
member already uses the same relative origin; absolute epochs or
event-aligned runs require an explicit offset supplied by a recipe or
the grouping UI. Synthetic-index and physical-time members cannot
mix. Until every included member has a compatible transform,
ensemble queries fail closed with an alignment-required error.

The ensemble statistic is **across-run** spread. Pooling the bins'
`sum`/`sum_sq` across runs is wrong twice: it conflates within-bin
temporal variance with run scatter (the band would fatten as you zoom
out), and it weights runs by sample count.

For each cell on a shared aligned-time grid, the query first computes
one overlap-weighted mean per contributing run, then aggregates those
run means with equal run weight: minimum and maximum run mean, mean of
run means, population σ, and contributing-run count. The band is
therefore explicitly a **run-mean envelope**, not the extrema of all
raw samples. Its value legitimately changes when grid width changes;
the invariant is equal run weighting without accidental within-bin
sample weighting. Member bins only partially overlap a grid cell, so
apportioning their sums and counts by time overlap is an explicit
approximation, exact only under uniform in-bin sample spacing.

Two execution strategies use the same estimand:

- **Query-time merge** — O(members × bins-per-px) per query. Honest
  for tens of runs and used for any filtered subset. Requests above a
  configured member limit fail with an action to create a separate
  set or remove the filter.
- **Materialized full-set levels** — after P3, build every level
  independently from aligned per-run data. Ensemble child aggregates
  are not mergeable because they discard run identity; no parent
  level may be derived by merging them. A materialization is valid
  only for one immutable set generation and the full membership.
  Membership or alignment changes create a new generation and rebuild
  it. Queries over that exact generation are viewport-bounded.

Gap semantics: one member's dropout does not gap the band; display
bins carry a contributing-run count and the renderer thins the band
instead. Protocol: `EnsembleTileRequest { set_id, local_path, window,
pixel_width, member_filter }` uses process-local `set_id` as a
string-represented `u64`; `member_filter` contains durable
`SourceKey` strings because panel selections survive restart. An
absent filter may use materialized full-set levels; a non-empty filter
always uses the bounded query-time path. Response bins include
`run_count`, `set_key`, and the set generation. The tree shows one
logical signal per `local_path` with an N-run badge; selection offers
single run, spaghetti (bounded by the series budget), or band.

Snapshots and export must be answered, not skipped: `queryTiles` is
core `DataPlane`. The manifest bakes ensemble levels for each panel's
exact set generation and membership selection, including filtered
query-time results, so `BakedPlane` never recomputes or widens a
filter. "All loaded" export at 16,000 signals cannot fit any artifact
budget; export gains per-set/per-source selection, and the estimate
path stops replanning every signal for all range×fidelity
combinations on a dialog open.

### Out-of-core storage — bins and columns

Paging columns alone strands ~90% of the footprint, so this phase
addresses both. Before any paging, shrink what is resident — two
compactions cut the bin footprint roughly an order of magnitude with
no architectural change, and they make everything downstream (RAM,
sidecar bytes, mmap pages) proportionally cheaper:

- **Split the storage bin from the wire bin.** `EnvelopeBin` is the
  generated protocol type reused as storage; its four `Option<f64>`
  fields cost 16 bytes each because f64 has no niche. A dedicated
  storage layout — NaN sentinels plus one flags byte for the
  optional fields, u32 counts, struct-of-arrays per level — is
  ~70–80 bytes per bin instead of 120 (and shrinks the 88-byte
  sidecar record too). Conversion to the wire type happens at the
  query boundary; the protocol schema is untouched.
- **Stop storing the finest levels.** Stored bins total ~one per raw
  sample only because levels 1–2 hold 75% of them. Queries dense
  enough to select those levels have few samples per pixel by
  construction (level choice bounds in-window bins to ~2× pixel
  width), so binning them on the fly from the raw column stays
  viewport-bounded, exactly like the existing level-0 path. Starting
  stored levels at 3 cuts stored bins ~4× (validate the on-the-fly
  cost against ADR 0003's render invariants before committing to the
  exact cutoff).

Together: ~120 bytes of bin per raw sample drops to ~15–20. The
1,000-run example's resident bins go from ~380 GB to ~50 GB — still
too big for RAM at full scale, so paging remains necessary; the
compactions just shrink the problem paging has to solve.

The paging work is a cross-cutting `scope-core` refactor, not a swap
behind the current API (`Arc<[f64]>` cannot wrap a mapped region):

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
  once the store depends on the files. A guaranteed-writable,
  app-owned cache root (an ADR 0023 amendment with a P3 preferences
  schema bump) becomes the fallback and the spill target during
  ingest. Entries are keyed by a decode-provenance digest containing
  the existing source fingerprint (size, mtime, and first-64-KiB
  CRC), provider id and cache-ABI version, recipe content digest or
  plugin module digest, normalization/timebase options, and sidecar
  schema version. A changed decoder or recipe can never reuse stale
  columns.
- Mapped entries hold leases. LRU may delete only unleased entries;
  active mappings count against the cap and can make a new ingest
  fail admission rather than evicting data in use. Platform-specific
  deletion closes mappings before removal, including on Windows.
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
from it. Sniffing reads a fixed probe window; selection is
deterministic and independent of registration order: explicit
provider priority first, then stable provider id as the tie-break,
and each provider exposes a cache-ABI version. The session records the
provider id and decode-provenance digest per source so reopen either
reproduces the decode or reports that its provider is unavailable;
it never silently sniffs a different provider. Zero confidence no
longer falls through to CSV unconditionally — the CSV provider claims
anything that passes a text-plausibility gate (short text files keep
working), and input nothing claims fails closed with an
unsupported-format error naming the known formats, a deliberate
behavior change from today's test-locked total dispatch where binary
garbage parses as CSV. The registry's justification is runtime
registration for recipes and plugins, not the (small) edit cost of
built-ins.

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
preferences through a P4 amendment to ADR 0023, after P3 adds the
cache preferences. When no recipe matches, an import wizard
introspects the container, asks the user to tag time datasets, and
saves the answers as a recipe. A recipe is data, not code — and that
claim is enforced: a recipe selects datasets, timebases, names, and
units, and can never name an executable, plugin, or decoder binary,
because sidecar recipes arrive with untrusted data directories. The
session records the recipe id and exact content digest. A missing or
changed recipe fails restore with a relink/reconfirm action instead of
silently decoding a different signal schema; the digest is also part
of the sidecar cache key.

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
network), and the sandbox includes host-enforced resource limits,
not just capability denial: fuel/deadline budgets, a memory cap, and
maximum batch and total output sizes, with the host terminating and
rolling back any module that exceeds them or stops responding to
cancellation. Second, one transport and one encoding ship first, not
a matrix. Plugins are native-host-only and never enter the frontend or
snapshots.

## Protocol and session impact

Schema and cache changes are versioned in the phase that ships them;
the five phases do not share one speculative umbrella version:

- P1: protocol bump (batch job shapes,
  `source_id`/`source_key`/`local_path` on `SignalSummary`,
  registry-derived formats listing, cancellation and reconciliation
  status) and a **breaking** session bump (`SourceRecord`, durable
  `SourceKey`, and the two-stage legacy-path reconciliation state).
- P2: protocol bump (`set_id`/`set_key` summaries and ensemble tiles),
  session bump (durable membership, time-domain transforms, set
  generation), snapshot manifest addition for exact ensemble
  selections.
- P3: sidecar format version and preferences schema bump (cache root
  and size cap) with an ADR 0023 amendment; no wire change expected.
- P4: another preferences schema bump (recipe directory) and a
  session bump recording the recipe id and content digest used per
  source.
- P5: per the plugin spec.

Unknown-version rules are unchanged: fail clearly, never partially
restore.

## Phasing

1. **P1 — registry + batch ingest + naming.** Decoder trait change,
   registry, batch jobs with off-lock decode and per-file failure
   policy, durable source records, opaque stable prefixes,
   two-stage session reconciliation, batch session restore, streaming
   CSV decode, cancellation, and memory admission. The user-visible
   win is parallel directory loads that survive individual bad files
   within the resident-store budget.
2. **P2 — source sets + ensemble tiles at bounded scale.** Grouping
   with partial members and explicit time alignment, query-time
   ensemble merge behind a member limit (tens of runs), band
   rendering, exact filtered snapshot baking, and the export answer.
3. **P3 — storage: compaction, then paging.** Bin compaction and
   finest-level elision first (an order of magnitude off resident
   footprint, shippable on their own), then out-of-core bins and
   columns. Unlocks thousand-run sweeps and the precomputed ensemble
   levels built independently per full-set generation; benchmarked
   against the Phase 5 targets.
4. **P4 — container readers + recipes.** HDF5/MAT readers, recipe
   format, import wizard, preferences amendment.
5. **P5 — parser plugins.** Dedicated spec, then implementation.

P2 at full Monte Carlo scale explicitly depends on P3; the phases
stay in this order because bounded-scale ensembles already pay for
themselves and de-risk the statistics and protocol before the store
refactor lands. Each phase carries its own ADR and tests: per-file
transactionality under concurrent commits, deterministic naming,
migration fidelity including deterministic legacy keys,
missing-source retry, ambiguous aliases, and expression rewrites,
snapshot path redaction, cancellation at every stage, terminal-job
cleanup, bounded queue and resident memory, single-flight
deduplication, ensemble math against known distributions at multiple
grid widths, non-mergeability counterexamples, equal run weighting,
alignment refusal, exact filtered snapshot membership, cache
invalidation after provider/recipe changes, ragged-set membership,
recipe resolution, and hostile plugin output.

## Open questions

- Ensemble bands beyond min/max/mean/σ: are independently built
  per-set quantile levels worth their cost, or is σ plus the envelope
  enough for v1?
- The shared resample grid for materialized full-set levels:
  per-level fixed bin width from the union span, or anchored to the
  largest member?
- How much fingerprint mismatch still auto-groups, and what the tree
  shows for partial members.
- Bin paging granularity and eviction policy (per level, per signal,
  per byte range) against the ADR 0003 render invariants.
- Export budget policy for sets: per-set fidelity caps vs. refusing
  "all" above a source count.
