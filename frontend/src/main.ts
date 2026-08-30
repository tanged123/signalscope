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
  let recoveryPromise: Promise<void> | null = null;
  let stopped = false;
  let app: AppShell;
  const recoverGpu = (): void => {
    if (stopped || recoveryPromise !== null) return;
    recoveryPromise = (async () => {
      while (!stopped) {
        const gpu = await acquireGpuContext();
        if (gpu !== null) {
          app.setGpu(gpu);
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      }
    })().finally(() => {
      recoveryPromise = null;
    });
  };
  window.addEventListener("pagehide", () => {
    stopped = true;
  });
  app = new AppShell(root, await planePromise, null, recoverGpu);
  await app.mount();
  const gpu = await gpuPromise;
  if (gpu === null) recoverGpu();
  else app.setGpu(gpu);
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const root = document.querySelector<HTMLElement>("#app");
  if (root !== null) {
    root.textContent = `SignalScope failed to start: ${message}`;
  }
  console.error(error);
});
