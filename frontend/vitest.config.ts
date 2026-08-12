import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const frontendRoot = resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: {
      "@chartgpu/chartgpu": resolve(
        frontendRoot,
        "vendor/chartgpu/src/index.ts",
      ),
    },
  },
  test: {
    coverage: {
      exclude: ["src/**/*.test.ts", "src/generated/**", "tests/**"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json", "lcov"],
      reportsDirectory: "../build/coverage/frontend",
    },
    exclude: [
      "tests/e2e/**",
      "tests/demo/**",
      "tests/bench/**",
      "node_modules/**",
      "dist/**",
    ],
  },
});
