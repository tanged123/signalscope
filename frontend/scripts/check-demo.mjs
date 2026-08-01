import { spawnSync } from "node:child_process";
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
    gifBytes < 14 ||
    !["GIF87a", "GIF89a"].includes(gif.subarray(0, 6).toString("ascii")) ||
    gif.readUInt16LE(6) === 0 ||
    gif.readUInt16LE(8) === 0 ||
    gif.at(-1) !== 0x3b
  ) {
    failures.push("demo.gif is not a valid GIF file");
  }
  if (gifBytes > maximumGifBytes) {
    failures.push(
      `demo GIF is ${gifBytes} bytes; budget is ${maximumGifBytes} bytes`,
    );
  }

  const firstFrame = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      gifPath,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  if (firstFrame.status !== 0 || firstFrame.stdout.length === 0) {
    failures.push("demo.gif first frame could not be decoded");
  } else {
    let minimum = 255;
    let maximum = 0;
    for (const channel of firstFrame.stdout) {
      minimum = Math.min(minimum, channel);
      maximum = Math.max(maximum, channel);
    }
    if (maximum - minimum < 80) {
      failures.push("demo.gif begins with a blank frame");
    }
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
