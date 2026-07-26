import type { TimeWindow } from "../generated/protocol";
import type { LinkedTime } from "../generated/session";

export type { TimeWindow };
export type LinkedTimeState = LinkedTime;

export class LinkedTimeModel {
  constructor(
    private state: LinkedTimeState = {
      t0: 0,
      t1: 60,
      linked: true,
      cursorT: null,
      mode: "fixed",
      paused: false,
    },
  ) {
    this.validateWindow(state);
  }

  snapshot(): Readonly<LinkedTimeState> {
    return { ...this.state };
  }

  setLinked(linked: boolean): void {
    this.state = { ...this.state, linked };
  }

  setWindow(t0: number, t1: number): void {
    const next = { ...this.state, t0, t1 };
    this.validateWindow(next);
    this.state = next;
  }

  setCursor(cursorT: number | null): void {
    this.state = {
      ...this.state,
      cursorT: cursorT !== null && Number.isFinite(cursorT) ? cursorT : null,
    };
  }

  private validateWindow(window: TimeWindow): void {
    if (
      !Number.isFinite(window.t0) ||
      !Number.isFinite(window.t1) ||
      window.t1 <= window.t0
    ) {
      throw new Error("Time window must be finite and increasing");
    }
  }
}
