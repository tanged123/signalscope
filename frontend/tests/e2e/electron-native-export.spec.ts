import { _electron as electron, expect, test } from "@playwright/test";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const electronPath = process.env.SIGNALSCOPE_ELECTRON_BIN;
const desktopPath = fileURLToPath(new URL("../../../desktop", import.meta.url));
const csvPath = fileURLToPath(
  new URL("fixtures/roundtrip.csv", import.meta.url),
);
const containerPath = fileURLToPath(
  new URL("../../../examples/containers/flight_run.h5", import.meta.url),
);
const recipePath = `${containerPath}.scope.toml`;

test("Electron reaches every native data and file capability", async () => {
  if (electronPath === undefined) {
    test.skip(true, "SIGNALSCOPE_ELECTRON_BIN is not configured");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "signalscope-native-"));
  const userData = join(root, "user-data");
  const sourceFolder = join(root, "source-folder");
  const sourceCopy = join(sourceFolder, "roundtrip.csv");
  const containerCopy = join(root, "flight_run.h5");
  const sessionPath = join(root, "workspace.signalscope");
  const htmlPath = join(root, "snapshot.html");
  const pngPath = join(root, "plot.png");
  const csvExportPath = join(root, "plot.csv");
  const directory = join(root, "exports");
  await mkdir(sourceFolder);
  await mkdir(directory);
  await copyFile(csvPath, sourceCopy);
  await copyFile(containerPath, containerCopy);
  const recipeText = await readFile(recipePath, "utf8");

  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const app = await electron.launch({
    executablePath: electronPath,
    args: [desktopPath, `--user-data-dir=${userData}`],
    env,
  });
  try {
    await app.evaluate(
      ({ dialog }, paths: Record<string, string>) => {
        dialog.showOpenDialog = (options) => {
          const properties = "properties" in options ? options.properties : [];
          const filePath = properties.includes("openDirectory")
            ? properties.includes("createDirectory")
              ? paths.directory
              : paths.sourceFolder
            : paths.source;
          return Promise.resolve({
            canceled: false,
            filePaths: [String(filePath)],
          });
        };
        dialog.showSaveDialog = (options) => {
          const defaultPath =
            "defaultPath" in options && typeof options.defaultPath === "string"
              ? options.defaultPath
              : "";
          const filePath = defaultPath.endsWith(".signalscope")
            ? paths.session
            : defaultPath.endsWith(".html")
              ? paths.html
              : defaultPath.endsWith(".csv")
                ? paths.csv
                : paths.png;
          return Promise.resolve({
            canceled: false,
            filePath: String(filePath),
          });
        };
      },
      {
        csv: csvExportPath,
        directory,
        html: htmlPath,
        png: pngPath,
        session: sessionPath,
        source: sourceCopy,
        sourceFolder,
      },
    );
    const page = await app.firstWindow();
    await expect(page).toHaveURL("http://127.0.0.1:4173/");

    const result = await page.evaluate(
      async ({
        container,
        recipeText,
        source,
        htmlDestination,
        pngDestination,
        csvDestination,
        directory,
      }) => {
        const modulePath = "/src/app/native-plane.ts";
        const { NativePlane } = await import(modulePath);
        const bridge = window.scopeDesktop;
        if (bridge === undefined) throw new Error("desktop bridge is absent");
        const plane = await NativePlane.create(bridge);
        const formats = await plane.ingest.listFormats();
        const picked = await plane.ingest.pickSources();
        const pickedFolder = await plane.ingest.pickSourceFolder();
        if (pickedFolder === null)
          throw new Error("source folder was not picked");
        const scan = await plane.ingest.scanSources(pickedFolder, false);
        const jobId = await plane.ingest.startBatch([source]);
        let status = await plane.ingest.batchStatus(jobId);
        for (
          let attempt = 0;
          attempt < 100 && status.state === "running";
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          status = await plane.ingest.batchStatus(jobId);
        }
        const detail = await plane.ingest.batchDetail(jobId, 0, 10);
        await plane.ingest.releaseBatch(jobId);
        const outline = await plane.ingest.introspect(container);
        const recipeResult = await plane.ingest.saveRecipe(
          container,
          recipeText,
          "user_directory",
        );
        const sources = await plane.listSources();
        const signals = await plane.listSignals();
        const signalId = signals[0]?.signal_id;
        if (signalId === undefined)
          throw new Error("native ingest returned no signal");
        const tiles = await plane.queryTiles({
          request_id: "native-parity-tiles",
          signal_ids: [signalId],
          window: { t0: 0, t1: 1 },
          pixel_width: 640,
        });
        const samples = await plane.querySamples({
          request_id: "native-parity-samples",
          signal_ids: [signalId],
          window: { t0: 0, t1: 1 },
          max_points: 64,
        });
        const derived = await plane.derived.create(
          "derived/native_double",
          `'${signals[0].path}' * 2`,
        );
        const bundle = await plane.derived.createBundle(
          "native_bundle",
          `'${signals[0].local_path}'`,
        );
        await plane.derived.remove("derived/native_double");
        await plane.derived.removeBundle("native_bundle");
        const session = await plane.session.reset();
        const sessionPath = await plane.session.save(
          session.session_json,
          null,
        );
        const loaded = await plane.session.load(sessionPath);
        const pickedSessionOpen = await plane.session.pick("open");
        const pickedSessionSave = await plane.session.pick("save");
        const restoreJob = await plane.restore.start(loaded.session_json);
        const restored = await plane.restore.reconcile(
          loaded.session_json,
          restoreJob,
        );
        const preferences = await plane.preferences.load();
        await plane.preferences.save(
          preferences ??
            JSON.stringify({
              schema_version: 4,
              theme: "dark",
              ui_font_family: "inter",
              plot_font_family: "jetbrains",
              ui_font_size: 13,
              plot_font_size: 9,
              cache_max_bytes: "21474836480",
              ingest_working_bytes: null,
              ingest_resident_bytes: null,
              recipe_directory: null,
            }),
        );
        const recipeDirectory =
          await plane.preferences.effectiveRecipeDirectory();
        const pickedRecipeDirectory =
          await plane.preferences.pickRecipeDirectory();
        const selection = {
          source_keys: sources.map(
            (source: { readonly source_key: string }) => source.source_key,
          ),
        };
        const estimate = await plane.exporter.estimate(
          session.session_json,
          selection,
        );
        await plane.exporter.writeHtml(
          session.session_json,
          "visible",
          "preview",
          selection,
        );
        await plane.exporter.saveFile(
          "plot.png",
          "png",
          new Uint8Array([137, 80, 78, 71]),
        );
        await plane.exporter.saveFile(
          "plot.csv",
          "csv",
          new TextEncoder().encode("time,value\n"),
        );
        const directoryFile = await plane.exporter.saveFileToDirectory(
          directory,
          "directory.csv",
          "csv",
          new TextEncoder().encode("time,value\n"),
        );
        return {
          bundleCreated: bundle.created.length,
          csv: csvDestination,
          derived: derived.path,
          directoryFile,
          detailEntries: detail.entries.length,
          estimateEntries: estimate.entries.length,
          formats: formats.length,
          html: htmlDestination,
          loaded: loaded.session_json === session.session_json,
          outlineDatasets: outline.datasets.length,
          picked: picked.length,
          pickedFolder,
          pickedSessionOpen,
          pickedSessionSave,
          pickedRecipeDirectory,
          recipeDirectory,
          recipeId: recipeResult.recipe_id,
          restored: restored.session_json.length > 0,
          samples: samples.series.length,
          scanFiles: scan.files.length,
          sessionPath,
          signals: signals.length,
          status: status.state,
          tiles: tiles.series.length,
          png: pngDestination,
        };
      },
      {
        container: containerCopy,
        csvDestination: csvExportPath,
        directory,
        htmlDestination: htmlPath,
        pngDestination: pngPath,
        recipeText,
        session: sessionPath,
        source: sourceCopy,
        sourceFolder,
      },
    );

    expect(result.status).toBe("done");
    expect(result.formats).toBeGreaterThan(0);
    expect(result.picked).toEqual([sourceCopy].length);
    expect(result.scanFiles).toBe(1);
    expect(result.outlineDatasets).toBeGreaterThan(0);
    expect(result.signals).toBeGreaterThan(0);
    expect(result.tiles).toBe(1);
    expect(result.samples).toBe(1);
    expect(result.derived).toBe("derived/native_double");
    expect(result.bundleCreated).toBeGreaterThan(0);
    expect(result.loaded).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.recipeId.length).toBeGreaterThan(0);
    expect(result.recipeDirectory.length).toBeGreaterThan(0);
    expect(result.pickedRecipeDirectory.length).toBeGreaterThan(0);
    expect(result.estimateEntries).toBeGreaterThan(0);
    expect(result.html).toBe(htmlPath);
    expect(result.png).toBe(pngPath);
    expect(result.csv).toBe(csvExportPath);
    expect(result.directoryFile).toBe(join(directory, "directory.csv"));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
