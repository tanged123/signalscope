import type { Page } from "@playwright/test";
import { PROTOCOL_VERSION } from "../../src/generated/protocol";

export async function waitForNativeSourceCount(
  page: Page,
  expected: number,
  timeout = 900_000,
): Promise<void> {
  await page.waitForFunction(
    async ({ expectedSources, protocolVersion }) => {
      const bridge = window.scopeDesktop;
      if (bridge === undefined) return false;
      const connection = await bridge.connect();
      const response = await fetch(`${connection.baseUrl}/v1/catalog/sources`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          protocol_version: protocolVersion,
          payload: null,
        }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { payload?: unknown };
      return (
        Array.isArray(body.payload) && body.payload.length === expectedSources
      );
    },
    { expectedSources: expected, protocolVersion: PROTOCOL_VERSION },
    { timeout },
  );
}

export async function nativeSourceCount(page: Page): Promise<number> {
  const count = await page.evaluate(async (protocolVersion) => {
    const bridge = window.scopeDesktop;
    if (bridge === undefined) throw new Error("desktop bridge is absent");
    const connection = await bridge.connect();
    const response = await fetch(`${connection.baseUrl}/v1/catalog/sources`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        protocol_version: protocolVersion,
        payload: null,
      }),
    });
    if (!response.ok)
      throw new Error(`catalog request failed: ${String(response.status)}`);
    const body = (await response.json()) as { payload?: unknown };
    if (!Array.isArray(body.payload))
      throw new Error("catalog payload is not an array");
    return body.payload.length;
  }, PROTOCOL_VERSION);
  return count;
}
