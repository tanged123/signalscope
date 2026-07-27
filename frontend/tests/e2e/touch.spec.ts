import { expect, test } from "./fixtures";

test.describe("touch gestures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("a one-finger drag pans and the fit command restores the view", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "touch interaction");
    const overlay = page.locator(".overlay-canvas").first();
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    const readout = page.locator(".window-readout");
    const fitted = await readout.textContent();

    const client = await page.context().newCDPSession(page);
    const at = (x: number, y: number) => [
      { x: box.x + x, y: box.y + y, id: 0 },
    ];
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: at(200, 120),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: at(120, 120),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(readout).not.toHaveText(fitted ?? "");

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("Panel: fit view");
    await page.keyboard.press("Enter");
    await expect(readout).toHaveText(fitted ?? "");
  });

  test("histogram one-finger pan and double-tap fit move its viewport", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "touch interaction");
    const panel = page.locator(".panel").first();
    const canvas = panel.locator(".plot-canvas");
    const snapshot = async (): Promise<string> =>
      canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await panel.locator(".mode-pill", { hasText: "H" }).click();
    await expect(panel.locator(".mode-pill.active")).toHaveText("H");
    await page.waitForTimeout(350);
    const overlay = panel.locator(".overlay-canvas");
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("overlay not laid out");
    const client = await page.context().newCDPSession(page);
    const sampleX = Math.min(box.width - 20, Math.max(80, box.width * 0.6));
    const sampleY = Math.min(box.height - 40, Math.max(20, box.height * 0.35));
    const dragEndX = Math.min(box.width - 20, sampleX + 80);
    const point = (x: number, y: number) => [
      { x: box.x + x, y: box.y + y, id: 0 },
    ];
    const tap = async (x: number, y: number): Promise<void> => {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: point(x, y),
      });
      await page.waitForTimeout(40);
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    const beforePan = await snapshot();

    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(sampleX, sampleY),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: point(dragEndX, sampleY),
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(350);
    await expect.poll(snapshot).not.toBe(beforePan);
    const panned = await snapshot();

    await tap(sampleX, sampleY);
    await page.waitForTimeout(80);
    await tap(sampleX, sampleY);
    await expect.poll(snapshot).not.toBe(panned);
    const doubleTapFit = await snapshot();

    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.keyboard.type("Panel: fit view");
    await page.keyboard.press("Enter");
    await expect.poll(snapshot).toBe(doubleTapFit);
  });
});
