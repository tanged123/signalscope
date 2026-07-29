# Export Fidelity Controls Implementation Plan

**Goal:** Make export-time data reduction explicit and adjustable. Today
`ExportScope` conflates _range_ and _fidelity_ (`visible` = windowed **and**
capped at 2,048 bins; `all` = full range **and** undecimated), and the CSV path
strides silently at 65,536 points. Split the two axes, give the user a fidelity
ladder with live per-rung consequences, and state what is being dropped before
the write happens.

**Scope decisions (settled, do not re-litigate):**

- One user-facing knob: **decimation**. Any lossless encoding win is an internal
  detail — no knob, no disclosure.
- Awareness is **export-time only**. The dialog tells the exporter. Artifacts
  carry no provenance marker: no snapshot badge, no CSV header comment.
- **Range × fidelity are orthogonal.** Every combination is legal, including
  "all loaded at preview" (small shareable overview, impossible today) and
  "visible window at full" (honest deep-dive).
- Applies to **HTML and CSV**. PNG is a picture, not a data claim — untouched.
- **One global target.** No per-signal or per-panel overrides.
- Not persisted. The dialog resets to its default rung on each open, matching
  how scope resets to `visible` today.

**Depends on:** the in-flight review fixes, specifically the refactor that has
`plan()` record per-level bin counts once so `bake()` and `estimated_bytes()`
consume the plan instead of recomputing. Build on that shape; do not reintroduce
a third window-counting implementation.

**Prior art:** `docs/superpowers/specs/2026-07-28-phase4-export-pipeline-design.md`,
ADR 0024.

## Global constraints

- `./scripts/` wrappers only. Codegen via `./scripts/codegen.sh`; never hand-edit
  `protocol/src/generated.rs` or `frontend/src/generated/protocol.ts`.
- Protocol version bumps **6 → 7**. This is a breaking manifest change; old
  snapshots are not expected to load.
- Codegen rejects `u64?` (generate-types.mjs:194) — only plain `u64` and `u64[]`
  carry the string serde attributes. Express "no ceiling" as an enum variant, not
  a nullable integer or a `0` sentinel.
- Bake output stays byte-stable for identical inputs.

---

### Task 1: Protocol types

- [ ] Rename `ExportScope` → `ExportRange` (`visible | all`). Range now means
      _only_ which signals and what time span — never fidelity.
- [ ] Add `ExportFidelity` (`preview | standard | high | full`).
- [ ] `ExportWriteRequest { session_json, range, fidelity }`.
- [ ] Replace `ExportEstimate { visible_bytes, all_bytes }` with a matrix:
      `ExportEstimate { entries: ExportEstimateEntry[] }`, one entry per
      (range, fidelity) pair — 8 entries.
- [ ] `ExportEstimateEntry { range, fidelity, bytes, series_total,
series_decimated, series_full_rate, coarsest_ratio }`. All counts `u64`.
      `coarsest_ratio` is source samples per emitted point, worst case across
      series; `1` when nothing was decimated.
- [ ] Bump `protocol_version` to 7, regenerate both sides.

The matrix is HTML-only. PNG and CSV sizes stay exact and frontend-computed.

### Task 2: `scope-core::snapshot` — fidelity ceilings

- [ ] Replace `MAX_BINS_PER_BAKED_LEVEL` with one table:
      `fn ceiling(fidelity) -> Option<usize>` — `preview` 512, `standard` 2_048
      (today's value), `high` 16_384, `full` `None`. Exhaustive `match`, so a new
      rung fails to compile until the table is updated.
- [ ] `plan(session, store, pyramids, range, fidelity)`. `finest_level` takes the
      ceiling; `None` means level 0, i.e. today's `ExportScope::All` behavior.
- [ ] **Two rules outrank the knob.** Keep both, and make the precedence explicit
      in code and doc comment: 1. _Level-0 override._ Signals on an XY/FFT/histogram panel bake level 0 at
      every rung. `querySamples` in a snapshot reconstructs from `levels[0]`
      (ADR 0015); an FFT over envelope bins is meaningless. 2. _Honesty rule._ The target is a ceiling, never an upsample. A signal
      whose in-window raw count already fits stays raw.
- [ ] `ExportPlan` carries the awareness summary (`series_total`,
      `series_decimated`, `series_full_rate`, `coarsest_ratio`) alongside the
      per-level counts, computed once. `estimated_bytes` and the dialog both read
      it; neither recomputes.

### Task 3: Tauri commands

- [ ] `export_estimate` builds all 8 plans and returns the matrix. It is
      metadata-only, so cost is unchanged — do not materialize levels.
- [ ] `export_write` takes `range` + `fidelity`. Keep the mutex-scope and clone
      fixes from the review pass: bake under the lock, `inject` and write outside it.

### Task 4: `scope-bake` CLI

- [ ] Add `--range visible|all` and `--fidelity preview|standard|high|full`.
- [ ] Defaults `--range all --fidelity full` so the CI round-trip artifact is
      byte-identical to today's.

### Task 5: Export dialog

- [ ] Split the single segmented control into two rows: **RANGE**
      (visible window | all loaded) and **FIDELITY** (the four rungs). Both stay
      HTML-only-enabled as the scope control is today, except fidelity, which the
      CSV row also uses.
- [ ] Each fidelity rung shows its own estimated size from the matrix, so the
      trade-off is visible before committing rather than described in a caption.
- [ ] Under the ladder, render the awareness line for the current selection, e.g.
      `38 of 41 series decimated · coarsest 1 pt per 64 samples · 3 kept at full
rate (XY/FFT)`. This line is the feature — it is not optional chrome.
- [ ] Delete the hardcoded `decimated to ≤2k pts/series` caption. The number now
      comes from the selected rung.
- [ ] **Guard rail:** above ~100 MB, the rung's size renders in a warning tone and
      the confirm button restates it (`Export 1.4 GB`). This is what stops
      "all × full" on a large session from silently OOMing the app.

### Task 6: CSV path

- [ ] `CSV_SAMPLE_CAP` goes away. `buildVisibleCsv` passes the selected rung's
      ceiling as `max_points`; `full` means every sample in the window.
- [ ] Default the CSV row to `high` (16,384) rather than `standard` — closer to
      the old 65,536 behavior, and CSV rows feed other tools rather than pixels.
      HTML keeps `standard`.
- [ ] The dialog's CSV row reports exact rows and stride from the sample response
      (`stride` is already returned and currently discarded). Exact, not `~`.
- [ ] The CSV file itself stays unmarked — a deliberate consequence of
      exporter-only awareness. If that ever changes, a `# strided 1:N` header is
      the intended shape.

### Task 7: Docs and tests

- [ ] ADR 0025: export range and fidelity are orthogonal; supersedes the level
      selection paragraph of ADR 0024. Add to `docs/adr/README.md`.
- [ ] Rust unit tests: - ceiling table is monotone — a coarser rung never bakes more bins; - XY/FFT override wins at `preview`; - a sparse signal stays raw at every rung; - `all × full` matches the pre-change `ExportScope::All` output byte-for-byte; - the matrix has one entry per combination and bytes decrease monotonically
      as fidelity coarsens.
- [ ] e2e: bake the round-trip fixture at `preview` and at `full`; assert the
      preview artifact is materially smaller and both restore the same session
      state. Keep the existing ceiling assertion but measure the `signals` payload
      rather than whole-file bytes, which is dominated by the JS bundle.
