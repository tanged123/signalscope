export function composePanelPng(
  title: string,
  plot: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  colors: { background: string; text: string },
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
  context.font = `${String(Math.round(12 * dpr))}px system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.fillText(title, Math.round(10 * dpr), header / 2);
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
