import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint, Linter } from "eslint";
import tseslint from "typescript-eslint";

const eslint = new ESLint({
  cwd: fileURLToPath(new URL("..", import.meta.url)),
});

async function violations(file, source) {
  const config = await eslint.calculateConfigForFile(file);
  return new Linter().verify(source, {
    languageOptions: { parser: tseslint.parser },
    rules: { "no-restricted-imports": config.rules["no-restricted-imports"] },
  });
}

for (const [file, source] of [
  ["src/app/workspace.ts", 'import { PanelView } from "../ui/panel";'],
  ["src/render/chart-host.ts", 'export { PanelView } from "../ui/panel";'],
  [
    "src/app/workspace.ts",
    'import type { GpuContext } from "../render/gpu-context";',
  ],
  ["src/app/workspace.ts", 'import { ChartGPU } from "@chartgpu/chartgpu";'],
  [
    "src/render/chart-host.ts",
    'import type { WorkspaceModel } from "../app/workspace";',
  ],
  [
    "src/ui/panel.ts",
    'import { HttpPlane as Plane } from "../app/data-plane";',
  ],
  [
    "src/render/chart-host.ts",
    'import { BakedPlane } from "../app/data-plane";',
  ],
]) {
  test(`${file} rejects ${source}`, async () => {
    assert.equal(
      (await violations(file, source))[0]?.ruleId,
      "no-restricted-imports",
    );
  });
}

for (const [file, source] of [
  [
    "src/app/line2d-family.ts",
    'import { line2DFromTimeTiles } from "../render/time-adapter";',
  ],
  [
    "src/app/line-presentation-controller.ts",
    'import { prepareTimeTiles } from "../render/time-adapter";',
  ],
  [
    "src/render/time-adapter.ts",
    'import type { ColumnarTileResponse } from "../app/bin-columns";',
  ],
  ["src/ui/panel.ts", 'import type { DataPlane } from "../app/data-plane";'],
]) {
  test(`${file} allows ${source}`, async () => {
    assert.deepEqual(await violations(file, source), []);
  });
}
