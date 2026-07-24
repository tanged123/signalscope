import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(scriptDirectory, "../dist/snapshot-template.html");
const snapshot = await readFile(snapshotPath, "utf8");
const details = await stat(snapshotPath);
const maximumBytes = 750_000;

const failures = [];
if (!snapshot.includes('id="signalscope-baked-data"')) {
  failures.push("baked data slot is missing");
}
if (/<(?:script|img|link)\b[^>]*(?:src|href)=/i.test(snapshot)) {
  failures.push("external resource attributes remain");
}
if (/\bhttps?:\/\//i.test(snapshot)) {
  failures.push("an HTTP URL remains");
}
if (details.size > maximumBytes) {
  failures.push(
    `snapshot is ${details.size} bytes; budget is ${maximumBytes} bytes`,
  );
}

if (failures.length > 0) {
  throw new Error(
    `Snapshot artifact check failed:\n- ${failures.join("\n- ")}`,
  );
}

console.log(
  `Snapshot artifact is self-contained (${details.size.toLocaleString()} bytes).`,
);
