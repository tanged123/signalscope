import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: "chartgpu-offline-doc-links",
      transform(source: string, id: string) {
        if (!id.includes("/frontend/vendor/chartgpu/")) return null;
        return {
          code: source
            .replaceAll("https://", "offline://")
            .replaceAll(
              '"http://www.w3.org/2000/svg"',
              '"http:" + "//www.w3.org/2000/svg"',
            )
            .replaceAll(
              "'http://www.w3.org/2000/svg'",
              "'http:' + '//www.w3.org/2000/svg'",
            ),
          map: null,
        };
      },
    },
  ],
  build: {
    cssCodeSplit: false,
    target: "es2022",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      "@chartgpu/chartgpu": resolve(
        frontendRoot,
        "vendor/chartgpu/src/index.ts",
      ),
    },
  },
  server: {
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8317",
    },
  },
});
