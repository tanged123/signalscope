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

  const required = [
    "cold_first_plot_ms",
    "coarse_first_ms",
    "refinement_ms",
    "upload_bytes",
    "resident_gpu_bytes",
    "resident_pages",
    "draw_calls",
    "draw_call_bound",
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
    "raf_interval_p95_ms",
    "raf_interval_max_ms",
    "longest_task_ms",
    "pick_count",
    "pick_p95_ms",
    "recovery_samples",
    "device_recovery_ms",
    "resident_pan_upload_bytes",
    "resident_pan_descriptor_rebuilds",
    "resident_pan_resident_bytes_before",
    "resident_pan_resident_bytes_after",
    "resident_pan_resident_pages_before",
    "resident_pan_resident_pages_after",
    "pre_plot_pixels",
    "post_recovery_pixels",
  ];
  const errors = [];

  const nonHardware = entries.filter(
    (entry) => entry.bench !== "electron_hardware",
  );
  const duplicateNames = nonHardware
    .map((entry) => entry.bench)
    .filter((bench, index, all) => all.indexOf(bench) !== index);
  if (duplicateNames.length > 0)
    errors.push(`duplicate benches: ${duplicateNames.join(", ")}`);

  const hardware = entries.find((entry) => entry.bench === "electron_hardware");
  const corpora = Array.isArray(hardware?.corpora)
    ? hardware.corpora
    : hardware === undefined
      ? []
      : [hardware];
  const requestedText = process.env.SIGNALSCOPE_BENCH_REQUESTED_TIERS;
  const requested =
    requestedText === undefined
      ? corpora.length > 0
        ? ["mc1000", "dense10k"]
        : []
      : requestedText === "all"
        ? ["mc1000", "dense10k"]
        : requestedText.split(",").filter((tier) => tier.length > 0);
  const corpusNames = corpora.map((entry) => entry.corpus_tier);
  const duplicateCorpora = corpusNames.filter(
    (tier, index, all) => all.indexOf(tier) !== index,
  );
  if (duplicateCorpora.length > 0)
    errors.push(`duplicate hardware corpora: ${duplicateCorpora.join(", ")}`);
  const missingCorpora = requested.filter(
    (tier) => !corpusNames.includes(tier),
  );
  if (missingCorpora.length > 0)
    errors.push(`missing hardware corpora: ${missingCorpora.join(", ")}`);

  const invalidHardware = corpora.flatMap((entry) => {
    const missing = [
      "corpus_tier",
      "backend",
      "electron",
      "chromium",
      "adapter_vendor",
      "adapter_architecture",
      "adapter_device",
      "adapter_description",
      "software_rendering",
      "pass",
    ].filter((key) => !(key in entry));
    const nonfinite = required.filter(
      (key) => typeof entry[key] !== "number" || !Number.isFinite(entry[key]),
    );
    const reasons = [];
    if (missing.length > 0) reasons.push(`missing ${missing.join(",")}`);
    if (nonfinite.length > 0)
      reasons.push(`missing/nonfinite ${nonfinite.join(",")}`);
    if (entry.pass === true && entry.backend !== "hardware")
      reasons.push("software/unsupported adapter marked pass");
    if (entry.pass === true && entry.pre_plot_pixels <= 0)
      reasons.push("blank pre-interaction plot pixels");
    if (entry.pass === true && entry.post_recovery_pixels <= 0)
      reasons.push("blank post-recovery plot pixels");
    if (entry.pass === true && entry.validation_errors !== 0)
      reasons.push("validation errors are present");
    if (entry.pass === true && entry.recovery_samples < 1)
      reasons.push("device recovery is absent");
    return reasons.length === 0
      ? []
      : [`${entry.corpus_tier ?? "unknown"}: ${reasons.join("; ")}`];
  });
  errors.push(...invalidHardware);

  const invalidGeneric = entries.flatMap((entry) => {
    if (typeof entry.bench !== "string" || !entry.bench.startsWith("e2e_"))
      return [];
    const missing = required.filter(
      (key) => typeof entry[key] !== "number" || !Number.isFinite(entry[key]),
    );
    return missing.length === 0
      ? []
      : [`${entry.bench}: missing/nonfinite ${missing.join(",")}`];
  });
  errors.push(...invalidGeneric);

  if (hardware !== undefined) {
    const expectedTopPass =
      corpora.length > 0 && corpora.every((entry) => entry.pass);
    if (hardware.pass !== expectedTopPass)
      errors.push(
        "electron_hardware top-level pass does not match its corpora",
      );
  }
  const failed = entries
    .filter((entry) => entry.pass === false)
    .map((entry) => entry.bench);
  const failedCorpora = corpora
    .filter((entry) => entry.pass === false)
    .map((entry) => `${entry.bench}:${entry.corpus_tier}`);
  if (failed.length > 0 || failedCorpora.length > 0)
    errors.push(`failing benches: ${[...failed, ...failedCorpora].join(", ")}`);

  const report = { generated: new Date().toISOString(), entries };
  await writeFile(
    join(root, "build", "bench", "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `bench report: ${entries.length} entries -> build/bench/report.json`,
  );
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  }
}
