import { afterEach, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { send } }));

afterEach(() => vi.unstubAllGlobals());

it("publishes initial and changed theme colors and disconnects at teardown", async () => {
  const listeners = new Map<string, (event?: { persisted: boolean }) => void>();
  const colors: Record<string, string> = {
    "--surface-1": " #151920 ",
    "--fg-1": " #e6e8ec ",
  };
  let changed = (): void => {};
  const disconnect = vi.fn();
  vi.stubGlobal("window", {
    addEventListener: (name: string, callback: () => void) =>
      listeners.set(name, callback),
  });
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => colors[name],
  }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        changed = callback;
      }
      observe(): void {}
      disconnect = disconnect;
    },
  );
  await import("../src/preload");
  listeners.get("DOMContentLoaded")?.();
  expect(send).toHaveBeenLastCalledWith("titlebar-theme", {
    color: "#151920",
    symbolColor: "#e6e8ec",
  });
  changed();
  expect(send).toHaveBeenCalledTimes(1);
  colors["--surface-1"] = "#eff1f4";
  colors["--fg-1"] = "#1a1e26";
  changed();
  expect(send).toHaveBeenLastCalledWith("titlebar-theme", {
    color: "#eff1f4",
    symbolColor: "#1a1e26",
  });
  listeners.get("pagehide")?.({ persisted: true });
  expect(disconnect).not.toHaveBeenCalled();
  listeners.get("pagehide")?.({ persisted: false });
  expect(disconnect).toHaveBeenCalledOnce();
});
