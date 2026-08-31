import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoDirectory = resolve(scriptDirectory, "../../build/demo");
const htmlPath = resolve(demoDirectory, "demo.html");
const failures = [];

let html;
try {
  html = await readFile(htmlPath, "utf8");
} catch {
  failures.push("demo.html is missing");
}

if (html !== undefined) {
  if (!html.includes('id="signalscope-baked-data"')) {
    failures.push("baked data slot is missing");
  }
  if (/<(?:script|img|link)\b[^>]*(?:src|href)=/i.test(html)) {
    failures.push("external resource attributes remain");
  }
  if (/\bhttps?:\/\//i.test(html)) {
    failures.push("an HTTP URL remains");
  }
}

if (failures.length > 0) {
  throw new Error(`Demo artifact check failed:\n- ${failures.join("\n- ")}`);
}

console.log("Demo HTML is self-contained.");
