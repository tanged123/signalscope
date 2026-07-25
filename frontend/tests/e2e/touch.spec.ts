import { expect, test } from "./fixtures";

test.describe("touch gestures", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".panel").first()).toBeVisible();
  });

  test("a one-finger drag pans and a double tap fits", async ({
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

    for (let tap = 0; tap < 2; tap += 1) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: at(200, 120),
      });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    }
    await expect(readout).toHaveText(fitted ?? "");
  });
});
