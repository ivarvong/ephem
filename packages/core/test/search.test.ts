// /v1/alignment/search core: region canonicalisation, the customer's 12-month Brooklyn Bridge Park scan (round-2 feedback),
// completeness against a brute-force scan that shares none of the search's band or scan logic, and exactness of entries.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  type Geodetic, type Region, SEARCH, WINDOW_MS, apparent, decodeRegion, encodeRegion, frameAt, geoidUndulation, insideRegion, instant, parseRegion,
  direct, planarRegion, regionBbox, searchGeometry, searchWindow, searchWindowRequest, searchWindowRequestSteps, standingPoint, targetElevation, topocentric, windowsFor,
} from "../src/index.ts"
import { diskBlocks } from "./helpers/blocks.ts"

// © OpenStreetMap contributors, ODbL 1.0: OSM way 56469108 (Brooklyn Bridge Park), version 73, 424 node refs; see the fixture's properties.
const PARK = JSON.parse(readFileSync(resolve(__dirname, "fixtures/regions/brooklyn-bridge-park.geojson"), "utf8"))
const region = (x: unknown): Region => { const r = parseRegion(x); if ("error" in r) throw new Error(r.error); return r.ok }
const park = region(PARK)
const LIBERTY = { lat: 40.68925, lon: -74.0445 }
const target = { ...LIBERTY, height: 70 + geoidUndulation(LIBERTY.lat, LIBERTY.lon) }   // figure middle ~70 m MSL
const EYE = { observerHeight: 5, observerHeightRef: "msl" as const }                       // 5 m MSL
const T0 = Date.parse("2026-10-30T00:00:00Z"), T1 = Date.parse("2027-10-30T00:00:00Z")

const scan = (body: "sun" | "moon", tg: Geodetic, reg: Region, eye: { observerHeight: number; observerHeightRef?: "msl" | "ellipsoid" }, from: number, to: number) => {
  const passes = [], counters: Record<string, number> = {}
  for (const w of windowsFor(from, to)) {
    const r = searchWindow(diskBlocks, { body, target: tg, region: reg, ...eye, startMs: Math.max(w, from), endMs: Math.min(w + WINDOW_MS, to) })
    if ("error" in r) throw new Error(r.error)
    passes.push(...r.passes)
    for (const [k, v] of Object.entries(r.counters)) counters[k] = (counters[k] ?? 0) + v
  }
  return { passes, counters }
}

/** Independent of searchGeometry and the scan: every `step` s while the body's true altitude at the region's centre is in
 *  [−1.5°, max elevation over a grid of the region + 3°], solve the standing point and test it against the region. */
const brute = (body: "sun" | "moon", tg: Geodetic, reg: Region, eye: { observerHeight: number; observerHeightRef?: "msl" | "ellipsoid" }, from: number, to: number, step: number) => {
  const b = regionBbox(reg), pr = planarRegion(reg), eyeAt = (lat: number, lon: number) => eye.observerHeight + (eye.observerHeightRef === "msl" ? geoidUndulation(lat, lon) : 0)
  let eMax = -90
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
    const lat = b.south + (b.north - b.south) * i / 40, lon = b.west + (b.east - b.west) * j / 40
    if (insideRegion(pr, lon, lat)) eMax = Math.max(eMax, targetElevation({ lat, lon, height: eyeAt(lat, lon) }, tg).elevation)
  }
  const ref = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2, height: eyeAt((b.south + b.north) / 2, (b.west + b.east) / 2) }
  const inp = { body, target: tg, ...eye, startMs: 0, endMs: 0, stepSeconds: 1, maxDistanceKm: 120 }
  const inside: number[] = []
  let seed = { backAz: 0, az: 0, dist: 0, slope: 0, lt: 0 }
  for (let t = from; t < to;) {
    const f = frameAt(diskBlocks, instant(t), ref), h = topocentric(f, apparent(diskBlocks, f, body).v).altitude
    if (h < -1.5 || h > eMax + 3) { t += Math.max(step * 1000, Math.min(Math.abs(h + 1.5), Math.abs(h - eMax - 3)) / 16 * 3.6e6 * 0.9); seed = { backAz: 0, az: 0, dist: 0, slope: 0, lt: 0 }; continue }
    const p = standingPoint(diskBlocks, inp, t, seed)
    if (p && insideRegion(pr, p.lon, p.lat)) inside.push(t)
    t += step * 1000
  }
  return inside
}
const checkComplete = (passes: ReadonlyArray<{ segments: ReadonlyArray<{ enter: { time: string }; exit: { time: string } }> }>, inside: number[], step: number) => {
  const segs = passes.flatMap(p => p.segments.map(s => [Date.parse(s.enter.time), Date.parse(s.exit.time)] as const))
  const missed = inside.filter(t => !segs.some(([a, z]) => t >= a - 2 && t <= z + 2))
  const unsampled = segs.filter(([a, z]) => z - a > 2000 * step && !inside.some(t => t >= a && t <= z))
  return { missed: missed.map(t => new Date(t).toISOString()), unsampled: unsampled.length, samples: inside.length, segments: segs.length }
}

describe("region", () => {
  it("canonical: orientation, start vertex, closing vertex and 1e-7° quantisation do not change the encoding", () => {
    const ring = [[-74, 40.7], [-73.99, 40.7], [-73.99, 40.71], [-74, 40.71]]
    const a = encodeRegion(region({ type: "Polygon", coordinates: [[...ring, ring[0]]] }))
    const b = encodeRegion(region({ type: "Polygon", coordinates: [[...ring].reverse().map(([x, y]) => [x! + 3e-9, y!])] }))
    const c = encodeRegion(region([-74, 40.7, -73.99, 40.71]))
    const d = encodeRegion(region({ type: "Feature", properties: null, geometry: { type: "MultiPolygon", coordinates: [[[...ring.slice(2), ...ring.slice(0, 2)]]] } }))
    expect(new Set([a, b, c, d]).size).toBe(1)
    expect(a).toMatch(/^r1\.[A-Za-z0-9_-]+$/)
  })
  it("round-trips the 424-node park, holes and multipolygons; refuses non-canonical encodings", () => {
    const e = encodeRegion(park), back = decodeRegion(e)
    expect("ok" in back && encodeRegion(back.ok)).toBe(e)
    expect(park[0]![0]!.length).toBe(423)   // 424 refs, the last closes the ring
    expect(e.length).toBeLessThan(4000)
    const k = (r: number[][]) => r.map(([x, y]) => [x! / 100, y! / 100])
    const holed = region({ type: "MultiPolygon", coordinates: [
      [k([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]), k([[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]])],
      [k([[1.1, 0.1], [1.15, 0.1], [1.15, 0.15], [1.1, 0.1]])],
    ] })
    expect(holed.length).toBe(2)
    const pr = planarRegion(holed)
    expect(insideRegion(pr, 0.005, 0.005)).toBe(true); expect(insideRegion(pr, 0.0035, 0.0025)).toBe(false); expect(insideRegion(pr, 0.015, 0.005)).toBe(false); expect(insideRegion(pr, 0.0114, 0.0011)).toBe(true)
    const hb = decodeRegion(encodeRegion(holed)); expect("ok" in hb && encodeRegion(hb.ok)).toBe(encodeRegion(holed))
    expect("error" in decodeRegion(e.slice(0, -2))).toBe(true)
    expect("error" in decodeRegion("r1.AAAA")).toBe(true)
  })
  it("limits", () => {
    const many = Array.from({ length: 1001 }, (_, i) => [Math.cos(i / 1001 * 2 * Math.PI) / 100, Math.sin(i / 1001 * 2 * Math.PI) / 100])
    expect(parseRegion({ type: "Polygon", coordinates: [many] })).toMatchObject({ error: expect.stringMatching(/1001 vertices; at most 1000/) })
    expect(parseRegion([0, 0, 1, 1])).toMatchObject({ error: expect.stringMatching(/km across/) })
    expect(parseRegion([1, 0, 0, 1])).toMatchObject({ error: expect.stringMatching(/west < east/) })
    expect(parseRegion({ type: "Polygon", coordinates: [[[0, 0], [1, 1], [0, 0]]] })).toMatchObject({ error: expect.stringMatching(/at least 3/) })
    expect(parseRegion({ type: "Point", coordinates: [0, 0] })).toMatchObject({ error: expect.stringMatching(/Polygon or MultiPolygon/) })
    expect(searchGeometry({ target: { lat: 40.7, lon: -74, height: 50 }, observerHeight: 0, region: region([-74.01, 40.69, -73.99, 40.71]) })).toEqual({ error: "the target is inside the region" })
  })
})

describe("search: the customer's Statue of Liberty / Brooklyn Bridge Park scan (round-2 feedback, 2026-10-30)", () => {
  const year = scan("moon", target, park, EYE, T0, T1)
  it("12 months: 64 passes, 125 in-park segments (the customer's numbers), no invariant tripped", () => {
    expect(year.passes.length).toBe(64)
    expect(year.passes.reduce((s, p) => s + p.segments.length, 0)).toBe(125)
    expect(year.counters.anomalies).toBe(0)
  })
  it("regression: the Nov 16 pass enters at 2026-11-17T03:45:19Z, 40.70329, −73.99630 (the customer's expected entry)", () => {
    const p = year.passes.find(x => x.time.startsWith("2026-11-17T03:4"))!
    const e = p.segments[0]!.enter
    expect(Math.abs(Date.parse(e.time) - Date.parse("2026-11-17T03:45:19.646Z"))).toBeLessThanOrEqual(5)   // pinned (this solver)
    expect(Math.abs(Date.parse(e.time) - Date.parse("2026-11-17T03:45:19.5Z"))).toBeLessThan(1000)         // the customer's second
    expect(e.lat).toBeCloseTo(40.70329, 5); expect(e.lon).toBeCloseTo(-73.9963, 5)
    expect(p.moon.illuminated).toBeCloseTo(0.47, 2)                                                       // "Nov 16 (47% lit)"
    expect(p.sunAlt).toBeLessThan(-18)
  })
  it("entries and exits are exact: on a park edge to 1 cm, and the standing point at that instant is that point", () => {
    const pr = planarRegion(park), E = pr.edges
    const edgeDist = (lon: number, lat: number) => {
      const [x, y] = pr.frame.toXY(lon, lat); let best = Infinity
      for (let k = 0; k < E.length / 4; k++) {
        const ax = E[4 * k]!, ay = E[4 * k + 1]!, ex = E[4 * k + 2]! - ax, ey = E[4 * k + 3]! - ay, u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)))
        best = Math.min(best, Math.hypot(x - ax - u * ex, y - ay - u * ey))
      }
      return best
    }
    const inp = { body: "moon" as const, target, ...EYE, startMs: 0, endMs: 0, stepSeconds: 1, maxDistanceKm: 20 }
    for (const p of year.passes.slice(0, 12)) for (const s of p.segments) for (const c of [s.enter, s.exit]) {
      expect(edgeDist(c.lon, c.lat)).toBeLessThan(0.01)
      const sp = standingPoint(diskBlocks, inp, Date.parse(c.time))!
      expect(Math.hypot((sp.lat - c.lat) * 111_000, (sp.lon - c.lon) * 84_000)).toBeLessThan(0.02)   // ms rounding of the time ≈ 1.2 cm
    }
  })
  it("complete: a brute-force 1 s scan of Nov–Dec 2026 finds no in-park instant outside a returned segment", () => {
    const from = T0, to = Date.parse("2027-01-01T00:00:00Z")
    const r = checkComplete(year.passes.filter(p => Date.parse(p.time) < to), brute("moon", target, park, EYE, from, to, 1), 1)
    expect(r).toMatchObject({ missed: [], unsampled: 0 })
    expect(r.samples).toBeGreaterThan(100)
  }, 60_000)
  it("aim=litCentroid (47% lit): the Nov 16 pass comes earlier, as the customer measured (~40 s)", () => {
    const from = Date.parse("2026-11-16T12:00:00Z"), to = Date.parse("2026-11-17T12:00:00Z")
    const r = searchWindow(diskBlocks, { body: "moon", target, region: park, ...EYE, startMs: from, endMs: to, aim: "litCentroid" })
    if ("error" in r) throw new Error(r.error)
    const c = year.passes.find(x => x.time.startsWith("2026-11-17T03:4"))!
    const dt = (Date.parse(r.passes[0]!.segments[0]!.enter.time) - Date.parse(c.segments[0]!.enter.time)) / 1000
    expect(r.passes.length).toBe(1); expect(dt).toBeLessThan(-30); expect(dt).toBeGreaterThan(-50)
  })
  it("windows are independent: splitting [a, c) at an instant inside a pass gives the same passes, each once", () => {
    const p = year.passes.find(x => x.segments.length >= 3)!, b = Date.parse(p.segments[1]!.enter.time)
    const a = b - 10 * 86_400_000, c = b + 10 * 86_400_000
    const run = (s: number, e: number) => { const r = searchWindow(diskBlocks, { body: "moon", target, region: park, ...EYE, startMs: s, endMs: e }); if ("error" in r) throw new Error(r.error); return r.passes }
    const whole = run(a, c), split = [...run(a, b), ...run(b, c)]
    expect(split.map(x => x.segments)).toEqual(whole.map(x => x.segments))
    expect(whole.some(x => x.time === p.time)).toBe(true)
  })
  it("request level: heights, region info and conventions echoed", () => {
    const w = windowsFor(Date.parse("2026-11-16T00:00:00Z"), Date.parse("2026-11-17T00:00:00Z"))[0]!
    const r = searchWindowRequest(diskBlocks, { body: "moon", targetLat: LIBERTY.lat, targetLon: LIBERTY.lon, targetHeight: 70, targetHeightRef: "msl", observerHeight: 5, heightRef: "msl", region: park, encoding: encodeRegion(park), startMs: w })
    if (!("ok" in r)) throw new Error(r.error)
    expect(r.ok.target).toMatchObject({ heightMsl: 70, heightRef: "msl" }); expect(r.ok.target.geoidUndulation).toBeCloseTo(-32.9, 1)
    expect(r.ok.region).toMatchObject({ polygons: 1, rings: 1, vertices: 423 })
    expect(r.ok.conventions).toMatchObject({ observerHeightRef: "msl", targetHeightRef: "msl", terrestrialRefractionK: 0.13 })
    expect(r.ok.geometry.elevation.min).toBeGreaterThan(0.6); expect(r.ok.geometry.elevation.max).toBeLessThan(1.1)
  })
  it("sliced (searchWindowRequestSteps): yields every ~sliceEvaluations evaluations, output identical to the one-piece run", () => {
    const w = windowsFor(Date.parse("2026-11-16T00:00:00Z"), Date.parse("2026-11-17T00:00:00Z"))[0]!
    const q = { body: "moon" as const, targetLat: LIBERTY.lat, targetLon: LIBERTY.lon, targetHeight: 70, targetHeightRef: "msl" as const, observerHeight: 5, heightRef: "msl" as const, region: park, encoding: encodeRegion(park), startMs: w }
    const it = searchWindowRequestSteps(diskBlocks, q)
    let slices = 0, r = it.next()
    while (!r.done) { slices++; r = it.next() }
    const whole = searchWindowRequest(diskBlocks, q)
    if (!("ok" in whole) || !("ok" in r.value)) throw new Error("window failed")
    expect(r.value).toEqual(whole)
    const c = whole.ok.counters, evals = c.scanEvaluations! + c.trackEvaluations! + c.refineEvaluations!
    expect(slices).toBeGreaterThanOrEqual(Math.floor(evals / SEARCH.sliceEvaluations) - 1)
    expect(slices).toBeLessThanOrEqual(Math.ceil(evals / SEARCH.sliceEvaluations))
  })
})

describe("search: completeness on other geometries (brute force, 1–2 s steps, 30 days)", () => {
  const from = Date.parse("2026-11-01T00:00:00Z"), to = Date.parse("2026-12-01T00:00:00Z")
  it("Sun, a 40 m light seen from 2–9 km over a 55° fan of bearings", () => {
    // standing points on bearings 270–325° from the light, so the bearings back to it span November's sunrise azimuths
    const tg = { lat: 40.5, lon: -73.0, height: 40 }, eye = { observerHeight: 2 }
    const at = (az: number, km: number) => { const d = direct(tg.lat, tg.lon, az, km * 1000); return [d.lon, d.lat] }
    const reg = region({ type: "Polygon", coordinates: [[at(270, 2), at(325, 2), at(325, 9), at(270, 9), at(270, 2)]] })
    const r = searchWindow(diskBlocks, { body: "sun", target: tg, region: reg, ...eye, startMs: from, endMs: to })
    if ("error" in r) throw new Error(r.error)
    const c = checkComplete(r.passes, brute("sun", tg, reg, eye, from, to, 1), 1)
    expect(c).toMatchObject({ missed: [], unsampled: 0 }); expect(c.segments).toBeGreaterThan(10); expect(r.counters.anomalies).toBe(0)
  }, 60_000)
  it("refuses a target below the eye (alignment has no standing point there)", () => {
    expect(searchGeometry({ target: { lat: 40.5, lon: -73, height: 30 }, observerHeight: 60, region: region([-73.2, 40.55, -73.15, 40.6]) })).toMatchObject({ error: expect.stringMatching(/above the eye/) })
  })
  it("Moon, a 300 m tower 1–3 km away, a park with a hole plus a second polygon (MultiPolygon)", () => {
    const tg = { lat: 51.5, lon: -0.1, height: 300 }, eye = { observerHeight: 2, observerHeightRef: "msl" as const }
    const reg = region({ type: "MultiPolygon", coordinates: [
      [[[-0.13, 51.51], [-0.11, 51.51], [-0.11, 51.525], [-0.13, 51.525], [-0.13, 51.51]], [[-0.125, 51.515], [-0.115, 51.515], [-0.115, 51.52], [-0.125, 51.52], [-0.125, 51.515]]],
      [[[-0.14, 51.49], [-0.135, 51.49], [-0.135, 51.495], [-0.14, 51.495], [-0.14, 51.49]]],
    ] })
    const r = searchWindow(diskBlocks, { body: "moon", target: tg, region: reg, ...eye, startMs: from, endMs: to })
    if ("error" in r) throw new Error(r.error)
    const c = checkComplete(r.passes, brute("moon", tg, reg, eye, from, to, 2), 2)
    expect(c).toMatchObject({ missed: [], unsampled: 0 }); expect(c.segments).toBeGreaterThan(5); expect(r.counters.anomalies).toBe(0)
  }, 120_000)
})

describe("search: bounds", () => {
  it("windows on a fixed 30-day grid", () => {
    const w = windowsFor(T0, T1)
    expect(w.every(x => x % WINDOW_MS === 0)).toBe(true); expect(w.length).toBe(14); expect(SEARCH.maxSpanDays).toBe(400)
  })
})
