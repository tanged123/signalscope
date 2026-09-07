import { version } from "../../package.json";
import { required } from "./dom";
import { showInfoDialog } from "./info-dialog";

export function showAbout(root: HTMLElement): void {
  const content = document.createElement("div");
  content.innerHTML = `<p class="about-version"></p>
    <p>A signal analysis workbench for engineering telemetry. Compare signals, inspect linked plots, and share self-contained interactive snapshots.</p>
    <p>MIT License · © 2026 Edward Tang</p>
    <nav aria-label="SignalScope resources">
      <a href="https://github.com/tanged123/signalscope#readme" target="_blank" rel="noreferrer">Documentation ↗</a>
      <a href="https://github.com/tanged123/signalscope/issues" target="_blank" rel="noreferrer">Report an issue ↗</a>
    </nav>`;
  required(content, ".about-version").textContent = `Version ${version}`;
  showInfoDialog(root, "about", "About SignalScope", content);
}
