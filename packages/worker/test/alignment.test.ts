// /v1/alignment through the real handler: height references, conventions, rates.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { geoidUndulation } from "@ephem/core"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")   // 5441–5444 cover Sep–Dec 2026
const handler = makeHandler(makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer })))
const get = async (q: string) => { const r = await handler(new Request(`http://x/v1/alignment?${q}`)); return { status: r.status, j: await r.json() as any } }

// The Liberty reference Nov 16 2026 (EST) pass behind the Statue of Liberty, heights ellipsoidal (their hand-copied N = −32.81 m).
const BASE = "body=moon&targetLat=40.68925&targetLon=-74.0445&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8"
const ELLIPSOID = `${BASE}&targetHeight=37.2&height=-27.8`
const MSL = `${BASE}&targetHeight=70&height=5&heightRef=msl&targetHeightRef=msl`
/** Ground distance between two lat/lon points, metres (local flat approximation, fine at metres). */
const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  Math.hypot((a.lat - b.lat) * 111_000, (a.lon - b.lon) * 111_000 * Math.cos(a.lat * Math.PI / 180))

describe("alignment height references", () => {
  it("the Liberty reference ellipsoidal repro keeps working: 19 points, entering Brooklyn Bridge Park near 03:45:19Z", async () => {
    const { status, j } = await get(ELLIPSOID)
    expect(status).toBe(200)
    expect(j.track).toHaveLength(19)
    expect(j.conventions).toMatchObject({ heightRef: "ellipsoid", targetHeightRef: "ellipsoid", terrestrialRefractionK: 0.13 })
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
    expect(b.conventions).toMatchObject({ heightRef: "msl", targetHeightRef: "msl" })
    // The hand-copied N (−32.81 at the park centroid, used for both heights) differs from N at the statue and at each standing
    // point by centimetres; 1 m of eye height moves the spot ~60 m (reference), so the tracks agree to a few metres, not mm.
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
    const obs = "&lat=40.7003&lon=-73.9968"
    const b = (await get(MSL + obs)).j
    const Nt = b.target.geoidUndulation, No = b.fromObserver.observer.geoidUndulation
    const a = (await get(`${BASE}&targetHeight=${70 + Nt}&height=${5 + No}${obs}`)).j
    expect(b.fromObserver.targetElevation).toBeCloseTo(a.fromObserver.targetElevation, 10)
    expect(b.fromObserver.observer).toMatchObject({ heightMsl: 5, heightRef: "msl" })
  })
  it("no observerHeight: the eye is on the geoid (heightMsl 0), as on every other endpoint", async () => {
    const { j } = await get(`${BASE}&targetHeight=70&targetHeightRef=msl`)
    expect(j.conventions.heightRef).toBe("default")
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

const pos = async (lat: number, lon: number, hE: number, time: string) =>
  (await (await handler(new Request(`http://x/v1/position?lat=${lat}&lon=${lon}&height=${hE}&time=${time}`))).json()) as any
describe("include=sun,phase", () => {
  it("alignment: every track point and pass carries the Sun and the Moon phase, equal to /v1/position there and then", async () => {
    const { status, j } = await get(`${MSL}&include=sun,phase&lat=40.7003&lon=-73.9968`)
    expect(status).toBe(200)
    for (const p of [j.track[0], j.track.at(-1)]) {
      const r = await pos(p.lat, p.lon, p.heightEllipsoid, p.time)
      expect(p.sun.altitude).toBeCloseTo(r.sun.altitude, 9); expect(p.sun.azimuth).toBeCloseTo(r.sun.azimuth, 9)
      expect(p.sun.apparentAltitude).toBe(null)          // the Sun is far below the sea horizon at 22:45 EST
      expect(p.phase).toEqual(r.moon.phase)
    }
    expect(j.track[0].phase.illuminatedFraction).toBeGreaterThan(0.4); expect(j.track[0].phase.illuminatedFraction).toBeLessThan(0.55)
    expect(j.conventions.include).toMatch(/include=sun/)
    const plain = (await get(MSL)).j
    expect(plain.track[0].sun).toBeUndefined(); expect(plain.track[0].phase).toBeUndefined()
    expect((await get(`${MSL}&include=sun`)).j.track[0].phase).toBeUndefined()
  })
  it("crossing: per crossing; bad values are 400", async () => {
    const r = await handler(new Request("http://x/v1/crossing?body=moon&lat=40.6985&lon=-73.999&height=5&heightRef=msl&altitude=0.87&altitudeType=apparent&direction=set&start=2026-11-16T00:00:00Z&end=2026-11-18T00:00:00Z&include=phase,sun"))
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.crossings.length).toBeGreaterThan(0)
    for (const c of j.crossings) {
      const p = await pos(40.6985, -73.999, j.observer.heightEllipsoid, c.time)
      expect(c.sun.altitude).toBeCloseTo(p.sun.altitude, 9); expect(c.phase).toEqual(p.moon.phase)
    }
    for (const bad of ["include=moon", "include=sun,sun,phase", "include="])
      expect((await handler(new Request(`http://x/v1/crossing?body=moon&lat=40.7&lon=-74&altitude=0&date=2026-11-16&tz=America/New_York&${bad}`))).status, bad).toBe(400)
  })
})

describe("aim", () => {
  it("litCentroid: the aim point sits on the target (geometry re-checked), ~37 s earlier than the centre at the same spot", async () => {
    const c = (await get(MSL)).j, l = (await get(`${MSL}&aim=litCentroid`)).j
    expect(l.conventions.aim).toMatchObject({ point: "litCentroid" })
    expect(c.track[0].aimOffset).toBeUndefined()
    for (const p of l.track) {
      expect(p.aimOffset * 60).toBeGreaterThan(6.8); expect(p.aimOffset * 60).toBeLessThan(6.9)   // 6.84′ (numeric integration: 6.85′)
      expect(p.aimAngle).toBeGreaterThan(155.5); expect(p.aimAngle).toBeLessThan(156)
    }
    // the centroid is below and right of the centre, so the line of standing points moves: at the spot where the centroid is
    // on the statue at 03:45:20 the centre gets there later. Locate it on the centre track (5 s samples, ~12 m/s).
    const p = l.track.find((x: any) => x.time === "2026-11-17T03:45:20.000Z")
    const xy = (q: any): [number, number] => [q.lon * 111320 * Math.cos(40.7 * Math.PI / 180), q.lat * 111132]
    const [px, py] = xy(p)
    let best = 0, bestD = Infinity
    c.track.forEach((q: any, i: number) => { const [x, y] = xy(q), dd = Math.hypot(x - px, y - py); if (dd < bestD) { bestD = dd; best = i } })
    const dt = (Date.parse(c.track[best].time) - Date.parse(p.time)) / 1000
    expect(dt).toBeGreaterThan(30); expect(dt).toBeLessThan(45)
  })
  it("upper / lower: offset = the angular radius along the vertical; litCentroid needs the Moon", async () => {
    const u = (await get(`${ELLIPSOID}&aim=upper`)).j, lo = (await get(`${ELLIPSOID}&aim=lower`)).j
    for (const [t, ang] of [[u, 0], [lo, 180]] as const) for (const p of t.track) { expect(p.aimOffset).toBeCloseTo(p.angularRadius, 12); expect(p.aimAngle).toBe(ang) }
    const s = await get("body=sun&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&start=2026-11-17T21:00:00Z&end=2026-11-17T21:10:00Z&aim=litCentroid")
    expect(s.status).toBe(400)
    expect((await get(`${ELLIPSOID}&aim=rim`)).status).toBe(400)
  })
  it("crossing: aim=upper moves the crossing by the radius / rate; litCentroid moves the moonset by offset·cos(angle) / rate; limb is no longer a parameter", async () => {
    const C = "http://x/v1/crossing?body=moon&lat=40.6985&lon=-73.999&height=5&heightRef=msl&altitude=0.87&altitudeType=apparent&direction=set&start=2026-11-16T00:00:00Z&end=2026-11-18T00:00:00Z"
    const j = async (q: string) => { const r = await handler(new Request(C + q)); return { status: r.status, j: await r.json() as any } }
    const up = await j("&aim=upper"), ctr = await j("")
    expect(up.j.conventions.aim.point).toBe("upper"); expect(ctr.j.conventions.aim.point).toBe("center")
    const u0 = up.j.crossings.find((x: any) => x.time.startsWith("2026-11-17T03")), c0 = ctr.j.crossings.find((x: any) => x.time.startsWith("2026-11-17T03"))
    expect(Date.parse(u0.time)).toBeGreaterThan(Date.parse(c0.time))   // a setting upper limb sets after the centre
    const lit = await j("&aim=litCentroid")
    const a = ctr.j.crossings.find((x: any) => x.time.startsWith("2026-11-17T03")), b = lit.j.crossings.find((x: any) => x.time.startsWith("2026-11-17T03"))
    const expectS = b.aimOffset * Math.cos(b.aimAngle * Math.PI / 180) / a.altitudeRate * 60   // offset is below the centre: negative / negative rate
    expect(Math.abs((Date.parse(a.time) - Date.parse(b.time)) / 1000 - expectS)).toBeLessThan(2)
    expect(lit.j.conventions.aim.point).toBe("litCentroid")
    expect((await j("&limb=upper")).status).toBe(400)
  })
})
