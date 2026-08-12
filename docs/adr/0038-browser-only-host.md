# ADR 0038: Browser-only host

- Status: Accepted
- Date: 2026-08-12

## Context

SignalScope's Tauri shell duplicated the browser presentation host, coupled
the release path to platform-specific webview packaging, and made the
portable snapshot and workbench diverge at their host boundary. The product
is an internal desktop workbench, so a loopback server and a dictated
Chromium provide the required native file access without carrying a second
frontend host. WebKitGTK support is not a viable target and Electron would
add a larger runtime without improving the data boundary.

## Decision

The native host is `scope-server`, a loopback-only Rust HTTP server on port 8317. It serves the built frontend and exposes the existing versioned
protocol as authenticated `POST /api/<command>` endpoints. Launch tokens are
exchanged for an HttpOnly, SameSite cookie; `--no-auth` is available for
controlled local development. Native dialogs remain in the server process
through `rfd`.

The frontend selects `BakedPlane` for a non-empty snapshot slot, `HttpPlane`
when `/api/health` is live, and the built-in demo `BakedPlane` otherwise. The
presentation plane does not branch on host identity. The server is
single-client and stateful, matching the former desktop process model.

Window-level drag-and-drop import is removed deliberately. Path-based ingest
through the native picker remains supported, and panel/workspace drag
operations remain frontend behavior.

This supersedes the shell-host portions of ADR 0020, ADR 0021, and ADR 0032;
their visual chrome, desktop input, and data invariants remain in force where
they do not depend on Tauri event forwarding.

## Consequences

The release artifact is a `scope-server` binary plus the shared frontend
directory, and `./scripts/run.sh app` is the supported packaged launch path.
There is no native window chrome or platform installer matrix. Browser
automation and the portable snapshot use the same TypeScript presentation
plane; a viewer without WebGPU can still open the shell, but time-series
panels are disabled by the renderer decision in ADR 0039.
