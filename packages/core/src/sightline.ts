// /sightline (round-2 #6): the height above mean sea level of the sight line from an eye to a target, against ground
// distance, and the clearance over given obstacle points. Pure geometry (no ephemeris, no time).
//
// Geometric line: the straight chord eye → target between exact WGS-84 ECEF points, so Earth's curvature is in it by
// construction. Each sample is a point X on the chord; its height is X's own geodetic height (above the ellipsoid, along
// the normal through X) minus EGM96 N at the foot of that normal, and its distance is the geodesic distance from the eye
// to the foot. Refracted line: light near the ground bends with curvature k/R (the same k = 0.13 /alignment uses for
// the target's apparent elevation), so the ray through both endpoints bows upwards over the chord by k·s₁·s₂/(2R)
// (s₁, s₂ = ground distances to the eye and to the target). Both are given; the refracted one is what the eye sees along.
import { type Geodetic, WGS84, itrsOf } from "./observe.ts"
import { type Vec3, DEG, add, scale, sub, wrap360 } from "./linalg.ts"
import { inverse } from "./geodesic.ts"
import { geoidUndulation } from "./geoid.ts"
import { type HeightRef, K_TERRESTRIAL, R_MEAN_M } from "./horizon.ts"

const E2 = WGS84.f * (2 - WGS84.f)
/** ITRS (km) → geodetic (deg, deg, m above the ellipsoid), Bowring-seeded fixed point (sub-mm in 4 iterations near the surface). */
export const geodeticOf = (x: Vec3): Geodetic => {
  const p = Math.hypot(x[0], x[1]), lon = Math.atan2(x[1], x[0])
  let lat = Math.atan2(x[2], p * (1 - E2)), h = 0
  for (let i = 0; i < 6; i++) {
    const N = WGS84.a / Math.sqrt(1 - E2 * Math.sin(lat) ** 2)
    h = p / Math.cos(lat) - N
    lat = Math.atan2(x[2], p * (1 - E2 * N / (N + h)))
  }
  return { lat: lat / DEG, lon: lon / DEG, height: h * 1000 }
}

export interface SightlineEnd { readonly lat: number; readonly lon: number; readonly height: number; readonly heightRef?: HeightRef | undefined }
export interface Obstacle { readonly lat: number; readonly lon: number; readonly heightMsl: number }
export interface SightlineInput { readonly observer: SightlineEnd; readonly target: SightlineEnd; readonly samples: number; readonly obstacles: ReadonlyArray<Obstacle> }

const endOut = (e: SightlineEnd) => {
  const N = geoidUndulation(e.lat, e.lon), ref = e.heightRef ?? "ellipsoid"
  const hE = ref === "msl" ? e.height + N : e.height
  return { lat: e.lat, lon: e.lon, height: hE, heightEllipsoid: hE, heightMsl: hE - N, geoidUndulation: N, heightRef: ref }
}

export const MAX_SIGHTLINE_SAMPLES = 1001, MAX_OBSTACLES = 100, MAX_SIGHTLINE_KM = 200

export const sightline = (q: SightlineInput) => {
  const o = endOut(q.observer), t = endOut(q.target)
  const O = itrsOf({ lat: o.lat, lon: o.lon, height: o.heightEllipsoid }), T = itrsOf({ lat: t.lat, lon: t.lon, height: t.heightEllipsoid })
  const inv = inverse(o.lat, o.lon, t.lat, t.lon), D = inv.distanceM
  const bulge = (s1: number) => K_TERRESTRIAL * Math.max(0, s1) * Math.max(0, D - s1) / (2 * R_MEAN_M)
  /** The chord point at parameter u ∈ [0, 1]: foot, ground distance from the eye, heights. */
  const at = (u: number) => {
    const g = geodeticOf(add(O, scale(sub(T, O), u))), N = geoidUndulation(g.lat, g.lon)
    const s = u === 0 ? 0 : inverse(o.lat, o.lon, g.lat, g.lon).distanceM
    const hMsl = g.height - N
    return { distanceKm: s / 1000, lat: g.lat, lon: g.lon, heightMsl: hMsl, refractedHeightMsl: hMsl + bulge(s), heightEllipsoid: g.height, geoidUndulation: N }
  }
  const profile = Array.from({ length: q.samples }, (_, i) => at(i / (q.samples - 1)))
  /** u whose foot is `s` metres from the eye (monotone in u). */
  const uAt = (s: number) => {
    let lo = 0, hi = 1
    for (let i = 0; i < 60 && hi - lo > 1e-12; i++) { const m = (lo + hi) / 2; if (inverse(o.lat, o.lon, ...footOf(m)).distanceM < s) lo = m; else hi = m }
    return (lo + hi) / 2
  }
  const footOf = (u: number): [number, number] => { const g = geodeticOf(add(O, scale(sub(T, O), u))); return [g.lat, g.lon] }
  const obstacles = q.obstacles.map(b => {
    const r = inverse(o.lat, o.lon, b.lat, b.lon), dAz = (wrap360(r.azimuth - inv.azimuth + 180) - 180) * DEG
    const along = r.distanceM * Math.cos(dAz), cross = r.distanceM * Math.sin(dAz)   // local flat projection on the line
    const between = along > 0 && along < D
    const p = between ? at(uAt(along)) : null
    return {
      lat: b.lat, lon: b.lon, heightMsl: b.heightMsl,
      distanceKm: along / 1000, crossTrackM: cross,
      lineHeightMsl: p ? p.heightMsl : null, refractedLineHeightMsl: p ? p.refractedHeightMsl : null,
      clearanceM: p ? p.heightMsl - b.heightMsl : null, refractedClearanceM: p ? p.refractedHeightMsl - b.heightMsl : null,
      blocks: p ? p.refractedHeightMsl < b.heightMsl : null,
    }
  })
  return { observer: o, target: t, distanceKm: D / 1000, azimuth: inv.azimuth, samples: q.samples, profile, obstacles }
}

export const parseObstacles = (s: string | undefined): Obstacle[] | string => {
  if (s === undefined) return []
  const pts = s.split(",").map(x => x.trim()).filter(Boolean)
  if (pts.length > MAX_OBSTACLES) return `at most ${MAX_OBSTACLES} obstacles`
  const out: Obstacle[] = []
  for (const p of pts) {
    const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(p)
    if (!m) return `obstacle ${JSON.stringify(p)} is not lat:lon:heightMsl (degrees, degrees, metres above sea level)`
    const lat = Number(m[1]), lon = Number(m[2]), h = Number(m[3])
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return `obstacle ${JSON.stringify(p)} is outside lat [−90, 90], lon [−180, 180]`
    if (!(h >= -500 && h <= 10_000)) return `obstacle height ${h} m is outside [−500, 10 000]`
    out.push({ lat, lon, heightMsl: h })
  }
  return out
}

export const SIGHTLINE_CONVENTIONS = {
  definition: "profile[]: points on the sight line from the eye (observer) to the target, equally spaced along the straight line. heightMsl: the geometric line's height above the EGM96 geoid (≈ mean sea level) at that point, i.e. its WGS-84 geodetic height minus N at the foot of the normal; Earth's curvature is in it because both ends are exact WGS-84 ECEF points. distanceKm: geodesic ground distance from the observer to the foot.",
  terrestrialRefraction: `Modelled as a constant coefficient k = ${K_TERRESTRIAL} (as /alignment): the ray through both ends curves with curvature k/R, R = ${R_MEAN_M} m, so it runs k·s₁·s₂/(2R) above the straight line (refractedHeightMsl; s₁, s₂ = ground distances to the ends: 0.15 m at the middle of a 4 km line). Real k near water varies roughly 0–0.3, and much more over a warm or cold surface; no atmospheric profile, inversion or ducting. heightMsl is the line with no refraction.`,
  obstacles: "obstacles[]: each point is projected on the line (distanceKm along it, crossTrackM to the right of it looking at the target, local flat projection). lineHeightMsl / refractedLineHeightMsl: the line's height at that distance; clearanceM = line − obstacle heightMsl (negative: the obstacle rises above the line); blocks = refracted clearance < 0. Null when the point is not between the ends. crossTrackM says whether the point is really on the line: the clearance is the line's height there, not at the obstacle.",
  heights: "observerHeight / targetHeight: metres above the WGS-84 ellipsoid by default, above the EGM96 geoid with heightRef / targetHeightRef = msl; obstacle heights are always above sea level (msl).",
} as const
