# SignalScope agent instructions

These rules apply to Codex, Claude Code, and other agents. Preserve unrelated
worktree changes; inspect before editing.

## Source of truth

At the start of every task, inspect `git status`, target files, nearby tests,
and the relevant scripts.

- UI work: read `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md`
  and `SignalScope Final Spec.dc.html` in that directory. The Final Spec is
  authoritative for visuals and interaction. Consult
  `reference/signalscope.html` only for a behavior detail the current code and
  accepted ADRs do not settle; it is not production code.
- Architecture/data work: read this file, the current records in
  `docs/adr/README.md` and relevant ADRs, and
  `docs/implementation-roadmap.md`. Superseded ADRs and historical design
  explorations are context, not requirements.
- For ambiguity, state a small proposal before expanding scope. Update the
  nearest README, roadmap, or ADR when behavior or architecture changes.

## Brevity and safety

Prefer deletion and the shortest correct implementation. Do not add speculative
abstractions, wrappers, defensive scaffolding, or comments that restate code.
Keep commands and logs quiet. Use `apply_patch` for file edits. Never reset,
overwrite, or stage unrelated work; review staged and unstaged diffs
separately.

## Canonical commands

Use the `scripts/` wrappers so local and CI operations match. If a needed
operation has no wrapper, add a focused one first.

```text
./scripts/setup.sh                    locked frontend dependencies
./scripts/run.sh app|dev|web          packaged host, development host, browser
./scripts/test.sh [core|server|unit|frontend|e2e|full]
./scripts/format.sh [--check]         treefmt formatting
./scripts/build.sh [web|server|app]
./scripts/export.sh                   self-contained snapshot
./scripts/coverage.sh
./scripts/ci.sh [format|quality|rust|frontend|e2e|build|all]
./scripts/version.sh get|check|set|bump
./scripts/release.sh version|tag|assets|publish
```

`quality_checks()` in `scripts/lib.sh` is the deterministic quality gate and
must remain aligned with the CI quality job. `treefmt` (via `nix fmt` or
`./scripts/format.sh`) formats all supported languages, including Markdown.
Run formatting before staging. Install hooks with
`./scripts/install-hooks.sh`.

Run the narrowest affected test and formatter before handoff. For cross-layer
changes run `./scripts/ci.sh all`; run `./scripts/ci.sh e2e` only after the
implementation plan is complete. Do not claim GUI, platform, or end-to-end
validation that was not run.

## Architecture invariants

SignalScope is a local browser workbench with a portable export:

- One TypeScript presentation plane serves the live `HttpPlane` host and
  offline `BakedPlane` snapshots. UI and renderer code never branch on host
  identity.
- Rust owns ingest, storage, pyramids, compute, persistence, and HTTP-facing
  data. Keep `scope-core::{store, ingest, pyramid, compute, session}`
  separable; dependency direction is inward.
- Frontend code consumes protocol tiles/views, not raw native arrays or source
  formats. Keep the protocol boundary open to future local transports.
- Ingest decoders stream and registration is transactional: failed imports
  leave no source or partial signals visible.
- Query time columns are finite and monotonically nondecreasing. Pyramid
  parents preserve first/last, finite extrema, sample count, and ORed gap bits;
  gaps break strokes but do not discard finite extrema.
- Query density is bounded by viewport width and preserves visible peaks. Do
  not scan raw arrays in the renderer for ordinary pan/zoom.
- `protocol/schema/scope-protocol.json` is the schema source. Generated Rust
  and TypeScript outputs are committed and must be regenerated, never hand
  edited. Wire `u64` identifiers use the schema's exact string boundary.
- Protocol/session changes are API changes: additive fields need defaults,
  breaking changes need a version and migration, and unknown future versions
  fail clearly without partial restore.
- Snapshots contain session state plus selected decimated tiles, replace the
  exact injection slot, make no network requests, stay within the size
  budget, and escape data before HTML script injection. Treat external names
  as data and prefer `textContent`.

## Design and testing invariants

Follow the Final Spec: near-black flat surfaces, 1px seams, radii ≤4px, no
glows or gradients; achromatic chrome; amber only for interaction; Inter for
UI and JetBrains Mono/tabular numerals for values, paths, axes, and readouts.
Use the categorical `--series-1` through `--series-8` palette consistently;
identity must not depend on color alone and status colors are reserved. Every
plot owns complete labeled axes, linked-time/per-panel state, and serialized
axis choices. Every pointer action needs a keyboard path. Input is desktop-only
per ADR 0021. Keep renderer output deterministic and snapshot dependencies
offline.

Add behavior tests with behavior changes: Rust ingest, finite-time, pyramid,
protocol/session, and expression semantics; TypeScript linked-time,
formula-bar, renderer, and snapshot checks where relevant; Playwright for
desktop input, layout, and export boundaries. Keep generated protocol outputs
synchronized.

## Delivery

Use small conventional commits that explain why. Do not version-bump ordinary
commits. A PR targeting `main` gets exactly one synchronized final bump:
`./scripts/version.sh bump <major|minor|patch>`, then `check`, with `major` for
breaking protocol/session/API changes and `minor` for backward-compatible
features; refactors, tests, tooling, and docs use `patch`.
