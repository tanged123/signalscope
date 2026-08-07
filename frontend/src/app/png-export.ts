import type { WorkspaceTab } from "../generated/session";
import { exportFileStem } from "./export-file";

export interface PanelPngTarget {
  tabId: string;
  panelId: string;
  fileName: string;
}

export function panelPngTargets(
  tabs: readonly WorkspaceTab[],
): PanelPngTarget[] {
  const targets: PanelPngTarget[] = [];
  const usedNames = new Set<string>();
  for (const tab of tabs) {
    const panels = new Map(tab.panels.map((panel) => [panel.id, panel]));
    const orderedIds = tab.layout.flatMap((row) =>
      row.panels.map((cell) => cell.panel_id),
    );
    const seen = new Set(orderedIds);
    orderedIds.push(
      ...tab.panels
        .map((panel) => panel.id)
        .filter((panelId) => !seen.has(panelId)),
    );
    for (const panelId of orderedIds) {
      const panel = panels.get(panelId);
      if (panel === undefined) continue;
      const base = `${exportFileStem(tab.title, tab.id)}-${exportFileStem(panel.title, panel.id)}`;
      let fileName = `${base}.png`;
      let suffix = 2;
      while (usedNames.has(fileName.toLowerCase())) {
        fileName = `${base}-${String(suffix)}.png`;
        suffix += 1;
      }
      usedNames.add(fileName.toLowerCase());
      targets.push({ tabId: tab.id, panelId, fileName });
    }
  }
  return targets;
}

export function composePanelPng(
  title: string,
  axes: HTMLCanvasElement,
  plot: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  colors: { background: string; text: string; font: string },
): HTMLCanvasElement {
  const dpr = globalThis.devicePixelRatio || 1;
  const header = Math.round(28 * dpr);
  const output = document.createElement("canvas");
  output.width = plot.width;
  output.height = header + plot.height;
  const context = output.getContext("2d");
  if (context === null) throw new Error("2d context unavailable");
  context.fillStyle = colors.background;
  context.fillRect(0, 0, output.width, output.height);
  context.fillStyle = colors.text;
  context.font = `${String(Math.round(12 * dpr))}px ${colors.font}`;
  context.textBaseline = "middle";
  context.fillText(title, Math.round(10 * dpr), header / 2);
  context.drawImage(axes, 0, header);
  context.drawImage(plot, 0, header);
  context.drawImage(overlay, 0, header);
  return output;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
