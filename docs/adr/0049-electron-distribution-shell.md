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

Demo publication follows successful tagged releases. Its deployment job uses
the authenticated GitHub artifact API with `actions: read` to retrieve the
current run's demo before publishing Pages. Package failures prevent both a
new release and a demo deployment, leaving the previous demo available.

Linux `scope-server` artifacts target the Ubuntu 22.04 glibc 2.35 baseline.
HDF5 and zlib are linked statically, while the optional Wayland client is
loaded at runtime. The package gate rejects newer glibc symbols and native
dependencies outside the baseline runtime.

macOS packaging prepares the staged server before Electron signing: the pinned
Nix Apple libiconv 115.100.1 reference is replaced with
`/usr/lib/libiconv.2.dylib`, Nix runtime search paths are removed, and the modified
binary receives a fresh ad-hoc signature. Other non-system dependencies fail
packaging rather than being guessed or bundled. `scripts/macos-server.sh` owns
this check and runs again on the packaged server before its smoke test. The
stage is disposable and recreated for each package; Cargo outputs are untouched.
This fixes [issue 34](https://github.com/tanged123/signalscope/issues/34) without
changing application APIs or adding user-installed runtime dependencies.
Shell regression tests cover remapping, rejection, and signing order; the macOS
build job also exercises a real Mach-O binary using iconv. Revisit the explicit
mapping when the pinned Nix libiconv changes.

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

## 2026-09-07 amendment: integrated window chrome

The desktop window hides its native title text and removes the Windows/Linux
menu bar. Native window controls overlay SignalScope's existing title row;
the single application-menu button remains the command entry point. No new
toolbar actions are added. macOS retains its system-level application menu.

`desktop/src/window.ts` owns window buttons, their initial colors, and one
WebContents-scoped `titlebar-theme` listener. The sandboxed preload observes
the document's theme/style attributes and sends the existing surface/foreground
tokens after DOM readiness and theme changes. The listener accepts only hex
colors from the window's own main frame and loopback origin. It has no data or
window-action commands, and nothing is exposed in the page's JavaScript world.
The observer disconnects on final page teardown; WebContents owns IPC cleanup.

Shared CSS uses the Window Controls Overlay safe-area variables to reserve
space on either side, marks the title row draggable, and excludes the menu,
buttons and title editor from dragging. Browsers and snapshots use the normal
30px row through CSS fallbacks, without host detection or schema changes.

Desktop tests cover menu removal, sandbox/preload options, theme publication
and validation. Browser tests retain keyboard/menu/title editing coverage; the
packaged Electron test checks safe-area layout, theme updates and
minimize/maximize/restore behavior. Windows snapping and macOS traffic lights
remain owned by Electron and the OS.
