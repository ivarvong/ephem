// /v1/alignment through the real handler: height references (round-2 feedback #2), conventions, rates.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { geoidUndulation } from "@ephem/core"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")   // 5441–5444 cover Sep–Dec 2026
const handler = makeHandler(makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer })))
const get = async (q: string) => { const r = await handler(new Request(`http://x/v1/alignment?${q}`)); return { status: r.status, j: await r.json() as any } }

// The customer's Nov 16 2026 (EST) pass behind the Statue of Liberty, heights ellipsoidal (their hand-copied N = −32.81 m).
const BASE = "body=moon&targetLat=40.68925&targetLon=-74.0445&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8"
const ELLIPSOID = `${BASE}&targetHeight=37.2&observerHeight=-27.8`
const MSL = `${BASE}&targetHeight=70&observerHeight=5&heightRef=msl&targetHeightRef=msl`
/** Ground distance between two lat/lon points, metres (local flat approximation, fine at metres). */
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 111_000 * Math.cos(a.lat * Math.PI / 180))

describe("alignment height references", () => {
  it("the customer's ellipsoidal repro keeps working: 19 points, entering Brooklyn Bridge Park near 03:45:19Z", async () => {
    const { status, j } = await get(ELLIPSOID)
    expect(status).toBe(200)
    expect(j.track).toHaveLength(19)
    expect(j.conventions).toMatchObject({ observerHeightRef: "ellipsoid", targetHeightRef: "ellipsoid", terrestrialRefractionK: 0.13 })
    expect(j.target).toMatchObject({ heightEllipsoid: 37.2, heightRef: "ellipsoid" })
    // their park entry (bisected against the OSM polygon): 03:45:19Z at 40.70329, −73.99630. Our 03:45:20 sample is the next one.
    const p = j.track.find((x: any) => x.time === "2026-11-17T03:45:20.000Z")
    expect(metres(p, { lat: 40.70329, lon: -73.99630 })).toBeLessThan(25)   // ≈ 12 m/s × 1 s along the line
  })
  it("msl heights give the same track to within the hand-copied undulation's error", async () => {
    const a = (await get(ELLIPSOID)).j, b = (await get(MSL)).j
    expect(b.track).toHaveLength(a.track.length)
    expect(b.target).toMatchObject({ heightMsl: 70, heightRef: "msl" })
    expect(b.target.geoidUndulation).toBeCloseTo(geoidUndulation(40.68925, -74.0445), 12)
    expect(b.conventions).toMatchObject({ observerHeightRef: "msl", targetHeightRef: "msl" })
    // The hand-copied N (−32.81 at the park centroid, used for both heights) differs from N at the statue and at each standing
    // point by centimetres; 1 m of eye height moves the spot ~60 m (customer), so the tracks agree to a few metres, not mm.
    const dN = Math.abs(b.target.geoidUndulation + 32.8) + Math.max(...b.track.map((p: any) => Math.abs(p.geoidUndulation + 32.8)))
    for (const [i, p] of b.track.entries()) {
      expect(p.time).toBe(a.track[i].time)
      expect(p.heightMsl).toBeCloseTo(5, 9)
      expect(p.heightEllipsoid).toBeCloseTo(5 + p.geoidUndulation, 9)
      expect(metres(p, a.track[i])).toBeLessThan(Math.max(1, 120 * dN))
    }
  })
  it("msl with exact undulations equals the ellipsoidal solve with the same heights", async () => {
    // A fixed observer point removes the along-track N variation: fromObserver must agree exactly.
    const obs = "&observerLat=40.7003&observerLon=-73.9968"
    const b = (await get(MSL + obs)).j
    const Nt = b.target.geoidUndulation, No = b.fromObserver.observer.geoidUndulation
    const a = (await get(`${BASE}&targetHeight=${70 + Nt}&observerHeight=${5 + No}${obs}`)).j
    expect(b.fromObserver.targetElevation).toBeCloseTo(a.fromObserver.targetElevation, 10)
    expect(b.fromObserver.observer).toMatchObject({ heightMsl: 5, heightRef: "msl" })
  })
  it("no observerHeight: the eye is on the geoid (heightMsl 0), as on every other endpoint", async () => {
    const { j } = await get(`${BASE}&targetHeight=70&targetHeightRef=msl`)
    expect(j.conventions.observerHeightRef).toBe("default")
    for (const p of j.track) expect(p.heightMsl).toBeCloseTo(0, 9)
  })
  it("conventions say terrestrial refraction is modelled and what azimuth means; rates match the per-point motion", async () => {
    const { j } = await get(ELLIPSOID)
    expect(j.conventions.terrestrialRefraction).toMatch(/^Modelled/)
    expect(j.conventions.azimuth).toMatch(/seen from that standing point/)
    expect(j.conventions.refraction.temperatureC).toBe(10)
    for (const p of j.track) {
      expect(p.altitudeRate).toBeLessThan(0)          // a moonset
      expect(Math.abs(p.altitudeRate)).toBeGreaterThan(0.1); expect(Math.abs(p.altitudeRate)).toBeLessThan(0.25)
      expect(Number.isFinite(p.azimuthRate)).toBe(true)
    }
  })
  it("rejects unknown and bad height references", async () => {
    expect((await get(`${ELLIPSOID}&heightRef=geoid`)).status).toBe(400)
    const u = await get(`${ELLIPSOID}&observerHeightRef=msl`)
    expect(u.status).toBe(400); expect(u.j.allowed).toEqual(expect.arrayContaining(["heightRef", "targetHeightRef"]))
  })
})
