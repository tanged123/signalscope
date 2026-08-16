# Post-Review Fixes Implementation Plan (Phases 1+2 review findings)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the twelve defects found in the post-delivery review of the browser-host + ChartGPU work (branch `better_charts_reattempt`) so it can merge to `main`.

**Architecture:** No architectural changes. Every task is a localized correction to the code landed in 439334a: one GPU color-mapping bug, five scope-server robustness bugs, three panel render-path bugs, one build-script bug, one MSRV violation, plus committing an already-verified CI-harness fix that sits uncommitted in the worktree.

**Tech Stack:** Rust (axum 0.8, tokio), TypeScript (vite, vitest, Playwright), bash.

## Global Constraints

- Use `./scripts/` wrappers for everything: `./scripts/test.sh server <filter>` (scope-server tests), `./scripts/test.sh unit <filter>` (frontend unit tests), `./scripts/test.sh frontend` (lint+typecheck+unit+snapshot), `./scripts/ci.sh e2e`, `./scripts/ci.sh all`.
- Conventional commits (`fix: …`, `test: …`, `chore: …`). Commit per task.
- Do NOT bump the version: the branch is already at 1.0.0 vs `main`'s 0.21.1, so `version.mjs check-pr` is already satisfied. A bump here would violate the "version bump only as final PR change" rule for no reason.
- Do not touch `frontend/vendor/chartgpu/` (vendored, pinned).
- The frontend has a zero-runtime-dependency policy (`check-runtime-deps`); add no packages.
- `treefmt`/prettier reformats on commit; if a commit's diff looks bigger than your edit, that's formatting — keep it.
- Rust code must compile under the workspace MSRV `rust-version = "1.85"` (Task 12 exists because it currently doesn't).
- WSL2 has no WebGPU: anything needing a real GPU is covered by unit tests + the SwiftShader Playwright suite here; visual confirmation happens on Windows Chrome later.

---

### Task 1: Commit the CI-harness fix already in the worktree

The `ci.sh all` flake was root-caused and fixed during review: both server E2E harnesses folded an unbounded `cargo build` into a fixed 30 s health window with diagnostics suppressed. The fix is **already applied and verified** in the working tree — this task only reviews and commits it. If the worktree is clean (someone committed it already), skip to Task 2.

**Files:**

- Modify (already modified): `scripts/server-smoke.sh`
- Modify (already modified): `frontend/tests/e2e/live-plane.spec.ts`
- Modify (already modified): `frontend/src/node-builtins.d.ts`

**Interfaces:**

- Produces: nothing other tasks consume; standalone gate fix.

- [ ] **Step 1: Confirm the expected diff is present**

Run: `git diff --stat scripts/server-smoke.sh frontend/tests/e2e/live-plane.spec.ts frontend/src/node-builtins.d.ts`
Expected: exactly these three files, roughly `+34/−6`. The content must be:

- `server-smoke.sh`: a `cargo build --release -p scope-server` line inserted before the `cargo run … &` launch; `[ "$ready" -eq 1 ]` replaced by an `if`/`echo …>&2`/`exit 1` block; the final `[ "$magic" = … ]` replaced by an `if`/`echo`/`exit 1` block.
- `live-plane.spec.ts`: `execFileSync` imported; `beforeAll` starts with `test.setTimeout(300_000)` + `execFileSync("cargo", ["build", "-p", "scope-server"], { cwd: repositoryRoot, stdio: "inherit", timeout: 270_000 })`; the spawn's `stdio` is `["ignore", "ignore", "inherit"]`.
- `node-builtins.d.ts`: `child_process` shim gains a `Stdio` union, array `stdio`, and `execFileSync`.

If any of that is missing, apply it from this description — the three bullet points are the complete change.

- [ ] **Step 2: Run the e2e gate**

Run: `./scripts/ci.sh e2e`
Expected: 63 passed; server-smoke prints the compile lines (if any) then the URL; exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/server-smoke.sh frontend/tests/e2e/live-plane.spec.ts frontend/src/node-builtins.d.ts
git commit -m "fix: build scope-server before e2e health windows and surface harness failures"
```

---

### Task 2: GPU palette off-by-one (every time-series line is the wrong color)

`ChartHost` maps hue→color with `hue % palette.series.length`; the rest of the codebase uses `(max(1,trunc(hue))−1) % COLOR_SLOTS` (`COLOR_SLOTS` = 7). Result: every GPU line is one palette slot off from its legend/tree/annotation color, and hue 7 renders as `--series-8` which equals `--series-1`.

**Files:**

- Modify: `frontend/src/render/canvas-renderer.ts:89` (export `hueIndex`)
- Modify: `frontend/src/render/chart-host.ts:107-112`
- Test: `frontend/src/render/chart-host.test.ts`

**Interfaces:**

- Produces: `export function hueIndex(hue: number): number` from `canvas-renderer.ts` — 0-based palette index, `(max(1,trunc(hue))−1) % COLOR_SLOTS`.

- [ ] **Step 1: Write the failing test**

In `chart-host.test.ts`, inside `describe("ChartHost", …)` (the file's `palette.series` is `["#e65050", "#50a0e6"]`):

```ts
it("maps hue to the same palette slot as the Canvas2D renderers", async () => {
  const host = await hostFixture();
  const data = response(["signal-1", "signal-2"]);

  host.render(request(data, [stroke(1), stroke(2)]));

  const series = state.charts.at(-1)?.options.series as Array<{
    color: string;
  }>;
  // hue 1 is the FIRST palette slot (hueIndex(1) === 0), not series[1 % len].
  expect(series[0]?.color).toBe(palette.series[0]);
  expect(series[1]?.color).toBe(palette.series[1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh unit chart-host`
Expected: FAIL — `series[0].color` is `"#50a0e6"` (slot 1) under the buggy `1 % 2` mapping.

- [ ] **Step 3: Implement**

In `canvas-renderer.ts:89`, change `function hueIndex(` to `export function hueIndex(`.

In `chart-host.ts`, add `hueIndex` to the existing import from `./canvas-renderer`, then replace the color computation (currently around line 107):

```ts
const hue = style.hue;
const ghost = hue === null;
const color = ghost
  ? request.palette.fg4
  : (request.palette.series[hueIndex(hue)] ?? request.palette.fg4);
```

(The only change is `hue % request.palette.series.length` → `hueIndex(hue)`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh unit chart-host`
Expected: all chart-host tests PASS (the identity-caching test must still pass — the color change does not affect `sameStyle`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/render/canvas-renderer.ts frontend/src/render/chart-host.ts frontend/src/render/chart-host.test.ts
git commit -m "fix: align ChartGPU hue-to-color mapping with hueIndex"
```

---

### Task 3: Unknown `/api/*` paths return 404, not the SPA with 200

`build_router` merges `page_routes()` whose `.fallback(static_asset)` is inherited by the `/api` nest, so an unmatched `/api/foo` serves `index.html` with 200 and clients get JSON parse errors instead of 404s.

**Files:**

- Modify: `server/scope-server/src/lib.rs:102,143` (api router)
- Test: `server/scope-server/src/api.rs` (tests module at line 875)

**Interfaces:**

- Produces: any request under `/api/` that matches no route → HTTP 404 (401 if unauthenticated, since the auth layer wraps the fallback).

- [ ] **Step 1: Write the failing test**

In `api.rs`'s `mod tests` (these tests use `AppContext::for_tests(None)` — no auth token needed; follow the existing `oneshot` pattern at line 885):

```rust
#[tokio::test]
async fn unknown_api_path_is_404() {
    let router = crate::build_router(crate::AppContext::for_tests(None));
    let response = router
        .oneshot(
            axum::http::Request::post("/api/no_such_endpoint")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh server unknown_api_path`
Expected: FAIL — status is 200 OK (the SPA index.html).

- [ ] **Step 3: Implement**

In `lib.rs`, on the `api` router, insert a fallback immediately before the `.layer(...)` call (line 143):

```rust
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
        .layer(axum::middleware::from_fn_with_state(
            ctx.clone(),
            auth::require_auth,
        ));
```

The fallback sits inside the auth layer on purpose: unauthenticated probes of unknown API paths still get 401, authenticated clients get 404.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh server`
Expected: all scope-server tests PASS (the existing auth tests confirm 401 behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/scope-server/src/lib.rs server/scope-server/src/api.rs
git commit -m "fix: 404 unmatched /api paths instead of serving the SPA"
```

---

### Task 4: Correct MIME types for static assets; drop dead `query_token` parameter

`frontend_response` maps only css/js/json/svg and falls back to `text/html`, so the six shipped `.woff2` fonts are served as HTML (and any future `.wasm` would break streaming instantiation). Separately, `authorized()` has a `query_token` parameter that is `None` at all three call sites.

**Files:**

- Modify: `server/scope-server/src/auth.rs:98-104` (MIME map), `auth.rs:108-115,21,52,64` (signature)
- Test: `server/scope-server/src/auth.rs` tests module

**Interfaces:**

- Produces: `fn authorized(ctx: &AppContext, headers: &HeaderMap) -> bool` (two-argument form; Task 4 updates all callers, which live only in this file).

- [ ] **Step 1: Write the failing test**

In `auth.rs`'s `mod tests`, following the temp-dir pattern of `authenticated_root_serves_frontend_and_unauthenticated_is_rejected` (line 199):

```rust
#[tokio::test]
async fn static_assets_get_correct_content_types() {
    let dir = std::env::temp_dir().join(format!("scope-mime-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("fonts")).unwrap();
    std::fs::write(dir.join("fonts/mono.woff2"), b"font-bytes").unwrap();
    let mut context = crate::AppContext::for_tests(None);
    context.frontend_dir = Some(dir.clone());

    let response = crate::build_router(context)
        .oneshot(
            Request::get("/fonts/mono.woff2")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "font/woff2"
    );
    let _ = std::fs::remove_dir_all(dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh server static_assets_get_correct`
Expected: FAIL — content-type is `text/html; charset=utf-8`.

- [ ] **Step 3: Implement**

Replace the match in `frontend_response` (auth.rs:98-104):

```rust
    let content_type = match request_path.rsplit('.').next() {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        _ => "text/html; charset=utf-8",
    };
```

Then remove the dead parameter: change the signature at line 108 to
`fn authorized(ctx: &AppContext, headers: &HeaderMap) -> bool`, delete the
`query_token == Some(expected) ||` arm from its body, and drop the trailing
`, None` from the three call sites (lines 21, 52, 64).

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh server`
Expected: PASS, including all pre-existing auth tests.

- [ ] **Step 5: Commit**

```bash
git add server/scope-server/src/auth.rs
git commit -m "fix: serve fonts and binary assets with correct MIME types"
```

---

### Task 5: Recipe save must survive a stale temporary file

`write_recipe_file` uses a process-global counter for its temp-file suffix and `create_new(true)`. After a crash between create and rename, the counter resets on restart and the leftover `<name>.toml.0.tmp` makes every later save of that recipe fail with `File exists`. The deleted Tauri shell retried the next suffix; restore that, as a bounded loop.

**Files:**

- Modify: `server/scope-server/src/host.rs:423-446`
- Test: `server/scope-server/src/host.rs` (tests module at line 875)

**Interfaces:**

- Consumes/produces: `pub(crate) fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String>` — signature unchanged.

- [ ] **Step 1: Write the failing test**

In `host.rs`'s `mod tests`:

```rust
#[test]
fn recipe_write_walks_past_stale_temp_files() {
    let dir = std::env::temp_dir().join(format!("scope-recipe-retry-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let destination = dir.join("data.csv.scope.toml");
    // Simulate temp files leaked by a previous process life (the suffix
    // counter restarts at 0). Plant a generous range so the test is
    // independent of how many recipes earlier tests in this process wrote.
    for suffix in 0..32u64 {
        std::fs::write(
            dir.join(format!("data.csv.scope.toml.{suffix}.tmp")),
            "stale",
        )
        .unwrap();
    }
    write_recipe_file(&destination, "recipe = true").unwrap();
    assert_eq!(
        std::fs::read_to_string(&destination).unwrap(),
        "recipe = true"
    );
    let _ = std::fs::remove_dir_all(dir);
}
```

(If the tests module lacks a `use super::*;`, refer to the function as `super::write_recipe_file`; match whichever style the module already uses.)

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh server recipe_write_walks`
Expected: FAIL — `write_recipe_file` returns `Err("File exists (os error 17)")` (unless >32 recipes were written earlier in-process; the planted range covers the module's real test count with margin).

- [ ] **Step 3: Implement**

Replace `write_recipe_file` (host.rs:423-446) with a retry loop. `AlreadyExists` means a stale temp from a previous process life — take the next suffix. Everything else is a real error. `create_new` still never follows a pre-planted symlink.

```rust
pub(crate) fn write_recipe_file(destination: &Path, contents: &str) -> Result<(), String> {
    static NEXT_RECIPE_ID: AtomicU64 = AtomicU64::new(0);
    for _ in 0..1000 {
        let suffix = NEXT_RECIPE_ID.fetch_add(1, Ordering::Relaxed);
        let temporary = destination.with_extension(format!("toml.{suffix}.tmp"));
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        };
        let result = file
            .write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string());
        drop(file);
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        if let Err(error) = std::fs::rename(&temporary, destination) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        return Ok(());
    }
    Err("could not create a temporary recipe file after 1000 attempts".into())
}
```

(`AtomicU64`, `Ordering`, and `std::io::Write` are already imported in this file; `std::io::ErrorKind` is referenced by full path above so no new import is needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/scope-server/src/host.rs
git commit -m "fix: retry past stale temp files when saving recipes"
```

---

### Task 6: Snapshot export must not truncate the previous export on failure

`write_export_file` is a bare `std::fs::write`, which truncates the destination before writing — a failed re-export destroys the previous good snapshot. Restore the shell's staged-write-then-rename.

**Files:**

- Modify: `server/scope-server/src/api.rs:234-236`
- Test: `server/scope-server/src/api.rs` tests module

**Interfaces:**

- Consumes/produces: `fn write_export_file(path: &Path, contents: &str) -> Result<(), std::io::Error>` — signature unchanged.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn export_write_replaces_via_rename_not_truncation() {
    let dir = std::env::temp_dir().join(format!("scope-export-stage-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("report.html");
    std::fs::write(&path, "old export").unwrap();
    // A read-only destination rejects in-place truncation (`fs::write` opens
    // the file for writing) but allows rename-over, because only the
    // directory needs to be writable. That is exactly the staged contract.
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();

    super::write_export_file(&path, "new export").unwrap();

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new export");
    // Staging must clean up: nothing but report.html remains.
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["report.html".to_string()]);
    let _ = std::fs::remove_dir_all(dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh server export_write_replaces`
Expected: FAIL — the current bare `std::fs::write` gets `PermissionDenied` opening the read-only file, so `write_export_file` returns `Err` and the `unwrap` panics. (The staged implementation writes a sibling temp and renames over the read-only file, which succeeds.)

- [ ] **Step 3: Implement**

Replace `write_export_file` (api.rs:234-236) with the shell's staged version (this is a direct port of the deleted `shell/src-tauri/src/lib.rs:1522`):

```rust
fn write_export_file(path: &Path, contents: &str) -> Result<(), std::io::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("export"))
        .to_string_lossy();
    let staged = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(error) = std::fs::write(&staged, contents) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staged, path) {
        let _ = std::fs::remove_file(&staged);
        return Err(error);
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh server`
Expected: PASS, including the existing `export_write` template-fallback test.

- [ ] **Step 5: Commit**

```bash
git add server/scope-server/src/api.rs
git commit -m "fix: stage snapshot export writes so failures keep the old file"
```

---

### Task 7: An abandoned restore must not block autosave forever

`restore_sources` calls `gate.begin()`; only `restore_reconcile` settles it. If the tab closes mid-restore, the counter stays ≥1 for the life of the server process and every autosave returns 400 "restore in progress". The Tauri process died with its window so this never mattered; the browser host outlives the page. Fix: a new restore (and a session reset) supersedes any abandoned one — clear the gate first. The server is single-client by design (ADR 0038), so overlapping restores are already out of contract (`restore_sources` unconditionally `replace_sources` + `state.reset()`).

**Files:**

- Modify: `server/scope-server/src/host.rs:67-85` (add `clear`), `server/scope-server/src/api.rs:392` (restore_sources), `api.rs:694-706` (reset_session)
- Test: `server/scope-server/src/host.rs` tests module

**Interfaces:**

- Produces: `pub(crate) fn clear(&self)` on `RestoreGate` — resets the pending count to zero.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn restore_gate_clear_unblocks_autosave_after_abandoned_restore() {
    let gate = RestoreGate::default();
    gate.begin(); // restore started, tab closed, reconcile never arrives
    assert!(gate.save_allowed(true).is_err());
    gate.clear(); // next restore_sources / reset_session supersedes it
    assert!(gate.save_allowed(true).is_ok());
    gate.begin(); // and the new restore still gates autosave
    assert!(gate.save_allowed(true).is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh server restore_gate_clear`
Expected: FAIL to compile — `clear` does not exist.

- [ ] **Step 3: Implement**

Add to `impl RestoreGate` (host.rs, after `settle`):

```rust
    pub(crate) fn clear(&self) {
        self.0.store(0, Ordering::Release);
    }
```

In `api.rs` `restore_sources`, replace line 392:

```rust
    // A new restore supersedes any abandoned one (tab closed before
    // reconcile); otherwise the stale count blocks autosave forever.
    ctx.gate.clear();
    ctx.gate.begin();
```

In `api.rs` `reset_session` (line 694), add the same clear after the state reset (the `.reset();` call around line 701):

```rust
    ctx.gate.clear();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/scope-server/src/host.rs server/scope-server/src/api.rs
git commit -m "fix: clear the restore gate when a new restore or reset supersedes an abandoned one"
```

---

### Task 8: Surface ChartGPU initialization failure instead of a silent blank panel

`initializeChartHost`'s `.catch(() => { hidden = true })` swallows the error, and the next `renderForMode` un-hides the element again — permanently blank time panel with no diagnostic. Fix: on failure, drop back to the `gpu === null` path, which already renders the "WebGPU unavailable" empty state.

**Files:**

- Modify: `frontend/src/ui/panel.ts:685-704` (`initializeChartHost`)

**Interfaces:**

- Consumes: the existing `gpu === null` handling — `update()` line 990 shows "WebGPU unavailable — time-series rendering disabled" and `renderForMode` line 1065 keeps the host hidden.

There is no `PanelView` unit-test harness (panel.test.ts covers exported pure helpers only), and the failure needs a rejecting `ChartGPU.create`, which the e2e SwiftShader run can't produce on demand — so this task is verified by typecheck + the full suite + the logic reusing an already-rendered path.

- [ ] **Step 1: Implement**

Replace the `.catch` in `initializeChartHost` (panel.ts:700-703):

```ts
      .catch((error: unknown) => {
        console.error("ChartGPU initialization failed", error);
        // Fall back to the no-GPU path: renderForMode keeps the host hidden
        // and update() shows the "WebGPU unavailable" empty state.
        this.gpu = null;
        this.chartHostElement.hidden = true;
        if (this.lastInputState !== null) {
          this.lastStateKey = null;
          this.update(
            this.lastInputState,
            this.element.classList.contains("maximized"),
          );
        }
        return null;
      });
```

Note: `setGpu` (line 672) early-returns when `this.gpu !== null`, so after this fallback a later `setGpu` call would retry `initializeChartHost` — that is the desired recovery path; do not change `setGpu`.

- [ ] **Step 2: Verify**

Run: `./scripts/test.sh frontend`
Expected: PASS (typecheck is the main gate here; no behavior covered by unit tests changes).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/ui/panel.ts
git commit -m "fix: fall back to the no-GPU empty state when ChartGPU.create fails"
```

---

### Task 9: Emptying a time panel must stop rendering the removed lines

`renderForMode` sets `chartHostElement.hidden = false` before the `series.length === 0` early return, so ChartGPU keeps compositing the deleted signal under the transparent "Empty panel" message.

**Files:**

- Modify: `frontend/src/ui/panel.ts:1069-1070`

**Interfaces:** none new.

- [ ] **Step 1: Implement**

Replace lines 1069-1070 of `renderForMode`:

```ts
if (state.series.length === 0) {
  this.chartHostElement.hidden = true;
  return 0;
}
this.chartHostElement.hidden = false;
if (tiles === null) return 0;
```

(`tiles === null` keeps the host visible on purpose: that is a transient refresh state where the previous frame is still the right thing to show.)

- [ ] **Step 2: Verify**

Run: `./scripts/test.sh frontend && ./scripts/ci.sh e2e`
Expected: PASS. The e2e workbench suite exercises add/remove-signal flows over the chart host.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/ui/panel.ts
git commit -m "fix: hide the chart host when a time panel has no series"
```

---

### Task 10: Time panels always have gutter axes — hit-test and toggle must agree

ChartGPU always draws gutter axes with fixed `CHART_GRID` margins, but `axisEditZone` is still fed `state.axis_style`: with `inline` style, double-clicking the visible left gutter no longer opens the Y-range editor and a 90×18 zone inside the plot does, and the still-visible `axes:` toggle changes nothing. Fix: time mode hit-tests as `gutter` regardless of stored style, and the toggle hides in time mode (it still works for xy/fft/histogram, which remain Canvas2D).

**Files:**

- Modify: `frontend/src/ui/panel.ts:649-661` (axisEditZone callback), `panel.ts:958-963` (toggle), export helper near `colorIndexForHue` (line 97)
- Test: `frontend/src/ui/panel.test.ts`

**Interfaces:**

- Produces: `export function effectiveAxisStyle(mode: RenderPanelState["mode"], style: AxisStyle): AxisStyle` from `panel.ts`.

- [ ] **Step 1: Write the failing test**

In `panel.test.ts` (add `effectiveAxisStyle` to the existing import list from `./panel`):

```ts
describe("effectiveAxisStyle", () => {
  it("forces gutter for time mode where ChartGPU always draws gutter axes", () => {
    expect(effectiveAxisStyle("time", "inline")).toBe("gutter");
    expect(effectiveAxisStyle("time", "gutter")).toBe("gutter");
  });

  it("passes the stored style through for Canvas2D modes", () => {
    expect(effectiveAxisStyle("xy", "inline")).toBe("inline");
    expect(effectiveAxisStyle("fft", "gutter")).toBe("gutter");
    expect(effectiveAxisStyle("histogram", "inline")).toBe("inline");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/test.sh unit panel`
Expected: FAIL — `effectiveAxisStyle` is not exported.

- [ ] **Step 3: Implement**

Add next to `colorIndexForHue` (panel.ts:97), importing `AxisStyle` from the generated session types if it is not already imported in this file:

```ts
export function effectiveAxisStyle(
  mode: RenderPanelState["mode"],
  style: AxisStyle,
): AxisStyle {
  return mode === "time" ? "gutter" : style;
}
```

Use it in the `axisEditZone` callback (line 654-660):

```ts
          : axisEditZone(
              layout,
              effectiveAxisStyle(state.mode, state.axis_style),
              x,
              y,
              state.mode === "xy" && this.hasColorbar,
            );
```

Hide the toggle for time panels in `update()` (after line 963, mirroring the `aspectToggle.hidden` pattern at 968):

```ts
axisToggle.hidden = rendered.mode === "time";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh unit panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ui/panel.ts frontend/src/ui/panel.test.ts
git commit -m "fix: hit-test time-panel axes as gutter and hide the dead axis toggle"
```

---

### Task 11: `build.sh app` must produce a clean frontend copy on rebuild

`cp -R frontend/dist build/app/frontend` copies _into_ the directory when it already exists — the second run nests `frontend/dist/` inside and stale hashed assets ship in the tarball.

**Files:**

- Modify: `scripts/build.sh:25-27`

- [ ] **Step 1: Implement**

```bash
  mkdir -p build/app
  cp target/release/scope-server build/app/scope-server
  rm -rf build/app/frontend
  cp -R frontend/dist build/app/frontend
```

(The only change is the `rm -rf` line before the `cp -R`.)

- [ ] **Step 2: Verify — run the build twice**

Run: `./scripts/build.sh app && ./scripts/build.sh app && test ! -e build/app/frontend/dist && echo CLEAN`
Expected: prints `CLEAN`. Also run `shellcheck scripts/build.sh scripts/lib.sh` — no new findings.

- [ ] **Step 3: Commit**

```bash
git add scripts/build.sh
git commit -m "fix: replace the staged frontend copy instead of nesting into it"
```

---

### Task 12: MSRV — replace `Duration::from_mins`

`server/scope-server/src/lib.rs:74` uses `std::time::Duration::from_mins(5)`, which needs a newer rustc than the workspace's declared `rust-version = "1.85"`. It only builds because local toolchains are newer.

**Files:**

- Modify: `server/scope-server/src/lib.rs:74`

- [ ] **Step 1: Implement**

```rust
            terminal_ttl: std::time::Duration::from_secs(5 * 60),
```

- [ ] **Step 2: Verify**

Run: `grep -rn "from_mins" server/ core/ && echo FOUND || echo NONE` — expect `NONE`; then `./scripts/test.sh server` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add server/scope-server/src/lib.rs
git commit -m "fix: keep scope-server buildable at the declared MSRV"
```

---

### Task 13: Full gate + ledger

- [ ] **Step 1: Run the complete local gate**

Run: `./scripts/ci.sh all`
Expected: exit 0 end-to-end (format, quality, rust, frontend, artifacts, 63 e2e, server-smoke). This is the same gate that flaked before Task 1; it must now pass from any cache state.

- [ ] **Step 2: Record completion in the SDD ledger**

Append to `.superpowers/sdd/2026-08-12-chartgpu-phase-1-browser-shell/progress.md`: one line per task number with its commit hash, plus the `ci.sh all` result.

- [ ] **Step 3: Commit**

```bash
git add .superpowers/sdd/2026-08-12-chartgpu-phase-1-browser-shell/progress.md
git commit -m "docs: record post-review fix completion in the SDD ledger"
```

---

## Explicitly out of scope

- **Drag-and-drop**: deliberately removed per spec Amendment 5; not a defect.
- **Dashed time-series strokes**: accepted regression per ADR 0039.
- **Wheel-zoom-changes-tick-labels e2e case** (Phase 2 plan Task 8 Step 2d gap): needs pixel-reading under SwiftShader; deferred to the Windows-Chrome manual verification checklist rather than papered over with a weak assertion.
- **Version bump**: branch is already 1.0.0 vs main's 0.21.1.
