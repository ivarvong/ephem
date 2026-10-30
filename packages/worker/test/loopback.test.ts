// Guardrail for crossVersionCache: every fetch to our own cache-enabled entrypoints goes through src/loopback.ts, which puts
// CACHE_VERSION in the key. A static check over the source, plus the keys themselves.
import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { apiCacheKey, makeLoopback, resolveBindings, type Binding } from "../src/loopback.ts"
import { CACHE_TAG, CACHE_VERSION } from "../src/cache-version.ts"
import { serveBlock } from "../src/blocks.ts"
import { FEED_PATH } from "../src/metar-feed.ts"

const SRC = resolve(__dirname, "../src")
/** Source without comments and string/template literals, so prose and URLs never trip the check. */
const code = (f: string) => readFileSync(`${SRC}/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/`[^`]*`|"[^"\n]*"|'[^'\n]*'/g, "''")
/** A read of a binding off ctx.exports (exports.Api, exports?.X, exports["X"]), off the `loop` / `bound` hand-offs in
 *  index.ts / compute.ts, or of a service binding to a compute Worker (env.COMPUTE, env.STORE: removed, DESIGN §12.0). */
const bypass = (line: string) => /\bexports\b\s*(\?\.|\.|\[)/.test(line) || /\b(loop|bound)\b\s*(\?\.|\.|\[)/.test(line) || /\b(COMPUTE|STORE)\b\s*(\?\.|\.|\[)/.test(line)

describe("loopback guardrail", () => {
  it("no source file outside loopback.ts reads a binding off ctx.exports (only `loop = ctx.exports` hand-offs)", () => {
    const offenders: string[] = []
    for (const f of readdirSync(SRC).filter(f => f.endsWith(".ts") && f !== "loopback.ts" && f !== "cloudflare.d.ts"))
      for (const [n, line] of code(f).split("\n").entries()) if (bypass(line)) offenders.push(`${f}:${n + 1}: ${line.trim()}`)
    expect(offenders, "fetch our entrypoints only through src/loopback.ts").toEqual([])
  })
  it("the check catches a bypass, and does not flag the hand-off", () => {
    for (const bad of ["const r = await this.ctx.exports.Api.fetch(req)", "const s = ctx.exports?.[x]", "const x = loop?.MetarFeed", "env.exports.BlockStore", "await env.COMPUTE.fetch(req)", "this.env.STORE?.fetch(r)", "bound?.COMPUTE"]) expect(bypass(bad), bad).toBe(true)
    for (const ok of ["loop = ctx.exports", "loop = this.ctx.exports", "loop = ctx.exports; bound = env", "export { Admin } from x"]) expect(bypass(ok), ok).toBe(false)
  })
  it("keys: Api /v<N>/path?query in cf.cacheKey, blocks /block/v<N>/…, feed /feed/v<N>/…", async () => {
    const seen: Array<{ to: string; url: string; key?: string | undefined }> = []
    const bind = (to: string): Binding => ({ fetch: async (req, init) => { const u = new URL(req.url); seen.push({ to, url: u.pathname + u.search, key: init?.cf?.cacheKey }); return new Response("") } })
    const lb = makeLoopback(() => ({ Api: bind("Api"), BlockStore: bind("BlockStore"), MetarFeed: bind("MetarFeed") }))
    await lb.api("/v1/day?date=2026-10-28&lat=1&lon=2&tz=UTC", { method: "GET", headers: {} }); await lb.block(5442); await lb.feed()
    expect(CACHE_TAG).toBe(`v${CACHE_VERSION}`)
    expect(seen[0]).toEqual({ to: "Api", url: "/v1/day?date=2026-10-28&lat=1&lon=2&tz=UTC", key: `/${CACHE_TAG}/v1/day?date=2026-10-28&lat=1&lon=2&tz=UTC` })
    expect(apiCacheKey("/v1/x")).toBe(`/${CACHE_TAG}/v1/x`)
    expect(seen[1]!.url).toMatch(new RegExp(`^/block/${CACHE_TAG}/[0-9a-f]{16}/5442$`)); expect(seen[1]!.key).toBeUndefined()
    expect(seen[2]!.url).toBe(`/feed/${CACHE_TAG}/metars.cache.csv.gz`); expect(FEED_PATH).toBe(seen[2]!.url)
    expect(() => makeLoopback(() => undefined).feed()).toThrow(/unavailable/)
  })
  it("front door: Api, BlockStore and MetarFeed are this Worker's own ctx.exports, with the tagged keys", async () => {
    const seen: Array<{ to: string; url: string; key?: string | undefined }> = []
    const bind = (to: string): Binding => ({ fetch: async (req, init) => { const u = new URL(req.url); seen.push({ to, url: u.pathname + u.search, key: init?.cf?.cacheKey }); return new Response("") } })
    const lb = makeLoopback(() => resolveBindings({ Api: bind("Api"), BlockStore: bind("BlockStore"), MetarFeed: bind("MetarFeed") }))
    await lb.api("/v1/track?a=1", { method: "GET", headers: {} }); await lb.block(1); await lb.geoid(3); await lb.feed()
    expect(seen.map(s => s.to)).toEqual(["Api", "BlockStore", "BlockStore", "MetarFeed"])
    expect(seen[0]!.key).toBe(`/${CACHE_TAG}/v1/track?a=1`)
    expect(seen[2]!.url).toMatch(new RegExp(`^/geoid/${CACHE_TAG}/[0-9a-f]{16}/3$`))
  })
  it("BlockStore answers only the tagged path", async () => {
    expect((await serveBlock(new Request("https://b/de440/29915576d0a65557/5442"), async () => new ArrayBuffer(8))).status).toBe(404)
  })
})
