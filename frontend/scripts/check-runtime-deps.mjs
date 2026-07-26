import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  if (
    packageJson[field] !== undefined &&
    Object.keys(packageJson[field]).length > 0
  ) {
    console.error(
      `frontend/package.json must not declare ${field}; portable snapshots have no runtime dependencies.`,
    );
    process.exitCode = 1;
  }
}

if (process.exitCode === undefined) {
  console.log("Frontend runtime dependency policy is satisfied.");
}
