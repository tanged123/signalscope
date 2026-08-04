import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDir = join(root, "build", "bench", "report");

const names = (await readdir(reportDir).catch(() => []))
  .filter((name) => name.endsWith(".json"))
  .sort();
if (names.length === 0) {
  console.error(`no bench reports in ${reportDir}`);
  process.exitCode = 1;
} else {
  const entries = [];
  for (const name of names) {
    entries.push(JSON.parse(await readFile(join(reportDir, name), "utf8")));
  }
  const failed = entries
    .filter((entry) => entry.pass === false)
    .map((entry) => entry.bench);
  const report = { generated: new Date().toISOString(), entries };
  await writeFile(
    join(root, "build", "bench", "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `bench report: ${entries.length} entries -> build/bench/report.json`,
  );
  if (failed.length > 0) {
    console.error(`failing benches: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}
