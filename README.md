# SignalScope

SignalScope is a local desktop and browser app for exploring large engineering
datasets. Load CSV, MCAP, HDF5/MAT v7.3, or Parquet files, plot signals against time
or each other, and compare runs across linked charts. Rust handles data processing
and ChartGPU renders the plots. Save workspaces as sessions or share interactive
HTML snapshots that work offline.

## Interactive demo

[Open the interactive HTML snapshot](https://tanged123.github.io/signalscope/demo.html).

## Install

Download the prebuilt package from the
[latest release](https://github.com/tanged123/signalscope/releases/latest), or
choose a version from [all release tags](https://github.com/tanged123/signalscope/releases):

- Windows x64: `SignalScope-VERSION-windows-x64-setup.exe`
- macOS Apple Silicon: `SignalScope-VERSION-mac-arm64.dmg`
- Linux x64: `SignalScope-VERSION-linux-x64.AppImage` or the `.deb` package

## Build and run

The pinned Nix environment supplies the development toolchain:

```bash
./scripts/setup.sh
./scripts/build.sh web
./scripts/run.sh app
```

Use `./scripts/run.sh dev` for the development server with frontend hot reload.
Open `examples/demo_flight.csv` to try the bundled data.

## Repository

```text
core/       Rust data processing and persistence
server/     local browser host
frontend/   shared application UI and renderer
desktop/    desktop packaging shell
protocol/   versioned schemas and generated types
scripts/    developer and CI commands
docs/       architecture and design records
examples/   sample data and workspaces
```

See [AGENTS.md](AGENTS.md) for contributor commands and
[docs/adr](docs/adr/README.md) for architecture decisions.
See [rendering performance](docs/rendering-performance.md) for repeatable
CPU/GPU measurements and the remaining large-ensemble bottlenecks.

MIT licensed.
