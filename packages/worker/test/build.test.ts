// crossVersionCache is on, so the only thing keeping one build's cached Api answers from another's is __EPHEM_BUILD__ in the
// front door's cf.cacheKey (src/responses.ts, src/index.ts). It must be fresh every time the config is evaluated (= every
// deploy), and the key must carry it.
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const DIR = resolve(__dirname, "..")
const evalBuild = () => JSON.parse(JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "-e",
  "import('./wrangler.config.ts').then(async m => { const c = await (typeof m.default === 'function' ? m.default({}) : m.default); console.log(JSON.stringify(c.define.__EPHEM_BUILD__)) })"],
  { cwd: DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!)) as string

describe("build id", () => {
  it("differs on every evaluation of wrangler.config.ts (every deploy): ISO time plus a random suffix", () => {
    const ids = [evalBuild(), evalBuild(), evalBuild()]
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z-[a-z0-9]{1,6}$/)
  }, 60_000)
})
