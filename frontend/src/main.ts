import "./styles/app.css";

import { selectDataPlane } from "./app/data-plane";
import { AppShell } from "./ui/app-shell";

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (root === null) {
    throw new Error("SignalScope application root is missing");
  }

  // Temporary boot-stage diagnostics for the Windows package smoke hang.
  console.error("signalscope-boot: selecting data plane");
  const plane = await selectDataPlane();
  console.error("signalscope-boot: plane ready");
  const app = new AppShell(root, plane);
  console.error("signalscope-boot: mounting");
  await app.mount();
  console.error("signalscope-boot: mounted");
}

await boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const root = document.querySelector<HTMLElement>("#app");
  if (root !== null) {
    root.textContent = `SignalScope failed to start: ${message}`;
  }
  console.error(error);
});
