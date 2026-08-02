import type { ChannelMapEntry, ChannelAlias } from "../generated/session";
import { Catalog } from "../app/catalog";
import type { MergeSuggestion } from "../app/channel-map";

const CONSISTENT_PAGE_SIZE = 30;

export interface ChannelMapViewCallbacks {
  onClose(): void;
  onUnmerge(canonical: string): void;
  onMerge(suggestion: MergeSuggestion): void;
  onKeep(suggestion: MergeSuggestion): void;
}

export class ChannelMapView {
  private readonly element: HTMLElement;
  private readonly dialog: HTMLElement;
  private catalog: Catalog = Catalog.empty();
  private map: readonly ChannelMapEntry[] = [];
  private suggestions: readonly MergeSuggestion[] = [];
  private consistentExpanded = false;
  private returnFocus: HTMLElement | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.element.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...this.dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  constructor(
    root: HTMLElement,
    private readonly callbacks: ChannelMapViewCallbacks,
  ) {
    this.element = document.createElement("div");
    this.element.className = "channel-map-overlay";
    this.element.hidden = true;
    this.dialog = document.createElement("div");
    this.dialog.className = "channel-map-dialog";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.dialog.setAttribute("aria-label", "Channel map workspace");
    this.element.appendChild(this.dialog);
    root.appendChild(this.element);
    this.element.addEventListener("pointerdown", (event) => {
      if (event.target === this.element) this.close();
    });
  }

  open(
    catalog: Catalog,
    map: readonly ChannelMapEntry[],
    suggestions: readonly MergeSuggestion[],
  ): void {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.catalog = catalog;
    this.map = map.map((entry) => ({
      canonical: entry.canonical,
      aliases: entry.aliases.map((alias) => ({ ...alias })),
    }));
    this.suggestions = suggestions;
    this.consistentExpanded = false;
    this.element.hidden = false;
    this.render();
    document.addEventListener("keydown", this.onKeyDown);
    this.dialog.querySelector<HTMLButtonElement>(".channel-map-close")?.focus();
  }

  close(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    document.removeEventListener("keydown", this.onKeyDown);
    this.returnFocus?.focus();
    this.returnFocus = null;
    this.callbacks.onClose();
  }

  isOpen(): boolean {
    return !this.element.hidden;
  }

  private render(): void {
    this.dialog.replaceChildren();
    const header = document.createElement("header");
    header.className = "channel-map-header";
    const title = document.createElement("h2");
    title.textContent = "CHANNEL MAP — WORKSPACE";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "channel-map-close";
    close.textContent = "close";
    close.addEventListener("click", () => this.close());
    header.append(title, close);
    this.dialog.appendChild(header);
    this.dialog.append(
      this.mergedSection(),
      this.consistentSection(),
      this.pendingSection(),
    );
  }

  private mergedSection(): HTMLElement {
    const section = this.section("merged", "MERGED CHANNELS");
    const merged = this.map.filter((entry) => entry.aliases.length > 1);
    if (merged.length === 0) {
      this.empty(section, "No merged channels.");
      return section;
    }
    for (const entry of merged) {
      const row = document.createElement("div");
      row.className = "channel-map-entry";
      const label = document.createElement("span");
      label.className = "channel-map-entry-label";
      label.textContent = `${entry.canonical} ← ${entry.aliases
        .map(formatAlias)
        .join(" · ")}`;
      const channel = this.catalog
        .channels()
        .find((candidate) => candidate.name === entry.canonical);
      if (channel?.unitConflict === true) {
        const marker = document.createElement("span");
        marker.className = "unit-conflict-marker";
        marker.textContent = "unit?";
        marker.title = "Source units disagree";
        row.appendChild(marker);
      }
      const unmerge = document.createElement("button");
      unmerge.type = "button";
      unmerge.dataset.action = "unmerge";
      unmerge.textContent = "unmerge";
      unmerge.addEventListener("click", () => {
        this.callbacks.onUnmerge(entry.canonical);
      });
      row.append(label, unmerge);
      section.appendChild(row);
    }
    return section;
  }

  private consistentSection(): HTMLElement {
    const section = this.section("consistent", "CONSISTENT CHANNELS");
    const mergedNames = new Set(
      this.map
        .filter((entry) => entry.aliases.length > 1)
        .map((entry) => entry.canonical),
    );
    const channels = this.catalog
      .channels()
      .filter((channel) => !mergedNames.has(channel.name));
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "channel-map-consistent-summary";
    summary.textContent = `${String(channels.length)} consistent channels ${
      this.consistentExpanded ? "▾" : "▸"
    }`;
    summary.addEventListener("click", () => {
      this.consistentExpanded = !this.consistentExpanded;
      this.render();
    });
    section.appendChild(summary);
    if (!this.consistentExpanded) return section;
    for (const channel of channels.slice(0, CONSISTENT_PAGE_SIZE)) {
      const row = document.createElement("div");
      row.className = "channel-map-consistent-row";
      row.textContent = `${channel.name} · ${String(channel.sourceKeys.length)} srcs`;
      if (channel.unitConflict) {
        const marker = document.createElement("span");
        marker.className = "unit-conflict-marker";
        marker.textContent = " unit?";
        row.appendChild(marker);
      }
      section.appendChild(row);
    }
    if (channels.length > CONSISTENT_PAGE_SIZE) {
      const more = document.createElement("div");
      more.className = "channel-map-consistent-more";
      more.textContent = `+${String(channels.length - CONSISTENT_PAGE_SIZE)} more`;
      section.appendChild(more);
    }
    return section;
  }

  private pendingSection(): HTMLElement {
    const section = this.section("pending", "PENDING NEAR-MATCHES");
    if (this.suggestions.length === 0) {
      this.empty(section, "No pending near-matches.");
      return section;
    }
    for (const suggestion of this.suggestions) {
      const row = document.createElement("div");
      row.className = "channel-map-suggestion";
      const label = document.createElement("span");
      label.textContent = `${suggestion.names
        .map((entry) => entry.channel)
        .join(" · ")} → ${suggestion.canonical}`;
      const merge = document.createElement("button");
      merge.type = "button";
      merge.dataset.action = "merge";
      merge.textContent = "merge";
      merge.addEventListener("click", () => this.callbacks.onMerge(suggestion));
      const keep = document.createElement("button");
      keep.type = "button";
      keep.dataset.action = "keep";
      keep.textContent = "keep";
      keep.addEventListener("click", () => this.callbacks.onKeep(suggestion));
      row.append(label, merge, keep);
      section.appendChild(row);
    }
    return section;
  }

  private section(key: string, title: string): HTMLElement {
    const section = document.createElement("section");
    section.dataset.section = key;
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  private empty(section: HTMLElement, text: string): void {
    const empty = document.createElement("p");
    empty.className = "channel-map-empty";
    empty.textContent = text;
    section.appendChild(empty);
  }
}

function formatAlias(alias: ChannelAlias): string {
  return `${alias.source_key}: ${alias.name}`;
}
