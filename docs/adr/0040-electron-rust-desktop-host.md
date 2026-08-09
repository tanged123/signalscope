# ADR 0040: Electron desktop host and authenticated Rust data plane

- Status: Accepted
- Date: 2026-08-09
- Supersedes: host-specific portions of ADRs 0001, 0002, 0004, 0007, 0032,
  0035, 0036, and 0039

## Context

SignalScope needs one pinned Chromium desktop host on Linux, macOS, and
Windows so the WebGPU renderer has the same browser engine everywhere. Rust
must continue to own native data and filesystem operations while the frontend
also remains usable in an offline HTML snapshot.

## Decision

Electron 43.2.0 is the desktop presentation host. Its renderer is sandboxed,
has no Node.js access, and communicates with a thin Electron main process
through a narrow preload bridge. Electron launches one `signalscope-host`
child process and owns only lifecycle, windows, dialogs, drag/drop path
recovery, and GPU diagnostics.

The shell-independent `scope-host` library owns application state and typed
operations over `scope-core` and `scope-protocol`. `scope-server` exposes
those operations over authenticated loopback HTTP. It binds only to
`127.0.0.1:0`, authenticates every operation with a bearer token, preserves
the versioned JSON envelopes and binary tile framing, and keeps transport
errors separate from scientific protocol errors.

The completed architecture has no dual-shell compatibility state. During
extraction, Tauri was a temporary caller; it is retired after Electron parity
and packaging gates pass. The renderer selects between
`NativePlane` and `BakedPlane` by capability presence, never by host identity.

## Consequences

Native data behavior is testable without a GUI or transport and can be reused
by Electron without moving scientific logic into JavaScript. Loopback
authentication and strict origin checks add startup and request plumbing, but
keep the local HTTP boundary private. Existing host-specific Tauri decisions
are retired by this record; data, protocol, snapshot, and renderer decisions
from those ADRs remain in force until separately superseded.
