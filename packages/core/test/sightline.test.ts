// /sightline over long lines (sweep 2026-10-31) vs PROJ (ECEF ↔ geodetic, EPSG 4978/4979) and GeographicLib (pyproj.Geod),
// the in-gate form of reference/oracle/sightline_check.py: up to the 200 km limit, across the equator, the antimeridian and
// over the North Pole, and from 1 400 m to 8 848 m. Every profile point: the chord point's geodetic height, its foot, and
// the geodesic distance eye → foot.
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { sightline } from "../src/sightline.ts"

const LINES = [
  { name: "199 km east–west at 60°N", observer: { lat: 60, lon: 10, height: 2 }, target: { lat: 60.05, lon: 13.58, height: 300 } },
  { name: "199 km north–south across the equator", observer: { lat: -0.9, lon: -78.5, height: 2850 }, target: { lat: 0.9, lon: -78.5, height: 4000 } },
  { name: "across the antimeridian (Fiji)", observer: { lat: -16.8, lon: 179.4, height: 10 }, target: { lat: -16.95, lon: -179.3, height: 1000 } },
  { name: "over the North Pole", observer: { lat: 89.6, lon: 0, height: 5 }, target: { lat: 89.6, lon: 180, height: 5 } },
  { name: "Kathmandu to Everest", observer: { lat: 27.7172, lon: 85.324, height: 1400, heightRef: "msl" as const }, target: { lat: 27.9881, lon: 86.925, height: 8848, heightRef: "msl" as const } },
  { name: "below the ellipsoid, 1 km", observer: { lat: 31.5, lon: 35.5, height: -430 }, target: { lat: 31.509, lon: 35.5, height: -400 } },
]
const runs = LINES.map(l => ({ ...l, r: sightline({ observer: l.observer, target: l.target, samples: 201, obstacles: [] }) }))
const py = `
import sys, json; from pyproj import Transformer, Geod
G = Geod(ellps="WGS84"); to = Transformer.from_crs(4979, 4978, always_xy=True); back = Transformer.from_crs(4978, 4979, always_xy=True)
out = []
for j in json.load(sys.stdin):
    o, t = j["observer"], j["target"]; O = to.transform(o["lon"], o["lat"], o["heightEllipsoid"]); T = to.transform(t["lon"], t["lat"], t["heightEllipsoid"])
    n = j["n"]; pts = []
    for i in range(n):
        u = i / (n - 1); lon, lat, h = back.transform(*[a + (b - a) * u for a, b in zip(O, T)])
        pts.append(dict(lat=lat, lon=lon, h=h, s=G.inv(o["lon"], o["lat"], lon, lat)[2]))
    out.append(dict(pts=pts, D=G.inv(o["lon"], o["lat"], t["lon"], t["lat"])[2]))
print(json.dumps(out))`
const ref = JSON.parse(execFileSync("python3", ["-c", py], { input: JSON.stringify(runs.map(x => ({ observer: x.r.observer, target: x.r.target, n: x.r.profile.length }))) }).toString()) as Array<{ D: number; pts: Array<{ lat: number; lon: number; h: number; s: number }> }>

describe("sight line vs PROJ + GeographicLib", () => {
  it.each(runs.map((x, i) => [x.name, i] as const))("%s: heights, feet and distances within 1 mm", (_n, i) => {
    const r = runs[i]!.r, p = ref[i]!
    expect(Math.abs(r.distanceKm * 1000 - p.D)).toBeLessThan(1e-3)
    let wh = 0, wf = 0, ws = 0
    r.profile.forEach((x, k) => {
      const q = p.pts[k]!
      wh = Math.max(wh, Math.abs(x.heightEllipsoid - q.h)); ws = Math.max(ws, Math.abs(x.distanceKm * 1000 - q.s))
      wf = Math.max(wf, Math.hypot((x.lat - q.lat) * 111_132, (((x.lon - q.lon + 540) % 360) - 180) * 111_320 * Math.cos(q.lat * Math.PI / 180)))
      expect(Math.abs(x.heightEllipsoid - x.geoidUndulation - x.heightMsl)).toBeLessThan(1e-9)
    })
    process.stderr.write(`sightline ${runs[i]!.name} (${r.distanceKm.toFixed(1)} km): |Δh| ${wh.toExponential(2)} m  |Δfoot| ${wf.toExponential(2)} m  |Δs| ${ws.toExponential(2)} m\n`)
    expect(wh).toBeLessThan(1e-3); expect(wf).toBeLessThan(1e-3); expect(ws).toBeLessThan(1e-3)
  })
})
