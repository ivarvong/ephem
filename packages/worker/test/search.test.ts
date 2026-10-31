// /v1/alignment/search through the real router: the POST (validation, fan-out, merge, filters), the cacheable window GET,
// the front door → Api loopback with a fake Workers Caching (overlapping scans share windows), and failure mapping.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { encodeRegion, parseRegion, setGeoidSource } from "@ephem/core"
import { bundledGeoidBand } from "../../core/src/geoid-bundled.ts"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { makeGeoid } from "../src/geoid.ts"
import { IMMUTABLE, deterministic } from "../src/responses.ts"
import { SEARCH_WINDOW_PATH } from "../src/search.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures")
const blocks = () =>
  makeBlocks(
    direct(async (first) => {
      const b = readFileSync(`${FIX}/blocks/${first}.bin`)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
    }),
  )
// © OpenStreetMap contributors, ODbL 1.0 (OSM way 56469108; attribution in the fixture's properties)
const PARK = JSON.parse(readFileSync(`${FIX}/regions/brooklyn-bridge-park.geojson`, "utf8"))
const BODY = {
  body: "moon",
  targetLat: 40.68925,
  targetLon: -74.0445,
  targetHeight: 70,
  targetHeightRef: "msl",
  region: PARK,
  height: 5,
  heightRef: "msl",
  start: "2026-11-16T00:00:00Z",
  end: "2026-11-18T00:00:00Z",
}
const local = makeHandler(blocks())
const post = async (h: typeof local, body: unknown, headers: Record<string, string> = {}) => {
  const r = await h(
    new Request("http://x/v1/alignment/search", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
  return { status: r.status, headers: r.headers, j: (await r.json()) as any }
}

describe("POST /v1/alignment/search", () => {
  it("the Liberty reference Nov 16 pass: one call, exact entry 2026-11-17T03:45:19Z at 40.70329, −73.99630", async () => {
    const { status, j, headers } = await post(local, BODY)
    expect(status).toBe(200)
    expect(headers.get("cache-control")).toBe("no-store")
    expect(j.passes).toHaveLength(1)
    const p = j.passes[0],
      e = p.segments[0].enter
    expect(Math.abs(Date.parse(e.time) - Date.parse("2026-11-17T03:45:19.646Z"))).toBeLessThanOrEqual(5)
    expect(e.lat).toBeCloseTo(40.70329, 5)
    expect(e.lon).toBeCloseTo(-73.9963, 5)
    expect(p.segments).toHaveLength(2) // the track crosses an inlet
    expect(p.illuminatedFraction).toBeCloseTo(0.469, 3)
    expect(p.apparentAltitude).toBeCloseTo(0.8, 2)
    expect(p.sunAltitude).toBeLessThan(-60)
    expect(p.angularRadius).toBeCloseTo(0.26, 1)
    expect(p).not.toHaveProperty("sun")
    expect(p).not.toHaveProperty("phase")
    expect(j.target).toMatchObject({ heightMsl: 70, heightRef: "msl" })
    expect(j.observer).toMatchObject({ height: 5, heightRef: "msl" })
    expect(j.region).toMatchObject({
      polygons: 1,
      vertices: 423,
      encoding: encodeRegion((parseRegion(PARK) as any).ok),
    })
    expect(j.conventions).toMatchObject({ heightRef: "msl", targetHeightRef: "msl", terrestrialRefractionK: 0.13 })
    expect(j.search.windows.map((w: any) => w.cache)).toEqual(["LOCAL"])
    expect(j.search.counters.anomalies).toBe(0)
    expect(j.provenance.diagnostics.cache.windows).toBe(1)
  }, 30_000)
  it("filters and include run after the windows", async () => {
    const dark = await post(local, { ...BODY, maxSunAltitude: -4, minIlluminated: 0.1, include: "sun,phase" })
    expect(dark.j.passes).toHaveLength(1)
    expect(dark.j.passes[0].phase.name).toMatch(/quarter|crescent|gibbous/)
    expect(dark.j.passes[0].sun.altitude).toBe(dark.j.passes[0].sunAltitude)
    // include = /v1/position at the pass instant from where the pass is seen (sweep 2026-10-31): the Sun's place and the Moon's phase
    const p = dark.j.passes[0],
      seg = p.segments[0],
      where = `lat=${seg.enter.lat}&lon=${seg.enter.lon}&height=5&heightRef=msl&time=${p.time}`
    const pos = (await (await local(new Request(`http://x/v1/position?${where}`))).json()) as any
    expect(Math.abs(p.sun.altitude - pos.sun.altitude)).toBeLessThan(1e-3)
    expect(Math.abs(p.sun.azimuth - pos.sun.azimuth)).toBeLessThan(1e-2) // standing point of the instant ≈ the segment's entry (≤ km)
    expect(Math.abs(p.phase.illuminatedFraction - pos.moon.phase.illuminatedFraction)).toBeLessThan(1e-4)
    expect(p.phase.name).toBe(pos.moon.phase.name)
    const bright = await post(local, { ...BODY, minIlluminated: 0.5 })
    expect(bright.j.passes).toHaveLength(0)
    expect(bright.j.search.passesBeforeFilters).toBe(1)
  }, 30_000)
  it("aim=litCentroid moves the entry earlier; litCentroid needs the Moon", async () => {
    const a = await post(local, { ...BODY, aim: "litCentroid" })
    expect(a.status).toBe(200)
    expect(a.j.conventions.aim.point).toBe("litCentroid")
    expect(Date.parse(a.j.passes[0].segments[0].enter.time)).toBeLessThan(Date.parse("2026-11-17T03:45:00Z"))
    expect((await post(local, { ...BODY, body: "sun", aim: "litCentroid" })).status).toBe(400)
  }, 30_000)
  it("rejects bad input with the reason", async () => {
    const bad = async (patch: object, status: number, msg: RegExp) => {
      const r = await post(local, { ...BODY, ...patch })
      expect(r.status, JSON.stringify(patch)).toBe(status)
      expect(r.j.message).toMatch(msg)
    }
    await bad({ end: BODY.start }, 400, /end=.* must be after start=/)
    await bad({ end: "2028-01-01T00:00:00Z" }, 400, /at most 400 days/)
    await bad({ region: [-74.05, 40.68, -74.04, 40.7] }, 400, /target is inside the region/)
    await bad({ region: [-74, 40, -73, 41] }, 400, /km across/)
    await bad({ height: 200 }, 400, /above the eye/)
    await bad({ start: "1960-01-01T00:00:00Z" }, 400, /outside/)
    expect((await post(local, { ...BODY, nope: 1 })).status).toBe(400)
  }, 30_000)
})

describe("GET /internal/alignment-search-window", () => {
  const enc = encodeRegion((parseRegion(PARK) as any).ok)
  const W = `${SEARCH_WINDOW_PATH}?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&height=5&heightRef=msl&region=${enc}&start=2026-11-03T00:00:00Z`
  it("is deterministic (immutable) and refuses off-grid starts and non-canonical regions", async () => {
    expect(deterministic(new URL("http://x" + W))).toBe(true)
    const r = await local(new Request("http://x" + W))
    const j = (await r.json()) as any
    expect(r.status).toBe(200)
    expect(j.start).toBe("2026-11-03T00:00:00.000Z")
    expect(j.end).toBe("2026-12-03T00:00:00.000Z")
    expect(j.passes.length).toBeGreaterThan(3)
    expect(j.passes.every((p: any) => p.sun && p.phase)).toBe(true)
    expect((await local(new Request("http://x" + W.replace("2026-11-03", "2026-11-04")))).status).toBe(400)
    expect((await local(new Request("http://x" + W.replace(enc, enc.slice(0, -3))))).status).toBe(400)
  }, 30_000)
})

describe("front door → Api windows (fake Workers Caching)", () => {
  it("a scan fans out per window; a repeat and a scan shifted by days hit the cache; filters never split it", async () => {
    const apiH = makeHandler(blocks(), { role: "api" }),
      store = new Map<string, string>(),
      keys: string[] = []
    const api = async (pq: string, init: RequestInit) => {
      keys.push(pq)
      const hit = store.get(pq)
      if (hit) return new Response(hit, { headers: { "cf-cache-status": "HIT", "content-type": "application/json" } })
      const r = await apiH(new Request("https://api.internal" + pq, init)),
        text = await r.text()
      if (r.status === 200 && r.headers.get("cache-control") === IMMUTABLE) store.set(pq, text)
      return new Response(text, {
        status: r.status,
        headers: { ...Object.fromEntries(r.headers), "cf-cache-status": "MISS" },
      })
    }
    const front = makeHandler(blocks(), { role: "front", api })
    const scan = { ...BODY, start: "2026-10-30T00:00:00Z", end: "2026-12-30T00:00:00Z" }
    const a = await post(front, scan, { "cf-ray": "abc-EWR" })
    expect(a.status).toBe(200)
    expect(a.j.search.windows.map((w: any) => w.cache)).toEqual(["MISS", "MISS", "MISS"])
    expect(keys.every((k) => k.startsWith(SEARCH_WINDOW_PATH + "?"))).toBe(true)
    const b = await post(front, { ...scan, maxSunAltitude: -4, include: "phase" })
    expect(b.j.search.windows.map((w: any) => w.cache)).toEqual(["HIT", "HIT", "HIT"])
    const c = await post(front, { ...scan, start: "2026-11-02T00:00:00Z", end: "2027-01-05T00:00:00Z" })
    expect(c.j.search.windows.map((w: any) => w.cache)).toEqual(["HIT", "HIT", "HIT", "MISS"]) // only the new window computes
    expect(store.size).toBe(4)
    const strip = (x: any) => x.passes.map((p: any) => p.segments)
    expect(strip(b.j)).toEqual(strip(a.j).filter((_: unknown, i: number) => a.j.passes[i].sunAltitude <= -4))
    // the merged answer equals the in-process one
    expect(strip(a.j)).toEqual(strip((await post(local, scan)).j))
  }, 60_000)
})

describe("geoid unavailable", () => {
  it("is a 503 Unavailable from the window and from the POST, never a guessed height", async () => {
    const h = makeHandler(
      blocks(),
      undefined,
      undefined,
      makeGeoid(async () => {
        throw new Error("R2 down")
      }),
    )
    try {
      const r = await post(h, BODY)
      expect(r.status).toBe(503)
      expect(r.j._tag).toBe("Unavailable")
      const apiH = makeHandler(
        blocks(),
        { role: "api" },
        undefined,
        makeGeoid(async () => {
          throw new Error("R2 down")
        }),
      )
      const front = makeHandler(blocks(), {
        role: "front",
        api: (pq, init) => apiH(new Request("https://api.internal" + pq, init)),
      })
      const f = await post(front, BODY)
      expect(f.status).toBe(503)
      expect(f.j._tag).toBe("Unavailable")
    } finally {
      setGeoidSource(bundledGeoidBand)
    }
  }, 30_000)
})
