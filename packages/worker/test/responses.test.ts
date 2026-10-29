// Cache-Control per route, on both sides of the front door → Api loopback, and the forwarding itself. Workers Caching stores
// what the Api entrypoint's Cache-Control allows; browsers see the front door's (outward) header.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { API_LIVE, API_WEATHER, IMMUTABLE, canonical, deterministic, internalCacheControl, outwardCacheControl } from "../src/responses.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const blocks = () => makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }))
const DAY = "/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445"
const ALIGN = "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-28T23:45:00Z&end=2026-10-29T02:00:00Z&stepSeconds=1800"
const POS_T = "/v1/position?lat=40.7&lon=-74&time=2026-10-28T11:51:00Z"
const POS_NOW = "/v1/position?lat=40.7&lon=-74"
const u = (p: string) => new URL("http://x" + p)

describe("Cache-Control policy", () => {
  it("deterministic: day, alignment, and position / magnetic with an explicit time", () => {
    for (const p of [DAY, ALIGN, POS_T, "/v1/magnetic?lat=1&lon=1&time=2026-10-28T00:00:00Z"]) expect(deterministic(u(p))).toBe(true)
    for (const p of [POS_NOW, "/v1/magnetic?lat=1&lon=1", "/v1/weather?lat=1&lon=1", "/v1/health"]) expect(deterministic(u(p))).toBe(false)
  })
  it("internal (Api entrypoint, what Workers Caching stores)", () => {
    expect(internalCacheControl(200, u(DAY))).toBe(IMMUTABLE)
    expect(internalCacheControl(200, u(ALIGN))).toBe(IMMUTABLE)
    expect(internalCacheControl(200, u(POS_T))).toBe(IMMUTABLE)
    expect(internalCacheControl(200, u(POS_NOW))).toBe(API_LIVE)
    expect(internalCacheControl(200, u("/v1/weather?lat=1&lon=1"))).toBe(API_WEATHER)
    expect(internalCacheControl(422, u(DAY))).toBe("no-store")
    expect(internalCacheControl(500, u(POS_T))).toBe("no-store")
  })
  it("outward (front door, what browsers see); / is never shareable", () => {
    expect(outwardCacheControl(200, u("/"))).toBe("private, no-store")
    expect(outwardCacheControl(200, u(DAY))).toBe(IMMUTABLE)
    expect(outwardCacheControl(200, u(POS_NOW))).toBe("no-store")
    expect(outwardCacheControl(200, u("/v1/weather?lat=1&lon=1"))).toBe("private, max-age=30")
    expect(outwardCacheControl(200, u("/v1/magnetic?lat=1&lon=1"))).toBe("public, max-age=3600")
    expect(outwardCacheControl(200, u("/docs"))).toBe("public, max-age=300")
    expect(outwardCacheControl(503, u("/v1/weather?lat=1&lon=1"))).toBe("no-store")
    expect(outwardCacheControl(200, u("/mcp"))).toBeUndefined()
  })
  it("the forwarded key sorts parameters, so ?a&b and ?b&a share one entry", () => {
    expect(canonical(u("/v1/position?time=t&lon=2&lat=1"))).toBe("/v1/position?lat=1&lon=2&time=t")
    expect(canonical(u("/v1/health"))).toBe("/v1/health")
  })
})

describe("roles", () => {
  it("api role: the Api entrypoint answers with the internal header", async () => {
    const h = makeHandler(blocks(), { role: "api" })
    const d = await h(new Request("http://api.internal" + DAY)); expect(d.status).toBe(200); expect(d.headers.get("cache-control")).toBe(IMMUTABLE)
    const n = await h(new Request("http://api.internal" + POS_NOW)); expect(n.headers.get("cache-control")).toBe(API_LIVE)
    const bad = await h(new Request("http://api.internal/v1/day?date=2026-10-28&tz=Nowhere/Zone&lat=1&lon=1")); expect(bad.status).toBe(422); expect(bad.headers.get("cache-control")).toBe("no-store")
  })
  it("front role: /v1 GETs go to the Api (sorted query), relay its cache status, outward header; / /docs /mcp stay local", async () => {
    const seen: Array<string> = []
    const apiH = makeHandler(blocks(), { role: "api" })
    const api = async (req: Request) => {
      seen.push(new URL(req.url).pathname + new URL(req.url).search)
      const r = await apiH(req); const h = new Headers(r.headers); h.set("cf-cache-status", seen.length === 1 ? "MISS" : "HIT")
      return new Response(r.body, { status: r.status, headers: h })
    }
    const front = makeHandler(blocks(), { role: "front", api })
    const a = await front(new Request("http://x/v1/day?lon=-74.0445&lat=40.6892&tz=America/New_York&date=2026-10-28"))
    expect(a.status).toBe(200); expect(a.headers.get("x-ephem-cache")).toBe("MISS"); expect(a.headers.get("cf-cache-status")).toBeNull()
    expect(a.headers.get("cache-control")).toBe(IMMUTABLE); expect(a.headers.get("access-control-allow-origin")).toBe("*")
    const b = await front(new Request("http://x" + DAY)); expect(b.headers.get("x-ephem-cache")).toBe("HIT")
    const strip = (t: string) => { const { provenance: _p, ...rest } = JSON.parse(t); return rest }
    expect(strip(await b.text())).toEqual(strip(await a.text()))
    expect(seen).toEqual(["/v1/day?date=2026-10-28&lat=40.6892&lon=-74.0445&tz=America%2FNew_York", "/v1/day?date=2026-10-28&lat=40.6892&lon=-74.0445&tz=America%2FNew_York"])
    const n = await front(new Request("http://x" + POS_NOW)); expect(n.headers.get("cache-control")).toBe("no-store"); expect(n.headers.get("x-ephem-cache")).toBeNull()   // live: computed here
    const home = await front(new Request("http://x/")); expect(home.headers.get("cache-control")).toBe("private, no-store"); expect(home.headers.get("x-ephem-cache")).toBeNull()
    expect((await front(new Request("http://x/docs"))).headers.get("x-ephem-cache")).toBeNull()
    expect(seen.length).toBe(2)   // the two days; never position-now, / or /docs
  })
  it("front role: a failed loopback is computed in place, flagged LOOPBACK_ERROR", async () => {
    const front = makeHandler(blocks(), { role: "front", api: async () => { throw new Error("loopback down") } })
    const r = await front(new Request("http://x" + POS_T)); expect(r.status).toBe(200); expect(r.headers.get("x-ephem-cache")).toBe("LOOPBACK_ERROR")
    expect(r.headers.get("cache-control")).toBe(IMMUTABLE)
  })
})

describe("Api entrypoint guards", () => {
  it("a response without Cache-Control becomes no-store (never heuristically cached); the front door forwards cf-ray as x-ephem-ray", async () => {
    const { defaultNoStore } = await import("../src/responses.ts")
    expect(defaultNoStore(new Response("nf", { status: 404 })).headers.get("cache-control")).toBe("no-store")
    expect(defaultNoStore(new Response("ok", { headers: { "cache-control": IMMUTABLE } })).headers.get("cache-control")).toBe(IMMUTABLE)
    const apiH = makeHandler(blocks(), { role: "api" }), rays: Array<string | null> = []
    const front = makeHandler(blocks(), { role: "front", api: async req => { rays.push(req.headers.get("x-ephem-ray")); return apiH(req) } })
    await front(new Request("http://x" + POS_T, { headers: { "cf-ray": "8d0000-EWR" } }))
    expect(rays).toEqual(["8d0000-EWR"])
    expect((await apiH(new Request("http://api.internal/v1/nope"))).status).toBe(404)
  })
})

describe("front door key", () => {
  it("keyPrefix sets cf.cacheKey to <prefix><path+sorted query>, so one build's Api answers never serve another's", async () => {
    const { live, forwards } = await import("../src/responses.ts")
    expect(live(u(POS_NOW))).toBe(true); expect(live(u(POS_T))).toBe(false); expect(forwards("GET", u(POS_NOW))).toBe(false)
    expect(forwards("GET", u("/v1/weather?lat=1&lon=1"))).toBe(true); expect(forwards("POST", u(DAY))).toBe(false)
    const keys: Array<unknown> = [], apiH = makeHandler(blocks(), { role: "api" })
    const front = makeHandler(blocks(), { role: "front", keyPrefix: "/build-1", api: async (req, init) => { keys.push(init?.cf?.cacheKey); return apiH(req) } })
    await front(new Request("http://x/v1/position?time=2026-10-28T11:51:00Z&lon=-74&lat=40.7"))
    expect(keys).toEqual(["/build-1/v1/position?lat=40.7&lon=-74&time=2026-10-28T11%3A51%3A00Z"])
  })
})
