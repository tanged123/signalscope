import { describe, expect, it, vi } from "vitest";
import { GpuFrameLoop, type GpuPanelEncoder } from "./frame-loop";

class RafMock {
  private callbacks: FrameRequestCallback[] = [];
  request = vi.fn((callback: FrameRequestCallback): number => {
    this.callbacks.push(callback);
    return this.callbacks.length;
  });
  cancel = vi.fn();
  flush(): void {
    const callbacks = this.callbacks.splice(0);
    callbacks.forEach((callback) => callback(0));
  }
}

type TestPanel = GpuPanelEncoder & {
  encodeSpy: ReturnType<typeof vi.fn>;
  afterSubmitSpy: ReturnType<typeof vi.fn>;
};

function panel(id: string): TestPanel {
  const encode = vi.fn();
  const afterSubmit = vi.fn();
  const deviceLost = vi.fn();
  const deviceRestored = vi.fn();
  const dispose = vi.fn();
  return {
    id,
    encode,
    afterSubmit,
    deviceLost,
    deviceRestored,
    dispose,
    encodeSpy: encode,
    afterSubmitSpy: afterSubmit,
  };
}

function device() {
  const finish = vi.fn(() => ({ id: "commands" }));
  const createCommandEncoder = vi.fn(() => ({ finish }));
  const submit = vi.fn();
  return {
    device: {
      createCommandEncoder,
    } as unknown as GPUDevice,
    createCommandEncoder,
    createCommandEncoderSpy: createCommandEncoder,
    finish,
    submit,
    submitSpy: submit,
    queue: { submit } as unknown as GPUQueue,
  };
}

describe("GpuFrameLoop", () => {
  it("coalesces dirty panels into one command submission", () => {
    const raf = new RafMock();
    const gpu = device();
    const loop = new GpuFrameLoop(
      gpu.device,
      gpu.queue,
      raf.request,
      raf.cancel,
    );
    const panelA = panel("a");
    const panelB = panel("b");
    const unregisterA = loop.register(panelA);
    loop.register(panelB);

    loop.request(panelA);
    loop.request(panelA);
    loop.request(panelB);
    expect(raf.request).toHaveBeenCalledTimes(1);
    raf.flush();

    expect(panelA.encodeSpy).toHaveBeenCalledTimes(1);
    expect(panelB.encodeSpy).toHaveBeenCalledTimes(1);
    expect(gpu.createCommandEncoderSpy).toHaveBeenCalledTimes(1);
    expect(gpu.submitSpy).toHaveBeenCalledTimes(1);
    expect(panelA.afterSubmitSpy).toHaveBeenCalledTimes(1);
    unregisterA();
  });

  it("does not encode an unregistered panel and reports failures once", () => {
    const raf = new RafMock();
    const gpu = device();
    const report = vi.fn();
    const loop = new GpuFrameLoop(
      gpu.device,
      gpu.queue,
      raf.request,
      raf.cancel,
      report,
    );
    const panelA = panel("a");
    const panelB = panel("b");
    loop.register(panelA);
    loop.register(panelB);
    panelA.encodeSpy.mockImplementation(() => {
      throw new Error("bad panel");
    });
    loop.request(panelA);
    loop.request(panelB);
    loop.unregister(panelB);
    raf.flush();

    expect(panelA.encodeSpy).toHaveBeenCalledTimes(1);
    expect(panelB.encodeSpy).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("a", expect.any(Error));
    expect(gpu.submitSpy).toHaveBeenCalledTimes(0);
  });
});
