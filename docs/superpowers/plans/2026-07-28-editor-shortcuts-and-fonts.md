# Editor Shortcuts and Font Preferences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace undo/redo (ctrl+z / ctrl+y / ctrl+shift+z), a global preferences file with UI/plot font family and size settings, plot-font-size shortcuts (ctrl+= / ctrl+- / ctrl+0), a ctrl+, settings palette, and command-palette frecency.

**Architecture:** A new versioned `scope-preferences.json` schema is codegen'd to TS + Rust like the session schema; `core/scope-core/src/preferences.rs` owns IO/migration, two Tauri commands expose it, and a nullable `preferences` port on `DataPlane` keeps the baked host degrading gracefully. Undo is a snapshot `HistoryStack` of `structuredClone`d sessions committed from `AppShell` mutation sites. The settings surface is a third mode of the existing `CommandPalette`.

**Tech Stack:** Vanilla TypeScript 5.9 + Vite, Vitest 4, Playwright 1.57, Rust (serde/thiserror), Tauri 2. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-28-editor-shortcuts-and-fonts-design.md`

## Global Constraints

- Run everything through `./scripts/` wrappers (`AGENTS.md`). If `pnpm`/`cargo` are missing from PATH, prefix commands with `./scripts/dev.sh` (e.g. `./scripts/dev.sh pnpm test`). Targeted inner-loop runs like `pnpm --filter @signalscope/frontend exec vitest run <file>` are fine; finish each task with the named wrapper check.
- Preferences: `ui_font_size` px clamp **10–20** default **13** step **1**; `plot_font_size` px clamp **6–16** default **9** step **0.5**. Font family enum variants: `inter | dejavu | arimo | jetbrains`. Defaults: UI `inter`, plot `jetbrains`.
- `PREFERENCES_SCHEMA_VERSION = 1`. Prefs file name: `preferences.json` in `app_data_dir()`, atomic temp-file+rename writes (ADR 0022 pattern).
- Load failure or future schema version → defaults in memory + `console.warn`; never write the file back except from a user settings change.
- Keys: undo `mod+z`; redo `mod+shift+z` **and** `mod+y`; plot font `mod+=` / `mod+-` / `mod+0` (ctrl+shift+= normalizes to `mod+=`); settings `mod+,`. No Edit menu — undo/redo are palette+keys only, section `workspace`.
- History cap **100** entries; excluded from history: `setCursorT`, `focusPanel`, hover, ingestion data effects.
- Frecency: localStorage key `signalscope.command-usage.v1`, max **50** tracked ids, score = `count * 0.5 ** (ageMs / week)`.
- Generated files (`frontend/src/generated/*`, `*/generated.rs`) are never edited by hand — only via `./scripts/codegen.sh`.
- Commit style: match `git log` (`feat(scope): …`, `fix(session): …` etc., lowercase, no period). Stage only intentional files.
- The codebase's ESLint config requires `${String(x)}` for non-string template interpolations — follow the surrounding style.

## File Structure

| File | Role |
|---|---|
| `protocol/schema/scope-preferences.json` | New prefs schema (v1) |
| `protocol/scripts/generate-types.mjs` | Add prefs codegen job |
| `scripts/codegen.sh`, `package.json` (`codegen:check`) | Add new generated files to format/diff lists |
| `core/scope-core/src/preferences.rs` (+ `preferences/generated.rs`) | Rust Default/IO/migration + tests |
| `protocol/testdata/preferences-conformance.json` | TS↔Rust fixture |
| `shell/src-tauri/src/lib.rs` | `load_preferences` / `save_preferences` commands |
| `frontend/src/generated/preferences.ts` | Generated TS types |
| `frontend/src/app/preferences.ts` (+ test) | Defaults, clamps, parse, font stacks, apply |
| `frontend/src/app/history.ts` (+ test) | `HistoryStack` |
| `frontend/src/app/frecency.ts` (+ test) | `CommandUsage` |
| `frontend/src/app/commands.ts` (+ test) | comboFor `=` handling, `altKeys`, `reservedWhileEditing`, `onRun` |
| `frontend/src/app/data-plane.ts` | `PreferencesPort`, plane wiring |
| `frontend/src/ui/command-palette.ts` | `"settings"` mode, `keepOpen`, `adjust` |
| `frontend/src/ui/app-shell.ts` | Prefs wiring, undo/redo commands + commit sites, settings entries, frecency ranking |
| `frontend/src/render/canvas-renderer.ts`, `overlay-renderer.ts` | `--font-plot` / `--plot-font-size` driven text |
| `frontend/src/styles/tokens.css`, `app.css` | New tokens, @font-face, rem conversion |
| `frontend/public/fonts/` | DejaVu Sans + Arimo woff2 + licenses |
| `frontend/tests/e2e/settings-and-undo.spec.ts` | E2E coverage |
| `docs/adr/0023-global-preferences-file.md` | ADR (confirm next free number) |

---

### Task 1: Preferences schema + codegen pipeline

**Files:**
- Create: `protocol/schema/scope-preferences.json`
- Create: `core/scope-core/src/preferences.rs` (module skeleton)
- Modify: `protocol/scripts/generate-types.mjs:8-23` (jobs array)
- Modify: `scripts/codegen.sh` (rustfmt list)
- Modify: `package.json` (`codegen:check` script)
- Modify: `core/scope-core/src/lib.rs` (add module)
- Generated: `core/scope-core/src/preferences/generated.rs`, `frontend/src/generated/preferences.ts`

**Interfaces:**
- Produces (Rust): `scope_core::preferences::{Preferences, FontFamily, PREFERENCES_SCHEMA_VERSION}` with `Preferences::default()`.
- Produces (TS): `frontend/src/generated/preferences.ts` exporting `PREFERENCES_SCHEMA_VERSION` (=1), `type FontFamily = "inter" | "dejavu" | "arimo" | "jetbrains"`, `interface Preferences { schema_version: number; ui_font_family: FontFamily; plot_font_family: FontFamily; ui_font_size: number; plot_font_size: number; }`.

- [ ] **Step 1: Write the schema**

`protocol/schema/scope-preferences.json`:

```json
{
  "schema_version": 1,
  "types": {
    "FontFamily": {
      "kind": "enum",
      "variants": ["inter", "dejavu", "arimo", "jetbrains"],
      "default": "inter"
    },
    "Preferences": {
      "kind": "object",
      "fields": {
        "schema_version": "u32",
        "ui_font_family": "FontFamily",
        "plot_font_family": "FontFamily",
        "ui_font_size": "f64",
        "plot_font_size": "f64"
      }
    }
  }
}
```

(Variants are single words on purpose: the codegen's `pascalCase`/`rename_all = "lowercase"` pair cannot represent hyphenated names.)

- [ ] **Step 2: Register the codegen job**

In `protocol/scripts/generate-types.mjs`, append to the `jobs` array (after the session entry):

```js
  {
    schema: "protocol/schema/scope-preferences.json",
    versionKey: "schema_version",
    versionConst: "PREFERENCES_SCHEMA_VERSION",
    rust: "core/scope-core/src/preferences/generated.rs",
    ts: "frontend/src/generated/preferences.ts",
  },
```

In `scripts/codegen.sh`, add `"$script_dir/../core/scope-core/src/preferences/generated.rs"` to the `rustfmt` file list. In root `package.json`, extend `codegen:check` so both the rustfmt list and the `git diff --exit-code --` list also include `core/scope-core/src/preferences/generated.rs` and `frontend/src/generated/preferences.ts`.

- [ ] **Step 3: Create the Rust module skeleton and register it**

`core/scope-core/src/preferences.rs`:

```rust
//! Versioned global preferences schema (ADR 0023): appearance settings that
//! persist across sessions, unlike the per-workspace session file.

mod generated;

pub use generated::*;

impl Default for Preferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            ui_font_family: FontFamily::Inter,
            plot_font_family: FontFamily::Jetbrains,
            ui_font_size: 13.0,
            plot_font_size: 9.0,
        }
    }
}
```

In `core/scope-core/src/lib.rs`, add `pub mod preferences;` (alphabetical, between `ingest` and `pyramid`).

- [ ] **Step 4: Run codegen and verify both generated files appear**

Run: `./scripts/codegen.sh`
Expected: creates `core/scope-core/src/preferences/generated.rs` and `frontend/src/generated/preferences.ts`; the TS file contains `PREFERENCES_SCHEMA_VERSION = 1` and the four-variant `FontFamily`.

- [ ] **Step 5: Verify Rust compiles and codegen check passes**

Run: `./scripts/test.sh core` and `./scripts/dev.sh pnpm codegen:check`
Expected: both pass (no tests yet for prefs; compilation is the gate).

- [ ] **Step 6: Commit**

```bash
git add protocol/schema/scope-preferences.json protocol/scripts/generate-types.mjs scripts/codegen.sh package.json core/scope-core/src/lib.rs core/scope-core/src/preferences.rs core/scope-core/src/preferences/generated.rs frontend/src/generated/preferences.ts
git commit -m "feat(prefs): add versioned preferences schema and codegen"
```

---

### Task 2: Rust preferences IO, migration, and conformance fixture

**Files:**
- Modify: `core/scope-core/src/preferences.rs`
- Create: `protocol/testdata/preferences-conformance.json` (via `REGENERATE_FIXTURES=1`)

**Interfaces:**
- Consumes: Task 1's `Preferences`, `FontFamily`, `PREFERENCES_SCHEMA_VERSION`.
- Produces: `preferences::from_json(&str) -> Result<Preferences, PreferencesError>`, `preferences::save_to_path(&Preferences, &Path) -> Result<(), PreferencesError>`, `preferences::load_from_path(&Path) -> Result<Preferences, PreferencesError>`, `enum PreferencesError { UnsupportedVersion(u32), Io, Json }`.

- [ ] **Step 1: Write failing tests**

Append to `core/scope-core/src/preferences.rs` (mirroring `session.rs:294-370` patterns):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../protocol/testdata/preferences-conformance.json"
    );

    #[test]
    fn preferences_conformance_fixture_matches_rust() {
        let preferences = Preferences::default();
        let current = format!(
            "{}\n",
            serde_json::to_string_pretty(&preferences).expect("serializes")
        );
        if std::env::var("REGENERATE_FIXTURES").is_ok() {
            std::fs::write(FIXTURE_PATH, &current).expect("write fixture");
            return;
        }
        let stored = std::fs::read_to_string(FIXTURE_PATH).expect("read fixture");
        assert_eq!(
            from_json(&stored).expect("the fixture is loadable preferences"),
            preferences,
            "regenerate with REGENERATE_FIXTURES=1"
        );
    }

    #[test]
    fn saving_and_loading_round_trips_through_a_file() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("preferences.json");
        let preferences = Preferences {
            plot_font_family: FontFamily::Dejavu,
            plot_font_size: 11.5,
            ..Preferences::default()
        };
        save_to_path(&preferences, &path).expect("saves");
        assert_eq!(load_from_path(&path).expect("loads"), preferences);
        assert!(
            !directory.path().join("preferences.json.tmp").exists(),
            "the temporary file is renamed, not left behind"
        );
    }

    #[test]
    fn future_version_is_rejected() {
        let error = from_json(r#"{"schema_version":99}"#).unwrap_err();
        assert!(matches!(error, PreferencesError::UnsupportedVersion(99)));
    }

    #[test]
    fn truncated_preferences_fail_instead_of_partially_restoring() {
        let error = from_json("{\"schema_ver").unwrap_err();
        assert!(matches!(error, PreferencesError::Json(_)));
    }

    #[test]
    fn a_missing_preferences_file_reports_io() {
        let directory = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            load_from_path(&directory.path().join("absent.json")).expect_err("absent"),
            PreferencesError::Io(_)
        ));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./scripts/test.sh core`
Expected: FAIL — `from_json`, `save_to_path`, `load_from_path`, `PreferencesError` not found.

- [ ] **Step 3: Implement**

Insert between the `Default` impl and the tests (same shape as `session.rs:60-223`):

```rust
use std::path::Path;

use serde::Deserialize;
use thiserror::Error;

/// Deserializes and migrates a preferences document.
///
/// # Errors
///
/// Returns [`PreferencesError`] when the JSON is malformed or uses an
/// unsupported schema version.
pub fn from_json(json: &str) -> Result<Preferences, PreferencesError> {
    #[derive(Deserialize)]
    struct Head {
        schema_version: u32,
    }

    let value: serde_json::Value = serde_json::from_str(json)?;
    let head: Head = Head::deserialize(&value)?;
    migrate(head.schema_version, value)
}

/// Serializes `preferences` through a sibling temporary file renamed into
/// place, so an interrupted write never truncates the previous file.
///
/// # Errors
///
/// Returns [`PreferencesError::Io`] when the write or rename fails and
/// [`PreferencesError::Json`] when serialization fails.
pub fn save_to_path(preferences: &Preferences, path: &Path) -> Result<(), PreferencesError> {
    let json = serde_json::to_string_pretty(preferences)?;
    let temporary = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&temporary, json)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Reads and migrates the preferences stored at `path`.
///
/// # Errors
///
/// Returns [`PreferencesError::Io`] when the file cannot be read and the
/// variants of [`from_json`] otherwise.
pub fn load_from_path(path: &Path) -> Result<Preferences, PreferencesError> {
    from_json(&std::fs::read_to_string(path)?)
}

/// Migration ladder (ADR 0005 pattern): v1 is current; each future bump adds
/// one arm that rewrites vN into vN+1 shape and recurses.
fn migrate(version: u32, value: serde_json::Value) -> Result<Preferences, PreferencesError> {
    match version {
        PREFERENCES_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(PreferencesError::UnsupportedVersion(version)),
    }
}

#[derive(Debug, Error)]
pub enum PreferencesError {
    #[error("unsupported preferences schema version: {0}")]
    UnsupportedVersion(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
```

Generate the fixture: `REGENERATE_FIXTURES=1 ./scripts/dev.sh cargo test -p scope-core preferences_conformance` (or run `./scripts/test.sh core` once with the env var set).

- [ ] **Step 4: Run tests to verify they pass**

Run: `./scripts/test.sh core`
Expected: PASS, all five new tests green.

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/preferences.rs protocol/testdata/preferences-conformance.json
git commit -m "feat(prefs): preferences io, migration ladder, conformance fixture"
```

---

### Task 3: Tauri load/save preferences commands

**Files:**
- Modify: `shell/src-tauri/src/lib.rs` (near the session commands, `lib.rs:436-535`, and the handler list at `lib.rs:548-562`)

**Interfaces:**
- Consumes: `scope_core::preferences` from Task 2; existing `Envelope` from `scope_protocol`.
- Produces: Tauri commands `load_preferences() -> Envelope<Option<String>>` (None when the file doesn't exist; Err on corrupt/future-version) and `save_preferences(request: Envelope<String>) -> Envelope<()>` (validates via `from_json`, then atomic save). These are what `TauriPlane` invokes in Task 9.

- [ ] **Step 1: Implement the commands**

Add `preferences` to the `scope_core::{…}` import list at `lib.rs:8-14`. Below `pick_session_path`, add:

```rust
const PREFERENCES_FILE: &str = "preferences.json";

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(PREFERENCES_FILE))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn load_preferences(app: AppHandle) -> Result<Envelope<Option<String>>, String> {
    let path = preferences_path(&app)?;
    if !path.exists() {
        return Ok(Envelope::new(None));
    }
    let preferences = preferences::load_from_path(&path).map_err(|error| error.to_string())?;
    Ok(Envelope::new(Some(
        serde_json::to_string(&preferences).map_err(|error| error.to_string())?,
    )))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn save_preferences(request: Envelope<String>, app: AppHandle) -> Result<Envelope<()>, String> {
    let json = request.open().map_err(|error| error.to_string())?;
    let preferences = preferences::from_json(&json).map_err(|error| error.to_string())?;
    preferences::save_to_path(&preferences, &preferences_path(&app)?)
        .map_err(|error| error.to_string())?;
    Ok(Envelope::new(()))
}
```

Register both in `tauri::generate_handler![…]` after `pick_session_path`.

- [ ] **Step 2: Verify the shell compiles and clippy is clean**

Run: `./scripts/dev.sh cargo clippy -p signalscope-shell --all-targets -- -D warnings`
Expected: PASS. (The shell's own test suite runs in the final CI gate.)

- [ ] **Step 3: Commit**

```bash
git add shell/src-tauri/src/lib.rs
git commit -m "feat(prefs): tauri load/save preferences commands"
```

---

### Task 4: Frontend preferences module + conformance test

**Files:**
- Create: `frontend/src/app/preferences.ts`
- Create: `frontend/src/app/preferences.test.ts`
- Create: `frontend/src/app/preferences-conformance.test.ts`

**Interfaces:**
- Consumes: generated `frontend/src/generated/preferences.ts` (Task 1); fixture `protocol/testdata/preferences-conformance.json` (Task 2).
- Produces (used by Tasks 9, 12): `defaultPreferences(): Preferences`, `parsePreferences(json: string): Preferences | null`, `clampUiFontSize(value: number): number`, `clampPlotFontSize(value: number): number`, `applyPreferences(prefs: Preferences, target: PreferencesTarget): void`, `fontLabel(family: FontFamily): string`, `fontStack(family: FontFamily): string`, `FONT_FAMILIES: readonly FontFamily[]`, `UI_FONT_SIZE` / `PLOT_FONT_SIZE` (`{ min, max, default, step }`), `interface PreferencesTarget { style: { setProperty(name: string, value: string): void; fontSize: string } }`.

- [ ] **Step 1: Write failing tests**

`frontend/src/app/preferences.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  applyPreferences,
  clampPlotFontSize,
  clampUiFontSize,
  defaultPreferences,
  fontStack,
  parsePreferences,
  PLOT_FONT_SIZE,
  UI_FONT_SIZE,
} from "./preferences";

describe("preferences", () => {
  it("defaults match the spec", () => {
    const prefs = defaultPreferences();
    expect(prefs.schema_version).toBe(1);
    expect(prefs.ui_font_family).toBe("inter");
    expect(prefs.plot_font_family).toBe("jetbrains");
    expect(prefs.ui_font_size).toBe(13);
    expect(prefs.plot_font_size).toBe(9);
  });

  it("clamps sizes to their ranges and steps", () => {
    expect(clampUiFontSize(0)).toBe(UI_FONT_SIZE.min);
    expect(clampUiFontSize(99)).toBe(UI_FONT_SIZE.max);
    expect(clampUiFontSize(12.4)).toBe(12);
    expect(clampPlotFontSize(0)).toBe(PLOT_FONT_SIZE.min);
    expect(clampPlotFontSize(99)).toBe(PLOT_FONT_SIZE.max);
    expect(clampPlotFontSize(9.26)).toBe(9.5);
  });

  it("parses a round-tripped document", () => {
    const prefs = { ...defaultPreferences(), plot_font_size: 11.5 };
    expect(parsePreferences(JSON.stringify(prefs))).toEqual(prefs);
  });

  it("rejects malformed json and future versions", () => {
    expect(parsePreferences("{nope")).toBeNull();
    expect(
      parsePreferences(JSON.stringify({ ...defaultPreferences(), schema_version: 99 })),
    ).toBeNull();
  });

  it("repairs unknown families and out-of-range sizes", () => {
    const parsed = parsePreferences(
      JSON.stringify({
        ...defaultPreferences(),
        ui_font_family: "comic-sans",
        ui_font_size: 400,
      }),
    );
    expect(parsed?.ui_font_family).toBe("inter");
    expect(parsed?.ui_font_size).toBe(UI_FONT_SIZE.max);
  });

  it("applies css variables and the root font size", () => {
    const set = new Map<string, string>();
    const target = {
      style: {
        setProperty: (name: string, value: string) => set.set(name, value),
        fontSize: "",
      },
    };
    applyPreferences({ ...defaultPreferences(), plot_font_family: "dejavu" }, target);
    expect(set.get("--font-ui")).toBe(fontStack("inter"));
    expect(set.get("--font-plot")).toBe(fontStack("dejavu"));
    expect(set.get("--plot-font-size")).toBe("9");
    expect(target.style.fontSize).toBe("13px");
  });
});
```

`frontend/src/app/preferences-conformance.test.ts` (mirrors `session-conformance.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import fixtureJson from "../../../protocol/testdata/preferences-conformance.json";
import type { Preferences } from "../generated/preferences";
import { PREFERENCES_SCHEMA_VERSION } from "../generated/preferences";
import { defaultPreferences } from "./preferences";

const fixture = fixtureJson as Preferences;

describe("preferences conformance", () => {
  it("parses the Rust fixture as the generated Preferences type", () => {
    expect(fixture.schema_version).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(fixture.ui_font_family).toBe("inter");
  });

  it("emits every key the Rust fixture carries", () => {
    expect(Object.keys(defaultPreferences()).sort()).toEqual(
      Object.keys(fixture).sort(),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/preferences.test.ts src/app/preferences-conformance.test.ts`
Expected: FAIL — module `./preferences` not found.

- [ ] **Step 3: Implement `frontend/src/app/preferences.ts`**

```ts
import {
  PREFERENCES_SCHEMA_VERSION,
  type FontFamily,
  type Preferences,
} from "../generated/preferences";

export const UI_FONT_SIZE = { min: 10, max: 20, default: 13, step: 1 } as const;
export const PLOT_FONT_SIZE = { min: 6, max: 16, default: 9, step: 0.5 } as const;

export const FONT_FAMILIES: readonly FontFamily[] = [
  "inter",
  "dejavu",
  "arimo",
  "jetbrains",
];

const FONT_META: Record<FontFamily, { label: string; stack: string }> = {
  inter: {
    label: "Inter",
    stack: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  dejavu: {
    label: "DejaVu Sans (matplotlib)",
    stack: '"DejaVu Sans", Verdana, sans-serif',
  },
  arimo: {
    label: "Arimo (MATLAB-like)",
    stack: 'Arimo, "Liberation Sans", Helvetica, Arial, sans-serif',
  },
  jetbrains: {
    label: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  },
};

export function fontLabel(family: FontFamily): string {
  return FONT_META[family].label;
}

export function fontStack(family: FontFamily): string {
  return FONT_META[family].stack;
}

export function defaultPreferences(): Preferences {
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    ui_font_family: "inter",
    plot_font_family: "jetbrains",
    ui_font_size: UI_FONT_SIZE.default,
    plot_font_size: PLOT_FONT_SIZE.default,
  };
}

export function clampUiFontSize(value: number): number {
  const clamped = Math.min(UI_FONT_SIZE.max, Math.max(UI_FONT_SIZE.min, value));
  return Math.round(clamped);
}

export function clampPlotFontSize(value: number): number {
  const clamped = Math.min(
    PLOT_FONT_SIZE.max,
    Math.max(PLOT_FONT_SIZE.min, value),
  );
  return Math.round(clamped * 2) / 2;
}

/**
 * Parses a stored preferences document. Unknown enum values and
 * out-of-range sizes are repaired to keep a hand-edited file loadable;
 * malformed JSON or an unknown schema version returns null so callers fall
 * back to defaults without overwriting the file.
 */
export function parsePreferences(json: string): Preferences | null {
  let value: Partial<Preferences>;
  try {
    value = JSON.parse(json) as Partial<Preferences>;
  } catch {
    return null;
  }
  if (value.schema_version !== PREFERENCES_SCHEMA_VERSION) return null;
  const defaults = defaultPreferences();
  const family = (candidate: unknown, fallback: FontFamily): FontFamily =>
    FONT_FAMILIES.includes(candidate as FontFamily)
      ? (candidate as FontFamily)
      : fallback;
  const size = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : fallback;
  return {
    schema_version: PREFERENCES_SCHEMA_VERSION,
    ui_font_family: family(value.ui_font_family, defaults.ui_font_family),
    plot_font_family: family(value.plot_font_family, defaults.plot_font_family),
    ui_font_size: clampUiFontSize(size(value.ui_font_size, defaults.ui_font_size)),
    plot_font_size: clampPlotFontSize(
      size(value.plot_font_size, defaults.plot_font_size),
    ),
  };
}

/** The subset of an element the appearance settings write to. */
export interface PreferencesTarget {
  style: {
    setProperty(name: string, value: string): void;
    fontSize: string;
  };
}

/**
 * Pushes preferences into the style system: font-family tokens, the plot
 * font size token the canvas renderers read, and the root font-size that
 * drives every rem-based UI font size.
 */
export function applyPreferences(
  prefs: Preferences,
  target: PreferencesTarget,
): void {
  target.style.setProperty("--font-ui", fontStack(prefs.ui_font_family));
  target.style.setProperty("--font-plot", fontStack(prefs.plot_font_family));
  target.style.setProperty("--plot-font-size", String(prefs.plot_font_size));
  target.style.fontSize = `${String(prefs.ui_font_size)}px`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/preferences.test.ts src/app/preferences-conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/preferences.ts frontend/src/app/preferences.test.ts frontend/src/app/preferences-conformance.test.ts
git commit -m "feat(prefs): frontend preferences module and conformance test"
```

---

### Task 5: Bundle DejaVu Sans and Arimo fonts

**Files:**
- Create: `frontend/public/fonts/dejavu-sans-latin-400-normal.woff2`, `dejavu-sans-latin-700-normal.woff2`, `arimo-latin-400-normal.woff2`, `arimo-latin-700-normal.woff2`, `LICENSE-dejavu-sans.txt`, `LICENSE-arimo.txt`
- Modify: `frontend/src/styles/tokens.css:1-15` (add @font-face blocks)

**Interfaces:**
- Produces: font families `"DejaVu Sans"` and `Arimo` resolvable by the stacks defined in Task 4. No code interfaces.

- [ ] **Step 1: Download the woff2 files and licenses**

```bash
cd frontend/public/fonts
curl -fLo dejavu-sans-latin-400-normal.woff2 https://cdn.jsdelivr.net/npm/@fontsource/dejavu-sans/files/dejavu-sans-latin-400-normal.woff2
curl -fLo dejavu-sans-latin-700-normal.woff2 https://cdn.jsdelivr.net/npm/@fontsource/dejavu-sans/files/dejavu-sans-latin-700-normal.woff2
curl -fLo arimo-latin-400-normal.woff2 https://cdn.jsdelivr.net/npm/@fontsource/arimo/files/arimo-latin-400-normal.woff2
curl -fLo arimo-latin-700-normal.woff2 https://cdn.jsdelivr.net/npm/@fontsource/arimo/files/arimo-latin-700-normal.woff2
curl -fLo LICENSE-dejavu-sans.txt https://cdn.jsdelivr.net/npm/@fontsource/dejavu-sans/LICENSE
curl -fLo LICENSE-arimo.txt https://cdn.jsdelivr.net/npm/@fontsource/arimo/LICENSE
```

Fallback if a `@fontsource` URL 404s: download the official TTFs (DejaVu: `https://github.com/dejavu-fonts/dejavu-fonts/releases`, DejaVuSans.ttf + DejaVuSans-Bold.ttf, license in the archive; Arimo: `https://github.com/googlefonts/Arimo` or Google Fonts download) and convert with `pnpm dlx ttf2woff2 < DejaVuSans.ttf > dejavu-sans-latin-400-normal.woff2`, keeping the file names above.

Verify each file is real woff2: `for f in *.woff2; do head -c 4 "$f"; echo " <- $f"; done` — every line must start with `wOF2`.

- [ ] **Step 2: Add @font-face declarations**

In `frontend/src/styles/tokens.css`, after the JetBrains Mono block (line 15):

```css
@font-face {
  font-family: "DejaVu Sans";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/dejavu-sans-latin-400-normal.woff2") format("woff2");
}

@font-face {
  font-family: "DejaVu Sans";
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/dejavu-sans-latin-700-normal.woff2") format("woff2");
}

@font-face {
  font-family: Arimo;
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/arimo-latin-400-normal.woff2") format("woff2");
}

@font-face {
  font-family: Arimo;
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url("/fonts/arimo-latin-700-normal.woff2") format("woff2");
}
```

- [ ] **Step 3: Verify the build still passes (snapshot stays self-contained)**

Run: `./scripts/test.sh frontend`
Expected: PASS — including the snapshot artifact checks.

- [ ] **Step 4: Commit**

```bash
git add frontend/public/fonts frontend/src/styles/tokens.css
git commit -m "feat(fonts): bundle dejavu sans and arimo with licenses"
```

---

### Task 6: Plot font tokens and renderer sizing

**Files:**
- Modify: `frontend/src/styles/tokens.css` (`:root` block)
- Modify: `frontend/src/render/canvas-renderer.ts:20-96, 488-506`
- Modify: `frontend/src/render/overlay-renderer.ts:217, 288, 322-339`
- Create: `frontend/src/render/plot-fonts.test.ts`

**Interfaces:**
- Consumes: CSS vars `--font-plot` and `--plot-font-size` (set by Task 4's `applyPreferences`; defaults from tokens.css).
- Produces: exported `tickFont(palette)` / `labelFont(palette)` from `canvas-renderer.ts` now deriving from `palette.fontPlot: string` and `palette.fontSize: number` (tick = base, label = base + 0.5); overlay plates draw at base + 1. `Palette`/`OverlayPalette` gain `fontPlot`/`fontSize` and **drop `fontMono`**.

- [ ] **Step 1: Add default tokens**

In `frontend/src/styles/tokens.css` `:root` block (after `--font-mono`, line 67):

```css
  --font-plot: JetBrains Mono, ui-monospace, "SF Mono", Menlo, monospace;
  --plot-font-size: 9;
```

- [ ] **Step 2: Write failing test**

`frontend/src/render/plot-fonts.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { labelFont, tickFont } from "./canvas-renderer";

const palette = { fontPlot: '"DejaVu Sans", sans-serif', fontSize: 11 };

describe("plot fonts", () => {
  it("derives tick and label fonts from the palette size", () => {
    expect(tickFont(palette)).toBe('11px "DejaVu Sans", sans-serif');
    expect(labelFont(palette)).toBe('11.5px "DejaVu Sans", sans-serif');
  });
});
```

Run: `pnpm --filter @signalscope/frontend exec vitest run src/render/plot-fonts.test.ts`
Expected: FAIL — `tickFont`/`labelFont` not exported.

- [ ] **Step 3: Implement renderer changes**

`canvas-renderer.ts`:
- In `Palette` (line 20-29): replace `fontMono: string;` with `fontPlot: string;` and add `fontSize: number;`.
- Replace the two font helpers (lines 90-96) with exported versions typed loosely so the test needs no full palette:

```ts
export function tickFont(palette: { fontPlot: string; fontSize: number }): string {
  return `${String(palette.fontSize)}px ${palette.fontPlot}`;
}

export function labelFont(palette: { fontPlot: string; fontSize: number }): string {
  return `${String(palette.fontSize + 0.5)}px ${palette.fontPlot}`;
}
```

- In `resolvePalette()` (line 488-506): replace the `fontMono:` line with:

```ts
      fontPlot:
        styles.getPropertyValue("--font-plot").trim() ||
        styles.getPropertyValue("--font-mono").trim() ||
        FALLBACK_MONO,
      fontSize: plotFontSize(styles),
```

and add near `FALLBACK_MONO`:

```ts
function plotFontSize(styles: CSSStyleDeclaration): number {
  const parsed = Number.parseFloat(styles.getPropertyValue("--plot-font-size"));
  return Number.isFinite(parsed) ? parsed : 9;
}
```

- Run `grep -n "fontMono" frontend/src/render/*.ts` and update every remaining use (colorbar/axis draw sites in canvas-renderer use `tickFont`/`labelFont` already; fix any direct `palette.fontMono` reference to `palette.fontPlot`).

`overlay-renderer.ts`:
- In `OverlayPalette`: replace `fontMono` with `fontPlot: string;` and add `fontSize: number;`.
- Lines 217 and 288: `context.font = \`${String(palette.fontSize + 1)}px ${palette.fontPlot}\`;`
- `resolvePalette()` (line 322-339): replace the `fontMono:` line with:

```ts
      fontPlot: token("--font-plot") || token("--font-mono") || '"JetBrains Mono", monospace',
      fontSize: overlayPlotFontSize(styles),
```

with a matching module-level helper:

```ts
function overlayPlotFontSize(styles: CSSStyleDeclaration): number {
  const parsed = Number.parseFloat(styles.getPropertyValue("--plot-font-size"));
  return Number.isFinite(parsed) ? parsed : 9;
}
```

- [ ] **Step 4: Run tests + full frontend gate**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/render/plot-fonts.test.ts` then `./scripts/test.sh frontend`
Expected: PASS. Rendering is unchanged at defaults (9/9.5/10px reproduced exactly).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/render/canvas-renderer.ts frontend/src/render/overlay-renderer.ts frontend/src/render/plot-fonts.test.ts
git commit -m "feat(fonts): drive plot text from --font-plot and --plot-font-size"
```

---

### Task 7: UI font-size rem conversion

**Files:**
- Modify: `frontend/src/styles/tokens.css` (`:root`), `frontend/src/styles/app.css` (~60 declarations)

**Interfaces:**
- Produces: root `font-size: 13px` in tokens.css as the rem base; every `font-size:`/`font:` px literal in app.css converted to rem so `applyPreferences` (which sets `documentElement.style.fontSize`) scales the whole UI. Spacing/borders stay px.

- [ ] **Step 1: Set the rem base**

Add to the `:root` block in `tokens.css` (top of the block):

```css
  font-size: 13px;
```

- [ ] **Step 2: Convert app.css font sizes to rem**

Enumerate every value first: `grep -no 'font\(-size\)\?: [0-9.]*px' frontend/src/styles/app.css | sort -t: -k3 -u`. Convert each with **rem = px / 13, 4 decimals**:

| px | rem |
|---|---|
| 9 | 0.6923rem |
| 9.5 | 0.7308rem |
| 10 | 0.7692rem |
| 10.5 | 0.8077rem |
| 11 | 0.8462rem |
| 11.5 | 0.8846rem |
| 12 | 0.9231rem |
| 12.5 | 0.9615rem |
| 13 | 1rem |
| 14 | 1.0769rem |
| 15 | 1.1538rem |

Apply mechanically (covers both `font-size: Npx` and the `font: Npx …` shorthands):

```bash
perl -pi -e '
  s/\b(font(?:-size)?): 9px/$1: 0.6923rem/g;
  s/\b(font(?:-size)?): 9\.5px/$1: 0.7308rem/g;
  s/\b(font(?:-size)?): 10px/$1: 0.7692rem/g;
  s/\b(font(?:-size)?): 10\.5px/$1: 0.8077rem/g;
  s/\b(font(?:-size)?): 11px/$1: 0.8462rem/g;
  s/\b(font(?:-size)?): 11\.5px/$1: 0.8846rem/g;
  s/\b(font(?:-size)?): 12px/$1: 0.9231rem/g;
  s/\b(font(?:-size)?): 12\.5px/$1: 0.9615rem/g;
  s/\b(font(?:-size)?): 13px/$1: 1rem/g;
  s/\b(font(?:-size)?): 14px/$1: 1.0769rem/g;
  s/\b(font(?:-size)?): 15px/$1: 1.1538rem/g;
' frontend/src/styles/app.css
```

Any value the grep surfaces that is missing from the table: compute px/13 to 4 decimals and add a matching substitution. Beware `9px` vs `9.5px` ordering — the commands above list `9px` before `9.5px` safely because of the `px` suffix in the pattern.

- [ ] **Step 3: Verify no px font sizes remain and TS sources are clean**

Run: `grep -n 'font\(-size\)\?: [0-9.]*px' frontend/src/styles/*.css` — expected: only the `font-size: 13px` root base in tokens.css. Also `grep -rn "font-size" frontend/src --include='*.ts' | grep -v generated` — expected: no inline px font sizes to convert (the renderers were handled in Task 6).

- [ ] **Step 4: Run the frontend gate (visual default must be byte-identical)**

Run: `./scripts/test.sh frontend`
Expected: PASS, including snapshot artifact checks — at root 13px the computed sizes equal the old px values.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/styles/app.css
git commit -m "refactor(styles): rem-based ui font sizes on a 13px root"
```

---

### Task 8: Keymap upgrades in commands.ts

**Files:**
- Modify: `frontend/src/app/commands.ts`
- Create: `frontend/src/app/commands.test.ts` (extend if it already exists)

**Interfaces:**
- Produces: `Command.altKeys?: string[]` (secondary bindings; palette/menu hints keep showing `keys`); `CommandRegistry.onRun: ((id: string) => void) | null` (fires after every successful `run`/`handleKey` execution — Task 13's frecency hook); exported `reservedWhileEditing(event: KeyboardEvent): boolean` (true for `mod+z`, `mod+shift+z`, `mod+y` — Task 11's editing guard); `comboFor` now maps `+` → `=` and suppresses `shift` for `=` so ctrl+= and ctrl+shift+= both produce `"mod+="`.

- [ ] **Step 1: Write failing tests**

`frontend/src/app/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CommandRegistry, reservedWhileEditing } from "./commands";

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: "",
    ...init,
  } as KeyboardEvent;
}

describe("command registry keys", () => {
  it("matches mod+= for ctrl+= and ctrl+shift+= (plus)", () => {
    const registry = new CommandRegistry();
    let runs = 0;
    registry.register({
      id: "increase-plot-font",
      title: "Plot font size: increase",
      keys: "mod+=",
      run: () => {
        runs += 1;
      },
    });
    expect(registry.handleKey(keyEvent({ ctrlKey: true, key: "=" }))).toBe(true);
    expect(
      registry.handleKey(keyEvent({ ctrlKey: true, shiftKey: true, key: "+" })),
    ).toBe(true);
    expect(runs).toBe(2);
  });

  it("matches altKeys as secondary bindings", () => {
    const registry = new CommandRegistry();
    let runs = 0;
    registry.register({
      id: "redo",
      title: "Redo",
      keys: "mod+shift+z",
      altKeys: ["mod+y"],
      run: () => {
        runs += 1;
      },
    });
    expect(
      registry.handleKey(keyEvent({ ctrlKey: true, shiftKey: true, key: "Z" })),
    ).toBe(true);
    expect(registry.handleKey(keyEvent({ ctrlKey: true, key: "y" }))).toBe(true);
    expect(runs).toBe(2);
  });

  it("reports run ids through onRun", () => {
    const registry = new CommandRegistry();
    const seen: string[] = [];
    registry.onRun = (id) => seen.push(id);
    registry.register({ id: "undo", title: "Undo", keys: "mod+z", run: () => undefined });
    registry.run("undo");
    registry.handleKey(keyEvent({ ctrlKey: true, key: "z" }));
    expect(seen).toEqual(["undo", "undo"]);
  });
});

describe("reservedWhileEditing", () => {
  it("reserves native undo/redo combos", () => {
    expect(reservedWhileEditing(keyEvent({ ctrlKey: true, key: "z" }))).toBe(true);
    expect(
      reservedWhileEditing(keyEvent({ ctrlKey: true, shiftKey: true, key: "Z" })),
    ).toBe(true);
    expect(reservedWhileEditing(keyEvent({ ctrlKey: true, key: "y" }))).toBe(true);
    expect(reservedWhileEditing(keyEvent({ ctrlKey: true, key: "s" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/commands.test.ts`
Expected: FAIL — `altKeys` unknown, `reservedWhileEditing` not exported, `onRun` missing, plus-key not matched.

- [ ] **Step 3: Implement**

In `frontend/src/app/commands.ts`:

1. Add to the `Command` interface after `keys?: string;`:

```ts
  /** Secondary key bindings; hints keep displaying `keys`. */
  altKeys?: string[];
```

2. Add to `CommandRegistry` (first member):

```ts
  /** Called with the command id after every successful execution. */
  onRun: ((id: string) => void) | null = null;
```

3. In `run()` (line 27-38), before `return true;` add `this.onRun?.(id);` (after `command.run();`).

4. In `handleKey()` (line 40-54), change the match to include altKeys and report:

```ts
    for (const command of this.commands.values()) {
      if (
        (command.keys === combo || (command.altKeys?.includes(combo) ?? false)) &&
        command.status !== "planned" &&
        (command.enabled?.() ?? true)
      ) {
        command.run();
        this.onRun?.(command.id);
        return true;
      }
    }
```

5. Replace `comboFor` (lines 57-65):

```ts
function comboFor(event: KeyboardEvent): string | null {
  if (event.altKey) return null;
  // Shifted ctrl+= arrives as "+" on row-number layouts; both spellings mean
  // the same zoom-in binding, so "+" folds into "=" and drops its shift.
  const key = event.key === "+" ? "=" : event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    const shift = event.shiftKey && key !== "=" ? "shift+" : "";
    return `mod+${shift}${key}`;
  }
  if (event.shiftKey && key.length > 1) return `shift+${key}`;
  return key;
}
```

6. Add after `comboFor`:

```ts
const EDITING_RESERVED = new Set(["mod+z", "mod+shift+z", "mod+y"]);

/**
 * True when the combo belongs to native text editing (undo/redo) and must
 * not be captured while an input, textarea, or contenteditable has focus.
 */
export function reservedWhileEditing(event: KeyboardEvent): boolean {
  const combo = comboFor(event);
  return combo !== null && EDITING_RESERVED.has(combo);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/commands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/commands.ts frontend/src/app/commands.test.ts
git commit -m "feat(commands): altkeys, plus-equals normalization, onRun hook, editing guard"
```

---

### Task 9: Preferences port and AppShell wiring + plot-font shortcuts

**Files:**
- Modify: `frontend/src/app/data-plane.ts` (interfaces + both planes)
- Modify: `frontend/src/ui/app-shell.ts` (fields, `mount`, new methods, commands, planned list at line 664-685)

**Interfaces:**
- Consumes: Task 3 commands, Task 4 module, Task 8 `mod+=` normalization.
- Produces: `interface PreferencesPort { load(): Promise<string | null>; save(preferencesJson: string): Promise<void>; }`; `DataPlane.preferences: PreferencesPort | null` (`TauriPlane` implements, `BakedPlane` null). AppShell: `private prefs: Preferences`, `private loadPreferences(): Promise<void>`, `private updatePreferences(patch: Partial<Omit<Preferences, "schema_version">>): void`, `private schedulePreferencesSave(): void` — Task 12's settings entries call `updatePreferences` and read `this.prefs`. Commands `increase-plot-font` (`mod+=`), `decrease-plot-font` (`mod+-`), `reset-plot-font` (`mod+0`), replacing the inert `font-size` planned entry.

- [ ] **Step 1: Add the port to `data-plane.ts`**

After `SessionPort` (line 40):

```ts
export interface PreferencesPort {
  load(): Promise<string | null>;
  save(preferencesJson: string): Promise<void>;
}
```

Add to `DataPlane` after `session`: `readonly preferences: PreferencesPort | null;`

In `TauriPlane`, declare `readonly preferences: PreferencesPort;` and initialize in the constructor after `this.session = {…};`:

```ts
    this.preferences = {
      load: async () =>
        open(await this.invoke<Envelope<string | null>>("load_preferences")),
      save: async (preferencesJson: string) => {
        open(
          await this.invoke<Envelope<null>>("save_preferences", {
            request: seal(preferencesJson),
          }),
        );
      },
    };
```

In `BakedPlane`, add `readonly preferences = null;` beside `readonly session = null;`.

- [ ] **Step 2: Wire AppShell**

In `app-shell.ts`:

1. Imports:

```ts
import {
  applyPreferences,
  clampPlotFontSize,
  clampUiFontSize,
  defaultPreferences,
  parsePreferences,
  PLOT_FONT_SIZE,
} from "../app/preferences";
import type { Preferences } from "../generated/preferences";
```

2. Fields (near `autosaveTimer`, line 70):

```ts
  private prefs: Preferences = defaultPreferences();
  private prefsSaveTimer: number | null = null;
```

3. In `mount()` immediately after `this.root.innerHTML = shellMarkup();` (line 80): `await this.loadPreferences();`

4. New methods (place after `scheduleAutosave`, line 941):

```ts
  /** Loads global preferences; any failure falls back to defaults without
   *  touching the stored file (it is only written on a user change). */
  private async loadPreferences(): Promise<void> {
    const port = this.plane.preferences;
    if (port !== null) {
      try {
        const json = await port.load();
        const parsed = json === null ? null : parsePreferences(json);
        if (json !== null && parsed === null) {
          console.warn("preferences file is unreadable or newer; using defaults");
        }
        this.prefs = parsed ?? defaultPreferences();
      } catch (error: unknown) {
        console.warn("preferences load failed; using defaults", error);
      }
    }
    applyPreferences(this.prefs, document.documentElement);
  }

  private updatePreferences(
    patch: Partial<Omit<Preferences, "schema_version">>,
  ): void {
    this.prefs = { ...this.prefs, ...patch };
    this.prefs.ui_font_size = clampUiFontSize(this.prefs.ui_font_size);
    this.prefs.plot_font_size = clampPlotFontSize(this.prefs.plot_font_size);
    applyPreferences(this.prefs, document.documentElement);
    this.workspaceView?.invalidateTheme();
    this.renderTiles();
    this.schedulePreferencesSave();
  }

  /** Coalesces rapid setting changes into one write, like autosave. */
  private schedulePreferencesSave(): void {
    const port = this.plane.preferences;
    if (port === null) return;
    if (this.prefsSaveTimer !== null) window.clearTimeout(this.prefsSaveTimer);
    this.prefsSaveTimer = window.setTimeout(() => {
      this.prefsSaveTimer = null;
      void port.save(JSON.stringify(this.prefs)).catch((error: unknown) => {
        this.reportError(error);
      });
    }, AUTOSAVE_DEBOUNCE_MS);
  }
```

5. In `registerCommands()`, add (in the view/display neighborhood, near `toggle-theme`):

```ts
    this.commands.register({
      id: "increase-plot-font",
      title: "Plot font size: increase",
      keys: "mod+=",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({
          plot_font_size: this.prefs.plot_font_size + PLOT_FONT_SIZE.step,
        });
      },
    });
    this.commands.register({
      id: "decrease-plot-font",
      title: "Plot font size: decrease",
      keys: "mod+-",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({
          plot_font_size: this.prefs.plot_font_size - PLOT_FONT_SIZE.step,
        });
      },
    });
    this.commands.register({
      id: "reset-plot-font",
      title: "Plot font size: reset",
      keys: "mod+0",
      section: "view",
      group: "display",
      run: () => {
        this.updatePreferences({ plot_font_size: PLOT_FONT_SIZE.default });
      },
    });
```

6. Delete the `["font-size", "Font size ▸", "view", "display"],` row from the planned array (line 668).

- [ ] **Step 3: Verify manually + typecheck gate**

Run: `./scripts/test.sh frontend`
Expected: PASS. Then run `./scripts/run.sh` (or `./scripts/dev.sh pnpm dev` for the web host) and confirm: ctrl+= visibly enlarges axis tick text, ctrl+0 resets, ctrl+- shrinks; in the Tauri host the values survive an app restart (`preferences.json` appears in the app data dir).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/data-plane.ts frontend/src/ui/app-shell.ts
git commit -m "feat(prefs): preferences port, appshell wiring, plot font shortcuts"
```

---

### Task 10: HistoryStack

**Files:**
- Create: `frontend/src/app/history.ts`
- Create: `frontend/src/app/history.test.ts`

**Interfaces:**
- Consumes: `Session` type from `../generated/session`.
- Produces (Task 11 uses exactly these): `class HistoryStack { reset(current: Session): void; commit(next: Session, coalesceKey?: string): void; undo(): Session | null; redo(): Session | null; canUndo(): boolean; canRedo(): boolean; }`. `undo`/`redo` return deep clones safe to hand to `WorkspaceModel.replace`. `commit` deduplicates unchanged state and folds consecutive commits sharing a coalesce key into one entry. Cap: 100 past entries.

- [ ] **Step 1: Write failing tests**

`frontend/src/app/history.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Session } from "../generated/session";
import { emptySession } from "./workspace";
import { HistoryStack } from "./history";

function sessionWithTheme(theme: Session["theme"]): Session {
  return { ...emptySession(), theme };
}

function sessionWithWindow(t1: number): Session {
  const session = emptySession();
  session.linked_time.t1 = t1;
  return session;
}

describe("HistoryStack", () => {
  it("undoes and redoes committed states", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithTheme("dark"));
    stack.commit(sessionWithTheme("light"));
    expect(stack.canUndo()).toBe(true);
    expect(stack.undo()?.theme).toBe("dark");
    expect(stack.canUndo()).toBe(false);
    expect(stack.redo()?.theme).toBe("light");
    expect(stack.canRedo()).toBe(false);
  });

  it("returns null at the ends of history", () => {
    const stack = new HistoryStack();
    stack.reset(emptySession());
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
  });

  it("skips commits that do not change state", () => {
    const stack = new HistoryStack();
    stack.reset(emptySession());
    stack.commit(emptySession());
    expect(stack.canUndo()).toBe(false);
  });

  it("coalesces consecutive commits sharing a key", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50), "window:panel-1");
    stack.commit(sessionWithWindow(40), "window:panel-1");
    stack.commit(sessionWithWindow(30), "window:panel-1");
    expect(stack.undo()?.linked_time.t1).toBe(60);
  });

  it("breaks a coalescing run when the key changes", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50), "window:panel-1");
    stack.commit(sessionWithTheme("light"));
    stack.commit(sessionWithWindow(40), "window:panel-1");
    expect(stack.undo()?.theme).toBe("light");
  });

  it("clears the redo branch on a new commit", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(60));
    stack.commit(sessionWithWindow(50));
    stack.undo();
    stack.commit(sessionWithTheme("light"));
    expect(stack.canRedo()).toBe(false);
  });

  it("caps stored history at 100 entries", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithWindow(1));
    for (let step = 2; step <= 150; step += 1) {
      stack.commit(sessionWithWindow(step));
    }
    let undos = 0;
    while (stack.undo() !== null) undos += 1;
    expect(undos).toBe(100);
  });

  it("hands out clones, not shared references", () => {
    const stack = new HistoryStack();
    stack.reset(sessionWithTheme("dark"));
    stack.commit(sessionWithTheme("light"));
    const restored = stack.undo();
    if (restored === null) throw new Error("expected a session");
    restored.theme = "light";
    expect(stack.redo()?.theme).toBe("light");
    expect(stack.undo()?.theme).toBe("dark");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/history.test.ts`
Expected: FAIL — `./history` not found.

- [ ] **Step 3: Implement `frontend/src/app/history.ts`**

```ts
import type { Session } from "../generated/session";

const HISTORY_LIMIT = 100;

/**
 * Bounded snapshot history for workspace undo/redo. The session is
 * kilobyte-scale JSON, so whole-state clones beat hand-written inverse
 * operations on robustness. `present` mirrors the workspace's live state;
 * callers own applying returned snapshots via `WorkspaceModel.replace`.
 */
export class HistoryStack {
  private past: Session[] = [];
  private future: Session[] = [];
  private present: Session | null = null;
  private lastKey: string | null = null;

  reset(current: Session): void {
    this.past = [];
    this.future = [];
    this.present = structuredClone(current);
    this.lastKey = null;
  }

  commit(next: Session, coalesceKey?: string): void {
    if (this.present === null) {
      this.reset(next);
      return;
    }
    const snapshot = structuredClone(next);
    if (JSON.stringify(snapshot) === JSON.stringify(this.present)) return;
    if (coalesceKey !== undefined && coalesceKey === this.lastKey) {
      // Mid-gesture: fold into the open entry instead of stacking a step
      // per wheel tick or drag frame.
      this.present = snapshot;
    } else {
      this.past.push(this.present);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.present = snapshot;
    }
    this.future = [];
    this.lastKey = coalesceKey ?? null;
  }

  undo(): Session | null {
    const previous = this.past.pop();
    if (previous === undefined || this.present === null) return null;
    this.future.push(this.present);
    this.present = previous;
    this.lastKey = null;
    return structuredClone(previous);
  }

  redo(): Session | null {
    const next = this.future.pop();
    if (next === undefined || this.present === null) return null;
    this.past.push(this.present);
    this.present = next;
    this.lastKey = null;
    return structuredClone(next);
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/history.ts frontend/src/app/history.test.ts
git commit -m "feat(history): bounded snapshot history stack"
```

---

### Task 11: Undo/redo integration in AppShell

**Files:**
- Modify: `frontend/src/ui/app-shell.ts`

**Interfaces:**
- Consumes: `HistoryStack` (Task 10), `Command.altKeys` + `reservedWhileEditing` (Task 8).
- Produces: commands `undo` (`mod+z`) and `redo` (`mod+shift+z`, altKeys `["mod+y"]`), section `workspace`, group `history`; `private commitHistory(coalesceKey?: string): void`; `private applyHistory(session: Session | null): void`. Undo of a derived-signal removal recreates the backend signal; undo of a derived-signal creation leaves the orphan signal in the tree (harmless; redo re-records it) — data effects of ingestion are never rolled back.

- [ ] **Step 1: Add state, commands, and restore path**

1. Imports: `import { HistoryStack } from "../app/history";` and add `reservedWhileEditing` to the existing `../app/commands` import.

2. Fields:

```ts
  private readonly history = new HistoryStack();
  private restoringHistory = false;
```

3. In `mount()`, right after `await this.restoreSession();` (line 81): `this.history.reset(this.workspace.snapshot());`

4. New methods (near `afterLayoutChange`):

```ts
  /** Records the post-mutation state; no-op while restoring history. */
  private commitHistory(coalesceKey?: string): void {
    if (this.restoringHistory) return;
    this.history.commit(this.workspace.snapshot(), coalesceKey);
  }

  private applyHistory(session: Session | null): void {
    if (session === null) return;
    this.restoringHistory = true;
    try {
      this.workspace.replace(session);
      document.documentElement.dataset.theme = this.workspace.theme();
      this.workspaceView?.invalidateTheme();
      this.renderWindowReadout();
      this.afterLayoutChange();
    } finally {
      this.restoringHistory = false;
    }
    void this.replayMissingDerived();
  }

  /**
   * After an undo resurrects derived definitions the data plane no longer
   * holds (their removal really deleted the signal), recreate them exactly
   * as session load does. Unresolved definitions stay recorded.
   */
  private async replayMissingDerived(): Promise<void> {
    const port = this.plane.derived;
    if (port === null) return;
    const missing = this.workspace
      .derived()
      .filter((definition) => !this.signalsByPath.has(definition.path));
    if (missing.length === 0) return;
    for (const definition of missing) {
      try {
        await port.create(definition.path, definition.expr);
      } catch {
        // Unresolved definitions stay recorded for a later source retry.
      }
    }
    await this.reloadSignals();
    await this.refreshTiles();
  }
```

5. In `registerCommands()`:

```ts
    this.commands.register({
      id: "undo",
      title: "Undo",
      keys: "mod+z",
      section: "workspace",
      group: "history",
      enabled: () => this.history.canUndo(),
      run: () => {
        this.applyHistory(this.history.undo());
      },
    });
    this.commands.register({
      id: "redo",
      title: "Redo",
      keys: "mod+shift+z",
      altKeys: ["mod+y"],
      section: "workspace",
      group: "history",
      enabled: () => this.history.canRedo(),
      run: () => {
        this.applyHistory(this.history.redo());
      },
    });
```

6. Editing guard — in `bindControls()` replace the line `if (editing && !event.metaKey && !event.ctrlKey) return;` (line 834) with:

```ts
      if (
        editing &&
        ((!event.metaKey && !event.ctrlKey) || reservedWhileEditing(event))
      ) {
        return;
      }
```

- [ ] **Step 2: Add commit calls at every mutation site**

1. `afterLayoutChange()` (line 915): add `this.commitHistory();` as the **first** line — this covers every call site that already funnels through it (tabs, splits, close, move, plot, focused-panel commands, createDerived/removeDerived, openFiles).

2. Coalesced sites:
   - `applyTimeWindow()` (line 1247): before `this.renderTiles();` add `this.commitHistory(\`window:${panelId}\`);`
   - `applyXRange()` (line 1261): before `this.renderTiles();` add `this.commitHistory(\`xrange:${panelId}\`);`
   - `onYRange` callback (line 164-167): after `setPanelYRange`, add `this.commitHistory(\`yrange:${id}\`);`

3. Plain commits — append `this.commitHistory();` after the workspace mutation in each of these `WorkspaceView` callbacks (line 102-245) and methods that bypass `afterLayoutChange`:
   - `onSelectMode` (after `transitionPanelMode`), `onSetColorSignal`, `onToggleSeries`, `onPinAnnotation`, `onRemoveAnnotation`, `onEditAnnotationLabel`, `onToggleStats`, `onToggleAxisStyle`, `onEditAxisLabel`, `onSetSeriesStyle`, `onRemoveSeries`, `onLayoutChanged` (covers row/column seam drags, which mutate via `resizeRows`/`resizeColumns` inside WorkspaceView and fire this at gesture end)
   - `toggle-all-stats` command body (after the loop, line 380-384)
   - `toggleLinked()` (line 1530, after `setLinked`), `toggleTheme()` (line 1545, after `setTheme`), `cycleCursorMode()` (line 1374, after `setCursorMode`), `fitPanelView()` (line 1304, last line — the time-branch double-commits via `applyTimeWindow`, which the dedupe check absorbs)
   - `onToggleFavorite` tree callback (line 253-256, after `toggleFavorite`)

4. Excluded on purpose (add no commit): `onFocus`/`focusPanel`, `setCursor`/`setCursorT`, `scheduleLiveValues`, `onResized`, `onGesture`.

5. History lifecycle: in `newWorkspace()` (after `this.workspace.replace(...)`, line 976) and `loadSession()` (after `this.workspace.replace(...)`, line 1015) add `this.history.reset(this.workspace.snapshot());`

- [ ] **Step 3: Verify behavior manually + gates**

Run: `./scripts/test.sh frontend`
Expected: PASS. Then in `./scripts/dev.sh pnpm dev`: press `n` (split), ctrl+z (panel gone), ctrl+y (back), ctrl+shift+z equivalent; wheel-zoom a plot several ticks then a single ctrl+z restores the pre-gesture window; `t` theme toggle undoes; typing in the formula bar, ctrl+z edits the *text*, not the workspace.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/ui/app-shell.ts
git commit -m "feat(history): workspace undo/redo with gesture coalescing"
```

---

### Task 12: Settings palette (ctrl+,)

**Files:**
- Modify: `frontend/src/ui/command-palette.ts`
- Modify: `frontend/src/ui/app-shell.ts` (`paletteEntries`, `registerCommands`)

**Interfaces:**
- Consumes: `updatePreferences` / `this.prefs` / `fontLabel` / `FONT_FAMILIES` / `UI_FONT_SIZE` / `PLOT_FONT_SIZE` / `defaultPreferences` (Tasks 4, 9); `toggleTheme` (existing).
- Produces: `PaletteMode = "commands" | "signals" | "settings"`; `PaletteEntry.keepOpen?: boolean` (run without closing; list refreshes) and `PaletteEntry.adjust?: (direction: -1 | 1) => void` (ArrowLeft/ArrowRight while selected); command `open-settings` (`mod+,`, section `view`, group `display`).

- [ ] **Step 1: Extend the palette**

In `command-palette.ts`:

1. `export type PaletteMode = "commands" | "signals" | "settings";`
2. Add to `PaletteEntry`:

```ts
  /** Runs without closing the palette; the entry list refreshes after. */
  keepOpen?: boolean;
  /** ArrowLeft/ArrowRight handler for value entries (e.g. font sizes). */
  adjust?: (direction: -1 | 1) => void;
```

3. Add field `private mode: PaletteMode = "commands";` and set `this.mode = mode;` first in `open()`. Placeholder line becomes:

```ts
    this.input.placeholder =
      mode === "signals"
        ? "signals, workspaces, panels…"
        : mode === "settings"
          ? "settings — enter cycles, ←/→ adjust…"
          : "commands…";
```

4. In the input `keydown` handler, add before the `Enter` branch:

```ts
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const entry = this.matches[this.selected];
        if (entry?.adjust !== undefined) {
          event.preventDefault();
          entry.adjust(event.key === "ArrowRight" ? 1 : -1);
          this.refreshEntries();
        }
```

5. Replace `runSelected()` and the row click handler body with keep-open awareness:

```ts
  private runSelected(): void {
    const entry = this.matches[this.selected];
    if (entry === undefined || entry.unavailable !== undefined) return;
    if (entry.keepOpen === true) {
      entry.run();
      this.refreshEntries();
    } else {
      this.close();
      entry.run();
    }
  }
```

and in `renderList()`'s click listener:

```ts
        row.addEventListener("click", () => {
          if (entry.keepOpen === true) {
            entry.run();
            this.refreshEntries();
          } else {
            this.close();
            entry.run();
          }
        });
```

6. Add:

```ts
  /** Re-pulls entries so hints show updated values, keeping the selection. */
  private refreshEntries(): void {
    const selected = this.selected;
    this.entries = this.provider(this.mode);
    this.filter();
    this.selected = Math.min(selected, Math.max(0, this.matches.length - 1));
    this.renderList();
  }
```

- [ ] **Step 2: Provide settings entries + command in AppShell**

Extend the `../app/preferences` import in `app-shell.ts` with `fontLabel`, `FONT_FAMILIES`, `UI_FONT_SIZE`, `defaultPreferences` (some already imported in Task 9). In `paletteEntries()` (line 724), first line:

```ts
    if (mode === "settings") return this.settingsEntries();
```

New method:

```ts
  private settingsEntries(): PaletteEntry[] {
    const cycleFont = (key: "ui_font_family" | "plot_font_family"): void => {
      const index = FONT_FAMILIES.indexOf(this.prefs[key]);
      const next = FONT_FAMILIES[(index + 1) % FONT_FAMILIES.length] ?? "inter";
      this.updatePreferences({ [key]: next });
    };
    const sizeEntry = (
      title: string,
      key: "ui_font_size" | "plot_font_size",
      step: number,
    ): PaletteEntry => ({
      title,
      hint: `${String(this.prefs[key])}px`,
      keepOpen: true,
      run: () => {
        this.updatePreferences({ [key]: this.prefs[key] + step });
      },
      adjust: (direction) => {
        this.updatePreferences({ [key]: this.prefs[key] + direction * step });
      },
    });
    return [
      {
        title: "Theme",
        hint: this.workspace.theme(),
        keepOpen: true,
        run: () => {
          this.toggleTheme();
        },
      },
      {
        title: "UI font",
        hint: fontLabel(this.prefs.ui_font_family),
        keepOpen: true,
        run: () => {
          cycleFont("ui_font_family");
        },
      },
      {
        title: "Plot font",
        hint: fontLabel(this.prefs.plot_font_family),
        keepOpen: true,
        run: () => {
          cycleFont("plot_font_family");
        },
      },
      sizeEntry("UI font size", "ui_font_size", UI_FONT_SIZE.step),
      sizeEntry("Plot font size", "plot_font_size", PLOT_FONT_SIZE.step),
      {
        title: "Reset appearance to defaults",
        hint: "",
        keepOpen: true,
        run: () => {
          const defaults = defaultPreferences();
          this.updatePreferences({
            ui_font_family: defaults.ui_font_family,
            plot_font_family: defaults.plot_font_family,
            ui_font_size: defaults.ui_font_size,
            plot_font_size: defaults.plot_font_size,
          });
        },
      },
    ];
  }
```

Register the command in `registerCommands()`:

```ts
    this.commands.register({
      id: "open-settings",
      title: "Settings…",
      keys: "mod+,",
      section: "view",
      group: "display",
      run: () => {
        this.palette?.open("settings");
      },
    });
```

- [ ] **Step 3: Verify + gate**

Run: `./scripts/test.sh frontend`, then manually: ctrl+, opens the settings list; Enter on "Plot font" cycles families and axis text changes typeface immediately; ArrowRight on "UI font size" grows the chrome; the hint values update in place; theme cycling from settings is undoable (ctrl+z after closing).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/ui/command-palette.ts frontend/src/ui/app-shell.ts
git commit -m "feat(settings): palette settings mode behind mod+comma"
```

---

### Task 13: Palette frecency

**Files:**
- Create: `frontend/src/app/frecency.ts`
- Create: `frontend/src/app/frecency.test.ts`
- Modify: `frontend/src/ui/app-shell.ts` (usage field, `onRun` hook, `paletteEntries` ranking)

**Interfaces:**
- Consumes: `CommandRegistry.onRun` (Task 8).
- Produces: `class CommandUsage { constructor(storage: Pick<Storage, "getItem" | "setItem"> | null, now: () => number); record(id: string): void; score(id: string): number; }` (score = `count * 0.5 ** (ageMs / week)`, 0 for unknown ids; max 50 tracked ids, least-recently-used evicted) and `browserStorage(): Pick<Storage, "getItem" | "setItem"> | null`.

- [ ] **Step 1: Write failing tests**

`frontend/src/app/frecency.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CommandUsage } from "./frecency";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("CommandUsage", () => {
  it("scores unknown commands as zero", () => {
    const usage = new CommandUsage(memoryStorage(), () => 0);
    expect(usage.score("undo")).toBe(0);
  });

  it("counts runs and persists them", () => {
    const storage = memoryStorage();
    const usage = new CommandUsage(storage, () => 1000);
    usage.record("undo");
    usage.record("undo");
    usage.record("redo");
    const reloaded = new CommandUsage(storage, () => 1000);
    expect(reloaded.score("undo")).toBe(2);
    expect(reloaded.score("redo")).toBe(1);
  });

  it("halves the score per week of disuse", () => {
    let now = 0;
    const usage = new CommandUsage(memoryStorage(), () => now);
    usage.record("undo");
    usage.record("undo");
    now = WEEK_MS;
    expect(usage.score("undo")).toBeCloseTo(1, 5);
  });

  it("evicts the least recently used beyond 50 ids", () => {
    let now = 0;
    const usage = new CommandUsage(memoryStorage(), () => now);
    for (let index = 0; index < 51; index += 1) {
      now = index;
      usage.record(`command-${String(index)}`);
    }
    expect(usage.score("command-0")).toBe(0);
    expect(usage.score("command-50")).toBeGreaterThan(0);
  });

  it("survives a null or throwing storage", () => {
    const usage = new CommandUsage(null, () => 0);
    usage.record("undo");
    expect(usage.score("undo")).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/frecency.test.ts`
Expected: FAIL — `./frecency` not found.

- [ ] **Step 3: Implement `frontend/src/app/frecency.ts`**

```ts
const STORAGE_KEY = "signalscope.command-usage.v1";
const MAX_TRACKED = 50;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

interface UsageRecord {
  count: number;
  lastUsed: number;
}

type UsageTable = Record<string, UsageRecord>;

/** localStorage when available; storage access can throw in locked-down
 *  webviews, and frecency is disposable, so failures degrade to null. */
export function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Disposable command-usage ranking for the palette. Deliberately not part
 * of the preferences file: it is a cache, not user state (ADR 0023).
 */
export class CommandUsage {
  private table: UsageTable | null = null;

  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null,
    private readonly now: () => number,
  ) {}

  record(id: string): void {
    const table = this.load();
    const entry = table[id] ?? { count: 0, lastUsed: 0 };
    table[id] = { count: entry.count + 1, lastUsed: this.now() };
    const ids = Object.keys(table);
    if (ids.length > MAX_TRACKED) {
      ids.sort((a, b) => (table[a]?.lastUsed ?? 0) - (table[b]?.lastUsed ?? 0));
      for (const stale of ids.slice(0, ids.length - MAX_TRACKED)) {
        delete table[stale];
      }
    }
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(table));
    } catch {
      // Storage full or unavailable; in-memory ranking still works.
    }
  }

  /** Use-count halved for every week since last use; 0 for unknown ids. */
  score(id: string): number {
    const entry = this.load()[id];
    if (entry === undefined) return 0;
    const age = Math.max(0, this.now() - entry.lastUsed);
    return entry.count * 0.5 ** (age / HALF_LIFE_MS);
  }

  private load(): UsageTable {
    if (this.table === null) {
      try {
        const raw = this.storage?.getItem(STORAGE_KEY);
        this.table = raw == null ? {} : (JSON.parse(raw) as UsageTable);
      } catch {
        this.table = {};
      }
    }
    return this.table;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @signalscope/frontend exec vitest run src/app/frecency.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into AppShell**

1. Import: `import { browserStorage, CommandUsage } from "../app/frecency";`
2. Field: `private readonly usage = new CommandUsage(browserStorage(), () => Date.now());`
3. In `mount()` right after `this.registerCommands();` (line 271):

```ts
    this.commands.onRun = (id) => {
      this.usage.record(id);
    };
```

4. In `paletteEntries()` (line 727), rank commands before mapping — replace `const commands = this.commands.listAll().map((command) => ({` with:

```ts
    const ranked = [...this.commands.listAll()].sort(
      (left, right) => this.usage.score(right.id) - this.usage.score(left.id),
    );
    const commands = ranked.map((command) => ({
```

(Sort is stable, so zero-score commands keep registration order; with a query, `fuzzyScore` dominates in `CommandPalette.filter` and this order breaks ties.)

- [ ] **Step 6: Full frontend gate + commit**

Run: `./scripts/test.sh frontend` — PASS. Manually: run "Toggle theme" twice from the palette, reopen ctrl+shift+p — it now sits at the top with an empty query.

```bash
git add frontend/src/app/frecency.ts frontend/src/app/frecency.test.ts frontend/src/ui/app-shell.ts
git commit -m "feat(palette): frecency ranking for commands"
```

---

### Task 14: End-to-end tests

**Files:**
- Create: `frontend/tests/e2e/settings-and-undo.spec.ts`

**Interfaces:**
- Consumes: everything shipped in Tasks 5–13; the e2e host is the baked demo plane (prefs port null — in-memory settings only, which these tests rely on).

- [ ] **Step 1: Read the house style**

Read `frontend/tests/e2e/workbench.spec.ts` and `fixtures.ts`; new tests import `{ expect, test } from "./fixtures"` and start with `await page.goto("/")`.

- [ ] **Step 2: Write the tests**

`frontend/tests/e2e/settings-and-undo.spec.ts`:

```ts
import { expect, test } from "./fixtures";

test("ctrl+z undoes and ctrl+y redoes a panel split", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(1);

  await page.keyboard.press("Control+y");
  await expect(page.locator(".panel")).toHaveCount(2);

  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".panel")).toHaveCount(2);
});

test("ctrl+z in a text field edits text, not the workspace", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("n");
  await expect(page.locator(".panel")).toHaveCount(2);

  const search = page.locator(".signal-search");
  await search.click();
  await search.fill("velocity");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".panel")).toHaveCount(2);
});

test("settings palette adjusts fonts and sizes in place", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+Comma");
  const palette = page.locator(".palette");
  await expect(palette).toBeVisible();
  await expect(palette.locator(".palette-row")).toHaveCount(6);

  const plotFont = palette.locator(".palette-row", { hasText: "Plot font" }).first();
  await expect(plotFont.locator(".palette-hint")).toHaveText("JetBrains Mono");

  const uiSize = palette.locator(".palette-row", { hasText: "UI font size" });
  await expect(uiSize.locator(".palette-hint")).toHaveText("13px");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowDown");
  await page.locator(".palette-input").press("ArrowRight");
  await expect(uiSize.locator(".palette-hint")).toHaveText("14px");
  await expect(page.locator(":root")).toHaveCSS("font-size", "14px");

  await page.keyboard.press("Escape");
});

test("ctrl+= scales plot text and ctrl+0 resets", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+Equal");
  await page.keyboard.press("Control+Equal");

  await page.keyboard.press("Control+Comma");
  const plotSize = page.locator(".palette-row", { hasText: "Plot font size" });
  await expect(plotSize.locator(".palette-hint")).toHaveText("10px");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Digit0");
  await page.keyboard.press("Control+Comma");
  await expect(plotSize.locator(".palette-hint")).toHaveText("9px");
});
```

Adapt selectors/counts only if the running app disagrees (e.g. the settings row count if entries changed); keep the assertions' intent.

- [ ] **Step 3: Run the e2e suite**

Run: `./scripts/test.sh e2e`
Expected: PASS (existing specs stay green — especially `workbench.spec.ts`, which exercises keys near the new bindings).

- [ ] **Step 4: Commit**

```bash
git add frontend/tests/e2e/settings-and-undo.spec.ts
git commit -m "test(e2e): undo/redo, settings palette, plot font shortcuts"
```

---

### Task 15: ADR + full CI gate

**Files:**
- Create: `docs/adr/0023-global-preferences-file.md` (confirm the next free number with `ls docs/adr/`)

**Interfaces:** none — documentation and verification.

- [ ] **Step 1: Write the ADR**

Follow the format of `docs/adr/0022-durable-session-persistence.md` (read it first). Content to cover:

```markdown
# 0023 — Global preferences file

Status: accepted
Date: 2026-07-28

## Context

ADR 0022 made the per-workspace session the only durable store; theme lives
there. The design handoff (Audit v2, "Global preferences … persist across
sessions") calls for appearance settings that follow the user, not the
workspace. Font family/size preferences forced the decision.

## Decision

Appearance preferences (UI font family/size, plot font family/size) persist
in `preferences.json` in the app data dir, governed by a dedicated versioned
schema (`protocol/schema/scope-preferences.json`, codegen per ADR 0004,
migration ladder per ADR 0005, atomic writes per ADR 0022). The frontend
reaches it through a nullable `preferences` DataPlane port; the baked
snapshot host keeps in-memory defaults. Load failures and future schema
versions fall back to defaults without rewriting the stored file.
Command-usage frecency stays in localStorage: it is a disposable cache, not
user state. Theme remains in the session for now; migrating it to global
preferences is an open follow-up.

## Consequences

Two durable stores exist with a clear split: session = workspace state,
preferences = user appearance. Every prefs schema change needs a schema
bump, migration rung, and TS↔Rust conformance fixture, like the session.
```

- [ ] **Step 2: Run the complete local quality gate**

Run: `./scripts/ci.sh all`
Expected: PASS — format, quality, rust (clippy + full cargo test including the shell), frontend, e2e.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0023-global-preferences-file.md
git commit -m "docs(adr): global preferences file"
```

---

## Self-review notes (already applied)

- Spec coverage: prefs layer (T1–T4, T9), fonts (T5–T7), shortcuts (T8–T9), undo (T10–T11), settings palette (T12), frecency (T13), tests (throughout + T14), ADR (T15). The spec's "planned `font-size` entry replaced" lands in T9; the editing-guard fix in T11.
- `FontFamily` variants are single words (not the spec's illustrative `dejavu-sans` strings) because the codegen cannot emit hyphenated enum variants; the TS `FONT_META` table carries the human labels and CSS stacks.
- Type consistency: `PreferencesTarget`, `updatePreferences(patch)`, `commitHistory(coalesceKey?)`, `applyHistory(session | null)`, `PaletteEntry.keepOpen/adjust`, `CommandUsage(storage, now)` are each defined once and consumed with the same signatures in later tasks.
