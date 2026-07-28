# Editor shortcuts and font preferences — design

Date: 2026-07-28
Status: Approved by Edward (this session)

## Goal

Bring SignalScope closer to the Zed-like editor posture it is designed around:

1. **Undo/redo** for workspace edits (`ctrl+z`, `ctrl+y` / `ctrl+shift+z`).
2. **Font family selection** — separately for UI chrome and plot text — from a
   curated bundled set, including matplotlib-like (DejaVu Sans) and MATLAB-like
   (Arimo, Helvetica-metric) options.
3. **Font size control** — `ctrl+=` / `ctrl+-` / `ctrl+0` for plot text
   (Zed's buffer-font-zoom analog); UI chrome font size as a settings entry.
4. **Global preferences layer + settings palette** (`ctrl+,`) to give the above
   a home.
5. **Palette frecency** — recently/frequently used commands rank first.

Deferred (discussed, out of scope): plot style presets (MATLAB/matplotlib
one-command looks), panel/tab navigation shortcut pack, user-customizable
keymap file.

## Decisions made during brainstorming

- Preferences persist in a **new global, versioned preferences file** — not the
  per-workspace session. This follows the design handoff (Audit v2 line 104:
  "Global preferences … persist across sessions") and deliberately diverges
  from ADR 0022's session-only precedent. **Theme stays in the session** for
  now (no session schema bump this iteration); migrating it to global prefs is
  a possible follow-up.
- `ctrl+=`/`ctrl+-` adjust **plot** text size only. UI font size is
  settings-only. Two independent preferences.
- Font families come from a **curated bundled set** (woff2, self-hosted) to
  keep baked snapshots self-contained and satisfy the Tauri CSP
  (`font-src 'self' data:`). No free-text system fonts.
- Undo covers **all workspace-session edits** except transient state (cursor
  position, panel focus, hover) and file ingestion.
- Undo mechanism: **snapshot history** (deep clones of the session), not
  inverse commands or diffs.
- Settings surface: **palette-style list**, a third mode of the existing
  palette infrastructure — not a modal.
- Redo binds to both `ctrl+y` and `ctrl+shift+z`.
- Frecency data lives in **localStorage** (disposable usage cache, not user
  state), not the prefs file.

## 1. Preferences layer

New versioned schema following the session-schema pattern:

- `protocol/schema/scope-preferences.json`, `schema_version: 1`:

  ```json
  {
    "schema_version": 1,
    "ui_font_family": "inter",
    "plot_font_family": "jetbrains-mono",
    "ui_font_size": 13,
    "plot_font_size": 9
  }
  ```

  - `ui_font_family`, `plot_font_family`: enum
    `inter | dejavu-sans | arimo | jetbrains-mono`.
  - `ui_font_size`: px, clamped 10–20, default 13 (today's look).
  - `plot_font_size`: base px, clamped 6–16, default 9 (today's tick size).

- Codegen to TypeScript (`frontend/src/generated/preferences.ts`) and Rust via
  the existing `protocol/scripts/generate-types.mjs` pipeline (ADR 0004).
- Load/save + migration ladder in `core/scope-core` (new `preferences.rs`,
  modeled on `session.rs`): one migration rung + test per future version bump.
- Tauri commands in `shell/src-tauri` writing `preferences.json` to
  `app_data_dir()` with the atomic temp-file+rename pattern from ADR 0022.
- New `preferences` port on `DataPlane` (`load`/`save`), alongside `session`.
  **Null in the baked host**: snapshot viewers get defaults, can adjust
  settings in-memory for the page's lifetime, nothing persists — mirroring how
  autosave already degrades.
- Saves debounce at 800 ms (same constant/pattern as autosave).
- Error handling: corrupt file or newer-than-known `schema_version` → use
  defaults in memory, log a warning, and **do not write the file back** until
  the user changes a setting (never clobber a newer version's file on load).
- A TS↔Rust conformance test mirrors `session-conformance.test.ts`: TypeScript
  default-prefs keys must equal the Rust fixture's keys.

## 2. Fonts

Bundle two new variable/static woff2 files in `frontend/public/fonts/` with
`@font-face` rules in `tokens.css` beside Inter and JetBrains Mono:

- **DejaVu Sans** — matplotlib's default font (free license).
- **Arimo** — metric-compatible Helvetica substitute, the MATLAB look
  (real Helvetica is not freely licensable).

### UI chrome

- Prefs apply `--font-ui` on the root element (inline style custom-property
  override; `tokens.css` keeps the defaults).
- Size: one mechanical CSS pass converts the ~60 hardcoded `font-size` px
  literals in `frontend/src/styles/app.css` to `rem`, and root `font-size` is
  driven by `ui_font_size` (13px root reproduces today's rendering exactly).
  Spacing, borders, and layout dimensions stay px — this is font sizing, not
  zoom.

### Plot text (canvas renderers)

- New `--font-plot` token, decoupled from `--font-mono` (which the formula bar
  and other UI code keep).
- `canvas-renderer.ts` and `overlay-renderer.ts` currently hardcode
  9 / 9.5 / 10 px. They derive from `plot_font_size` instead:
  - tick labels = base
  - axis labels = base + 0.5
  - overlay plates (cursor/delta/annotation) = base + 1

  These are exactly today's ratios at the default base of 9.

- The renderers' cached palette (read via `getComputedStyle`) picks up font
  changes through the existing `invalidateTheme()` invalidation path, followed
  by a re-render. Overlay `measureText` plate layout scales automatically
  because it measures with the font it draws with.

## 3. Font-size shortcuts

- `ctrl+=` → `increase-plot-font`, `ctrl+-` → `decrease-plot-font`,
  `ctrl+0` → `reset-plot-font`. Steps of ±0.5 px, clamped to 6–16.
- These replace the inert planned `font-size` menu entry
  (`app-shell.ts:668`).
- `comboFor()` in `frontend/src/app/commands.ts` gains support for the `=`,
  `-`, `0`, and `,` keys, and normalizes `ctrl+shift+=` (i.e. ctrl-plus on US
  layouts) to the same combo as `ctrl+=`.
- UI font size has no shortcut; it is a settings-palette entry.

## 4. Undo/redo

New module `frontend/src/app/history.ts`:

- `HistoryStack`: `past: Session[]`, `future: Session[]`, cap 100 entries.
  Entries are deep clones via `structuredClone`. The session is
  kilobyte-scale JSON, so clones are cheap.
- **Capture:** an explicit `commit(coalesceKey?)` call in `AppShell` after
  each mutation site, seeded with a baseline snapshot when a session becomes
  active. Continuous gestures (row/column resize, wheel zoom, drag pan,
  time-window scrub) pass a stable coalesce key so the whole gesture collapses
  into one undo step; a new entry starts when the key changes or the gesture
  ends (pointer up / wheel settle).
- **Excluded from history:** `setCursorT` (cursor position), `focusPanel`,
  hover state, and file ingestion (`addSourcePath` data effects — undo never
  unloads ingested data). Everything else is undoable: layout, splits, series,
  styles, annotations, axis edits, tabs, derived-signal add/remove, theme.
- **Restore:** undo/redo call `workspace.replace(clone)` and reuse the
  session-load re-sync path (tabs sync, panel refresh, tile re-request —
  derived signals re-request through the derived port exactly as on load).
  Focused panel is preserved when it still exists in the restored state.
- History clears on new-workspace and open-workspace. Redo clears on any new
  mutation.
- **Keys:** `ctrl+z` undo; `ctrl+y` **and** `ctrl+shift+z` redo. Palette
  commands + keys only — no Edit menu, per the design handoff (Audit v2 line
  77). Menu/palette section: `workspace`.
- **Editing-guard fix:** the global keydown handler currently forwards
  ctrl-modified keys even when an editable element has focus, so `ctrl+z`
  would hijack native text undo in the formula bar and rename inputs. The
  handler will skip history commands (undo/redo ids) while the event target is
  editable, restoring native text-field undo.

## 5. Settings palette (`ctrl+,`)

- Third palette mode: `"commands" | "signals" | "settings"`.
- Entries: Theme, UI font, Plot font, UI font size, Plot font size, Reset all
  to defaults. Each shows its current value in the existing hint slot.
- Interaction: Enter cycles enum values (theme, families); Left/Right (or
  `+`/`-`) adjust the two size entries while selected. Fuzzy filter works as
  in other modes.
- New command `open-settings` bound to `ctrl+,`, with a `view`-section
  application-menu entry per ADR 0020's menu-mirrors-palette rule.
- Theme changes made here go through the existing session-backed
  `toggleTheme` path; font changes go to the prefs port.

## 6. Palette frecency

- Record command executions as `{ count, lastUsed }` per command id in
  localStorage (`signalscope.command-usage.v1`), capped (drop
  least-recently-used beyond ~50 ids).
- Commands mode, empty query: order by frecency score (count decayed by
  recency), then the existing registration order.
- Non-empty query: fuzzy score dominates; frecency breaks ties.
- Baked host: localStorage works there too; no special handling.

## 7. Testing

- **Unit (Vitest):** `HistoryStack` push/undo/redo/coalesce/cap; prefs
  defaults, clamping, and apply logic; `comboFor` for `=`, `-`, `0`, `,` and
  the shift-equals normalization; frecency scoring and ordering.
- **Rust:** prefs load/save round-trip, atomic write, migration ladder,
  unknown-future-version behavior.
- **Conformance:** TS default prefs keys ↔ Rust fixture keys.
- **E2E (Playwright):** split a panel → `ctrl+z` restores the layout →
  `ctrl+y` re-applies; `ctrl+,` opens settings and switching plot font updates
  `--font-plot`; `ctrl+=` bumps the plot font size (asserted via the settings
  entry's displayed value).
- All work runs through `./scripts/` wrappers; frontend + Rust CI gates before
  handoff.

## Impact / invariants check

- No session schema change (theme untouched). No tile-pyramid, ingest,
  transactional, or protocol changes beyond the new additive prefs schema.
- Two-host `DataPlane` preserved: prefs is a new nullable port; baked
  snapshots remain self-contained and network-free (fonts are bundled).
- New ADR recommended alongside implementation: "Global preferences file"
  documenting the deliberate divergence from ADR 0022's session-only
  persistence and the theme follow-up question.
