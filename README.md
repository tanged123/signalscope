# SignalScope

[![SignalScope CI](https://github.com/tanged123/signalscope/actions/workflows/ci.yml/badge.svg)](https://github.com/tanged123/signalscope/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tanged123/signalscope/graph/badge.svg?token=ypwd3hmX9u)](https://codecov.io/gh/tanged123/signalscope)

**A native, high-performance time-series analysis workbench with portable interactive HTML snapshots.**

SignalScope combines a Rust data plane for logs larger than memory with one TypeScript/canvas presentation plane that runs in two hosts:

- The native Tauri workbench streams and memory-maps source data.
- A self-contained HTML snapshot uses the same renderer against embedded, size-budgeted tiles.

The repository is currently at the Phase 0 walking-skeleton stage. CSV ingestion, min/max pyramid construction, protocol types, Tauri IPC, the canonical one-panel UI, and snapshot packaging are wired end to end. MCAP, production cache persistence, and the remainder of the v1 interaction surface follow in later phases.

## Quick start

```bash
./scripts/setup.sh
./scripts/run.sh web
```

Run the lightweight local quality gate:

```bash
./scripts/test.sh
```

Run the native shell:

```bash
./scripts/run.sh
```

Build the workbench and the portable snapshot template:

```bash
./scripts/build.sh
```

The snapshot is written to `frontend/dist/snapshot-template.html`.

## Repository layout

```text
core/
  scope-core/        native data plane with separable layers:
    store/            signal/source registry and backing-store boundary
    ingest/           streaming decoders behind one trait
    pyramid/          multi-resolution min/max envelope tiles
    compute/          transforms and XY resampling primitives
    session/          versioned session schema and migrations
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
./scripts/setup.sh          # install locked frontend dependencies
./scripts/dev.sh            # enter the development shell
./scripts/run.sh web        # launch browser frontend
./scripts/run.sh native     # launch native Tauri workbench
./scripts/test.sh           # lightweight core + frontend checks
./scripts/test.sh full      # Tauri compile + Playwright checks too
./scripts/build.sh web      # frontend + snapshot-template.html
./scripts/build.sh native   # native bundle + shared frontend
./scripts/setup-appimage.sh # install AppImage dependencies on Ubuntu
./scripts/build.sh appimage # portable Linux AppImage (Ubuntu/FHS only)
./scripts/coverage.sh       # Rust + frontend LCOV reports
./scripts/version.sh check  # verify synchronized release manifests
./scripts/release.sh version # validate release metadata
./scripts/release.sh tag     # create/push the annotated release tag
./scripts/ci.sh             # complete CI-oriented quality gate
./scripts/ci.sh rust        # reproduce one named GitHub Actions job
nix fmt                     # format the workspace
```

The UI design authority is in `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/`. Production code recreates that design; it does not import the reference prototype.

## License

MIT
