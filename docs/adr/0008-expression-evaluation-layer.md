# ADR 0008: Expressions evaluate in the native compute layer

- Status: Accepted
- Date: 2026-07-24

## Context

Derived-signal expressions could evaluate as sandboxed JavaScript in the
presentation plane or in the native compute module behind the protocol. A
Phase 0 frontend stub parsed `deriv`/`integ`/`smooth`/`$` references and
gate-checked strings with an eval blocklist, while `scope-core::compute`
already implements the same transforms in Rust — seeding both answers.

## Decision

Expression evaluation is a protocol request served by `scope-core`'s compute
module (ADR 0001: the native plane owns compute). The frontend may parse
references for editor affordances but never evaluates. Snapshots bake derived
results like any other signal. The dormant frontend stub — and its blocklist
"sandbox", which pre-committed to in-browser eval — was removed rather than
left as false assurance.

## Consequences

One authoritative implementation of derived-signal semantics. The derived
formula bar remains part of the UI contract and stays inert until the protocol
request exists. No JavaScript evaluation of user expressions runs in the
webview.
