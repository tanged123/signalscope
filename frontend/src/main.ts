import "./styles/app.css";

import { selectDataPlane } from "./app/data-plane";
import { acquireGpuContext } from "./render/gpu-context";
import { AppShell } from "./ui/app-shell";

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (root === null) {
    throw new Error("SignalScope application root is missing");
  }

  const planePromise = selectDataPlane();
  const gpuPromise = acquireGpuContext();
  const app = new AppShell(root, await planePromise);
  await app.mount();
  const gpu = await gpuPromise;
  if (gpu !== null) app.setGpu(gpu);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const root = document.querySelector<HTMLElement>("#app");
  if (root !== null) {
    root.textContent = `SignalScope failed to start: ${message}`;
  }
  console.error(error);
});
