# SignalScope

[![SignalScope CI](https://github.com/tanged123/signalscope/actions/workflows/ci.yml/badge.svg)](https://github.com/tanged123/signalscope/actions/workflows/ci.yml)
[![Format Check](https://github.com/tanged123/signalscope/actions/workflows/format.yml/badge.svg)](https://github.com/tanged123/signalscope/actions/workflows/format.yml)

**A native, high-performance time-series analysis workbench with portable interactive HTML snapshots.**

SignalScope combines a Rust data plane for logs larger than memory with one TypeScript/canvas presentation plane that runs in two hosts:

- The native Tauri workbench streams and memory-maps source data.
- A self-contained HTML snapshot uses the same renderer against embedded, size-budgeted tiles.

The repository is currently at the Phase 0 walking-skeleton stage. CSV ingestion, min/max pyramid construction, protocol types, Tauri IPC, the canonical one-panel UI, and snapshot packaging are wired end to end. MCAP, production cache persistence, and the remainder of the v1 interaction surface follow in later phases.

## Quick start

```bash
nix develop
pnpm install
pnpm dev
```

Run the complete local quality gate:

```bash
./scripts/ci.sh
```

Run the native shell:

```bash
./scripts/dev.sh bash -lc 'cd shell/src-tauri && cargo tauri dev'
```

Build the workbench and the portable snapshot template:

```bash
./scripts/build.sh
```

The snapshot is written to `frontend/dist/snapshot-template.html`.

## Repository layout

```text
core/
  scope-store/       signal/source registry and backing-store boundary
  scope-ingest/      streaming decoders behind one trait
  scope-pyramid/     multi-resolution min/max envelope tiles
  scope-compute/     transforms and XY resampling primitives
  scope-session/     versioned session schema and migrations
protocol/            single schema source plus generated Rust and TypeScript
frontend/
  src/app/           host-neutral application and DataPlane implementations
  src/render/        deterministic canvas renderer
  src/ui/            workbench chrome and design tokens
shell/src-tauri/     thin native host and IPC commands
docs/adr/            accepted architecture decisions
```

## Architecture

The frontend depends only on the versioned `DataPlane` contract. `TauriPlane` invokes the native Rust plane; `BakedPlane` reads the same response shapes from a snapshot data slot. The renderer therefore has no host-specific branch.

See [the ADR index](docs/adr/README.md) for the decisions behind the two-host product shape, layer boundaries, tile pyramid, protocol, session schema, linked-time model, and snapshot injection mechanism.

## Development

All CI tools are provided by the pinned Nix flake.

```bash
./scripts/dev.sh            # enter the development shell
./scripts/test.sh           # Rust and TypeScript unit tests
./scripts/ci.sh             # format, lint, codegen, tests, builds, artifact checks
nix fmt                     # format the workspace
pnpm e2e                    # Playwright browser smoke test
```

The UI design authority is in `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/`. Production code recreates that design; it does not import the reference prototype.

## License

MIT
