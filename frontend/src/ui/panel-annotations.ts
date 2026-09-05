export interface AnnotationOffset {
  x: number;
  y: number;
}

/** Ephemeral annotation interaction state, independent of plot-family data. */
export class PanelAnnotationState {
  readonly selectedIds = new Set<string>();
  readonly offsets = new Map<string, AnnotationOffset>();
  expanded = false;
  hoveredId: string | null = null;
  dragId: string | null = null;
  tipsHeight: number | null = null;

  prune(ids: ReadonlySet<string>): void {
    for (const id of this.selectedIds) {
      if (!ids.has(id)) this.selectedIds.delete(id);
    }
    for (const id of this.offsets.keys()) {
      if (!ids.has(id)) this.offsets.delete(id);
    }
    if (this.hoveredId !== null && !ids.has(this.hoveredId)) {
      this.hoveredId = null;
    }
  }

  select(id: string, additive: boolean): void {
    if (!additive) this.selectedIds.clear();
    if (additive && this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
  }
}
