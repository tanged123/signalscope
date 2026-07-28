import type { Session } from "../generated/session";

const HISTORY_LIMIT = 100;

/**
 * Bounded snapshot history for workspace undo/redo. The session is
 * kilobyte-scale JSON, so whole-state clones beat hand-written inverse
 * operations on robustness. `present` mirrors the workspace's live state;
 * callers own applying returned snapshots via `WorkspaceModel.replace`.
 */
export class HistoryStack {
  private past: Session[] = [];
  private future: Session[] = [];
  private present: Session | null = null;
  private lastKey: string | null = null;

  reset(current: Session): void {
    this.past = [];
    this.future = [];
    this.present = structuredClone(current);
    this.lastKey = null;
  }

  commit(next: Session, coalesceKey?: string): void {
    if (this.present === null) {
      this.reset(next);
      return;
    }
    const snapshot = structuredClone(next);
    if (JSON.stringify(snapshot) === JSON.stringify(this.present)) return;
    if (coalesceKey !== undefined && coalesceKey === this.lastKey) {
      // Mid-gesture: fold into the open entry instead of stacking a step
      // per wheel tick or drag frame.
      this.present = snapshot;
    } else {
      this.past.push(this.present);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.present = snapshot;
    }
    this.future = [];
    this.lastKey = coalesceKey ?? null;
  }

  undo(): Session | null {
    const previous = this.past.pop();
    if (previous === undefined || this.present === null) return null;
    this.future.push(this.present);
    this.present = previous;
    this.lastKey = null;
    return structuredClone(previous);
  }

  redo(): Session | null {
    const next = this.future.pop();
    if (next === undefined || this.present === null) return null;
    this.past.push(this.present);
    this.present = next;
    this.lastKey = null;
    return structuredClone(next);
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }
}
