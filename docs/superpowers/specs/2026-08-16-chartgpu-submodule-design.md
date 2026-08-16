# ChartGPU submodule design

## Goal

Replace the committed ChartGPU source copy with a pinned Git submodule without
changing the renderer, build output, or import paths. A normal repository setup
and every CI job that needs ChartGPU must initialize the submodule automatically.

## Repository layout

ChartGPU remains at `frontend/vendor/chartgpu`. `.gitmodules` records the public
HTTPS upstream URL, and the parent repository's gitlink records the exact
ChartGPU revision. The current
`671e1c157a6fd9a80df35d5b43795314214569d0` revision remains pinned during the
migration.

The submodule replaces the copied `src`, `LICENSE`, `package.json`, and
`VENDORED_REV.txt`. The gitlink becomes the single source of truth for the pin.
Existing Vite and Vitest aliases continue to resolve
`@chartgpu/chartgpu` from `frontend/vendor/chartgpu/src/index.ts`.

## Setup and updates

A focused repository script initializes and synchronizes the ChartGPU submodule.
It fails clearly if the checked-out commit does not match the parent repository's
gitlink. `scripts/setup.sh` calls it before installing frontend dependencies.

The same script supports intentional updates: fetch the requested upstream
revision, check it out detached in the submodule, and leave the resulting gitlink
change for review and commit in the parent repository. There is no separate
revision file to synchronize.

The shared GitHub setup action runs submodule setup independently of its
`install-frontend` option. Jobs that use the shared action therefore receive the
source before invoking Nix, frontend, Rust, benchmark, coverage, build, or demo
commands. Jobs that only inspect versions, aggregate results, tag an already
validated commit, or publish existing artifacts do not need the submodule.

## Validation and failures

Script tests cover an uninitialized submodule, a successful initialization at
the recorded gitlink, and a mismatched checkout. Errors identify the path and the
recovery command. Existing frontend and artifact checks prove that TypeScript and
WGSL still bundle into the self-contained snapshot.

Formatting, lint, and spelling exclusions continue to treat
`frontend/vendor/chartgpu` as upstream-owned source. The repository does not
modify files inside the submodule.

## Documentation and delivery

ADR 0039 and the original ChartGPU renderer design receive dated amendments that
record the delivery change without rewriting the historical vendoring decision.
The README describes ChartGPU as a pinned submodule. The completed change ends
with the required patch version bump.
