import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { direct, inverse } from "../src/geodesic.ts"

// Reference: pyproj (Karney's GeographicLib) on the same random pairs.
const N = 400
const rnd = (() => {
  let s = 440
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
})()
const pairs = Array.from({ length: N }, () => {
  const lat1 = -89 + 178 * rnd(),
    lon1 = -180 + 360 * rnd()
  const d = Math.exp(Math.log(1) + rnd() * Math.log(200_000)) // 1 m … 200 km, log-uniform
  const az = 360 * rnd()
  return { lat1, lon1, az, d }
})
const py = `
import sys, json; from pyproj import Geod; g = Geod(ellps="WGS84"); out = []
for p in json.load(sys.stdin):
    lon2, lat2, baz = g.fwd(p["lon1"], p["lat1"], p["az"], p["d"])
    a12, a21, s = g.inv(p["lon1"], p["lat1"], lon2, lat2)
    out.append(dict(lat2=lat2, lon2=lon2, s=s, a12=a12 % 360))
print(json.dumps(out))`
const ref = JSON.parse(execFileSync("python3", ["-c", py], { input: JSON.stringify(pairs) }).toString()) as Array<{
  lat2: number
  lon2: number
  s: number
  a12: number
}>

describe("Vincenty vs GeographicLib", () => {
  it("direct: position within 1 mm", () => {
    let worst = 0
    pairs.forEach((p, i) => {
      const d = direct(p.lat1, p.lon1, p.az, p.d),
        r = ref[i]!
      const dn = (d.lat - r.lat2) * 111_132,
        de = (((d.lon - r.lon2 + 540) % 360) - 180) * 111_320 * Math.cos((r.lat2 * Math.PI) / 180)
      worst = Math.max(worst, Math.hypot(dn, de))
    })
    expect(worst).toBeLessThan(1e-3)
  })
  it("inverse: distance within 1 mm, azimuth within 0.1 mm of lateral error", () => {
    let wd = 0,
      wl = 0
    pairs.forEach((p, i) => {
      const r = ref[i]!,
        inv = inverse(p.lat1, p.lon1, r.lat2, r.lon2)
      wd = Math.max(wd, Math.abs(inv.distanceM - r.s))
      wl = Math.max(wl, ((Math.abs(((inv.azimuth - r.a12 + 540) % 360) - 180) * Math.PI) / 180) * r.s) // azimuth error × distance
    })
    expect(wd).toBeLessThan(1e-3)
    expect(wl).toBeLessThan(1e-4)
  })
  it("round trip direct ∘ inverse is the identity", () => {
    for (const p of pairs.slice(0, 50)) {
      const d = direct(p.lat1, p.lon1, p.az, p.d),
        inv = inverse(p.lat1, p.lon1, d.lat, d.lon)
      expect(Math.abs(inv.distanceM - p.d)).toBeLessThan(1e-6)
      expect(((Math.abs(((inv.azimuth - p.az + 540) % 360) - 180) * Math.PI) / 180) * p.d).toBeLessThan(1e-6) // lateral metres
    }
  })
})
