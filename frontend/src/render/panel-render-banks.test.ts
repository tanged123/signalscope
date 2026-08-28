// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { ChartRenderRequest } from "./chart-host";
import type { PlotLayout } from "../app/plot-math";
import type { GpuContext } from "./gpu-context";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  hosts: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    layout: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    setRangesOnly: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("./chart-host", () => ({
  ChartHost: { create: state.create },
}));

import { PanelRenderBanks } from "./panel-render-banks";

const layout: PlotLayout = {
  plot: { x: 0, y: 0, width: 100, height: 80 },
  xRange: { min: 0, max: 1 },
  yRange: { min: 0, max: 1 },
};

function request(role: "overview" | "detail"): ChartRenderRequest {
  return { bank: { role } } as ChartRenderRequest;
}

function gpu(): GpuContext {
  return {} as GpuContext;
}

function setupHostMocks(): void {
  state.create.mockReset();
  state.hosts.length = 0;
  state.create.mockImplementation(() => {
    const host = {
      render: vi.fn(() => 12),
      layout: vi.fn(() => layout),
      resize: vi.fn(),
      setRangesOnly: vi.fn(),
      capture: vi.fn(() => Promise.resolve(document.createElement("canvas"))),
      dispose: vi.fn(),
    };
    state.hosts.push(host);
    return Promise.resolve(host);
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("PanelRenderBanks", () => {
  it("lazily creates, selects, and retains overview and detail hosts", async () => {
    setupHostMocks();
    const container = document.createElement("div");
    const banks = new PanelRenderBanks(container, gpu());

    expect(container.querySelectorAll(".chart-bank")).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLElement>(".chart-bank")].map(
        (element) => element.dataset.bankRole,
      ),
    ).toEqual(["overview", "detail"]);
    expect(banks.publish("overview", request("overview"))).toBe(0);
    expect(banks.publish("detail", request("detail"))).toBe(0);
    await settle();

    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.hosts[0]?.render).toHaveBeenCalledTimes(1);
    expect(state.hosts[1]?.render).toHaveBeenCalledTimes(1);
    expect(banks.select("overview")).toBe(true);
    const elements = [
      ...container.querySelectorAll<HTMLElement>(".chart-bank"),
    ];
    expect(elements[0]?.hidden).toBe(false);
    expect(elements[1]?.hidden).toBe(true);
    expect(banks.selectedRole()).toBe("overview");
    const overviewElement = elements[0];

    expect(banks.select("detail")).toBe(true);
    expect(elements[0]).toBe(overviewElement);
    expect(elements[0]?.hidden).toBe(true);
    expect(elements[1]?.hidden).toBe(false);
    expect(banks.selectedRole()).toBe("detail");
  });

  it("uses the selected host for layout and capture and resizes both", async () => {
    setupHostMocks();
    const banks = new PanelRenderBanks(document.createElement("div"), gpu());
    banks.publish("overview", request("overview"));
    banks.publish("detail", request("detail"));
    await settle();
    banks.select("detail");

    expect(banks.layout()).toBe(layout);
    await expect(banks.capture()).resolves.toBeInstanceOf(HTMLCanvasElement);
    banks.resize();
    expect(state.hosts[0]?.resize).toHaveBeenCalledOnce();
    expect(state.hosts[1]?.resize).toHaveBeenCalledTimes(2);
  });

  it("resizes a selected host before applying its current ranges", async () => {
    setupHostMocks();
    const banks = new PanelRenderBanks(document.createElement("div"), gpu());
    banks.publish("overview", request("overview"));
    await settle();

    expect(
      banks.select("overview", {
        xRange: { min: 20, max: 30 },
        yRange: [-2, 4],
      }),
    ).toBe(true);

    const host = state.hosts[0];
    expect(host?.resize).toHaveBeenCalledOnce();
    expect(host?.setRangesOnly).toHaveBeenCalledWith(
      { min: 20, max: 30 },
      [-2, 4],
    );
    expect(host?.resize.mock.invocationCallOrder[0]).toBeLessThan(
      host?.setRangesOnly.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("resizes and ranges a selected host when async creation finishes", async () => {
    setupHostMocks();
    const banks = new PanelRenderBanks(document.createElement("div"), gpu());
    banks.publish("detail", request("detail"));

    expect(
      banks.select("detail", {
        xRange: { min: 40, max: 50 },
        yRange: [1, 2],
      }),
    ).toBe(true);
    await settle();

    expect(state.hosts[0]?.resize).toHaveBeenCalledOnce();
    expect(state.hosts[0]?.setRangesOnly).toHaveBeenCalledWith(
      { min: 40, max: 50 },
      [1, 2],
    );
  });

  it("updates ranges without resizing an already selected bank again", async () => {
    setupHostMocks();
    const banks = new PanelRenderBanks(document.createElement("div"), gpu());
    banks.publish("detail", request("detail"));
    await settle();
    banks.select("detail", {
      xRange: { min: 0, max: 10 },
      yRange: [0, 1],
    });

    banks.select("detail", {
      xRange: { min: 2, max: 4 },
      yRange: [-1, 2],
    });

    expect(state.hosts[0]?.resize).toHaveBeenCalledOnce();
    expect(state.hosts[0]?.setRangesOnly).toHaveBeenLastCalledWith(
      { min: 2, max: 4 },
      [-1, 2],
    );
  });

  it("evicts one role without removing its stable hidden container", async () => {
    setupHostMocks();
    const container = document.createElement("div");
    const banks = new PanelRenderBanks(container, gpu());
    banks.publish("overview", request("overview"));
    banks.publish("detail", request("detail"));
    await settle();
    banks.select("overview");
    const elements = [...container.querySelectorAll(".chart-bank")];

    banks.evict("overview");

    expect(state.hosts[0]?.dispose).toHaveBeenCalledOnce();
    expect(state.hosts[1]?.dispose).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".chart-bank")).toHaveLength(2);
    expect((elements[0] as HTMLElement | undefined)?.hidden).toBe(true);
    expect(banks.selectedRole()).toBeNull();
  });

  it("disposes both role hosts", async () => {
    setupHostMocks();
    const banks = new PanelRenderBanks(document.createElement("div"), gpu());
    banks.publish("overview", request("overview"));
    banks.publish("detail", request("detail"));
    await settle();

    banks.dispose();

    expect(state.hosts[0]?.dispose).toHaveBeenCalledOnce();
    expect(state.hosts[1]?.dispose).toHaveBeenCalledOnce();
  });
});
