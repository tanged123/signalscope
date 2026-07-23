import { defineConfig } from "vite";

export default defineConfig({
  build: {
    cssCodeSplit: false,
    target: "es2022",
  },
  server: {
    strictPort: true,
  },
});
