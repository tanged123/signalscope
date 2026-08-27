# ADR 0040: ChartGPU submodule delivery

- Status: Accepted
- Date: 2026-08-16

## Context

ADR 0039 pinned ChartGPU by committing a copied subset of its source under
`frontend/vendor/chartgpu`. That made ordinary clones self-contained but added
about 68,000 upstream lines to the SignalScope tree and made revision changes
appear as repository source diffs.

## Decision

Keep ChartGPU at `frontend/vendor/chartgpu`, but represent it as a Git submodule
of `https://github.com/ChartGPU/ChartGPU.git`. The parent repository's gitlink is
the only revision pin. SignalScope continues to import ChartGPU's TypeScript and
WGSL source through the existing Vite and Vitest aliases.

`./scripts/chartgpu-submodule.sh` owns initialization, validation, and updates.
`./scripts/setup.sh` and the shared GitHub setup action initialize the submodule
before commands that need its source.

## Consequences

A normal development setup and relevant CI jobs require network access the first
time the submodule is initialized. A raw clone that bypasses `./scripts/setup.sh`
does not contain ChartGPU source. In return, upstream source no longer inflates
ordinary SignalScope diffs, and a ChartGPU update is a reviewable gitlink change.

This supersedes only the source-delivery portion of ADR 0039. Its renderer scope,
revision choice, data flow, capture behavior, and fork triggers remain accepted.
