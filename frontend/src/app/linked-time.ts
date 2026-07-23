export type TimeMode = "fixed" | "follow";

export interface TimeWindow {
  t0: number;
  t1: number;
}

export interface LinkedTimeState extends TimeWindow {
  linked: boolean;
  cursorT: number | null;
  mode: TimeMode;
  paused: boolean;
}

type Listener = (state: Readonly<LinkedTimeState>, origin: string) => void;

export class LinkedTimeModel {
  private readonly listeners = new Set<Listener>();

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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setWindow(window: TimeWindow, origin: string): void {
    this.validateWindow(window);
    this.state = { ...this.state, ...window, mode: "fixed" };
    this.publish(origin);
  }

  setCursor(cursorT: number | null, origin: string): void {
    this.state = { ...this.state, cursorT };
    this.publish(origin);
  }

  setLinked(linked: boolean, origin: string): void {
    this.state = { ...this.state, linked };
    this.publish(origin);
  }

  private publish(origin: string): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot, origin);
    }
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
