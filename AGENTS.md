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
  placement and shared primitives, and the accepted ADRs for the area
  (`docs/adr/README.md`).
- If requirements are ambiguous, state a small proposal before expanding
  scope. Write an ADR only for a decision that is expensive to reverse:
  schema or protocol compatibility, data or reduction semantics, or a
  process-wide resource policy. Other changes explain themselves in code,
  comments and the commit message.

## Working rules

Prefer deletion and the shortest correct implementation. Do not add
speculative abstractions, wrappers, defensive scaffolding, or comments that
restate code. Modules have a soft budget of 600 lines; a module over 1,000
lines is split before new behavior is added to it, per ADR 0053. Check the
shared-primitives table in `docs/architecture.md` before writing a helper.
Extract around behavior, invariants, or resource lifetime; passing the whole
previous owner into a new file does not establish a boundary. Keep commands
and logs quiet. Use `apply_patch` for edits. Never
reset, overwrite, or stage unrelated work; review staged and unstaged diffs
separately.

## Commands and validation

The `scripts/` directory is the developer and CI API. Use its wrappers when one
exists; add a focused wrapper when an operation must be shared with CI. Schema
generation is the sole direct package command below.

```text
./scripts/setup.sh                    install locked frontend dependencies
./scripts/run.sh app|dev|web          packaged, development, or browser host
./scripts/test.sh [quick|core|server|desktop|unit|chartgpu|frontend|e2e|bench|full]
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
builds until implementation is complete. The vendored ChartGPU fork's suite
runs only through `./scripts/test.sh chartgpu` and CI; run it when you change
the fork. Report what actually ran.

## Product and architecture boundaries

- SignalScope supports Cartesian2D Line2D and sampled Scatter2D plots with linked-time or explicit
  signal-X bindings ([ADR 0052](docs/adr/0052-typed-plot-families-and-explicit-x-line2d.md)).
  [ADR 0066](docs/adr/0066-scatter-panels-and-creation.md) adds scatter and panel creation.
  Future plot types require deliberate schema and design work. Touch and mobile
  remain out of scope.
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
- Sessions retain time anchors even with explicit signal-X plots. Do not restore panel modes,
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

Tests exist to catch broken user experience and wrong data, not to pin
implementation. Rust tests cover ingest, time, pyramids, protocol/session, and
expressions. TypeScript unit tests cover pure data and math (decoders,
resolution, ranges, statistics, parsing). Playwright journeys in
`frontend/tests/e2e/` drive the real server through user-visible controls and
assert outcomes: plots draw, actions change what the user sees, sessions and
exports reproduce the workbench. Do not add tests that assert markup, class
names, label wording, pixel geometry, or mocked GPU/DOM calls; a UI change
should not require a test change unless a journey's outcome changed. Keep
generated outputs synchronized.

## Delivery

Use small conventional commits that explain why. Update the docs that describe
changed behavior. Releasing is opt-in: a PR that should ship a release runs
`./scripts/version.sh bump major|minor|patch` once (`major` for a breaking
API/schema change, `minor` for a compatible feature, `patch` otherwise), and
merging it to `main` tags and publishes that version. Other PRs leave the
version alone; `./scripts/version.sh check` only verifies the manifests agree.
