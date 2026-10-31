import { bindings, defineConfig } from "cf/config"

// ephem's Tail Worker: one row per ephem invocation to the Basin stream ephem_invocations (ops/basin/invocations.schema.json in
// packages/worker). Catches what ephem's own waitUntil row cannot: exceededCpu, exceededMemory, exception, canceled.
export default defineConfig({
  worker: {
    name: "ephem-tail",
    compatibilityDate: "2026-10-01",
    entrypoint: "src/index.ts",
    observability: { enabled: true },
    env: {
      INVOCATIONS: bindings.pipeline({ name: "2d45db937f214e5cae5c19ba4c099779" }), // stream ephem_invocations
    },
  },
})
