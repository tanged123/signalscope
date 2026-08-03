import type {
  ContainerOutline,
  DatasetOutline,
  RecipeDestination,
  SaveRecipeResponse,
} from "../generated/protocol";
import type { DataPlane } from "../app/data-plane";

const MAX_RECIPE_BYTES = 256 * 1024;
const MAX_SELECTIONS = 1_024;
let nextWizardId = 0;

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
  private readonly selectedSignals: Set<string>;
  private rendered: HTMLElement | null = null;
  private previousActive: Element | null = null;
  private escapeHandler: ((event: KeyboardEvent) => void) | null = null;

  private constructor(
    private readonly outline: ContainerOutline,
    private readonly sourcePath: string | null = null,
    private readonly plane: DataPlane | null = null,
    private readonly onSaved?: (path: string) => void | Promise<void>,
  ) {
    this.timePath = this.proposedTime();
    this.selectedSignals = new Set(
      this.signalCandidates().map((dataset) => dataset.path),
    );
    if (this.timePath !== null) this.selectedSignals.delete(this.timePath);
  }

  static fromOutline(outline: ContainerOutline): ImportWizard {
    return new ImportWizard(outline);
  }

  static async mount(
    plane: DataPlane,
    path: string,
    onSaved?: (path: string) => void | Promise<void>,
  ): Promise<ImportWizard> {
    const outline = await plane.ingest?.introspect(path);
    if (outline === undefined) {
      throw new Error("container introspection is unavailable");
    }
    const wizard = new ImportWizard(outline, path, plane, onSaved);
    document.body.append(wizard.render());
    wizard.focusTimeSelect();
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
    return this.signalCandidates()
      .map((dataset) => dataset.path)
      .filter(
        (path) => path !== this.timePath && this.selectedSignals.has(path),
      );
  }

  setTime(path: string | null): void {
    if (
      path !== null &&
      !this.numericDatasets().some((dataset) => dataset.path === path)
    ) {
      throw new Error("unknown time dataset: " + path);
    }
    if (this.timePath !== null && this.timePath !== path) {
      this.selectedSignals.add(this.timePath);
    }
    this.timePath = path;
    if (path !== null) this.selectedSignals.delete(path);
  }

  setNameRule(rule: WizardNameRule): void {
    this.nameRule = rule;
  }

  setUnitSource(source: WizardUnitSource): void {
    this.unitSource = source;
  }

  toToml(): string {
    const selectedSignals = this.selectableSignals();
    if (selectedSignals.length > MAX_SELECTIONS) {
      throw new Error("recipe has more than 1,024 selections");
    }
    const id = recipeId(this.sourcePath, this.outline.container);
    const time =
      this.timePath === null
        ? 'kind = "index"\ndt = 1.0\nt0 = 0.0'
        : 'kind = "dataset"\npath = ' + quoteToml(this.timePath);
    const unit = unitSourceToml(this.unitSource);
    const selections = selectedSignals.flatMap((path) => [
      "[[selection]]",
      "datasets = " + quoteToml(path),
      "name = " + quoteToml(nameRuleValue(this.nameRule)),
      ...(unit === null ? [] : [unit]),
      "",
      "[selection.time]",
      time,
      "",
    ]);
    const toml = [
      "id = " + quoteToml(id),
      "container = " + quoteToml(this.outline.container),
      "",
      ...selections,
    ].join("\n");
    if (new TextEncoder().encode(toml).byteLength > MAX_RECIPE_BYTES) {
      throw new Error("recipe exceeds the 256 KiB limit");
    }
    return toml;
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
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    this.rendered = root;
    const headingId = "import-wizard-heading-" + String(++nextWizardId);
    this.escapeHandler = (event) => {
      if (event.key === "Escape") this.close();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !root.contains(active))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);
    const heading = document.createElement("h2");
    heading.id = headingId;
    root.setAttribute("aria-labelledby", headingId);
    heading.textContent = "Import container";
    root.append(heading);
    const container = document.createElement("p");
    container.className = "wizard-container";
    container.textContent = this.outline.container;
    root.append(container);
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Timebase";
    const timeSelect = document.createElement("select");
    timeSelect.className = "wizard-time-select";
    const indexOption = document.createElement("option");
    indexOption.value = "";
    indexOption.textContent = "Index (1 s)";
    timeSelect.append(indexOption);
    for (const dataset of this.signalCandidates()) {
      const option = document.createElement("option");
      option.value = dataset.path;
      option.textContent = dataset.path;
      option.selected = dataset.path === this.timePath;
      timeSelect.append(option);
    }
    timeSelect.addEventListener("change", () => {
      this.setTime(timeSelect.value || null);
      syncSignalCheckboxes();
    });
    timeLabel.append(timeSelect);
    root.append(timeLabel);
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Names";
    const nameSelect = document.createElement("select");
    const nameRules = new Map<string, WizardNameRule>();
    const keepNames = document.createElement("option");
    keepNames.value = "name-keep";
    keepNames.textContent = "Keep dataset paths";
    nameRules.set(keepNames.value, { kind: "keep" });
    nameSelect.append(keepNames);
    const firstSlash = this.selectableSignals()[0]?.indexOf("/") ?? -1;
    if (firstSlash > 0) {
      const prefix =
        this.selectableSignals()[0]?.slice(0, firstSlash + 1) ?? "";
      const stripNames = document.createElement("option");
      stripNames.value = "name-strip-0";
      stripNames.textContent = `Strip ${prefix}`;
      nameRules.set(stripNames.value, { kind: "strip", prefix });
      nameSelect.append(stripNames);
    }
    nameSelect.addEventListener("change", () => {
      const rule = nameRules.get(nameSelect.value);
      if (rule !== undefined) this.setNameRule(rule);
    });
    nameLabel.append(nameSelect);
    root.append(nameLabel);
    const unitLabel = document.createElement("label");
    unitLabel.textContent = "Units";
    const unitSelect = document.createElement("select");
    const unitSources = new Map<string, WizardUnitSource>([
      ["unit-none", { kind: "none" }],
      ["unit-attribute-units", { kind: "attribute", name: "units" }],
    ]);
    for (const [value] of unitSources) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent =
        value === "unit-none" ? "No unit" : "Read units attribute";
      unitSelect.append(option);
    }
    unitSelect.addEventListener("change", () => {
      const source = unitSources.get(unitSelect.value);
      if (source !== undefined) this.setUnitSource(source);
    });
    unitLabel.append(unitSelect);
    root.append(unitLabel);
    const list = document.createElement("div");
    list.className = "wizard-datasets";
    const checkboxPaths = new Map<HTMLInputElement, string>();
    const syncSignalCheckboxes = () => {
      for (const checkbox of list.querySelectorAll<HTMLInputElement>(
        ".wizard-signal",
      )) {
        const path = checkboxPaths.get(checkbox);
        if (path === undefined) continue;
        checkbox.disabled = path === this.timePath;
        checkbox.checked =
          path !== this.timePath && this.selectedSignals.has(path);
      }
    };
    for (const dataset of this.outline.datasets) {
      const row = document.createElement("div");
      row.className = "wizard-dataset";
      if (dataset.kind === "numeric") {
        const checkbox = document.createElement("input");
        checkbox.className = "wizard-signal";
        checkbox.type = "checkbox";
        checkboxPaths.set(checkbox, dataset.path);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) this.selectedSignals.add(dataset.path);
          else this.selectedSignals.delete(dataset.path);
        });
        row.append(checkbox);
      }
      const text = document.createElement("span");
      text.textContent =
        dataset.path + " · " + dataset.kind + " · " + dataset.len;
      row.append(text);
      list.append(row);
    }
    syncSignalCheckboxes();
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
        const path = this.sourcePath;
        void this.save(this.plane, destination)
          .then(async (response) => {
            status.textContent = `Saved ${response.recipe_id} to ${response.saved_to}`;
            this.close();
            // A saved recipe is only useful once the file it describes is
            // loaded, so finish the job rather than asking for another click.
            if (path !== null) await this.onSaved?.(path);
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

  private signalCandidates(): DatasetOutline[] {
    return this.numericDatasets().filter(
      (dataset) => dataset.sample_preview.length > 0,
    );
  }

  private focusTimeSelect(): void {
    this.rendered
      ?.querySelector<HTMLSelectElement>(".wizard-time-select")
      ?.focus();
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
    Array.from(value.replaceAll("\\", "\\\\").replaceAll('"', '\\"'))
      .map((character) => {
        const code = character.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) return character;
        switch (character) {
          case "\b":
            return "\\b";
          case "\t":
            return "\\t";
          case "\n":
            return "\\n";
          case "\f":
            return "\\f";
          case "\r":
            return "\\r";
          default:
            return `\\u${code.toString(16).padStart(4, "0")}`;
        }
      })
      .join("") +
    '"'
  );
}
