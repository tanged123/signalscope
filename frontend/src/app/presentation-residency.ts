import type { PresentationBudgets } from "./presentation-budget";
import type { TileBankRole } from "./prepared-tile-bank";

export type EvictionAction = {
  panelId: string;
  role: TileBankRole;
  medium: "gpu" | "cpu";
};

export interface ResidentBank {
  panelId: string;
  role: TileBankRole;
  cpuBytes: number;
  gpuBytes: number;
  selected: boolean;
  superseded: boolean;
  active: boolean;
  lastUsed: number;
}

export function planPresentationEvictions(input: {
  cpuBytes: number;
  gpuBytes: number;
  budgets: PresentationBudgets;
  banks: readonly ResidentBank[];
  activePanelIds: ReadonlySet<string>;
}): readonly EvictionAction[] {
  let cpuPressure = positiveExcess(input.cpuBytes, input.budgets.cpuBytes);
  let gpuPressure = positiveExcess(input.gpuBytes, input.budgets.gpuBytes);
  const actions: EvictionAction[] = [];
  const candidates = input.banks.filter(
    (bank) =>
      !(input.activePanelIds.has(bank.panelId) && bank.selected) &&
      !(input.activePanelIds.has(bank.panelId) && bank.role === "overview"),
  );

  const evict = (
    medium: "gpu" | "cpu",
    banks: readonly ResidentBank[],
    bytes: (bank: ResidentBank) => number,
  ): void => {
    for (const bank of ordered(banks)) {
      const amount = positive(bytes(bank));
      if (amount === 0) continue;
      if (medium === "gpu") {
        if (gpuPressure <= 0) break;
        gpuPressure -= amount;
      } else {
        if (cpuPressure <= 0) break;
        cpuPressure -= amount;
      }
      actions.push({ panelId: bank.panelId, role: bank.role, medium });
    }
  };

  evict(
    "gpu",
    candidates.filter(
      (bank) =>
        !input.activePanelIds.has(bank.panelId) && bank.role === "detail",
    ),
    (bank) => bank.gpuBytes,
  );
  evict(
    "gpu",
    candidates.filter(
      (bank) =>
        !input.activePanelIds.has(bank.panelId) && bank.role === "overview",
    ),
    (bank) => bank.gpuBytes,
  );
  evict(
    "cpu",
    candidates.filter(
      (bank) =>
        input.activePanelIds.has(bank.panelId) &&
        bank.role === "detail" &&
        bank.superseded,
    ),
    (bank) => bank.cpuBytes,
  );
  evict(
    "cpu",
    candidates.filter(
      (bank) =>
        !input.activePanelIds.has(bank.panelId) && bank.role === "detail",
    ),
    (bank) => bank.cpuBytes,
  );
  evict(
    "cpu",
    candidates.filter(
      (bank) =>
        !input.activePanelIds.has(bank.panelId) && bank.role === "overview",
    ),
    (bank) => bank.cpuBytes,
  );
  return actions;
}

function ordered(banks: readonly ResidentBank[]): ResidentBank[] {
  return [...banks].sort(
    (left, right) =>
      left.lastUsed - right.lastUsed ||
      left.panelId.localeCompare(right.panelId) ||
      left.role.localeCompare(right.role),
  );
}

function positiveExcess(value: number, budget: number): number {
  return Math.max(0, positive(value) - positive(budget));
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
