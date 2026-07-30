import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

function fixed(value) {
  return value.toFixed(6);
}

function runCsv(run) {
  const partial = run === 8;
  const gain = 0.91 + run * 0.021;
  const damping = 0.62 + run * 0.035;
  const delay = 0.06 + run * 0.008;
  const bias = (run - 4.5) * 0.006;
  const lines = [
    partial ? "time,command,response" : "time,command,response,temperature",
  ];
  for (let sample = 0; sample <= 1_000; sample += 1) {
    const time = sample / 100;
    const command = time < 1 ? 0 : 1 + 0.2 * Math.sin((time - 1) * 0.8);
    const delayed = Math.max(0, time - 1 - delay);
    const response =
      bias +
      gain *
        (1 - Math.exp(-damping * delayed)) *
        (1 + 0.2 * Math.sin(Math.max(0, time - 1 - delay) * 0.8)) +
      0.008 * Math.sin(time * (11 + run * 0.7));
    const row = [fixed(time), fixed(command), fixed(response)];
    if (!partial) {
      row.push(
        fixed(
          21 +
            run * 0.18 +
            time * (0.55 + run * 0.015) +
            0.08 * Math.sin(time * 0.6 + run),
        ),
      );
    }
    lines.push(row.join(","));
  }
  return `${lines.join("\n")}\n`;
}

for (let run = 1; run <= 8; run += 1) {
  const path = resolve(
    root,
    "examples",
    "monte_carlo",
    `run_${String(run).padStart(2, "0")}.csv`,
  );
  const expected = runCsv(run);
  if (check) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) process.exitCode = 1;
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected);
  }
}
