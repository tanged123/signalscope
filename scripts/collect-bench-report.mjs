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
  const duplicateNames = entries
    .map((entry) => entry.bench)
    .filter((bench, index, all) => all.indexOf(bench) !== index);
  const required = [
    "cold_first_plot_ms",
    "coarse_first_ms",
    "refinement_ms",
    "upload_bytes",
    "resident_gpu_bytes",
    "draw_calls",
    "submitted_segments",
    "compact_segments",
    "selected_series",
    "successful_frames",
    "validation_errors",
    "visible_series",
    "series_with_segments",
    "frame_p50_ms",
    "frame_p95_ms",
    "frame_max_ms",
    "longest_task_ms",
    "pick_p95_ms",
    "device_recovery_ms",
    "resident_pan_upload_bytes",
    "resident_pan_descriptor_rebuilds",
  ];
  const invalid = entries.flatMap((entry) => {
    if (typeof entry.bench !== "string" || !entry.bench.startsWith("e2e_"))
      return [];
    const missing = required.filter((key) => typeof entry[key] !== "number");
    const nonfinite = required.filter(
      (key) => typeof entry[key] === "number" && !Number.isFinite(entry[key]),
    );
    return missing.length === 0 && nonfinite.length === 0
      ? []
      : [
          `${entry.bench}: missing/nonfinite ${[...missing, ...nonfinite].join(",")}`,
        ];
  });
  const invalidHardware = entries.flatMap((entry) => {
    if (entry.bench !== "electron_hardware") return [];
    const required = [
      "backend",
      "electron",
      "chromium",
      "adapter_vendor",
      "adapter_architecture",
      "adapter_device",
      "adapter_description",
      "software_rendering",
      "pass",
    ];
    const missing = required.filter((key) => !(key in entry));
    return missing.length === 0
      ? []
      : [`${entry.bench}: missing ${missing.join(",")}`];
  });
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
  if (
    duplicateNames.length > 0 ||
    invalid.length > 0 ||
    invalidHardware.length > 0 ||
    failed.length > 0
  ) {
    if (duplicateNames.length > 0)
      console.error(`duplicate benches: ${duplicateNames.join(", ")}`);
    if (invalid.length > 0) console.error(invalid.join("\n"));
    if (invalidHardware.length > 0) console.error(invalidHardware.join("\n"));
    console.error(`failing benches: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}
