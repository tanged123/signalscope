# SignalScope agent instructions

These are repository-specific rules for Codex, Claude Code, and other coding
agents. They supplement the user's request and the code itself. Preserve
unrelated user changes in the worktree; inspect before editing.

## Start here

Before changing code, read the relevant source of truth. For product or UI
work, read these in order:

1. `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/kickoffprompt.md`
2. `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/README.md`
3. `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/SignalScope Final Spec.dc.html`
4. `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/reference/signalscope.html`

For architecture or data work, read the relevant accepted ADRs in
`docs/adr/README.md` and `docs/adr/`, plus `docs/implementation-roadmap.md`.
The Final Spec is authoritative for visuals and interaction. The prototype is
behavioral reference material, not production code. Do not import it into the
application or silently revive an obsolete design-pass decision.

At the beginning of a task, inspect `git status`, the target files, nearby
tests, and the existing scripts. Do not overwrite or reset unrelated changes.
If an instruction or design requirement is ambiguous, state the ambiguity and
make a small, explicit proposal before expanding scope.

## Command and workflow policy

The `scripts/` directory is the repository's public developer and CI API. Use
the wrappers so local commands and GitHub Actions execute the same operations.
Do not default to ad-hoc `cargo`, `pnpm`, `npm`, `nix develop`, or custom shell
pipelines when a script exists. If a needed operation has no wrapper, add or
extend a focused script first and document it.

Canonical commands:

```text
./scripts/setup.sh                    locked frontend dependencies
./scripts/run.sh web                  browser development host
./scripts/run.sh native               Tauri development host
./scripts/test.sh                     quick Rust + frontend checks
./scripts/test.sh core|frontend|e2e|full
./scripts/build.sh web|native         frontend or native bundles
./scripts/setup-appimage.sh           Ubuntu AppImage system dependencies
./scripts/build.sh appimage           Ubuntu/FHS AppImage build
./scripts/coverage.sh                 Rust + frontend LCOV
./scripts/ci.sh format|lint|typecheck|clippy|unit|e2e|build|artifacts
./scripts/ci.sh all                   complete local quality gate
./scripts/ci.sh flake                 flake check
```

Run `./scripts/setup.sh` before frontend work when dependencies are absent.
The Nix flake supplies the normal pinned toolchain. AppImage packaging is the
intentional exception: run it outside the Nix shell on Ubuntu/FHS using the
two AppImage scripts. Do not “fix” that path by reintroducing the known Nix
`linuxdeploy` GTK schema mismatch.

Every workflow shell command must call an appropriate script. Keep setup,
formatting, linting, tests, coverage, builds, artifact checks, and release
preparation reproducible through scripts. GitHub actions that upload artifacts
or publish releases may remain native actions; their build inputs must still
come from scripts.

Before handoff, run the narrowest relevant script and then the broader gate
proportional to risk. At minimum, run formatting plus the affected test suite;
for cross-layer changes run `./scripts/ci.sh all` or explain why a narrower
check is sufficient. Report commands and results. Do not claim a GUI or
platform build was tested if it was not.

Install the repository hook with `./scripts/install-hooks.sh`. Do not use a
blanket `git add -A` or silently stage unrelated work. Review staged and
unstaged diffs separately before committing.

## Product and architecture invariants

SignalScope is native software with a portable export, not a web app:

- One TypeScript/canvas presentation plane runs in both the Tauri webview and
  the self-contained HTML snapshot.
- The native host uses `TauriPlane`; snapshots use `BakedPlane`; both implement
  the same versioned `DataPlane` contract. UI and renderer code must not branch
  on host identity.
- Rust owns ingest, storage, pyramids, compute, persistence, and IPC-facing
  data. The Tauri shell stays thin: windows, dialogs, and protocol wiring.
- `core/scope-store`, `scope-ingest`, `scope-pyramid`, `scope-compute`, and
  `scope-session` remain separable. Do not make core crates depend on shell or
  frontend state.
- Frontend code consumes protocol tiles/views, never raw native arrays or
  source-format details. Keep a future local HTTP/WebSocket plane possible.

The dependency direction is inward: ingest/pyramid/compute use store; shell
uses protocol and core crates; frontend uses generated protocol types. An
architectural change requires a new or amended ADR; accepted ADRs are not
silently rewritten.

## Data and protocol rules

- Ingest decoders are streaming and trait-based. Never load a multi-GB source
  merely to render it or make the browser hold raw source arrays.
- Signal registration is transactional: a failed CSV/MCAP ingest must not
  leave a source or partial signals visible in the store.
- Time columns used for pyramid queries must be finite and monotonically
  nondecreasing. Invalid named time columns need validation/fallback rather
  than being accepted by name alone.
- The pyramid is a binary multi-resolution min/max envelope. Parent bins
  preserve first, last, finite min/max, sample count, and the OR of child gap
  bits. `has_gap` breaks a rendered stroke; it does not mean the entire bin's
  finite extrema should be discarded. All-NaN bins may have null extrema.
- Query density is bounded by viewport width; preserve peaks and visible
  extrema. Do not scan raw arrays in the renderer for ordinary pan/zoom.
- `protocol/schema/scope-protocol.json` is the single schema source. Generated
  Rust and TypeScript files are committed outputs: do not hand-edit them.
  Regenerate through the repository's checked workflow and keep the codegen
  diff check green.
- Wire-level `u64` identifiers must remain exact; use the schema's string
  representation at the TypeScript boundary rather than unsafe JS numbers.
- Protocol and session schemas are APIs. Additive changes need defaults;
  breaking changes need a version and migration. Unknown future versions must
  fail clearly, never partially restore.
- Snapshots contain session state plus selected decimated tiles, use the exact
  injection slot, make no network requests, and remain within the artifact
  size budget. Escape data before placing it in an HTML script element.
- Treat untrusted signal/source names as data. Do not concatenate CSV headers
  or other external values into HTML without escaping; prefer `textContent`.

## Design and frontend rules

Match the Final Spec rather than generic dashboard patterns:

- Near-black flat surfaces, 1px seams, radii at most 4px, no glows,
  gradients, floating-card chrome, or decorative shadows in the dark theme.
- Chrome is achromatic. Amber is interaction-only: cursor, focus inset,
  deltas, derived marks, and drag/drop targets. Never use amber as a generic
  active fill or series/status color.
- Use Inter for UI and JetBrains Mono with tabular numerals for values, paths,
  axes, and readouts. Signal paths are lowercase snake_case.
- Use the design tokens as the source of truth. Light mode is a token swap,
  not a collection of per-component overrides.
- Use the categorical `--series-1` through `--series-8` palette consistently;
  identity must not depend on color alone. Status colors are reserved.
- Every plot owns complete labeled axes. Preserve gutter/inline axis semantics,
  linked time, per-panel state, and serialized axis choices.
- Preserve keyboard paths for pointer actions and the specified desktop/mobile
  gestures. Right-click must never be the only way to perform an action.
- Keep the renderer deterministic from tiles, viewport, and tokens so snapshot
  and workbench output stay pixel- and behavior-aligned.
- Avoid adding runtime dependencies to the snapshot frontend. The exported
  HTML must remain self-contained and offline.

## Testing expectations

Add tests with behavior changes, not only compilation checks:

- Rust: ingest comments/delimiters, duplicate/atomic failure, finite time
  validation, pyramid extrema and NaN-gap invariants, protocol/session
  round-trips and migrations.
- TypeScript: expression and linked-time units, renderer behavior where
  practical, snapshot/no-network/size checks.
- Playwright: desktop and mobile-emulation interactions when changing input,
  gestures, layout, or export behavior.
- Keep generated protocol outputs synchronized and run the artifact checks for
  snapshot changes.

## Documentation and delivery

Update the nearest README, ADR, roadmap, or design note when behavior or
architecture changes. New architectural decisions belong in a numbered ADR.
Use small conventional commits that describe the behavior, and keep changes
traceable to the requested task. Before finalizing, summarize changed files,
validation commands, known platform limitations, and any unrelated work left
unstaged.
