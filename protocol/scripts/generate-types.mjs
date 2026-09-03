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
  {
    schema: "protocol/schema/scope-preferences.json",
    versionKey: "schema_version",
    versionConst: "PREFERENCES_SCHEMA_VERSION",
    rust: "core/scope-core/src/preferences/generated.rs",
    ts: "frontend/src/generated/preferences.ts",
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

const RUST_KEYWORDS = new Set([
  "Self",
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "crate",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

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
  array: (value) => (value.includes(" | ") ? `(${value})[]` : `${value}[]`),
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
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const u64ScalarHelper = `mod u64_string {
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
`;

const u64VectorHelper = `mod u64_vec_string {
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

const optionalU64Helper = `mod optional_u64_string {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    #[allow(clippy::ref_option)]
    pub fn serialize<S>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match value {
            Some(value) => serializer.serialize_some(&value.to_string()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<String>::deserialize(deserializer)?
            .map(|value| value.parse().map_err(D::Error::custom))
            .transpose()
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
  const usesU64 = fieldTypes.includes("u64");
  const usesU64Vector = fieldTypes.includes("u64[]");
  const usesOptionalU64 = fieldTypes.includes("u64?");

  const rust = [
    "// @generated by protocol/scripts/generate-types.mjs. Do not edit.",
    "",
    "use serde::{Deserialize, Serialize};",
    "",
    `pub const ${job.versionConst}: u32 = ${schema[job.versionKey]};`,
    "",
  ];
  if (usesU64) rust.push(u64ScalarHelper);
  if (usesU64Vector) rust.push(u64VectorHelper);
  if (usesOptionalU64) rust.push(optionalU64Helper);

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
  const rename = definition.variants.some((variant) => variant.includes("_"))
    ? "snake_case"
    : "lowercase";
  rust.push(
    `#[derive(Clone, Copy, Debug, ${derives}Eq, PartialEq, Deserialize, Serialize)]`,
    `#[serde(rename_all = "${rename}")]`,
    `pub enum ${name} {`,
  );
  for (const variant of definition.variants) {
    if (variant === definition.default) rust.push("    #[default]");
    rust.push(`    ${pascalCase(variant)},`);
  }
  rust.push("}", "");
  typeScript.push(
    `export type ${name} = ${definition.variants.map((variant) => `"${variant}"`).join(" | ")};`,
    "",
  );
}

function emitObject(rust, typeScript, name, definition) {
  rust.push("#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]");
  rust.push(`pub struct ${name} {`);
  typeScript.push(`export interface ${name} {`);
  for (const [field, type] of Object.entries(definition.fields)) {
    const rustField = rustIdentifier(field);
    if (
      type.includes("u64") &&
      type !== "u64" &&
      type !== "u64[]" &&
      type !== "u64?"
    ) {
      throw new Error(`${name}.${field}: unsupported u64 form "${type}"`);
    }
    if (type.endsWith("?")) rust.push("    #[serde(default)]");
    if (type === "u64") {
      rust.push('    #[serde(with = "u64_string")]');
    } else if (type === "u64[]") {
      rust.push('    #[serde(with = "u64_vec_string")]');
    } else if (type === "u64?") {
      rust.push('    #[serde(with = "optional_u64_string")]');
    }
    if (rustField !== field) rust.push(`    #[serde(rename = "${field}")]`);
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

function rustIdentifier(field) {
  const identifier = snakeCase(field);
  return RUST_KEYWORDS.has(identifier) ? `r#${identifier}` : identifier;
}
