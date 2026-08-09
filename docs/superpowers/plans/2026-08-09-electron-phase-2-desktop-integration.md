# Electron Migration Phase 2: Desktop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch the production frontend in secure Electron 43.2.0, connect it
to `signalscope-host`, and restore every native `DataPlane` capability without
exposing Node.js to the renderer.

**Architecture:** Electron main owns lifecycle and dialogs, preload exposes a
fixed bridge, `NativeClient` owns authenticated fetch, and `NativePlane` maps
that transport to the existing frontend ports. `BakedPlane` remains unchanged
except for asynchronous host selection.

**Tech Stack:** Electron 43.2.0, TypeScript 5.9.3, Vitest 4.0.16, Playwright
1.57.0, Rust binary protocol codecs, Vite 7.2.4.

## Global Constraints

- Complete Phase 1 first.
- Follow the approved architecture spec exactly.
- No generic Electron invoke API and no Electron import under `frontend/`.
- Renderer security settings are fixed; do not disable sandboxing for convenience.
- Production loads only `app://signalscope`; development loads only `http://127.0.0.1:4173`.
- Electron dialogs return paths; Rust performs all data and filesystem work.
- Keep every runtime npm dependency out of the exported snapshot.
- Do not delete Tauri until Phase 3 parity gates pass.
- Do not bump the application version in this phase.

---

## Resulting file structure

```text
desktop/package.json
desktop/tsconfig.json
desktop/scripts/start.mjs
desktop/src/types.ts
desktop/src/main.ts
desktop/src/window.ts
desktop/src/backend.ts
desktop/src/dialogs.ts
desktop/src/preload.ts
desktop/tests/*.test.ts
frontend/src/app/desktop-bridge.ts
frontend/src/app/native-client.ts
frontend/src/app/native-plane.ts
frontend/src/app/file-binary.ts
frontend/tests/e2e/electron-native.spec.ts
```

### Task 1: Create the Electron package and secure window

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/scripts/start.mjs`
- Create: `desktop/src/types.ts`
- Create: `desktop/src/window.ts`
- Create: `desktop/src/main.ts`
- Create: `desktop/tests/window.test.ts`
- Modify: `scripts/setup.sh`
- Modify: `scripts/test.sh`
- Modify: `flake.nix`

**Interfaces:**

- Produces package `@signalscope/desktop` with scripts `build`, `test`, and
  `start`; public command `./scripts/test.sh desktop [filter…]`.

- [ ] **Step 1: Add a failing desktop script**

Add `desktop)` to `scripts/test.sh`:

```bash
desktop)
  shift || true
  pnpm --filter @signalscope/desktop test -- "$@"
  ;;
```

Run: `./scripts/test.sh desktop`

Expected: FAIL because the package does not exist.

- [ ] **Step 2: Add the exact package**

Add `desktop` to `pnpm-workspace.yaml`. Create a private CommonJS package with
exact dev dependencies:

```json
{
  "electron": "43.2.0",
  "electron-builder": "26.15.7",
  "typescript": "5.9.3",
  "vitest": "4.0.16"
}
```

Compile `src` to `dist` with `module: "CommonJS"`, `target: "ES2022"`,
`strict: true`, and Node/Electron types. `main` is `dist/main.js`.

`start.mjs` launches absolute `SIGNALSCOPE_ELECTRON_BIN` when set and otherwise
uses the installed Electron package path. Reject a relative/missing override.
Add `electron_43` to the Nix dev shell and export its binary path; this keeps
NixOS development off the unpatched npm Electron executable.

Run: `./scripts/setup.sh --update-lock`

- [ ] **Step 3: Write secure-window tests**

Mock Electron and assert the BrowserWindow options exactly match the spec.
Assert production resolves `app://signalscope/index.html`; development accepts
only `http://127.0.0.1:4173`. Assert navigation outside the selected origin,
`window.open`, permission requests, and downloads are denied.

- [ ] **Step 4: Run and preserve failure**

Run: `./scripts/test.sh desktop window`

Expected: FAIL because `createWindow` is absent.

- [ ] **Step 5: Implement the window and custom protocol**

Export:

```ts
export interface WindowConfig {
  readonly developmentUrl: string | null;
  readonly frontendRoot: string;
  readonly preloadPath: string;
}

export function createWindow(config: WindowConfig): BrowserWindow;
export function registerAppProtocol(frontendRoot: string): void;
```

Register `app` as standard, secure, fetch-capable, and CORS-enabled before app
ready. Resolve request paths under `frontendRoot` after URL-decoding and reject
path traversal. Serve files with fixed MIME types and a CSP implementing the
spec. Set the fixed BrowserWindow security options and deny all navigation,
new-window, download, and permission requests.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh desktop window`

Run: `./scripts/build.sh web`

Expected: PASS.

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml desktop scripts/setup.sh scripts/test.sh flake.nix flake.lock
git commit -m "feat(desktop): establish sandboxed Electron host"
```

### Task 2: Manage the Rust child process safely

**Files:**

- Create: `desktop/src/backend.ts`
- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/main.ts`
- Create: `desktop/tests/backend.test.ts`

**Interfaces:**

- Produces:

```ts
export interface NativeConnection {
  readonly transportVersion: 1;
  readonly baseUrl: string;
  readonly token: string;
  readonly protocolVersion: number;
}

export interface BackendPaths {
  readonly executable: string;
  readonly configDir: string;
  readonly cacheDir: string;
  readonly resourceDir: string;
}

export class BackendProcess {
  static start(
    paths: BackendPaths,
    devOrigin: string | null,
  ): Promise<BackendProcess>;
  connection(): NativeConnection;
  stop(): Promise<void>;
}
```

- [ ] **Step 1: Write lifecycle tests with a fake child**

Cover a valid fragmented handshake, malformed JSON, wrong transport version,
non-loopback port, token shape, stderr forwarding, pre-handshake exit,
10-second timeout using fake timers, stdin-close shutdown, five-second kill,
and idempotent `stop()`.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh desktop backend`

Expected: FAIL because `BackendProcess` does not exist.

- [ ] **Step 3: Implement executable resolution**

Development uses the absolute `SIGNALSCOPE_HOST_BIN` set by `run.sh`.
Production resolves:

```ts
join(
  process.resourcesPath,
  "bin",
  process.platform === "win32" ? "signalscope-host.exe" : "signalscope-host",
);
```

Reject missing, non-file, or relative paths before spawn.

- [ ] **Step 4: Implement spawn and handshake**

Spawn detached false with piped stdin/stdout and inherited stderr. Pass only
the six path/value arguments defined by Phase 1 and optional `--dev-origin`.
Parse one newline-terminated stdout record capped at 8 KiB. Validate transport
version 1, integer port 1–65535, 43-character base64url token, and protocol
version. Never print the token.

- [ ] **Step 5: Wire app lifecycle**

Acquire Electron's single-instance lock. Start the backend before creating a
window. On startup failure, show one native error dialog and quit. On
`before-quit`, await backend stop once. Handle `second-instance` and macOS
`open-file` paths by queueing them for Task 3.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh desktop backend`

Run: `./scripts/build.sh host`

Expected: PASS.

```bash
git add desktop/src desktop/tests
git commit -m "feat(desktop): supervise native Rust host"
```

### Task 3: Expose dialogs, drag/drop, and GPU diagnostics through preload

**Files:**

- Create: `desktop/src/dialogs.ts`
- Create: `desktop/src/preload.ts`
- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/main.ts`
- Create: `desktop/tests/dialogs.test.ts`
- Create: `desktop/tests/preload.test.ts`
- Create: `frontend/src/app/desktop-bridge.ts`

**Interfaces:**

- Produces the exact `ScopeDesktopBridge` from the design spec and global
  `window.scopeDesktop?: ScopeDesktopBridge`.

- [ ] **Step 1: Define clone-safe bridge types**

In both desktop and frontend type files define structurally equal types for
`NativeConnection`, dialog filters, `DesktopGpuInfo`, and the bridge. Do not
import files across the Electron/frontend package boundary. Add a frontend
type test that assigns each side to a checked fixture object.

- [ ] **Step 2: Write failing dialog tests**

Assert fixed IPC channels and options for supported source files, source
folder, open/save `.signalscope`, HTML/PNG/CSV save, export directory, and
recipe directory. Cancellation returns `null` or `[]`; errors reject. File
filters are built from `FormatDescriptor` values and never from HTML.

- [ ] **Step 3: Implement dialog handlers**

Register handlers once in main. Validate every renderer argument before
calling `dialog.showOpenDialog`/`showSaveDialog`. Reject unknown export kinds,
empty extensions, non-string names, and calls from a WebContents other than
the workbench window.

- [ ] **Step 4: Write and implement preload tests**

Expose only the methods in the spec through `contextBridge`. Each dialog uses
one fixed `ipcRenderer.invoke` channel. `connect()` returns a frozen copy of
the connection without mutators.

At DOM readiness, install dragenter/drop/dragleave listeners. Recover paths
with `webUtils.getPathForFile`, discard empty paths, deduplicate in encounter
order, and notify registered callbacks with `DragDropForward`. The unsubscribe
removes one callback; it does not remove global listeners while others remain.

- [ ] **Step 5: Feed OS open events through the same callback**

Main sends queued launch paths, macOS open-file paths, and second-instance
argv paths on one fixed IPC event after `did-finish-load`. Preload converts
them to `DragDropKind.Drop`. Do not add a second frontend classifier.

- [ ] **Step 6: Add GPU diagnostics**

Main waits for Electron's `gpu-info-update`, then returns
`app.getGPUFeatureStatus()` and `app.getGPUInfo("complete")` reduced to
clone-safe fields. Include Electron, Chromium, and OS versions and a
`softwareRendering` boolean. Never expose arbitrary Electron process data.

- [ ] **Step 7: Verify and commit**

Run: `./scripts/test.sh desktop dialogs`

Run: `./scripts/test.sh unit frontend/src/app/desktop-bridge.test.ts`

Expected: PASS.

```bash
git add desktop/src desktop/tests frontend/src/app/desktop-bridge.ts frontend/src/app/desktop-bridge.test.ts
git commit -m "feat(desktop): expose narrow native capability bridge"
```

### Task 4: Implement authenticated NativeClient and raw file uploads

**Files:**

- Create: `frontend/src/app/native-client.ts`
- Create: `frontend/src/app/native-client.test.ts`
- Create: `frontend/src/app/file-binary.ts`
- Create: `frontend/src/app/file-binary.test.ts`
- Create: `protocol/src/file_binary.rs`
- Modify: `protocol/src/lib.rs`
- Modify: `host/scope-server/src/routes.rs`
- Modify: `host/scope-host/src/export.rs`
- Test: `host/scope-server/tests/http.rs`

**Interfaces:**

- Produces:

```ts
export class NativeClient {
  constructor(connection: NativeConnection, fetchFn?: typeof fetch);
  json<Req, Res>(path: string, request: Envelope<Req>): Promise<Envelope<Res>>;
  tiles(request: Envelope<TileRequest>): Promise<ArrayBuffer>;
  writeFile(
    metadata: Envelope<FileWriteMetadata>,
    bytes: Uint8Array,
  ): Promise<Envelope<string>>;
}
```

- [ ] **Step 1: Specify the binary file frame with paired failing tests**

Use little-endian framing:

```text
u32 magic = 0x57465353 (SSFW)
u32 protocol_version
u32 metadata_length
u32 reserved = 0
u64 payload_length
metadata_length bytes of UTF-8 JSON Envelope<FileWriteMetadata>
payload_length raw bytes
```

Add Rust and TypeScript fixtures for Unicode paths, empty payload, PNG bytes,
truncation at every header field, wrong magic/version, length overflow, and
trailing bytes. Both codecs must accept/reject the same fixtures.

- [ ] **Step 2: Add the protocol metadata type**

Change `protocol/schema/scope-protocol.json`: remove base64 fields from native
file-write requests and generate `FileWriteMetadata` with an explicit tagged
destination: exact path or directory plus filename. Bump the protocol version
and regenerate only through the repository codegen script.

- [ ] **Step 3: Implement raw streaming write**

Add `/v1/export/file` with a 1 GiB hard body limit. Decode metadata before
writing payload bytes to an adjacent temporary file, enforce existing
extension/name rules, fsync, and atomically rename. Reject symlinks and partial
bodies; remove temporary files on failure.

- [ ] **Step 4: Write NativeClient tests**

Assert bearer header, exact content types, no token in URL/body/error text,
JSON envelope handling, binary tile response, raw upload framing, abort on
network error, and `NativeError` decoding for each non-2xx class.

- [ ] **Step 5: Implement NativeClient**

Freeze and validate the connection. Construct paths only with `new URL(path,
baseUrl)`, reject non-`/v1/` paths, and attach the bearer header. Do not retry
mutating operations automatically.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh core file_binary`

Run: `./scripts/test.sh host http`

Run: `./scripts/test.sh unit frontend/src/app/file-binary.test.ts frontend/src/app/native-client.test.ts`

Expected: PASS.

```bash
git add protocol host/scope-host host/scope-server frontend/src/app/file-binary.ts frontend/src/app/file-binary.test.ts frontend/src/app/native-client.ts frontend/src/app/native-client.test.ts
git commit -m "feat(protocol): stream native export bytes without base64"
```

### Task 5: Replace TauriPlane with NativePlane

**Files:**

- Create: `frontend/src/app/native-plane.ts`
- Create: `frontend/src/app/native-plane.test.ts`
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/app/data-plane.test.ts`
- Modify: `frontend/src/main.ts`
- Modify: relevant export callers under `frontend/src/ui/`

**Interfaces:**

- Produces:

```ts
export class NativePlane implements DataPlane {
  static create(bridge: ScopeDesktopBridge): Promise<NativePlane>;
}

export async function selectDataPlane(): Promise<DataPlane>;
```

- [ ] **Step 1: Move existing TauriPlane behavior tests**

Copy every `TauriPlane` test case to `native-plane.test.ts`, replace invoke
recorders with `NativeClient`/bridge fakes, and rename expectations by behavior
rather than transport. Add route assertions for every method in every port.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh unit frontend/src/app/native-plane.test.ts`

Expected: FAIL because `NativePlane` does not exist.

- [ ] **Step 3: Implement all DataPlane ports**

Map the route table exactly. Dialog methods call the bridge; data operations
call `NativeClient`. Source picking fetches format descriptors before opening
the dialog. Drag/drop delegates to the bridge. Tile responses continue through
`decodeTileResponse`; sample NaNs retain existing normalization.

Change `ExportPort.saveFile` and `saveFileToDirectory` to consume
`Uint8Array`. Update PNG/CSV producers to decode their own data URL/base64 at
the edge and pass bytes once. HTML export picks an exact destination first,
then asks Rust to generate/write it.

- [ ] **Step 4: Make host selection asynchronous**

`selectDataPlane` chooses only on `window.scopeDesktop` presence. Await
`NativePlane.create` or return `BakedPlane.fromDocument`. Change frontend boot
to await selection before constructing `AppShell`. No other frontend file may
read `window.scopeDesktop`.

- [ ] **Step 5: Delete Tauri frontend code now**

Delete `TauriInternals`, `TauriPlane`, `__TAURI_INTERNALS__`, raw Tauri event
plugin calls, and their tests from `data-plane.ts`. Verify:

Run: `rg -n "TauriPlane|__TAURI_INTERNALS__|plugin:event" frontend`

Expected: no matches.

- [ ] **Step 6: Verify and commit**

Run: `./scripts/test.sh unit frontend/src/app/native-plane.test.ts frontend/src/app/data-plane.test.ts`

Run: `./scripts/test.sh frontend`

Expected: PASS.

```bash
git add frontend/src frontend/tests protocol
git commit -m "feat(frontend): replace TauriPlane with NativePlane"
```

### Task 6: Launch Electron through the public native command

**Files:**

- Modify: `scripts/run.sh`
- Modify: `scripts/build.sh`
- Modify: `desktop/package.json`
- Modify: `desktop/src/main.ts`
- Create: `frontend/tests/e2e/electron-native.spec.ts`
- Modify: `frontend/playwright.config.ts`
- Modify: `scripts/test.sh`

**Interfaces:**

- Produces `run.sh native [--software-gpu]` and `test.sh native-e2e`.

- [ ] **Step 1: Add a failing native E2E script**

The script builds the frontend, debug Rust host, and desktop TypeScript, sets
`SIGNALSCOPE_HOST_BIN` to the absolute binary, sets
`SIGNALSCOPE_GPU_MODE=software`, and runs the Electron Playwright project.

Run: `./scripts/test.sh native-e2e`

Expected: FAIL because the project is absent.

- [ ] **Step 2: Implement GPU mode parsing before app ready**

Only value `software` is accepted. In that mode append:

```text
--enable-unsafe-webgpu
--enable-features=Vulkan
--use-angle=swiftshader
--use-webgpu-adapter=swiftshader
```

Production/default appends none. Expose the selected mode in `DesktopGpuInfo`.

- [ ] **Step 3: Rewrite `run.sh native`**

Build the host through `./scripts/build.sh host`, export its absolute path,
start Vite, wait for port 4173 with the existing script helper, then launch
`pnpm --filter @signalscope/desktop start`. `--software-gpu` sets the one env
variable. Forward remaining Electron arguments after `--`. Ensure termination
cleans up Vite and the Rust child.

- [ ] **Step 4: Write native E2E behavior**

Launch Electron with isolated temporary config/cache directories and the
checked-in roundtrip CSV in argv. Assert:

1. one BrowserWindow at the expected origin;
2. `navigator.gpu`, adapter, device, and nonblank probe pixels;
3. the CLI file enters the regular ingest path;
4. signal catalog contains the fixture;
5. a plot submits nonzero descriptors and nonblank line pixels;
6. session save/load and preferences round-trip in temp directories;
7. closing Electron exits the Rust child.

- [ ] **Step 5: Verify and commit**

Run: `./scripts/test.sh native-e2e`

Run: `./scripts/run.sh native --software-gpu` and manually confirm the window
opens. Do not claim hardware performance.

```bash
git add scripts/run.sh scripts/build.sh scripts/test.sh desktop frontend/playwright.config.ts frontend/tests/e2e/electron-native.spec.ts
git commit -m "feat(desktop): run native workbench in Electron"
```

## Phase 2 acceptance gate

- Electron launches the Rust host and shared frontend through `run.sh native`.
- The renderer is sandboxed and has no Node.js/global IPC access.
- NativePlane implements every DataPlane capability and TauriPlane is gone.
- Native file loading and nonblank WebGPU rendering pass in Electron E2E.
- Raw native exports contain no base64 transport copy.
- Tauri exists only as an obsolete buildable shell awaiting Phase 3 deletion.
- No version bump has occurred.
