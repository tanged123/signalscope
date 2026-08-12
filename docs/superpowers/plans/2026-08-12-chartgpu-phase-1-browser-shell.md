# ChartGPU Phase 1 — Browser Shell (`scope-server`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **For Codex/sandboxed workers:** if your environment cannot run `git commit`, skip commit steps and report "commit deferred to supervisor". Never skip test steps.

**Goal:** Replace the Tauri shell with a localhost Rust HTTP server (`scope-server`) serving the built frontend and the versioned protocol to a dictated Chromium; delete Tauri entirely.

**Architecture:** A new `server/scope-server` crate (axum + tokio) owns the exact host state the Tauri shell owns today (`DataState`, `RestoreGate`, `BatchJobs`) and exposes every existing command as `POST /api/<command_name>` with the same `Envelope<T>` JSON bodies; `query_tiles_bin` returns the ADR 0036 binary as `application/octet-stream` (byte 0 = magic — `decodeTileResponse` consumes it unchanged). The frontend gets a third `DataPlane`, `HttpPlane`, that mirrors `TauriPlane` with `fetch`; plane selection becomes: baked element → `BakedPlane`, live `/api/health` → `HttpPlane`, else demo `BakedPlane`. Auth is a launch token exchanged for an HttpOnly cookie. File dialogs open natively from the server process via `rfd`. Window drag-drop is deliberately dropped (spec Amendment 6).

**Tech Stack:** Rust 2024 (axum 0.8, tokio, tower-http, rfd, dirs, rand, open), TypeScript 5.9 / Vite 7, Playwright.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-chartgpu-browser-renderer-design.md` **including Amendments 1, 6** — HTTP-only (no WebSocket), drag-drop dropped, `rfd` dialogs.
- Preserve verbatim: the `DataPlane` interface (minus `onDragDrop`), `Envelope` versioning (protocol v18 — **no protocol bump in this phase**), the tile-binary wire format, session/preferences schemas, transactional ingest, snapshot self-containment.
- All commands through `./scripts/` wrappers; extend wrappers rather than calling `cargo`/`pnpm` ad hoc. New operations get wrapper modes (Task 9).
- `deny.toml` has `unknown-registry = "deny"`: all new crates must come from crates.io and pass `cargo deny check` (part of `./scripts/ci.sh quality`).
- Default server port **8317**; loopback bind only (`127.0.0.1`).
- The frontend must keep **zero dynamic `import()`** and zero runtime npm dependencies (`check-runtime-deps.mjs` enforces the latter).
- Conventional commits, one per task. Run `./scripts/format.sh` before staging. Do not `git add -A`.
- Version bump happens ONCE, at Task 11, as the final change.

## Command inventory (the porting contract)

Every Tauri command in `shell/src-tauri/src/lib.rs` (registered at lines 1897–1932) becomes `POST /api/<name>`. Request body: the same `Envelope<Req>` JSON the frontend already builds with `seal(...)`; commands whose Tauri form takes no `request` accept an empty body. Response: `Envelope<Res>` JSON, or `400` with a plain-text error string (the Tauri error type is already `String`).

| Endpoint | Request → Response payload |
|---|---|
| `pick_sources` | ∅ → `Vec<String>` (rfd dialog) |
| `pick_source_folder` | ∅ → `Option<String>` (rfd) |
| `scan_sources` | `ScanSourcesRequest` → `ScanSourcesResponse` |
| `ingest_batch` | `IngestBatchRequest` → `BatchJob` |
| `batch_status` | `BatchJob` → `BatchStatus` |
| `batch_detail` | `BatchDetailRequest` → `BatchDetail` |
| `cancel_batch` | `BatchJob` → `()` |
| `release_batch` | `BatchJob` → `()` |
| `list_formats` | ∅ → `Vec<FormatDescriptor>` |
| `introspect_container` | `IntrospectRequest` → `ContainerOutline` (spawn_blocking) |
| `save_recipe` | `SaveRecipeRequest` → `SaveRecipeResponse` |
| `restore_sources` | `RestoreSourcesRequest` → `BatchJob` |
| `restore_reconcile` | `RestoreReconcileRequest` → `RestoreReconcileResponse` |
| `list_sources` | ∅ → `Vec<SourceSummary>` |
| `list_signals` | ∅ → `Vec<SignalSummary>` |
| `query_tiles_bin` | `TileRequest` → **binary** `application/octet-stream` |
| `query_samples` | `SampleRequest` → `SampleResponse` |
| `create_derived` | `DerivedRequest` → `SignalSummary` |
| `create_derived_bundle` | `CreateDerivedBundleRequest` → `DerivedBundleResponse` |
| `remove_derived_bundle` | `RemoveDerivedBundleRequest` → `()` |
| `remove_signal` | `RemoveSignalRequest` → `()` |
| `save_session` | `SaveSessionRequest` → `String` |
| `load_session` | `LoadSessionRequest` → `LoadedSession` |
| `reset_session` | ∅ → `LoadedSession` |
| `pick_session_path` | `PickSessionRequest` → `Option<String>` (rfd) |
| `export_estimate` | `ExportEstimateRequest` → `ExportEstimate` |
| `export_write` | `ExportWriteRequest` → `Option<String>` (rfd save dialog inside) |
| `save_export_file` | `SaveExportFileRequest` → `Option<String>` (rfd) |
| `pick_export_directory` | ∅ → `Option<String>` (rfd) |
| `pick_recipe_directory` | ∅ → `Option<String>` (rfd) |
| `effective_recipe_directory` | ∅ → `String` |
| `save_export_file_to_directory` | `SaveExportFileToDirectoryRequest` → `String` |
| `load_preferences` | ∅ → `Option<String>` |
| `save_preferences` | `String` (raw prefs JSON, enveloped) → `()` |

Plus new, unauthenticated: `GET /api/health` → `200 "ok"`.

---

### Task 1: `scope-server` crate skeleton — router, auth, health

**Files:**
- Modify: `Cargo.toml` (workspace members: add `"server/scope-server"`; keep `"shell/src-tauri"` until Task 8)
- Create: `server/scope-server/Cargo.toml`
- Create: `server/scope-server/src/main.rs`
- Create: `server/scope-server/src/auth.rs`
- Test: inline `#[cfg(test)]` in `auth.rs` + `server/scope-server/src/lib.rs` (make it a lib+bin crate so tests can build the router)

**Interfaces:**
- Produces: `scope_server::build_router(ctx: AppContext) -> axum::Router`, `scope_server::AppContext`, CLI flags `--port <u16>` (default 8317), `--frontend-dir <path>`, `--data-dir <path>`, `--no-auth`, `--no-open`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Crate manifest**

`server/scope-server/Cargo.toml`:

```toml
[package]
name = "scope-server"
version = "0.21.1"
edition = "2024"
license = "MIT"
publish = false

[dependencies]
scope-core = { path = "../../core/scope-core" }
scope-protocol = { path = "../../protocol" }
axum = "0.8"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "signal"] }
tower-http = { version = "0.6", features = ["fs", "set-header"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rfd = "0.15"
dirs = "6"
rand = "0.9"
open = "5"
base64 = "0.22"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
http-body-util = "0.1"
```

Run `cargo deny check` via `./scripts/dev.sh cargo deny check` — every crate above is crates.io/MIT-or-Apache; if `deny` flags a transitive license, record it and add the narrowest possible allow in `deny.toml` with a comment.

- [ ] **Step 2: Failing test for auth flow**

In `server/scope-server/src/auth.rs`:

```rust
//! Launch-token auth: GET /?token=<t> sets an HttpOnly cookie and
//! redirects; every non-/api/health route requires the cookie (or
//! `Authorization: Bearer <t>`). `--no-auth` disables the layer.

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::{Request, StatusCode}};
    use tower::ServiceExt;

    fn router() -> axum::Router {
        crate::build_router(crate::AppContext::for_tests(Some("sekret".into())))
    }

    #[tokio::test]
    async fn health_needs_no_auth() {
        let res = router().oneshot(Request::get("/api/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn api_without_cookie_is_unauthorized() {
        let res = router().oneshot(Request::post("/api/list_formats").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn token_query_sets_cookie_and_redirects() {
        let res = router().oneshot(Request::get("/?token=sekret").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::SEE_OTHER);
        let cookie = res.headers().get("set-cookie").unwrap().to_str().unwrap();
        assert!(cookie.starts_with("scope_token=sekret"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
    }

    #[tokio::test]
    async fn bearer_token_passes() {
        let res = router().oneshot(
            Request::post("/api/list_formats")
                .header("authorization", "Bearer sekret")
                .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `./scripts/dev.sh cargo test -p scope-server`
Expected: FAIL to compile (`build_router` / `AppContext` undefined).

- [ ] **Step 4: Implement**

`server/scope-server/src/lib.rs` — the skeleton (state grows in Task 2):

```rust
pub mod auth;

use axum::{routing::{get, post}, Router};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppContext {
    pub token: Option<Arc<str>>,       // None = --no-auth
    pub data_dir: PathBuf,
    pub frontend_dir: Option<PathBuf>,
    // Task 2 adds: pub state: Arc<Mutex<DataState>>, pub gate: Arc<RestoreGate>, pub jobs: Arc<BatchJobs>
}

impl AppContext {
    pub fn for_tests(token: Option<String>) -> Self {
        Self { token: token.map(Into::into), data_dir: std::env::temp_dir().join("scope-server-test"), frontend_dir: None }
    }
}

pub fn build_router(ctx: AppContext) -> Router {
    let api = Router::new()
        .route("/list_formats", post(|| async { "[]" })) // replaced in Task 3
        .layer(axum::middleware::from_fn_with_state(ctx.clone(), auth::require_auth));
    Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .nest("/api", api)
        .merge(auth::page_routes(ctx.clone()))
        .with_state(ctx)
}
```

`auth.rs` implementation: `require_auth` middleware reads the `scope_token` cookie (manual parse of the `cookie` header — no extra crate) or `Authorization: Bearer`; compares against `ctx.token`; `None` token = pass-through. `page_routes` provides `GET /` that, when `?token=` matches, replies `303 See Other` to `/` with `Set-Cookie: scope_token=<t>; HttpOnly; SameSite=Strict; Path=/`, and otherwise falls through to static serving (Task 6) if a cookie is already valid, else `401`.

`src/main.rs`: parse flags by hand from `std::env::args` (repo convention: no clap; `scope-bake.rs` is the precedent), generate a 32-hex-char token with `rand` unless `--no-auth`, build the router, bind `127.0.0.1:<port>` with tokio, print the tokened URL, and unless `--no-open` call `open::that(url)`.

- [ ] **Step 5: Run tests**

Run: `./scripts/dev.sh cargo test -p scope-server`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
./scripts/format.sh
git add Cargo.toml Cargo.lock server/
git commit -m "feat(server): scope-server skeleton with token auth and health"
```

---

### Task 2: Port host state (`DataState`, `RestoreGate`, `BatchJobs`) into `scope-server`

**Files:**
- Create: `server/scope-server/src/host.rs` (state + setup, moved from `shell/src-tauri/src/lib.rs`)
- Modify: `server/scope-server/src/lib.rs` (AppContext gains the three states)
- Test: `server/scope-server/src/host.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `shell/src-tauri/src/lib.rs` lines 1835–1896 (`run()` setup) and its `DataState` definition — copy, do not re-derive.
- Produces: `AppContext { state: Arc<Mutex<DataState>>, gate: Arc<RestoreGate>, jobs: Arc<BatchJobs>, token, data_dir, frontend_dir }` and `AppContext::new(data_dir, token, frontend_dir) -> Self` performing the same setup the Tauri `.setup()` closure performs (`BatchOptions { worker_count, budget, terminal_ttl: Duration::from_secs(300), cache_directory, recipe_directory, provider_registry }`).

- [ ] **Step 1: Copy the state types.** Move `DataState`, `RestoreGate`, the commit sink (`ShellCommitSink` → rename `ServerCommitSink`), and every pure helper function they use from `shell/src-tauri/src/lib.rs` into `host.rs`, unchanged except: `app.path().app_data_dir()` becomes `ctx.data_dir` (resolved in `main.rs` as `dirs::data_dir().unwrap().join("signalscope")`, overridable with `--data-dir`). Do NOT delete the shell copies yet — the shell keeps compiling until Task 8.

- [ ] **Step 2: Write a state test**

```rust
#[tokio::test]
async fn context_setup_creates_dirs_and_empty_store() {
    let dir = std::env::temp_dir().join(format!("scope-host-{}", std::process::id()));
    let ctx = crate::AppContext::new(dir.clone(), None, None);
    let state = ctx.state.lock().unwrap();
    assert!(state.store.signals().is_empty());
    assert!(dir.join("cache").exists());
    let _ = std::fs::remove_dir_all(dir);
}
```

(Adjust the `cache` path assertion to whatever the copied setup actually creates — read the moved code, don't guess.)

- [ ] **Step 3: Run** `./scripts/dev.sh cargo test -p scope-server` — expect PASS.

- [ ] **Step 4: Commit** — `feat(server): host state and batch setup ported from shell`

---

### Task 3: All JSON command endpoints

**Files:**
- Create: `server/scope-server/src/api.rs`
- Modify: `server/scope-server/src/lib.rs` (route table)
- Test: `server/scope-server/src/api.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `AppContext` from Task 2; command bodies from `shell/src-tauri/src/lib.rs`.
- Produces: every non-dialog, non-binary endpoint from the inventory table.

- [ ] **Step 1: Write the handler pattern.** One helper runs state-touching work on the blocking pool (scope-core is synchronous):

```rust
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use scope_protocol::Envelope;

pub(crate) type ApiError = (StatusCode, String);

pub(crate) fn err(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.into())
}

/// Run `f` with the locked DataState on the blocking pool.
pub(crate) async fn with_state<T: Send + 'static>(
    ctx: &AppContext,
    f: impl FnOnce(&mut DataState) -> Result<T, String> + Send + 'static,
) -> Result<T, ApiError> {
    let state = ctx.state.clone();
    tokio::task::spawn_blocking(move || {
        let mut guard = state.lock().map_err(|_| "state poisoned".to_string())?;
        f(&mut guard)
    })
    .await
    .map_err(|e| err(e.to_string()))?
    .map_err(err)
}

// The pattern, shown in full for list_signals:
pub async fn list_signals(State(ctx): State<AppContext>) -> Result<impl IntoResponse, ApiError> {
    let signals = with_state(&ctx, |state| Ok(shell_body_of_list_signals(state))).await?;
    Ok(Json(Envelope::new(signals)))
}

// And for an enveloped request, query_samples:
pub async fn query_samples(
    State(ctx): State<AppContext>,
    Json(request): Json<Envelope<SampleRequest>>,
) -> Result<impl IntoResponse, ApiError> {
    let request = request.open().map_err(|e| err(e.to_string()))?;
    let response = with_state(&ctx, move |state| shell_body_of_query_samples(state, request)).await?;
    Ok(Json(Envelope::new(response)))
}
```

`shell_body_of_*` means: move the body of the corresponding `#[tauri::command]` fn from `shell/src-tauri/src/lib.rs` into `api.rs` (or `host.rs` if shared), with `State<'_, Arc<Mutex<DataState>>>` parameters replaced by the `&mut DataState` the closure receives, and `AppHandle`-derived paths replaced by `ctx.data_dir`. Port **every** endpoint in the inventory table this way except the seven rfd-dialog commands (Task 5) and `query_tiles_bin` (Task 4). `ingest_batch`/`batch_*` commands use `ctx.jobs` and need no `with_state`; mirror the shell's locking exactly. `save_session`/`load_session`/`reset_session` also consult `ctx.gate` exactly as the shell does.

- [ ] **Step 2: Route table** in `build_router` — one `.route("/<name>", post(api::<name>))` per endpoint. No wildcard dispatch; typed handlers only.

- [ ] **Step 3: Endpoint tests** (in `api.rs`): at minimum —

```rust
#[tokio::test]
async fn list_formats_round_trips_envelope() { /* oneshot POST /api/list_formats with bearer,
    parse body as Envelope<Vec<FormatDescriptor>>, assert protocol_version == scope_protocol::PROTOCOL_VERSION
    and the vec is non-empty (builtin registry) */ }

#[tokio::test]
async fn query_samples_rejects_wrong_protocol_version() { /* POST with Envelope{protocol_version: 1, ...},
    expect 400 and the body mentioning version */ }

#[tokio::test]
async fn save_and_load_preferences_round_trip() { /* save "{}", load, expect Some("{}")-ish
    per the shell's cache_root injection behavior — read the ported body first */ }
```

Write them against the real router via `tower::ServiceExt::oneshot` as in Task 1.

- [ ] **Step 4: Run** `./scripts/dev.sh cargo test -p scope-server` — PASS.
- [ ] **Step 5: Commit** — `feat(server): port all JSON commands to POST /api endpoints`

---

### Task 4: Binary tile endpoint

**Files:**
- Modify: `server/scope-server/src/api.rs`
- Test: same file

**Interfaces:**
- Produces: `POST /api/query_tiles_bin` → `200`, `content-type: application/octet-stream`, body = exactly the bytes `scope_protocol::tile_binary::encode_tile_response` produced. **No length prefix, no base64, no JSON wrapper** — `frontend/src/app/tile-binary.ts` builds zero-copy typed-array views over the buffer and its alignment math assumes byte 0 is the magic (`0x4254_5353` LE).

- [ ] **Step 1: Failing test**

```rust
#[tokio::test]
async fn tiles_bin_starts_with_magic() {
    // Build ctx, ingest nothing; query with empty signal_ids should still
    // produce a valid empty response (series_count = 0).
    let res = /* oneshot POST /api/query_tiles_bin with sealed TileRequest{signal_ids: vec![], ...} */;
    assert_eq!(res.headers()["content-type"], "application/octet-stream");
    let body = /* collect bytes */;
    assert_eq!(&body[0..4], &0x4254_5353u32.to_le_bytes());
}
```

- [ ] **Step 2: Implement** — port the shell's `query_tiles_bin` body: open the envelope, `spawn_blocking`, per-id `store.signal` + `pyramids.get` + `pyramid.query_with_target(t0, t1, pixel_width, per_series)` with `per_series = max_total_bins.map(|b| (b / ids.len().max(1)).max(64))`, drop the lock, `tile_wire::binary_series` per series, `encode_tile_response`, respond with `([(header::CONTENT_TYPE, "application/octet-stream")], bytes)`.

- [ ] **Step 3: Run** — PASS. **Step 4: Commit** — `feat(server): binary tile endpoint`

---

### Task 5: Native dialogs via `rfd` + the seven picker endpoints

**Files:**
- Create: `server/scope-server/src/dialogs.rs`
- Modify: `server/scope-server/src/api.rs`, `lib.rs`

**Interfaces:**
- Produces: `pick_sources`, `pick_source_folder`, `pick_session_path`, `pick_export_directory`, `pick_recipe_directory`, `export_write`, `save_export_file` — each calling `rfd::FileDialog` (sync API) inside `spawn_blocking`, mirroring the filters/titles the Tauri shell passes to `tauri_plugin_dialog`. `rfd` with default features uses the XDG desktop portal on Linux — no GTK dependency; the dialog appears on the user's desktop because the server runs there.
- A `DialogProvider` trait with a `Native` impl and a `Scripted` test impl (returns canned paths) so endpoint tests never open real dialogs:

```rust
pub trait DialogProvider: Send + Sync + 'static {
    fn pick_files(&self, title: &str, filters: &[(&str, &[&str])]) -> Option<Vec<PathBuf>>;
    fn pick_folder(&self, title: &str) -> Option<PathBuf>;
    fn save_file(&self, title: &str, file_name: &str, filters: &[(&str, &[&str])]) -> Option<PathBuf>;
}
```

`AppContext` gains `pub dialogs: Arc<dyn DialogProvider>`; `AppContext::for_tests` installs `Scripted`.

- [ ] **Step 1:** Failing test: `pick_sources` with a `Scripted` provider returning two paths → response `Envelope<Vec<String>>` with both paths.
- [ ] **Step 2:** Implement trait + endpoints; port `export_write`'s template lookup replacing `BaseDirectory::Resource` with: `--frontend-dir`'s `snapshot-template.html` when set, else `frontend/dist/snapshot-template.html` relative to the workspace (same dev fallback and same error string `"snapshot template is missing; run ./scripts/build.sh web"`).
- [ ] **Step 3:** Run tests — PASS. **Step 4: Commit** — `feat(server): native file dialogs via rfd`

---

### Task 6: Static frontend serving + launch flow

**Files:**
- Modify: `server/scope-server/src/lib.rs`, `src/auth.rs`, `src/main.rs`
- Test: `lib.rs` `#[cfg(test)]`

**Interfaces:**
- Produces: authenticated static serving of `--frontend-dir` (default: `frontend/dist` if it exists relative to CWD, else exe-adjacent `frontend/`) via `tower_http::services::ServeDir` with `index.html` fallback; launch = print URL + `open::that` unless `--no-open`.

- [ ] **Step 1:** Failing test: with `frontend_dir` pointing at a tempdir containing `index.html` ("hello"), an authenticated `GET /` returns the file; unauthenticated returns 401.
- [ ] **Step 2:** Implement — the auth middleware wraps static routes too; `/api/health` stays outside.
- [ ] **Step 3:** Run tests; then a manual smoke:

```bash
./scripts/build.sh web
./scripts/dev.sh cargo run -p scope-server -- --no-open
# prints http://127.0.0.1:8317/?token=…  → open it in Chromium: app boots (BakedPlane demo until Task 7 lands, which is expected)
```

- [ ] **Step 4: Commit** — `feat(server): serve built frontend with auth and browser launch`

---

### Task 7: Frontend `HttpPlane` + async plane selection

**Files:**
- Modify: `frontend/src/app/data-plane.ts`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/vite.config.ts` (dev proxy)
- Test: `frontend/src/app/data-plane.test.ts`

**Interfaces:**
- Produces: `export class HttpPlane implements DataPlane` (`sourceLabel = "native data plane"` — keep the label; UI copy must not change) and `export async function selectDataPlane(): Promise<DataPlane>`.
- Consumes: `seal`/`open` from `frontend/src/app/envelope.ts`; `decodeTileResponse` from `tile-binary.ts`.

- [ ] **Step 1: Write failing tests** in `data-plane.test.ts` (replace the 14 `TauriPlane` test blocks; keep every `BakedPlane` test untouched). Test via injected fetch:

```ts
function fetchStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return handler as unknown as typeof fetch;
}

it("posts sealed envelopes and opens responses", async () => {
  const plane = new HttpPlane(fetchStub(async (url, init) => {
    expect(url).toBe("/api/list_signals");
    expect(init.method).toBe("POST");
    return new Response(JSON.stringify(seal([])), { status: 200 });
  }));
  expect(await plane.listSignals()).toEqual([]);
});

it("throws the server's error text", async () => {
  const plane = new HttpPlane(fetchStub(async () => new Response("boom", { status: 400 })));
  await expect(plane.listSignals()).rejects.toThrow("boom");
});

it("decodes binary tiles from an ArrayBuffer body", async () => {
  // reuse the existing tile-binary test fixture bytes already used by tile-binary.test.ts
});

it("querySamples maps null back to NaN", async () => {
  // port the existing TauriPlane null->NaN test verbatim, swapping the transport
});
```

- [ ] **Step 2: Run** `./scripts/test.sh unit data-plane` — FAIL (HttpPlane undefined).

- [ ] **Step 3: Implement `HttpPlane`.** Core transport:

```ts
export class HttpPlane implements DataPlane {
  readonly sourceLabel = "native data plane";
  constructor(private readonly fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async post<Req, Res>(command: string, payload?: Req): Promise<Res> {
    const response = await this.fetchFn(`/api/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload === undefined ? null : JSON.stringify(seal(payload)),
    });
    if (!response.ok) throw new Error(await response.text());
    return open<Res>((await response.json()) as Envelope<Res>);
  }

  private async postBinary<Req>(command: string, payload: Req): Promise<ArrayBuffer> {
    const response = await this.fetchFn(`/api/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seal(payload)),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.arrayBuffer();
  }

  async queryTiles(request: TileRequest): Promise<ColumnarTileResponse> {
    return decodeTileResponse(await this.postBinary("query_tiles_bin", request), request.request_id);
  }
  // querySamples: post + the same null->NaN post-processing TauriPlane.querySamples does today (copy it).
  // listSignals/listSources: this.post("list_signals") / this.post("list_sources").
  // ingest/derived/session/restore/preferences/exporter ports: same construction style as
  // TauriPlane's constructor, with each method one this.post(...) call per the endpoint
  // inventory table in this plan's header. IngestPort loses onDragDrop (Task 8 removes it
  // from the interface first if executing out of order — coordinate).
}
```

Selection (replaces the sync `selectDataPlane`):

```ts
export async function selectDataPlane(): Promise<DataPlane> {
  if (document.getElementById("signalscope-baked-data") !== null) {
    return BakedPlane.fromDocument();       // snapshots always win
  }
  try {
    const health = await fetch("/api/health", { signal: AbortSignal.timeout(1500) });
    if (health.ok) return new HttpPlane();
  } catch {
    // no live host — fall through to the demo plane
  }
  return BakedPlane.fromDocument();          // demo manifest fallback (run.sh web, e2e)
}
```

Delete `TauriPlane`, `TauriInternals`, and the `__TAURI_INTERNALS__` global declaration. `main.ts`: `const app = new AppShell(root, await selectDataPlane());`.

`vite.config.ts` gains a dev proxy so `./scripts/run.sh dev` (Task 9) works:

```ts
server: { strictPort: true, proxy: { "/api": "http://127.0.0.1:8317" } },
```

**Wait:** `BakedPlane.fromDocument()` currently falls back to the demo manifest when the element is missing — verify that behavior in the code before relying on it for the no-host branch; if it throws instead, keep the existing behavior by passing an explicit flag.

- [ ] **Step 4: Run** `./scripts/test.sh unit` then `./scripts/test.sh frontend` — PASS (lint will flag the now-dead eslint Tauri bans; that cleanup is Task 8's).
- [ ] **Step 5: Commit** — `feat(frontend): HttpPlane and async plane selection`

---

### Task 8: Remove drag-drop forwarding + delete the Tauri shell

**Files:**
- Modify: `frontend/src/app/data-plane.ts` (remove `IngestPort.onDragDrop`, `DragDropForward` usage)
- Modify: `frontend/src/ui/app-shell.ts` (remove the subscription at `mount()` ~line 575 and the `onDragDrop` handler ~line 1748)
- Modify/Delete: `frontend/src/app/drop.ts` + `drop.test.ts` (delete `classifyDrop`/`expandDropPaths` if `rg -n "classifyDrop|expandDropPaths" frontend/src` shows no remaining callers — the intra-app signal-binding drag is DOM-based and untouched)
- Delete: `shell/` (entire directory)
- Modify: `Cargo.toml` (remove `"shell/src-tauri"` member), `Cargo.lock` (regenerates)
- Modify: `frontend/eslint.config.js` (drop the `__TAURI__`/`isTauri` bans; change the plane-import ban from `TauriPlane` to `HttpPlane` — the rule's intent, "UI/render never import planes", survives)
- Modify: `.gitignore` (drop the two `/shell/src-tauri/gen` lines)
- Modify: `scripts/version.mjs` (remove the `tauri:` manifest entry at line 12, the `tauriText` destructure at ~126, and the pair at ~133; the version set now covers root `package.json`, `frontend/package.json`, and the Cargo manifests it already handles — read the file and keep the rest intact)
- Modify: `scripts/ci-policy.test.sh` (remove the synthetic `shell/src-tauri/tauri.conf.json` fixtures at lines 51 and 73 and any count assertions that included it)
- Modify: `renovate.json` (remove the tauri packageRule)
- Modify: `flake.nix` (remove `cargo-tauri` and the `linuxTauriPackages` list — **keep `chromium`** and the Playwright env exports)

**Interfaces:**
- Consumes: Task 7 (HttpPlane exists, so deleting TauriPlane leaves two planes).
- Produces: a repo with zero Tauri references outside docs history.

- [ ] **Step 1:** Remove `onDragDrop` from the interface and both implementations, delete the app-shell subscription + handler, run `rg -n "onDragDrop|DragDropForward|drag-drop" frontend/src` — expect zero code hits (generated protocol types for DragDrop may remain in `frontend/src/generated/protocol.ts`; leave generated files alone — no protocol bump this phase).
- [ ] **Step 2:** `git rm -r shell` and apply every file edit listed above. Then the sweep:

```bash
rg -n "tauri|src-tauri|TauriPlane|__TAURI" --ignore-case \
  --glob '!docs/**' --glob '!Cargo.lock' --glob '!pnpm-lock.yaml' --glob '!refs/**'
```

Expected: zero hits outside this plan/spec. `Cargo.lock` cleans itself on the next cargo command.

- [ ] **Step 3:** Run `./scripts/test.sh quick` (note: its `--exclude signalscope-shell` breaks the moment the crate is gone — fix `scripts/test.sh`, `scripts/lib.sh` (`rust_checks` `TAURI_CONFIG` export), and `scripts/coverage.sh` (`--exclude signalscope-shell`) in this same task; `test.sh shell` mode becomes `test.sh server` = `cargo test -p scope-server`).
- [ ] **Step 4:** Run `./scripts/ci.sh quality` — shellcheck, ci-policy tests, deny, machete all green.
- [ ] **Step 5: Commit** — `feat!: delete Tauri shell; browser-only host (drag-drop import removed)`

---

### Task 9: Scripts and CI surgery

**Files:**
- Modify: `scripts/run.sh` — modes become: `web` (unchanged: vite only, demo plane), `dev` (new: start `cargo run -p scope-server -- --no-auth --no-open` in the background, then vite with the `/api` proxy; trap EXIT to kill the server), `app` (new default: `./scripts/build.sh web` if `frontend/dist` missing, then `cargo run --release -p scope-server`)
- Modify: `scripts/build.sh` — `native` mode replaced by `app`: `pnpm build` + `cargo build --release -p scope-server` + stage `build/app/` containing the binary and `frontend/dist/` (help text updated); delete `appimage`/`windows` modes
- Delete: `scripts/build-appimage.sh`, `scripts/setup-appimage.sh`, `scripts/build-windows.sh`
- Modify: `scripts/ci.sh` — `build` mode runs `./scripts/build.sh app`; delete `appimage`/`windows` modes and help lines
- Modify: `.github/workflows/ci.yml` — delete the `appimage` and `windows` jobs; `build` job matrix reduces to `ubuntu-latest`; update `tag.needs` to `[version, flake, quality, rust, frontend, e2e, build]`
- Delete: `.github/workflows/windows-dev.yml` (already broken: uploads a nonexistent `desktop/release` path)

**Interfaces:** consumes Task 8's deletions; produces a green `./scripts/ci.sh all`.

- [ ] **Step 1:** Apply the edits. Every workflow shell command must still call a script (AGENTS.md rule).
- [ ] **Step 2:** Run `./scripts/ci.sh all` end to end. Expected: every stage passes. (e2e still runs against vite + BakedPlane demo — unchanged behavior.)
- [ ] **Step 3:** `actionlint` and `zizmor` run inside quality — confirm no workflow lint regressions.
- [ ] **Step 4: Commit** — `chore(ci): replace native bundle jobs with scope-server app build`

---

### Task 10: Live-plane end-to-end proof

**Files:**
- Create: `scripts/server-smoke.sh`
- Create: `frontend/tests/e2e/live-plane.spec.ts`
- Modify: `scripts/test.sh` (append server smoke to the `e2e` mode)

**Interfaces:** consumes Tasks 1–9.

- [ ] **Step 1:** `scripts/server-smoke.sh` — build web if needed, start `cargo run -p scope-server -- --no-auth --no-open --port 43117 --data-dir "$(mktemp -d)"`, poll `/api/health` (max 30 s), then:

```bash
curl -fsS -X POST localhost:43117/api/list_formats | node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    const e=JSON.parse(d);
    if (typeof e.protocol_version !== "number" || !Array.isArray(e.payload) || e.payload.length===0) process.exit(1);
  })'
curl -fsS -X POST -H 'content-type: application/json' \
  -d "{\"protocol_version\":$PROTO,\"payload\":{\"request_id\":\"smoke\",\"signal_ids\":[],\"window\":{\"t0\":0,\"t1\":1},\"pixel_width\":100,\"max_total_bins\":1000}}" \
  localhost:43117/api/query_tiles_bin | head -c 4 | xxd -p   # expect 53535442 (little-endian 0x42545353... verify against protocol/src/tile_binary.rs constant byte order in a comment)
```

Derive `$PROTO` from `protocol/schema/scope-protocol.json` with `node -e`. Kill the server in a trap.

- [ ] **Step 2:** `live-plane.spec.ts` — spawns the server (`--no-auth`, port 8317 to match the vite proxy, tmp `--data-dir`) from `test.beforeAll` via `child_process`, waits for health, then `page.goto("/")` (vite baseURL) and asserts the live plane engaged: the formula-bar toggle is **visible** (it is hidden when `plane.derived === null`, and only `BakedPlane` has null ports — this is the plane-selection signal that requires no new UI). `test.afterAll` kills the server.
- [ ] **Step 3:** Run `./scripts/test.sh e2e` — all specs pass including the new one.
- [ ] **Step 4:** Manual parity checklist (record results in the PR description; ADR 0020–0024 behaviors): open app via `./scripts/run.sh app` → import CSVs via picker → plot pans/zooms → save session (dialog) → reload → session restores → export HTML snapshot → snapshot opens from `file://` and pans → export PNG/CSV → preferences persist across restart.
- [ ] **Step 5: Commit** — `test: live-plane smoke and e2e coverage`

---

### Task 11: ADR, docs, version bump

**Files:**
- Create: `docs/adr/0038-browser-only-host.md`
- Modify: `docs/adr/README.md` (index), `README.md` (repo tree + run instructions), `AGENTS.md` (the 6 Tauri mentions become scope-server equivalents; the "future local HTTP plane" note becomes present tense), `docs/implementation-roadmap.md`
- Modify: version manifests via script

**Interfaces:** consumes everything above.

- [ ] **Step 1:** Write ADR 0038: browser-only host — decision (localhost `scope-server`, dictated Chromium, token auth), premises (internal tool; WebKitGTK dead end; Electron pain), consequences (native window chrome gone; **window drag-drop import removed** — deliberate regression, path-based ingest preserved via rfd dialogs; single-client statefulness documented), supersedes the shell portions of ADR 0020/0021/0032.
- [ ] **Step 2:** Update the docs listed above; `rg -n "tauri" README.md AGENTS.md` → zero hits.
- [ ] **Step 3:** `./scripts/version.sh bump major && ./scripts/version.sh check` (breaking: native shell removed).
- [ ] **Step 4:** Run `./scripts/ci.sh all` one final time — green.
- [ ] **Step 5: Commit** — `docs: ADR 0038 browser-only host; bump version` — then hand off for review with the parity checklist results.
