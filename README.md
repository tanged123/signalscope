# SignalScope

[![SignalScope CI](https://github.com/tanged123/signalscope/actions/workflows/ci.yml/badge.svg)](https://github.com/tanged123/signalscope/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/tanged123/signalscope/graph/badge.svg?token=ypwd3hmX9u)](https://codecov.io/gh/tanged123/signalscope)

**A native, high-performance time-series analysis workbench with portable interactive HTML snapshots.**

SignalScope combines a Rust data plane for logs larger than memory with one TypeScript/WebGPU presentation plane that runs in two hosts:

- The native Electron workbench streams and memory-maps source data.
- A self-contained HTML snapshot uses the same renderer against embedded, size-budgeted tiles.

The repository ships the time-series WebGPU renderer and workbench fundamentals:
CSV and JSON-channel MCAP ingestion, persistent min/max pyramid caches, native
progress reporting, multi-panel layouts, a virtualized signal tree, and the
shared snapshot presentation plane. Workspace tabs retain multiple independent
panel grids over the same loaded sources and linked time window.

## Interactive demo

[![SignalScope interactive demo](https://tanged123.github.io/signalscope/demo.gif?v=2.0.0)](https://tanged123.github.io/signalscope/demo.html)

**[Open the interactive HTML snapshot](https://tanged123.github.io/signalscope/demo.html)**
to zoom, inspect values, and explore the exported workspace in your browser.
The preview and snapshot are regenerated from SignalScope's export path on
every release, so this view tracks the shipping UI.

## Quick start

```bash
./scripts/setup.sh
./scripts/run.sh web
```

Run the lightweight local quality gate:

```bash
./scripts/test.sh
```

Run the software-adapter correctness proof or the native hardware benchmark:

```bash
./scripts/test.sh gpu
./scripts/test.sh bench core
./scripts/test.sh bench software
./scripts/test.sh bench e2e
```

`bench e2e` requires a non-fallback WebGPU adapter and fails early with its
diagnostic report when the host only exposes software rendering. The scheduled
benchmark workflow runs `core` and `software`; no GPU runner is currently
reserved for hardware acceptance.

Run the native Electron workbench:

```bash
./scripts/run.sh native
./scripts/run.sh windows
```

`run.sh native` fails early under WSL because WSLg cannot present the WebGPU
surface. WSL developers should use `run.sh windows` for the packaged app on
hardware WebGPU, or open `run.sh web` and exported snapshots in the Windows
browser.

Press `O` or click **Open…**, choose **Files**, then select
[`examples/demo_flight.csv`](examples/demo_flight.csv) to explore the ingest
and plotting workflow. The demo contains 16 signals spanning smooth and signed
telemetry, paired XY position, angular values, steps and setpoints, boolean and
discrete state, high-frequency vibration, thermal drift, and intentional GPS
gaps. Plot nine or more together to exercise the colour-plus-dash identities.

For bundled multi-source plotting, open all eight files in
[`examples/monte_carlo`](examples/monte_carlo). The deterministic runs vary
response and thermal parameters; run 8 omits `temperature` to demonstrate a
partial bundle member. Expand a bundle in the signal tree to plot all members,
then highlight one source from the panel legend.

### Derived signals

Press `E` to open the formula bar. Signal references use their quoted full
tree path; drag leaves from the signal tree to insert them:

```text
derived/pitch_twice = 'demo_flight/attitude/pitch_deg' * 2
derived/speed = hypot('demo_flight/velocity_body/x_mps', 'demo_flight/velocity_body/y_mps')
```

Press `?` in the bar for syntax help or `Ctrl+Space` for context-sensitive
function and signal completion. Enter creates, Up/Down recalls accepted
formulas, and Escape closes the bar. Angle conversions use `rad2deg(x)` and
`deg2rad(x)`.

### Supported input files

- `.csv`, `.tsv`, `.txt`, and `.dat`: numeric delimited text using comma, tab,
  semicolon, or pipe separators. Headers are optional; `#`, `%`, and `;`
  comment lines are ignored. A finite, monotonically nondecreasing time column
  is selected by name or validation, with row index used as a fallback.
- `.mcap`: MCAP recordings containing channels whose message encoding is
  `json`. Numeric and boolean fields are flattened into signal paths. Other
  MCAP message encodings are reported but not decoded yet.
- `.h5` and `.hdf5`: HDF5 containers. Dataset layouts are selected by a
  validated `.scope.toml` sidecar or a user recipe directory.
- `.mat`: MATLAB v7.3 files, which use the HDF5 container format. Other MATLAB
  file variants are unsupported.
- `.parquet` and `.pq`: Parquet columns selected by the same declarative recipe
  format.

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
  src/render/        WebGPU line renderer, axes, and overlays
  src/ui/            workbench chrome and design tokens
desktop/              sandboxed Electron host and packaging
host/                 authenticated Rust host and loopback server
docs/adr/            accepted architecture decisions
```

## Architecture

The frontend depends only on the versioned `DataPlane` contract. `NativePlane` invokes the authenticated Rust host through Electron's narrow bridge; `BakedPlane` reads the same response shapes from a snapshot data slot. WebGPU renders ordered time-series pages and asynchronous nearest picks while Canvas2D supplies axes and overlays, with no host-specific branch.

See [the ADR index](docs/adr/README.md) for the decisions behind the two-host product shape, layer boundaries, tile pyramid, protocol, session schema, linked-time model, and snapshot injection mechanism.

## Development

All CI tools are provided by the pinned Nix flake.

```bash
./scripts/setup.sh          # install locked frontend dependencies
./scripts/setup.sh --update-lock # refresh the lockfile after an intentional manifest edit
./scripts/dev.sh            # enter the development shell
./scripts/run.sh web        # launch browser frontend
./scripts/run.sh native     # launch native Electron workbench
./scripts/run.sh windows    # launch CI-built Windows package via WSL interop
./scripts/test.sh           # lightweight core + frontend checks
./scripts/test.sh full      # desktop + Playwright checks too
./scripts/build.sh web      # frontend + snapshot-template.html
./scripts/build.sh native   # native bundle + shared frontend
./scripts/build.sh appimage # portable Linux AppImage
./scripts/build.sh windows  # Windows NSIS installer (Git Bash only)
./scripts/coverage.sh       # Rust + merged Vitest/Playwright frontend LCOV
./scripts/version.sh check  # verify synchronized release manifests
./scripts/release.sh version # validate release metadata
./scripts/release.sh tag     # create/push the annotated release tag
./scripts/ci.sh             # complete CI-oriented quality gate
./scripts/ci.sh quality     # dependency, workflow, shell, spelling, unused code
./scripts/ci.sh rust        # reproduce one named GitHub Actions job
nix fmt                     # format the workspace

Linux and macOS builds use the pinned Nix shell, which supplies HDF5 and the
Electron development binary. Windows packaging runs in Git Bash with the
runner's Rust and Node toolchains. `./scripts/test.sh desktop package` launches
the current unpacked production package; on NixOS the generic Linux executable
may be blocked by its FHS dynamic-library requirements, while Ubuntu CI owns
that package-smoke claim. The release matrix covers Linux x64, Windows x64,
macOS x64, and macOS arm64.
```

`./scripts/ci.sh quality` is implemented by `quality_checks()` in
`scripts/lib.sh`, which is the single source of truth shared with GitHub
Actions. The aggregate `ci-ok` job is the stable required-check target.

The UI design authority is in `docs/Signal Scope UI Design Pass/design_handoff_signalscope_ui/`. Production code recreates that design; it does not import the reference prototype.

## License

MIT
