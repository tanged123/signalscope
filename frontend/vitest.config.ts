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
    // The pinned ChartGPU fork's own suite only changes with the fork, so it
    // runs on its own: `./scripts/test.sh chartgpu` and the CI frontend job.
    projects: [
      {
        extends: true,
        test: {
          name: "app",
          exclude: [
            "vendor/**",
            "tests/e2e/**",
            "tests/bench/**",
            "node_modules/**",
            "dist/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "chartgpu",
          include: ["vendor/chartgpu/src/**/*.test.ts"],
        },
      },
    ],
  },
});
