export interface ResidentPanel {
  id: string;
  seriesCount: number;
  lastUsed: number;
  active: boolean;
}

export function panelsToEvict(
  panels: readonly ResidentPanel[],
  limit: number,
): string[] {
  let resident = panels.reduce((sum, panel) => sum + panel.seriesCount, 0);
  const evicted: string[] = [];
  for (const panel of panels
    .filter(({ active }) => !active)
    .sort((left, right) => left.lastUsed - right.lastUsed)) {
    if (resident <= limit) break;
    resident -= panel.seriesCount;
    evicted.push(panel.id);
  }
  return evicted;
}
