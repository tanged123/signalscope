# SignalScope

Local workbench for exploring large engineering time-series logs. SignalScope
streams CSV, MCAP, HDF5/MAT v7.3, and Parquet data through a Rust data plane and
renders it in a WebGPU-capable Chromium browser.

## Interactive demo

[Open the interactive HTML snapshot](https://tanged123.github.io/signalscope/demo.html).

## Install

Download the prebuilt package from the
[latest release](https://github.com/tanged123/signalscope/releases/latest), or
choose a version from [all release tags](https://github.com/tanged123/signalscope/releases):

- Windows x64: `SignalScope-VERSION-windows-x64-setup.exe`
- macOS Apple Silicon: `SignalScope-VERSION-mac-arm64.dmg`
- Linux x64: `SignalScope-VERSION-linux-x64.AppImage` or the `.deb` package

Release assets include `SHA256SUMS.txt` for verification. Rendering requires a
WebGPU-capable system.

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

## Export

SignalScope can save a workspace as one self-contained HTML file that works
offline and uses the same interface as the live app.

```bash
./scripts/export.sh
```

MIT licensed.
