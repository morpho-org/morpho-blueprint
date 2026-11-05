import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Runs the parity dump, not a test suite: the root `vitest.config.mts` (jsdom, anvil global setup)
// never sees this file. `PARITY_APP` is the checkout whose providers are dumped, so the same script
// dumps `main` and a branch.
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(process.env.PARITY_APP ?? path.join(here, "../.."));
const stub = (name: string) => path.join(here, "stubs", name);

export default defineConfig({
  root: here,
  // Keeps Vite's cache in the ignored root node_modules, not next to the scripts.
  cacheDir: path.join(here, "../../node_modules/.vite/parity-dump"),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.join(app, "src")}/` },
      { find: /^server-only$/, replacement: stub("server-only.ts") },
      { find: /^next\/cache$/, replacement: stub("next-cache.ts") },
      { find: /^next\/font\/(google|local)$/, replacement: stub("next-font.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["parity-dump.task.ts"],
    testTimeout: 600_000,
    retry: 0,
    reporters: ["default"],
  },
});
