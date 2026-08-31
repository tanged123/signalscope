import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--release")) {
  await rm(fileURLToPath(new URL("../release", import.meta.url)), {
    recursive: true,
    force: true,
  });
} else {
  await rm(fileURLToPath(new URL("../dist", import.meta.url)), {
    recursive: true,
    force: true,
  });
}
