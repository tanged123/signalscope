# SignalScope

Local workbench for exploring large engineering datasets as XY charts. SignalScope
streams CSV, MCAP, HDF5/MAT v7.3, and Parquet data through a Rust data plane and
renders it in a WebGPU-capable Chromium browser.

Use each panel's **x:** control to search every loaded signal, or select a
channel bundle to pair each run's Y with that run's X. **y: + add** adds a
signal, channel bundle, or named set. Dragging a signal or bundle to the bottom
X strip also assigns X. One X signal can serve multiple Y signals; bundle
members match by source, with missing or ambiguous matches reported explicitly.
Pairs must share an exact sample timebase; no interpolation is performed.

CSV time columns stay available as ordinary signals. A recognized finite time
header supplies the linked-time anchor; otherwise imports use row index instead
of guessing from increasing measurements. Recipe time datasets and MCAP
log timestamps (in seconds) also appear in the signal catalog. Axis bindings
persist in sessions and captured bundle curves work in offline HTML exports.

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
WebGPU-capable system. Linux packages support the Ubuntu 22.04 glibc 2.35
baseline and newer distributions.

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

MIT licensed.
