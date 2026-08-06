import { expect, test } from "vitest";
import { TILE_BIN_BUDGET } from "./budgets";

test("the tile bin budget is the value ADR 0036 sized transports around", () => {
  expect(TILE_BIN_BUDGET).toBe(250_000);
});
