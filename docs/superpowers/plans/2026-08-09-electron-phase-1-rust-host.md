# Electron Migration Phase 1: Rust Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every native data operation from Tauri into a tested,
shell-independent Rust host and expose it through an authenticated loopback
server.

**Architecture:** `scope-host` owns state and typed operations over
`scope-core`/`scope-protocol`; `scope-server` owns HTTP, authentication,
envelopes, and process lifecycle. The existing Tauri shell may delegate during
this phase only so intermediate commits compile; Phase 3 deletes it.

**Tech Stack:** Rust 2024, scope-core, scope-protocol, Axum 0.8, Tokio 1,
Serde, base64 0.22, getrandom 0.3.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-09-electron-rust-desktop-architecture-design.md` exactly.
- `scope-host` must not depend on Tauri, Axum, Electron, or Node.js.
- `scope-server` must not contain ingest, query, compute, persistence, or export logic.
- Preserve protocol envelopes and the existing binary tile framing.
- Bind only to `127.0.0.1:0`; never log or place the bearer token in argv.
- Use repository scripts for every test/build command.
- Keep the existing untracked corrective WebGPU plan untouched.
- Do not bump the application version in this phase.

---

## Resulting file structure

```text
host/scope-host/Cargo.toml
host/scope-host/src/lib.rs
host/scope-host/src/config.rs
host/scope-host/src/state.rs
host/scope-host/src/catalog.rs
host/scope-host/src/ingest.rs
host/scope-host/src/query.rs
host/scope-host/src/derived.rs
host/scope-host/src/session.rs
host/scope-host/src/preferences.rs
host/scope-host/src/export.rs
host/scope-host/src/error.rs
host/scope-server/Cargo.toml
host/scope-server/src/lib.rs
host/scope-server/src/main.rs
host/scope-server/src/auth.rs
host/scope-server/src/handshake.rs
host/scope-server/src/routes.rs
host/scope-server/src/shutdown.rs
host/scope-server/tests/http.rs
```

### Task 1: Record the decision and create testable crate boundaries

**Files:**

- Create: `docs/adr/0040-electron-rust-desktop-host.md`
- Modify: `docs/adr/README.md`
- Modify: `Cargo.toml`
- Create: `host/scope-host/Cargo.toml`
- Create: `host/scope-host/src/lib.rs`
- Create: `host/scope-server/Cargo.toml`
- Create: `host/scope-server/src/lib.rs`
- Create: `host/scope-server/src/main.rs`
- Modify: `scripts/test.sh`
- Modify: `scripts/build.sh`

**Interfaces:**

- Produces: Cargo packages `scope-host` and `scope-server`; binary name
  `signalscope-host`; script commands `test.sh host` and `build.sh host`.

- [ ] **Step 1: Write ADR 0040**

Record the decisions from the approved spec: Electron 43.2.0 on all desktop
OSes, a sandboxed renderer, `NativePlane`, authenticated loopback transport,
Rust data ownership, no completed dual-shell state, and final removal of
Tauri. Mark ADR 0040 as superseding only the host-specific portions of ADRs
0001, 0002, 0004, 0007, 0032, 0035, 0036, and 0039. Add it to the ADR index.

- [ ] **Step 2: Add failing public script cases**

Add `host)` to `scripts/test.sh`:

```bash
host)
  shift || true
  cargo test -p scope-host -p scope-server "$@"
  ;;
```

Add `host)` to `scripts/build.sh` after `ensure_dev_shell`:

```bash
host)
  shift || true
  exec cargo build -p scope-server --bin signalscope-host "$@"
  ;;
```

Update both help texts. Do not rename or remove existing commands yet.

- [ ] **Step 3: Run the new test command and preserve the failure**

Run: `./scripts/test.sh host`

Expected: FAIL because the two packages are not workspace members.

- [ ] **Step 4: Create the minimal crates**

Add both host crates to `workspace.members`. Add exact workspace dependencies:

```toml
axum = "0.8"
base64 = "0.22"
getrandom = "0.3"
tokio = { version = "1", features = ["macros", "net", "rt-multi-thread", "signal"] }
tower = { version = "0.5", features = ["util"] }
```

`scope-host/src/lib.rs` exports only `pub struct ScopeHost;` initially.
`scope-server/src/lib.rs` exports `pub const TRANSPORT_VERSION: u32 = 1;`.
`main.rs` returns success without starting a server until Task 6.

- [ ] **Step 5: Verify the boundaries**

Run: `./scripts/test.sh host`

Expected: PASS.

Run: `./scripts/build.sh host`

Expected: PASS and create `target/debug/signalscope-host` (or `.exe`).

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock docs/adr/README.md docs/adr/0040-electron-rust-desktop-host.md host/scope-host host/scope-server scripts/test.sh scripts/build.sh
git commit -m "feat(host): establish shell-independent native boundary"
```

### Task 2: Extract host configuration and application state

**Files:**

- Create: `host/scope-host/src/config.rs`
- Create: `host/scope-host/src/error.rs`
- Create: `host/scope-host/src/state.rs`
- Modify: `host/scope-host/src/lib.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Test: `host/scope-host/src/config.rs`
- Test: `host/scope-host/src/state.rs`

**Interfaces:**

- Produces:

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

#[derive(Clone)]
pub struct ScopeHost { inner: Arc<HostInner> }

impl ScopeHost {
    pub fn open(config: HostConfig) -> Result<Self, HostError>;
}
```

- [ ] **Step 1: Write failing configuration tests**

Test with temporary config/cache/resource directories that:

1. default paths are exactly `config_dir/scope-preferences.json`,
   `cache_dir/cache`, and `config_dir/recipes`;
2. a stored preference cache override wins;
3. invalid/future preferences fail `ScopeHost::open` clearly;
4. budget values use preferences when present and available-memory defaults
   otherwise;
5. missing `resource_dir/snapshot-template.html` does not prevent opening but
   produces a typed export error when used.

- [ ] **Step 2: Run the focused test**

Run: `./scripts/test.sh host config`

Expected: FAIL because `HostConfig` and `ScopeHost::open` do not exist.

- [ ] **Step 3: Move state without changing behavior**

Move `DataState`, `RestoreGate`, `RestoreSettlement`, `ShellCommitSink`, budget
construction, preference loading, and path resolution from
`shell/src-tauri/src/lib.rs` into the three new modules. Rename
`ShellCommitSink` to `HostCommitSink`. Keep fields private.

`HostError` is:

```rust
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{message}")]
    Invalid { code: &'static str, message: String },
    #[error("{message}")]
    Conflict { code: &'static str, message: String },
    #[error("{message}")]
    Internal { code: &'static str, message: String },
}
```

Add `code()` and `kind()` accessors; do not expose nested debug chains to the
frontend.

- [ ] **Step 4: Make the temporary Tauri setup construct `ScopeHost`**

Tauri may retain only platform directory discovery in this phase. Build a
`HostConfig` in `.setup`, manage `ScopeHost`, and remove its owned `DataState`,
`RestoreGate`, and `BatchJobs`. Do not add a new compatibility module.

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh host config`

Expected: PASS.

Run: `./scripts/test.sh shell`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add host/scope-host shell/src-tauri/src/lib.rs Cargo.lock
git commit -m "refactor(host): extract native state and configuration"
```

### Task 3: Extract catalog, ingest, restore, and recipe operations

**Files:**

- Create: `host/scope-host/src/catalog.rs`
- Create: `host/scope-host/src/ingest.rs`
- Modify: `host/scope-host/src/lib.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Test: `host/scope-host/src/catalog.rs`
- Test: `host/scope-host/src/ingest.rs`

**Interfaces:**

- Produces typed `ScopeHost` methods named:

```text
list_formats, list_sources, list_signals, scan_sources,
start_batch, batch_status, batch_detail, cancel_batch, release_batch,
introspect_container, save_recipe, restore_sources, restore_reconcile
```

Each method consumes the current generated request payload and returns the
current generated response payload, without `Envelope`.

- [ ] **Step 1: Move existing tests before implementations**

Move shell tests for provider formatting, source expansion, atomic ingest,
batch status conversion, restore reconciliation, and symlink-safe recipe
writes into `scope-host`. Rewrite setup around `ScopeHost::open` and temporary
`HostPaths`; preserve assertions exactly.

- [ ] **Step 2: Run and confirm failures**

Run: `./scripts/test.sh host ingest`

Expected: FAIL because the methods are absent.

- [ ] **Step 3: Move catalog and ingest code**

Move the corresponding command bodies and private helpers from the Tauri file.
Replace `State<T>` parameters with `&self` access through `HostInner`. Keep
blocking decode work in the existing batch worker design. `scope-host` methods
must not call `spawn_blocking`; that scheduling belongs to the caller only
where an operation is not already job-based.

- [ ] **Step 4: Reduce Tauri commands to delegation**

Each non-dialog Tauri command opens its request envelope, calls one
`ScopeHost` method, and seals the response. Dialog commands may still obtain
paths before calling the same host methods. No operation body remains copied.

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh host ingest`

Run: `./scripts/test.sh shell`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add host/scope-host shell/src-tauri/src/lib.rs
git commit -m "refactor(host): extract ingest and catalog services"
```

### Task 4: Extract queries and derived computation

**Files:**

- Create: `host/scope-host/src/query.rs`
- Create: `host/scope-host/src/derived.rs`
- Modify: `host/scope-host/src/lib.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Test: `host/scope-host/src/query.rs`
- Test: `host/scope-host/src/derived.rs`

**Interfaces:**

- Produces:

```rust
pub async fn query_tiles(&self, request: TileRequest) -> Result<Vec<u8>, HostError>;
pub fn query_samples(&self, request: SampleRequest) -> Result<SampleResponse, HostError>;
pub fn create_derived(&self, request: DerivedRequest) -> Result<SignalSummary, HostError>;
pub fn remove_signal(&self, request: RemoveSignalRequest) -> Result<(), HostError>;
pub fn create_derived_bundle(&self, request: CreateDerivedBundleRequest) -> Result<DerivedBundleResponse, HostError>;
pub fn remove_derived_bundle(&self, request: RemoveDerivedBundleRequest) -> Result<(), HostError>;
```

- [ ] **Step 1: Move query and derived tests**

Move tests for per-series tile target, ordered binary points, exact samples,
NaN serialization inputs, derived lifecycle, bundle atomicity, and removals.
Add one concurrency test proving a tile query does not hold the state mutex
while awaiting blocking work.

- [ ] **Step 2: Run the failing tests**

Run: `./scripts/test.sh host query`

Expected: FAIL because the six methods are absent.

- [ ] **Step 3: Move query code**

Move `query_tiles_bin`, `query_samples`, `windowed_slice`, tile target logic,
and helpers. Keep the binary encoder in `scope-protocol`. Clone only the
bounded query inputs needed outside the lock, then use Tokio blocking work for
the existing synchronous pyramid query.

- [ ] **Step 4: Move derived code**

Move derived signal and bundle command bodies. Preserve store/pyramid
transactionality and source-local identifiers. Return typed `HostError`
instead of strings.

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh host query`

Run: `./scripts/test.sh shell`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add host/scope-host shell/src-tauri/src/lib.rs
git commit -m "refactor(host): extract query and compute services"
```

### Task 5: Extract session, preferences, and export operations

**Files:**

- Create: `host/scope-host/src/session.rs`
- Create: `host/scope-host/src/preferences.rs`
- Create: `host/scope-host/src/export.rs`
- Modify: `host/scope-host/src/lib.rs`
- Modify: `shell/src-tauri/src/lib.rs`
- Test: `host/scope-host/src/session.rs`
- Test: `host/scope-host/src/preferences.rs`
- Test: `host/scope-host/src/export.rs`

**Interfaces:**

- Produces typed methods named:

```text
save_session, load_session, reset_session, load_preferences,
save_preferences, effective_recipe_directory, export_estimate,
export_html_to_path, write_export_file, write_export_file_to_directory
```

- [ ] **Step 1: Add failing path-independent tests**

Use temporary `HostPaths` to cover autosave, explicit session paths, corrupt
and future sessions, reset, preference round-trip, preference budget refresh,
effective recipe directory, snapshot template lookup, export size estimate,
HTML atomic write, raw PNG bytes, sanitized directory filenames, and planted
symlink protection.

- [ ] **Step 2: Run and confirm failure**

Run: `./scripts/test.sh host export`

Expected: FAIL because host persistence methods are absent.

- [ ] **Step 3: Move persistence and export behavior**

Remove every `AppHandle` dependency from operation bodies. Exact destination
paths are method inputs; default autosave and preferences paths come from
`HostPaths`. The snapshot template is
`resource_dir/snapshot-template.html`. Preserve atomic adjacent-temp writes.

- [ ] **Step 4: Keep dialogs outside the host**

Temporary Tauri dialog commands pick a path and call the host method. Verify
that no `tauri`, `DialogExt`, or GUI type appears under `host/`:

Run: `rg -n "tauri|DialogExt|AppHandle" host`

Expected: no matches.

- [ ] **Step 5: Verify**

Run: `./scripts/test.sh host`

Run: `./scripts/test.sh shell`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add host/scope-host shell/src-tauri/src/lib.rs
git commit -m "refactor(host): extract persistence and export services"
```

### Task 6: Implement authenticated loopback transport and lifecycle

**Files:**

- Create: `host/scope-server/src/auth.rs`
- Create: `host/scope-server/src/handshake.rs`
- Create: `host/scope-server/src/routes.rs`
- Create: `host/scope-server/src/shutdown.rs`
- Modify: `host/scope-server/src/lib.rs`
- Modify: `host/scope-server/src/main.rs`
- Create: `host/scope-server/tests/http.rs`

**Interfaces:**

- Produces:

```rust
pub const TRANSPORT_VERSION: u32 = 1;

pub struct ServerConfig {
    pub host: HostConfig,
    pub dev_origin: Option<String>,
}

pub async fn serve(config: ServerConfig) -> Result<(), ServerError>;
```

- [ ] **Step 1: Write failing HTTP tests**

Start the router with a deterministic test token and temporary host. Assert:

1. missing and wrong bearer tokens return 401;
2. production and configured development origins receive exact CORS headers;
3. an arbitrary origin receives no CORS permission;
4. wrong protocol envelopes return 400 before a host operation runs;
5. catalog and sample routes round-trip JSON envelopes;
6. `/v1/query/tiles` returns the existing binary magic and protocol version;
7. unknown routes return a versioned `NativeError` with 404;
8. host conflicts map to 409 and body overflow to 413;
9. no response includes the bearer token.

- [ ] **Step 2: Run and preserve failure**

Run: `./scripts/test.sh host http`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement auth and typed handlers**

Use one Axum handler per route from the design table. Helpers may open and seal
envelopes, but handlers must call typed `ScopeHost` methods. Set JSON body
limit to 16 MiB. Leave binary export upload to Phase 2, where its protocol
codec and frontend consumer land together.

- [ ] **Step 4: Implement secure startup**

Generate 32 random bytes with `getrandom`, encode base64url without padding,
bind `127.0.0.1:0`, print exactly one handshake JSON line to stdout, then flush
stdout before serving. Parse:

```text
--config-dir <absolute path>
--cache-dir <absolute path>
--resource-dir <absolute path>
--available-memory <u64>
--dev-origin <origin>  # optional
```

Reject relative paths and a non-loopback dev origin host.

- [ ] **Step 5: Implement shutdown**

Spawn a task that reads stdin to EOF. EOF, SIGINT, or SIGTERM triggers Axum
graceful shutdown. Stop accepting new requests, allow five seconds for active
requests, cancel batch jobs, and exit nonzero only for startup/runtime errors.

- [ ] **Step 6: Verify**

Run: `./scripts/test.sh host`

Run: `./scripts/build.sh host --release`

Expected: PASS and a release `signalscope-host` binary.

- [ ] **Step 7: Commit**

```bash
git add host/scope-server Cargo.toml Cargo.lock
git commit -m "feat(host): serve authenticated native data plane"
```

### Task 7: Prove parity and close Phase 1

**Files:**

- Modify: `scripts/lib.sh`
- Modify: `scripts/ci.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**

- Consumes: `./scripts/test.sh host`, `./scripts/build.sh host`.
- Produces: CI host test coverage and documented transitional state.

- [ ] **Step 1: Add host checks to repository quality paths**

Add `./scripts/test.sh host` to `rust_checks()` in `scripts/lib.sh`; do not run
raw Cargo commands in workflows. Ensure the existing Rust CI job reaches it.

- [ ] **Step 2: Add a protocol parity test**

For one fixture, call the temporary Tauri delegate and the HTTP router against
equivalent isolated hosts. Assert byte-identical tile frames and equal JSON
payloads for catalog, sample, session, preference, and export-estimate routes.
Do not compare dialog behavior.

- [ ] **Step 3: Run phase verification**

Run: `./scripts/format.sh`

Run: `./scripts/test.sh host`

Run: `./scripts/test.sh shell`

Run: `./scripts/test.sh core`

Run: `./scripts/ci.sh rust`

Expected: all PASS.

- [ ] **Step 4: Document only the current transition**

Add a short README architecture note that `scope-host` is now authoritative
and Tauri is a temporary caller pending Phase 3. Do not describe Electron as
shipped yet.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.sh scripts/ci.sh .github/workflows/ci.yml README.md host
git commit -m "test(host): prove transport parity before shell replacement"
```

## Phase 1 acceptance gate

- `scope-host` contains all native operations and no GUI/transport dependency.
- `scope-server` binds only loopback and authenticates every operation.
- Tauri contains only temporary platform adapters and no duplicated operation body.
- Existing Tauri behavior and binary tile bytes remain green.
- `./scripts/test.sh host`, `shell`, and `core` pass.
- No version bump has occurred.
