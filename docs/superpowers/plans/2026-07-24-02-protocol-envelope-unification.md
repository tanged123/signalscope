# Protocol Envelope Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `scope_protocol::EnvelopeBin` the single envelope-bin definition (deleting the pyramid's duplicate struct and the shell's field-by-field copy), and validate `protocol_version` at exactly one choke point via a transport `Envelope<T>` instead of per-payload fields checked ad hoc.

**Architecture:** The pyramid consumes the protocol tile type directly (ADR 0002 sanctions this: "Compute consumes signal views or protocol tiles"). Every Tauri command accepts/returns `Envelope<T>`; `Envelope::open()` (Rust) and `open()` (TS) are the only two version checks in the codebase — mirroring the envelope pattern `scope-core::session` already uses. The message types themselves lose their `protocol_version` fields.

**Tech Stack:** Rust 2021, serde, Tauri 2 IPC, TypeScript 5.9, hand-rolled schema codegen at `protocol/scripts/generate-types.mjs`.

## Global Constraints

- **Depends on Plan 01** (`2026-07-24-01-core-workspace-consolidation.md`): the pyramid lives at `core/scope-core/src/pyramid.rs`. Do not start before Plan 01 is merged.
- Run all commands through `./scripts/` wrappers. Regenerate protocol types with `pnpm codegen` **from inside the dev shell** — i.e. run `./scripts/dev.sh pnpm codegen` if `pnpm` is not on your PATH (`dev.sh` re-execs into the Nix shell).
- Generated files (`protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`) are committed; CI fails if regeneration diffs (`pnpm codegen:check`). Never hand-edit them.
- clippy pedantic + `-D warnings` in CI; `unsafe_code` forbidden.
- Commit messages: lowercase imperative, no prefix.
- Wire-format note: this plan intentionally changes the IPC/manifest wire format (version field moves from each payload to the envelope). There are no persisted artifacts or external consumers yet — Phase 0 is the only time this is a free change. `PROTOCOL_VERSION` stays 1.

---

### Task 1: Pyramid uses the protocol `EnvelopeBin`

**Files:**

- Modify: `core/scope-core/Cargo.toml`, `core/scope-core/src/pyramid.rs`, `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `scope_protocol::EnvelopeBin` (8 fields: `t0`, `t1`, `first`, `last`, `min`, `max`, `sample_count`, `has_gap`) — already generated.
- Produces: `Pyramid::query` returns `PyramidQuery { level: u32, bins: &[scope_protocol::EnvelopeBin] }`. The local `scope_core::pyramid::EnvelopeBin` type is deleted; `TILE_BINS` and all `Pyramid` method signatures otherwise unchanged.

- [ ] **Step 1: Add the dependency**

In `core/scope-core/Cargo.toml` `[dependencies]`, add:

```toml
scope-protocol.workspace = true
```

- [ ] **Step 2: Replace the duplicate struct with the protocol type**

In `core/scope-core/src/pyramid.rs`:

1. Replace the imports at the top:

```rust
use crate::store::Signal;
use scope_protocol::EnvelopeBin;
```

(Remove `use serde::{Deserialize, Serialize};`.)

2. Delete the local `pub struct EnvelopeBin { … }` definition and its `impl EnvelopeBin { fn sample … fn merge … }` block entirely.

3. Add private constructors in their place. These are the only two places that build bins, so the gap/extrema invariant (parent `has_gap` = OR of children; extrema = min/max of finite children) stays enforced by construction:

```rust
fn sample_bin(time: f64, value: f64) -> EnvelopeBin {
    let finite = value.is_finite().then_some(value);
    EnvelopeBin {
        t0: time,
        t1: time,
        first: finite,
        last: finite,
        min: finite,
        max: finite,
        sample_count: 1,
        has_gap: !value.is_finite(),
    }
}

fn merge_bins(left: &EnvelopeBin, right: &EnvelopeBin) -> EnvelopeBin {
    EnvelopeBin {
        t0: left.t0,
        t1: right.t1,
        first: left.first.or(right.first),
        last: right.last.or(left.last),
        min: min_option(left.min, right.min),
        max: max_option(left.max, right.max),
        sample_count: left.sample_count + right.sample_count,
        has_gap: left.has_gap || right.has_gap,
    }
}
```

4. Update the two call sites. In `from_samples`, `.map(|(time, value)| EnvelopeBin::sample(time, value))` becomes `.map(|(time, value)| sample_bin(time, value))`. In `from_level_zero`, the chunk merge becomes (the protocol struct is `Clone` but not `Copy`):

```rust
.map(|chunk| {
    if chunk.len() == 2 {
        merge_bins(&chunk[0], &chunk[1])
    } else {
        chunk[0].clone()
    }
})
```

5. `PyramidQuery` derives: change `#[derive(Clone, Copy, Debug)]` to `#[derive(Clone, Debug)]` (its `bins` slice ref was `Copy` only because the old bin was).

- [ ] **Step 3: Delete the shell's field-by-field copy**

In `shell/src-tauri/src/lib.rs` `query_tiles`, replace:

```rust
bins: query
    .bins
    .iter()
    .map(|bin| EnvelopeBin { … })
    .collect(),
```

with:

```rust
bins: query.bins.to_vec(),
```

Remove `EnvelopeBin` from the `scope_protocol` import list if it becomes unused.

- [ ] **Step 4: Run the tests**

Run: `./scripts/ci.sh rust`
Expected: PASS. The three pyramid tests (`every_level_preserves_global_envelope`, `nan_gap_survives_every_parent`, `query_is_bounded_by_display_density`) compile against the protocol type unchanged because the field names are identical — that identity is exactly why the duplicate had to go.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/Cargo.toml core/scope-core/src/pyramid.rs shell/src-tauri/src/lib.rs Cargo.lock
git commit -m "use the protocol envelope bin as the single definition"
```

---

### Task 2: Slim the schema — version fields out, `IngestRequest` in

**Files:**

- Modify: `protocol/schema/scope-protocol.json`
- Regenerate: `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`

**Interfaces:**

- Produces: `TileRequest`, `TileResponse`, `IngestResponse` without `protocol_version` fields; new `IngestRequest { path: string }`. Both generated files updated. Downstream tasks depend on these exact shapes.

- [ ] **Step 1: Edit the schema**

In `protocol/schema/scope-protocol.json`:

- Delete the line `"protocol_version": "u32",` from `TileRequest`, `TileResponse`, and `IngestResponse`.
- Add after the `TimeWindow` entry:

```json
"IngestRequest": {
  "kind": "object",
  "fields": {
    "path": "string"
  }
},
```

- [ ] **Step 2: Regenerate and inspect**

Run: `./scripts/dev.sh pnpm codegen`
Expected: `protocol/src/generated.rs` and `frontend/src/generated/protocol.ts` regenerate; `git diff` shows the three `protocol_version` fields gone and the `IngestRequest` struct/interface added. This temporarily breaks the shell and frontend build — expected. **Do not commit yet:** Tasks 2–5 are one atomic wire-format change and land as a single commit at the end of Task 5, so the workspace compiles at every commit.

---

### Task 3: The Rust `Envelope<T>` choke point

**Files:**

- Create: `protocol/src/envelope.rs`
- Modify: `protocol/src/lib.rs`, `protocol/Cargo.toml`

**Interfaces:**

- Produces: `scope_protocol::Envelope<T>` with `Envelope::new(payload)` (stamps `PROTOCOL_VERSION`) and `envelope.open() -> Result<T, VersionError>`; `scope_protocol::VersionError { expected, actual }`.

- [ ] **Step 1: Write the failing tests** (inside `protocol/src/envelope.rs`, written together with the implementation below — create the file with both)

`protocol/Cargo.toml` `[dependencies]` — add:

```toml
thiserror.workspace = true
```

`protocol/src/envelope.rs`:

```rust
//! Transport wrapper validated at one choke point per host.
//!
//! Every IPC payload and baked manifest crosses hosts inside an
//! [`Envelope`], so the protocol version is stamped and checked in exactly
//! one place instead of per message type.

use serde::{Deserialize, Serialize};

use crate::PROTOCOL_VERSION;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub protocol_version: u32,
    pub payload: T,
}

impl<T> Envelope<T> {
    #[must_use]
    pub fn new(payload: T) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            payload,
        }
    }

    /// Returns the payload when the envelope's version matches this build.
    ///
    /// # Errors
    ///
    /// Returns [`VersionError`] when the envelope was produced by an
    /// incompatible protocol version.
    pub fn open(self) -> Result<T, VersionError> {
        if self.protocol_version == PROTOCOL_VERSION {
            Ok(self.payload)
        } else {
            Err(VersionError {
                expected: PROTOCOL_VERSION,
                actual: self.protocol_version,
            })
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("unsupported protocol version {actual}; expected {expected}")]
pub struct VersionError {
    pub expected: u32,
    pub actual: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_version_opens() {
        assert_eq!(Envelope::new(7_u32).open(), Ok(7));
    }

    #[test]
    fn mismatched_version_is_rejected() {
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION + 1,
            payload: (),
        };
        let error = envelope.open().unwrap_err();
        assert_eq!(error.actual, PROTOCOL_VERSION + 1);
    }
}
```

`protocol/src/lib.rs` becomes:

```rust
//! Versioned data-plane protocol generated from the repository schema.

mod envelope;
mod generated;

pub use envelope::{Envelope, VersionError};
pub use generated::*;
```

- [ ] **Step 2: Run the protocol tests**

Run: `./scripts/dev.sh cargo test -p scope-protocol`
Expected: both envelope tests PASS. (The workspace as a whole still fails to compile — the shell is fixed next.)

---

### Task 4: Shell commands speak envelopes

**Files:**

- Modify: `shell/src-tauri/src/lib.rs`

**Interfaces:**

- Consumes: `Envelope`, `IngestRequest` from `scope_protocol`.
- Produces: Tauri commands `ingest_csv(request: Envelope<IngestRequest>) -> Result<Envelope<IngestResponse>, String>`, `list_signals() -> Result<Envelope<Vec<SignalSummary>>, String>`, `query_tiles(request: Envelope<TileRequest>) -> Result<Envelope<TileResponse>, String>`. The frontend (Task 5) relies on these names and the `request` argument key.

- [ ] **Step 1: Update imports**

```rust
use scope_protocol::{
    Envelope, IngestRequest, IngestResponse, SignalSummary, SignalTile, SourceSummary,
    TileRequest, TileResponse,
};
```

(`PROTOCOL_VERSION` and `EnvelopeBin` disappear from the import — the shell no longer touches either.)

- [ ] **Step 2: Rewrite the three command signatures**

`ingest_csv` — signature and first/last lines change; the body between stays as it is today:

```rust
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn ingest_csv(
    request: Envelope<IngestRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<IngestResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    let path = request.path;
    // … existing body, using `path` where it used the old `path` argument …
    Ok(Envelope::new(IngestResponse { source, signals }))
}
```

(Note `IngestResponse` no longer has a `protocol_version` field — delete that field from the construction. Bind `source` and `signals` as the existing body already does.)

`list_signals`:

```rust
fn list_signals(
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<Vec<SignalSummary>>, String> {
    let data = state.lock().map_err(|error| error.to_string())?;
    Ok(Envelope::new(
        data.store.signals().map(signal_summary).collect(),
    ))
}
```

`query_tiles` — DELETE the manual version check block at the top (`if request.protocol_version != PROTOCOL_VERSION { … }`), open the envelope instead, and wrap the response:

```rust
fn query_tiles(
    request: Envelope<TileRequest>,
    state: State<'_, Mutex<DataState>>,
) -> Result<Envelope<TileResponse>, String> {
    let request = request.open().map_err(|error| error.to_string())?;
    // … existing body unchanged …
    Ok(Envelope::new(TileResponse {
        request_id: request.request_id,
        series,
    }))
}
```

- [ ] **Step 3: Verify Rust side compiles and passes**

Run: `./scripts/ci.sh rust`
Expected: PASS, clippy clean. Every version check in Rust now lives in `Envelope::open`.

---

### Task 5: Frontend envelope + call-site updates

**Files:**

- Create: `frontend/src/app/envelope.ts`, `frontend/src/app/envelope.test.ts`
- Modify: `frontend/src/app/data-plane.ts`, `frontend/src/ui/app-shell.ts`

**Interfaces:**

- Produces: `seal<T>(payload): Envelope<T>` and `open<T>(envelope): T` (throws on mismatch); `BakedManifest = Envelope<{ signals: SignalSummary[]; tiles: TileResponse }>`. Snapshot bakers must wrap the manifest with `seal` from now on.

- [ ] **Step 1: Write the failing test** — `frontend/src/app/envelope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../generated/protocol";
import { open, seal } from "./envelope";

describe("envelope", () => {
  it("round-trips a payload at the current version", () => {
    expect(open(seal({ value: 42 }))).toEqual({ value: 42 });
  });

  it("rejects a mismatched version", () => {
    expect(() =>
      open({ protocol_version: PROTOCOL_VERSION + 1, payload: null }),
    ).toThrow(/unsupported protocol version/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/dev.sh pnpm test`
Expected: FAIL — module `./envelope` not found.

- [ ] **Step 3: Implement** — `frontend/src/app/envelope.ts`:

```ts
import { PROTOCOL_VERSION } from "../generated/protocol";

export interface Envelope<T> {
  protocol_version: number;
  payload: T;
}

export function seal<T>(payload: T): Envelope<T> {
  return { protocol_version: PROTOCOL_VERSION, payload };
}

export function open<T>(envelope: Envelope<T>): T {
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol version ${String(envelope.protocol_version)}; expected ${String(PROTOCOL_VERSION)}`,
    );
  }
  return envelope.payload;
}
```

- [ ] **Step 4: Update `data-plane.ts`**

1. Imports: drop `PROTOCOL_VERSION` and `EnvelopeBin` stays; add:

```ts
import { open, seal, type Envelope } from "./envelope";
```

2. Manifest type:

```ts
type BakedManifest = Envelope<{
  signals: SignalSummary[];
  tiles: TileResponse;
}>;
```

3. `TauriPlane` methods:

```ts
async listSignals(): Promise<SignalSummary[]> {
  return open(await this.invoke<Envelope<SignalSummary[]>>("list_signals"));
}

async queryTiles(request: TileRequest): Promise<TileResponse> {
  return open(
    await this.invoke<Envelope<TileResponse>>("query_tiles", {
      request: seal(request),
    }),
  );
}
```

4. `BakedPlane`: the constructor's manual version check is replaced by the choke point:

```ts
export class BakedPlane implements DataPlane {
  readonly host = "snapshot" as const;
  private readonly payload: BakedManifest["payload"];

  constructor(manifest: BakedManifest) {
    this.payload = open(manifest);
  }
  // listSignals / queryTiles read this.payload.signals / this.payload.tiles
  // instead of this.manifest.signals / this.manifest.tiles — same logic.
}
```

5. `createDemoManifest()`: wrap the returned object in `seal({ signals, tiles: { … } })` and delete the two inner `protocol_version:` properties (on the manifest and on the `tiles` response) plus the outer `protocol_version` field — the demo body is otherwise unchanged.

- [ ] **Step 5: Update `app-shell.ts`**

In `refreshTiles`, delete the `protocol_version: PROTOCOL_VERSION,` line from the `queryTiles` argument object, and remove `PROTOCOL_VERSION` from the `../generated/protocol` import.

- [ ] **Step 6: Run the full frontend + e2e checks**

Run: `./scripts/test.sh frontend` — Expected: lint, typecheck, `codegen:check`, unit tests, web build, and snapshot artifact checks all PASS.
Run: `./scripts/test.sh e2e` — Expected: both Playwright specs PASS (the demo manifest still renders).

- [ ] **Step 7: Commit Tasks 2–5 together** (the wire format change is one atomic unit)

```bash
git add protocol/schema/scope-protocol.json protocol/src/ protocol/Cargo.toml Cargo.lock \
  shell/src-tauri/src/lib.rs frontend/src/app/envelope.ts frontend/src/app/envelope.test.ts \
  frontend/src/app/data-plane.ts frontend/src/ui/app-shell.ts frontend/src/generated/protocol.ts
git commit -m "validate protocol version through one transport envelope"
```

---

### Task 6: ADR 0004 amendment — envelope + reserved binary framing

**Files:**

- Modify: `docs/adr/0004-versioned-protocol-and-codegen.md`

- [ ] **Step 1: Replace the second Decision paragraph** ("Every request and response includes `protocol_version`. …") with:

```markdown
Every payload crosses hosts inside a transport envelope
`{ protocol_version, payload }`; `Envelope::open` (Rust) and `open()`
(TypeScript) are the only version checks. Additive fields require defaults;
breaking semantics require a new version with an explicit compatibility
path. Tauri IPC and baked snapshots use the same serialized names.

Framing 1 is JSON. A binary framing for bulk `EnvelopeBin[]` transfers
(bytes decoded to typed arrays) is reserved for a future protocol version so
dense tile traffic never has to squeeze through JSON; adding it is a new
framing behind the same envelope, not a redesign.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0004-versioned-protocol-and-codegen.md
git commit -m "record envelope transport and reserved binary framing in adr 0004"
```

---

### Task 7: Full gate

- [ ] **Step 1: Run `./scripts/ci.sh all`** — Expected: every stage passes.
- [ ] **Step 2: `git status` clean; hand off for review.**
