import { defineConfig } from "vitest/config"
// packages/web's tests render TSX (Preact). The web build (dist/: assets.json, the client bundle) must exist: `npm test` runs
// scripts/build-web.ts --if-stale first.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  test: { include: ["packages/*/test/**/*.test.{ts,tsx}"], setupFiles: ["./test-setup.ts"] },
})
