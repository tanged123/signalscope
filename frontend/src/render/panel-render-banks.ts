import type { PlotLayout, Range } from "../app/plot-math";
import type { PreparedTileBank, TileBankRole } from "../app/prepared-tile-bank";
import { ChartHost, type ChartRenderRequest } from "./chart-host";
import type { GpuContext } from "./gpu-context";

interface BankState {
  readonly element: HTMLElement;
  host: ChartHost | null;
  ready: Promise<ChartHost | null> | null;
  pending: ChartRenderRequest | null;
  bank: PreparedTileBank | null;
  lastUsed: number;
  generation: number;
  selectedRanges: BankSelectionRanges | null;
}

const ROLES: readonly TileBankRole[] = ["overview", "detail"];

export interface GpuBankResidency {
  role: TileBankRole;
  bankId: string;
  cpuBytes: number;
  gpuBytes: number;
  selected: boolean;
  lastUsed: number;
}

export interface BankSelectionRanges {
  xRange: Range;
  yRange: readonly [number, number];
}

export class PanelRenderBanks {
  private readonly states = new Map<TileBankRole, BankState>();
  private selected: TileBankRole | null = null;
  private useCounter = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly gpu: GpuContext,
  ) {
    for (const child of [...container.children]) {
      if (child.classList.contains("chart-bank")) child.remove();
    }
    for (const role of ROLES) {
      const element = document.createElement("div");
      element.className = "chart-bank";
      element.dataset.bankRole = role;
      element.hidden = true;
      this.container.append(element);
      this.states.set(role, {
        element,
        host: null,
        ready: null,
        pending: null,
        bank: null,
        lastUsed: 0,
        generation: 0,
        selectedRanges: null,
      });
    }
  }

  publish(role: TileBankRole, request: ChartRenderRequest): number {
    if (this.disposed) return 0;
    const state = this.state(role);
    state.pending = request;
    state.bank = request.bank;
    this.touch(state);
    if (state.host !== null) {
      state.pending = null;
      const elapsed = state.host.render(request);
      if (this.selected === role) this.applySelectedRanges(state);
      return elapsed;
    }
    if (state.ready === null) this.initialize(role, state);
    return 0;
  }

  select(role: TileBankRole, ranges?: BankSelectionRanges): boolean {
    if (this.disposed) return false;
    const state = this.state(role);
    if (state.host === null && state.ready === null && state.pending === null) {
      return false;
    }
    const activating = this.selected !== role || state.element.hidden;
    for (const candidate of this.states.values())
      candidate.element.hidden = true;
    state.element.hidden = false;
    this.selected = role;
    if (ranges !== undefined) {
      state.selectedRanges = copySelectionRanges(ranges);
    }
    this.touch(state);
    this.prepareSelectedHost(state, activating);
    return true;
  }

  selectedRole(): TileBankRole | null {
    return this.selected;
  }

  layout(): PlotLayout | null {
    const host = this.selectedHost();
    return host?.layout() ?? null;
  }

  setRangesOnly(
    xRange: { min: number; max: number },
    yRange: readonly [number, number],
  ): void {
    if (this.selected === null) return;
    const state = this.state(this.selected);
    state.selectedRanges = copySelectionRanges({ xRange, yRange });
    state.host?.setRangesOnly(xRange, yRange);
  }

  residentGpuBytes(role?: TileBankRole): number {
    if (role !== undefined)
      return this.states.get(role)?.host?.residentGpuBytes() ?? 0;
    let bytes = 0;
    for (const state of this.states.values()) {
      bytes += state.host?.residentGpuBytes() ?? 0;
    }
    return bytes;
  }

  residency(): readonly GpuBankResidency[] {
    return ROLES.flatMap((role) => {
      const state = this.state(role);
      if (state.host === null || state.bank === null) return [];
      return [
        {
          role,
          bankId: state.bank.id,
          cpuBytes: state.bank.cpuBytes,
          gpuBytes: state.host.residentGpuBytes(),
          selected: this.selected === role,
          lastUsed: state.lastUsed,
        },
      ];
    });
  }

  evict(role: TileBankRole): void {
    const state = this.state(role);
    state.generation += 1;
    state.host?.dispose();
    state.host = null;
    state.ready = null;
    state.pending = null;
    state.bank = null;
    state.selectedRanges = null;
    state.element.hidden = true;
    if (this.selected === role) this.selected = null;
  }

  touchAll(): void {
    for (const state of this.states.values()) {
      if (state.host !== null || state.pending !== null) this.touch(state);
    }
  }

  resize(): void {
    for (const state of this.states.values()) state.host?.resize();
  }

  async capture(): Promise<HTMLCanvasElement> {
    const host = this.selectedHost() ?? (await this.selectedReady());
    if (host === null) throw new Error("selected chart bank unavailable");
    return host.capture();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.states.values()) {
      state.generation += 1;
      state.host?.dispose();
      state.host = null;
      state.ready = null;
      state.pending = null;
      state.bank = null;
      state.selectedRanges = null;
    }
    this.selected = null;
  }

  private initialize(role: TileBankRole, state: BankState): void {
    const generation = state.generation;
    const ready = ChartHost.create(state.element, this.gpu)
      .then((host) => {
        if (this.disposed || generation !== state.generation) {
          host.dispose();
          return null;
        }
        state.host = host;
        state.ready = null;
        if (state.pending !== null) {
          const request = state.pending;
          state.pending = null;
          host.render(request);
        }
        if (this.selected === role) this.prepareSelectedHost(state);
        return host;
      })
      .catch((error: unknown) => {
        if (!this.disposed && generation === state.generation) {
          console.error(`ChartGPU ${role} bank initialization failed`, error);
          state.ready = null;
          state.pending = null;
          state.bank = null;
        }
        return null;
      });
    state.ready = ready;
  }

  private selectedHost(): ChartHost | null {
    return this.selected === null
      ? null
      : (this.states.get(this.selected)?.host ?? null);
  }

  private prepareSelectedHost(state: BankState, resize = true): void {
    if (state.host === null) return;
    if (resize) state.host.resize();
    this.applySelectedRanges(state);
  }

  private applySelectedRanges(state: BankState): void {
    if (state.host === null) return;
    if (state.selectedRanges !== null) {
      state.host.setRangesOnly(
        state.selectedRanges.xRange,
        state.selectedRanges.yRange,
      );
    }
  }

  private async selectedReady(): Promise<ChartHost | null> {
    if (this.selected === null) return null;
    const state = this.states.get(this.selected);
    return state?.host ?? (await state?.ready) ?? null;
  }

  private state(role: TileBankRole): BankState {
    const state = this.states.get(role);
    if (state === undefined)
      throw new Error(`unknown chart bank role: ${role}`);
    return state;
  }

  private touch(state: BankState): void {
    state.lastUsed = ++this.useCounter;
  }
}

function copySelectionRanges(ranges: BankSelectionRanges): BankSelectionRanges {
  return {
    xRange: { ...ranges.xRange },
    yRange: [ranges.yRange[0], ranges.yRange[1]],
  };
}
