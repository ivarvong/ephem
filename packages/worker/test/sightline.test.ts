// /v1/sightline (round-2 #6). Geometry cross-checked offline against PROJ + GeographicLib (reference/oracle/
// sightline_check.py, 2026-10-30): heightEllipsoid ≤ 1.5e-7 m, distance ≤ 2.6e-7 m on a 3.6 km and a 152 km line.
import { describe, expect, it } from "vitest"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"

const handler = makeHandler(makeBlocks(direct(async () => { throw new Error("sightline reads no DE440 blocks") })))
const get = async (q: string) => { const r = await handler(new Request(`http://x/v1/sightline?${q}`)); return { status: r.status, j: await r.json() as any } }
// Pier 6, Brooklyn Bridge Park (eye 5 m MSL) → Statue of Liberty figure middle (70 m MSL), across Governors Island.
const PIER6 = "lat=40.6935&lon=-74.0017&height=5&heightRef=msl&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl"
const R = 6_371_008.8, K = 0.13

describe("sight line", () => {
  it("ends at the given heights; Earth's curvature lowers the middle by s₁s₂/2R; refraction lifts it by k times that", async () => {
    const { status, j } = await get(`${PIER6}&samples=11`)
    expect(status).toBe(200)
    expect(j.profile).toHaveLength(11)
    expect(j.profile[0].heightMsl).toBeCloseTo(5, 6); expect(j.profile[10].heightMsl).toBeCloseTo(70, 6)
    expect(j.conventions.terrestrialRefraction).toMatch(/^Modelled as a constant coefficient k = 0.13/)
    const D = j.distanceKm * 1000
    for (const p of j.profile.slice(1, -1)) {
      const s1 = p.distanceKm * 1000, s2 = D - s1, linear = 5 + (70 - 5) * s1 / D
      expect(linear - p.heightMsl).toBeCloseTo(s1 * s2 / (2 * R), 1)            // ±5 cm: N varies along the line too
      expect(p.refractedHeightMsl - p.heightMsl).toBeCloseTo(K * s1 * s2 / (2 * R), 9)
      expect(p.heightEllipsoid - p.geoidUndulation).toBeCloseTo(p.heightMsl, 9)
    }
  })
  it("obstacles: clearance = line height at the projected distance − obstacle height; off-line points say so", async () => {
    const { j } = await get(`${PIER6}&samples=101&obstacles=40.6894:-74.0166:25,40.6894:-74.0166:30,40.70:-73.99:5`)
    const [a, b, c] = j.obstacles
    expect(a.clearanceM).toBeCloseTo(a.lineHeightMsl - 25, 9); expect(a.blocks).toBe(false)
    expect(a.lineHeightMsl).toBeGreaterThan(22); expect(a.lineHeightMsl).toBeLessThan(34)     // customer: 22–28 m over the island
    expect(b.blocks).toBe(true); expect(b.refractedClearanceM).toBeLessThan(0)
    expect(Math.abs(a.crossTrackM)).toBeLessThan(400)
    expect(c.distanceKm).toBeLessThan(0); expect(c.clearanceM).toBe(null); expect(c.blocks).toBe(null)   // behind the eye
    // the line height at an obstacle equals the profile interpolated at that distance
    const i = j.profile.findIndex((p: any) => p.distanceKm > a.distanceKm), p0 = j.profile[i - 1], p1 = j.profile[i]
    const interp = p0.heightMsl + (p1.heightMsl - p0.heightMsl) * (a.distanceKm - p0.distanceKm) / (p1.distanceKm - p0.distanceKm)
    expect(a.lineHeightMsl).toBeCloseTo(interp, 3)
  })
  it("default eye on the geoid; refusals", async () => {
    const d = await get("lat=40.6935&lon=-74.0017&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&samples=2")
    expect(d.j.observer).toMatchObject({ heightMsl: 0, heightRef: "default" })
    expect((await get(`${PIER6}&obstacles=40.6:-74`)).status).toBe(400)
    expect((await get(`${PIER6}&obstacles=95:-74:3`)).status).toBe(400)
    expect((await get(`${PIER6}&samples=1`)).status).toBe(400)
    expect((await get("lat=40&lon=-74&targetLat=42&targetLon=-74&targetHeight=0")).status).toBe(400)   // 222 km
    const u = await get(`${PIER6}&time=2026-11-17T03:45:00Z`)
    expect(u.status).toBe(400); expect(u.j).toMatchObject({ _tag: "InvalidRequest", parameter: "time" })
  })
})
