import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  cacheDir: "./node_modules/.vite",
  test: { include: ["test/*.test.ts"], environment: "node", setupFiles: ["./test/offline.ts"], watch: false }
});
