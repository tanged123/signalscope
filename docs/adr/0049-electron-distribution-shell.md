# ADR 0049: Electron distribution shell

- Status: Accepted
- Date: 2026-08-31
- Amends: ADR 0038

## Context

ADR 0038 correctly unified live operation on `scope-server` and `HttpPlane`,
but made the lack of native application lifecycle and platform installers a
product policy. Requiring a separately installed compatible Chromium makes
formal distribution unreliable, while Linux WebKitGTK remains unsuitable for
the WebGPU renderer.

## Decision

SignalScope packages Electron 43.2.0 as a presentation and lifecycle wrapper
around `scope-server`. Electron starts the server on an ephemeral loopback
port, loads its authenticated URL, enforces one application instance, reports
startup and renderer failures, and closes the server through stdin before
exit. The renderer remains sandboxed with no Node.js access.

Electron has no data, filesystem, dialog, or ingest IPC API. Native operations
remain authenticated `scope-server` routes, the frontend always uses
`HttpPlane`, and snapshots remain `BakedPlane`. UI and renderer code must not
detect Electron or branch on host identity.

Official releases require Windows x64 NSIS, macOS arm64 DMG, and Linux x64
AppImage packages. The Linux server tarball remains an additional artifact.
Packaging starts from a fresh stage containing only the current
`scope-server` binary and frontend build. The release gate rejects missing,
stale, nested, or symlinked artifacts and generates SHA-256 checksums before
tagging.

Linux `scope-server` artifacts target the Ubuntu 22.04 glibc 2.35 baseline.
HDF5 and zlib are linked statically, while the optional Wayland client is
loaded at runtime. The package gate rejects newer glibc symbols and native
dependencies outside the baseline runtime.

Windows certificate secrets retain the existing convention. macOS Developer
ID and notarization credentials are all-or-nothing. Unsigned packages are
permitted during the initial restoration; production operators can set
`SIGNALSCOPE_REQUIRE_SIGNING=1` to require configured signing.

## Consequences

Users receive one pinned Chromium runtime and normal application lifecycle on
each supported operating system. Installer size increases, but no second data
plane or native frontend API is introduced. ADR 0038 remains authoritative for
the loopback server, authentication, `HttpPlane`, and snapshot architecture;
only its no-installer consequence is superseded.
