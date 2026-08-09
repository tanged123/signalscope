import { defineConfig } from "vitest/config";

export default defineConfig({
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
      "tests/bench/**/*.spec.ts",
      "tests/gpu/**",
      "node_modules/**",
      "dist/**",
    ],
  },
});
