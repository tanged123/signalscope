import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  const root = document.documentElement;
  let previous = "";
  const publishTheme = (): void => {
    const styles = getComputedStyle(root);
    const color = styles.getPropertyValue("--surface-1").trim();
    const symbolColor = styles.getPropertyValue("--fg-1").trim();
    const key = `${color}:${symbolColor}`;
    if (key === previous) return;
    previous = key;
    ipcRenderer.send("titlebar-theme", { color, symbolColor });
  };
  const observer = new MutationObserver(publishTheme);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme", "style"],
  });
  publishTheme();
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) observer.disconnect();
  });
});
