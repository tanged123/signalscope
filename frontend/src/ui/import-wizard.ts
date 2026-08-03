import type {
  ContainerOutline,
  DatasetOutline,
  RecipeDestination,
  SaveRecipeResponse,
} from "../generated/protocol";
import type { DataPlane } from "../app/data-plane";

export type WizardNameRule =
  | { kind: "keep" }
  | { kind: "strip"; prefix: string }
  | { kind: "replace"; from: string; to: string }
  | { kind: "template"; value: string };

export type WizardUnitSource =
  | { kind: "none" }
  | { kind: "attribute"; name: string }
  | { kind: "value"; value: string };

export class ImportWizard {
  private timePath: string | null;
  private nameRule: WizardNameRule = { kind: "keep" };
  private unitSource: WizardUnitSource = { kind: "none" };
  private rendered: HTMLElement | null = null;
  private previousActive: Element | null = null;
  private escapeHandler: ((event: KeyboardEvent) => void) | null = null;

  private constructor(
    private readonly outline: ContainerOutline,
    private readonly sourcePath: string | null = null,
    private readonly plane: DataPlane | null = null,
  ) {
    this.timePath = this.proposedTime();
  }

  static fromOutline(outline: ContainerOutline): ImportWizard {
    return new ImportWizard(outline);
  }

  static async mount(plane: DataPlane, path: string): Promise<ImportWizard> {
    const outline = await plane.ingest?.introspect(path);
    if (outline === undefined) {
      throw new Error("container introspection is unavailable");
    }
    const wizard = new ImportWizard(outline, path, plane);
    document.body.append(wizard.render());
    return wizard;
  }

  close(): void {
    this.rendered?.remove();
    this.rendered = null;
    if (this.escapeHandler !== null) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
    if (this.previousActive instanceof HTMLElement) {
      this.previousActive.focus();
    }
  }

  proposedTime(): string | null {
    return (
      [...this.numericDatasets()]
        .filter((dataset) => monotonicPreview(dataset.sample_preview))
        .sort((left, right) => {
          const preferred = (dataset: DatasetOutline): number => {
            const leaf = dataset.path.split("/").at(-1)?.toLowerCase() ?? "";
            return leaf === "time" || leaf === "timestamp" || leaf === "t"
              ? 0
              : 1;
          };
          return (
            preferred(left) - preferred(right) ||
            Number(right.len) - Number(left.len) ||
            left.path.localeCompare(right.path)
          );
        })[0]?.path ?? null
    );
  }

  selectableSignals(): string[] {
    return this.numericDatasets()
      .map((dataset) => dataset.path)
      .filter((path) => path !== this.timePath);
  }

  setTime(path: string | null): void {
    if (
      path !== null &&
      !this.numericDatasets().some((dataset) => dataset.path === path)
    ) {
      throw new Error("unknown time dataset: " + path);
    }
    this.timePath = path;
  }

  setNameRule(rule: WizardNameRule): void {
    this.nameRule = rule;
  }

  setUnitSource(source: WizardUnitSource): void {
    this.unitSource = source;
  }

  toToml(): string {
    const id = recipeId(this.sourcePath, this.outline.container);
    const time =
      this.timePath === null
        ? 'kind = "index"\ndt = 1.0\nt0 = 0.0'
        : 'kind = "dataset"\npath = ' + quoteToml(this.timePath);
    const unit = unitSourceToml(this.unitSource);
    const selections = this.selectableSignals().flatMap((path) => [
      "[[selection]]",
      "datasets = " + quoteToml(path),
      "name = " + quoteToml(nameRuleValue(this.nameRule)),
      ...(unit === null ? [] : [unit]),
      "",
      "[selection.time]",
      time,
      "",
    ]);
    return [
      "id = " + quoteToml(id),
      "container = " + quoteToml(this.outline.container),
      "",
      ...selections,
    ].join("\n");
  }

  async save(
    plane: DataPlane,
    destination: RecipeDestination,
  ): Promise<SaveRecipeResponse> {
    if (plane.ingest === null) {
      throw new Error("recipe saving is unavailable");
    }
    if (this.sourcePath === null) {
      throw new Error("a source path is required to save a recipe");
    }
    return plane.ingest.saveRecipe(this.sourcePath, this.toToml(), destination);
  }

  render(): HTMLElement {
    if (this.rendered !== null) return this.rendered;
    this.previousActive ??= document.activeElement;
    const root = document.createElement("section");
    root.className = "import-wizard";
    this.rendered = root;
    this.escapeHandler = (event) => {
      if (event.key === "Escape") this.close();
    };
    document.addEventListener("keydown", this.escapeHandler);
    const heading = document.createElement("h2");
    heading.textContent = "Import container";
    root.append(heading);
    const container = document.createElement("p");
    container.className = "wizard-container";
    container.textContent = this.outline.container;
    root.append(container);
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Timebase";
    const timeSelect = document.createElement("select");
    const indexOption = document.createElement("option");
    indexOption.value = "";
    indexOption.textContent = "Index (1 s)";
    timeSelect.append(indexOption);
    for (const dataset of this.numericDatasets()) {
      const option = document.createElement("option");
      option.value = dataset.path;
      option.textContent = dataset.path;
      option.selected = dataset.path === this.timePath;
      timeSelect.append(option);
    }
    timeSelect.addEventListener("change", () => {
      this.setTime(timeSelect.value || null);
    });
    timeLabel.append(timeSelect);
    root.append(timeLabel);
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Names";
    const nameSelect = document.createElement("select");
    const keepNames = document.createElement("option");
    keepNames.value = "keep";
    keepNames.textContent = "Keep dataset paths";
    nameSelect.append(keepNames);
    const firstSlash = this.selectableSignals()[0]?.indexOf("/") ?? -1;
    if (firstSlash > 0) {
      const prefix =
        this.selectableSignals()[0]?.slice(0, firstSlash + 1) ?? "";
      const stripNames = document.createElement("option");
      stripNames.value = prefix;
      stripNames.textContent = `Strip ${prefix}`;
      nameSelect.append(stripNames);
    }
    nameSelect.addEventListener("change", () => {
      this.setNameRule(
        nameSelect.value === "keep"
          ? { kind: "keep" }
          : { kind: "strip", prefix: nameSelect.value },
      );
    });
    nameLabel.append(nameSelect);
    root.append(nameLabel);
    const unitLabel = document.createElement("label");
    unitLabel.textContent = "Units";
    const unitSelect = document.createElement("select");
    for (const [value, label] of [
      ["none", "No unit"],
      ["attribute:units", "Read units attribute"] as const,
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      unitSelect.append(option);
    }
    unitSelect.addEventListener("change", () => {
      this.setUnitSource(
        unitSelect.value === "none"
          ? { kind: "none" }
          : { kind: "attribute", name: unitSelect.value.slice(10) },
      );
    });
    unitLabel.append(unitSelect);
    root.append(unitLabel);
    const list = document.createElement("div");
    list.className = "wizard-datasets";
    for (const dataset of this.outline.datasets) {
      const row = document.createElement("div");
      row.className = "wizard-dataset";
      row.textContent =
        dataset.path + " · " + dataset.kind + " · " + dataset.len;
      list.append(row);
    }
    root.append(list);
    const actions = document.createElement("div");
    actions.className = "wizard-actions";
    const status = document.createElement("span");
    status.className = "wizard-status";
    const destinations: readonly [RecipeDestination, string][] = [
      ["sidecar", "Save sidecar"],
      ["user_directory", "Save recipe"],
    ];
    for (const [destination, label] of destinations) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled =
        this.plane === null ||
        this.plane.ingest === null ||
        this.sourcePath === null;
      button.addEventListener("click", () => {
        if (this.plane === null) return;
        void this.save(this.plane, destination)
          .then((response) => {
            status.textContent = `Saved ${response.recipe_id} to ${response.saved_to}`;
            this.close();
          })
          .catch((error: unknown) => {
            status.textContent =
              error instanceof Error ? error.message : String(error);
          });
      });
      actions.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    actions.append(close);
    actions.append(status);
    root.append(actions);
    return root;
  }

  private numericDatasets(): DatasetOutline[] {
    return this.outline.datasets.filter(
      (dataset) => dataset.kind === "numeric",
    );
  }
}

function monotonicPreview(values: readonly number[]): boolean {
  if (values.length === 0) return false;
  return values.every(
    (value, index) =>
      Number.isFinite(value) &&
      (index === 0 || value >= (values[index - 1] ?? value)),
  );
}

function nameRuleValue(rule: WizardNameRule): string {
  switch (rule.kind) {
    case "keep":
      return "keep";
    case "strip":
      return "strip:" + rule.prefix;
    case "replace":
      return "replace:" + rule.from + "=>" + rule.to;
    case "template":
      return "template:" + rule.value;
  }
}

function unitSourceToml(source: WizardUnitSource): string | null {
  switch (source.kind) {
    case "none":
      return null;
    case "attribute":
      return "unit_attribute = " + quoteToml(source.name);
    case "value":
      return "unit = " + quoteToml(source.value);
  }
}

function recipeId(sourcePath: string | null, container: string): string {
  const stem = sourcePath?.split(/[\\/]/).at(-1)?.split(".")[0] ?? "container";
  const normalized = stem.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
  return (normalized || "container") + "-" + container;
}

function quoteToml(value: string): string {
  return (
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n") +
    '"'
  );
}
