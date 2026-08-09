# SignalScope — Implementation Kickoff

## Mission

Stand up the production repo for **SignalScope**, an internal high-performance time-series analysis workbench (MATLAB-style manipulation, PlotJuggler-style centralized workflow, uPlot-class rendering speed, Plotly-style HTML snapshot export). A validated interactive prototype and a finalized design package exist. Your job in this engagement: **design the codebase and initialize the repository** — architecture, layout, toolchain, CI — then implement v1 in phases. Do not redesign the product; implement the design.

## Product shape (read this before anything else)

SignalScope is **centralized native software with a portable export**, not a web app:

- The **workbench** is a native Electron application. It must open bigger-than-RAM logs (multi-GB MCAP/parquet/CSV) via the authenticated Rust loopback data plane — mmap, streaming decode, out-of-core access. Browser memory limits are irrelevant to the workbench because the workbench is not a browser page.
- The **snapshot** is the portable artifact: a single self-contained HTML file, exported from the workbench, that opens in any browser with the full interactive UI and an embedded, size-budgeted slice of the data. Snapshots are how analysis is shared; they must be pixel- and behavior-identical to the workbench, because they run the *same* frontend code.

This dictates the core architectural bet: **one presentation plane, two hosts.** The TS/canvas frontend runs inside the native shell (webview) and inside exported snapshots. The Rust data plane runs only in the workbench; snapshots replace it with baked data.

## Inputs (attached) and their authority, highest first

1. **`SignalScope_Final_Spec.dc.html`** — the design package. Source of truth for visuals, tokens, IA, component behavior, and the v1/v2 split (F6·5). Where it conflicts with anything else, it wins.  
2. **`prompt.md`** — the design brief: product rationale, pillars, palette rules. Note: its "static file deployability" constraint is superseded by the product shape above — the *snapshot* is the static artifact, not the workbench.  
3. **`signalscope.html`** — the working prototype. Source of truth for some *behavior, but more so inspiration*: plotting / ui semantics, CSV autodetection, expression-engine semantics, and the snapshot self-embedding approach. Reference material, not a starting point — the repo starts clean.

## Repo conventions — follow the pantheon house style exactly

This repo joins the pantheon family and must be indistinguishable from its siblings in structure and tooling. **Before writing anything, clone and study the reference repo: `<PANTHEON_REFERENCE_REPO>`** (confirm the exemplar with me). Mirror, do not reinvent:

- **Nix**: `flake.nix` with the house devshell pattern and pinned inputs. Every tool CI uses comes from the flake — including the Rust toolchain, Node/TS toolchain, and Electron development/package dependencies. `direnv`/`.envrc` if siblings use it.
- **Layout**: the house top-level shape, adapted to a polyglot workspace (Cargo workspace \+ JS/TS workspace side by side; see Architecture).  
- **CI**: the same forge workflows as siblings — job names, trigger policy, caching. Minimum jobs: nix flake check, lint (rust \+ ts), typecheck, clippy, unit tests (both languages), e2e (headless browser \+ headless shell), builds (workbench binaries \+ snapshot template), and the artifact checks defined below.  
- **Quality gates**: house formatter/linter configs, pre-commit hooks, commit/PR conventions, CODEOWNERS, versioning/release scheme.  
- **Docs**: README in house format; `docs/adr/` — every architectural decision below gets accepted or amended as a numbered ADR.

If a pantheon convention conflicts with this brief, flag it and ask; don't silently diverge either way.

## Architecture (proposed — confirm or amend via ADR before scaffolding)

### Layers

- **`core/` (Rust, workspace of crates)** — the data plane:  
  - `scope-store`: signal store; columnar Float64 timebases/values; mmap'd file backing; source registry (files now, live transports later).  
  - `scope-ingest`: decoders behind one trait — CSV (port the prototype's autodetect semantics), MCAP, parquet; streaming, never whole-file loads.  
  - `scope-pyramid`: the central data structure — a **multi-resolution min/max tile pyramid** per signal (mipmap for time series). Built on ingest, cached on disk beside the source. Everything downstream consumes tiles, never raw arrays.  
  - `scope-compute`: FFT, expression engine (`$()`, `deriv`, `integ`, `smooth` — match prototype semantics exactly), XY resampling/pairing.  
  - `scope-session`: versioned session/snapshot schema \+ migration scaffolding; serialization of layout, annotations, zoom state, theme.  
- **`protocol/`** — the tile/query protocol between data plane and frontend: typed requests ("tiles for signals S over window W at density D", "expr eval", "stats over window"), generated types shared Rust↔TS (single schema source; codegen both ways). This protocol is an API from day one — the snapshot's baked-data reader implements the same interface.  
- **`frontend/` (TypeScript, strict, zero runtime deps)** —  
  - `render/`: canvas renderer — axes (gutter \+ inline styles), grid, series strokes from tiles, colorbar, overlay (cursor, box, numbered datatips/annotations). Deterministic given (tiles, viewport, tokens): screenshot-testable.  
  - `ui/`: components per the spec — panel chrome \+ mode pills (T·XY·FFT·H), split legend chips \+ inspector popover, virtualized search-first signal tree with favorites and live values, formula bar, ⌘K command palette, export dialog with size budget, empty states, status bar. Design tokens from one token file (CSS custom properties; light theme is a pure token swap — enforce in review).  
  - `app/`: workspace shell, panel layout management, linked-time model, mouse/keyboard desktop input controller, and a **`DataPlane` interface with two implementations**: `NativePlane` (authenticated loopback HTTP through Electron) and `BakedPlane` (reads tiles embedded in a snapshot). UI code must not know which one it's on.
- **`desktop/` (Electron)** — thin: window management, native file dialogs, and bridge wiring of the protocol. Keep it boring; a future headless `scope-serverd` (same crates, localhost HTTP/WS) is explicitly anticipated — don't preclude it, don't build it.

### Build artifacts (all produced in CI)

1. **Workbench binaries** (Electron packages) for Linux x64, Windows x64, macOS x64, and macOS arm64.
2. **`snapshot-template.html`** — the frontend built single-file (JS/CSS inlined, zero network requests) with an empty baked-data slot. The workbench's Export writes snapshots by injecting tiles \+ session into this template — same mechanism the prototype proved.  
3. CI checks on the template: no external requests, opens headless with demo data, size budget (ratchet from first green build; the code budget matters because it ships inside every snapshot).

## v1 scope (from spec F6·5)

Keep from prototype: linked-time model, min/max decimation (now formalized as the pyramid), drag-to-plot \+ drop-creates-panel, the mouse/keyboard desktop gesture set, single-file snapshot export, derived-signals-in-tree.

Build for v1: final skin \+ tokens (dark \+ light) · full axis system (gutter default, inline option, per-panel, serialized) · mode pills T·XY·FFT·H · legend split chips \+ inspector popover · formula bar (docked, history) · panel drag-rearrange \+ seam resize · export dialog with real size budget computed from tile selection (visible window vs. all loaded) · empty states · ⌘K command palette · XY drop-strip · numbered datatips → annotations list with text notes, embedded in exports · `c:` colorbar for XY · ingest: CSV \+ MCAP (parquet if cheap behind the trait, else v2).

Non-goals for v1 (v2 per spec): layout presets UI, Monte-Carlo envelope ergonomics beyond basic many-series handling, live streaming and `scope-serverd` (but: the status bar reserves the FOLLOW slot, and the linked-time \+ protocol ADRs must not preclude a moving window or a remote plane — say so in the ADRs).

## Engineering requirements

- **Performance has numbers, in data-plane terms**: time-to-first-plot on a cold multi-GB file (target: seconds, dominated by pyramid build — show progress); tile-serve latency such that pan/zoom holds interactive framerates with ≥100M points loaded; render ms surfaced honestly in the status bar per the spec. Benchmark harness in CI (criterion for crates, a scripted pan/zoom scenario for the frontend) failing on gross regression.  
- **Tests**: Rust unit/property tests for pyramid correctness (min/max envelope invariants incl. NaN gaps), ingest edge cases, session round-trip  
  + migrations; TS unit tests for expression parsing and linked-time model; Playwright e2e for the gesture set on desktop AND mobile emulation (pinch via CDP); snapshot round-trip (export → open template → identical state, screenshot-compared); renderer screenshot tests across both themes and both axis styles.  
- **Invariants as CI checks where possible**: series identity never color-alone; amber is interaction-only, never a series color; status colors reserved; a keyboard path exists for every pointer action (⌘K covers the long tail); protocol types stay in sync (codegen diff check).  
- **Schemas are APIs**: the session/snapshot schema and the tile protocol are versioned from day one with migration scaffolding. Prototype-session import is a nice-to-have adapter, not a constraint.

## Phase 0 — definition of done (first PRs)

1. Repo scaffolded to pantheon conventions; `nix develop` yields the complete polyglot toolchain; CI green on the skeleton.  
2. ADRs for: product shape & two-host frontend, layer boundaries, tile pyramid design (levels, tile size, NaN/gap semantics, disk cache format), protocol \+ codegen approach, session schema versioning, linked-time model (with streaming reservation), snapshot injection mechanism.  
3. Walking skeleton, end to end: the Electron desktop opens; a real CSV is ingested by the Rust host; the pyramid builds tiles; the frontend renders one panel from tiles over `NativePlane` with final dark tokens and honest render-ms; `snapshot-template.html` builds, passes no-network \+ size checks, and renders the same panel from `BakedPlane` with hand-injected tiles. One Rust test suite, one TS test suite, one e2e in CI.

Stop after Phase 0 and present the plan for phases 1–n (sequenced from v1 scope) before proceeding.

## Working agreement

- Small PRs, conventional messages per house style, ADR for anything that contradicts this document.  
- When the design spec is ambiguous, check the prototype's behavior first; if still ambiguous, ask — with a concrete proposal and a default.  
- Questions for the maintainer before you start, if unanswered: (1) which pantheon repo is the reference exemplar, (2) forge/org/repo name, (3) license header convention, (4) workbench target platforms (Linux x64, Windows x64, macOS x64/arm64), (5) Electron/Chromium floor, (6) any pantheon-standard telemetry/error reporting to wire.
