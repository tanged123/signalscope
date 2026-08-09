# Electron + Rust Desktop Architecture

**Date:** 2026-08-09
**Status:** Approved direction; clean-slate replacement for every desktop OS
**Supersedes:** The Tauri host portions of ADRs 0001, 0002, 0004, 0007,
0032, 0035, 0036, and 0039. Their data, protocol, snapshot, and renderer
decisions remain in force.

## Goal

SignalScope uses one pinned Chromium desktop host on Linux, macOS, and Windows
so the WebGPU renderer has the same browser engine everywhere. Rust continues
to own ingest, storage, pyramids, compute, persistence, and native filesystem
operations. The existing TypeScript presentation plane and offline HTML
snapshots remain shared.

`./scripts/run.sh native` must launch a useful workbench on every development
OS: Electron, the Rust host, native file loading, and the production WebGPU
renderer. It must not launch Tauri or depend on a system webview.

## Locked decisions

1. Electron 43.2.0, containing Chromium 150.0.7871.129, is the only desktop
   presentation host on Linux, macOS, and Windows.
2. Tauri, Wry, WebKitGTK, `TauriPlane`, Tauri commands, Tauri packaging, and
   their generated files are deleted. There is no compatibility host.
3. Electron stays thin. It owns application lifecycle, windows, dialogs,
   drag/drop path recovery, and launching the Rust child process. It never
   ingests, parses, computes, stores signal data, or renders series.
4. A new shell-independent `scope-host` Rust library owns native application
   state and typed operations. A small `scope-server` executable exposes those
   operations over authenticated loopback HTTP.
5. The Electron renderer has no Node.js access. `nodeIntegration` is false,
   `contextIsolation` and Chromium sandboxing are enabled, and a narrow preload
   bridge exposes only desktop capabilities.
6. `NativePlane` and `BakedPlane` implement the same `DataPlane` contract. UI,
   renderer, and workspace code never inspect Electron, operating system, or
   transport identity.
7. Existing JSON protocol envelopes and the binary tile framing remain the
   data contract. The HTTP transport has its own version so transport changes
   do not masquerade as scientific protocol changes.
8. WebGPU remains the only series renderer. There is no Canvas2D series
   fallback. Software WebGPU proves correctness; hardware WebGPU is required
   for performance claims.
9. The migration is intentionally breaking. No Tauri session bridge, command
   alias, old binary launcher, or dual-shell period remains in the completed
   tree.
10. The completed change bumps SignalScope to 2.0.0 because it replaces the
    native host and transport without compatibility.

## Resulting repository structure

```text
core/scope-core/                 scientific data plane
protocol/                        generated shared types and binary codecs
host/scope-host/                 shell-independent native application state
host/scope-server/               authenticated loopback HTTP executable
desktop/                         Electron main process, preload, and packaging
frontend/                        shared TypeScript UI and WebGPU renderer
scripts/                         sole developer, CI, build, and release API
```

The following structure is deleted in full:

```text
shell/src-tauri/
shell/
```

Only Electron-required desktop icons move to `desktop/assets/icons/`:
`icon.icns`, `icon.ico`, and a 512×512 `icon.png`. Tauri capability schemas,
mobile icons, Windows Store tile icons, generated ACL manifests, `build.rs`,
`tauri.conf.json`, and `tauri.windows.conf.json` are deleted.

## Process architecture

```text
Electron main process
  ├─ starts signalscope-host
  ├─ owns BrowserWindow and native dialogs
  ├─ serves packaged frontend through app://signalscope
  └─ exposes narrow IPC handlers to the preload

Electron sandboxed renderer
  ├─ shared frontend
  ├─ WebGPU renderer
  ├─ NativePlane
  └─ fetches authenticated protocol responses from 127.0.0.1

signalscope-host process
  ├─ scope-server: authentication, CORS, HTTP framing
  └─ scope-host: state, ingest, storage, queries, compute, persistence
```

Electron starts exactly one Rust child. The child binds `127.0.0.1:0`, creates
a 256-bit random bearer token from the operating system RNG, and writes one
JSON handshake line to stdout:

```json
{
  "transport_version": 1,
  "port": 43817,
  "token": "base64url-without-padding",
  "protocol_version": 17
}
```

All later diagnostics go to stderr. Electron rejects malformed handshakes,
wrong transport versions, early process exit, non-loopback addresses, and a
startup delay over 10 seconds. Closing Electron closes the child's stdin; the
server treats EOF as a graceful shutdown request and exits within five
seconds. Electron kills a child that misses that deadline.

## Rust host

### `scope-host`

`scope-host` depends on `scope-core` and `scope-protocol`, never Electron,
Node.js, Axum, or an operating-system window toolkit.

```rust
pub struct HostPaths {
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub resource_dir: PathBuf,
}

pub struct HostConfig {
    pub paths: HostPaths,
    pub available_memory_bytes: u64,
}

pub struct ScopeHost { /* private state */ }

impl ScopeHost {
    pub fn open(config: HostConfig) -> Result<Self, HostError>;
}
```

The current Tauri `DataState`, restore gate, batch jobs, path resolution, and
command bodies move into focused modules:

```text
src/config.rs       HostConfig, HostPaths, preferences-derived budgets
src/state.rs        private DataState and commit sink
src/catalog.rs      source/signal/format queries
src/ingest.rs       scans, batch lifecycle, restore, recipes
src/query.rs        ordered tiles and exact sample queries
src/derived.rs      derived signal and bundle operations
src/session.rs      autosave, named workspace persistence, reset
src/preferences.rs  preferences and effective directories
src/export.rs       estimates, HTML generation, and atomic file writes
src/error.rs        stable HostError code and safe user-facing message
```

Methods consume protocol payloads and return protocol payloads. They do not
open dialogs and do not wrap values in transport envelopes. Unit tests migrate
with the code; Tauri mocks and `AppHandle` disappear.

### `scope-server`

`scope-server` depends on `scope-host`, `scope-protocol`, Axum, Tokio, and the
OS random source. It contains no scientific behavior.

Every route except `/v1/health` requires
`Authorization: Bearer <handshake-token>`. The server permits only the exact
production origin `app://signalscope` and, in development, the exact origin
passed by `--dev-origin` (normally `http://127.0.0.1:4173`). Wildcard CORS,
non-loopback binds, query-string tokens, and token logging are forbidden.

JSON routes accept and return existing versioned `Envelope<T>` values. Errors
use HTTP status plus this transport shape:

```ts
interface NativeError {
  transport_version: 1;
  code: string;
  message: string;
}
```

The message is safe to show to the user and contains no stack trace. Statuses
are 400 for malformed/version-invalid requests, 401 for authentication, 404
for unknown routes, 409 for state conflicts, 413 for body limits, and 500 for
unexpected host failures.

### Route surface

All operation routes use `POST`; this avoids cache semantics and gives every
request one envelope shape.

| Route                              | Host operation                  | Response                   |
| ---------------------------------- | ------------------------------- | -------------------------- |
| `/v1/catalog/formats`              | list formats                    | JSON                       |
| `/v1/catalog/sources`              | list sources                    | JSON                       |
| `/v1/catalog/signals`              | list signals                    | JSON                       |
| `/v1/ingest/scan`                  | scan paths                      | JSON                       |
| `/v1/ingest/start`                 | start batch                     | JSON                       |
| `/v1/ingest/status`                | batch status                    | JSON                       |
| `/v1/ingest/detail`                | batch detail                    | JSON                       |
| `/v1/ingest/cancel`                | cancel batch                    | JSON                       |
| `/v1/ingest/release`               | release batch                   | JSON                       |
| `/v1/ingest/introspect`            | container outline               | JSON                       |
| `/v1/ingest/recipe`                | save recipe                     | JSON                       |
| `/v1/restore/start`                | restore sources                 | JSON                       |
| `/v1/restore/reconcile`            | reconcile restored state        | JSON                       |
| `/v1/query/tiles`                  | ordered tile query              | existing binary tile frame |
| `/v1/query/samples`                | exact bounded samples           | JSON                       |
| `/v1/derived/create`               | create derived signal           | JSON                       |
| `/v1/derived/remove`               | remove derived signal           | JSON                       |
| `/v1/derived-bundle/create`        | create bundle                   | JSON                       |
| `/v1/derived-bundle/remove`        | remove bundle                   | JSON                       |
| `/v1/session/save`                 | save session/autosave           | JSON                       |
| `/v1/session/load`                 | load session                    | JSON                       |
| `/v1/session/reset`                | reset session                   | JSON                       |
| `/v1/preferences/load`             | load preferences                | JSON                       |
| `/v1/preferences/save`             | save preferences                | JSON                       |
| `/v1/preferences/recipe-directory` | effective recipe directory      | JSON                       |
| `/v1/export/estimate`              | export estimate                 | JSON                       |
| `/v1/export/html`                  | generate and write snapshot     | JSON                       |
| `/v1/export/file`                  | atomically write frontend bytes | binary upload              |

`/v1/export/file` replaces base64 file payloads. Its body starts with the
existing protocol version, a length-prefixed JSON metadata envelope, and raw
bytes. The metadata selects either one exact destination path or a directory,
sanitized file name, and export kind. The server streams bytes to an adjacent
temporary file and atomically renames it; it does not create an extra base64
copy.

## Electron desktop shell

The `desktop` workspace package has no production npm dependencies beyond
Electron itself. Electron and electron-builder are exact dev dependencies:

```json
{
  "electron": "43.2.0",
  "electron-builder": "26.15.7"
}
```

TypeScript compiles the main and preload entries to CommonJS. No Electron
Vite plugin or frontend framework is introduced.

```text
desktop/src/main.ts       app lifecycle and single-instance handling
desktop/src/window.ts     secure BrowserWindow and app:// protocol
desktop/src/backend.ts    child path, spawn, handshake, shutdown
desktop/src/dialogs.ts    fixed native dialog IPC handlers
desktop/src/preload.ts    contextBridge API and drop-path recovery
desktop/src/types.ts      shared bridge types
desktop/electron-builder.yml
```

The production window loads `app://signalscope/index.html`; development loads
only `http://127.0.0.1:4173`. Navigation, new windows, downloads, permissions,
remote content, and the `<webview>` tag are denied. DevTools open only in
development or with an explicit command-line switch.

BrowserWindow security options are fixed:

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
}
```

The preload exposes `window.scopeDesktop` with only:

```ts
interface ScopeDesktopBridge {
  connect(): Promise<NativeConnection>;
  pickSources(formats: readonly FormatDescriptor[]): Promise<string[]>;
  pickSourceFolder(): Promise<string | null>;
  pickSession(mode: SessionDialogMode): Promise<string | null>;
  pickExportFile(name: string, kind: ExportFileKind): Promise<string | null>;
  pickDirectory(kind: "export" | "recipe"): Promise<string | null>;
  onDragDrop(handler: (event: DragDropForward) => void): () => void;
  gpuInfo(): Promise<DesktopGpuInfo>;
}
```

There is no generic `invoke`, arbitrary filesystem API, shell command API,
Node object, or raw `ipcRenderer` exposure.

## TypeScript data plane

`frontend/src/app/data-plane.ts` retains only interfaces, `BakedPlane`, and
host selection. Native code moves into:

```text
frontend/src/app/native-client.ts   authenticated fetch and error decoding
frontend/src/app/native-plane.ts    DataPlane capability adapters
frontend/src/app/desktop-bridge.ts  preload type declaration
```

`selectDataPlane()` becomes asynchronous. The presence of
`window.scopeDesktop` selects `NativePlane.create`; its absence selects
`BakedPlane.fromDocument`. This is the only host selection branch.

`NativePlane` asks Electron for paths and Rust for data. For example, source
selection is Electron dialog → returned paths → Rust batch start. Session and
export dialogs follow the same rule. NativePlane never imports Electron and
the Electron preload never imports frontend application code.

## Files, dialogs, and operating-system events

- Electron dialogs return paths only. Rust validates, reads, and writes them.
- Browser `File` objects are never used for ingest. The preload uses
  Electron's supported path recovery API and emits `DragDropForward` through
  `IngestPort`.
- macOS `open-file`, Windows/Linux command-line file paths, and second-instance
  arguments feed the same drop/open classifier after the renderer is ready.
- Preferences, cache, resources, and default recipes use directories passed
  from Electron's `app.getPath` results to the Rust child at startup.
- Snapshot HTML is generated by Rust from the packaged
  `frontend/dist/snapshot-template.html`. Packaged resources are never found
  through current-working-directory assumptions.

## WebGPU policy

Production Electron uses Chromium's default hardware adapter selection and no
unsafe GPU switches. The unsupported-host screen remains when adapter or
required limits are absent.

`SIGNALSCOPE_GPU_MODE=software` is test/development-only. Electron then adds
the pinned SwiftShader switches before `app.ready`. The UI status surface and
test reports identify software rendering explicitly; software measurements
cannot satisfy performance floors.

Test authority is separated:

| Layer                | Authority                          | Purpose                               |
| -------------------- | ---------------------------------- | ------------------------------------- |
| Rust/unit            | repository test scripts            | host behavior and protocol            |
| GPU correctness      | Chromium SwiftShader               | shaders, pixels, picking, recovery    |
| Electron integration | Electron + SwiftShader             | process, dialogs, transport, renderer |
| Performance          | Electron/Chromium hardware adapter | `mc1000`, `dense10k`, pan/zoom        |
| Snapshots            | standalone Chromium                | offline `BakedPlane` parity           |

The hardware benchmark records Electron/Chromium versions, adapter info,
driver information, limits, and whether Electron reports software rendering.
It refuses to produce a passing performance report for SwiftShader, llvmpipe,
Lavapipe, WARP, or another fallback adapter.

## Packaging and supported outputs

Electron-builder packages the frontend and the matching release-mode Rust
host. `asar` contains Electron JavaScript; the Rust executable and frontend
resource directory are explicit unpacked resources.

| OS      | Architectures    | Artifacts                    |
| ------- | ---------------- | ---------------------------- |
| Linux   | x86_64           | AppImage, `.deb`, `.rpm`     |
| Windows | x86_64           | NSIS `-setup.exe`            |
| macOS   | x86_64 and arm64 | architecture-labelled `.dmg` |

Cross-compiling the Rust host is not assumed. Each CI runner builds its own
host and Electron package. Signing is optional in ordinary CI and uses the
existing release secrets when supplied; unsigned artifacts are labelled as
such and are never described as notarized.

## Public scripts

The completed public API is:

```text
./scripts/run.sh native              Electron + Rust host, hardware GPU
./scripts/run.sh native --software-gpu
./scripts/run.sh web                 standalone baked frontend
./scripts/test.sh host [filter…]
./scripts/test.sh desktop [filter…]
./scripts/test.sh gpu
./scripts/test.sh native-e2e
./scripts/test.sh bench e2e
./scripts/build.sh web
./scripts/build.sh native
./scripts/build.sh appimage
./scripts/build.sh windows
```

`test.sh shell` is deleted, not aliased. Build outputs move from
`target/release/bundle` to `desktop/release`; release collection and CI use
only the new paths.

## Deletion and quality gates

The implementation is incomplete while any live source, manifest, script,
workflow, instruction, or package references Tauri, Wry, WebKitGTK,
`TauriPlane`, `__TAURI_INTERNALS__`, `cargo tauri`, `@tauri-apps`, or
`shell/src-tauri`. Historical ADRs and historical plans may retain those
terms. A repository quality check enforces this distinction.

The final tree must also remove:

- Tauri crates and lockfile entries;
- cargo-tauri and WebKitGTK from the Nix shell;
- AppImage/Windows Tauri installer scripts and setup dependencies;
- Tauri version synchronization logic;
- Tauri shell tests, mocks, capabilities, generated schemas, and icons;
- obsolete base64 native export request types after raw binary writing lands;
- the claim that SwiftShader benchmark timings measure plotting performance.

## Acceptance

The replacement is complete only when:

1. `rg` finds no live Tauri or system-webview implementation reference.
2. One Electron package launches the same frontend on all three OS families.
3. Native ingest, restore, sessions, preferences, recipes, HTML/PNG/CSV export,
   drag/drop, command-line open, and binary tile queries pass through Rust.
4. The renderer passes the existing nonblank SwiftShader proof.
5. Electron native E2E loads a real fixture through the Rust host and renders
   nonblank WebGPU pixels.
6. A hardware run loads `mc1000`, reports a non-software adapter, and measures
   responsive pan/zoom without SwiftShader.
7. Baked exports remain single-file, offline, and renderer-identical.
8. Linux, Windows, and both macOS architecture builds contain the correct Rust
   host and start without a development checkout.
9. Format, quality, Rust, frontend, GPU, Electron E2E, build, and release-asset
   gates pass through repository scripts.
10. Version manifests are synchronized at 2.0.0 as the final change.
