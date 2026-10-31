// Effect imports go by module subpath (`import * as Effect from "effect/Effect"`), never through a barrel ("effect",
// "effect/http", "effect/http-api"): esbuild keeps the whole namespace object of `import { Schema } from "effect"`, so
// every barrel import kept all of that module (bundle 630 → 411 KB when removed, 2026-10-30; docs/telemetry_and_profiling.md).
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(__dirname, "../..")
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [])
describe("bundle hygiene", () => {
  it("no Effect barrel imports in bundled sources", () => {
    const bad = ["api", "core", "worker"].flatMap(p => files(join(ROOT, p, "src"))).flatMap(f =>
      readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => /from\s+"effect(\/http|\/http-api)?"/.test(l)))
    expect(bad.map(([f, i, l]) => `${f.slice(ROOT.length + 1)}:${i}: ${l.trim()}`)).toEqual([])
  })
  it("the Worker never imports the bundled EGM96 grid (it reads bands from R2)", () => {
    const bad = files(join(ROOT, "worker", "src")).filter(f => !f.endsWith("dev-handler.ts") && /egm96-grid|geoid-bundled/.test(readFileSync(f, "utf8")))
    expect(bad).toEqual([])
    expect(readFileSync(join(ROOT, "core", "src", "index.ts"), "utf8")).not.toMatch(/egm96-grid|geoid-bundled/)
  })
})
