// Aim points (round-2 #3): the lit-area centroid's closed form against a brute-force integration over the lunar sphere with
// an independent ephemeris (Skyfield + DE440s, reference/oracle/litcentroid.py, 2 M surface points), and the bright limb
// from the local vertical against Meeus' position angle minus the parallactic angle.
import { describe, expect, it } from "vitest"
import { DEG, LIT_CENTROID_K, angularRadius, apparent, aimVector, enuOf, frameAt, instant, litGeometry, mxv, positionRequest, topocentric } from "../src/index.ts"
import type { Vec3 } from "../src/index.ts"
import { diskBlocks } from "./helpers/blocks.ts"

const at = (iso: string, lat: number, lon: number, h: number) => {
  const f = frameAt(diskBlocks, instant(Date.parse(iso)), { lat, lon, height: h })
  const m = apparent(diskBlocks, f, "moon"), s = apparent(diskBlocks, f, "sun"), r = angularRadius("moon", m.distanceKm)
  return { f, m, s, r, g: litGeometry(mxv(f.eo.C, m.v), mxv(f.eo.C, s.v), enuOf(f.geo).up, r) }
}

describe("lit-area centroid", () => {
  it("closed form: 0 at full, 4r/3π at quarter, 8r/3π towards new; direction = the Sun's side", () => {
    const up: Vec3 = [0, 0, 1], moon: Vec3 = [0, 384_400, 0]   // due north on the horizon (ENU)
    const sunAt = (i: number): Vec3 => [1.496e8 * Math.sin(i * DEG), 384_400 - 1.496e8 * Math.cos(i * DEG), 0]   // phase angle i, Sun to the east
    expect(litGeometry(moon, sunAt(1e-9), up, 0.25).centroidOffset).toBeCloseTo(0, 9)
    const q = litGeometry(moon, sunAt(90), up, 0.25)
    expect(q.centroidOffset / 0.25).toBeCloseTo(LIT_CENTROID_K, 3); expect(q.illuminatedFraction).toBeCloseTo(0.5, 3)
    expect(q.brightLimbAngleFromVertical).toBeCloseTo(90, 6)   // facing north, east is to the right (increasing azimuth)
    expect(litGeometry(moon, sunAt(179.9999), up, 0.25).centroidOffset / 0.25).toBeCloseTo(2 * LIT_CENTROID_K, 5)
    const a = aimVector("upper", moon, up, 0.25), b = aimVector("lower", moon, up, 0.25)
    expect(Math.asin(a.dir[2]) / DEG).toBeCloseTo(0.25, 12); expect(Math.asin(b.dir[2]) / DEG).toBeCloseTo(-0.25, 12)
  })
  // Frozen output of reference/oracle/litcentroid.py (2026-10-30): offset (′), angle clockwise from vertical (°).
  const BRUTE: ReadonlyArray<[string, number, number, number, number, number]> = [
    ["2026-11-17T03:45:20Z", 40.70333, -73.99618, -27.8, 6.8473, 155.703],    // the customer's Nov 16 (EST) pass, 46 % lit
    ["2026-11-17T00:00:00Z", 40.7, -74.0, 0, 7.0432, 125.897],
    ["2026-11-20T23:00:00Z", 51.5, -0.1, 20, 2.3682, 138.543],                // gibbous, 82 %
    ["2026-11-12T10:00:00Z", -33.9, 151.2, 30, 11.5114, 202.163],             // crescent, 9 %
  ]
  it.each(BRUTE)("%s: closed form = numeric integration over the sphere (Skyfield) to 0.05′ and 0.02°", (iso, lat, lon, h, off, ang) => {
    const { g } = at(iso, lat, lon, h)
    expect(Math.abs(g.centroidOffset * 60 - off)).toBeLessThan(0.05)
    expect(Math.abs(g.brightLimbAngleFromVertical! - ang)).toBeLessThan(0.02)
  })
  it("the customer's check value: 6.75′ is the geocentric phase (46.9 %); topocentric (46.15 %) gives 6.84′", () => {
    const { g, r } = at("2026-11-17T03:45:20Z", 40.70333, -73.99618, -27.8)
    const geo = positionRequest(diskBlocks, { utcMs: Date.parse("2026-11-17T03:45:20Z"), lat: 40.70333, lon: -73.99618, height: -27.8 }).moon.phase
    const cosGeo = 2 * geo.illuminatedFraction - 1
    expect(LIT_CENTROID_K * (1 - cosGeo) * r * 60).toBeCloseTo(6.75, 2)
    expect(g.centroidOffset * 60).toBeCloseTo(6.84, 2)
  })
})

describe("bright limb from the local vertical", () => {
  it("= 360° − (χ − q): Meeus' position angle from topocentric RA/Dec minus the parallactic angle (spherical trig, no vectors)", () => {
    for (const [iso, lat, lon] of [["2026-11-17T03:45:20Z", 40.70333, -73.99618], ["2026-11-20T23:00:00Z", 51.5, -0.1], ["2026-11-12T10:00:00Z", -33.9, 151.2], ["2026-10-30T02:00:00Z", 64.15, -21.94]] as const) {
      const { f, m, s } = at(iso, lat, lon, 0)
      const tm = topocentric(f, m.v), tsun = topocentric(f, s.v)
      const a0 = tm.rightAscension * 15 * DEG, d0 = tm.declination * DEG, a = tsun.rightAscension * 15 * DEG, d = tsun.declination * DEG
      const chi = Math.atan2(Math.cos(d) * Math.sin(a - a0), Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(a - a0))
      const H = tm.hourAngle * 15 * DEG, phi = lat * DEG
      const q = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(d0) - Math.sin(d0) * Math.cos(H))
      const meeus = ((360 - (chi - q) / DEG) % 360 + 360) % 360
      const api = positionRequest(diskBlocks, { utcMs: Date.parse(iso), lat, lon, height: 0 }).moon.brightLimbAngleFromVertical!
      expect(Math.abs(((api - meeus + 540) % 360) - 180)).toBeLessThan(0.01)
    }
  })
})
