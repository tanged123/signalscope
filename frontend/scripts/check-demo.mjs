import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoDirectory = resolve(scriptDirectory, "../../build/demo");
const htmlPath = resolve(demoDirectory, "demo.html");
const gifPath = resolve(demoDirectory, "demo.gif");
const maximumGifBytes = 2_829_205; // 15-second spike plus a 10% ratchet.
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

let gifBytes;
try {
  const gifDetails = await stat(gifPath);
  const gif = await readFile(gifPath);
  gifBytes = gifDetails.size;
  if (
    !gifDetails.isFile() ||
    gifBytes === 0 ||
    !["GIF87a", "GIF89a"].includes(gif.subarray(0, 6).toString("ascii"))
  ) {
    failures.push("demo.gif is not a valid GIF file");
  }
  if (gifBytes > maximumGifBytes) {
    failures.push(
      `demo GIF is ${gifBytes} bytes; budget is ${maximumGifBytes} bytes`,
    );
  }
} catch {
  failures.push("demo.gif is missing");
}

if (failures.length > 0) {
  throw new Error(`Demo artifact check failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `Demo artifacts are self-contained (${gifBytes.toLocaleString()} GIF bytes).`,
);
