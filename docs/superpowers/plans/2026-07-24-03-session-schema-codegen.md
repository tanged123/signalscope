# Session Schema Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the session schema through the same schema→codegen pipeline as the protocol (both shared Rust↔TS schemas evolve from one source), extend the generator with the constructs session needs (enums, `f32`/`u8`, fixed pairs, camelCase wire names), replace the session version gate with a real migration ladder, and delete the hand-maintained duplicate time types in the frontend.

**Architecture:** A second schema file `protocol/schema/scope-session.json` is the single source for session shapes; the generator emits `core/scope-core/src/session/generated.rs` and `frontend/src/generated/session.ts`. The hand-written `session.rs` keeps only behavior: `Default` impls, the app/version envelope check, and a `migrate(version, value)` ladder per ADR 0005. `frontend/src/app/linked-time.ts` imports its types from generated code instead of re-declaring them.

**Tech Stack:** Node ESM codegen script, serde, TypeScript 5.9.

## Global Constraints

- **Depends on Plan 01** (module layout `core/scope-core/src/session.rs`). Run after Plan 02 where possible; if run in parallel, regenerate (`pnpm codegen`) after rebasing so generated files converge.
- Run commands via `./scripts/` wrappers; `pnpm` via `./scripts/dev.sh pnpm …` when outside the dev shell.
- The session **wire format must not change**: lowercase enum values, `cursorT` field name, same field set. The round-trip test in `session.rs` is the guard — it must pass unmodified except for renamed version-constant references.
- Generated files are committed; never hand-edit them; `pnpm codegen:check` must stay green.
- clippy pedantic + `-D warnings`; commit messages lowercase imperative.

---

### Task 1: Generator v2 — multi-schema, enums, new primitives

**Files:**

- Modify: `protocol/scripts/generate-types.mjs` (full rewrite below), `package.json` (root, `codegen:check` script)
- Create: `protocol/schema/scope-session.json`
- Generate: `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`
- Regenerate (must be byte-identical): `protocol/src/generated.rs`, `frontend/src/generated/protocol.ts`

**Interfaces:**

- Produces: Rust `scope_core::session::generated::{SESSION_SCHEMA_VERSION, Session, Theme, LinkedTime, TimeMode, PanelState, PanelMode, AxisStyle, SeriesState, DashStyle, Annotation}`; TS `frontend/src/generated/session.ts` exporting the same names as interfaces/string-literal unions. Schema DSL additions: `kind: "enum"` with `variants` + optional `default`; primitives `f32`, `u8`; fixed pair `f64[2]`; camelCase field names emit `#[serde(rename = …)]` with a snake_case Rust field.

- [ ] **Step 1: Write the session schema** — `protocol/schema/scope-session.json` (mirrors the current `session.rs` wire format exactly):

```json
{
  "schema_version": 1,
  "types": {
    "Theme": {
      "kind": "enum",
      "variants": ["dark", "light"],
      "default": "dark"
    },
    "TimeMode": {
      "kind": "enum",
      "variants": ["fixed", "follow"],
      "default": "fixed"
    },
    "PanelMode": {
      "kind": "enum",
      "variants": ["time", "xy", "fft", "histogram"]
    },
    "AxisStyle": { "kind": "enum", "variants": ["gutter", "inline"] },
    "DashStyle": { "kind": "enum", "variants": ["solid", "dash", "dot"] },
    "LinkedTime": {
      "kind": "object",
      "fields": {
        "t0": "f64",
        "t1": "f64",
        "linked": "bool",
        "paused": "bool",
        "cursorT": "f64?",
        "mode": "TimeMode"
      }
    },
    "SeriesState": {
      "kind": "object",
      "fields": {
        "path": "string",
        "color_slot": "u8",
        "dash": "DashStyle",
        "width": "f32",
        "visible": "bool"
      }
    },
    "Annotation": {
      "kind": "object",
      "fields": {
        "id": "string",
        "series_path": "string",
        "time": "f64",
        "value": "f64",
        "label": "string"
      }
    },
    "PanelState": {
      "kind": "object",
      "fields": {
        "id": "string",
        "title": "string",
        "mode": "PanelMode",
        "axis_style": "AxisStyle",
        "x_signal": "string?",
        "color_signal": "string?",
        "series": "SeriesState[]",
        "y_range": "f64[2]?",
        "annotations": "Annotation[]",
        "show_stats": "bool"
      }
    },
    "Session": {
      "kind": "object",
      "fields": {
        "app": "string",
        "schema_version": "u32",
        "theme": "Theme",
        "linked_time": "LinkedTime",
        "focused_panel_id": "string?",
        "panels": "PanelState[]"
      }
    }
  }
}
```

- [ ] **Step 2: Rewrite the generator** — replace `protocol/scripts/generate-types.mjs` in full:

```js
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");

const jobs = [
  {
    schema: "protocol/schema/scope-protocol.json",
    versionKey: "protocol_version",
    versionConst: "PROTOCOL_VERSION",
    rust: "protocol/src/generated.rs",
    ts: "frontend/src/generated/protocol.ts",
  },
  {
    schema: "protocol/schema/scope-session.json",
    versionKey: "schema_version",
    versionConst: "SESSION_SCHEMA_VERSION",
    rust: "core/scope-core/src/session/generated.rs",
    ts: "frontend/src/generated/session.ts",
  },
];

const primitiveRust = {
  bool: "bool",
  f32: "f32",
  f64: "f64",
  string: "String",
  u8: "u8",
  u32: "u32",
  u64: "u64",
};

const primitiveTypeScript = {
  bool: "boolean",
  f32: "number",
  f64: "number",
  string: "string",
  u8: "number",
  u32: "number",
  u64: "string",
};

const rustForms = {
  array: (value) => `Vec<${value}>`,
  optional: (value) => `Option<${value}>`,
  pair: (value) => `[${value}; 2]`,
};

const typeScriptForms = {
  array: (value) => `${value}[]`,
  optional: (value) => `${value} | null`,
  pair: (value) => `[${value}, ${value}]`,
};

function convertType(type, primitives, forms) {
  if (type.endsWith("?")) {
    return forms.optional(convertType(type.slice(0, -1), primitives, forms));
  }
  if (type.endsWith("[2]")) {
    return forms.pair(convertType(type.slice(0, -3), primitives, forms));
  }
  if (type.endsWith("[]")) {
    return forms.array(convertType(type.slice(0, -2), primitives, forms));
  }
  return primitives[type] ?? type;
}

function snakeCase(name) {
  return name.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function pascalCase(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const u64Helpers = `mod u64_string {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    #[allow(clippy::trivially_copy_pass_by_ref)]
    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?.parse().map_err(D::Error::custom)
    }
}

mod u64_vec_string {
    use serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S>(values: &[u64], serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        values.iter().map(ToString::to_string).collect::<Vec<_>>().serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Vec::<String>::deserialize(deserializer)?.into_iter().map(|value| value.parse().map_err(D::Error::custom)).collect()
    }
}
`;

for (const job of jobs) {
  const schema = JSON.parse(
    await readFile(resolve(repositoryRoot, job.schema), "utf8"),
  );

  const fieldTypes = Object.values(schema.types)
    .filter((definition) => definition.kind === "object")
    .flatMap((definition) => Object.values(definition.fields));
  const usesU64 = fieldTypes.some((type) => type === "u64" || type === "u64[]");

  const rust = [
    "// @generated by protocol/scripts/generate-types.mjs. Do not edit.",
    "",
    "use serde::{Deserialize, Serialize};",
    "",
    `pub const ${job.versionConst}: u32 = ${schema[job.versionKey]};`,
    "",
  ];
  if (usesU64) {
    rust.push(u64Helpers);
  }

  const typeScript = [
    "// @generated by protocol/scripts/generate-types.mjs. Do not edit.",
    "",
    `export const ${job.versionConst} = ${schema[job.versionKey]} as const;`,
    "",
  ];

  for (const [name, definition] of Object.entries(schema.types)) {
    if (definition.kind === "enum") {
      emitEnum(rust, typeScript, name, definition);
    } else if (definition.kind === "object") {
      emitObject(rust, typeScript, name, definition);
    } else {
      throw new Error(`Unsupported schema kind: ${definition.kind}`);
    }
  }

  await writeFile(
    resolve(repositoryRoot, job.rust),
    `${rust.join("\n").trimEnd()}\n`,
  );
  await writeFile(
    resolve(repositoryRoot, job.ts),
    `${typeScript.join("\n").trimEnd()}\n`,
  );
}

function emitEnum(rust, typeScript, name, definition) {
  const derives = definition.default === undefined ? "" : "Default, ";
  rust.push(
    `#[derive(Clone, Copy, Debug, ${derives}Eq, PartialEq, Deserialize, Serialize)]`,
    '#[serde(rename_all = "lowercase")]',
    `pub enum ${name} {`,
  );
  for (const variant of definition.variants) {
    if (variant === definition.default) {
      rust.push("    #[default]");
    }
    rust.push(`    ${pascalCase(variant)},`);
  }
  rust.push("}", "");
  typeScript.push(
    `export type ${name} = ${definition.variants
      .map((variant) => `"${variant}"`)
      .join(" | ")};`,
    "",
  );
}

function emitObject(rust, typeScript, name, definition) {
  rust.push("#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]");
  rust.push(`pub struct ${name} {`);
  typeScript.push(`export interface ${name} {`);
  for (const [field, type] of Object.entries(definition.fields)) {
    const rustField = snakeCase(field);
    if (type.endsWith("?")) {
      rust.push("    #[serde(default)]");
    }
    if (type === "u64") {
      rust.push('    #[serde(with = "u64_string")]');
    } else if (type === "u64[]") {
      rust.push('    #[serde(with = "u64_vec_string")]');
    }
    if (rustField !== field) {
      rust.push(`    #[serde(rename = "${field}")]`);
    }
    rust.push(
      `    pub ${rustField}: ${convertType(type, primitiveRust, rustForms)},`,
    );
    typeScript.push(
      `  ${field}: ${convertType(type, primitiveTypeScript, typeScriptForms)};`,
    );
  }
  rust.push("}", "");
  typeScript.push("}", "");
}
```

- [ ] **Step 3: Regenerate and check the protocol output is unchanged**

Run: `./scripts/dev.sh pnpm codegen`
Then: `./scripts/dev.sh rustfmt --edition 2021 protocol/src/generated.rs core/scope-core/src/session/generated.rs`
Then: `git diff protocol/src/generated.rs frontend/src/generated/protocol.ts`
Expected: **zero diff** on both protocol files after rustfmt (the committed Rust file is rustfmt'd by `codegen:check`, so compare post-format). If only blank-line differences remain, adjust the generator's string joins until the protocol output is byte-identical — the protocol wire types must not change in this plan. Two new files exist: `core/scope-core/src/session/generated.rs`, `frontend/src/generated/session.ts`.

- [ ] **Step 4: Rewire `session.rs` to consume the generated types**

In `core/scope-core/src/session.rs`:

1. Delete `pub const CURRENT_SCHEMA_VERSION: u32 = 1;` and every type definition: `Session`, `Theme`, `LinkedTime`, `TimeMode`, `PanelState`, `PanelMode`, `AxisStyle`, `SeriesState`, `DashStyle`, `Annotation` (structs, enums, and their derive attributes — but NOT the `Default` impls for `Session` and `LinkedTime`, which stay).

2. At the top, after the module doc comment, add:

```rust
mod generated;

pub use generated::*;
```

(Rust resolves `mod generated;` inside `session.rs` to `session/generated.rs`.)

3. The two kept `Default` impls reference generated types unchanged; in `impl Default for Session`, change `schema_version: CURRENT_SCHEMA_VERSION` to `schema_version: SESSION_SCHEMA_VERSION`.

4. In `from_json`, change the match arm `CURRENT_SCHEMA_VERSION => …` to `SESSION_SCHEMA_VERSION => …` (Task 2 restructures this function anyway).

- [ ] **Step 5: Extend the codegen check to the new files**

In root `package.json`, replace the `codegen:check` script with:

```json
"codegen:check": "pnpm codegen && rustfmt --edition 2021 protocol/src/generated.rs core/scope-core/src/session/generated.rs && git diff --exit-code -- protocol/src/generated.rs core/scope-core/src/session/generated.rs frontend/src/generated/protocol.ts frontend/src/generated/session.ts"
```

- [ ] **Step 6: Run the gates**

Run: `./scripts/ci.sh rust` — Expected: PASS; the session tests `current_session_round_trips` and `future_version_is_rejected` pass against generated types, proving the wire format did not move.
Run: `./scripts/test.sh frontend` — Expected: PASS, including `codegen:check`.

- [ ] **Step 7: Commit**

```bash
git add protocol/scripts/generate-types.mjs protocol/schema/scope-session.json \
  core/scope-core/src/session.rs core/scope-core/src/session/generated.rs \
  frontend/src/generated/session.ts package.json
git commit -m "generate session schema types for both hosts"
```

---

### Task 2: Session migration ladder

**Files:**

- Modify: `core/scope-core/src/session.rs`

**Interfaces:**

- Produces: `from_json` unchanged in signature; private `migrate(version: u32, value: serde_json::Value) -> Result<Session, SessionError>` — the seam ADR 0005 promises, with a v1 identity rung.

- [ ] **Step 1: Write the failing test** (in `session.rs` tests — a shape the gate can't express: the ladder must receive the _parsed value_, not re-parse the string)

```rust
#[test]
fn migrate_is_the_single_dispatch_point() {
    let json = serde_json::to_string(&Session::default()).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let session = migrate(SESSION_SCHEMA_VERSION, value).unwrap();
    assert_eq!(session, Session::default());
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./scripts/test.sh core`
Expected: FAIL — `cannot find function 'migrate'`.

- [ ] **Step 3: Restructure `from_json` around the ladder**

Replace the existing `from_json` with:

```rust
/// Deserializes and validates a `SignalScope` session.
///
/// # Errors
///
/// Returns [`SessionError`] when the JSON is malformed, belongs to another
/// application, or uses an unsupported schema version.
pub fn from_json(json: &str) -> Result<Session, SessionError> {
    #[derive(Deserialize)]
    struct Head {
        app: String,
        schema_version: u32,
    }

    let value: serde_json::Value = serde_json::from_str(json)?;
    let head: Head = Head::deserialize(&value)?;
    if head.app != "signalscope" {
        return Err(SessionError::WrongApplication(head.app));
    }
    migrate(head.schema_version, value)
}

/// Migration ladder (ADR 0005): each arm upgrades `value` one schema
/// version and falls through to the next; the current version
/// deserializes directly. To add v(N+1): bump `schema_version` in
/// `protocol/schema/scope-session.json`, regenerate, then add an arm here
/// that rewrites a vN `value` into vN+1 shape and recurses.
fn migrate(version: u32, value: serde_json::Value) -> Result<Session, SessionError> {
    match version {
        SESSION_SCHEMA_VERSION => Ok(serde_json::from_value(value)?),
        version => Err(SessionError::UnsupportedVersion(version)),
    }
}
```

(`Head::deserialize(&value)` needs `use serde::Deserialize;` which the file already has.)

- [ ] **Step 4: Run the tests**

Run: `./scripts/test.sh core`
Expected: PASS — the new test plus `current_session_round_trips` and `future_version_is_rejected` (which now exercises the ladder's reject rung).

- [ ] **Step 5: Commit**

```bash
git add core/scope-core/src/session.rs
git commit -m "replace session version gate with a migration ladder"
```

---

### Task 3: Delete the frontend's hand-maintained duplicate types

**Files:**

- Modify: `frontend/src/app/linked-time.ts`, `frontend/src/app/linked-time.test.ts` (only if it imports the deleted local types by name)

**Interfaces:**

- Consumes: `TimeWindow` from `../generated/protocol`; `LinkedTime`, `TimeMode` from `../generated/session`.
- Produces: `linked-time.ts` re-exports `type LinkedTimeState = LinkedTime` so existing importers (`app-shell.ts`, tests) keep compiling. Plan 05 later simplifies the model class itself — this task touches only the type declarations.

- [ ] **Step 1: Replace the local declarations**

In `frontend/src/app/linked-time.ts`, delete these three declarations:

```ts
export type TimeMode = "fixed" | "follow";

export interface TimeWindow {
  t0: number;
  t1: number;
}

export interface LinkedTimeState extends TimeWindow {
  linked: boolean;
  cursorT: number | null;
  mode: TimeMode;
  paused: boolean;
}
```

and replace them with:

```ts
import type { TimeWindow } from "../generated/protocol";
import type { LinkedTime, TimeMode } from "../generated/session";

export type { TimeMode, TimeWindow };
export type LinkedTimeState = LinkedTime;
```

The generated `LinkedTime` has fields `t0`, `t1`, `linked`, `paused`, `cursorT`, `mode` — the identical shape, now from the single source. The rest of the file (the `LinkedTimeModel` class) is unchanged.

- [ ] **Step 2: Run the frontend checks**

Run: `./scripts/test.sh frontend`
Expected: PASS — typecheck proves the generated shape really is identical.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/linked-time.ts frontend/src/app/linked-time.test.ts
git commit -m "source linked-time types from the generated session schema"
```

---

### Task 4: ADR 0005 amendment + full gate

**Files:**

- Modify: `docs/adr/0005-session-schema-versioning.md`

- [ ] **Step 1: Append the amendment**

```markdown
## Amendment (2026-07-24)

The session schema is now source-of-truth'd in
`protocol/schema/scope-session.json` and generated into both hosts by the
same script as the protocol (ADR 0004), eliminating hand-maintained
duplicates of session shapes in TypeScript. Deserialization dispatches
through a `migrate(version, value)` ladder with a v1 identity rung; every
schema bump adds one rung and one migration test.
```

- [ ] **Step 2: Run `./scripts/ci.sh all`** — Expected: all stages PASS.

- [ ] **Step 3: Commit and hand off**

```bash
git add docs/adr/0005-session-schema-versioning.md
git commit -m "record session codegen and migration ladder in adr 0005"
```
