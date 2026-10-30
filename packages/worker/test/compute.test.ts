// The Api router (src/router.ts makeApiHandler): the same /v1 answers as the front door's own router, none of its pages;
// and the front door forwards cf-ray (and the version override, harmless over ctx.exports) with every forward.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { makeApiHandler } from "../src/router.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { IMMUTABLE, VERSION_OVERRIDES, forwardHeaders } from "../src/responses.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const blocks = () => makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }))
const DAY = "/v1/day?date=2026-10-28&lat=40.6892&lon=-74.0445&tz=America%2FNew_York"
const POS_T = "/v1/position?lat=40.7&lon=-74&time=2026-10-28T11%3A51%3A00Z"
const PIN = 'ephem="0f0f0f0f-0000-4000-8000-000000000000"'
const strip = (j: any) => { delete j.provenance; return j }

describe("Api router", () => {
  it("answers deterministic /v1 routes exactly as the in-process router, with the Api's immutable Cache-Control", async () => {
    const api = makeApiHandler(blocks(), { role: "api" }), local = makeHandler(blocks())
    for (const p of [DAY, POS_T]) {
      const a = await api(new Request("https://api.internal" + p)), l = await local(new Request("http://x" + p))
      expect(a.status, p).toBe(200); expect(a.headers.get("cache-control"), p).toBe(IMMUTABLE)
      expect(strip(await a.json()), p).toEqual(strip(await l.json()))
    }
  })
  it("has no homepage, docs, openapi.json or MCP (front door only)", async () => {
    const api = makeApiHandler(blocks(), { role: "api" })
    for (const p of ["/", "/docs", "/llms.txt", "/openapi.json"]) expect((await api(new Request("https://api.internal" + p))).status, p).toBe(404)
    expect((await api(new Request("https://api.internal/mcp", { method: "POST", body: "{}" }))).status).toBe(404)
  })
  it("the front door forwards cf-ray and Cloudflare-Workers-Version-Overrides (REST, search windows, MCP tools), nothing else", async () => {
    expect(forwardHeaders({ "cf-ray": "r1-EWR", [VERSION_OVERRIDES]: PIN, cookie: "x", "user-agent": "curl" })).toEqual({ "x-ephem-ray": "r1-EWR", [VERSION_OVERRIDES]: PIN })
    expect(forwardHeaders({})).toEqual({})
    const api = makeApiHandler(blocks(), { role: "api" }), seen: Array<Record<string, string>> = []
    const front = makeHandler(blocks(), { role: "front", api: async (pq, init) => { seen.push(init.headers); return api(new Request("https://api.internal" + pq, init)) } })
    const h = { "cf-ray": "r2-EWR", [VERSION_OVERRIDES]: PIN }
    expect((await front(new Request("http://x" + POS_T, { headers: h }))).status).toBe(200)
    const mcp = await front(new Request("http://x/mcp", { method: "POST", headers: { ...h, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sun_moon_position", arguments: { lat: 40.7, lon: -74, time: "2026-10-28T11:51:00Z" } } }) }))
    expect(mcp.status).toBe(200)
    expect(seen.length).toBe(2)
    for (const s of seen) expect(s).toEqual({ "x-ephem-ray": "r2-EWR", [VERSION_OVERRIDES]: PIN })
  })
})
