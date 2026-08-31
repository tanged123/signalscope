# SignalScope

Local workbench for exploring large engineering time-series logs. SignalScope
streams CSV, MCAP, HDF5/MAT v7.3, and Parquet data through a Rust data plane and
renders it in a WebGPU-capable Chromium browser.

## Interactive demo

[Open the interactive HTML snapshot](https://tanged123.github.io/signalscope/demo.html).

## Run

```bash
./scripts/setup.sh
./scripts/run.sh app
```

Open `examples/demo_flight.csv` to try the bundled data. For development, use
`./scripts/run.sh dev`.

## Export

SignalScope can save a workspace as one self-contained HTML file that works
offline and uses the same interface as the live app.

```bash
./scripts/export.sh
```

Requirements, architecture decisions, and contributor commands live in
[AGENTS.md](AGENTS.md) and [docs/adr](docs/adr/README.md).

MIT licensed.
