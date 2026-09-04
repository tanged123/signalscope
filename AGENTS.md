# SignalScope agent instructions

These rules supplement the code and accepted ADRs. Preserve unrelated worktree
changes and inspect before editing.

## Before editing

- Inspect `git status`, the target files, nearby tests, and existing scripts.
- For UI work, read
  `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md`
  and `SignalScope Final Spec.dc.html` in that directory. The Final Spec owns
  visuals and interaction. The reference prototype is behavioral context, not
  production code.
- For architecture or data work, read `docs/architecture.md` for module
  placement and shared primitives, then `docs/adr/README.md`, the relevant
  accepted ADRs, and `docs/implementation-roadmap.md`. Superseded ADRs and
  historical design explorations are not requirements.
- If requirements are ambiguous, state a small proposal before expanding
  scope. Record architectural changes in a new or amended ADR.

## Working rules

Prefer deletion and the shortest correct implementation. Do not add
speculative abstractions, wrappers, defensive scaffolding, or comments that
restate code. Modules have a soft budget of 600 lines; a module over 1,000
lines is split before new behavior is added to it, per ADR 0053. Check the
shared-primitives table in `docs/architecture.md` before writing a helper. Keep commands and logs quiet. Use `apply_patch` for edits. Never
reset, overwrite, or stage unrelated work; review staged and unstaged diffs
separately.

## Commands and validation

The `scripts/` directory is the developer and CI API. Use its wrappers when one
exists; add a focused wrapper when an operation must be shared with CI. Schema
generation is the sole direct package command below.

```text
./scripts/setup.sh                    install locked frontend dependencies
./scripts/run.sh app|dev|web          packaged, development, or browser host
./scripts/test.sh [quick|core|server|desktop|unit|frontend|e2e|bench|full]
./scripts/format.sh [--check]         apply or check treefmt formatting
./scripts/build.sh app|server|web
./scripts/export.sh                   build a self-contained snapshot
./scripts/coverage.sh
./scripts/ci.sh format|quality|rust|frontend|e2e|bench|build|all
./scripts/version.sh get|check|set|bump
./scripts/release.sh version|tag|assets|publish
pnpm codegen                          regenerate committed schema types
```

`quality_checks()` in `scripts/lib.sh` is the deterministic quality gate and
must match the CI quality job. `treefmt` is the only formatter and includes
Markdown. Run `./scripts/format.sh` before staging; the pre-commit hook does not
stage formatter changes. Install hooks with `./scripts/install-hooks.sh`.

Run the narrowest affected tests, then a gate proportional to the change. Use
`./scripts/ci.sh all` for cross-layer work and defer e2e, GUI, and platform
builds until implementation is complete. Report what actually ran.

## Product and architecture boundaries

- SignalScope currently supports time-series plots. That is a present
  capability, not a permanent architecture boundary; future plot types require
  deliberate schema and design work. Touch and mobile remain out of scope.
- The Electron app is a thin lifecycle and presentation wrapper around
  `scope-server`. It adds no native data API. Frontend code always uses
  `HttpPlane` and must not detect Electron.
- The same TypeScript/canvas presentation plane serves live `HttpPlane` and
  offline `BakedPlane` data. UI and renderer code never branch on host identity.
- Rust owns ingest, storage, pyramids, compute, persistence, and HTTP data. Keep
  `scope-core::{store, ingest, pyramid, compute, session}` separable with
  dependencies directed inward.
- Frontend code consumes protocol views and tiles, never raw native arrays or
  source-format details. Keep the transport boundary open to future local
  implementations.

## Data, schema, and rendering invariants

- Ingest decoders stream, and signal registration is transactional. Failed
  imports leave no source or partial signals visible.
- Query time columns are finite and monotonically nondecreasing. Pyramid
  parents preserve first/last, finite extrema, sample count, and ORed gap bits;
  gaps break strokes but do not discard finite extrema.
- `protocol/schema/scope-{protocol,session,preferences}.json` are schema sources.
  Generated Rust and TypeScript are committed outputs: regenerate with
  `pnpm codegen`, never hand-edit them, and verify with
  `./scripts/test.sh frontend`. Wire `u64` identifiers remain exact strings at
  the TypeScript boundary.
- Protocol, session, and preference schemas are APIs. Additive fields need
  defaults; breaking changes need a version and migration. Unknown future and
  unsupported old versions fail clearly without partial restore.
- The current session model is time-only. Do not restore panel modes,
  annotation domains, facet splits, reconciliation markers, or pre-migration
  alias rewriting removed by ADR 0050. Source identity is the source key plus
  local channel.
- Live panels choose pyramid resolution from physical device pixels. Density
  degrades uniformly across active panels under one global budget; do not add a
  fixed active-series cap. Each panel keeps at most an overview and latest
  detail CPU tile response, while stale covering data remains visible until an
  atomic replacement is ready.
- Each plot has one ChartGPU host. Use `setViewRange` for pan/zoom and
  `setOption` only when data identity, content, or style changes; never
  republish series progressively.
- Snapshots contain session state plus selected decimated tiles, replace the
  exact injection slot, make no network requests, stay within the size budget,
  and escape script data. Treat imported names as data and prefer
  `textContent`.

## UI and tests

Follow the Final Spec: flat achromatic chrome, 1px seams, radii at most 4px, no
glows or gradients, and amber only for interaction. Use Inter for UI,
JetBrains Mono with tabular numerals for data, and the `--series-1` through
`--series-8` palette for series. Identity cannot depend on color alone. Every
plot owns complete labeled axes and serialized per-panel state. Pointer actions
need keyboard paths. Keep rendering deterministic and snapshot dependencies
offline.

Behavior changes need behavior tests. Use Rust tests for ingest, time,
pyramids, protocol/session, and expressions; TypeScript tests for application,
renderer, and snapshot behavior; Playwright for desktop interaction, layout,
and export boundaries. Keep generated outputs synchronized.

## Delivery

Use small conventional commits that explain why. Update the nearest README,
roadmap, or ADR when behavior changes. A PR targeting `main` gets exactly one
synchronized version bump: `major` for a breaking API/schema change, `minor`
for a backward-compatible feature, and `patch` for fixes, refactors, tests,
tooling, or docs. Run `./scripts/version.sh check` before handoff; never bump
again for follow-up commits in the same PR.
